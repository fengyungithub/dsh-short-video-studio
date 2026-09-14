/**
 * scripts/make-h3-variants.mjs — 内置 H3 视频清单生成器（P2）。
 *
 * 契约：docs/tier-strategy-design.md
 *   「workflow 是原材料，注册表是策略」：**一个 json = 一个档位实现**。
 *   本脚本是唯一源头——从 scripts/h3-templates/ 的图模板产出 workflows/*.json（**产物，勿手改**）。
 *
 * 做三件事：
 *  1) 拆分：一个模板的某个 mode → 一份单档清单（modes 只剩该档，名称即档位名）
 *  2) 标注：id/group/tier/accel/requiresNodes/estSeconds/note（requiresNodes 由与标准版的
 *     节点类别差集自动推出——加速件依赖的第三方节点，是可用性预检的依据）
 *  3) 校验：validateManifest + buildGraphFromManifest 编译一次，并打印策略投影预览
 *
 * 用法：
 *   node scripts/make-h3-variants.mjs            # 产出到 workflows/
 *   node scripts/make-h3-variants.mjs --dry      # 只校验与打印，不写盘
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { validateManifest, buildGraphFromManifest } from '../lib/manifest.js'
import { _internals } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const TEMPLATE_DIR = join(__dirname, 'h3-templates')
const OUT_DIR = join(ROOT, 'workflows')
const DRY = process.argv.includes('--dry')

const GROUP_REF2V = { id: 'minimax-h3-ref2v', displayName: 'MiniMax H3 参考生成视频', capability: 'video.reference2video' }
const GROUP_I2V = { id: 'minimax-h3-i2v', displayName: 'MiniMax H3 首末帧生成视频', capability: 'video.image2video' }
// PDD 不单列策略组：它就是**四个普通清单**（…-balanced-pdd / …-balanced-pdd-sol），
// 归在与其它实现同一个家族组里，由用户自己在配置页「新增策略」时组合、命名。
// 策略由用户命名 ⇒ 注册表不再自动投影出「（PDD 蒸馏）」之类的条目。

/**
 * 变体表：一份 = 一个档位实现。
 * estSeconds 口径：16:9 · 124 帧 · 该档长边（来源 docs/minimax-h3-video-benchmark.md 实测）。
 */
const VARIANTS = [
  // ref2v ───────────────────────────────────────────────────────────────────
  { out: 'minimax-h3-ref2v-fast', group: GROUP_REF2V, tier: 'fast', template: 'minimax-h3-ref2v.json', mode: 'fast', estSeconds: 24.6, note: '4 步 LoRA · 长边 832 · 实测 24.6s' },
  { out: 'minimax-h3-ref2v-balanced', group: GROUP_REF2V, tier: 'balanced', template: 'minimax-h3-ref2v-8step.json', mode: 'balanced', estSeconds: 166.3, note: '8 步 768p LoRA · shift 6/3 · euler · 实测 166.3s' },
  { out: 'minimax-h3-ref2v-balanced-sol', group: GROUP_REF2V, tier: 'balanced', accel: 'sol', template: 'minimax-h3-ref2v-8step-sol.json', mode: 'balanced', estSeconds: 136.3, note: 'Sol-Attn 加速 · 实测 136.3s（1.23×，tau 1.2）' },
  { out: 'minimax-h3-ref2v-quality', group: GROUP_REF2V, tier: 'quality', template: 'minimax-h3-ref2v.json', mode: 'quality', estSeconds: 396.6, note: '20 步 · 实测 396.6s' },
  { out: 'minimax-h3-ref2v-quality-sol', group: GROUP_REF2V, tier: 'quality', accel: 'sol', template: 'minimax-h3-ref2v-sol.json', mode: 'quality', estSeconds: 311.2, note: 'Sol-Attn 加速 · 实测 311.2s（1.27×）' },
  // i2v balanced（2026 补齐）：历史上缺的是**清单**不是资产——本机早有 fl2v 8 步 LoRA，
  // 但那是 **544p 版**（配对 shift 12/3），跑不了 1344；补齐时下载了 **768p 版**
  // （`minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16`，配对 shift 6/3），并**另建模板**
  // `minimax-h3-i2v-8step.json`（shift 与 LoRA 必须配对，见 docs §2.1）——不是改现有 i2v 清单。
  { out: 'minimax-h3-i2v-fast', group: GROUP_I2V, tier: 'fast', template: 'minimax-h3-i2v.json', mode: 'fast', estSeconds: 26.1, note: '4 步 LoRA · 长边 832 · 实测 26.1s' },
  { out: 'minimax-h3-i2v-balanced', group: GROUP_I2V, tier: 'balanced', template: 'minimax-h3-i2v-8step.json', mode: 'balanced', estSeconds: 177, note: '8 步 fl2v 768p LoRA（shift 6/3 + euler）· 实测 177.3s' },
  { out: 'minimax-h3-i2v-balanced-sol', group: GROUP_I2V, tier: 'balanced', accel: 'sol', template: 'minimax-h3-i2v-8step-sol.json', mode: 'balanced', estSeconds: 131, note: 'Sol-Attn 加速 · 实测 130.5s（1.36×，tau 1.2）' },
  { out: 'minimax-h3-i2v-quality', group: GROUP_I2V, tier: 'quality', template: 'minimax-h3-i2v.json', mode: 'quality', estSeconds: 394.8, note: '20 步 · 实测 394.8s' },
  { out: 'minimax-h3-i2v-quality-sol', group: GROUP_I2V, tier: 'quality', accel: 'sol', template: 'minimax-h3-i2v-sol.json', mode: 'quality', estSeconds: 314.7, note: 'Sol-Attn 加速 · 实测 314.7s（1.25×）' },
  // PDD（2026 引入）：8 步 nfe=8 就能达到 20 步成片档的细节量，成本约 185s（≈ 2.1× 提速）。
  // priority 为负 = **不做隐式默认**（依赖第三方节点 MiniMaxH3PDDAccApply，须用户显式选策略）。
  { out: 'minimax-h3-ref2v-balanced-pdd', group: GROUP_REF2V, tier: 'balanced', priority: -30, template: 'minimax-h3-pdd-ref2v.json', mode: 'balanced', estSeconds: 185, note: 'PDD nfe=8 · shift 12/3 · euler · 实测 184.7s（细节量高于 20 步成片档）' },
  { out: 'minimax-h3-i2v-balanced-pdd', group: GROUP_I2V, tier: 'balanced', priority: -30, template: 'minimax-h3-pdd-i2v.json', mode: 'balanced', estSeconds: 179, note: 'PDD nfe=8 · shift 12/3 · euler · 实测 178.8s（细节量高于 20 步成片档）' },
  // PDD 组内的第二个策略：叠 Sol-Attn（Sol 只改注意力，PDD 的 sigma 网格与 head bank 不受影响）。
  // 实测 ref2v：184.7s → 137.3s（1.35×），细节量从"高于 20 步成片档"回落到"与成片档持平"。
  { out: 'minimax-h3-ref2v-balanced-pdd-sol', group: GROUP_REF2V, tier: 'balanced', accel: 'sol', accelOf: 'minimax-h3-ref2v-balanced-pdd', priority: -30, template: 'minimax-h3-pdd-ref2v-sol.json', mode: 'balanced', estSeconds: 137, note: 'PDD + Sol-Attn（tau 1.2）· 实测 137.3s（对 PDD 单独 1.35×；细节量仍与 20 步成片档持平）' },
  { out: 'minimax-h3-i2v-balanced-pdd-sol', group: GROUP_I2V, tier: 'balanced', accel: 'sol', accelOf: 'minimax-h3-i2v-balanced-pdd', priority: -30, template: 'minimax-h3-pdd-i2v-sol.json', mode: 'balanced', estSeconds: 134, note: 'PDD + Sol-Attn（tau 1.2）· 实测 134.1s（对 PDD 单独 1.33×）' },
]

/**
 * 内部诊断清单：不进档位解析、不出现在 UI/技能选项，只能显式 workflow= 调用
 * （注册表用 internal 标注过滤；这样它们也由图模板产出，可随时重建）。
 */
const INTERNAL_VARIANTS = [
  {
    out: 'minimax-h3-ref2v-sol-stats',
    template: 'minimax-h3-ref2v-sol-stats.json',
    displayName: 'MiniMax H3 Sol-Attn 统计诊断（内部）',
    note: '内部诊断：跑 Sol 时输出 sol_attn/skipped_early 统计，用于验证加速是否真的生效。',
    requiresNodes: ['SolAttnMiniMaxH3', 'SolAttnStats'],
  },
]

const readTemplate = (file) => JSON.parse(readFileSync(join(TEMPLATE_DIR, file), 'utf8'))
const classTypes = (graph) => new Set(Object.values(graph).map((n) => n.class_type))

function buildVariant(spec, templates) {
  const src = templates[spec.template]
  if (!src) throw new Error(`模板缺失：${spec.template}`)
  const modeCfg = (src.modes || {})[spec.mode]
  if (!modeCfg) throw new Error(`${spec.template} 没有 mode "${spec.mode}"（现有：${Object.keys(src.modes || {}).join('/') || '无'}）`)

  const m = JSON.parse(JSON.stringify(src))
  m.id = spec.out
  m.version = 1
  m.group = spec.group.id
  m.tier = spec.tier
  m.displayName = spec.group.displayName
  m.capability = spec.group.capability
  m.description = `${spec.group.displayName} · ${spec.tier} 档${spec.accel ? `（${spec.accel} 加速实现）` : ''}。由 scripts/make-h3-variants.mjs 生成，请勿手改。`
  m.estSeconds = spec.estSeconds
  m.note = spec.note
  m.priority = Number.isFinite(spec.priority) ? spec.priority : 0
  // 只保留本档的 mode（名称即档位名）
  m.modes = { [spec.tier]: modeCfg }
  if (spec.accel) m.accel = spec.accel
  else delete m.accel

  // requiresNodes：与同路径同档的标准版做节点类别差集（加速件依赖的第三方节点）
  if (spec.accel) {
    // 差集对象：默认取"同组同档的第一个非 accel 变体"；同档有多个非 accel 实现时
    // （如 balanced 的 lightx2v 版与 PDD 版同组）必须用 accelOf 显式指定兄弟清单，
    // 否则会把 PDD 的 Apply 节点也算成 Sol 带来的依赖。
    const stockSpec = spec.accelOf
      ? VARIANTS.find((v) => v.out === spec.accelOf)
      : VARIANTS.find((v) => v.group.id === spec.group.id && v.tier === spec.tier && !v.accel)
    if (!stockSpec) throw new Error(`${spec.out} 找不到对比基准（accelOf=${spec.accelOf || '同组同档非 accel'}），无法推断 requiresNodes`)
    const stock = buildVariant(stockSpec, templates)
    const diff = [...classTypes(m.graph)].filter((c) => !classTypes(stock.graph).has(c))
    if (!diff.length) throw new Error(`${spec.out} 声明了 accel 但图与标准版无节点差异`)
    m.requiresNodes = diff.sort()
  } else if (Array.isArray(src.requiresNodes) && src.requiresNodes.length) {
    // 非 accel 变体也可以自带第三方依赖（如 PDD 的 Apply 节点）——直接沿用模板声明，
    // 这样可用性预检/置灰对 PDD 同样生效（缺节点时不会假装可用）。
    m.requiresNodes = [...src.requiresNodes].sort()
  } else {
    delete m.requiresNodes
  }
  return m
}

/** 内部诊断清单：原样复制模板 + 标注（不改 modes，因为它不参与档位解析）。 */
function buildInternal(spec, templates) {
  const src = templates[spec.template]
  if (!src) throw new Error(`模板缺失：${spec.template}`)
  const m = JSON.parse(JSON.stringify(src))
  m.id = spec.out
  m.version = 1
  m.internal = true
  m.displayName = spec.displayName
  m.description = spec.note + '由 scripts/make-h3-variants.mjs 生成，请勿手改。'
  m.note = spec.note
  if (spec.requiresNodes) m.requiresNodes = spec.requiresNodes
  delete m.priority
  return m
}

// --- 生成 + 校验 -------------------------------------------------------------

const templateFiles = new Set(readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.json')))
const templates = {}
for (const spec of [...VARIANTS, ...INTERNAL_VARIANTS]) {
  if (!templateFiles.has(spec.template)) throw new Error(`模板目录里没有 ${spec.template}；请确认 scripts/h3-templates/ 完整`)
  templates[spec.template] ||= readTemplate(spec.template)
}

const outputs = []
const errors = []
for (const spec of VARIANTS) {
  let m
  try { m = buildVariant(spec, templates) } catch (e) { errors.push(`${spec.out}: ${e.message}`); continue }
  const v = validateManifest(m, spec.out)
  if (!v.ok) { errors.push(...v.errors); continue }
  // 编译一次：确保图能注入（宽度/高度/帧数/种子/提示词/步数）
  try {
    buildGraphFromManifest(m, {
      prompt: 'smoke', width: 1344, height: 768, length: 124, seed: 1,
      steps: (m.modes[spec.tier] || {}).steps ?? 20, prefix: 'smoke/' + m.id, refs: [], first_frame: null, last_frame: null,
    })
  } catch (e) { errors.push(`${spec.out}: 图编译失败 — ${e.message}`); continue }
  outputs.push(m)
}

for (const spec of INTERNAL_VARIANTS) {
  let m
  try { m = buildInternal(spec, templates) } catch (e) { errors.push(`${spec.out}: ${e.message}`); continue }
  const v = validateManifest(m, spec.out)
  if (!v.ok) { errors.push(...v.errors); continue }
  outputs.push(m)
}

if (errors.length) {
  console.error('✗ 生成失败：\n  ' + errors.join('\n  '))
  process.exit(1)
}

// 策略投影预览（配置页会看到什么）
const fake = { byId: {}, byCapability: {} }
for (const m of outputs.filter((x) => !x.internal)) { fake.byId[m.id] = m; (fake.byCapability[m.capability] ||= []).push(m) }
for (const [cap, list] of Object.entries(fake.byCapability)) {
  const groups = {}
  for (const m of list) (groups[m.group] ||= { id: m.group, displayName: m.displayName, tiers: {} })
  for (const m of list) (groups[m.group].tiers[m.tier] ||= []).push(m)
  // 策略不再由组自动投影（策略是**用户命名的一套档位组合**）：这里只列出"内置默认"会选中的实现，
  // 让生成结果和配置页显示的默认一致；其余组合由用户在配置页自建。
  const defaultLine = []
  for (const tier of _internals.TIERS) {
    const cand = list.filter((m) => m.tier === tier && !m.internal)
    const pick = cand.filter((m) => !m.accel).sort((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id))[0]
    if (pick) defaultLine.push(`${tier}→${pick.id}`)
  }
  if (defaultLine.length) console.log(`  「内置默认」 ` + defaultLine.join('  '))
  for (const g of Object.values(groups)) {
    console.log(`\n${cap} · ${g.displayName}（${g.id}）`)
    for (const [tier, list] of Object.entries(g.tiers)) {
      for (const m of list) console.log(`    [${tier}] ${m.id}${m.accel ? ` · accel=${m.accel} requires=${m.requiresNodes.join(',')}` : ''} · ${m.estSeconds}s · 步数=${m.modes[tier].steps} 长边=${m.modes[tier].longSide ?? '-'}`)
    }
  }
}

if (DRY) { console.log('\n(--dry：未写盘)'); process.exit(0) }
for (const m of outputs) writeFileSync(join(OUT_DIR, m.id + '.json'), JSON.stringify(m, null, 2) + '\n', 'utf8')
console.log(`\n✓ 已写出 ${outputs.length} 份单档清单到 workflows/：` + outputs.map((m) => m.id).join(', '))
