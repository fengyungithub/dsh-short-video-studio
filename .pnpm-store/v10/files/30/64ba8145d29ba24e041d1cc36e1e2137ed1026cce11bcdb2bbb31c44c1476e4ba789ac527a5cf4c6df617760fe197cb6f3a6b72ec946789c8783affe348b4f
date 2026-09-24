/**
 * scripts/make-h3-ctx-templates.mjs — 派生「i2v 版链式续接」模板（生成物，勿手改）。
 *
 * 背景：r2v 的链式续接（Motion Context）靠 4 个节点挂在**条件节点之后**实现——
 *   MiniMaxH3MotionContextLoadLatent(20) → MiniMaxH3MotionContext(21) → BasicGuider 吃 21 的 conditioning
 *   MiniMaxH3MotionContextSaveLatent(22) 存本次采样的 latent；MiniMaxH3MotionContextTrim(23) 裁掉继承帧
 * 这套挂法与"用哪种条件节点"无关，所以 i2v（MiniMaxH3ImageToVideo）同样可以链式续接：
 * 本脚本把 r2v-ctx 模板里的这 4 个节点**原样搬到 i2v 模板**上（只改 conditioning / latent 的来源节点）。
 *
 * 产出（3 份 i2v 模板，对应 4 个档位变体）：
 *   minimax-h3-i2v-ctx.json         ← minimax-h3-i2v.json          （fast / quality 共用）
 *   minimax-h3-i2v-8step-ctx.json   ← minimax-h3-i2v-8step.json    （balanced）
 *   minimax-h3-pdd-i2v-ctx.json     ← minimax-h3-pdd-i2v.json      （balanced · PDD nfe=8）
 *
 * 用法：node scripts/make-h3-ctx-templates.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const TPL = join(here, 'h3-templates')

/** 链式续接的 4 个节点 + 两处重接线（条件节点 id 固定为 5，采样器输出 10，解码 11/11a，合成 12）。 */
const CHAIN_NODES = (cond = '5') => ({
  // 读取上一镜的 latent（起链时 clip_index=0 = 没有上文，节点原样放行）
  20: { class_type: 'MiniMaxH3MotionContextLoadLatent', inputs: { latent_path: 'h3_context', clip_index: null } },
  // 把上一镜结尾拼进条件与 latent（输出 0 = conditioning，输出 1 = 要裁掉的继承帧数）
  21: {
    class_type: 'MiniMaxH3MotionContext',
    inputs: { conditioning: [cond, 0], vae: ['4', 0], latent: [cond, 1], context_length: '22', audio_context_length: 24, context_latent: ['20', 0] },
  },
  // 存本镜 latent 供下一镜续接
  22: { class_type: 'MiniMaxH3MotionContextSaveLatent', inputs: { latent: ['10', 0], filename_prefix: 'h3_context/clip', clip_index: null } },
  // 裁掉继承帧并按尾部对齐声音
  23: { class_type: 'MiniMaxH3MotionContextTrim', inputs: { images: ['11', 0], trim_frames: ['21', 1], audio: ['11a', 0], fps: 24, match_tail: true } },
})

const CHAIN_PARAMS = {
  context_length: { inject: 'scalar', to: { node: '21', field: 'context_length' }, default: '22' },
  audio_context_length: { inject: 'scalar', to: { node: '21', field: 'audio_context_length' }, default: 24 },
  context_clip_index: { inject: 'scalar', to: { node: '20', field: 'clip_index' } },
  save_clip_index: { inject: 'scalar', to: { node: '22', field: 'clip_index' } },
}

const CHAIN_REQUIRES = [
  'MiniMaxH3MotionContext',
  'MiniMaxH3MotionContextLoadLatent',
  'MiniMaxH3MotionContextSaveLatent',
  'MiniMaxH3MotionContextTrim',
]

const DERIVATIONS = [
  { out: 'minimax-h3-i2v-ctx.json', from: 'minimax-h3-i2v.json' },
  { out: 'minimax-h3-i2v-8step-ctx.json', from: 'minimax-h3-i2v-8step.json' },
  { out: 'minimax-h3-pdd-i2v-ctx.json', from: 'minimax-h3-pdd-i2v.json' },
]

let written = 0
for (const { out, from } of DERIVATIONS) {
  const src = JSON.parse(readFileSync(join(TPL, from), 'utf8'))
  const ctxRef = JSON.parse(readFileSync(join(TPL, 'minimax-h3-ref2v-ctx.json'), 'utf8'))

  const m = JSON.parse(JSON.stringify(src))
  const g = m.graph

  // ① 挂 4 个链式节点
  Object.assign(g, CHAIN_NODES('5'))
  // ② 条件节点输出改走 Motion Context（guider 吃 21 的 conditioning）
  if (g['7']?.inputs?.conditioning?.join(',') !== '5,0') throw new Error(`${from}: 预期 BasicGuider.conditioning=["5",0]，实际 ${JSON.stringify(g['7']?.inputs?.conditioning)}`)
  g['7'].inputs.conditioning = ['21', 0]
  // ③ 合成视频改吃裁剪后的画面/音频（保持模型生成的尾部对齐）
  if (g['12']?.inputs?.images?.join(',') !== '11,0') throw new Error(`${from}: 预期 CreateVideo.images=["11",0]`)
  g['12'].inputs.images = ['23', 0]
  g['12'].inputs.audio = ['23', 1]

  // ④ 链式参数（与 r2v-ctx 完全一致；首帧/末帧注入参数保持不动）
  Object.assign(m.params, CHAIN_PARAMS)

  // ⑤ 声明链式续接：runner 据此注入 Load/Save 序号、多采 sampleExtra 帧再裁掉
  m.chain = { source: ctxRef.chain.source, sampleExtra: ctxRef.chain.sampleExtra, lengthGrid: ctxRef.chain.lengthGrid }
  if (ctxRef.lengthGrid && !m.lengthGrid) m.lengthGrid = ctxRef.lengthGrid
  // 合并而不是覆盖：base 自己可能已经依赖别的第三方节点（如 PDD 基座的 MiniMaxH3PDDAccApply），
  // 覆盖会让可用性预检漏判——2026-09 修：pdd-i2v-ctx 曾因此丢掉 PDDAccApply。
  m.requiresNodes = [...new Set([...(src.requiresNodes || []), ...CHAIN_REQUIRES])]

  // ⑥ provenance
  m.description = `${src.description || src.id}（链式续接：继承上一镜尾部画面与音频）`
  m.note = `i2v 版链式续接模板，由 ${from} + r2v-ctx 的 Motion Context 节点派生（scripts/make-h3-ctx-templates.mjs 生成，勿手改）`

  writeFileSync(join(TPL, out), JSON.stringify(m, null, 2) + '\n', 'utf8')
  written++
  console.log(`✓ ${out}  ← ${from}（+ 节点 20/21/22/23，chain sampleExtra=${m.chain.sampleExtra}，lengthGrid=[${m.chain.lengthGrid}]）`)
}
console.log(`\n生成 ${written} 份 i2v ctx 模板。下一步：node scripts/make-h3-variants.mjs 生成清单。`)
