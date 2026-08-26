/**
 * dsh-short-video-studio — host half.
 *
 * MiniMax-Design 风格的短剧/动画画布工作室：
 *  - ComfyUI 生成引擎（图片 FLUX / 视频 MiniMax H3，默认 http://localhost:8188）
 *  - 画布持久存储 <workspace>/canvas/<sessionId>/project.json + 媒体文件
 *  - /dsh-short-video-studio 路由（画布 API + 媒体伺服 + studio 静态站）
 *  - Agent 工具：comfy_generate_image / comfy_generate_video / canvas_*
 *  - systemPrompt 段：流水线 + 工具契约 + 选项卡门控
 *
 * 本文件刻意零 @deepseek-ai/* 运行时 import：工具用原生 ToolDefinition
 * 注册（parameters 直接写 JSON Schema），服务全部走注入的 ctx
 * （webServer/tools/systemPrompt/workspaceRegistry），从而 link:/file: 安装
 * 都不受 peer 解析路径影响。
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync, cpSync, readdirSync, mkdirSync } from 'node:fs'
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises'
import { resolve, basename, dirname, join, relative, sep, extname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { loadBuiltinManifests, buildGraphFromManifest, validateManifest, resolveAssets, CAPABILITIES } from './manifest.js'
import { convertComfyExport, isRawComfyExport, isLegacyWorkflowFormat } from './convert.js'
import {
  loadLibrary, normalizeAssetId, isAssetRef, canonicalAssetId, assetFilename,
  resolveAssetImagePath, registerAsset, slugifyName, ASSET_TYPES,
} from './assets.js'

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
      h3Clip: env('DSH_SVS_H3_CLIP', m.h3Clip || 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'),
      h3VideoVae: env('DSH_SVS_H3_VAE', m.h3VideoVae || 'minimax_h3_video_vae_fp16.safetensors'),
      h3AudioVae: env('DSH_SVS_H3_AUDIO_VAE', m.h3AudioVae || 'minimax_h3_audio_vae_fp32.safetensors'),
      h3FastLora: env('DSH_SVS_H3_LORA_FAST', m.h3FastLora || 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'),
      h3Fps: Number(env('DSH_SVS_H3_FPS', m.h3Fps || 24)),
    },
    assetOverrides: c.assetOverrides || {},
    preferred: c.preferred || {},
  }
}

const GUIDANCE_ORDER = 150

// 画布分组规范顺序（与 MiniMax skill 的生产顺序对齐）
const GROUP_ORDER = [
  'story planning',
  'character cards',
  'scene cards',
  'shot table',
  'text storyboards',
  'shot clips',
  'final delivery',
]

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
    if (body?.error) detail = typeof body.error === 'string' ? body.error : JSON.stringify(body.error)
    else if (body?.node_errors) detail = JSON.stringify(body.node_errors)
    else if (body?.message) detail = body.message
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
    '1': { class_type: 'UNETLoader', inputs: { unet_name: models.h3RefUnet, weight_dtype: 'default' } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: models.h3Clip, type: H3_CLIP_TYPE } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: models.h3VideoVae } },
    '4a': { class_type: 'VAELoader', inputs: { vae_name: models.h3AudioVae } },
  }
  let modelRef = ['1', 0]
  if (fast) {
    graph['1a'] = { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: models.h3FastLora, strength_model: 1.0, model: ['1', 0] } }
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
    group: opts.group || 'character cards',
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
    group: opts.group || 'shot clips',
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
  _registry = {
    manifests: Object.values(byId),
    byId,
    byCapability,
    errors: [...builtin.errors, ...user.errors],
  }
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

/** 旧 models.* 键 → 各工作流资产的别名映射（升级后旧配置不失效）。 */
const LEGACY_MODEL_ASSET_MAP = {
  'flux-text2image': { unet: 'fluxUnet', clip: 'fluxClip', vae: 'fluxVae' },
  'minimax-h3-ref2v': { unet: 'h3RefUnet', clip: 'h3Clip', vae: 'h3VideoVae', audio_vae: 'h3AudioVae', fast_lora: 'h3FastLora' },
  'minimax-h3-i2v': { unet: 'h3RefUnet', clip: 'h3Clip', vae: 'h3VideoVae', audio_vae: 'h3AudioVae', fast_lora: 'h3FastLora' },
}

/** 某工作流的资产覆盖：显式 assetOverrides[workflowId] 优先，旧 models.* 兜底。 */
function getAssetOverrides(workflowId) {
  const c = loadConfigFile()
  const explicit = (c.assetOverrides && c.assetOverrides[workflowId]) || {}
  const legacy = {}
  const map = LEGACY_MODEL_ASSET_MAP[workflowId] || {}
  const models = c.models || {}
  for (const [assetKey, modelKey] of Object.entries(map)) {
    if (models[modelKey] !== undefined && models[modelKey] !== '') legacy[assetKey] = models[modelKey]
  }
  return { ...legacy, ...explicit }
}

/** 显式 workflow > preferred 顺序 > 该 capability 任意清单。 */
function resolveManifest(registry, capability, workflowId) {
  const candidates = registry.byCapability[capability] || []
  if (workflowId) {
    const m = registry.byId[workflowId]
    if (!m) throw new Error(`workflow "${workflowId}" 不存在`)
    if (m.capability !== capability) throw new Error(`workflow "${workflowId}" 能力是 ${m.capability}，非 ${capability}`)
    return m
  }
  if (!candidates.length) throw new Error(`no workflow for capability ${capability}`)
  for (const id of getPreferred(capability)) {
    const m = registry.byId[id]
    if (m && m.capability === capability) return m
  }
  return candidates[0]
}

/** 解析 mode：显式合法 mode > 清单首个 mode > null。 */
function resolveMode(manifest, mode) {
  const names = Object.keys(manifest.modes || {})
  if (mode && manifest.modes && manifest.modes[mode]) return mode
  return names[0] || null
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

/** 通用渲染：capability → manifest → 编译图 → ComfyUI → 下载 → 写画布节点。 */
async function runRender(ctx, opts) {
  const { workspaceId, exec } = opts
  const { root, sessionId } = resolveSessionRoot(ctx, opts.sessionId, workspaceId, exec)
  const project = await loadProject(root, sessionId)
  const aspectRatio = project.settings?.aspectRatio

  const registry = getRegistry()
  const manifest = resolveManifest(registry, opts.capability, opts.workflow)
  const mode = resolveMode(manifest, opts.mode)
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
    group: opts.group || (mediaType === 'video' ? 'shot clips' : 'character cards'),
    params: {
      workflow: manifest.id,
      capability: manifest.capability,
      model: manifest.id,
      mode,
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

  return { ok: true, node, files }
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
        group: { type: 'string', description: '画布分组（character cards / scene cards / text storyboards 等）。' },
        nodeId: { type: 'string', description: '复用节点 id（更新而非新增）。' },
        sessionId: { type: 'string', description: '会话 id（缺省取当前 agent 会话）。' },
        workspaceId: { type: 'string', description: '工作区 id（缺省自动解析）。' },
      },
      required: ['prompt'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, nodeId: { type: 'string' }, media: { type: 'string' }, error: { type: 'string' } } },
      render: (_args, value) => text(value.ok
        ? `已生成图片节点 ${value.nodeId}\n媒体路径: ${value.media}`
        : `生成失败: ${value.error}`),
    },
    async execute(args, exec) {
      try {
        const r = await runRender(ctx, { ...args, capability: 'image.text2image', exec })
        return { ok: true, nodeId: r.node.id, media: r.node.media, error: '' }
      } catch (error) {
        return { ok: false, nodeId: '', media: '', error: error?.message || String(error) }
      }
    },
  }

  const videoTool = {
    name: 'comfy_generate_video',
    description:
      '用 ComfyUI 的 MiniMax H3 音视频模型生成单镜头视频（带声音）。两种路径：传 first_frame_node/last_frame_node（画布图片节点）→ 用 ImageToVideo 做首/末帧串联（同场景续接，身份/环境由首帧继承，改善过渡）；不传 → 用 ReferenceToVideo 并支持 ref_nodes（角色/场景卡）作参考绑定。支持 mode（quality 成片 / fast 调试）。产物写入画布并返回节点 id + 媒体相对路径。用于单镜头视频。触发词：生成视频/单镜头/片段。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频提示词（含每秒动作、镜头运动、说话人绑定等）。' },
        mode: { type: 'string', enum: ['quality', 'fast'], description: '模式：quality=20步/无LoRA（成片，默认 1344×768）；fast=4步/Lightning LoRA（调试，快5×+）。分辨率按画布 aspectRatio 或传入宽高推导，fast/quality 均支持任意比例。默认 quality。' },
        ref_nodes: { type: 'array', items: { type: 'string' }, description: '参考图：画布图片节点 id 或资产 id（character:luna / scene:bridge，跨会话复用）。绑定身份/环境（一致性）。与 first/last_frame 二选一。' },
        first_frame_node: { type: 'string', description: '首帧：画布图片节点 id 或资产 id（末帧串联：传上一镜末帧来接续）。' },
        last_frame_node: { type: 'string', description: '末帧：画布图片节点 id 或资产 id（供下一镜首帧串联）。' },
        width: { type: 'integer', description: '宽，显式传入则优先采用（snap 到 32 倍数）；缺省按画布 aspectRatio 推导，默认 1344。fast/quality 均支持任意比例。' },
        height: { type: 'integer', description: '高，显式传入则优先采用（snap 到 32 倍数）；缺省按画布 aspectRatio 推导，默认 768。fast/quality 均支持任意比例。' },
        length: { type: 'integer', description: '帧数（24fps；124≈5s，步进 17）。默认 124。' },
        seed: { type: 'integer', description: '随机种子（可选）。' },
        steps: { type: 'integer', description: '采样步数，默认 20（fast 档强制 4）。' },
        title: { type: 'string', description: '画布节点标题，如「S01 片段」。' },
        group: { type: 'string', description: '画布分组（shot clips / final delivery）。' },
        nodeId: { type: 'string', description: '复用节点 id。' },
        sessionId: { type: 'string', description: '会话 id（缺省取当前 agent 会话）。' },
        workspaceId: { type: 'string', description: '工作区 id（缺省自动解析）。' },
      },
      required: ['prompt'],
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, nodeId: { type: 'string' }, media: { type: 'string' }, error: { type: 'string' } } },
      render: (_args, value) => text(value.ok
        ? `已生成视频节点 ${value.nodeId}\n媒体路径: ${value.media}`
        : `生成失败: ${value.error}`),
    },
    async execute(args, exec) {
      try {
        const chaining = Boolean(args.first_frame_node || args.last_frame_node)
        const capability = chaining ? 'video.image2video' : 'video.reference2video'
        const r = await runRender(ctx, { ...args, capability, exec })
        return { ok: true, nodeId: r.node.id, media: r.node.media, error: '' }
      } catch (error) {
        return { ok: false, nodeId: '', media: '', error: error?.message || String(error) }
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
          group: args.group || 'story planning',
          status: 'ready',
          createdAt: Date.now(),
          order: nextOrder(project.nodes),
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
    description: '读取会话画布的项目设置（画幅/时长/音频模式/模式）。',
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
    description: '写入会话画布的项目设置（画幅/时长/音频模式/模式）。用于持久化 Step 0 的选项卡选择。',
    parameters: {
      type: 'object',
      properties: {
        aspectRatio: { type: 'string', description: '画面比例，如 16:9 / 9:16 / 1:1。' },
        duration: { type: 'string', description: '总时长，如 30 秒。' },
        audioMode: { type: 'string', enum: ['silent', 'dialogue-led', 'narration-led'], description: '音频模式。' },
        mode: { type: 'string', enum: ['quality', 'fast'], description: '生成模式：quality 成片 / fast 调试。' },
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
      '通用渲染入口（模型/工作流无关）：按 capability 调用注册表里对应的工作流。显式 workflow 可指定实现，否则按 preferred 默认。产物写入画布。触发词：生成/渲染。',
    parameters: {
      type: 'object',
      properties: {
        capability: { type: 'string', enum: CAPABILITIES, description: '能力（见 comfy_list_workflows）。' },
        workflow: { type: 'string', description: '显式指定工作流 id（可选，缺省按 preferred 默认）。' },
        mode: { type: 'string', description: '质量档（如 quality/fast；缺省取清单首个 mode）。' },
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
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, nodeId: { type: 'string' }, media: { type: 'string' }, error: { type: 'string' } } },
      render: (_args, value) => text(value.ok ? `已渲染节点 ${value.nodeId}\n媒体路径: ${value.media}` : `渲染失败: ${value.error}`),
    },
    async execute(args, exec) {
      try {
        const r = await runRender(ctx, { ...args, exec })
        return { ok: true, nodeId: r.node.id, media: r.node.media, error: '' }
      } catch (error) {
        return { ok: false, nodeId: '', media: '', error: error?.message || String(error) }
      }
    },
  }

  const listWorkflowsTool = {
    name: 'comfy_list_workflows',
    description: '列出可用的生成能力与工作流（模型/工作流清单），供选择默认或显式指定 workflow。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'object', properties: { capabilities: { type: 'array', items: { type: 'object' } } } },
      render: (_args, value) => text((value.capabilities || []).map((c) =>
        `${c.capability}\t默认=${c.default}\n  ` + c.workflows.map((w) => `${w.id}${w.modes && w.modes.length ? `[${w.modes.join('/')}]` : ''}`).join(', ')
      ).join('\n') || '(无工作流)'),
    },
    async execute() {
      const registry = getRegistry()
      const capabilities = Object.entries(registry.byCapability).map(([cap, ms]) => {
        const preferred = getPreferred(cap)
        return {
          capability: cap,
          default: preferred[0] || (ms[0] && ms[0].id) || '',
          workflows: ms.map((m) => ({
            id: m.id,
            displayName: m.displayName || m.id,
            modes: Object.keys(m.modes || {}),
            output: m.output || {},
            constraints: m.constraints || {},
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
        group: { type: 'string', description: '分组（缺省按资产类型：character cards / scene cards）。' },
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
        const lib = loadLibrary(root)
        const id = canonicalAssetId(args.id)
        const a = lib.assets[id]
        if (!a) throw new Error('资产不存在: ' + args.id)
        const abs = resolveAssetImagePath(root, lib, id)
        if (!abs) throw new Error('资产图片文件缺失: ' + a.image)

        const nodeId = args.nodeId || randomUUID()
        const buf = await readFile(abs)
        const rel = await persistMedia(root, sid, buf, 'asset-' + assetFilename(id) + (extname(abs) || '.png'))
        const project = await loadProject(root, sid)
        const group = args.group || (a.type === 'scene' ? 'scene cards' : 'character cards')
        const node = {
          id: nodeId,
          kind: 'image',
          title: args.title || a.name || id,
          media: rel,
          group,
          params: { assetId: id, model: 'asset:' + id, speaksOnScreen: a.speaksOnScreen },
          status: 'ready',
          createdAt: Date.now(),
          order: nextOrder(project.nodes),
        }
        const existing = project.nodes.findIndex((n) => n.id === nodeId)
        if (existing >= 0) { node.order = project.nodes[existing].order; node.createdAt = project.nodes[existing].createdAt; project.nodes[existing] = node }
        else project.nodes.push(node)
        await saveProject(root, sid, project)
        return { ok: true, nodeId, media: rel, error: '' }
      } catch (error) {
        return { ok: false, nodeId: '', media: '', error: error?.message || String(error) }
      }
    },
  }

  return [imageTool, videoTool, renderTool, listWorkflowsTool, listNodesTool, writeNodeTool, getNodeTool, groupTool, reorderTool, stateTool, setStateTool, assetListTool, assetToCanvasTool]
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
    if (req.method === 'GET' && action === '/workflows') {
      const registry = getRegistry()
      const capabilities = Object.entries(registry.byCapability).map(([cap, ms]) => ({
        capability: cap,
        preferred: getPreferred(cap),
        workflows: ms.map((m) => ({
          id: m.id,
          displayName: m.displayName || m.id,
          modes: Object.keys(m.modes || {}),
          output: m.output || {},
          constraints: m.constraints || {},
          assets: m.assets || {},
          source: m._source || 'builtin',
        })),
      }))
      sendJson(res, 200, { ok: true, capabilities, errors: registry.errors })
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
        group: typeof body.group === 'string' ? body.group : (prev?.group || 'story planning'),
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
      project.nodes = project.nodes.filter((n) => n.id !== id)
      await saveProject(root, sessionId, project)
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

      let type = body.type
      if (!type) type = n.group === 'scene cards' ? 'scene' : 'character'
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
  async function handleMedia(ctx, res, url) {
    if (url.searchParams.get('token') !== runtime.token) throw HttpError(403, 'unauthorized')
    const { root } = resolveFromQuery(ctx, url)
    const path = url.searchParams.get('path')?.trim()
    if (!path) throw HttpError(400, 'path required')
    const rel = safeRelative(path, CANVAS_DIR)
    const target = resolve(root, rel)
    if (!inside(root, target)) throw HttpError(403, 'path escapes workspace')
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
    res.writeHead(200, { 'content-type': contentType(file), 'content-length': info.size, 'cache-control': 'public, max-age=31536000, immutable' })
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

const GUIDANCE = `本机已安装 dsh-short-video-studio 插件（短剧/动画画布工作室，复刻 MiniMax Design 画布体验）。它给每个会话提供一个「画布」视图 tab，并提供经 ComfyUI（http://localhost:8188）调用的生成服务。生成走「能力注册表」：图片默认文生图工作流（flux-text2image），视频默认 MiniMax H3 音视频工作流（参考绑定 minimax-h3-ref2v / 首末帧串联 minimax-h3-i2v，AV 模型默认带声音）。能力与工作流可替换（任意模型/任意 ComfyUI 工作流），默认由注册表 preferred 决定，勿在 prompt 中写死模型名。

## 工具契约
- comfy_list_workflows()：列出可用能力与工作流（capability → 工作流清单 + modes + 默认）。换模型/换工作流前先调它核对能力。
- comfy_render(capability, workflow?, mode?, prompt, width?, height?, length?, seed?, steps?, guidance?, count?, ref_nodes?, first_frame_node?, last_frame_node?, title?, group?, nodeId?)：通用渲染入口（模型无关）。capability ∈ image.text2image / video.reference2video / video.image2video / ...；workflow 缺省取 preferred 默认，mode 缺省取清单首个（quality/fast）。
- comfy_generate_image(prompt, width?, height?, seed?, steps?, guidance?, count?, title?, group?, nodeId?)：文生图别名（= comfy_render capability=image.text2image），写入画布，返回节点 id + 媒体相对路径。角色卡/场景卡/铅笔分镜用它。
- comfy_generate_video(prompt, mode?, ref_nodes?, first_frame_node?, last_frame_node?, width?, height?, length?, seed?, steps?, title?, group?, nodeId?)：单镜头视频别名。传 first_frame_node/last_frame_node → image2video 首/末帧串联（同场景续接）；不传 → reference2video 参考绑定。mode=quality(成片)/fast(调试快)。**分辨率由画布 aspectRatio 推导（支持 16:9/9:16/1:1 等任意比例），显式传 width/height 可覆盖**。length 为 24fps 帧数（124≈5s）。
- canvas_list_nodes / canvas_write_node(kind: text|table, title, content, group) / canvas_get_node / canvas_group_nodes / canvas_reorder / canvas_get_state / canvas_set_state：读写画布与项目设置。所有耐用产物都要落到画布。
- asset_list(type?, query?)：列出跨会话资产库中已入库的角色卡/场景卡/风格锚点（返回稳定资产 id，如 character:luna）。
- asset_to_canvas(id, title?, group?)：把资产物化为当前会话画布节点（复用卡片也要在画布出现）。返回节点 id。

## 流水线（固定顺序）
0 接收创意 → 会话开始先 asset_list() 查库。若库非空，用 ask_user_question 选项卡确认【复用范围】：在问题里列出库内已有资产（如 character:luna、scene:bridge），问本次是否复用（复用 / 全新 / 部分复用，复用与全新可混选）；复用的资产后续直接以资产 id 引用、不再重新生成对应卡片。随后（无论库是否为空）用 ask_user_question 选项卡确认【画面比例/总时长/音频模式(silent|dialogue-led)/生成模式(fast调试|quality成片)】。
1 项目简报（text，group="story planning"）。
2 故事大纲（text，含音频脊柱图，group="story planning"）→ 选项卡批准。
3 角色卡（comfy_generate_image，group="character cards"，**单视图正面全身、画面内不得出现任何文字**，speaks_on_screen 记在画布节点标题/描述里而非画进图里）→ 选项卡锁定。生成前先 asset_list(type=character) 查库；命中复用则 asset_to_canvas(id=资产 id) 把卡片物化到画布（复用也要在画布可见），未命中才 comfy_generate_image 新卡。**新卡不自动入库**——生成后提示用户在画布点该卡的「入库」按钮人工登记（AI 不调用任何入库动作）。
4 场景卡（comfy_generate_image，group="scene cards"，只环境不出现人物）→ 选项卡锁定。生成前先 asset_list(type=scene) 查库；命中复用则 asset_to_canvas(id=资产 id)，未命中才生成新卡。**新卡不自动入库**——提示用户在画布点「入库」按钮人工登记。
5 七列镜头表（canvas_write_node kind=table，group="shot table"）：Shot ID & Duration / Continuity Handoff / Reference Anchors / Hook Type / Per-Second Directives / Audio & Dialogue Track(含 Mouth State) / Audio Mode。随后跑镜头表自检（hook 密度、单镜≤15s、单镜≤3 重要角色、空间锚点继承、每秒指令覆盖、跨镜连续、音频模式+口型安全）。
6 文本分镜文档（canvas_write_node kind=text，group="text storyboards"，每镜一节，含四象限每秒内容 + Mouth State + 双重绑定 [char:][scene:][hook:][audio_mode:][speaker:]）→ 选项卡批准。
7 单镜头视频：comfy_generate_video 逐镜生成（group="shot clips"）。起点/换场景镜用 ref_nodes 传【说话人角色卡+场景卡】作参考绑定（reference2video 路径）；同场景续接镜（如 S03→S04、S05→S06）用 first_frame_node=上一镜末帧 做首帧串联（image2video 路径）改善过渡。按当前 mode（fast 调试/quality 成片）出片。video prompt 按音频模式加前缀 [AUDIO_MODE][SPEAKER][NON_SPEAKERS_MOUTH][SHOT_DURATION]，渲染前剥离分镜专用标签 → 片段批准卡。
8 拼接 + BGM + 最终合成（group="final delivery"）→ 终检（角色一致性、场景连续性、无分镜痕迹、口型/说话人硬卡、音频可听）。

## 门控纪律
所有批准/修订/模型/分辨率/继续/重做关口必须用 ask_user_question 选项卡（推荐项置首），不允许只用普通聊天让用户回复。

## 默认与失败梯度
默认由能力注册表 preferred 决定（当前：image.text2image=flux-text2image，video.reference2video=minimax-h3-ref2v，video.image2video=minimax-h3-i2v）。用户明确要求换模型/换工作流时：先 comfy_list_workflows 核对能力，再 comfy_render 显式 workflow（或改 preferred 默认）。生成失败按 fallback 梯度：重试一次(强化锚点/缩短措辞)→ 缩短时长/拆镜/降分辨率/简化动作 → 选项卡 → 占位跳过。不要重复提交未改动的同一请求。

## 实践要点（从实战沉淀，务必遵守）
- **参考图必须「单视图」（实测硬规则）**：参考图里有几个身体，生成画面就倾向出现几个角色。三视图（正/侧/背）拼图作 ref_images 必然产生多个角色副本，**且在 prompt 里声明「参考图是同一角色的多个角度、只出现一只」经实测完全无效，不要依赖这个说法**。只能用单视图角色卡。若手上只有三视图卡，先裁出正面单视图再用。
- **参考图内不得包含任何文字**（实测硬规则）：参考图上的文字（角色名、"正面/侧面/背面"、FRONT VIEW 之类标注、水印）会被视频模型当作"应出现在画面里的内容"直接渲进成片，且标注越清晰、烙印越清晰。角色名与视图信息只写在画布节点标题或资产库元数据里，绝不画进图内。
- **多角度信息对视频模型无增量价值**（实测）：视频模型自带 3D 理解，单张正面卡已足够支撑角色转身/走远等镜头，无需为"看到侧面/背面"额外提供参考。确有需要时，把多张单视图分别放进不同 ref_nodes 槽位，**绝不拼成一张图**。
- **视频原生字幕**：对白字幕直接写进 video prompt 末尾「画面底部居中显示一条清晰的中文对白字幕，字幕内容即台词文字本身（不加引号、书名号或括号）」，由视频模型端到端渲染（当前 H3 支持；若换不支持原生字幕的模型，改用后期叠加并逐镜复核）。
- **末帧串联仅用于同场景续接镜**（如 S03→S04、S05→S06）：用 first_frame_node=上一镜末帧 改善过渡；跨场景只放「角色+场景」参考，不带上一镜末帧。
- **角色分状态建卡**：同一角色不同着装状态（如「不穿/穿宇航服」）分别建单视图卡，按镜头状态选用。
- **跨会话复用**：角色卡/场景卡是昂贵锚点，**入库必须由用户在画布点该卡的「入库」按钮人工完成（AI 不自动入库）**；续集/新会话先 asset_list 查库，命中就直接用 ref_nodes 传资产 id（如 character:luna）复用同一张图，保证一致性且不重复生成。

## 边界
silent（静音，纯画面+BGM/SFX，口型风险为 0）与 dialogue-led（对白主导，一镜一人+反应切镜，说话人绑定+非说话人闭嘴）两种音频模式；旁白主导不在本插件范围。不用于单图修图、真人写实、单条独立镜头。用户提到「画布/短剧/动画短片/故事转视频/卡通短片」时即指本插件，请据此协作。`

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let ctx = null

/**
 * 安装插件自带 skills：把 <包>/skills/<name> 复制到 ~/.dsh/skills/<name>。
 * - 幂等：目标已存在则跳过（不覆盖用户修改）。
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
      const target = join(dstRoot, entry.name)
      if (existsSync(target)) continue
      cpSync(join(src, entry.name), target, { recursive: true })
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
  GROUP_ORDER,
  ROUTE_ROOT,
  CANVAS_DIR,
  // M1：工作流契约引擎
  loadBuiltinManifests,
  buildGraphFromManifest,
  validateManifest,
  resolveAssets,
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
}
