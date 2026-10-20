// 由 PDD + 链式续接模板派生「原生块稀疏（BlockSparseAttention sol-attn）」版本。
//
// 为什么走 ComfyUI 原生节点而不是第三方 Sol-Attn：
//   第三方 `SolAttnMiniMaxH3` 用 `torch.compile(flex_attention)`，在 ComfyUI 0.35+ 的
//   `cudaMallocAsync` 分配器上会在 `cuMemFreeAsync` 处 abort（见 docs/minimax-h3-acceleration-lora.md §9.10，
//   2026-10-20 在 0.37.2 与 0.42.1 上各复现一次，第二次带崩整机）。
//   0.42 起 ComfyUI 原生提供 `BlockSparseAttention`（sol-attn / sla / vsa），走 comfy_kitchen 的
//   CUDA 扩展，不经过那条分配器路径；实测 PDD+ctx 176.0s → 112.2s（1.57×）。
//
// 图手术（固定 2 处）：
//   1) 新增 node 2b = BlockSparseAttention（吃 2a 打过的 model，吐 MODEL）
//      - tau=1.3（默认，保留约 7% 精确块）；start/end=0.2/1.0；min_tokens=12288
//      - sink_conditioning="exact_kv_and_rows"（H3 专用：文本/音频/参考前缀保持精确，
//        并让目标音频的 query 行走 dense —— 否则音频会先退化）
//   2) node 7 BasicGuider.model 改指 2b；10 SamplerCustomAdvanced.sigmas 仍取 2a（PDD 训练网格）
//
// 用法：node scripts/make-h3-solattn-template.mjs [--check]
//   --check 只校验生成结果与现有文件一致，不写盘。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = resolve(ROOT, 'scripts/h3-templates')

const SPECS = [
  {
    from: 'minimax-h3-pdd-ref2v-ctx.json',
    out: 'minimax-h3-pdd-ref2v-ctx-solattn.json',
    note: '链式续接 · PDD nfe=8 + 原生 BlockSparseAttention(sol-attn, tau 1.0) · 实测 112.7s（对 PDD+ctx 163.1–176.0s 为 1.45–1.57×）',
  },
  {
    // 非 PDD 路径（quality 20 步；模板同时保留 fast/quality 两档，清单各取一档）
    from: 'minimax-h3-ref2v-ctx.json',
    out: 'minimax-h3-ref2v-ctx-solattn.json',
    note: '链式续接 · 原生 BlockSparseAttention(sol-attn, tau 1.0) · quality 20 步实测 253.8s（对 379.1s 为 1.49×）· fast 档未实测',
  },
  {
    // i2v 的非 PDD 路径（quality 20 步；模板保留 fast/quality 两档，清单各取一档）
    from: 'minimax-h3-i2v-ctx.json',
    out: 'minimax-h3-i2v-ctx-solattn.json',
    note: 'i2v 链式续接 · 原生 BlockSparseAttention(sol-attn, tau 1.0) · quality 20 步实测 253.9s（对 382.7s 为 1.51×）· fast 档未实测',
  },
  {
    from: 'minimax-h3-pdd-i2v-ctx.json',
    out: 'minimax-h3-pdd-i2v-ctx-solattn.json',
    note: 'i2v 链式续接 · PDD nfe=8 + 原生 BlockSparseAttention(sol-attn, tau 1.0) · 继承上一镜尾部、末帧锚点保留 · 实测 116.1s@tau1.3，tau1.0 约 120s（推算）',
  },
]

/** 原生块稀疏节点（H3 专用参数：sink_conditioning 保住文本/音频/参考前缀与目标音频行）。 */
const SOLATTN = (modelId) => ({
  class_type: 'BlockSparseAttention',
  inputs: {
    model: [modelId, 0],
    selection: 'sol-attn',
    'selection.tau': 1.0,
    start_percent: 0.2,
    end_percent: 1.0,
    dense_blocks: '',
    min_tokens: 12288,
    extra_tokens: 256,
    sink_conditioning: 'exact_kv_and_rows',
    verbose: true,
  },
})

const CHECK = process.argv.includes('--check')
let written = 0
const changed = []

for (const spec of SPECS) {
  const src = JSON.parse(readFileSync(resolve(DIR, spec.from), 'utf8'))
  const m = JSON.parse(JSON.stringify(src))
  const g = m.graph

  // 挂载点：PDD 模板挂在 PDD 节点（2a）之后；非 PDD 模板直接挂 SigmaShift（2）之后。
  const applyId = Object.entries(g).find(([, n]) => n.class_type === 'MiniMaxH3PDDAccApply')?.[0]
  const attachTo = applyId || '2'
  const attachType = g[attachTo]?.class_type
  if (attachType !== 'MiniMaxH3PDDAccApply' && attachType !== 'MiniMaxH3SigmaShift') {
    throw new Error(`${spec.from} 的挂载点 ${attachTo} 既不是 PDD 也不是 SigmaShift（实际 ${attachType}）`)
  }
  if (g['2b']) throw new Error(`${spec.from} 已存在 2b，避免覆盖`)

  // ① 插节点
  g['2b'] = SOLATTN(attachTo)
  // ② guider 改指 2b（sigmas 仍由 2a 输出，不动 10）
  const guider = g['7']
  if (!guider || guider.class_type !== 'BasicGuider') throw new Error('guider（node 7）缺失或类型不对')
  const before = JSON.stringify(guider.inputs.model)
  guider.inputs.model = ['2b', 0]
  // BasicScheduler 若直接用 MODEL（非 PDD 的 sigmas 路径），同样要挂在 2b 上
  if (g['9']) {
    const b9 = JSON.stringify(g['9'].inputs.model)
    if (b9 === JSON.stringify([attachTo, 0])) { g['9'].inputs.model = ['2b', 0]; changed.push(`  ${spec.from} → ${spec.out}: 9.model ${b9} → ["2b",0]`) }
  }
  changed.push(`  ${spec.from} → ${spec.out}: 7.model ${before} → ["2b",0]`)

  m.id = spec.out.replace(/\.json$/, '')
  const isI2v = m.capability === 'video.image2video'
  m.displayName = isI2v
    ? 'MiniMax H3 首末帧·链式续接（PDD + 原生块稀疏）'
    : 'MiniMax H3 参考视频·链式续接（PDD + 原生块稀疏）'
  m.description = `${isI2v ? 'MiniMax H3 首末帧' : 'MiniMax H3 参考视频'} · 链式续接 + PDD 8 步 + 原生 BlockSparseAttention（sol-attn）。由 scripts/make-h3-solattn-template.mjs 生成，请勿手改。`
  m.note = spec.note

  const text = JSON.stringify(m, null, 2) + '\n'
  const target = resolve(DIR, spec.out)
  let current = null
  try { current = readFileSync(target, 'utf8') } catch {}
  if (current === text) { console.log(`  = ${spec.out}（无变化）`); continue }
  if (CHECK) { console.error(`  ✗ ${spec.out} 与脚本不一致（--check）`); process.exitCode = 1; continue }
  writeFileSync(target, text, 'utf8')
  written++
  console.log(`  ✓ 写出 ${spec.out}`)
}

console.log(`\n${CHECK ? '校验' : '完成'}：${changed.length ? '\n' + changed.join('\n') : '（无改动）'}${written ? `，写出 ${written} 份` : ''}`)
