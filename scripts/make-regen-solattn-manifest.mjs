// scripts/make-regen-solattn-manifest.mjs — 由 open-h3-regenerate-2k 派生 Sol-Attn 变体清单。
//
// 唯一差异：在 OpenH3RegenLora 与 BasicGuider 之间插一个原生 BlockSparseAttention（sol-attn），
// 其余 assets / params / regenerate 契约逐字保留。priority 比 base 低一档（-31），不做隐式默认。
//
// 用法：node scripts/make-regen-solattn-manifest.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = resolve(ROOT, 'workflows/minimax-h3-regenerate-2k.json')
const OUT = resolve(ROOT, 'workflows/minimax-h3-regenerate-2k-solattn.json')

const SOL = {
  selection: 'sol-attn',
  'selection.tau': 1.0,
  start_percent: 0.2,
  end_percent: 1,
  dense_blocks: '',
  min_tokens: 12288,
  extra_tokens: 256,
  sink_conditioning: 'exact_kv_and_rows',
  verbose: true,
}

const m = JSON.parse(readFileSync(BASE, 'utf8'))
m.id = 'open-h3-regenerate-2k-solattn'
m.displayName = 'MiniMax H3 视频重生成（Open-H3 · Sol-Attn · 2K/1080p）'
m.description =
  '与 open-h3-regenerate-2k 逐字相同，只把原生 BlockSparseAttention（sol-attn）插在合并 LoRA 之后。' +
  '实测（A800 80GB，124 帧 2K）：3 步采样 506.2s → 176.9s（2.86×），整轮 549.7s → 220.2s（2.50×）；' +
  'tau 1.3 再降到 149.7s / 193.9s（3.38× / 2.84×）。与 dense 输出 PSNR Y 31.2 dB、SSIM 0.930，1:1 目检无可见差。'
m.priority = -31
m.estSeconds = 194
m.note =
  'Sol-Attn 变体（原生 BlockSparseAttention，ComfyUI 0.42+ 内置，非第三方 SolAttnMiniMaxH3）。' +
  '实测：dense 549.7s → sol(tau1.0) 220.2s → sol(tau1.3) 193.9s（124 帧 / 2560×1440 / A800 80GB）；' +
  '解码器仍用 sol_h3_vae（快解码 19s vs 原版 54s）。与 dense 同 seed 输出 PSNR Y 31.2 / SSIM 0.930，' +
  '闪烁代理指标（相邻帧平均 |Δ|）7.20 vs dense 7.37（更稳）。仍是「重画内容」，产物必须抽帧核对身份/口型。'

// 插节点：8 UNETLoader → 9 OpenH3RegenLora → 8b BlockSparseAttention → 15 BasicGuider
const loraKey = Object.entries(m.graph).find(([, n]) => n.class_type === 'OpenH3RegenLora')?.[0]
const guider = Object.entries(m.graph).find(([, n]) => n.class_type === 'BasicGuider')
if (!loraKey || !guider) throw new Error('base 清单里找不到 OpenH3RegenLora / BasicGuider')
m.graph['8b'] = { class_type: 'BlockSparseAttention', inputs: { ...SOL, model: [loraKey, 0] } }
guider[1].inputs.model = ['8b', 0]
m.requiresNodes = [...new Set([...(m.requiresNodes || []), 'BlockSparseAttention'])].sort()

writeFileSync(OUT, JSON.stringify(m, null, 2) + '\n')
console.log('[make-regen-solattn] 写入', OUT)
