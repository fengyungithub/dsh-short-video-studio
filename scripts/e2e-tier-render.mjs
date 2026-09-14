/**
 * scripts/e2e-tier-render.mjs — 档位端到端集成验证（**真跑 GPU**）。
 *
 * 验证「档位 → 实现 → 图 → ComfyUI 产物」这条链路在真实 ComfyUI 上成立：
 *  1) 按 tier 解析实现（fast / balanced / quality 任一）
 *  2) 上传参考图 → buildRenderGraph → 提交 → 等待 → 取产物
 *  3) 打印耗时并与 docs/minimax-h3-video-benchmark.md 的实测值对照（seed 一致时可比）
 *
 * 用法：
 *   node scripts/e2e-tier-render.mjs                       # 默认 fast（≈25s，调试用）
 *   node scripts/e2e-tier-render.mjs --tier=quality        # 成片档（≈400s）
 *   node scripts/e2e-tier-render.mjs --workflow=minimax-h3-ref2v-balanced-sol   # 指定实现（加速件）
 *   node scripts/e2e-tier-render.mjs --ref=<某个 png 路径>  # 换参考图
 *
 * 产物落 e2e-out/tier-render/ 下（不入画布；画布产物由 agent 工具链写）。
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { _internals } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'e2e-out', 'tier-render')
const { getRegistry, resolveTieredManifest, buildRenderGraph, computeManifestSize, comfyUploadImage, comfySubmit, comfyWait, comfyOutputs, comfyDownload } = _internals

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}
const CAP = arg('capability', 'video.reference2video')
const TIER = arg('tier', 'fast')
const LENGTH = Number(arg('length', 124))
const SEED = Number(arg('seed', 42424242))
const RATIO = arg('ratio', '16:9')
const PROMPT = arg('prompt', 'A small red fox sits on a mossy rock in a sunlit pine forest, ears twitching, gentle wind moving the ferns, warm afternoon light. Soft natural ambience.')

/** 找一张可用的参考图（优先命令行指定，其次画布里任一角色卡 png）。 */
function findRef() {
  const explicit = arg('ref', '')
  if (explicit) return explicit
  const root = join(ROOT, 'canvas')
  if (existsSync(root)) {
    for (const dir of readdirSync(root)) {
      const p = join(root, dir)
      if (!statSync(p).isDirectory()) continue
      const png = readdirSync(p).filter((f) => f.endsWith('.png')).sort()[0]
      if (png) return join(p, png)
    }
  }
  throw new Error('找不到参考图：请用 --ref=<png 路径> 指定')
}

const registry = getRegistry()
const WF = arg('workflow', '')
const resolved = await resolveTieredManifest(CAP, TIER, WF || null, { registry })
const manifest = resolved.manifest
const bigTier = manifest.tier === 'fast'
const size = computeManifestSize(manifest, resolved.tier, undefined, undefined, RATIO)

console.log(`能力 ${CAP} · 档位 ${resolved.tier} → 实现 ${manifest.id}（解析来源 ${resolved.resolution}）`)
console.log(`尺寸 ${size.w}×${size.h} · 帧数 ${LENGTH} · seed ${SEED} · 提示词 ${PROMPT.slice(0, 40)}…`)

// 参考图只有 ref2v 需要；i2v 需要首帧
const isI2v = CAP === 'video.image2video'
const refPath = findRef()
const refName = 'e2e-tier-' + Date.now() + '-' + refPath.split('/').pop()
await comfyUploadImage(await (await import('node:fs/promises')).readFile(refPath), refName)
const opts = {
  prompt: PROMPT, width: size.w, height: size.h, length: LENGTH, seed: SEED,
  prefix: 'e2e-tier/' + manifest.id, refs: isI2v ? [] : [refName],
  first_frame: isI2v ? refName : null, last_frame: null,
  steps: (manifest.modes[resolved.tier] || {}).steps,
}
const built = buildRenderGraph(manifest, opts, RATIO)
console.log(`图已编译：${Object.keys(built.graph).length} 节点（mode=${built.mode} steps=${opts.steps}）`)

const t0 = Date.now()
const jobId = await comfySubmit(built.graph)
const hist = await comfyWait(jobId)
const elapsed = (Date.now() - t0) / 1000
const outputs = comfyOutputs(hist)
const files = Array.isArray(outputs) ? outputs : (outputs.files || [])
if (!files.length) throw new Error('没有产物：' + JSON.stringify(outputs).slice(0, 300))
mkdirSync(OUT, { recursive: true })
const saved = []
for (const f of files) {
  const dest = join(OUT, `${manifest.id}-${f.kind || 'out'}-${(f.filename || 'x').split('/').pop()}`)
  writeFileSync(dest, await comfyDownload(f))
  saved.push(dest + ' (' + Math.round(statSync(dest).size / 1024) + ' KiB)')
}
console.log(`\n✓ 完成 ${elapsed.toFixed(1)}s（jobId=${jobId}）`)
for (const s of saved) console.log('  产物：' + s)
console.log(`  对照：docs/minimax-h3-video-benchmark.md 中 ${manifest.id} 的 16:9 · 124 帧实测为 ${manifest.estSeconds}s（同 seed 可比）`)
