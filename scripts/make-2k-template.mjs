/**
 * scripts/make-2k-template.mjs — 由 **ctx（链式续接）** base 模板派生「>2K」模板（U1 方案）。
 *
 * 与 hires（`make-hires-template.mjs`）的区别，就在「怎么放大」这一件事上：
 *   · hires 用内置 `MiniMaxH3AVLatentUpscaleBy`（**插值**，1.5×）——只保结构、不造细节，
 *     所以它只能把 896×512 拉回模型原生 1344×768，交付分辨率仍然 = 原生上限。
 *   · 2k 用**学习式 3D 放大器**（`minimax_h3_latent_upscaler_3d_conv_v1_bf16`，×2）
 *     ——在 latent 空间真重建，把首遍推到 2 倍尺寸（1344×768 → 2688×1536）。
 *
 * ## 为什么基模板必须是 ctx（链式续接）版
 *
 * 2026-09 起 U1 不再是一份孤立的 quality 清单，而是**按档位 × 形状的 6 份清单**，且全部由
 * ctx 模板派生。可行性来自一个接线事实（本脚本会 fail-closed 断言它）：
 *
 *   `MiniMaxH3MotionContextSaveLatent`（node 22）读的是 **node 10 = 采样器输出 = 首遍 latent**，
 *   而放大发生在采样之后（node 17）。所以**链上流动的始终是首遍尺寸的 latent**，
 *   放大后的交付尺寸根本不参与续接 ⇒ 「两阶段放大」与「链式续接」可以叠用。
 *
 * 由此得到链的兼容性契约（也改进了 lib 侧的校验）：
 *   **一条链内首遍尺寸必须一致**（普通实现 = 交付尺寸；本族 = 首遍尺寸），交付尺寸可以不同。
 *
 * ## 图结构（相对 ctx base 的改动）
 *
 *   1) resolutionLock **只声明倍率**（`{ scale: 2 }`，不锁首遍）——首遍尺寸照常按
 *      「显式 width/height → 画布 aspectRatio × 档位长边 → resolution.default」推导。
 *      图内目标尺寸不是字面量，而是算术模板 `"${width * 2}"` / `"${height * 2}"`，
 *      跟着首遍走 ⇒ **任意画幅比例都能用**（16:9 / 9:16 / 1:1）。
 *   2) 新增 node 6b/9b = 二遍的新噪声 + 低 σ 调度（denoise 0.3 / 6 步）；
 *   3) 新增 node 17 = `MinimaxH3LatentUpscaler3DRefineHandoff`
 *      ——官方语义：「Learned LBH 3D upscale followed by low-sigma MiniMax H3 refinement …
 *      The LATENT output is final/decode-ready」。学习式放大 + 二遍采样由它一次做完；
 *      `lock_audio=true` 保持首遍音轨、并把音频排除在精修之外（口型/对白天然不破）；
 *   4) **只重指 node 23（MotionContextTrim）** 去读放大后的解码（11b/11c）。
 *      ctx 图里 `CreateVideo` 读的是 23 而不是 11b，所以 12 不用动；
 *   5) **node 22 一个字都不改**——链式存档仍读 node 10（首遍），这正是能续接的原因；
 *   6) node 20/21（加载上一镜 + 注入 head）原样保留。
 *
 * ## 档位与尺寸（16:9 口径；其余比例按同一档长边对称推）
 *
 *   fast        首遍 832×480   （4 步 LoRA）       → 交付 1664×960
 *   balanced    首遍 1344×768  （8 步 / PDD）      → 交付 2688×1536
 *   quality     首遍 1344×768  （20 步）           → 交付 2688×1536
 *   9:16 同档    首遍 480×832 / 768×1344（长边不变）→ 交付 960×1664 / 1536×2688（像素量同 16:9）
 *   1:1 同档     首遍 832×832 / 1344×1344          → 交付 1664×1664 / 2688×2688（**像素 1.78×**）
 *
 * 放大倍率 SCALE 写在图内节点（node 17 的 scale）与 `resolutionLock.scale` 两处，必须一致；
 * 交付尺寸 = 首遍 × SCALE，由 lib 的 manifestDeliverySize() 推出并记进画布节点。
 *
 * 用法：node scripts/make-2k-template.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = resolve(ROOT, 'scripts/h3-templates')

const SCALE = 2
const PASS2_DENOISE = 0.3    // 起手值（已实测：无 32px 网格伪影，细节增益 6.6×）
const PASS2_STEPS = 6
const UPSCALER = 'minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors'
// 首遍 seed + 2e6：与 hires 的 +1e6 分开，避免同一 seed 下两条链的二遍噪声撞车
const PASS2_SEED_OFFSET = 2000000

// 首遍尺寸都落在 16× VAE 网格与 32 对齐网格上（832/480、1344/768 都是 16 的倍数），不需要再 snap。
const NATIVE = [1344, 768]
const FAST = [832, 480]

/**
 * 8 份清单 = 形状（ref2v/i2v）× 档位（fast / balanced / balanced-pdd / quality）。
 * 其中 `balanced` 与 `balanced-pdd` 是**同一档的两臂**：只差首遍要不要 PDD 加速，用于 A/B 归因。
 * `tier` 是**清单档位**（= base 模板里对应的 modes 键），`suffix` 是 id 后缀。
 */
const SPECS = [
  // ── ref2v ────────────────────────────────────────────────────────────────
  {
    base: 'minimax-h3-ref2v-ctx.json',
    out: 'minimax-h3-ref2v-ctx-quality-2k',
    tier: 'quality',
    conditionNode: 'MiniMaxH3ReferenceToVideo',
    family: 'ref2v',
    graph: NATIVE,
    sibling: 'minimax-h3-ref2v-ctx-quality',
  },
  {
    // **PDD 只进二遍**：与 quality-2k 的**首遍逐字节相同**（同 template、同 20 步），
    // 唯一变量是二遍的 model/sigmas 换成 PDD 侧 ⇒ 这是「二遍加速到底值不值」的干净对照。
    // 对照臂 = minimax-h3-ref2v-ctx-quality-2k。
    base: 'minimax-h3-ref2v-ctx.json',
    out: 'minimax-h3-ref2v-ctx-quality-pdd2-2k',
    tier: 'quality',
    conditionNode: 'MiniMaxH3ReferenceToVideo',
    family: 'ref2v',
    graph: NATIVE,
    sibling: 'minimax-h3-ref2v-ctx-quality',
    pddPass2: true,
  },
  {
    base: 'minimax-h3-pdd-ref2v-ctx.json',
    out: 'minimax-h3-ref2v-ctx-balanced-pdd-2k',
    tier: 'balanced',
    conditionNode: 'MiniMaxH3ReferenceToVideo',
    family: 'ref2v',
    graph: NATIVE,
    sibling: 'minimax-h3-ref2v-ctx-balanced-pdd',
  },
  {
    // 非 PDD 的 balanced-2k = A/B 的**对照臂**，与上一份只差「首遍要不要 PDD 加速」。
    // base 必须用 8step-ctx（不是 PDD 版）：两者首遍步数（8）、shift（6/3）、采样器（euler）
    // 完全一致，唯一区别就是 PDD 的 `MiniMaxH3PDDAccApply`（node 2a）与它产出的 sigma。
    // 基线走普通 `BasicScheduler` 出 sigma —— 这才是 balanced 档「不加速」的本来配方。
    base: 'minimax-h3-ref2v-8step-ctx.json',
    out: 'minimax-h3-ref2v-ctx-balanced-2k',
    tier: 'balanced',
    conditionNode: 'MiniMaxH3ReferenceToVideo',
    family: 'ref2v',
    graph: NATIVE,
    sibling: 'minimax-h3-ref2v-ctx-balanced',
  },
  {
    base: 'minimax-h3-ref2v-ctx.json',
    out: 'minimax-h3-ref2v-ctx-fast-2k',
    tier: 'fast',
    conditionNode: 'MiniMaxH3ReferenceToVideo',
    family: 'ref2v',
    graph: FAST,
    sibling: 'minimax-h3-ref2v-ctx-fast',
  },
  // ── i2v ──────────────────────────────────────────────────────────────────
  {
    base: 'minimax-h3-i2v-ctx.json',
    out: 'minimax-h3-i2v-ctx-quality-2k',
    tier: 'quality',
    conditionNode: 'MiniMaxH3ImageToVideo',
    family: 'i2v',
    graph: NATIVE,
    sibling: 'minimax-h3-i2v-ctx-quality',
  },
  {
    // i2v 侧的 PDD-只进二遍（走 FL2VA 权重）。理由见上面 ref2v 同名条目。
    base: 'minimax-h3-i2v-ctx.json',
    out: 'minimax-h3-i2v-ctx-quality-pdd2-2k',
    tier: 'quality',
    conditionNode: 'MiniMaxH3ImageToVideo',
    family: 'i2v',
    graph: NATIVE,
    sibling: 'minimax-h3-i2v-ctx-quality',
    pddPass2: true,
  },
  {
    base: 'minimax-h3-pdd-i2v-ctx.json',
    out: 'minimax-h3-i2v-ctx-balanced-pdd-2k',
    tier: 'balanced',
    conditionNode: 'MiniMaxH3ImageToVideo',
    family: 'i2v',
    graph: NATIVE,
    sibling: 'minimax-h3-i2v-ctx-balanced-pdd',
  },
  {
    // i2v 侧的对照臂（与 ref2v 版同构；走 FL2VA 权重）。理由见上面 ref2v 的注释。
    base: 'minimax-h3-i2v-8step-ctx.json',
    out: 'minimax-h3-i2v-ctx-balanced-2k',
    tier: 'balanced',
    conditionNode: 'MiniMaxH3ImageToVideo',
    family: 'i2v',
    graph: NATIVE,
    sibling: 'minimax-h3-i2v-ctx-balanced',
  },
  {
    base: 'minimax-h3-i2v-ctx.json',
    out: 'minimax-h3-i2v-ctx-fast-2k',
    tier: 'fast',
    conditionNode: 'MiniMaxH3ImageToVideo',
    family: 'i2v',
    graph: FAST,
    sibling: 'minimax-h3-i2v-ctx-fast',
  },
]

// `resolutionLock` 的 note 会拼进 lib 的解析警告，让调用方看到「首遍 → 交付」的换算。
// 只锁倍率形态（无 graph）：首遍尺寸照请求生效，放大在其后 ⇒ 任意比例可用。
const noteFor = (w, h) =>
  '两阶段放大：首遍尺寸**不锁**（按显式 width/height 或画布比例 × 档位长边推导），' +
  '学习式 3D latent 放大器 ×' + SCALE + ' 推到首遍的 ' + SCALE + ' 倍，再以低噪声（denoise ' + PASS2_DENOISE + '）精修。' +
  '交付尺寸 = 首遍 × ' + SCALE + '（16:9 首遍 ' + w + '×' + h + ' → 交付 ' + w * SCALE + '×' + h * SCALE + '）。' +
  '链式续接：**链上流动的是首遍 latent**（node 22 存的是 node 10），放大在其之后 ⇒ 同族续接成立；' +
  '一条链内**首遍尺寸必须一致**（跨比例续接不成立），交付尺寸可以不同。'

let failed = 0
for (const spec of SPECS) {
  const src = JSON.parse(readFileSync(resolve(DIR, spec.base), 'utf8'))
  const m = JSON.parse(JSON.stringify(src))
  const g = m.graph
  // spec.graph 现在只是**16:9 参考尺寸**（= resolution.default，也是 note/description 里举例用的数字）。
  // 它**不再锁任何东西**：真实首遍尺寸由调用方推导（显式宽高 > 画布比例 × 档位长边 > default），
  // 图内目标尺寸是算术模板 ⇒ 任意比例都自动对上。spec.graph 写错不影响出片，只会让文案不准。
  const [GW, GH] = spec.graph
  const out = [GW * SCALE, GH * SCALE]

  const bad = (msg) => { console.error(`✗ ${spec.out}: ${msg}`); failed++; return true }

  // ── 守住 base 的前提：条件节点、链式存档读首遍、Trim 在首遍解码上 ──────────────
  if (g['5']?.class_type !== spec.conditionNode) {
    if (bad(`${spec.base} 的 node 5 是 ${g['5']?.class_type}，期望 ${spec.conditionNode}——base 已变更，请先核对`)) continue
  }
  if (JSON.stringify(g['22']?.inputs?.latent) !== JSON.stringify(['10', 0])) {
    if (bad(`node 22（链式存档）读的是 ${JSON.stringify(g['22']?.inputs?.latent)}，必须是 ["10",0]（首遍 latent）——` +
      `如果改成读放大后的 latent，续接会因两镜 latent 尺寸不同而直接失败`)) continue
  }
  if (JSON.stringify(g['23']?.inputs?.images) !== JSON.stringify(['11', 0])) {
    if (bad(`node 23（Trim）读的是 ${JSON.stringify(g['23']?.inputs?.images)}，必须是 ["11",0]（首遍解码）——base 已变更`)) continue
  }
  if (!src.modes?.[spec.tier]) {
    if (bad(`${spec.base} 没有 modes.${spec.tier} 档`)) continue
  }

  m.id = spec.out
  m.capability = spec.capability
  m.description =
    '链式续接 + 学习式放大（U1）：在 `' + spec.sibling + '` 的同一份图上，把采样结果交给**学习式 3D latent 放大器**' +
    '（在同一模型上精修出细节），交付 = 首遍 × ' + SCALE + '。' +
    '与 hires 档的区别：hires 用的是**插值**放大，只能把低分辨率首遍拉回原生 768p（交付仍是 768p）；' +
    '本档用学习式放大器，在 latent 空间真重建，因此交付分辨率**超过原生上限**。' +
    '音频 latent 全程不被放大、精修时被 mask 在外（lock_audio），音轨与口型沿用首遍。' +
    '**首遍尺寸不锁**（`resolutionLock` 只声明倍率），按显式 width/height 或画布比例推导；' +
    '图内目标尺寸是算术模板（`${width * 2}`），跟着首遍走 ⇒ **支持 16:9 / 9:16 / 1:1**：' +
    '16:9 首遍 ' + GW + '×' + GH + ' → 交付 ' + out[0] + '×' + out[1] + '；' +
    '9:16 首遍 ' + GH + '×' + GW + ' → 交付 ' + out[1] + '×' + out[0] + '（像素量相同）；' +
    '1:1 首遍 ' + GW + '×' + GW + ' → 交付 ' + out[0] + '×' + out[0] + '（像素量为 16:9 的 ' + (GW / GH).toFixed(2) + '×，更重、可能 OOM）。' +
    '**链式续接与两阶段放大可叠用**：链上传递的是首遍 latent（node 22 读 node 10），放大在其之后；' +
    '同一条链内首遍尺寸必须一致（跨比例不能续接）。'
  // 只保留该档自己的 mode（其余档由普通清单/ctx 清单承担）
  m.modes = { [spec.tier]: src.modes[spec.tier] }
  m.resolution = { policy: 'aspect-ratio', snap: 32, default: { [spec.tier]: spec.graph } }
  // 只锁倍率：不写 graph ⇒ 首遍照常推导（显式宽高 > 画布比例 > default），交付 = 首遍 × SCALE。
  // 这是本族支持任意比例的关键（图锁定形态会把显式宽高与画布比例一起忽略）。
  m.resolutionLock = { scale: SCALE, note: noteFor(GW, GH) }
  m.requiresNodes = [...new Set([...(src.requiresNodes || []), 'MinimaxH3LatentUpscaler3DRefineHandoff'])]
  // 三种比例都开：首遍尺寸来自档位长边 + 画布比例，放大器与首遍尺寸无关（目标尺寸是模板算的）。
  // 像素量：9:16 与 16:9 **完全相同**（长边都是档位长边，只是方向不同）；1:1 = 1.78×，最重。
  // maxDurationFrames=124：精修在 2688×1536（16:9）上算，代价随帧数**超线性**。
  //   序列长 ≈ (2688/32)×(1536/32)×(帧/4) ≈ 125k token，是原生 1344×768 的 ≈3.5×
  //   （注意：500k 是 16× VAE 的 latent cell 数，不是 transformer 序列长度）。
  //   实测 56 帧 269.3s / 124 帧 1671.2s ⇒ 帧数 ×2.21、耗时 ×6.2（非 ctx 基座）。
  //   基线模板继承来的 288/310 帧在 2K 上按此趋势是小时级且很可能 OOM，
  //   所以这里按**已实测过的最长长度**封顶；要放长必须先跑一次探针再改这个数。
  //   fast 档交付 1664×960（token ≈ 1/2.6），理论上有余量，但同样要实测过才放宽。
  //   ⚠️ 1:1 交付是 16:9 的 1.78× 像素，显存余量很薄 —— 见下面的 maxDurationFramesByRatio。
  m.constraints = { ...(src.constraints || {}), aspectRatios: ['16:9', '9:16', '1:1'], maxDurationFrames: 124 }
  // 1:1 的建议帧数上限（**只声明、不强制**：渲染不会被拦，供 UI/文档/排障提示）。
  //   只声明**实测过**的档，不猜数字：
  //     fast 档 1:1（交付 1664×1664）实测：56 帧峰值余量 13.0 GiB 从容；
  //       124 帧峰值 72.6/79.2 GiB（余量仅 6.6 GiB），同配置另有一次运行被中断 ⇒ 56 是稳妥值。
  //     quality/balanced 档 1:1 交付 2688×2688（= fast 的 2.6 倍像素）**完全未实测**，
  //       所以这里**不声明**上限（编一个数字比留空更糟）；要用先跑小帧数探针：
  //       node scripts/probe-2k-aspect.mjs --workflow <该档 2k 清单> --ratio 1:1 --frames 22
  if (spec.tier === 'fast') m.constraints.maxDurationFramesByRatio = { '1:1': 56 }
  // 学习式放大器权重：kind=other（不是 checkpoint/clip/vae/lora 之一），可用 env 覆盖
  m.assets = {
    ...(m.assets || {}),
    latent_upscaler: {
      kind: 'other',
      default: UPSCALER,
      env: 'DSH_SVS_H3_LATENT_UPSCALER',
      label: 'H3 学习式 latent 放大器（3D）',
    },
  }
  // `pddPass2` 变体额外需要 PDD 权重槽（base 模板里没有）。必须与 UNet 同族：
  // ref2v 用 ref2va、i2v 用 fl2va —— 节点有 trunk/head 指纹守卫（partition_check）。
  if (spec.pddPass2) {
    m.assets = {
      ...m.assets,
      pdd: {
        kind: 'other',
        default: spec.family === 'i2v'
          ? 'minimax_h3_fl2va_pdd_acc_8step_comfyui.safetensors'
          : 'minimax_h3_ref2va_pdd_acc_8step_comfyui.safetensors',
        env: spec.family === 'i2v' ? 'DSH_SVS_H3_PDD_FL2V' : 'DSH_SVS_H3_PDD_REF2V',
        label: 'MiniMax-H3 PDD Acc 8 步（放 models/pdd_acc/）',
      },
    }
  }

  // 1) 二遍：新噪声 + 低 σ 调度
  g['6b'] = { class_type: 'RandomNoise', inputs: { noise_seed: '${seed + ' + PASS2_SEED_OFFSET + '}' } }
  g['9b'] = {
    class_type: 'BasicScheduler',
    inputs: { model: ['2', 0], scheduler: 'simple', steps: null, denoise: PASS2_DENOISE },
  }
  // 2) 学习式放大 + 低 σ 精修一次做完，输出 decode-ready latent
  g['17'] = {
    class_type: 'MinimaxH3LatentUpscaler3DRefineHandoff',
    inputs: {
      latent: ['10', 0],          // 首遍的 AV latent（音轨由 lock_audio 原样保留）
      noise: ['6b', 0],
      sampler: ['8', 0],
      sigmas: ['9b', 0],
      model: ['2', 0],            // 已做视频 12 / 音频 3 shift 的模型（PDD 档首遍另有 2a，二遍仍用 2）
      positive: ['5', 0],
      model_name: '$assets.latent_upscaler',
      mode: 'target dimensions',
      // 目标尺寸 = 首遍 × SCALE，用**算术模板**跟着 job 的 width/height 走（lib/manifest.js 的
      // resolveTemplate 支持纯算术：允许字符集 [0-9+-*/().\s]）。这样同一份图在 16:9 / 9:16 / 1:1
      // 下都自动对上首遍，不必为每个比例各出一份清单——这是「只锁倍率」形态能成立的关键。
      width: '${width * ' + SCALE + '}',
      height: '${height * ' + SCALE + '}',
      scale: SCALE,
      megapixels: 1,
      align: 32,
      keep_proportion: true,
      lock_audio: true,
      cfg: 1,
      device: 'cuda',
      precision: 'bf16',
      offload_after_upscale: true,
    },
  }

  // 2b) PDD 只进二遍（`pddPass2`）：把**精修那一步**的 model 与 sigmas 换成 PDD 侧。
  //
  // 为什么这样接：2K 的开销几乎全在二遍（序列 ≈ 首遍 4×，注意力随 S 超线性 ⇒ 二遍占 55%–83%，
  // 见 docs/2k-acceleration-variants-analysis.md §0）。首遍便宜、又是运动/构图/音轨的来源，
  // 动它只有风险没有收益（§1.6 变体 A）。这里的挂点正是那份文档推荐的：
  //   PDDAccApply(2a) ──→ RefineHandoff.model     （只喂精修）
  //   PDDAccScheduler(2c) ─→ RefineHandoff.sigmas （训练网格上的 tail）
  // 首遍 sampler（node 10）继续读 base 模型与 node 9 的 sigma，完全不动。
  //
  // `denoise = PASS2_DENOISE` ⇒ blocks = round(8×0.3) = 2 次评估，与「6 步 × denoise 0.3」
  // 是同一个形状；且因为落在**训练网格**上，`on_off_grid='error'`（fail-closed）不会误触发。
  //
  // 已知风险（必须实测、不能靠推理，见 §1.4）：
  //   ① 二遍入口状态 = **未蒸馏的 base 输出 + 学习式放大器的重建**，对 PDD 的蒸馏轨迹是域外；
  //      节点只守 σ 网格与 trunk 族，不守状态分布。
  //   ② 2 次评估没有迭代纠错 ⇒ 典型失效模式是**过冲 → 闪烁**。验收第一指标必须是闪烁，不是锐度。
  //   ③ 音频：`lock_audio=true` 把音频 mask 在二遍外，但 head bank 改的是同一个 model 对象，
  //      首遍音频仍可能受扰动 —— 不能假设音轨不受影响。
  if (spec.pddPass2) {
    g['2a'] = {
      class_type: 'MiniMaxH3PDDAccApply',
      inputs: {
        model: ['2', 0],          // 二遍的 base（已做 12/3 shift）；首遍不经过这里
        pdd_file: '$assets.pdd',
        nfe: '8',
        lora_strength: 1,
        head_strength: 1,
        on_off_grid: 'error',     // fail-closed：σ 不在训练块边界上直接报错，不静默降级
        partition: '',
        enabled: true,
        partition_check: 'error',
      },
    }
    g['2c'] = {
      class_type: 'MiniMaxH3PDDAccScheduler',
      inputs: { nfe: '8', denoise: PASS2_DENOISE },
    }
    // 只改精修这一步的两个入口；首遍（node 10 ← node 9）保持不动
    g['17'].inputs.model = ['2a', 0]
    g['17'].inputs.sigmas = ['2c', 0]
    m.requiresNodes = [...new Set([...m.requiresNodes, 'MiniMaxH3PDDAccApply', 'MiniMaxH3PDDAccScheduler'])]
  }
  // 3) 解码改读 17
  g['11b'] = { class_type: 'VAEDecode', inputs: { samples: ['17', 0], vae: ['4', 0] } }
  g['11c'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['17', 0], vae: ['4a', 0] } }
  // 4) ctx 图：CreateVideo 读的是 node 23（Trim）⇒ 把 23 重指到放大后的解码；node 12 不动
  g['23'].inputs.images = ['11b', 0]
  g['23'].inputs.audio = ['11c', 0]

  // 5) 二遍步数是结构参数（首遍的 steps 注入点由 base 自带，PDD 档首遍由 nfe 控制）
  m.params['steps2'] = { inject: 'scalar', to: { node: '9b', field: 'steps' }, default: PASS2_STEPS }

  writeFileSync(resolve(DIR, spec.out + '.json'), JSON.stringify(m, null, 2) + '\n', 'utf8')
  console.log(
    `✓ ${spec.out}.json（${spec.family} · ${spec.tier} 档 · 首遍不锁（长边 ${GW === FAST[0] ? 832 : 1344}）· 交付 = 首遍 ×${SCALE}：` +
    `16:9 ${GW}×${GH}→${out[0]}×${out[1]} · 9:16 ${GH}×${GW}→${out[1]}×${out[0]} · 1:1 ${GW}×${GW}→${out[0]}×${out[0]}，` +
    `二遍 denoise ${PASS2_DENOISE} / ${PASS2_STEPS} 步 · 链式续接保留）`
  )
}

if (failed) process.exit(1)
console.log('\n注意：模板是产物，改结构请改本脚本后重跑；生成 workflows/ 清单请再跑 make-h3-variants.mjs。')
