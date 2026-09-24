#!/usr/bin/env node
/**
 * scripts/make-image-variants.mjs — 从「图片模板」生成**一档一清单**的产物。
 *
 * 契约见 docs/unified-tier-tool-design.md（P1）：
 *   - 人只改 scripts/image-templates/<family>.json（图结构 + 三档差异表）
 *   - 产物 workflows/<family>-<tier>.json **勿手改**（与 H3 的 make-h3-variants.mjs 同一约定）
 *   - 图片与视频共用同一套档位词汇（fast < balanced < quality），清单声明 tier + group=家族
 *
 * 用法：
 *   node scripts/make-image-variants.mjs          # 生成/覆盖产物
 *   node scripts/make-image-variants.mjs --check   # 只校验产物是否与模板一致（CI 用，不写盘）
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { validateManifest } from '../lib/manifest.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_DIR = join(__dirname, 'image-templates')
const OUT_DIR = join(__dirname, '..', 'workflows')
const CHECK = process.argv.includes('--check')

const TIER_ORDER = ['fast', 'balanced', 'quality']
const snap32 = (v) => Math.max(32, Math.round(Number(v) / 32) * 32)

/** 深合并：对象递归、数组/标量后者覆盖（档位补丁用）。 */
function merge(base, patch) {
  if (patch === undefined) return base
  if (Array.isArray(base) || Array.isArray(patch)) return patch
  if (base && patch && typeof base === 'object' && typeof patch === 'object') {
    const out = { ...base }
    for (const [k, v] of Object.entries(patch)) out[k] = merge(base[k], v)
    return out
  }
  return patch
}

/** 展开一份模板 → [{ tier, manifest }] */
function expand(tpl) {
  const tiers = tpl.tiers || {}
  const names = TIER_ORDER.filter((t) => tiers[t])
  if (!names.length) throw new Error(`${tpl.family}: 模板没有声明任何 tier`)
  const out = []
  for (const tier of names) {
    const cfg = tiers[tier]
    const patch = (tpl.tierPatches || {})[tier] || {}

    // 1) 图 / 资产 / 参数：模板 + 档位补丁
    const assets = merge(structuredClone(tpl.assets || {}), patch.assets)
    const graph = merge(structuredClone(tpl.graph), patch.graph)
    const params = merge(structuredClone(tpl.params || {}), patch.params)

    // 2) 档位参数：steps / longSide / loras / 参考图预算
    const steps = cfg.steps
    if (!Number.isInteger(steps) || steps < 1) throw new Error(`${tpl.family}/${tier}: steps 非法（${steps}）`)
    const modeCfg = { steps }
    if (Array.isArray(cfg.loras) && cfg.loras.length) modeCfg.loras = cfg.loras
    for (const l of modeCfg.loras || []) {
      if (!assets[l.asset]) throw new Error(`${tpl.family}/${tier}: LoRA 引用了未声明的资产 "${l.asset}"`)
    }

    // 3) 分辨率：图片一律 aspect-ratio（画布比例 × 本档长边）。
    //    i2i 没有尺寸注入点（尺寸跟随参考图），长边改由「参考图预算」表达 ⇒ default 记方形预算。
    //    模板里的 refBudget 一律是**总像素预算**；写进目标字段时按 refTarget.unit 换算：
    //      unit='side'（缺省，如 Qwen 的 TextEncodeQwenImage21.resolution「约 N×N 像素」）→ 边长 = snap32(√budget)
    //      unit='megapixels'（如 ImageScaleToTotalPixels.megapixels）            → budget / 1e6
    const refBudget = tpl.refBudget ? tpl.refBudget[tier] : undefined
    let resolution
    if (refBudget) {
      const rt = tpl.refTarget
      if (!rt || !rt.node || !rt.field || !rt.param) throw new Error(`${tpl.family}: 声明了 refBudget 就必须给 refTarget{node,field,param}`)
      const side = snap32(Math.sqrt(refBudget))
      const value = rt.unit === 'megapixels' ? refBudget / 1e6 : side
      modeCfg.referencePixels = refBudget
      resolution = { policy: 'aspect-ratio', snap: 32, default: [side, side] }
      params[rt.param] = { inject: 'scalar', to: { node: rt.node, field: rt.field }, default: value }
    } else {
      const longSide = cfg.longSide
      if (!Number.isInteger(longSide) || longSide <= 0 || longSide % 32 !== 0) {
        throw new Error(`${tpl.family}/${tier}: longSide 必须是 32 的倍数的正整数（${longSide}）`)
      }
      modeCfg.longSide = longSide
      resolution = { policy: 'aspect-ratio', snap: 32, longSide, default: [longSide, snap32((longSide * 9) / 16)] }
    }

    // 4) 清单头
    const id = `${tpl.family}-${tier}`
    const label = cfg.label ? `（${cfg.label}）` : ''
    const manifest = {
      id,
      version: 1,
      capability: tpl.capability,
      runner: 'comfyui',
      displayName: `${tpl.displayName}${label}`,
      description: tpl.description,
      ...(tpl.note ? { note: tpl.note } : {}),
      tier,
      group: tpl.family,
      ...(cfg.estSeconds ? { estSeconds: cfg.estSeconds } : {}),
      ...(tpl.requiresNodes ? { requiresNodes: tpl.requiresNodes } : {}),
      ...(tpl.priority !== undefined ? { priority: tpl.priority } : {}),
      output: tpl.output,
      ...(tpl.modelNode ? { modelNode: tpl.modelNode } : {}),
      assets,
      graph,
      params,
      modes: { [tier]: modeCfg },
      resolution,
      constraints: structuredClone(tpl.constraints || {}),
    }
    out.push({ tier, manifest })
  }
  return out
}

const files = existsSync(TEMPLATE_DIR) ? readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.json')).sort() : []
if (!files.length) {
  console.error(`✗ 没有模板：${TEMPLATE_DIR}`)
  process.exit(1)
}

let written = 0
let drifted = 0
let failed = 0
for (const file of files) {
  const tpl = JSON.parse(readFileSync(join(TEMPLATE_DIR, file), 'utf8'))
  let variants
  try {
    variants = expand(tpl)
  } catch (e) {
    console.error(`✗ ${file}: ${e.message}`)
    failed++
    continue
  }
  for (const { tier, manifest } of variants) {
    const v = validateManifest(manifest, `${manifest.id}`)
    if (!v.ok) {
      console.error(`✗ ${manifest.id} 校验失败：\n  - ${v.errors.join('\n  - ')}`)
      failed++
      continue
    }
    const outPath = join(OUT_DIR, `${manifest.id}.json`)
    const text = JSON.stringify(manifest, null, 2) + '\n'
    if (CHECK) {
      const cur = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''
      if (cur !== text) {
        console.error(`✗ ${manifest.id}.json 与模板不一致（跑 node scripts/make-image-variants.mjs 重新生成）`)
        drifted++
      }
      continue
    }
    if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(outPath, text, 'utf8')
    written++
    console.log(`  ✓ ${manifest.id}  tier=${tier}  ${Object.keys(manifest.modes[tier]).join('/')}`)
  }
}

if (failed) process.exit(1)
if (CHECK) {
  console.log(drifted ? `✗ ${drifted} 份产物与模板不一致` : '✓ 所有图片产物与模板一致')
  process.exit(drifted ? 1 : 0)
}
console.log(`✓ 生成 ${written} 份图片档位清单`)
