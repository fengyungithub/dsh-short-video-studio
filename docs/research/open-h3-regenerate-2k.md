# Open-H3-Regenerate-2K 调研：把 H3 草稿「重生成」到 2K 的开放实现

> 状态：**已落地（首版）**（2026-11-07）—— 能力 `video.regenerate` / 工具 `video_regenerate` / 清单
> `open-h3-regenerate-2k`，实现契约见 [`video-regenerate.md`](../video-regenerate.md)；本文保留选型与实测依据。
> 相关：[`learned-latent-upscale-2k.md`](../learned-latent-upscale-2k.md)（现有 2K 路线 U1）·
> [`2k-acceleration-variants-analysis.md`](../2k-acceleration-variants-analysis.md)（2K 开销结构 / PDD2 修正）·
> [`hires-two-pass-upscale.md`](../hires-two-pass-upscale.md)（插值版两阶段）·
> [`research/sol-h3-vae-ab.md`](sol-h3-vae-ab.md)（快解码器 A/B）·
> [`upscale-latency-optimization-research.md`](../upscale-latency-optimization-research.md)（放大器横评）

## 0. 结论速览

- **是什么**：NVIDIA（Efficient-Large-Model / NVlabs Sana，SoL-Engine 团队，与 MIT 合作）2026-10 开源的
  **H3-Regenerate-2K 替代品**（HF 模型仓建于 10-26，社区 ComfyUI 包 10-28 起出现）——把 H3 768P 草稿（1344×768、121 帧）在 **latent 空间放大**后，
  用 **3 步 Euler 重生成**到 **2560×1440**（也支持 768P / 1080P / 4K、5–15s、任意低分辨率草稿）。
  官方闭源的 H3-Regenerate-2K 只走 API、只收符合规格的 H3 768P 源片；这是第一个可本地跑的同类模块。
- **与现有 2K 路线的本质差异**（本文最重要的判断）：我们现在的 U1 是「**低噪声补细节**」
  （×2 学习式放大 + base 模型 denoise 0.3 / 6 步，保草稿、交付 2688×1536）；
  Open-H3 是「**高噪声重画**」（σ₀=0.909 起、3 步、专用 refiner LoRA，交付 2560×1440）。
  两者共用同一个放大器权重，区别在「二遍重画多少」。前者更保守、后者纹理恢复更强，但身份/口型漂移风险更高。
- **本机已具备 3 件（2026-11-07 已用 `/object_info` 核实，见 §6.2）**：同一份 latent 放大器
  （`minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` 已在 `latent_upscale_models/`）、
  同款快解码器（`sol_h3_vae.safetensors` 6.47 GB ≈ Open-H3 的 `vae_fast/fast_h3_vae_noncausal_24l.safetensors`，接入前核 sha256）、
  带 AdaLN 曲线表的 pruned 基模（ref2va / fl2va convrot，正是 Sharp 曲线分支要读的表）。
  **真正缺的只有 13.7 GB 权重**（合并 LoRA 12.45 GB + Sharp 曲线分支 1.24 GB）**和一个能做 AdaLN 前向补丁的节点包**
  （本机一个 Open-H3 节点都没装）。
- **硬约束**：
  1) 合并 LoRA 内含 **LightX2V FL2VA Turbo**，语义上是 **FL2VA 适配器**——精修段的 base 最好是 FL2VA；
     r2v（Ref2VA）草稿的 2K 精修要么双 checkpoint、要么拆成两段作业（决定性设计点，见 §6）。
  2) 社区节点包的输出尺寸是**固定预设**（768p / 1080p / 2k / 4k，竖屏自动翻转），**没有 1:1**；
     但 ComfyUI 0.44.1 核心已有 `MiniMaxH3LatentUpscaleWithModel`（默认 2560×1440、任意 32 网格）⇒
     1:1 可以靠「核心放大 + 自己做音频 mask」绕开，属未验证区域（refiner 在 1:1 的表现未知）。
  3) 参考实现的音频是 **encoded silence**（官方 FastVideo 端口干脆输出无声 MP4）；社区 ComfyUI 包可以把草稿音轨按 σ=0 锁住。
  4) σ₀=0.909 重画幅度大：社区实测「小狐狸的脸漂向狼」（毛色变深、耳尖丢失），**`start_sigma` 0.8 更贴草稿**。
- **收益（本机 已实测）**：124 帧 / 16:9 / 2K 全量 **557.3 s**（≈9.3 min，暖机、dense、int8 FL2VA、含解码；
  显存峰值 ≈57 GiB，产物 2560×1440 / 24fps / 带源音轨）；对照现有 `-ctx-quality-2k` 端到端
  **2120.9 s**（≈35 min）、`-ctx-quality-pdd2-2k` **1277.8 s**（≈21 min）⇒ 比 U1 快 **3.8×**、比 PDD2 版快 **2.3×**。
  **注意**：NVIDIA 那个 3.9× 是 B200 + MXFP8 + CUDA graph + Sol-Attn 的数字，本机 拿不到；本机数字全部来自 dense 路径。
- **落地方式（已实施）**：讨论后**没有**塞进 `video.upscale` 契约（提示词 / 尺寸来源 / 内容不变性三条承诺冲突），
  而是新开能力 `video.regenerate` + 工具 `video_regenerate(video_node, prompt?, target?, start_sigma?, steps?)`，
  清单 `open-h3-regenerate-2k`（`priority: -30`，不做隐式默认）。契约与图结构见 [`video-regenerate.md`](../video-regenerate.md)；
  选型理由见本文 §6.5（与 upscale 的逐条对比在讨论记录里，结论落在该文档 §4）。

## 1. 它解决的问题：官方两段式里唯一闭源的那一段

MiniMax 官方 H3 系统 = **H3-Context-IR**（托管，闭源）→ **H3-Base**（开源 768P）→ **H3-Regenerate-2K**（闭源，只走 API）。

| | 谁做 | 输入 | 输出 | 开放度 |
|---|---|---|---|---|
| H3-Base | MiniMax 开源权重 | prompt / 参考图 / 首末帧 | 768P 带声音（4–15s、24fps） | ✅ 本仓库已在用 |
| H3-Regenerate-2K | 官方 API | **只收符合 H3-768P 规格的源片**（必须有音轨、24fps、/32、面积 589,824–1,032,192、107–362 帧且步进 17），且**必须重发当时真正送进模型的输入**（含 Context-IR 之后的最终 prompt）；resolution 仅 `2K` | 2560×1440 | ❌ 无权重 |
| **Open-H3-Regenerate-2K** | NVIDIA + MIT | **任意低分辨率草稿**（384P/512P/576P/768P，可来自 LTX / Wan / SANA-Video / H3） | **768P / 1080P / 2K / 4K 原生重生成**，5–15s | ✅ 权重 + 参考代码 + 3 个 ComfyUI 包 + FastVideo 端口 |

官方定位不是「超分」，而是「**用同一段内容在目标分辨率上重新画一遍细节**」——人脸、布料、毛发、树叶在放大后仍然成立。
项目页的关键句：*"Upscaling alone adds no detail. It carries layout, color and motion onto the larger grid; the three diffusion steps draw the surfaces at that size."*
这正好解释了为什么我们现有 U1（denoise 0.3、6 步）在 2K 上「结构对、细节软」：它只按 30% 的噪声幅度补细节。

## 2. 管线与配方

```
草稿（1344×768×121f 或任意低分辨率）
  └─ H3 VAE 编码一次（视频 latent [24, T, 48, 84]）
      └─ H3-Latent-Upscaler（社区 3D 卷积，直接到目标 latent 网格，不解码/重编码）
          └─ 重加噪到 σ = 0.909375 → 3 步 Euler（0.909 → 0.857 → 0.667 → 0），CFG 1
              · base H3（FL2VA）+ 合并 LoRA（refiner + LightX2V FL2VA Turbo + LMS Sharp）
              · 50 条 Sharp AdaLN 曲线分支（B·A·curve(t)，按 t 查 1025×8 表）
              · 音频 latent 锁在 σ=0（参考实现＝编码静音；社区版可锁草稿音轨）
          └─ 解码（发布版 36 层 VAE，或 StreamRender-H3 的 24 层快解码器）
              └─ 裁帧 / 裁行（1080p 1088→1080、4k 2176→2160、121 帧）
```

### 2.1 权重构成（HF `Efficient-Large-Model/Open-H3-Regenerate-2K`）

| 文件 | 大小 | 说明 |
|---|---|---|
| `lora/open_h3_regenerate_2k_lora.safetensors` | **12.45 GB**（FP32，rank 576 / 312 个 linear） | 三个适配器沿 rank 轴拼接合并：**refiner 384/384（step-5000 EMA）+ LightX2V FL2VA Turbo v1.2 128/8 + LMS Sharp v1.0 r64**；合并误差 2.2e-8 |
| `lora/sharp_curve_branches.safetensors` | **1.24 GB** | LMS Sharp 的 **50 条 AdaLN 曲线分支**；不是普通 LoRA，不能塞 `models/loras` 就用标准 loader |
| `vae_fast/fast_h3_vae_noncausal_24l.safetensors` | **6.47 GB** | StreamRender-H3 的 24 层非因果解码器（1.62B，从发布版 VAE 蒸馏） |
| `latent_upsampler/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` | **0.69 GB** | 社区 LBH 3D 卷积放大器（本仓库 2K 清单已在用**同名同文件**） |
| `base_model/` | — | MiniMax-H3（revision `6818f6c`）Diffusers 组件副本，可不下载 |

**本机复用核对**：放大器是**同名同文件**（`minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors`）；
快解码器与我们已装 `models/vae/sol_h3_vae.safetensors` **同名尺寸（6.47 GB）**、同源（StreamRender-H3 24 层非因果），
接入前建议先 `sha256sum` 核一次是不是同一份，避免重复下载 6.5 GB。

**曲线表**：Sharp 分支读 `adaln_t_table`（1025×8，sha256 `c02a6c11…`），它**不从 HF 分发**，而是按字节从
`Comfy-Org/MiniMax-H3` 的 `minimax_h3_ref2va_pruned_int8_convrot` 里读——**我们本机的两个 pruned 基模正好带这张表**
（社区节点支持「用自己的表」并反解 t，fl2va pruned 也覆盖）。

### 2.2 采样配方

| 项 | 值 |
|---|---|
| sigmas（3 步，默认） | `0.909375, 0.857143, 0.666667, 0` |
| sigmas（2 步） | `0.7, 0.494118, 0`（≈30% 更快，**细纹理明显更软**） |
| `start_sigma` | 传 >0 时按 refiner 的 shift-6 规则重算网格（0.8 / 0.7 / 0.6 用于「分辨率阶梯」多次精修） |
| 采样器 | Euler；**CFG = 1**（关闭 CFG，所以每步只有 1 次 transformer 前向） |
| 初始状态 | `(1-σ₀)·upscaled + σ₀·noise`；模型时间 `t = 1 - σ` |
| 帧 / 尺寸 | 草稿帧数 17k+5（121 → 补 3 帧 = 124 = 37 latent 帧；1080p/4k 算整 latent patch 行数再裁回） |
| 4K | **两遍**：先经 2K（保持放大器训练范围内），再 2K→4K |
| 音频 | 参考实现：固定编码静音；社区节点：`silence` / `draft audio (AUDIO 输入)` / `keep latent audio`（H3 AV latent 直接复用），噪声 mask 音频=0 |

### 2.3 质量与「重画」的代价（三方独立观察）

| 来源 | 结论 |
|---|---|
| NVIDIA（项目页 / RefinerBench-150，同为 2560×1440） | VBench 均分 **0.814 vs 官方 API 0.802**（美学 0.676 vs 0.629、成像 0.604 vs 0.569、主体一致性 0.924 vs 0.918；官方在运动平滑/动态度略高）；UniPercept 均分 **60.0 vs 53.4**；盲测 200 判 **87% 偏好本方案** |
| rdh9616（ComfyUI 包作者，实测） | 默认 σ₀.909「重画很多」：一次测试里**小狐狸的脸漂向狼**（毛色深、耳尖丢），布局与运动保持；**关掉曲线分支、甚至 decode→re-encode 也一样** ⇒ 是 σ 的选择，不是分支的锅；σ 0.8 更贴草稿 |
| FastVideo（独立端口，GB200 实测） | 相对草稿 PSNR 19–22 dB（本来就是重画，像素一致度低是预期）；Laplacian 方差 ×1.7–3.3；**闪烁比 1.3–1.5×**（比草稿抖） |

⇒ **产品含义**：这是「细节更强、但更不像原片」的路线。用在短剧里，逐镜身份/口型风险必须靠 `start_sigma` 与抽帧自检兜住。

## 3. 四种落地形态

| | NVIDIA 参考代码 | FastVideo 端口 | ComfyUI 社区三包 |
|---|---|---|---|
| 入口 | `infer.py`（Linux + CUDA 13 + PyTorch 2.11） | `OpenH3Regenerate2KPipeline` / `fastvideo serve`（OpenAI 兼容 API） | 节点 + 示例 workflow |
| 加速 | `standard` / `sol_engine` / `sol_engine_fast`（Sol-Attn、MXFP8、CUDA graph；**需 B200/GB200 级，约 150 GB 显存**） | 只移植 `standard_fwd`（dense BF16），**不含 Sol-Attn / MXFP8 / 快解码器** | 依赖 ComfyUI 原生能力（`BlockSparseAttention` 0.42+ 内置） |
| 尺寸 | 768p/1080p/2k/4k（4k 两遍） | **固定 2560×1440**（服务端只认 `2560x1440` / 124 帧 / 24fps） | 预设 768p/1080p/2k/4k，竖屏自动翻转 |
| 音频 | encoded silence，输出带参数化音轨 | **输出无声 MP4**（`-an`，忽略草稿音轨） | 可锁草稿音轨（σ=0），音轨可原样带回 |
| 依赖 | 参考代码 + 权重 | FastVideo + 权重 | 权重 + LBH 放大器节点；rdh 包另需 `OpenH3RegenLora` 等节点（Apache-2.0） |
| 成熟度（2026-11-07） | 官方，验证在 B200/GB200 | 官方文档齐全，port 明确「只做 dense 对齐」 | 三包均 **2026-10-28/29 创建**：rdh 44★ / Songssx 13★ / 1038lab 8★ |
| 许可 | 权重 MiniMax H3 Community License | 同上（只加载不转售） | rdh **Apache-2.0** / Songssx **MIT** / 1038lab **GPL-3.0** |

**对本仓库的意义**：只有 ComfyUI 形态能进现有 `workflows/*.json` 体系。ComfyUI 三包中：

- [`rdh9616/ComfyUI-Open-H3-Regenerate`](https://github.com/rdh9616/ComfyUI-Open-H3-Regenerate)（Apache-2.0）最完整：
  Diffusers→ComfyUI 的 **312 个 key 映射逐位对齐验证**（`to_q/k/v`→`qkv_proj` 行切片、`to_out.0`→`out_proj`、
  `ff.net.2`→`fc2`、`ff.net.0.proj`→`fc1` 且 **SwiGLU 两半交换**）、曲线分支三种取 t 模式（同表/反解/记录）、
  音频三种模式、快解码器（内存精简前向，2K 5s 峰值 21 GB）、以及在 72 GB 卡上跑通 2K 的实测数据。
- [`Songssx/ComfyUI-OpenH3-Regenerate2K`](https://github.com/Songssx/ComfyUI-OpenH3-Regenerate2K)（MIT）最早，
  但自述「初步适配、高动态画面会融化/闪烁」，**在 RTX 5090 32 GB 上只跑通一次**；曲线分支强制校验 ref2va 表哈希。
- [`1038lab/ComfyUI-Open-H3-Regenerate-2K`](https://github.com/1038lab/ComfyUI-Open-H3-Regenerate-2K)（GPL-3.0）
  一个节点全包（自动下权重、预转 BF16 8.8 GB / r128 1.95 GB、曲线分支、audio lock），但**GPL 传染性**对插件分发不友好。

## 4. 实测数字（区分「官方 B200」「社区 72 GB」「FastVideo GB200」）

### 4.1 NVIDIA 官方（单 B200/GB200，5 s，warm，中位数 3 次）

| 配置 | 放大 | 精修 3 步 | VAE 解码 | 合计 |
|---|---:|---:|---:|---:|
| `standard_fwd`（dense BF16，发布版 VAE） | 1.01 s | 71.27 s | 14.99 s | **87.26 s** |
| `sol_engine_fast` + 发布版 VAE | 1.21 s | 19.65 s | 16.48 s | 37.39 s（2.3×） |
| `sol_engine_fast` + **快解码器** | 1.05 s | 19.75 s | **1.58 s** | **22.45 s**（3.9×） |

- 模块账本：Sol-Attn 一项省 39.99 s（累计 2.80×），MXFP8 → 3.21×，CUDA graph → 3.57×；
- 显存：SoL-Engine 前向 + CUDA graph **约 150 GB**；2 步网格 14.1 s（比 3 步快 ~30%）。

### 4.2 社区 ComfyUI（rdh9616，RTX PRO 5000 Blackwell 72 GB，5 s，int8 FL2VA，Sol-Attn 开）

| 配置 | 精修 | 解码 | 整轮 |
|---|---:|---:|---:|
| 默认（Sol-Attn + 快解码器） | **122 s** | **24 s** | **≈3 min**（冷启 206 s） |
| Sol-Attn + ComfyUI 自带 VAE | 122 s | 50 s | ≈3.5 min |
| dense attention + 自带 VAE | 474 s | 50 s | ≈9.5 min |
| prompt → 768P 草稿（6×16 s）→ 2K | 122 s | 24 s | ≈5 min |

- Sol-Attn 与 dense 输出 PSNR 34.6 dB（肉眼看不出）；快解码器与 ComfyUI 解码器 37.8 dB（无可见差）；
- 快解码器 2K 峰值 21 GB（5 s）/ 45 GB（15 s）；NVIDIA 参考前向 2K 峰值约 71 GB（72 GB 卡会溢到内存，所以社区写了 lean 前向）；
- **NVFP4 基模只省 9%，但皮肤/苔藓细节可见损失**（⇒ 用 int8/bf16 base）。

### 4.3 FastVideo（单 GB200，dense BF16）

| | 放大+编码 | 精修 3 步 | 解码（含拷回主机） | 合计 |
|---|---:|---:|---:|---:|
| 参考 `standard_fwd` | 0.87 | 71.6 | 15.0 | 87.5 s |
| FastVideo | 5.9–10.7 | 69.5 | 25.0 | 107.5 s |

- 与参考的 parity：草稿 latent / 放大 latent **逐位相同**；精修 latent 相对 L2 1.3–3.7%；解码视频 **PSNR 45.2 dB / SSIM 0.993**；
- 口径提醒：**同 seed PSNR 不能用来判质量**——3 步模型对舍入级变化极其敏感（NVIDIA 自己写明了）。

### 4.4 本机（本机 80 GB）实测

**已实测（2026-11-07，首版落地后）**：124 帧 / 16:9 / 2K（2560×1440），同一份 768p 草稿、int8 FL2VA base、
合并 LoRA、dense attention（无 Sol-Attn / MXFP8）：

| 项 | 实测 |
|---|---:|
| 5 帧接线冒烟（冷启，含加载 12.45 GB LoRA） | **32.8 s** |
| **124 帧 2K 全量（暖机）** | **557.3 s**（≈9.3 min） |
| 显存峰值 | **≈57 GiB**（本机 80 GB） |
| 产物 | 2560×1440 / 24fps / 124 帧 / 带源音轨，31.7 MB |

⇒ 相对 U1-2K（2120.9 s）**3.8×**、相对 PDD2-2K（1277.8 s）**2.3×**——比落地前的推算（15–16 min）**快**，
原因是 2K 的实际 token 量比按 16× VAE 口径估算的低（H3 的 DiT 侧是 32 像素 patch：80×45×37 ≈ 133k）。

落地前的估算（保留作口径对照）：按 56 帧纯二遍 6 步 843.9 s（≈140.6 s/前向 @63k token）线性外推，
124 帧 3 步 ≈ 843 s + 解码 30–60 s ⇒ 15–16 min。**实测证明 token 线性外推过于保守**。

**Sol-Attn 已验证（2026-11-09，本机 A800 80 GB）**：原生 `BlockSparseAttention`（不是历史崩服务的第三方 `SolAttnMiniMaxH3`）
在 2K/124 帧上稳定跑通，且收益超预期——3 步采样 **506.2 s → 176.9 s（2.86×）**、整轮 **549.7 s → 220.2 s（2.50×）**
（tau 1.3 再降到 149.7 s / 193.9 s）；与 dense 同 seed 输出 PSNR Y 31.2 dB / SSIM 0.930，闪烁代理反而略低。
清单 `open-h3-regenerate-2k-solattn`（`priority: -31`，不改隐式默认），详见 [`video-regenerate.md`](../video-regenerate.md) §11。
2K 历史上那次崩服务是第三方节点在 `cudaMallocAsync` 下的问题，与核心稀疏注意力无关。

## 5. 与现有 U1 路线逐项对比

| | **U1（现有 `-2k` 家族）** | **Open-H3-Regenerate-2K** |
|---|---|---|
| 放大器 | 同一份 LBH 3D 卷积权重（目标尺寸模式） | 同一份（官方 2K 网格 2560×1440；4K 两遍） |
| 二遍 | base 模型，`BasicScheduler` **6 步 / denoise 0.3** | base + **合并 refiner LoRA**，**3 步 / σ₀ 0.909** |
| 二遍模型 | ref2va 或 fl2va（与首遍同一个） | **FL2VA + LoRA**（Turbo 是 fl2va 版） |
| 重画幅度 | 小（denoise 0.3，只补 30% 噪声幅度） | 大（重画目标分辨率的细节） |
| 交付尺寸 | 首遍 ×2 ⇒ **2688×1536** | **2560×1440**（1080p = 1920×1080；4K = 3840×2160） |
| 长宽比 | 16:9 / 9:16 / **1:1**（图像素量自重） | 16:9 / 9:16；1:1 无预设（核心 `MiniMaxH3LatentUpscaleWithModel` 可绕开，未验证） |
| 帧数 | ≤124（2K 家族上限） | 5–15 s（121–361 帧），**我们 124 帧落在甜点区** |
| 链式续接 | 支持（链上流首遍 latent） | 与链式不相干（精修是单镜后处理），可复用同一首遍 latent |
| 音频 | 二遍 `lock_audio=true`：音频 latent 不参与重采样（保留首遍音轨） | 同样锁死（σ=0）：参考实现填静音、社区节点可 `keep latent audio` 直接复用草稿音轨 |
| 耗时（本机单卡，124 帧） | 2120.9 s（quality）/ 1277.8 s（PDD2） | **557.3 s（实测，3.8× / 2.3×）** |
| 身份/口型风险 | 低（不重画表演） | **中—高**（σ₀ 越大越漂）；σ 0.8 / 0.7 可回退 |
| 画质取向 | 结构稳、纹理软 | 纹理强、可能「换脸」、闪烁 +30–50% |

## 6. 接入本项目的方案

### 6.1 先认清架构差异

官方系统天然是**两个模型、两段作业**：H3-Base（草稿）→ H3-Regenerate-2K（精修，base 是 FL2VA）。
我们现有 2K 家族把它压成**一张图、一个模型**——所以只能做「低噪声补细节」，做不了「高噪声重生成」。
要忠实接 Open-H3，绕不开下面三选一：

| 方案 | 做法 | 优点 | 代价 / 风险 |
|---|---|---|---|
| **A. 同图两遍** | 一张 manifest：首遍（现有 ctx/标准）→ 放大器 → Open-H3 3 步 → 解码 | 零工具改动；latent 直通、无重编码；音频天然可带 | 需要**同一 base**：**i2v 干净**（首遍与精修都用 FL2VA）；**r2v 需要 Ref2VA + FL2VA 双 checkpoint**，本机 80 GB 上双模型 + 2K 激活未验（现有 1:1 已到 ≈73/79 GiB） |
| **B. 两段作业 + latent 交接** | 作业 1 出草稿并 `SaveLatent`；作业 2 用 FL2VA+LoRA 从 latent 精修 | 与官方架构一致；r2v/i2v 都通用；可顺手支持「给外部草稿提 2K」 | 插件要新增 **latent 产物类型 + 第二段作业编排**（现在只有图片/视频/音频/文本），改动面最大 |
| **C. 独立工具 `video_regenerate`** | 输入画布**已存在的视频节点** → 解码/重编码 → 精修 2K | 最贴官方用法（草稿视频 → 2K）；**改动最小**；可直接拿现成成片试 | 多一次 decode→encode；FastVideo 证据：MP4 路线更锐是**把 h264 噪点变成纹理**（Laplacian 180–244 vs latent 路线 84–106，幅度大但来源是编码噪声）⇒ 画质不如 latent 直通 |

**推荐顺序**：**C 先打通链路（1 周内可验证）→ B 做质量正解 → A 只作为 i2v 的省事实现**。
理由：C 能最快拿到「同一草稿、三臂 A/B」的证据（也回答「MP4 交接到底伤不伤」这个关键问题），
而 B 才是和官方对齐的形态；A 在 r2v 上大概率卡显存，收益最小。

**B 已实测（2026-11-07）**：同一草稿（pika ctx 6 步）、同 prompt、同 refine seed，2K 124 帧——
latent 交接 **540.3 s** / 视频交接 **557.2 s**（**快 3.0%**，算上省掉的上传约 **4.5%**）；
两臂放大后的 latent 相对 L2 **0.182**（h264+VAE 往返确实改了 18%），但 1:1 眼判差异很小。
清单：`…-pika-solattn-solvae-latent`（草稿段，存 latent）+ `open-h3-regenerate-2k-latent`（质量档精修段），
均为 `internal: true` 实验清单；完整数据与结论见 [`video-regenerate.md`](../video-regenerate.md) §9。

### 6.2 本机现状核查（2026-11-07，直接查 `/object_info`）

| 项 | 状态 |
|---|---|
| ComfyUI | **0.44.1**，`cuda:0 NVIDIA 本机单卡`（`vram_total` 85.1 GB）、RAM 540 GB |
| `BlockSparseAttention`（sol-attn 内置） | ✅ 已有（与 rdh/官方默认同一节点，参数可照抄：tau 1.2 / start 0 / end 0.9 / dense `0,1,49`） |
| 学习式放大器（LBH 3D） | ✅ `MinimaxH3LatentUpscaler3D` + `MinimaxH3LatentUpscaler3DRefineHandoff`，权重 `minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` 已在 `latent_upscale_models/` |
| **ComfyUI 核心**放大节点 | ✅ **新增发现**：`LatentUpscaleModelLoader` + `MiniMaxH3LatentUpscaleWithModel`（samples + width/height，**默认就是 2560×1440**，任意 32 对齐尺寸）⇒ 放大不必依赖 rdh 的 `OpenH3RegenUpscale`（它只认预设），**为 1:1 / 任意比例留了口子** |
| 快解码器 | ✅ `sol_h3_vae.safetensors`（6.47 GB）已在 `vae/`，与 Open-H3 的 `vae_fast` 同款（接入前核 sha256） |
| 基模 | ✅ `minimax_h3_fl2va_pruned_int8_convrot` + `minimax_h3_ref2va_pruned_int8_convrot`（都带 AdaLN 曲线表）、`qwen3vl_32b_minimax_h3_nvfp4_awq` |
| Open-H3 节点包 | ❌ `OpenH3Regen*` / `AILab_OpenH3_*` **均不在 object_info**（三包一个都没装） |
| Open-H3 权重 | ❌ `open_h3_regenerate_2k_lora` / `sharp_curve_branches` 都不在 `loras` 列表 |

⇒ **接入成本 = 13.7 GB 权重 + 一个节点包**（rdh 或 1038lab），放大与解码可以全部复用现成件。
音频 mask 这一项仍需节点包：核心有 `SetLatentNoiseMask`，但它对 H3 的 **nested AV latent** 是否按路复用未验证
（rdh 的 `OpenH3RegenRefineLatent` 是显式构造 `NestedTensor(video, audio)` + 分开的 mask 解决的）。

### 6.3 需要的资产 / 节点 / 契约（方案 C 为例）

```jsonc
// 能力：video.regenerate（新）或先在脚本层直连；实现由配置解析
"assets": {
  "unet":        { "default": "minimax_h3_fl2va_pruned_int8_convrot.safetensors" },
  "clip":        { "default": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" },
  "vae":         { "default": "minimax_h3_video_vae_fp16.safetensors" },   // 编码草稿
  "vae_decode":  { "default": "sol_h3_vae.safetensors" },                   // 已有：快解码器
  "latent_upscaler": { "default": "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors" }, // 已有
  "regenerate_lora": { "default": "open_h3_regenerate_2k_lora.safetensors" },      // 新增 12.45 GB
  "sharp_curves":    { "default": "sharp_curve_branches.safetensors" }             // 新增 1.24 GB
}
```

图中节点（对应 rdh9616 包，Apache-2.0）：

```
LoadVideo → GetVideoComponents → OpenH3RegenPrepareDraft(768p, max_frames=<交付帧数>)
→ VAEEncode → 放大（三选一：OpenH3RegenUpscale(预设) / LatentUpscaleModelLoader+MiniMaxH3LatentUpscaleWithModel(核心, 任意 32 网格) / MinimaxH3LatentUpscaler3D）
→ OpenH3RegenRefineLatent(audio_mode=draft audio)     // 音频 mask=0、锁在 σ0；也用得上 GetVideoComponents 的 AUDIO
→ UNETLoader(fl2va) → OpenH3RegenLora(lora + curves + curve_table)
→ OpenH3RegenSigmas(steps=3 | start_sigma=0.8) → RandomNoise → KSamplerSelect(euler)
→ BasicGuider(CLIPTextEncode 文本条件, CFG=1) → SamplerCustomAdvanced
→ OpenH3RegenFastVAEDecode / VAEDecode(int8)
→ OpenH3RegenFinish(裁帧) → CreateVideo（音轨回接）→ SaveVideo
```

（`curve_table` 默认指 **ref2va pruned**（参考表）；指本模型自己的 pruned checkpoint 也行——节点会反解出 t，见 §3。）

要点：

- **文本条件**：精修用**纯文本**（官方就是这么做的），不要再塞角色卡/场景卡——身份由草稿承载。
  现有 r2v 图的 `MiniMaxH3ReferenceToVideo` 条件不能直接复用，要多挂一个 `CLIPLoader + CLIPTextEncode`。
- **草稿编码**：参考实现用 FP32 VAE 采样后验（`--vae-seed` 42）；我们出片链路里编码本来就走
  `minimax_h3_video_vae_int8_convrot`，直接用同一份即可——编码阶段的轻微扰动会被 σ₀0.909 的重加噪吃掉。
- **音频回接**：草稿音轨要么从草稿视频里 `GetVideoComponents` 取，要么（方案 A/B）直接复用首遍 AV latent 的音频
  （`keep latent audio`）⇒ 零重编码、零漂移。
- **`requiresNodes`**：`OpenH3RegenLora` / `OpenH3RegenRefineLatent` /（放大三选一：`OpenH3RegenUpscale` 或核心
  `LatentUpscaleModelLoader` + `MiniMaxH3LatentUpscaleWithModel` 或已装的 `MinimaxH3LatentUpscaler3D`）/
  `LoadVideo` / `GetVideoComponents` ⇒ 缺包时注册表显式「缺节点」，不静默换实现。
- **尺寸**：16:9 → 2560×1440；9:16 → 1440×2560。**1:1 用核心放大节点按 32 网格自算**（`2560×2560` 之外的像素量要单独算账），
  但 audio-mask 仍要节点包，**属于未验证区域**。
- **门禁**：这是**后处理能力**（无 prompt 生成的新镜头），应与 `video_upscale` / `video_interpolate` 同待遇——
  不参与「逐镜生成自检门」，但产物仍要抽帧核对（身份漂移、字幕被重画）。若走 `video.regenerate` 新能力，
  要把它加进 pre-execute 的「后处理白名单」，否则会被逐镜自检门误拦。
- **镜头表一致性门**：这类实现没有 `Sxx` 生成、`length` 由源片决定 ⇒ 与 upsert 镜表校验无交集，需在门里显式跳过。

### 6.4 清单/档位怎么摆

- 与 PDD / Pika / Sol-H3-VAE 一样：**新增清单 `priority < 0`，不进隐式默认**，在设置页「新增策略」里显式挑；
- 2K 家族已经有一组 `...-2k` 清单，Open-H3 版建议独立命名（如 `...-2k-regen`），**不要覆盖现有 U1**——
  两者是「稳 / 锐」的取舍，不该互斥替换；
- `estSeconds` 按 §4.4 的 本机实测填（557 s 含解码，124 帧暖机）；换卡/换帧数后要重测。

## 7. 风险登记

| # | 风险 | 证据 | 处置 |
|---|---|---|---|
| 1 | **生态极新** | 三个 ComfyUI 包均创建于 2026-10-28/29，最高 44★；FastVideo 端口自述只对齐 dense 路径 | 只依赖 rdh（Apache-2.0 且验证最全）；把节点包当「可选加速件」，缺了就不显示可用 |
| 2 | **LoRA 是 FL2VA 适配器** | 合并里含 LightX2V **FL2VA** Turbo；官方 reference base 是 FL2VA | r2v 草稿的 2K 精修必须换 FL2VA 模型（双 checkpoint 或两段作业），**不要**把 LoRA 硬贴 Ref2VA |
| 3 | **σ₀.909 重画 → 身份/口型漂移** | 社区实测「狐狸→狼」，且与曲线分支无关；`start_sigma` 0.8 更贴 | 默认给 `start_sigma` 开关（0.909 / 0.8 / 0.7）；逐镜抽帧核角色一致性；口型由人工听核 |
| 4 | **闪烁 +30–50%** | FastVideo 对三种草稿都测得 1.3–1.5× 闪烁比 | 拼接前逐镜看片；必要时降 `start_sigma`；与现有 PDD2-2K 对比同镜 |
| 5 | **MP4 交接放大编码噪点**（方案 C） | FastVideo：MP4 路线比 latent 路线锐但 PSNR 仅 24–27 dB，能量来自 h264 伪影 | 首选 latent 直通（方案 A/B）；方案 C 只做验证/兜底 |
| 6 | **尺寸预设限制** | 社区包只认 768p/1080p/2k/4k，无 1:1（核心放大节点可出任意 32 网格，但音频 mask 仍要节点包） | 2K 家族先只声明 16:9 / 9:16；1:1 待核心节点路径验证后再开 |
| 7 | **本机 上收益远小于 B200** | 3.9× 依赖 MXFP8 + CUDA graph + Sol-Attn；本机 拿不到 | 预期 ≈1.3–2.2×，主要价值在**画质**而非速度；Sol-Attn 作为第二实验变量 |
| 8 | **显存** | 官方 ≈150 GB（B200）；社区 72 GB 卡实测；现有 2K 1:1 已到 ≈73/79 GiB | 本机 80 GB 只跑 16:9 / 9:16；1:1 与长片先不做 |
| 9 | **许可** | 权重 MiniMax H3 Community License（地域/用途/再分发条款）；节点包 Apache/MIT/GPL 不一 | 不随插件分发权重；用户自备；优先 Apache 的 rdh，避免 GPL（1038lab） |
| 10 | **PSNR 不可作判据** | NVIDIA 明说 3 步输出对舍入级变化极敏感；社区同样用肉眼 + Laplacian | 评估用抽帧目检 + Laplacian/闪烁/有效宽度三件套（本仓库已有脚本） |

## 8. 若立项：验证计划（最小闭环）

1. **冒烟**（纯逻辑，可进 `npm run smoke`）：清单加载 / `requiresNodes` 缺失时置灰 / 资产槽齐备 / 尺寸与帧数守卫；
2. **一镜三臂 A/B**（本机单卡，16:9，124 帧，同一 768P 草稿、同 prompt、同 seed 的 refine 噪声）：
   - A：现有 `-ctx-quality-2k`（denoise 0.3 / 6 步，2688×1536）
   - B：Open-H3 3 步 σ₀.909（2560×1440）
   - C：Open-H3 3 步 σ₀.80
   指标：抽帧目检（人脸/手/小字/纹理）、Laplacian 方差、闪烁比、`analyze-2k-detail` 有效宽度、
   与草稿的身份相似度（有现成抽帧就用眼睛，别只信 PSNR）；**音频/口型必须人工听核**；
3. **r2v 与 i2v 各一镜**：验证「LoRA 贴 FL2VA、草稿来自 Ref2VA」这条跨模型链路是否成立；
4. **竖屏一镜**：1440×2560 走通，确认 `OpenH3RegenFinish` 的裁行逻辑；
5. **成本**：节点级计时（现有 `/ws` 方法），把 本机 的「精修 3 步 / 解码」拆开记，替换 §4.4 的推算；
6. 通过后再选 A/B/C 方案落清单；不通过则文档结论写清「不值得」，避免重复调研。

## 9. 参考

**上游（NVIDIA / 权重）**
- 项目页 — <https://nvlabs.github.io/Sana/Open-H3-Regenerate-2K/>
- 权重（HF）— <https://huggingface.co/Efficient-Large-Model/Open-H3-Regenerate-2K>
- 参考代码 — <https://github.com/NVlabs/Sana/tree/sol-engine/models/Open-H3-Regenerate-2K>
- 官方闭源 API 对照（输入规格 / 只支持 2K）— <https://platform.minimax.io/docs/api-reference/video-generation-v2-regeneration>
- 报道（中文，含 3.9× 与评测口径）— <https://www.qbitai.com/2026/10/506743.html>

**独立端口**
- FastVideo（dense 对齐 + NVFP4 解码器 + MP4/latent 交接实测）— <https://github.com/hao-ai-lab/fastvideo/blob/main/docs/inference/open_h3_regenerate_2k.md>

**ComfyUI 社区包**
- rdh9616（Apache-2.0，验证最全）— <https://github.com/rdh9616/ComfyUI-Open-H3-Regenerate>
- Songssx（MIT，最早，高动态不稳）— <https://github.com/Songssx/ComfyUI-OpenH3-Regenerate2K>
- 1038lab（GPL-3.0，一键全包 + 自动下载）— <https://github.com/1038lab/ComfyUI-Open-H3-Regenerate-2K>

**本仓库相关**
- 现有 2K（U1）路线 — [`learned-latent-upscale-2k.md`](../learned-latent-upscale-2k.md)
- 2K 开销结构 / PDD2 修正版实测 — [`2k-acceleration-variants-analysis.md`](../2k-acceleration-variants-analysis.md)
- 放大器横评（含官方 2K Regenerate 旧口径）— [`upscale-latency-optimization-research.md`](../upscale-latency-optimization-research.md)
- 快解码器（= Open-H3 的 `vae_fast`）A/B — [`sol-h3-vae-ab.md`](sol-h3-vae-ab.md)
