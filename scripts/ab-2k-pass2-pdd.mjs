/**
 * scripts/ab-2k-pass2-pdd.mjs — 2K 二遍「6 步 base」vs「PDD 2 次评估」的 A/B（§1.6 变体 A）。
 *
 * ## 这对清单的差异在哪
 *
 * 两份都是 ctx（链式续接）+ 学习式 latent ×2 的 2K 清单，**首遍逐字节相同**（20 步 base）：
 *   A  `minimax-h3-ref2v-ctx-quality-2k`      二遍 = base 模型 · BasicScheduler 6 步 denoise 0.3
 *   B  `minimax-h3-ref2v-ctx-quality-pdd2-2k` 二遍 = PDD 模型 · PDDAccScheduler nfe=8 denoise 0.3 ⇒ 2 次评估
 *
 * 节点级隔离自证（脚本启动时自动打印）：B 只多出 `2a`（PDDAccApply）与 `2c`（PDDAccScheduler），
 * 共享节点里**只有 `17`** 不同（model/sigmas 的来源）。首遍 node 9/10/7 完全一致。
 *
 * ## 为什么特意用同种子 + 依赖 ComfyUI 的执行缓存
 *
 * 首遍相同 ⇒ 跑完 A 之后，B 的首遍节点会**命中缓存**，于是 B 的墙钟时间 ≈ 纯二遍 + 放大 + 解码。
 * 这让「二遍 PDD 省多少」可以被直接读出来，而不是靠减法猜：
 *
 *   A · seed S   冷跑 → t_A（= 首遍 + 二遍base + 放大/解码）
 *   B · seed S   热跑 → t_B_hot（首遍命中缓存 ⇒ ≈ 二遍PDD + 放大/解码）
 *   B2· seed S   冷跑（先清缓存不可行，故用同 seed 的第二份 B 复现，验证 B 的首遍也命中）
 *
 * 于是 `二遍 base ≈ t_A − t_pass1`、`二遍 PDD ≈ t_B_hot − t_pass1`，而 t_pass1 由 A 的日志中
 * 缓存命中节点集合与 `execution_cached` 时间戳直接给出（脚本会把命中节点打印出来供核对）。
 *
 * ⚠️ 已知风险（`docs/2k-acceleration-variants-analysis.md` §1.4，必须实测）：
 *   ① 二遍入口 = 未蒸馏 base 输出 + 学习式放大器重建，对 PDD 蒸馏轨迹是**域外**；
 *   ② 2 次评估无迭代纠错 ⇒ 典型失效模式是**过冲 → 闪烁**。**验收第一指标是闪烁，不是锐度**。
 *   ③ `lock_audio=true` 让音频 mask 在二遍外，但 head bank 改同一个 model 对象，音轨可能被扰动。
 *
 * 用法：
 *   node scripts/ab-2k-pass2-pdd.mjs                  # 全跑（A、B）
 *   node scripts/ab-2k-pass2-pdd.mjs --only A         # 只跑某一段
 *   node scripts/ab-2k-pass2-pdd.mjs --frames 56 --seed 20260922
 *   node scripts/ab-2k-pass2-pdd.mjs --dry            # 只打印编译结果与差异，不提交
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
  A: { id: 'minimax-h3-ref2v-ctx-quality-2k', label: '二遍 base · BasicScheduler 6 步 denoise 0.3', seedOffset: 0 },
  B: { id: 'minimax-h3-ref2v-ctx-quality-pdd2-2k', label: '二遍 PDD · PDDAccScheduler nfe=8 denoise 0.3 ⇒ 2 次评估', seedOffset: 0 },
  // 复现臂：同 seed 再跑一遍 B（首遍应继续命中缓存），验证「热跑时间」稳定
  B2: { id: 'minimax-h3-ref2v-ctx-quality-pdd2-2k', label: '二遍 PDD · 第二次（复现性）', seedOffset: 0 },
}

// 等价臂说明：B 与 B2 是同一清单、同一 seed、同一张图，**成片必然逐像素相同**（prefix 只改文件名，
// 不进采样）。B2 的唯一用途是量「同配置重复跑的耗时离散度」，**不要把它当成第二条片子**做画质对比。


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

function lookup(id) {
  const r = getRegistry()
  let m = r.byId[id]
  if (!m) {
    // 注册表在清单目录时间戳变化时会**自动重载**；重载瞬间读到不完整状态会短暂查不到 id。
    // 再取一次即可（下一次调用会重新比对签名并完成加载）。
    m = getRegistry().byId[id]
  }
  if (!m) {
    const errs = (getRegistry().errors || []).join(' | ')
    throw new Error(`注册表里找不到 ${id}。加载错误：${errs || '(无)'}。` +
      '请确认 `node scripts/make-2k-template.mjs && node scripts/make-h3-variants.mjs` 已跑过。')
  }
  return m
}

function compile(arm) {
  const spec = MANIFESTS[arm]
  const m = lookup(spec.id)
  const [g, off] = m.chain?.lengthGrid || [1, 0]
  const sampled = Math.max(FRAMES, g * Math.ceil((FRAMES - off) / g) + off) + (m.chain?.sampleExtra || 0)
  const graph = buildGraphFromManifest(m, {
    prompt: PROMPT,
    width: 1344, height: 768,          // 被 resolutionLock 忽略，仅保持一致（真正注入的是 graph 尺寸）
    length: sampled,
    seed: SEED + spec.seedOffset,
    steps: STEPS,                      // PDD 档的 node 9 不存在 ⇒ 该参数对它自然无效，由 nfe 控制
    prefix: `e2e-2k/ab2-${arm}`,
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

mkdirSync(resolve(ROOT, 'e2e-out/2k-ab2'), { recursive: true })
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
      const out = resolve(ROOT, `e2e-out/2k-ab2/${arm}.mp4`)
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

const todo = ONLY.length ? ONLY : ['A', 'B', 'B2']
for (const arm of todo) {
  if (!MANIFESTS[arm]) throw new Error(`未知分臂 ${arm}（可选 A / B / B2）`)
  await run(arm)
}

if (!DRY && results.length) {
  console.log('\n═══ 耗时（全长 = 首遍 + 学习式放大 + 二遍精修 + 解码）')
  for (const r of results) {
    const fmin = r.vram?.length ? Math.min(...r.vram.map((v) => v.freeGiB)) : NaN
    const f0 = r.vram?.length ? r.vram[0].freeGiB : NaN
    console.log(`  ${r.arm.padEnd(3)} ${r.seconds.toFixed(1).padStart(8)}s  最低空闲显存 ${fmin.toFixed(1).padStart(5)} GiB`
      + `  占用峰值 ${(f0 - fmin).toFixed(1).padStart(5)} GiB  ${r.id}`)
  }
  const T = Object.fromEntries(results.map((r) => [r.arm, r.seconds]))
  // A 是冷跑（首遍真算），B 的首遍与 A 逐字节相同 ⇒ 命中缓存 ⇒ 时间 ≈ 纯二遍
  if (T.A && T.B) {
    console.log(`\n  A 冷跑 ${T.A.toFixed(1)}s → B 热跑 ${T.B.toFixed(1)}s = ${(T.A / T.B).toFixed(2)}×`)
    console.log('  注意：B 的墙钟 ≈ 纯二遍 + 放大/解码（首遍节点命中了 A 的缓存，见上面「缓存命中节点」）。')
    console.log('  该比例**不是**纯二遍加速比：分母里还含未加速的放大/解码。真正的二遍加速比要看')
    console.log('  A、B 各自的缓存命中集：若 B 的命中集 ⊇ 首遍节点，则')
    console.log('      二遍PDD ≈ t_B − t(放大+解码+加载)，二遍base ≈ t_A − 同一项')
    console.log('  画质对比（**闪烁是第一验收指标**）：')
    console.log('      python3 scripts/analyze-2k-pair.py e2e-out/2k-ab2/A.mp4 e2e-out/2k-ab2/B.mp4 --label-a base --label-b pdd')
  } else {
    console.log('  （A/B 没跑齐，暂不做比较）')
  }
}
