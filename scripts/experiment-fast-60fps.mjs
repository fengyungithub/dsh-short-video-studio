/**
 * 实测：fast 档「60fps」视频的生成时间
 *
 * 背景（docs/fps-interpolation.md）：H3 没有生成侧 fps 旋钮，CreateVideo.fps 只是容器标签。
 * 所以测「60fps 的生成时间」实际测的是：为 5s@60fps 交付需要采多少帧、这些帧要跑多久。
 *
 * 本脚本走 i2v fast 清单（非链式，maxDurationFrames=310），两组对照：
 *   A. 124 帧 @ 24fps —— 现有 5s 镜的基线
 *   B. 300 帧 @ 60fps —— 5s@60fps 的帧数（注意：这仍是 24fps 的时域采样，
 *      按 60fps 播只会变 2.5× 快；真 60fps 观感要靠补帧，见文档）
 *
 * 用法：node scripts/experiment-fast-60fps.mjs [--force]
 *   --force  队列非空时也直接跑（默认会等队列空，避免计时被别的渲染污染）
 */
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { _internals } from '../lib/index.js'
import { probeMp4 } from '../lib/upscale.js'

const {
  buildRenderGraph, comfyUploadImage, comfySubmit, comfyWait, comfyOutputs, comfyDownload,
  getRegistry, resolveManifest,
} = _internals

const FORCE = process.argv.includes('--force')
const OUT_DIR = 'e2e-out/fps-test'
mkdirSync(OUT_DIR, { recursive: true })

const BASE = process.env.DSH_SVS_BASE || 'http://localhost:8188'

async function queueState() {
  const res = await fetch(BASE + '/queue')
  const d = await res.json()
  return { running: (d.queue_running || []).length, pending: (d.queue_pending || []).length }
}

async function waitIdle(timeoutMs = 15 * 60 * 1000) {
  const t0 = Date.now()
  for (;;) {
    const q = await queueState()
    if (q.running === 0 && q.pending === 0) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`队列 ${timeoutMs / 1000}s 内未清空（running=${q.running} pending=${q.pending}）`)
    process.stdout.write(`\r  等待队列清空… running=${q.running} pending=${q.pending}   `)
    await new Promise((r) => setTimeout(r, 5000))
  }
}

function pickFirstFrame() {
  const dirs = readdirSync('canvas', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join('canvas', e.name))
  for (const d of dirs) {
    for (const f of readdirSync(d)) {
      if (/\.(png|jpe?g|webp)$/i.test(f) && !/\.txt$/.test(f)) {
        const p = join(d, f)
        if (existsSync(p)) return p
      }
    }
  }
  throw new Error('canvas/ 下找不到可用首帧图')
}

const framePath = pickFirstFrame()
console.log('首帧:', framePath)
const up = await comfyUploadImage(await (await import('node:fs/promises')).readFile(framePath), 'fps-test-first-frame.png')
console.log('已上传 ComfyUI:', up.name)

const base = resolveManifest(getRegistry(), 'video.image2video', 'minimax-h3-i2v-fast')
console.log('清单:', base.id, '| mode:', Object.keys(base.modes || {}), '| 长边:', base.modes?.fast?.longSide, '| 步数:', base.modes?.fast?.steps)

const cases = [
  { name: 'fast-124f-24fps', fps: 24, length: 124, secondsExpected: 124 / 24 },
  { name: 'fast-300f-60fps', fps: 60, length: 300, secondsExpected: 300 / 60 },
]

const rows = []
for (const c of cases) {
  if (!FORCE) await waitIdle()
  const manifest = {
    ...base,
    params: { ...base.params, fps: { ...(base.params.fps || {}), default: c.fps } },
  }
  const prompt = '镜头缓慢推近，人物保持静止，光线稳定，无对白，无字幕。'
  const { graph, job } = buildRenderGraph(manifest, {
    prompt,
    first_frame: up.name,
    length: c.length,
    // 每次换 seed：ComfyUI 按图哈希缓存，同 seed 会直接命中缓存（实测第二次 2.3s，不可用于计时）
    seed: Number(process.env.SEED) || Math.floor(Math.random() * 2 ** 31),
    prefix: `fps-test/${c.name}`,
    mode: 'fast',
  }, '9:16')
  console.log(`\n[${c.name}] image ${job.width}×${job.height} · length=${job.length} · fps=${job.fps} · steps=${job.steps}`)

  const t0 = Date.now()
  const promptId = await comfySubmit(graph)
  const entry = await comfyWait(promptId)
  const tDone = Date.now()
  const outputs = comfyOutputs(entry)
  if (!outputs.length) throw new Error('无输出')
  const buf = await comfyDownload(outputs[0])
  const tDl = Date.now()
  const file = join(OUT_DIR, `${c.name}.mp4`)
  writeFileSync(file, buf)
  const info = probeMp4(file)
  const genSec = (tDone - t0) / 1000
  const totalSec = (tDl - t0) / 1000
  rows.push({ ...c, genSec, totalSec, file, info, bytes: buf.length })
  console.log(`  提交→完成 ${genSec.toFixed(1)}s（含排队）；下载完成 ${totalSec.toFixed(1)}s；产物 ${info?.w}×${info?.h} ${info?.frames}f ${info?.duration}s → ${file}`)
}

console.log('\n=== 汇总 ===')
for (const r of rows) {
  const fpsReal = r.info ? (r.info.frames / r.info.duration).toFixed(2) : '?'
  console.log(`${r.name}: 生成 ${r.genSec.toFixed(1)}s · 总 ${r.totalSec.toFixed(1)}s · ${r.info?.frames}f/${r.info?.duration}s · 容器 fps≈${fpsReal} · ${(r.bytes / 1024 / 1024).toFixed(1)}MB`)
}
const a = rows[0], b = rows[1]
if (a && b) {
  console.log(`每帧耗时：${(a.genSec / a.length).toFixed(3)}s/f (A) vs ${(b.genSec / b.length).toFixed(3)}s/f (B)`)
  console.log(`帧数比 ${b.length}/${a.length} = ${(b.length / a.length).toFixed(2)}×，耗时比 ${(b.genSec / a.genSec).toFixed(2)}×`)
}
