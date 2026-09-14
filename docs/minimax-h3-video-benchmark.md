# MiniMax H3 视频工作流 Benchmark

> **⚠️ 历史实测记录（保留原文 id）**：本报告的 `minimax-h3-ref2v` 对应拆分后的 `minimax-h3-ref2v-fast`（同图 fast 档）与 `minimax-h3-ref2v-quality`（同图 quality 档），`minimax-h3-ref2v-8step` → `minimax-h3-ref2v-balanced`，`minimax-h3-ref2v-sol` → `minimax-h3-ref2v-quality-sol`，`minimax-h3-ref2v-8step-sol` → `minimax-h3-ref2v-balanced-sol`，`minimax-h3-i2v` → `minimax-h3-i2v-fast` / `minimax-h3-i2v-quality`，`minimax-h3-i2v-sol` → `minimax-h3-i2v-quality-sol`（**P2 拆分，图形等价**——同一张图，只是「一个 json = 一个档位」。当时一个 json 用 `modes` 覆盖多档）。`mode=` 参数现为 `tier=` 的兼容别名。档位契约见 [`docs/tier-strategy-design.md`](tier-strategy-design.md)。

> 本机实测汇总：**分辨率 × 档位 × LoRA × Sol-Attn 加速** 四个维度的成本与画质。
> 数据来自 单卡 Ampere（sm_80）服务器上的本地 ComfyUI，全部由 `dsh-short-video-studio` 插件的**能力注册表**提交，可用 `node e2e-out/bench.mjs` 从 `/history` 一键重取。
>
> 配套文档：`docs/minimax-h3-acceleration-lora.md`（加速方案研究，§9 为实测记录）、`README.md`（工作流清单与配置）。

---

## 0. 速查结论（先看这张）

| 我要什么 | 用哪个（workflow / mode） | 分辨率 | 实测耗时（5.2s 一镜） | 备注 |
|---|---|---|---|---|
| **成片（正式出片）** | `minimax-h3-ref2v` 或 `-i2v`，`quality` | 1344×768 | **396.6s / 394.8s** | 20 步无 LoRA，画质最好 |
| 成片但要快 | 同上 + **Sol 加速**：`minimax-h3-ref2v-sol` / `-i2v-sol` | 1344×768 | **311.2s / 314.7s** | **1.25–1.27×**，细节持平 |
| **日常主力（性价比最高）** | `minimax-h3-ref2v-8step`，`balanced` | 1344×768 | **166.3s** | 8 步 768p LoRA + shift 6/3 |
| 同上 + Sol | `minimax-h3-ref2v-8step-sol` | 1344×768 | **136.3s**（tau1.2）/ 125.4s（tau1.5） | 1.23–1.33× |
| **构图/动作预演** | `minimax-h3-ref2v`，`fast` + 显式 768p | 1344×768 | **94.8s** | 4 步 LoRA 跑 768p：可用但材质偏糊 |
| **快速迭代（调 prompt/动作）** | `minimax-h3-ref2v`，`fast` | 832×480 | **24.6s** | 最省，画质"勉强可用偏软" |
| 竖版短视频 | 同上任意档 + `width/height` 换 9:16 | 480×832 | **26.6s**（fast） | 同像素数≈同成本 |
| **首帧续接 / 镜头衔接（日常主力）** | `minimax-h3-i2v-balanced`（`first_frame_node`） | 1344×768 | **177.3s**（带 Sol 130.5s） | 8 步 + fl2v **768p** LoRA + shift 6/3；2026 补齐，此前 i2v 只有 fast/quality 两档 |
| 首帧续接（成片档） | `minimax-h3-i2v-quality`（`first_frame_node`） | 1344×768 | 394.8s | 20 步无 LoRA，画质最好；身份由首帧继承 |
| **Sol 加速** | 只在 **768p 及以上**开 | — | 见 §6 | 1024×576 及以下无收益 |

**一句话**：**分辨率是最贵的旋钮（超线性），步数次之（线性），Sol-Attn 只有 768p 档值得开（1.25–1.38×）。**

---

## 1. 测试条件（保证可比）

| 项 | 取值 |
|---|---|
| 硬件/环境 | 单卡 Ampere（sm_80）服务器；ComfyUI 0.33.3；torch 2.15.0.dev+cu132；py3.14；FFmpeg 可用 |
| 时长 | `length=124` @24fps = **5.17s**（H3 帧数步进 17，24fps） |
| seed | 全部 **42424242**（早期对比臂用 66660003 / 55550001，已标注） |
| prompt | 同一份 H3 结构化 prompt（ref2v 6 段 / i2v 3 段+对齐行） |
| 参考/首帧 | 同一张**单视图**角色卡（ref2v）或同一张中帧（i2v） |
| 取数 | ComfyUI `/history` 的 `execution_start → execution_success`（含模型加载、VAE 解码、封装），非墙钟估算 |
| 热态 | 同一 UNet 连续跑时模型常驻；**换 base（ref2va↔fl2va，各 21GB）会重载**，i2v 首次跑会多花 ~10–20s |
| 缓存 | 图不变的部分（CLIP/VAE 加载等）会命中缓存，脚本记录了缓存节点数；本表比值均在同图条件下取得 |

> ⚠️ 两个必须知道的取数陷阱：① 换 base 的首次运行**不可**与热态比（如 i2v fast 37.3s 含 21GB 重载）；② 稀疏开关（Sol）会改变采样轨迹，**同 seed 不再复现同像素**（即使不稀疏也有 15.1/255 的均值差），跨内核比"像素差"只能判断"是不是崩坏"，不能当画质好坏的唯一判据。

---

## 2. 工作流清单盘点（本插件共 10 份清单）

| 工作流 id | 能力 | 条件节点 | shift | 采样器 | UNet base | 档位 | priority |
|---|---|---|---|---|---|---|---|
| `minimax-h3-ref2v` | reference2video | `MiniMaxH3ReferenceToVideo` | 12/3 | res_multistep | ref2va_int8_convrot | quality 20步 / fast 4步 | 0 |
| `minimax-h3-ref2v-sol` | reference2video | 同上 + **Sol** | 12/3 | res_multistep | 同上 | quality / fast | **-100** |
| `minimax-h3-ref2v-sol-stats` | reference2video | 同上 + **Sol + Stats** | 12/3 | res_multistep | 同上 | quality / fast | **-100** |
| `minimax-h3-ref2v-8step` | reference2video | 同上 | **6/3** | **euler** | 同上 | balanced 8步 | 0 |
| `minimax-h3-ref2v-8step-sol` | reference2video | 同上 + **Sol** | 6/3 | euler | 同上 | balanced 8步 | **-100** |
| `minimax-h3-i2v` | image2video | `MiniMaxH3ImageToVideo` | 12/3 | res_multistep | **fl2va**_int8_convrot | quality / fast | 0 |
| `minimax-h3-i2v-sol` | image2video | 同上 + **Sol** | 12/3 | res_multistep | fl2va_int8_convrot | quality / fast | **-100** |
| `minimax-h3-i2v-8step` | image2video | 同上 | **6/3** | **euler** | fl2va_int8_convrot | balanced 8步 | 0 |
| `minimax-h3-i2v-8step-sol` | image2video | 同上 + **Sol** | 6/3 | euler | fl2va_int8_convrot | balanced 8步 | **-100** |
| `extract-frame` | image.from_video | — | — | — | — | — | 0 |
| `flux-text2image` | image.text2image | — | — | — | flux2_dev_fp8mixed | — | 0 |
| `flux2-img2img` | image.image2image | — | — | — | flux2_dev_fp8mixed | — | 0 |

- **共享资产**：CLIP `qwen3vl_32b_minimax_h3_nvfp4_awq`；视频 VAE `minimax_h3_video_vae_int8_convrot`（生效配置，见 §8）；音频 VAE `minimax_h3_audio_vae_fp32`。**视频自带音频**（AV 模型），音轨随 mp4 输出。
- `priority: -100` 的加速档**永远不会被选为隐式默认**；`preferred` 当前钉在非 Sol 档（有意为之，见 §6.4）。

### LoRA 与「配对规则」（本地三份 LoRA）

| LoRA 文件 | 训练档位 | 配对 shift | 配对分辨率 | 配套采样器 | 用在 |
|---|---|---|---|---|---|
| `minimax_h3_ref2v_turbo_4step_v0.1` | 4 步 | 12/3 | **~544p（832×480）** | res_multistep | ref2v `fast` |
| `minimax_h3_ref2v_turbo_8step_v1.0_768p` | 8 步 | **6/3** | **768p（1344×768）** | euler | ref2v `balanced` |
| `minimax_h3_fl2v_lightx2v_turbo_4step_v0.1` | 4 步 | 12/3 | ~544p | res_multistep | **i2v** `fast` |
| `minimax_h3_fl2v_turbo_8step_v1.0_768p` | 8 步 | **6/3** | **768p（1344×768）** | euler | **i2v** `balanced` |
| （无 LoRA） | 20 步 | 12/3 | 768p | res_multistep | 两条路径的 `quality` |

**LoRA 的 shift/分辨率/步数是不可分割的三元组**：换分辨率就要同时换 LoRA 与 shift，否则画质掉（见 §5.2 实测的不配对格）。

---

## 3. 分辨率阶梯（ref2v `fast` 4 步，16:9 与 9:16）

| 分辨率 | 比例 | 注意力 token（实测算得） | 端到端 | 相对 480p | 每秒成片成本 |
|---|---|---|---|---|---|
| **832×480** | 16:9 | 14.4k | **24.6s** | 1.00× | 4.8s/s |
| **480×832** | 9:16 | 14.4k | **26.6s** | 1.08× | 5.1s/s |
| **1024×576** | 16:9 | 21.2k | **42.1s** | 1.71× | 8.1s/s |
| **1344×768** | 16:9 | 37.2k | **94.8s** | **3.85×** | 18.3s/s |

- **token 计算**：实测两锚点 `1344×768 → S=40005`（含 2816 前缀）、`832×480 → S=15858`（含 1536 前缀）⇒ patch 数 ≈ **0.036 × 宽 × 高**（124 帧时）。其余分辨率由此推算（标注为推算值）。
- **成本超线性**：token 数涨 2.6×，耗时涨 **3.85×** ⇒ 经验指数 **≈ tokens^1.5**。分辨率是**最贵**的旋钮。
- 竖版与横版**同像素数≈同成本**（26.6 vs 24.6s，差 8%，属抖动/分块布局差异）。
- i2v 同分辨率比 ref2v 高约 **6%**（44.2 vs 42.1s @1024×576；26.1 vs 24.6s @832×480）——多一次首帧编码。

---

## 4. 档位阶梯（同分辨率 1344×768，ref2v）

| 档位 | 步数 | LoRA | 采样器 | shift | 端到端 | 每步 | 相对 quality |
|---|---|---|---|---|---|---|---|
| `fast`（非常规用法，见 §5.2） | 4 | 4步 544p | res_multistep | 12/3 | 94.8s | 23.7s | 0.24× |
| **`balanced`** | 8 | 8步 768p | euler | 6/3 | **166.3s** | 20.8s | **0.42×** |
| **`quality`** | 20 | 无 | res_multistep | 12/3 | **396.6s** | 19.8s | 1.00× |
| `quality` + **Sol** | 20 | 无 | res_multistep | 12/3 | **311.2s** | 15.6s | 0.78× |

- **步数近似线性**：768p 拟合 **t ≈ 19s + 18.9s × 步数**（4/8/20 三点误差 ≤2%）。固定项 ~19s = 模型/CLIP 就位 + VAE 解码 + 音频解码 + mp4 封装。
- 单步成本随步数**略降**（23.7 → 19.8 s/步）：蒸馏 LoRA 档要吃 attention 之外的开销，denoise 步数越少固定开销占比越高。
- **同分辨率下"降档"是唯一接近线性的提速手段**：20→8 步省 58%，8→4 步再省 43%（但 4 步在 768p 属不配对，见 §5.2）。

---

## 5. LoRA 与档位的实测组合

### 5.1 合规组合（推荐）
| 组合 | 分辨率 | 端到端 | 画质判定 |
|---|---|---|---|
| ref2v + 4步 LoRA + shift12/3 | 832×480 | 24.6s | 「勉强可用（偏软）」基线档 |
| ref2v + 8步 LoRA + shift6/3 | 1344×768 | 166.3s | 平衡档主力 |
| ref2v / i2v + 无 LoRA 20 步 | 1344×768 | 396.6s / 394.8s | 「干净可用的成片帧」 |
| i2v + fl2v 4步 LoRA | 832×480 | 26.1s | 结构正常 |
| 上述 + Sol（768p） | 1344×768 | 见 §6 | 「可用、可疑点=无」 |
| **PDD nfe=8（无蒸馏 LoRA）** | 1344×768 | **184.7s / i2v 178.8s** | **细节量高于 20 步成片档、噪声地板更低**（详见 §5.3） |
| **PDD + Sol tau1.2** | 1344×768 | **137.3s / i2v 134.1s** | 细节量回落到与成片档持平 |

### 5.2 实测的「不配对」格（**知道代价但别当默认**）
| 组合 | 分辨率 | 端到端 | 画质判定 | 结论 |
|---|---|---|---|---|
| **4 步 LoRA（544p 训练）跑 768p** | 1344×768 | **94.8s** | 「**可用，材质轻微糊化**」（无结构崩坏、无多头多肢、无五官错位） | 可作**构图/动作预演**（比 balanced 快 43%），**不要当成片** |
| i2v 早期用 ref2va base + ref2v LoRA（已修） | 832×480 | 31.0s | 结构正常但非该 base 的最优解 | 已切换 `fl2va + fl2v LoRA`（34.6s，含首次加载） |
| ~~PDD Acc-8Step（Alibaba，Kijai repack）~~ | — | — | 当时失败：`final_layer` 张量尺寸崩坏 | **已推翻**：那是不兼容的第三种 repack 格式 + 当时无 PDD 节点包；换预转换权重 + 专用节点后跑通，见 §5.3 |

---

### 5.3 PDD 8 步（2026-09-09 晚复测）

条件：同参考图 / 同 prompt / 同 seed 42424242 / 1344×768 / 124 帧 / 单卡 Ampere（sm_80）；PDD 走专用节点
（`MiniMaxH3PDDAccApply`，权重放 `models/pdd_acc/`），baseline = 20 步无蒸馏（同条件）。

| 臂 | 配方 | 端到端 | 帧锐度 mean\|∇\| | 噪声地板 p05 |
|---|---|---|---|---|
| baseline | 20 步 · res_multistep · shift 12/3 | 394.4s | 7.243 | 0.131 |
| **PDD** | **nfe=8 · euler · shift 12/3 · 无蒸馏 LoRA** | **184.7s** | **7.986（+10.3%）** | **0.077（更低）** |
| PDD + Sol | + Sol-Attn tau1.2 | **137.3s** | 7.141（−1.4%） | 0.064 |
| 对照 | lightx2v 8 步 768p（现有 balanced） | 170.4s | 5.630（−22.3%） | 0.013 |

i2v（FL2VA）侧同条件：20 步 **392.4s**（锐度 8.137）→ **PDD 178.8s（+7.9%）** → PDD+Sol **134.1s（−6.3%）**。

**结论**：① 8 步 PDD 的细节量在成片档之上、噪声地板比成片档还低 ⇒ 多出来的高频是细节不是颗粒；② 叠加 Sol 后细节回落到成片档水平，但时间降到 137s / 134s（**2.9× 于 20 步**）；③ **收益按能力不同**：ref2v 相对现有 balanced 是 +42%，i2v 只有 +1.5%（i2v 的 768p fl2v LoRA 本身更强）——所以 PDD 在 ref2v 是"balanced 的全面升级"，在 i2v 是"成片档的廉价替代"；④ 单帧/单 seed 结论，未做多镜头一致性验证。完整分析见 `docs/minimax-h3-acceleration-lora.md` §9.9。

---

## 6. Sol-Attn 块稀疏加速（768p 才值得）

环境：第三方节点 `ComfyUI-SolAttn-Ampere`，注册名 **`SolAttnMiniMaxH3`**（+ `SolAttnStats`），纯 `torch.compile(flex_attention)`，**不需要 nvcc**。⚠️ 本栈**必须 `dense_first_percent: 0`**，否则节点把每次调用判为"去噪早期"而**完全不稀疏**（默认 0.2 时 `sol_attn=0`、`s/it` 与原版一致）。

### 6.1 加速矩阵（同 seed 关/开对照）
| 场景 | 分辨率 | token | 基线 | Sol 开 | 加速 | 密度（跳块） |
|---|---|---|---|---|---|---|
| 成片 20 步 ref2v | 1344×768 | 37.2k | 396.6s | **311.2s** | **1.27×** | 0.13–0.16（~6.5×） |
| 成片 20 步 i2v | 1344×768 | 37.2k | 394.8s | **314.7s** | **1.25×** | — |
| 平衡 8 步 tau1.2 | 1344×768 | 37.2k | 167.3s | 136.3s | 1.23× | 0.221–0.247 |
| 平衡 8 步 tau1.5 | 1344×768 | 37.2k | 167.3s | 125.4s | **1.33×** | 0.167–0.190 |
| 平衡 8 步 tau2.0 | 1344×768 | 37.2k | 167.3s | 121.2s | **1.38×** | 0.126–0.159 |
| fast 4 步 | 1024×576 | 21.2k | 42.1s | 40.9s | **1.03×** | — |
| fast 4 步 | 832×480 | 14.4k | 24.6s | 23.8s | **1.03×** | — |
| fast 4 步 i2v | 832×480 | 14.4k | 26.1s | 采样 15.1s | ~1.08%（仅采样） | 0.26–0.29 |

### 6.2 交叉点与饱和
- **交叉点在 25k token 以上**：14.4k / 21.2k 都只有 ~1.03×，37.2k 跳到 1.23–1.38×。⇒ **只有 768p（及更高）值得开**。
- **tau 饱和**：1.2→1.5 端到端 +8%，1.5→2.0 只 +3%（密度再多跳 25% 无效）⇒ 瓶颈不在注意力 FLOPs，**上限 ≈1.4×**。推荐 **tau 1.2**，8 步档要更快用 1.5。

### 6.3 画质（三条证据链）
| 检查 | 结果 |
|---|---|
| 目视（strict 两行判定） | tau1.5「**档位=可用、可疑点=无**」；i2v 成片档 Sol「**可用/无**」；768p tau1.2「干净可用的成片帧」；480p Sol「可用」（基线反被判「勉强可用·偏软」） |
| 高频能量 mean\|∇\|（同 seed） | **成片 20 步：ref2v +2.5%、i2v −1.8%（持平）**；768p 8 步：+23%/+37%/+29%（无糊化）；**480p：−13.8%（偏软）** |
| 像素 diff | 8 步 15.3/255（43% 通道 >8）、成片 ref2v 17.2、成片 i2v 6.4、tau2.0 20.3 → 换轨迹而非崩坏 |
| 音轨 | 各臂 mp4 均含音频 ✓ |

证据链工具：`node e2e-out/sharpness.mjs 基线.png 稀疏.png`（零依赖）。

### 6.4 怎么启用
- **按调用指定**（推荐）：`comfy_render(workflow="minimax-h3-ref2v-8step-sol", mode="balanced", …)` / `"minimax-h3-i2v-sol"`。
- **不要**把 `preferred` 指到 `*-sol`：那会让 480p `fast` 档也走稀疏（实测既无速度又偏软）。
- **同片一致**：⚠️ 开/关 Sol 的采样轨迹不同（同 seed 也不同像素）⇒ **一部片子里必须一致地全用或全不用**，不能逐镜混用。
- **复核**：跑 `minimax-h3-ref2v-sol-stats`，日志看 `[Sol-Attn] sol_attn=… prefix_blocks=… last_density=…`；`sol_attn=0` + `skipped_early` 占满 = 又被 `dense_first_percent` 关掉了。

---

## 7. 换算成真金白银：一条 60 镜短片（每镜 5.2s ≈ 5 分钟成片）

| 方案 | 单镜 | 60 镜总时长 | 备注 |
|---|---|---|---|
| ref2v `fast` 832×480 | 24.6s | **24.6 分钟** | 预演/调 prompt |
| ref2v `fast` 1024×576 | 42.1s | 42.1 分钟 | 中分辨率草稿 |
| ref2v `fast` 1344×768 | 94.8s | 1.6 小时 | 构图预演（材质偏糊） |
| **ref2v `balanced` 1344×768** | 166.3s | **2.8 小时** | 主力档 |
| balanced + Sol（tau1.2） | 136.3s | **2.3 小时** | 省 31 分钟 |
| `quality` 1344×768 | 396.6s | **6.6 小时** | 正式出片 |
| **quality + Sol** | 311.2s | **5.2 小时** | **省 1.4 小时** |

多模态通用换算：**总时长 ≈ Σ(固定开销 + 步数 × 单步成本)**，其中单步成本 ∝ token^1.5、token ∝ 宽×高×帧数。想砍时间，**先降分辨率，再降步数，最后才考虑注意力内核**。

---

## 8. 生效配置（本次基准所依据）

```json
// ~/.dsh/dsh-short-video-studio.json（节选）
{
  "models": {
    "h3RefUnet": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    "h3FlUnet":  "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    "h3VideoVae":"minimax_h3_video_vae_int8_convrot.safetensors",   // int8 加速件（可选）
    "h3AudioVae":"minimax_h3_audio_vae_fp32.safetensors",
    "h3FastLora":  "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    "h3FlFastLora":"minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors"
  },
  "assetOverrides": { "minimax-h3-ref2v": { "vae": "…int8_convrot…" }, "…-8step": {…}, "minimax-h3-i2v": { "unet": "…fl2va…", "fast_lora": "…fl2v…", "vae": "…int8…" } },
  "preferred": { "video.reference2video": ["minimax-h3-ref2v"], "video.image2video": ["minimax-h3-i2v"] }
}
```

- **int8_convrot VAE**：端到端 25.3s vs fp16 27.3s（480p fast），像素 diff 均值 1.878/255、>8 仅 1.503% ⇒ 视觉等价，**省 2.3GB 显存**（常驻 2677MB vs 4965MB）。默认仍是 fp16，int8 为经配置开启的可选加速件。
- **`preferred` 有意不指向 `*-sol`**（理由见 §6.4）。

---

## 9. 陷阱清单（踩过的）

| 陷阱 | 现象 | 真相/对策 |
|---|---|---|
| Sol `dense_first_percent` 默认值 | `s/it` 与原版**一模一样**，看起来"加速无效" | 本栈 sigma 表传参导致 `progress≡0`，默认 0.2 ⇒ 全部回退稠密；**必须 `=0`** |
| Sol 节点名 | `missing_node_type: 'Sol-Attn MiniMax H3'` | UI 显示名 ≠ `class_type`；应为 **`SolAttnMiniMaxH3`** |
| 稀疏开关改变采样轨迹 | 同 seed 画面"不一样" | 即使不稀疏（flex vs SDPA）也差 15.1/255；**同片一致使用**，别逐镜混 |
| 换 base 的首次运行 | i2v 比 ref2v 慢一倍 | 21GB UNet 重载；**只能比热态** |
| 长宽比与"长边" | 以为 9:16 更便宜 | 成本∝像素总数，竖版/横版同价 |
| 步数与 LoRA 不配对 | 4 步 LoRA 跑 768p 出片但糊 | 三元组必须同换（步数/分辨率/shift） |
| `length` 步进 | 任意帧数报错 | 24fps、步进 17；124≈5.17s |
| length 拉长的成本 | 未实测 | token ∝ 帧数，成本按 §7 公式外推（**待实测**） |

---

## 10. 未测 / 待验证

1. **长时长**（`length` 250/372 ≈ 10s/15s）的成本曲线——按 token ∝ 帧数外推未实测。
2. `quality` 档在 480p/1024×576 的表现（本表只测 768p）。
3. **多参考图**（ref_nodes 2–3 张）的额外成本与一致性收益。
4. **音轨听感**比对（只验证了音频链路执行与音轨存在）。
5. Sol 在 i2v `fast` 档 768p（不配对格 + Sol）的组合。
6. Sage Attention（需服务器装 CUDA Toolkit，且与 Sol-Attn 互斥）——在 Sol 已给出成片档 1.25–1.27× 后优先级下降。
7. 25/30 步等中间档位（步数线性规律已由 4/8/20 三点支撑）。

---

## 11. 复现命令

```bash
# ① 一键重取本次基准表（扫 ComfyUI /history，按指纹归类，输出 markdown）
node e2e-out/bench.mjs 100

# ② 清单盘点（各档位的步数/LoRA/shift/采样器/Sol 参数）
node e2e-out/inventory.mjs

# ③ 单跑（走能力注册表，模型无关）
#    成片档 + Sol：comfy_render(capability="video.reference2video",
#      workflow="minimax-h3-ref2v-sol", mode="quality", width=1344, height=768, seed=42424242,
#      length=124, ref_nodes=["<角色卡节点 id>"], prompt="<H3 六段结构>", group="基准矩阵")
#    预演档：workflow="minimax-h3-ref2v", mode="fast", width=1344, height=768

# ④ 画质证据
node e2e-out/pngdiff.mjs 基线中帧.png 待检中帧.png      # 像素差
node e2e-out/sharpness.mjs 基线中帧.png 待检中帧.png    # 高频能量（糊化检测）

# ⑤ 换 tau 重新生成 Sol 变体
node scripts/make-sol-attn-variant.mjs --tau 1.5
```

---

*数据日期：2026-09-09 · 单机单卡实测，不同硬件/ComfyUI 版本会有差异；结论（超线性分辨率成本、768p 以下 Sol 无效、步数线性）应可迁移。*
