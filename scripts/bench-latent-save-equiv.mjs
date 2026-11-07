/**
 * scripts/bench-latent-save-equiv.mjs
 * 等价性验证：同 seed、同输入，A（带 node 24）vs B（删 node 24），两次之间清 ComfyUI 执行缓存。
 * 产出两段 mp4 → sha256；不同则用 ffmpeg 算 PSNR。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _internals as I } from '../lib/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'e2e-out', 'latent-save-ab')
const SESSION = 'session-41eced70-fa41-4d76-8440-ddd7591d297d'
const CLIP_ID = '2032ec28-f5d8-48ee-b191-c18123995ab1'
const WF = 'minimax-h3-ref2v-ctx-balanced-pika-solattn-solvae'
const SEED = 777001
const baseUrl = (I.getCfg && I.getCfg().baseUrl) || 'http://127.0.0.1:8188'

const proj = JSON.parse(await readFile(join(ROOT, 'canvas', SESSION, 'project.json'), 'utf8'))
const clip = proj.nodes.find((n) => n.id === CLIP_ID)
const prompt = String(clip.params.prompt)
const refIds = (clip.params.ref_nodes || []).map((r) => String(r).replace(/^canvas:/, ''))
const refPaths = refIds.map((id) => {
  const n = proj.nodes.find((x) => x.id === id)
  return join(ROOT, ...String(n.media).split('/'))
})

const reg = I.getRegistry()
const man = reg.byId[WF]
await mkdir(OUT, { recursive: true })

const upload = async (p) => {
  const up = await I.comfyUploadImage(await readFile(p), basename(p))
  return up.subfolder ? up.subfolder + '/' + up.name : up.name
}
const refNames = []
for (const p of refPaths) refNames.push(await upload(p))

const build = (arm, tag) => {
  const g = I.buildGraphFromManifest(man, {
    mode: 'balanced', assetOverrides: {}, prompt,
    width: 1344, height: 768, length: 124, fps: 24, seed: SEED,
    refs: refNames, prefix: `bench/equiv_${tag}`,
    context_clip_index: 0, save_clip_index: 8100,
    latent_prefix: `equiv_${tag}`, latent_frame_count: 124,
  })
  if (arm === 'B') delete g['24']
  return g
}

const clearCache = async () => {
  const r = await fetch(`${baseUrl}/free`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unload_models: false, free_memory: true }),
  })
  return r.status
}

const run = async (arm, tag) => {
  const g = build(arm, tag)
  const res = await I.comfySubmit(g)
  const id = typeof res === 'string' ? res : res.prompt_id
  const t0 = Date.now()
  const hist = await I.comfyWait(id)
  const secs = +((Date.now() - t0) / 1000).toFixed(2)
  const outs = I.comfyOutputs(hist) || []
  const mp4 = outs.find((o) => /\.mp4$/.test(o.filename))
  const buf = await I.comfyDownload(mp4)
  const p = join(OUT, `equiv_${arm}_${tag}.mp4`)
  await writeFile(p, buf)
  const cached = (hist?.status?.messages || []).find((m) => m && m[0] === 'execution_cached')
  return { arm, secs, file: p, bytes: buf.length, samplerRan: !(cached?.[1]?.nodes || []).includes('10') }
}

const a = await run('A', `A_${Date.now()}`)
console.log('A:', JSON.stringify(a))
await clearCache()
await new Promise((r) => setTimeout(r, 1500))
const b = await run('B', `B_${Date.now()}`)
console.log('B:', JSON.stringify(b))

const { createHash } = await import('node:crypto')
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const ha = sha(await readFile(a.file))
const hb = sha(await readFile(b.file))
console.log(JSON.stringify({ identical: ha === hb, shaA: ha.slice(0, 16), shaB: hb.slice(0, 16), bytesA: a.bytes, bytesB: b.bytes }, null, 2))
await writeFile(join(OUT, 'equiv.json'), JSON.stringify({ seed: SEED, a, b, identical: ha === hb, shaA: ha, shaB: hb }, null, 2))
