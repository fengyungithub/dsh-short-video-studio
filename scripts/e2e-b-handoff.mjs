/**
 * scripts/e2e-b-handoff.mjs — B 方案（latent 交接）与 C 方案（视频交接）的**真机 A/B**。
 *
 * 目的：同一份草稿、同 prompt、同 refine seed，只换「交接物」，量出：
 *   · 时间差（B 省掉 mp4 上传 + 解码 + VAE 重编码）
 *   · 画质差（两份 2K 产物的 PSNR/SSIM、1:1 裁切对照）
 *   · 交接噪声（可选：把两臂「放大后的 latent」都存下来做数值比较，见文档 §10 的补测）
 *
 * 用到的清单（都是内置、`internal: true` 的实验清单）：
 *   1) minimax-h3-ref2v-ctx-balanced-pika-solattn-solvae-latent   草稿 + 存 latent（基于 pika ctx solattn solvae）
 *   2) open-h3-regenerate-2k-latent                               质量档重生成，入口是 latent
 *   3) open-h3-regenerate-2k                                      现有 C 方案，入口是视频
 *
 * 用法（默认取 canvas/session-4a03… 的宝钗镜；可换参数）：
 *   node scripts/e2e-b-handoff.mjs
 *   node scripts/e2e-b-handoff.mjs --session <sessionId> --refs ab-ref-a,ab-ref-b --clip 51881ad7 --target 2k
 *
 * 产物写到 e2e-out/b-handoff/（mp4 + result.json），不参与 npm run smoke。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _internals as I } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'e2e-out', 'b-handoff')

const args = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const SESSION = arg('session', 'session-4a030c9a-9e9b-4795-aa2e-0ae20099d4b2')
const REFS = arg('refs', 'ab-ref-baochai,ab-ref-scene,ab-ref-fan').split(',').filter(Boolean)
const CLIP_MATCH = arg('clip', '51881ad7')
const TARGET = arg('target', '2k')
const SEED = Number(arg('seed', '42'))

const TARGETS = { '1080p': { graph: [1920, 1088] }, '2k': { graph: [2560, 1440] } }
const target = TARGETS[TARGET]
if (!target) throw new Error(`未知 target "${TARGET}"（可选 ${Object.keys(TARGETS).join(' / ')}）`)

const projPath = join(ROOT, 'canvas', SESSION, 'project.json')
const proj = JSON.parse(await readFile(projPath, 'utf8'))
const refs = REFS.map((id) => {
  const n = proj.nodes.find((x) => x.id === id)
  if (!n || !n.media) throw new Error(`画布上没有参考图节点 ${id}`)
  return join(ROOT, ...String(n.media).split('/'))
})
const clip = proj.nodes.find((x) => String(x.media || '').includes(CLIP_MATCH))
if (!clip) throw new Error(`画布里找不到含 "${CLIP_MATCH}" 的片段节点`)
const prompt = String(clip.params?.prompt || '')
if (!prompt) throw new Error('源片段没有记录 prompt（换个镜头或用 --clip 指一个生成节点）')
await mkdir(OUT, { recursive: true })

const reg = I.getRegistry()
const s1 = reg.byId['minimax-h3-ref2v-ctx-balanced-pika-solattn-solvae-latent']
const s2 = reg.byId['open-h3-regenerate-2k-latent']
const cMan = reg.byId['open-h3-regenerate-2k']
if (!s1 || !s2 || !cMan) throw new Error('实验清单缺失（先确认 workflows/ 里三份清单都在）')

const upload = async (p) => {
  const up = await I.comfyUploadImage(await readFile(p), basename(p))
  return up.subfolder ? up.subfolder + '/' + up.name : up.name
}

const stamp = Date.now()
const result = { startedAt: new Date().toISOString(), session: SESSION, target: TARGET, refs: REFS, stamp }

// ---- 1) 草稿：pika ctx + solattn + solvae，同时存 latent 与 mp4 ----
const refNames = []
for (const p of refs) refNames.push(await upload(p))
const latentPrefix = `b_handoff_${stamp}`
const t1 = Date.now()
const g1 = I.buildGraphFromManifest(s1, {
  mode: 'balanced', assetOverrides: {},
  prompt,
  width: 1344, height: 768, length: 124, fps: 24, seed: 424242,
  refs: refNames,
  prefix: `e2e/b_stage1_${stamp}`,
  context_clip_index: 0,
  save_clip_index: 9100 + (stamp % 800),
  latent_prefix: latentPrefix,
  latent_frame_count: 124,
})
const e1 = await I.comfyWait(await I.comfySubmit(g1))
result.stage1 = { secs: +((Date.now() - t1) / 1000).toFixed(1) }
const outs1 = I.comfyOutputs(e1)
const mp4 = outs1.find((o) => /\.mp4$/.test(o.filename))
if (!mp4) throw new Error('草稿没有产出 mp4')
const stage1Path = join(OUT, `draft_${stamp}.mp4`)
await writeFile(stage1Path, await I.comfyDownload(mp4))
const latentFile = (JSON.stringify(e1).match(/([A-Za-z0-9._-]+\.safetensors)/g) || [])
  .find((x) => x.startsWith(latentPrefix)) || null
result.stage1.mp4 = mp4.filename
result.stage1.latentFile = latentFile
if (!latentFile) throw new Error('没从 history 里读到 SaveRefinedLatent 写出的文件名（检查节点包版本）')

// ---- 2) 臂 B：latent 交接 ----
const t2 = Date.now()
const g2 = I.buildGraphFromManifest(s2, {
  mode: null, assetOverrides: {},
  latent_file: latentFile,
  prompt,
  width: target.graph[0], height: target.graph[1], seed: SEED,
  steps: 3, start_sigma: 0,
  prefix: `e2e/b_latent_${TARGET}_${stamp}`,
})
const e2 = await I.comfyWait(await I.comfySubmit(g2))
const outB = I.comfyOutputs(e2).find((o) => /\.mp4$/.test(o.filename))
if (!outB) throw new Error('臂 B 没有产出 mp4')
const bPath = join(OUT, `regen_latent_${TARGET}_${stamp}.mp4`)
await writeFile(bPath, await I.comfyDownload(outB))
result.armB = { secs: +((Date.now() - t2) / 1000).toFixed(1), mp4: outB.filename }

// ---- 3) 臂 C：视频交接（上传草稿 mp4 → LoadVideo → PrepareDraft → VAEEncode）----
const t3 = Date.now()
const upMp4 = await upload(stage1Path)
const g3 = I.buildGraphFromManifest(cMan, {
  mode: null, assetOverrides: {},
  source_video: upMp4,
  prompt,
  width: target.graph[0], height: target.graph[1], seed: SEED,
  audio_mode: 'draft audio (AUDIO input)',
  steps: 3, start_sigma: 0,
  prefix: `e2e/b_video_${TARGET}_${stamp}`,
})
const e3 = await I.comfyWait(await I.comfySubmit(g3))
const outC = I.comfyOutputs(e3).find((o) => /\.mp4$/.test(o.filename))
if (!outC) throw new Error('臂 C 没有产出 mp4')
const cPath = join(OUT, `regen_video_${TARGET}_${stamp}.mp4`)
await writeFile(cPath, await I.comfyDownload(outC))
result.armC = { secs: +((Date.now() - t3) / 1000).toFixed(1), mp4: outC.filename }

result.files = { draft: stage1Path, armB: bPath, armC: cPath }
result.deltaSecs = +(result.armC.secs - result.armB.secs).toFixed(1)
await writeFile(join(OUT, 'result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
console.log('\n下一步（文档 §10 的补测）：两臂各跑一次「只放大不精修」并存 latent，用 numpy 比相对 L2 —— 这是交接噪声本身。')
