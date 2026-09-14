# MiniMax H3 加速方案研究报告（面向 dsh-short-video-studio）

> **⚠️ 历史记录（保留原文 id）**：本报告的 `minimax-h3-ref2v` → 拆分后的 `minimax-h3-ref2v-fast` / `minimax-h3-ref2v-quality`，`minimax-h3-ref2v-8step` → `minimax-h3-ref2v-balanced`，`minimax-h3-ref2v-sol` → `minimax-h3-ref2v-quality-sol`，`minimax-h3-ref2v-8step-sol` → `minimax-h3-ref2v-balanced-sol`，`minimax-h3-i2v` → `minimax-h3-i2v-fast` / `minimax-h3-i2v-quality`，`minimax-h3-i2v-sol` → `minimax-h3-i2v-quality-sol`（**P2 拆分，图形等价**：同一张图，只是「一个 json = 一个档位」）。`minimax-h3-ref2v-sol-stats` 仍存在（`internal: true` 诊断清单，不参与档位解析、不进 UI）。文中 `mode=` 现为 `tier=` 的兼容别名；`priority: -100` 已不再是加速实现的标注方式（改为同档 `-sol` 清单 + 策略投影，缺第三方节点时置灰而非静默回退）。档位契约见 [`docs/tier-strategy-design.md`](tier-strategy-design.md)。

> 调研时间：2026-09
> 调研对象：ComfyUI 上 MiniMax H3（FL2VA / Ref2VA 双变体、音视频联合生成）的加速 LoRA 及配套加速手段
> 落点：本插件的 `video.reference2video` / `video.image2video` 两条内置 H3 工作流（拆分后为 `workflows/minimax-h3-ref2v-*.json` / `minimax-h3-i2v-*.json`，模板在 `scripts/h3-templates/`）该选什么、怎么换
> 资料来源：HF 模型卡与文件清单（`Comfy-Org/MiniMax-H3`、`lightx2v/Minimax-h3-Turbo`、`lightx2v/Minimax-h3-Turbo-SLA`、`alibaba-pai/Minimax-H3-Acc-LoRAs`、`Kijai/MiniMax-H3-experimental`）、Cloud/ComfyUI 官方文档、ModelTC 官方仓库、第三方 benchmark 与社区源码（链接见文末）

---

## 0. 结论摘要（先看这段）

**一句话**：本项目当前 fast 档的组合（`ref2v_turbo_4step_v0.1` + shift 12/3 + 832×480）是**自洽且正确**的基线，不要盲动；真正值得做的是 ①把 **int8_convrot VAE** 换上（白捡解码加速）、②按硬件把 **注意力内核**升级（Ampere（sm_80）上走 Sage / Sol-Attn-Ampère，而不是 SLA/FP8）、③在**明确配对 shift 与分辨率**的前提下，给 ref2v 增开一个 8 步"平衡档"，④单独评估 i2v 的 `ref2va base + ref2v LoRA` 跨型错配。

| 决策点 | 建议 | 理由 |
|---|---|---|
| fast 档 LoRA（ref2v） | **保持** `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16`（shift 12/3） | 4 步、544p 训练域与 832×480 匹配、shift 与训练一致，实测 ~3.4× 加速 |
| 成片档（quality） | **继续不挂 LoRA**，20 步纯 base（可选提到 25 步） | 4 步蒸馏在运动/音频上明确降质；成片不该用 4 步 |
| 新增"平衡档"（可选） | **采用 lightx2v `ref2v_turbo_8step_v1.0_768p`（shift 6/3 + 分辨率上 768p）**；~~Alibaba PDD Acc-8Step~~ 当时判为不可用（§9.4），**2026-09-09 晚已复测推翻 → PDD 可用且已落地为独立策略，见 §9.9** | 8 步是官方 Studio 的可用配置；实测 175.8s/镜 vs 成片档 396.6s/镜（省 55.7%，2.25×）。**PDD 8 步 184.7s/镜即可达到成片档以上细节量（§9.9）** |
| i2v 路径 | **二选一**：保守（不动 base，fast 档沿用现有 LoRA）/ 正确（新增 fl2va pruned base + fl2v 系 LoRA，flush shift 6/3） | 现在 i2v 用 `ref2va` base 跑 `MiniMaxH3ImageToVideo`，属跨变体组合，拿不到 fl2v 系（v1.1/v1.2）的迭代红利 |
| 明确不采用 | SLA 版 LoRA、w4a8、FP8 权重、t8star int8-convrot 变体、larryvrh 系 | SLA 依赖 sage2 稀疏算子；单卡 Ampere（sm_80）无 FP8 硬件；后两者需专用 loader/采样器节点 |
| 非 LoRA 加速优先级 | P0 int8_convrot VAE ✅已落地 → P1 Sol-Attn(Ampère) ✅**已实测：768p 1.23–1.33×，480p 1.03×**（§9.8） → P2 Sage Attention / First Block Cache → P3 TE-Speed / VDN | 该测试机无 nvcc，Sage 需 CUDA Toolkit 编译；Sol-Attn 纯 Triton JIT，实测可用但**只有 1.2–1.3×，不是翻倍** |

**实测已完成（2026-09-09，单卡 Ampere（sm_80），详见 §9）**：① int8 VAE ✅ 可用、与 fp16 像素等价、省 ~2s/镜且省 2.3GB 常驻；② i2v 换 `fl2va + fl2v LoRA` ✅ 可用、结构正常（+21GB 磁盘）；③ 新增平衡档 8 步 ✅ 175.8s/镜（成片档的 44.3%）；④ PDD Acc-8Step ❌ 当时结论：**在本机 ComfyUI 0.33.3 上不可用**（无 PDD loader，前向张量尺寸崩坏，与 shift 无关）——**已复测推翻：装上专用节点包 + 换预转换权重后跑通，见 §9.9**；⑤ **Sol-Attn 块稀疏 ✅ 跑通**：**成片档 20 步 768p 最快**——ref2v 396.6s→311.2s（**1.27×**）、i2v 394.8s→314.7s（**1.25×**），高频细节持平（±2.5%）；8 步档 1.23×（tau1.2）～1.38×（tau2.0，已饱和）；**480p 仅 1.03× 且偏软（−13.8% 高频），不要开**。两个前提：**必须 `dense_first_percent=0`**（默认 0.2 在本栈上等于完全没开）、节点注册名是 `SolAttnMiniMaxH3`。已落地改动清单见 §9.6。

**最大的结构性坑**：`shift_video/shift_audio` 目前在 manifest 的 `graph` 里**硬编码为 12.0/3.0**（`node "2" MiniMaxH3SigmaShift`），既不是可注入参数、也不随质量档变化。而 **LoRA 与其训练 shift 必须配对**（544p 系=12/3，768p 系=6/3）。换任何 768p LoRA 而不改 shift，输出会结构性崩坏，而不是"略糊"。`modes` 当前只支持 `steps` / `loras` / `longSide`，无法表达"按档切 shift" —— 所以换档的正确姿势是**加一份新 workflow JSON**（符合插件"换模型=加一份 JSON"的设计主张），而不是改 JS。

---

## 1. 背景：H3 慢在哪里，加速有哪几个面

### 1.1 单序列架构决定了"注意力"是主战场

H3 把一切都塞进**一条自注意力序列** `[text | cond rows | audio | video]`，每个 block 只有一次 attention 调用；VAE 压缩 16× 空间 / 4× 时间，DiT 再 patch 2×2 → 总计 **32× 空间 / 4× 时间**。于是 token 数与 Attention 的 O(N²) 共同决定单步耗时（数据来自 [ComfyUI-SolAttn-Ampere docs/why.md](https://github.com/cicalooo/ComfyUI-SolAttn-Ampere)）：

| 输出 | 约 token 数 |
|---|---|
| 480p / 5s | ~12k（**实测折算 ≈17k**，见 §9.8） |
| 480p / 15s | ~35k |
| 720p / 5s | ~28k（**实测 1344×768/5s = 40005**，其中文本/参考/音频前缀 2816） |
| 720p / 15s | ~84k |

对照本项目：`constraints.maxDurationFrames = 310`（≈12.9s @24fps），quality 档 1344×768 —— 即**成片单镜已接近 720p/13s 档，注意力开销是主要成本**；而 fast 档 832×480（≈0.4MP，480p 级）约 12k token，正好落在"4 步 LoRA 舒适区"。

### 1.2 可加速的四个面（互相正交，可叠加）

| 面 | 手段 | 本项目现状 |
|---|---|---|
| ① 采样步数 | 蒸馏 LoRA（4/8 步）、DMD2/PDD 少步 | fast 档已挂 4 步 LoRA；quality 档 20 步无 LoRA |
| ② 注意力内核 | SageAttention、Sol-Attn 稀疏、Block Sparse Attention、First Block Cache | 未启用（用默认 SDPA） |
| ③ 精度 / 量化 | DiT int8_convrot / fp8 / w4a8、VAE int8_convrot、TE nvfp4_awq | DiT 与 CLIP 已量化 ✅；**VAE 仍是 fp16 ❌** |
| ④ I/O 与调度 | ComfyUI Comfy Compiler/内存调度、block prefetch、TensorRT VAE、latent 上采样器 | 未动 |

**注意②③会互相稀释**：量化后的 transformer 每个线性层都多一层 dequant，注意力在单步中的占比反而上升或下降取决于硬件（[SolAttn-Ampere docs/why.md](https://github.com/cicalooo/ComfyUI-SolAttn-Ampere) 明确指出："量化 transformer 会增加线性层开销，但注意力不受影响，因此端到端收益 < 注意力层收益"）。单卡 Ampere（sm_80）没有权重流式加载问题，所以注意力的占比比 3090/24GB 场景**更高**，稀疏注意力在本项目上的相对收益应当**更好**。

### 1.3 AV 模型带来一个额外约束

H3 的视频与音频在同一个 forward 里生成。所以步数蒸馏的短板首先暴露在**音频**和**运动**上（Comfy 官方明确写 turbo 8 步 "slightly lower audio and motion quality"），而 lightx2v 的 v1.2 版本专门只修音频、不动架构。选 LoRA 时必须**同时验画面和音轨**，这是本项目（原生字幕 + 对白直出）不可忽略的一条。

---

## 2. 加速 LoRA 全景（按可生产性排序）

### 2.1 第一梯队：官方系，值得进生产

**A. lightx2v / ModelTC《MiniMax-H3 Turbo》**（Apache-2.0，事实标准；ComfyUI 官方模板即用此系）

| 名称 | 任务 | 训练分辨率 | 训练 shift（video/audio） | 蒸馏 NFE | 建议推理 NFE | 体积（comfy 版） |
|---|---|---|---|---|---|---|
| FL2VA Turbo 4-step v0.1 | FL2VA/T2VA | 544p 混合比例 | **12 / 3** | 4 | 4 | — |
| FL2VA Turbo 8-step v1.0 | FL2VA/T2VA | 544p 混合比例 | **12 / 3** | 8 | 8 或 4 | 1.96GB |
| FL2VA Turbo 4-step v1.0 768p | FL2VA/T2VA | 768p（1344×768） | **6 / 3** | 4 | 4 | 1.96GB |
| FL2VA Turbo 8-step v1.0 768p | FL2VA/T2VA | 768p | **6 / 3** | 8 | 8 | 1.96GB |
| FL2VA Turbo 4-step v1.1 768p | FL2VA/T2VA | 768p | 6 / 3 | 4 | 4 | 1.96GB |
| FL2VA Turbo **4-step v1.2 768p**（最新，2026-09-04） | FL2VA/T2VA | 768p | 6 / 3 | 4 | 4 | 1.96GB |
| Ref2VA Turbo 4-step v0.1 | Ref2VA | 544p | **12 / 3** | 4 | 4 | 1.96GB |
| Ref2VA Turbo 8-step v1.0 768p | Ref2VA | 768p | 6 / 3 | 8 | 8 | 1.96GB |

要点：
- **Ref2VA 没有 4 步 768p 版本**，4 步只有 v0.1（544p，shift 12/3）——这正是本项目当前在用的那个。
- v1.2 是**只改音频质量**的刷新（官方 discussion [#52](https://huggingface.co/lightx2v/Minimax-h3-Turbo/discussions/52)），推荐设置：4 步、euler、video shift 6、audio shift 3、≤768p。社区有反馈认为 v1.2 相对 v1.1 **画面质量略降**，若视觉优先可留在 v1.1。
- 官方 Studio 线上用的是 **8 步 v1.0 768p**（8 NFE、shift 6/3）——即"可用的生产档"是 8 步，不是 4 步。

**B. Alibaba PDD《MiniMax-H3-Acc-LoRAs》**（rank64 / alpha64 / BF16，8 步）

- 用 PDD（Parallel Decoding Distillation）蒸馏的**官方加速 LoRA**，FL2VA 与 Ref2VA **各一支**，README 直接以 demo 对比 "base vs lightx2v 4step vs Acc-8Step"。
- Kijai 已做 ComfyUI 转换并有 **pruned 版本**：`MiniMax-H3-{FL2VA,Ref2VA}-Acc-8Step_pruned_comfy.safetensors`（1.73GB）——与本项目使用的 `pruned_int8_convrot` base 正好配套。
- 加载：新版 ComfyUI 已支持 PDD LoRA（TE-Speed 3.3 的更新说明即为此适配）；官方脚本走 Diffusers `apply_pdd_lora` 自动推导步数（NFE=8）。
- ⚠️ **模型卡未给出训练 shift** —— 若要进本项目，必须先做 shift 实测（先试 12/3，再试 6/3）。

### 2.2 第二梯队：实验性，只在特定场景用

| 方案 | 是什么 | 为什么不默认用 |
|---|---|---|
| **Turbo-SLA**（lightx2v） | 4 步蒸馏 + SLA 85% 稀疏注意力，RTX 5090 上约 2.5× | 收益依赖 `operator: sage2` 稀疏算子；单卡 Ampere（sm_80）无 FP8/Sage2 路径 |
| **FastVideo FastH3（DMD2 data-free 4-step）** | hao-ai-lab 的数据无关 DMD2 少步蒸馏，`[999,749,500,250]` 阶梯 / cfg1.0、768×1344×124f；含 ComfyUI 提取版与 int8_convrot 整模型（22.9GB） | 预览态（v0.1=step1400 / v0.2=2900），高运动细节仍在成熟中 |
| **社区蒸馏**（larryvrh 744MB / drbaph pruned 592MB / TenStrip hybrid 4→8 步 / t8star int8-convrot） | 各类自训/融合/转换 | 或需专用采样器节点（larryvrh 需 `ComfyUI-MiniMax-H3-Turbo`）、或需专用 loader（t8star int8-convrot 需 `ComfyUI-LoraInt8Loader`）、或标注"需双时钟采样器或 8–10 步" |
| **低秩压缩版**（drbaph `resized_avg_rank_*` 284–933MB；Kijai rank20–31 约 300–440MB） | 对官方 LoRA 做精确 SVD 动态秩压缩（Ref2V r21 余弦相似度 99.92%、体积 −83%） | **只省显存/加载时间，不减算力**。单卡 Ampere（sm_80）无必要 |
| **风格 / 运动 LoRA**（wushu、yunjing 相机、Combat、Spatial Physics…） | 质量增强类 | 与加速档位正交，可作为独立议题；可与 Turbo 叠加（社区报告），但要单独验 shift 与 strength |

### 2.3 一张表看清"哪些能用"

| 方案 | ComfyUI 原生可加载 | sm_80（单卡 Ampere，无 FP8）可用 | 与本项目 base 匹配 | 结论 |
|---|---|---|---|---|
| lightx2v fl2v/ref2v turbo（.comfy 版） | ✅ 普通 LoraLoaderModelOnly | ✅ | ✅（ref2v v0.1 ↔ ref2va base） | **生产可用** |
| Alibaba PDD Acc-8Step（Kijai pruned_comfy） | ✅（需较新 ComfyUI） | ✅ | ✅（pruned 版 ↔ pruned base） | **候选生产** → 该 repack 格式不可用（§9.4），改用 aptech0081 预转换版 ✅ 已落地（§9.9） |
| SLA 版 | ✅ | ⚠️ 无 sage2 稀疏路径 | ✅ | 实验 |
| FastVideo FastH3 4-step | 半（VSA 节点生态） | ✅（有 int8_convrot 版） | 整模型替换 | 观察 |
| t8star int8-convrot LoRA | ❌ 需专用 loader | ✅ | ✅ | 不采用 |
| larryvrh 社区蒸馏 | ❌ 需专用采样器节点 | ✅ | 需 full base | 不采用 |
| w4a8 DiT | 实验（需 comfy-kitchen PR） | ❌ 无 FP8/FP4 硬件 | — | 不采用 |

---

## 3. 选 LoRA 的四个硬约束（比选哪支 LoRA 更重要）

### 3.1 shift 必须与训练配对 —— 错配不是"变糊"，是结构崩坏

| LoRA 家族 | 训练 shift(video/audio) | 必须设置 |
|---|---|---|
| 544p 系（fl2v 4step v0.1 / 8step v1.0、ref2v 4step v0.1） | 12 / 3 | `shift_video=12.0`, `shift_audio=3.0` |
| 768p 系（fl2v 4step v1.0/v1.1/v1.2 768p、fl2v 8step v1.0 768p、ref2v 8step v1.0 768p） | 6 / 3 | `shift_video=6.0`, `shift_audio=3.0` |
| PDD Acc-8Step | 未公开 | **已实测：8 步 184.7s / 叠 Sol 137.3s（§9.9）** |
| SLA 4step | 6 / 3（官方配置 `video_flow_shift 6.0`） | 6 / 3 |

### 3.2 steps：4 步在舒适区之下，6–8 步才是锐度舒适区

- 社区共识（awesome-minimax-H3）：4 步 LoRA "早期原型，锐度舒适区为 6–8 步"。
- ComfyUI 官方模板：quality 走 20 步（并建议提到 25 步改善运动）。
- 8 步 v1.0（544p）官方标注"建议 NFE 8 **或 4**"——即 8 步 LoRA 也能在 4 步跑，且第三方实测这一组合是**最快的一档**（见 §4）。
- lightx2v 建议的采样器是 **euler**；本项目用的是 `res_multistep` + `simple` —— 不匹配不等于不可用，但换 LoRA 时应把采样器作为验证变量之一。

### 3.3 分辨率：LoRA 有"训练域"

- 544p 系 LoRA ↔ 本项目 fast 档 832×480（0.4MP）——**同域**，所以当前组合自洽。
- 768p 系 LoRA ↔ 需要 ~960×544 以上、最好直接 1344×768 —— 在 832×480 上属域外，`fast 档分辨率` 必须跟着抬，否则等于拿训练域外的 LoRA 做调试档，A/B 结论不可信。
- 官方强调 768×1344 像素面积上限、分辨率 snap 到 32、时长 snap 到 `17k+5`。

### 3.4 base 变体匹配：fl2va ≠ ref2va

- H3 有两套权重：FL2VA（首末帧/T2V）与 Ref2VA（多模态参考）。Comfy 官方明确：T2V/I2V 模板用 fl2va，R2V 模板用 ref2va。
- 二者差异较小（Kijai 提供"fl2va→ref2va 差值的 rank256 LoRA"作为实验件；lihaoyun6 的 Ref-Patch 仅 148MB 即可让 fl2va 部分模拟 ref2va），所以**跨用能跑，但不在官方支持面内，且拿不到对应家族的迭代红利**。
- pruned 与 full base 也要匹配：pruned 会丢掉部分 AdaLN 投影，某些社区 LoRA 在 pruned base 上"明显更弱"——**有 pruned 专版就一定要用 pruned 版**。

---

## 4. 实测数据（选型依据）

### 4.1 步数带来的加速（RTX 4070 12GB，I2V，576×832，124 帧，24fps）——[sepiablue-ai/minimax-h3-turbo-lora-benchmark](https://github.com/sepiablue-ai/minimax-h3-turbo-lora-benchmark)

| 条件 | LoRA | steps | 平均总耗时 | 相对 baseline | Peak VRAM |
|---|---|---:|---:|---:|---:|
| Baseline | 无 | 20 | 272.97 s | — | 10.66 GiB |
| Larry/drbaph | v4_step600_ema | 8 | 130.30 s | 2.09× | 10.66 GiB |
| LightX2V 8-step | 8-step v1.0 | 8 | 131.02 s | 2.08× | 10.60 GiB |
| **LightX2V（8 步 LoRA 跑 4 步）** | 8-step v1.0 | **4** | **79.36 s** | **3.44×** | 10.66 GiB |

结论：**Turbo LoRA 的收益几乎全部来自步数削减**，Peak VRAM 几乎不变；最快的实测组合是"8 步 LoRA + 4 NFE"。

### 4.2 本项目自身的基线（可作对照刻度）

`docs/three-view-experiment.md` 记录：**ComfyUI 0.33.3 / 单卡 Ampere（sm_80）/ `minimax_h3_ref2va_pruned_int8_convrot` / mode=fast（4 步 LoRA）/ 832×480 / 124 帧（5.17s）→ 每臂约 28s**。
→ 即本项目 fast 档单镜 ≈ 28s（单卡 Ampere（sm_80））。quality 档（20 步 + 1344×768）步数 ×5、像素 ×2.6，单镜成本量级明显跃升 —— 这也是"成片档要不要引入 8 步平衡档"这个问题的由来。

### 4.3 注意力加速的参考数字

| 手段 | 硬件 | 数据 |
|---|---|---|
| **Sol-Attn（q0 真实 H3 生成）** | RTX 3090 sm_86，INT8 DiT + Q4_0 TE，FL2VA 480×672，124f，**20 步** | 168.67 s 冷启动，~6.0 s/it；`sol_attn=1000`（50 blocks × 20 步，零回退）；**真实密度 0.17–0.21**（随机张量下 0.125 → 合成收益表会高估） |
| Sol-Attn 合成内核 | 4070 Ti / 5080 / L40 / RTX PRO 6000 | vs SDPA **3.0–5.1×**；vs SageAttention 1.27–1.66×（消费卡）/ 1.85–2.55×（数据中心卡：L40 与 Blackwell PRO 6000 同档） |
| **SageAttention 2.2** | sm_80/86/87（Ampere） | 走**弱路径**：INT8 QK + FP16 PV + FP32 累加（Sage2++ 的 fp8 累加器 gated 到 sm89+），实测仍 **2.2–2.3× over SDPA** |
| Turbo-SLA | RTX 5090 | 约 **2.5×**（依赖 `sage2` 稀疏算子 + 85% 稀疏率） |
| Sage Attention（官方文档） | 通用 | 约 **2×**，质量损失极小（需 `Patch Sage Attention KJ` 节点或 `--use-sage-attention`） |
| int8_convrot VAE | 通用 | VAE 解码约 **1.5×**（需 ComfyUI ≥ 0.31；<0.31 会出黑帧） |
| First Block Cache + Sol-Attn | RTX 3060 12GB | 默认 9 分钟 → **4 分 18 秒**（缓存 + 稀疏组合，缓存参数需自行 A/B） |

**sm_80（Ampere）适用性判定**：

- ✅ 可跑：SageAttention（sage1/2 的 Ampere 路径）、Sol-Attn（Ampere 版用 `torch.compile(flex_attention)`，PyTorch ≥2.5 起支持 sm_80，无需 CuTe/CUTLASS/FP8）、First Block Cache、TE-Speed（缓存类）、VDN（线性注意力分支）。
- ❌ 跑不了 / 没意义：FlashAttention-3（Hopper-only，依赖 wgmma/TMA）、SageAttention2++ 的 fp8 累加器、SLA 的 `sage2` 稀疏算子、FP8/FP4 权重（sm_80 无对应硬件 → 也就解释了**本项目选 `int8_convrot` 是对的**）。
- ⚠️ 互斥：`flex_attention`（bf16 Triton）与 SageAttention（INT8）**不能在同一次 attention 调用里组合** —— 这就是 Sol-Attn Ampere 版 `min_seq_len` 门控存在的原因（短序列交回 Sage）。

---

## 5. 本项目现状盘点（事实层）

来源：`workflows/minimax-h3-ref2v.json`、`workflows/minimax-h3-i2v.json`、`~/.dsh/dsh-short-video-studio.json`、`docs/ARCHITECTURE.md`、`docs/three-view-experiment.md`。

| 项 | ref2v（`video.reference2video`） | i2v（`video.image2video`） |
|---|---|---|
| unet | `minimax_h3_ref2va_pruned_int8_convrot` | 同左 |
| clip | `qwen3vl_32b_minimax_h3_nvfp4_awq` | 同左 |
| video vae | `minimax_h3_video_vae_fp16` ❗ | 同左 |
| audio vae | `minimax_h3_audio_vae_fp32` | 同左 |
| fast LoRA | `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16`（strength 1.0） | **同一个 LoRA** |
| shift | **硬编码** `shift_video=12.0` / `shift_audio=3.0` | 同左 |
| sampler / scheduler | `res_multistep` / `simple` | 同左 |
| quality 档 | 20 步、longSide 1344（1344×768）、无 LoRA | 同左 |
| fast 档 | 4 步、longSide 832（832×480）、挂 LoRA | 同左 |
| 分辨率策略 | aspect-ratio + snap 32，支持 16:9/9:16/1:1 | 同左 |
| 时长上限 | 310 帧（≈12.9s） | 同左 |

**五点判断：**

1. ✅ **fast 档三要素同域**：544p 系 LoRA + shift 12/3 + 832×480 —— 自洽。实测 28s/镜（832×480、124 帧）也说明它够快。
2. ⚠️ **i2v 的 base/LoRA 组合是跨变体**：用 ref2va base 跑 `MiniMaxH3ImageToVideo`，并挂 ref2v 系 LoRA。省了一份 20.9GB 权重、也省了显存换模型，但放弃了 fl2v 系（v1.0→v1.2 三轮迭代）的收益，且不在官方支持面内。
3. ❗ **VAE 解码还是 fp16**：int8_convrot VAE（Kijai 3.17GB）可白捡 ~1.5× 解码加速。成片 1344×768×124 帧的解码时长占比不低，这是当前性价比最高的单点改动。
4. ❗ **shift 不可注入**：`modes` 只支持 `steps`/`loras`/`longSide`，`params` 是全局标量 —— 结构上无法表达"quality 12/3、fast 6/3"。
5. ➖ **注意力面完全没动**：既没开 Sage，也没上稀疏/缓存；sm_80 机上注意力占比高于消费卡，这一块现在是纯浪费。

---

## 6. 推荐方案

### 6.1 分档策略（推荐终态）

| 档位 | 步数 | base + LoRA | shift | 分辨率 | 用途 |
|---|---|---|---|---|---|
| **fast**（调试/画布预览） | 4 | ref2va_pruned_int8 + `ref2v_turbo_4step_v0.1_comfyui` | 12 / 3 | longSide 832 | 现有行为，保持不变 |
| **balanced**（新增，已落地） | 8 | ref2va_pruned_int8_convrot + `ref2v_turbo_8step_v1.0_768p_comfyui_bf16`（**实测采用**） | 6 / 3 | 1344×768（必须进 768p 训练域） | 长片批量出镜、成本敏感的成片；实测 175.8s/镜 |
| ~~balanced-b（PDD）~~ | ~~8~~ | ~~`MiniMax-H3-Ref2VA-Acc-8Step_pruned_comfy`~~ | — | — | 旧清单已删除（§9.4）；**新清单 `minimax-h3-ref2v-balanced-pdd[-sol]` 已落地（§9.9）** |
| **quality**（成片） | 20（可试 25） | 纯 base，无 LoRA | 12 / 3 | longSide 1344 | 现有行为；建议叠加 §6.3 |

一致性纪律：**同一片的同一镜不要混档**（fast 调参、quality 出片是允许的；但 fast 抽的帧不能当最终画面）。若引入 balanced 档，必须整片统一用它，否则 LoRA 带来的风格/细节漂移会在拼接处暴露。

### 6.2 i2v 的两条路线（明确二选一，不要含糊）

**路线 A（保守，零风险，推荐先做）**：保持 ref2va base 不动，在文档与 GUIDANCE 里把"i2v 与 ref2v 共用 ref2va 权重"写成显式取舍；i2v 的 fast 档沿用现有 LoRA，成片走 20 步纯 base。收益：零风险；代价：i2v 的 fast 档拿不到 fl2v v1.1/v1.2 的音频改善。

**路线 B（正确，需磁盘 + 必改 shift）**：新增 `minimax_h3_fl2va_pruned_int8_convrot`（20.97GB）为 i2v 的 unet，新增 fl2v LoRA 资产，并把该 manifest 的 shift 改到与 LoRA 配对：

```jsonc
// workflows/minimax-h3-i2v.json（路线 B 的关键差异）
"assets": {
  "unet":      { "default": "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "env": "DSH_SVS_H3_MODEL_FL" },
  // 768p 系 LoRA → shift 必须 6/3
  "fast_lora": { "default": "minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors", "env": "DSH_SVS_H3_LORA_FL_FAST" }
},
"graph": {
  "2": { "class_type": "MiniMaxH3SigmaShift",
         "inputs": { "model": ["$model", 0], "shift_video": 6.0, "shift_audio": 3.0 } }   // 12.0 → 6.0
},
"modes": {
  "quality": { "steps": 20, "longSide": 1344, "loras": [] },
  "fast":    { "steps": 4,  "longSide": 1344, "loras": [ { "asset": "fast_lora", "strength": 1.0 } ] }
}
```

> ⚠️ 注意：只要挂 768p 系 LoRA，`longSide` 就必须从 832 提到 768p 训练域（≥960×544，建议 1344×768），这会同时抬高 fast 档成本 —— 此时 fast 档实际变成"廉价成片"而非"调试档"。

**已落地（2026）**：i2v 的 `balanced` 档已按下面的折中建议补齐——`fast` 仍用 `fl2v 4step v0.1`（544p，shift 12/3），`balanced` 另建模板 `scripts/h3-templates/minimax-h3-i2v-8step.json`（`fl2v_turbo_8step_v1.0_768p` + shift 6/3 + euler + longSide 1344）。实测：**177.3s/镜**（ref2v balanced 166.3s），带 Sol 加速 **130.5s（1.36×）**；抽帧结构正常、无崩坏。历史缺口的原因不是缺资产（`fl2v 8step 544p` 早就在本机），而是**缺清单**：768p 版未下载 + 该档从未落成模板。

**折中建议（推荐）**：路线 B 里若想保住"fast = 调试档"的语义，就**别用 768p 系**，改用 **`fl2v 4step v0.1`（544p，shift 12/3）** —— 即 Kijai 提供的 `minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors`，可直接在 832×480 上跑，shift 保持 12/3 不变。这样路线 B 只需改**两项**：i2v 的 `unet` 换成 `minimax_h3_fl2va_pruned_int8_convrot`、`fast_lora` 换成 fl2v 4step v0.1；而 768p 系（含 v1.1/v1.2）留给新增的 balanced 档或专门的"高画质快出"档。

| 路线 B 的两种取法 | unet | fast LoRA | shift | fast longSide | 语义 |
|---|---|---|---|---|---|
| B1 保调试语义 | `fl2va_pruned_int8_convrot` | `fl2v 4step v0.1`（544p） | 12 / 3（不变） | 832 | 换 base + 换 LoRA 共 2 项改动 ✅ |
| B2 追画质/音质 | `fl2va_pruned_int8_convrot` | `fl2v 4step v1.2 768p`（或 v1.1） | **6 / 3** | 1344 | 三项一起改，需完整 A/B |

### 6.3 非 LoRA 加速（按优先级，与 LoRA 决策解耦）

| 优先级 | 动作 | 收益 | 风险 | 改动面 | 验收 |
|---|---|---|---|---|---|
| **P0** | video vae 换 `minimax_h3_video_vae_int8_convrot.safetensors`（[Kijai](https://huggingface.co/Kijai/MiniMax-H3-experimental)，3.17GB） | 解码 ~1.5× | 需 ComfyUI ≥0.31（本项目 0.33.3 ✅）；<0.31 会黑帧 | 两个 manifest 的 `assets.vae.default` + 配置 `models.h3VideoVae` | 同 seed 抽同一帧做像素 diff；确认无黑帧 |
| **P0** | 开 Sage Attention（`--use-sage-attention` 或 KJNodes 的 `Patch Sage Attention KJ`，插在 loader 与 guider 之间） | ~2×（Ampere 弱路径仍 2.2× over SDPA） | H3 部分层非 fp16/bf16 会回退（官方称预期无害）；`scheduler` 不需要 patch | 启动参数（**零 manifest 改动**）；若走节点则给两个 manifest 加链 | 控制台确认回退日志；同 seed A/B 画面与音轨 |
| **P1** | Sol-Attn Ampère（[cicalooo/ComfyUI-SolAttn-Ampere](https://github.com/cicalooo/ComfyUI-SolAttn-Ampere)，sm_80+，`flex_attention`） | 合成内核 3.2–4.0× vs Sage；真实密度 0.17–0.21 → 端到端收益需自测 | 需 PyTorch ≥2.5 + Triton；与 Sage 互斥（`min_seq_len` 门控）；作者自己**没有 A/B 基线** | 加节点到 MODEL 链（**同时喂 scheduler 和 guider**），manifest 加链 | 必须做：同 seed「节点关/开」两跑；读 `Sol-Attn Stats` 确认 `sol_attn>0` 且 `last_density<0.35` |
| **P1** | First Block Cache（缓存残差） | 与稀疏正交，3060 上组合后 9min→4m18 | 阈值需自行搜（上游 0.08 是 BF16/8×GB200 的设置，不能照搬）；对音轨影响需验 | 加节点 | 同 seed A/B，**同时检查视频与音频** |
| **P2** | TE-Speed 3.5（缓存/短轨迹策略，含 4/8 步专用策略） | 长片段与低显存收益明显 | 需最新 ComfyUI；与官方新接口强绑定 | 加节点 | 同上 |
| **P2** | VDN 混合线性注意力（[Saganaki22/ComfyUI-VDN-H3](https://github.com/Saganaki22/ComfyUI-VDN-H3)） | 长片段成本**线性化**（310 帧 × 1344×768 ≈ 70k token 的场景最有价值） | 学术预览，纹理可能欠训 | 加节点 | 长镜（≥10s）专项 A/B |

### 6.4 一个"两条线同时可走"的顺序建议

1. ~~**先做零风险项**：int8 VAE + 开 Sage~~ → **int8 VAE 已完成（§9.1）**；**开 Sage 仍未做**，且是当前**最大剩余杠杆**（实测采样占单镜耗时 63%（480p）～94%（768p），见 §9.3）。
2. ~~**再做 i2v 路线 A 的文档化**~~ → 已完成并直接走到路线 B1（§9.2），base 与 LoRA 均已切换为 fl2va/fl2v 配对。
3. ~~**然后加 balanced 档**：优先试 PDD~~ → **已完成**：PDD 当时实测不可用（§9.4，**后于 §9.9 复测推翻**），balanced 档采用 `ref2v_turbo_8step_v1.0_768p` + shift 6/3 + 1344×768，清单 `minimax-h3-ref2v-balanced`，实测 175.8s/镜（§9.3）；PDD 另立独立组/独立策略（§9.9）。
4. **最后做注意力稀疏**（Sol-Attn / FBC / Sage）：这两项的收益需要用真实生成自测（合成数据会高估），放在有稳定基线之后做 —— 现在基线已建立（§9.3 三档表）。
5. ~~**路线 B（i2v 换 fl2va base）** 作为独立议题~~ → 已落地（§9.2），磁盘成本 +21GB 已由用户承担；剩余动作只是把它写进 README 的兼容性说明（§9.6）。

---

## 7. 验收协议（换任何一项都要走一遍）

1. **单变量**：一次只改一样（LoRA / shift / 分辨率 / 内核），否则无法归因。若要换 768p LoRA，"LoRA+shift+分辨率"三项属于**一个不可分割的改动包**，一起改、一起验。
2. **固定变量**：同 seed（如 42424242）、同 prompt（建议用 H3 结构化 prompt，含 `overall_soundscape`）、同 `length=124`、同参考图（单视图！见 `docs/three-view-experiment.md`）。
3. **对照产物**：视频 + 抽帧（首/中/末各一帧做像素 diff）+ **音轨**（H3 是 AV 模型，音频退化是 4 步档的首要症状）。
4. **量化指标**：单镜墙钟耗时、跳步密度（Sol-Attn `last_density`）、回退计数（`failed`/`skipped_shape`）、峰值显存。
5. **回归门槛**：fast 档提速 <10% 的改动不进 fast 档；quality 档任何画面/音频回归直接回退（成片质量不可交易）。
6. **记录到画布**：每个改动包落一个画布文本节点（含改动项、seed、耗时、结论），与插件"耐用产物必须落画布"的约定保持一致。

---

## 8. 风险与坑清单

1. **shift 错配 = 结构性崩坏**，不是"略糊"。最容易被忽略、代价最高的一条。
2. **4 步档的短板是音频与运动**，不是清晰度。本项目成片带原生字幕与对白，音频退化 = 交付不合格。v1.2 专修音频（但有人反馈画面略降）→ 必须 v1.1/v1.2 同 seed A/B。
3. **pruned / full base 错配**：有 `_pruned_` 专版就绝不用 full 版 LoRA。
4. **fl2va / ref2va 错配**：能跑 ≠ 最优；跨用拿不到对应家族迭代红利（见 §6.2）。
5. **6–8 步才是锐度舒适区**：4 步适合调试与预览；把它当"成片档"是本末倒置。
6. **分辨率越低 token 越少**：4 步 LoRA 在 832×480 的收益与稳定性最好；在 70k token 的长镜上，4 步模型更易失真（这也是长片段需要 VDN/SLA 这类方案的原因）。
7. **Sage 与 Sol-Attn 互斥**（每次 attention 调用只能选一个），别指望叠加。
8. **别在 sm_80 机器上追 FP8/SLA/w4a8**：sm_80 没有对应硬件路径；`int8_convrot` 是这台机器的正解（HF 模型卡亦如此建议：能用 cu130 的 PyTorch 就优先 `int8_convrot`，`fp8_scaled` 只作退路）。
9. **授权**：LoRA 多为 Apache-2.0，但 **H3 base 受 MiniMax-H3 Community License 约束，本地生成物的商用需向官方渠道（Comfy）取得商业许可**。VDN 等权重另有地域排除条款。
10. **加速 LoRA 的上游还在快速迭代**（v1.0 → v1.1 → v1.2 约一个月内三次；PDD/FastVideo 均为新版）→ 换 LoRA 的成本应被设计得很低：**一个 manifest 字段 + 一次登记**，这正是本项目"能力注册表 + 清单"架构的优势，建议继续保持"不在 JS 里写死模型名"。

---

## 9. 实测结果（2026-09-09，单卡 Ampere（sm_80）/ ComfyUI 0.33.3，本节为**推翻/确认前面推断**的实证部分）

> 环境：`NVIDIA Ampere 单卡（sm_80）`（sm_80）、torch 2.15.0.dev+cu132、python 3.14.4、`--disable-xformers`（**未开 Sage**）、无 SolAttn/KJNodes 节点。
> 协议：同 seed `42424242`、同 H3 结构化 prompt、同**单视图**参考图（`e9cd2fee-…` 角色卡）、`length=124`（24fps≈5.17s）；耗时取 ComfyUI `Prompt executed in` 与 `/internal/logs/raw` 的 `s/it`，非墙钟估计。

### 9.1 int8_convrot VAE：✅ 可用，像素等价，但收益比文档预估小

| 臂 | 采样 | 解码（含音轨+写盘） | 端到端 | VAE 常驻 |
|---|---|---|---|---|
| int8_convrot（热态） | 16.0s（4.04 s/it） | **~9s** | **25.3s** | 2677 MB（staged） |
| fp16（热态） | 16.0s（4.04 s/it） | ~11–13s | 27.3s（另一跑 29.7s 含首次 4965MB 加载） | 4965 MB（staged） |

像素等价性（同 seed 同潜变量、仅解码不同；抽第 60 帧比对 832×480×3）：**通道均值绝对差 1.878/255、最大差 38、>8 的通道占 1.503%** → 视觉等价，无黑帧。

**修正**：§6.3 写的"解码 ~1.5×"是**解码步本身**的倍数；端到端只省 **~2s/镜（≈8%）**，因为 832×480 下解码只占 ~36%。真正价值在 768p（像素 ×2.58 → 约省 5s/镜）与**显存少 2.3GB**。结论：仍建议常开（零质量代价），但别把它当提速主力。

### 9.2 i2v 跨变体错配：✅ 换 fl2va + fl2v LoRA 后结构正常（路线 B1 成立）

| 臂 | base + LoRA | 端到端 | 画面判定（抽第 60 帧） |
|---|---|---|---|
| B1 旧组合 | ref2va + `ref2v_turbo_4step_v0.1` | 31.0s | 狐狸/橙宇航服/背包一致，四肢无多余、无重影，月面+星空 |
| B2 新组合 | **fl2va + `fl2v_lightx2v_turbo_4step_v0.1`** | 34.6s（含 21GB fl2va 首次加载） | 同上，结构正常；画面更"密"（陨石坑/岩石/星点更丰富），文件 768.6KB vs 598.3KB |

**修正**：这条**不是性能问题**（31.0 vs 34.6s 差异主要来自模型冷加载），而是**正确性 + 迭代红利**问题：换到 fl2va 后 i2v 才与官方 I2V/T2V 权重同源，也才能吃到 fl2v v1.1/v1.2。代价是插件用户多下 21GB。

### 9.3 三档成本阶梯（同 seed / 同 prompt / 同参考图）

| 档 | LoRA | 步数 | 分辨率 | 采样 | 解码+其他 | **端到端** | 相对成片档 |
|---|---|---|---|---|---|---|---|
| fast（调试） | fl2v/ref2v 4 步 v0.1 | 4 | 832×480 | 16.0s（4.04 s/it） | ~9s | **25.3s** | 6.4% |
| balanced（新） | `ref2v_8step_v1.0_768p` | 8 | 1344×768 | 140.2s（17.48 s/it） | ~35.6s | **175.8s** | **44.3%（省 55.7%）** |
| quality（成片） | 无 | 20 | 1344×768 | ~374s（18.7–18.9 s/it） | ~22s | **396.6s** | 100% |

> balanced 的"解码+其他"偏高（35.6s）主要含 8 步 LoRA 的权重 patch 与 int8 VAE 首次加载；quality 档的 ~22s 是热态纯解码。按像素推算 768p 解码本应 ~23s，与 quality 一致。

**修正**：8 步档的性价比被证实（**2.25×**，不是此前估的"约 2.7×"），但**绝对耗时仍很贵**（每镜 3 分钟）。124 帧 5 秒镜头下，一部 2 分钟短片（24 镜）balanced 档 ≈ 70 分钟纯 GPU。

### 9.4 PDD Acc-8Step（Alibaba）：❌ 本机不可用 —— 与 shift 无关

```
Module diffusion_model.final_layer.video_out has resizing Lora - force loading
Module diffusion_model.final_layer.audio_out has resizing Lora - force loading
308 patches attached          ← 对比 lightx2v 系为 208 patches
RuntimeError: The size of tensor a (32) must match the size of tensor b (1024)
              at non-singleton dimension 1
  at ComfyUI/comfy/ldm/minimax/model.py:510 (out[1] = ... audio_src ...)
```

崩点在**模型前向的 final_layer 双输出**（video_out / audio_out），不在采样调度 → **与 shift 12/3 或 6/3 无关**，改 shift 救不回来。且本机 `object_info` 中**不存在任何 PDD/Acc 专用 loader 节点**（只有通用 `LoraLoaderModelOnly` 等）——PDD 需要专用加载/推理路径（Diffusers `apply_pdd_lora`，或等 Comfy-Org/ComfyUI 官方支持）。

**2026 复核（读 safetensors 明文头，未下载整文件）**：本机保留的那个权重来自 [Kijai/MiniMax-H3-experimental](https://huggingface.co/Kijai/MiniMax-H3-experimental)，是**第三种**重打包格式——head bank 被表达为「相对 base 的 pad-and-add `reshape_weight` LoRA」（键名 `diffusion_model.final_layer.{video_out,audio_out}.*.reshape_weight`、`blocks.N.adaln_proj.linear.diff_b`），面向**普通 LoRA loader**。因此它**既**解释了当初普通 loader 为何在 final_layer 崩（键被强行 patch、语义不对 → `resizing Lora — force loading` 后 32 vs 1024），**也**意味着它不满足 PDD 专用节点的加载条件（节点要求 4 个顶层键 `proj_out.weight/bias`、`audio_proj_out.weight/bias`，该文件 0/4 存在）。要用 PDD 节点须改用 [aptech0081/MiniMax-H3-Acc-LoRAs-ComfyUI](https://huggingface.co/aptech0081/MiniMax-H3-Acc-LoRAs-ComfyUI) 的预转换版（`minimax_h3_{ref2va,fl2va}_pdd_acc_8step_comfyui.safetensors`，各 1.54GB）：实测 4/4 头键（`proj_out.weight [32,96,5376]`）+ 774/774 键合规，**双门通过**。节点侧目录机制见 `nodes.py`：`add_model_folder_path("pdd_acc", models/pdd_acc)` + `get_filename_list("pdd_acc")` 下拉 + `get_full_path_or_raise`，即文件**必须**放在 `models/pdd_acc/`。

**动作**：候选清单 `workflows/minimax-h3-ref2v-acc8.json` **已删除**（避免被误选而烧掉一次 3 分钟渲染）；权重 `MiniMax-H3-Ref2VA-Acc-8Step_pruned_comfy.safetensors`（1.73GB）**保留在服务器**备查。若日后 ComfyUI 支持 PDD，恢复成本 = 一个 JSON + 一次登记。

### 9.5 修正后的建议（覆盖前文相应条目）

1. **平衡档 = lightx2v `ref2v_turbo_8step_v1.0_768p` + shift 6/3 + 1344×768**（已落地）。~~不要等 PDD~~ → **PDD 已可用并作为独立策略并存（§9.9）**：要成片档画质且能等 ~185s 就选 PDD，要更快就还用它。
2. **int8 VAE 常开**（省 2.3GB 显存比省 2s 更值）。
3. **i2v 已切 fl2va/fl2v**，README 需补 +21GB 兼容性说明。
4. **剩余最大杠杆是注意力内核，但它的量级是 +20~30%，不是翻倍**：采样占 63%（480p）～94%（768p）的端到端耗时，所以注意力仍是最后能抠的地方；但 **Sol-Attn 实测只有 1.23–1.33×（768p，§9.8）**，而不是"SDPA→稀疏"的名义 2×+。Sage 在本机（sm_80 + torch 2.15.dev + py3.14）需要源码编译（无 nvcc 就不行），且**与 Sol-Attn 互斥**，所以现实选择是：**要么 Sol-Attn（已通、1.2–1.3×），要么装 CUDA Toolkit 后编 Sage**。再往上要提速就只剩"降档"（步数/分辨率，成本 ∝ token²·步数）。
5. **⚠️ 新发现的插件架构陷阱（已修）**：注册表的默认工作流 = `preferred` 为空时的 **`candidates[0]`**（`lib/index.js:945`）。新加一份清单会**静默改变**该能力的默认工作流——本次加 `minimax-h3-ref2v-8step` 后，`video.reference2video` 的默认就从 4 步 fast 档变成了 8 步 balanced 档；更险的是热加载后 `video.image2video` 的候选首项一度变成 `minimax-h3-i2v-sol`（**依赖未安装的第三方节点**，npm 用户必崩）。**已修**：候选排序改为显式 `priority`（降序）+ `id`（升序），Sol 变体一律 `priority: -100`；本机再用 `preferred` 双保险。

### 9.6 本次已落地的改动清单

| 类型 | 位置 | 内容 |
|---|---|---|
| 新清单 | `workflows/minimax-h3-ref2v-8step.json` | 平衡档：8 步 / euler / shift 6/3 / longSide 1344 / `ref2v_8step_v1.0_768p` LoRA |
| 改清单 | `workflows/minimax-h3-i2v.json` | unet → `minimax_h3_fl2va_pruned_int8_convrot`（env `DSH_SVS_H3_MODEL_FL`）；fast_lora → `minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy`（env `DSH_SVS_H3_LORA_FL_FAST`）；shift 保持 12/3；描述补"base/LoRA 配对"铁律 |
| 改引擎 | `lib/index.js` | **修掉一个会让上述改动失效的坑**：`LEGACY_MODEL_ASSET_MAP['minimax-h3-i2v']` 原先复用 ref2v 的 `h3RefUnet`/`h3FastLora` → 配置里有这两个旧键的用户，i2v 的 base 会被**静默改回 ref2va**（跨变体错配复现）。现改为独立的 `h3FlUnet`/`h3FlFastLora`（`getCfg().models` 新增两键，env `DSH_SVS_H3_MODEL_FL` / `DSH_SVS_H3_LORA_FL_FAST`），并把 legacy 兜底 builder `buildH3ImageToVideoWorkflow` 同步到 fl2va/fl2v。**此改动需重启插件进程才生效** |
| 删清单 | ~~`workflows/minimax-h3-ref2v-acc8.json`~~ | PDD 不可用，下架（后由 §9.9 的 PDD 清单取代） |
| 本机配置 | `~/.dsh/dsh-short-video-studio.json` | `models.h3VideoVae` → int8_convrot；4 个 `assetOverrides`（3 个 ref2v 档挂 int8 VAE + i2v 的 fl2va/fl2v/int8VAE）；`preferred` pin 住两能力的默认档 |
| 备份 | `e2e-out/config-backup-before-h3-accel.json` | 改动前配置，回滚用 |
| 工具 | `e2e-out/hist.mjs` / `logs.mjs` / `pngdiff.mjs` | 历史耗时归因 / 服务端日志提取 / 零依赖 PNG 像素 diff |
| 新清单（加速） | `workflows/minimax-h3-ref2v-sol.json`、`minimax-h3-ref2v-8step-sol.json`、`minimax-h3-i2v-sol.json`、`minimax-h3-ref2v-sol-stats.json` | Sol-Attn 块稀疏注意力变体（`class_type: SolAttnMiniMaxH3`，`dense_first_percent: 0`，`log_every: 50`），**内置可见但 `priority: -100` 不当默认档**；`-stats` 是带计数器诊断的复核用变体；全部由 `scripts/make-sol-attn-variant.mjs` 生成 |
| 改引擎 | `lib/index.js`（`reloadRegistry`） | 同能力候选改为**确定性排序**（`priority` 降序 → `id` 升序），修掉"候选顺序跟文件系统枚举走、新增清单会静默改掉隐式默认档"的问题；`schema` 同步补 `priority` 字段说明 |
| 产物 | 画布分组「加速实验」 | A1/A1'/A2/A3/A4（VAE）、B1/B2（i2v）、C1/C3（平衡 vs 成片）、S/P 系列（Sol-Attn 关开对照与探针）共 26 个节点含抽帧 |

**未做（已知待办）**：① Sage Attention 仍未启用（本机 torch 2.15.dev+py3.14 无预编译轮子，且**服务器没有 nvcc**，需先装 CUDA Toolkit）—— 落地步骤见 §9.7，但在已跑通 Sol-Attn（§9.8，成片档 1.25–1.27×）后优先级下降；② 音轨的**听感**比对未做（只验证了音频解码链路执行、产物含音轨；听感需人工）；③ Sol-Attn 尚未接进实际片型的默认档（要不要把 `preferred` 指到 `*-sol`，等定片型流程时再定）。

### 9.7 注意力加速落地步骤（服务器侧；Sage 路径**未执行**，Sol-Attn 路径已执行 → §9.8）

#### 9.7.0 先厘清概念："编译 Sage" 是什么

**Sage Attention 不是 ComfyUI 插件节点，而是一个 Python/CUDA 扩展包**（[thu-ml/SageAttention](https://github.com/thu-ml/SageAttention)，PyPI 包名 `sageattention`）：它用自写的 CUDA kernel 替换 PyTorch 的 `scaled_dot_product_attention`，从而让注意力更快。因此**不需要新增任何画布/插件节点**——ComfyUI 原生就带 sage 支持（`--use-sage-attention` 启动参数），装上包 + 改启动命令即可，**零 manifest / 零 JSON 改动**。

"编译"指：`sageattention` 在 PyPI 上主要是**源码包**，`pip install` 时会用 nvcc 现场编译 CUDA kernel（几十分钟）；官方只对少数几个 torch/python/CUDA 组合提供预编译 wheel。本机是 **torch 2.15.0.dev20260820+cu132 + Python 3.14**，远在 wheel 矩阵之外 → 只能源码编译（或自己造 wheel）。

**两种启用方式（先试 ①）**

| | 方式 | 动作 | 代价 |
|---|---|---|---|
| ① | **全局启动参数**（推荐） | `pip install sageattention` 后，用 `python main.py ... --use-sage-attention` 启动 ComfyUI | 零节点、零 JSON；改一行启动命令 |
| ② | **节点方式**（兜底） | 装 [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes)，用 `Patch Sage Attention KJ` 插在 loader 与 guider 之间 | 需要给每个 H3 清单加一条链；本机当前**没装** KJNodes |

#### 9.7.1 先探路（3 条命令，1 分钟，决定后面怎么做）

```bash
nvcc --version                      # 有没有 CUDA toolkit？没有则源码编译无从谈起（先解决这个）
python -c "import torch;print(torch.__version__, torch.version.cuda)"
pip install --dry-run sageattention  # 有 wheel 就是 "Would install …whl"；显示 "Building wheel for sageattention" 就是源码编译
```

#### 9.7.2 路径 A：源码编译 + 启动参数（推荐，零 manifest 改动）

```bash
# 1) 编译安装（sm_80；务必指定 TORCH_CUDA_ARCH_LIST，否则会连无关架构一起编，时间翻好几倍）
git clone https://github.com/thu-ml/SageAttention && cd SageAttention
TORCH_CUDA_ARCH_LIST="8.0" MAX_JOBS=8 pip install -e . --no-build-isolation
python -c "import sageattention; print('sage ok')"
# 2) 带 sage 启动 ComfyUI（在原命令后追加；--disable-xformers 与 sage 不冲突，可保留）
python main.py --listen --port 8188 --use-sage-attention
```

验收：启动或首次采样日志出现 sage 相关加载信息；H3 若有非 fp16/bf16 层会**回退 SDPA**（预期无害，但要确认不是**全层**回退）；同 seed A/B 看 `s/it` 是否从 **4.04** 掉到 ~2.0–2.5，并**同时检查视频与音轨**。
若编译失败（典型是 nvcc 版本与 torch cu132 ABI 不匹配、或 py3.14 头文件问题）：可尝试装匹配的 CUDA 13.x toolkit 后重试；仍不行则走路径 B/C。

#### 9.7.3 路径 B：Sol-Attn Ampère（**无 nvcc 时的首选**，✅ 已实测跑通，见 §9.8）

**为什么它不需要 nvcc**：[cicalooo/ComfyUI-SolAttn-Ampere](https://github.com/cicalooo/ComfyUI-SolAttn-Ampere) 的稀疏核是 `torch.compile(flex_attention)`，**JIT 编译**（走 Triton，随 torch 分发），不编译任何 CUDA 扩展。硬前置只有两条：**torch ≥2.5（本机 2.15 ✅）+ 可用的 Triton**。它按 128-token 粒度做块稀疏路由（K/Q 分块均值 → `q̄@k̄ᵀ` 试探打分 → `mean + tau·std` 阈值），只对重要块跑精确注意力，长视频序列上跳过约 80% 的计算；且**训练无关**（无重训、无校准），H3 的文本/条件/参考/音频前缀由 `protect_prefix` 自动保持稠密。

**① 服务器侧安装（约 1 分钟）**
```bash
python -c "import torch, triton; print(torch.__version__, triton.__version__)"   # 前置：triton 必须能 import
cd /root/ComfyUI/custom_nodes && git clone https://github.com/cicalooo/ComfyUI-SolAttn-Ampere
# 重启 ComfyUI（启动参数不变；Sol-Attn 是节点，不需要 --use-sage-attention 这类开关）
curl -s localhost:8188/object_info | python -c "import json,sys;print([k for k in json.load(sys.stdin) if 'Sol' in k])"
#   期望：['SolAttnMiniMaxH3', 'SolAttnStats']   ← 注册名！UI 显示名才是 "Sol-Attn MiniMax H3"
```
> ⚠️ 清单里的 `class_type` 必须写**注册名 `SolAttnMiniMaxH3`**；写成 UI 显示名 `Sol-Attn MiniMax H3` 会被 ComfyUI 判为 `missing_node_type`（已踩）。节点加载日志里出现 `[Sol-Attn] flex_attention compiled (warmup done)` 即编译成功。

**② 插件侧接线（已内置，无需手工登记）**
```bash
node scripts/make-sol-attn-variant.mjs            # 重新生成：产出 workflows/*-sol.json 并自校验接线
node scripts/make-sol-attn-variant.mjs --tau 1.5  # 换 tau 再生成
```
已随包内置四份**加速工作流**（`builtin`）：`minimax-h3-ref2v-sol`、`minimax-h3-ref2v-8step-sol`、`minimax-h3-i2v-sol`、`minimax-h3-ref2v-sol-stats`（带计数器诊断），在 `comfy_list_workflows` 与设置页可见可选，**都不作为默认档**（`priority: -100`）。变体把上游要求的接线落成图：`UNETLoader → [LoRA] → MiniMaxH3SigmaShift → SolAttnMiniMaxH3 →（BasicGuider + BasicScheduler）`，即插入节点 `2a` 并把**所有**引用 `["2",0]` 的 model 连线（`7.BasicGuider.model`、`9.BasicScheduler.model`）改指 `2a`（脚本自校验这两条必须都改到、无哨兵/悬空）。
选用方式：`comfy_render({ capability:"video.reference2video", workflow:"minimax-h3-ref2v-8step-sol", mode:"balanced", ... })`，或在配置里写进 `preferred`。

> ⚠️ **本插件栈必须 `dense_first_percent: 0`**（生成器已默认）：节点用 `transformer_options["sigmas"].flatten()[0]` 估采样进度，而本版本 ComfyUI 传的是整条 sigma 表、首元素恒定 ⇒ `progress ≡ 0`；只要 `dfp>0`，**每次调用都被判为"去噪早期"而全部回退稠密**（实测 `sol_attn=0 / skipped_early=400`，`s/it` 与原版一致）。`end_percent` 同理失效；早期保护改由 `dense_first_blocks=2` + `protect_prefix=true` 承担（实测 `prefix_blocks=22`）。

**③ 验收（关/开两跑，同 seed）**
- 指标：`sol_attn`（必须 >0，否则稀疏核没生效，看 `skipped_*` 判断被哪条挡掉）、`last_density`（目标 <0.35）、`s/it`、抽帧像素差、**音轨**是否退化。
- 用法：跑 `workflow="minimax-h3-ref2v-sol-stats"`（内置诊断变体，`Sol-Attn Stats` 的 `trigger` 已接解码后的 `IMAGE`，保证在采样**之后**读计数），然后看 ComfyUI 日志里 `[Sol-Attn] sol_attn=… prefix_blocks=… last_density=…` 一行；该行会自动带诊断提示（`never ran` / `density 高，提速有限`）。
- 前置开销：节点加载时完成 flex_attention JIT（实测 **5.8s**）；建议把 `TORCHINDUCTOR_CACHE_DIR` 指到持久目录，避免重启后重编。
- 与 Sage 互斥：同一层不要同时挂两种 attention override；内核失败时该节点会**回退**而不是中断生成，所以内置清单始终可作对照与兜底。

#### 9.7.4 为什么值得做

本次实测采样占端到端 63%（fast 480p）～94%（quality 768p）。**原以为**注意力端到端提速 2× 可把 768p 8 步从 175.8s 压到 ~106s；**实测下来是 1.23–1.33×**（见 §9.8），所以本节结论要按实测收窄：

- **768p 档值得开，成片档收益最大**：成片 20 步 ref2v 396.6s → 311.2s（**1.27×**）、i2v 394.8s → 314.7s（**1.25×**）；8 步平衡档 167.3s → 136.3s（tau 1.2）/ 125.4s（tau 1.5）。
- **480p 调试档不值得**：实测只有 1.03×（`s/it` 4.10→3.78），却要担一个第三方节点依赖。
- 为什么达不到"跳过 80% 块 ⇒ 提速 2×"：① 块稀疏跳的是**注意力里的一部分**，而一个 DiT 前向还有 FFN/门控/音频分支等固定成本；② 稀疏路径本身有路由（分块均值打分）+ `approx_correction` 回填的开销；③ Ampere 上 `flex_attention` 相对 SDPA 的**每单位工作量本就不占优**（Triton flex 在 sm_80 上通常慢于 FlashAttention2/SDPA），所以"少算 4 倍块"只换来"快 1.2–1.3 倍"。
- 也就是说：注意力核是**最后一个能抠的杠杆**，但它的量级是 +20~30%，不是翻倍。真要再快，得动**分辨率/步数档位**（成本 ∝ token²·步数），而不是继续换 attention 实现。

### 9.8 Sol-Attn 实测（2026-09-09，单卡 Ampere（sm_80）/ ComfyUI 0.33.3）——✅ 跑通：成片档 1.25–1.27×、8 步档最高 1.38×、480p 无效

**环境**：服务器已装 `ComfyUI-SolAttn-Ampere`；节点加载日志 `[Sol-Attn] flex_attention compiled (warmup done, correction=ready)`（5.8s）；`object_info` 见 `SolAttnMiniMaxH3` / `SolAttnStats`。torch 2.15.0.dev+cu132、triton 可用（启动日志里 `comfy_kitchen backend triton: available=True, disabled=True` 是 comfy 自己的后端开关，与 Sol-Attn 无关）。

**不变量**：同 H3 结构化 prompt、同一张单视图参考卡、`length=124`、seed 42424242（关/开同 seed）；对照臂 `enabled=false` 走**同一张图**，只差稀疏核开关。耗时取 `/history` 的 `execution_start→execution_success`。

**① 先踩的坑：默认参数等于没开**

| 臂 | 清单参数 | 计数器（Logs/Stats） | `s/it` | 结论 |
|---|---|---|---|---|
| 480p fast | `dense_first_percent=0.2`（上游默认） | `sol_attn=0 skipped_early=400` | 4.05 | **一次都没稀疏**，与原版 4.04 一致 |

根因：`patch.py` 的 `_RoutingPolicy._sigma()` 读 `transformer_options["sigmas"].flatten()[0]`；本版本 ComfyUI 在 `transformer_options` 里放的是**整条 sigma 表**，首元素恒定 ⇒ `progress=(sigma_hi−sigma)/span ≡ 0` ⇒ 恒被判为"去噪早期" ⇒ `dfp>0` 时全部回退稠密。**修复 = `dense_first_percent: 0`**（生成器已改默认）。`min_seq_len=0` 也试过：480p 仍不进场的真凶是 dfp，不是长度门槛。

**② 修复后实测（三个档位 × 关/开，全部同 seed 同 prompt 同参考图/首帧）**

| 档位 | 臂 | 参数 | 密度 | 采样 | 端到端 | 加速比 |
|---|---|---|---|---|---|---|
| 768p 平衡 8 步 | P5 | `enabled=false`（同图对照） | — | ~147s | 167.3s | 1.00× |
| 768p 平衡 8 步 | P4b | `tau=1.2, dfp=0` | 0.221–0.247（跳 ~4.2× 块） | 115s | **136.3s** | **1.23×** |
| 768p 平衡 8 步 | P6 | `tau=1.5, dfp=0` | 0.167–0.190（跳 ~5.4× 块） | 106s | **125.4s** | **1.33×** |
| **768p 成片 20 步（ref2v）** | C3 → P7 | 基线 → `tau=1.2, dfp=0` | 0.13–0.16 | 374s → 291s | 396.6s → **311.2s** | **1.27×** |
| **768p 成片 20 步（i2v）** | P9 → P10 | 基线 → `tau=1.2, dfp=0` | — | — | 394.8s → **314.7s** | **1.25×** |
| 480p fast 4 步 | P3b → P3 | 基线 → `dfp=0` | — | 16.4s（4.10 s/it）→ 15.1s（3.78 s/it） | 24.6s → 23.8s | **1.03×** |
| i2v fast 4 步（480p） | P8b → P8 | 基线 → `dfp=0` | 0.26–0.29 | 16.4s → 15.1s | 26.1s → 37.3s※ | ~1.08×（仅采样） |

※ P8 的端到端含 21GB FL2VA 基座重载 + 首步模型初始化，不可直接比。

- 计数证据：768p 8 步 `sol_attn=384 failed=0 prefix_blocks=22`（384 = 8 步 × 50 块 − 每步前 2 块稠密；`prefix_blocks=22` = 2816 token 前缀始终稠密 ⇒ `protect_prefix` 生效）；20 步成片档 `sol_attn=960`。
- 实测序列长度：**S=40005 token**（ref2v 768p/124 帧，含前缀 2816）、**S=15858**（i2v 480p，含前缀 1536）→ 折算 ref2v 480p ≈ 17k。（前文"480p ≈ 12k"估算偏低，结论方向不变。）
- **i2v 首帧续接同样生效**：Sol 变体在 i2v 图上接线正确（生成器改指的 `7/9` 两个 model 消费点都命中），20 步档拿到与 ref2v 同量级的 1.25×。

**③ tau 旋钮已饱和（768p 8 步，同图同 seed）**

| tau | 密度 | 跳块倍数 | 端到端 | 加速比 | 相对上一档 |
|---|---|---|---|---|---|
| 1.2 | 0.221–0.247 | ~4.2× | 136.3s | 1.23× | — |
| 1.5 | 0.167–0.190 | ~5.4× | 125.4s | 1.33× | +8% |
| 2.0 | 0.126–0.159 | ~7.4× | 121.2s | **1.38×** | **+3%** |

密度从 0.17 再砍到 0.13（多跳 25% 的块）只换来 3% ⇒ **瓶颈已不在注意力 FLOPs**（路由开销 + 非注意力部分反而成为主项）。**上限 ≈1.4×**，再加 tau 只增画质风险。

**④ 画质：三条证据链**

| 检查 | 结果 |
|---|---|
| 目视（strict 两行判定） | 768p tau1.2「干净可用的成片帧」；768p tau1.5「**档位=可用、可疑点=无**」；i2v 成片档 Sol「**档位=可用、可疑点=无**」；480p Sol「可用」（基线反被判「勉强可用·偏软」） |
| 高频能量 mean\|∇\|（同 seed 同场景） | **成片 20 步：ref2v +2.5%、i2v −1.8% → 细节持平**；768p 8 步 tau1.2/1.5/2.0：+23%/+37%/+29% → 无糊化；480p 4 步：**−13.8%** → 偏软 |
| 像素 diff（同图同 seed 开/关） | 768p 8 步 15.3/255（43% 通道 >8）；成片 ref2v 17.2/255；成片 i2v 6.4/255（16.7%）；tau2.0 20.3/255 |
| 音轨 | 各臂 mp4 均含音频轨 ✓ |

工具：`node e2e-out/sharpness.mjs a.png b.png …`（零依赖；输出 mean\|∇\| 与 >16 梯度像素占比，第一张为基准）。

**这些数字怎么读**：
- **"像不像基线"不能当画质判据**：注意力实现从 SDPA 换成 flex_attention，即使**完全不稀疏**（`enabled=false` 对照 vs 原版基线）也有 15.1/255 的均值差；8 步蒸馏采样器会把 bf16 级扰动放大成"另一张同样合理的画面"。⇒ **同 seed 不再复现同像素，整片必须一致地全用或全不用**，不能逐镜混用。
- **真正说明画质的是两点**：(a) 成片档（20 步）两条路径的高频能量都持平在 ±2.5% 内——细节没被抹平；(b) 目视结构检查无畸形/重复/乱码。
- **480p 的 −13.8% 要当回事**：480p 只有 ~17k token、4 步，跳掉 4 倍块确实让画面偏软；叠加此处本来就没速度收益（1.03×）⇒ 480p 档**双重理由不开**。

**⑤ 结论（选型）**

| 场景 | 建议 |
|---|---|
| 768p 成片档（20 步） | ✅ **开**：ref2v 1.27×、i2v 1.25×，高频细节持平、目视通过 —— **收益最大的地方就是这里** |
| 768p 平衡档（8 步） | ✅ 开：1.23×（tau1.2）/ 1.33×（tau1.5），画质已验 |
| 480p fast 调试档 | ❌ **别开**：速度 1.03×（i2v 1.08%）且高频能量 −13.8%，白担第三方依赖 + JIT |
| tau | **推荐 1.2**（三个档位都验过）；8 步档要更快用 1.5（+8%，画质判定"可用/无"）；2.0 只多 3% 且有画质风险，不建议 |
| 与 SageAttention | 互斥（H3 同层不能挂两个 override），本机 Sage 未启用，不冲突 |
| 兜底 | 内核异常会自动回退稠密而非中断；内置清单恒可用 |

**⑥ 复核方法**：跑 `workflow="minimax-h3-ref2v-sol-stats"`（内置诊断变体），日志会出现
`[Sol-Attn] sol_attn=384 skipped_short=0 skipped_shape=0 skipped_early=0 … prefix_blocks=22 last_density=0.2213`。
判读：`sol_attn=0` + `skipped_early` 占满 ⇒ 又是 `dense_first_percent>0` 把稀疏关掉了；`last_density>0.35` ⇒ 提速有限，可加 tau。

---

### 9.9 PDD 复测（2026-09-09 晚，同机）——✅ **推翻 §9.4 的"不可用"结论：已跑通并落地为每能力独立策略**

**§9.4 错在哪（两处，都不是"PDD 本身不行"）**：① 当时本机**没有 PDD 专用节点包**（`object_info` 里查不到任何 PDD/Acc 节点）——PDD 不是普通 LoRA，必须由专用节点安装 head bank；② 手上那份权重是 [Kijai/MiniMax-H3-experimental](https://huggingface.co/Kijai/MiniMax-H3-experimental) 的**第三种重打包格式**（head bank 表达为 pad-and-add `reshape_weight`，面向普通 LoRA loader），既不满足 PDD 节点的加载条件（0/4 个必需顶层键），也正是当年"普通 loader 强行 patch → final_layer 32 vs 1024 崩坏"的根因。**两者都不是 shift 的问题** ✓（§9.4 这一句判断仍然成立）。

**这次具备的条件**：节点包 [Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc](https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc) 已装（`MiniMaxH3PDDAccApply` / `...Scheduler` / `...WarmupScheduler` / `MiniMaxH3AVLatentUpscaleBy` 共 4 个类，ComfyUI 0.33.3 ≥ 其要求的 0.33.0）；权重改用 [aptech0081/MiniMax-H3-Acc-LoRAs-ComfyUI](https://huggingface.co/aptech0081/MiniMax-H3-Acc-LoRAs-ComfyUI) 的预转换版（Ref2VA / FL2VA 各 1.54GB，**放 `models/pdd_acc/`**——节点只从该目录取文件，放 `models/loras/` 会被 `LoraLoader` 系列看见但 Apply 节点的下拉里没有）。

**实测配方（已被本插件模板固化，与节点包 README 逐条一致）**：
`UNETLoader → MiniMaxH3SigmaShift(12/3) → MiniMaxH3PDDAccApply → BasicGuider(CFG 1.0)`，采样器 **euler**，sigmas = **Apply 节点的 1 号输出**（训练网格），强度 1.0，`nfe=8`，`on_off_grid=error` / `partition_check=error`（fail-closed，不静默降级）；**不叠任何其它蒸馏 LoRA**（lightx2v 系必须摘掉）、不叠 step-caching；base 与权重严格同族（节点有 trunk/head 指纹守卫，ref2va↔ref2va、fl2va↔fl2va，bf16 与 **int8-convrot pruned** base 都可用——本机用的就是 pruned int8_convrot）。

**实测（单卡 Ampere（sm_80）· 同参考图/同 prompt/同 seed 42424242 · 1344×768 · 124 帧）**

| 臂 | 配方 | 耗时 | 帧 60 锐度 mean\|∇\| | 噪声地板 p05 |
|---|---|---|---|---|
| 参照 | 20 步无蒸馏（成片档） | 394.4s | 7.243 | 0.131 |
| **PDD** | **nfe=8** · shift 12/3 · euler · 无蒸馏 LoRA | **184.7s** | **7.986（比成片档 +10.3%）** | **0.077（比成片档更低）** |
| PDD + Sol | 同上再叠 Sol-Attn tau1.2 | **137.3s（1.35×）** | 7.141（−1.4%，与成片档持平） | 0.064 |
| 对照 | lightx2v 8 步 768p（现有 balanced） | 170.4s | 5.630（比成片档 −22.3%） | 0.013 |

**i2v（FL2VA）侧同条件（同首帧 / 同 prompt / 同 seed，fp16 VAE）**

| 臂 | 配方 | 耗时 | 帧锐度 mean\|∇\| | 噪声地板 p05 |
|---|---|---|---|---|
| 参照 | 20 步无蒸馏（成片档） | 392.4s | 8.137 | 0.528 |
| **PDD** | **nfe=8** · shift 12/3 · euler | **178.8s** | **8.778（比成片档 +7.9%）** | **0.403（更低）** |
| PDD + Sol | + Sol-Attn tau1.2 | **134.1s（1.33×）** | 7.622（比成片档 −6.3%） | 0.463 |
| 对照 | lightx2v 8 步 768p（现有 balanced，生产路径 int8 VAE） | 177.3s | 8.648 | — |

**读法**：8 步的 PDD 把细节量做到**成片档之上**，而现有 lightx2v 8 步是过平滑（ref2v 侧比成片档 −22%）；PDD 的噪声地板比 20 步**更低** ⇒ 多出来的高频是细节而非颗粒。叠加 Sol 后细节回落到与成片档持平（ref2v −1.4% / i2v −6.3%），换来 1.35× —— 即"137s 买成片档画质"（对 20 步是 **2.9×**）。

**⚠️ 收益按能力不同（"每能力独立策略"的实证依据）**

| 能力 | PDD 8 步 vs **成片档 20 步** | PDD 8 步 vs **现有 balanced（lightx2v 8 步）** | 因此 PDD 的定位 |
|---|---|---|---|
| ref2v | **+10.3%** 细节（且噪声地板更低） | **+42%** 细节（7.986 vs 5.630） | **现有 balanced 的全面升级**（同 8 步、画质越档） |
| i2v | **+7.9%** 细节 | 仅 **+1.5%**（8.778 vs 8.648） | **成片档的廉价替代**（对比对象是 20 步，不是 balanced） |

原因：i2v 的 768p fl2v LoRA 本身训练得更到位，8 步已经不错；ref2v 的 768p LoRA 偏弱，才让 PDD 的优势显得巨大。**结论不能跨能力外推**——这正是分能力独立策略的价值。

**落位（本插件）**：**四个普通清单**（`minimax-h3-{ref2v,i2v}-balanced-pdd[-sol]`），与 lightx2v / Sol 那些实现并列在同一个家族组里；**不再自动生成"（PDD 蒸馏）"策略条目**——策略由用户在配置页「新增策略」里自行组合并命名（内置默认只有一条 = 跟随注册表首选）。`priority: -30` ⇒ **不做隐式默认**：PDD 依赖第三方节点，必须用户在设置页显式选择；缺节点时矩阵如实置灰（不静默回退、不假装可用）。档位目前只提供 `balanced`（nfe=8，已实测）；`nfe=4`（官方允许）与"两段式超分"（`MiniMaxH3AVLatentUpscaleBy`，节点包自带、纯 resize）**未测**，需要时再补档位。

**复核命令**：`node scripts/bench-h3.mjs --template=minimax-h3-pdd-ref2v --mode=balanced --ref-input=<图>`（先 `--dry` 核对配方）；结构不变量由 `verify-h3-variants` 断言（nfe↔档位步数、fail-closed 标志、无调度器、无蒸馏 LoRA、base/权重同族），档位契约由 `smoke-tier-resolution` 断言（独立组、两条策略、不隐式默认、缺节点置灰）。

**残留风险**：① PDD 依赖第三方节点 + 第三方重打包权重（权重 Apache-2.0，节点包非官方）；② 画质结论来自单帧/单 seed，未做多镜头一致性验证；③ 不能与 lightx2v 叠加，也不能超过 8 步；④ 块长只能 4 或 8（越界节点直接拒绝，不静默）。

---

## 10. 参考链接

**模型与权重**
- [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3)（ComfyUI 重打包：DiT/CLIP/VAE/LoRA/embeddings/ControlNet）
- [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3)（官方权重与 prompt 写作指南）
- [lightx2v/Minimax-h3-Turbo](https://huggingface.co/lightx2v/Minimax-h3-Turbo)（Turbo LoRA 全家族；discussion [#52](https://huggingface.co/lightx2v/Minimax-h3-Turbo/discussions/52) = v1.2 发布）
- [lightx2v/Minimax-h3-Turbo-SLA](https://huggingface.co/lightx2v/Minimax-h3-Turbo-SLA)
- [alibaba-pai/MiniMax-H3-Acc-LoRAs](https://huggingface.co/alibaba-pai/MiniMax-H3-Acc-LoRAs)（PDD 8 步官方加速 LoRA，原始格式）
- [aptech0081/MiniMax-H3-Acc-LoRAs-ComfyUI](https://huggingface.co/aptech0081/MiniMax-H3-Acc-LoRAs-ComfyUI)（ComfyUI 键名预转换版，**本插件采用**；Apache-2.0）
- [Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc](https://github.com/Jalen-Brunson/ComfyUI-MiniMax-H3-PDD-Acc)（PDD 专用节点包，提供 `MiniMaxH3PDDAccApply` 等）
- [Kijai/MiniMax-H3-experimental](https://huggingface.co/Kijai/MiniMax-H3-experimental)（Acc-8Step 的 comfy/pruned 转换、int8_convrot VAE、w4a8、FastVideo int8 版）
- [ModelTC/Minimax-H3-Turbo](https://github.com/ModelTC/Minimax-H3-Turbo)（模型规格表：训练分辨率/训练 shift/NFE；ComfyUI 与 Diffusers 推理说明）
- [wildminder/awesome-minimax-H3](https://github.com/wildminder/awesome-minimax-H3)（LoRA 全景索引、低秩压缩、量化、节点生态）

**官方文档**
- [ComfyUI MiniMax H3 总览（含 Sage Attention 加速）](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)
- [ComfyUI MiniMax H3 原生工作流（turbo_mode / 分辨率 / 时长网格 / AddGuide / 噪声掩码）](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native)
- [ComfyUI Wiki：FL2V Turbo 4 步 v1.2 发布说明](https://comfyui-wiki.com/zh/news/2026-09-06-minimax-h3-fl2v-turbo-v1-2)

**加速内核与节点**
- [cicalooo/ComfyUI-SolAttn-Ampere](https://github.com/cicalooo/ComfyUI-SolAttn-Ampere)（sm_80+ 块稀疏注意力；含真实生成实测与 Ampere/Sage 弱路径分析）
- [quzopl/ComfyUI-SolAttn-H3](https://github.com/quzopl/ComfyUI-SolAttn-H3)（SM89/90/100/120 CuTe 版与逐卡 benchmark）
- [Apache0ne/ComfyUI-fasterminimax](https://github.com/Apache0ne/ComfyUI-fasterminimax)（First Block Cache + Sol-Attn SM86 适配、时序日志）
- [woct0rdho/SageAttention](https://github.com/woct0rdho/SageAttention) · [KJNodes `Patch Sage Attention KJ`](https://github.com/kijai/ComfyUI-KJNodes)
- [zbm2024/TE-Speed-MiniMaxH3](https://github.com/zbm2024/TE-Speed-MiniMaxH3) / [tl2012tl/TE-Speed-MiniMaxH3](https://github.com/tl2012tl/TE-Speed-MiniMaxH3)（4/8 步专用策略、PDD LoRA 适配）
- [Saganaki22/ComfyUI-VDN-H3](https://github.com/Saganaki22/ComfyUI-VDN-H3)（线性注意力分支，长片段）

**第三方实测**
- [sepiablue-ai/minimax-h3-turbo-lora-benchmark](https://github.com/sepiablue-ai/minimax-h3-turbo-lora-benchmark)（4070 12GB，20/8/4 步对照）
- [ComfyUI PR #15334（int8_convrot VAE 支持）](https://github.com/Comfy-Org/ComfyUI/pull/15334)
- [ComfyUI PR #15439（MiniMaxH3AddGuide）](https://github.com/Comfy-Org/ComfyUI/pull/15439) · [PR #15375（per-token 噪声掩码）](https://github.com/Comfy-Org/ComfyUI/pull/15375)

**本项目内部依据**
- `workflows/minimax-h3-ref2v.json`、`workflows/minimax-h3-i2v.json`（当前资产、shift、档位）
- `docs/ARCHITECTURE.md`（`$model` 哨兵与 `mode.loras` 插链机制）
- `docs/workflow-contract.md`（manifest 契约、`modes` 字段）
- `docs/three-view-experiment.md`（单卡 Ampere（sm_80）/ ComfyUI 0.33.3 / fast 档 28s 基线）
