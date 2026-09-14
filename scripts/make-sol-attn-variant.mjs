#!/usr/bin/env node
/**
 * Sol-Attn 插桩工具（**图模板层**，不是内置清单生成器）。
 *
 * ⚠️ 内置清单请用 `scripts/make-h3-variants.mjs`（一个 json = 一个档位实现）。
 * 本脚本只负责一件事：往一份**图模板**里插入 Sol-Attn 节点并改线，产物落
 * `scripts/h3-templates/`，再由 make-h3-variants.mjs 产出内置档位清单。
 * 默认输出目录因此**不是** workflows/（那里的文件是产物，手写会被生成器覆盖）。
 *
 * 接线（与上游 README 一致）：
 *   UNETLoader -> [LoRA] -> MiniMaxH3SigmaShift -> Sol-Attn MiniMax H3 -+-> BasicGuider
 *                                                                     +-> BasicScheduler
 * 即：在 SigmaShift 之后插入 Sol-Attn 节点，并把**所有**引用 ["2",0] 的节点改指新节点。
 *
 * 关于「加速实现不被选为默认」：现在由注册表的 `accel` 标注 + 同档排序
 * 「priority 降序 → **无加速优先** → id 升序」保证（见 lib/index.js sortTierCandidates），
 * 不再依赖 priority: -100。清单里的 priority 只影响同档内的展示次序。
 *
 * 用法：
 *   node scripts/make-sol-attn-variant.mjs                      # 重生成 h3-templates/ 下的 *-sol 模板
 *   node scripts/make-sol-attn-variant.mjs scripts/h3-templates/minimax-h3-ref2v.json
 *   node scripts/make-sol-attn-variant.mjs --tau 1.4 --out /tmp/sol
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { validateManifest, buildGraphFromManifest } from '../lib/manifest.js'

const ROOT = resolve(import.meta.dirname, '..')
const SIGMA_NODE = '2'          // MiniMaxH3SigmaShift（所有 H3 清单里模型链的汇聚点）
const SOL_NODE = '2a'           // 插入的 Sol-Attn 节点 id
const SOL_CLASS = 'SolAttnMiniMaxH3'   // 注意：注册名是 SolAttnMiniMaxH3（README 里的 "Sol-Attn MiniMax H3" 是 UI 显示名）
const SOL_PRIORITY = 0          // 不再用于「不被选为默认」（改由 accel 标注 + 无加速优先保证）

// ---- 参数 ----
const argv = process.argv.slice(2)
let outDir = join(ROOT, 'scripts', 'h3-templates')   // 模板层，非 workflows/ 产物层
let tau = 1.2
let solPriority = SOL_PRIORITY
const files = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') outDir = resolve(argv[++i])
  else if (argv[i] === '--tau') tau = Number(argv[++i])
  else if (argv[i] === '--priority') solPriority = Number(argv[++i])
  else files.push(argv[i])
}
const sources = files.length
  ? files.map((f) => resolve(f))
  : readdirSync(join(ROOT, 'scripts', 'h3-templates'))
      .filter((f) => f.startsWith('minimax-h3-') && f.endsWith('.json') && !f.includes('-sol'))
      .map((f) => join(ROOT, 'scripts', 'h3-templates', f))

mkdirSync(outDir, { recursive: true })
if (/(^|\/)workflows$/.test(outDir)) {
  console.warn('⚠️ 输出目录是 workflows/（内置清单产物层）：那里的单档清单由 scripts/make-h3-variants.mjs 生成，' +
    '手写/覆盖会与档位契约（tier/group/accel）不一致。请改为输出到 scripts/h3-templates/ 或用户目录。')
}

for (const srcPath of sources) {
  const src = JSON.parse(readFileSync(srcPath, 'utf8'))
  const v = structuredClone(src)
  const newId = `${src.id}-sol`
  const modes = Object.keys(src.modes || {})

  // 1) 插入 Sol-Attn 节点（model 来自 SigmaShift 输出）
  v.graph[SOL_NODE] = {
    class_type: SOL_CLASS,
    inputs: {
      model: [SIGMA_NODE, 0],
      enabled: true,          // 置 false 即"接线不变、不稀疏"的完美对照臂（同图 A/B）
      tau,                    // 稀疏强度：越大越快、越糙；1.0–1.5 是速度优先区间
      min_seq_len: 8192,      // 低于此 token 数不稀疏（H3 的 124 帧 480p≈12k、768p≈31k 都会命中）
      protect_prefix: true,   // 自动保持 文本/条件/参考/音频 前缀为稠密（AV 模型关键）
      // 必须是 0：本 ComfyUI 版本 transformer_options['sigmas'] 是整条表，
      // 节点读 flatten()[0] → progress 恒为 0 → dfp>0 会让**每次调用**都判为"早期"而全部回退稠密
      // （实测 dfp=0.2 时 sol_attn=0、400/400 skipped_early、s/it 与原版一模一样）。
      // 早期保护改由 dense_first_blocks=2 与 protect_prefix 承担。
      dense_first_percent: 0,
      dense_first_blocks: 2,
      approx_correction: true,
      log_every: 50,          // 节点默认 200，短镜跑不满就打不出密度；50 让每个镜头都能看到实测密度
    },
  }

  // 2) 把所有（除自身外）指向 SigmaShift 的 model 连线改指 Sol-Attn
  let repointed = []
  for (const [id, node] of Object.entries(v.graph)) {
    if (id === SOL_NODE) continue
    for (const [field, val] of Object.entries(node.inputs || {})) {
      if (Array.isArray(val) && val.length === 2 && val[0] === SIGMA_NODE && val[1] === 0) {
        node.inputs[field] = [SOL_NODE, 0]
        repointed.push(`${id}.${field}`)
      }
    }
  }

  v.id = newId
  v.displayName = `${src.displayName || src.id} · Sol-Attn 加速`
  v.priority = solPriority
  v.description = `[加速工作流 · 需自装自定义节点 cicalooo/ComfyUI-SolAttn-Ampere] 在 MiniMaxH3SigmaShift 之后插入 Sol-Attn MiniMax H3 块稀疏注意力（Ampere/sm_80+，torch>=2.5，纯 torch.compile(flex_attention)），tau=${tau}。不装节点会报 node type not found；priority=${solPriority} 保证它不会被选为隐式默认档。原清单说明：${src.description || ''}`.slice(0, 900)

  // 3) 校验：清单合法 + 编译出的图里接线正确、无残留哨兵
  const check = validateManifest(v, newId)
  const errs = [...(check.errors || [])]
  const mode = modes[0]
  let graph = null
  if (check.ok) {
    try {
      graph = buildGraphFromManifest(v, {
        mode,
        prompt: 'validation',
        width: 832, height: 480, length: 124, seed: 1,
        steps: v.modes[mode]?.steps ?? 4,
        fps: 24,
        prefix: 'validation',
      })
    } catch (e) {
      errs.push(`编译失败: ${e.message}`)
    }
  }
  if (graph) {
    const g = JSON.stringify(graph)
    if (/\$assets\.|\$model/.test(g)) errs.push('编译产物残留哨兵 $assets./$model')
    if (graph[SOL_NODE]?.inputs?.model?.[0] !== SIGMA_NODE) errs.push(`${SOL_NODE}.model 未指向节点 ${SIGMA_NODE}`)
    for (const [id, node] of Object.entries(graph)) {
      if (id === SOL_NODE) continue
      for (const [field, val] of Object.entries(node.inputs || {})) {
        if (Array.isArray(val) && val[0] === SIGMA_NODE && val[1] === 0) errs.push(`${id}.${field} 仍指向 ${SIGMA_NODE}（漏改）`)
      }
    }
    if (repointed.length < 2) errs.push(`只改到 ${repointed.length} 条 model 连线（BasicGuider/BasicScheduler 应为 2 条）`)
  }

  const dest = join(outDir, `${newId}.json`)
  if (errs.length) {
    console.error(`✗ ${src.id} → ${newId} 校验失败:\n  - ${errs.join('\n  - ')}`)
    process.exitCode = 1
    continue
  }
  writeFileSync(dest, JSON.stringify(v, null, 2) + '\n', 'utf8')
  console.log(`✓ ${src.id} → ${newId}  (${repointed.join(', ')} 改指 ${SOL_NODE}; tau=${tau})`)
  console.log(`   写入 ${dest}`)
}
