/**
 * scripts/probe-4k.mjs — U3 探针：在**已交付的 2K 成片**上做像素空间超分（U1 → 4K）。
 *
 * U3 与 U1/U2 的本质差别：
 *   U1 = 在 H3 的 latent 空间重建（模型懂运动，时间一致）
 *   U3 = 在**像素空间**逐帧超分（RealESRGAN 等）——**逐帧独立 ⇒ 没有时间先验**
 * 所以 U3 的成败不是"能不能放大"（必然能），而是：
 *   ① 有效分辨率真涨了吗（不是换个尺寸的插值）？
 *   ② 逐帧合成会不会引入**时间闪烁**（U2/U3 的已知风险）？
 * 本探针只负责出片；判据用 analyze-hires.mjs / analyze-2k-detail.mjs 量。
 *
 * 图（只做像素空间，不碰 H3）：
 *   LoadVideo(file=上传的2K成片)
 *     → GetVideoComponents ─┬─ images → [ImageFromBatch 截前 N 帧] → ImageUpscaleWithModel(超分件)
 *                           │            → [ImageScaleBy 可选回缩到 4K]
 *                           └─ audio ────────────────────────────────┐（原声原样带走）
 *                           └─ fps ─────────────────────────────────┐│
 *                                          CreateVideo(images,fps,audio) → SaveVideo
 *
 * 用法：
 *   node scripts/probe-4k.mjs --src e2e-out/2k/v2s20f124-v2s20f124_00001_.mp4 --frames 12 --tag u3-trial
 *   --model RealESRGAN_x2.pth | RealESRGAN_x4.pth | ESRGAN_4x.pth
 *   --frames N   只处理前 N 帧（显存安全阀；不传=整片）
 *   --scale S    超分后再按 S 回缩（如 0.75：5376×3072 → 4032×2304）
 *   --method M   回缩的重采样方式（默认 area；lanczos 更锐但慢一个量级）
 *   --dry        只打印图
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, basename } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const BASE = process.env.DSH_SVS_COMFY ?? 'http://localhost:8188'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const has = (k) => argv.includes('--' + k)
const num = (k, d) => { const v = arg(k); return v === undefined ? d : Number(v) }

const SRC = resolve(ROOT, arg('src', 'e2e-out/2k/v2s20f56-v2s20f56_00001_.mp4'))
const MODEL = arg('model', 'RealESRGAN_x2.pth')
const FRAMES = num('frames', undefined)
const SCALE = num('scale', undefined)
const TAG = arg('tag', 'u3')
const DRY = has('dry')

if (!existsSync(SRC)) { console.error(`找不到源片 ${SRC}`); process.exit(1) }

// 1) 把源片传到 ComfyUI 的 input/（LoadVideo 只认它自己的 input 目录）
const buf = readFileSync(SRC)
const fd = new FormData()
fd.append('image', new Blob([buf], { type: 'video/mp4' }), basename(SRC))
fd.append('type', 'input')
fd.append('subfolder', 'dsh-4k')
fd.append('overwrite', 'true')
const up = await fetch(BASE + '/upload/image', { method: 'POST', body: fd })
if (!up.ok) { console.error(`上传失败 ${up.status} ${(await up.text()).slice(0, 300)}`); process.exit(1) }
const uploaded = await up.json()
// LoadVideo 的 file 取 "subfolder/name" 形式（subfolder 为空则就是 name）
const FILE = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name
console.log(`源片 ${basename(SRC)}（${(buf.length / 2 ** 20).toFixed(1)} MiB）→ ComfyUI input: ${FILE}`)

// 2) 组图
const g = {
  1: { class_type: 'LoadVideo', inputs: { file: FILE } },
  2: { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
  3: { class_type: 'UpscaleModelLoader', inputs: { model_name: MODEL } },
}
let img = ['2', 0]
if (FRAMES !== undefined) {
  g[4] = { class_type: 'ImageFromBatch', inputs: { image: ['2', 0], batch_index: 0, length: FRAMES } }
  img = ['4', 0]
  console.log(`  ⚙ 只处理前 ${FRAMES} 帧（显存安全阀）`)
}
g[5] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['3', 0], image: img } }
let out = ['5', 0]
if (SCALE !== undefined) {
  // 默认 area：lanczos 在 ComfyUI 里走的是很贵的重采样路径（124 帧 5.4K 上实测多花 ~4 分钟），
  // 而缩小时 area（平均池化）更快且不产生振铃。需要 lanczos 时用 --method 覆盖。
  g[6] = { class_type: 'ImageScaleBy', inputs: { image: ['5', 0], upscale_method: arg('method', 'area'), scale_by: SCALE } }
  out = ['6', 0]
  console.log(`  ⚙ 超分后按 ×${SCALE} 回缩（${arg('method', 'area')}）`)
}
// --no-audio：源片没有音轨时（长片压测用的合成片）不接 audio，否则 CreateVideo 拿空 AUDIO 会失败
const NO_AUDIO = has('no-audio')
g[7] = { class_type: 'CreateVideo', inputs: NO_AUDIO ? { images: out, fps: ['2', 2] } : { images: out, fps: ['2', 2], audio: ['2', 1] } }
g[8] = { class_type: 'SaveVideo', inputs: { video: ['7', 0], filename_prefix: `e2e-4k/${TAG}`, format: 'mp4', codec: 'h264' } }

if (DRY) { console.log(JSON.stringify(g, null, 2)); process.exit(0) }

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${p} → ${r.status} ${(await r.text()).slice(0, 500)}`)
  return r.json()
}

console.log(`ComfyUI ${BASE} · U3 像素空间超分 · ${MODEL}${FRAMES !== undefined ? ` · 前 ${FRAMES} 帧` : ' · 整片'}`)
const t0 = Date.now()
try {
  const { prompt_id } = await post('/prompt', { prompt: g, client_id: 'probe-4k' })
  console.log(`  ▸ 已提交 prompt_id=${prompt_id.slice(0, 8)}`)
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000))
    const h = await (await fetch(`${BASE}/history/${prompt_id}`)).json()
    const e = h[prompt_id]
    if (!e) continue
    const st = e.status?.status_str
    if (st === 'error') {
      const msgs = (e.status?.messages || []).filter((x) => x[0] === 'execution_error').map((x) => JSON.stringify(x[1]).slice(0, 600))
      throw new Error(`执行失败：${msgs.join(' | ')}`)
    }
    const secs = (Date.now() - t0) / 1000
    const files = Object.values(e.outputs || {}).flatMap((o) => o.videos || o.images || [])
    console.log(`  ✓ 完成：${secs.toFixed(1)}s，产物 ${JSON.stringify(files.map((f) => f.filename))}`)
    mkdirSync(resolve(ROOT, 'e2e-out/4k'), { recursive: true })
    for (const f of files) {
      const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? 'e2e-4k', type: f.type ?? 'output' })
      const b = Buffer.from(await (await fetch(`${BASE}/view?${q}`)).arrayBuffer())
      const o = resolve(ROOT, `e2e-out/4k/${TAG}-${f.filename.replace(/^.*\//, '')}`)
      writeFileSync(o, b)
      console.log(`    已存 ${o}（${(b.length / 2 ** 20).toFixed(1)} MiB）`)
    }
    break
  }
} catch (e) {
  console.error('✗ ' + e.message)
  process.exit(1)
}
