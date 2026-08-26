/**
 * lib/assets.js — 跨会话资产库（角色卡/场景卡/风格锚点）。
 *
 * 存储（workspace 作用域，与 canvas 同级）：
 *   <root>/.dsh-assets/library.json   索引
 *   <root>/.dsh-assets/images/        图片文件（稳定路径）
 *
 * 资产 id 规范：<type>:<name>[/<state>]，type ∈ character / scene / style，
 *   name/state 仅小写字母/数字/._-。引用时 char: 是 character: 的别名。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { join, extname } from 'node:path'

export const ASSET_DIR = '.dsh-assets'
export const ASSET_TYPES = ['character', 'scene', 'style']

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

/** 判断 ref 是否为资产 id（character:/char:/scene:/style: 前缀）。 */
export function isAssetRef(ref) {
  return typeof ref === 'string' && /^(character|char|scene|style):/i.test(ref)
}

/** ref → 规范资产 id（char: → character:）。 */
export function canonicalAssetId(ref) {
  return String(ref).replace(/^char:/i, 'character:')
}

/** 资产 id → 绝对图片路径（不存在返回 null）。 */
export function resolveAssetImagePath(root, lib, ref) {
  const id = canonicalAssetId(ref)
  const a = lib.assets[id]
  if (!a?.image) return null
  const abs = join(root, ...String(a.image).split('/'))
  return existsSync(abs) ? abs : null
}

/** 登记资产：把源图拷进库 images/，写入索引。返回资产记录。 */
export function registerAsset(root, lib, { id, type, name, state, srcAbsPath, meta = {} }) {
  mkdirSync(assetImagesDir(root), { recursive: true })
  const ext = (extname(srcAbsPath) || '.png').toLowerCase()
  const relImage = `${ASSET_DIR}/images/${assetFilename(id)}${ext}`
  const dest = join(root, ...relImage.split('/'))
  cpSync(srcAbsPath, dest)
  const prev = lib.assets[id] || {}
  lib.assets[id] = {
    id,
    type: canonType(type),
    name: name || id,
    state: state || 'default',
    image: relImage,
    ...meta,
    createdAt: prev.createdAt || Date.now(),
    updatedAt: Date.now(),
  }
  saveLibrary(root, lib)
  return lib.assets[id]
}

/** 从索引移除资产（不删文件，避免误删复用中的图）。 */
export function removeAsset(root, lib, ref) {
  const id = canonicalAssetId(ref)
  if (!lib.assets[id]) return false
  delete lib.assets[id]
  saveLibrary(root, lib)
  return true
}
