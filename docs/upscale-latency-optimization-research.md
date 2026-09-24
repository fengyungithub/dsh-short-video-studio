# 学习式放大为什么慢、能怎么快 —— 优化方案与备选放大器调研

> 状态：**调研（未做本机 A/B 实测）**。本文提出的每一项都标了「实测 / 推算 / 外部实测」三种口径，
> 并在 §6 给出落地顺序、预估 GPU 时间与验收判据；**任何一条在没有本仓库同 seed A/B 之前不要写进 README/技能**。
> 相关：`docs/learned-latent-upscale-2k.md`（U1 路线本体）· `docs/2k-acceleration-variants-analysis.md`（PDD 理论）·
> `docs/2k-pdd-ab-verdict.md`（PDD 实测）· `docs/video-upscale.md`（U3 路线与选型）·
> `docs/minimax-h3-acceleration-lora.md` §9（加速清单，本机注意力内核现状）

---

## 0. 结论速览

**先把问题问对**：跑得慢的**不是学习式放大器**，而是放大器之后那次「H3 在 4× token 上做的低 σ 精修」。
放大器本身是 12+12 块卷积、`attn=False` 的小网络，实测单块 **0.6–0.8 s**（≈1 MP，
[xmarre README](https://github.com/xmarre/Comfyui_Minimax_h3_latent_Upscaler-Plus)），且**不产生任何 H3 NFE**。
所以「自学习放大耗时」这个说法里，要优化的是**精修段**。

| # | 杠杆 | 预期收益 | 性质 | 风险 | 改动面 |
|---|---|---|---|---|---|
| **L0** | PDD 只进二遍（**已上线**） | 二遍 **3.06×** / 端到端 **1.66×** | 本仓库实测 | 无（闪烁未退化） | 已落地 |
| **L1** | **开 SageAttention**（`--use-sage-attention`） | Ampere 弱路径号称 **2.2× over SDPA**；外部同构 A/B **1.55×** | 外部实测 | 需 CUDA Toolkit（本机无 nvcc）；H3 部分层非 fp16/bf16 会回退 | 启动参数，**零 manifest 改动** |
| **L2** | 精修 NFE 再降：PDD `1 block`（denoise≈0.125）/ First Block Cache | 1 block：精修段再 **≈2×**；FBC Fast **1.44×**、Aggressive **1.55×** | 推算 + 外部实测（0.5 MP） | 细节量可能不足；FBC 会改生成轨迹（SSIM 0.69/0.62） | 清单参数 / 加节点 |
| **L3** | **精修分块**（LTX-2.5 的 span 纪律：每块回到原生 1344×768 内） | 空间 2×2 分块 **≈2.3×**（按本仓库标定的 α≈1.85 推算）；时间分窗在 124 帧上只有 **1.3–1.5×** | 推算（§3.1 有算式） | 接缝 / 大尺度结构退化；**需要新节点** | 新图 + 新节点 |
| **L4** | 混合：精修只做 1.5×，剩下的用 U3 收尾 | 精修 token 降到 **0.34×**（≈2.9× 省） | 推算 | 两级误差叠加 | 新图（U1 1.5× + `video_upscale`） |
| **L5** | 换架构：VDN-H3 线性注意力（α→1）/ 官方 2K Regenerate / Flow-Aligned 渐进 handoff | 渐进 handoff 外部实测 **1.25×**（≈1 MP）；VDN 无实测 | 外部实测 | 换模型=换分布；官方 2K 只能走 API | 大 |
| **L6** | **产品口径**：默认不用 U1 提分辨率 | 便宜 **10.7×** 且有效宽更高 | 本仓库实测 | 丢失「H3 自己在目标分辨率收尾」 | 文档/技能（零算力） |

一句话：**L1（开 Sage）是当下唯一「零图形改动、量级最大」的杠杆**（本仓库 `docs/minimax-h3-acceleration-lora.md` §9
也把它标为「当前最大剩余杠杆，仍未做」）；**L3 是唯一能改写成本结构的算法杠杆**，而且它同时是画质纪律；
**L6 是零成本的正确默认**。另有一节专题讨论「SeedVR2 这类扩散恢复模型能不能做成 `video.upscale` 的可选实现」
——结论是**能，但要先扩契约**，见 **§5.1**。

---

## 1. 先定位：时间到底花在哪

### 1.1 本仓库的实测分解（A800 / sm_80 / 2688×1536）

`docs/2k-pdd-ab-verdict.md` §4.1 的自洽分解（56 帧，单位秒）：

```
首遍 P1                    =  94.5s
二遍 base 每次评估 p2      =  48.67s     ← 6 次 = 292.0s
二遍 PDD  每次评估 p2'     =  50.25s     ← 2 次 = 100.5s
2K 解码+编码 D             =  28.8s
验算 base：94.5 + 6×48.67 + 28.8 = 415.3s（实测 414.4 / 416.1）
验算 PDD ：94.5 + 2×50.25 + 28.8 = 223.8s（实测 223.8，分毫不差）
```

交付长度（124 帧）端到端（同文档 §「交付长度」表）：

| 实现 | 124 帧端到端 | 口径 |
|---|---|---|
| `…-ctx-quality-2k`（二遍 6 步 base） | **2120.9s** | 编译清单直跑 |
| `…-ctx-quality-pdd2-2k`（二遍 PDD 2 次评估） | **1277.8s** | 首遍冷跑 ⇒ 对 PDD **偏保守** |
| 加速比 | **1.66×** | |
| 另有早期口径 `-balanced-pdd` 族 | 1671.2s → 826.0s = **2.02×** | 手改图 / 非 ctx 基座 |

清单里的 `estSeconds` 也按此填：`quality-2k` **2700** / `quality-pdd2-2k` **1800** / `balanced-2k` **1200** / `fast-2k` **620**。

**注意那 28.8s 的 D**：它包含 2K 的 VAE 解码与编码，而**学习式放大器本身的开销小到把分解式配平了**
（xmarre 在 ~1 MP 上实测：私有网格 0.6–0.8 s/块、两块合计 **1.37s**，且 **0 额外 H3 NFE**）。
⇒ 「放大」几乎免费，「放大后重采样」才是全部成本。

### 1.2 独立复现（外部，非本机）

[Chaosyn：MiniMax H3 High-Resolution Upscaling](https://blog.chaosyn.com/en/posts/minimax-h3-high-resolution-upscaling/)
（RTX 5090 32GB / 73 帧 / 参考图 r2v / 二遍 15 步 denoise 0.4）：

| 配置 | 交付 | 总耗时 | 采样耗时 | 峰值显存 |
|---|---|---|---|---|
| 原生 int8 8 步 | 1344×768 | 145.8s | 123.4s | 31.3 GB |
| 两阶段 1.5× | 2016×1152 | 649s | 604s | 29.5 GB |
| 两阶段 2.0× | **2688×1536** | **1302s** | **1255s** | 30.8 GB |
| 两阶段 1.5×，首遍换 Turbo+Sage | 2016×1152 | **345s** | — | — |
| 两阶段 2.0×，首遍换 Turbo | 2688×1536 | **OOM 未完成** | — | — |

其结论原话：**「High-resolution sampling accounted for 93% to 96% of the full two-pass sampling time.
Shortening only the first pass does not remove the principal cost of the 2K path.」**

这替本仓库说清了一件事：**只优化首遍（换 Turbo / 换档）在 2K 上没有意义**，因为首遍只占 4–7%。
本仓库其实早就把结论写在了 `docs/2k-acceleration-variants-analysis.md` §0（「加速只有加在 pass 2 上才有意义」），
外部数据独立印证了它。

### 1.3 成本结构的关键指数 α：本仓库数据反解 ≈ 1.85

`docs/2k-pdd-ab-verdict.md` §4.4 从 56 → 124 帧的实测反解出：**帧数涨 2.21×，二遍每次评估涨价 4.34×**。

```
α = ln(4.34) / ln(2.21) ≈ 1.85
```

即 H3 的每次前向在 2K 这个长度区间**既不是纯带宽受限（α=1）也不是纯 FLOP 受限（α=2）**，而是介于两者。
**这个 α 是后文所有「分块能省多少」的唯一依据**——它决定了分块是白干还是真赚：

> 把一段长度 S 的序列切成 n 块（每块 S/n），单次前向成本 ∝ S^α ⇒ 总成本比 = n·(1/n)^α = n^(1−α)。
> α=1.85 时，**4 块 ⇒ 0.108×4 = 0.43（省 2.3×）**；α=1 时 4 块恰好持平（还会因重叠变贵）。

⚠️ α 是从**两个实测点 + 一条线性假设（fD=2.21）**外推出来的，不是直接扫出来的。§6 的 E3 要顺手把它扫实。

---

## 2. 杠杆 L1/L2：不动图结构的部分

### 2.1 L1 SageAttention —— 最划算的一步，但仍未做

- 本仓库现状（`docs/minimax-h3-acceleration-lora.md` §9.3 / §9.5）：**采样占单镜耗时 63%（480p）～94%（768p）**，
  而**注意力面完全没动**（既没开 Sage，也没上稀疏/缓存）；该文档把「开 Sage」列为 **P0，且标注仍未做**。
- 未做的**真实原因**不是不确定，而是**该测试机没有 nvcc**（Sage 需 CUDA Toolkit 编译）。
  ⇒ 这是一个**环境前提**，不是技术判断；把工具链备齐就能开。
- 收益量级：SageAttention 官方口径 ~2×；Ampere（sm_80）走**弱路径**（INT8 QK + FP16 PV + FP32 累加，
  Sage2++ 的 fp8 累加器 gated 到 sm89+）实测仍 **2.2–2.3× over SDPA**；
  外部同构 A/B（FirstBlockCache 的对照臂，0.5 MP / 124 帧 / 20 步）：
  **native attention 90.6s(warm) → SageAttention 58.4s(warm) ≈ 1.55×**。
- 为什么在 2K 上更值得期待：注意力开销随 S 超线性，而 2K 的 S≈125k 是 768p（≈37.8k）的 3.3×。
- 风险与边界：
  1. 与 Sol-Attn / `flex_attention` **互斥**（同一次 attention 调用只能选一个）；
  2. **Sol-Attn 在本容器上会崩**（`cudaMallocAsync` 下 `cuMemFreeAsync → CUDA_ERROR_INVALID_VALUE`，
     已复现两次、拖垮整台共享服务，见 §9.10）——所以走 Sage 这条路**不要**顺手开 Sol；
  3. H3 部分层若非 fp16/bf16 会回退，需看控制台回退日志；
  4. 音频分支是否受影响要单独验（同 seed 比 PCM md5）。
- 改动面：**启动参数**（或 KJNodes 的 `Patch Sage Attention KJ` 插在 loader 与 guider 之间），**零 manifest 改动**。
  验收：同 seed「关/开」两跑，比画面与音轨；读控制台确认没有大面积回退。

### 2.2 L2 精修 NFE 再往下压

PDD 把二遍从 6 次评估压到 2 次（`nfe=8, denoise=0.3 → round(8×0.3)=2` block）。**网格上还有更低的档**：

| denoise | blocks | 入口 σ | 相对现状 |
|---|---|---|---|
| 0.3（现状） | 2 | 0.8000 | 基准 |
| **0.125** | **1** | **0.6316** | **精修段再省一半 NFE** |
| 0.375 | 3 | 0.8780 | 更贵 |

`docs/2k-pdd-ab-verdict.md` §7 已经把这一档点名「**值得单独看**——入口 σ 0.6316 更接近『只补细节』，
可能进一步降本，但也可能细节量不足」。这是**一行参数就能跑的 A/B，应该最先做**。

另两个通用 NFE 削减件（都在 H3 生态里现成）：

- **First Block Cache**（[duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache](https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache)）：
  0.5 MP / 124 帧 / 20 步实测 —— Safe 46.4s（1.25×）、**Fast 40.3s（1.44×）**、Aggressive 37.3s（1.55×），
  对照无缓存 58.0s；且**在 native 与 Sage 两种后端上增益一致（1.49× / 1.44×）**⇒ 不是 Sage 的副产物，可叠。
  代价：Fast 相对无缓存的 SSIM 0.687 / PSNR 22.09 dB（Aggressive 0.616 / 19.48）——**改的是生成轨迹**，
  对「二遍的活就是定细节」这件事是直接风险，**必须把闪烁与有效宽当第一判据**。
- **Spectrum**（[xmarre/ComfyUI-Spectrum-MiniMax-H3](https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3)，预测式跳步）：
  在 Flow-Aligned 的遥测里表现为 38 logical / 28 actual / 10 forecast（省 ~26% 实际前向）。
  但社区反馈有分歧（[Comfy-Org 讨论](https://huggingface.co/Comfy-Org/MiniMax-H3/discussions/26)：
  「用 Spectrum 反而慢了一倍」）。**列为待自查，不作为推荐项。**

### 2.3 已被证伪/不要做的方向（省得重走）

- **只优化首遍**：2K 上首遍占 4–7%（§1.2），换 Turbo 也救不了 2.0× 那一格（外部实测直接 OOM）。
- **Sol-Attn 上 2K**：本容器分配器下必崩，且收益/风险不对称（`docs/2k-acceleration-variants-analysis.md` §2）。
- **把 PDD 接在首遍**：已实测更慢（1462.3s vs 942.0s）+ 闪烁 +150%，该清单已 `internal: true` 退场。
- **给 2K 叠第 3 个蒸馏 LoRA / step-caching 与 PDD 同用**：PDD 明确不能与其它蒸馏叠加。

---

## 3. 杠杆 L3/L4：改写成本结构的部分

### 3.1 L3 精修分块：LTX-2.5 的核心纪律，也是最大的一笔

按 §1.3 的 α≈1.85：

| 分块方式 | 块构成 | 成本比 | 加速 |
|---|---|---|---|
| 现状（整段） | 1 × 124 帧 @ 2688×1536（S≈125k） | 1.00 | — |
| **空间 2×2** | 4 × 124 帧 @ 1344×768（S≈37.8k） | 4 × 0.302^1.85 = **0.43** | **≈2.3×** |
| 空间 2×2 + 15% 重叠 | 同上，块变大 | ≈0.55 | ≈1.8× |
| 时间 3 窗（56 帧 + 22 重叠） | 3 × 56 帧 @ 2688×1536 | ≈0.69 | ≈1.45× |
| 时间 2 窗（73 帧 + 22 重叠） | 2 × 73 帧 @ 2688×1536 | ≈0.75 | ≈1.33× |
| **1.5× 精修 + U3 收尾**（L4） | 1 × 124 帧 @ 2016×1152（S≈70k） | 0.56^1.85 = **0.34** | ≈2.9× |

读法：
1. **空间分块是数量级更大的一档**（2.3× vs 1.45×），因为它同时砍掉两个轴；
2. 时间分窗在**124 帧这种短片长上收益有限**（重叠占比太高），它是**长片/成片级素材**的工具；
3. L4 的「先 1.5× 再像素收尾」是**唯一既省精修又不引入接缝**的方案——它把几何代价转移给逐帧 CNN（U3）。

**为什么空间分块同时是画质纪律**：H3 开源版的原生上限是 768p（1344×768 ≈ 1.03 MP），
而我们在 2688×1536（4.1 MP，线性 2×）上做低 σ 精修——**每一步都在训练分布之外**。
切成 1344×768 的块，每一块都回到模型真正见过的尺寸上（LTX-2.5 正是这么做的，见 §4）。
它把「更大的画布」换成「更多次在分布内的重采样」，这正是 `mold` 那篇 PR 的标题：
**reach 1440p and 4K by composing, not by denoising bigger**。

**风险与前置条件（必须先量再上）**：
- **接缝**：块边界缺少跨块注意力 ⇒ **大尺度结构退化**（LTX 自己写得很直白：*「a finished video with degraded
  large-scale structure, which is precisely what nobody notices is wrong」*）。缓解：只在**低 σ 的 stage 2** 分块
  （大结构已由首遍钉住）+ 重叠 + 梯形窗；每块位置归一化、独立噪声 seed+tile_index。
- **音频**：分块只精修视频，音轨原样穿过（LTX 的做法与 `lock_audio=true` 语义一致）。
- **本仓库的链式续接不受影响**：链上流动的是**首遍 latent**（`node 22` 存的是 `node 10`），
  精修分块发生在它之后 ⇒ 与续接正交（这一点与 U1 现有的设计一致，不是新结论）。
- **节点缺口**：H3 侧**没有**等价于 LTX 的分块精修节点。现有生态里最接近的是 LBH/PDD 的
  **窗口化精修采样**（`MMH3SplitUpscale` + `MMH3TemporalSplitParams`，见
  [PDD 的 `pdd_video_upscale_long.json`](https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc)：
  「73-frame windows with 22-frame overlap and anchor frames — 70s clip refines in ~25 cheap windows
  instead of one quadratic-cost 500k-token pass」），**但那是时间窗，不是空间块**。
  空间分块需要自己写节点（或在 LBH 的 3D 节点上加 tile 模式）。

> ⚠️ 一条重要的反向证据：xmarre Plus fork **明确拒绝**了 LBH 上游的「16 帧时间分块 + kernel//2 重叠」，
> 理由是 3D 网络的 Conv3d 感受野与 **GroupNorm 的跨维度统计**会让分块**数值不等价**（会引入块边界差异）。
> 这条**只针对放大器本身**（groupnorm 统计），**不针对采样器的 σ 分段**——
> 但同理，空间分块采样器也会改变「同一块看到多少上下文」，所以**必须用解码后的片子判决，不能用结构指标**。

### 3.2 L4 混合路线：1.5× 精修 + U3 收尾

本仓库已有的两个事实拼起来就成立：

- U1 的 2K（2688×1536）实测有效宽 **1915（×1.425）**，耗时 **1671–2121s**；
- U3（原生 → ×2 → 2688×1536）实测有效宽 **2218（×1.65）**，耗时 **155.7s**，平坦区闪烁比 0.958（不过关不了）。

也就是说：**在同一个交付格子里，U3 既更便宜、读数还更高**（`docs/video-upscale.md` §6.1 的结论）。
那么「1.5× 精修 + U3 收尾」的动机是：**用 U1 补出 1.5× 这一档的生成式细节（S≈70k，成本 0.34×），
再用 U3 补到 2688**——既不像纯 U1 那样在 125k 上烧 6 次评估，也不像纯 U3 那样完全没有生成式重建。
**代价**：两级误差叠加，且 U3 的 upsample 会削掉一部分合成高频（§4.3 已实测：5376→4032 会从 2352 掉到 2268）。
**这是本文里最便宜的一个可做实验**：不需要新节点，只需要一张 1.5× 的 2K-2x 变体图 + 一次 `video_upscale`。

### 3.3 L5 换架构：三个外部方案

| 方案 | 机制 | 实测 | 备注 |
|---|---|---|---|
| **Flow-Aligned 渐进 handoff**（[xmarre](https://github.com/xmarre/MiniMax-H3-Flow-Aligned-Regenerate)） | 「早期 H3 步在**小网格**上做，在**同一段采样调度内**切到目标网格」，交接点用学习式 3D 转移（零额外 NFE） | ~1 MP：两阶段 7+6 步 **777s** → 渐进 10 步 **621.63s = ≈1.25×**，且最终像素 **+3.7%**；学习式转移只花 1.37s | 直接命中「二遍太贵」；但只有 ~1 MP 的证据，**2.7K 未验**；官方也标注「不要当成普适 20%」 |
| **VDN-H3 线性注意力**（[OpenVDN](https://github.com/OpenVDN/vdn-minimax-h3)） | 用常数代价的线性注意力分支替换二次长程注意力 ⇒ **成本随长度线性**（α→1） | 无本机实测 | α=1.85→1 会让「分块」的收益消失（分块只在 α>1 时赚），但**整体**可能更快；属换模型，分布风险大 |
| **官方 2K Regenerate**（[API](https://platform.minimax.io/docs/api-reference/video-generation-v2-regeneration)） | 不开源的 `H3-Regenerate-2K` 模块 | 不在本地 | 只接受符合 H3-768P 规格的源片（**必须有音轨**、24fps、两边 /32、面积 589,824–1,032,192、107–362 帧且步进 17），且**必须重发当时真正送进模型的输入**（含 H3-Context-IR 之后的最终 prompt）；resolution 仅支持 `2K` |

**降级方案**：如果本地 2K 始终太贵，`fast-2k`（1664×960，`estSeconds=620`）是现成的中间档；
再往上的 4K 直接走 U3（原生→×4→4032，**241.3s**）。

---

## 4. LTX-2.5 到底做了什么，哪些能借

调研对象：[mold 的 LTX-2 composed 4K PR](https://github.com/utensils/mold/commit/b89a8c2a3caef6c29f84af6ccc652dc5fb8f6029)、
[vllm.cpp 的 temporal upsampler spec](https://github.com/mudler/vllm.cpp/blob/main/.agents/specs/ltx25-temporal-upsampler.md)、
[KreativeSuite 的 LTX 2.5 节点](https://github.com/formulake/KreativeSuite)、
以及 H3 侧的对标实现（LBH/xmarre 放大器的致谢里写明其架构**借鉴了 LTX 2.3 spatial upscaler**）。

### 4.1 它的结构

```
目标尺寸（如 3840×2112）
   └─ stage 1：在**一半**尺寸上完整去噪（1920×1056）
        └─ 学习式 LatentUpsampler ×2（Conv + PixelShuffle，latent 空间）
             └─ stage 2：**分块精修**（4K 时 2×2 四块，每块回到 2048px 的 span 内）
                  └─ VAE 解码（解码本身也要按 tile 做，否则 4K 会 OOM）
```

三个细节值得逐字抄下来：

1. **span 纪律**：单遍去噪的轴上限 2048px 不是「显存限制」，而是**checkpoint 把 RoPE 像素位置按 2048 归一化**
   ⇒ 更长的边**在训练分布之外**。分块精修的意义就是「让每一块都回到 span 内」。合成上限因此**恰好是 span 的 2×**
   （stage 1 是半尺寸），**不是留了余量**。
2. **分块只在 stage 2**：位置按块重新归零、每块噪声 `seed + tile_index`、用**可分离梯形窗**拼回；
   **分块的 stage 2 只精修视频，stage 1 的音频原样穿过**（对应我们的 `lock_audio=true`）。
   `--spatial-tile off` 在超 span 时是**报错**而不是警告——因为他们踩过「出一段大尺度结构悄悄坏掉的成片」。
3. **输出梯子按 /64 对齐**：因为 stage 1 是「目标 ÷ 2」，必须落在 VAE 的 /32 latent 网格上
   （H3 的 VAE 是 16×、patch 2×2，我们的 `align=32` 已经是等价约束）。

### 4.2 它的实测（RTX 4090 24GB / LTX-2 19B fp8 / 25 帧）

| 输出 | 结果 | 总耗时 | 峰值显存 |
|---|---|---|---|
| 1920×1088（对照） | 渲染成功 | 372s | 18.4 GB |
| 2560×1408（1440p，2 块） | 渲染成功 | **299s** | 18.1 GB |
| 3840×2176（默认分块） | **VAE 解码 OOM** | 478s | 22.8 GB |
| 3840×2176 `--spatial-tile 768` | 生成成功，H.264 导出失败 | 488s | 18.2 GB |
| **3840×2112**（4K UHD 梯级，`--spatial-tile 768`） | **渲染成功** | **474s** | 18.2 GB |

两条可直接借用的读数：
- **峰值显存几乎不随分辨率涨**（1080p→4K：18.4 → 18.2 GB），因为每一块都在 span 内；
- **真正放不下的是 VAE 解码，不是扩散**（4K 默认 1280px tile 在 `vae_decode` 阶段 OOM，日志点名了 phase 与数值）。
  ⇒ 我们 4K 级交付时，**解码/tile 与「生成后如何落地」要和采样一样当一等公民**（U3 的分块机制已经在做这件事）。

### 4.3 哪些能借、哪些不能

**能借（本文的 L3/L4 就是这么来的）**
- ✅ **span 纪律 + 分块 stage 2**：H3 的 2K 精修正处在 span 之外，这是**收益与画质同向**的一招；
- ✅ **梯形窗 + 每块独立噪声 + 位置归零**的具体工程细节；
- ✅ **音频原样穿过**（我们已有 `lock_audio=true`，语义一致）；
- ✅ **「/64 对齐」式的算术前置**：分块尺寸必须同时满足 lcm(用户 align, VAE 16)，否则尺寸会静默漂；
- ✅ **「解码也可能 OOM」的意识**：`docs/video-upscale.md` §5 的像素-帧预算（`PIXEL_FRAME_WARN/CHUNK`）是同类机制。

**不能借**
- ❌ **权重不可互换**：LTX 2.5 的 `ltx-2.5-latent-spatial-upscaler-x2-bf16` 作用在 **LTX 的 latent 空间**，
  H3 是 **24 通道 video latent + 32 通道 audio latent 的 `NestedTensor`**（`[B,24,T,H/16,W/16]` 与 `[B,32,2,T_a]`，
  见 [Chaosyn 的剖析](https://blog.chaosyn.com/en/posts/minimax-h3-high-resolution-upscaling/)），
  **不是同一种东西**，不存在「拿 LTX 的放大器放大 H3」这回事。能借的是**方法与几何**。
- ❌ **DFR 的 temporal x2**：那是**掉帧率**（latent 时间轴 ×2、首帧丢弃、`2F−1`），
  与「提空间分辨率省时间」不是一回事；对我们只有「24→48fps 交付」这种产品价值。
- ❌ **多轮 DFR 循环**：LTX 的 `temporal_upsample_rounds ∈ {0,1,2}` 是那条流水线特有的，H3 没有对应物。
- ❌ **把 4K 的 474s 当我们的预期**：那是 25 帧、19B、24GB 单卡的数字，我们 124 帧、更高 token 量。

**一句话**：**H3 的学习式放大本来就站在 LTX 的路线上**（放大器架构取自 LTX 2.3 spatial upscaler），
我们缺的不是模型，而是**「分块 + span 纪律 + 解码也要分块」这三件工程**。

---

## 5. 备选放大器横评（「有没有别的放大方案」）

| 方案 | 类型 | 跨帧先验 | 实测耗时 | 交付 | 集成成本 | 判断 |
|---|---|---|---|---|---|---|
| **U3 `video-upscale-x2/x4`**（已内置，RealESRGAN） | 像素空间逐帧 CNN | ❌ 逐帧独立 | 124 帧 → 2688：**155.7s**；→ 4032：**241.3s** | 2688 / 4032 | **零**（已在注册表） | **默认手段**；有效宽 ×1.65、闪烁比 0.958 |
| **H3 学习式 latent 放大器 ×2**（已内置，U3 的对照） | latent 空间 3D 卷积 | ✅（3D + H3 自精修） | 放大器本身 **~秒级**；**成本在精修**（1671–2121s） | 2688 | **零**（已在役） | 只在「要与链式续接叠用 / latent 还要再采样」时用 |
| **FlashVSR**（[ComfyUI-FlashVSR](https://github.com/1038lab/ComfyUI-FlashVSR)，block-sparse 因果注意力 + 流式） | 扩散式 SR（1 步/流式） | ✅ | **56s / 124 帧 / 2×（1664×960）/ 12GB 卡**（[H3 项目指南](https://github.com/juemin4-source/minimax-h3-guide/blob/main/docs/upscale.md)）；开 sage 再 −20~30% | 任意 2×/4× | 中：需 `block_sparse_attn` wheel + 5 个权重 | **最值得试的第三方**：「保真克制」型，时序一致、细节自然 |
| **SeedVR2 3B**（[ComfyUI 原生支持](https://docs.comfy.org/zh/tutorials/utility/seedvr2)，无需任何自定义节点） | 一步扩散恢复 | ✅ | **已实测**：同源同交付（124 帧 · 1344×768 → 2688×1536）**483.4s**，同格 U3 x2 只要 **69.0s ⇒ 7.0×**；官方仓库侧另有「细节重塑更强但慢」的一致说法 | 我们图里**直接把交付尺寸喂模型**（`ImageScale`）⇒ `target_width` 真驱动 | 低（节点与权重本机都已就位） | **已接入**：`video-upscale-seedvr2-3b`（`priority=-20` 不做隐式默认，`chunking="internal"`） |
| **RTX VSR (nvvfx)** | 驱动级 | ❌ | 12GB 卡上多帧 **OOM/CUDA 崩溃** | — | 低 | ❌ 弃用（同页实测） |
| **官方 H3-Regenerate-2K** | 闭源重生成 | ✅ | 云端 | **2K** | 需 API key + 重发原始输入 | 本地算力不够时的兜底；不是「放大器」 |
| **其它 H3 latent upscaler 实现** | latent 空间学习式 | ✅ | 未测 | — | 低（**资产槽可换**） | LBH 上游 / xmarre Plus / Tr1dae / Mamad8 至少四家；2D 档比 3D 档轻 |

**注意最后一行的杠杆**：本仓库的放大器走 `$assets.latent_upscaler` 资产槽（`DSH_SVS_H3_LATENT_UPSCALER` 可覆盖），
所以「换一个更轻的放大器」是**零图纸改动**的实验——但因为放大器本身只占秒级（§1.1），
**换放大器省不到时间**，它的价值只在质量/时序（2D vs 3D）。

> 一句话口径：**「别的放大方案」里，能立刻把 2K 交付从 20 分钟压到 1–3 分钟的只有逐帧 CNN（U3）与
> FlashVSR 这类轻量扩散 SR**；它们买的是「分辨率」，不是「H3 在目标分辨率上重新收尾的那点真实感」。

### 5.1 专题：SeedVR2 该不该做成 `video.upscale` 的一个可选实现？

> **状态（2026-09-24）：方案 A 已落地**——契约扩成 `upscale.sizing`（`factor` / `short-side`）× `upscale.chunking`
> （`caller` / `internal`）两个维度，规划器与分块决策都有单测（`node scripts/smoke-upscale.mjs`，175 项）。
> **SeedVR2 清单本身仍未加入**：节点是否装在 GPU 主机上、短边注入后模型是否真按该尺寸渲染，
> 都要真机验收（`scripts/e2e-upscale.mjs` 加一臂）——在那之前不给它标 `estSeconds`，也不写进 README/技能。
> 下面 §5.1.1–§5.1.4 保留为**决策记录**（当时写下的冲突分析），落地口径见 §5.1.5。

**结论：用户视角该是（同一个 `video_upscale`、同一个画布语义），但契约上不能只是「再加一份 `video-upscale-seedvr2.json`」。**
`upscale` 原本是一个**只描述固定倍率**的声明，而 SeedVR2 的尺寸是**目标短边驱动的**——直接照抄会静默给出错的交付尺寸。

#### 5.1.1 吻合的部分（这些支持「属于 `video.upscale`」）

| 现有契约要求 | SeedVR2 实际行为 | 判定 |
|---|---|---|
| 输入是**画布上已有的视频**（不是提示词） | 节点输入是 `IMAGE` batch（由 `GetVideoComponents` 给），**不吃 prompt** | ✅ |
| 产物是视频、写回画布、记 `width/height/length/fps` + `upscaleFrom` | 输出 `IMAGE` batch，`CreateVideo(images, fps, audio)` 由我们的图补 | ✅ |
| **音轨原样带回** | 节点完全不碰音频（只吃/吐帧）⇒ 沿用现有 `2.1 → CreateVideo.audio` 直连 | ✅ |
| 可作为「同一能力的多实现」被注册表解析 | 正是 `priority` / `tier` / `workflow=` 的用途 | ✅ |
| 不重画内容 | ❌ 它是**单步扩散恢复模型**（3B/7B），会**重塑细节**（这也是它的卖点） | ⚠️ 工具描述要改口径 |

#### 5.1.2 冲突的部分（这些决定「不能只加一份 json」）

**① `upscale.factor` 是必填的固定数，而 SeedVR2 没有「倍率」这个属性。**
`lib/manifest.js` 的校验是 fail-closed 的（下面是**扩展前**的原状）：

```
if (!Number.isFinite(u.factor) || u.factor <= 0) fail('upscale.factor 必须是正数（交付尺寸 = 源尺寸 × factor）')
if (m.capability === 'video.upscale') { if (m.upscale === undefined) fail(...必须声明 upscale.factor...) }
```

而 SeedVR2 的尺寸语义是 **`resolution` = 目标短边像素（默认 1080）+ `max_resolution` 上限（0=不限）**，
倍率是**推导出来的**。例：源 1344×768、`resolution=1080` ⇒ 短边 768→1080 = **1.40625×**（宽 1890），
**根本不是 2×**。写死 `factor: 2` 时，`naturalWidth/naturalHeight/factor` 三个溯源字段会**如实记错**，
而画布正是靠 `width/height` 判断拼接一致性。

**② `planUpscale()` 的 `natural = src × factor` 是整个 runner 的尺寸中枢。**
`lib/index.js` 的 `runUpscale` 用它推：交付尺寸 → 像素-帧总量 → 分块阈值 → `target_width` 收敛 →
「目标宽度超过模型能力」的 warning。SeedVR2 下这条中枢要换成「目标短边 → 交付尺寸」。

**③ 分块归属反了。** `lib/upscale.js` 开头的注释把分块安全的**理由**写得很清楚：
「图里没有任何采样器/时间维操作，逐帧独立 ⇒ 任意切点都安全」。SeedVR2 **有跨帧时间先验**：
`batch_size` 必须是 **4n+1**、`temporal_overlap`（0–16 帧 Hann 混合）、`prepend_frames`，
显存由它自己的 **VAE tiling / BlockSwap / offload_device** 管。
外层再按像素-帧预算切一刀 = 在它的时间窗上再加一道**无混合硬切** ⇒ 接缝闪烁，
而且像素-帧预算对它的显存峰值几乎没有解释力（它的显存由 DiT/VAE 常驻决定）。
（幸运的是现有阈值 3.0e9 在分镜级很少触发：124 帧 × 4032×2304 = 1.15e9，不切。）

**④ 资产槽的粒度不同。** 现在 `$assets.upscale_x2` 是「一个同倍率权重」；
SeedVR2 需要 **DiT 模型 + VAE 模型（+ 可选 torch.compile 配置）** 一整套，
且 3B/7B × fp16/fp8/GGUF 是**不同的显存档**（8GB 也能跑，但走 BlockSwap + Q8_0）。

**⑤ `estSeconds` 的标定方式不同。** 现在是「线性 s/帧」（5.4K 2.2–2.6 s/帧）；
SeedVR2 是扩散模型，官方明说 **VAE 常是瓶颈**，且首次跑有 `torch.compile` 编译成本（20–40% DiT / 15–25% VAE 加速）。
按帧线性外推会系统性偏乐观。

#### 5.1.3 三条可选路线

**方案 A（推荐）：把 `upscale` 从「固定倍率」扩成「尺寸来源 + 分块归属」两个维度。**

```jsonc
"upscale": {
  "sizing": "short-side",   // 新增：'factor'（缺省，向后兼容现有两清单）| 'short-side' | 'caller'
  "factor": 2,              // sizing='factor' 时必填（现有语义不变）
  "shortSide": 1080,        // sizing='short-side' 时用；maxEdge 可选（0=不限）
  "maxEdge": 0,
  "align": 32,              // 交付尺寸仍对齐到 32（保持画布既有约定）
  "chunking": "internal",   // 新增：'caller'（缺省，逐帧 CNN）| 'internal'（模型自己管显存）
  "note": "…"
}
```

- 校验器加两条 fail-closed 规则：`sizing='factor' ⇒ factor 必填`；`sizing='short-side' ⇒ shortSide 必填`。
- `planUpscale` 加一条分支（`natural` 由短边推导），`delivery/warning` 语义不变 ⇒ **runner 主体与画布节点零改动**。
- `chunking='internal'` ⇒ runner 跳过像素-帧预算分块，只发一条 warning 说明「显存交给实现自己管（batch_size/tiling/BlockSwap）从外面看不见」。
- 兼容性：现有 `video-upscale-x2/x4` 不加 `sizing` 即默认 `factor`，**91 断言的 smoke 不用改**。

**方案 B：新开能力 `video.restore`。** 语义最干净（恢复 ≠ 超分），但要动 `CAPABILITIES`、工具表、
档位解析、设置页与技能文案；而用户视角上「我就是要放大」不该被拆成两个工具。**不推荐**——
除非将来真的出现「去噪 / 划痕修复 / 上色」这类**非放大目标**，那时再拆才有信息量。

**方案 C：硬套 `factor: 2` 出一份清单。** 最省事，但交付尺寸随源片短边漂移，
且 `factor/naturalWidth` 会记错、拼接一致性判据跟着错。
**勉强成立的前提**是清单里写死「本实现只接 1344×768 源片」并让 runner fail-closed——那还不如直接做 A。

#### 5.1.4 若走方案 A，落地时要一并处理的几件事

1. **输出对齐**：SeedVR2 是「任意 2 的倍数」，比 32 更自由 ⇒ 在它的图里后接一个 `ImageScale`（照抄
   `video-upscale-x2.json` 的 `node 5`，`upscale_method: area`）收敛到 32 对齐，**保住「画布上的交付尺寸一定 32 对齐」这条约定**。
2. **档位与优先级**：它是**扩散恢复**，比 RealESRGAN 贵得多但细节强 ⇒ `priority` 低于 x2（不做隐式默认），
   或放 `quality` 档作显式可选；`tier` 词汇只有 fast/balanced/quality，映射到 quality 是合理的。
3. **工具描述要改口径**：`video_upscale` 现在写的是「逐帧 CNN、**不经过模型**、不重画内容」——
   对 SeedVR2 不成立。要么由清单出 `note` 驱动描述，要么把工具描述改成中性（「对画布上已有的视频提分辨率 / 恢复」）。
4. **`requiresNodes` 三件**：两个 loader（DiT / VAE）+ 主节点；模型首次使用会自动从 HF 下载（部署方要能出网）。
5. **一条顺手的交叉收益**：SeedVR2 自带 `attention_mode = sageattn_2/sageattn_3` 与 `torch.compile` 开关——
   §2.1 那个「本机无 nvcc 所以 Sage 没开」的限制，在 SeedVR2 这条路上**由它自己的 wheel 解决**，不需要和 ComfyUI 主进程的启动参数较劲。
6. **验收**：`scripts/smoke-upscale.mjs` 加 `sizing` 分支用例；`scripts/e2e-upscale.mjs` 加一臂，
   断言「交付尺寸按短边推导 + 32 对齐 + 帧数守恒 + 音轨在」，并且**用 §6 的判据表**（有效宽 / 闪烁 / 32px 网格 / 1:1 眼判）
   与 U3 同源片对比——不要在没跑之前就把「SeedVR2 细节更强」写进文档。

**一句结论**：SeedVR2 应该出现在 `comfy_list_workflows` 的 `video.upscale` 清单里（用户只该看到一个工具），
但它的接入**不是**「复制一份 x2 的 json 改类名」，而是**给 `upscale` 声明补上「尺寸来源」与「分块归属」两个维度**——
否则 runner 的尺寸中枢会静默给出错误的交付尺寸，而这正是这套契约最在意的那类错。

#### 5.1.5 落地结果（方案 A，2026-09-24）

```jsonc
"upscale": {
  "sizing": "factor" | "short-side",   // 缺省 factor（向后兼容：不写这两个字段的旧清单行为不变）
  "factor": 2,                          // sizing="factor" 必填（正数）
  "shortSide": 1080,                    // sizing="short-side" 必填（目标短边，正整数）
  "maxEdge": 0,                         // 可选：实现自己的长边上限（0=不限），超出时如实预测 + 告警
  "align": 32,                          // 交付尺寸对齐（缺省 32）
  "chunking": "caller" | "internal",    // 缺省 caller
  "note": "…"
}
```

落地的四条硬约束（都在 `lib/manifest.js` 里 fail-closed，写错会被拒而不是静默忽略）：

1. `sizing='short-side'` ⇒ **必须**声明 `params.out_short_side`（把解析出的短边注入实现）；
2. `sizing='short-side'` ⇒ **不得**声明 `factor`（倍率是推导的，写死会与实际交付不符）；
3. `sizing` / `chunking` 写错 ⇒ 判非法（拼错被静默忽略 = 交付尺寸与预期不符，正是这套契约最怕的错）；
4. `capability=video.upscale` 仍然**不得**声明 `resolutionLock`。

与提案的两点差异（都是有意的）：

* **`sizing='caller'` 没有实现。** 它要求给 `video_upscale` 加 `width/height` 参数，而当前**没有任何实现需要它**——
  「调用方要一个尺寸」这件事两种形态已经各自覆盖：`factor` 形态是事后收敛（并告警「只是插值」），
  `short-side` 形态是**反解短边回注**（`target_width` 变成让模型按目标渲染）。等真出现只能吃精确 W/H 的实现再加，
  不留没有消费者的死路径。
* **分块决策被提成了纯函数** `planUpscaleChunks()`（`lib/upscale.js`），而不是写在 runner 里——
  这样「caller 按预算切 / internal 不自动切 / 显式 chunk_frames 仍照办但告警」三条都能 GPU-free 单测。

配套改动：`lib/upscale.js` 的 `planUpscale` 支持两种尺寸来源、`lib/index.js` 的 `runUpscale` 注入 `out_short_side`
并把标题/画布 params 按形态如实记录（短边形态下 `factor` 记 `null`，不编一个数出来）、
`scripts/make-upscale-manifests.mjs` 显式生成 `sizing`/`chunking`（让用户在 `workflows/*.json` 里直接读到契约）、
`schemas/workflow-manifest.schema.json` 补 `upscale` 定义、`docs/video-upscale.md` 新增 §2.1 契约节、
`package.json` 的 `npm run smoke` 把 `smoke-upscale.mjs`（与 `smoke-hires-lock.mjs`）纳入 CI 门；
新增 `scripts/e2e-upscale-shortside.mjs` + 夹具，以及 `DSH_SVS_USER_WORKFLOWS` 测试接缝（清单装临时目录）。

**真机验收（2026-09-24，A800 / ComfyUI 0.35.2）**：factor 形态回归全绿（2688×1536 → 4032×2304，124 帧，266.8s）；
短边形态用 `scripts/fixtures/upscale-shortside-probe.json`（几何探针，`internal: true`）三臂真机跑通
（默认短边 → 1088×1888；`target_width=1504` → 反解短边 1504 → 1504×2592；`internal` + 显式 `chunk_frames=60` → 3 块、124 帧守恒）。

**这次真机顺带抓到一个产品级缺陷（已修）**：`sliceUpscaleGraph` 原来只在 `ImageUpscaleWithModel` 这个**类名**上切刀口，
所以契约一放开（异质实现）就**静默**接不上切口——每块仍吃整片，拼回去 **372 帧 = 124×3**。
现在改成**按引用**通用接线（任何吃 `[2,0]` 的输入都改到切口上）+ **接不上就抛错**；
并在 `chunking='caller'` 的契约里写明「必须保持 1 LoadVideo → 2 GetVideoComponents 这条头」。
这正是「只有单测的契约容易漏真机行为」的一个实例。

**仍未做**：FlashVSR 接入（E5）、以及本文 §6 的 E0–E4（PDD 1-block / Sage / FBC / 精修分块 / 1.5× 混合）。

> ⚠️ **勘误（同日两小时后的真机复核）**：上段曾断言「SeedVR2 主放大器节点缺失、需装 numz 的第三方包」——**这是错的**。
> SeedVR2 已在 **ComfyUI 原生支持**（[PR #14424](https://github.com/Comfy-Org/ComfyUI/pull/14424)，
> 官方文档 <https://docs.comfy.org/zh/tutorials/utility/seedvr2>），主链路用的**就是核心节点**：
> `UNETLoader` + `SeedVR2Preprocess` + `VAEEncodeTiled` + `SeedVR2Conditioning` + `KSampler` + `SeedVR2TemporalChunk/Merge`
> + `VAEDecodeTiled` + `SeedVR2PostProcessing`。当时按第三方包的类名（`SeedVR2VideoUpscaler` 等）去查，
> 所以看不到主节点——**查错了类名，不是缺节点**。
> 真机复核结果：本机 **14/14 个所需节点齐备**，且**权重也已就位**
> （`UNETLoader` 列表里有 `seedvr2_3b_int8_convrot.safetensors`，`VAELoader` 列表里有 `seedvr2_ema_vae_fp16.safetensors`）。
> 结论：**零安装成本**，可以立刻接入。

**接入的尺寸语义（据官方视频模板实测图）**：原生图先把输入重采样到目标尺寸，再让 SeedVR2 在**该尺寸上做
restoration**（`KSampler` 一步、`denoise=1`）。音频同样由 `GetVideoComponents → CreateVideo` 直连、不进模型
（与我们 U3 的图同构）。

#### B 的落地结果：**不需要新增 `out_scale`**

原方案 B 是「让 runner 额外注入 `out_scale = 交付宽/源宽`，好让 `target_width` 真正驱动模型」。
落地时发现**现有注入已经够用且更准**：runner 注入的 `out_width/out_height` 就是**精确交付尺寸**（已按 32 对齐），
图里用 `ImageScale(width=out_width, height=out_height, lanczos)` 直接喂模型即可——
而倍率是个**有损的中间表示**（`4032/2688 = 1.5` 再乘回去还要取整）。所以：
**目标驱动的意图用 `out_width/out_height` 实现，契约面零新增**（`out_scale` 留给将来「只吃倍率的实现」再补，5 行的事）。
SeedVR2 的 `sizing` 因此仍声明 `factor: 2`——它的含义退化为「默认倍率」，因为 SeedVR2 接受任意交付尺寸。

**真机验收（2026-09-24，A800）**：`video-upscale-seedvr2-3b` 在 56 帧（1344×768 → 2688×1536）**115.3s** 全绿；
124 帧同口径 **483.4s**，同格 U3 x2 **69.0s（7.0×）**。
画质（同一把自校准尺子）：有效宽 **2654（×1.975）** > U3 的 2218（×1.65），1:1 眼判也确实更实；
**但平坦区锐度 311（输入 4.6×，与 4032 那格被判过锐的 362 同档）+ 平坦区闪烁比 1.045（U3 是 0.958）**
⇒ 是「细节更多但会注入颗粒」的一档。眼判图：`e2e-out/seedvr2/compare-3arms-1to1.png`。

---

## 6. 建议的落地顺序（按「每 GPU 分钟买到多少信息」排）

前提：本机 ComfyUI 目前在隧道另一端、**当前不可达**（`ssh -L 8188:localhost:8188 <gpu-host>` 未挂），
所以下面全部是**待跑**，不是已跑。

| # | 实验 | 改动 | 预估 GPU 时间 | 判据（顺序不能换） |
|---|---|---|---|---|
| **E0** | 精修贡献基线：`steps2=1`（PDD 1 block）+ 一个 `steps2=0`（只放大不精修，LBH 文档称输出是 decode-ready） | 清单参数（PDD 变体）/ 临时图 | 每臂 56 帧 ×2 ≈ 25 min | ① 有效宽（`analyze-2k-detail.mjs --eff`）② 时序闪烁（`analyze-hires.mjs`）③ 32px 网格谱线 |
| **E1** | **开 Sage**（同 seed 关/开两跑） | 启动参数，零图改动 | 2 × ~20 min | 控制台回退日志；同 seed 画面 + **音轨 PCM md5** |
| **E2** | First Block Cache Safe/Fast 两档 | 加节点 | 3 × ~20 min | 闪烁**不得高于** base；有效宽不得下滑；Fast 的 SSIM/PSNR 只作轨迹距离记录 |
| **E3** | 空间分块精修（先 2×2 无重叠做可行性，再加 15% 重叠） | **新节点**（或在 LBH 3D 节点加 tile 模式） | 每臂 ~20 min + 开发 | ① **解码后的片子人眼判决**（接缝/大尺度结构）② 实测本次 α（顺带把 §1.3 的外推坐实）③ 与不分块同 seed 的有效宽/闪烁差 |
| **E4** | 1.5× 精修 + U3 收尾 | 一张 1.5× 变体图 + `video_upscale` | ~10 min 精修 + 3 min 超分 | 与纯 2K U1 同网格比有效宽（比不过就说明这条混合线不值得） |
| **E5** | FlashVSR 接入（作为 `video.upscale` 的第 3 个实现） | 新清单 + 新权重 + wheel | 环境为主 | 与 U3 同源片同尺寸比：有效宽、闪烁比、耗时、1:1 裁切眼判 |

判据与工具**全部复用现有脚本**，不要新造：
`scripts/analyze-2k-detail.mjs`（有效宽 + 频带）、`scripts/analyze-hires.mjs`（闪烁/锐度/32px 网格）、
`scripts/analyze-2k-pair.py`（同尺寸两臂，无需原生基线）、`scripts/eye-crops.py`（1:1 人眼裁切）、
`scripts/compare-crops.py`；A/B 骨架照抄 `scripts/ab-2k-pass2-pdd.mjs`（**利用首遍缓存分离出纯二遍时间**）。

契约改动只在 E3/E5 出现：
- E3 若做成新实现 → 新清单（`resolutionLock.scale` 形态不变，但要新增 tile 参数面），
  并且**要么声明「不支持链式续接」，要么证明精修分块发生在 `MiniMaxH3MotionContextSaveLatent` 之后**（预计成立）；
- E5 → 新清单必须声明尺寸来源（`upscale.sizing` + `factor`/`shortSide`）且**不得**带 `resolutionLock`；
  短边形态还要留 `params.out_short_side` 注入点，并按 §5.1.5 声明分块归属（`lib/manifest.js` 的 fail-closed 校验）。

---

## 7. 诚实边界

1. **本文没有任何本机实测**：ComfyUI 隧道当前不在，所有「预期收益」都标了推算或外部来源。
   一旦开跑，**外部数字只能当量级参考**（别人的卡、别人的分辨率、别人的步数）。
2. **α≈1.85 是外推值**：来自 `docs/2k-pdd-ab-verdict.md` 的两个实测点 + 一条 `fD` 线性假设。
   分块收益对 α 极度敏感（α=1 时分块是白干，α=2 时 2×2 分块能到 2.7×）⇒ **E3 必须先扫 α**。
3. **分块的接缝是真实的、且是「看不出来」的那一类**（大尺度结构悄悄坏掉）。LTX 因此把 `--spatial-tile off`
   做成报错；我们至少要把「分块」和「不分块」的同 seed 对照留档。
4. **PDD 与其它加速件的互斥关系没变**：PDD 不能叠蒸馏 LoRA / step-caching；FBC、Spectrum 与 PDD 的相互作用**未知**。
5. **跨比例/竖版没覆盖**：本仓库 2K 族支持任意比例，但 §1 的所有实测都是 16:9；
   1:1 的显存余量本来就薄（`fast` 档 124 帧峰值 72.6/79.2 GiB）。
6. **U3 类方案的「高频」不是真细节**：RealESRGAN 系是照片/CG 通用权重，对 3D 动画的平坦色块有过锐风险
   （4032 那格平坦区锐度 362 vs 输入 68，已有过锐嫌疑）⇒ 尺子会奖励高频，**眼判优先**。
7. **外部方案的可用性随时会变**：FlashVSR 依赖 `block_sparse_attn` wheel，Spectrum 有「反而更慢」的社区报告，
   VDN 需要专门节点。本文只对「本仓库自带的两条路线（U1/U3）」给出确定性结论。

---

## 8. 参考

**本仓库**：`docs/learned-latent-upscale-2k.md` · `docs/2k-acceleration-variants-analysis.md` · `docs/2k-pdd-ab-verdict.md` ·
`docs/video-upscale.md` · `docs/minimax-h3-acceleration-lora.md`（§9 加速账本）· `lib/upscale.js`（分块纯逻辑）

**LTX-2.5 / 分块与 span 纪律**
- mold：*reach 1440p and 4K by composing, not by denoising bigger* — <https://github.com/utensils/mold/commit/b89a8c2a3caef6c29f84af6ccc652dc5fb8f6029>
- vllm.cpp：LTX-2.5 temporal x2 latent upsampler spec — <https://github.com/mudler/vllm.cpp/blob/main/.agents/specs/ltx25-temporal-upsampler.md>
- KreativeSuite（LTX 2.5 放大 + H3 refine 节点与权重清单）— <https://github.com/formulake/KreativeSuite>
- SGLang LTX2.5 cookbook — <https://docs.sglang.io/cookbook/diffusion/LTX/LTX2.5>

**H3 侧放大器 / 精修 / 加速**
- LBH 学习式放大器（本仓库在用）与 xmarre Plus fork — <https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler> · <https://github.com/xmarre/Comfyui_Minimax_h3_latent_Upscaler-Plus>
- PDD 加速节点 + 长片窗口化精修示例（本机克隆在 `~/ComfyUI-MiniMax-H3-PDD-Acc`）— <https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc>
- Flow-Aligned Regenerate（渐进 handoff / 学习式转移 / 性能账本）— <https://github.com/xmarre/MiniMax-H3-Flow-Aligned-Regenerate>
- H3 Continuum（分块采样、native AV latent 连续）— <https://github.com/xmarre/ComfyUI-H3-Continuum-Plus>
- First Block Cache 基准 — <https://github.com/duckyshell/ComfyUI-MiniMaxH3-FirstBlockCache>
- Spectrum 预测式跳步 — <https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3>
- VDN-H3（线性注意力分支）— <https://github.com/OpenVDN/vdn-minimax-h3>
- awesome-minimax-H3（生态索引：Turbo LoRA / 量化 / 节点包）— <https://github.com/wildminder/awesome-minimax-H3>

**第三方放大器与官方路径**
- FlashVSR / SeedVR2 / RTX VSR 的 H3 侧对比实测 — <https://github.com/juemin4-source/minimax-h3-guide/blob/main/docs/upscale.md>
- Chaosyn：H3 高分辨率放大（joint AV latent 的坑、5090 实测）— <https://blog.chaosyn.com/en/posts/minimax-h3-high-resolution-upscaling/>
- 官方 2K Regenerate API（`H3-Regenerate-2K`，未开源）— <https://platform.minimax.io/docs/api-reference/video-generation-v2-regeneration>
- ComfyUI 官方视频放大教程 — <https://docs.comfy.org/tutorials/utility/video-upscale>
