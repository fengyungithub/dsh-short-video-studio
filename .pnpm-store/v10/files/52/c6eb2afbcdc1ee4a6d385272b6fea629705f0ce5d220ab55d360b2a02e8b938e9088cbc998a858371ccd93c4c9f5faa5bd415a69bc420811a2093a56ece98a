/**
 * scripts/probe-pdd-sigmas.mjs — PDD 调度「是否在训练网格上」的结构性验证（不出片，秒级）。
 *
 * 为什么需要它：2K-PDD 变体的全部理论前提是
 *   `MiniMaxH3PDDAccScheduler(nfe=8, denoise=0.3)` 给出的 σ 序列 == 训练网格的**尾部**，
 *   也就是 `PDDAccApply` 认可的 on-grid σ（否则 `on_off_grid='error'` 会在采样时直接报错）。
 * 这一步跑通之前，出片 A/B 没有意义。
 *
 * 同时给出一条独立核对：`Apply.sigmas`（节点自称的「训练网格」）与
 * `PDDAccScheduler(nfe=8, denoise=1.0)` 是否一致 —— 一致则调度器是忠实的网格生成器。
 *
 * 用法：node scripts/probe-pdd-sigmas.mjs [--nfe 8] [--denoise 0.3]
 */
process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || `${process.env.HOME}/.dsh/dsh-short-video-studio.json`

import { _internals } from '../lib/index.js'

const BASE = process.env.DSH_SVS_COMFY_URL || 'http://localhost:8188'
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const NFE = String(arg('nfe', '8'))
const DENOISE = Number(arg('denoise', 0.3))

const { comfySubmit, comfyWait, getCfg } = _internals
const cfg = getCfg()

// 资产名优先取配置，回落到模板默认
const UNET = cfg.models?.h3RefUnet || 'minimax_h3_ref2va_pruned_int8_convrot.safetensors'
const PDD = cfg.models?.h3PddRef2v || 'minimax_h3_ref2va_pdd_acc_8step_comfyui.safetensors'

const graph = {
  '1': { class_type: 'UNETLoader', inputs: { unet_name: UNET, weight_dtype: 'default' } },
  '2': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['1', 0], shift_video: 12, shift_audio: 3 } },
  '2a': {
    class_type: 'MiniMaxH3PDDAccApply',
    inputs: {
      model: ['2', 0], pdd_file: PDD, nfe: NFE, lora_strength: 1, head_strength: 1,
      on_off_grid: 'error', partition: '', enabled: true, partition_check: 'error',
    },
  },
  s_full: { class_type: 'MiniMaxH3PDDAccScheduler', inputs: { nfe: NFE, denoise: 1.0, partition: '' } },
  s_part: { class_type: 'MiniMaxH3PDDAccScheduler', inputs: { nfe: NFE, denoise: DENOISE, partition: '' } },
  // base 模型的调度网格：用来回答「base 的 pass 2 从哪个 σ 起跑，与 PDD 的 0.8 差多少」
  b20: { class_type: 'BasicScheduler', inputs: { model: ['2', 0], scheduler: 'simple', steps: 20, denoise: 1.0 } },
  b6: { class_type: 'BasicScheduler', inputs: { model: ['2', 0], scheduler: 'simple', steps: 6, denoise: DENOISE } },
  p_b20: { class_type: 'PreviewAny', inputs: { source: ['b20', 0] } },
  p_b6: { class_type: 'PreviewAny', inputs: { source: ['b6', 0] } },
  p_apply: { class_type: 'PreviewAny', inputs: { source: ['2a', 1] } },
  p_full: { class_type: 'PreviewAny', inputs: { source: ['s_full', 0] } },
  p_part: { class_type: 'PreviewAny', inputs: { source: ['s_part', 0] } },
  p_info: { class_type: 'PreviewAny', inputs: { source: ['2a', 2] } },
}

console.log(`PDD 调度探针 · unet=${UNET} · pdd=${PDD} · nfe=${NFE} · denoise=${DENOISE}`)
const id = await comfySubmit(graph)
console.log('已提交', id, '（等结果…）')
const entry = await comfyWait(id)

const texts = {}
for (const [nid, out] of Object.entries(entry.outputs || {})) {
  texts[nid] = out?.text ?? out
}
const pick = (key) => {
  const t = texts[key]
  if (t === undefined) return null
  return Array.isArray(t) ? t.join('\n') : String(t)
}

const parseSigmas = (s) => {
  if (!s) return null
  const nums = String(s).match(/-?\d+\.?\d*(?:e[-+]?\d+)?/gi)
  return nums ? nums.map(Number) : null
}

const full = parseSigmas(pick('p_full'))
const part = parseSigmas(pick('p_part'))
const apply = parseSigmas(pick('p_apply'))
const b20 = parseSigmas(pick('p_b20'))
const b6 = parseSigmas(pick('p_b6'))

console.log('\n--- raw ---')
for (const k of ['p_apply', 'p_full', 'p_part', 'p_b20', 'p_b6', 'p_info']) {
  const v = pick(k)
  console.log(`[${k}] ${v ? v.slice(0, 400).replace(/\n/g, ' ') : '(无输出)'}`)
}

console.log('\n--- 判据 ---')
if (full) console.log(`PDD 网格 (denoise=1.0, ${full.length} 点):`, full.map((x) => x.toFixed(4)).join(', '))
if (part) console.log(`PDD denoise=${DENOISE} (${part.length} 点):`, part.map((x) => x.toFixed(4)).join(', '))
if (b20) console.log(`base simple/20 步 (${b20.length} 点):`, b20.map((x) => x.toFixed(4)).join(', '))
if (b6) console.log(`base simple/6 步/denoise=${DENOISE} (${b6.length} 点):`, b6.map((x) => x.toFixed(4)).join(', '))
if (b6 && part) {
  console.log(`\n★ σ 起跑点对比：base pass2 σ0=${b6[0].toFixed(4)}  vs  PDD pass2 σ0=${part[0].toFixed(4)}` +
    `  ⇒ 比值 ${(part[0] / b6[0]).toFixed(2)}×`)
}

const tail = (arr, n) => arr.slice(arr.length - n)
const cmp = (a, b, tol = 1e-6) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol)

if (full && part) {
  const t = tail(full, part.length)
  const ok = cmp(t, part)
  console.log(ok
    ? `✓ denoise=${DENOISE} 的序列 == denoise=1.0 网格的尾部 ${part.length} 点 ⇒ 确实在训练网格上`
    : `✗ 尾部不匹配\n  网格尾: ${t.map((x) => x.toFixed(6)).join(', ')}\n  部分  : ${part.map((x) => x.toFixed(6)).join(', ')}`)
}
if (full && apply) {
  console.log(cmp(full, apply)
    ? '✓ Apply.sigmas == PDDAccScheduler(denoise=1.0) ⇒ 调度器是忠实的网格生成器'
    : `! Apply.sigmas 与调度器全网格不同（Apply ${apply.length} 点 / 调度器 ${full.length} 点）——需人工核对`)
}
console.log(`\nblocks = round(${NFE} × ${DENOISE}) = round(${(Number(NFE) * DENOISE).toFixed(3)}) = ${Math.round(Number(NFE) * DENOISE)}`)
