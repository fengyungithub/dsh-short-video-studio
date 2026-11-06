/**
 * 实测：48fps 补帧（ComfyUI 原生 FrameInterpolate + RIFE）
 *
 * 链路：LoadVideo → GetVideoComponents → FrameInterpolate(multiplier) → CreateVideo(fps=24×m, audio) → SaveVideo
 * 注意：模型输出帧数 = (N−1)×m + 1（保留首尾真帧），所以每镜会比源短 1/(m·f) 秒；
 *      音频由 CreateVideo 直通，会被画面时长裁剪（≈ 1/(m·f)）。
 *
 * 用法：node scripts/experiment-48fps.mjs [源视频] [multiplier]
 *   缺省：e2e-out/fps-test/fast-124f-24fps.mp4 × 2（= 48fps）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { _internals } from '../lib/index.js'
import { probeMp4 } from '../lib/upscale.js'

const { comfyUploadImage, comfySubmit, comfyWait, comfyOutputs, comfyDownload } = _internals

const src = process.argv[2] || 'e2e-out/fps-test/fast-124f-24fps.mp4'
const multiplier = Number(process.argv[3] || 2)
if (!existsSync(src)) throw new Error('源文件不存在: ' + src)
if (!Number.isInteger(multiplier) || multiplier < 2 || multiplier > 16) throw new Error('multiplier 必须是 2–16 的整数')

const outFps = 24 * multiplier
const label = `${outFps}fps-${basename(src, '.mp4')}-x${multiplier}`
const OUT_DIR = 'e2e-out/fps-test'
mkdirSync(OUT_DIR, { recursive: true })

// 队列非空时先等空（否则计时里混进排队时间；实测被生产任务挤到 69.5s vs 空队列 10.5s）
async function waitIdle(timeoutMs = 15 * 60 * 1000) {
  const t0 = Date.now()
  for (;;) {
    const d = await (await fetch('http://localhost:8188/queue')).json()
    const busy = (d.queue_running || []).length + (d.queue_pending || []).length
    if (!busy) return
    if (Date.now() - t0 > timeoutMs) throw new Error('队列未清空')
    process.stdout.write(`\r  等待队列清空… ${busy} 个任务   `)
    await new Promise((r) => setTimeout(r, 5000))
  }
}
if (!process.argv.includes('--force')) await waitIdle()

const srcInfo = probeMp4(src)
console.log(`源：${src} → ${srcInfo.w}×${srcInfo.h} ${srcInfo.frames}f ${srcInfo.duration}s audio=${srcInfo.hasAudio}`)
console.log(`目标：×${multiplier} → ${outFps}fps，预期帧数 (${srcInfo.frames}−1)×${multiplier}+1 = ${(srcInfo.frames - 1) * multiplier + 1}`)

const up = await comfyUploadImage(readFileSync(src), `fps48-src-${basename(src)}`)
console.log('已上传 ComfyUI:', up.name)

const graph = {
  1: { class_type: 'LoadVideo', inputs: { file: up.name } },
  2: { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
  3: { class_type: 'FrameInterpolationModelLoader', inputs: { model_name: 'rife_v4.25.safetensors' } },
  4: { class_type: 'FrameInterpolate', inputs: { interp_model: ['3', 0], images: ['2', 0], multiplier } },
  5: {
    class_type: 'CreateVideo',
    inputs: {
      images: ['4', 0], fps: outFps,
      ...(srcInfo.hasAudio ? { audio: ['2', 1] } : {}),
    },
  },
  6: { class_type: 'SaveVideo', inputs: { video: ['5', 0], filename_prefix: `fps-test/${label}`, format: 'mp4' } },
}

const t0 = Date.now()
const promptId = await comfySubmit(graph)
const entry = await comfyWait(promptId)
const tDone = Date.now()
const outputs = comfyOutputs(entry)
if (!outputs.length) throw new Error('无输出')
const buf = await comfyDownload(outputs[0])
const tDl = Date.now()
const file = join(OUT_DIR, `${label}.mp4`)
writeFileSync(file, buf)
const info = probeMp4(file)

const expectedFrames = (srcInfo.frames - 1) * multiplier + 1
const expectedSec = expectedFrames / outFps
console.log(`\n提交→完成 ${((tDone - t0) / 1000).toFixed(1)}s（含排队）；下载完成 ${((tDl - t0) / 1000).toFixed(1)}s`)
console.log(`产物：${info.w}×${info.h} ${info.frames}f ${info.duration}s · 容器 fps≈${(info.frames / info.duration).toFixed(2)} · ${(buf.length / 1024 / 1024).toFixed(1)}MB → ${file}`)
console.log(`帧数 ${info.frames}（预期 ${expectedFrames}，${info.frames === expectedFrames ? '一致' : '不一致'}）`)
console.log(`时长 ${info.duration}s（预期 ${expectedSec.toFixed(3)}s；源 ${srcInfo.duration}s，差 ${(info.duration - srcInfo.duration).toFixed(3)}s）`)
console.log(`音频：源 ${srcInfo.hasAudio ? '有' : '无'} → 产物 ${info.hasAudio ? '有' : '无'}`)
