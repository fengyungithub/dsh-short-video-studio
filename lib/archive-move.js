/**
 * 会话归档 → 画布目录搬迁（纯 Node 模块，零 DSH 依赖）。
 *
 * 设计：DSH 的「归档会话」只是在 ~/.dsh/storages/workspace.json 里加一个
 * sessionId（见 lib/index.js 的 domain/changed 监听），它本身不碰工作区文件。
 * 本模块补上「归档时把 <工作区>/canvas/<sessionId> 搬到归档路径，取消归档再搬回」。
 *
 * 硬约束：
 *  - 绝不丢数据：目标已存在同名文件且内容（大小）不同 → 源文件改名成 `<name>.dup-<时间>`，两边都留；
 *    大小相同视为同一条（崩溃后 cp 完成、rm 未完成的重放），源副本删除。
 *  - 绝不覆盖：目标目录里已有文件不会被源覆盖。
 *  - 跨盘（NAS / 外置盘）：rename 抛 EXDEV 时退化为「拷贝到 `<dst>.partial-*` → rename 到位 → 删源」，
 *    中途失败清理 partial，源目录保持原样。
 *  - 串行：同一归档路径的索引写入、同一会话的搬迁都按 key 串行，避免并发交错。
 *
 * 归档区布局：
 *   <archiveRoot>/<sessionId>/...                 画布文件（project.json + 媒体）
 *   <archiveRoot>/.dsh-svs-archive-index.json     索引（工作区路径、标题、时间、大小），取消归档时兜底定位
 */

import { mkdir, readdir, rename, cp, rm, rmdir, stat, readFile, writeFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** 归档区内索引文件名（点开头，不会和 sessionId 目录撞名）。 */
export const ARCHIVE_INDEX_FILE = '.dsh-svs-archive-index.json'
/** 索引格式版本。 */
export const ARCHIVE_INDEX_VERSION = 1
/** 搬迁前的稳定等待：DSH 归档写完才发事件，但「停止并归档」的取消是随后才下达的，
 *  留一点时间让在飞的生成请求收到 abort 再动文件。 */
export const DEFAULT_SETTLE_MS = 2000
/** 搬迁后再复查一次的延迟（防止 abort 期间又写回 canvas/<sid>）。 */
export const DEFAULT_RECHECK_MS = 3000

/** 展开 `~`；空值返回 ''。不校验存在性。 */
export function expandHomePath(raw, home = homedir()) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  if (s === '~') return home
  if (s.startsWith('~/') || s.startsWith('~' + sep)) return join(home, s.slice(2))
  return s
}

/**
 * 规范化归档路径。空 → ''（功能关闭）；相对路径 → null（非法，跨工作区语义不清）。
 * @param {string} raw 用户配置的原始值。
 * @returns {string|null} 绝对路径，或 '' / null。
 */
export function normalizeArchiveRoot(raw) {
  const expanded = expandHomePath(raw)
  if (!expanded) return ''
  if (!isAbsolute(expanded)) return null
  return resolve(expanded)
}

/** path 是否在 dir 内部（含相等）。 */
export function isInsidePath(dir, candidate) {
  const a = resolve(dir)
  const b = resolve(candidate)
  return b === a || b.startsWith(a + sep)
}

/** 存在性检查（不抛）。 */
export async function pathExists(p) {
  try { await stat(p); return true } catch { return false }
}

/** 递归收集目录内容：相对路径 → 大小（目录记为 -1）。 */
async function collectTree(root, prefix = '', out = new Map()) {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return out }
  for (const ent of entries) {
    const rel = prefix ? prefix + '/' + ent.name : ent.name
    const abs = join(root, ent.name)
    if (ent.isDirectory()) {
      out.set(rel, -1)
      await collectTree(abs, rel, out)
    } else {
      try { out.set(rel, (await stat(abs)).size) } catch { out.set(rel, -2) }
    }
  }
  return out
}

/**
 * 两个目录是否「内容一致」（相对路径集合 + 文件大小）。用于崩溃后重放去重：
 * cp 完成但 rm 未完成时两边都在，内容一致就直接删副本，不做无谓的 dup 改名。
 */
export async function dirsIdentical(a, b) {
  if (!(await pathExists(a)) || !(await pathExists(b))) return false
  const [ta, tb] = [await collectTree(a), await collectTree(b)]
  if (ta.size !== tb.size) return false
  for (const [k, v] of ta) if (tb.get(k) !== v) return false
  return true
}

/**
 * 移动一个文件或目录。同盘 rename；跨盘（EXDEV）拷贝到 partial 再 rename 到位，最后删源。
 * 目标已存在时抛错（调用方必须先决定冲突策略）。
 * @returns {Promise<'rename'|'copy'>} 实际走的路径。
 */
export async function movePath(src, dst) {
  await mkdir(dirname(dst), { recursive: true })
  try {
    await rename(src, dst)
    return 'rename'
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }
  const partial = `${dst}.partial-${process.pid}-${Date.now()}`
  try {
    await cp(src, partial, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
    await rename(partial, dst)
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  await rm(src, { recursive: true, force: true })
  return 'copy'
}

function dupSuffix() {
  return '.dup-' + new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * 把 from 目录合并进 to（目标优先，绝不覆盖）：
 *  - 目标没有 → 移过去；
 *  - 两边都有同名目录 → 递归合并；
 *  - 两边都有同名文件且大小相同 → 视为同一份，删源副本；
 *  - 同名文件大小不同 → 源改名 `<name>.dup-<时间>` 放进目标，两边都留。
 * @returns {Promise<{moved:number, deduped:number, renamed:number, renamedFiles:string[]}>}
 */
export async function mergeInto(from, to, stats = { moved: 0, deduped: 0, renamed: 0, renamedFiles: [] }) {
  await mkdir(to, { recursive: true })
  let entries = []
  try { entries = await readdir(from, { withFileTypes: true }) } catch { return stats }
  for (const ent of entries) {
    const s = join(from, ent.name)
    const d = join(to, ent.name)
    if (!(await pathExists(d))) {
      await movePath(s, d)
      stats.moved++
      continue
    }
    const [sStat, dStat] = await Promise.all([stat(s), stat(d)])
    if (sStat.isDirectory() && dStat.isDirectory()) {
      await mergeInto(s, d, stats)
      await rmdir(s).catch(() => {})
      continue
    }
    if (!sStat.isDirectory() && !dStat.isDirectory() && sStat.size === dStat.size) {
      await unlink(s)
      stats.deduped++
      continue
    }
    const alt = d + dupSuffix()
    await movePath(s, alt)
    stats.renamed++
    stats.renamedFiles.push(basename(alt))
  }
  // 全部搬完后删掉空的源目录（非空说明还有没处理的东西，失败也无妨，调用方会按 leftover 报 conflict）。
  await rmdir(from).catch(() => {})
  return stats
}

/** 一次搬迁的结果。status 取值：moved / copied / merged / deduped / no-canvas / already-archived / restored / in-workspace / missing / conflict。 */
function result(status, extra = {}) {
  return { status, ...extra }
}

/**
 * 归档一个会话的画布目录：`<workspacePath>/canvas/<sessionId>` → `<archiveRoot>/<sessionId>`。
 * 幂等：源不存在 / 两边都在 / 目标已在，都有确定行为，可安全重放。
 */
export async function archiveSessionDir({ workspacePath, sessionId, archiveRoot, canvasDirName = 'canvas' }) {
  const src = join(workspacePath, canvasDirName, sessionId)
  const dst = join(archiveRoot, sessionId)
  if (isInsidePath(src, archiveRoot)) throw new Error('归档路径不能位于被搬迁的会话目录内部')
  const [srcExists, dstExists] = await Promise.all([pathExists(src), pathExists(dst)])
  if (!srcExists && !dstExists) return result('no-canvas')
  if (!srcExists) return result('already-archived')
  if (dstExists) {
    if (await dirsIdentical(src, dst)) {
      await rm(src, { recursive: true, force: true })
      return result('deduped')
    }
    const stats = await mergeInto(src, dst)
    const leftover = await pathExists(src)
    return result(leftover ? 'conflict' : 'merged', stats)
  }
  const via = await movePath(src, dst)
  return result(via === 'rename' ? 'moved' : 'copied', { via })
}

/**
 * 取消归档：`<archiveRoot>/<sessionId>` → `<workspacePath>/canvas/<sessionId>`。
 * 目标工作区已存在同名目录时合并（目标优先，源冲突改 .dup 留档）。
 */
export async function restoreSessionDir({ workspacePath, sessionId, archiveRoot, canvasDirName = 'canvas' }) {
  const src = join(archiveRoot, sessionId)
  const dst = join(workspacePath, canvasDirName, sessionId)
  const [srcExists, dstExists] = await Promise.all([pathExists(src), pathExists(dst)])
  if (!srcExists && !dstExists) return result('missing')
  if (!srcExists) return result('in-workspace')
  if (dstExists) {
    if (await dirsIdentical(src, dst)) {
      await rm(src, { recursive: true, force: true })
      return result('deduped')
    }
    const stats = await mergeInto(src, dst)
    const leftover = await pathExists(src)
    return result(leftover ? 'conflict' : 'merged', stats)
  }
  const via = await movePath(src, dst)
  return result(via === 'rename' ? 'restored' : 'copied', { via })
}

// ---------------------------------------------------------------------------
// 归档区索引（取消归档时的兜底定位 + 设置页诊断）
// ---------------------------------------------------------------------------

const indexLocks = new Map()

/** 读索引；不存在/损坏都返回空索引（不抛）。 */
export async function readArchiveIndex(archiveRoot) {
  const file = join(archiveRoot, ARCHIVE_INDEX_FILE)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') throw new Error('bad index')
    return {
      version: ARCHIVE_INDEX_VERSION,
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    }
  } catch {
    return { version: ARCHIVE_INDEX_VERSION, sessions: {} }
  }
}

/** 串行链：同一索引文件的读-改-写不交错。 */
async function withIndexLock(archiveRoot, fn) {
  const key = resolve(archiveRoot)
  const prev = indexLocks.get(key) || Promise.resolve()
  let release
  const tail = new Promise((r) => { release = r })
  const queued = prev.then(() => tail, () => tail)
  indexLocks.set(key, queued)
  await prev.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    if (indexLocks.get(key) === queued) indexLocks.delete(key)
  }
}

/**
 * 写入/删除一条索引记录（meta 为 null 表示删除）。原子写（tmp + rename）。
 * @returns {Promise<object>} 更新后的索引
 */
export async function updateArchiveIndex(archiveRoot, sessionId, meta) {
  return withIndexLock(archiveRoot, async () => {
    const index = await readArchiveIndex(archiveRoot)
    if (meta === null) delete index.sessions[sessionId]
    else index.sessions[sessionId] = { ...meta, sessionId }
    index.version = ARCHIVE_INDEX_VERSION
    await mkdir(archiveRoot, { recursive: true })
    const file = join(archiveRoot, ARCHIVE_INDEX_FILE)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(index, null, 2), 'utf8')
    await rename(tmp, file)
    return index
  })
}

// ---------------------------------------------------------------------------
// 诊断 / 规划
// ---------------------------------------------------------------------------

/** 归档路径探测：存在性 + 可写性（不创建目录；探测写在归档区根下并立刻删除）。 */
export async function probeArchiveRoot(archiveRoot) {
  if (!archiveRoot) return { configured: false, path: '', exists: false, writable: false, error: '' }
  const exists = await pathExists(archiveRoot)
  if (!exists) return { configured: true, path: archiveRoot, exists: false, writable: false, error: '' }
  const probe = join(archiveRoot, `.dsh-svs-write-test-${process.pid}-${Date.now()}`)
  try {
    await writeFile(probe, 'ok', 'utf8')
    await unlink(probe)
    return { configured: true, path: archiveRoot, exists: true, writable: true, error: '' }
  } catch (error) {
    return { configured: true, path: archiveRoot, exists: true, writable: false, error: String(error?.message || error) }
  }
}

/**
 * 归档集合 diff（纯函数）：给定上一次的归档集与本次的 archivedSessionIds，给出新增/移除。
 * @param {Set<string>|string[]} previous
 * @param {string[]} next
 * @returns {{added:string[], removed:string[]}}
 */
export function diffArchived(previous, next) {
  const prev = previous instanceof Set ? previous : new Set(previous || [])
  const cur = new Set((next || []).map(String))
  const added = []
  const removed = []
  for (const id of cur) if (!prev.has(id)) added.push(id)
  for (const id of prev) if (!cur.has(id)) removed.push(id)
  return { added, removed }
}

/** 目录统计（大小 + 文件数），用于索引与设置页展示；目录不存在返回 null。 */
export async function dirStats(dir) {
  if (!(await pathExists(dir))) return null
  const tree = await collectTree(dir)
  let files = 0
  let bytes = 0
  for (const [, size] of tree) {
    if (size < 0) continue
    files++
    bytes += size
  }
  return { files, bytes }
}
