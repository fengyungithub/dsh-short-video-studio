/**
 * scripts/experiment/l3-inject.mjs — L3 故障注入（验证「拦得住」）
 *
 * 6 个注入，每个都必须被**代码门或工具**明确拦下（deny / ok:false），不许静默放过：
 *   F1 shotGate：上一镜未过自检就渲下一镜
 *   F2 planGate：改台词但不改镜头表
 *   F3 planGate：fast 档引用三视图卡
 *   F4 planGate：length 与镜头表时长不一致
 *   F5 H3 结构化门：自由格式 prompt 走 H3 工作流
 *   F6 跨会话续接：continuity_from 指向本画布不存在的节点
 *
 * 用法：node scripts/experiment/l3-inject.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PORT = 8302
const mock = spawn(process.execPath, [join(root, 'scripts/experiment/mock-comfy.mjs')], {
  env: { ...process.env, MOCK_COMFY_PORT: String(PORT), MOCK_COMFY_OUT: join(root, 'experiment-out/L3') },
  stdio: ['ignore', 'pipe', 'inherit'],
})
await new Promise((ok, fail) => {
  const t = setTimeout(() => fail(new Error('mock 启动超时')), 8000)
  mock.stdout.on('data', (d) => { if (String(d).includes('mock-comfy')) { clearTimeout(t); ok() } })
})
process.env.DSH_SVS_COMFY_URL = `http://127.0.0.1:${PORT}`

const { apply, _internals } = await import(join(root, 'lib/index.js'))
const { makePlanGateListener, makeShotGateListener, makeH3PromptGateListener } = _internals

const ws = mkdtempSync(join(tmpdir(), 'dsh-l3-'))
const SID = 'l3-session'
mkdirSync(join(ws, 'canvas', SID), { recursive: true })

const TABLE = [
  '| 镜头编号 & 时长 | 连续性衔接 | 续接 | 参考锚点（空间+身份） | Hook 类型 | 镜头描述（每秒指令） | 音频与对白轨 |',
  '|---|---|---|---|---|---|---|',
  '| S01 / 5s | 开场 | 起链 | door-frame: 右侧 1/3 | setup | 剧本依据: B01 — 0–5s 推门 | 模式: dialogue；对白: 林晚（0–2s）："我不去。"；口型: mouth-open；声线参考: none；音效: 无；BGM: N/A；字幕: none |',
  '| S02 / 5s | 接 S01 | 接 S01 | 同上 | reveal | 剧本依据: B02 — 0–5s 转身 | 模式: dialogue；对白: 林晚（0–2s）："我不走。"；口型: mouth-open；声线参考: none；音效: 无；BGM: N/A；字幕: none |',
].join('\n')

const project = {
  schemaVersion: 1,
  sessionId: SID,
  settings: { aspectRatio: '9:16', audioMode: 'dialogue-led', mode: 'fast', reviewMode: 'batch', shotGate: 'verdict' },
  nodes: [
    { id: 'c1', kind: 'image', title: '林晚 角色卡·单视图', group: 'character cards', media: `canvas/${SID}/c1.png`, params: { cardVariant: 'single', character: '林晚' } },
    { id: 'c3', kind: 'image', title: '林晚 角色卡·三视图', group: 'character cards', media: `canvas/${SID}/c3.png`, params: { cardVariant: 'three', character: '林晚' } },
    { id: 's1', kind: 'video', title: 'S01 片段', group: 'shot clips', media: `canvas/${SID}/s1.mp4`, params: { shot: true, tier: 'fast', length: 120, selfCheck: { status: 'pending', frames: [] } } },
    { id: 'tbl', kind: 'table', title: '七列镜头表', group: 'shot table', content: TABLE, params: {} },
  ],
}
writeFileSync(join(ws, 'canvas', SID, 'project.json'), JSON.stringify(project, null, 2))

const workspace = { id: 'ws-l3', path: ws, sessionIds: [SID] }
const registered = []
apply({
  webServer: { register: () => () => {} },
  tools: { register: (t) => { registered.push(t); return () => {} }, get: (n) => registered.find((t) => t.name === n) },
  systemPrompt: { section: () => () => {} },
  workspaceRegistry: { get: (id) => (id === workspace.id ? workspace : undefined), list: () => [workspace] },
  on: () => () => {},
  effect: (fn) => fn(),
})

const ctx = { workspaceRegistry: { get: (id) => (id === workspace.id ? workspace : undefined), list: () => [workspace] } }
const planGate = makePlanGateListener(ctx)
const shotGate = makeShotGateListener(ctx)
const h3Gate = makeH3PromptGateListener(ctx)
const next = () => ({ kind: 'allow' })
let seq = 0
const exec = (name, args, extraAgent = {}) => ({
  name,
  arguments: { sessionId: SID, ...args },
  agent: { id: `${SID}-call-${++seq}`, session: { id: SID, meta: { cwd: ws } }, ...extraAgent },
})

const cases = [
  ['F1 shotGate：上一镜未过自检就渲下一镜', 'canvas_record_check',
    () => shotGate(exec('comfy_generate_video', { type: 'r2v', title: 'S02 片段', prompt: 'x', tier: 'fast' }), next)],
  ['F2 planGate：改台词不改镜头表', '台词',
    () => planGate(exec('comfy_generate_video', { type: 'r2v', title: 'S01 片段', prompt: '0–5s 林晚走进来。', tier: 'fast', length: 120, ref_nodes: ['c1'], ref_variant: 'single' }), next)],
  ['F3 planGate：fast 档引用三视图卡', '三视图',
    () => planGate(exec('comfy_generate_video', { type: 'r2v', title: 'S01 片段', prompt: '林晚说："我不去。"', tier: 'fast', length: 120, ref_nodes: ['c3'], ref_variant: 'three' }), next)],
  ['F4 planGate：length 与镜头表时长不一致', '时长',
    () => planGate(exec('comfy_generate_video', { type: 'r2v', title: 'S01 片段', prompt: '林晚说："我不去。"', tier: 'fast', length: 200, ref_nodes: ['c1'], ref_variant: 'single' }), next)],
  ['F5 H3 结构化门：自由格式 prompt', '结构化',
    () => h3Gate(exec('comfy_generate_video', { type: 'r2v', prompt: '一只狐狸跳过原木，镜头推近。', tier: 'fast' }), next)],
  ['F6 跨会话续接：continuity_from 不存在', '节点',
    async () => {
      const tool = registered.find((t) => t.name === 'comfy_generate_video')
      const r = await tool.execute({ type: 'r2v', tier: 'fast', title: 'S02 片段', prompt: 'x', continuity_from: 'foreign-session-node-id', sessionId: SID, workspaceId: workspace.id }, { agent: { id: SID } })
      return r?.ok === false ? { kind: 'deny', reason: r.error } : { kind: 'allow', value: r }
    }],
]

let blocked = 0
console.log('\nL3 故障注入（每个都必须被拦）\n')
for (const [name, keyword, run] of cases) {
  let r
  try { r = await run() } catch (e) { r = { kind: 'error', reason: e?.message || String(e) } }
  const denied = r?.kind === 'deny' || r?.kind === 'error'
  const hitKeyword = denied && String(r.reason || '').includes(keyword)
  const ok = denied && hitKeyword
  if (ok) blocked++
  console.log(`  ${ok ? '✓' : '✗'} ${name}`)
  console.log(`      判定=${r?.kind} ｜ 理由=${String(r?.reason || r?.value?.error || '').split('\n')[0].slice(0, 120)}${hitKeyword ? '' : `（期望含「${keyword}」）`}`)
}
console.log(`\n${blocked === cases.length ? '✓' : '✗'} 拦截 ${blocked}/${cases.length}`)
mock.kill('SIGTERM')
process.exitCode = blocked === cases.length ? 0 : 1
