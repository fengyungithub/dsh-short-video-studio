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
// 链式续接家族（R3，见 docs/shot-chain-continuity.md）：**同能力**的第三组实现。
// 与其它组的区别只在于「上一镜从哪来」——它消费上一镜的服务端 latent，画面逐帧钉住上一镜结尾、
// 音频从接缝继续，专治同场景续接镜的跳变。跨场景/首镜请用普通组（未声明 chain 的实现）。
// priority 全为负 = **永不做隐式默认**：只有显式 workflow= 或带 continuity_from 的请求才会选到它，
// 免得默认档位悄悄把一个需要上一镜的实现当成普通参考生成。
const GROUP_REF2V_CTX = { id: 'minimax-h3-ref2v-ctx', displayName: 'MiniMax H3 参考视频·链式续接', capability: 'video.reference2video' }
// i2v 版链式续接（2026-09 补齐）：模板由普通的 i2v 模板 + r2v-ctx 的 Motion Context 节点派生
// （scripts/make-h3-ctx-templates.mjs）。首帧/末帧锚定与"继承上一镜尾部"因此可以同时用——
// 转场镜（首末帧双端锚定）与锚点式重渲（改中段）从此也能参与续接链，不再因"i2v 没有链式 latent"而断链。
const GROUP_I2V_CTX = { id: 'minimax-h3-i2v-ctx', displayName: 'MiniMax H3 首末帧·链式续接', capability: 'video.image2video' }
// 两阶段潜空间放大（2026 引入，方案 B）：**开源版 H3 原生上限就是 768p**（1344×768），
// 往更高尺寸直接采样会出复制/克隆伪影，所以「提分辨率」只能靠二遍：
// 首遍 896×512 解运动/构图/声音 → 视频 latent 放大 1.5× → 二遍低噪声（denoise 0.35）重建细节。
// 倍率与首遍尺寸写在模板的 resolutionLock + 图内 scale_by 上，**图分辨率被锁死**
// （显式 width/height 与画布比例都不生效，runner 会发警告如实说明）。
// priority 为负 = 不做隐式默认：它比普通 quality 贵，必须是用户显式选中的策略。
const GROUP_REF2V_HIRES = { id: 'minimax-h3-ref2v-hires', displayName: 'MiniMax H3 参考生成视频·两阶段放大', capability: 'video.reference2video' }
const GROUP_I2V_HIRES = { id: 'minimax-h3-i2v-hires', displayName: 'MiniMax H3 首末帧生成视频·两阶段放大', capability: 'video.image2video' }
// 学习式潜空间放大（>2K）：与 hires 的差别只在「用哪种放大器」——
// hires 是**插值**（保结构、不造细节，所以交付仍卡在原生 768p）；
// 这一族用**学习式 3D 放大器**（latent 空间真重建，×2），交付 2688×1536，超过模型原生上限。
// 首遍锁在原生 1344×768（不降分辨率：放大器要吃的就是一张干净的原生 latent）。
// priority 为负 = 不做隐式默认：它比普通 quality 贵得多，必须由用户显式选中。
const GROUP_REF2V_2K = { id: 'minimax-h3-ref2v-ctx-2k', displayName: 'MiniMax H3 参考视频·链式续接 + 学习式放大（>2K）', capability: 'video.reference2video' }
const GROUP_I2V_2K = { id: 'minimax-h3-i2v-ctx-2k', displayName: 'MiniMax H3 首末帧·链式续接 + 学习式放大（>2K）', capability: 'video.image2video' }
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
  // 链式续接（R3）：与上面同档同模型，只是把「上一镜」接进来。
  // estSeconds 口径同各档（多采样的 22 帧会被裁掉，实测与不带续接同档几乎同价：fast 实测 50.8s vs 50.1s）。
  { out: 'minimax-h3-ref2v-ctx-fast', group: GROUP_REF2V_CTX, tier: 'fast', priority: -100, template: 'minimax-h3-ref2v-ctx.json', mode: 'fast', estSeconds: 26, note: '链式续接 · 4 步 LoRA · 长边 832 · 实测接缝：画面 MAD 7.2（无续接对照 62.8）· 采样多 22 帧后裁掉' },
  { out: 'minimax-h3-ref2v-ctx-balanced', group: GROUP_REF2V_CTX, tier: 'balanced', priority: -100, template: 'minimax-h3-ref2v-8step-ctx.json', mode: 'balanced', estSeconds: 170, note: '链式续接 · 8 步 768p LoRA · shift 6/3 · euler · 采样多 22 帧后裁掉' },
  { out: 'minimax-h3-ref2v-ctx-balanced-pdd', group: GROUP_REF2V_CTX, tier: 'balanced', priority: -100, template: 'minimax-h3-pdd-ref2v-ctx.json', mode: 'balanced', estSeconds: 190, note: '链式续接 · PDD nfe=8 · 细节量高于 20 步成片档 · 采样多 22 帧后裁掉' },
  { out: 'minimax-h3-ref2v-ctx-quality', group: GROUP_REF2V_CTX, tier: 'quality', priority: -100, template: 'minimax-h3-ref2v-ctx.json', mode: 'quality', estSeconds: 400, note: '链式续接 · 20 步 · 采样多 22 帧后裁掉' },
  { out: 'minimax-h3-i2v-ctx-fast', group: GROUP_I2V_CTX, tier: 'fast', priority: -100, template: 'minimax-h3-i2v-ctx.json', mode: 'fast', estSeconds: 28, note: 'i2v 链式续接 · 4 步 LoRA · 长边 832 · 继承上一镜尾部（采样多 22 帧后裁掉）· 实测：首帧锚点被 head 取代、末帧锚点保留' },
  { out: 'minimax-h3-i2v-ctx-balanced', group: GROUP_I2V_CTX, tier: 'balanced', priority: -100, template: 'minimax-h3-i2v-8step-ctx.json', mode: 'balanced', estSeconds: 190, note: 'i2v 链式续接 · 8 步 fl2v 768p LoRA · 继承上一镜尾部 · 实测：首帧锚点被 head 取代、末帧锚点保留' },
  { out: 'minimax-h3-i2v-ctx-balanced-pdd', group: GROUP_I2V_CTX, tier: 'balanced', priority: -100, template: 'minimax-h3-pdd-i2v-ctx.json', mode: 'balanced', estSeconds: 195, note: 'i2v 链式续接 · PDD nfe=8 · 继承上一镜尾部 · 实测：首帧锚点被 head 取代、末帧锚点保留' },
  { out: 'minimax-h3-i2v-ctx-quality', group: GROUP_I2V_CTX, tier: 'quality', priority: -100, template: 'minimax-h3-i2v-ctx.json', mode: 'quality', estSeconds: 420, note: 'i2v 链式续接 · 20 步 · 继承上一镜尾部 · 实测：首帧锚点被 head 取代、末帧锚点保留' },
  // 注意：**不提供 ctx 的 Sol 变体**。2026-09-15 复现两次：Sol-Attn 在本环境（0.35.2 + cudaMallocAsync）下
  // 无论带不带续接都会让 ComfyUI 硬崩（CUDA_ERROR_INVALID_VALUE from cuMemFreeAsync → Fatal Python error: Aborted，
  // 容器整机重启，连别人的任务一起打掉）。模板 scripts/h3-templates/minimax-h3-pdd-ref2v-sol-ctx.json 保留备用，
  // 但**不生成清单**——详见 docs/minimax-h3-acceleration-lora.md §9.10。
  // 两阶段潜空间放大（方案 B）：estSeconds 未实测（结构与普通档不同：首遍 896×512 全步 + 二遍 1344×768 低噪声），
  // 先按待实测填，跑完对照后回填真实值。
  { out: 'minimax-h3-ref2v-hires', group: GROUP_REF2V_HIRES, tier: 'quality', priority: -50, template: 'minimax-h3-ref2v-hires.json', mode: 'quality', estSeconds: 480, note: '两阶段放大 · 首遍 896×512 20 步 → latent ×1.5 → 二遍 denoise 0.35 · 交付 1344×768 · 耗时待实测' },
  { out: 'minimax-h3-i2v-hires', group: GROUP_I2V_HIRES, tier: 'quality', priority: -50, template: 'minimax-h3-i2v-hires.json', mode: 'quality', estSeconds: 480, note: '两阶段放大 · 首遍 896×512 20 步 → latent ×1.5 → 二遍 denoise 0.35 · 交付 1344×768 · 耗时待实测' },
  // ── 学习式放大（>2K，U1）：由 **ctx 模板**派生，形状 × 档位 = 6 份 ─────────────────
  // 为什么基模板是 ctx 而不是普通模板：链式存档（node 22）读的是**首遍 latent**（node 10），
  // 放大发生在采样之后 ⇒ 链上流动的始终是首遍尺寸的 latent，两阶段放大与续接可以叠用。
  // 链的兼容性契约因此是「**一条链内首遍尺寸一致**」（= resolutionLock.graph），不是交付尺寸一致。
  // priority 全为负 = 永不做隐式默认（比同档普通实现贵得多，必须由用户显式选中/在设置页指定）。
  //
  // estSeconds：quality 档由非 ctx 基座真机实测回填（124 帧 1671.2s / 56 帧 269.3s），
  //   再按链式多采 22 帧（22/124 ≈ +17.7%）推算 ctx 版 ⇒ 约 1950s；fast / balanced-pdd 为推算值，
  //   待真机实测后回填（探针：scripts/probe-2k.mjs 传 workflow= 对应清单）。
  { out: 'minimax-h3-ref2v-ctx-quality-2k', group: GROUP_REF2V_2K, tier: 'quality', priority: -60, template: 'minimax-h3-ref2v-ctx-quality-2k.json', mode: 'quality', estSeconds: 2700, note: '链式续接 + 学习式 latent ×2 · 首遍 1344×768 20 步 → 学习式 3D 放大 → 二遍 denoise 0.3 · 交付 2688×1536 · **耗时推算，未实测**：锚点＝同管线非链式的 1671.2s@124 帧，链式多采后 158 采样帧、按二遍超线性（指数 1.6–2.3）外推 ⇒ 2700–3300s 区间' },
  { out: 'minimax-h3-ref2v-ctx-quality-pdd2-2k', group: GROUP_REF2V_2K, tier: 'quality', priority: -60, template: 'minimax-h3-ref2v-ctx-quality-pdd2-2k.json', mode: 'quality', estSeconds: 1800, note: '链式续接 + 学习式 latent ×2 · **PDD 只进二遍**（首遍 20 步与 quality-2k 逐字节相同）· 二遍 sigmas ← PDDAccScheduler(nfe=8, denoise 0.3) ⇒ 2 次评估替代 6 步 · 交付 2688×1536 · 与 quality-2k 只差二遍的 model/sigmas，是「二遍加速值不值」的干净对照（docs/2k-acceleration-variants-analysis.md §1.6 变体 A）· **耗时推算，未实测**' },
  { out: 'minimax-h3-i2v-ctx-quality-2k', group: GROUP_I2V_2K, tier: 'quality', priority: -60, template: 'minimax-h3-i2v-ctx-quality-2k.json', mode: 'quality', estSeconds: 2700, note: '链式续接 + 学习式 latent ×2 · 同 ref2v 结构（走 FL2VA 权重）· 交付 2688×1536 · **耗时推算，未实测**（沿用 ref2v 口径 2700–3300s）' },
  { out: 'minimax-h3-i2v-ctx-quality-pdd2-2k', group: GROUP_I2V_2K, tier: 'quality', priority: -60, template: 'minimax-h3-i2v-ctx-quality-pdd2-2k.json', mode: 'quality', estSeconds: 1800, note: '链式续接 + 学习式 latent ×2 · **PDD 只进二遍**（走 FL2VA 权重，与 i2v 的 quality-2k 只差二遍的 model/sigmas）· 交付 2688×1536 · **耗时推算，未实测**' },
  // ── 已弃用：PDD 接在**首遍**上，与设计文档 §1.6 变体 A（PDD 只进二遍）相反 ──────────────
  // 实测（56 帧 / 2688×1536，2026-09-23）：比无 PDD 版**更慢**（1462.3s vs 942.0s）、
  // 有效宽度无增益（1.00–1.11×，随 seed 波动）、**时域闪烁 +150%（两组 seed 都恶化）**。
  // 根因：2K 的开销与画质几乎全由二遍决定（docs/2k-acceleration-variants-analysis.md §0），
  // 而这里的 PDD 只改首遍，二遍与无 PDD 版**逐字节相同** ⇒ 不可能有收益，只留下闪烁代价。
  // 替代：`-ctx-quality-pdd2-2k`（PDD 真正接在二遍：二遍 3.06×、画质持平）。
  // 保留 internal 清单只为复现历史 A/B；**不要用于新镜头**。
  { out: 'minimax-h3-ref2v-ctx-balanced-pdd-2k', group: GROUP_REF2V_2K, tier: 'balanced', priority: -60, template: 'minimax-h3-ref2v-ctx-balanced-pdd-2k.json', mode: 'balanced', estSeconds: 1200, deprecated: 'PDD 接在首遍（设计文档推荐接二遍），实测更慢且闪烁 +150%；改用 minimax-h3-ref2v-ctx-quality-pdd2-2k。', note: '链式续接 + 学习式 latent ×2 · PDD 在**首遍**（nfe=8）· 交付 2688×1536' },
  { out: 'minimax-h3-ref2v-ctx-balanced-2k', group: GROUP_REF2V_2K, tier: 'balanced', priority: -60, template: 'minimax-h3-ref2v-ctx-balanced-2k.json', mode: 'balanced', estSeconds: 1200, note: '链式续接 + 学习式 latent ×2 · **首遍 8 步非 PDD**（balanced 档「不加速」的本来配方：普通 BasicScheduler 出 sigma）· 二遍 denoise 0.3 走普通 6 步 · 交付 2688×1536 · 与 balanced-pdd-2k **只差首遍要不要 PDD 加速**，是 A/B 的对照臂 · **耗时推算，未实测**' },
  { out: 'minimax-h3-i2v-ctx-balanced-pdd-2k', group: GROUP_I2V_2K, tier: 'balanced', priority: -60, template: 'minimax-h3-i2v-ctx-balanced-pdd-2k.json', mode: 'balanced', estSeconds: 1200, deprecated: 'PDD 接在首遍（设计文档推荐接二遍），实测更慢且闪烁 +150%；改用 minimax-h3-i2v-ctx-quality-pdd2-2k。', note: '链式续接 + 学习式 latent ×2 · PDD 在**首遍**（走 FL2VA 权重）· 交付 2688×1536' },
  { out: 'minimax-h3-i2v-ctx-balanced-2k', group: GROUP_I2V_2K, tier: 'balanced', priority: -60, template: 'minimax-h3-i2v-ctx-balanced-2k.json', mode: 'balanced', estSeconds: 1200, note: '链式续接 + 学习式 latent ×2 · 首遍 8 步非 PDD（走 FL2VA 权重）· 交付 2688×1536 · balanced-pdd-2k 的对照臂 · **耗时推算，未实测**' },
  { out: 'minimax-h3-ref2v-ctx-fast-2k', group: GROUP_REF2V_2K, tier: 'fast', priority: -60, template: 'minimax-h3-ref2v-ctx-fast-2k.json', mode: 'fast', estSeconds: 620, note: '链式续接 + 学习式 latent ×2 · 首遍 832×480 4 步 LoRA → 交付 **1664×960**（本族唯一的非 2688 交付，档内保留自己的首遍尺寸）· **实测锚点**：56 采样帧 114.0s（起链）/ 90 采样帧 246.3s（续接）⇒ 158 采样帧外推 ≈620s' },
  { out: 'minimax-h3-i2v-ctx-fast-2k', group: GROUP_I2V_2K, tier: 'fast', priority: -60, template: 'minimax-h3-i2v-ctx-fast-2k.json', mode: 'fast', estSeconds: 620, note: '链式续接 + 学习式 latent ×2 · 首遍 832×480 4 步 LoRA（走 FL2VA 权重）→ 交付 1664×960 · 实测锚点同上（56 帧 114.0s / 90 帧 246.3s）⇒ 158 帧 ≈620s' },
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
  // 两阶段实现：首遍是底片、二遍才出交付尺寸，把这件事写进 description，免得用户看到
  // 「清单说 896×512、产物却是 1344×768」以为出错。两种形态措辞不同（见 lib/manifest.js 的
  // resolutionLock 注释）：图锁定 = 首遍被钉死；只锁倍率 = 首遍照请求走、交付 = 首遍 × scale。
  if (m.resolutionLock && Array.isArray(m.resolutionLock.graph)) {
    const gl = m.resolutionLock.graph
    const sc = Number(m.resolutionLock.scale) || 1
    m.description += ` 两阶段：首遍 ${gl[0]}×${gl[1]}（图分辨率锁定，显式 width/height 不生效）→ 潜空间放大 ×${sc} → 交付约 ${Math.round(gl[0] * sc)}×${Math.round(gl[1] * sc)}。`
  } else if (m.resolutionLock && Number(m.resolutionLock.scale) > 1) {
    const sc = Number(m.resolutionLock.scale)
    const long = Number(modeCfg.longSide) || 1344
    const short = Math.round((long * 9) / 16)
    m.description += ` 两阶段：首遍尺寸**不锁**（按画布比例推导，本档长边 ${long}）→ 潜空间放大 ×${sc} → 交付 = 首遍 ×${sc}。` +
      `16:9 首遍 ${long}×${short} → 交付 ${long * sc}×${short * sc}；9:16 首遍 ${short}×${long} → 交付 ${short * sc}×${long * sc}；1:1 首遍 ${long}×${long} → 交付 ${long * sc}×${long * sc}（像素量为 16:9 的 ${(long / short).toFixed(2)}×，更重）。`
  }
  m.estSeconds = spec.estSeconds
  m.note = spec.note
  // 弃用退场：仍可显式 workflow= 调用（复现历史实验），但**不进档位解析、不出现在 UI/技能选项**。
  // 复用内部诊断清单那套 internal 机制（注册表按它过滤），并清掉 priority 免得被隐式选中。
  if (spec.deprecated) {
    m.internal = true
    delete m.priority
    m.displayName = `${m.displayName}（已弃用）`
    m.description = `**已弃用，不要用于新镜头**：${spec.deprecated} ` + m.description
    m.note = `**已弃用**：${spec.deprecated} ` + String(spec.note || '')
    return m
  }
  m.priority = Number.isFinite(spec.priority) ? spec.priority : 0
  // H3 的合法采样帧数网格：17k+5。声明后 runner 会把请求帧数向上取整到网格并**如实记录交付帧数**
  // （不声明时模型自己也会取整，但节点上的 length 会比产物少最多一个步长）。
  if (src.lengthGrid) m.lengthGrid = src.lengthGrid
  else delete m.lengthGrid
  // 只保留本档的 mode（名称即档位名）
  m.modes = { [spec.tier]: modeCfg }
  // 「只锁倍率」形态：交付尺寸随画布比例变，spec.note 里写的 16:9 数字只是其中一种口径。
  // 统一在这里追加比例说明，免得 10 条 note 各自漏写（1:1 的像素量与 estSeconds 误差必须显式提示）。
  // 尺寸走**真实推导**（computeManifestSize），不要手算 longSide*9/16——真实值还要过 snap32
  //（1344*9/16 = 756 → 768；832*9/16 = 468 → 480），手算会写出错误的数字。
  if (m.resolutionLock && !Array.isArray(m.resolutionLock.graph) && Number(m.resolutionLock.scale) > 1) {
    const sc = Number(m.resolutionLock.scale)
    const sz = (r) => { const s = _internals.computeManifestSize(m, spec.tier, undefined, undefined, r); return `${s.w}×${s.h}` }
    m.note = String(m.note || '') +
      ` · **首遍不锁**：交付 = 首遍 ×${sc}，随画布比例变（16:9 首遍 ${sz('16:9')}、9:16 首遍 ${sz('9:16')}），` +
      `上面写的交付尺寸是 16:9 口径。9:16 像素量与 16:9 相同（耗时同量级）；` +
      `**1:1 首遍 ${sz('1:1')}、交付 ${sz('1:1').replace(/(\d+)×(\d+)/, (_, a, b) => `${a * sc}×${b * sc}`)}、像素量 1.78×**` +
      `，estSeconds 未按比例修正；**1:1 显存余量小（实测峰值 ≈73/79 GiB），尽量压帧数**（高分辨率档的 1:1 未实测）`
  }
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
  // 编译一次：确保图能注入（宽度/高度/帧数/种子/提示词/步数）。
  // 首遍尺寸走**真实渲染同一条推导**（computeManifestSize）：图锁定形态会被钉回它声明的 graph，
  // 只锁倍率形态则按档位长边 + 16:9 推导（如 fast 832×480）——两种都要在这里如实编译，
  // 否则编译出来的图会带着调用方传的尺寸，把尺寸契约悄悄破坏。
  const [cw, ch] = (() => {
    const s = _internals.computeManifestSize(m, spec.tier, undefined, undefined, '16:9')
    return [s.w, s.h]
  })()
  try {
    buildGraphFromManifest(m, {
      prompt: 'smoke', width: cw, height: ch, length: 124, seed: 1,
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
      for (const m of list) {
        const lk = m.resolutionLock && Array.isArray(m.resolutionLock.graph) ? m.resolutionLock.graph : null
        const sc = Number(m.resolutionLock?.scale) || 1
        const g16 = _internals.computeManifestSize(m, tier, undefined, undefined, '16:9')
        const sizeBit = lk
          ? `首遍=${lk[0]}×${lk[1]} 交付=${Math.round(lk[0] * sc)}×${Math.round(lk[1] * sc)}（×${sc}）`
          : (sc > 1
            ? `首遍=${g16.w}×${g16.h}(16:9) 交付=首遍×${sc}=${g16.w * sc}×${g16.h * sc} · 支持 16:9/9:16/1:1`
            : `长边=${m.modes[tier].longSide ?? '-'}`)
        console.log(`    [${tier}] ${m.id}${m.accel ? ` · accel=${m.accel} requires=${m.requiresNodes.join(',')}` : ''} · ${m.estSeconds}s · 步数=${m.modes[tier].steps} ${sizeBit}`)
      }
    }
  }
}

if (DRY) { console.log('\n(--dry：未写盘)'); process.exit(0) }
for (const m of outputs) writeFileSync(join(OUT_DIR, m.id + '.json'), JSON.stringify(m, null, 2) + '\n', 'utf8')
console.log(`\n✓ 已写出 ${outputs.length} 份单档清单到 workflows/：` + outputs.map((m) => m.id).join(', '))
