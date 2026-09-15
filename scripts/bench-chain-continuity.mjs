/**
 * scripts/bench-chain-continuity.mjs — 链式续接的**档位 × 加速件覆盖矩阵**（真跑 GPU）。
 *
 * 一次跑完两件事：
 *  ① 档位覆盖：fast / balanced / balanced-pdd / balanced-pdd-sol / quality 各跑
 *     「起链 → 续接 → 同 seed 对照」三镜，**用各档原生分辨率**（不再用 832 覆盖）。
 *  ② 加速件叠加：同一素材、同一 seed 下比较 4 步蒸馏 / 8 步蒸馏 / PDD / PDD+Sol / 20 步
 *     五条路径的**接缝质量**（画面 MAD + 音频相关性 + 包络相关 + 响度台阶），
 *     看"省算力"是否把续接（尤其音频）一起省掉了。
 *
 * 素材用**带节拍的音乐型 prompt**：噪声型环境音上音频指标没有区分度（见 docs/shot-chain-continuity.md §5）。
 * 接缝测量直接在 ComfyUI 容器里跑（容器自带 av+numpy，不依赖宿主 ffmpeg）。
 *
 * 用法：
 *   node scripts/bench-chain-continuity.mjs                  # 全部 5 档（≈45min GPU）
 *   node scripts/bench-chain-continuity.mjs --only=fast,balanced
 *   node scripts/bench-chain-continuity.mjs --measure-only    # 只重量已有产物，不重渲
 *
 * 产物落 e2e-out/chain-bench/ 下；结果表同时写 e2e-out/chain-bench/report.md。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { _internals } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'e2e-out', 'chain-bench')
const MEASURE = join(ROOT, 'e2e-out', 'ctx-test', 'measure_seam.py')
const SSH_HOST = process.env.DSH_BENCH_SSH || ''   // 形如 user@host；跑接缝量化时必须给（容器所在宿主机）
const CONTAINER = process.env.DSH_BENCH_CONTAINER || 'comfyui'
const SERVER_OUT = '/root/ComfyUI/output'

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}
const ONLY = arg('only', '').split(',').map((s) => s.trim()).filter(Boolean)
const MEASURE_ONLY = process.argv.includes('--measure-only')
const SEED = Number(arg('seed', '20260915'))   // 每档再叠加各自偏移，见 seedOf()
const LENGTH = Number(arg('length', '124'))

const VARIANTS = [
  { key: 'fast', ctx: 'minimax-h3-ref2v-ctx-fast', plain: 'minimax-h3-ref2v-fast', accel: '4 步蒸馏 LoRA' },
  { key: 'balanced', ctx: 'minimax-h3-ref2v-ctx-balanced', plain: 'minimax-h3-ref2v-balanced', accel: '8 步 768p 蒸馏 LoRA' },
  { key: 'balanced-pdd', ctx: 'minimax-h3-ref2v-ctx-balanced-pdd', plain: 'minimax-h3-ref2v-balanced-pdd', accel: 'PDD nfe=8' },
  { key: 'balanced-pdd-sol', ctx: 'minimax-h3-ref2v-ctx-balanced-pdd-sol', plain: 'minimax-h3-ref2v-balanced-pdd-sol', accel: 'PDD + Sol-Attn' },
  { key: 'quality', ctx: 'minimax-h3-ref2v-ctx-quality', plain: 'minimax-h3-ref2v-quality', accel: '无（20 步）' },
].filter((v) => !ONLY.length || ONLY.includes(v.key))

const PROMPT_HEAD = [
  '[Shot 1] A 3D-animated fox-eared girl in a white fur coat kneels on a frozen lake at night, holding a dark glove over a snow hole.',
  'Sound: a steady 100 BPM electronic pulse with a low sustained synth pad, wind underneath, snow crunch on each beat.',
  '[0.0s] She kneels over the hole, coat moving in the wind, pulse steady.',
  '[2.0s] She lifts the glove slowly toward her chest.',
  '[4.5s] Camera settles close on her hands; the same pulse runs to the end of the shot.',
].join('\n')

const PROMPT_NEXT = [
  '[Shot 2] A 3D-animated fox-eared girl in a white fur coat on a frozen lake at night.',
  'The shot opens holding the exact closing framing of the previous clip and continues the same action.',
  'Sound: the same 100 BPM pulse, the same synth pad and the same wind continue without restarting or changing tempo.',
  '[0.0s] Hold the previous framing: glove at her chest, head lowered, pulse continuing.',
  '[2.0s] She exhales, shifts her weight, then rises to her feet.',
  '[4.0s] She turns her head toward the far ice ridge; the pulse keeps running.',
].join('\n')

mkdirSync(OUT, { recursive: true })
const workspace = join(OUT, 'workspace')
const sessionId = 'chain-bench'
const projectPath = join(workspace, 'canvas', sessionId, 'project.json')
mkdirSync(dirname(projectPath), { recursive: true })
if (!MEASURE_ONLY) {
  // 只在**要渲染**时重置画布。--measure-only 必须只读：它曾经在别的基准跑着的时候
  // 把画布清空，导致那次运行的"上一镜"节点消失、续接镜直接找不到来源。
  writeFileSync(projectPath, JSON.stringify({
    schemaVersion: 1, sessionId,
    settings: { aspectRatio: '16:9', duration: '', audioMode: 'silent', mode: 'quality' },
    nodes: [],
  }, null, 2), 'utf8')
}

const ctx = {
  workspaceRegistry: {
    get: (id) => (id === 'bench' ? { id, path: workspace } : undefined),
    list: () => [{ id: 'bench', path: workspace, sessionIds: [sessionId] }],
  },
}
const readNodes = () => JSON.parse(readFileSync(projectPath, 'utf8')).nodes
const nodeById = (id) => readNodes().find((n) => n.id === id)
const seedOf = (i) => SEED + i * 1000   // 同档内三镜同种子（可比），跨档不同种子（不吃缓存）
const common = {
  workspaceId: 'bench', sessionId,
  capability: 'video.reference2video',
  ref_nodes: [arg('ref', 'e2e-out/ctx-test/refA.png')],
  seed: SEED, group: '片段',
}

/** 在 ComfyUI 容器里量两条片子的接缝（返回解析后的 JSON）。 */
function measure(aMedia, bMedia, tag) {
  if (!SSH_HOST) throw new Error('接缝量化需要在 ComfyUI 容器所在宿主机上执行：请设 DSH_BENCH_SSH=user@host（可选 DSH_BENCH_CONTAINER，默认 comfyui）')
  const script = readFileSync(MEASURE, 'utf8')
  const out = execFileSync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', SSH_HOST,
    `sudo -n docker exec -i ${CONTAINER} python3 - ${SERVER_OUT}/${aMedia} ${SERVER_OUT}/${bMedia} ${SERVER_OUT}/seam_bench_${tag}`,
  ], { input: script, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000 })
  return JSON.parse(out.slice(out.indexOf('{')))
}

// 增量跑（--only=…）：默认与已有 rows.json 合并，这样分几次跑也能出一张完整表。
// --fresh 显式丢弃旧结果。
const ROWS_PATH = join(OUT, 'rows.json')
const ALL_KEYS = ['fast', 'balanced', 'balanced-pdd', 'balanced-pdd-sol', 'quality']
const rows = (process.argv.includes('--fresh') || !existsSync(ROWS_PATH)) ? [] : JSON.parse(readFileSync(ROWS_PATH, 'utf8'))
const report = []
for (const [vi, v] of VARIANTS.entries()) {
  console.log(`\n===== ${v.key}（${v.accel}）· seed ${seedOf(vi)} =====`)
  const commonV = { ...common, seed: seedOf(vi) }
  let head, next, ctrl
  if (!MEASURE_ONLY) {
    const t0 = Date.now()
    head = (await _internals.runRender(ctx, { ...commonV, workflow: v.ctx, prompt: PROMPT_HEAD, length: LENGTH, title: `B-${v.key}-起链` })).node
    const tHead = ((Date.now() - t0) / 1000).toFixed(1)
    const t1 = Date.now()
    next = (await _internals.runRender(ctx, { ...commonV, workflow: v.ctx, prompt: PROMPT_NEXT, length: LENGTH, continuity_from: head.id, title: `B-${v.key}-续接` })).node
    const tNext = ((Date.now() - t1) / 1000).toFixed(1)
    const t2 = Date.now()
    ctrl = (await _internals.runRender(ctx, { ...commonV, workflow: v.plain, prompt: PROMPT_NEXT, length: next.params.length, title: `B-${v.key}-对照` })).node
    const tCtrl = ((Date.now() - t2) / 1000).toFixed(1)
    v.times = { head: tHead, next: tNext, ctrl: tCtrl }
    console.log(`  渲染：起链 ${tHead}s · 续接 ${tNext}s · 对照 ${tCtrl}s`)
    console.log(`  帧数：起链 ${head.params.length} · 续接 ${next.params.length}（采样 ${next.params.sampledLength}）· 对照 ${ctrl.params.length} @ ${head.params.width}x${head.params.height}`)
  } else {
    // 复用已有产物：优先画布节点，其次上一轮 rows.json 里记的路径（画布被清过也能重量）
    const nodes = readNodes()
    const pick = (suffix) => nodes.filter((n) => n.title === `B-${v.key}-${suffix}`).pop()
    head = pick('起链'); next = pick('续接'); ctrl = pick('对照')
    if (!head || !next || !ctrl) {
      const prev = existsSync(join(OUT, 'rows.json')) ? JSON.parse(readFileSync(join(OUT, 'rows.json'), 'utf8')) : []
      const row = prev.find((r) => r.key === v.key)
      if (row?.sources) {
        head = { media: row.sources.head, params: { width: Number(row.res.split('x')[0]), height: Number(row.res.split('x')[1]) } }
        next = { media: row.sources.next, params: {} }
        ctrl = { media: row.sources.ctrl, params: {} }
      }
    }
    if (!head || !next || !ctrl) { console.log('  跳过：没有可复用的产物'); continue }
  }
  const missing = [head, next, ctrl].filter((n) => !n || !existsSync(join(workspace, n.media)))
  if (missing.length) {
    console.log('  跳过：产物缺失 ' + missing.map((n) => (n ? join(workspace, n.media) : '(节点为空)')).join(' / '))
    continue
  }
  const mCtx = measure(head.media, next.media, `${v.key}_ctx`)
  const mCtrl = measure(head.media, ctrl.media, `${v.key}_ctrl`)
  const row = {
    key: v.key, accel: v.accel, res: `${head.params.width}x${head.params.height}`,
    frames: `${head.params.length}/${next.params.length}/${ctrl.params.length}`,
    ctx: mCtx, ctrl: mCtrl, times: v.times || null,
    workflows: { ctx: v.ctx, plain: v.plain },
    sources: { head: head.media, next: next.media, ctrl: ctrl.media },
  }
  const dup = rows.findIndex((r) => r.key === v.key)
  if (dup >= 0) rows[dup] = row
  else rows.push(row)
  console.log(`  画面 MAD：续接 ${mCtx.frame_mad} vs 对照 ${mCtrl.frame_mad}`)
  console.log(`  音频 1s 相关：续接 ${mCtx.audio_xcorr_table['1000ms'].xcorr} vs 对照 ${mCtrl.audio_xcorr_table['1000ms'].xcorr}`)
  console.log(`  包络相关：续接 ${mCtx.env_xcorr} vs 对照 ${mCtrl.env_xcorr}`)
  console.log(`  响度台阶：续接 ${mCtx.level_step_db}dB vs 对照 ${mCtrl.level_step_db}dB`)
  writeFileSync(ROWS_PATH, JSON.stringify(rows, null, 2), 'utf8')
}

const f = (x) => (x === null || x === undefined ? '—' : String(x))
report.push(`# 链式续接 · 档位 × 加速件覆盖矩阵（${rows.length} 档）`, '')
report.push('素材：同一 prompt（带 100 BPM 节拍的音乐型声景）· 同一 seed · 各档**原生分辨率** · 上镜→本镜接缝')
report.push('')
report.push('| 实现 | 加速件 | 分辨率 | 帧数 起链/续接/对照 | 画面 MAD 续接→对照 | 音频相关 1s 续接→对照 | 包络相关 续接→对照 | 响度台阶 dB 续接→对照 | 耗时 起链/续接/对照 (s) |')
report.push('|---|---|---|---|---|---|---|---|---|')
for (const r of [...rows].sort((a, b) => ALL_KEYS.indexOf(a.key) - ALL_KEYS.indexOf(b.key))) {
  report.push(`| \`${r.workflows.ctx}\` | ${r.accel} | ${r.res} | ${r.frames} | **${f(r.ctx.frame_mad)}** → ${f(r.ctrl.frame_mad)} | **${f(r.ctx.audio_xcorr_table['1000ms'].xcorr)}** → ${f(r.ctrl.audio_xcorr_table['1000ms'].xcorr)} | **${f(r.ctx.env_xcorr)}** → ${f(r.ctrl.env_xcorr)} | **${f(r.ctx.level_step_db)}** → ${f(r.ctrl.level_step_db)} | ${r.times ? `${r.times.head}/${r.times.next}/${r.times.ctrl}` : '—'} |`)
}
if (MEASURE_ONLY && !rows.length) {
  console.log('没有可复用的产物 → 不动 report.md')
} else {
  writeFileSync(join(OUT, 'report.md'), report.join('\n') + '\n', 'utf8')
}
console.log('\n' + report.join('\n'))
console.log('\n报告：' + join(OUT, 'report.md'))
