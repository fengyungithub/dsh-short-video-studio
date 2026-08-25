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

/**
 * MiniMax H3 音视频 + 参考绑定工作流（静音→有声，去参考→参考绑定）。
 * - 模式 quality：1344×768 / 20 步 / 无 LoRA；fast：832×480 / 4 步 / Lightning LoRA（调试）。
 * - refComfyNames 为已上传到 ComfyUI 的参考图文件名（角色/场景卡），经
 *   MiniMaxH3ReferenceToVideo 的 ref_images.ref_image_N（dotted）绑定身份/环境。
 * - 音频经 VAEDecodeAudio(audio_vae) → CreateVideo(audio) 合成，不再静音。
 */
function buildH3VideoWorkflow({ prompt, width, height, length, seed, steps, filenamePrefix, mode = 'quality', refComfyNames = [] }) {
  const fast = mode === 'fast'
  const w = fast ? 832 : width
  const h = fast ? 480 : height
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
  const w = fast ? 832 : width
  const h = fast ? 480 : height
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
  const width = intArg(opts, 'width', 1344)
  const height = intArg(opts, 'height', 768)
  const length = intArg(opts, 'length', 124)
  const seed = intArg(opts, 'seed', Math.floor(Math.random() * 2 ** 31))
  const steps = intArg(opts, 'steps', 20)
  const mode = opts.mode === 'fast' ? 'fast' : 'quality'
  const nodeId = opts.nodeId || randomUUID()

  const project = await loadProject(root, sessionId)
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
    ? buildH3ImageToVideoWorkflow({ prompt: opts.prompt, width, height, length, seed, steps, filenamePrefix: prefix, mode, firstFrameComfyName, lastFrameComfyName })
    : buildH3VideoWorkflow({ prompt: opts.prompt, width, height, length, seed, steps, filenamePrefix: prefix, mode, refComfyNames })
  const promptId = await comfySubmit(graph)
  const entry = await comfyWait(promptId, opts.signal)
  const outputs = comfyOutputs(entry)
  if (outputs.length === 0) throw new Error('generation-error: ComfyUI 无输出')

  const files = []
  for (const f of outputs) {
    const buf = await comfyDownload(f)
    files.push(await persistMedia(root, sessionId, buf, f.filename))
  }

  // 记录实际生效分辨率（fast 档 832×480 / quality 档按传入）
  const effW = mode === 'fast' ? 832 : width
  const effH = mode === 'fast' ? 480 : height
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
        const r = await runImageGeneration(ctx, { ...args, exec })
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
        mode: { type: 'string', enum: ['quality', 'fast'], description: '模式：quality=1344×768/20步/无LoRA（成片）；fast=832×480/4步/Lightning LoRA（调试，快5×+）。默认 quality。' },
        ref_nodes: { type: 'array', items: { type: 'string' }, description: '画布图片节点 id（角色卡/场景卡）作为参考图绑定身份/环境（一致性）。与 first/last_frame 二选一。' },
        first_frame_node: { type: 'string', description: '画布图片节点 id 作为本镜首帧（末帧串联：传上一镜末帧来接续）。' },
        last_frame_node: { type: 'string', description: '画布图片节点 id 作为本镜末帧（供下一镜首帧串联）。' },
        width: { type: 'integer', description: '宽，默认 1344（quality 档；fast 档强制 832）。' },
        height: { type: 'integer', description: '高，默认 768（quality 档；fast 档强制 480）。' },
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
        const r = await runVideoGeneration(ctx, { ...args, exec })
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

  return [imageTool, videoTool, listNodesTool, writeNodeTool, getNodeTool, groupTool, reorderTool, stateTool, setStateTool]
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

    // POST /generate/image
    if (req.method === 'POST' && action === '/generate/image') {
      const { sessionId, workspaceId } = resolveFromQuery(ctx, url)
      const body = await requestJson(req)
      const r = await runImageGeneration(ctx, { ...body, sessionId, workspaceId, exec: null })
      sendJson(res, 200, r)
      return
    }

    // POST /generate/video
    if (req.method === 'POST' && action === '/generate/video') {
      const { sessionId, workspaceId } = resolveFromQuery(ctx, url)
      const body = await requestJson(req)
      const r = await runVideoGeneration(ctx, { ...body, sessionId, workspaceId, exec: null })
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

const GUIDANCE = `本机已安装 dsh-short-video-studio 插件（短剧/动画画布工作室，复刻 MiniMax Design 画布体验）。它给每个会话提供一个「画布」视图 tab，并提供经 ComfyUI（http://localhost:8188）调用的生成服务：图片用 FLUX（本地 flux2_dev），视频用 MiniMax H3（本地 H3，音视频 AV 模型，默认带声音，支持 fast/质量模式与参考图绑定）。

## 工具契约
- comfy_generate_image(prompt, width?, height?, seed?, steps?, guidance?, count?, title?, group?, nodeId?)：FLUX 生成图片，写入画布，返回节点 id + 媒体相对路径。角色卡/场景卡/铅笔分镜用它。
- comfy_generate_video(prompt, mode?, ref_nodes?, first_frame_node?, last_frame_node?, width?, height?, length?, seed?, steps?, title?, group?, nodeId?)：MiniMax H3 音视频模型生成单镜头视频（带声音）。mode=quality(1344×768/20步，成片) 或 fast(832×480/4步+Lightning LoRA，调试快5×+)。两种路径：a) 传 first_frame_node/last_frame_node → ImageToVideo 首/末帧串联（同场景续接，身份/环境由首帧继承，改善过渡）；b) 不传 → ref_nodes 传画布角色卡/场景卡节点 id 作参考绑定。length 为 24fps 帧数（124≈5s）。单镜头用它。
- canvas_list_nodes / canvas_write_node(kind: text|table, title, content, group) / canvas_get_node / canvas_group_nodes / canvas_reorder / canvas_get_state / canvas_set_state：读写画布与项目设置。所有耐用产物都要落到画布。

## 流水线（固定顺序）
0 接收创意 → 用 ask_user_question 选项卡确认【画面比例/总时长/音频模式(silent|dialogue-led)/生成模式(fast调试|quality成片)】。
1 项目简报（text，group="story planning"）。
2 故事大纲（text，含音频脊柱图，group="story planning"）→ 选项卡批准。
3 角色卡（comfy_generate_image，group="character cards"，16:9，含正/侧/背三视图与 speaks_on_screen 标注）→ 选项卡锁定。
4 场景卡（comfy_generate_image，group="scene cards"，只环境不出现人物）→ 选项卡锁定。
5 七列镜头表（canvas_write_node kind=table，group="shot table"）：Shot ID & Duration / Continuity Handoff / Reference Anchors / Hook Type / Per-Second Directives / Audio & Dialogue Track(含 Mouth State) / Audio Mode。随后跑镜头表自检（hook 密度、单镜≤15s、单镜≤3 重要角色、空间锚点继承、每秒指令覆盖、跨镜连续、音频模式+口型安全）。
6 文本分镜文档（canvas_write_node kind=text，group="text storyboards"，每镜一节，含四象限每秒内容 + Mouth State + 双重绑定 [char:][scene:][hook:][audio_mode:][speaker:]）→ 选项卡批准。
7 单镜头视频：comfy_generate_video 逐镜生成（group="shot clips"）。起点/换场景镜用 ref_nodes 传【说话人角色卡+场景卡】作参考绑定（ReferenceToVideo 路径）；同场景续接镜（如 S03→S04、S05→S06）用 first_frame_node=上一镜末帧 做首帧串联（ImageToVideo 路径）改善过渡。按当前 mode（fast 调试/quality 成片）出片。video prompt 按音频模式加前缀 [AUDIO_MODE][SPEAKER][NON_SPEAKERS_MOUTH][SHOT_DURATION]，渲染前剥离分镜专用标签 → 片段批准卡。
8 拼接 + BGM + 最终合成（group="final delivery"）→ 终检（角色一致性、场景连续性、无分镜痕迹、口型/说话人硬卡、音频可听）。

## 门控纪律
所有批准/修订/模型/分辨率/继续/重做关口必须用 ask_user_question 选项卡（推荐项置首），不允许只用普通聊天让用户回复。

## 默认与失败梯度
默认：图片 FLUX、视频 MiniMax H3（用户明确要求才换模型并先检查能力）。生成失败按 fallback 梯度：重试一次(强化锚点/缩短措辞)→ 缩短时长/拆镜/降分辨率/简化动作 → 选项卡 → 占位跳过。不要重复提交未改动的同一请求。

## 实践要点（从实战沉淀，务必遵守）
- **参考图用「单视图」**：角色卡若为三视图（正/侧/背）直接作 ref_images 会导致生成画面出现多个角色副本；请用单视图角色卡作参考，或必要时在三视图参考时于 prompt 声明「参考图是同一角色的多个角度、只出现一只角色」。
- **H3 原生字幕**：对白字幕直接写进 video prompt 末尾「画面底部居中显示一条清晰的中文对白字幕：『台词』」，由 H3 端到端渲染（不再用 ffmpeg 后期叠加）。
- **末帧串联仅用于同场景续接镜**（如 S03→S04、S05→S06）：用 first_frame_node=上一镜末帧 改善过渡；跨场景只放「角色+场景」参考，不带上一镜末帧。
- **角色分状态建卡**：同一角色不同着装状态（如「不穿/穿宇航服」）分别建单视图卡，按镜头状态选用。

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
  comfySubmit,
  comfyWait,
  comfyOutputs,
  GROUP_ORDER,
  ROUTE_ROOT,
  CANVAS_DIR,
}
