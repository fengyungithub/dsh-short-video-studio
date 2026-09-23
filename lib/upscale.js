/**
 * lib/upscale.js — 视频超分（U3）的**纯逻辑**部分：容器探测、尺寸规划、分块、图切片。
 *
 * 与「生成」能力的本质区别（决定了本模块的形状）：
 *   · 输入是**已存在的视频**，图分辨率跟着输入走 —— 清单只能声明**倍率**（`manifest.upscale.factor`），
 *     不能像 resolutionLock 那样锁一个写死的图尺寸；
 *   · 图里**没有任何采样器/时间维操作**，逐帧独立 ⇒ ①代价线性（实测 5.4K ≈2.2–2.6 s/帧，
 *     与帧数几乎成正比），②**天然可分块**（H3 不行：链式续接要求跨镜 latent 连续）。
 *     所以长片的安全阀就是「分块 + 拼接」，不需要新模型。
 *
 * 编排（上传/提交/取回/落画布）在 lib/index.js 的 runUpscale 里；本文件只放可单测的纯函数。
 */

import { readFileSync } from 'node:fs'

/** 按 align 就近对齐（至少 align），用于把交付尺寸收敛到 32 的倍数。 */
export function snapToAlign(v, align = 32) {
  const a = Math.max(1, Math.floor(Number(align) || 32))
  return Math.max(a, Math.round(Number(v) / a) * a)
}

/**
 * 解析 MP4 容器，取出视频轨的宽高与样本数、时长、有无音轨。
 *
 * 为什么自己解析而不是问 ComfyUI：源视频的尺寸要在**提交之前**就知道（用来算目标尺寸与分块），
 * 而这一步不该依赖远端；本机也没有 ffprobe。只走 moov/trak/tkhd/stsz/mvhd 这几个盒子，够用。
 * 失败一律返回 null 字段（调用方回退到画布节点 params）。
 *
 * @returns {{w:number|null,h:number|null,frames:number|null,duration:number|null,hasAudio:boolean}}
 */
export function probeMp4(absPath) {
  const out = { w: null, h: null, frames: null, duration: null, hasAudio: false }
  let buf
  try {
    buf = readFileSync(absPath)
  } catch {
    return out
  }

  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])
  // 单遍遍历：进入容器就递归，回调分「进入 / 离开」两次——离开 trak 时才提交该轨的结果，
  // 这样不需要跨层保存上下文，也不用 arguments.callee（ESM 严格模式下非法）。
  const walk = (off, end, enter, leave) => {
    while (off + 8 <= end) {
      const size = buf.readUInt32BE(off)
      const type = buf.toString('latin1', off + 4, off + 8)
      if (size < 8) break
      const s = off + 8
      const e = Math.min(off + size, end)
      if (e <= off) break
      enter(type, s, e)
      if (CONTAINERS.has(type)) walk(s, e, enter, leave)
      leave(type, s, e)
      off = e
    }
  }

  let cur = null
  walk(0, buf.length, (type, s) => {
    if (type === 'mvhd') {
      const ver = buf[s]
      const timescale = ver === 1 ? buf.readUInt32BE(s + 20) : buf.readUInt32BE(s + 12)
      const dur = ver === 1 ? Number(buf.readBigUInt64BE(s + 24)) : buf.readUInt32BE(s + 16)
      if (timescale) out.duration = dur / timescale
    }
    if (type === 'trak') cur = { video: false, audio: false, dims: null, samples: null }
    if (!cur) return
    if (type === 'hdlr') {
      const h = buf.toString('latin1', s + 8, s + 12)
      if (h === 'vide') cur.video = true
      if (h === 'soun') cur.audio = true
    }
    if (type === 'tkhd') {
      const ver = buf[s]
      let q = s + 4
      q += ver === 1 ? 16 : 8       // creation/modification
      q += 4                        // track id
      q += 4                        // reserved
      q += ver === 1 ? 8 : 4        // duration
      q += 8 + 2 + 2 + 2 + 2 + 36   // reserved/layer/alternate/volume/reserved/matrix
      cur.dims = [buf.readUInt32BE(q) / 65536, buf.readUInt32BE(q + 4) / 65536]
    }
    if (type === 'stsz') cur.samples = buf.readUInt32BE(s + 8)
  }, (type) => {
    if (type !== 'trak' || !cur) return
    if (cur.video) {
      if (cur.dims && cur.dims[0] > 0) { out.w = Math.round(cur.dims[0]); out.h = Math.round(cur.dims[1]) }
      if (cur.samples) out.frames = cur.samples
    }
    if (cur.audio) out.hasAudio = true
    cur = null
  })
  return out
}

/** 交付尺寸规划：自然尺寸 = 源尺寸 × factor；给了 targetWidth 就收敛到它（并对齐）。 */
export function planUpscale({ srcW, srcH, factor, align = 32, targetWidth = 0 }) {
  if (!(srcW > 0) || !(srcH > 0)) throw new Error('upscale-plan: 源尺寸未知')
  if (!(factor > 0)) throw new Error('upscale-plan: factor 必须是正数')
  const natW = Math.round(srcW * factor)
  const natH = Math.round(srcH * factor)
  let w = natW
  let h = natH
  let warning = ''
  if (targetWidth > 0) {
    w = snapToAlign(targetWidth, align)
    h = snapToAlign(Math.round(natH * (w / natW)), align)
    if (w > natW) {
      warning = `目标宽度 ${w} 超过模型 ${factor}× 能给的 ${natW}：超出部分只是插值，没有新信息`
    }
  }
  return {
    natural: { w: natW, h: natH },
    delivery: { w, h },
    factor,
    align,
    warning,
  }
}

/**
 * 分块表：逐帧独立 ⇒ 任意切点都安全（切点只影响内存峰值，不影响结果）。
 * 空表/非法 chunkFrames ⇒ 整片一次过（返回单块）。
 */
export function chunkRanges(frames, chunkFrames) {
  const n = Math.floor(Number(frames) || 0)
  const step = Math.floor(Number(chunkFrames) || 0)
  if (n <= 0) return [{ start: 0, frames: 0 }]
  if (step <= 0 || step >= n) return [{ start: 0, frames: n }]
  const out = []
  for (let s = 0; s < n; s += step) out.push({ start: s, frames: Math.min(step, n - s) })
  return out
}

/**
 * 按分块范围给超分图**开一个切口**：在源分支上插 ImageFromBatch（切帧）与 TrimAudioDuration（切音轨），
 * 并把放大节点与 CreateVideo 的输入改到切口上。
 *
 * 为什么要切音轨：CreateVideo 会把拿到的音频整段接到这一块画面上，不切就会出现
 * 「每块都配整条音轨」——拼接后声音叠加/错位。
 *
 * @param {object} graph  已由清单构建好的图（会被深拷贝）
 * @param {{start:number, frames:number, fps:number, sourceNode?:string, idBase?:number}} slice
 */
export function sliceUpscaleGraph(graph, { start, frames, fps, sourceNode = '2', idBase = 900 }) {
  const fpsNum = Number(fps) > 0 ? Number(fps) : 24
  if (!(frames > 0)) return graph
  if (start === 0 && graph.__fullLengthFrames === frames) return graph   // 整片：不需要切口
  const g = JSON.parse(JSON.stringify(graph))
  const batchId = String(idBase)
  const trimId = String(idBase + 1)
  if (g[batchId] || g[trimId]) {
    throw new Error(`upscale-slice: 节点 id ${batchId}/${trimId} 已被占用，无法插入切口`)
  }
  g[batchId] = {
    class_type: 'ImageFromBatch',
    inputs: { image: [sourceNode, 0], batch_index: start, length: frames },
  }
  g[trimId] = {
    class_type: 'TrimAudioDuration',
    inputs: {
      audio: [sourceNode, 1],
      start_index: Number((start / fpsNum).toFixed(6)),
      duration: Number((frames / fpsNum).toFixed(6)),
    },
  }
  for (const n of Object.values(g)) {
    if (n.class_type === 'ImageUpscaleWithModel' &&
        JSON.stringify(n.inputs.image) === JSON.stringify([sourceNode, 0])) {
      n.inputs.image = [batchId, 0]
    }
    if (n.class_type === 'CreateVideo' &&
        JSON.stringify(n.inputs.audio) === JSON.stringify([sourceNode, 1])) {
      n.inputs.audio = [trimId, 0]
    }
  }
  return g
}

/**
 * 显存安全阀：交付侧的像素-帧总量（帧数 × 交付宽 × 交付高）。
 *
 * 标定依据（A800 80GB 实测）：248 帧 × 5376×3072 = **4.09e9** 一次通过（无 OOM）；
 * 124 帧 × 5376×3072 = 2.05e9 亦通过。这里把**告警/分块线**压在已验证包线以内：
 * 超过 3.0e9 就分块，每块压到 2.0e9 以内。
 * 代价是线性的（5.4K ≈2.2–2.6 s/帧），所以分块不会显著变慢。
 */
export const PIXEL_FRAME_WARN = 3.0e9
export const PIXEL_FRAME_CHUNK = 2.0e9

/** 按像素-帧预算算每块帧数（至少 1 帧）。 */
export function chunkFramesForBudget(deliveryW, deliveryH, budget = PIXEL_FRAME_CHUNK) {
  const per = Math.max(1, Number(deliveryW) * Number(deliveryH))
  return Math.max(1, Math.floor(budget / per))
}
