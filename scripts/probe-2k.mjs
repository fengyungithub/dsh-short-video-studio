/**
 * scripts/probe-2k.mjs — U1 方案（>2K：学习式 latent 放大 + 低 σ 精修）可行性探针。
 *
 * 这是**接线探针**，不是清单验收：它借用已上线的 hires 清单（拿到真实的 asset 解析、
 * prompt/refs 注入），然后把图**原地改接**成学习式放大器路径，直接提交给 ComfyUI。
 * 目的只有一个：在把接线固化进模板之前，先确认
 *   ① 跑得通（无 OOM / 无参数校验失败）
 *   ② 交付分辨率真的落在 2688×1536
 *   ③ 音轨还在、口型没崩
 *   ④ 没有学习式 ×2 特有的 32px 周期网格伪影
 *
 * 两种接线（`--variant`）：
 *   v2（默认）单节点：pass1 的 AV latent → MinimaxH3LatentUpscaler3DRefineHandoff
 *        （节点自带「学习式放大 + 低 σ 采样器 2」，输出 decode-ready）
 *   v1（显式）三段：LTXVSeparateAVLatent → MinimaxH3LatentUpscalerNode2D(scale 2)
 *        → LTXVConcatAVLatent → BasicScheduler/新噪声 → SamplerCustomAdvanced
 *
 * 用法：
 *   node scripts/probe-2k.mjs --dry                      # 只打印改接后的图，不提交
 *   node scripts/probe-2k.mjs --frames 56 --steps 20 --steps2 3 --denoise 0.3
 *   node scripts/probe-2k.mjs --variant v1 --tag v1s56
 */

process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || `${process.env.HOME}/.dsh/dsh-short-video-studio.json`

import { _internals } from '../lib/index.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.DSH_SVS_COMFY_URL || 'http://localhost:8188'
const UPSCALER = 'minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const has = (k) => argv.includes('--' + k)
const num = (k, d) => { const v = arg(k, undefined); return v === undefined ? d : Number(v) }

// 首遍尺寸：模型原生上限（学习式放大器吃的就是这个尺寸的干净 latent）
const GW = num('graph-w', 1344)
const GH = num('graph-h', 768)
// 交付目标：正好 2×（全部落在 16× VAE 网格与 32 对齐网格上）
const TW = num('target-w', GW * 2)
const TH = num('target-h', GH * 2)

const VARIANT = arg('variant', 'v2')
const FRAMES = num('frames', 56)
const STEPS = num('steps', 20)
const STEPS2 = num('steps2', 3)
const DENOISE = num('denoise', 0.3)
const SEED = num('seed', 20260921)
const TAG = arg('tag', `${VARIANT}s${STEPS}f${FRAMES}`)
const DRY = has('dry')
const PROMPT = arg('prompt',
  'A narrow rain-soaked alley at dusk. A woman in a red coat walks toward the camera, umbrella tilted forward, ' +
  'neon signage reflecting in the puddles. She stops, looks up, rain streaks across the frame. ' +
  'Handheld camera pushes in slowly. Ambient rain and distant traffic. No subtitles.')

const { buildGraphFromManifest, getRegistry, getAssetOverrides } = _internals

// 借已上线的 hires 清单解析 asset（unet/clip/vae/audio_vae），再改接图
const m = getRegistry().byId['minimax-h3-ref2v-hires']
if (!m) throw new Error('找不到 hires 清单（先跑 node scripts/make-h3-variants.mjs）')

const prefix = `e2e-2k/${TAG}`
const graph = buildGraphFromManifest(m, {
  prompt: PROMPT, width: GW, height: GH, length: FRAMES, seed: SEED,
  steps: STEPS, prefix, refs: [], first_frame: null, last_frame: null,
  assetOverrides: getAssetOverrides(m.id),
})

// resolutionLock 会把首遍摁回 896×512——探针要的是原生 1344×768，所以直接改回注入值
graph['5'].inputs.width = GW
graph['5'].inputs.height = GH

// 二遍噪声必须与首遍不同，否则退化成重放首遍的高噪声步
graph['6b'].inputs.noise_seed = SEED + 2000000
graph['9b'].inputs.steps = STEPS2
graph['9b'].inputs.denoise = DENOISE

if (VARIANT === 'v2') {
  // 单节点：学习式放大 + 低 σ 采样器 2（输出 decode-ready latent）
  delete graph['14']
  delete graph['10b']
  graph['17'] = {
    class_type: 'MinimaxH3LatentUpscaler3DRefineHandoff',
    inputs: {
      latent: ['10', 0],        // pass-1 的 AV latent（音轨由其内部按 lock_audio 处理）
      noise: ['6b', 0],
      sampler: ['8', 0],
      sigmas: ['9b', 0],
      model: ['2', 0],          // 已做视频 12 / 音频 3 shift 的模型
      positive: ['5', 0],
      model_name: UPSCALER,
      mode: 'target dimensions',
      width: TW,
      height: TH,
      scale: 2,
      megapixels: 1,
      align: 32,
      keep_proportion: true,
      lock_audio: true,
      cfg: 1,
      device: 'cuda',
      precision: 'bf16',
      offload_after_upscale: true,
    },
  }
  graph['11b'].inputs.samples = ['17', 0]
  graph['11c'].inputs.samples = ['17', 0]
} else if (VARIANT === 'v1') {
  // 显式三段：拆 AV → 学习式放大视频 → 合回 AV → 低 σ 精修
  delete graph['14']
  graph['16'] = { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['10', 0] } }
  graph['17'] = {
    class_type: 'MinimaxH3LatentUpscalerNode2D',
    inputs: {
      latent: ['16', 0],
      model_name: UPSCALER,
      scale: 2,
      device: 'cuda',
      precision: 'bf16',
    },
  }
  graph['18'] = { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['17', 0], audio_latent: ['16', 1] } }
  graph['10b'].inputs.latent_image = ['18', 0]
} else if (VARIANT === 'native') {
  // 对照组：只跑首遍，不放大、不精修 —— 用来判断「2K 到底有没有多出真细节」
  delete graph['14']
  delete graph['6b']
  delete graph['9b']
  delete graph['10b']
  graph['11b'] = { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['4', 0] } }
  graph['11c'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['10', 0], vae: ['4a', 0] } }
} else {
  throw new Error(`未知 variant: ${VARIANT}（可选 v1 / v2 / native）`)
}

if (DRY) {
  console.log(JSON.stringify(graph, null, 2))
  process.exit(0)
}

// 码率混杂项：SaveVideo 的默认编码会先把最高频压掉，让「精修到底有没有造细节」判错。
// 传 --crf N 改成显式 re-encode（高码率重编）；采样链命中缓存时只会重跑编码，几秒钟。
const CRF = num('crf', undefined)
if (CRF !== undefined) {
  const sv = Object.values(graph).find((n) => n.class_type === 'SaveVideo')
  if (!sv) throw new Error('图里没有 SaveVideo，无法注入 crf')
  sv.inputs.format = 'mp4'
  sv.inputs.codec = 'h264'
  sv.inputs.encoding = 're-encode'
  sv.inputs.crf = CRF
  console.log(`  ⚙ SaveVideo 改为 h264 re-encode crf=${CRF}（排除默认码率对高频的压制）`)
}

const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`)
  return r.json()
}

console.log(`ComfyUI ${BASE} · variant=${VARIANT} · 首遍 ${GW}×${GH} → 交付 ${TW}×${TH} · ${FRAMES} 帧 · 步数 ${STEPS}+${STEPS2}(denoise ${DENOISE})`)
const t0 = Date.now()
try {
  const { prompt_id } = await post('/prompt', { prompt: graph, client_id: 'probe-2k' })
  console.log(`  ▸ 已提交 prompt_id=${prompt_id.slice(0, 8)}`)
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000))
    const h = await (await fetch(`${BASE}/history/${prompt_id}`)).json()
    const entry = h[prompt_id]
    if (!entry) continue
    const st = entry.status?.status_str
    if (st === 'error') {
      const msgs = (entry.status?.messages || []).filter((x) => x[0] === 'execution_error').map((x) => JSON.stringify(x[1]).slice(0, 700))
      throw new Error(`执行失败：${msgs.join(' | ')}`)
    }
    const secs = (Date.now() - t0) / 1000
    const files = Object.values(entry.outputs || {}).flatMap((o) => o.videos || o.images || [])
    console.log(`  ✓ 完成：${secs.toFixed(1)}s，产物 ${JSON.stringify(files.map((f) => f.filename))}`)
    mkdirSync(resolve(ROOT, 'e2e-out/2k'), { recursive: true })
    for (const f of files) {
      const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? 'e2e-2k', type: f.type ?? 'output' })
      const buf = Buffer.from(await (await fetch(`${BASE}/view?${q}`)).arrayBuffer())
      const out = resolve(ROOT, `e2e-out/2k/${TAG}-${f.filename.replace(/^.*\//, '')}`)
      writeFileSync(out, buf)
      console.log(`    已存 ${out}（${(buf.length / 2 ** 20).toFixed(1)} MiB）`)
    }
    break
  }
} catch (e) {
  console.error('✗ ' + e.message)
  process.exit(1)
}
