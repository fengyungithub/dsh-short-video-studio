// scripts/experiment-solvae-node-timing.mjs — 用 ComfyUI WebSocket 事件量「每节点耗时」，
// 精确对比 Pika ctx + Sol-Attn 两种解码器（H3 int8 VAE vs Sol-H3-VAE）的 VAEDecode 耗时。
//
// 为什么不用总耗时：两臂采样子图完全相同（同 seed / 同 prompt / 同 LoRA），
// ComfyUI 会命中采样缓存，总耗时只剩解码差，噪声比信号大；
// 而 /history 不带节点耗时，只有 status.messages。所以直接连 /ws 记录
// executing 事件时间戳，按「节点开始 → 下一节点开始」求每节点墙钟。
//
// 用法：node scripts/experiment-solvae-node-timing.mjs --pairs=3
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { _internals } from '../lib/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.COMFY || 'http://localhost:8188'
const WS = BASE.replace(/^http/, 'ws') + '/ws'
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}

const PAIRS = Number(arg('pairs', 3))
// 种子必须每次运行都不同：ComfyUI 的节点级缓存在同 seed+同图时会把采样整段缓存掉，
// 复用旧 seed 会得到「全 cached」的假数据（实测踩过）。
const SEED = Number(arg('seed', Math.floor(Date.now() / 1000) % 1000000))
const LENGTH = Number(arg('length', 124))
const RATIO = arg('ratio', '16:9')
const TAG = arg('tag', 'solvae-nodes')
const VAE_A = arg('vae-a', 'minimax_h3_video_vae_int8_convrot.safetensors')
const VAE_B = arg('vae-b', 'sol_h3_vae.safetensors')
const SAVE_CLIP = Number(arg('save-clip-index', 9003))
const REF = arg('ref', 'canvas/session-bc8f982d-8270-42b0-a09a-bf5399146f03/e9cd2fee-d838-47b1-82d5-2d0fc1339700_00001_.png')
const OUT = resolve(ROOT, arg('out-dir', 'e2e-out/solvae-ab'))

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

function buildArm(kind, refName, seed = SEED) {
  const m = JSON.parse(readFileSync(resolve(ROOT, TEMPLATES[kind]), 'utf8'))
  m.id = `experiment-ref2v-ctx-balanced-pika-${kind}`
  m.tier = MODE
  m.modes = { [MODE]: m.modes[MODE] }
  // 两臂的**编码 VAE 必须一致**：只允许解码器不同，否则参考图/MotionContext 的编码哈希也变了，
  // 采样缓存失效、A/B 不成立（标准 fast 清单默认 fp16，Pika 清单默认 int8，踩过）。
  if (m.assets?.vae) m.assets.vae.default = VAE_A
  if (kind === 'sol') m.assets.vae_decode.default = VAE_B
  const opts = {
    mode: MODE,
    prompt: PROMPT,
    seed,
    length: LENGTH,
    context_clip_index: 0,
    save_clip_index: SAVE_CLIP,
    prefix: `experiment/solvae/${TAG}`,
    refs: refName ? [refName] : undefined,
  }
  const { graph } = _internals.buildRenderGraph(m, opts, RATIO)
  return graph
}

function openWs(clientId) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${WS}?clientId=${clientId}`)
    ws.onopen = () => res(ws)
    ws.onerror = (e) => rej(new Error('ws 连接失败：' + (e?.message || 'error')))
  })
}

async function waitQueueIdle() {
  for (;;) {
    const q = await (await fetch(`${BASE}/queue`)).json()
    if ((q.queue_running?.length || 0) + (q.queue_pending?.length || 0) === 0) return
    await new Promise((r) => setTimeout(r, 2000))
  }
}

/** 跑一次，返回 {total, nodes: {id: seconds}, cached: [...]}。 */
async function runOnce(graph, tag) {
  const clientId = randomUUID()
  await waitQueueIdle()
  const ws = await openWs(clientId)
  const events = []
  const t0 = Date.now()

  const done = new Promise((resolveDone, rejectDone) => {
    const timer = setTimeout(() => rejectDone(new Error(tag + ' 超时')), 30 * 60 * 1000)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      const now = Date.now()
      events.push({ t: now, type: msg.type, data: msg.data })
      if (msg.type === 'execution_success' && msg.data?.prompt_id === pid) {
        clearTimeout(timer)
        resolveDone()
      }
      if (msg.type === 'execution_error' && msg.data?.prompt_id === pid) {
        clearTimeout(timer)
        rejectDone(new Error(tag + ' 执行失败：' + JSON.stringify(msg.data).slice(0, 500)))
      }
    }
  })

  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body?.prompt_id) throw new Error(tag + ' 提交失败：' + JSON.stringify(body).slice(0, 500))
  const pid = body.prompt_id

  try {
    await done
  } finally {
    ws.close()
  }

  // 节点耗时：executing(node) → 下一个 executing / execution_success
  const nodes = {}
  const cached = events.find((e) => e.type === 'execution_cached')?.data?.nodes || []
  let pending = null
  let pendingAt = 0
  for (const e of events) {
    if (e.type === 'executing' && e.data?.node) {
      if (pending) nodes[pending] = Number(((e.t - pendingAt) / 1000).toFixed(2))
      pending = e.data.node
      pendingAt = e.t
    }
    if (e.type === 'execution_success') {
      if (pending) nodes[pending] = Number(((e.t - pendingAt) / 1000).toFixed(2))
      pending = null
    }
  }
  return { tag, total: Number(((Date.now() - t0) / 1000).toFixed(2)), nodes, cached }
}

function stats(xs) {
  const s = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b)
  if (!s.length) return null
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  return { n: s.length, min: s[0], median: Number(median.toFixed(2)), mean: Number(mean.toFixed(2)), max: s[s.length - 1], values: s }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  console.log(`[solvae-nodes] mode=${MODE} ${RATIO} / ${LENGTH}f / pairs ${PAIRS} / A=${VAE_A} / B=${VAE_B}`)
  const refName = await (async () => {
    const name = basename(REF)
    const probe = await fetch(`${BASE}/view?filename=${encodeURIComponent(name)}&type=input`)
    if (probe.ok) return name
    const up = await _internals.comfyUploadImage(readFileSync(resolve(ROOT, REF)), name)
    return up.name
  })()

  const runs = []
  for (const kind of ['int8', 'sol']) {
    const g = buildArm(kind, refName, SEED + 1000000)
    const r = await runOnce(g, `warmup-${kind}`)
    r.arm = kind
    r.warm = true
    runs.push(r)
    console.log(`[solvae-nodes] 热机 ${kind}: total ${r.total}s decode=${r.nodes['11'] ?? '-'}s vaeLoad=${r.nodes['4b'] ?? r.nodes['4'] ?? '-'}s sampler=${r.nodes['10'] ?? '-'}s`)
  }

  for (let i = 0; i < PAIRS; i++) {
    const seed = SEED + i
    const order = i % 2 === 0 ? ['int8', 'sol'] : ['sol', 'int8']
    for (const kind of order) {
      const g = buildArm(kind, refName, seed)
      const r = await runOnce(g, `${kind}-${i + 1}`)
      r.arm = kind
      r.seed = seed
      runs.push(r)
      console.log(
        `[solvae-nodes] ${kind} #${i + 1} (seed ${seed}): total ${r.total}s | VAEDecode ${r.nodes['11'] ?? 'cached'}s | VAELoader ${r.nodes['4b'] ?? r.nodes['4'] ?? 'cached'}s | sampler ${r.nodes['10'] ?? 'cached'}s | SaveVideo ${r.nodes['13'] ?? 'cached'}s | cached ${r.cached.length} 节点`,
      )
    }
  }

  const measured = runs.filter((r) => !r.warm)
  const decA = stats(measured.filter((r) => r.arm === 'int8').map((r) => r.nodes['11']))
  const decB = stats(measured.filter((r) => r.arm === 'sol').map((r) => r.nodes['11']))
  const loadA = stats(measured.filter((r) => r.arm === 'int8').map((r) => r.nodes['4']))
  const loadB = stats(measured.filter((r) => r.arm === 'sol').map((r) => r.nodes['4b']))
  const ratio = decA && decB ? Number((decA.median / decB.median).toFixed(2)) : null

  const summary = { generatedAt: new Date().toISOString(), config: { ratio: RATIO, length: LENGTH, pairs: PAIRS, vaeA: VAE_A, vaeB: VAE_B }, runs, stats: { decodeA: decA, decodeB: decB, loadA, loadB, decodeSpeedup: ratio } }
  const outJson = resolve(OUT, `${TAG}-results.json`)
  writeFileSync(outJson, JSON.stringify(summary, null, 2))

  const fmt = (s) => (s ? `${s.median}s（min ${s.min} / max ${s.max}，n=${s.n}）` : '—')
  console.log('\n===== VAEDecode 节点耗时 =====')
  console.log('  A 原版 H3 VAE（int8）:', fmt(decA))
  console.log('  B Sol-H3-VAE        :', fmt(decB))
  console.log('  解码提速            :', ratio ? `${ratio}×（节省 ${((1 - decB.median / decA.median) * 100).toFixed(1)}%）` : '—')
  console.log('  VAELoader 耗时      : A', fmt(loadA), '| B', fmt(loadB))
  console.log('  结果 JSON           :', outJson)
}

main().catch((e) => {
  console.error('[solvae-nodes] 失败：', e.message)
  process.exitCode = 1
})
