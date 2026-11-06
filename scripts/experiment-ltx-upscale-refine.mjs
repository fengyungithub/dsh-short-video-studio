/**
 * scripts/experiment-ltx-upscale-refine.mjs — 「LTX×2 latent 放大 + H3 精修」vs「LBH H3×2 放大 + H3 精修」A/B。
 *
 * 背景：官方两段式是「H3 学习式 ×2 放大 → H3→LTX adapter → LTX refine」；
 * 本脚本验证的是**节点侧组合**：H3 草稿 latent → （ltx-2-spatial-upscaler-x2 | LBH H3 3D upscaler）
 * → 同一个 H3 模型低 sigma 精修（denoise 0.3）→ 解码（音频 lock 住）。
 *
 * 只提交原始 ComfyUI /prompt，不碰注册表/清单；产物落 e2e-out/ltx-refine/。
 *
 * 用法：
 *   node scripts/experiment-ltx-upscale-refine.mjs --length 22 --upscaler ltx        # 冒烟
 *   node scripts/experiment-ltx-upscale-refine.mjs --length 56 --upscaler both        # A/B
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.DSH_SVS_COMFY_URL || 'http://localhost:8188'
const OUT = resolve(ROOT, 'e2e-out/ltx-refine')

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const num = (k, d) => { const v = arg(k); return v === undefined || v === '' ? d : Number(v) }

const LENGTH = num('length', 56)
const STEPS = num('steps', 4)
const DENOISE2 = num('denoise2', 0.3)
const SEED = num('seed', 20261028)
const UPSCALER = arg('upscaler', 'both') // ltx | lbh | both
const TAG = arg('tag', 'ab')

const PROMPT = arg('prompt',
  'integrated_multimodal_description: A medium wide shot of a red fox trotting across a sunlit meadow at golden hour. ' +
  'Tall grass sways; the camera tracks alongside at eye level. Natural detail, crisp fur texture, no text, no cuts. ' +
  'overall_soundscape: Soft wind through grass, distant birdsong, faint rustle of footsteps.')

const MODELS = {
  unet: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  lora: 'minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors',
  clip: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  vae: 'minimax_h3_video_vae_fp16.safetensors',
  audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
}
const UPSCALERS = {
  ltx: 'ltx-2-spatial-upscaler-x2-1.0.safetensors',
  lbh: 'minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors',
}

function buildGraph(upscalerFile, prefix) {
  const g = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: MODELS.unet, weight_dtype: 'default' } },
    2: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: MODELS.lora, strength_model: 1.0 } },
    3: { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['2', 0], shift_video: 12.0, shift_audio: 3.0 } },
    4: { class_type: 'CLIPLoader', inputs: { clip_name: MODELS.clip, type: 'minimax' } },
    5: { class_type: 'VAELoader', inputs: { vae_name: MODELS.vae } },
    6: { class_type: 'VAELoader', inputs: { vae_name: MODELS.audioVae } },
    7: {
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: { clip: ['4', 0], vae: ['5', 0], prompt: PROMPT, width: 832, height: 480, length: LENGTH },
    },
    8: { class_type: 'RandomNoise', inputs: { noise_seed: SEED } },
    9: { class_type: 'BasicGuider', inputs: { model: ['3', 0], conditioning: ['7', 0] } },
    10: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    11: { class_type: 'BasicScheduler', inputs: { model: ['3', 0], scheduler: 'simple', steps: STEPS, denoise: 1.0 } },
    12: {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['8', 0], guider: ['9', 0], sampler: ['10', 0], sigmas: ['11', 0], latent_image: ['7', 1] },
    },
    // upscaler=null ⇒ 对照臂：直接解码首遍 latent（不放大、不精修）
    16: { class_type: 'VAEDecode', inputs: { samples: [upscalerFile ? '15' : '12', 0], vae: ['5', 0] } },
    17: { class_type: 'VAEDecodeAudio', inputs: { samples: [upscalerFile ? '15' : '12', 0], vae: ['6', 0] } },
    18: { class_type: 'CreateVideo', inputs: { images: ['16', 0], audio: ['17', 0], fps: 24.0 } },
    19: { class_type: 'SaveVideo', inputs: { video: ['18', 0], filename_prefix: prefix, format: 'mp4', codec: 'h264' } },
  }
  if (upscalerFile) {
    g[13] = { class_type: 'RandomNoise', inputs: { noise_seed: SEED + 2000000 } }
    g[14] = { class_type: 'BasicScheduler', inputs: { model: ['3', 0], scheduler: 'simple', steps: STEPS, denoise: DENOISE2 } }
    g[15] = {
      class_type: 'MinimaxH3LatentUpscaler3DRefineHandoff',
      inputs: {
        latent: ['12', 0], noise: ['13', 0], sampler: ['10', 0], sigmas: ['14', 0],
        model_name: upscalerFile, mode: 'scale by multiplier', scale: 2.0,
        width: 1280, height: 704, megapixels: 1.0, align: 32, keep_proportion: true,
        lock_audio: true, cfg: 1.0, device: 'cuda', precision: 'fp16',
        offload_after_upscale: false, model: ['3', 0], positive: ['7', 0],
      },
    }
  }
  return g
}

const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`)
  return r.json()
}

async function run(label, upscalerKey) {
  const upscalerFile = upscalerKey === 'none' ? null : UPSCALERS[upscalerKey]
  const prefix = `ltx-refine/${TAG}-${upscalerKey}-${LENGTH}f`
  const graph = buildGraph(upscalerFile, prefix)
  const t0 = Date.now()
  const { prompt_id } = await post('/prompt', { prompt: graph, client_id: `ltx-refine-${upscalerKey}` })
  console.log(`▸ [${label}] 已提交 ${upscalerFile} · ${LENGTH} 帧 · 首遍 832×480 ${STEPS} 步 → ×2 → denoise ${DENOISE2} · ${prompt_id.slice(0, 8)}`)

  for (;;) {
    await new Promise((r) => setTimeout(r, 5000))
    const h = await (await fetch(`${BASE}/history/${prompt_id}`)).json()
    const entry = h[prompt_id]
    if (!entry) continue
    const st = entry.status?.status_str
    if (st === 'error') {
      const msg = (entry.status?.messages || []).filter((m) => m[0] === 'execution_error').map((m) => JSON.stringify(m[1]).slice(0, 600))
      throw new Error(`[${label}] 执行失败：${msg.join(' | ')}`)
    }
    const secs = (Date.now() - t0) / 1000
    const files = Object.values(entry.outputs || {}).flatMap((o) => o.videos || o.images || [])
    mkdirSync(OUT, { recursive: true })
    const saved = []
    for (const f of files) {
      const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' })
      const buf = Buffer.from(await (await fetch(`${BASE}/view?${q}`)).arrayBuffer())
      const name = `${TAG}-${upscalerKey}-${LENGTH}f-${f.filename.replace(/^.*\//, '')}`
      const out = resolve(OUT, name)
      writeFileSync(out, buf)
      saved.push({ out, mib: buf.length / 2 ** 20 })
    }
    console.log(`✓ [${label}] ${secs.toFixed(1)}s · ${saved.map((s) => `${s.out.split('/').pop()} (${s.mib.toFixed(1)} MiB)`).join(', ')}`)
    return { label, secs, saved }
  }
}

const targets = UPSCALER === 'both' ? ['ltx', 'lbh'] : [UPSCALER]
const LABELS = { none: 'draft-only', ltx: 'ltx', lbh: 'lbh' }
// upscaler=none：跳过二遍（纯 H3 草稿解码），用作对照臂
if (targets.includes('none')) {
  const i = targets.indexOf('none')
  targets[i] = 'none'
}
const results = []
for (const t of targets) results.push(await run(t, t))

console.log('\n=== 结果 ===')
for (const r of results) console.log(`  ${r.label.padEnd(4)} ${r.secs.toFixed(1)}s  ${r.saved.map((s) => s.out).join(' ')}`)
