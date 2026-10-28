// Fast 档 Sol-Attn（原生 BlockSparseAttention / sol-attn）A/B 速度实验。
//
// 背景：内置清单里 solattn 只有 balanced（PDD+ctx）与 quality（ctx）两档，fast 档没有。
// 本脚本用同一份 h3 模板派生两条臂（唯一差异 = 是否插 BlockSparseAttention），
// 同 prompt / seed / 分辨率 / 帧数 / 参考图交替跑，测 execution_start→success 的内部耗时。
//
// 两条臂都基于 **ctx（链式续接）** 模板，因为当前 config.tiers 的 fast 档就是
// minimax-h3-ref2v-ctx-fast；ctx 模板同时带 fast / quality 两档，这里只取 fast。
//
// 用法：
//   node scripts/experiment-solattn-fast.mjs --dry
//   node scripts/experiment-solattn-fast.mjs --pairs=4
//   node scripts/experiment-solattn-fast.mjs --tau=1.3 --tag=tau13
//
// 参数：--pairs=N（每组交替次数，默认 4）--seed --length --ratio --tau --min-tokens
//       --ref=<本地图片路径> --out-dir=<结果目录> --dry --vae=<VAE 资产名>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _internals } from '../lib/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.COMFY || 'http://localhost:8188'
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}
const DRY = process.argv.includes('--dry')

const PAIRS = Number(arg('pairs', 4))
const SEED = Number(arg('seed', 42424242))
const LENGTH = Number(arg('length', 124))
const RATIO = arg('ratio', '16:9')
const TAU = Number(arg('tau', 1.0))
const MIN_TOKENS = Number(arg('min-tokens', 12288))
const VAE = arg('vae', 'minimax_h3_video_vae_int8_convrot.safetensors')
const TAG = arg('tag', 'tau' + String(TAU).replace('.', ''))
const REF = arg('ref', 'canvas/session-bc8f982d-8270-42b0-a09a-bf5399146f03/e9cd2fee-d838-47b1-82d5-2d0fc1339700_00001_.png')
const OUT = resolve(ROOT, arg('out-dir', 'e2e-out/solattn-fast-ab'))

// 与 docs/minimax-h3-video-benchmark.md 的基准臂同一份 H3 结构化 prompt。
const PROMPT =
  'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n' +
  'integrated_multimodal_description: [Shot 1] 3D-animated film look, 5 seconds. A single cartoon fox wearing a small orange spacesuit with a backpack ' +
  'stands on a gray moon surface with fine dust and small craters under a dark starry sky. The camera pushes in slowly at eye level. ' +
  'The fox takes two small steps forward, its ears lift, then it tilts its head up to look at the stars. Soft rim light from the upper left, cool blue ambient light, ' +
  'dust puffs rising under its boots. The identity, fur color and spacesuit must stay exactly as in <Picture 1>.\n' +
  'How the reference pictures align: <Picture 1> defines the opening composition, character design, colors and lighting; the shot starts from that design and moves forward without a cut.\n\n' +
  'overall_soundscape: Quiet lunar ambience, soft hiss from the life-support backpack, two crunching boot steps on dust, faint radio static.\n\n' +
  'non_diegetic_music: Soft warm strings pad at low volume, no percussion.'

const TEMPLATES = {
  base: 'scripts/h3-templates/minimax-h3-ref2v-ctx.json',
  sol: 'scripts/h3-templates/minimax-h3-ref2v-ctx-solattn.json',
}

/** 读模板 → 只留 fast 档、固定 VAE、按需调 tau，得到一个一次性 manifest。 */
function loadArm(kind) {
  const m = JSON.parse(readFileSync(resolve(ROOT, TEMPLATES[kind]), 'utf8'))
  m.id = `experiment-ref2v-ctx-fast-${kind}`
  m.tier = 'fast'
  m.modes = { fast: m.modes.fast }
  m.assets.vae.default = VAE
  if (kind === 'sol') {
    const sol = Object.values(m.graph).find((n) => n.class_type === 'BlockSparseAttention')
    if (!sol) throw new Error('solattn 模板里没有 BlockSparseAttention 节点')
    sol.inputs['selection.tau'] = TAU
    sol.inputs.min_tokens = MIN_TOKENS
  }
  return m
}

/** 编译图 + 打印配方。 */
function buildArm(kind, refName, seed = SEED) {
  const manifest = loadArm(kind)
  const opts = {
    mode: 'fast',
    prompt: PROMPT,
    seed,
    length: LENGTH,
    context_clip_index: 0,   // 起链：0 表示不读任何上一镜 latent
    save_clip_index: 9001,   // 避开生产链的 slot 0/1，防止覆盖别的会话的续接缓存
    prefix: `experiment/solattn-fast/${TAG}`,
  }
  if (refName) opts.refs = [refName]
  const { graph, job, mode } = _internals.buildRenderGraph(manifest, opts, RATIO)
  return { manifest, graph, job, mode }
}

function describe(kind, built) {
  const g = Object.values(built.graph)
  const node = (cls) => g.find((n) => n.class_type === cls)
  const cond = node('MiniMaxH3ReferenceToVideo') || node('MiniMaxH3ImageToVideo')
  const sched = node('BasicScheduler')
  const shift = node('MiniMaxH3SigmaShift').inputs
  const loras = g.filter((n) => n.class_type === 'LoraLoaderModelOnly').map((n) => n.inputs.lora_name)
  const sol = node('BlockSparseAttention')
  const refs = built.job.refs || []
  return {
    arm: kind,
    size: `${cond.inputs.width}x${cond.inputs.height}`,
    length: cond.inputs.length,
    steps: sched.inputs.steps,
    sampler: node('KSamplerSelect').inputs.sampler_name,
    shift: `${shift.shift_video}/${shift.shift_audio}`,
    unet: node('UNETLoader').inputs.unet_name,
    vae: node('VAELoader').inputs.vae_name,
    loras,
    sol: sol ? { tau: sol.inputs['selection.tau'], min_tokens: sol.inputs.min_tokens, start: sol.inputs.start_percent, sink: sol.inputs.sink_conditioning } : null,
    refs,
    seed: node('RandomNoise').inputs.noise_seed,
    ctx: Boolean(node('MiniMaxH3MotionContext')),
  }
}

async function waitQueueIdle({ maxMs = 20 * 60 * 1000 } = {}) {
  const deadline = Date.now() + maxMs
  for (;;) {
    const res = await fetch(`${BASE}/queue`)
    const q = await res.json()
    const pending = (q.queue_running?.length || 0) + (q.queue_pending?.length || 0)
    if (pending === 0) return
    if (Date.now() > deadline) throw new Error('等待 ComfyUI 队列空闲超时')
    await new Promise((r) => setTimeout(r, 3000))
  }
}

async function ensureInput(name, localPath) {
  const probe = await fetch(`${BASE}/view?filename=${encodeURIComponent(name)}&type=input`)
  if (probe.ok) return name
  const up = await _internals.comfyUploadImage(readFileSync(resolve(ROOT, localPath)), name)
  if (!up?.name) throw new Error('参考图上传失败：' + localPath)
  return up.name
}

async function runOnce(kind, built, tag, { warm = false } = {}) {
  const t0 = Date.now()
  const pid = await _internals.comfySubmit(built.graph)
  const hist = await _internals.comfyWait(pid)
  const wall = (Date.now() - t0) / 1000
  const msgs = hist.status?.messages || []
  const a = msgs.find((m) => m[0] === 'execution_start')?.[1]?.timestamp
  const b = msgs.find((m) => m[0] === 'execution_success')?.[1]?.timestamp
  const err = msgs.find((m) => m[0] === 'execution_error')?.[1]
  if (err) throw new Error(`${tag} 执行失败：${JSON.stringify(err).slice(0, 500)}`)
  const outs = _internals.comfyOutputs(hist)
  let local = null
  let bytes = null
  if (outs[0]) {
    const buf = await _internals.comfyDownload(outs[0])
    bytes = buf.length
    local = resolve(OUT, `${TAG}-${tag}${extname(outs[0].filename) || '.mp4'}`)
    writeFileSync(local, buf)
  }
  // 记录提交前后队列状态，便于发现并发污染
  const q = await (await fetch(`${BASE}/queue`)).json()
  const queueBusy = (q.queue_running?.length || 0) + (q.queue_pending?.length || 0)
  return {
    arm: kind,
    tag,
    warm,
    pid,
    internal: a && b ? Number(((b - a) / 1000).toFixed(2)) : null,
    wall: Number(wall.toFixed(2)),
    queueBusyAfter: queueBusy,
    outs,
    local,
    bytes,
  }
}

function stats(xs) {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (!s.length) return null
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  const sq = s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length
  return { n: s.length, min: s[0], median: Number(median.toFixed(2)), mean: Number(mean.toFixed(2)), max: s[s.length - 1], sd: Number(Math.sqrt(sq).toFixed(2)), values: s }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  console.log(`[solattn-fast] 目标：fast（4 步 / ${RATIO} 长边 832 / 124f / seed ${SEED} / tau ${TAU}）`)

  await waitQueueIdle()
  const refName = await ensureInput(basename(REF), REF)
  console.log('[solattn-fast] 参考图：', refName)

  const arms = {}
  for (const kind of ['base', 'sol']) {
    arms[kind] = buildArm(kind, refName)
    const d = describe(kind, arms[kind])
    console.log(`[solattn-fast] 臂 ${kind}:`, JSON.stringify(d))
  }

  // 校验两臂唯一差异：多余 2b 节点 + 7/9 的 model 指向；其余字段一致
  const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))
  const baseKeys = Object.keys(arms.base.graph).sort()
  const solKeys = Object.keys(arms.sol.graph).sort()
  const expectSolKeys = [...baseKeys, '2b'].sort()
  if (JSON.stringify(solKeys) !== JSON.stringify(expectSolKeys)) {
    throw new Error(`两臂节点集合不一致：base=${baseKeys} sol=${solKeys}`)
  }
  const stable = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? sortKeys(v) : v))
  const stripped = (g) => {
    const c = JSON.parse(JSON.stringify(g))
    delete c['2b']
    c['7'].inputs.model = c['7'].inputs.model[0] === '2b' ? ['2', 0] : c['7'].inputs.model
    if (c['9']?.inputs?.model?.[0] === '2b') c['9'].inputs.model = ['2', 0]
    return c
  }
  if (stable(stripped(arms.sol.graph)) !== stable(arms.base.graph)) {
    throw new Error('两臂除 Sol 节点外的图不一致（A/B 不成立）')
  }
  console.log('[solattn-fast] 图校验通过：唯一差异 = [2b] BlockSparseAttention + 7/9.model 改指')

  if (DRY) {
    writeFileSync(resolve(OUT, `${TAG}-graphs.json`), JSON.stringify({ base: arms.base.graph, sol: arms.sol.graph }, null, 2))
    console.log('[solattn-fast] --dry：配方已打印，图已写入', resolve(OUT, `${TAG}-graphs.json`))
    return
  }

  const runs = []
  // 1) 各跑一次热机（模型加载 / 编译不算进 A/B）。热机 seed 与正式测量错开，避免命中缓存。
  const WARM_SEED = SEED + 1000000
  for (const kind of ['base', 'sol']) {
    await waitQueueIdle()
    const built = buildArm(kind, refName, WARM_SEED)
    const r = await runOnce(kind, built, `warmup-${kind}`, { warm: true })
    console.log(`[solattn-fast] 热机 ${kind}: 内部 ${r.internal}s / wall ${r.wall}s`)
    runs.push(r)
  }

  // 2) 交替测：base/sol 顺序逐组翻转，抵消热漂移。
  //    每组用**不同的 seed**（成对共享同一 seed）：既保证两臂噪声/构图可比，
  //    又强制 ComfyUI 重跑采样（同 seed 同图会直接命中缓存，测出来是 0.0s）。
  for (let i = 0; i < PAIRS; i++) {
    const seed = SEED + i
    const order = i % 2 === 0 ? ['base', 'sol'] : ['sol', 'base']
    for (const kind of order) {
      await waitQueueIdle()
      const built = buildArm(kind, refName, seed)
      const r = await runOnce(kind, built, `${kind}-${i + 1}`)
      r.seed = seed
      runs.push(r)
      console.log(`[solattn-fast] 第 ${i + 1} 组 ${kind} (seed ${seed}): 内部 ${r.internal}s / wall ${r.wall}s / 产物 ${r.outs?.[0]?.filename || '-'} / 后续队列 ${r.queueBusyAfter}`)
    }
  }

  const measured = runs.filter((r) => !r.warm)
  const sBase = stats(measured.filter((r) => r.arm === 'base').map((r) => r.internal))
  const sSol = stats(measured.filter((r) => r.arm === 'sol').map((r) => r.internal))
  const speedup = sBase && sSol ? Number((sBase.median / sSol.median).toFixed(3)) : null
  const savePct = speedup ? Number(((1 - sSol.median / sBase.median) * 100).toFixed(1)) : null

  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    config: { tier: 'fast', ratio: RATIO, length: LENGTH, seed: SEED, pairs: PAIRS, tau: TAU, minTokens: MIN_TOKENS, vae: VAE, ref: REF },
    recipes: { base: describe('base', arms.base), sol: describe('sol', arms.sol) },
    runs,
    stats: { base: sBase, sol: sSol, speedup, savePct },
  }
  const outJson = resolve(OUT, `${TAG}-results.json`)
  writeFileSync(outJson, JSON.stringify(summary, null, 2))

  const fmt = (s) => (s ? `${s.median}s（min ${s.min} / max ${s.max} / sd ${s.sd}，n=${s.n}）` : '—')
  console.log('\n===== A/B 结果（内部 execution 耗时） =====')
  console.log('  基线 base :', fmt(sBase))
  console.log('  稀疏 sol  :', fmt(sSol))
  console.log(`  加速比    : ${speedup ?? '—'}×（节省 ${savePct ?? '—'}%）`)
  console.log('  逐次      : base', sBase?.values, '| sol', sSol?.values)
  console.log('  结果 JSON :', outJson)
}

main().catch((e) => {
  console.error('[solattn-fast] 失败：', e.message)
  process.exitCode = 1
})
