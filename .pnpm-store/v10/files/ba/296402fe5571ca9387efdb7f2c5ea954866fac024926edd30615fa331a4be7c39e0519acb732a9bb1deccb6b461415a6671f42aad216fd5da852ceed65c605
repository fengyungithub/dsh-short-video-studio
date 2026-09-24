// i2v 平衡档实测：同首帧 / 同 prompt / 同 seed，只换配方（8 步 + fl2v 768p LoRA + shift 6/3 + euler）。
// 用于给 workflows/minimax-h3-i2v-balanced.json 的 estSeconds 取真值。
//
// 用法：node scripts/bench-i2v-balanced.mjs [--dry]
//   --dry 只打印将要提交的图参数，不提交。
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _internals } from '../lib/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.COMFY || 'http://localhost:8188'
const DRY = process.argv.includes('--dry')

const TEMPLATE = process.env.TEMPLATE || 'minimax-h3-i2v-8step'
const FIRST_FRAME = process.env.FIRST_FRAME || '7ad764ef-6c26-4a5a-a5da-92637e02b24c_00001_.png'
const LOCAL_FRAME = resolve(ROOT, 'e2e-out/e2e-zimage_00001_.png')
const SEED = Number(process.env.SEED || 42424242)
const LENGTH = Number(process.env.LENGTH || 124)
const ASPECT = process.env.ASPECT || '16:9'

const PROMPT =
  'integrated_multimodal_description: [Shot 1] 3D-animated film look, 5 seconds, continuing seamlessly from the provided first frame. ' +
  'A single cartoon fox in a small orange spacesuit with a backpack stands on a gray moon surface with fine dust and small craters under a dark starry sky. ' +
  'The camera pushes in slowly at eye level. The fox takes two small steps forward, its ears lift, then it tilts its head up to look at the stars. ' +
  'Soft rim light from the upper left, cool blue ambient light, dust puffs rising under its boots. The fox\u2019s identity, fur color and spacesuit must stay exactly as in the first frame.\n' +
  'How the reference pictures align: the first frame defines the opening composition, camera height, lighting and the character\u2019s position; ' +
  'the shot starts on that exact frame and moves forward from it without a cut.\n\n' +
  'overall_soundscape: Quiet lunar ambience, soft hiss from the life-support backpack, two crunching boot steps on dust, faint radio static.\n\n' +
  'non_diegetic_music: Soft warm strings pad at low volume, no percussion.'

// 1) 由模板直接构造一次性 manifest（不落盘，避免 estSeconds 的鸡生蛋问题）
const tpl = JSON.parse(readFileSync(resolve(ROOT, 'scripts/h3-templates', TEMPLATE + '.json'), 'utf8'))
const manifest = {
  ...tpl,
  id: 'minimax-h3-i2v-balanced',  // 用真 id：顺带验证 assetOverrides 从旧 id 的继承（fl2va base / int8 VAE）
  capability: 'video.image2video',
  group: 'minimax-h3-i2v',
  tier: 'balanced',
  modes: { balanced: tpl.modes.balanced },
  estSeconds: 1,
}

// 2) 确保首帧在 ComfyUI input 目录（不存在则上传本地图）
async function ensureFirstFrame() {
  const probe = await fetch(`${BASE}/view?filename=${encodeURIComponent(FIRST_FRAME)}&type=input`)
  if (probe.ok) return FIRST_FRAME
  const buf = readFileSync(LOCAL_FRAME)
  const form = new FormData()
  form.append('image', new Blob([buf], { type: 'image/png' }), FIRST_FRAME)
  form.append('overwrite', 'true')
  const up = await fetch(`${BASE}/upload/image`, { method: 'POST', body: form })
  if (!up.ok) throw new Error(`上传首帧失败: ${up.status} ${await up.text()}`)
  return (await up.json()).name || FIRST_FRAME
}

const firstFrame = await ensureFirstFrame()
const { graph } = _internals.buildRenderGraph(
  manifest,
  { mode: 'balanced', prompt: PROMPT, seed: SEED, length: LENGTH, first_frame: firstFrame },
  ASPECT,
)

const g = Object.values(graph)
const node = (cls) => g.find((n) => n.class_type === cls)
const cond = node('MiniMaxH3ImageToVideo')
console.log('提交参数：')
console.log('  能力/档位 :', manifest.capability, '/ balanced')
console.log('  尺寸/帧数 :', cond.inputs.width + 'x' + cond.inputs.height, '/', cond.inputs.length)
console.log('  步数/采样 :', node('BasicScheduler').inputs.steps, '步 /', node('KSamplerSelect').inputs.sampler_name)
console.log('  shift     :', node('MiniMaxH3SigmaShift').inputs.shift_video + '/' + node('MiniMaxH3SigmaShift').inputs.shift_audio)
console.log('  unet      :', node('UNETLoader').inputs.unet_name)
const loraNode = g.filter((n) => n.class_type === 'LoraLoaderModelOnly')
console.log('  LoRA      :', loraNode.map((n) => n.inputs.lora_name).join(' + ') || '无')
console.log('  首帧/seed :', firstFrame, '/', node('RandomNoise').inputs.noise_seed)
console.log('  VAE       :', node('VAELoader').inputs.vae_name)

if (DRY) process.exit(0)

// 3) 提交并计时（wall clock，含排队；与文档口径一致）
const clientId = 'bench-i2v-balanced-' + Date.now()
const t0 = Date.now()
const sub = await fetch(`${BASE}/prompt`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: graph, client_id: clientId }),
})
if (!sub.ok) {
  console.error('提交失败:', sub.status, (await sub.text()).slice(0, 600))
  process.exit(1)
}
const { prompt_id: pid } = await sub.json()
console.log('\nprompt_id:', pid, '→ 轮询中…')

let last
for (;;) {
  await new Promise((r) => setTimeout(r, 5000))
  const h = await (await fetch(`${BASE}/history/${pid}`)).json()
  const entry = h[pid]
  if (entry) {
    const msgs = entry.status?.messages || []
    const done = msgs.some((m) => m[0] === 'execution_success' || m[0] === 'execution_error')
    if (done) {
      last = entry
      break
    }
    const exec = msgs.find((m) => m[0] === 'executing')
    process.stdout.write(`  ${Math.round((Date.now() - t0) / 1000)}s (node ${exec?.[1]?.node ?? '-'})\r`)
  }
  if (Date.now() - t0 > 30 * 60 * 1000) throw new Error('超时')
}

const msgs = last.status.messages
const a = msgs.find((m) => m[0] === 'execution_start')?.[1]?.timestamp
const b = msgs.find((m) => m[0] === 'execution_success')?.[1]?.timestamp
const err = msgs.find((m) => m[0] === 'execution_error')?.[1]
const wall = (Date.now() - t0) / 1000
const inner = a && b ? (b - a) / 1000 : null
console.log('\n结果：')
if (err) {
  console.log('  ❌ 执行失败:', JSON.stringify(err).slice(0, 500))
  process.exit(1)
}
console.log('  内部执行耗时:', inner ? inner.toFixed(1) + 's' : '(缺时间戳)')
console.log('  端到端(wall):', wall.toFixed(1) + 's')
const out = last.outputs && Object.values(last.outputs).find((o) => o.images || o.gifs)
const file = out && (out.gifs || out.images)?.[0]
console.log('  产物:', file ? `${file.filename}（${(file.type || 'output')}）` : '(未找到)')
console.log('\n建议 estSeconds ≈', inner ? Math.round(inner) : Math.round(wall))
