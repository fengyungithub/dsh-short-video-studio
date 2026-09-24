/**
 * lib/upscale.js — 视频超分（U3）的**纯逻辑**部分：容器探测、尺寸规划、分块、图切片。
 *
 * 与「生成」能力的本质区别（决定了本模块的形状）：
 *   · 输入是**已存在的视频**，图分辨率跟着输入走 —— 清单只能声明**尺寸来源**（`upscale.sizing`）：
 *     `factor`（交付 = 源 × 倍率，像素空间 CNN）或 `short-side`（交付 = 实现的目标短边推导，扩散/恢复类）。
 *     两种都不是 resolutionLock 那种「写死的图尺寸」。
 *   · 图里**没有任何采样器/时间维操作**（factor 形态），逐帧独立 ⇒ ①代价线性（实测 5.4K ≈2.2–2.6 s/帧，
 *     与帧数几乎成正比），②**天然可分块**（H3 不行：链式续接要求跨镜 latent 连续）。
 *     所以长片的安全阀就是「分块 + 拼接」，不需要新模型。
 *     自带跨帧时间先验的实现要把这条**声明掉**（`upscale.chunking: 'internal'`）——外层切开会在它的
 *     时间窗上再加一道硬切，那时分块权归实现自己（batch/tiling/offload）。
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

/**
 * 交付尺寸规划。**两种尺寸来源**（`upscale.sizing`，契约见 docs/video-upscale.md §3）：
 *
 *  · `factor`（缺省）：自然尺寸 = 源尺寸 × factor；给了 targetWidth 就**事后**收敛到它（并对齐）。
 *    这是像素空间逐帧 CNN 的形态——模型只会给源 × 倍率，想要别的尺寸只能缩放，
 *    所以「目标大于自然尺寸」时必须告警：超出的那部分只是插值，没有新信息。
 *
 *  · `short-side`：交付由实现的**目标短边**推出（扩散/恢复类模型，如 SeedVR2 的 `resolution`）。
 *    倍率是推导出来的。给了 targetWidth 时**反解短边并回注实现**（而不是先渲染再降采样）——
 *    这正是 `docs/video-upscale.md` §4.2 记的那件事：降采样会削掉合成出来的高频。
 *    `maxEdge > 0` 表示实现自己的长边上限，这里**如实预测**它会把尺寸压回来并告警。
 *
 * 返回的 `delivery` 是**预测的交付尺寸**；`natural` 在 factor 形态下是「倍率能给的尺寸」，
 * 在 short-side 形态下与 delivery 相同（没有二次缩放）。
 */
export function planUpscale({ srcW, srcH, sizing = 'factor', factor, shortSide, maxEdge = 0, align = 32, targetWidth = 0 }) {
  if (!(srcW > 0) || !(srcH > 0)) throw new Error('upscale-plan: 源尺寸未知')
  // 未知形态必须显式抛错：静默按 factor 处理会让「拼错的 sizing」变成一条算错尺寸的渲染
  if (sizing !== 'factor' && sizing !== 'short-side') {
    throw new Error(`upscale-plan: 未知 sizing "${sizing}"（只有 factor | short-side）`)
  }
  const a = Math.max(1, Math.floor(Number(align) || 32))
  const tw = Number(targetWidth) > 0 ? Number(targetWidth) : 0
  const warnings = []

  if (sizing === 'short-side') {
    const short0 = Number(shortSide)
    if (!(short0 > 0)) throw new Error('upscale-plan: sizing=short-side 需要正数 shortSide')
    const landscape = srcW >= srcH
    const ratio = srcW / srcH
    // 目标宽度：横版时它是**长边**，竖版时它就是短边 ⇒ 反解出短边交给模型
    const short = tw > 0 ? (landscape ? tw / ratio : tw) : short0
    let w
    let h
    if (landscape) {
      h = snapToAlign(Math.round(short), a)
      w = snapToAlign(Math.round(h * ratio), a)
    } else {
      w = snapToAlign(Math.round(short), a)
      h = snapToAlign(Math.round(w / ratio), a)
    }
    const cap = Number(maxEdge) > 0 ? Number(maxEdge) : 0
    if (cap > 0 && Math.max(w, h) > cap) {
      const s = cap / Math.max(w, h)
      w = snapToAlign(Math.round(w * s), a)
      h = snapToAlign(Math.round(h * s), a)
      warnings.push(`实现声明 maxEdge=${cap}：长边超出后压回 ${w}×${h}`)
    }
    return {
      sizing,
      natural: { w, h },          // short-side 形态没有「倍率能给的尺寸」，自然尺寸就是交付尺寸
      delivery: { w, h },
      factor: null,               // 倍率是推导出来的，不编一个数出来
      shortSide: Math.min(w, h),  // 注入实现的最终短边（已对齐，故预测值与实际渲染值一致）
      maxEdge: cap,
      align: a,
      warning: warnings.join('；'),
    }
  }

  const f = Number(factor)
  if (!(f > 0)) throw new Error('upscale-plan: factor 必须是正数')
  const natW = Math.round(srcW * f)
  const natH = Math.round(srcH * f)
  let w = natW
  let h = natH
  if (tw > 0) {
    w = snapToAlign(tw, a)
    h = snapToAlign(Math.round(natH * (w / natW)), a)
    if (w > natW) {
      warnings.push(`目标宽度 ${w} 超过模型 ${f}× 能给的 ${natW}：超出部分只是插值，没有新信息`)
    }
  }
  return {
    sizing: 'factor',
    natural: { w: natW, h: natH },
    delivery: { w, h },
    factor: f,
    shortSide: null,
    maxEdge: 0,
    align: a,
    warning: warnings.join('；'),
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
 * 并把**所有**指向源帧/源音轨的引用改到切口上。
 *
 * 为什么要切音轨：CreateVideo 会把拿到的音频整段接到这一块画面上，不切就会出现
 * 「每块都配整条音轨」——拼接后声音叠加/错位。
 *
 * 接线按**引用**找，不按节点类名猜：`video.upscale` 现在允许异质实现（`upscale.sizing` / `chunking`），
 * 逐帧那一段未必叫 `ImageUpscaleWithModel`。曾经只认这个类名 ⇒ 换一种实现就**静默**接不上切口
 * （每块仍吃整片，拼回去帧数翻 n 倍）。所以这里改成通用替换 + **接不上就抛错**（fail-closed，
 * 宁可显式失败也不要一段悄悄重复的成片）。
 *
 * 前提（契约）：`chunking="caller"` 的实现保持「1 LoadVideo → 2 GetVideoComponents → …」这条头，
 * 帧从源节点**直接**往下走（可以再经过预处理链）；显存自己管的实现应声明 `chunking="internal"`。
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
  const wantFrames = JSON.stringify([sourceNode, 0])
  const wantAudio = JSON.stringify([sourceNode, 1])
  let wiredFrames = 0
  for (const [id, n] of Object.entries(g)) {
    // 不碰刚插入的两个切口节点自己（否则 ImageFromBatch 会自指）
    if (id === batchId || id === trimId) continue
    if (!n || typeof n.inputs !== 'object' || n.inputs === null) continue
    for (const [field, val] of Object.entries(n.inputs)) {
      const s = JSON.stringify(val)
      if (s === wantFrames) { n.inputs[field] = [batchId, 0]; wiredFrames++ }
      else if (s === wantAudio) { n.inputs[field] = [trimId, 0] }
    }
  }
  if (!wiredFrames) {
    throw new Error(
      `upscale-slice: 图里没有任何节点消费源帧 [${sourceNode}, 0]，切口接不上（会让每块都吐整片）。` +
      '声明 chunking="caller" 的实现必须保持「LoadVideo → GetVideoComponents → …」这条头，帧从源节点直接往下走；' +
      '若显存由实现自己管（自带跨帧时间先验），请改声明 upscale.chunking="internal"',
    )
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

/**
 * 分块决策（纯函数，编排留在 runner）。
 *
 * **前提是「切点安全」**：这条预算只对逐帧独立的实现成立（`upscale.chunking='caller'`）。
 * 自带跨帧时间先验的实现（`'internal'`，如 SeedVR2 的 4n+1 batch / temporal_overlap / 内部 tiling）
 * 被外层切开，等于在它的时间窗上再加一道硬切 ⇒ **不自动分块**，显存交给它自己管。
 * 调用方**显式**给了 `chunk_frames` 仍然照办（显式意图优先），但要如实告警。
 *
 * @returns {{frameLimit:number, reason:''|'manual'|'budget', pixelFrames:number, warnings:string[]}}
 */
export function planUpscaleChunks({
  frames, deliveryW, deliveryH,
  chunking = 'caller', explicitChunkFrames = 0,
  warn = PIXEL_FRAME_WARN, budget = PIXEL_FRAME_CHUNK,
}) {
  const n = Math.floor(Number(frames) || 0)
  const w = Number(deliveryW) || 0
  const h = Number(deliveryH) || 0
  const pixelFrames = n > 0 ? n * w * h : 0
  const explicit = Math.floor(Number(explicitChunkFrames) || 0)
  const warnings = []
  let frameLimit = explicit
  let reason = explicit ? 'manual' : ''
  const over = n > 0 && pixelFrames > warn
  const amount = `${n} 帧 × 交付 ${w}×${h} = ${(pixelFrames / 1e9).toFixed(2)}e9 像素-帧`

  if (!frameLimit && chunking === 'caller' && over) {
    frameLimit = chunkFramesForBudget(w, h, budget)
    reason = 'budget'
  }
  if (chunking === 'internal' && !frameLimit && over) {
    warnings.push(
      `${amount}，超过像素-帧安全线 ${(warn / 1e9).toFixed(1)}e9；但实现声明 upscale.chunking="internal"` +
      '（显存由它自己管：batch / tiling / offload），外层**不**自动分块——切开会打断它内部的时间窗',
    )
  }
  if (chunking === 'internal' && frameLimit) {
    warnings.push(
      '调用方指定了 chunk_frames：该实现声明 upscale.chunking="internal"，外层切块会在它自己的时间窗上' +
      '再加一道硬切（可能出接缝）；显存建议改用它的 batch / tiling / offload 参数',
    )
  }
  return { frameLimit, reason, pixelFrames, warnings }
}
