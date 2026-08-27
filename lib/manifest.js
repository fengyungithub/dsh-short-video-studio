/**
 * lib/manifest.js — 工作流绑定契约（Workflow Manifest）的执行引擎。
 *
 * 职责（M1）：
 *  - validateManifest：加载期结构强校验（对应 schemas/workflow-manifest.schema.json 的核心不变量，
 *    手写实现以保持零依赖；JSON Schema 作为外部工具/文档的权威参照）。
 *  - resolveAssets：按 env > assetOverrides > default 解析资产文件名。
 *  - buildGraphFromManifest：把「一份清单 + 一份 job 输入」编译成 ComfyUI API 格式的图。
 *  - loadBuiltinManifests：读取一个目录下的 *.json 清单并校验。
 *
 * 注入原语（inject 类型）：
 *  - scalar          把任务标量写到图字段（支持多目标 to[]）。
 *  - image via:field 把已上传图片的文件名字符串写到字段。
 *  - image via:node  建 LoadImage（+可选 preprocess 链）→ 把节点输出连线写到字段。
 *  - video via:field 把已上传视频的文件名字符串写到字段（如 LoadVideo.file）。
 * 资产用 "$assets.<key>" 占位；模型连线用 ["$model", 0] 哨兵，由 mode.loras 决定是否插 LoRA。
 *
 * 本文件刻意零 @deepseek-ai/* 运行时 import，无第三方依赖。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

/** 能力词汇表（开放集合，新增能力在此登记即可）。 */
export const CAPABILITIES = [
  'image.text2image',
  'image.image2image',
  'video.text2video',
  'video.image2video',
  'video.reference2video',
  'image.from_video',
  'audio.tts',
  'audio.music',
]

const INJECT_KINDS = ['scalar', 'image', 'video']
const MEDIA_TYPES = ['image', 'video', 'audio']
const ASSET_KINDS = ['checkpoint', 'clip', 'vae', 'lora', 'other']

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/** 递归遍历图（节点对象的任意字符串/数组值），收集引用。 */
function walkGraphStrings(node, visit) {
  if (typeof node === 'string') return visit(node)
  if (Array.isArray(node)) { for (const x of node) walkGraphStrings(x, visit); return }
  if (node && typeof node === 'object') { for (const v of Object.values(node)) walkGraphStrings(v, visit) }
}

/**
 * 结构校验一份清单。返回 { ok, errors }。
 * 与 JSON Schema 同源；失败必须拒绝加载（决策 #4），不静默降级。
 */
export function validateManifest(m, source = 'manifest') {
  const errors = []
  const fail = (msg) => errors.push(`${source}: ${msg}`)

  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, errors: [`${source}: 清单必须是对象`] }
  }
  if (typeof m.id !== 'string' || !m.id) fail('id 必须是非空字符串')
  else if (!/^[a-z0-9][a-z0-9._-]*$/.test(m.id)) fail('id 只能含小写字母/数字/._-，且以字母或数字开头')
  if (!CAPABILITIES.includes(m.capability)) fail(`capability "${m.capability}" 不在能力词汇表`)
  if (m.runner !== undefined && m.runner !== 'comfyui') fail(`runner "${m.runner}" 本期不支持（仅 comfyui）`)
  if (m.version !== undefined && (!Number.isInteger(m.version) || m.version < 1)) fail('version 必须是不小于 1 的整数')

  if (m.output !== undefined) {
    if (typeof m.output !== 'object' || Array.isArray(m.output)) fail('output 必须是对象')
    else if (m.output.mediaType && !MEDIA_TYPES.includes(m.output.mediaType)) fail('output.mediaType 非法')
  }

  // assets
  const assetKeys = new Set()
  if (m.assets !== undefined) {
    if (typeof m.assets !== 'object' || Array.isArray(m.assets)) fail('assets 必须是对象')
    else {
      for (const [key, a] of Object.entries(m.assets)) {
        assetKeys.add(key)
        if (!a || typeof a !== 'object' || Array.isArray(a)) { fail(`assets.${key} 必须是对象`); continue }
        if (typeof a.default !== 'string' || !a.default) fail(`assets.${key}.default 必须是非空字符串`)
        if (a.kind && !ASSET_KINDS.includes(a.kind)) fail(`assets.${key}.kind 非法`)
        if (a.env !== undefined && typeof a.env !== 'string') fail(`assets.${key}.env 必须是字符串`)
      }
    }
  }

  // graph
  if (typeof m.graph !== 'object' || Array.isArray(m.graph) || !m.graph) {
    fail('graph 必须是 {nodeId: {...}} 对象')
  } else {
    const nodeIds = new Set(Object.keys(m.graph))
    if (!nodeIds.size) fail('graph 不能为空')
    for (const [id, node] of Object.entries(m.graph)) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) { fail(`graph.${id} 必须是节点对象`); continue }
      if (typeof node.class_type !== 'string' || !node.class_type) fail(`graph.${id}.class_type 缺失`)
      if (node.inputs !== undefined && (typeof node.inputs !== 'object' || Array.isArray(node.inputs))) {
        fail(`graph.${id}.inputs 必须是对象`)
      }
      // 连线引用完整性：["id", idx] 里的 id 必须存在（$model 哨兵除外）
      if (node.inputs && typeof node.inputs === 'object') {
        for (const v of Object.values(node.inputs)) {
          if (Array.isArray(v) && v.length >= 1 && typeof v[0] === 'string' && v[0] !== '$model' && !nodeIds.has(v[0])) {
            fail(`graph.${id} 引用了不存在的节点 "${v[0]}"`)
          }
        }
      }
    }
    // $assets.* 引用必须落在 assets 里
    const assetRefs = new Set()
    for (const node of Object.values(m.graph)) {
      walkGraphStrings(node.inputs, (s) => {
        for (const mch of s.matchAll(/\$assets\.([A-Za-z0-9_]+)/g)) assetRefs.add(mch[1])
      })
    }
    for (const k of assetRefs) if (!assetKeys.has(k)) fail(`graph 引用未声明的资产 "$assets.${k}"`)
    // 使用 $model 哨兵时需 modelNode（缺省 '1'）
    let usesModel = false
    for (const node of Object.values(m.graph)) {
      walkGraphStrings(node.inputs, (s) => { if (s === '$model' || (Array.isArray(s) && s[0] === '$model')) usesModel = true })
      for (const v of Object.values(node.inputs || {})) {
        if (Array.isArray(v) && v[0] === '$model') usesModel = true
      }
    }
    if (usesModel && m.modelNode !== undefined && typeof m.modelNode !== 'string') fail('modelNode 必须是节点 id 字符串')
  }

  // params
  if (typeof m.params !== 'object' || Array.isArray(m.params)) {
    fail('params 必须是对象')
  } else {
    for (const [name, p] of Object.entries(m.params)) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) { fail(`params.${name} 必须是对象`); continue }
      if (!INJECT_KINDS.includes(p.inject)) { fail(`params.${name}.inject 非法（${p.inject}）`); continue }
      if (p.inject === 'image') {
        if (!['field', 'node'].includes(p.via)) fail(`params.${name}.via 非法（image 需 field|node）`)
        if (p.max !== undefined && (!Number.isInteger(p.max) || p.max < 1)) fail(`params.${name}.max 非法`)
        if (p.preprocess !== undefined && !Array.isArray(p.preprocess)) fail(`params.${name}.preprocess 必须是数组`)
      }
      if (p.inject === 'video' && p.via !== 'field') {
        fail(`params.${name}.via 非法（video 目前仅支持 field）`)
      }
      const tos = Array.isArray(p.to) ? p.to : (p.to ? [p.to] : [])
      if (!tos.length) { fail(`params.${name}.to 缺失`); continue }
      for (const t of tos) {
        if (!t || typeof t !== 'object' || typeof t.node !== 'string' || typeof t.field !== 'string') {
          fail(`params.${name}.to 需含 {node, field}`)
        }
      }
    }
  }

  // modes
  if (m.modes !== undefined) {
    if (typeof m.modes !== 'object' || Array.isArray(m.modes)) fail('modes 必须是对象')
    else {
      for (const [mn, mc] of Object.entries(m.modes)) {
        if (!mc || typeof mc !== 'object' || Array.isArray(mc)) { fail(`modes.${mn} 必须是对象`); continue }
        if (mc.steps !== undefined && (!Number.isInteger(mc.steps) || mc.steps < 1)) fail(`modes.${mn}.steps 非法`)
        if (mc.loras !== undefined) {
          if (!Array.isArray(mc.loras)) fail(`modes.${mn}.loras 必须是数组`)
          else for (const l of mc.loras) {
            if (!l || typeof l !== 'object' || typeof l.asset !== 'string' || !assetKeys.has(l.asset)) {
              fail(`modes.${mn}.loras 引用了未声明的资产 "${l && l.asset}"`)
            }
          }
        }
      }
    }
  }

  // constraints
  if (m.constraints !== undefined && (typeof m.constraints !== 'object' || Array.isArray(m.constraints))) {
    fail('constraints 必须是对象')
  }

  return { ok: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// 资产解析
// ---------------------------------------------------------------------------

/** 解析资产文件名：env > assetOverrides > default。返回 {<key>: filename}。 */
export function resolveAssets(m, assetOverrides = {}) {
  const out = {}
  for (const [key, a] of Object.entries(m.assets || {})) {
    let v = a && typeof a.default === 'string' ? a.default : ''
    if (assetOverrides && assetOverrides[key] !== undefined && assetOverrides[key] !== '') v = assetOverrides[key]
    if (a && a.env && process.env[a.env]) v = process.env[a.env]
    out[key] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// 图编译（注入引擎）
// ---------------------------------------------------------------------------

function setField(graph, nodeId, field, value) {
  const node = graph[nodeId]
  if (!node) throw new Error(`注入目标节点不存在: ${nodeId}`)
  if (!node.inputs || typeof node.inputs !== 'object') node.inputs = {}
  node.inputs[field] = value
}

/** 替换 "${name}" 模板（引用 job 标量，用于 preprocess 等）。整串精确匹配时保留原类型（数字不转字符串）。 */
function resolveTemplate(v, job) {
  if (typeof v === 'string') {
    const exact = /^\$\{([A-Za-z0-9_]+)\}$/.exec(v)
    if (exact) return job[exact[1]] !== undefined ? job[exact[1]] : ''
    return v.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, k) => (job[k] !== undefined ? String(job[k]) : ''))
  }
  if (Array.isArray(v)) return v.map((x) => resolveTemplate(x, job))
  if (v && typeof v === 'object') {
    const o = {}
    for (const [k, x] of Object.entries(v)) o[k] = resolveTemplate(x, job)
    return o
  }
  return v
}

/** 建「LoadImage → preprocess 链」并返回末端节点 id。 */
function buildImageChain(graph, allocId, filename, p, job) {
  const loaderClass = p.node || 'LoadImage'
  const nid = allocId()
  graph[nid] = { class_type: loaderClass, inputs: { image: filename } }
  let prev = nid
  for (const pre of p.preprocess || []) {
    const pid = allocId()
    const inputs = resolveTemplate(pre.inputs || {}, job)
    inputs[pre.imageInput || 'image'] = [prev, 0]
    graph[pid] = { class_type: pre.class_type, inputs }
    prev = pid
  }
  return prev
}

/** 解析 $model 哨兵：按 mode.loras 在基础模型节点后插 LoRA 链，再替换所有 ["$model", idx]。 */
function resolveModel(graph, allocId, m, modeCfg, assets) {
  // 无 $model 哨兵（图内已硬连线到具体模型节点）则无需处理，直接返回。
  let hasModelSentinel = false
  for (const node of Object.values(graph)) {
    for (const v of Object.values(node.inputs || {})) {
      if (Array.isArray(v) && v[0] === '$model') { hasModelSentinel = true; break }
    }
    if (hasModelSentinel) break
  }
  if (!hasModelSentinel) return null
  let cur = m.modelNode || '1'
  if (!graph[cur]) throw new Error(`modelNode "${cur}" 不在 graph 中`)
  for (const lora of modeCfg.loras || []) {
    const name = assets[lora.asset] || ''
    const nid = allocId()
    graph[nid] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: [cur, 0], lora_name: name, strength_model: lora.strength !== undefined ? lora.strength : 1.0 },
    }
    cur = nid
  }
  for (const node of Object.values(graph)) {
    for (const [k, v] of Object.entries(node.inputs || {})) {
      if (Array.isArray(v) && v[0] === '$model') node.inputs[k] = [cur, v[1] !== undefined ? v[1] : 0]
    }
  }
  return cur
}

/**
 * 把「一份清单 + 一份 job 输入」编译成 ComfyUI API 格式图。
 * job 字段与清单 params 的键名一致（prompt/width/height/length/seed/steps/guidance/fps/
 * refs[]/first_frame/last_frame/prefix），另有 job.mode、job.assetOverrides。
 */
export function buildGraphFromManifest(m, job = {}) {
  const v = validateManifest(m, m.id || 'manifest')
  if (!v.ok) throw new Error('manifest 校验失败: ' + v.errors.join('; '))

  const assets = resolveAssets(m, job.assetOverrides)
  const modeNames = Object.keys(m.modes || {})
  const mode = job.mode && m.modes && m.modes[job.mode] ? job.mode : (modeNames[0] || null)
  const modeCfg = mode ? (m.modes[mode] || {}) : {}

  const graph = JSON.parse(JSON.stringify(m.graph))
  const usedIds = new Set(Object.keys(graph))
  let dyn = 1000
  const allocId = () => {
    let id
    do { id = String(dyn++) } while (usedIds.has(id))
    usedIds.add(id)
    return id
  }

  // 1) 解析 $assets.<key> 字符串占位（深拷贝后，只处理字符串/数组元素）
  const replaceAssets = (x) => {
    if (typeof x === 'string') return x.replace(/\$assets\.([A-Za-z0-9_]+)/g, (full, k) => (assets[k] !== undefined ? assets[k] : full))
    if (Array.isArray(x)) return x.map(replaceAssets)
    if (x && typeof x === 'object') {
      const o = {}
      for (const [k, val] of Object.entries(x)) o[k] = replaceAssets(val)
      return o
    }
    return x
  }
  for (const [id, node] of Object.entries(graph)) {
    graph[id] = { class_type: node.class_type, inputs: replaceAssets(node.inputs || {}) }
  }

  // 2) 注入 params（scalar / image）
  for (const [name, p] of Object.entries(m.params || {})) {
    const raw = job[name]
    const value = (raw !== undefined && raw !== null && raw !== '') ? raw : (p.default !== undefined ? p.default : undefined)
    if (value === undefined) continue

    if (p.inject === 'scalar') {
      const tos = Array.isArray(p.to) ? p.to : [p.to]
      for (const t of tos) setField(graph, t.node, resolveTemplate(t.field, job), value)
    } else if (p.inject === 'video') {
      // 已上传视频的文件名字符串 → 字段（如 LoadVideo.file）
      const videos = Array.isArray(value) ? value : [value]
      for (let i = 0; i < videos.length; i++) {
        setField(graph, p.to.node, resolveTemplate(p.to.field, { ...job, i }), videos[i])
      }
    } else if (p.inject === 'image') {
      const images = Array.isArray(value) ? value : [value]
      if (p.via === 'field') {
        for (let i = 0; i < images.length; i++) {
          setField(graph, p.to.node, resolveTemplate(p.to.field, { ...job, i }), images[i])
        }
      } else { // via 'node'
        for (let i = 0; i < images.length; i++) {
          const outId = buildImageChain(graph, allocId, images[i], p, job)
          setField(graph, p.to.node, resolveTemplate(p.to.field, { ...job, i }), [outId, 0])
        }
      }
    }
  }

  // 3) 解析 $model 哨兵（按 mode 插 LoRA）
  resolveModel(graph, allocId, m, modeCfg, assets)

  return graph
}

// ---------------------------------------------------------------------------
// 注册表加载
// ---------------------------------------------------------------------------

/**
 * 读取一个目录下的 *.json 清单并校验。
 * 返回 { manifests: [], byId: {}, byCapability: {}, errors: [] }。
 * 校验失败的清单不会进入 byId/byCapability（决策 #4：拒绝加载）。
 */
export function loadBuiltinManifests(dir) {
  const manifests = []
  const byId = {}
  const byCapability = {}
  const errors = []
  if (!existsSync(dir)) return { manifests, byId, byCapability, errors }
  for (const entry of readdirSync(dir)) {
    if (extname(entry).toLowerCase() !== '.json') continue
    const file = join(dir, entry)
    let m
    try {
      m = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      errors.push(`${entry}: JSON 解析失败（${e.message}）`)
      continue
    }
    const v = validateManifest(m, entry)
    if (!v.ok) {
      errors.push(...v.errors)
      continue
    }
    if (byId[m.id]) errors.push(`${entry}: id "${m.id}" 与已有清单重复（后者覆盖）`)
    manifests.push(m)
    byId[m.id] = m
    ;(byCapability[m.capability] ||= []).push(m)
  }
  return { manifests, byId, byCapability, errors }
}
