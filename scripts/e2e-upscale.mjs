/**
 * scripts/e2e-upscale.mjs — 视频超分（video_upscale / capability=video.upscale）端到端验证。**真跑 GPU**。
 *
 * 走的是**插件这一层**的完整链路（不是裸 ComfyUI 图）：
 *   读画布源节点 → 本机解容器拿尺寸 → 上传源片 → 按注册表取清单编译图 → 注入交付尺寸 →
 *   提交/等待/取回 → 落画布节点（记交付尺寸/倍率/溯源）
 *
 * 验证点：
 *  ① 单块：2K(2688×1536) → ×2 → 收敛 4032×2304；产物**实际**是 4032×2304（以容器为准，不信 params）
 *  ② 分块：chunk_frames=40（124 帧 → 4 块）→ ImageFromBatch 切帧 + TrimAudioDuration 切音轨 → 拼回；
 *     产物仍是 4032×2304 且**帧数守恒**（切音轨没切错才不会丢帧/错位）
 *  ③ 参数校验：缺 video_node / 非视频节点 / 非法 tier ⇒ 显式报错（不静默产出垃圾）
 *  ④ 容器解析回退：源节点**不带** width/height params 时，仍能从 mp4 读出尺寸并算对交付尺寸
 *  ⑤ 画布记录：交付尺寸写进 params（拼接/续接的兼容性判据要用），并记 upscaleFrom 溯源
 *
 * 用法：
 *   node scripts/e2e-upscale.mjs                       # 默认跑 ①②③⑤（x2 → 4032×2304）
 *   node scripts/e2e-upscale.mjs --src=<mp4> --chunk=40 --tag=myrun
 * 产物落 e2e-out/upscale/（画布写在临时工作区，不动用户会话）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { _internals } from '../lib/index.js'
import { probeMp4 } from '../lib/upscale.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'e2e-out', 'upscale')
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}

const SRC = arg('src', 'e2e-out/2k/v2s20f124-v2s20f124_00001_.mp4')   // U1 的 2K 交付：2688×1536
const TAG = arg('tag', 'e2e')
const TARGET = Number(arg('target', '4032'))
const CHUNK = Number(arg('chunk', '0'))
const TIER = arg('tier', 'quality')

const srcAbs = join(ROOT, SRC)
if (!existsSync(srcAbs)) {
  console.error(`✗ 源片不存在：${srcAbs}`)
  process.exit(1)
}
const srcProbe = probeMp4(srcAbs)
console.log(`源片 ${basename(srcAbs)} · ${srcProbe.w}×${srcProbe.h} · ${srcProbe.frames} 帧 · 音轨 ${srcProbe.hasAudio} · ${Number(srcProbe.duration).toFixed(2)}s`)

mkdirSync(OUT, { recursive: true })
const workspace = join(OUT, 'workspace-' + TAG)
const sessionId = 'upscale-smoke'
const projectPath = join(workspace, 'canvas', sessionId, 'project.json')
mkdirSync(dirname(projectPath), { recursive: true })

// 把源片放进画布媒体目录，并作为**普通视频节点**登记（模拟"画布上已有这一镜"）
const mediaName = 'src-' + basename(srcAbs)
const mediaRel = 'canvas-files/' + sessionId + '/' + mediaName
const mediaAbs = join(workspace, mediaRel)
mkdirSync(dirname(mediaAbs), { recursive: true })
copyFileSync(srcAbs, mediaAbs)

const srcNode = {
  id: 'src-shot-1',
  kind: 'video',
  title: '源镜（2K）',
  media: mediaRel,
  group: '片段',
  // 故意**不记** width/height/length —— 逼 runUpscale 走本机容器解析这条回退路径（验证点④）
  params: {},
  status: 'ready',
  createdAt: Date.now(),
  order: 1,
}
writeFileSync(projectPath, JSON.stringify({
  schemaVersion: 1, sessionId,
  settings: { aspectRatio: '16:9', duration: '', audioMode: 'dialogue-led', mode: TIER },
  nodes: [srcNode],
}, null, 2), 'utf8')

const ctx = {
  workspaceRegistry: {
    get: (id) => (id === 'smoke' ? { id, path: workspace } : undefined),
    list: () => [{ id: 'smoke', path: workspace, sessionIds: [sessionId] }],
  },
}
let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const readNodes = () => JSON.parse(readFileSync(projectPath, 'utf8')).nodes

// ── ③ 参数校验（不花 GPU）────────────────────────────────────────────────
console.log('\n[3] 参数校验：坏输入必须显式报错')
for (const [name, opts, want] of [
  ['缺 video_node', { video_node: '' }, '必须给 video_node'],
  ['节点不存在', { video_node: 'nope' }, '画布无此节点'],
  ['非法 tier', { video_node: srcNode.id, tier: 'ultra' }, '不在档位词汇表'],
]) {
  let msg = ''
  try { await _internals.runUpscale(ctx, { workspaceId: 'smoke', sessionId, ...opts }) } catch (e) { msg = e.message }
  check(name, msg.includes(want), msg || '(没报错)')
}
{
  // 图片节点也必须被拒
  const p = JSON.parse(readFileSync(projectPath, 'utf8'))
  p.nodes.push({ id: 'img-1', kind: 'image', title: '图', media: mediaRel, params: {}, status: 'ready', createdAt: Date.now(), order: 2 })
  writeFileSync(projectPath, JSON.stringify(p, null, 2))
  let msg = ''
  try { await _internals.runUpscale(ctx, { workspaceId: 'smoke', sessionId, video_node: 'img-1' }) } catch (e) { msg = e.message }
  check('非视频节点被拒', msg.includes('不是视频节点'), msg || '(没报错)')
  const q = JSON.parse(readFileSync(projectPath, 'utf8'))
  q.nodes = q.nodes.filter((n) => n.id !== 'img-1')
  writeFileSync(projectPath, JSON.stringify(q, null, 2))
}

// ── ①②⑤ 真跑 ────────────────────────────────────────────────────────────
const label = CHUNK ? `分块(${CHUNK}帧/块)` : '单块'
console.log(`\n[4/5] 真跑 · ${label} · ×2 · 目标宽 ${TARGET} · tier=${TIER}`)
const nodesBefore = readNodes().length
const t0 = Date.now()
const res = await _internals.runUpscale(ctx, {
  workspaceId: 'smoke', sessionId,
  video_node: srcNode.id,
  target_width: TARGET,
  chunk_frames: CHUNK || undefined,
  title: '源镜 · 超分',
  group: '超分',
})
const secs = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`  ▸ ${res.node.params.workflow} · ${secs}s · backend=${res.backend} · chunks=${res.chunks}`)
for (const w of res.warnings || []) console.log('  ! %s', w)

const outAbs = join(workspace, res.node.media)
check('产物落盘', existsSync(outAbs), outAbs)
const p = probeMp4(outAbs)
console.log(`  ▸ 产物 ${basename(outAbs)} · ${p.w}×${p.h} · ${p.frames} 帧 · 音轨 ${p.hasAudio}`)

const expW = TARGET
const expH = Math.round(srcProbe.h * 2 * (TARGET / (srcProbe.w * 2)) / 32) * 32
check(`产物实际尺寸 = ${expW}×${expH}（以容器为准）`, p.w === expW && p.h === expH, `${p.w}×${p.h}`)
check('交付尺寸写进画布 params', res.node.params.width === expW && res.node.params.height === expH,
  `${res.node.params.width}×${res.node.params.height}`)
check('帧数守恒（切音轨/分块没错位）', p.frames === srcProbe.frames, `${p.frames} != ${srcProbe.frames}`)
check('音轨保留', p.hasAudio === srcProbe.hasAudio, String(p.hasAudio))
check('溯源：upscaleFrom 指向源节点', res.node.params.upscaleFrom === srcNode.id, String(res.node.params.upscaleFrom))
check('记了倍率与自然尺寸', res.node.params.factor === 2 && res.node.params.naturalWidth === srcProbe.w * 2,
  `${res.node.params.factor} / ${res.node.params.naturalWidth}`)
check('源尺寸靠容器解析回退（源节点没记 params）',
  res.node.params.sourceWidth === srcProbe.w && res.node.params.sourceHeight === srcProbe.h,
  `${res.node.params.sourceWidth}×${res.node.params.sourceHeight}`)
check('只新增 1 个画布节点（源 + 本次产物）', readNodes().length === nodesBefore + 1,
  `${nodesBefore} → ${readNodes().length}`)
check('产物是 video 节点且 ready', res.node.kind === 'video' && res.node.status === 'ready')
if (CHUNK) {
  const want = Math.ceil(srcProbe.frames / CHUNK)
  check(`分块数 = ${want}（124 帧 / ${CHUNK}）`, res.chunks === want, String(res.chunks))
}

console.log('\n产物：%s', res.absPath)
console.log(failures ? `\n✗ ${failures} 项失败` : '\n✓ 全部通过')
process.exit(failures ? 1 : 0)
