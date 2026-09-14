// 通用 H3 单次实测：从 scripts/h3-templates/ 的模板直接组图并跑真机，打印耗时与产物文件名。
// 用于 A/B 对照——两条臂只要 --ref-input / --seed / --length / --prompt 一致，差异就只来自配方。
//
// 用法示例：
//   node scripts/bench-h3.mjs --template=minimax-h3-pdd-ref2v --mode=balanced \
//     --ref-input=asset-character-fulu2.png --tag=pdd8
//   node scripts/bench-h3.mjs --template=minimax-h3-ref2v-8step --mode=balanced \
//     --ref-input=asset-character-fulu2.png --tag=l2v8
//   node scripts/bench-h3.mjs --template=minimax-h3-i2v-8step --mode=balanced \
//     --first-frame=7ad764ef-....png --tag=i2v8
// 参数：--dry（只打印配方不提交）、--length=124、--seed=42424242、--ratio=16:9、
//       --prompt="…"、--prompt-file=<path>、--ref-file=<本地 png 路径>（否则用 ComfyUI input 里的文件名）
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _internals } from '../lib/index.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.COMFY || 'http://localhost:8188'
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}
const DRY = process.argv.includes('--dry')

const TEMPLATE = arg('template', '')
const MODE = arg('mode', 'balanced')
const TAG = arg('tag', TEMPLATE)
const LENGTH = Number(arg('length', 124))
const SEED = Number(arg('seed', 42424242))
const RATIO = arg('ratio', '16:9')
const REF_INPUT = arg('ref-input', '')
const REF_FILE = arg('ref-file', '')
const FIRST_FRAME = arg('first-frame', '')
const PROMPT_FILE = arg('prompt-file', '')
const OVERRIDES = arg('overrides', '')   // JSON：资产覆盖（A/B 两条臂必须一致，如 int8 VAE）
const DEFAULT_PROMPT =
  'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n' +
  'integrated_multimodal_description: [Shot 1] 3D-animated film look, 5 seconds. A single cartoon fox wearing a small orange spacesuit with a backpack ' +
  'stands on a gray moon surface with fine dust and small craters under a dark starry sky. The camera pushes in slowly at eye level. ' +
  'The fox takes two small steps forward, its ears lift, then it tilts its head up to look at the stars. Soft rim light from the upper left, cool blue ambient light, ' +
  'dust puffs rising under its boots. The identity, fur color and spacesuit must stay exactly as in <Picture 1>.\n' +
  'How the reference pictures align: <Picture 1> defines the opening composition, character design, colors and lighting; the shot starts from that design and moves forward without a cut.\n\n' +
  'overall_soundscape: Quiet lunar ambience, soft hiss from the life-support backpack, two crunching boot steps on dust, faint radio static.\n\n' +
  'non_diegetic_music: Soft warm strings pad at low volume, no percussion.'
const PROMPT = PROMPT_FILE ? readFileSync(resolve(ROOT, PROMPT_FILE), 'utf8') : arg('prompt', DEFAULT_PROMPT)
if (!TEMPLATE) throw new Error('必须给 --template=<scripts/h3-templates 下的文件名，不含 .json>')

// 1) 由模板构造一次性 manifest（不落盘，避免 estSeconds 的鸡生蛋问题）
const tpl = JSON.parse(readFileSync(resolve(ROOT, 'scripts/h3-templates', TEMPLATE + '.json'), 'utf8'))
const mode = MODE || Object.keys(tpl.modes || {})[0]
const manifest = {
  ...tpl,
  id: `bench-${TAG}`,
  modes: { [mode]: tpl.modes[mode] },
  tier: mode,
  estSeconds: 1,
}

// 2) 参考资产：优先用 ComfyUI input 里已有的文件；给了本地路径则上传
async function ensureFile(name, localPath) {
  const probe = await fetch(`${BASE}/view?filename=${encodeURIComponent(name)}&type=input`)
  if (probe.ok) return name
  if (!localPath) throw new Error(`input 目录里没有 ${name}，且未给 --ref-file`)
  const up = await _internals.comfyUploadImage(readFileSync(resolve(ROOT, localPath)), name)
  return up?.name || name
}
const job = {
  mode,
  prompt: PROMPT,
  seed: SEED,
  length: LENGTH,
  prefix: `bench-${TAG}`,
}
if (REF_INPUT || REF_FILE) {
  const name = REF_INPUT || REF_FILE.split('/').pop()
  job.refs = [await ensureFile(name, REF_FILE)]
}
if (FIRST_FRAME) job.first_frame = await ensureFile(FIRST_FRAME, '')
if (OVERRIDES) job.assetOverrides = JSON.parse(OVERRIDES)

const { graph, size } = _internals.buildRenderGraph(manifest, job, RATIO)

// 3) 打印配方（A/B 前先肉眼核对两条臂的差异是否只在预期处）
const g = Object.values(graph)
const node = (cls) => g.find((n) => n.class_type === cls)
const pdd = node('MiniMaxH3PDDAccApply')
console.log(`[${TAG}] 配方：`)
console.log('  模板/档位 :', TEMPLATE, '/', mode, '| 尺寸:', size ? `${size.w}x${size.h}` : (node('MiniMaxH3ReferenceToVideo') || node('MiniMaxH3ImageToVideo')).inputs.width + 'x' + (node('MiniMaxH3ReferenceToVideo') || node('MiniMaxH3ImageToVideo')).inputs.height)
console.log('  步数/采样 :', node('BasicScheduler') ? node('BasicScheduler').inputs.steps + ' 步(BasicScheduler)' : `PDD nfe=${pdd?.inputs.nfe}`, '/', node('KSamplerSelect').inputs.sampler_name)
console.log('  shift     :', node('MiniMaxH3SigmaShift').inputs.shift_video + '/' + node('MiniMaxH3SigmaShift').inputs.shift_audio)
console.log('  unet      :', node('UNETLoader').inputs.unet_name)
const loras = g.filter((n) => n.class_type === 'LoraLoaderModelOnly').map((n) => n.inputs.lora_name)
console.log('  蒸馏 LoRA :', loras.join(' + ') || '无', pdd ? `| PDD: ${pdd.inputs.pdd_file}` : '')
console.log('  参考/seed :', (job.refs || [job.first_frame]).join(',') || '(无)', '/', node('RandomNoise').inputs.noise_seed)
console.log('  VAE       :', node('VAELoader').inputs.vae_name)
if (DRY) process.exit(0)

// 4) 提交并计时（内部执行耗时与 wall 都记；与文档口径一致用内部耗时）
const t0 = Date.now()
const pid = await _internals.comfySubmit(graph)
console.log(`\n[${TAG}] prompt_id=${pid} → 轮询…`)
const hist = await _internals.comfyWait(pid)
const msgs = hist.status?.messages || []
const a = msgs.find((m) => m[0] === 'execution_start')?.[1]?.timestamp
const b = msgs.find((m) => m[0] === 'execution_success')?.[1]?.timestamp
const err = msgs.find((m) => m[0] === 'execution_error')?.[1]
if (err) {
  console.log(`[${TAG}] ❌ 执行失败：`, JSON.stringify(err).slice(0, 600))
  process.exit(1)
}
const outs = _internals.comfyOutputs(hist)
console.log(`[${TAG}] ✅ 内部执行 ${a && b ? ((b - a) / 1000).toFixed(1) + 's' : '(缺时间戳)'} / wall ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log(`[${TAG}] 产物：`, JSON.stringify(outs).slice(0, 300))
