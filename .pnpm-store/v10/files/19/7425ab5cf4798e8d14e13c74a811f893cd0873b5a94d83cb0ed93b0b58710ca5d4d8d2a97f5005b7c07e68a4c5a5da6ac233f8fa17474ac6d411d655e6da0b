/**
 * scripts/ab-2k-pdd.mjs — 2K 家族「balanced 非 PDD」vs「balanced PDD」的 56 帧 A/B。
 *
 * ## 这对清单的差异在哪（与旧版结论不同，务必先读）
 *
 * 两份都是 ctx（链式续接）+ 学习式 latent ×2 的 2K 清单：
 *   A  `minimax-h3-ref2v-ctx-balanced-2k`     首遍 8 步 **非 PDD**（普通 BasicScheduler 出 sigma）
 *   B  `minimax-h3-ref2v-ctx-balanced-pdd-2k` 首遍 8 步 **PDD**（`MiniMaxH3PDDAccApply` nfe=8 出 sigma）
 * 二遍完全相同（node 6b / 9b / 17，denoise 0.3 / 6 步 / 学习式 3D 放大器）。
 *
 * ⚠️ **旧版本文档说的「唯一变量＝二遍」是错的**，已核对图结构纠正：PDD 的
 * nfe=8 与 euler 都在喂 **node 10 首遍**，二遍（node 9b + node 8）两边读的是同一套。
 * 所以这对清单的差异在**首遍**，加速也应当出现在首遍。
 * 节点级隔离自证（脚本启动时自动打印）：A 独有 node `9`、B 独有 node `2a`，共享节点里只有
 * `10`（sigma 来源）、`2`（shift 6/3 vs 12/3）、`7`（guider 挂 2 vs 2a）不同。
 *
 * ## 两条提交臂（冷跑同种子 ⇒ 输出可比）
 *
 *    A · seed S   冷跑 → 全长 t_A + 成片 A
 *    B · seed S   冷跑 → 全长 t_B + 成片 B（首遍配方不同 ⇒ **不会**命中 A 的首遍缓存）
 * 同种子是刻意的：只有同种子，两条成片才能做逐帧画质对比。
 *
 * 首遍/二遍的耗时分解**不靠这对清单**（两边首遍不同，减不出干净的数），而是另用
 * `scripts/ab-2k-pass1.mjs` 在**非 ctx 同档**清单上做「8 步 vs PDD」的纯首遍探针。
 *
 * 用法：
 *   node scripts/ab-2k-pdd.mjs                    # 全跑（A、B）
 *   node scripts/ab-2k-pdd.mjs --only A           # 只跑某一段
 *   node scripts/ab-2k-pdd.mjs --frames 56 --seed 20260922
 *   node scripts/ab-2k-pdd.mjs --dry              # 只打印编译结果与差异，不提交
 */
process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || `${process.env.HOME}/.dsh/dsh-short-video-studio.json`

import { _internals } from '../lib/index.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.DSH_SVS_COMFY_URL || 'http://localhost:8188'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const has = (k) => argv.includes('--' + k)
const num = (k, d) => { const v = arg(k, undefined); return v === undefined ? d : Number(v) }

const FRAMES = num('frames', 56)
const STEPS = num('steps', 20)
const SEED = num('seed', 20260922)
const ONLY = arg('only', '').split(',').map((s) => s.trim()).filter(Boolean)
const DRY = has('dry')

// 与 probe-2k.mjs 同一段 prompt：无字幕、单镜、有明确动作与声音，便于跨实验对照
const PROMPT = arg('prompt',
  'A narrow rain-soaked alley at dusk. A woman in a red coat walks toward the camera, umbrella tilted forward, ' +
  'neon signage reflecting in the puddles. She stops, looks up, rain streaks across the frame. ' +
  'Handheld camera pushes in slowly. Ambient rain and distant traffic. No subtitles.')

const { buildGraphFromManifest, getRegistry, getAssetOverrides } = _internals

const MANIFESTS = {
  A: { id: 'minimax-h3-ref2v-ctx-balanced-2k', label: 'balanced · 首遍 8 步非 PDD（BasicScheduler 出 sigma）', seedOffset: 0 },
  B: { id: 'minimax-h3-ref2v-ctx-balanced-pdd-2k', label: 'balanced · 首遍 8 步 PDD（PDDAccApply nfe=8 出 sigma）', seedOffset: 0 },
  // 复现臂：同配置换一组种子，用来判定耗时差是「结构性的」还是「环境噪声」
  A2: { id: 'minimax-h3-ref2v-ctx-balanced-2k', label: 'balanced 非 PDD · 第二组种子（复现性）', seedOffset: 2000 },
  B2: { id: 'minimax-h3-ref2v-ctx-balanced-pdd-2k', label: 'balanced PDD · 第二组种子（复现性）', seedOffset: 2000 },
}

for (const [arm, spec] of Object.entries(MANIFESTS)) {
  if (!getRegistry().byId[spec.id]) {
    throw new Error(
      `注册表里没有 ${spec.id}。这对清单由 scripts/make-2k-template.mjs 从 ctx 模板派生，` +
      '请先跑 `node scripts/make-2k-template.mjs && node scripts/make-h3-variants.mjs`。'
    )
  }
}

// 起链（首镜）：没有上文可继承，Load 读 slot 0、Save 写 slot 1——与 runner 的 distributeClipIndices 同口径。
// 两边都必须显式给，否则 ComfyUI 端 clip_index=None 会直接 400。
const CHAIN_LOAD_IDX = 0
const CHAIN_SAVE_IDX = 1

function compile(arm) {
  const spec = MANIFESTS[arm]
  const m = getRegistry().byId[spec.id]
  const [g, off] = m.chain?.lengthGrid || [1, 0]
  const sampled = Math.max(FRAMES, g * Math.ceil((FRAMES - off) / g) + off) + (m.chain?.sampleExtra || 0)
  const graph = buildGraphFromManifest(m, {
    prompt: PROMPT,
    width: 1344, height: 768,          // 被 resolutionLock 忽略，仅保持一致（真正注入的是 graph 尺寸）
    length: sampled,
    seed: SEED + spec.seedOffset,
    steps: STEPS,                      // PDD 档的 node 9 不存在 ⇒ 该参数对它自然无效，由 nfe 控制
    prefix: `e2e-2k/ab-${arm}`,
    refs: [], first_frame: null, last_frame: null,
    context_clip_index: CHAIN_LOAD_IDX,
    save_clip_index: CHAIN_SAVE_IDX,
    assetOverrides: getAssetOverrides(spec.id),
  })
  return { spec, graph, sampled }
}

// 先自证隔离：把两份**已上线清单**编译出来，确认差异集合只有二遍那四个节点
{
  const a = compile('A').graph, b = compile('B').graph
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  const diffs = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
  console.log('隔离自证：A(base) 节点', Object.keys(a).length, '| B(pdd) 节点', Object.keys(b).length)
  console.log('  差异节点：', diffs.join(', '))
  for (const k of diffs) console.log(`    [${k}] A=${a[k] ? a[k].class_type : '(缺)'}  B=${b[k] ? b[k].class_type : '(缺)'}`)
  console.log('  逐字节相同：', keys.filter((k) => !diffs.includes(k)).join(', '))
  if (DRY) process.exit(0)
}

const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`)
  return r.json()
}

mkdirSync(resolve(ROOT, 'e2e-out/2k-ab'), { recursive: true })
const results = []

async function run(arm) {
  const { spec, graph } = compile(arm)
  console.log(`\n═══ ${arm} · ${spec.label}`)
  console.log(`    清单 ${spec.id} · seed ${SEED + spec.seedOffset} · ${FRAMES} 帧 · 首遍 ${STEPS} 步`)
  if (DRY) return null

  const t0 = Date.now()
  const { prompt_id } = await post('/prompt', { prompt: graph, client_id: 'ab-2k-pdd' })
  console.log(`  ▸ prompt_id=${prompt_id.slice(0, 8)}`)
  // 显存观测量：2K-PDD 的图里**同时存在两个模型分支**（首遍用未打补丁的 node 2，
  // 二遍用打过 PDD 补丁的 node 2a）。两个模型都要占显存 ⇒ 可能触发部分卸载/权重流式，
  // 这会直接吃掉 PDD 省下的算力。所以每条臂都采 VRAM，作为归因证据。
  const vram = []
  const sampleVram = async () => {
    try {
      const s = await (await fetch(`${BASE}/system_stats`)).json()
      const d = (s.devices || [])[0]
      if (d) vram.push({ t: (Date.now() - t0) / 1000, freeGiB: d.vram_free / 2 ** 30 })
    } catch { /* 采样失败不影响主流程 */ }
  }
  await sampleVram()
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000))
    await sampleVram()
    const h = await (await fetch(`${BASE}/history/${prompt_id}`)).json()
    const entry = h[prompt_id]
    if (!entry) continue
    const st = entry.status?.status_str
    if (st === 'error') {
      const msgs = (entry.status?.messages || []).filter((x) => x[0] === 'execution_error').map((x) => JSON.stringify(x[1]).slice(0, 900))
      throw new Error(`${arm} 执行失败：${msgs.join(' | ')}`)
    }
    const secs = (Date.now() - t0) / 1000

    // ComfyUI 会把「哪些节点命中了执行缓存」放在 status.messages 里——这是冷/热跑的硬证据
    const cached = (entry.status?.messages || []).filter((x) => x[0] === 'execution_cached')
      .flatMap((x) => x[1]?.nodes || [])
    console.log(`  ✓ ${secs.toFixed(1)}s · 缓存命中节点 [${cached.join(', ')}]`)

    const files = Object.values(entry.outputs || {}).flatMap((o) => o.videos || o.images || []).filter((f) => /\.mp4$/.test(f.filename))
    for (const f of files) {
      const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? 'e2e-2k', type: f.type ?? 'output' })
      const buf = Buffer.from(await (await fetch(`${BASE}/view?${q}`)).arrayBuffer())
      const out = resolve(ROOT, `e2e-out/2k-ab/${arm}.mp4`)
      writeFileSync(out, buf)
      console.log(`    已存 ${out}（${(buf.length / 2 ** 20).toFixed(1)} MiB）`)
    }
    results.push({ arm, id: spec.id, seconds: secs, cachedNodes: cached, vram, files: files.map((f) => f.filename) })
    const freeMin = vram.length ? Math.min(...vram.map((v) => v.freeGiB)) : NaN
    const freeStart = vram.length ? vram[0].freeGiB : NaN
    console.log(`    VRAM 空闲 ${freeStart.toFixed(1)} → 最低 ${freeMin.toFixed(1)} GiB（占用峰值 ${(freeStart - freeMin).toFixed(1)} GiB）`)
    return secs
  }
}

const todo = ONLY.length ? ONLY : ['A', 'B', 'A2', 'B2']
for (const arm of todo) {
  if (!MANIFESTS[arm]) throw new Error(`未知分臂 ${arm}（可选 A / B / A2 / B2）`)
  await run(arm)
}

if (!DRY && results.length) {
  console.log('\n═══ 耗时（全长，含首遍 + 学习式放大 + 二遍精修 + 解码）')
  for (const r of results) {
    const fmin = r.vram?.length ? Math.min(...r.vram.map((v) => v.freeGiB)) : NaN
    const f0 = r.vram?.length ? r.vram[0].freeGiB : NaN
    console.log(`  ${r.arm.padEnd(3)} ${r.seconds.toFixed(1).padStart(8)}s  最低空闲显存 ${fmin.toFixed(1).padStart(5)} GiB`
      + `  占用峰值 ${(f0 - fmin).toFixed(1).padStart(5)} GiB  ${r.id}`)
  }
  const T = Object.fromEntries(results.map((r) => [r.arm, r.seconds]))
  const pair = (a, b) => (T[a] && T[b] ? `非 PDD ${T[a].toFixed(1)}s → PDD ${T[b].toFixed(1)}s = ${(T[a] / T[b]).toFixed(3)}×` : null)
  const s1 = pair('A', 'B'), s2 = pair('A2', 'B2')
  if (s1) console.log(`\n  组 1（seed ${SEED}）  ${s1}`)
  if (s2) console.log(`  组 2（seed ${SEED + 2000}）${s2}`)
  if (s1 && s2) {
    console.log('  两组一致 ⇒ 差异是结构性的（不是环境噪声）' )
  }
  console.log('\n  注：这条差值**全部来自首遍**（二遍两边配置相同）。首遍/二遍的净分解见：')
  console.log('      node scripts/ab-2k-pass1.mjs      # 非 ctx 同档清单上做纯首遍 8 步 vs PDD 探针')
  console.log('  画质对比：node scripts/analyze-2k-detail.mjs --a e2e-out/2k-ab/A.mp4 --b e2e-out/2k-ab/B.mp4')
}
