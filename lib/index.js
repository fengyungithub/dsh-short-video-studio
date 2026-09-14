/**
 * dsh-short-video-studio — host half.
 *
 * MiniMax-Design 风格的短剧/动画画布工作室：
 *  - ComfyUI 生成引擎（图片 FLUX / 视频 MiniMax H3，默认 http://localhost:8188）
 *  - 画布持久存储 <workspace>/canvas/<sessionId>/project.json + 媒体文件
 *  - /dsh-short-video-studio 路由（画布 API + 媒体伺服 + studio 静态站）
 *  - Agent 工具：comfy_generate_image / comfy_generate_video / canvas_*
 *  - systemPrompt 段：流水线 + 工具契约 + 选项卡门控
 *  - pre-ask 自动送达：tools/pre-execute 钩子在 ask_user_question 前把画布
 *    未送达产物经 send_file 发到飞书（文本节点自动导出 .pdf）
 *
 * 本文件刻意零 @deepseek-ai/* 运行时 import：工具用原生 ToolDefinition
 * 注册（parameters 直接写 JSON Schema），服务全部走注入的 ctx
 * （webServer/tools/systemPrompt/workspaceRegistry），从而 link:/file: 安装
 * 都不受 peer 解析路径影响。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync, cpSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  realpath,
  stat,
  unlink,
  link,
  copyFile,
} from 'node:fs/promises'
import { resolve, basename, dirname, join, relative, sep, extname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { loadBuiltinManifests, buildGraphFromManifest, validateManifest, resolveAssets, CAPABILITIES, TIERS } from './manifest.js'
import { convertComfyExport, isRawComfyExport, isLegacyWorkflowFormat } from './convert.js'
import {
  loadLibrary, normalizeAssetId, isAssetRef, canonicalAssetId, assetFilename,
  resolveAssetImagePath, registerAsset, slugifyName, ASSET_TYPES,
} from './assets.js'
import { buildConcatGraph, detectFfmpeg, ffmpegConcat } from './concat.js'
import { detectPdfTool, htmlToPdf } from './pdf.js'
import { markdownToHtml, escapeHtmlText, inlineFormat } from '../studio/markdown.js'

export const name = 'short-video-studio'

/** 宿主服务依赖（fiber 等待这些服务先就绪）。 */
export const inject = ['webServer', 'tools', 'systemPrompt', 'workspaceRegistry']

// ---------------------------------------------------------------------------
// 配置（优先级：env > 配置文件 ~/.dsh/dsh-short-video-studio.json > 默认）
// 配置文件示例见 README「配置」；也支持 DSH_SVS_CONFIG 指向其它路径。
// ---------------------------------------------------------------------------
function loadConfigFile() {
  const path = process.env.DSH_SVS_CONFIG || join(homedir(), '.dsh', 'dsh-short-video-studio.json')
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) || {}
  } catch { /* 忽略损坏的配置，回退默认 */ }
  return {}
}
const _cfg = loadConfigFile()
const _models = _cfg.models || {}
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d)

const COMFY_BASE_URL = env('DSH_SVS_COMFY_URL', _cfg.baseUrl || 'http://localhost:8188').replace(/\/+$/, '')
const COMFY_API_KEY = env('DSH_SVS_COMFY_KEY', _cfg.apiKey || '')
const POLL_INTERVAL_MS = Number(env('DSH_SVS_POLL_MS', _cfg.pollMs || 2000))
const GENERATION_TIMEOUT_MS = Number(env('DSH_SVS_TIMEOUT_MS', _cfg.timeoutMs || 15 * 60 * 1000))

const ROUTE_ROOT = '/dsh-short-video-studio'
const CANVAS_DIR = 'canvas'

// FLUX 2 本地模型（图片）
const FLUX_MODEL = env('DSH_SVS_FLUX_MODEL', _models.fluxUnet || 'flux2_dev_fp8mixed.safetensors')
const FLUX_CLIP = env('DSH_SVS_FLUX_CLIP', _models.fluxClip || 'mistral_3_small_flux2_bf16.safetensors')
const FLUX_CLIP_TYPE = 'flux2'
const FLUX_VAE = env('DSH_SVS_FLUX_VAE', _models.fluxVae || 'flux2-vae.safetensors')

// MiniMax H3 本地模型（视频，音视频 AV）
const H3_MODEL = env('DSH_SVS_H3_MODEL', _models.h3Unet || 'minimax_h3_fl2va_pruned_int8_convrot.safetensors')
const H3_CLIP = env('DSH_SVS_H3_CLIP', _models.h3Clip || 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors')
const H3_CLIP_TYPE = 'minimax'
const H3_VAE = env('DSH_SVS_H3_VAE', _models.h3VideoVae || 'minimax_h3_video_vae_fp16.safetensors')
const H3_AUDIO_VAE = env('DSH_SVS_H3_AUDIO_VAE', _models.h3AudioVae || 'minimax_h3_audio_vae_fp32.safetensors')
const H3_MODEL_REF = env('DSH_SVS_H3_MODEL_REF', _models.h3RefUnet || 'minimax_h3_ref2va_pruned_int8_convrot.safetensors')
const H3_LORA_FAST = env('DSH_SVS_H3_LORA_FAST', _models.h3FastLora || 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors')
const H3_FPS = Number(env('DSH_SVS_H3_FPS', _models.h3Fps || 24))

/** 配置持久化路径（与 loadConfigFile 一致）。 */
const CONFIG_PATH = process.env.DSH_SVS_CONFIG || join(homedir(), '.dsh', 'dsh-short-video-studio.json')

/**
 * 运行时配置（每次调用重读 env + 配置文件，使设置即时生效）。
 * 优先级：env > 配置文件 ~/.dsh/dsh-short-video-studio.json > 默认。
 */
function getCfg() {
  const c = loadConfigFile()
  const m = c.models || {}
  return {
    baseUrl: env('DSH_SVS_COMFY_URL', c.baseUrl || 'http://localhost:8188').replace(/\/+$/, ''),
    apiKey: env('DSH_SVS_COMFY_KEY', c.apiKey || ''),
    pollMs: Number(env('DSH_SVS_POLL_MS', c.pollMs || 2000)),
    timeoutMs: Number(env('DSH_SVS_TIMEOUT_MS', c.timeoutMs || 15 * 60 * 1000)),
    models: {
      fluxUnet: env('DSH_SVS_FLUX_MODEL', m.fluxUnet || 'flux2_dev_fp8mixed.safetensors'),
      fluxClip: env('DSH_SVS_FLUX_CLIP', m.fluxClip || 'mistral_3_small_flux2_bf16.safetensors'),
      fluxVae: env('DSH_SVS_FLUX_VAE', m.fluxVae || 'flux2-vae.safetensors'),
      h3RefUnet: env('DSH_SVS_H3_MODEL_REF', m.h3RefUnet || 'minimax_h3_ref2va_pruned_int8_convrot.safetensors'),
      // i2v（首/末帧串联）用 FL2VA 变体：官方 I2V/T2V 即这套权重，与 ref2va 是两套不同 base
      h3FlUnet: env('DSH_SVS_H3_MODEL_FL', m.h3FlUnet || 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'),
      h3Clip: env('DSH_SVS_H3_CLIP', m.h3Clip || 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'),
      h3VideoVae: env('DSH_SVS_H3_VAE', m.h3VideoVae || 'minimax_h3_video_vae_fp16.safetensors'),
      h3AudioVae: env('DSH_SVS_H3_AUDIO_VAE', m.h3AudioVae || 'minimax_h3_audio_vae_fp32.safetensors'),
      h3FastLora: env('DSH_SVS_H3_LORA_FAST', m.h3FastLora || 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'),
      // fl2v 系 4 步 LoRA（544p 训练域，shift 12/3）—— 与 fl2va base 配对给 i2v 的 fast 档
      h3FlFastLora: env('DSH_SVS_H3_LORA_FL_FAST', m.h3FlFastLora || 'minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors'),
      // ref2v 的 8 步 768p LoRA（balanced 档，shift 6/3 + euler）
      h3BalancedLora: env('DSH_SVS_H3_LORA_BALANCED', m.h3BalancedLora || 'minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors'),
      // fl2v 的 8 步 768p LoRA（i2v 平衡档，shift 6/3 + euler）——必须与 544p 系（shift 12/3）区分
      h3FlBalancedLora: env('DSH_SVS_H3_LORA_FL_BALANCED', m.h3FlBalancedLora || 'minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors'),
      h3Fps: Number(env('DSH_SVS_H3_FPS', m.h3Fps || 24)),
    },
    assetOverrides: c.assetOverrides || {},
    preferred: c.preferred || {},
    // 档位选择：capability → tier → 实现 id（见 docs/tier-strategy-design.md）
    tiers: c.tiers && typeof c.tiers === 'object' ? c.tiers : {},
  }
}

/**
 * 未指定档位时的默认档（沿用旧行为：旧路径的默认是清单首个 mode，内置 ref2v 的
 * 首个 mode 即 quality）。解析结果里会带 resolution='tier-default' 与警告，不静默。
 */
const DEFAULT_TIER = 'quality'

const GUIDANCE_ORDER = 150

// 未指定分组时的中性兜底名。分组词汇由 skill 自由定义，执行层不认识任何片型名词；
// 展示顺序由画布 settings.groupOrder（skill 通过 canvas_set_state 声明）决定，未声明的按首次出现排。
const DEFAULT_GROUP = 'ungrouped'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const text = (value) => [{ type: 'text', text: String(value) }]

function HttpError(status, message) {
  const e = new Error(message)
  e.status = status
  return e
}

function errorCode(error) {
  if (!error || typeof error !== 'object') return ''
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : ''
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 校验 workspace 内相对路径，防路径逃逸（借鉴 idesign / dsh-ssh）。 */
function safeRelative(value, prefix = '') {
  const normalized = String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!normalized || isAbsolute(normalized) || normalized.includes('\0')) {
    throw HttpError(400, 'invalid canvas path')
  }
  if (normalized.split('/').some((p) => !p || p === '.' || p === '..')) {
    throw HttpError(400, 'invalid canvas path')
  }
  if (prefix) {
    const root = prefix.replace(/\/+$/, '')
    if (normalized !== root && !normalized.startsWith(root + '/')) {
      throw HttpError(403, 'path escapes canvas folder')
    }
  }
  return normalized
}

function inside(root, target) {
  const r = relative(root, target)
  return r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r))
}

async function requestJson(req, maxBytes = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > maxBytes) throw HttpError(413, 'request too large')
    chunks.push(buf)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object')
    return value
  } catch {
    throw HttpError(400, 'invalid JSON body')
  }
}

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
}

const contentType = (p) => CONTENT_TYPES[extname(p).toLowerCase()] || 'application/octet-stream'

/** 计算一个媒体相对路径的交付信息：绝对路径 / 媒体类型 / 字节数（供 TUI/飞书渠道送达）。 */
function mediaDelivery(root, media) {
  if (!media) return { absPath: '', mediaType: '', bytes: 0 }
  const absPath = join(root, ...String(media).split('/'))
  let bytes = 0
  try { bytes = statSync(absPath).size } catch { /* 文件缺失时保持 0 */ }
  return { absPath, mediaType: contentType(absPath), bytes }
}

/** 字节数 → 人类可读（交付时对照 send_file 的单文件上限）。 */
function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
  return (i === 0 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[i]
}

/** 生成类工具结果的统一交付信息文本：相对路径供 send_file，绝对路径供终端打开。 */
function mediaResultDetail(value) {
  const lines = [`相对路径(send_file 交付): ${value.media}`]
  if (value.absPath) lines.push(`绝对路径(终端打开): ${value.absPath}`)
  if (value.mediaType || value.bytes) lines.push(`媒体: ${value.mediaType || 'unknown'} · ${humanSize(value.bytes)}`)
  return lines.join('\n')
}

/**
 * 渲染结果的档位透明度说明：档位 → 实现 → 解析来源（+ 警告）。
 * 产品层必须能一眼看出"这次实际用了哪个实现"，否则又回到"显示 fast 实际跑 20 步"的失真。
 */
function renderResolutionNote(value) {
  if (!value || !value.ok) return ''
  const bits = []
  if (value.tier) bits.push(`档位 ${value.tier}`)
  if (value.implementation) bits.push(`实现 ${value.implementation}`)
  if (value.resolution) bits.push(`解析 ${value.resolution}`)
  const warn = Array.isArray(value.warnings) && value.warnings.length ? `\n注意：${value.warnings.join('；')}` : ''
  return (bits.length ? `\n${bits.join(' · ')}` : '') + warn
}

// ---------------------------------------------------------------------------
// ComfyUI 客户端
// ---------------------------------------------------------------------------

async function comfyFetch(path, init) {
  const cfg = getCfg()
  const headers = { ...(init?.headers || {}) }
  if (cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey
  let res
  try {
    res = await fetch(cfg.baseUrl + path, { ...init, headers })
  } catch (error) {
    throw new Error('comfy-unreachable: ComfyUI 不可达（' + cfg.baseUrl + '）：' + (error?.message || String(error)))
  }
  return res
}

/** 提交工作流，返回 prompt_id。 */
async function comfySubmit(graph) {
  const res = await comfyFetch('/prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: 'dsh-short-video-studio-' + randomUUID() }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body?.prompt_id) {
    let detail = ''
    if (body?.node_errors && Object.keys(body.node_errors).length) detail = JSON.stringify(body.node_errors)
    else if (body?.error) detail = typeof body.error === 'string' ? body.error : JSON.stringify(body.error)
    else if (body?.message) detail = body.message
    else detail = res.status + (typeof res.statusText === 'string' ? ' ' + res.statusText : '')
    throw new Error('workflow-validation: ComfyUI 拒绝工作流：' + (detail || res.status))
  }
  return body.prompt_id
}

/** 轮询 /history/{id} 直到 completed/error，带超时与 signal。 */
async function comfyWait(promptId, signal) {
  const deadline = Date.now() + GENERATION_TIMEOUT_MS
  for (;;) {
    if (signal?.aborted) throw new Error('generation cancelled')
    if (Date.now() > deadline) throw new Error('timeout: ComfyUI 生成超时（>' + GENERATION_TIMEOUT_MS + 'ms）')
    const res = await comfyFetch('/history/' + encodeURIComponent(promptId))
    const body = await res.json().catch(() => ({}))
    const entry = body?.[promptId]
    if (entry) {
      const status = entry.status
      if (status?.completed) return entry
      if (status?.status_str === 'error') {
        const errs = []
        for (const out of Object.values(entry.outputs || {})) {
          for (const e of out?.node_errors || []) errs.push(e?.message || JSON.stringify(e))
        }
        throw new Error('generation-error: ' + (errs.join('; ') || 'ComfyUI 节点报错'))
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

/** 从 history 抽取输出文件。 */
function comfyOutputs(entry) {
  const files = []
  const seen = new Set()
  for (const out of Object.values(entry?.outputs || {})) {
    for (const kind of ['images', 'videos', 'gifs', 'audio']) {
      for (const item of out?.[kind] || []) {
        const key = (item.type || 'output') + '/' + (item.subfolder || '') + '/' + item.filename
        if (seen.has(key)) continue
        seen.add(key)
        files.push({ filename: item.filename, subfolder: item.subfolder || '', type: item.type || 'output' })
      }
    }
  }
  return files
}

/** 下载产物为 Buffer。 */
async function comfyDownload(file) {
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder,
    type: file.type || 'output',
  })
  const res = await comfyFetch('/view?' + params.toString())
  if (!res.ok) throw new Error('comfy-download-failed: ' + res.status + ' ' + file.filename)
  return Buffer.from(await res.arrayBuffer())
}

/** 上传一张图片到 ComfyUI input 目录，返回 {name, subfolder, type}。 */
async function comfyUploadImage(buffer, filename) {
  const form = new FormData()
  form.append('image', new Blob([buffer]), filename)
  form.append('overwrite', 'true')
  const res = await comfyFetch('/upload/image', { method: 'POST', body: form })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body?.name) {
    throw new Error('comfy-upload-failed: ' + (body?.error || body?.message || res.status))
  }
  return body
}

// ---------------------------------------------------------------------------
// 工作流模板（ComfyUI API 格式）
// ---------------------------------------------------------------------------

/**
 * FLUX 2 文生图工作流。
 * UNETLoader → ModelSamplingFlux → CLIPLoader → VAELoader →
 * CLIPTextEncode(通用，mistral flux2 CLIP) → FluxGuidance →
 * EmptyFlux2LatentImage → Flux2Scheduler →
 * RandomNoise + BasicGuider + KSamplerSelect → SamplerCustomAdvanced → VAEDecode → SaveImage
 */
function buildFluxImageWorkflow({ prompt, width, height, seed, steps, guidance, filenamePrefix }) {
  const models = getCfg().models
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: models.fluxUnet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: models.fluxClip, type: FLUX_CLIP_TYPE } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: models.fluxVae } },
    '4': { class_type: 'ModelSamplingFlux', inputs: { model: ['1', 0], max_shift: 1.15, base_shift: 0.5, width, height } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    '5b': { class_type: 'FluxGuidance', inputs: { conditioning: ['5', 0], guidance } },
    '6': { class_type: 'EmptyFlux2LatentImage', inputs: { width, height, batch_size: 1 } },
    '7': { class_type: 'Flux2Scheduler', inputs: { steps, width, height } },
    '8': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '9': { class_type: 'BasicGuider', inputs: { model: ['4', 0], conditioning: ['5b', 0] } },
    '10': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '11': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['8', 0], guider: ['9', 0], sampler: ['10', 0], sigmas: ['7', 0], latent_image: ['6', 0] } },
    '12': { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
    '13': { class_type: 'SaveImage', inputs: { images: ['12', 0], filename_prefix: filenamePrefix } },
  }
}

// ---------------------------------------------------------------------------
// 分辨率计算：fast/quality 均按「每档固定长边 + 画布 aspectRatio」推导宽高，
// 因此 fast 也支持 9:16 / 1:1 等任意比例（不再写死 832×480）。
// ---------------------------------------------------------------------------
const VIDEO_MODE_LONG = { fast: 832, quality: 1344 }
const VIDEO_MODE_DEFAULT = { fast: { w: 832, h: 480 }, quality: { w: 1344, h: 768 } }
function snap32(n) { return Math.max(32, Math.round(n / 32) * 32) }
/**
 * 计算单镜头视频实际宽高。
 * - 显式传入 width/height：直接采用（snap 到 32 倍数）；
 * - 否则按 aspectRatio（如 '16:9'/'9:16'/'1:1'）以「每档长边」推导；
 * - 都没给：回退每档默认（fast 832×480 / quality 1344×768）。
 */
function computeVideoSize({ mode, width, height, aspectRatio }) {
  const hasW = Number.isFinite(width) && width > 0
  const hasH = Number.isFinite(height) && height > 0
  if (hasW && hasH) return { w: snap32(width), h: snap32(height) }
  const m = /^\s*(\d+)\s*[:/x]\s*(\d+)\s*$/.exec(String(aspectRatio || '').trim())
  if (m) {
    const rw = Number(m[1])
    const rh = Number(m[2])
    const long = VIDEO_MODE_LONG[mode] || VIDEO_MODE_LONG.quality
    if (rw >= rh) return { w: long, h: snap32(long * rh / rw) }
    return { w: snap32(long * rw / rh), h: long }
  }
  return VIDEO_MODE_DEFAULT[mode] || VIDEO_MODE_DEFAULT.quality
}

/**
 * MiniMax H3 音视频 + 参考绑定工作流（静音→有声，去参考→参考绑定）。
 * - 模式 quality：1344×768 / 20 步 / 无 LoRA；fast：4 步 / Lightning LoRA（调试）。
 * - 分辨率由调用方按画布 aspectRatio 传入 width/height（fast/quality 均支持任意比例）。
 * - refComfyNames 为已上传到 ComfyUI 的参考图文件名（角色/场景卡），经
 *   MiniMaxH3ReferenceToVideo 的 ref_images.ref_image_N（dotted）绑定身份/环境。
 * - 音频经 VAEDecodeAudio(audio_vae) → CreateVideo(audio) 合成，不再静音。
 */
function buildH3VideoWorkflow({ prompt, width, height, length, seed, steps, filenamePrefix, mode = 'quality', refComfyNames = [] }) {
  const fast = mode === 'fast'
  const w = width
  const h = height
  const st = fast ? 4 : steps
  const sampler = 'res_multistep'
  const scheduler = 'simple'
  const models = getCfg().models

  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: models.h3RefUnet, weight_dtype: 'default' } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: models.h3Clip, type: H3_CLIP_TYPE } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: models.h3VideoVae } },
    '4a': { class_type: 'VAELoader', inputs: { vae_name: models.h3AudioVae } },
  }

  // 模型链路：fast 档插入 Lightning LoRA（4 步 turbo）
  let modelRef = ['1', 0]
  if (fast) {
    graph['1a'] = { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: models.h3FastLora, strength_model: 1.0, model: ['1', 0] } }
    modelRef = ['1a', 0]
  }
  graph['2'] = { class_type: 'MiniMaxH3SigmaShift', inputs: { model: modelRef, shift_video: 12.0, shift_audio: 3.0 } }

  const n5 = { clip: ['3', 0], vae: ['4', 0], audio_vae: ['4a', 0], prompt, width: w, height: h, length, ref_image_size: 'match' }
  if (Array.isArray(refComfyNames) && refComfyNames.length) {
    for (let i = 0; i < refComfyNames.length; i++) {
      const nodeKey = String(200 + i)
      graph[nodeKey] = { class_type: 'LoadImage', inputs: { image: refComfyNames[i] } }
      n5['ref_images.ref_image_' + i] = [nodeKey, 0]
    }
  }
  graph['5'] = { class_type: 'MiniMaxH3ReferenceToVideo', inputs: n5 }

  graph['6'] = { class_type: 'RandomNoise', inputs: { noise_seed: seed } }
  graph['7'] = { class_type: 'BasicGuider', inputs: { model: ['2', 0], conditioning: ['5', 0] } }
  graph['8'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: sampler } }
  graph['9'] = { class_type: 'BasicScheduler', inputs: { model: ['2', 0], scheduler, steps: st, denoise: 1.0 } }
  graph['10'] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['6', 0], guider: ['7', 0], sampler: ['8', 0], sigmas: ['9', 0], latent_image: ['5', 1] } }
  graph['11'] = { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['4', 0] } }
  graph['11a'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['10', 0], vae: ['4a', 0] } }
  graph['12'] = { class_type: 'CreateVideo', inputs: { images: ['11', 0], audio: ['11a', 0], fps: H3_FPS } }
  graph['13'] = { class_type: 'SaveVideo', inputs: { video: ['12', 0], filename_prefix: filenamePrefix, format: 'mp4', codec: 'h264' } }

  return graph
}

/**
 * MiniMax H3 首/末帧串联 + 音频工作流（用于同场景续接镜，改善 Q5 过渡）。
 * - first_frame_node/last_frame_node：把上一镜末帧 / 本镜末帧作为首帧/末帧，实现连续性。
 * - 与 buildH3VideoWorkflow 不同，它用 MiniMaxH3ImageToVideo（无 ref_images，但 latent 仍可
 *   VAEDecodeAudio 取音频），身份/环境由首帧（真实帧）继承。
 */
function buildH3ImageToVideoWorkflow({ prompt, width, height, length, seed, steps, filenamePrefix, mode = 'quality', firstFrameComfyName = null, lastFrameComfyName = null }) {
  const fast = mode === 'fast'
  const w = width
  const h = height
  const st = fast ? 4 : steps
  const sampler = 'res_multistep'
  const scheduler = 'simple'
  const models = getCfg().models

  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: models.h3FlUnet, weight_dtype: 'default' } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: models.h3Clip, type: H3_CLIP_TYPE } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: models.h3VideoVae } },
    '4a': { class_type: 'VAELoader', inputs: { vae_name: models.h3AudioVae } },
  }
  let modelRef = ['1', 0]
  if (fast) {
    graph['1a'] = { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: models.h3FlFastLora, strength_model: 1.0, model: ['1', 0] } }
    modelRef = ['1a', 0]
  }
  graph['2'] = { class_type: 'MiniMaxH3SigmaShift', inputs: { model: modelRef, shift_video: 12.0, shift_audio: 3.0 } }

  const n5 = { clip: ['3', 0], vae: ['4', 0], prompt, width: w, height: h, length }
  let nid = 200
  if (firstFrameComfyName) {
    graph[String(nid)] = { class_type: 'LoadImage', inputs: { image: firstFrameComfyName } }
    graph[String(nid + 1)] = { class_type: 'ImageScale', inputs: { image: [String(nid), 0], upscale_method: 'lanczos', width: w, height: h, crop: 'disabled' } }
    n5.first_frame = [String(nid + 1), 0]
    nid += 2
  }
  if (lastFrameComfyName) {
    graph[String(nid)] = { class_type: 'LoadImage', inputs: { image: lastFrameComfyName } }
    graph[String(nid + 1)] = { class_type: 'ImageScale', inputs: { image: [String(nid), 0], upscale_method: 'lanczos', width: w, height: h, crop: 'disabled' } }
    n5.last_frame = [String(nid + 1), 0]
  }
  graph['5'] = { class_type: 'MiniMaxH3ImageToVideo', inputs: n5 }

  graph['6'] = { class_type: 'RandomNoise', inputs: { noise_seed: seed } }
  graph['7'] = { class_type: 'BasicGuider', inputs: { model: ['2', 0], conditioning: ['5', 0] } }
  graph['8'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: sampler } }
  graph['9'] = { class_type: 'BasicScheduler', inputs: { model: ['2', 0], scheduler, steps: st, denoise: 1.0 } }
  graph['10'] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['6', 0], guider: ['7', 0], sampler: ['8', 0], sigmas: ['9', 0], latent_image: ['5', 1] } }
  graph['11'] = { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['4', 0] } }
  graph['11a'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['10', 0], vae: ['4a', 0] } }
  graph['12'] = { class_type: 'CreateVideo', inputs: { images: ['11', 0], audio: ['11a', 0], fps: H3_FPS } }
  graph['13'] = { class_type: 'SaveVideo', inputs: { video: ['12', 0], filename_prefix: filenamePrefix, format: 'mp4', codec: 'h264' } }

  return graph
}

// ---------------------------------------------------------------------------
// 画布存储
// ---------------------------------------------------------------------------

function projectDir(root, sessionId) {
  return join(root, CANVAS_DIR, sessionId)
}
function projectFile(root, sessionId) {
  return join(projectDir(root, sessionId), 'project.json')
}

function emptyProject(sessionId) {
  return {
    schemaVersion: 1,
    sessionId,
    settings: { aspectRatio: '16:9', duration: '', audioMode: 'silent' },
    nodes: [],
  }
}

async function loadProject(root, sessionId) {
  const file = projectFile(root, sessionId)
  if (!existsSync(file)) return emptyProject(sessionId)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return emptyProject(sessionId)
    if (!Array.isArray(parsed.nodes)) parsed.nodes = []
    if (!parsed.settings || typeof parsed.settings !== 'object') parsed.settings = { aspectRatio: '16:9', duration: '', audioMode: 'silent' }
    return parsed
  } catch {
    return emptyProject(sessionId)
  }
}

/** 原子写 project.json（临时文件 + rename），带 per-session 串行化。 */
const writeLocks = new Map()
async function saveProject(root, sessionId, project) {
  const key = root + ':' + sessionId
  const prev = writeLocks.get(key) || Promise.resolve()
  let release
  const tail = new Promise((r) => (release = r))
  const queued = prev.then(() => tail, () => tail)
  writeLocks.set(key, queued)
  await prev.catch(() => {})
  try {
    const dir = projectDir(root, sessionId)
    await mkdir(dir, { recursive: true })
    const file = projectFile(root, sessionId)
    const tmp = join(dir, '.project.' + randomUUID() + '.tmp')
    await writeFile(tmp, JSON.stringify(project, null, 2), 'utf8')
    await rename(tmp, file)
  } finally {
    release()
    if (writeLocks.get(key) === queued) writeLocks.delete(key)
  }
}

function nextOrder(nodes) {
  return nodes.reduce((m, n) => Math.max(m, Number(n.order) || 0), -1) + 1
}

// ---------------------------------------------------------------------------
// workspace / session 解析
// ---------------------------------------------------------------------------

/**
 * 解析会话工作区根目录。
 * 优先级：显式 workspaceId → agent 会话 cwd → workspaceRegistry 会话成员扫描。
 */
function resolveSessionRoot(ctx, sessionId, workspaceId, exec) {
  const sid = sessionId || exec?.agent?.id
  if (!sid) throw HttpError(400, 'sessionId required')

  if (workspaceId) {
    const w = ctx.workspaceRegistry.get(workspaceId)
    if (w) return { sessionId: sid, root: w.path, workspaceId: String(w.id) }
  }

  const cwd = exec?.agent?.session?.meta?.cwd
  if (cwd) return { sessionId: sid, root: cwd, workspaceId: '' }

  for (const w of ctx.workspaceRegistry.list()) {
    if (w.sessionIds.includes(sid)) return { sessionId: sid, root: w.path, workspaceId: String(w.id) }
  }

  throw HttpError(404, 'workspace not found for session ' + sid)
}

// ---------------------------------------------------------------------------
// 生成执行（图片 / 视频），写回画布
// ---------------------------------------------------------------------------

async function persistMedia(root, sessionId, buffer, filename) {
  const dir = projectDir(root, sessionId)
  await mkdir(dir, { recursive: true })
  const target = join(dir, filename)
  await writeFile(target, buffer)
  return CANVAS_DIR + '/' + sessionId + '/' + filename
}

// ---------------------------------------------------------------------------
// 手动资产导入（画布「自己添加角色卡/场景卡」）
//   importManualImage    — 上传的本地图片 → 画布 image 节点
//   copyAssetToCanvas    — 资产库中的资产 → 画布 image 节点（工具/路由共用）
// 入库仍是用户可选的独立动作（画布卡片「入库」按钮），与「入库由用户人工完成」
// 的契约一致：此处只落画布卡，不写资产库。
// ---------------------------------------------------------------------------

const UPLOAD_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}
const UPLOAD_MAX_FILE = 24 * 1024 * 1024
const UPLOAD_MAX_FILES = 12

/** data:image/...;base64 → { buffer, ext }；非法输入抛错。 */
function parseDataUrlImage(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '').trim())
  if (!m) throw new Error('仅支持 png / jpg / webp / gif 图片的 dataURL')
  const buffer = Buffer.from(m[2], 'base64')
  if (!buffer.length) throw new Error('图片内容为空')
  if (buffer.length > UPLOAD_MAX_FILE) throw new Error('图片超过 24MB 上限')
  return { buffer, ext: UPLOAD_MIME[m[1]] }
}

/** 把一张上传的本地图片存成画布 image 节点（kind=image，params.source='manual-upload'）。 */
async function importManualImage(root, sessionId, item, group) {
  const { buffer, ext } = parseDataUrlImage(item && item.dataUrl)
  const nodeId = randomUUID()
  const rel = await persistMedia(root, sessionId, buffer, 'upload-' + nodeId + ext)
  const rawName = String((item && item.filename) || '').replace(/\\/g, '/').split('/').pop() || '图片'
  const baseName = rawName.replace(/\.[^.]+$/, '').trim().slice(0, 60) || '图片'
  const project = await loadProject(root, sessionId)
  const node = {
    id: nodeId,
    kind: 'image',
    title: (item && typeof item.title === 'string' && item.title.trim()) ? item.title.trim().slice(0, 60) : baseName,
    media: rel,
    group: group || DEFAULT_GROUP,
    params: { source: 'manual-upload', originalName: rawName },
    status: 'ready',
    createdAt: Date.now(),
    order: nextOrder(project.nodes),
  }
  project.nodes.push(node)
  await saveProject(root, sessionId, project)
  return node
}

/**
 * 把资产库（.dsh-assets/library.json）中的资产物化为当前画布 image 节点：
 * 库图拷贝到 canvas/<sessionId>/，节点 params.assetId 绑定资产 id（ref_nodes 可引用）。
 */
async function copyAssetToCanvas(root, sessionId, ref, opts = {}) {
  const lib = loadLibrary(root)
  const id = canonicalAssetId(ref)
  const a = lib.assets[id]
  if (!a) throw new Error('资产不存在: ' + ref)
  const abs = resolveAssetImagePath(root, lib, id)
  if (!abs) throw new Error('资产图片文件缺失: ' + (a.image || id))

  const nodeId = opts.nodeId || randomUUID()
  const buf = await readFile(abs)
  const rel = await persistMedia(root, sessionId, buf, 'asset-' + assetFilename(id) + (extname(abs) || '.png'))
  const project = await loadProject(root, sessionId)
  const node = {
    id: nodeId,
    kind: 'image',
    title: opts.title || a.name || id,
    media: rel,
    group: opts.group || DEFAULT_GROUP,
    params: { assetId: id, model: 'asset:' + id, speaksOnScreen: a.speaksOnScreen },
    status: 'ready',
    createdAt: Date.now(),
    order: nextOrder(project.nodes),
  }
  const existing = project.nodes.findIndex((n) => n.id === nodeId)
  if (existing >= 0) { node.order = project.nodes[existing].order; node.createdAt = project.nodes[existing].createdAt; project.nodes[existing] = node }
  else project.nodes.push(node)
  await saveProject(root, sessionId, project)
  return node
}

/**
 * 替换画布某 image 节点的图片（画布卡「编辑 → 本地上传替换」）。
 * - 新图落盘为 upload-<uuid><ext>，节点 media 指向新文件（原文件保留在磁盘）。
 * - 该节点此前若已绑定资产库（params.assetId，来自入库或 asset_to_canvas），
 *   替换后**解除绑定**（库中旧图不被被动更新），返回 prevAssetId 供提示用户按需重新「入库」。
 * - 生成类元数据（model/prompt/seed/steps/width/height 等）一并清掉，避免误导
 *   「这张图是按旧参数生成」；capability/状态类 params 保留。
 * - 清除 deliveredAt/deliveryError：替换后的新图会在下次 ask 前重新自动送达（飞书）。
 */
async function replaceNodeImage(root, sessionId, nodeId, item) {
  const { buffer, ext } = parseDataUrlImage(item && item.dataUrl)
  const project = await loadProject(root, sessionId)
  const idx = project.nodes.findIndex((n) => n.id === nodeId)
  if (idx < 0) throw new Error('节点不存在: ' + nodeId)
  const n = project.nodes[idx]
  if (n.kind !== 'image') throw new Error('仅 image 节点可替换图片（当前 ' + (n.kind || '?') + '）')

  const rel = await persistMedia(root, sessionId, buffer, 'upload-' + randomUUID() + ext)
  const params = { ...(n.params || {}) }
  const prevAssetId = params.assetId
  delete params.assetId
  for (const k of ['model', 'prompt', 'seed', 'steps', 'guidance', 'width', 'height', 'length', 'count']) delete params[k]
  const rawName = String((item && item.filename) || '').replace(/\\/g, '/').split('/').pop() || ''
  params.source = 'manual-upload'
  params.replacedAt = Date.now()
  if (rawName) params.originalName = rawName
  delete params.deliveredAt
  delete params.deliveryError

  n.media = rel
  n.params = params
  project.nodes[idx] = n
  await saveProject(root, sessionId, project)
  return { node: n, prevAssetId, assetIdCleared: Boolean(prevAssetId) }
}

async function runImageGeneration(ctx, opts) {
  const { workspaceId, exec } = opts
  const { root, sessionId } = resolveSessionRoot(ctx, opts.sessionId, workspaceId, exec)
  const width = intArg(opts, 'width', 1344)
  const height = intArg(opts, 'height', 768)
  const seed = intArg(opts, 'seed', Math.floor(Math.random() * 2 ** 31))
  const steps = intArg(opts, 'steps', 20)
  const guidance = floatArg(opts, 'guidance', 3.5)
  const count = Math.min(Math.max(intArg(opts, 'count', 1), 1), 4)
  const nodeId = opts.nodeId || randomUUID()

  const files = []
  for (let i = 0; i < count; i++) {
    const prefix = CANVAS_DIR + '/' + sessionId + '/' + nodeId
    const graph = buildFluxImageWorkflow({ prompt: opts.prompt, width, height, seed: seed + i, steps, guidance, filenamePrefix: prefix })
    const promptId = await comfySubmit(graph)
    const entry = await comfyWait(promptId, opts.signal)
    const outputs = comfyOutputs(entry)
    if (outputs.length === 0) throw new Error('generation-error: ComfyUI 无输出')
    for (const f of outputs) {
      const buf = await comfyDownload(f)
      files.push(await persistMedia(root, sessionId, buf, f.filename))
    }
  }

  const project = await loadProject(root, sessionId)
  const node = {
    id: nodeId,
    kind: 'image',
    title: opts.title || 'FLUX 图片',
    media: files[0] || '',
    group: opts.group || DEFAULT_GROUP,
    params: { model: 'flux', seed, width, height, steps, guidance, prompt: opts.prompt },
    status: 'ready',
    createdAt: Date.now(),
    order: nextOrder(project.nodes),
  }
  const existing = project.nodes.findIndex((n) => n.id === nodeId)
  if (existing >= 0) { node.order = project.nodes[existing].order; node.createdAt = project.nodes[existing].createdAt; project.nodes[existing] = node }
  else project.nodes.push(node)
  await saveProject(root, sessionId, project)

  return { ok: true, node, files }
}

async function runVideoGeneration(ctx, opts) {
  const { workspaceId, exec } = opts
  const { root, sessionId } = resolveSessionRoot(ctx, opts.sessionId, workspaceId, exec)
  const explicitW = opts.width !== undefined && opts.width !== null && opts.width !== ''
  const explicitH = opts.height !== undefined && opts.height !== null && opts.height !== ''
  const width = intArg(opts, 'width', 1344)
  const height = intArg(opts, 'height', 768)
  const length = intArg(opts, 'length', 124)
  const seed = intArg(opts, 'seed', Math.floor(Math.random() * 2 ** 31))
  const steps = intArg(opts, 'steps', 20)
  const mode = opts.mode === 'fast' ? 'fast' : 'quality'
  const nodeId = opts.nodeId || randomUUID()

  const project = await loadProject(root, sessionId)
  // 实际生效分辨率：显式 width/height 优先，否则按画布 aspectRatio 推导（fast/quality 均支持任意比例）
  const { w: effW, h: effH } = computeVideoSize({
    mode,
    width: explicitW ? width : undefined,
    height: explicitH ? height : undefined,
    aspectRatio: project.settings?.aspectRatio,
  })
  // 上传画布图片节点 → ComfyUI 文件名（参考图 / 首末帧）
  const uploadNode = async (nid) => {
    const n = project.nodes.find((x) => x.id === nid)
    if (n?.media) {
      const absPath = join(root, ...n.media.split('/'))
      if (existsSync(absPath)) {
        const buf = await readFile(absPath)
        const up = await comfyUploadImage(buf, basename(n.media))
        return up.name
      }
    }
    return null
  }

  // 参考绑定（角色卡/场景卡）→ ReferenceToVideo 路径
  const refNodeIds = Array.isArray(opts.ref_nodes) ? opts.ref_nodes : []
  const refComfyNames = []
  for (const rid of refNodeIds) {
    const name = await uploadNode(rid)
    if (name) refComfyNames.push(name)
  }

  // 首/末帧串联（同场景续接）→ ImageToVideo 路径
  const firstFrameComfyName = opts.first_frame_node ? await uploadNode(opts.first_frame_node) : null
  const lastFrameComfyName = opts.last_frame_node ? await uploadNode(opts.last_frame_node) : null
  const useChaining = Boolean(firstFrameComfyName || lastFrameComfyName)

  const prefix = CANVAS_DIR + '/' + sessionId + '/' + nodeId
  const graph = useChaining
    ? buildH3ImageToVideoWorkflow({ prompt: opts.prompt, width: effW, height: effH, length, seed, steps, filenamePrefix: prefix, mode, firstFrameComfyName, lastFrameComfyName })
    : buildH3VideoWorkflow({ prompt: opts.prompt, width: effW, height: effH, length, seed, steps, filenamePrefix: prefix, mode, refComfyNames })
  const promptId = await comfySubmit(graph)
  const entry = await comfyWait(promptId, opts.signal)
  const outputs = comfyOutputs(entry)
  if (outputs.length === 0) throw new Error('generation-error: ComfyUI 无输出')

  const files = []
  for (const f of outputs) {
    const buf = await comfyDownload(f)
    files.push(await persistMedia(root, sessionId, buf, f.filename))
  }

  // 记录实际生效分辨率（fast/quality 均按画布比例或传入宽高计算）
  const node = {
    id: nodeId,
    kind: 'video',
    title: opts.title || 'MiniMax H3 视频',
    media: files[0] || '',
    group: opts.group || DEFAULT_GROUP,
    params: { model: 'minimax-h3' + (mode === 'fast' ? '-fast' : ''), seed, width: effW, height: effH, length, fps: H3_FPS, steps: mode === 'fast' ? 4 : steps, mode, ref_nodes: refNodeIds, first_frame_node: opts.first_frame_node || null, last_frame_node: opts.last_frame_node || null, prompt: opts.prompt },
    status: 'ready',
    createdAt: Date.now(),
    order: nextOrder(project.nodes),
  }
  const existing = project.nodes.findIndex((n) => n.id === nodeId)
  if (existing >= 0) { node.order = project.nodes[existing].order; node.createdAt = project.nodes[existing].createdAt; project.nodes[existing] = node }
  else project.nodes.push(node)
  await saveProject(root, sessionId, project)

  return { ok: true, node, files }
}

function intArg(obj, key, dflt) {
  const v = obj?.[key]
  if (v === undefined || v === null || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? Math.floor(n) : dflt
}
function floatArg(obj, key, dflt) {
  const v = obj?.[key]
  if (v === undefined || v === null || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

// ---------------------------------------------------------------------------
// 通用渲染（M2）：capability → manifest → 编译图 → ComfyUI → 写画布
// ---------------------------------------------------------------------------

let _registry = null
const USER_WORKFLOWS_DIR = join(homedir(), '.dsh', 'dsh-short-video-studio', 'workflows')

/** 重新加载内置 + 用户清单（用户同名遮蔽内置）。 */
function reloadRegistry() {
  const builtin = loadBuiltinManifests(resolve(packageRoot, 'workflows'))
  const user = loadBuiltinManifests(USER_WORKFLOWS_DIR)
  for (const m of builtin.manifests) m._source = 'builtin'
  for (const m of user.manifests) m._source = 'user'
  const byId = { ...builtin.byId, ...user.byId }
  const byCapability = {}
  for (const m of Object.values(byId)) (byCapability[m.capability] ||= []).push(m)
  // 同能力候选**确定性排序**：priority 降序（缺省 0），再按 id 升序。
  // 该顺序决定 `preferred` 为空时的隐式默认档（resolveManifest 取 candidates[0]），
  // 所以不能依赖文件系统枚举顺序（曾导致"新增一份清单就悄悄改掉默认档"）。
  // 约定：想永不被选为隐式默认的清单写负数 priority（如实验/依赖自定义节点的加速变体）。
  for (const list of Object.values(byCapability)) {
    list.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || String(a.id).localeCompare(String(b.id)))
  }
  _registry = {
    manifests: Object.values(byId),
    byId,
    byCapability,
    errors: [...builtin.errors, ...user.errors],
  }
  // 清单变动 → 节点可用性预检缓存作废（用户可能刚装了 Sol 之类的第三方节点）
  _nodeProbe.clear()
  return _registry
}

function getRegistry() {
  return _registry || reloadRegistry()
}

/** 读取某 capability 的有序 preferred 工作流 id 列表。 */
function getPreferred(capability) {
  const c = loadConfigFile()
  return (Array.isArray(c.preferred?.[capability]) ? c.preferred[capability] : []).filter((id) => typeof id === 'string')
}

/**
 * 旧 models.* 键 → 各工作流资产的别名映射（升级后旧配置不失效）。
 * P2 拆分后每个档位是独立清单（<组名>-<档位>[-sol]），因此按族登记。
 */
const H3_REF2V_IDS = [
  'minimax-h3-ref2v-fast', 'minimax-h3-ref2v-balanced', 'minimax-h3-ref2v-balanced-sol',
  'minimax-h3-ref2v-quality', 'minimax-h3-ref2v-quality-sol',
]
const H3_I2V_IDS = [
  'minimax-h3-i2v-fast', 'minimax-h3-i2v-balanced', 'minimax-h3-i2v-balanced-sol',
  'minimax-h3-i2v-quality', 'minimax-h3-i2v-quality-sol',
]
const H3_REF2V_ASSETS = { unet: 'h3RefUnet', clip: 'h3Clip', vae: 'h3VideoVae', audio_vae: 'h3AudioVae', fast_lora: 'h3FastLora', lora_8step: 'h3BalancedLora' }
// i2v 走 fl2va/fl2v 配对：**不能**复用 ref2v 的 h3RefUnet/h3FastLora，
// 否则 manifest 里的 fl2va 默认值会被旧键静默覆盖（跨变体错配复现）。
const H3_I2V_ASSETS = { unet: 'h3FlUnet', clip: 'h3Clip', vae: 'h3VideoVae', audio_vae: 'h3AudioVae', fast_lora: 'h3FlFastLora', lora_8step: 'h3FlBalancedLora' }

const LEGACY_MODEL_ASSET_MAP = {
  'flux-text2image': { unet: 'fluxUnet', clip: 'fluxClip', vae: 'fluxVae' },
  ...Object.fromEntries(H3_REF2V_IDS.map((id) => [id, H3_REF2V_ASSETS])),
  ...Object.fromEntries(H3_I2V_IDS.map((id) => [id, H3_I2V_ASSETS])),
  // 拆分前的旧 id：用户配置里可能仍写着它们，保留映射以便平滑迁移
  'minimax-h3-ref2v': H3_REF2V_ASSETS,
  'minimax-h3-ref2v-8step': H3_REF2V_ASSETS,
  'minimax-h3-i2v': H3_I2V_ASSETS,
}

/**
 * 旧清单 id 的 assetOverrides 继承：拆分后新 id 会同时读旧 id 的覆盖，
 * 使用户既有的 assetOverrides（如 int8 VAE 选择）不因拆分而失效。
 */
const ASSET_OVERRIDE_ALIASES = Object.fromEntries([
  ...H3_REF2V_IDS.map((id) => [id, id.includes('balanced') ? ['minimax-h3-ref2v-8step', 'minimax-h3-ref2v'] : ['minimax-h3-ref2v']]),
  ...H3_I2V_IDS.map((id) => [id, ['minimax-h3-i2v']]),
])

/** 某工作流的资产覆盖：显式 assetOverrides[id] > 旧 id 覆盖 > 旧 models.* 兜底。 */
function getAssetOverrides(workflowId) {
  const c = loadConfigFile()
  const explicit = (c.assetOverrides && c.assetOverrides[workflowId]) || {}
  const alias = {}
  for (const oldId of ASSET_OVERRIDE_ALIASES[workflowId] || []) {
    Object.assign(alias, (c.assetOverrides && c.assetOverrides[oldId]) || {})
  }
  const legacy = {}
  const map = LEGACY_MODEL_ASSET_MAP[workflowId] || {}
  const models = c.models || {}
  for (const [assetKey, modelKey] of Object.entries(map)) {
    if (models[modelKey] !== undefined && models[modelKey] !== '') legacy[assetKey] = models[modelKey]
  }
  return { ...legacy, ...alias, ...explicit }
}

/** 显式 workflow > preferred 顺序 > 该 capability 任意清单（internal 诊断清单不参与隐式选中）。 */
function resolveManifest(registry, capability, workflowId) {
  const candidates = (registry.byCapability[capability] || []).filter((m) => !m.internal)
  if (workflowId) {
    const m = registry.byId[workflowId]
    if (!m) throw new Error(`workflow "${workflowId}" 不存在`)
    if (m.capability !== capability) throw new Error(`workflow "${workflowId}" 能力是 ${m.capability}，非 ${capability}`)
    return m
  }
  if (!candidates.length) throw new Error(`no workflow for capability ${capability}`)
  for (const id of getPreferred(capability)) {
    const m = registry.byId[id]
    if (m && m.capability === capability && !m.internal) return m
  }
  return candidates[0]
}

/**
 * 解析 mode：显式合法 mode > 单档清单的唯一 mode > 清单首个 mode。
 * strict=true 时，显式请求的 mode 不存在于清单 → **报错**（禁止静默跨档替换）。
 * 例外：已声明 tier 且只有一个 mode 的清单（P2 之后的分档实现），其唯一 mode 就是该档的参数组，
 * 名称不同也照用——这不算跨档替换。
 */
function resolveMode(manifest, mode, { strict = false } = {}) {
  const names = Object.keys(manifest.modes || {})
  if (!names.length) return null
  if (mode && manifest.modes[mode]) return mode
  if (mode && strict) {
    if (manifest.tier && names.length === 1) return names[0]
    throw new Error(
      `工作流 "${manifest.id}" 不提供 "${mode}" 档（可用：${names.join(' / ')}）：` +
      '本插件不会静默跨档替换，请改档位或改用提供该档的实现')
  }
  return names[0]
}

/** 分辨率：显式宽高 > aspect-ratio 推导（按 mode.longSide）> resolution.default。 */
function computeManifestSize(manifest, mode, explicitW, explicitH, aspectRatio) {
  const hasW = Number.isFinite(explicitW) && explicitW > 0
  const hasH = Number.isFinite(explicitH) && explicitH > 0
  if (hasW && hasH) return { w: snap32(explicitW), h: snap32(explicitH) }
  const res = manifest.resolution || {}
  if (res.policy === 'aspect-ratio') {
    const m = /^\s*(\d+)\s*[:/x]\s*(\d+)\s*$/.exec(String(aspectRatio || '').trim())
    const long = (mode && manifest.modes?.[mode]?.longSide) || res.longSide || 1344
    if (m) {
      const rw = Number(m[1])
      const rh = Number(m[2])
      if (rw >= rh) return { w: long, h: snap32((long * rh) / rw) }
      return { w: snap32((long * rw) / rh), h: long }
    }
  }
  const d = res.default
  if (Array.isArray(d) && d.length >= 2) return { w: snap32(d[0]), h: snap32(d[1]) }
  if (d && typeof d === 'object' && Array.isArray(d[mode]) && d[mode].length >= 2) return { w: snap32(d[mode][0]), h: snap32(d[mode][1]) }
  return { w: 1344, h: 768 }
}

// ---------------------------------------------------------------------------
// 档位解析层（契约见 docs/tier-strategy-design.md）
//   产品层：capability + tier(fast|balanced|quality) → 一个实现清单
//   注册层：同 group 聚合、无加速/有加速策略投影、可用性预检
//   铁律：不静默跨档替换；选定的实现不可用就显式报错（可由用户改选，不自动换）
// ---------------------------------------------------------------------------

/** 同档候选排序：priority 降序 → 无加速优先 → id 升序（确定性；内置默认＝无加速）。 */
function sortTierCandidates(list) {
  return list.slice().sort((a, b) =>
    (Number(b.priority) || 0) - (Number(a.priority) || 0)
    || (a.accel ? 1 : 0) - (b.accel ? 1 : 0)
    || String(a.id).localeCompare(String(b.id)))
}

/** 组名：显式 group 优先，缺省以自身 id 成组（不从文件名猜）。 */
const groupNameOf = (m) => (typeof m.group === 'string' && m.group ? m.group : m.id)

/** 某能力某档的实现（排除 internal 诊断清单），已按确定性顺序排好。 */
function tierImplementations(capability, tier, registry = getRegistry()) {
  return sortTierCandidates((registry.byCapability[capability] || []).filter((m) => m.tier === tier && !m.internal))
}

/** 该能力是否已分档（至少有一档实现）。未分档 → 走旧清单兼容路径。 */
function isTieredCapability(capability, registry = getRegistry()) {
  return TIERS.some((t) => tierImplementations(capability, t, registry).length > 0)
}

/** 配置里的档位选择：capability → tier → 实现 id。 */
function getTierSelection(capability) {
  const c = loadConfigFile()
  const t = c.tiers && c.tiers[capability]
  return t && typeof t === 'object' && !Array.isArray(t) ? t : {}
}

/** 未分档能力的旧清单候选顺序：preferred 命中者优先，其余按注册表顺序。 */
function orderLegacyCandidates(registry, capability) {
  const list = (registry.byCapability[capability] || []).filter((m) => !m.internal)
  const pref = getPreferred(capability)
  const rank = (m) => { const i = pref.indexOf(m.id); return i < 0 ? pref.length + 1 : i }
  return list.slice().sort((a, b) => rank(a) - rank(b))
}

// --- 可用性预检（读 ComfyUI /object_info，带 TTL 缓存；离线＝未知，不判死）---------

const NODE_PROBE_TTL_MS = 5 * 60 * 1000
const _nodeProbe = new Map() // class_type → { ok: true|false|null, at }

/**
 * 探测 ComfyUI 是否注册某节点类。
 * true=已注册 / false=未注册 / null=未知（ComfyUI 不可达或探测失败）。
 * 离线时不判死：否则一断网整个设置页会被判为不可用。
 */
async function probeNodeClass(classType, { ttlMs = NODE_PROBE_TTL_MS, force = false } = {}) {
  const hit = _nodeProbe.get(classType)
  const now = Date.now()
  if (!force && hit && now - hit.at < ttlMs) return hit.ok
  let ok = null
  try {
    const res = await comfyFetch('/object_info/' + encodeURIComponent(classType))
    if (res.ok) {
      const json = await res.json()
      // ComfyUI 对未知节点返回 {}（空对象），已注册则返回该类名的条目
      ok = Boolean(json && typeof json === 'object' && Object.keys(json).length > 0)
    }
  } catch { ok = null }
  _nodeProbe.set(classType, { ok, at: now })
  return ok
}

/** 该实现的可用性：{ ok, unknown, missing }；无 requiresNodes 视为可用（不探测）。 */
async function checkAvailability(m, opts = {}) {
  const req = Array.isArray(m.requiresNodes) ? m.requiresNodes : []
  if (!req.length) return { ok: true, unknown: false, missing: [] }
  const probe = typeof opts.probe === 'function' ? opts.probe : probeNodeClass
  const missing = []
  let unknown = false
  for (const cls of req) {
    const r = await probe(cls, opts)
    if (r === false) missing.push(cls)
    else if (r === null) unknown = true
  }
  return { ok: missing.length === 0, unknown, missing }
}

/** 不可用 → 显式报错（含补救指引；**绝不静默替换**用户选定的实现）。 */
async function assertImplementationUsable(m, tier, opts = {}) {
  const a = await checkAvailability(m, opts)
  if (a.ok) return a
  const registry = opts.registry || getRegistry()
  const std = sortTierCandidates(tierImplementations(m.capability, m.tier || tier, registry).filter((x) => !x.accel && x.id !== m.id))
  throw new Error(
    `档位 ${m.tier || tier} 的实现 "${m.id}" 不可用：ComfyUI 未注册节点 ${a.missing.join('、')}。` +
    (std.length ? `可在设置页改选标准实现「${std[0].id}」，或安装对应节点后重试。` : '请安装对应节点后重试。') +
    '（本插件不会静默替换你选定的实现）')
}

// --- 解析 -------------------------------------------------------------------

/** 从调用参数取档位：显式 tier，或 mode 恰为档位名（mode 是档位的兼容别名）。 */
function tierFromArgs(opts) {
  const t = typeof opts.tier === 'string' ? opts.tier.trim() : ''
  if (TIERS.includes(t)) return t
  const m = typeof opts.mode === 'string' ? opts.mode.trim() : ''
  return TIERS.includes(m) ? m : null
}

/** 非档位含义的 mode 名（旧清单自定义档，如 high/low），仅旧路径使用。 */
function legacyModeFromArgs(opts) {
  const m = typeof opts.mode === 'string' ? opts.mode.trim() : ''
  return m && !TIERS.includes(m) ? m : null
}

/**
 * capability + tier → 清单。
 * 返回 { manifest, tier, resolution, warnings }，resolution ∈ explicit | tier-config | tier-default | legacy-mode | legacy。
 * 规则（docs/tier-strategy-design.md §5）：
 *   1. 显式 workflow 优先；其 tier 与请求档位不符 → 报错（不静默）
 *   2. 配置 tiers[capability][tier] 选定的实现
 *   3. 否则该档候选首个
 *   4. 该档无实现 → 报错并列出可用档位
 *   5. 该能力完全未分档（旧清单）→ 用旧清单的 mode 名匹配请求档位；匹配不到 → 报错（不猜）
 */
async function resolveTieredManifest(capability, tier, explicitWorkflow, opts = {}) {
  const registry = opts.registry || getRegistry()
  const warnings = []

  if (explicitWorkflow) {
    const m = registry.byId[explicitWorkflow]
    if (!m) throw new Error(`workflow "${explicitWorkflow}" 不存在`)
    if (m.capability !== capability) throw new Error(`workflow "${explicitWorkflow}" 能力是 ${m.capability}，非 ${capability}`)
    if (tier && m.tier && m.tier !== tier) {
      throw new Error(
        `workflow "${m.id}" 是 ${m.tier} 档，与请求的 ${tier} 档不匹配（不静默跨档替换）：` +
        `请改请求档位，或改用提供 ${tier} 档的实现`)
    }
    await assertImplementationUsable(m, tier, { ...opts, registry })
    return { manifest: m, tier: m.tier || tier || null, resolution: 'explicit', warnings }
  }

  // 未分档能力：兼容旧清单（按 mode 名匹配请求档位，匹配不到就报错，不猜）
  if (!isTieredCapability(capability, registry)) {
    if (tier) {
      const cands = orderLegacyCandidates(registry, capability)
      const hit = cands.find((m) => m.modes && m.modes[tier])
      if (hit) {
        warnings.push(`能力 ${capability} 尚未分档：按旧清单 "${hit.id}" 的 ${tier} mode 解析（建议补 tier 声明）`)
        return { manifest: hit, tier, resolution: 'legacy-mode', warnings }
      }
      // 完全无 mode 的清单＝没有档位轴（如文生图）：只有一个实现，谈不上跨档替换，
      // 照用并明确告知（不是静默替换，warning 会进结果与画布节点参数）。
      const modeless = cands.find((m) => !Object.keys(m.modes || {}).length)
      if (modeless) {
        warnings.push(`能力 ${capability} 的清单 "${modeless.id}" 未声明档位（无 mode）：按唯一实现执行，忽略请求的 ${tier} 档`)
        return { manifest: modeless, tier: null, resolution: 'legacy-modeless', warnings }
      }
      const modes = [...new Set(cands.flatMap((m) => Object.keys(m.modes || {})))]
      throw new Error(
        `能力 ${capability} 尚无 ${tier} 档实现（现有清单未声明 tier，只提供 mode：${modes.join(' / ') || '无'}）：` +
        '请改档位、给清单补 tier 声明，或用显式 workflow=')
    }
    return { manifest: resolveManifest(registry, capability, null), tier: null, resolution: 'legacy', warnings }
  }

  const want = tier || DEFAULT_TIER
  if (!tier) warnings.push(`未指定档位，按默认 ${DEFAULT_TIER} 档解析`)

  // 配置选定（opts.selection 可注入：让测试/预览不依赖本机配置里已保存的选择）
  const selected = (opts.selection !== undefined ? (opts.selection || {}) : getTierSelection(capability))[want]
  if (selected) {
    const m = registry.byId[selected]
    if (!m) throw new Error(`档位 ${want} 选定的实现 "${selected}" 不存在（可能已被删除）：请在设置页重选`)
    if (m.capability !== capability) throw new Error(`档位 ${want} 选定的实现 "${selected}" 能力是 ${m.capability}，非 ${capability}：请在设置页重选`)
    if (m.internal) throw new Error(`档位 ${want} 选定的实现 "${selected}" 是内部诊断清单，不能作为档位实现：请在设置页重选`)
    if (m.tier && m.tier !== want) throw new Error(`档位 ${want} 选定的实现 "${selected}" 实际是 ${m.tier} 档：请在设置页修正`)
    await assertImplementationUsable(m, want, { ...opts, registry })
    return { manifest: m, tier: want, resolution: 'tier-config', warnings }
  }

  // 该档候选首个
  const cands = tierImplementations(capability, want, registry)
  if (!cands.length) {
    const avail = TIERS.filter((t) => tierImplementations(capability, t, registry).length)
    throw new Error(
      `能力 ${capability} 没有 ${want} 档实现（可用档位：${avail.join(' / ') || '无'}）：` +
      '请改档位，或上传/声明该档实现')
  }
  const pick = cands[0]
  await assertImplementationUsable(pick, want, { ...opts, registry })
  return { manifest: pick, tier: want, resolution: 'tier-default', warnings }
}

// --- 策略投影与矩阵（配置页 / UI / 技能读同一份数据） ------------------------

/**
 * 组的策略投影：
 *  「（无加速）」= 每档 → 组内非 accel 实现；「（有加速）」= 每档 → 组内 accel 实现（无则落标准）。
 *  两条投影逐档完全相同时只给一条（否则又成了"两个选项选出来一样"的假象）。
 */
function projectGroupStrategies(group) {
  const std = {}
  const acc = {}
  for (const [tier, list] of Object.entries(group.tiers)) {
    std[tier] = (list.find((m) => !m.accel) || list[0]).id
    acc[tier] = (list.find((m) => m.accel) || list[0]).id
  }
  // 策略是**组级**的：id/label 带组信息，消费方无需靠嵌套位置推断它属于哪一组
  const entries = [{ id: `${group.id}::standard`, group: group.id, label: `${group.displayName}（无加速）`, tiers: std }]
  const identical = TIERS.every((t) => (std[t] || null) === (acc[t] || null))
  if (!identical) entries.push({ id: `${group.id}::accel`, group: group.id, label: `${group.displayName}（有加速）`, tiers: acc })
  return entries
}

/**
 * 档位 × 实现 × 可用性矩阵（UI 与技能的唯一数据源）。
 * opts.probe=false 时不做节点预检（可用性返回 null=未知）。
 */
async function describeTierMatrix(registry = getRegistry(), opts = {}) {
  const probe = opts.probe !== false
  const out = {}
  for (const [cap, ms] of Object.entries(registry.byCapability)) {
    const classified = ms.filter((m) => m.tier && !m.internal)
    const unclassified = ms.filter((m) => !m.tier && !m.internal)
    if (!classified.length && !unclassified.length) continue
    const groups = {}
    for (const m of classified) (groups[groupNameOf(m)] ||= { id: groupNameOf(m), displayName: m.displayName || groupNameOf(m), tiers: {} })
    for (const m of classified) (groups[groupNameOf(m)].tiers[m.tier] ||= []).push(m)
    const desc = async (m) => {
      const a = probe ? await checkAvailability(m, opts) : { ok: null, unknown: true, missing: [] }
      return {
        id: m.id,
        displayName: m.displayName || m.id,
        tier: m.tier,
        group: groupNameOf(m),
        accel: m.accel || '',
        available: a.ok,
        missingNodes: a.missing,
        requiresNodes: m.requiresNodes || [],
        estSeconds: Number.isFinite(m.estSeconds) ? m.estSeconds : null,
        note: m.note || '',
        source: m._source || 'builtin',
        modes: Object.keys(m.modes || {}),
        // 该档的生效参数（UI 显示尺寸/步数与后端同源，不硬编码）
        longSide: (m.modes && m.modes[m.tier] && m.modes[m.tier].longSide) || null,
        steps: (m.modes && m.modes[m.tier] && m.modes[m.tier].steps) || null,
      }
    }
    const groupList = []
    for (const g of Object.values(groups)) {
      const tiers = {}
      for (const [tier, list] of Object.entries(g.tiers)) {
        tiers[tier] = await Promise.all(sortTierCandidates(list).map(desc))
      }
      const built = { id: g.id, displayName: g.displayName, tiers }
      built.strategies = projectGroupStrategies(built)
      groupList.push(built)
    }
    out[cap] = {
      capability: cap,
      tiered: classified.length > 0,
      tiers: TIERS.filter((t) => classified.some((m) => m.tier === t)),
      groups: groupList,
      selection: getTierSelection(cap),
      unclassified: unclassified.map((m) => {
        const firstMode = Object.values(m.modes || {})[0] || {}
        // 未分档清单的分辨率声明原样透出（mode.longSide / resolution.longSide / resolution.default），
        // UI 不再硬编码 1344 之类的尺寸
        const longSide = firstMode.longSide || (m.resolution && m.resolution.longSide) || null
        const def = (m.resolution && m.resolution.default) || null
        return {
          id: m.id, displayName: m.displayName || m.id, modes: Object.keys(m.modes || {}), source: m._source || 'builtin',
          longSide,
          resolution: { policy: (m.resolution && m.resolution.policy) || null, longSide, default: def },
        }
      }),
    }
  }
  return out
}

/** /api/workflows 的响应体（设置页与工具条的唯一数据源；抽成函数便于测试与复用）。 */
async function describeWorkflowsApi(registry = getRegistry(), opts = {}) {
  const matrix = await describeTierMatrix(registry, opts)
  const capabilities = Object.entries(registry.byCapability).map(([cap, ms]) => ({
    capability: cap,
    preferred: getPreferred(cap),
    tiered: Boolean((matrix[cap] || {}).tiered),
    tiers: (matrix[cap] || {}).tiers || [],
    selection: (matrix[cap] || {}).selection || {},
    groups: (matrix[cap] || {}).groups || [],
    unclassified: (matrix[cap] || {}).unclassified || [],
    workflows: ms.map((m) => ({
      id: m.id,
      displayName: m.displayName || m.id,
      modes: Object.keys(m.modes || {}),
      tier: m.tier || '',
      group: groupNameOf(m),
      accel: m.accel || '',
      internal: Boolean(m.internal),
      requiresNodes: m.requiresNodes || [],
      estSeconds: Number.isFinite(m.estSeconds) ? m.estSeconds : null,
      note: m.note || '',
      output: m.output || {},
      constraints: m.constraints || {},
      assets: m.assets || {},
      // 实际生效的资产值（清单默认 ← 旧配置 models.* 映射 ← 旧 id 覆盖继承 ← 显式覆盖），
      // 供设置页显示：避免"界面显示 fp16、实际跑 int8"这类失真。
      effectiveAssets: effectiveAssetsOf(m),
      source: m._source || 'builtin',
    })),
  }))
  return { ok: true, capabilities, tiers: TIERS, errors: registry.errors }
}

/** 某清单的资产键 → 实际生效值（覆盖 > 别名/旧配置 > 清单默认）。 */
function effectiveAssetsOf(m) {
  const ov = getAssetOverrides(m.id)
  const out = {}
  for (const [k, a] of Object.entries(m.assets || {})) {
    out[k] = (ov && ov[k] !== undefined) ? ov[k] : ((a && a.default) || '')
  }
  return out
}

/** 纯逻辑：manifest + opts + aspectRatio → { mode, job, graph }（opts.refs/first_frame/last_frame 为已上传 comfy 文件名）。 */
function buildRenderGraph(manifest, opts, aspectRatio) {
  const mode = resolveMode(manifest, opts.mode)
  const explicitW = opts.width !== undefined && opts.width !== null && opts.width !== '' ? intArg(opts, 'width', 1344) : undefined
  const explicitH = opts.height !== undefined && opts.height !== null && opts.height !== '' ? intArg(opts, 'height', 768) : undefined
  const { w, h } = computeManifestSize(manifest, mode, explicitW, explicitH, aspectRatio)
  const length = intArg(opts, 'length', 124)
  const seed = intArg(opts, 'seed', Math.floor(Math.random() * 2 ** 31))
  const modeCfg = mode && manifest.modes ? (manifest.modes[mode] || {}) : {}
  const steps = opts.steps !== undefined && opts.steps !== null && opts.steps !== ''
    ? intArg(opts, 'steps', 20)
    : (modeCfg.steps ?? 20)
  const guidance = floatArg(opts, 'guidance', 3.5)
  const fps = (manifest.params?.fps?.default) || 24
  const job = {
    prompt: opts.prompt,
    width: w,
    height: h,
    length,
    seed,
    steps,
    guidance,
    fps,
    mode,
    prefix: opts.prefix || '',
    assetOverrides: getAssetOverrides(manifest.id),
  }
  if (opts.refs !== undefined) job.refs = opts.refs
  if (opts.first_frame !== undefined && opts.first_frame !== null) job.first_frame = opts.first_frame
  if (opts.last_frame !== undefined && opts.last_frame !== null) job.last_frame = opts.last_frame
  // 自动注入 manifest params 中 opts 提供的其余字段（source_video / frame_index / 未来新 param），
  // 避免新 param 漏注入（曾致 extract-frame 的 LoadVideo.file 为 null → ComfyUI 校验失败）。
  for (const pname of Object.keys(manifest.params || {})) {
    if (opts[pname] !== undefined && opts[pname] !== null && job[pname] === undefined) job[pname] = opts[pname]
  }
  const graph = buildGraphFromManifest(manifest, job)
  return { mode, job, graph }
}

/** 把画布图片节点上传到 ComfyUI，返回文件名（不存在返回 null）。 */
async function uploadCanvasNodeImage(root, project, nid) {
  const n = project.nodes.find((x) => x.id === nid)
  if (!n?.media) return null
  const absPath = join(root, ...String(n.media).split('/'))
  if (!existsSync(absPath)) return null
  const buf = await readFile(absPath)
  const up = await comfyUploadImage(buf, basename(n.media))
  return up.name
}

/** 解析参考图 → ComfyUI 文件名：资产 id（character:/scene:/style:）或画布节点 id 均可。 */
async function resolveRefImage(root, project, lib, ref) {
  if (!ref) return null
  if (isAssetRef(ref)) {
    const abs = resolveAssetImagePath(root, lib, ref)
    if (!abs) return null
    const buf = await readFile(abs)
    const up = await comfyUploadImage(buf, basename(abs))
    return up.name
  }
  return uploadCanvasNodeImage(root, project, ref)
}

/** 画布 video 节点 → 上传到 ComfyUI input（LoadVideo 只认 input 目录）→ 返回文件名。 */
async function resolveSourceVideo(root, project, ref) {
  const n = project.nodes.find((x) => x.id === ref)
  if (!n) throw new Error('extract-invalid: 画布无此节点 ' + ref)
  if (n.kind !== 'video') throw new Error(`extract-invalid: 节点 ${ref} 不是视频节点（kind=${n.kind}）`)
  if (!n.media) throw new Error('extract-invalid: 节点无媒体文件 ' + ref)
  const abs = join(root, ...String(n.media).split('/'))
  if (!existsSync(abs)) throw new Error('extract-invalid: 媒体文件不存在 ' + n.media)
  const up = await comfyUploadImage(await readFile(abs), basename(abs))
  return up.subfolder ? up.subfolder + '/' + up.name : up.name
}

/** 通用渲染：capability → manifest → 编译图 → ComfyUI → 下载 → 写画布节点。 */
async function runRender(ctx, opts) {
  const { workspaceId, exec } = opts
  const { root, sessionId } = resolveSessionRoot(ctx, opts.sessionId, workspaceId, exec)
  const project = await loadProject(root, sessionId)
  const aspectRatio = project.settings?.aspectRatio

  const registry = getRegistry()
  // 档位解析：capability + tier → 实现清单（不静默跨档替换；不可用显式报错）
  const wantTier = tierFromArgs(opts)
  const legacyMode = legacyModeFromArgs(opts)
  const resolved = await resolveTieredManifest(opts.capability, wantTier, opts.workflow, { registry })
  const manifest = resolved.manifest
  const mode = resolveMode(manifest, legacyMode || resolved.tier || (typeof opts.mode === 'string' ? opts.mode : null), {
    strict: Boolean(legacyMode || wantTier || resolved.tier),
  })
  const nodeId = opts.nodeId || randomUUID()
  const effSize = computeManifestSize(manifest, mode,
    opts.width !== undefined && opts.width !== null && opts.width !== '' ? intArg(opts, 'width', 1344) : undefined,
    opts.height !== undefined && opts.height !== null && opts.height !== '' ? intArg(opts, 'height', 768) : undefined,
    aspectRatio)
  const modeCfg = mode && manifest.modes ? (manifest.modes[mode] || {}) : {}
  const steps = opts.steps !== undefined && opts.steps !== null && opts.steps !== ''
    ? intArg(opts, 'steps', 20)
    : (modeCfg.steps ?? 20)
  const guidance = floatArg(opts, 'guidance', 3.5)

  // 上传参考图/首末帧（资产 id 或画布节点 id → ComfyUI 文件名）
  const lib = loadLibrary(root)
  const refs = []
  if (Array.isArray(opts.ref_nodes)) {
    for (const rid of opts.ref_nodes) {
      const name = await resolveRefImage(root, project, lib, rid)
      if (name) refs.push(name)
    }
  }
  const firstFrame = opts.first_frame_node ? await resolveRefImage(root, project, lib, opts.first_frame_node) : undefined
  const lastFrame = opts.last_frame_node ? await resolveRefImage(root, project, lib, opts.last_frame_node) : undefined
  const sourceVideo = opts.video_node ? await resolveSourceVideo(root, project, opts.video_node) : undefined

  const prefix = CANVAS_DIR + '/' + sessionId + '/' + nodeId
  const isImage = manifest.output?.mediaType === 'image'
  const count = isImage ? Math.min(Math.max(intArg(opts, 'count', 1), 1), 4) : 1
  const baseSeed = intArg(opts, 'seed', Math.floor(Math.random() * 2 ** 31))

  const files = []
  for (let i = 0; i < count; i++) {
    const { graph } = buildRenderGraph(manifest, {
      ...opts,
      seed: baseSeed + i,
      prefix,
      refs,
      first_frame: firstFrame,
      last_frame: lastFrame,
      source_video: sourceVideo,
      width: effSize.w,
      height: effSize.h,
    }, aspectRatio)
    const promptId = await comfySubmit(graph)
    const entry = await comfyWait(promptId, opts.signal)
    const outputs = comfyOutputs(entry)
    if (!outputs.length) throw new Error('generation-error: ComfyUI 无输出')
    for (const f of outputs) {
      const buf = await comfyDownload(f)
      files.push(await persistMedia(root, sessionId, buf, f.filename))
    }
  }

  const mediaType = manifest.output?.mediaType || (manifest.capability.startsWith('video') ? 'video' : 'image')
  const node = {
    id: nodeId,
    kind: mediaType,
    title: opts.title || manifest.displayName || (mediaType === 'video' ? '视频' : '图片'),
    media: files[0] || '',
    group: opts.group || DEFAULT_GROUP,
    params: {
      workflow: manifest.id,
      capability: manifest.capability,
      model: manifest.id,
      mode,
      tier: resolved.tier,
      accel: manifest.accel || '',
      resolution: resolved.resolution,
      seed: baseSeed,
      width: effSize.w,
      height: effSize.h,
      length: intArg(opts, 'length', 124),
      steps,
      guidance,
      fps: (manifest.params?.fps?.default) || 24,
      ref_nodes: Array.isArray(opts.ref_nodes) ? opts.ref_nodes : [],
      first_frame_node: opts.first_frame_node || null,
      last_frame_node: opts.last_frame_node || null,
      prompt: opts.prompt,
      assets: resolveAssets(manifest, getAssetOverrides(manifest.id)),
    },
    status: 'ready',
    createdAt: Date.now(),
    order: nextOrder(project.nodes),
  }
  const existing = project.nodes.findIndex((n) => n.id === nodeId)
  if (existing >= 0) { node.order = project.nodes[existing].order; node.createdAt = project.nodes[existing].createdAt; project.nodes[existing] = node }
  else project.nodes.push(node)
  await saveProject(root, sessionId, project)

  return { ok: true, node, files, tier: resolved.tier, implementation: manifest.id, resolution: resolved.resolution, warnings: resolved.warnings, ...mediaDelivery(root, node.media) }
}

/**
 * 按顺序拼接画布上的多个视频节点，产物写回画布。
 * 后端：本机有 ffmpeg 走 ffmpeg（stream copy），否则退化到 ComfyUI 纯节点链路。
 */
async function runConcat(ctx, opts) {
  const { root, sessionId } = resolveSessionRoot(ctx, opts.sessionId, opts.workspaceId, opts.exec)
  const project = await loadProject(root, sessionId)

  const ids = Array.isArray(opts.nodes) ? opts.nodes : []
  if (ids.length < 2) throw new Error('concat-invalid: nodes 至少要 2 个视频节点 id')

  // 解析素材：必须是画布上已就绪的 video 节点，且媒体文件存在
  const sources = []
  for (const id of ids) {
    const n = project.nodes.find((x) => x.id === id)
    if (!n) throw new Error('concat-invalid: 画布无此节点 ' + id)
    if (n.kind !== 'video') throw new Error(`concat-invalid: 节点 ${id} 不是视频节点（kind=${n.kind}）`)
    if (!n.media) throw new Error('concat-invalid: 节点无媒体文件 ' + id)
    const abs = join(root, ...String(n.media).split('/'))
    if (!existsSync(abs)) throw new Error('concat-invalid: 媒体文件不存在 ' + n.media)
    sources.push({ id, abs })
  }

  const nodeId = opts.nodeId || randomUUID()
  let media
  let backend
  let reencoded = false

  if (await detectFfmpeg()) {
    backend = 'ffmpeg'
    const dir = projectDir(root, sessionId)
    await mkdir(dir, { recursive: true })
    const outName = nodeId + '.mp4'
    const r = await ffmpegConcat(sources.map((s) => s.abs), join(dir, outName))
    reencoded = r.reencoded
    media = CANVAS_DIR + '/' + sessionId + '/' + outName
  } else {
    backend = 'comfyui'
    // ComfyUI 的 LoadVideo 只认 input 目录，先把每段上传（/upload/image 同时接受 mp4）
    const names = []
    for (const s of sources) {
      const uploaded = await comfyUploadImage(await readFile(s.abs), basename(s.abs))
      names.push(uploaded.subfolder ? uploaded.subfolder + '/' + uploaded.name : uploaded.name)
    }
    const graph = buildConcatGraph(names, CANVAS_DIR + '/' + sessionId + '/' + nodeId)
    const promptId = await comfySubmit(graph)
    const entry = await comfyWait(promptId, opts.signal)
    const outputs = comfyOutputs(entry)
    if (!outputs.length) throw new Error('generation-error: ComfyUI 拼接无输出')
    media = await persistMedia(root, sessionId, await comfyDownload(outputs[0]), outputs[0].filename)
  }

  const node = {
    id: nodeId,
    kind: 'video',
    title: opts.title || '拼接成片',
    media,
    group: opts.group || DEFAULT_GROUP,
    params: { backend, reencoded, sources: sources.map((s) => s.id) },
    status: 'ready',
    createdAt: Date.now(),
    order: nextOrder(project.nodes),
  }
  const existing = project.nodes.findIndex((n) => n.id === nodeId)
  if (existing >= 0) { node.order = project.nodes[existing].order; node.createdAt = project.nodes[existing].createdAt; project.nodes[existing] = node }
  else project.nodes.push(node)
  await saveProject(root, sessionId, project)

  return { ok: true, node, backend, ...mediaDelivery(root, media) }
}

// ---------------------------------------------------------------------------
// pre-ask 自动送达（飞书渠道）
// ---------------------------------------------------------------------------
// 机制：宿主每个工具执行前都过 `tools/pre-execute` waterfall（可扩展、异步、
// 按 agent scope 分发）。本插件注册一个监听器：当 agent 即将调用
// `ask_user_question` 时，先把画布中「未送达」的产物程序化调 send_file
// 送达，再放行 ask。
// - 媒体（图片/视频/音频）直接发原文件；文本/表格节点导出为 .pdf 发送
//   （puppeteer-core/Chrome 渲染 HTML→PDF；无 PDF 工具时兜底 .html）。
// - 文件名：send_file 没有 name 参数（聊天显示名 = 路径 basename），钩子把产物
//   以「节点标题」命名的副本放到 workspace 内 .delivery/<sid>/ 再发送
//   （如 主角卡.png / 简报.pdf），发完即删；副本建不出来退回原路径。
// - send_file 是 dsh-lark per-agent 注册的工具；本插件用 ctx.tools.get(name, agent)
//   探测可见性（不可见 = Web/TUI 或 sendFiles=false → 自动跳过，不推）。
// - 去重：送达成功后写回节点 params.deliveredAt；失败不标记，下次 ask 前重试。
// - 该监听器只对 ask_user_question 生效，send_file 自身执行不会递归触发。
// 开关（改这里即可整体关闭 / 关闭文本导出）：
const AUTO_DELIVER_BEFORE_ASK = true
const TEXT_NODE_EXPORT_PDF = true

/** 收集画布中尚未送达的产物（按 order 升序）。 */
function collectUndelivered(project) {
  const pending = []
  for (const n of (project?.nodes || [])) {
    if (n.status !== 'ready') continue
    if (n.params?.deliveredAt) continue
    if (n.kind === 'image' || n.kind === 'video' || n.kind === 'audio') {
      if (n.media) pending.push({ node: n, path: n.media })
    } else if (TEXT_NODE_EXPORT_PDF && (n.kind === 'text' || n.kind === 'table')) {
      if (n.file) pending.push({ node: n, path: n.file })
    }
  }
  return pending.sort((a, b) => (a.node.order || 0) - (b.node.order || 0))
}

// ---- 文本节点 markdown → HTML：渲染器在 studio/markdown.js（双端共享，与画布一致）----

/** 文本/表格节点 → 完整 HTML 文档。 */
function renderNodeHtml(title, kind, group, content) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtmlText(title)}</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:860px;margin:32px auto;padding:0 20px;color:#1f2328;line-height:1.7}
h1{font-size:1.5em;border-bottom:1px solid #e5e7eb;padding-bottom:8px}
h2,h3,h4{line-height:1.3}
table{border-collapse:collapse;width:100%;margin:12px 0}
th,td{border:1px solid #d8dee4;padding:6px 10px;text-align:left;font-size:0.92em}
th{background:#f6f8fa}
pre{background:#f6f8fa;border:1px solid #d8dee4;border-radius:6px;padding:12px;overflow-x:auto}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.9em}
blockquote{border-left:4px solid #d0d7de;margin:12px 0;padding:4px 14px;color:#57606a}
.meta{color:#6e7781;font-size:0.85em;margin-bottom:16px}
</style>
</head>
<body>
<h1>${escapeHtmlText(title)}</h1>
<p class="meta">kind: ${escapeHtmlText(kind)} · group: ${escapeHtmlText(group)}</p>
${markdownToHtml(content)}
</body>
</html>`
}

/**
 * 文本/表格节点导出交付文件：PDF 优先（puppeteer/Chrome/soffice/cupsfilter），
 * 无 PDF 工具或转换失败时兜底导出 .html。返回 { rel, ext }（失败也返回 html 兜底）。
 */
async function exportTextNode(root, sid, nodeId, title, kind, group, content, pdfTool) {
  const htmlRel = CANVAS_DIR + '/' + sid + '/' + nodeId + '.html'
  const htmlAbs = join(root, ...htmlRel.split('/'))
  await mkdir(dirname(htmlAbs), { recursive: true })
  await writeFile(htmlAbs, renderNodeHtml(title, kind, group, content), 'utf8')
  if (pdfTool) {
    try {
      const pdfRel = CANVAS_DIR + '/' + sid + '/' + nodeId + '.pdf'
      const pdfAbs = join(root, ...pdfRel.split('/'))
      await htmlToPdf(pdfTool, htmlAbs, pdfAbs)
      await unlink(htmlAbs).catch(() => {})
      return { rel: pdfRel, ext: 'pdf' }
    } catch (error) {
      console.warn('[dsh-short-video-studio] html→pdf failed, fallback .html:', error?.message || String(error))
    }
  }
  return { rel: htmlRel, ext: 'html' }
}

// ---- 交付文件名：send_file 没有 name 参数（dsh-lark 只收 {path}），
//      聊天显示名 = path 的 basename（outbound-file.ts `fileName: basename(canonical)`）。
//      因此把产物以「节点标题」命名的副本放到 workspace 内 .delivery/<sid>/，
//      发副本路径 → 飞书显示 主角卡.png / 简报.pdf，而不是内部 nodeId。发完即删。

/** workspace 内交付副本目录（隐藏目录，不参与画布伺服/资产）。 */
const DELIVERY_DIR = '.delivery'

/** 由节点派生友好文件名：`<title>.<ext>`，清理非法字符；title 为空回退 `<kind>-<nodeId前8>.<ext>`。 */
function deliveryFilename(node, path) {
  const ext = extname(path).toLowerCase()
  let base = String(node.title || '').trim()
  base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.+$/g, '').slice(0, 60)
  if (!base) base = (node.kind || 'file') + '-' + String(node.id || '').slice(0, 8)
  return base + ext
}

/**
 * 为送达建友好名副本（硬链接零拷贝，失败退复制）。同名冲突加 -2/-3 后缀。
 * 副本建不出来返回 null（调用方退回原路径发送，不阻塞送达）。
 * @returns {{rel:string, abs:string}|null} 副本的 workspace 相对路径与绝对路径
 */
async function stageDeliveryFile(root, sid, item) {
  const name = deliveryFilename(item.node, item.path)
  if (name === basename(item.path)) return null // 原名已是友好名
  const srcAbs = join(root, ...item.path.split('/'))
  const relDir = DELIVERY_DIR + '/' + sid
  const dirAbs = join(root, ...relDir.split('/'))
  await mkdir(dirAbs, { recursive: true })
  let rel = relDir + '/' + name
  let abs = join(dirAbs, name)
  const stem = name.replace(/\.[^.]*$/, '')
  const ext = extname(name)
  let i = 2
  while (existsSync(abs)) {
    rel = relDir + '/' + `${stem}-${i}${ext}`
    abs = join(dirAbs, `${stem}-${i}${ext}`)
    i++
  }
  try {
    await link(srcAbs, abs)
  } catch {
    try { await copyFile(srcAbs, abs) } catch { return null }
  }
  return { rel, abs }
}

/**
 * 把 pending 列表逐个经 send_file 送达（友好文件名副本）；成功者打 deliveredAt 标记，
 * 失败者记 deliveryError（下次 ask 前会重试，模型可用 canvas_get_node 查原因）。
 * 失败只 console.warn（不阻塞 ask）。返回 { sent, errored }。
 */
async function deliverPending(ctx, exec, root, sid, project, pending) {
  let sent = 0
  let errored = 0
  for (const item of pending) {
    const n = project.nodes.find((x) => x.id === item.node.id)
    let staged = null
    try {
      staged = await stageDeliveryFile(root, sid, item)
      await ctx.tools.execute({
        name: 'send_file',
        arguments: { path: staged ? staged.rel : item.path },
        agent: exec.agent,
        signal: exec.signal,
      })
      if (n) n.params = { ...(n.params || {}), deliveredAt: Date.now() }
      sent++
    } catch (error) {
      if (n) n.params = { ...(n.params || {}), deliveryError: String(error?.message || error) }
      errored++
      console.warn(`[dsh-short-video-studio] pre-ask deliver failed for ${item.path}:`, error?.message || String(error))
    } finally {
      if (staged) await unlink(staged.abs).catch(() => {})
    }
  }
  if (sent > 0 || errored > 0) await saveProject(root, sid, project)
  return { sent, errored }
}

/**
 * 构造 tools/pre-execute 监听器：只拦 ask_user_question；当前 agent scope 可见
 * send_file 时（飞书渠道），先把画布未送达产物送达，再放行 ask。
 * 任何异常都不阻塞 ask（只 warn）。
 */
function makePreAskDeliverListener(ctx) {
  return async function preAskDeliverListener(exec, next) {
    if (!AUTO_DELIVER_BEFORE_ASK || exec?.name !== 'ask_user_question') return next()
    try {
      const agent = exec.agent
      if (!agent || typeof ctx.tools?.get !== 'function') return next()
      // 渠道探测：当前 agent scope 看不到 send_file（Web/TUI，或飞书 sendFiles=false）→ 不推送
      if (!ctx.tools.get('send_file', agent)) return next()
      const sid = agent.id
      const { root } = resolveSessionRoot(ctx, sid, '', exec)
      const project = await loadProject(root, sid)
      const pending = collectUndelivered(project)
      if (pending.length > 0) await deliverPending(ctx, exec, root, sid, project, pending)
    } catch (error) {
      console.warn('[dsh-short-video-studio] pre-ask deliver skipped:', error?.message || String(error))
    }
    return next()
  }
}

// ---------------------------------------------------------------------------
// H3 结构化 prompt 质检门（tools/pre-execute 兜底）
// ---------------------------------------------------------------------------
// 机制：宿主每个工具执行前都过 `tools/pre-execute` waterfall。本监听器对
// 视频生成工具（comfy_generate_video / comfy_render）做 H3 结构化 prompt 校验：
// - 仅当解析出的工作流 id 前缀为 minimax-h3- 时启用（模型无关：其他工作流直接放行）；
// - 参考绑定镜（video.reference2video）要求 Ref2VA 六段式字段齐全；
//   首末帧串联镜 / 转场镜（video.image2video）要求 I2VA/FL2VA 三段式 + 对齐指令；
// - 不满足 → deny，reason 列出缺失字段并指引加载 h3-prompt-writing skill 重写；
// - 防死循环：同一 agent 连续 deny ≥ H3_GATE_MAX_DENIES 次后降级放行（不无限打回）。
// 开关（改这里即可整体关闭）：
const H3_PROMPT_GATE = true
const H3_GATE_MAX_DENIES = 2
const H3_WORKFLOW_PREFIX = 'minimax-h3-'
const H3_REF2V_SECTIONS = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music']
const H3_I2V_SECTIONS = ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music']
const h3GateDenies = new Map() // agentId -> 连续 deny 次数

/** prompt 是否已含某 H3 字段标题（行首 `<字段>:`）。 */
function h3HasSection(prompt, section) {
  return new RegExp(`(^|\\n)\\s*${section}\\s*:`, 'm').test(prompt)
}

/**
 * 构造 tools/pre-execute 监听器：只拦 H3 系工作流的视频生成；校验结构化字段，
 * 缺失则 deny 引导（防死循环上限后降级放行）。任何异常都放行（不阻塞生成）。
 */
function makeH3PromptGateListener(ctx) {
  return async function h3PromptGateListener(exec, next) {
    try {
      if (!H3_PROMPT_GATE || !exec?.arguments) return next()
      const name = exec.name
      const args = exec.arguments
      // 定位 capability
      let capability = null
      if (name === 'comfy_generate_video') {
        capability = args.first_frame_node || args.last_frame_node ? 'video.image2video' : 'video.reference2video'
      } else if (name === 'comfy_render' && typeof args.capability === 'string') {
        capability = args.capability
      } else {
        return next()
      }
      if (!capability || !String(capability).startsWith('video.')) return next()
      const prompt = typeof args.prompt === 'string' ? args.prompt : ''
      if (!prompt.trim()) return next()
      // 显式回退通道：skill 失败回退时在 prompt 首行加 [PROMPT_FALLBACK]，质检门放行
      // （结构化重写质量倒退 → 该镜回退自由格式时使用，避免被误拦）。
      if (/^\s*\[PROMPT_FALLBACK\]/.test(prompt)) return next()
      // 解析工作流 id（显式 workflow > preferred > 任意清单）；解析失败放行
      let manifest
      try {
        manifest = resolveManifest(getRegistry(), capability, typeof args.workflow === 'string' ? args.workflow : undefined)
      } catch {
        return next()
      }
      if (!manifest || typeof manifest.id !== 'string' || !manifest.id.startsWith(H3_WORKFLOW_PREFIX)) return next()
      // 结构校验
      const isI2V = capability === 'video.image2video'
      const required = isI2V ? H3_I2V_SECTIONS : H3_REF2V_SECTIONS
      const missing = required.filter((s) => !h3HasSection(prompt, s))
      if (isI2V && !/For the target video|How the reference pictures align/.test(prompt)) missing.unshift('对齐指令（For the target video… / How the reference pictures align…）')
      if (missing.length === 0) {
        h3GateDenies.delete(exec.agent?.id || 'unknown')
        return next()
      }
      // 防死循环：连续 deny 超上限 → 降级放行
      const key = exec.agent?.id || 'unknown'
      const denies = (h3GateDenies.get(key) || 0) + 1
      h3GateDenies.set(key, denies)
      if (denies > H3_GATE_MAX_DENIES) return next()
      const expect = isI2V
        ? 'I2VA/FL2VA 三段式（对齐指令 + integrated_multimodal_description + overall_soundscape + non_diegetic_music）'
        : 'Ref2VA 六段式（subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music）'
      return {
        kind: 'deny',
        reason: `H3 结构化 prompt 校验未通过，缺失：${missing.join(' / ')}。请调用 skill 工具加载 h3-prompt-writing，按它的 references/studio-mapping.md 把本镜 prompt 重写为 ${expect} 后重新调用。`,
      }
    } catch {
      return next()
    }
  }
}

// ---------------------------------------------------------------------------
// Agent 工具（原生 ToolDefinition，parameters 用 JSON Schema）
// ---------------------------------------------------------------------------

function makeTools() {
  const imageTool = {
    name: 'comfy_generate_image',
    description:
      '用 ComfyUI 的 FLUX 模型生成图片（默认 flux2_dev，16:9）。产物写入会话画布并返回节点 id 与媒体相对路径（在「画布」tab 可见）。用于角色卡、场景卡、铅笔分镜等图片资产。触发词：生成图片/角色卡/场景卡/分镜图。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片提示词（含风格、角色/场景描述、负向约束）。' },
        width: { type: 'integer', description: '宽，默认 1344。' },
        height: { type: 'integer', description: '高，默认 768。' },
        seed: { type: 'integer', description: '随机种子（可选，缺省随机）。' },
        steps: { type: 'integer', description: '采样步数，默认 20。' },
        guidance: { type: 'number', description: '引导强度，默认 3.5。' },
        count: { type: 'integer', description: '生成张数（1–4，默认 1）。' },
        title: { type: 'string', description: '画布节点标题，如「主角卡」。' },
        group: { type: 'string', description: '画布分组（自由字符串，由流程 skill 定义；缺省 ungrouped）。' },
        nodeId: { type: 'string', description: '复用节点 id（更新而非新增）。' },
        sessionId: { type: 'string', description: '会话 id（缺省取当前 agent 会话）。' },
        workspaceId: { type: 'string', description: '工作区 id（缺省自动解析）。' },
      },
      required: ['prompt'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, nodeId: { type: 'string' }, media: { type: 'string' }, absPath: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'number' }, error: { type: 'string' } } },
      render: (_args, value) => text(value.ok
        ? `已生成图片节点 ${value.nodeId}\n${mediaResultDetail(value)}`
        : `生成失败: ${value.error}`),
    },
    async execute(args, exec) {
      try {
        const r = await runRender(ctx, { ...args, capability: 'image.text2image', exec })
        return { ok: true, nodeId: r.node.id, media: r.node.media, absPath: r.absPath, mediaType: r.mediaType, bytes: r.bytes, error: '' }
      } catch (error) {
        return { ok: false, nodeId: '', media: '', absPath: '', mediaType: '', bytes: 0, error: error?.message || String(error) }
      }
    },
  }

  const videoTool = {
    name: 'comfy_generate_video',
    description:
      '用 ComfyUI 的 MiniMax H3 音视频模型生成单镜头视频（带声音）。两种路径：传 first_frame_node/last_frame_node（画布图片节点）→ 用 ImageToVideo 做首/末帧串联（同场景续接，身份/环境由首帧继承，改善过渡）；不传 → 用 ReferenceToVideo 并支持 ref_nodes（角色/场景卡）作参考绑定。**档位用 tier**（fast 调试 / balanced 日常 / quality 成片），由注册表解析到具体实现——不会静默跨档替换，所选实现不可用会显式报错。产物写入画布并返回节点 id + 媒体相对路径。用于单镜头视频。触发词：生成视频/单镜头/片段。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频提示词（含每秒动作、镜头运动、说话人绑定等）。' },
        tier: { type: 'string', enum: TIERS, description: '档位：一个能力支持哪些档、每档意味着什么（分辨率/步数/加速件/耗时）由注册表决定，**以 comfy_list_workflows 为准**，不要预设。缺省 quality。' },
        mode: { type: 'string', description: '兼容旧参数：fast/balanced/quality 等同 tier；其它名字按旧清单的自定义 mode 处理。' },
        ref_nodes: { type: 'array', items: { type: 'string' }, description: '参考图：画布图片节点 id 或资产 id（character:luna / scene:bridge，跨会话复用）。绑定身份/环境（一致性）。与 first/last_frame 二选一。' },
        first_frame_node: { type: 'string', description: '首帧：画布图片节点 id 或资产 id（末帧串联：传上一镜末帧来接续）。' },
        last_frame_node: { type: 'string', description: '末帧：画布图片节点 id 或资产 id（供下一镜首帧串联）。' },
        width: { type: 'integer', description: '宽，显式传入则优先采用（snap 到 32 倍数）；缺省按画布 aspectRatio 推导，默认 1344。fast/quality 均支持任意比例。' },
        height: { type: 'integer', description: '高，显式传入则优先采用（snap 到 32 倍数）；缺省按画布 aspectRatio 推导，默认 768。fast/quality 均支持任意比例。' },
        length: { type: 'integer', description: '帧数（24fps；124≈5s，步进 17）。默认 124。' },
        seed: { type: 'integer', description: '随机种子（可选）。' },
        steps: { type: 'integer', description: '采样步数，默认 20（fast 档强制 4）。' },
        title: { type: 'string', description: '画布节点标题，如「S01 片段」。' },
        group: { type: 'string', description: '画布分组（自由字符串，由流程 skill 定义；缺省 ungrouped）。' },
        nodeId: { type: 'string', description: '复用节点 id。' },
        sessionId: { type: 'string', description: '会话 id（缺省取当前 agent 会话）。' },
        workspaceId: { type: 'string', description: '工作区 id（缺省自动解析）。' },
      },
      required: ['prompt'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, nodeId: { type: 'string' }, media: { type: 'string' }, absPath: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'number' }, tier: { type: 'string' }, implementation: { type: 'string' }, resolution: { type: 'string' }, warnings: { type: 'array', items: { type: 'string' } }, error: { type: 'string' } } },
      render: (_args, value) => text(value.ok
        ? `已生成视频节点 ${value.nodeId}${renderResolutionNote(value)}\n${mediaResultDetail(value)}`
        : `生成失败: ${value.error}`),
    },
    async execute(args, exec) {
      try {
        const chaining = Boolean(args.first_frame_node || args.last_frame_node)
        const capability = chaining ? 'video.image2video' : 'video.reference2video'
        const r = await runRender(ctx, { ...args, capability, exec })
        return { ok: true, nodeId: r.node.id, media: r.node.media, absPath: r.absPath, mediaType: r.mediaType, bytes: r.bytes, tier: r.tier || '', implementation: r.implementation || '', resolution: r.resolution || '', warnings: r.warnings || [], error: '' }
      } catch (error) {
        return { ok: false, nodeId: '', media: '', absPath: '', mediaType: '', bytes: 0, tier: '', implementation: '', resolution: '', warnings: [], error: error?.message || String(error) }
      }
    },
  }

  const listNodesTool = {
    name: 'canvas_list_nodes',
    description: '列出会话画布的所有节点（含分组、状态、媒体相对路径）。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id。' },
        workspaceId: { type: 'string', description: '工作区 id。' },
      },
      required: [],
    },
    output: {
      schema: { type: 'object', properties: { nodes: { type: 'array', items: { type: 'object' } } } },
      render: (_args, value) => text((value.nodes || []).map((n) => `${n.kind}\t${n.group}\t${n.id}\t${n.title}\t${n.status}`).join('\n') || '(空画布)'),
    },
    async execute(args, exec) {
      const sid = args.sessionId || exec?.agent?.id
      const { root } = resolveSessionRoot(ctx, sid, args.workspaceId, exec)
      const project = await loadProject(root, sid)
      return { nodes: project.nodes }
    },
  }

  const writeNodeTool = {
    name: 'canvas_write_node',
    description: '在会话画布写入/更新文本或表格节点（项目简报、故事大纲、七列镜头表、文本分镜等）。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: '节点类型：text / table。' },
        title: { type: 'string', description: '节点标题。' },
        content: { type: 'string', description: '文本/markdown 内容。' },
        group: { type: 'string', description: '分组。' },
        nodeId: { type: 'string', description: '复用节点 id（更新而非新增）。' },
        sessionId: { type: 'string', description: '会话 id。' },
        workspaceId: { type: 'string', description: '工作区 id。' },
      },
      required: ['kind', 'title', 'content'],
    },
    output: {
      schema: { type: 'object', properties: { nodeId: { type: 'string' }, error: { type: 'string' } } },
      render: (_args, value) => text(value.error ? '写入失败: ' + value.error : '已写入画布节点 ' + value.nodeId),
    },
    async execute(args, exec) {
      try {
        const sid = args.sessionId || exec?.agent?.id
        const { root } = resolveSessionRoot(ctx, sid, args.workspaceId, exec)
        const project = await loadProject(root, sid)
        const nodeId = args.nodeId || randomUUID()
        const node = {
          id: nodeId,
          kind: args.kind === 'table' ? 'table' : 'text',
          title: args.title,
          content: args.content,
          group: args.group || DEFAULT_GROUP,
          status: 'ready',
          createdAt: Date.now(),
          order: nextOrder(project.nodes),
        }
        // 文本/表格节点导出交付文件：PDF 优先（puppeteer/Chrome），无工具兜底 .html
        // （随 pre-ask 钩子送达飞书；失败不阻塞画布写入）
        if (TEXT_NODE_EXPORT_PDF) {
          try {
            const pdfTool = await detectPdfTool()
            const out = await exportTextNode(root, sid, nodeId, args.title, node.kind, node.group || DEFAULT_GROUP, args.content, pdfTool)
            node.file = out.rel
          } catch (error) {
            console.warn('[dsh-short-video-studio] text node export failed:', error?.message || String(error))
          }
        }
        const existing = project.nodes.findIndex((n) => n.id === nodeId)
        if (existing >= 0) { node.order = project.nodes[existing].order; node.createdAt = project.nodes[existing].createdAt; project.nodes[existing] = node }
        else project.nodes.push(node)
        await saveProject(root, sid, project)
        return { nodeId, error: '' }
      } catch (error) {
        return { nodeId: '', error: error?.message || String(error) }
      }
    },
  }

  const getNodeTool = {
    name: 'canvas_get_node',
    description: '读取会话画布单个节点。',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: '节点 id。' },
        sessionId: { type: 'string', description: '会话 id。' },
        workspaceId: { type: 'string', description: '工作区 id。' },
      },
      required: ['nodeId'],
    },
    output: {
      schema: { type: 'object', properties: { node: { type: 'object' } } },
      render: (_args, value) => text(value.node ? `${value.node.kind}\t${value.node.id}\t${value.node.title}\n${value.node.content || value.node.media || ''}` : '(未找到)'),
    },
    async execute(args, exec) {
      const sid = args.sessionId || exec?.agent?.id
      const { root } = resolveSessionRoot(ctx, sid, args.workspaceId, exec)
      const project = await loadProject(root, sid)
      const node = project.nodes.find((n) => n.id === args.nodeId) || {}
      return { node }
    },
  }

  const groupTool = {
    name: 'canvas_group_nodes',
    description: '把画布多个节点归到同一分组。',
    parameters: {
      type: 'object',
      properties: {
        nodeIds: { type: 'array', items: { type: 'string' }, description: '节点 id 列表。' },
        group: { type: 'string', description: '目标分组。' },
        sessionId: { type: 'string', description: '会话 id。' },
        workspaceId: { type: 'string', description: '工作区 id。' },
      },
      required: ['nodeIds', 'group'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' } } },
      render: (_args, value) => text(value.ok ? '已分组' : '分组失败: ' + value.error),
    },
    async execute(args, exec) {
      try {
        const sid = args.sessionId || exec?.agent?.id
        const { root } = resolveSessionRoot(ctx, sid, args.workspaceId, exec)
        const project = await loadProject(root, sid)
        for (const n of project.nodes) if ((args.nodeIds || []).includes(n.id)) n.group = args.group
        await saveProject(root, sid, project)
        return { ok: true, error: '' }
      } catch (error) {
        return { ok: false, error: error?.message || String(error) }
      }
    },
  }

  const reorderTool = {
    name: 'canvas_reorder',
    description: '按给定节点 id 顺序重排画布（未列出的节点按原顺序排到末尾）。',
    parameters: {
      type: 'object',
      properties: {
        nodeIds: { type: 'array', items: { type: 'string' }, description: '新顺序节点 id 列表。' },
        sessionId: { type: 'string', description: '会话 id。' },
        workspaceId: { type: 'string', description: '工作区 id。' },
      },
      required: ['nodeIds'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' } } },
      render: (_args, value) => text(value.ok ? '已重排' : '重排失败: ' + value.error),
    },
    async execute(args, exec) {
      try {
        const sid = args.sessionId || exec?.agent?.id
        const { root } = resolveSessionRoot(ctx, sid, args.workspaceId, exec)
        const project = await loadProject(root, sid)
        const ids = args.nodeIds || []
        const byId = new Map(project.nodes.map((n) => [n.id, n]))
        const ordered = []
        for (const id of ids) { const n = byId.get(id); if (n) { ordered.push(n); byId.delete(id) } }
        for (const n of project.nodes) if (byId.has(n.id)) ordered.push(n)
        ordered.forEach((n, i) => { n.order = i })
        project.nodes = ordered
        await saveProject(root, sid, project)
        return { ok: true, error: '' }
      } catch (error) {
        return { ok: false, error: error?.message || String(error) }
      }
    },
  }

  const stateTool = {
    name: 'canvas_get_state',
    description: '读取会话画布的项目设置（画幅/时长/音频模式/生成模式/分组展示顺序）。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '会话 id。' },
        workspaceId: { type: 'string', description: '工作区 id。' },
      },
      required: [],
    },
    output: {
      schema: { type: 'object', properties: { settings: { type: 'object' } } },
      render: (_args, value) => text(JSON.stringify(value.settings || {})),
    },
    async execute(args, exec) {
      const sid = args.sessionId || exec?.agent?.id
      const { root } = resolveSessionRoot(ctx, sid, args.workspaceId, exec)
      const project = await loadProject(root, sid)
      return { settings: project.settings || {} }
    },
  }

  const setStateTool = {
    name: 'canvas_set_state',
    description: '写入会话画布的项目设置（画幅/时长/音频模式/生成模式/分组展示顺序）。用于持久化流程 skill 的开场选择。',
    parameters: {
      type: 'object',
      properties: {
        aspectRatio: { type: 'string', description: '画面比例，如 16:9 / 9:16 / 1:1。' },
        duration: { type: 'string', description: '总时长，如 30 秒。' },
        audioMode: { type: 'string', enum: ['silent', 'dialogue-led', 'narration-led'], description: '音频模式。' },
        mode: { type: 'string', enum: TIERS, description: '生成档位（画布项目设置）：项目默认档位；工具条与技能按此默认值预选。各档语义见 comfy_list_workflows（不要预设档位含义）。' },
        groupOrder: {
          type: 'array',
          items: { type: 'string' },
          description: '画布分组的展示顺序（分组名由流程 skill 自由定义）。画布按此顺序渲染分组；未列出的分组排在其后、按首次出现顺序。流程 skill 应在开场一次性声明。',
        },
        sessionId: { type: 'string', description: '会话 id。' },
        workspaceId: { type: 'string', description: '工作区 id。' },
      },
      required: [],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, error: { type: 'string' } } },
      render: (_args, value) => text(value.ok ? '已保存画布设置' : '保存失败: ' + value.error),
    },
    async execute(args, exec) {
      try {
        const sid = args.sessionId || exec?.agent?.id
        const { root } = resolveSessionRoot(ctx, sid, args.workspaceId, exec)
        const project = await loadProject(root, sid)
        project.settings = {
          ...project.settings,
          aspectRatio: args.aspectRatio ?? project.settings.aspectRatio,
          duration: args.duration ?? project.settings.duration,
          audioMode: args.audioMode ?? project.settings.audioMode,
          mode: args.mode ?? project.settings.mode,
          groupOrder: Array.isArray(args.groupOrder)
            ? args.groupOrder.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim())
            : project.settings.groupOrder,
        }
        await saveProject(root, sid, project)
        return { ok: true, error: '' }
      } catch (error) {
        return { ok: false, error: error?.message || String(error) }
      }
    },
  }

  const renderTool = {
    name: 'comfy_render',
    description:
      '通用渲染入口（模型/工作流无关）：按 capability + tier 调用注册表解析出的实现。显式 workflow 可指定实现（最高优先）。产物写入画布。触发词：生成/渲染。',
    parameters: {
      type: 'object',
      properties: {
        capability: { type: 'string', enum: CAPABILITIES, description: '能力（见 comfy_list_workflows）。' },
        workflow: { type: 'string', description: '显式指定工作流 id（最高优先；其档位与 tier 不符会报错，不静默替换）。' },
        tier: { type: 'string', enum: TIERS, description: '档位（见 comfy_list_workflows；缺省 quality）。' },
        mode: { type: 'string', description: '兼容旧参数：fast/balanced/quality 等同 tier；其它名字按旧清单的自定义 mode 处理。' },
        prompt: { type: 'string', description: '提示词。' },
        width: { type: 'integer', description: '宽（可选，缺省按能力/画布推导）。' },
        height: { type: 'integer', description: '高（可选，缺省按能力/画布推导）。' },
        length: { type: 'integer', description: '帧数（视频，默认 124）。' },
        seed: { type: 'integer', description: '随机种子（可选）。' },
        steps: { type: 'integer', description: '采样步数（缺省取 mode 声明的 steps）。' },
        guidance: { type: 'number', description: '引导强度。' },
        count: { type: 'integer', description: '图片张数（1–4，默认 1）。' },
        ref_nodes: { type: 'array', items: { type: 'string' }, description: '参考图：画布图片节点 id 或资产 id（character:luna / scene:bridge）。' },
        first_frame_node: { type: 'string', description: '首帧（画布图片节点 id 或资产 id）。' },
        last_frame_node: { type: 'string', description: '末帧（画布图片节点 id 或资产 id）。' },
        title: { type: 'string', description: '画布节点标题。' },
        group: { type: 'string', description: '画布分组。' },
        nodeId: { type: 'string', description: '复用节点 id。' },
        sessionId: { type: 'string', description: '会话 id。' },
        workspaceId: { type: 'string', description: '工作区 id。' },
      },
      required: ['capability', 'prompt'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, nodeId: { type: 'string' }, media: { type: 'string' }, absPath: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'number' }, tier: { type: 'string' }, implementation: { type: 'string' }, resolution: { type: 'string' }, warnings: { type: 'array', items: { type: 'string' } }, error: { type: 'string' } } },
      render: (_args, value) => text(value.ok
        ? `已渲染节点 ${value.nodeId}${renderResolutionNote(value)}\n${mediaResultDetail(value)}`
        : `渲染失败: ${value.error}`),
    },
    async execute(args, exec) {
      try {
        const r = await runRender(ctx, { ...args, exec })
        return { ok: true, nodeId: r.node.id, media: r.node.media, absPath: r.absPath, mediaType: r.mediaType, bytes: r.bytes, tier: r.tier || '', implementation: r.implementation || '', resolution: r.resolution || '', warnings: r.warnings || [], error: '' }
      } catch (error) {
        return { ok: false, nodeId: '', media: '', absPath: '', mediaType: '', bytes: 0, tier: '', implementation: '', resolution: '', warnings: [], error: error?.message || String(error) }
      }
    },
  }

  const concatTool = {
    name: 'video_concat',
    description:
      '按给定顺序把画布上的多个视频节点拼接成一条完整成片，产物写回画布。后端自动选择：本机有 ffmpeg 走 ffmpeg（零重编码、秒级），否则退化到 ComfyUI 纯节点链路（无需任何本地二进制）。只做硬切，不做转场。触发词：拼接/合成全片/连成一条。',
    parameters: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          items: { type: 'string' },
          description: '要拼接的画布视频节点 id，按成片顺序排列（至少 2 个）。',
        },
        title: { type: 'string', description: '画布节点标题，如「拼接成片」。' },
        group: { type: 'string', description: '画布分组（自由字符串，由流程 skill 定义；缺省 ungrouped）。' },
        nodeId: { type: 'string', description: '复用节点 id。' },
        sessionId: { type: 'string', description: '会话 id（缺省取当前 agent 会话）。' },
        workspaceId: { type: 'string', description: '工作区 id（缺省自动解析）。' },
      },
      required: ['nodes'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, nodeId: { type: 'string' }, media: { type: 'string' }, absPath: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'number' }, backend: { type: 'string' }, error: { type: 'string' } },
      },
      render: (_args, value) => text(value.ok
        ? `已拼接节点 ${value.nodeId}（后端 ${value.backend}）\n${mediaResultDetail(value)}`
        : `拼接失败: ${value.error}`),
    },
    async execute(args, exec) {
      try {
        const r = await runConcat(ctx, { ...args, exec })
        return { ok: true, nodeId: r.node.id, media: r.node.media, absPath: r.absPath, mediaType: r.mediaType, bytes: r.bytes, backend: r.backend, error: '' }
      } catch (error) {
        return { ok: false, nodeId: '', media: '', absPath: '', mediaType: '', bytes: 0, backend: '', error: error?.message || String(error) }
      }
    },
  }

  const extractFrameTool = {
    name: 'extract_frame',
    description:
      '从画布上的视频节点抽取一帧存为画布图片节点（默认末帧）。用途：① 同场景续接镜——抽上一镜末帧作 comfy_generate_video 的 first_frame_node；② 跨场景转场镜——抽前一镜末帧 + 后一镜首帧，作首末帧生成一个真实的过渡镜头。触发词：抽帧/取末帧/取首帧。',
    parameters: {
      type: 'object',
      properties: {
        video_node: { type: 'string', description: '来源视频节点的画布 id。' },
        frame_index: {
          type: 'integer',
          description: '帧序号。负数从末尾数：-1 = 末帧（默认），0 = 首帧。',
        },
        title: { type: 'string', description: '画布节点标题，如「S03 末帧」。' },
        group: { type: 'string', description: '画布分组（自由字符串，由流程 skill 定义；缺省 ungrouped）。' },
        nodeId: { type: 'string', description: '复用节点 id。' },
        sessionId: { type: 'string', description: '会话 id（缺省取当前 agent 会话）。' },
        workspaceId: { type: 'string', description: '工作区 id（缺省自动解析）。' },
      },
      required: ['video_node'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, nodeId: { type: 'string' }, media: { type: 'string' }, absPath: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'number' }, error: { type: 'string' } } },
      render: (_args, value) => text(value.ok ? `已抽帧节点 ${value.nodeId}\n${mediaResultDetail(value)}` : `抽帧失败: ${value.error}`),
    },
    async execute(args, exec) {
      try {
        const r = await runRender(ctx, {
          ...args,
          capability: 'image.from_video',
          frame_index: args.frame_index === undefined ? -1 : args.frame_index,
          exec,
        })
        return { ok: true, nodeId: r.node.id, media: r.node.media, absPath: r.absPath, mediaType: r.mediaType, bytes: r.bytes, error: '' }
      } catch (error) {
        return { ok: false, nodeId: '', media: '', absPath: '', mediaType: '', bytes: 0, error: error?.message || String(error) }
      }
    },
  }

  const listWorkflowsTool = {
    name: 'comfy_list_workflows',
    description: '列出可用的生成能力、档位与实现（含组、策略投影、可用性与实测耗时），供选择档位或显式指定 workflow/tier。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'object', properties: { capabilities: { type: 'array', items: { type: 'object' } } } },
      render: (_args, value) => text((value.capabilities || []).map((c) => {
        if (!c.tiered) {
          const ws = (c.workflows || []).filter((w) => !w.internal)
          return `${c.capability}（未分档）默认=${c.default}\n  ` + (ws.map((w) => `${w.id}${w.modes && w.modes.length ? `[${w.modes.join('/')}]` : ''}`).join(', ') || '(无)')
        }
        const lines = [`${c.capability}\t档位=${(c.tiers || []).join(' / ')}\t选择=${(c.tiers || []).map((t) => `${t}:${(c.selection || {})[t] || '(默认)'}`).join(' ')}`]
        for (const g of c.groups || []) {
          for (const [tier, list] of Object.entries(g.tiers || {})) {
            for (const w of list) {
              const av = w.available === true ? '✓可用' : w.available === false ? `✗缺节点(${w.missingNodes.join(',')})` : '?未知(ComfyUI 未连接)'
              lines.push(`  [${tier}] ${w.id}${w.accel ? ` · 加速=${w.accel}` : ''} ${av}${w.estSeconds ? ` · ${w.estSeconds}s` : ''}${w.note ? ` · ${w.note}` : ''}`)
            }
          }
          for (const s of g.strategies || []) {
            lines.push(`  策略「${s.label}」= ` + Object.entries(s.tiers || {}).map(([t, id]) => `${t}→${id}`).join(' '))
          }
        }
        if ((c.unclassified || []).length) lines.push(`  未分级（不可用于档位解析，只能显式 workflow=）：` + c.unclassified.map((w) => w.id).join(', '))
        return lines.join('\n')
      }).join('\n') || '(无工作流)'),
    },
    async execute() {
      const registry = getRegistry()
      const matrix = await describeTierMatrix(registry)
      const capabilities = Object.entries(registry.byCapability).map(([cap, ms]) => {
        const preferred = getPreferred(cap)
        const m = matrix[cap] || {}
        return {
          capability: cap,
          default: preferred[0] || (ms[0] && ms[0].id) || '',
          tiered: Boolean(m.tiered),
          tiers: m.tiers || [],
          selection: m.selection || {},
          groups: m.groups || [],
          unclassified: m.unclassified || [],
          workflows: ms.map((w) => ({
            id: w.id,
            displayName: w.displayName || w.id,
            modes: Object.keys(w.modes || {}),
            tier: w.tier || '',
            group: groupNameOf(w),
            accel: w.accel || '',
            internal: Boolean(w.internal),
            requiresNodes: w.requiresNodes || [],
            estSeconds: Number.isFinite(w.estSeconds) ? w.estSeconds : null,
            output: w.output || {},
            constraints: w.constraints || {},
          })),
        }
      })
      return { capabilities }
    },
  }

  const assetListTool = {
    name: 'asset_list',
    description:
      '列出跨会话资产库中的角色卡/场景卡/风格锚点（供复用，避免重复生成）。返回稳定资产 id（如 character:luna），可用 ref_nodes 直接引用。触发词：资产库/已有角色/已有场景/复用。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ASSET_TYPES, description: '按类型过滤（character/scene/style）。' },
        query: { type: 'string', description: '按 name/state/tags 模糊匹配（可选）。' },
        sessionId: { type: 'string', description: '会话 id（缺省取当前 agent 会话）。' },
        workspaceId: { type: 'string', description: '工作区 id（缺省自动解析）。' },
      },
      required: [],
    },
    output: {
      schema: { type: 'object', properties: { assets: { type: 'array', items: { type: 'object' } } } },
      render: (_args, value) => text((value.assets || []).map((a) =>
        `${a.id}\t${a.state}\t${a.name}${a.tags && a.tags.length ? '\t[' + a.tags.join(',') + ']' : ''}`
      ).join('\n') || '(资产库为空)'),
    },
    async execute(args, exec) {
      const sid = args.sessionId || exec?.agent?.id
      const { root } = resolveSessionRoot(ctx, sid, args.workspaceId, exec)
      const lib = loadLibrary(root)
      let list = Object.values(lib.assets)
      if (args.type) list = list.filter((a) => a.type === args.type)
      if (args.query) {
        const q = String(args.query).toLowerCase()
        list = list.filter((a) =>
          (a.name && String(a.name).toLowerCase().includes(q)) ||
          (a.state && String(a.state).toLowerCase().includes(q)) ||
          (a.id && String(a.id).toLowerCase().includes(q)) ||
          (Array.isArray(a.tags) && a.tags.some((t) => String(t).toLowerCase().includes(q))))
      }
      return { assets: list }
    },
  }

  const assetToCanvasTool = {
    name: 'asset_to_canvas',
    description:
      '把资产库中的角色卡/场景卡物化为当前会话画布节点（复用资产时，卡片仍要出现在画布）。拷贝库图到会话画布并创建 image 节点，返回节点 id。之后 ref_nodes 可传该节点 id 或资产 id。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '资产 id（如 character:luna）。' },
        title: { type: 'string', description: '画布节点标题（缺省用资产名）。' },
        group: { type: 'string', description: '画布分组（自由字符串，由流程 skill 定义；缺省 ungrouped）。' },
        nodeId: { type: 'string', description: '复用节点 id。' },
        sessionId: { type: 'string', description: '会话 id（缺省取当前 agent 会话）。' },
        workspaceId: { type: 'string', description: '工作区 id（缺省自动解析）。' },
      },
      required: ['id'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, nodeId: { type: 'string' }, media: { type: 'string' }, error: { type: 'string' } } },
      render: (_args, value) => text(value.ok ? '已物化画布节点 ' + value.nodeId : '物化失败: ' + value.error),
    },
    async execute(args, exec) {
      try {
        const sid = args.sessionId || exec?.agent?.id
        const { root } = resolveSessionRoot(ctx, sid, args.workspaceId, exec)
        const node = await copyAssetToCanvas(root, sid, args.id, { title: args.title, group: args.group, nodeId: args.nodeId })
        return { ok: true, nodeId: node.id, media: node.media, error: '' }
      } catch (error) {
        return { ok: false, nodeId: '', media: '', error: error?.message || String(error) }
      }
    },
  }

  return [imageTool, videoTool, renderTool, concatTool, extractFrameTool, listWorkflowsTool, listNodesTool, writeNodeTool, getNodeTool, groupTool, reorderTool, stateTool, setStateTool, assetListTool, assetToCanvasTool]
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

function makeRoutes(runtime) {
  const apiPrefix = ROUTE_ROOT + '/api'

  /** 从 query 解析 workspace（显式 workspaceId 优先，否则按 session 成员扫描）。 */
  function resolveFromQuery(ctx, url) {
    const sessionId = url.searchParams.get('sessionId')?.trim()
    const workspaceId = url.searchParams.get('workspaceId')?.trim()
    if (!sessionId) throw HttpError(400, 'sessionId required')
    if (workspaceId) {
      const w = ctx.workspaceRegistry.get(workspaceId)
      if (w) return { sessionId, root: w.path, workspaceId: String(w.id) }
    }
    for (const w of ctx.workspaceRegistry.list()) {
      if (w.sessionIds.includes(sessionId)) return { sessionId, root: w.path, workspaceId: String(w.id) }
    }
    throw HttpError(404, 'workspace not found for session ' + sessionId)
  }

  async function handleApi(ctx, req, res, url) {
    const action = url.pathname.slice(apiPrefix.length)

    // 配置路由（供 DSH 设置页调用；tokenless，仅读写本插件配置）
    if (req.method === 'GET' && action === '/config') {
      sendJson(res, 200, { ok: true, config: getCfg(), path: CONFIG_PATH })
      return
    }
    if (req.method === 'POST' && action === '/config') {
      const body = await requestJson(req)
      const safe = {
        baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : getCfg().baseUrl,
        apiKey: typeof body.apiKey === 'string' ? body.apiKey : getCfg().apiKey,
        pollMs: body.pollMs != null ? Number(body.pollMs) : getCfg().pollMs,
        timeoutMs: body.timeoutMs != null ? Number(body.timeoutMs) : getCfg().timeoutMs,
        models: body.models && typeof body.models === 'object' ? body.models : getCfg().models,
        assetOverrides: body.assetOverrides && typeof body.assetOverrides === 'object' ? body.assetOverrides : getCfg().assetOverrides,
        preferred: body.preferred && typeof body.preferred === 'object' ? body.preferred : getCfg().preferred,
        tiers: body.tiers && typeof body.tiers === 'object' ? body.tiers : getCfg().tiers,
      }
      try {
        mkdirSync(dirname(CONFIG_PATH), { recursive: true })
        writeFileSync(CONFIG_PATH, JSON.stringify(safe, null, 2), 'utf8')
        sendJson(res, 200, { ok: true, config: safe })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error?.message || String(error) })
      }
      return
    }

    // 工作流注册表（tokenless，与 /config 同级：管理本地清单，不涉及会话数据）
    // ?probe=0 跳过节点预检（可用性返回 null=未知），用于加速首屏。
    if (req.method === 'GET' && action === '/workflows') {
      const payload = await describeWorkflowsApi(getRegistry(), { probe: url.searchParams.get('probe') !== '0' })
      sendJson(res, 200, payload)
      return
    }

    if (req.method === 'POST' && action === '/workflows') {
      const body = await requestJson(req)
      let manifest = body
      let todos = []

      // 原始 ComfyUI 导出自动转换：body = { raw: {...nodes}, id, capability, displayName? }
      if (body && typeof body === 'object' && body.raw && isRawComfyExport(body.raw)) {
        const r = convertComfyExport(body.raw, { id: body.id, capability: body.capability, displayName: body.displayName })
        if (!r.ok) { sendJson(res, 400, { ok: false, errors: r.errors }); return }
        manifest = r.manifest
        todos = r.todos
      } else if (isLegacyWorkflowFormat(body)) {
        sendJson(res, 400, { ok: false, errors: ['检测到旧版 ComfyUI「Save workflow」格式（nodes/links 数组）。请改用菜单里的「Export (API)」导出（{nodeId:{class_type,inputs}} 格式），再导入。'] })
        return
      } else if (isRawComfyExport(body)) {
        sendJson(res, 400, { ok: false, errors: ['检测到 ComfyUI 原始导出（缺少 id/capability 字段）。请在导入时填写 id 与能力，或先运行 scripts/import-comfy.mjs 转换。'] })
        return
      }

      // 档位声明（导入时选择档位 → 落盘约定 <组名>-<档位>）：字段为准，文件名只是约定
      if (body && typeof body === 'object' && (body.tier || body.group || body.accel)) {
        const tier = typeof body.tier === 'string' ? body.tier.trim() : ''
        if (tier && !TIERS.includes(tier)) { sendJson(res, 400, { ok: false, errors: [`tier "${tier}" 不在档位词汇表（${TIERS.join('|')}）`] }); return }
        const group = typeof body.group === 'string' && body.group.trim() ? body.group.trim() : (manifest.group || '')
        if (tier) manifest.tier = tier
        if (group) manifest.group = group
        if (typeof body.accel === 'string' && body.accel.trim()) manifest.accel = body.accel.trim()
        // 未显式给 id 时按约定合成 <组名>-<档位>[-加速]
        if (!body.id && group && tier) manifest.id = `${group}-${tier}${manifest.accel ? '-' + manifest.accel : ''}`
      }

      const idOk = typeof manifest?.id === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(manifest.id)
      if (!idOk) { sendJson(res, 400, { ok: false, errors: ['id 非法（仅小写字母/数字/._-，且字母或数字开头）'] }); return }
      const v = validateManifest(manifest, manifest.id || 'workflow')
      if (!v.ok) { sendJson(res, 400, { ok: false, errors: v.errors }); return }
      mkdirSync(USER_WORKFLOWS_DIR, { recursive: true })
      writeFileSync(join(USER_WORKFLOWS_DIR, manifest.id + '.json'), JSON.stringify(manifest, null, 2), 'utf8')
      reloadRegistry()
      sendJson(res, 200, { ok: true, id: manifest.id, todos })
      return
    }

    if (req.method === 'DELETE' && action === '/workflows') {
      const id = url.searchParams.get('id')?.trim()
      if (!id || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) { sendJson(res, 400, { ok: false, message: 'id 非法' }); return }
      const file = join(USER_WORKFLOWS_DIR, id + '.json')
      if (!existsSync(file)) { sendJson(res, 404, { ok: false, message: 'workflow not found (仅用户清单可删)' }); return }
      await unlink(file)
      reloadRegistry()
      sendJson(res, 200, { ok: true })
      return
    }

    requireToken(req, runtime)

    // GET /canvas
    if (req.method === 'GET' && action === '/canvas') {
      const { root, sessionId } = resolveFromQuery(ctx, url)
      sendJson(res, 200, await loadProject(root, sessionId))
      return
    }

    // POST /canvas/node  (写入/更新节点，含文本编辑、分组、排序、状态)
    if (req.method === 'POST' && action === '/canvas/node') {
      const { root, sessionId } = resolveFromQuery(ctx, url)
      const body = await requestJson(req)
      const project = await loadProject(root, sessionId)
      const nodeId = typeof body.id === 'string' && body.id ? body.id : randomUUID()
      const existingIdx = project.nodes.findIndex((n) => n.id === nodeId)
      const prev = existingIdx >= 0 ? project.nodes[existingIdx] : null
      const node = {
        id: nodeId,
        kind: ['text', 'table', 'image', 'video', 'audio'].includes(body.kind) ? body.kind : (prev?.kind || 'text'),
        title: typeof body.title === 'string' ? body.title : (prev?.title || ''),
        content: typeof body.content === 'string' ? body.content : (prev?.content || ''),
        media: typeof body.media === 'string' ? body.media : (prev?.media || ''),
        group: typeof body.group === 'string' ? body.group : (prev?.group || DEFAULT_GROUP),
        params: body.params && typeof body.params === 'object' ? body.params : (prev?.params || {}),
        status: typeof body.status === 'string' ? body.status : (prev?.status || 'ready'),
        error: typeof body.error === 'string' ? body.error : (prev?.error || ''),
        createdAt: prev?.createdAt || Date.now(),
        order: typeof body.order === 'number' ? body.order : (prev?.order ?? nextOrder(project.nodes)),
      }
      if (existingIdx >= 0) project.nodes[existingIdx] = node
      else project.nodes.push(node)
      await saveProject(root, sessionId, project)
      sendJson(res, 200, { node })
      return
    }

    // POST /canvas/group
    if (req.method === 'POST' && action === '/canvas/group') {
      const { root, sessionId } = resolveFromQuery(ctx, url)
      const body = await requestJson(req)
      const group = typeof body.group === 'string' ? body.group : ''
      const ids = Array.isArray(body.nodeIds) ? body.nodeIds : []
      const project = await loadProject(root, sessionId)
      for (const n of project.nodes) if (ids.includes(n.id)) n.group = group
      await saveProject(root, sessionId, project)
      sendJson(res, 200, { ok: true })
      return
    }

    // POST /canvas/reorder
    if (req.method === 'POST' && action === '/canvas/reorder') {
      const { root, sessionId } = resolveFromQuery(ctx, url)
      const body = await requestJson(req)
      const ids = Array.isArray(body.nodeIds) ? body.nodeIds : []
      const project = await loadProject(root, sessionId)
      const byId = new Map(project.nodes.map((n) => [n.id, n]))
      const ordered = []
      for (const id of ids) { const n = byId.get(id); if (n) { ordered.push(n); byId.delete(id) } }
      for (const n of project.nodes) if (byId.has(n.id)) ordered.push(n)
      ordered.forEach((n, i) => { n.order = i })
      project.nodes = ordered
      await saveProject(root, sessionId, project)
      sendJson(res, 200, { ok: true })
      return
    }

    // DELETE /canvas/node?id=
    if (req.method === 'DELETE' && action === '/canvas/node') {
      const { root, sessionId } = resolveFromQuery(ctx, url)
      const id = url.searchParams.get('id')?.trim()
      if (!id) throw HttpError(400, 'id required')
      const project = await loadProject(root, sessionId)
      const removed = project.nodes.filter((n) => n.id === id)
      project.nodes = project.nodes.filter((n) => n.id !== id)
      await saveProject(root, sessionId, project)
      // 同步清理被删节点的媒体文件（参考图/首末帧等手动上传节点），避免画布残留孤儿文件
      const mediaBase = join(root, CANVAS_DIR) + '/'
      for (const n of removed) {
        if (!n.media) continue
        try {
          const abs = join(root, ...String(n.media).split('/'))
          if (abs.startsWith(mediaBase) && existsSync(abs)) await unlink(abs)
        } catch (e) {
          console.warn('[dsh-short-video-studio] 节点媒体文件清理失败:', n.id, e?.message || e)
        }
      }
      sendJson(res, 200, { ok: true })
      return
    }

    // GET /assets（资产库列表）
    if (req.method === 'GET' && action === '/assets') {
      const { root } = resolveFromQuery(ctx, url)
      const lib = loadLibrary(root)
      sendJson(res, 200, { ok: true, assets: Object.values(lib.assets) })
      return
    }

    // POST /assets（把画布节点一键入库）
    if (req.method === 'POST' && action === '/assets') {
      const { root, sessionId } = resolveFromQuery(ctx, url)
      const body = await requestJson(req)
      const project = await loadProject(root, sessionId)
      const n = project.nodes.find((x) => x.id === body.nodeId)
      if (!n?.media) throw HttpError(400, '节点无媒体图')
      const srcAbs = join(root, ...String(n.media).split('/'))
      if (!existsSync(srcAbs)) throw HttpError(404, '媒体文件不存在')

      const type = body.type || 'character'
      let name = body.name
      if (!name) name = slugifyName(n.title || '')
      if (!name) throw HttpError(400, '请提供 name（小写英文/拼音，如 luna）')

      const lib = loadLibrary(root)
      const id = normalizeAssetId(type, name, body.state)
      const meta = { sourceSession: sessionId, sourceNode: n.id }
      if (n.params?.seed !== undefined && n.params?.seed !== null) meta.seed = n.params.seed
      if (n.params?.prompt) meta.prompt = n.params.prompt
      if (body.tags) meta.tags = body.tags
      if (body.speaksOnScreen !== undefined) meta.speaksOnScreen = Boolean(body.speaksOnScreen)

      const rec = registerAsset(root, lib, { id, type, name, state: body.state, srcAbsPath: srcAbs, meta })
      sendJson(res, 200, { ok: true, id: rec.id })
      return
    }

    // POST /canvas/upload（画布手动添加资产：本地图片 → 资产卡；JSON 带 base64 dataURL）
    if (req.method === 'POST' && action === '/canvas/upload') {
      const { root, sessionId } = resolveFromQuery(ctx, url)
      const body = await requestJson(req, 64 * 1024 * 1024)
      const files = Array.isArray(body.files) ? body.files.slice(0, UPLOAD_MAX_FILES) : []
      if (!files.length) throw HttpError(400, 'files 为空（最多 ' + UPLOAD_MAX_FILES + ' 张）')
      const group = typeof body.group === 'string' && body.group.trim() ? body.group.trim() : DEFAULT_GROUP
      const added = []
      const errors = []
      for (const f of files) {
        try {
          const node = await importManualImage(root, sessionId, f, group)
          added.push({ id: node.id, title: node.title, media: node.media })
        } catch (error) {
          errors.push({ filename: (f && f.filename) || '', message: error?.message || String(error) })
        }
      }
      if (!added.length) throw HttpError(400, '没有可用图片：' + errors.map((e) => e.message).join('；'))
      sendJson(res, 200, { ok: true, added, errors })
      return
    }

    // POST /assets/to-canvas（把资产库中的资产物化到当前画布，带缩略图取用）
    if (req.method === 'POST' && action === '/assets/to-canvas') {
      const { root, sessionId } = resolveFromQuery(ctx, url)
      const body = await requestJson(req)
      if (!body.id || typeof body.id !== 'string') throw HttpError(400, 'id 必填（如 character:luna）')
      const node = await copyAssetToCanvas(root, sessionId, body.id, {
        title: typeof body.title === 'string' ? body.title : undefined,
        group: typeof body.group === 'string' ? body.group : undefined,
        nodeId: typeof body.nodeId === 'string' ? body.nodeId : undefined,
      })
      sendJson(res, 200, { ok: true, nodeId: node.id, media: node.media, title: node.title })
      return
    }

    // POST /canvas/node/replace-image（画布卡「编辑 → 本地上传替换图片」）
    if (req.method === 'POST' && action === '/canvas/node/replace-image') {
      const { root, sessionId } = resolveFromQuery(ctx, url)
      const body = await requestJson(req, 64 * 1024 * 1024)
      if (!body.nodeId) throw HttpError(400, 'nodeId 必填')
      const r = await replaceNodeImage(root, sessionId, body.nodeId, { filename: body.filename, dataUrl: body.dataUrl })
      sendJson(res, 200, { ok: true, nodeId: r.node.id, media: r.node.media, prevAssetId: r.prevAssetId || '', assetIdCleared: r.assetIdCleared })
      return
    }

    // POST /generate/image
    if (req.method === 'POST' && action === '/generate/image') {
      const { sessionId, workspaceId } = resolveFromQuery(ctx, url)
      const body = await requestJson(req)
      const r = await runRender(ctx, { ...body, capability: 'image.text2image', sessionId, workspaceId, exec: null })
      sendJson(res, 200, r)
      return
    }

    // POST /generate/video
    if (req.method === 'POST' && action === '/generate/video') {
      const { sessionId, workspaceId } = resolveFromQuery(ctx, url)
      const body = await requestJson(req)
      const chaining = Boolean(body.first_frame_node || body.last_frame_node)
      const r = await runRender(ctx, { ...body, capability: chaining ? 'video.image2video' : 'video.reference2video', sessionId, workspaceId, exec: null })
      sendJson(res, 200, r)
      return
    }

    throw HttpError(404, 'unknown canvas api route: ' + action)
  }

  // 媒体伺服（token 走 query，便于 <img>/<video> 直接加载）
  // 两种来源：path=canvas/<sessionId>/…（画布媒体）；asset=<id>（跨会话资产库图，供缩略图预览）
  async function handleMedia(ctx, res, url) {
    if (url.searchParams.get('token') !== runtime.token) throw HttpError(403, 'unauthorized')
    const { root } = resolveFromQuery(ctx, url)
    const assetId = url.searchParams.get('asset')?.trim()
    let target
    if (assetId) {
      const lib = loadLibrary(root)
      const abs = resolveAssetImagePath(root, lib, canonicalAssetId(assetId))
      if (!abs) throw HttpError(404, 'asset image not found: ' + assetId)
      target = abs
    } else {
      const path = url.searchParams.get('path')?.trim()
      if (!path) throw HttpError(400, 'path required')
      const rel = safeRelative(path, CANVAS_DIR)
      target = resolve(root, rel)
      if (!inside(root, target)) throw HttpError(403, 'path escapes workspace')
    }
    const canonical = await realpath(target).catch((e) => { if (errorCode(e) === 'ENOENT') throw HttpError(404, 'media not found'); throw e })
    if (!inside(root, canonical)) throw HttpError(403, 'symlink escapes workspace')
    const info = await stat(canonical)
    if (!info.isFile()) throw HttpError(400, 'not a file')
    res.writeHead(200, { 'content-type': contentType(canonical), 'content-length': info.size, 'cache-control': 'no-store' })
    createReadStream(canonical).pipe(res)
  }

  // 静态 studio
  async function handleStatic(res, url) {
    let requested = url.pathname.slice(ROUTE_ROOT.length).replace(/^\/+/, '')
    if (requested === '') requested = 'index.html'
    const file = resolve(runtime.studioRoot, requested)
    if (!inside(runtime.studioRoot, file)) throw HttpError(403, 'asset path escape')
    const info = await stat(file).catch((e) => { if (errorCode(e) === 'ENOENT') throw HttpError(404, 'studio asset not found'); throw e })
    if (!info.isFile()) throw HttpError(404, 'studio asset not found')
    if (basename(file) === 'index.html') {
      const html = (await readFile(file, 'utf8')).replace('__DSH_SVS_TOKEN_VALUE__', runtime.token)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(html)
      return
    }
    // 开发期反复改 app.js/app.css，用 no-cache 让浏览器每次重验，避免旧代码被 immutable 永久缓存
    res.writeHead(200, { 'content-type': contentType(file), 'content-length': info.size, 'cache-control': 'no-cache' })
    createReadStream(file).pipe(res)
  }

  return { apiPrefix, handleApi, handleMedia, handleStatic }
}

function requireToken(req, runtime) {
  if (req.headers['x-dsh-svs-token'] !== runtime.token) throw HttpError(403, 'unauthorized')
}

// ---------------------------------------------------------------------------
// systemPrompt 段
// ---------------------------------------------------------------------------

const GUIDANCE = `本机已安装 dsh-short-video-studio 插件（短剧/动画画布工作室）。它给每个会话提供一个「画布」视图 tab，并把生成请求经「能力注册表」派发到本地 ComfyUI（http://localhost:8188）执行。用户提到「画布/短剧/动画短片/故事转视频/卡通短片」时即指本插件。

## 基本约定
- **只表达能力，不写死模型名**：capability（image.text2image / video.reference2video / video.image2video / audio.* 等）由注册表 preferred 解析到具体工作流；工作流可随时增删替换，勿在 prompt 或流程里硬编码模型名。
- **耐用产物必须落画布**：简报/大纲/角色卡/场景卡/镜头表/分镜/片段都要写成画布节点，不要只留在对话里。
- **分辨率由画布 settings.aspectRatio + 质量档推导**（fast 长边 832 调试 / quality 长边 1344 成片，snap32），支持 16:9 / 9:16 / 1:1 等任意比例；显式传 width/height 可覆盖。
- **视频工作流是 AV 模型**：默认带声音，且支持画面内原生字幕——把字幕要求写进 video prompt 末尾即可，无需后期叠加。
- **失败不要重复提交未改动的同一请求**：先改锚点/缩时长/降档/简化动作再重试。

## 工具契约
- comfy_list_workflows()：列出可用能力与工作流（capability → 工作流清单 + modes + 默认）。换模型/换工作流前先调它核对能力。
- comfy_render(capability, workflow?, mode?, prompt, width?, height?, length?, seed?, steps?, guidance?, count?, ref_nodes?, first_frame_node?, last_frame_node?, title?, group?, nodeId?)：通用渲染入口（模型无关）。capability ∈ image.text2image / video.reference2video / video.image2video / ...；workflow 缺省取 preferred 默认，mode 缺省取清单首个（quality/fast）。
- comfy_generate_image(prompt, width?, height?, seed?, steps?, guidance?, count?, title?, group?, nodeId?)：文生图别名（= comfy_render capability=image.text2image），写入画布，返回节点 id + 媒体相对路径。角色卡/场景卡/铅笔分镜用它。
- comfy_generate_video(prompt, mode?, ref_nodes?, first_frame_node?, last_frame_node?, width?, height?, length?, seed?, steps?, title?, group?, nodeId?)：单镜头视频别名。传 first_frame_node/last_frame_node → image2video 首/末帧串联（同场景续接）；不传 → reference2video 参考绑定。mode=quality(成片)/fast(调试快)。**分辨率由画布 aspectRatio 推导（支持 16:9/9:16/1:1 等任意比例），显式传 width/height 可覆盖**。length 为 24fps 帧数（124≈5s）。
- extract_frame(video_node, frame_index?, title?, group?, nodeId?)：从画布视频节点抽一帧存为图片节点（frame_index 负数从末尾数，-1=末帧默认，0=首帧）。抽出的图片节点可直接作 first_frame_node / last_frame_node。
- video_concat(nodes[], title?, group?, nodeId?)：把画布上的多个视频节点按给定顺序拼接成完整成片（含音轨），产物写回画布。后端自动选择：有 ffmpeg 走 ffmpeg（零重编码），否则走 ComfyUI 纯节点链路。拼接本身只做硬切；跨场景过渡应由「转场镜」承担（extract_frame 抽前一镜末帧 + 后一镜首帧 → comfy_generate_video 首末帧生成一个短过渡镜，当普通片段参与拼接）。
- canvas_list_nodes / canvas_write_node(kind: text|table, title, content, group) / canvas_get_node / canvas_group_nodes / canvas_reorder / canvas_get_state / canvas_set_state：读写画布与项目设置。所有耐用产物都要落到画布。
- **分组是自由字符串**：group 由流程 skill 自行定义，插件不预设任何片型词汇（缺省 ungrouped）。用 canvas_set_state(groupOrder=[...]) 一次性声明分组展示顺序，画布即按此顺序渲染；未列出的分组排在其后、按首次出现顺序。
- asset_list(type?, query?)：列出跨会话资产库中已入库的角色卡/场景卡/风格锚点（返回稳定资产 id，如 character:luna）。
- asset_to_canvas(id, title?, group?)：把资产物化为当前会话画布节点（复用卡片也要在画布出现）。返回节点 id。

## 参考图硬规则（实测，适用于任何 ref_nodes / first_frame_node 用法）
- **单视图**：参考图里有几个身体，成片就倾向出现几个角色。三视图（正/侧/背）拼图必然产生角色副本，**且在 prompt 里声明「同一角色多角度、只出现一只」经实测完全无效**。只传单视图；手上只有三视图卡就先裁出正面再用。
- **图内零文字**：参考图上的角色名、「正面/侧面/背面」、FRONT VIEW 之类标注、水印，会被视频模型当成「该出现在画面里的内容」印进成片，标注越清晰烙印越重。文字信息只写画布节点标题或资产库元数据。
- **多角度对视频模型无增量价值**：单张正面卡已足以支撑转身/走远等镜头。确需多角度时把多张单视图分别放进不同 ref_nodes 槽位，**绝不拼成一张图**。
- **first_frame_node 只用于同场景续接镜**（改善过渡）；跨场景只传角色卡 + 场景卡，不带上一镜末帧。
- **入库由用户人工完成**：角色卡/场景卡的跨会话入库必须由用户在画布点该卡的「入库」按钮，AI 不调用任何入库动作。新会话先 asset_list 查库，命中就用资产 id（如 character:luna）直接复用。

## 渠道交付（TUI / 飞书）
- 「画布」tab 只在 Web 可见；TUI / 飞书看不到画布，产物要主动送达用户，不能只报一句媒体路径。
- **ask 前自动送达（飞书）**：插件会在每次「ask_user_question」执行前，自动把画布中未送达的产物经「send_file」发到飞书——媒体文件（图片/视频/音频）直接发；文本/表格节点已自动导出为 .pdf 一并送达（puppeteer/Chrome 渲染，飞书可直接预览；本机无 PDF 工具时兜底 .html）。**发送的文件名取自节点标题**（如 主角卡.png、简报.pdf、S01-片段.mp4），不再是内部 id。**不要手动调「send_file」**，避免与自动送达重复。群聊会先弹审批卡、再出选项卡，均由用户在飞书确认，照常调用即可。
- **文本同时进回复**：简报/大纲/镜头表/分镜等文本节点除 .html 文件外，把要点写进助手回复，飞书回复本身即可读。
- **没有 send_file（Web / TUI）**：无自动送达，产物已在画布/工作区；TUI 用户按工具返回的 absPath 自行打开。
- send_file 有单文件上限（默认 20 MiB，可配）：自动送达失败的产物会在画布节点「params.deliveryError」记录原因（可用「canvas_get_node」查看），下次 ask 前会自动重试；若用户反馈未收到，改用 fast 档 / 更短镜头 / 分镜分开发，或提示用户到画布取。

## 生产流程
本段只定义工具契约与硬约束，**不定义任何生产流程**。完整片型流程（简报/大纲/卡片/镜头表/分镜/逐镜生成/交付的顺序、选项卡门控、失败梯度、终检清单）由 skill 定义——本插件会把自带的流程 skill 安装到 ~/.dsh/skills/，用户也可自行放置。触发到某个 skill 就完全按该 skill 执行；未触发任何 skill 时，按用户当下要求直接用上述工具生成，并把耐用产物落到画布。`

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let ctx = null

/** 本插件自带 skill 的安装标记文件（存在 = 该目录由本插件安装过）。 */
const STUDIO_SKILL_MARK = '.dsh-studio-manifest'

/**
 * 安装插件自带 skills：把 <包>/skills/<name> 复制到 ~/.dsh/skills/<name>。
 * - 幂等：目标已存在则跳过（不覆盖用户修改）。
 * - 冲突检测（仅带安装标记的 skill 参与）：同名目录已存在且非本插件安装
 *   （如用户单独装过官方 h3-prompt-writing）→ warn 提示，不覆盖，给出手动合并指引。
 * - 扩展：其他人可在本包 skills/ 下新增 skill，或直接在 ~/.dsh/skills 放自己的 skill。
 */
function installBundledSkills() {
  try {
    const src = resolve(packageRoot, 'skills')
    if (!existsSync(src)) return
    const dstRoot = join(homedir(), '.dsh', 'skills')
    mkdirSync(dstRoot, { recursive: true })
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const srcDir = join(src, entry.name)
      const target = join(dstRoot, entry.name)
      if (!existsSync(target)) {
        cpSync(srcDir, target, { recursive: true })
        continue
      }
      // 同名已存在：本包该 skill 带安装标记（需要来源检测）且目标目录不带标记 → 提示冲突
      if (existsSync(join(srcDir, STUDIO_SKILL_MARK)) && !existsSync(join(target, STUDIO_SKILL_MARK))) {
        console.warn(
          `[dsh-short-video-studio] 检测到同名 skill "${entry.name}" 已存在于 ~/.dsh/skills/（非本插件安装），未覆盖。` +
          `如需本插件适配版，请删除 ~/.dsh/skills/${entry.name} 后重装插件，或手动合并所需文件。`
        )
      }
    }
  } catch (error) {
    console.warn('[dsh-short-video-studio] install skills failed:', error?.message || String(error))
  }
}

export function apply(hostCtx) {
  ctx = hostCtx
  const runtime = {
    token: randomBytes(32).toString('base64url'),
    studioRoot: resolve(packageRoot, 'studio'),
  }

  // 安装自带 skill（供模型/技能中心发现）
  installBundledSkills()

  // M1：加载并校验内置工作流清单（纯观察，工具/路由仍走旧 builder，M2 再切换到 registry）
  const manifestReport = loadBuiltinManifests(resolve(packageRoot, 'workflows'))
  if (manifestReport.errors.length) {
    console.warn('[dsh-short-video-studio] 内置工作流清单校验失败:', manifestReport.errors)
  }

  // 工具
  const tools = makeTools()
  const disposeTools = ctx.effect(() => {
    const disposers = tools.map((t) => ctx.tools.register(t))
    return () => disposers.forEach((d) => d())
  }, 'dsh-short-video-studio: tools')

  // pre-ask 自动送达：ask_user_question 执行前，把画布中未送达的产物经
  // send_file 送达（仅飞书渠道有 send_file；Web/TUI 自动跳过）。
  // 只拦 ask_user_question，send_file 自身执行不会递归触发。
  // global:true = 全局监听器不受 agent context filter 限制，所有 scope 的 dispatch 都收到。
  const disposePreAskDeliver = ctx.effect(() => ctx.on('tools/pre-execute', makePreAskDeliverListener(ctx), { global: true }), 'dsh-short-video-studio: pre-ask deliver')

  // H3 结构化 prompt 质检门：comfy_generate_video / comfy_render 在 H3 系工作流下
  // 必须携带结构化字段（六段式 / 三段式 + 对齐指令），缺失 deny 引导加载
  // h3-prompt-writing skill 重写（防死循环上限后降级放行）。
  const disposeH3Gate = ctx.effect(() => ctx.on('tools/pre-execute', makeH3PromptGateListener(ctx), { global: true }), 'dsh-short-video-studio: h3 prompt gate')

  // systemPrompt 段
  const disposeSection = ctx.systemPrompt.section({
    name: 'plugin:dsh-short-video-studio',
    order: GUIDANCE_ORDER,
    text: GUIDANCE,
  })

  // 路由
  const { apiPrefix, handleApi, handleMedia, handleStatic } = makeRoutes(runtime)
  const disposeRoutes = ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_ROOT,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? ROUTE_ROOT, 'http://localhost')
          if (url.pathname.startsWith(apiPrefix)) await handleApi(ctx, req, res, url)
          else if (url.pathname.startsWith(ROUTE_ROOT + '/media')) await handleMedia(ctx, res, url)
          else await handleStatic(res, url)
        } catch (error) {
          if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return }
          sendJson(res, error?.status || 500, { ok: false, message: error?.message || 'request failed' })
        }
      },
    })
  }, 'dsh-short-video-studio: routes')
}

// 暴露部分内部供测试
export const _internals = {
  buildFluxImageWorkflow,
  buildH3VideoWorkflow,
  buildH3ImageToVideoWorkflow,
  comfySubmit,
  comfyWait,
  comfyOutputs,
  comfyDownload,
  comfyUploadImage,
  resolveTieredManifest,
  getCfg,
  getTierSelection,
  DEFAULT_GROUP,
  ROUTE_ROOT,
  CANVAS_DIR,
  // M1：工作流契约引擎
  loadBuiltinManifests,
  buildGraphFromManifest,
  validateManifest,
  resolveAssets,
  // 档位解析层（契约见 docs/tier-strategy-design.md）
  tierImplementations,
  sortTierCandidates,
  groupNameOf,
  isTieredCapability,
  getTierSelection,
  tierFromArgs,
  legacyModeFromArgs,
  projectGroupStrategies,
  describeTierMatrix,
  describeWorkflowsApi,
  effectiveAssetsOf,
  ASSET_OVERRIDE_ALIASES,
  LEGACY_MODEL_ASSET_MAP,
  checkAvailability,
  probeNodeClass,
  DEFAULT_TIER,
  CAPABILITIES,
  // M2：通用渲染
  runRender,
  buildRenderGraph,
  resolveManifest,
  resolveMode,
  computeManifestSize,
  getAssetOverrides,
  getRegistry,
  reloadRegistry,
  // 渠道交付：pre-ask 自动送达
  collectUndelivered,
  deliverPending,
  makePreAskDeliverListener,
  // 手动资产导入（画布上传 / 资产库取用 / 替换）
  parseDataUrlImage,
  importManualImage,
  copyAssetToCanvas,
  replaceNodeImage,
  UPLOAD_MAX_FILE,
  UPLOAD_MAX_FILES,
  // H3 结构化 prompt 质检门
  makeH3PromptGateListener,
  h3HasSection,
  H3_PROMPT_GATE,
  H3_GATE_MAX_DENIES,
  exportTextNode,
  deliveryFilename,
  markdownToHtml,
  renderNodeHtml,
  AUTO_DELIVER_BEFORE_ASK,
  TEXT_NODE_EXPORT_PDF,
}
