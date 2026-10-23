/**
 * lib/assets.js — 跨会话资产库（角色卡/场景卡/风格锚点/视频片段/文本）。
 *
 * 存储（workspace 作用域，与 canvas 同级）：
 *   <root>/.dsh-assets/library.json   索引
 *   <root>/.dsh-assets/images/        文件（图片/视频，稳定路径；目录名沿用 images/ 以免破坏既有库）
 *
 * 两个**正交**概念（别混）：
 *   kind —— 载体：image / video / text。决定怎么存、怎么物化回画布。由来源节点的 kind 派生。
 *   type —— 语义类别：character / scene / style / clip / text。决定分组与 asset_list 过滤。
 *   kind 与 type 的合法组合见 TYPE_KINDS（图片→角色/场景/风格锚点，视频→片段，文本→文本）。
 *
 * 资产 id：新入库为不透明随机 id `<type>:<16 位 hex>`（与显示名解耦、永久不变）；老库可能仍是
 *   `<type>:<name>[/<state>]` 的可读形式（历史遗留）。显示名 name 可随时重命名，不影响 id 与引用；
 *   状态 state 是历史遗留字段（界面不再提供编辑，仅分组标题只读展示）。
 *   引用时 char: 是 character: 的别名。
 *
 * 兼容性：v1.4 之前的记录只有 { type, image }，没有 kind/file 字段。读取一律走
 *   assetKind() / assetStoredFile()，不要直接读字段。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { join, extname } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

export const ASSET_DIR = '.dsh-assets'
export const ASSET_TYPES = ['character', 'scene', 'style', 'clip', 'text']
export const ASSET_KINDS = ['image', 'video', 'text']

/** type → kind（每个语义类别只由一种载体承载）。 */
export const TYPE_KINDS = {
  character: 'image',
  scene: 'image',
  style: 'image',
  clip: 'video',
  text: 'text',
}

/** 来源画布节点 kind → 资产 kind（table 也算文本）。 */
export const NODE_KINDS = { image: 'image', video: 'video', text: 'text', table: 'text' }

/** 某个 kind 允许的 type 列表（UI 用它过滤下拉框）。 */
export function assetTypesForKind(kind) {
  return ASSET_TYPES.filter((t) => TYPE_KINDS[t] === kind)
}

// 允许 Unicode 字母/数字（含中文）+ . _ -；首字符必须是字母/数字
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u

export function assetDir(root) { return join(root, ASSET_DIR) }
export function assetFile(root) { return join(assetDir(root), 'library.json') }
export function assetImagesDir(root) { return join(assetDir(root), 'images') }

/** 资产 id → 安全文件名（把 : 和 / 换成 -；中文原样保留）。 */
export function assetFilename(id) { return String(id).normalize('NFKC').replace(/[:/]+/g, '-') }

/** 把任意标题转成合法资产名（小写，Unicode 字母/数字原样保留，其它字符转 -）。中文标题不再变成空串。 */
export function slugifyName(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}

export function emptyLibrary() { return { version: 1, assets: {} } }

export function loadLibrary(root) {
  const file = assetFile(root)
  if (!existsSync(file)) return emptyLibrary()
  try {
    const p = JSON.parse(readFileSync(file, 'utf8'))
    return (p && typeof p === 'object' && p.assets && typeof p.assets === 'object')
      ? { version: 1, assets: p.assets }
      : emptyLibrary()
  } catch {
    return emptyLibrary()
  }
}

export function saveLibrary(root, lib) {
  mkdirSync(assetDir(root), { recursive: true })
  writeFileSync(assetFile(root), JSON.stringify({ version: 1, assets: (lib && lib.assets) || {} }, null, 2), 'utf8')
}

function canonType(t) {
  const x = String(t || '').toLowerCase()
  return x === 'char' ? 'character' : x
}

/** 资产的载体（image/video/text）。旧记录没有 kind 字段，按 type 推导。 */
export function assetKind(a) {
  if (!a) return null
  if (a.kind && ASSET_KINDS.includes(a.kind)) return a.kind
  if (a.type && TYPE_KINDS[a.type]) return TYPE_KINDS[a.type]
  return a.image || a.file ? 'image' : null
}

/** 资产在库里的相对文件路径（视频/图片）。文本资产返回 null。 */
export function assetStoredFile(a) {
  if (!a) return null
  return a.file || a.image || null
}

/**
 * 构造**老式可读 id**（`<type>:<name>[/<state>]`）。新入库不再用它——id 由
 * newAssetId() 随机生成，显示名与 id 解耦。保留它是为了兼容老库 / 脚本导入。
 */
export function normalizeAssetId(type, name, state) {
  const t = canonType(type)
  if (!ASSET_TYPES.includes(t)) throw new Error(`asset type "${type}" 非法（应为 ${ASSET_TYPES.join('/')}）`)
  const n = String(name || '').normalize('NFKC').toLowerCase().trim()
    .replace(/[·•・—–]+/g, '-')
    .replace(/\s+/g, '-')
  if (!NAME_RE.test(n)) throw new Error('asset name 仅允许字母/数字（含中文等 Unicode 字符）与 . _ -，且以字母或数字开头')
  const s = state ? String(state).normalize('NFKC').toLowerCase().trim().replace(/[·•・—–]+/g, '-').replace(/\s+/g, '-') : ''
  if (s && !NAME_RE.test(s)) throw new Error('asset state 仅允许字母/数字（含中文等 Unicode 字符）与 . _ -')
  return s ? `${t}:${n}/${s}` : `${t}:${n}`
}

/** 判断 ref 是否为资产 id（character:/char:/scene:/style:/clip:/text: 前缀）。 */
export function isAssetRef(ref) {
  return typeof ref === 'string' && /^(character|char|scene|style|clip|text):/i.test(ref)
}

/** ref → 规范资产 id（char: → character:）。 */
export function canonicalAssetId(ref) {
  return String(ref).replace(/^char:/i, 'character:')
}

/**
 * 显示名规范化：保留大小写与中文标点（显示名不再是 id 的一部分），只做
 * NFKC、控制字符 → 空格、连续空白折叠、去首尾空白，并截到 80 字。
 */
export function normalizeDisplayName(s) {
  const v = String(s == null ? '' : s).normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [...v].slice(0, 80).join('')
}

/**
 * 生成**不透明资产 id**：`<type>:<16 位随机 hex>`。
 * 为什么不是 `<type>:<name>`：id 是跨会话引用的唯一键，一旦和名字绑定，
 * 改名就得换 id、所有引用都得迁移。随机 id 入库后永久不变，显示名随便改。
 * 循环避让自己库里的碰撞；极端情况退回完整 uuid。
 */
export function newAssetId(lib, type) {
  const t = canonType(type)
  for (let i = 0; i < 10; i++) {
    const id = `${t}:${randomBytes(8).toString('hex')}`
    if (!lib?.assets?.[id]) return id
  }
  return `${t}:${randomUUID().replace(/-/g, '')}`
}

/** 老式 id 的解析（仅用于给没有 name 字段的旧记录兜底显示名/状态）。 */
function parseLegacyId(id) {
  const m = /^([^:/]+):([^/]+)(?:\/(.+))?$/.exec(String(id || ''))
  return m ? { type: m[1], name: m[2], state: m[3] || '' } : { type: '', name: '', state: '' }
}

/** 资产的显示名（人类可读、可重命名；id 保持稳定）。 */
export function assetDisplayName(a) {
  if (!a) return ''
  const n = normalizeDisplayName(a.name)
  if (n) return n
  return parseLegacyId(a.id).name || String(a.id || '')
}

/** 资产的显示状态（分组用；新资产与 id 无关，老资产缺字段时从 id 解析）。 */
export function assetDisplayState(a) {
  if (!a) return 'default'
  const s = normalizeDisplayName(a.state)
  // 记录里有 state 就以它为准（哪怕就是 default）——否则「把老资产的状态改回 default」
  // 会被 id 里残留的旧 state 又顶回来。
  if (s) return s.toLowerCase() === 'default' ? 'default' : s
  const legacy = parseLegacyId(a.id).state
  return legacy && legacy.toLowerCase() !== 'default' ? legacy : 'default'
}

/**
 * 按「类型 + 显示名」找已有资产 id（入库时同名更新、重命名时查重都用它）。
 * 唯一性**不含 state**：同类型下显示名就是用户看到的那个名字，允许「同名不同状态」会让
 * 用户分不清两张卡。state 只是显示 / 分组字段。
 */
export function findAssetByLabel(lib, type, name) {
  const t = canonType(type)
  const n = normalizeDisplayName(name).toLowerCase()
  for (const [id, a] of Object.entries((lib && lib.assets) || {})) {
    if (!a || canonType(a.type) !== t) continue
    if (assetDisplayName(a).toLowerCase() !== n) continue
    return id
  }
  return null
}

/** 资产 → 绝对文件路径（任意 kind，只要它落在磁盘上；不存在返回 null）。 */
export function resolveAssetPath(root, lib, ref) {
  const id = canonicalAssetId(ref)
  const rel = assetStoredFile(lib.assets[id])
  if (!rel) return null
  const abs = join(root, ...String(rel).split('/'))
  return existsSync(abs) ? abs : null
}

/**
 * 资产 → 绝对**图片**路径。只认 kind=image —— 视频/文本资产返回 null。
 * 这是给 ref_nodes / first_frame 用的（ComfyUI 只吃图片），
 * 不加这道闸的话视频会被当成参考图递进去，报错点离真相很远。
 */
export function resolveAssetImagePath(root, lib, ref) {
  const id = canonicalAssetId(ref)
  if (assetKind(lib.assets[id]) !== 'image') return null
  return resolveAssetPath(root, lib, id)
}

/**
 * 登记资产。按 kind 分两条路：
 *   - image / video：把源文件拷进库 images/（扩展名沿用源文件）
 *   - text：正文直接存进索引的 `text` 字段，不落文件
 * 覆盖同名 id 时保留 createdAt。
 */
export function registerAsset(root, lib, { id, type, name, state, srcAbsPath, text, title, nodeKind, meta = {} }) {
  const prev = lib.assets[id] || {}
  const t = canonType(type)
  const kind = TYPE_KINDS[t]
  if (!kind) throw new Error(`asset type "${type}" 非法（应为 ${ASSET_TYPES.join('/')}）`)

  const rec = {
    id,
    type: t,
    name: normalizeDisplayName(name) || String(id),
    state: normalizeDisplayName(state) || 'default',
    ...meta,
    // kind 放在 meta 之后：调用方传的 meta 里若混进 kind/name 之类的键，
    // 不能覆盖掉由 type 推导出的载体（那是记录正确性的根）。
    kind,
    createdAt: prev.createdAt || Date.now(),
    updatedAt: Date.now(),
  }

  if (kind === 'text') {
    rec.text = String(text == null ? prev.text || '' : text)
    rec.title = title || prev.title || name || id
    if (nodeKind) rec.nodeKind = nodeKind === 'table' ? 'table' : 'text'
    delete rec.file
    delete rec.image
  } else {
    if (!srcAbsPath || !existsSync(srcAbsPath)) throw new Error('源文件不存在: ' + (srcAbsPath || '(空)'))
    mkdirSync(assetImagesDir(root), { recursive: true })
    const ext = (extname(srcAbsPath) || (kind === 'video' ? '.mp4' : '.png')).toLowerCase()
    const rel = `${ASSET_DIR}/images/${assetFilename(id)}${ext}`
    cpSync(srcAbsPath, join(root, ...rel.split('/')))
    rec.file = rel
    // 旧字段名（≤v1.4 记录用 image）：新记录一律写 file，同时清掉可能残留的旧键，
    // 否则覆盖登记后两个字段会指向不同文件。
    delete rec.image
    delete rec.text
  }

  lib.assets[id] = rec
  saveLibrary(root, lib)
  return rec
}

/**
 * 从索引移除资产，并**尽力**清掉它留下的文件。
 *
 * 删文件的前提是「没有别的资产记录还指向同一个文件」——库按 id 命名文件，
 * 理论上不会共享，但覆盖登记 / 手工编辑索引都可能造成共享，删之前必须确认，
 * 否则会把仍在用的图删掉（这正是旧版只删索引不删文件的原因）。
 * 文件删除失败（权限/占用）不影响索引删除的结果，只是 fileDeleted=false。
 */
export function removeAsset(root, lib, ref) {
  const id = canonicalAssetId(ref)
  const a = lib.assets[id]
  if (!a) return { removed: false, id, file: null, fileDeleted: false }

  const rel = assetStoredFile(a)
  delete lib.assets[id]
  saveLibrary(root, lib)

  if (!rel) return { removed: true, id, file: null, fileDeleted: false }
  const stillUsed = Object.values(lib.assets).some((x) => assetStoredFile(x) === rel)
  if (stillUsed) return { removed: true, id, file: rel, fileDeleted: false }

  // fileDeleted 的语义是「确实删掉了一个文件」：先判存在再删，
  // 否则 rmSync({force}) 对不存在的路径也静默成功，会报出一个骗人的 true。
  const abs = join(root, ...String(rel).split('/'))
  let fileDeleted = false
  try {
    if (existsSync(abs)) { rmSync(abs, { force: true }); fileDeleted = true }
  } catch { /* 索引已删，文件留着不影响正确性 */ }
  return { removed: true, id, file: rel, fileDeleted }
}

/**
 * 重命名资产：只改**显示名**（`state` 参数只为 API / 脚本兼容保留，界面已不传），
 * id 与库文件永久不变。
 *
 * 为什么这样：id 是跨会话引用的唯一键（asset_list / asset_to_canvas / ref_nodes 都用它）。
 * 只要 id 不变，改名就不会影响任何画布、文本节点或历史对话里的引用，也不需要迁移。
 * （老资产的 id 可能仍是 `<type>:<name>[/<state>]` 的可读形式，属历史遗留，同样不再改。）
 *
 * 唯一性：**同类型 + 同显示名** 不允许重复（入库按这个键覆盖更新、重命名按它查重），
 * state 不参与唯一性。比较忽略大小写与全半角。
 *
 * 抛错：ASSET_NOT_FOUND（id 不存在）、ASSET_EXISTS（撞名）、BAD_NAME（显式传了空名字）。
 */
export function renameAsset(root, lib, ref, { name, state } = {}) {
  const id = canonicalAssetId(ref)
  const rec = lib.assets[id]
  if (!rec) {
    const e = new Error('资产不存在: ' + id)
    e.code = 'ASSET_NOT_FOUND'
    throw e
  }
  const oldName = assetDisplayName(rec)
  const oldState = assetDisplayState(rec)

  let nextName = oldName
  if (name !== undefined && name !== null) {
    nextName = normalizeDisplayName(name)
    if (!nextName) {
      const e = new Error('显示名不能为空')
      e.code = 'BAD_NAME'
      throw e
    }
  }
  let nextState = oldState
  if (state !== undefined && state !== null) {
    nextState = normalizeDisplayName(state) || 'default'
  }

  if (nextName === oldName && nextState === oldState) {
    return { renamed: false, id, name: nextName, state: nextState }
  }
  // 只在**名字真的变了**时查重：老库里可能本来就有同类型同名记录（旧 id 带 state 时代），
  // 只改 state 不应被既有重复挡住。
  if (nextName !== oldName) {
    const collision = findAssetByLabel(lib, rec.type, nextName)
    if (collision && collision !== id) {
      const e = new Error(`同一类型下已有同名资产：${nextName}——换一个显示名，或先给已有资产改名`)
      e.code = 'ASSET_EXISTS'
      throw e
    }
  }

  rec.name = nextName
  rec.state = nextState || 'default'
  rec.updatedAt = Date.now()
  // 文本资产的展示标题：仍与旧显示名一致时才跟随，避免覆盖入库时自定义的标题
  if (assetKind(rec) === 'text' && (!rec.title || rec.title === oldName)) rec.title = nextName
  saveLibrary(root, lib)
  return { renamed: true, id, name: nextName, state: rec.state }
}
