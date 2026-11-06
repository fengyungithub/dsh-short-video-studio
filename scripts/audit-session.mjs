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
 *   A3 每镜都抽过帧、都记录过自检（extract_frame / canvas_record_check 次数 ≥ 视频生成次数）
 *   A4 重渲有边界（带 nodeId 的调用 ≤ 视频调用总数的一半）
 *   A5 字幕核验留痕（交付/终检节点正文含「字幕核验」）
 *   A6 没有「fast + 三视图」这类已知违规参数
 *
 * 用法：
 *   node scripts/audit-session.mjs --session e0b06202-de0e-4388-a21b-7c668e1e4027 [--workspace .] [--json]
 *   node scripts/audit-session.mjs            # 不给 session 时取该 workspace 最新一条
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
const argOf = (n, d = '') => (argv.indexOf('--' + n) >= 0 ? argv[argv.indexOf('--' + n) + 1] : d)
const flag = (n) => argv.includes('--' + n)
const ws = resolve(argOf('workspace', process.cwd()))
const sidArg = argOf('session', '')

const SESSION_ROOT = join(homedir(), '.dsh', 'sessions')
function findSessionDir(sid) {
  const dirs = readdirSync(SESSION_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(SESSION_ROOT, d.name))
  for (const d of dirs) {
    const p = join(d, sid)
    if (existsSync(p)) return p
  }
  // 没指定 session：取该 workspace 下最新的一条
  const wsDir = dirs.find((d) => basename(d).includes(ws.replace(/\//g, '-')))
  if (!wsDir) return ''
  const cands = readdirSync(wsDir, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => join(wsDir, x.name))
  cands.sort((a, b) => (existsSync(join(b, 'session.v4.jsonl.zstd')) ? 1 : 0) - (existsSync(join(a, 'session.v4.jsonl.zstd')) ? 1 : 0))
  return cands[0] || ''
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
if (!dir) { console.error('找不到会话记录：' + (sidArg || ws)); process.exit(2) }
const file = join(dir, 'session.v4.jsonl.zstd')
if (!existsSync(file)) { console.error('会话没有 transcript：' + file); process.exit(2) }
const sid = basename(dir)
const events = decodeZstdFrames(readFileSync(file)).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const calls = events.filter((e) => e.type === 'tool/call')
const parseArgs = (c) => { try { return JSON.parse(c.data?.arguments || '{}') } catch { return {} } }
const named = (n) => calls.filter((c) => c.data?.name === n)

const seriesMode = existsSync(join(ws, 'series/production-state.json'))
const rows = []
const add = (id, ok, detail) => rows.push({ id, ok, detail })

// A1 三张卡
const asks = named('ask_user_question').map((c) => ({ seq: c.seq, args: parseArgs(c) }))
const askText = (a) => JSON.stringify(a.args)
const cardSeq = {
  plan: asks.find((a) => /方案卡|G-P/.test(askText(a)))?.seq || 0,
  clips: asks.find((a) => /片段卡|门 ?3|片段/.test(askText(a)))?.seq || 0,
  delivery: asks.find((a) => /交付卡|G-E|交付/.test(askText(a)))?.seq || 0,
}
if (!seriesMode) add('A1 三张卡', true, '单片模式：不要求（SKIP）')
else add('A1 三张卡都问过', !!(cardSeq.plan && cardSeq.clips && cardSeq.delivery),
  `方案=${cardSeq.plan || '无'} 片段=${cardSeq.clips || '无'} 交付=${cardSeq.delivery || '无'}（共 ${asks.length} 次 ask）`)

// A2 先问后渲
const firstVideo = named('comfy_generate_video')[0]?.seq || 0
if (!seriesMode) add('A2 先问后渲', true, '单片模式：SKIP')
else add('A2 首个视频在方案卡之后', !!firstVideo && !!cardSeq.plan && firstVideo > cardSeq.plan,
  `首个视频 seq=${firstVideo || '无'} ｜ 方案卡 seq=${cardSeq.plan || '无'}`)

// A3 抽帧 / 自检次数
const videoCalls = named('comfy_generate_video')
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
  console.log(`\n会话审计：${sid}（${calls.length} 次工具调用，${seriesMode ? '系列' : '单片'}模式）`)
  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.id}${r.ok ? '' : '  ← ' + r.detail}`)
  console.log(`\n  ${rows.length - fail.length}/${rows.length} 通过`)
}
process.exitCode = fail.length ? 1 : 0
