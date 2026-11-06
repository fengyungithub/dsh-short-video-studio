// scripts/experiment-solvae-ab.mjs — Pika ctx + Sol-Attn 的 VAE 对照实验（H3 int8 VAE vs Sol-H3-VAE）。
//
// 目的：工作流其余部分完全不变（Pika 6 步适配器 + 原生 BlockSparseAttention(sol-attn) + 链式续接），
// 只把 VAEDecode 的解码器换成 Sol-H3-VAE（24 层蒸馏非因果解码器），量解码阶段与单镜总耗时的差。
//
// 两臂来自两份清单：
//   A: workflows/minimax-h3-ref2v-ctx-balanced-pika-solattn.json      （VAEDecode → 原 H3 视频 VAE）
//   B: workflows/minimax-h3-ref2v-ctx-balanced-pika-solattn-solvae.json（VAEDecode → Sol-H3-VAE）
// 脚本会先断言两臂图**只差**一个 VAELoader 节点（4b）与 11.vae 的指向，否则直接报错，避免"假 A/B"。
//
// 前置：ComfyUI >= v0.44.0（PR #17411 才认识 Sol-H3-VAE 权重）+ models/vae/sol_h3_vae.safetensors。
//
// 用法：
//   node scripts/experiment-solvae-ab.mjs --dry
//   node scripts/experiment-solvae-ab.mjs --pairs=4
//   node scripts/experiment-solvae-ab.mjs --pairs=4 --ref=<本地参考图>
//
// 参数：--pairs=N(默认 3) --seed --length(默认 124) --ratio(默认 16:9) --ref --out-dir --dry --vae-a --vae-b
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

const PAIRS = Number(arg('pairs', 3))
const SEED = Number(arg('seed', 20261106))
const LENGTH = Number(arg('length', 124))
const RATIO = arg('ratio', '16:9')
const TAG = arg('tag', 'solvae')
const VAE_A = arg('vae-a', 'minimax_h3_video_vae_int8_convrot.safetensors')
const VAE_B = arg('vae-b', 'sol_h3_vae.safetensors')
const SAVE_CLIP = Number(arg('save-clip-index', 9002)) // 避开生产链 slot，防止覆盖别人的续接缓存
const REF = arg('ref', 'canvas/session-bc8f982d-8270-42b0-a09a-bf5399146f03/e9cd2fee-d838-47b1-82d5-2d0fc1339700_00001_.png')
const OUT = resolve(ROOT, arg('out-dir', 'e2e-out/solvae-ab'))

// 与 docs/minimax-h3-video-benchmark.md 同源的 H3 结构化 prompt；两臂完全相同。
const PROMPT =
  'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n' +
  'integrated_multimodal_description: [Shot 1] 3D-animated film look, 5 seconds. A single cartoon fox wearing a small orange spacesuit with a backpack ' +
  'stands on a gray moon surface with fine dust and small craters under a dark starry sky. The camera pushes in slowly at eye level. ' +
  'The fox takes two small steps forward, its ears lift, then it tilts its head up to look at the stars. Soft rim light from the upper left, cool blue ambient light, ' +
  'dust puffs rising under its boots. The identity, fur color and spacesuit must stay exactly as in <Picture 1>.\n' +
  'How the reference pictures align: <Picture 1> defines the opening composition, character design, colors and lighting; the shot starts from that design and moves forward without a cut.\n\n' +
  'overall_soundscape: Quiet lunar ambience, soft hiss from the life-support backpack, two crunching boot steps on dust, faint radio static.\n\n' +
  'non_diegetic_music: Soft warm strings pad at low volume, no percussion.'

const MODE = arg('mode', 'balanced')
const TEMPLATES = {
  int8: arg('template-a', 'workflows/minimax-h3-ref2v-ctx-balanced-pika-solattn.json'),
  sol: arg('template-b', 'workflows/minimax-h3-ref2v-ctx-balanced-pika-solattn-solvae.json'),
}

/** 读清单 → 只保留 balanced 档，返回一次性 manifest。 */
function loadArm(kind) {
  const m = JSON.parse(readFileSync(resolve(ROOT, TEMPLATES[kind]), 'utf8'))
  m.id = `experiment-ref2v-ctx-balanced-pika-${kind}`
  m.tier = MODE
  m.modes = { [MODE]: m.modes[MODE] }
  // 两臂的**编码 VAE 必须一致**：只允许解码器不同，否则参考图/MotionContext 的编码哈希也变了，
  // 采样缓存失效、A/B 不成立（标准 fast 清单默认 fp16，Pika 清单默认 int8，踩过）。
  if (m.assets?.vae) m.assets.vae.default = VAE_A
  if (kind === 'sol') m.assets.vae_decode.default = VAE_B
  return m
}

function buildArm(kind, refName, seed = SEED) {
  const manifest = loadArm(kind)
  const opts = {
    mode: MODE,
    prompt: PROMPT,
    seed,
    length: LENGTH,
    context_clip_index: 0, // 起链：0 表示不读上一镜 latent
    save_clip_index: SAVE_CLIP,
    prefix: `experiment/solvae/${TAG}`,
  }
  if (refName) opts.refs = [refName]
  const { graph, job, mode } = _internals.buildRenderGraph(manifest, opts, RATIO)
  return { manifest, graph, job, mode }
}

function describe(kind, built) {
  const g = Object.values(built.graph)
  const node = (cls) => g.find((n) => n.class_type === cls)
  const cond = node('MiniMaxH3ReferenceToVideo')
  const vaeLoaders = g.filter((n) => n.class_type === 'VAELoader').map((n) => n.inputs.vae_name)
  const dec = g.find((n) => n.class_type === 'VAEDecode')
  const sol = g.find((n) => n.class_type === 'BlockSparseAttention')
  return {
    arm: kind,
    size: `${cond.inputs.width}x${cond.inputs.height}`,
    length: cond.inputs.length,
    vaeLoaders,
    decodeVae: (() => {
      const ref = dec?.inputs?.vae?.[0]
      const loader = g.find((n) => n === g.find((x) => x.class_type === 'VAELoader' && built.graph[ref] === x))
      return built.graph[ref]?.inputs?.vae_name || loader?.inputs?.vae_name || null
    })(),
    loras: g.filter((n) => n.class_type === 'LoraLoaderModelOnly').map((n) => n.inputs.lora_name),
    sol: sol ? { tau: sol.inputs['selection.tau'], min_tokens: sol.inputs.min_tokens, start: sol.inputs.start_percent } : null,
    refs: built.job.refs || [],
    seed: node('RandomNoise').inputs.noise_seed,
  }
}

async function waitQueueIdle({ maxMs = 30 * 60 * 1000 } = {}) {
  const deadline = Date.now() + maxMs
  for (;;) {
    const q = await (await fetch(`${BASE}/queue`)).json()
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
  if (err) throw new Error(`${tag} 执行失败：${JSON.stringify(err).slice(0, 600)}`)
  const outs = _internals.comfyOutputs(hist)
  let local = null
  let bytes = null
  if (outs[0]) {
    const buf = await _internals.comfyDownload(outs[0])
    bytes = buf.length
    local = resolve(OUT, `${TAG}-${tag}${extname(outs[0].filename) || '.mp4'}`)
    writeFileSync(local, buf)
  }
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
  console.log(`[solvae-ab] 目标：Pika ctx ${MODE}（${RATIO} / 1344 长边 / ${LENGTH}f / seed ${SEED} / pairs ${PAIRS}）`)
  console.log(`[solvae-ab] A 解码器=${VAE_A}  B 解码器=${VAE_B}`)

  const arms = {}
  for (const kind of ['int8', 'sol']) arms[kind] = buildArm(kind, null)

  // 图校验：两臂只差 [4b] VAELoader + 11.vae 指向。
  const keysA = Object.keys(arms.int8.graph).sort()
  const keysB = Object.keys(arms.sol.graph).sort()
  const expectB = [...keysA, '4b'].sort()
  if (JSON.stringify(keysB) !== JSON.stringify(expectB)) {
    throw new Error(`两臂节点集合不一致：A=${keysA} B=${keysB}`)
  }
  const strip = (g) => {
    const c = JSON.parse(JSON.stringify(g))
    delete c['4b']
    if (c['11']?.inputs?.vae?.[0] === '4b') c['11'].inputs.vae = ['4', 0]
    return c
  }
  const stable = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((kk) => [kk, v[kk]])) : v))
  if (stable(strip(arms.sol.graph)) !== stable(arms.int8.graph)) {
    throw new Error('两臂除 Sol VAE 解码器外还有别的差异（A/B 不成立）')
  }
  console.log('[solvae-ab] 图校验通过：唯一差异 = [4b] VAELoader(Sol-H3-VAE) + 11.vae 改指')

  if (DRY) {
    writeFileSync(resolve(OUT, `${TAG}-graphs.json`), JSON.stringify({ int8: arms.int8.graph, sol: arms.sol.graph }, null, 2))
    console.log('[solvae-ab] --dry：图已写入', resolve(OUT, `${TAG}-graphs.json`))
    return
  }

  await waitQueueIdle()
  const refName = await ensureInput(basename(REF), REF)
  console.log('[solvae-ab] 参考图：', refName)

  const built = {}
  for (const kind of ['int8', 'sol']) {
    await waitQueueIdle()
    built[kind] = buildArm(kind, refName)
    console.log(`[solvae-ab] 臂 ${kind}:`, JSON.stringify(describe(kind, built[kind])))
  }

  const runs = []
  const WARM_SEED = SEED + 1000000
  for (const kind of ['int8', 'sol']) {
    await waitQueueIdle()
    // 热机必须用与正式测量不同的 seed：同 seed + 同图会让 ComfyUI 整图命中缓存（实测踩过）。
    const r = await runOnce(kind, buildArm(kind, refName, WARM_SEED), `warmup-${kind}`, { warm: true })
    console.log(`[solvae-ab] 热机 ${kind}: 内部 ${r.internal}s / wall ${r.wall}s`)
    runs.push(r)
  }

  for (let i = 0; i < PAIRS; i++) {
    const seed = SEED + i
    const order = i % 2 === 0 ? ['int8', 'sol'] : ['sol', 'int8']
    for (const kind of order) {
      await waitQueueIdle()
      const b = buildArm(kind, refName, seed)
      const r = await runOnce(kind, b, `${kind}-${i + 1}`)
      r.seed = seed
      runs.push(r)
      console.log(`[solvae-ab] 第 ${i + 1} 组 ${kind} (seed ${seed}): 内部 ${r.internal}s / wall ${r.wall}s / 产物 ${r.outs?.[0]?.filename || '-'}`)
    }
  }

  const measured = runs.filter((r) => !r.warm)
  const sA = stats(measured.filter((r) => r.arm === 'int8').map((r) => r.internal))
  const sB = stats(measured.filter((r) => r.arm === 'sol').map((r) => r.internal))
  const ratio = sA && sB ? Number((sA.median / sB.median).toFixed(3)) : null
  const savePct = ratio ? Number(((1 - sB.median / sA.median) * 100).toFixed(1)) : null

  const summary = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    config: { tier: 'balanced', ratio: RATIO, length: LENGTH, seed: SEED, pairs: PAIRS, vaeA: VAE_A, vaeB: VAE_B, ref: REF },
    recipes: { int8: describe('int8', arms.int8), sol: describe('sol', arms.sol) },
    runs,
    stats: { int8: sA, sol: sB, speedup: ratio, savePct },
  }
  const outJson = resolve(OUT, `${TAG}-results.json`)
  writeFileSync(outJson, JSON.stringify(summary, null, 2))

  const fmt = (s) => (s ? `${s.median}s（min ${s.min} / max ${s.max} / sd ${s.sd}，n=${s.n}）` : '—')
  console.log('\n===== VAE A/B 结果（内部 execution 耗时，含采样） =====')
  console.log('  A 原版 H3 VAE :', fmt(sA))
  console.log('  B Sol-H3-VAE  :', fmt(sB))
  console.log(`  提速          : ${ratio ?? '—'}×（节省 ${savePct ?? '—'}%）`)
  console.log('  逐次          : A', sA?.values, '| B', sB?.values)
  console.log('  结果 JSON     :', outJson)
}

main().catch((e) => {
  console.error('[solvae-ab] 失败：', e.message)
  process.exitCode = 1
})
