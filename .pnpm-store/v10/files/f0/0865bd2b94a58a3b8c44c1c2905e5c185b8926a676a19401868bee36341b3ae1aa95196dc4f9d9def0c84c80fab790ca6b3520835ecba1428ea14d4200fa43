/**
 * scripts/e2e-chain-continuity.mjs — 链式续接（continuity_from）端到端集成验证（**真跑 GPU**）。
 *
 * 验证的是**插件这一层**的链路，不是裸 ComfyUI 图：
 *  ① 起链：不传 continuity_from → Load 0（没有上文）、Save 分配会话序号、采样=交付
 *  ② 续接：传上一镜节点 id → Load=上一镜序号、Save=+1、多采 22 帧再裁掉（交付帧数按网格取整）
 *  ③ 反向：上一镜没有链序号时**显式报错**（不许悄悄退化成"另起一镜"）
 *  ④ 对照镜：同 prompt、同 seed、同交付帧数，但走普通（非链式）实现——接缝指标必须有对照
 *
 * 用法：
 *   node scripts/e2e-chain-continuity.mjs                       # fast 档（默认，≈40s×3）
 *   node scripts/e2e-chain-continuity.mjs --tier=balanced --workflow-suffix=-pdd
 *
 * 产物落 e2e-out/chain-continuity/ 下（画布写在临时工作区，不动用户会话）。
 * 接缝测量：e2e-out/ctx-test/measure_seam.py（在 ComfyUI 容器里跑，用 av+numpy）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { _internals } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'e2e-out', 'chain-continuity')
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}

const TIER = arg('tier', 'fast')
const SUFFIX = arg('workflow-suffix', '')
const CHAIN_WF = `minimax-h3-ref2v-ctx-${TIER}${SUFFIX}`
// ③ 用的「非链式上一镜」：必须是**不声明 chain** 的实现（默认同族普通实现）。
// ④ 用的「不续接对照镜」：默认同上；跑放大族时要显式指到**同交付尺寸**的实现，
//    否则接缝指标会被分辨率差异污染 —— 见 --control-workflow=。
const PLAIN_WF = arg('plain', `minimax-h3-ref2v-${TIER}${SUFFIX}`)
const CONTROL_WF = arg('control-workflow', PLAIN_WF)
const LENGTH = Number(arg('length', '124'))
const SEED = Number(arg('seed', '20260915'))
const W = Number(arg('width', '832'))
const H = Number(arg('height', '480'))
const CTX_EXTRA = 22
const GRID = [17, 5]
const snap = (n) => (n <= GRID[1] ? GRID[1] : GRID[1] + Math.ceil((n - GRID[1]) / GRID[0]) * GRID[0])

const PROMPT_HEAD = [
  '[Shot 1] A 3D-animated fox-eared girl in a white fur coat kneels on a frozen lake at night, holding a dark glove over a snow hole.',
  'Sound: steady wind, snow crunch, a quiet low string bed under everything.',
  '[0.0s] She kneels over the hole, coat moving in the wind.',
  '[2.0s] She lifts the glove slowly toward her chest.',
  '[4.5s] Camera settles close on her hands; wind and strings continue.',
].join('\n')

const PROMPT_NEXT = [
  '[Shot 2] A 3D-animated fox-eared girl in a white fur coat on a frozen lake at night.',
  'The shot opens holding the exact closing framing of the previous clip and continues the same action.',
  'Sound: the same wind, the same snow crunch and the same low string bed continue without restarting.',
  '[0.0s] Hold the previous framing: glove at her chest, head lowered, snow drifting.',
  '[2.0s] She exhales and shifts her weight, then rises to her feet.',
  '[4.0s] She turns her head toward the far ice ridge as the wind continues.',
].join('\n')

mkdirSync(OUT, { recursive: true })
const workspace = join(OUT, 'workspace')
const sessionId = 'chain-smoke'
const projectPath = join(workspace, 'canvas', sessionId, 'project.json')
mkdirSync(dirname(projectPath), { recursive: true })
writeFileSync(projectPath, JSON.stringify({
  schemaVersion: 1, sessionId,
  settings: { aspectRatio: '16:9', duration: '', audioMode: 'silent', mode: TIER },
  nodes: [],
}, null, 2), 'utf8')

const ctx = {
  workspaceRegistry: {
    get: (id) => (id === 'smoke' ? { id, path: workspace } : undefined),
    list: () => [{ id: 'smoke', path: workspace, sessionIds: [sessionId] }],
  },
}
const fail = (msg) => { console.error('✗ ' + msg); process.exit(1) }
const readNodes = () => JSON.parse(readFileSync(projectPath, 'utf8')).nodes

const common = {
  workspaceId: 'smoke', sessionId,
  capability: 'video.reference2video',
  ref_nodes: [arg('ref', 'e2e-out/ctx-test/refA.png')],
  width: W, height: H, seed: SEED, group: '片段',
}

// ① 起链（同场景第一镜：链式实现，不传 continuity_from）
const t0 = Date.now()
const head = await _internals.runRender(ctx, { ...common, implementation: CHAIN_WF, prompt: PROMPT_HEAD, length: LENGTH, title: 'S01 片段（起链）' })
const headNode = head.node
console.log('✓ ① 起链 %s · %ss · 交付 %d 帧（请求 %d）· load %s / save %d',
  head.implementation, ((Date.now() - t0) / 1000).toFixed(1), headNode.params.length, LENGTH,
  headNode.params.contextClipIndex, headNode.params.clipIndex)
if (headNode.params.continuityFrom !== null) fail('起链不该有 continuityFrom')
if (headNode.params.contextClipIndex !== 0) fail('起链的 Load 序号必须是 0，实际 ' + headNode.params.contextClipIndex)
if (!(headNode.params.clipIndex >= 1)) fail('起链没分配 Save 序号')
if (headNode.params.length !== snap(LENGTH)) fail(`起链交付帧数记错：${headNode.params.length} != ${snap(LENGTH)}`)

// ② 续接
const t1 = Date.now()
const next = await _internals.runRender(ctx, { ...common, implementation: CHAIN_WF, prompt: PROMPT_NEXT, length: LENGTH, continuity_from: headNode.id, title: 'S02 片段（续接）' })
const nextNode = next.node
const expectSampled = snap(LENGTH + CTX_EXTRA)
console.log('✓ ② 续接 %s · %ss · 请求 %d → 采样 %d → 交付 %d 帧 · load %d / save %d',
  next.implementation, ((Date.now() - t1) / 1000).toFixed(1), LENGTH, nextNode.params.sampledLength,
  nextNode.params.length, nextNode.params.contextClipIndex, nextNode.params.clipIndex)
if (nextNode.params.contextClipIndex !== headNode.params.clipIndex) fail('续接的 Load 序号没接上一镜')
if (nextNode.params.clipIndex !== headNode.params.clipIndex + 1) fail('续接的 Save 序号不是 +1')
if (nextNode.params.sampledLength !== expectSampled) fail(`采样帧数记错：${nextNode.params.sampledLength} != ${expectSampled}`)
if (nextNode.params.length !== expectSampled - CTX_EXTRA) fail(`交付帧数记错：${nextNode.params.length}`)
if (nextNode.params.continuityFrom !== headNode.id) fail('没记 continuityFrom')

// ③ 反向：上一镜没有链序号时显式报错
const plain = await _internals.runRender(ctx, { ...common, implementation: PLAIN_WF, prompt: PROMPT_NEXT, length: nextNode.params.length, title: 'S02 对照（非链式实现）' })
try {
  await _internals.runRender(ctx, { ...common, implementation: CHAIN_WF, prompt: PROMPT_NEXT, length: LENGTH, continuity_from: plain.node.id, title: '不该成功' })
  fail('上一镜没有链序号也跑通了——应当显式报错')
} catch (e) {
  if (!/没有链式序号/.test(String(e.message))) fail('拒跑信息不对：' + e.message)
  console.log('✓ ③ 非链式上一镜 → 显式拒跑')
}
console.log('✓ ④ 对照镜 %s · 交付 %d 帧 · seed %d', plain.implementation, plain.node.params.length, plain.node.params.seed)

// ④b 接缝对照镜：**同一个链式实现**、同 prompt、同 seed，只是不传 continuity_from。
// 只有它和续接镜同尺寸，接缝指标才干净（跨尺寸比较会把放大差异误读成"接缝变差"）。
const control = CONTROL_WF === PLAIN_WF
  ? plain
  : await _internals.runRender(ctx, { ...common, implementation: CONTROL_WF, prompt: PROMPT_NEXT, length: nextNode.params.length, title: 'S02 对照（同实现·不续接）' })
if (CONTROL_WF !== PLAIN_WF) {
  if (control.node.params.width !== nextNode.params.width || control.node.params.height !== nextNode.params.height) {
    fail(`接缝对照镜与续接镜尺寸不同：${control.node.params.width}×${control.node.params.height} vs ${nextNode.params.width}×${nextNode.params.height}`)
  }
  console.log('✓ ④b 接缝对照镜 %s · 交付 %d×%d', control.implementation, control.node.params.width, control.node.params.height)
}

// ⑤ 抽帧产物必须**不是**源视频回显（LoadVideo 会把输入文件回显成 images/type=input；
//    旧 comfyOutputs 会把它当产物，导致抽帧节点存成源 mp4）。链式实现里的上一镜尤其致命。
const frame = await _internals.runRender(ctx, {
  workspaceId: 'smoke', sessionId, capability: 'image.from_video', prompt: '',
  video_node: headNode.id, frame_index: -1, title: 'S01 末帧（抽帧检查）', group: '片段',
})
if (!/\.png$/.test(frame.node.media)) fail('抽帧拿到的是源视频回显，不是图片：' + frame.node.media)
if (frame.files.length !== 1) fail('抽帧产物数量异常：' + JSON.stringify(frame.files))
console.log('✓ ⑤ 抽帧：%s → %s（不是源视频回显）', headNode.title, frame.node.media.split('/').pop())

for (const n of [headNode, nextNode, plain.node]) {
  const abs = join(workspace, n.media)
  if (!existsSync(abs)) fail('产物没落盘: ' + abs)
}
console.log('\n画布节点 %d 个：%s', readNodes().length, readNodes().map((n) => `${n.title}(clip ${n.params.clipIndex ?? '-'})`).join(' · '))
console.log('\n上一镜（起链）：%s', join(workspace, headNode.media))
console.log('续接镜        ：%s', join(workspace, nextNode.media))
console.log('对照镜(不续接)：%s', join(workspace, plain.node.media))
if (CONTROL_WF !== PLAIN_WF) console.log('对照镜(同实现·不续接)：%s', join(workspace, control.node.media))
console.log('\n服务端 latent 槽位应为 clip_%05d（上一镜）与 clip_%05d（本镜）。', headNode.params.clipIndex, nextNode.params.clipIndex)
console.log('接缝量化：把这三条交给 e2e-out/ctx-test/measure_seam.py（在 ComfyUI 容器里跑）。')
