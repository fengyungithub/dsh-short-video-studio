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
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

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

let _ffmpegProbe = null

/** 可执行文件存在且真的能跑（-version 退出码 0）。 */
async function isRunnableFfmpeg(bin) {
  try {
    const { code } = await run(bin, ['-version'])
    return code === 0
  } catch {
    return false
  }
}

/** 从某个目录逐级向上找常见落点：tools/ffmpeg/ffmpeg、tools/ffmpeg、bin/ffmpeg、ffmpeg。 */
function ffmpegCandidatesUpward(root, levels = 5) {
  const out = []
  let dir = root ? resolve(root) : ''
  for (let i = 0; i < levels && dir; i++) {
    out.push(join(dir, 'tools', 'ffmpeg', 'ffmpeg'))
    out.push(join(dir, 'tools', 'ffmpeg'))
    out.push(join(dir, 'bin', 'ffmpeg'))
    out.push(join(dir, 'ffmpeg'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out
}

/**
 * 探测本机 ffmpeg，返回可执行路径或 null。结果按候选集合缓存（进程内）。
 *
 * 解析顺序：env `DSH_SVS_FFMPEG` > 配置 `ffmpegPath`（extraPaths）> PATH 里的 `ffmpeg`
 * > 从 roots（工作区根、插件包根、进程 cwd）逐级向上找 `tools/ffmpeg[/ffmpeg]` 等常见落点。
 * PATH 排在向上搜索之前：ffmpeg 全局安装后（如 /usr/local/bin/ffmpeg）就用全局那份，仓库上层
 * 目录里的 `tools/ffmpeg` 只是「没进 PATH 时」的兜底；要钉住某个版本用 `ffmpegPath` 或
 * `DSH_SVS_FFMPEG`。⇒ 断言「向上搜索」的测试必须隔离 PATH，否则全局 ffmpeg 会先命中。
 */
export async function detectFfmpeg({ roots = [], extraPaths = [], force = false } = {}) {
  const key = JSON.stringify({ roots, extraPaths })
  if (!force && _ffmpegProbe && _ffmpegProbe.key === key) return _ffmpegProbe.bin
  const candidates = []
  const envBin = process.env.DSH_SVS_FFMPEG
  if (envBin) candidates.push(envBin)
  for (const p of extraPaths) if (p) candidates.push(p)
  candidates.push('ffmpeg')
  for (const r of roots) candidates.push(...ffmpegCandidatesUpward(r))

  let bin = null
  for (const c of candidates) {
    if (!c) continue
    if (c !== 'ffmpeg') {
      // 绝对/相对路径：文件必须存在且可执行；同名目录（如 tools/ffmpeg/）跳过
      try { if (!statSync(c).isFile()) continue } catch { continue }
    }
    if (await isRunnableFfmpeg(c)) { bin = c; break }
  }
  _ffmpegProbe = { key, bin }
  return bin
}

/** 补帧/重定时会用到：把一段视频按目标帧率重采样（丢/补帧），音轨原样复制。 */
export async function ffmpegRetimeFps(bin, inputAbs, outputAbs, fps) {
  const args = [
    '-y', '-i', inputAbs,
    '-vf', `fps=${fps}`,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart',
    outputAbs,
  ]
  const r = await run(bin, args)
  if (r.code !== 0) {
    throw new Error('interpolate-retime-failed: ' + (r.stderr.split('\n').slice(-4).join(' ').trim() || `exit ${r.code}`))
  }
}

/** concat demuxer 的清单行：单引号包裹，内部单引号按 ffmpeg 规则转义。 */
function concatListLine(absPath) {
  return "file '" + absPath.replace(/'/g, "'\\''") + "'"
}

/**
 * 用 ffmpeg 拼接。先试 stream copy；copy 失败（各段编码参数不一致）再重编码。
 *
 * `bin` 应传调用方已经探测到的 ffmpeg 路径（runConcat 会用 roots/extraPaths 向上层目录找，
 * 而这里的无参 detectFfmpeg() 只看 PATH）。不传时退回无参探测 —— 两条探测口径不一致时
 * 会选出 ffmpeg 后端却在这里报「本机无 ffmpeg」，ComfyUI 兜底也就永远到不了。
 * @returns {Promise<{reencoded: boolean}>}
 */
export async function ffmpegConcat(absPaths, outAbsPath, binArg) {
  const bin = binArg || await detectFfmpeg()
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
