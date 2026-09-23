# 学习式潜空间放大（>2K）：把 H3 成片推到 2688×1536

> 状态：**已实现**（清单 `minimax-h3-{ref2v,i2v}-ctx-{quality,quality-pdd2,balanced,fast}-2k`，**8 份在役**；`-ctx-balanced-pdd-2k` 一对已弃用退场）
> 尺寸：**首遍不锁**，交付 = 首遍 ×2 ⇒ 16:9 交付 2688×1536（`fast` 1664×960）、9:16 交付 1536×2688（`fast` 960×1664）、1:1 交付 2688×2688
> 契约：`resolutionLock` 的**只锁倍率**形态（`docs/tier-strategy-design.md` §3）· 提交流程见 `docs/workflow-contract.md`
> 相关：`docs/hires-two-pass-upscale.md`（插值版两阶段，图锁定形态）· `docs/minimax-h3-video-benchmark.md`（实测表）

## 0. 为什么需要它：hires 到不了 2K

`docs/hires-two-pass-upscale.md` 的 hires 档解决的是「**别在模型没见过的尺寸上采样**」，用的是内置
`MiniMaxH3AVLatentUpscaleBy`——它是**插值**放大（bislerp/bilinear）。插值只保结构、不造细节，所以
hires 只能把首遍的 896×512 **拉回**模型原生 1344×768，**交付分辨率仍然等于原生上限**。

要**超过**原生上限，放大器必须能「在 latent 空间凭空重建细节」。本机已装的学习式放大器提供了这一点：

| 件 | 位置 |
|---|---|
| 节点 | `MinimaxH3LatentUpscaler3DRefineHandoff`（`custom_nodes.Comfyui_Minimax_h3_latent_Upscaler`，分类 `video/MinimaxH3`） |
| 权重 | `models/latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` |
| 官方语义 | *"Learned LBH 3D upscale followed by low-sigma MiniMax H3 refinement … The LATENT output is final/decode-ready."* |

**不需要装任何东西**：节点与权重本机都在（`comfy_list_workflows` 的 `requiresNodes` 预检会告诉你缺没缺）。

## 1. 三条路线，以及为什么选 U1

| | 引擎 | 交付 | 时间一致性 | 代价 | 结论 |
|---|---|---|---|---|---|
| **U1** | 原生 1344×768 → **学习式 latent ×2** → 2688×1536 → 低 σ 精修 | **2688×1536** | 最好（3D 卷积有跨帧感受野 + H3 自己精修） | 精修在 500k token 上跑 | **已实现** |
| U2 | 原生出片 → 像素空间 RealESRGAN ×2/×4 | 2688×1536 / 5376×3072 | 一般（逐帧，会闪烁） | 便宜 | 未实现（`RealESRGAN_x2/x4`、`ESRGAN_4x` 权重本机已有，可作后备） |
| U3 | U1 → 再叠像素超分 | 3840×2160 起 | 混合 | 两级误差叠加 | 未实现 |

U1 的理由：**只有它让 H3 自己在目标分辨率上收尾**，所以运动/口型/时间稳定性与首遍一致；U2 是「H3 画完再去猜细节」，看不出运动。

## 2. 结构：图里多了什么

以 ref2v 为例，相对标准 quality 清单只多三块：

```
node 5  MiniMaxH3ReferenceToVideo（首遍条件 + 空 latent）
node 10 首遍采样（20 步 / denoise 1.0 / shift 12,3）   ← 首遍尺寸**按请求推导**（画布比例 × 档位长边）
   │
   ├─ node 6b  RandomNoise(seed = ${seed + 2000000})     ← 二遍必须是新噪声
   ├─ node 9b  BasicScheduler(steps 6, denoise 0.3)      ← 低 σ 精修，不重画表演
   └─ node 17  MinimaxH3LatentUpscaler3DRefineHandoff(
   │             latent=10, noise=6b, sampler=8, sigmas=9b, model=2, positive=5,
   │             model_name=$assets.latent_upscaler,
   │             mode="target dimensions",
   │             width="${width * 2}", height="${height * 2}",   ← 算术模板，跟着首遍走（任意比例）
   │             scale=2, align=32, keep_proportion=true, lock_audio=true, precision=bf16)
   │                └─ 学习式 ×2 放大 + 采样器 2 一次做完，输出 decode-ready latent
   └─ 11b VAEDecode / 11c VAEDecodeAudio → CreateVideo → SaveVideo
```

三处与 hires 的结构性差别：

1. **放大器换成学习式**，因此「放大」与「精修」由 RefineHandoff 一个节点完成；
   图里只有**一个** `SamplerCustomAdvanced`（首遍）——多一个就等于在 4× token 上白采样一遍。
2. **首遍尺寸照请求推导，不降分辨率**（长边 1344；`fast` 长边 832；而不是 hires 的 896×512）：
   这一档不靠首遍省钱，放大器要吃的就是一张模型最擅长的尺寸的干净 latent。
3. **音轨锁定方式不同**：hires 靠「插值节点不碰音频那一半」；这里靠 `lock_audio=true`
   （首遍音轨原样保留 + 把音频 mask 出精修）。两者结果一致：口型与对白沿用首遍。

## 3. 真机证据（A800，本环境实测）

**结构正确性**（`scripts/probe-2k.mjs`，56 帧 / 20 + 3 步）：

| 项 | 结果 |
|---|---|
| 交付分辨率 | **2688×1536**（MP4 容器 `vide` 轨实测） |
| 音轨 | `soun` 轨在（74 个音频样本 / 56 个视频样本） |
| 耗时 | **269.3s**（56 帧） |
| OOM | 无 |

**「多出来的是真细节还是插值？」** —— 这是必须回答的问题，因为把 1344×768 用 bicubic 拉大
在小图上看几乎一样。做法（`scripts/analyze-2k-detail.mjs`）：

- A/B 两次跑的**首遍逐像素相同**（同 seed、同步数、同首遍尺寸）⇒ 唯一变量就是「放大 + 精修」；
- 在 2K 的像素网格上，原生 1344×768 的成片**物理上最高只能含到 0.25 cycles/px**
  （它的 Nyquist 换算到 2× 网格），所以 **[0.25, 0.5] 这一带的能量就是「真·更高分辨率」的指纹**；
- 基线 = 把 native 用 bicubic 放大到 2K。

| 频带 (cyc/px) | ratio（真 2K / bicubic 基线） |
|---|---|
| 0.03–0.08 | **1.10** ← 对位正确（低频本就该一致） |
| 0.08–0.16 | 1.35 |
| 0.16–0.25 | 2.10 ← 基线自己在源 Nyquist 附近滚降，属正常 |
| **0.25–0.4** | **6.60** |
| **0.4–0.5** | **7.04** |

**0.25 以上 6.6–7.0×**，且逐帧 p25/p75 很窄（6.47–7.32）⇒ 不是噪声，是稳定存在的高频结构。

### 3.1 「交付 2688 宽」≠「细节等于 2K 渲染」——必须分清两层

上面的频带比值只说明「原生装不下的那一带有能量」，**没说明那一带能量有多少**。所以再补一个
尺度无关的**有效分辨率**测量（`analyze-2k-detail.mjs` 的 `--eff` 段，默认输出）：

- 尺子：径向平均功率谱（40 环），找**最高**的、功率仍 ≥ 峰值某比例的频率，按 Nyquist=0.5 cyc/px
  换算成等效像素宽度；
- **自校准**：拿「原生 bicubic 放大到 2K」当靶——它的信息上限**按构造就是原生宽度 1344**。
  在阈值网格里挑一档让基线读数正好落回 1344，再用同一档去读 2K。这样读数不依赖拍脑袋的阈值
  （粗网格会让读数漂 5%，必须用 geomspace 细分）。

| 片子 | 基线读数（靶=1344） | **真 2K 读数** |
|---|---|---|
| 124 帧（5.2s） | 1344 ✓ | **1949 px** |
| 56 帧（2.3s） | 1378（+2.5% 过冲） | **1882 px**（校正后 ≈1835） |

两条不同片长/内容独立收敛到 **≈1.9K 等效宽度**，所以：

- **文件/像素层：是。** MP4 容器实测 2688×1536（`vide` 轨），> DCI 2K(2048×1080)、> QHD(2560×1440)，
  按行话是 **2.7K 交付**。
- **信息量层：不是真 2K。** 有效细节约 **1.9K**，即比原生 1344 **多约 1.4× 线性（面积 ≈2×）** 的真细节，
  但**没到 2048**，更远没到 2688。
- 根本原因：H3 开源版不能原生出 768p 以上，任何 >768p 都是**生成式合成**，没有 ground truth 可比。
  「真 2K 渲染」在这条链路上不存在参照物；1.9K 已是本链路能给的最强结论。

**长片上顶部八度偏薄**（已知边界，非 bug）：0.4–0.5 cyc/px 增益 56 帧为 7.0×、124 帧降到 **1.7×**；
0.03–0.08 低频带偏离也从 1.10 涨到 1.35（精修改动更大）。**不是码率造成的**——用
`--crf 12` 强制高码率重编后，五条频带比值逐位相同（1.354/1.619/2.991/7.709/1.695），
说明默认编码已是高质量，差异来自精修在 ≈500k token 上的行为。

**没有学习式 ×2 的「硬网格」伪影**：`analyze-hires.mjs` 的 32px 谱线判据
（latent 上 2×2 周期 → 像素 32px 周期）在 56 帧给出 `grid32 = 1.93 / grid_ref = 3.15`（比值 0.61，干净）；
124 帧为 `5.95 / 3.57`（比值 **1.67**，超过警戒线）⇒ **长片需要人眼复核 32px 瓦片纹**，
这一项是筛选指标不是判决（未经学习式放大的原生成片本身也有 4.93/3.91）。

## 4. 契约：`resolutionLock` 的**第二种形态**——只锁倍率

首版把首遍**钉死**在 `resolutionLock.graph` 上（`constraints.aspectRatios: ['16:9']`），理由是
「放大倍率与首遍尺寸写死在图里，换比例会让『原生 → ×2』前提失效」。

**这个理由在改成算术模板之后不成立了**：图内 node 17 的目标尺寸从字面量 `2688×1536` 换成
`"${width * 2}"` / `"${height * 2}"`（`lib/manifest.js` 的 `evalTemplateArithmetic`，白名单
`[0-9+\-*/().\s]`），目标尺寸就跟着**本次请求的首遍尺寸**走，同一份图在任意比例下自动对上。
于是清单只需声明 `{ scale: 2 }`：

| 场景 | 行为 |
|---|---|
| 只声明 `scale`（本族） | 首遍**不锁**：`显式 width/height` → `画布 aspectRatio × 档位长边` → `resolution.default` |
| 图内目标尺寸 | 算术模板算出来的 = 首遍 × 2（**随比例变化**，不是字面量） |
| 交付尺寸 | `manifestDeliverySize()` = 首遍 × scale，**画布节点记的是交付尺寸** |
| 不静默 | 每次调用都带 warning，写明「首遍 WxH（按请求尺寸生效）→ 实际交付 2Wx2H」 |
| 支持比例 | `16:9` / `9:16` / `1:1`（**hires 族仍是图锁定形态，只支持 16:9**） |
| 无 `resolutionLock` | 行为完全不变（回归由 `smoke-hires-lock.mjs` §6/§8/§9 覆盖） |

### 4.1 各比例的实际尺寸（longSide 1344 / 832）

| 比例 | 首遍（longSide 1344） | 交付 | 首遍（fast, 832） | 交付 | 像素量 |
|---|---|---|---|---|---|
| 16:9 | 1344×768 | **2688×1536** | 832×480 | 1664×960 | 1.00× |
| 9:16 | 768×1344 | **1536×2688** | 480×832 | 960×1664 | 1.00×（同 16:9） |
| 1:1 | 1344×1344 | **2688×2688** | 832×832 | 1664×1664 | **1.78×**（最重） |

### 4.2 实机验证（`scripts/probe-2k-aspect.mjs`，A800 80GB，ref2v-ctx-fast-2k）

**产物尺寸从 mp4 box 直读**（不信工具自报），三项都做了硬校验：尺寸 == 推导交付、画幅 == 请求比例、音轨存在。

| 运行 | 首遍 | 交付（实测视频轨） | 耗时 | 峰值显存 | 结果 |
|---|---|---|---|---|---|
| 9:16 · 124 帧 | 480×832 | **960×1664** (avc1) + mp4a 2ch 32k | **638.5s** | — | ✅ |
| 1:1 · 22 帧 | 832×832 | **1664×1664** + mp4a | 50.8s | — | ✅ |
| 1:1 · 56 帧 | 832×832 | **1664×1664** + mp4a | — | 空闲最低 13.0 GiB | ✅ |
| 1:1 · 124 帧 | 832×832 | **1664×1664** + mp4a | **992.8s** | 空闲最低 **6.6 GiB**（占用 72.6/79.2） | ✅（一次通过，**另一次被中断**） |

结论与风险：

- **9:16 完全可用且没有额外代价**：像素量与 16:9 相同，实测 638.5s ≈ `fast` 档 `estSeconds` 620s 的口径。
- **1:1 可用，但显存余量很薄**：124 帧峰值 72.6/79.2 GiB（余量 6.6 GiB），**同样配置下有一次运行被中断**
  （ComfyUI 只回 `execution_interrupted`，无 traceback ⇒ 判为余量不足的偶发，不是参数/结构错误）。
  所以 1:1 请**尽量压帧数**，或在腾空的卡上跑。
- **耗时比预估长**：1:1 实测 992.8s vs `estSeconds` 620s（**1.6×**），与像素量 1.78× 吻合——
  `estSeconds` 是 16:9 口径，**未按比例修正**。
- ⚠️ **高分辨率档（quality/balanced）的 1:1 交付 2688×2688 = fast 的 2.6 倍像素，完全未实测**。
  要用先跑小帧数探针：`node scripts/probe-2k-aspect.mjs --workflow minimax-h3-ref2v-ctx-quality-2k --ratio 1:1 --frames 22`。

### 4.3 1:1 的帧数预算：`constraints.maxDurationFramesByRatio`

`maxDurationFrames` 是**单一数字、且只声明不强制**——它没法表达「同一实现在某些比例下余量更小」。
所以 2K 族按实测给 1:1 单独声明了一条（`constraints.maxDurationFramesByRatio: { "1:1": 56 }`，
**只对 `fast` 档声明，因为只有它实测过**）：

| 档 | `maxDurationFrames` | `maxDurationFramesByRatio` | 依据 |
|---|---|---|---|
| `fast`-2k | 124 | `{ "1:1": 56 }` | 1:1 实测 56 帧余量 13.0 GiB 从容；124 帧余量仅 6.6 GiB 且另有一次被中断 |
| `quality`/`balanced`-2k | 124 | **未声明** | 1:1 交付 2688×2688 = fast 的 2.6 倍像素，**完全未实测** ⇒ 宁缺勿假，不编数字 |

**「只声明不强制」是刻意的**：渲染路径不读这个字段，1:1 请求 124 帧不会被拦
（`maxDurationFrames` 本身同样只是声明）。它的用途是 UI 提示 / 文档 / 排障时能一眼看到「这个比例别跑太长」。
校验器只做**形状** fail-closed：比例键必须形如 `1:1`/`9:16`（写成 `square` 会被判非法，
否则拼错就静默失效）、值必须是正整数。

⚠️ **跨比例不能链式续接**：链上流动的是首遍 latent，续接判据是**首遍尺寸一致**（`chainGraphMismatch`）。
同一条链内保持同一比例即可（9:16 链 → 首遍恒为 768×1344 或 480×832）。

> 注：`--frames` 会按清单声明的 `lengthGrid`（H3 = 17k+5）向上取整；22 帧即网格最小的有效值。

## 5. 怎么用

```jsonc
// 显式选中实现（档位解析不会自动落到它：priority = -60）
comfy_render({ capability: "video.reference2video", workflow: "minimax-h3-ref2v-ctx-quality-2k", prompt: "..." })
```

或在配置页「新增策略」把它设成某 capability 的某档实现（UI 里显示为「学习式放大（>2K）」家族）。

### 可调参数

| 参数 | 位置 | 默认 | 说明 |
|---|---|---|---|
| 首遍步数 | `params.steps` → node 9 | 20 | 常规档位语义 |
| 二遍步数 | `params.steps2` → node 9b | 6 | 结构参数；精修步数 |
| 二遍噪声强度 | node 9b `denoise` | **0.3** | 已实测：无 32px 网格、细节增益 6.6×。过高会改人物/姿态 |
| 放大倍率 | 节点 `scale` / `width`/`height` + `resolutionLock.scale` | 2 | 三处必须一致（改结构请改 `scripts/make-2k-template.mjs` 后重跑） |
| 放大器权重 | 资产槽 `$assets.latent_upscaler` | `minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` | 可用 `DSH_SVS_H3_LATENT_UPSCALER` 或配置覆盖 |
| 二遍 seed | node 6b `${seed + 2000000}` | 首遍 seed + 2e6 | 必须与首遍不同，否则退化成重放首遍的高噪声步 |

## 6. 与其它增强的关系

| 增强 | 是否可叠 | 说明 |
|---|---|---|
| 链式续接（`continuity_from`） | **不可叠** | 续接要求同分辨率同档位（latent 不能缩放）；2k 是独立组、不声明 `chain` |
| Sol-Attn | 未提供 | 本环境 Sol + cudaMallocAsync 有硬崩记录（见 acceleration-lora §9.10），2k 不带 Sol 变体 |
| PDD 8 步 | 未提供 | 精修用的是标准 20 步模型 + 低噪声，不引入 PDD 第三方节点依赖 |
| 像素空间超分（U2/U3） | 可后接 | 见 §1，未实现

## 7. 失败与排障

| 症状 | 原因 | 处理 |
|---|---|---|
| 32px 周期瓦片纹 | 学习式 ×2 在 latent 上留了硬网格 | 抬高二遍 `denoise`（0.3 → 0.4）让精修抹掉它；或解码前做一次 norm-preserving 轻模糊。**先用 `analyze-hires.mjs` 的 `grid32`/`grid_ref` 判据确认**，别凭感觉 |
| OOM | 精修在 2688×1536（≈500k token）上采样，峰值显存由它决定 | 降帧数；或先 `POST /free {"unload_models":true,"free_memory":true}` |
| 交付尺寸被改小/比例不对 | 首遍随请求推导（本族**故意不锁**） | 交付 = 首遍 × 2，所以比例由画布/显式宽高决定。若结果不对，先看清单 warning 里写的「首遍 WxH」是否等于你以为的尺寸；hires 族才是图锁定（只 16:9） |
| 人物/姿态变了 | 二遍 denoise 过高 | 下调到 0.2–0.25；仍漂移则回到 standard quality 档 |
| 画面几乎没变化 | 精修步数过少 / denoise 过低 | 上调 `steps2` 到 8–10，或 denoise 到 0.4 |
| 提示缺节点 | 未装 `Comfyui_Minimax_h3_latent_Upscaler` | 可用性预检（`requiresNodes`）会在渲染前报错，不会假装可用 |

## 8. 验收

```bash
node scripts/make-2k-template.mjs         # 生成模板（产物，勿手改）
node scripts/make-h3-variants.mjs         # 生成 workflows/*.json 清单
node scripts/smoke-hires-lock.mjs         # 锁定语义 / 图结构 / 不静默 / 不隐式默认（331 断言，含 2k 段）
node scripts/smoke-tier-resolution.mjs    # 档位解析无回归
node scripts/verify-h3-variants.mjs       # 清单一致性无回归
node scripts/probe-2k.mjs --frames 56 --steps 20 --steps2 3 --denoise 0.3   # 真机接线探针
node scripts/analyze-2k-detail.mjs <native.mp4> <2k.mp4>                    # 「细节是真的吗」判据
```

`probe-2k.mjs` 还提供 `--variant native`（同 seed 只跑首遍）与 `--variant v1`
（`LTXVSeparateAVLatent` → 2D 放大器 → `LTXVConcatAVLatent` → 传统二遍）作为对照与后备接线。
