/**
 * scripts/bench-latent-save-ab.mjs
 *
 * 对照实验：minimax-h3-ref2v-ctx-balanced-pika-solattn-solvae
 *   A 臂 = 图里带 OpenH3SaveRefinedLatent（node 24，当前 base 清单原样）
 *   B 臂 = 同图删掉 node 24（不存采样输出 latent）
 *
 * 唯一变量就是 node 24；prompt / seed / 尺寸 / length / 参考图 / 档位全同。
 * 用法：node scripts/bench-latent-save-ab.mjs [--runs 2] [--seed 20261107]
 * 结果写 e2e-out/latent-save-ab/result.json 并打印表。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _internals as I } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'e2e-out', 'latent-save-ab')

const args = process.argv.slice(2)
const arg = (n, d) => {
  const i = args.indexOf('--' + n)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const RUNS = Number(arg('runs', '2'))
const SEED = Number(arg('seed', '20261107'))
const SESSION = arg('session', 'session-41eced70-fa41-4d76-8440-ddd7591d297d')
const CLIP_ID = arg('clip', '2032ec28-f5d8-48ee-b191-c18123995ab1')
const WF = arg('wf', 'minimax-h3-ref2v-ctx-balanced-pika-solattn-solvae')

const proj = JSON.parse(await readFile(join(ROOT, 'canvas', SESSION, 'project.json'), 'utf8'))
const clip = proj.nodes.find((n) => n.id === CLIP_ID)
if (!clip) throw new Error(`画布上没有 ${CLIP_ID}`)
const prompt = String(clip.params?.prompt || '')
if (!prompt) throw new Error('该片段没记录 prompt')
const refIds = (clip.params?.ref_nodes || []).map((r) => String(r).replace(/^canvas:/, ''))
const refPaths = refIds.map((id) => {
  const n = proj.nodes.find((x) => x.id === id)
  if (!n?.media) throw new Error(`参考节点 ${id} 没有媒体`)
  return join(ROOT, ...String(n.media).split('/'))
})

const baseUrl = (I.getCfg && I.getCfg().baseUrl) || 'http://127.0.0.1:8188'
const reg = I.getRegistry()
const man = reg.byId[WF]
if (!man) throw new Error(`清单 ${WF} 不在注册表`)

await mkdir(OUT, { recursive: true })

const upload = async (p) => {
  const up = await I.comfyUploadImage(await readFile(p), basename(p))
  return up.subfolder ? up.subfolder + '/' + up.name : up.name
}
const refNames = []
for (const p of refPaths) refNames.push(await upload(p))

const seedFor = (tag) => {
  // 每次唯一 seed：否则 ComfyUI 的节点级缓存会让采样直接命中（实测 4s 假快）
  let h = 0
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return (SEED + (h % 100000)) >>> 0
}

const buildGraph = (arm, tag) => {
  const g = I.buildGraphFromManifest(man, {
    mode: 'balanced',
    assetOverrides: {},
    prompt,
    width: 1344,
    height: 768,
    length: 124,
    fps: 24,
    seed: seedFor(tag),
    refs: refNames,
    prefix: `bench/latent_ab_${tag}`,
    context_clip_index: 0,
    save_clip_index: 8000,
    latent_prefix: `bench_handoff_${tag}`,
    latent_frame_count: 124,
  })
  if (arm === 'B') delete g['24']
  return g
}

const execMs = (hist) => {
  const msgs = hist?.status?.messages || []
  const t = (name) => {
    const m = msgs.find((m) => m && m[0] === name)
    return m && m[1] && typeof m[1].timestamp === 'number' ? m[1].timestamp : null
  }
  const a = t('execution_start')
  const b = t('execution_success')
  return a && b ? b - a : null
}

const queueIdle = async () => {
  for (let i = 0; i < 600; i++) {
    const q = await (await fetch(`${(I.getCfg?.().baseUrl) || 'http://127.0.0.1:8188'}/queue`)).json()
    if (!q.queue_running?.length && !q.queue_pending?.length) return
    await new Promise((r) => setTimeout(r, 2000))
  }
}

const runOnce = async (arm, tag) => {
  await queueIdle()
  const g = buildGraph(arm, tag)
  const nodes = Object.keys(g).length
  const t0 = Date.now()
  const res = await I.comfySubmit(g)
  const id = typeof res === 'string' ? res : res.prompt_id
  const hist = await I.comfyWait(id)
  const wall = (Date.now() - t0) / 1000
  const outs = I.comfyOutputs(hist) || []
  const mp4 = outs.find((o) => /\.mp4$/.test(o.filename))
  const node24 = hist?.outputs?.['24']
  const latentPath = Array.isArray(node24?.text) ? String(node24.text[0] || '') : null
  const latentName = latentPath ? latentPath.replace(/^saved\s+/, '').split('/').pop() : null
  const cached = (hist?.status?.messages || []).find((m) => m && m[0] === 'execution_cached')
  const cachedNodes = Array.isArray(cached?.[1]?.nodes) ? cached[1].nodes : []
  let latentBytes = null
  if (latentName) {
    try {
      const u = `${baseUrl}/view?filename=${encodeURIComponent(latentName)}&subfolder=${encodeURIComponent('open_h3_latents')}&type=output`
      const r = await fetch(u, { method: 'HEAD' })
      const n = Number(r.headers.get('content-length') || 0)
      if (n) latentBytes = n
    } catch {}
  }
  const exec = execMs(hist)
  return {
    arm,
    tag,
    nodes,
    seed: seedFor(tag),
    wallSecs: +wall.toFixed(2),
    execSecs: exec === null ? null : +(exec / 1000).toFixed(2),
    samplerRan: !cachedNodes.includes('10'),
    mp4: mp4 ? mp4.filename : null,
    latent: latentName,
    latentMB: latentBytes === null ? null : +(latentBytes / 1048576).toFixed(1),
    promptId: id,
  }
}

const stamp = Date.now()
const runs = []
let warm = null
if (!args.includes('--no-warmup')) {
  warm = await runOnce('A', `warmup_${stamp}`)
  console.log('warmup:', JSON.stringify(warm))
}

for (let i = 1; i <= RUNS; i++) {
  for (const arm of ['A', 'B']) {
    const r = await runOnce(arm, `${arm}${i}_${stamp}`)
    runs.push(r)
    console.log(`run ${arm}${i}:`, JSON.stringify(r))
  }
}

const stat = (arr) => {
  const xs = arr.map((r) => r.wallSecs).sort((a, b) => a - b)
  const es = arr.map((r) => r.execSecs).filter((x) => x !== null).sort((a, b) => a - b)
  const mean = (v) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null)
  return {
    n: arr.length,
    wall: { min: xs[0], max: xs[xs.length - 1], mean: +mean(xs).toFixed(2) },
    exec: es.length ? { min: es[0], max: es[es.length - 1], mean: +mean(es).toFixed(2) } : null,
  }
}

const A = runs.filter((r) => r.arm === 'A')
const B = runs.filter((r) => r.arm === 'B')
const result = {
  startedAt: new Date().toISOString(),
  workflow: WF,
  clip: CLIP_ID,
  seed: SEED,
  promptChars: prompt.length,
  refs: refIds,
  warmup: warm,
  runs,
  summary: {
    A_withSave: stat(A),
    B_withoutSave: stat(B),
    deltaWallSecs: +(stat(A).wall.mean - stat(B).wall.mean).toFixed(2),
    deltaExecSecs: stat(A).exec && stat(B).exec ? +(stat(A).exec.mean - stat(B).exec.mean).toFixed(2) : null,
    ratioWall: +(stat(A).wall.mean / stat(B).wall.mean).toFixed(3),
  },
}
await writeFile(join(OUT, 'result.json'), JSON.stringify(result, null, 2))
console.log('\n=== SUMMARY ===')
console.log(JSON.stringify(result.summary, null, 2))
