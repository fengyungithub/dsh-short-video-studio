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
 * 资产 id 规范：<type>:<name>[/<state>]，name/state 仅小写字母/数字/._-。
 *   引用时 char: 是 character: 的别名。
 *
 * 兼容性：v1.4 之前的记录只有 { type, image }，没有 kind/file 字段。读取一律走
 *   assetKind() / assetStoredFile()，不要直接读字段。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { join, extname } from 'node:path'

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

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/

export function assetDir(root) { return join(root, ASSET_DIR) }
export function assetFile(root) { return join(assetDir(root), 'library.json') }
export function assetImagesDir(root) { return join(assetDir(root), 'images') }

/** 资产 id → 安全文件名（把 : 和 / 换成 -）。 */
export function assetFilename(id) { return String(id).replace(/[:/]+/g, '-') }

/** 把任意标题转成合法资产名（小写、非字母数字转 -，中文会变成空串）。 */
export function slugifyName(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
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

/** 规范化资产 id；非法输入抛错。 */
export function normalizeAssetId(type, name, state) {
  const t = canonType(type)
  if (!ASSET_TYPES.includes(t)) throw new Error(`asset type "${type}" 非法（应为 ${ASSET_TYPES.join('/')}）`)
  const n = String(name || '').toLowerCase().trim().replace(/\s+/g, '-')
  if (!NAME_RE.test(n)) throw new Error('asset name 仅小写字母/数字/._-，且字母或数字开头')
  const s = state ? String(state).toLowerCase().trim().replace(/\s+/g, '-') : ''
  if (s && !NAME_RE.test(s)) throw new Error('asset state 仅小写字母/数字/._-')
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
    name: name || id,
    state: state || 'default',
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
