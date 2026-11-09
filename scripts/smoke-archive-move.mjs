#!/usr/bin/env node
/**
 * 冒烟：会话归档 → 画布目录搬出；取消归档 → 搬回。
 *
 * 为什么不能只测「文件搬过去了」：这条链路的坑全在边界上——
 *  - 归档路径配成相对路径 / 配到会话目录里面；
 *  - 跨盘（NAS）没法 rename，只能拷贝后删源；
 *  - 拷贝完成但删源前崩溃：两边都在，重放必须去重而不是造 .dup 垃圾；
 *  - 目标里已有同名不同内容文件：**绝不能覆盖**，要留 .dup；
 *  - 归档/取消归档都是幂等的，重复事件不能把目录搬丢。
 *
 * 隔离：HOME / 插件配置全部改指临时目录，绝不碰真实 ~/.dsh 与用户工作区。
 *
 * 用法：node scripts/smoke-archive-move.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'svs-archive-home-'))
process.env.HOME = HOME
process.env.DSH_SVS_CONFIG = join(HOME, 'config.json')
process.env.DSH_SVS_SKILL_REFRESH = 'off'
process.env.DSH_SVS_ARCHIVE_SETTLE_MS = '0'

const {
  archiveSessionDir, restoreSessionDir, diffArchived, dirsIdentical, dirStats,
  normalizeArchiveRoot, expandHomePath, mergeInto, probeArchiveRoot,
  readArchiveIndex, updateArchiveIndex, movePath, pathExists,
} = await import('../lib/archive-move.js')

let passed = 0
let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}
const eq = (name, actual, expected) => ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 轮询等条件成立（最多 timeout ms）；返回是否成立。 */
async function waitFor(predicate, timeout = 2000, step = 25) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(step)
  }
  return false
}

const ROOT = mkdtempSync(join(tmpdir(), 'svs-archive-ws-'))
const WS = join(ROOT, 'workspace')
const SID = 'session-abc-123'
const CANVAS = join(WS, 'canvas', SID)

function seedCanvas({ label = 'v1', extra = null } = {}) {
  mkdirSync(join(CANVAS, 'media'), { recursive: true })
  writeFileSync(join(CANVAS, 'project.json'), JSON.stringify({ sessionId: SID, label, nodes: [{ id: 'n1' }] }), 'utf8')
  writeFileSync(join(CANVAS, 'media', 'frame.png'), label === 'v1' ? 'PNG-A' : 'PNG-B-larger')
  if (extra) writeFileSync(join(CANVAS, extra), 'x', 'utf8')
}

try {
  // -------------------------------------------------------------------------
  // 纯函数：路径规范化
  // -------------------------------------------------------------------------
  console.log('\n[1] 路径规范化')
  eq('空值 → 关闭', normalizeArchiveRoot(''), '')
  eq('空白 → 关闭', normalizeArchiveRoot('   '), '')
  eq('相对路径非法', normalizeArchiveRoot('archive'), null)
  eq('~ 展开为 HOME', normalizeArchiveRoot('~/dsh-archive'), join(HOME, 'dsh-archive'))
  eq('~ 单独也展开', normalizeArchiveRoot('~'), HOME)
  ok('绝对路径原样', normalizeArchiveRoot('/tmp/svs-archive') === '/tmp/svs-archive')
  eq('expandHomePath 不动普通绝对路径', expandHomePath('/a/b'), '/a/b')

  // -------------------------------------------------------------------------
  // 纯函数：归档集合 diff
  // -------------------------------------------------------------------------
  console.log('\n[2] 归档集合 diff')
  {
    const d1 = diffArchived(new Set(['a', 'b']), ['b', 'c'])
    eq('新增项', JSON.stringify(d1.added), '["c"]')
    eq('移除项', JSON.stringify(d1.removed), '["a"]')
    const d2 = diffArchived([], ['x'])
    eq('空基线全部算新增', JSON.stringify(d2.added), '["x"]')
    const d3 = diffArchived(['x'], ['x'])
    ok('无变化为空', d3.added.length === 0 && d3.removed.length === 0)
  }

  // -------------------------------------------------------------------------
  // 搬迁 / 回迁
  // -------------------------------------------------------------------------
  console.log('\n[3] 归档 / 取消归档')
  const ARCH1 = join(ROOT, 'archive-1')
  mkdirSync(ARCH1, { recursive: true })
  seedCanvas()

  {
    const stats = await dirStats(CANVAS)
    eq('搬迁前统计文件数', stats.files, 2)
    ok('搬迁前统计大小 > 0', stats.bytes > 0)

    const r1 = await archiveSessionDir({ workspacePath: WS, sessionId: SID, archiveRoot: ARCH1 })
    eq('首次归档 status=moved（同盘）', r1.status, 'moved')
    ok('工作区目录已消失', !existsSync(CANVAS))
    ok('归档区目录已就位', existsSync(join(ARCH1, SID, 'project.json')))
    ok('媒体文件一起搬走', existsSync(join(ARCH1, SID, 'media', 'frame.png')))
    eq('归档内容未变', JSON.parse(readFileSync(join(ARCH1, SID, 'project.json'), 'utf8')).sessionId, SID)

    const r2 = await archiveSessionDir({ workspacePath: WS, sessionId: SID, archiveRoot: ARCH1 })
    eq('重复归档幂等（already-archived）', r2.status, 'already-archived')
    ok('归档区仍在', existsSync(join(ARCH1, SID, 'project.json')))

    const b1 = await restoreSessionDir({ workspacePath: WS, sessionId: SID, archiveRoot: ARCH1 })
    eq('取消归档 status=restored', b1.status, 'restored')
    ok('画布回到工作区', existsSync(join(CANVAS, 'project.json')))
    ok('归档区已清空', !existsSync(join(ARCH1, SID)))

    const b2 = await restoreSessionDir({ workspacePath: WS, sessionId: SID, archiveRoot: ARCH1 })
    eq('重复取消归档幂等（in-workspace）', b2.status, 'in-workspace')

    const b3 = await archiveSessionDir({ workspacePath: WS, sessionId: 'session-no-canvas', archiveRoot: ARCH1 })
    eq('没有画布的会话 no-canvas', b3.status, 'no-canvas')
  }

  // -------------------------------------------------------------------------
  // 崩溃重放 / 冲突
  // -------------------------------------------------------------------------
  console.log('\n[4] 崩溃重放与冲突保护')
  const ARCH2 = join(ROOT, 'archive-2')
  mkdirSync(ARCH2, { recursive: true })
  {
    // 模拟「cp 完成、rm 未完成」：两边内容一致 → 去重，不造 .dup
    mkdirSync(join(ARCH2, SID), { recursive: true })
    seedCanvas()
    writeFileSync(join(ARCH2, SID, 'project.json'), readFileSync(join(CANVAS, 'project.json')))
    mkdirSync(join(ARCH2, SID, 'media'), { recursive: true })
    writeFileSync(join(ARCH2, SID, 'media', 'frame.png'), readFileSync(join(CANVAS, 'media', 'frame.png')))
    ok('两边内容一致（dirsIdentical）', await dirsIdentical(CANVAS, join(ARCH2, SID)))
    const r = await archiveSessionDir({ workspacePath: WS, sessionId: SID, archiveRoot: ARCH2 })
    eq('一致时 deduped', r.status, 'deduped')
    ok('副本已删、归档区保留', !existsSync(CANVAS) && existsSync(join(ARCH2, SID, 'project.json')))
    ok('没有产生 .dup 文件', !readdirSync(join(ARCH2, SID)).some((n) => n.includes('.dup-')))

    // 回迁后造「同名不同内容」：源（归档区）比工作区新 → 保留双方，源改名 .dup，绝不覆盖
    await restoreSessionDir({ workspacePath: WS, sessionId: SID, archiveRoot: ARCH2 })
    seedCanvas({ label: 'v1', extra: 'only-in-workspace.txt' })
    mkdirSync(join(ARCH2, SID), { recursive: true })
    writeFileSync(join(ARCH2, SID, 'project.json'), JSON.stringify({ sessionId: SID, label: 'v2-archive' }), 'utf8')
    const r3 = await archiveSessionDir({ workspacePath: WS, sessionId: SID, archiveRoot: ARCH2 })
    eq('冲突合并 status=merged', r3.status, 'merged')
    eq('冲突文件改名 1 个', r3.renamed, 1)
    ok('工作区原有 only-in-workspace.txt 已在归档区', existsSync(join(ARCH2, SID, 'only-in-workspace.txt')))
    ok('两边 project.json 都在（另一份 .dup）', existsSync(join(ARCH2, SID, 'project.json')) && readdirSync(join(ARCH2, SID)).some((n) => n.startsWith('project.json.dup-')))
    eq('归档区的 project.json 没被覆盖', JSON.parse(readFileSync(join(ARCH2, SID, 'project.json'), 'utf8')).label, 'v2-archive')

    // 清理后重来
    rmSync(join(ARCH2, SID), { recursive: true, force: true })
    ok('清空归档区', !existsSync(join(ARCH2, SID)))
  }

  // -------------------------------------------------------------------------
  // mergeInto 纯函数
  // -------------------------------------------------------------------------
  console.log('\n[5] mergeInto')
  {
    const a = join(ROOT, 'merge-a')
    const b = join(ROOT, 'merge-b')
    mkdirSync(join(a, 'sub'), { recursive: true })
    mkdirSync(join(b, 'sub'), { recursive: true })
    writeFileSync(join(a, 'same.bin'), 'AA')
    writeFileSync(join(b, 'same.bin'), 'AA')
    writeFileSync(join(a, 'diff.bin'), 'A')
    writeFileSync(join(b, 'diff.bin'), 'BBBBB')
    writeFileSync(join(a, 'sub', 'x.txt'), 'x')
    const stats = await mergeInto(a, b)
    eq('同名同大小记为 dedupe', stats.deduped, 1)
    eq('同名不同大小改名', stats.renamed, 1)
    eq('新文件搬入', stats.moved, 1)
    ok('目标 diff.bin 未被覆盖', readFileSync(join(b, 'diff.bin'), 'utf8') === 'BBBBB')
    ok('源目录已空（只剩已递归合并的 sub 被删）', !existsSync(join(a, 'sub', 'x.txt')))
  }

  // -------------------------------------------------------------------------
  // 索引
  // -------------------------------------------------------------------------
  console.log('\n[6] 归档区索引')
  {
    const idxRoot = join(ROOT, 'archive-index')
    mkdirSync(idxRoot, { recursive: true })
    const i0 = await readArchiveIndex(idxRoot)
    eq('缺失索引返回空', Object.keys(i0.sessions).length, 0)
    await updateArchiveIndex(idxRoot, SID, { workspacePath: WS, workspaceTitle: 'demo', archivedAt: '2026-01-01T00:00:00.000Z', files: 2, bytes: 10 })
    const i1 = await readArchiveIndex(idxRoot)
    eq('写入一条', i1.sessions[SID].workspacePath, WS)
    eq('索引文件已落盘', existsSync(join(idxRoot, '.dsh-svs-archive-index.json')), true)
    await updateArchiveIndex(idxRoot, SID, null)
    const i2 = await readArchiveIndex(idxRoot)
    eq('删除一条', i2.sessions[SID], undefined)
    // 损坏索引不抛
    writeFileSync(join(idxRoot, '.dsh-svs-archive-index.json'), '{not json', 'utf8')
    const i3 = await readArchiveIndex(idxRoot)
    eq('损坏索引回落空', Object.keys(i3.sessions).length, 0)
  }

  // -------------------------------------------------------------------------
  // 归档路径探测 / 安全边界
  // -------------------------------------------------------------------------
  console.log('\n[7] 路径探测与安全边界')
  {
    const missing = await probeArchiveRoot(join(ROOT, 'not-yet'))
    eq('不存在的路径 configured=true', missing.configured, true)
    eq('不存在 exists=false', missing.exists, false)
    const existsRoot = join(ROOT, 'probe-ok')
    mkdirSync(existsRoot, { recursive: true })
    const probed = await probeArchiveRoot(existsRoot)
    eq('存在的可写路径 writable=true', probed.writable, true)
    ok('探测完不留测试文件', readdirSync(existsRoot).length === 0)

    // 归档路径位于会话目录内部必须拒绝
    mkdirSync(CANVAS, { recursive: true })
    writeFileSync(join(CANVAS, 'project.json'), '{}')
    let threw = false
    try {
      await archiveSessionDir({ workspacePath: WS, sessionId: SID, archiveRoot: join(CANVAS, 'nested') })
    } catch { threw = true }
    ok('归档路径在会话目录内部 → 拒绝', threw)
    rmSync(CANVAS, { recursive: true, force: true })
  }

  // -------------------------------------------------------------------------
  // 与宿主接线：reconcileArchive（假 workspaceRegistry）
  // -------------------------------------------------------------------------
  console.log('\n[8] 宿主对账 reconcileArchive（假 ctx）')
  {
    writeFileSync(process.env.DSH_SVS_CONFIG, JSON.stringify({ archiveRoot: join(ROOT, 'archive-live') }), 'utf8')
    const { _internals } = await import('../lib/index.js')
    const archived = []
    const wsRecord = { id: 'ws-1', path: WS, title: 'demo-ws', sessionIds: [SID, 'session-other'] }
    const ctx = {
      workspaceRegistry: {
        get archivedSessionIds() { return archived.slice() },
        list: () => [wsRecord],
        get: (id) => (id === 'ws-1' ? wsRecord : undefined),
      },
    }

    seedCanvas({ label: 'live' })
    const missing = await _internals.reconcileArchive(ctx)
    eq('未归档时不搬', existsSync(join(WS, 'canvas', SID)), true)
    eq('未归档时 archivedMoved=0', missing.archivedMoved, 0)

    archived.push(SID)
    const moved = await _internals.reconcileArchive(ctx)
    eq('已归档 → 搬出 1 个', moved.archivedMoved, 1)
    ok('工作区目录已消失', !existsSync(join(WS, 'canvas', SID)))
    ok('归档区目录已就位', existsSync(join(ROOT, 'archive-live', SID, 'project.json')))
    const idx = await readArchiveIndex(join(ROOT, 'archive-live'))
    eq('索引记录了工作区路径', idx.sessions[SID].workspacePath, WS)
    eq('索引记录了文件数', idx.sessions[SID].files, 2)

    archived.length = 0
    const restored = await _internals.reconcileArchive(ctx)
    eq('已取消归档 → 回迁 1 个', restored.restored, 1)
    ok('画布回到工作区', existsSync(join(WS, 'canvas', SID, 'project.json')))
    const idx2 = await readArchiveIndex(join(ROOT, 'archive-live'))
    eq('索引条目已删除', idx2.sessions[SID], undefined)

    const again = await _internals.reconcileArchive(ctx)
    eq('重复对账幂等（不再搬）', again.archivedMoved + again.restored, 0)

    // 打开画布前的按需回迁：已取消归档、画布还在归档区时，GET /canvas 的等待逻辑应把它搬回来
    archived.push(SID)
    await _internals.reconcileArchive(ctx)
    ok('按需回迁前：画布在归档区', existsSync(join(ROOT, 'archive-live', SID, 'project.json')))
    archived.length = 0
    const waited = await _internals.ensureArchiveRestored(ctx, WS, SID)
    eq('按需回迁状态', waited.status, 'restored')
    ok('按需回迁后：画布已在工作区', existsSync(join(WS, 'canvas', SID, 'project.json')))
    const again2 = await _internals.ensureArchiveRestored(ctx, WS, SID)
    eq('已在工作区时按需回迁 no-op', again2.status, 'in-workspace')

    // 未配置归档路径：对账直接跳过
    writeFileSync(process.env.DSH_SVS_CONFIG, JSON.stringify({}), 'utf8')
    const skipped = await _internals.reconcileArchive(ctx)
    eq('未配置时 configured=false', skipped.configured, false)
  }

  // -------------------------------------------------------------------------
  // 事件接线：domain/changed → 自动搬出/搬回
  // -------------------------------------------------------------------------
  console.log('\n[9] domain/changed 事件联动（假 ctx）')
  {
    const liveRoot = join(ROOT, 'archive-events')
    writeFileSync(process.env.DSH_SVS_CONFIG, JSON.stringify({ archiveRoot: liveRoot }), 'utf8')
    const { _internals } = await import('../lib/index.js')
    const archived = []
    const wsRecord = { id: 'ws-2', path: WS, title: 'evt', sessionIds: [SID] }
    let handler = null
    let disposed = false
    const ctx = {
      on: (name, cb) => {
        if (name === 'domain/changed') handler = cb
        return () => { disposed = true }
      },
      workspaceRegistry: {
        get archivedSessionIds() { return archived.slice() },
        list: () => [wsRecord],
        get: (id) => (id === 'ws-2' ? wsRecord : undefined),
      },
    }
    const off = _internals.startArchiveWatcher(ctx)
    ok('已注册 domain/changed 监听', typeof handler === 'function')
    eq('基线取自当前归档集（空）', archived.length, 0)

    // 非 workspace 域 / 非 global / 删除操作都应被忽略
    handler({ domain: 'other', table: '', key: '', operation: 'put', value: { archivedSessionIds: [SID] } })
    handler({ domain: 'workspace', table: 'workspaces', key: 'ws-2', operation: 'put', value: {} })
    handler({ domain: 'workspace', table: '', key: '', operation: 'deleted' })
    await sleep(30)
    ok('无关事件不搬', existsSync(join(WS, 'canvas', SID)))

    seedCanvas({ label: 'evt' })
    // 先模拟「DSH 已把 id 写进 registry 再广播」：watcher 的基线仍在内存里
    archived.push(SID)
    handler({ domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: [SID] } })
    await waitFor(() => !existsSync(join(WS, 'canvas', SID)), 3000)
    ok('归档事件 → 画布被搬出工作区', !existsSync(join(WS, 'canvas', SID)))
    ok('归档区出现该会话', existsSync(join(liveRoot, SID, 'project.json')))

    archived.length = 0
    handler({ domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: [] } })
    await waitFor(() => existsSync(join(WS, 'canvas', SID, 'project.json')), 3000)
    ok('取消归档事件 → 画布搬回工作区', existsSync(join(WS, 'canvas', SID, 'project.json')))

    // 竞态：归档后又立刻取消（稳定等待期内）→ 最终必须留在工作区，不能被迟到的 archive 搬走
    archived.push(SID)
    handler({ domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: [SID] } })
    archived.length = 0
    handler({ domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: [] } })
    await sleep(120)
    ok('稳定等待期内取消归档：画布留在工作区', existsSync(join(WS, 'canvas', SID, 'project.json')))
    ok('……也没有被搬到归档区', !existsSync(join(liveRoot, SID)))

    off()
    ok('注销时释放监听', disposed)
    rmSync(liveRoot, { recursive: true, force: true })
  }

  // -------------------------------------------------------------------------
  // movePath 基本行为
  // -------------------------------------------------------------------------
  console.log('\n[10] movePath')
  {
    const f = join(ROOT, 'f.txt')
    const g = join(ROOT, 'moved', 'g.txt')
    writeFileSync(f, 'hello')
    const via = await movePath(f, g)
    eq('同盘 rename', via, 'rename')
    ok('目标存在、源消失', existsSync(g) && !existsSync(f))
    ok('pathExists 对不存在返回 false', !(await pathExists(join(ROOT, 'nope'))))
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed) process.exit(1)
console.log('archive-move smoke passed')
