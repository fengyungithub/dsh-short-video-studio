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
  // 视频超分（U3）：输入是**已存在的视频**，输出 = 输入 × 模型倍率（可收敛到目标宽度）。
  // 与生成能力不同：没有提示词、没有采样器，图是纯像素空间 CNN 链路（见 docs/video-upscale.md）。
  'video.upscale',
  'image.from_video',
  'audio.tts',
  'audio.music',
]

/**
 * 档位词汇表（受控枚举，锁定三档；契约见 docs/tier-strategy-design.md）。
 * 一个清单只服务一个档位（可含加速实现，如 Sol 节点）；同名 group 聚合成组。
 * 展示顺序按成本升序：fast < balanced < quality。
 */
export const TIERS = ['fast', 'balanced', 'quality']

/**
 * 超分实现的**尺寸来源**（`upscale.sizing`，缺省 `factor`；契约见 docs/video-upscale.md §3）：
 *  - `factor`     交付 = 源视频尺寸 × `upscale.factor`。像素空间逐帧 CNN 的形态（RealESRGAN 系），
 *                 倍率写在权重里；`target_width` 只能**事后**收敛（超出倍率的量只是插值，会告警）。
 *  - `short-side` 交付由实现的**目标短边**（`upscale.shortSide` + 可选 `upscale.maxEdge`）推出。
 *                 扩散/恢复类模型的形态（如 SeedVR2 的 `resolution` = 目标短边）：倍率是**推导出来的**，
 *                 所以清单不得声明 `factor`，且必须声明 `params.out_short_side` 让 runner 注入解析结果
 *                 ⇒ `target_width` 变成「让模型按目标渲染」，而不是先渲染再降采样。
 */
export const UPSCALE_SIZINGS = ['factor', 'short-side']

/**
 * 超分实现的**分块归属**（`upscale.chunking`，缺省 `caller`）：
 *  - `caller`   runner 可按像素-帧预算自由分块（逐帧独立 ⇒ 任意切点安全）。
 *  - `internal` 模型自带跨帧时间先验（如 SeedVR2 的 4n+1 batch / temporal_overlap / 内部 tiling），
 *               外层再切一刀等于在它的时间窗上再加一道硬切 ⇒ runner **不自动分块**，显存交给它自己管。
 */
export const UPSCALE_CHUNKINGS = ['caller', 'internal']

const INJECT_KINDS = ['scalar', 'image', 'video']
const MEDIA_TYPES = ['image', 'video', 'audio']
const ASSET_KINDS = ['checkpoint', 'clip', 'vae', 'lora', 'other']
/** 链式续接的「上一镜」来源形态（见 docs/shot-chain-continuity.md）。 */
export const CHAIN_SOURCES = ['clip-latent']

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

  // 档位/分组/加速元数据（可选；声明了 tier 才参与档位解析，见 docs/tier-strategy-design.md）
  if (m.tier !== undefined && !TIERS.includes(m.tier)) fail(`tier "${m.tier}" 不在档位词汇表（${TIERS.join('|')}）`)
  if (m.group !== undefined && (typeof m.group !== 'string' || !m.group)) fail('group 必须是非空字符串')
  if (m.accel !== undefined && (typeof m.accel !== 'string' || !m.accel)) fail('accel 必须是非空字符串（如 sol）')
  if (m.requiresNodes !== undefined) {
    if (!Array.isArray(m.requiresNodes) || m.requiresNodes.some((s) => typeof s !== 'string' || !s)) {
      fail('requiresNodes 必须是非空字符串数组（ComfyUI 节点 class_type）')
    }
  }
  if (m.estSeconds !== undefined && (!Number.isFinite(m.estSeconds) || m.estSeconds <= 0)) fail('estSeconds 必须是正数（秒）')
  if (m.note !== undefined && typeof m.note !== 'string') fail('note 必须是字符串')
  if (m.internal !== undefined && typeof m.internal !== 'boolean') fail('internal 必须是布尔')

  // 模型合法的采样帧数网格（如 H3 的 17k+5）。声明后 runner 会把请求帧数**向上取整**到网格，
  // 并据此记录实际交付帧数——否则节点上的 length 会与产物差最多一个步长（曾实测请求 136 → 产物 141 帧）。
  if (m.lengthGrid !== undefined) {
    const g = m.lengthGrid
    if (!Array.isArray(g) || g.length !== 2 || !g.every((x) => Number.isInteger(x) && x > 0)) {
      fail('lengthGrid 必须是 [步长, 偏移] 两个正整数（合法采样帧数 = 步长*k + 偏移）')
    }
  }

  // 链式续接声明：本实现消费「上一镜」的产物（服务端 latent）以延续画面与音频。
  // 采样长度补偿与合法长度网格也在这里声明——**runner 不认识任何模型的名字**，
  // 换算规则由清单提供（同 params/resolution 的思路）。契约见 docs/shot-chain-continuity.md。
  if (m.chain !== undefined) {
    const c = m.chain
    if (!c || typeof c !== 'object' || Array.isArray(c)) fail('chain 必须是对象')
    else {
      if (!CHAIN_SOURCES.includes(c.source)) fail(`chain.source 必须是 ${CHAIN_SOURCES.join('|')}`)
      if (!Number.isInteger(c.sampleExtra) || c.sampleExtra < 0) fail('chain.sampleExtra 必须是非负整数（为继承而多采样的帧数）')
      if (c.lengthGrid !== undefined) {
        const g = c.lengthGrid
        if (!Array.isArray(g) || g.length !== 2 || !g.every((x) => Number.isInteger(x) && x > 0)) {
          fail('chain.lengthGrid 必须是 [步长, 偏移] 两个正整数（合法采样帧数 = 步长*k + 偏移）')
        }
      }
      for (const p of [c.indexParam || 'context_clip_index', c.saveIndexParam || 'save_clip_index']) {
        if (!m.params || !m.params[p]) fail(`chain 需要 params.${p}（把链序号注入到 Load/Save 节点）`)
      }
    }
  }

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
        // 档位级长边（图片/视频共用）：32 对齐，否则 computeManifestSize 会推出非对齐尺寸
        if (mc.longSide !== undefined && (!Number.isInteger(mc.longSide) || mc.longSide <= 0 || mc.longSide % 32 !== 0)) {
          fail(`modes.${mn}.longSide 必须是 32 的倍数的正整数（实际 ${mc.longSide}）`)
        }
        // 档位级参考图预算（i2i）：总像素预算，正整数
        if (mc.referencePixels !== undefined && (!Number.isInteger(mc.referencePixels) || mc.referencePixels <= 0)) {
          fail(`modes.${mn}.referencePixels 必须是正整数像素预算（实际 ${mc.referencePixels}）`)
        }
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

  // 分辨率声明（图片与视频统一走这一套，见 docs/unified-tier-tool-design.md §3.4）：
  //   policy='aspect-ratio' 交付 = 画布 aspectRatio × 本档长边（longSide），显式 width/height 可覆盖；
  //   policy='explicit'     只认显式宽高与 default（旧清单兼容）。
  // longSide 必须 32 对齐——否则「画布比例 × 长边」推出来的另一条边会跟着不对齐。
  if (m.resolution !== undefined) {
    const r = m.resolution
    if (!r || typeof r !== 'object' || Array.isArray(r)) fail('resolution 必须是对象')
    else {
      if (r.policy !== undefined && !['explicit', 'aspect-ratio'].includes(String(r.policy))) {
        fail(`resolution.policy 只能是 explicit | aspect-ratio（实际 "${r.policy}"）`)
      }
      if (r.longSide !== undefined && (!Number.isInteger(r.longSide) || r.longSide <= 0 || r.longSide % 32 !== 0)) {
        fail(`resolution.longSide 必须是 32 的倍数的正整数（实际 ${r.longSide}）`)
      }
      if (r.snap !== undefined && (!Number.isInteger(r.snap) || r.snap <= 0)) fail('resolution.snap 必须是正整数')
      const pairOk = (v) => Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(x) && x > 0)
      if (r.default !== undefined) {
        if (Array.isArray(r.default)) {
          if (!pairOk(r.default)) fail('resolution.default 必须是 [宽, 高] 两个正整数')
        } else if (r.default && typeof r.default === 'object') {
          for (const [k, v] of Object.entries(r.default)) {
            if (!pairOk(v)) fail(`resolution.default.${k} 必须是 [宽, 高] 两个正整数`)
          }
        } else {
          fail('resolution.default 必须是 [宽, 高] 或 { 档位: [宽, 高] } 对象')
        }
      }
    }
  }

  // 分辨率声明：两阶段实现（首遍采样 → 放大/精修 → 交付）的尺寸契约，**两种形态**：
  //
  //   ① 图锁定（`graph: [w,h]`，如 hires）——首遍尺寸是图结构的一部分（放大倍率写在图内节点上），
  //      显式 width/height 与画布 aspectRatio **都不得覆盖**；交付尺寸 = graph × scale。
  //   ② 只锁倍率（只有 `scale`，如学习式 2K 族）——首遍尺寸**不锁**：按「显式 width/height →
  //      画布 aspectRatio × 档位长边 → resolution.default」正常推导；交付尺寸 = 首遍 × scale。
  //      用于「放大器与首遍尺寸无关」的实现：图内目标尺寸由算术模板跟着首遍走
  //      （node 17 写 `"${width * 2}"`），所以天然支持任意画幅比例。
  //
  // 共同点：**交付尺寸一律 = 首遍 × scale**，由 manifestDeliverySize() 推出；两种形态都由
  // resolutionLockWarning() 显式回报（不静默）。至少要声明 graph / scale 之一，否则字段无语义。
  if (m.resolutionLock !== undefined) {
    const l = m.resolutionLock
    if (!l || typeof l !== 'object' || Array.isArray(l)) fail('resolutionLock 必须是对象')
    else {
      const g = l.graph
      if (g !== undefined && (!Array.isArray(g) || g.length !== 2 || !g.every((x) => Number.isInteger(x) && x > 0))) {
        fail('resolutionLock.graph 必须是 [宽, 高] 两个正整数（省略 = 不锁首遍，只按 scale 声明交付倍率）')
      }
      if (l.scale !== undefined && (!Number.isFinite(l.scale) || l.scale <= 0)) {
        fail('resolutionLock.scale 必须是正数（交付尺寸 = 首遍 × scale）')
      }
      if (g === undefined && l.scale === undefined) {
        fail('resolutionLock 至少要声明 graph 或 scale 之一（只有 note 没有语义）')
      }
      if (l.note !== undefined && typeof l.note !== 'string') fail('resolutionLock.note 必须是字符串')
    }
  }

  // 按画幅比例的建议帧数上限（**只声明、不强制**：渲染不会被拦，供 UI/文档/排障提示）。
  // 存在意义：同一实现在某些比例下显存余量很小（如两阶段放大族 1:1 的交付像素是 16:9 的 1.78 倍），
  // 用一个结构化字段把「这个比例别跑太长」记下来，而不是只写在 note 的散文里。
  // 这里只做形状校验：比例键写错（如 "1x1" 之外的拼法）会让声明被静默忽略，所以必须 fail-closed。
  if (m.constraints?.maxDurationFramesByRatio !== undefined) {
    const cap = m.constraints.maxDurationFramesByRatio
    if (!cap || typeof cap !== 'object' || Array.isArray(cap)) {
      fail('constraints.maxDurationFramesByRatio 必须是 { 比例: 帧数 } 对象（只声明不强制）')
    } else {
      for (const [k, v] of Object.entries(cap)) {
        if (!/^\d+\s*[:/x]\s*\d+$/.test(String(k).trim())) {
          fail(`constraints.maxDurationFramesByRatio 的键 "${k}" 不是画幅比例（形如 "1:1" / "9:16"）——写错会被静默忽略`)
        }
        if (!Number.isInteger(v) || v < 1) {
          fail(`constraints.maxDurationFramesByRatio["${k}"] 必须是正整数帧数`)
        }
      }
    }
  }

  // 视频超分（capability=video.upscale）的结构声明。**尺寸来源有两种形态**，清单必须说清是哪一种：
  //
  //   sizing='factor'      交付 = 源视频尺寸 × factor。像素空间逐帧 CNN 的形态（RealESRGAN 系），
  //                        倍率写在权重里，图里靠 factor 声明；`target_width` 只能事后收敛（超出倍率=插值）。
  //   sizing='short-side'  交付由实现的**目标短边**推出（扩散/恢复类模型的形态，如 SeedVR2 的 `resolution`）。
  //                        倍率是**推导出来的**，所以**不得**再声明 factor（写死会与实际交付悄悄不符），
  //                        且必须声明 `params.out_short_side`——runner 把解析出的短边注入实现，
  //                        这样 `target_width` 是**让模型按目标渲染**，而不是先渲染再降采样。
  //
  // 分块归属同理要声明：逐帧独立的实现（chunking='caller'）随便切；自带跨帧时间先验的实现
  // （chunking='internal'，如 SeedVR2 的 4n+1 batch / temporal_overlap）被外层切开会在它的时间窗上
  // 再加一道硬切 ⇒ runner 不自动分块，把显存交给它自己管。
  //
  // 与 resolutionLock 仍然互斥：那里的尺寸来源是「图结构 / 档位 × 画布比例」，这里的尺寸**跟着输入视频走**。
  if (m.upscale !== undefined) {
    const u = m.upscale
    if (!u || typeof u !== 'object' || Array.isArray(u)) fail('upscale 必须是对象')
    else {
      const sizing = u.sizing === undefined ? 'factor' : String(u.sizing)
      if (!UPSCALE_SIZINGS.includes(sizing)) {
        fail(`upscale.sizing 只能是 ${UPSCALE_SIZINGS.join(' | ')}（实际 "${u.sizing}"）`)
      }
      if (sizing === 'factor') {
        if (!Number.isFinite(u.factor) || u.factor <= 0) fail('upscale.factor 必须是正数（交付尺寸 = 源尺寸 × factor）')
      } else {
        if (u.factor !== undefined) {
          fail('upscale.sizing="short-side" 时不应声明 factor（倍率由短边推导，写死会与实际交付不符）')
        }
        if (!Number.isInteger(u.shortSide) || u.shortSide <= 0) {
          fail('upscale.sizing="short-side" 必须声明 upscale.shortSide（目标短边像素，正整数）')
        }
        if (u.maxEdge !== undefined && (!Number.isInteger(u.maxEdge) || u.maxEdge < 0)) {
          fail('upscale.maxEdge 必须是非负整数（0 = 不限；仅 sizing="short-side" 有意义）')
        }
      }
      if (u.align !== undefined && (!Number.isInteger(u.align) || u.align <= 0)) {
        fail('upscale.align 必须是正整数（交付尺寸按它对齐，缺省 32）')
      }
      if (u.chunking !== undefined && !UPSCALE_CHUNKINGS.includes(String(u.chunking))) {
        fail(`upscale.chunking 只能是 ${UPSCALE_CHUNKINGS.join(' | ')}（实际 "${u.chunking}"）`)
      }
      if (u.note !== undefined && typeof u.note !== 'string') fail('upscale.note 必须是字符串')
    }
  }
  // 超分能力必须声明尺寸来源（否则 runner 无从知道交付多大），且不应同时声明 resolutionLock
  // （两者的尺寸语义互斥：一个锁图分辨率、一个跟着输入走）
  if (m.capability === 'video.upscale') {
    if (m.upscale === undefined) {
      fail('capability=video.upscale 的清单必须声明 upscale.factor（或 upscale.sizing="short-side" + upscale.shortSide）')
    }
    if (m.resolutionLock !== undefined) fail('capability=video.upscale 的清单不应声明 resolutionLock（尺寸跟着输入视频走）')
    // 短边驱动的实现必须留出注入点：没有它，runner 解析出的尺寸落不到模型上，
    // 交付尺寸会与画布记录的 width/height 悄悄不一致（拼接一致性判据接着错）。
    if (m.upscale && m.upscale.sizing === 'short-side' && !m.params?.out_short_side) {
      fail('upscale.sizing="short-side" 的清单必须声明 params.out_short_side（把解析出的短边注入实现，否则 target_width 落不到模型上）')
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

/**
 * 替换 "${name}" 模板（引用 job 标量，用于 preprocess 等）。整串精确匹配时保留原类型（数字不转字符串）。
 *
 * 支持 `+ - * / ()` 与数字常量的**纯算术**组合（如 `${seed + 1000000}`）：两阶段实现需要「二遍 seed
 * 必须不同于首遍」——同 seed 会把二遍退化成重放首遍的高噪声步，二遍就白跑了。这里只做算术，
 * 不求值任意表达式（不用 eval）。
 *
 * 算术在**整串**与**内嵌**两种形态下都成立：内嵌用于「字段名本身要带序号」的场景——例如
 * Qwen-Image 2.1 的参考图槽位叫 `images.image_1…image_16`（1 起），而 refs 循环给的是 0 起的 `${i}`，
 * 于是字段写 `"images.image_${i+1}"`。内嵌形态下值一定是字符串（字段名/文件名），保留原类型只对整串有意义。
 */
const TEMPLATE_ARITH = /^[0-9+\-*/().\s]+$/
function evalTemplateArithmetic(expr, job) {
  const substituted = expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (k) => {
    const v = job[k]
    return Number.isFinite(Number(v)) ? String(Number(v)) : 'NaN'
  })
  if (!TEMPLATE_ARITH.test(substituted) || substituted.includes('NaN')) return null
  try {
    // eslint-disable-next-line no-new-func -- 输入已被上面的字符白名单限制为纯算术
    const out = Function(`"use strict";return (${substituted})`)()
    return Number.isFinite(out) ? out : null
  } catch { return null }
}

function resolveTemplate(v, job) {
  if (typeof v === 'string') {
    const exact = /^\$\{([A-Za-z0-9_]+)\}$/.exec(v)
    if (exact) return job[exact[1]] !== undefined ? job[exact[1]] : ''
    const arith = /^\$\{([^{}]+)\}$/.exec(v)
    if (arith) {
      const out = evalTemplateArithmetic(arith[1], job)
      if (out !== null) return out
      return ''
    }
    // 内嵌占位：标识符取 job 值（缺失 → 空串，保持旧行为），其余按**同一套白名单算术**求值，
    // 两者都不成立时原样保留（如 `${foo.bar}`）。
    return v.replace(/\$\{([^{}]+)\}/g, (full, expr) => {
      if (/^[A-Za-z0-9_]+$/.test(expr)) return job[expr] !== undefined ? String(job[expr]) : ''
      const out = evalTemplateArithmetic(expr, job)
      return out !== null ? String(out) : full
    })
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
  // 2) 渲染图内 `${...}` 模板（引用 job 标量，支持纯算术）。
  //    与 replaceAssets 分开两步：先把模型文件名换掉，再渲染模板——模板值本身可能来自 job
  //    （如两阶段实现的二遍 seed `${seed + 1000000}`），不能在第一步就被当成普通字符串放过。
  const renderTemplates = (x) => {
    if (typeof x === 'string') return /\$\{[^{}]*\}/.test(x) ? resolveTemplate(x, job) : x
    if (Array.isArray(x)) return x.map(renderTemplates)
    if (x && typeof x === 'object') {
      const o = {}
      for (const [k, val] of Object.entries(x)) o[k] = renderTemplates(val)
      return o
    }
    return x
  }
  for (const [id, node] of Object.entries(graph)) {
    graph[id] = renderTemplates({ class_type: node.class_type, inputs: replaceAssets(node.inputs || {}) })
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
