// scripts/experiment-regen-solattn.mjs — Open-H3 Regenerate 的 Sol-Attn / 快解码器 A/B。
//
// 目的：在**同一份 768p 草稿、同 prompt、同 refine seed、同目标网格**下，量出：
//   · arm=dense vs arm=sol（原生 BlockSparseAttention 插在 OpenH3RegenLora 之后）；
//   · vae=fast（sol_h3_vae）vs vae=stock（minimax_h3_video_vae_fp16）的 VAEDecode 耗时。
// 走的是清单 + 图编译这一层，不经过画布（产物写 e2e-out/regen-solattn/）。
//
// 用法：
//   node scripts/experiment-regen-solattn.mjs --arm=sol --length=17 --vae=fast   # 冒烟
//   node scripts/experiment-regen-solattn.mjs --arm=sol --length=124 --vae=fast
//   node scripts/experiment-regen-solattn.mjs --arm=dense --length=124 --vae=fast
//   node scripts/experiment-regen-solattn.mjs --arm=sol --length=17 --vae=stock  # 解码器对照
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

const ARM = arg('arm', 'sol')                     // dense | sol
const VAE = arg('vae', 'fast')                    // fast | stock
const LENGTH = Number(arg('length', 124))         // 源片交付帧数（也会按源片实际帧数走）
const TARGET = arg('target', '2k')
const SEED = Number(arg('seed', 424242))
const SOURCE = arg('source', 'e2e-out/2k-vs-regen/rain-alley-draft.mp4')
const TAG = arg('tag', `regen-${ARM}-${VAE}-${LENGTH}f`)
const OUT = resolve(ROOT, arg('out-dir', 'e2e-out/regen-solattn'))
const MANIFEST = 'workflows/minimax-h3-regenerate-2k.json'
const STOCK_VAE = 'minimax_h3_video_vae_fp16.safetensors'

const TARGETS = { '1080p': [1920, 1088], '2k': [2560, 1440] }
const target = TARGETS[TARGET]
if (!target) throw new Error(`未知 target "${TARGET}"`)

const PROMPT = readFileSync(resolve(ROOT, 'e2e-out/2k-vs-regen/prompt-rain-alley.txt'), 'utf8')

const SOL_INPUTS = {
  selection: 'sol-attn',
  'selection.tau': Number(arg('tau', 1.0)),
  start_percent: Number(arg('start-percent', 0.2)),
  end_percent: 1,
  dense_blocks: '',
  min_tokens: Number(arg('min-tokens', 12288)),
  extra_tokens: 256,
  sink_conditioning: 'exact_kv_and_rows',
  verbose: true,
}

/** 清单 → 图：可选插 BlockSparseAttention（8b，夹在 LoRA 与 guider 之间）、可选换解码 VAE。 */
function buildGraph(srcName) {
  const m = JSON.parse(readFileSync(resolve(ROOT, MANIFEST), 'utf8'))
  m.id = `experiment-regen-${ARM}`
  if (VAE === 'stock') m.assets.vae_decode.default = STOCK_VAE
  if (ARM === 'sol') {
    const guider = Object.entries(m.graph).find(([, n]) => n.class_type === 'BasicGuider')
    const lora = Object.entries(m.graph).find(([, n]) => n.class_type === 'OpenH3RegenLora')
    if (!guider || !lora) throw new Error('清单里找不到 guider / LoRA 节点')
    m.graph['8b'] = { class_type: 'BlockSparseAttention', inputs: { ...SOL_INPUTS, model: [lora[0], 0] } }
    guider[1].inputs.model = ['8b', 0]
  }
  const built = _internals.buildGraphFromManifest(m, {
    mode: null,
    assetOverrides: {},
    source_video: srcName,
    prompt: PROMPT,
    width: target[0],
    height: target[1],
    seed: SEED,
    steps: Number(arg('steps', 3)),
    start_sigma: Number(arg('start-sigma', 0)),
    prefix: `experiment/regen-solattn/${TAG}`,
  })
  return { manifest: m, graph: built }
}

function fmtGraph(g) {
  const nodes = Object.entries(g).map(([k, v]) => `${k}:${v.class_type}`)
  const sol = Object.values(g).find((n) => n.class_type === 'BlockSparseAttention')
  const vae = Object.values(g).filter((n) => n.class_type === 'VAELoader').map((n) => n.inputs.vae_name)
  return { nodes: nodes.length, sol: !!sol, vae, size: `${target[0]}x${target[1]}`, length: LENGTH, seed: SEED }
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

async function runOnce(graph) {
  const clientId = randomUUID()
  await waitQueueIdle()
  const ws = await openWs(clientId)
  const events = []
  const t0 = Date.now()
  let pid = null

  const done = new Promise((resolveDone, rejectDone) => {
    const timer = setTimeout(() => rejectDone(new Error('执行超时')), 40 * 60 * 1000)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      events.push({ t: Date.now(), type: msg.type, data: msg.data })
      if (msg.type === 'execution_success') { clearTimeout(timer); resolveDone() }
      if (msg.type === 'execution_error') { clearTimeout(timer); rejectDone(new Error('执行失败：' + JSON.stringify(msg.data).slice(0, 800))) }
    }
  })

  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: clientId }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body?.prompt_id) throw new Error('提交失败：' + JSON.stringify(body).slice(0, 800))
  pid = body.prompt_id

  try { await done } finally { ws.close() }

  // 节点耗时：executing(node) → 下一个 executing / execution_success
  const nodes = {}
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
  const started = events.find((e) => e.type === 'execution_start')?.t
  const finished = events.find((e) => e.type === 'execution_success')?.t
  return {
    pid,
    wall: Number(((Date.now() - t0) / 1000).toFixed(2)),
    internal: started && finished ? Number(((finished - started) / 1000).toFixed(2)) : null,
    nodes,
    cached: events.find((e) => e.type === 'execution_cached')?.data?.nodes || [],
    byClass: Object.fromEntries(Object.entries(graph).map(([k, v]) => [k, v.class_type])),
  }
}

async function uploadSource() {
  const name = `regen-src-${TAG.replace(/[^a-zA-Z0-9._-]/g, '_')}.mp4`
  const up = await _internals.comfyUploadImage(readFileSync(resolve(ROOT, SOURCE)), name)
  return up.subfolder ? up.subfolder + '/' + up.name : up.name
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const srcName = await uploadSource()
  const { manifest, graph } = buildGraph(srcName)
  console.log(`[regen-solattn] ${TAG} | ${JSON.stringify(fmtGraph(graph))}`)
  console.log(`[regen-solattn] 源片 ${srcName} / prompt ${PROMPT.length} 字符 / manifest ${manifest.id}`)

  const r = await runOnce(graph)
  const decodeNode = Object.entries(graph).find(([, n]) => n.class_type === 'VAEDecode')?.[0]
  const samplerNode = Object.entries(graph).find(([, n]) => n.class_type === 'SamplerCustomAdvanced')?.[0]
  const upNode = Object.entries(graph).find(([, n]) => n.class_type === 'MiniMaxH3LatentUpscaleWithModel')?.[0]
  const prepNode = Object.entries(graph).find(([, n]) => n.class_type === 'OpenH3RegenPrepareDraft')?.[0]
  const finishNode = Object.entries(graph).find(([, n]) => n.class_type === 'OpenH3RegenFinish')?.[0]
  const saveNode = Object.entries(graph).find(([, n]) => n.class_type === 'SaveVideo')?.[0]

  // 取产物（仅记录体积/路径，不落盘大文件以外的处理）
  let outFile = null
  try {
    const hist = await (await fetch(`${BASE}/history/${r.pid}`)).json()
    const outs = _internals.comfyOutputs(hist[r.pid])
    if (outs[0]) {
      const buf = await _internals.comfyDownload(outs[0])
      outFile = resolve(OUT, `${TAG}.mp4`)
      writeFileSync(outFile, buf)
      r.bytes = buf.length
    }
    r.outputs = outs
  } catch (e) {
    console.warn('[regen-solattn] 取产物失败：', e.message)
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    tag: TAG, arm: ARM, vae: VAE, target: TARGET, length: LENGTH, seed: SEED, source: SOURCE, srcName,
    size: target, graphNodes: Object.keys(graph).length,
    total: r.wall, internal: r.internal, cached: r.cached.length,
    stage: {
      prepareDraft: r.nodes[prepNode] ?? null,
      upscale: r.nodes[upNode] ?? null,
      sampler: r.nodes[samplerNode] ?? null,
      decode: r.nodes[decodeNode] ?? null,
      finish: r.nodes[finishNode] ?? null,
      save: r.nodes[saveNode] ?? null,
    },
    nodes: r.nodes, bytes: r.bytes ?? null, outFile,
  }
  writeFileSync(resolve(OUT, `${TAG}.json`), JSON.stringify(summary, null, 2))
  console.log('[regen-solattn] 结果：', JSON.stringify(summary.stage), `total ${r.wall}s internal ${r.internal}s`, outFile ? `→ ${outFile}` : '')
}

main().catch((e) => {
  console.error('[regen-solattn] 失败：', e.message)
  process.exitCode = 1
})
