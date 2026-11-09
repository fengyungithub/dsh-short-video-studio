/**
 * 冒烟：会话审计（scripts/audit-session.mjs）
 * 覆盖两个真实 bug 的回归：
 *   1. --session <bare-id> 与 --session session-<id> 都要命中同一个会话（曾静默审计成最新会话）；
 *      显式给了 sid 但找不到 → exit 2 且不退回最新；只有不给 sid 时才取最新。
 *   2. 单片模式不再 SKIP A1/A2：有角色卡图就必须问过「角色卡锁定」；在卡片之前问不算。
 * 用法：node scripts/smoke-audit-session.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { zstdCompressSync } from 'node:zlib'

const SCRIPT = fileURLToPath(new URL('./audit-session.mjs', import.meta.url))
let passed = 0
function ok(cond, name) {
  assert.ok(cond, name)
  passed++
  console.log('  ok -', name)
}

const root = mkdtempSync(join(tmpdir(), 'svs-audit-session-'))
const sessions = join(root, 'sessions')
const ws = join(root, 'ws')
mkdirSync(sessions, { recursive: true })
mkdirSync(ws, { recursive: true })

// workspace 目录名编码：非字母数字 → '-'，两侧各包一层 '-'
const encodeWs = (p) => '--' + p.replace(/[^a-zA-Z0-9]/g, '-') + '--'
const wsRoot = join(sessions, encodeWs(ws))

const SID = '5b98e197-364f-4a5d-af15-a3bd6a885d33'
const OTHER = '1857668c-564c-4d1a-9ac1-4bd9bda7d6b6'
const ASK_FIRST = 'aaaa1111-2222-3333-4444-555566667777'
const MISSING = 'deadbeef-0000-0000-0000-000000000000'

const ev = (seq, name, args) => JSON.stringify({ type: 'tool/call', seq, data: { name, arguments: JSON.stringify(args) } })
const ask = (seq, question, labels) => ev(seq, 'ask_user_question', { questions: [{ header: '角色卡', question, options: labels.map((label) => ({ label })) }] })
const cardImage = (seq) => ev(seq, 'comfy_generate_image', { title: '孔子 角色卡·三视图', group: 'character cards' })

/** 造一条会话记录（多帧 zstd 不是必须的：单帧即可） */
function makeSession(dirName, lines, ageSec) {
  const dir = join(wsRoot, dirName)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
  const t = new Date(Date.now() - ageSec * 1000)
  utimesSync(file, t, t)
}

// 指定命中：带前缀的老目录 + 另一个更新的会话
makeSession('session-' + SID, [cardImage(1), ask(2, '角色卡可以锁吗？', ['锁定并继续', '重出角色卡'])], 120)
makeSession('session-' + OTHER, [cardImage(1)], 10) // 没有锁定 ask → A1 应 fail
// 反例：ask 出现在卡片图之前，不算用户确认过卡片
makeSession('session-' + ASK_FIRST, [ask(1, '角色卡可以锁吗？', ['锁定并继续']), cardImage(2)], 60)

function runAudit(args) {
  const res = spawnSync(process.execPath, [SCRIPT, '--workspace', ws, ...args], {
    env: { ...process.env, DSH_SVS_SESSION_ROOT: sessions },
    encoding: 'utf8',
  })
  return res
}
const rowOf = (jsonText, id) => JSON.parse(jsonText).rows.find((r) => r.id === id)

try {
  // 1. 裸 id 必须命中指定会话（回归：曾静默审计成最新会话）
  const bare = runAudit(['--session', SID, '--json'])
  ok(bare.status === 0, `裸 id 命中指定会话时退出码 0（实际 ${bare.status}）`)
  ok(JSON.parse(bare.stdout).session === SID, '裸 id 审计对象是 ' + SID)
  ok(rowOf(bare.stdout, 'A1 角色卡锁定').ok, '图片之后问过锁定 → A1 角色卡锁定 pass')

  // 2. 带 session- 前缀同样命中
  const prefixed = runAudit(['--session', 'session-' + SID, '--json'])
  ok(JSON.parse(prefixed.stdout).session === SID, 'session- 前缀审计对象是 ' + SID)

  // 3. 显式 sid 找不到 → exit 2，绝不退回最新会话
  const missing = runAudit(['--session', MISSING])
  ok(missing.status === 2, `找不到显式 sid 时 exit 2（实际 ${missing.status}）`)
  ok(/不会退回最新会话/.test(missing.stderr), 'stderr 明确说明不退回最新会话')
  ok(!missing.stdout.includes('会话审计：'), '找不到显式 sid 时不输出任何审计结果')

  // 4. 不给 sid 才取该 workspace 下最新一条
  const latest = runAudit(['--json'])
  ok(JSON.parse(latest.stdout).session === OTHER, '不给 session 时取最新会话 ' + OTHER)
  ok(!rowOf(latest.stdout, 'A1 角色卡锁定').ok, '有角色卡图但没问过 → A1 角色卡锁定 fail')
  ok(latest.status === 1, `审计有失败项时退出码 1（实际 ${latest.status}）`)

  // 5. 单片模式真的检查：ask 在卡片图之前不算确认
  const askFirst = runAudit(['--session', ASK_FIRST, '--json'])
  ok(!rowOf(askFirst.stdout, 'A1 角色卡锁定').ok, 'ask 在卡片图之前 → A1 角色卡锁定 fail')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n  ${passed} 项通过`)
