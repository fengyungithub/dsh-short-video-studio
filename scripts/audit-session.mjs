/**
 * scripts/audit-session.mjs — 会话审计（P2 交互层的机器部分）
 *
 * 生产门只能验「state 里写了什么」，验不了「人真的点过头」。会话记录是唯一能证明
 * 「问过 / 没问过」的证据源：`~/.dsh/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`
 * （多帧拼接 zstd，需按 28 B5 2F FD 切片逐帧解）。
 *
 * 断言（Series 模式）：
 *   A1 三张卡都问过（方案 / 片段 / 交付），且顺序正确
 *   A2 首个视频生成发生在「方案卡」之后（不许先渲后问）
 * 断言（单片模式）：
 *   A1 角色卡 / 场景卡出图后必须问过「锁定」类确认（问句/选项同时含卡片名与 锁定|批准|继续|通过）
 *   A2 镜头表、分镜都必须问过，且首个 Sxx 视频在它们之后
 * 两种模式共有：
 *   A3 每镜都抽过帧、都记录过自检（extract_frame / canvas_record_check 次数 ≥ 视频生成次数）
 *   A4 重渲有边界（带 nodeId 的调用 ≤ 视频调用总数的一半）
 *   A5 字幕核验留痕（交付/终检节点正文含「字幕核验」）
 *   A6 没有「fast + 三视图」这类已知违规参数
 *
 * 用法：
 *   node scripts/audit-session.mjs --session e0b06202-de0e-4388-a21b-7c668e1e4027 [--workspace .] [--json]
 *   node scripts/audit-session.mjs --session session-e0b06202-...   # 带 session- 前缀一样命中
 *   node scripts/audit-session.mjs            # 不给 session 时取该 workspace 最新一条
 *   # 显式给了 session 但找不到时会报错 exit 2，绝不退回最新会话
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
const argOf = (n, d = '') => (argv.indexOf('--' + n) >= 0 ? argv[argv.indexOf('--' + n) + 1] : d)
const flag = (n) => argv.includes('--' + n)
const ws = resolve(argOf('workspace', process.cwd()))
const sidArg = argOf('session', '')

// 会话根目录（默认 ~/.dsh/sessions；测试可用 DSH_SVS_SESSION_ROOT 指向临时目录）
const SESSION_ROOT = process.env.DSH_SVS_SESSION_ROOT || join(homedir(), '.dsh', 'sessions')
const TRANSCRIPT = 'session.v4.jsonl.zstd'
/** 会话目录名编码不统一（老的是 <sid>，新的是 session-<sid>），一律按「去掉 session- 前缀的裸 id」比较。 */
const bareSid = (s) => String(s || '').trim().replace(/^session-/, '')
/** workspace 目录名是把路径里的非字母数字替换成 '-' 拼出来的，按「只留字母数字」归一后再比。 */
const normKey = (s) => String(s || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
const dirsIn = (dir) => (dir && existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => join(dir, x.name)) : [])
const transcriptOf = (d) => join(d, TRANSCRIPT)
const mtimeOf = (d) => {
  try { return statSync(transcriptOf(d)).mtimeMs } catch { try { return statSync(d).mtimeMs } catch { return 0 } }
}
const newestFirst = (dirs) => [...dirs].sort((a, b) => mtimeOf(b) - mtimeOf(a))

const allWorkspaceDirs = dirsIn(SESSION_ROOT)
const workspaceDirs = (() => {
  const exact = allWorkspaceDirs.filter((d) => normKey(basename(d)) === normKey(ws))
  if (exact.length) return exact
  // 兜底：老版本的宽松匹配（workspace 名里包含路径转义串）
  return allWorkspaceDirs.filter((d) => basename(d).includes(ws.replace(/\//g, '-')))
})()

function findSessionDir(sid) {
  const wanted = bareSid(sid)
  if (wanted) {
    // 显式指定 session：先在本次 workspace 里找，找不到再跨 workspace 找；
    // 都找不到就返回 ''（调用方报错退出），**绝不退回最新会话**。
    const scopes = [...workspaceDirs, ...allWorkspaceDirs.filter((d) => !workspaceDirs.includes(d))]
    let hits = []
    for (const scope of scopes) {
      hits = dirsIn(scope).filter((d) => bareSid(basename(d)) === wanted)
      if (hits.length) break
    }
    if (!hits.length) return ''
    return newestFirst(hits.filter((d) => existsSync(transcriptOf(d))))[0] || hits[0]
  }
  // 没指定 session：取该 workspace 下最新的一条
  return newestFirst(dirsIn(workspaceDirs[0]))[0] || ''
}

/** 多帧 zstd 解压（Node 的 zstdDecompressSync 只解第一帧）。 */
function decodeZstdFrames(buf) {
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
  const offs = []
  for (let i = 0; i < buf.length - 3; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i)
  }
  const parts = []
  for (let i = 0; i < offs.length; i++) {
    const s = offs[i]
    const e = i + 1 < offs.length ? offs[i + 1] : buf.length
    try { parts.push(zstdDecompressSync(buf.subarray(s, e))) } catch { /* 跳过坏帧 */ }
  }
  return Buffer.concat(parts).toString('utf8')
}

const dir = findSessionDir(sidArg)
if (!dir) {
  if (sidArg) console.error(`找不到会话记录：${sidArg}（在 ${SESSION_ROOT} 下按 <sid> 与 session-<sid> 两种目录名均未命中；不会退回最新会话）`)
  else console.error('找不到会话记录：' + ws)
  process.exit(2)
}
const file = join(dir, TRANSCRIPT)
if (!existsSync(file)) { console.error('会话没有 transcript：' + file); process.exit(2) }
const sid = bareSid(basename(dir))
const events = decodeZstdFrames(readFileSync(file)).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const calls = events.filter((e) => e.type === 'tool/call')
const parseArgs = (c) => { try { return JSON.parse(c.data?.arguments || '{}') } catch { return {} } }
const named = (n) => calls.filter((c) => c.data?.name === n)

const seriesMode = existsSync(join(ws, 'series/production-state.json'))
const rows = []
const add = (id, ok, detail) => rows.push({ id, ok, detail })

// A1/A2 —— 系列模式看「三张卡」，单片模式看「卡片锁定 + 镜头表/分镜先问后渲」
const asks = named('ask_user_question').map((c) => ({ seq: c.seq, args: parseArgs(c) }))
const askText = (a) => JSON.stringify(a.args)
// 只取「问句/选项 label」文本（不含 description）：别的问题在描述里顺带提到卡片，不算用户确认过卡片。
const askQuestionTexts = (a) => (a.args.questions || []).map((q) =>
  [q.header, q.question, ...(q.options || []).map((o) => o.label)].filter(Boolean).join(' '))
const askMatches = (a, subjectRe, lockRe) =>
  askQuestionTexts(a).some((t) => subjectRe.test(t) && (!lockRe || lockRe.test(t)))
const LOCK_RE = /锁定|批准|继续|通过/
const imageCalls = named('comfy_generate_image')
const videoCalls = named('comfy_generate_video')
const seqOf = (c) => c.seq || 0
const seqList = (list) => list.map(seqOf).join(',')

/** 卡片锁定检查：有卡片图 → 必须在第一张图之后问过（问句/选项同时含主体与 锁定|批准|继续|通过）。 */
const checkCardLock = (label, subjectRe) => {
  const id = `A1 ${label}锁定`
  const cards = imageCalls.filter((c) => subjectRe.test(String(parseArgs(c).title || '')))
  if (!cards.length) { add(id, true, `未生成${label}图片：不适用`); return }
  const firstSeq = Math.min(...cards.map(seqOf))
  const hits = asks.filter((a) => seqOf(a) > firstSeq && askMatches(a, subjectRe, LOCK_RE))
  add(id, hits.length > 0,
    hits.length
      ? `${label}图片 seq=${seqList(cards)} ｜ 确认 ask seq=${seqList(hits)}（共 ${asks.length} 次 ask）`
      : `${label}图片 seq=${seqList(cards)} ｜ 之后没有「${label}」确认 ask（共 ${asks.length} 次 ask；要求问句/选项同时含「${label}」与 锁定|批准|继续|通过）`)
}

const cardSeq = {
  plan: asks.find((a) => /方案卡|G-P/.test(askText(a)))?.seq || 0,
  clips: asks.find((a) => /片段卡|门 ?3|片段/.test(askText(a)))?.seq || 0,
  delivery: asks.find((a) => /交付卡|G-E|交付/.test(askText(a)))?.seq || 0,
}
const firstVideo = videoCalls[0]?.seq || 0
if (seriesMode) {
  add('A1 三张卡都问过', !!(cardSeq.plan && cardSeq.clips && cardSeq.delivery),
    `方案=${cardSeq.plan || '无'} 片段=${cardSeq.clips || '无'} 交付=${cardSeq.delivery || '无'}（共 ${asks.length} 次 ask）`)
  add('A2 首个视频在方案卡之后', !!firstVideo && !!cardSeq.plan && firstVideo > cardSeq.plan,
    `首个视频 seq=${firstVideo || '无'} ｜ 方案卡 seq=${cardSeq.plan || '无'}`)
} else {
  checkCardLock('角色卡', /角色卡/)
  checkCardLock('场景卡', /场景卡/)
  // 镜头表 / 分镜必须问过，且第一个 Sxx 视频在其后（同一张 ask 卡可同时覆盖两项）
  const shotVideos = videoCalls.filter((c) => /S\d{1,3}/i.test(String(parseArgs(c).title || '')))
  if (!shotVideos.length) add('A2 镜头表+分镜先问后渲', true, '未生成 Sxx 视频：不适用')
  else {
    const firstShot = Math.min(...shotVideos.map(seqOf))
    const tableAsk = asks.filter((a) => seqOf(a) < firstShot && askMatches(a, /镜头表/))
    const boardAsk = asks.filter((a) => seqOf(a) < firstShot && askMatches(a, /分镜/))
    add('A2 镜头表+分镜先问后渲', tableAsk.length > 0 && boardAsk.length > 0,
      `首个 Sxx 视频 seq=${firstShot} ｜ 镜头表 ask=${seqList(tableAsk) || '无'} 分镜 ask=${seqList(boardAsk) || '无'}（两者都必须早于它）`)
  }
}

// A3 抽帧 / 自检次数
const frames = named('extract_frame')
const checks = named('canvas_record_check')
// 用「不同镜号」而不是「调用次数」做分母：失败重试/预热调用不算镜；重渲同一镜也不该多要一次自检
const shotTitles = new Set(videoCalls.map((c) => String(parseArgs(c).title || '').trim()).filter(Boolean))
const shotCount = shotTitles.size || videoCalls.length
add('A3 抽帧覆盖', shotCount === 0 || frames.length >= shotCount, `镜 ${shotCount} / 抽帧 ${frames.length}（视频调用 ${videoCalls.length}）`)
add('A3 自检留痕覆盖', shotCount === 0 || checks.length >= shotCount, `镜 ${shotCount} / record_check ${checks.length}（视频调用 ${videoCalls.length}）`)

// A4 重渲边界
const rework = videoCalls.filter((c) => parseArgs(c).nodeId)
add('A4 重渲有边界', videoCalls.length === 0 || rework.length <= Math.max(1, Math.ceil(videoCalls.length / 2)), `重渲 ${rework.length} / 视频 ${videoCalls.length}`)

// A5 字幕核验留痕
const writes = named('canvas_write_node').map((c) => String(parseArgs(c).content || ''))
const subtitleAudit = writes.filter((t) => /字幕核验/.test(t))
if (!seriesMode) add('A5 字幕核验留痕', true, '单片模式：SKIP')
else add('A5 字幕核验留痕', subtitleAudit.length > 0, subtitleAudit.length ? `${subtitleAudit.length} 个节点含「字幕核验」` : '没有任何节点记录字幕核验')

// A6 已知违规参数
const bad = videoCalls.filter((c) => { const a = parseArgs(c); return String(a.tier) === 'fast' && String(a.ref_variant) === 'three' })
add('A6 无 fast+三视图', bad.length === 0, `命中 ${bad.length} 次`)

const fail = rows.filter((r) => !r.ok)
if (flag('json')) console.log(JSON.stringify({ session: sid, seriesMode, calls: calls.length, rows }, null, 2))
else {
  console.log(`会话审计：${sid}（${calls.length} 次工具调用，${seriesMode ? '系列' : '单片'}模式）`)
  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id}${r.ok ? '' : '  ← ' + r.detail}`)
  console.log(`\n  ${rows.length - fail.length}/${rows.length} 通过`)
}
process.exitCode = fail.length ? 1 : 0
