/**
 * lib/regenerate.js — 视频重生成（capability=video.regenerate）的**纯逻辑**部分。
 *
 * 与 video.upscale 的区别（决定了本模块的形状）：
 *   · 交付尺寸**不来自源片**：重生成模型是在固定网格上训练的（1080p / 2K / 4K），
 *     所以清单声明**目标网格**（`regenerate.targets`），由调用方选一个，runner 注入图内。
 *     源片的比例只决定**方向**（横/竖），不决定像素量——这一点与超分的 `factor` / `short-side` 相反。
 *   · 它是**生成式**的：图里有采样器、要提示词、会重画内容，因此需要更严的源片护栏
 *     （24fps / 帧数训练区间 / 必须有 prompt），否则模型会在分布外输出。
 *
 * 编排（上传/提交/取回/落画布）在 lib/index.js 的 runRegenerate 里；本文件只放可单测的纯函数。
 */

/** 目标网格的像素对齐：H3 VAE 16× 下采样 + 放大器按 32 对齐 ⇒ 32 是最小安全粒度（1080/2160 不是 32 的倍数）。 */
export const REGENERATE_ALIGN = 32

const DEFAULT_GUARDS = {
  inputFps: 24,
  fpsTolerance: 0.02,
  minFrames: 121,
  maxFrames: 362,
  requiresPrompt: true,
}

const pair = (v) => Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(x) && x > 0)
const snap = (v, a = REGENERATE_ALIGN) => Math.max(a, Math.round(Number(v) / a) * a)

/**
 * 归一化清单里的 `regenerate.targets`：`{ 名字: { graph:[w,h], delivery:[w,h] } }`。
 * 校验器已经保证形状合法，这里只做「名字 → 尺寸对」的浅拷贝，避免调用方改到清单对象。
 */
export function normalizeRegenerateTargets(targets) {
  const out = {}
  for (const [name, t] of Object.entries(targets || {})) {
    out[name] = { graph: [...t.graph], delivery: [...t.delivery] }
  }
  return out
}

/**
 * 目标网格规划：选目标 → 按源片方向翻转 → 校验 32 对齐与 delivery ≤ graph。
 * 返回 `{ target, graph:{w,h}, delivery:{w,h}, portrait, warnings }`。
 */
export function resolveRegenerateTarget({ targets, target }) {
  const all = normalizeRegenerateTargets(targets)
  const names = Object.keys(all)
  if (!names.length) throw new Error('regenerate-invalid: 清单没有声明任何目标（regenerate.targets 为空）')
  const name = target || names[0]
  const t = all[name]
  if (!t) throw new Error(`regenerate-invalid: 未知目标 "${name}"（可选 ${names.join(' / ')}）`)
  for (const key of ['graph', 'delivery']) {
    if (!pair(t[key])) throw new Error(`regenerate-invalid: targets.${name}.${key} 必须是 [宽, 高] 两个正整数`)
  }
  // 只有**图内网格**要按 32 对齐（放大器/VAE 的下采样粒度）；delivery 是裁切后的尺寸，
  // 1080 / 2160 本来就不是 32 的倍数 —— 强制对齐会把「裁回标准分辨率」这件事变成不可能。
  if (t.graph.some((v) => v % REGENERATE_ALIGN !== 0)) {
    throw new Error(`regenerate-invalid: targets.${name}.graph 的宽高必须按 ${REGENERATE_ALIGN} 对齐（实际 ${t.graph.join('×')}）`)
  }
  if (t.delivery[0] > t.graph[0] || t.delivery[1] > t.graph[1]) {
    throw new Error(`regenerate-invalid: targets.${name}.delivery 不能大于 graph（交付是裁切后的尺寸）`)
  }
  return { target: name, ...t, warnings: [] }
}

/**
 * 源片护栏 + 规划。清单声明的是**规则**（24fps / 帧数区间 / 必须有 prompt），runner 只照做：
 * 不符合就**显式报错并给修法**，不静默降级（这类实现跑在分布外只会产出「看起来像成品」的废片）。
 *
 * @returns {{target:string, graph:{w:number,h:number}, delivery:{w:number,h:number}, frames:number,
 *            fps:number|null, portrait:boolean, source:{w:number,h:number}, warnings:string[]}}
 */
export function planRegenerate({ srcW, srcH, frames, fps, targets, target, guards = {}, hasPrompt = true }) {
  const g = { ...DEFAULT_GUARDS, ...guards }
  // 未指定目标时用清单声明的 default（不是对象第一个键——插入顺序不该决定交付尺寸）
  const base = resolveRegenerateTarget({ targets, target: target || g.default })
  const warnings = [...base.warnings]

  if (!(srcW > 0) || !(srcH > 0)) throw new Error('regenerate-invalid: 读不出源视频尺寸')
  const n = Math.floor(Number(frames) || 0)
  if (!(n > 0)) throw new Error('regenerate-invalid: 读不出源视频帧数')
  if (n < g.minFrames) {
    throw new Error(
      `regenerate-invalid: 源片只有 ${n} 帧，低于重生成实现的训练区间（≥${g.minFrames} 帧 ≈ ${(g.minFrames / 24).toFixed(1)}s）。` +
      `短片段请改用 video_upscale（超分），或先补足长度再重生成`)
  }
  if (n > g.maxFrames) {
    throw new Error(
      `regenerate-invalid: 源片 ${n} 帧超过重生成实现的上限（≤${g.maxFrames} 帧 ≈ ${(g.maxFrames / 24).toFixed(1)}s）。` +
      '请先按分镜拆开（逐镜重生成），不要把成片整条丢进来')
  }

  const want = Number(g.inputFps) || 24
  const tol = Number(g.fpsTolerance) || 0.02
  let srcFps = Number(fps)
  if (!Number.isFinite(srcFps) || srcFps <= 0) {
    srcFps = null
    warnings.push(`读不出源片帧率，按 ${want}fps 处理（该实现只训练过 ${want}fps 的时间轴）`)
  } else if (Math.abs(srcFps - want) > tol) {
    throw new Error(
      `regenerate-invalid: 源片是 ${srcFps}fps，而重生成实现只训练过 ${want}fps。` +
      `请先 video_interpolate / 转码到 ${want}fps 再重生成（混帧率会得到错速的时间轴）`)
  }

  if (g.requiresPrompt && !hasPrompt) {
    throw new Error(
      'regenerate-invalid: 重生成需要提示词（精修是条件生成）。' +
      '源节点没有记录 prompt（外部导入 / 拼接成片），请显式传 prompt —— 通常就是该镜头的原始提示词')
  }

  const portrait = srcH > srcW
  const graph = { w: portrait ? base.graph[1] : base.graph[0], h: portrait ? base.graph[0] : base.graph[1] }
  const delivery = { w: portrait ? base.delivery[1] : base.delivery[0], h: portrait ? base.delivery[0] : base.delivery[1] }

  // 方向与像素量提示（不拦）：源片比目标还大时，重生成会先降到 768p 再重画。
  const srcShort = Math.min(srcW, srcH)
  if (srcShort > 768) warnings.push(`源片短边 ${srcShort}px 高于 768p：重生成会先降采样到 768p 草稿再重画（细节是重画的，不是保留的）`)
  if (srcShort < 720) warnings.push(`源片短边 ${srcShort}px 低于 768p：草稿本身信息少，重生成会「补」出模型认为该有的细节（可能偏离原片）`)

  return {
    target: base.target,
    graph,
    delivery,
    frames: n,
    fps: srcFps,
    portrait,
    source: { w: srcW, h: srcH },
    warnings,
  }
}

/** 标题/记账用的尺寸标签：`2k → 2560×1440`。 */
export function regenerateSizeLabel(plan) {
  return `${plan.target} ${plan.delivery.w}×${plan.delivery.h}`
}

/** 交接方式：`latent` 吃上游存下的 H3 latent；`video` 走 mp4 解码重编码；`auto` 按可用性挑。 */
export const HANDOFF_MODES = ['auto', 'latent', 'video']

/**
 * 决定这次重生成用哪种交接物（纯函数，供 runner 与冒烟复用）。
 *
 * `auto` 的判定全部通过才走 latent；任何一条不满足就**退回视频入口**，并给出人能读懂的原因
 * （`handoffReason` 会写进工具返回值与画布节点，不静默）。`latent` 是显式要求：不满足直接抛错。
 *
 * @param {{requested?:'auto'|'latent'|'video', latent?:{file?:string,frames?:number,width?:number,height?:number},
 *          cfg?:object, targetGraph?:{w:number,h:number}, availableLatentFiles?:string[]|null, warnings?:string[]}} p
 * @returns {{mode:'latent'|'video', reason:string, warnings:string[]}}
 */
export function decideRegenerateHandoff({ requested = 'auto', latent = null, cfg = {}, targetGraph = null, availableLatentFiles = null, warnings = [] } = {}) {
  const req = String(requested || 'auto').toLowerCase()
  if (!HANDOFF_MODES.includes(req)) throw new Error(`regenerate-invalid: handoff 只能是 ${HANDOFF_MODES.join(' | ')}（实际 "${requested}"）`)
  const out = [...warnings]
  if (req === 'video') return { mode: 'video', reason: '调用方显式要求视频交接（handoff=video）', warnings: out }

  const why = (msg) => {
    if (req === 'latent') throw new Error(`regenerate-invalid: handoff=latent 但${msg}。请改用 handoff=video，或先用带 save 节点的清单重渲该镜`)
    return { mode: 'video', reason: `${msg}，已退回视频交接`, warnings: out }
  }

  const file = String(latent?.file || '').trim()
  if (!file) return why('源节点没有登记 draft latent（params.latentFile）')
  if (availableLatentFiles && !availableLatentFiles.includes(file)) {
    return why(`latent 文件不在服务端（${file}）——可能已被清理或存于另一台机器`)
  }
  const g = { ...DEFAULT_GUARDS, ...cfg }
  const frames = Math.floor(Number(latent?.frames) || 0)
  if (!(frames > 0)) return why('源节点没有记录 latent 帧数（params.latentFrames）')
  if (frames < g.minFrames) return why(`latent 只有 ${frames} 帧，低于重生成训练区间（≥${g.minFrames}）`)
  if (frames > g.maxFrames) return why(`latent ${frames} 帧，超过重生成上限（≤${g.maxFrames}）`)
  // 放大器只升不降：latent 比目标网格还大时不能走 latent（要降采样，upscaler 不支持）
  const lw = Math.floor(Number(latent?.width) || 0)
  const lh = Math.floor(Number(latent?.height) || 0)
  if (targetGraph && lw > 0 && lh > 0) {
    if (Math.max(lw, lh) > Math.max(targetGraph.w, targetGraph.h)) {
      return why(`latent 尺寸 ${lw}×${lh} 大于目标网格（${targetGraph.w}×${targetGraph.h}，放大器只升不降）`)
    }
  }
  return { mode: 'latent', reason: `使用源节点登记的 draft latent（${file}，${frames} 帧）`, warnings: out }
}
