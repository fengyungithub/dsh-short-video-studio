/**
 * 视频拼接（delivery 层的确定性操作，非模型能力）。
 *
 * 两条后端，按环境自动选择：
 *  1. ffmpeg（优先）—— concat demuxer + stream copy，零重编码、零显存、秒级；
 *     参数不一致导致 copy 失败时自动降级为重编码。
 *  2. ComfyUI（退化）—— 纯节点链路，不需要任何本地二进制：
 *       LoadVideo → GetVideoComponents → ImageBatch / AudioConcat 左折叠 →
 *       CreateVideo(images, fps, audio) → SaveVideo(mp4/h264)
 *     代价是整段素材要作为 IMAGE 张量进内存（N×帧数×W×H×3×4 字节）。
 *
 * 之所以不做成 workflow manifest：manifest 的 graph 是静态模板 + 定点注入，
 * 而拼接图的节点数与连线拓扑随片段数变化（变长左折叠），超出注入原语的表达能力。
 * 为一个确定性后处理扩展契约层不划算。
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 构造 ComfyUI 拼接图（纯函数，可测）。
 * @param {string[]} inputNames ComfyUI input 目录里的文件名（需先上传）
 * @param {string} filenamePrefix SaveVideo 的 filename_prefix
 */
export function buildConcatGraph(inputNames, filenamePrefix) {
  if (!Array.isArray(inputNames) || inputNames.length < 2) {
    throw new Error('concat-invalid: 至少需要 2 段片段')
  }
  const graph = {}
  const comps = []
  inputNames.forEach((file, i) => {
    graph[`load${i}`] = { class_type: 'LoadVideo', inputs: { file } }
    graph[`comp${i}`] = { class_type: 'GetVideoComponents', inputs: { video: [`load${i}`, 0] } }
    comps.push(`comp${i}`)
  })

  // 左折叠：images 走 ImageBatch，audio 走 AudioConcat；fps 取首段
  let images = [comps[0], 0]
  let audio = [comps[0], 1]
  for (let i = 1; i < comps.length; i++) {
    graph[`batch${i}`] = { class_type: 'ImageBatch', inputs: { image1: images, image2: [comps[i], 0] } }
    graph[`acat${i}`] = { class_type: 'AudioConcat', inputs: { audio1: audio, audio2: [comps[i], 1], direction: 'after' } }
    images = [`batch${i}`, 0]
    audio = [`acat${i}`, 0]
  }

  graph.create = { class_type: 'CreateVideo', inputs: { images, fps: [comps[0], 2], audio } }
  graph.save = {
    class_type: 'SaveVideo',
    inputs: { video: ['create', 0], filename_prefix: filenamePrefix, format: 'mp4', codec: 'h264' },
  }
  return graph
}

/** 跑一条命令，返回 {code, stderr}。参数走数组，不经 shell。 */
function run(bin, args) {
  return new Promise((resolve) => {
    let stderr = ''
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch {
      resolve({ code: -1, stderr: 'spawn failed' })
      return
    }
    child.stderr?.on('data', (c) => { stderr += String(c) })
    child.on('error', () => resolve({ code: -1, stderr: stderr || 'spawn error' }))
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

let _ffmpegProbe
/** 探测本机 ffmpeg，返回可执行名或 null。结果缓存（进程内）。 */
export async function detectFfmpeg() {
  if (_ffmpegProbe !== undefined) return _ffmpegProbe
  const { code } = await run('ffmpeg', ['-version'])
  _ffmpegProbe = code === 0 ? 'ffmpeg' : null
  return _ffmpegProbe
}

/** concat demuxer 的清单行：单引号包裹，内部单引号按 ffmpeg 规则转义。 */
function concatListLine(absPath) {
  return "file '" + absPath.replace(/'/g, "'\\''") + "'"
}

/**
 * 用 ffmpeg 拼接。先试 stream copy；copy 失败（各段编码参数不一致）再重编码。
 * @returns {Promise<{reencoded: boolean}>}
 */
export async function ffmpegConcat(absPaths, outAbsPath) {
  const bin = await detectFfmpeg()
  if (!bin) throw new Error('concat-no-ffmpeg: 本机无 ffmpeg')

  const dir = await mkdtemp(join(tmpdir(), 'dsh-svs-concat-'))
  const listFile = join(dir, 'list.txt')
  try {
    await writeFile(listFile, absPaths.map(concatListLine).join('\n') + '\n', 'utf8')
    const base = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile]

    const copy = await run(bin, [...base, '-c', 'copy', outAbsPath])
    if (copy.code === 0) return { reencoded: false }

    const enc = await run(bin, [
      ...base,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      outAbsPath,
    ])
    if (enc.code === 0) return { reencoded: true }

    throw new Error('concat-ffmpeg-failed: ' + (enc.stderr.split('\n').slice(-5).join(' ').trim() || copy.code))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
