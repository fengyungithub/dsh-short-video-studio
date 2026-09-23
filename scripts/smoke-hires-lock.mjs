/**
 * scripts/smoke-hires-lock.mjs — 两阶段潜空间放大（resolutionLock）冒烟测试。
 *
 * 契约（docs/tier-strategy-design.md §9「两段式超分」/「>2K」）：
 *   **开源版 H3 原生上限就是 768p（1344×768）**，往更高尺寸直接采样会出复制/克隆伪影，
 *   所以「提分辨率」只能靠二遍：首遍在模型原生尺寸解运动/构图/声音 → 视频 latent 放大 →
 *   二遍低噪声重建细节。
 *
 * `resolutionLock` 有两种形态，本测试**分别**锁住：
 *
 *   ① **图锁定**（hires）：首遍尺寸是**图结构的一部分**（放大倍率写在图内节点上），
 *      不能被调用方传的 width/height 或画布 aspectRatio 覆盖 ⇒ 只支持 16:9。
 *   ② **只锁倍率**（学习式 2K ctx 族）：只声明 `{ scale: 2 }`，**首遍尺寸不锁**——按
 *      「显式宽高 → 画布比例 × 档位长边 → resolution.default」推导；图内目标尺寸是算术模板
 *      `"${width * 2}"`，跟着首遍走 ⇒ **支持 16:9 / 9:16 / 1:1**。
 *
 * 两种形态的共同契约：交付尺寸 = 首遍 × scale，且必有 warning（不静默）。
 *
 * 本测试锁住的语义：
 *  1) 图锁定：显式 width/height / 画布比例都改不动首遍尺寸
 *  2) 只锁倍率：三种比例都能推、显式宽高生效、9:16 与 16:9 像素量相同
 *  3) 不静默：调用了锁定实现就一定有 warning 说明首遍与交付的关系
 *  4) 图结构正确：放大节点 + 二遍采样（低 denoise）+ 解码读二遍 + 音频走二遍
 *  5) 音频不被放大：Video 与 Audio 的 latent 分离由放大节点保证（节点语义，登记在 requiresNodes）
 *  6) 不做隐式默认：priority<0，未显式选择时 quality 仍落到标准实现
 *  7) 无锁的既有实现尺寸行为不变（回归）
 *
 * 用法：node scripts/smoke-hires-lock.mjs
 */

// 测试隔离：不读本机 ~/.dsh 的真实配置（可能有用户自建策略，会改掉"隐式默认"的前提）
process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || '/nonexistent/svs-hires-smoke-config.json'

import { _internals, chainGraphMismatch } from '../lib/index.js'

const I = _internals
const { computeManifestSize, manifestDeliverySize, resolutionLockWarning, buildGraphFromManifest, getRegistry } = I

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `期望 ${want}，实际 ${got}`)
const S = (o) => `${o.w}×${o.h}`

const reg = getRegistry()
const HIRES = ['minimax-h3-ref2v-hires', 'minimax-h3-i2v-hires']
// 学习式放大（>2K）的 ctx 族：形状 × 档位 = 6 份 + 变体 A（PDD 只进二遍）2 份。
// 与 hires 的**关键差别**：本族用「只锁倍率」形态（`resolutionLock = { scale: 2 }`，不写 graph），
// 首遍尺寸不锁 ⇒ 支持 16:9 / 9:16 / 1:1；图内目标尺寸是算术模板 `"${width * 2}"`，跟着首遍走。
const TWO_K = [
  'minimax-h3-ref2v-ctx-quality-2k', 'minimax-h3-ref2v-ctx-balanced-pdd-2k', 'minimax-h3-ref2v-ctx-fast-2k',
  'minimax-h3-i2v-ctx-quality-2k', 'minimax-h3-i2v-ctx-balanced-pdd-2k', 'minimax-h3-i2v-ctx-fast-2k',
  // 变体 A：PDD 只进二遍（首遍与 quality-2k 逐字节相同）⇒ 二遍的 model/sigmas 接 PDD 侧
  'minimax-h3-ref2v-ctx-quality-pdd2-2k', 'minimax-h3-i2v-ctx-quality-pdd2-2k',
]
const TWO_K_PDD2 = new Set(['minimax-h3-ref2v-ctx-quality-pdd2-2k', 'minimax-h3-i2v-ctx-quality-pdd2-2k'])

console.log('\n[1] 清单存在且声明了锁定契约')
for (const id of HIRES) {
  const m = reg.byId[id]
  ok(`${id} 已注册`, Boolean(m))
  if (!m) continue
  eq(`${id} tier=quality`, m.tier, 'quality')
  eq(`${id} 只提供 quality 档`, Object.keys(m.modes).join(','), 'quality')
  ok(`${id} 声明 requiresNodes=[MiniMaxH3AVLatentUpscaleBy]`,
    Array.isArray(m.requiresNodes) && m.requiresNodes.includes('MiniMaxH3AVLatentUpscaleBy'),
    JSON.stringify(m.requiresNodes))
  // 首遍必须 ≤ 原生 768p 的像素量：H3 原生 1344×768，超过就失去"在原生尺寸重建"的前提
  const g = m.resolutionLock.graph
  ok(`${id} 首遍 ${g[0]}×${g[1]} 不超过原生 1344×768`, g[0] * g[1] <= 1344 * 768, S({ w: g[0], h: g[1] }))
  eq(`${id} 首遍正好是原生 ÷1.5`, `${g[0] * m.resolutionLock.scale}×${g[1] * m.resolutionLock.scale}`, '1344×768')
  eq(`${id} 交付尺寸 = 原生 768p`, S(manifestDeliverySize(m, { w: g[0], h: g[1] })), '1344×768')
}

console.log('\n[2] 锁定生效：显式宽高 / 画布比例都改不动首遍尺寸')
for (const id of HIRES) {
  const m = reg.byId[id]
  if (!m) continue
  eq(`${id} 显式 1920×1080 被忽略`, S(computeManifestSize(m, 'quality', 1920, 1080, '16:9')), '896×512')
  eq(`${id} 显式 768×1344（竖版）被忽略`, S(computeManifestSize(m, 'quality', 768, 1344, '9:16')), '896×512')
  eq(`${id} 画布 9:16 被忽略`, S(computeManifestSize(m, 'quality', undefined, undefined, '9:16')), '896×512')
  eq(`${id} 画布 1:1 被忽略`, S(computeManifestSize(m, 'quality', undefined, undefined, '1:1')), '896×512')
  // 无参也不能崩（画布未设置比例）
  eq(`${id} 无画布比例时仍锁定`, S(computeManifestSize(m, 'quality', undefined, undefined, undefined)), '896×512')
}

console.log('\n[3] 不静默：锁定必然伴随警告（说清改写成了什么）')
for (const id of HIRES) {
  const m = reg.byId[id]
  if (!m) continue
  const w = resolutionLockWarning(m, { w: 896, h: 512 })
  ok(`${id} 有警告`, typeof w === 'string' && w.length > 0)
  ok(`${id} 警告含实际交付尺寸`, Boolean(w && w.includes('1344×768')), w)
  ok(`${id} 警告说明显式宽高不生效`, Boolean(w && w.includes('width/height')), w)
}

console.log('\n[4] 图结构：放大 → 二遍低噪声 → 解码读二遍')
for (const id of HIRES) {
  const m = reg.byId[id]
  if (!m) continue
  const g = buildGraphFromManifest(m, {
    prompt: 'x', width: 896, height: 512, length: 124, seed: 1, steps: 20,
    prefix: 'smoke', refs: [], first_frame: null, last_frame: null,
  })
  // 放大节点存在且倍率正确
  const up = Object.values(g).find((n) => n.class_type === 'MiniMaxH3AVLatentUpscaleBy')
  ok(`${id} 有 AVLatentUpscaleBy`, Boolean(up))
  eq(`${id} 放大倍率 1.5`, up?.inputs.scale_by, 1.5)
  eq(`${id} 放大的是首遍采样结果（node 10）`, JSON.stringify(up?.inputs.samples), JSON.stringify(['10', 0]))

  // 二遍调度器必须 < 1（全噪声会重画表演，且 CONST 参数化下会毁掉信号）
  const schedEntries = Object.entries(g).filter(([, n]) => n.class_type === 'BasicScheduler')
  const s2Entry = schedEntries.find(([, n]) => Number(n.inputs.denoise) < 1)
  ok(`${id} 有二遍低噪声调度器`, Boolean(s2Entry))
  ok(`${id} 二遍 denoise ∈ (0,1)`, Number(s2Entry?.[1]?.inputs.denoise) > 0 && Number(s2Entry?.[1]?.inputs.denoise) < 1, String(s2Entry?.[1]?.inputs.denoise))
  eq(`${id} 二遍步数来自 params.steps2 默认值`, s2Entry?.[1]?.inputs.steps, 6)

  // 二遍采样器的 latent 必须来自放大节点，且 sigmas 指向那个低噪声调度器
  const samplers = Object.entries(g).filter(([, n]) => n.class_type === 'SamplerCustomAdvanced')
  eq(`${id} 有两个采样器（首遍 + 二遍）`, samplers.length, 2)
  const s2cEntry = samplers.find(([, n]) => JSON.stringify(n.inputs.sigmas) === JSON.stringify([s2Entry?.[0], 0]))
  ok(`${id} 二遍采样器用的是低噪声调度器`, Boolean(s2cEntry), JSON.stringify(samplers.map(([, n]) => n.inputs.sigmas)))
  eq(`${id} 二遍 latent 来自放大节点`, JSON.stringify(s2cEntry?.[1]?.inputs.latent_image), JSON.stringify(['14', 0]))
  ok(`${id} 二遍噪声独立于首遍（不同 seed 注入点）`,
    JSON.stringify(s2cEntry?.[1]?.inputs.noise) !== JSON.stringify(samplers.find(([, n]) => n !== s2cEntry?.[1])?.[1]?.inputs.noise))

  // 解码必须读二遍（读首遍就等于白放大）
  const videoDecode = Object.values(g).find((n) => n.class_type === 'VAEDecode' && JSON.stringify(n.inputs.samples) === JSON.stringify(['10b', 0]))
  ok(`${id} 视频解码读二遍结果`, Boolean(videoDecode))
  const audioDecode = Object.values(g).find((n) => n.class_type === 'VAEDecodeAudio' && JSON.stringify(n.inputs.samples) === JSON.stringify(['10b', 0]))
  ok(`${id} 音频解码读二遍结果（音频 latent 全程未被放大）`, Boolean(audioDecode))
  const create = Object.values(g).find((n) => n.class_type === 'CreateVideo')
  ok(`${id} CreateVideo 接的是二遍解码`, Boolean(create && JSON.stringify(create.inputs.images) === JSON.stringify(['11b', 0])))

  // 首遍尺寸注入生效
  const cond = g['5']
  eq(`${id} 首遍宽 896`, cond?.inputs.width, 896)
  eq(`${id} 首遍高 512`, cond?.inputs.height, 512)
}

console.log('\n[5] 不做隐式默认：未显式选择时 quality 仍落标准实现')
{
  const R = 'video.reference2video'
  const cands = reg.byCapability[R].filter((m) => m.tier === 'quality' && !m.internal)
  const implicit = I.sortTierCandidates(cands)[0]
  eq('ref2v quality 隐式首选仍是标准实现', implicit.id, 'minimax-h3-ref2v-quality')
  ok('ref2v-hires priority<0（显式可选中、不被隐式选中）', reg.byId['minimax-h3-ref2v-hires'].priority < 0)
  const I2 = 'video.image2video'
  const cands2 = reg.byCapability[I2].filter((m) => m.tier === 'quality' && !m.internal)
  eq('i2v quality 隐式首选仍是标准实现', I.sortTierCandidates(cands2)[0].id, 'minimax-h3-i2v-quality')
}

console.log('\n[6] 回归：无锁实现的尺寸行为不变')
{
  const std = reg.byId['minimax-h3-ref2v-quality']
  ok('标准实现没有 resolutionLock', std.resolutionLock === undefined)
  eq('标准实现 16:9 仍是 1344×768', S(computeManifestSize(std, 'quality', undefined, undefined, '16:9')), '1344×768')
  eq('标准实现 9:16 仍是 768×1344', S(computeManifestSize(std, 'quality', undefined, undefined, '9:16')), '768×1344')
  // 显式宽高仍优先，且照旧 snap 到 32 倍数（1080 → 1088）
  eq('标准实现显式宽高仍优先（snap32）', S(computeManifestSize(std, 'quality', 1920, 1080, '16:9')), '1920×1088')
  eq('标准实现交付尺寸 = 图尺寸', S(manifestDeliverySize(std, { w: 1344, h: 768 })), '1344×768')
  eq('标准实现无锁定警告', resolutionLockWarning(std, { w: 1344, h: 768 }), null)
  const i2v = reg.byId['minimax-h3-i2v-fast']
  eq('i2v fast 仍是 832×480', S(computeManifestSize(i2v, 'fast', undefined, undefined, '16:9')), '832×480')
}

console.log('\n[7] 学习式放大（>2K，ctx 族）：契约与图结构')
// 与 hires 的关键差别：hires 用**插值**放大器，只能把低分辨率首遍拉回原生（交付=原生）；
// 2k 用**学习式**放大器，×2 后交付**超过**模型原生上限。
// 本族由 **ctx 模板**派生，所以除放大之外还必须守住一条契约：**链式续接与放大可叠用**——
// 链上流动的是首遍 latent（node 22 存 node 10），放大发生在它之后，因此续接判据是首遍尺寸。
for (const id of TWO_K) {
  const m = reg.byId[id]
  ok(`${id} 已注册`, Boolean(m))
  if (!m) continue
  ok(`${id} tier ∈ {fast,balanced,quality}`, ['fast', 'balanced', 'quality'].includes(m.tier), m.tier)
  eq(`${id} 只提供自己那一档`, Object.keys(m.modes).join(','), m.tier)
  ok(`${id} 声明 requiresNodes=[MinimaxH3LatentUpscaler3DRefineHandoff]`,
    Array.isArray(m.requiresNodes) && m.requiresNodes.includes('MinimaxH3LatentUpscaler3DRefineHandoff'),
    JSON.stringify(m.requiresNodes))

  const pdd2 = TWO_K_PDD2.has(id)
  const isFast = m.tier === 'fast'
  const base = isFast ? '832×480' : '1344×768'
  const vert = isFast ? '480×832' : '768×1344'
  const sq = isFast ? '832×832' : '1344×1344'
  const delivery = isFast ? '1664×960' : '2688×1536'
  const deliveryV = isFast ? '960×1664' : '1536×2688'
  const deliveryS = isFast ? '1664×1664' : '2688×2688'

  // ── 「只锁倍率」形态（与 hires 的图锁定形态分道扬镳）──────────────────────────
  eq(`${id} 只锁倍率：不写 graph`, m.resolutionLock.graph, undefined)
  eq(`${id} 放大倍率 2`, m.resolutionLock.scale, 2)
  eq(`${id} 至少声明了 scale（校验要求）`, typeof m.resolutionLock.scale, 'number')

  // 首遍不再被钉死：三种比例各自推导，长边都是档位长边（9:16 与 16:9 像素量相同）
  const g16 = computeManifestSize(m, m.tier, undefined, undefined, '16:9')
  const gv = computeManifestSize(m, m.tier, undefined, undefined, '9:16')
  const gs = computeManifestSize(m, m.tier, undefined, undefined, '1:1')
  eq(`${id} 16:9 首遍 = ${base}`, S(g16), base)
  eq(`${id} 9:16 首遍 = ${vert}`, S(gv), vert)
  eq(`${id} 1:1 首遍 = ${sq}`, S(gs), sq)
  // 显式宽高现在**生效**（只锁倍率形态不覆盖它）——1080 snap 到 32 的倍数即 1088
  eq(`${id} 显式 1920×1080 生效（不再被改写，仅 snap32 → 1088）`,
    S(computeManifestSize(m, m.tier, 1920, 1080, '16:9')), '1920×1088')

  // 交付 = 首遍 × 2，逐比例对账
  const del = manifestDeliverySize(m, g16)
  eq(`${id} 16:9 交付 = 首遍 ×2 = ${delivery}`, S(del), delivery)
  eq(`${id} 9:16 交付 = ${deliveryV}`, S(manifestDeliverySize(m, gv)), deliveryV)
  eq(`${id} 1:1 交付 = ${deliveryS}`, S(manifestDeliverySize(m, gs)), deliveryS)
  ok(`${id} 16:9 交付两轴都在 32 对齐网格上`, del.w % 32 === 0 && del.h % 32 === 0, S(del))
  ok(`${id} 9:16 交付两轴都在 32 对齐网格上`,
    manifestDeliverySize(m, gv).w % 32 === 0 && manifestDeliverySize(m, gv).h % 32 === 0, S(manifestDeliverySize(m, gv)))
  if (!isFast) ok(`${id} 16:9 交付宽度 > 2560（真·超过 2K）`, del.w > 2560, String(del.w))

  const warn = resolutionLockWarning(m, g16)
  ok(`${id} 不静默：警告含实际交付 ${delivery}`, Boolean(warn && warn.includes(`${del.w}x${del.h}`)), warn)
  ok(`${id} 警告说明是二阶段（首遍 → 交付），不再说「尺寸被改写」`,
    Boolean(warn && warn.includes('两阶段') && warn.includes(String(g16.w))), warn)
  eq(`${id} 声明三种比例`, JSON.stringify(m.constraints?.aspectRatios), JSON.stringify(['16:9', '9:16', '1:1']))
  eq(`${id} maxDurationFrames=124（精修在放大后的尺寸上算）`, m.constraints?.maxDurationFrames, 124)

  const gg = buildGraphFromManifest(m, {
    prompt: 'x', width: g16.w, height: g16.h, length: 124, seed: 1, steps: 20,
    prefix: 'smoke', refs: [], first_frame: null, last_frame: null,
  })
  const rh = Object.values(gg).find((n) => n.class_type === 'MinimaxH3LatentUpscaler3DRefineHandoff')
  ok(`${id} 有 RefineHandoff 节点`, Boolean(rh))
  eq(`${id} 放大器吃的是首遍 AV latent（node 10）`, JSON.stringify(rh?.inputs.latent), JSON.stringify(['10', 0]))
  eq(`${id} lock_audio=true（音轨不进精修）`, rh?.inputs.lock_audio, true)
  eq(`${id} 目标尺寸跟着首遍（16:9）= ${delivery}`, `${rh?.inputs.width}×${rh?.inputs.height}`, delivery)
  if (pdd2) {
    eq(`${id} PDD 只进二遍：精修模型接 PDD 侧（node 2a）`, JSON.stringify(rh?.inputs.model), JSON.stringify(['2a', 0]))
    eq(`${id} PDD 只进二遍：sigmas 接 PDDAccScheduler（node 2c）`, JSON.stringify(rh?.inputs.sigmas), JSON.stringify(['2c', 0]))
  } else {
    eq(`${id} 精修模型接的是已 shift 的模型（node 2）`, JSON.stringify(rh?.inputs.model), JSON.stringify(['2', 0]))
    eq(`${id} 精修 sigmas 接普通低噪声调度器（node 9b）`, JSON.stringify(rh?.inputs.sigmas), JSON.stringify(['9b', 0]))
  }
  eq(`${id} 精修正条件接的是首遍条件（node 5）`, JSON.stringify(rh?.inputs.positive), JSON.stringify(['5', 0]))
  ok(`${id} 放大器权重走资产槽（有 default + env 可覆盖）`,
    Boolean(m.assets?.latent_upscaler?.default && m.assets?.latent_upscaler?.env),
    JSON.stringify(m.assets?.latent_upscaler))

  // ★ 本族的核心新能力：**同一份图**在 9:16 下目标尺寸自动变成首遍 ×2
  const ggv = buildGraphFromManifest(m, {
    prompt: 'x', width: gv.w, height: gv.h, length: 124, seed: 1, steps: 20,
    prefix: 'smoke', refs: [], first_frame: null, last_frame: null,
  })
  const rhv = Object.values(ggv).find((n) => n.class_type === 'MinimaxH3LatentUpscaler3DRefineHandoff')
  eq(`${id} 9:16 首遍注入 ${vert}`, `${ggv['5']?.inputs.width}×${ggv['5']?.inputs.height}`, vert)
  eq(`${id} 9:16 目标尺寸跟着首遍 = ${deliveryV}`, `${rhv?.inputs.width}×${rhv?.inputs.height}`, deliveryV)
  // 目标尺寸是算术模板算出来的（数字，不是图里写死的 16:9 字面量）——这正是支持任意比例的原因
  eq(`${id} 9:16 目标宽度 = 首遍宽 ×2（模板算出来的数字）`, rhv?.inputs.width, 2 * gv.w)
  eq(`${id} 9:16 目标高度 = 首遍高 ×2`, rhv?.inputs.height, 2 * gv.h)

  // 精修由 RefineHandoff 内部完成 ⇒ 图里只有一个采样器（多一个就是在高分辨率上采样两遍）
  eq(`${id} 图里只有一个采样器（精修在 RefineHandoff 内部）`,
    Object.values(gg).filter((n) => n.class_type === 'SamplerCustomAdvanced').length, 1)
  if (!pdd2) {
    const s2 = Object.entries(gg).filter(([, n]) => n.class_type === 'BasicScheduler' && Number(n.inputs.denoise) < 1)
    eq(`${id} 只有一个二遍低噪声调度器`, s2.length, 1)
    ok(`${id} 二遍 denoise ∈ (0,1)`,
      Number(s2[0]?.[1]?.inputs.denoise) > 0 && Number(s2[0]?.[1]?.inputs.denoise) < 1, `实际 ${s2[0]?.[1]?.inputs.denoise}`)
    eq(`${id} 二遍步数来自 params.steps2 默认值`, s2[0]?.[1]?.inputs.steps, 6)
  } else {
    ok(`${id} 二遍 denoise ∈ (0,1)`,
      Number(gg['2c']?.inputs.denoise) > 0 && Number(gg['2c']?.inputs.denoise) < 1, `实际 ${gg['2c']?.inputs.denoise}`)
  }

  // 二遍噪声必须与首遍不同，否则退化成重放首遍的高噪声步
  const n1 = gg['6']?.inputs.noise_seed
  const n2 = gg['6b']?.inputs.noise_seed
  ok(`${id} 二遍噪声独立于首遍`, Number(n1) !== Number(n2), `${n1} vs ${n2}`)

  // 解码必须读 RefineHandoff（读首遍等于白放大）
  ok(`${id} 视频解码读 RefineHandoff 输出`,
    Boolean(Object.values(gg).find((n) => n.class_type === 'VAEDecode' && JSON.stringify(n.inputs.samples) === JSON.stringify(['17', 0]))))
  ok(`${id} 音频解码读 RefineHandoff 输出（音轨全程未被放大）`,
    Boolean(Object.values(gg).find((n) => n.class_type === 'VAEDecodeAudio' && JSON.stringify(n.inputs.samples) === JSON.stringify(['17', 0]))))

  // ── 链式续接 × 放大：三条不变式 ──────────────────────────────────────────────
  ok(`${id} 声明 chain（续接与放大叠用）`, Boolean(m.chain), JSON.stringify(m.chain))
  eq(`${id} 链式存档读的仍是首遍 latent（node 22 ← node 10）——这是能续接的原因`,
    JSON.stringify(gg['22']?.inputs.latent), JSON.stringify(['10', 0]))
  eq(`${id} Trim 改读放大后的解码（node 23 ← 11b）`,
    JSON.stringify(gg['23']?.inputs.images), JSON.stringify(['11b', 0]))
  eq(`${id} Trim 的音频也走放大后的解码（node 23 ← 11c）`,
    JSON.stringify(gg['23']?.inputs.audio), JSON.stringify(['11c', 0]))
  const create = Object.values(gg).find((n) => n.class_type === 'CreateVideo')
  ok(`${id} CreateVideo 接的是 Trim（ctx 图结构）`,
    Boolean(create && JSON.stringify(create.inputs.images) === JSON.stringify(['23', 0])),
    JSON.stringify(create?.inputs))

  // 首遍尺寸注入生效（是该档的首遍尺寸，不是交付尺寸）
  eq(`${id} 首遍宽 ${g16.w}`, gg['5']?.inputs.width, g16.w)
  eq(`${id} 首遍高 ${g16.h}`, gg['5']?.inputs.height, g16.h)
}

console.log('\n[8] 通用契约：所有带 resolutionLock 的实现按**两种形态**分别遵守')
{
  // internal（内部诊断 / 已弃用退场）清单不参与档位解析、也没有 priority，
  // 对它们的「只能显式选中」等面向用户的断言不适用 —— 只对可被档位选中的实现生效。
  const locked = Object.values(reg.byId).filter((m) => m.resolutionLock && !m.internal)
  const graphLocked = locked.filter((m) => Array.isArray(m.resolutionLock.graph))
  const scaleOnly = locked.filter((m) => !Array.isArray(m.resolutionLock.graph))
  ok('锁定实现数量 ≥ 10（hires 2 + 2k ctx 族 8）', locked.length >= 10, String(locked.length))
  ok('两种形态都存在（hires = 图锁定；2k ctx 族 = 只锁倍率）',
    graphLocked.length >= 2 && scaleOnly.length >= 6, `图锁定 ${graphLocked.length} / 只锁倍率 ${scaleOnly.length}`)

  for (const m of locked) {
    ok(`${m.id} priority<0（只能显式选中）`, m.priority < 0, String(m.priority))
    ok(`${m.id} 传任意调用方尺寸都会给警告`, typeof resolutionLockWarning(m, { w: 1, h: 1 }) === 'string')
    // 交付 = 首遍 × scale（两形态共同点）
    const g = Array.isArray(m.resolutionLock.graph)
      ? { w: m.resolutionLock.graph[0], h: m.resolutionLock.graph[1] }
      : computeManifestSize(m, m.tier, undefined, undefined, '16:9')
    const sc = Number(m.resolutionLock.scale) || 1
    ok(`${m.id} 交付尺寸 = 首遍 × scale`,
      S(manifestDeliverySize(m, g)) === `${Math.round(g.w * sc)}×${Math.round(g.h * sc)}`, S(manifestDeliverySize(m, g)))
    if (Array.isArray(m.resolutionLock.graph)) {
      // 图锁定：显式宽高与画布比例都不得覆盖
      eq(`${m.id} 图锁定：画布 9:16 改不动首遍`,
        S(computeManifestSize(m, m.tier, undefined, undefined, '9:16')), S(g))
      eq(`${m.id} 图锁定：显式 1920×1080 改不动首遍`,
        S(computeManifestSize(m, m.tier, 1920, 1080, '16:9')), S(g))
      ok(`${m.id} 图锁定：警告说「不生效」`,
        resolutionLockWarning(m, g).includes('不生效'), resolutionLockWarning(m, g))
      eq(`${m.id} 图锁定：只声明 16:9`, JSON.stringify(m.constraints?.aspectRatios), JSON.stringify(['16:9']))
    } else {
      // 只锁倍率：首遍照请求生效，三种比例都能推
      ok(`${m.id} 只锁倍率：画布 9:16 能改首遍（不再被忽略）`,
        S(computeManifestSize(m, m.tier, undefined, undefined, '9:16')) !== S(g),
        S(computeManifestSize(m, m.tier, undefined, undefined, '9:16')))
      eq(`${m.id} 只锁倍率：显式 1920×1080 生效（snap32 → 1088）`,
        S(computeManifestSize(m, m.tier, 1920, 1080, '16:9')), '1920×1088')
      ok(`${m.id} 只锁倍率：警告说「两阶段」而不是「改写」`,
        resolutionLockWarning(m, g).includes('两阶段'), resolutionLockWarning(m, g))
      eq(`${m.id} 只锁倍率：声明 16:9/9:16/1:1`,
        JSON.stringify(m.constraints?.aspectRatios), JSON.stringify(['16:9', '9:16', '1:1']))
      // 9:16 与 16:9 像素量必须相同（长边不变，只是方向不同）
      const gv = computeManifestSize(m, m.tier, undefined, undefined, '9:16')
      eq(`${m.id} 只锁倍率：9:16 与 16:9 像素量相同`, g.w * g.h, gv.w * gv.h)
      // note 里写的首遍尺寸必须与**真实推导**一致——曾经手算 longSide*9/16 写出 468/756（没走 snap32）
      const note = String(m.note || '')
      ok(`${m.id} note 里的 16:9/9:16 首遍尺寸与真实推导一致`,
        note.includes(S(g)) && note.includes(S(gv)), `note 里缺 ${S(g)} 或 ${S(gv)}`)
    }
  }
  // 加了锁定族之后，隐式默认**不受影响**（这是它们 priority<0 的意义）
  const cases = [['video.reference2video', 'minimax-h3-ref2v-quality'], ['video.image2video', 'minimax-h3-i2v-quality']]
  for (const [cap, want] of cases) {
    const cands = reg.byCapability[cap].filter((m) => m.tier === 'quality' && !m.internal)
    eq(`${cap} quality 隐式首选仍是非锁定实现`, I.sortTierCandidates(cands)[0].id, want)
  }
}

console.log('\n[8b] maxDurationFramesByRatio：**只声明不强制**，但形状必须合法')
{
  // 存在意义：同一实现在某些比例下显存余量很小（两阶段放大族 1:1 的交付像素是 16:9 的 1.78 倍），
  // 把这个事实结构化记下来供 UI/文档/排障用——渲染路径**不读它**，不会拦任何请求（这是刻意的）。
  const fast = reg.byId['minimax-h3-ref2v-ctx-fast-2k']
  eq('fast-2k 声明 1:1 的建议帧数上限（实测值）', fast?.constraints?.maxDurationFramesByRatio?.['1:1'], 56)
  eq('i2v fast-2k 同样声明', reg.byId['minimax-h3-i2v-ctx-fast-2k']?.constraints?.maxDurationFramesByRatio?.['1:1'], 56)
  // 未实测的档**不许编数字**（宁缺勿假）
  for (const id of ['minimax-h3-ref2v-ctx-quality-2k', 'minimax-h3-i2v-ctx-quality-2k',
                    'minimax-h3-ref2v-ctx-balanced-2k', 'minimax-h3-i2v-ctx-balanced-2k']) {
    ok(`${id} 不声明未实测的 1:1 上限（宁缺勿假）`,
      reg.byId[id]?.constraints?.maxDurationFramesByRatio === undefined)
  }
  // 形状 fail-closed：比例键写错 / 帧数非法会让声明被静默忽略，必须判非法
  const mk = (v) => {
    const m = JSON.parse(JSON.stringify(fast))
    delete m._source
    m.constraints = { ...m.constraints, maxDurationFramesByRatio: v }
    return I.validateManifest(m, 'ratio-cap-probe')
  }
  ok('合法声明 {"1:1":56} 通过', mk({ '1:1': 56 }).ok === true, JSON.stringify(mk({ '1:1': 56 }).errors))
  ok('比例键写成 "square" 被判非法（否则静默忽略）', mk({ square: 56 }).ok === false)
  ok('帧数 0 被判非法', mk({ '1:1': 0 }).ok === false)
  ok('写成数组被判非法', mk([56]).ok === false)
  // 渲染路径不消费它 ⇒ 不构成拦截。这里用「注册表里没人读」的等价断言：
  // 声明与实际可跑帧数无关——fast-2k 的 maxDurationFrames 仍是 124，1:1 也能请求 124（只是余量薄）。
  eq('声明上限不改变 maxDurationFrames（不强制）', fast?.constraints?.maxDurationFrames, 124)
}

console.log('\n[9] 链式续接 × 两阶段放大：判据是**首遍尺寸**，不是交付尺寸')
// 接线事实：ctx 图的链式存档（node 22）读的是 node 10（首遍 latent），放大发生在它之后
// ⇒ 「两阶段放大」与「链式续接」可以叠用；兼容性判据落在首遍尺寸上。
// 节点上：width/height = 交付尺寸，graphWidth/graphHeight = 首遍尺寸。
{
  const q = { width: 2688, height: 1536, graphWidth: 1344, graphHeight: 768 }   // 学习式 2K（quality/pdd）
  const f = { width: 1664, height: 960, graphWidth: 832, graphHeight: 480 }     // 学习式 2K（fast）
  const plain = { width: 1344, height: 768 }                                    // 普通实现（无放大）
  const plainFast = { width: 832, height: 480 }

  // 同首遍尺寸、不同交付尺寸 ⇒ 兼容（这正是 U1 × ctx 的核心）
  ok('2K quality(交付 2688×1536) → 2K quality：首遍同为 1344×768，兼容',
    chainGraphMismatch(q, { w: 1344, h: 768 }) === null)
  ok('2K fast(1664×960) → 2K fast：首遍同为 832×480，兼容',
    chainGraphMismatch(f, { w: 832, h: 480 }) === null)
  ok('普通 1344×768 → 2K quality：首遍同为 1344×768，兼容（交付尺寸不同也允许）',
    chainGraphMismatch(plain, { w: 1344, h: 768 }) === null)
  ok('2K fast(首遍 832×480) → 普通 832×480：兼容',
    chainGraphMismatch(f, { w: 832, h: 480 }) === null)
  // 首遍不同 ⇒ 拒跑，且信息里必须给出两侧的首遍尺寸
  const m1 = chainGraphMismatch(q, { w: 832, h: 480 })
  ok('2K quality(首遍 1344×768) → 2K fast(首遍 832×480)：拒跑', typeof m1 === 'string', String(m1))
  ok('拒跑信息含上一镜首遍尺寸 1344×768', Boolean(m1 && m1.includes('1344×768')), String(m1))
  ok('拒跑信息含本镜首遍尺寸 832×480', Boolean(m1 && m1.includes('832×480')), String(m1))
  ok('拒跑信息说明「交付尺寸可以不同」', Boolean(m1 && m1.includes('交付尺寸可以不同')), String(m1))
  ok('普通 1344×768 → 2K fast(832×480)：拒跑',
    typeof chainGraphMismatch(plain, { w: 832, h: 480 }) === 'string')
  // 旧节点没记尺寸 ⇒ 不判死（交给后续步骤），不能因缺字段就拒跑
  ok('旧节点无尺寸字段 ⇒ 不判死', chainGraphMismatch({}, { w: 1344, h: 768 }) === null &&
    chainGraphMismatch(undefined, { w: 1344, h: 768 }) === null)
  // 交付尺寸不参与判据：同一份 max duration 交付尺寸不同也算兼容（防回归成旧行为）
  ok('判据不看交付尺寸（2688×1536 vs 1344×768 交付仍兼容）',
    chainGraphMismatch(q, { w: 1344, h: 768 }) === null && chainGraphMismatch(plain, { w: 1344, h: 768 }) === null)
  ok('bare fast 交付尺寸相同但首遍相同也兼容', chainGraphMismatch(plainFast, { w: 832, h: 480 }) === null)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)