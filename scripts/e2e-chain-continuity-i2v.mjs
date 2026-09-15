/**
 * scripts/e2e-chain-continuity-i2v.mjs — i2v 版链式续接端到端验证（**真跑 GPU**）。
 *
 * 验证的是**i2v 也能继承上一镜尾部**（i2v 版 ctx 模板 = 普通 i2v 图 + Motion Context 四节点）：
 *  ① 起链：i2v + first_frame，不传 continuity_from → Load 0、Save 分配会话序号、采样=交付
 *  ② 抽起链镜末帧 → 作续接镜的 first_frame（这正是**转场镜 / 锚点式重渲**的真实用法：
 *     "首帧 = 上游末帧" + "继承上游尾部" + 可选"末帧 = 下游首帧"）
 *  ③ 续接：传 continuity_from=起链镜 → Load=上一镜序号、Save=+1、多采 22 帧再裁掉
 *  ④ 对照：**同一张首帧图、同 seed、同交付帧数**，但走普通 i2v 实现（无尾部继承）→ 接缝必须有对照
 *  ⑤ 反向：普通 i2v 实现 + continuity_from → 必须**显式报错**（不许悄悄退化成"另起一镜"）
 *
 * 用法：
 *   node scripts/e2e-chain-continuity-i2v.mjs                    # fast 档（默认）
 *   node scripts/e2e-chain-continuity-i2v.mjs --tier=balanced     # 其余档（待补实测，先记录）
 *
 * 产物落 e2e-out/chain-continuity-i2v/（画布写在临时工作区，不动用户会话）。
 * 接缝量化：e2e-out/ctx-test/measure_seam.py（在 ComfyUI 容器里跑，用 av+numpy）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { _internals } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'e2e-out', 'chain-continuity-i2v')
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}

const TIER = arg('tier', 'fast')
const CHAIN_WF = `minimax-h3-i2v-ctx-${TIER}`
const PLAIN_WF = `minimax-h3-i2v-${TIER}`
const LENGTH = Number(arg('length', '124'))
const SEED = Number(arg('seed', '20260916'))
const W = Number(arg('width', '832'))
const H = Number(arg('height', '480'))
const CTX_EXTRA = 22
const GRID = [17, 5]
const snap = (n) => (n <= GRID[1] ? GRID[1] : GRID[1] + Math.ceil((n - GRID[1]) / GRID[0]) * GRID[0])

// 与 r2v 端到端同一套素材/提示词：便于横向比较两种形状的接缝指标
const ANCHOR_SRC = join(ROOT, 'e2e-out', 'ctx-test', 'refA.png')
const MEASURE = join(ROOT, 'e2e-out', 'ctx-test', 'measure_seam.py')
const SSH_HOST = process.env.DSH_BENCH_SSH || ''   // 形如 user@host；跑接缝量化时必须给（容器所在宿主机）
const CONTAINER = process.env.DSH_BENCH_CONTAINER || 'comfyui'
const SERVER_OUT = '/root/ComfyUI/output'
const MEASURE_ON = process.argv.includes('--measure') || process.argv.includes('--measure-only')
const MEASURE_ONLY = process.argv.includes('--measure-only')

/** 在 ComfyUI 容器里量两条片子的接缝（两条都是容器 output 目录里的产物，无需上传）。 */
function measure(aMedia, bMedia, tag) {
  if (!SSH_HOST) throw new Error('接缝量化需要在 ComfyUI 容器所在宿主机上执行：请设 DSH_BENCH_SSH=user@host（可选 DSH_BENCH_CONTAINER，默认 comfyui）')
  const script = readFileSync(MEASURE, 'utf8')
  const out = execFileSync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', SSH_HOST,
    `sudo -n docker exec -i ${CONTAINER} python3 - ${SERVER_OUT}/${aMedia} ${SERVER_OUT}/${bMedia} ${SERVER_OUT}/seam_i2v_${tag}`,
  ], { input: script, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000 })
  return JSON.parse(out.slice(out.indexOf('{')))
}

const PROMPT_HEAD = [
  '[Shot 1] A 3D-animated fox-eared girl in a white fur coat kneels on a frozen lake at night, holding a dark glove over a snow hole.',
  'Sound: steady wind, snow crunch, a quiet low string bed under everything.',
  '[0.0s] She kneels over the hole, coat moving in the wind.',
  '[2.0s] She lifts the glove slowly toward her chest.',
  '[4.5s] Camera settles close on her hands; wind and strings continue.',
].join('\n')

const PROMPT_NEXT = [
  '[Shot 2] The shot begins from the given first frame and continues the same action in the same place.',
  'Sound: the same wind, the same snow crunch and the same low string bed continue without restarting.',
  '[0.0s] Hold the given framing: glove at her chest, head lowered, snow drifting.',
  '[2.0s] She exhales and shifts her weight, then rises to her feet.',
  '[4.0s] She turns her head toward the far ice ridge as the wind continues.',
].join('\n')

if (!existsSync(ANCHOR_SRC)) {
  console.error('✗ 缺少首帧素材：' + ANCHOR_SRC + '（先跑 r2v 的 scripts/e2e-chain-continuity.mjs，或放一张 16:9 图片）')
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })
const workspace = join(OUT, 'workspace')
const sessionId = 'chain-i2v'
const projectPath = join(workspace, 'canvas', sessionId, 'project.json')
const mediaDir = join(workspace, 'canvas', sessionId)
mkdirSync(mediaDir, { recursive: true })
copyFileSync(ANCHOR_SRC, join(mediaDir, 'anchor.png'))

// 首帧锚点：手工登记一个画布 image 节点（= 真实流程里"抽帧/角色卡"出来的图片节点）
const ANCHOR_ID = 'anchor-image-node'
writeFileSync(projectPath, JSON.stringify({
  schemaVersion: 1, sessionId,
  settings: { aspectRatio: '16:9', duration: '', audioMode: 'silent', mode: TIER },
  nodes: [{
    id: ANCHOR_ID, kind: 'image', title: '首帧锚点', media: `canvas/${sessionId}/anchor.png`,
    group: '片段', params: { source: 'e2e-fixture' }, status: 'ready', createdAt: Date.now(), order: 0,
  }],
}, null, 2), 'utf8')

const ctx = {
  workspaceRegistry: {
    get: (id) => (id === 'smoke' ? { id, path: workspace } : undefined),
    list: () => [{ id: 'smoke', path: workspace, sessionIds: [sessionId] }],
  },
}
const fail = (msg) => { console.error('✗ ' + msg); process.exit(1) }
const readNodes = () => JSON.parse(readFileSync(projectPath, 'utf8')).nodes

// --measure-only：直接用上一次渲染的 rows-<tier>.json（不重跑 GPU），只补接缝量化
if (MEASURE_ONLY) {
  const rowsPath = join(OUT, `rows-${TIER}.json`)
  if (!existsSync(rowsPath)) fail('没有 ' + rowsPath + '，先跑一次完整渲染')
  const prev = JSON.parse(readFileSync(rowsPath, 'utf8')).rows
  const [head, next, ctrl] = prev
  const seam = {
    tier: TIER, chainWorkflow: CHAIN_WF, plainWorkflow: PLAIN_WF, at: new Date().toISOString(),
    ctx: measure(head.media, next.media, `ctx_${TIER}`),
    ctrl: measure(head.media, ctrl.media, `ctrl_${TIER}`),
  }
  writeFileSync(join(OUT, `seam-${TIER}.json`), JSON.stringify(seam, null, 2) + '\n', 'utf8')
  const w = (m, k) => m.audio_xcorr_table?.[k]?.xcorr
  const fmt = (m) => `画面 MAD ${Number(m.frame_mad).toFixed(2)} · 音频相关 100/250/500/1000ms ${[w(m,'100ms'),w(m,'250ms'),w(m,'500ms'),w(m,'1000ms')].map((v)=>v==null?'—':Number(v).toFixed(3)).join(' / ')} · 包络 ${Number(m.env_xcorr).toFixed(3)} · 响度台阶 ${Number(m.level_step_db).toFixed(2)} dB`
  console.log('i2v 链式续接接缝量化 · %s 档', TIER)
  console.log('  上一镜 → 续接镜（ctx）：%s', fmt(seam.ctx))
  console.log('  上一镜 → 对照镜（同首帧同 seed，无续接）：%s', fmt(seam.ctrl))
  console.log('\n明细：%s', join(OUT, `seam-${TIER}.json`))
  process.exit(0)
}

const common = {
  workspaceId: 'smoke', sessionId,
  capability: 'video.image2video',
  type: 'i2v',
  width: W, height: H, seed: SEED, group: '片段',
}

console.log('i2v 链式续接端到端 · %s 档 · %s / %s · %dx%d · %d 帧请求\n', TIER, CHAIN_WF, PLAIN_WF, W, H, LENGTH)

// ① 起链（i2v + 首帧锚点，不传 continuity_from）
const t0 = Date.now()
const head = await _internals.runRender(ctx, { ...common, workflow: CHAIN_WF, prompt: PROMPT_HEAD, first_frame_node: ANCHOR_ID, length: LENGTH, title: 'S01 片段（i2v 起链）' })
const headNode = head.node
console.log('✓ ① 起链 %s · %ss · 交付 %d 帧（请求 %d）· load %s / save %s',
  head.implementation, ((Date.now() - t0) / 1000).toFixed(1), headNode.params.length, LENGTH,
  headNode.params.contextClipIndex, headNode.params.clipIndex)
if (headNode.params.contextClipIndex !== 0) fail('起链的 Load 序号必须是 0，实际 ' + headNode.params.contextClipIndex)
if (!(headNode.params.clipIndex >= 1)) fail('起链没分配 Save 序号（i2v 链式实现没生效？）')
if (headNode.params.length !== snap(LENGTH)) fail(`起链交付帧数记错：${headNode.params.length} != ${snap(LENGTH)}`)

// ② 抽起链镜末帧 → 续接镜的首帧锚点（转场镜/锚点式重渲的真实用法）
const tail = await _internals.runRender(ctx, {
  workspaceId: 'smoke', sessionId, capability: 'image.from_video', prompt: '',
  video_node: headNode.id, frame_index: -1, title: 'S01 末帧', group: '片段',
})
if (!/\.png$/.test(tail.node.media)) fail('抽帧拿到的是源视频回显，不是图片：' + tail.node.media)
console.log('✓ ② 抽末帧 %s → 作为续接镜首帧锚点', tail.node.media.split('/').pop())

// ③ 续接（首帧 = 上游末帧 + 继承上游尾部）
const t1 = Date.now()
const next = await _internals.runRender(ctx, { ...common, workflow: CHAIN_WF, prompt: PROMPT_NEXT, first_frame_node: tail.node.id, continuity_from: headNode.id, length: LENGTH, title: 'S02 片段（i2v 续接）' })
const nextNode = next.node
const expectSampled = snap(LENGTH + CTX_EXTRA)
console.log('✓ ③ 续接 %s · %ss · 请求 %d → 采样 %d → 交付 %d 帧 · load %s / save %s',
  next.implementation, ((Date.now() - t1) / 1000).toFixed(1), LENGTH, nextNode.params.sampledLength,
  nextNode.params.length, nextNode.params.contextClipIndex, nextNode.params.clipIndex)
if (nextNode.params.type !== 'i2v') fail('续接镜没记 type=i2v：' + nextNode.params.type)
if (nextNode.params.contextClipIndex !== headNode.params.clipIndex) fail('续接的 Load 序号没接上一镜')
if (nextNode.params.clipIndex !== headNode.params.clipIndex + 1) fail('续接的 Save 序号不是 +1')
if (nextNode.params.sampledLength !== expectSampled) fail(`采样帧数记错：${nextNode.params.sampledLength} != ${expectSampled}`)
if (nextNode.params.length !== expectSampled - CTX_EXTRA) fail(`交付帧数记错：${nextNode.params.length}`)
if (nextNode.params.continuityFrom !== headNode.id) fail('没记 continuityFrom')

// ④ 对照：同一张首帧图、同 seed、同交付帧数，但走普通 i2v 实现（无尾部继承）
const t2 = Date.now()
const plain = await _internals.runRender(ctx, { ...common, workflow: PLAIN_WF, prompt: PROMPT_NEXT, first_frame_node: tail.node.id, length: nextNode.params.length, seed: nextNode.params.seed, title: 'S02 对照（不续接）' })
console.log('✓ ④ 对照 %s · %ss · 交付 %d 帧 · seed %s（与续接镜同 seed 同首帧）',
  plain.implementation, ((Date.now() - t2) / 1000).toFixed(1), plain.node.params.length, plain.node.params.seed)
if (plain.node.params.clipIndex != null) fail('对照镜不该有链序号')

// ⑤ 反向：普通 i2v 实现 + continuity_from → 显式拒跑
try {
  await _internals.runRender(ctx, { ...common, workflow: PLAIN_WF, prompt: PROMPT_NEXT, first_frame_node: tail.node.id, length: LENGTH, continuity_from: headNode.id, title: '不该成功' })
  fail('普通 i2v 实现 + continuity_from 也跑通了——应当显式报错')
} catch (e) {
  if (!/不是链式续接实现/.test(String(e.message))) fail('拒跑信息不对：' + e.message)
  console.log('✓ ⑤ 普通 i2v 实现 + continuity_from → 显式拒跑')
}

for (const n of [headNode, nextNode, plain.node]) {
  const abs = join(workspace, n.media)
  if (!existsSync(abs)) fail('产物没落盘: ' + abs)
}

const rows = [headNode, nextNode, plain.node].map((n) => ({
  role: n.title, workflow: n.params.workflow, type: n.params.type, res: `${n.params.width}x${n.params.height}`,
  requested: LENGTH, sampled: n.params.sampledLength ?? n.params.length, delivered: n.params.length,
  load: n.params.contextClipIndex ?? null, save: n.params.clipIndex ?? null, seed: n.params.seed,
  continuityFrom: n.params.continuityFrom ?? null, media: n.media,
}))
writeFileSync(join(OUT, `rows-${TIER}.json`), JSON.stringify({ tier: TIER, chainWorkflow: CHAIN_WF, plainWorkflow: PLAIN_WF, rows }, null, 2) + '\n', 'utf8')

console.log('\n画布节点 %d 个：%s', readNodes().length, readNodes().map((n) => `${n.title}(${n.params.clipIndex ?? '-'})`).join(' · '))
console.log('\n上一镜（i2v 起链）：%s', join(workspace, headNode.media))
console.log('续接镜（i2v ctx）  ：%s', join(workspace, nextNode.media))
console.log('对照镜（同首帧同seed）：%s', join(workspace, plain.node.media))
// ⑥ 接缝量化（--measure）：两种用法都量——i2v 的画面接缝本来就被首帧锚定保证，
//    所以真正要看的是**音频**（首帧锚不住声音）与"继承了尾部运动"带来的差异。
let seam = null
if (MEASURE_ON) {
  seam = {
    ctx: measure(headNode.media, nextNode.media, `ctx_${TIER}`),
    ctrl: measure(headNode.media, plain.node.media, `ctrl_${TIER}`),
  }
  const fmt = (m) => `画面 MAD ${m.frame_mad?.toFixed?.(2) ?? m.frame_mad} · 音频 1s 相关 ${m.audio_xcorr_1000ms?.toFixed?.(3) ?? '—'} · 包络 ${m.audio_env_xcorr_1s?.toFixed?.(3) ?? '—'} · 响度台阶 ${m.level_step_db?.toFixed?.(2) ?? '—'} dB`
  console.log('✓ ⑥ 接缝（上一镜 → 续接镜）：%s', fmt(seam.ctx))
  console.log('   接缝（上一镜 → 对照镜）：%s', fmt(seam.ctrl))
}
if (seam) writeFileSync(join(OUT, `seam-${TIER}.json`), JSON.stringify(seam, null, 2) + '\n', 'utf8')

console.log('\n服务端 latent 槽位：clip_%05d（上一镜）→ clip_%05d（续接镜）', headNode.params.clipIndex, nextNode.params.clipIndex)
console.log('接缝量化：用 e2e-out/ctx-test/measure_seam.py 分别量（上一镜, 续接镜）与（上一镜, 对照镜）。')
console.log('明细已写 %s', join(OUT, `rows-${TIER}.json`))
