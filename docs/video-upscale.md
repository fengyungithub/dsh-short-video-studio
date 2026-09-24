# 视频超分（U3）：像素空间放大

> 面向「已经生成的片段提分辨率」这条路：输入是**画布上已有的视频**，输出是它的 ×2 / ×4。
> 与「生成内两阶段放大」（U1，见 [`learned-latent-upscale-2k.md`](learned-latent-upscale-2k.md)）是两条不同的路线，
> 取舍见 §6。全部数字都是本机 A800 实测（2026-09-23），不是估算。

---

## 1. 它是什么 / 不是什么

| | 说明 |
|---|---|
| 能力 | `video.upscale`（注册表里的一个能力，与 generation 能力并列） |
| 工具 | `video_upscale(video_node, tier?, workflow?, target_width?, chunk_frames?, …)` |
| 内置实现 | 像素链路：`video-upscale-x2`（`RealESRGAN_x2.pth`）×2、`video-upscale-x4`（`RealESRGAN_x4.pth`）×4；扩散式：`video-upscale-seedvr2-3b`（SeedVR2 3B，见 §6.5） |
| **不是**生成 | 输入没有提示词。像素链路**没有任何采样器**；`video-upscale-seedvr2-3b` 是**一步扩散恢复**（有 KSampler，但没有文本条件）。两者都**完全不碰 H3**（不占 H3 的 token，也不受 768p 原生上限约束） |
| 输入 | 画布上的视频节点（拼接产物、生成产物、外部导入的都可以） |
| 输出 | 同帧数、同 fps、同音轨的 mp4（**音轨从不经过模型**） |

**逐帧 CNN** 是最重要的性质，它决定了两件事：

1. **代价线性**：5.4K ≈ 2.2–2.6 s/帧，几乎与帧数成正比（H3 的 latent 精修是超线性的：帧数 ×2.21 → 耗时 ×6.2）。
2. **天然可分块**：任意帧切点都安全 ⇒ 长片可以分段超分再拼回（H3 做不到，链式续接要求 latent 连续）。

---

## 2. 图与清单（7 个节点，写在代码里而非模板 JSON）

```
1 LoadVideo(file=${source_video})                  ← 源片先上传到 ComfyUI input 目录
2 GetVideoComponents                               → images(0) / audio(1) / fps(2)
3 UpscaleModelLoader($assets.upscale_xN)
4 ImageUpscaleWithModel(model=3, image=2.images)    ← 唯一干活的节点：像素空间 ×N
5 ImageScale(width=${out_width}, height=${out_height}, area)   ← 收敛到交付尺寸
6 CreateVideo(images=5, fps=2.fps, audio=2.audio)   ← 音轨原样带回
7 SaveVideo(mp4/h264)
```

* 清单由 `scripts/make-upscale-manifests.mjs` 生成（**没有单独的模板层**）：生成类的图分辨率是图结构的一部分
  （`resolutionLock`），而超分的图分辨率**跟着输入视频走**，清单只能声明尺寸来源 —— 7 个固定节点写在代码里比维护模板更不易失同步。
* 校验（`lib/manifest.js`）：`capability=video.upscale` **必须**声明尺寸来源（`upscale.sizing` + `factor` / `shortSide`），
  且**不得**声明 `resolutionLock`（两者的尺寸语义互斥）。两个枚举都 fail-closed。
* 交付尺寸由 runner 算出后注入（`out_width/out_height`，短边形态还会注入 `out_short_side`）；
  `source_video` 是上传后的 ComfyUI 文件名；`prefix` 决定输出路径。
* **模型可换**：资产槽 `upscale_x2` / `upscale_x4`（设置页/env `DSH_SVS_UPSCALE_X2`、`DSH_SVS_UPSCALE_X4` 覆盖）。
  **倍率写死在权重里** ⇒ 换权重必须换同倍率的文件，否则交付尺寸与 `factor` 声明不符。要换倍率就复制一份清单改 `factor`，
  或在配置页「导入你的 workflow」自己加一份（`convertComfyExport` 支持）。

---

## 2.1 尺寸来源与分块归属：两类实现都能进这个能力（契约，2026-09-24 扩展）

`video.upscale` 现在按两个维度描述实现。**两者都必须声明**（写错 fail-closed，不静默退化）：

| 字段 | 取值 | 含义 | 谁会这么声明 |
|---|---|---|---|
| `upscale.sizing` | `factor`（缺省） | 交付 = 源尺寸 × `factor`；`target_width` 只能**事后**收敛（超出倍率的量只是插值，会告警） | 像素空间逐帧 CNN（RealESRGAN 系，本仓库内置的两份） |
| | `short-side` | 交付由实现的**目标短边**（`shortSide`，可选 `maxEdge` 上限）推导；**不得**再声明 `factor`（倍率是推导出来的） | 扩散/恢复类模型（如 SeedVR2 的 `resolution` = 目标短边） |
| `upscale.chunking` | `caller`（缺省） | 逐帧独立 ⇒ runner 可按像素-帧预算自动分块再拼回（切点不影响结果） | 像素空间 CNN |
| | `internal` | 模型自带跨帧时间先验（4n+1 batch / temporal_overlap / 内部 tiling）⇒ runner **不**自动分块 | 扩散/恢复类模型 |

四条硬约束（前三条校验器会拒，第四条是**运行时** fail-closed）：

1. `sizing='short-side'` ⇒ **必须**声明 `params.out_short_side`。没有这个注入点，runner 解析出的尺寸落不到模型上，
   画布记录的 `width/height` 会与实际交付悄悄不一致（拼接一致性判据接着错）。
2. `sizing='short-side'` ⇒ **不得**声明 `factor`。倍率由短边推导，写死一个数会与实际交付不符。
3. `chunking='internal'` ⇒ 超预算时 runner 只发告警、**不切块**（切开会打断它自己的时间窗）；
   调用方显式传 `chunk_frames=` 仍照办，但会警告可能出接缝。
4. `chunking='caller'`（缺省）⇒ 图必须保持「**1 LoadVideo → 2 GetVideoComponents → …**」这条头，且帧从源节点
   直接往下走（可以再经过预处理链）。切块的刀口是**按引用**接的（把每个吃 `[2,0]` 的输入改到切口上），
   接不上时 `sliceUpscaleGraph` **直接抛错**——2026-09-24 真机事故就是这么暴露的：当时只认
   `ImageUpscaleWithModel` 这个类名，换一种逐帧实现（`ImageScale`）就静默接不上，每块仍吐整片，
   拼回去 **372 帧 = 124×3**。现在改成通用接线 + fail-closed，错误信息会给出两条出路（保持这条头 / 改声明 `internal`）。

**`target_width` 在两种形态下的含义不同**（这是这次扩展最实质的一处）：`factor` 形态是「先按倍率渲染，再缩到目标」
（超出倍率能力只是插值）；`short-side` 形态是「**反解短边回注实现**，让它按目标渲染」——
后者避免「渲染得更大再降采样」，而 §4.2 已实测降采样会削掉合成出来的高频（5376→4032：2352→2268 px）。

短边形态的尺寸算法：短边按 `align` 对齐 → 长边按源片比例推导再对齐 → 若 `maxEdge>0` 且长边超出则等比压回（带告警）。
横版时 `target_width` 是**长边**（短边 = 目标宽 ÷ 源片比例）；竖版时它本身就是短边。

---

## 2.2 多实现怎么切换（同一个工具，换的是实现）

`video.upscale` 下**可以有多份清单**（现在 2 份：`video-upscale-x2` / `-x4`；将来加入 SeedVR2 这类扩散/恢复实现就是第 3 份）。
**一份清单 = 一个工作流**：各自独立的图、资产槽、`requiresNodes`、`estSeconds`、`priority`；一次调用只解析出其中一份，
产物是自足的（画布 `params` 记下 `workflow` / `model` / `sizing` / `assets`）。所以它们是**可共存的平级实现**，不是「一个工作流的两个模式」。

切换有三个入口（都走同一套 `resolveTieredManifest`，优先级从高到低）：

| 入口 | 怎么用 | 粒度 | 说明 |
|---|---|---|---|
| **① 显式 `workflow=`** | `video_upscale({ video_node, workflow: 'video-upscale-x4' })` | **逐次调用** | 最高优先。与 `tier` 不符会**显式报错**，不静默跨档替换；能力不符、id 不存在同样报错 |
| **② 档位 `tier=`** | 把不同实现放在不同档（如 U3 放 `quality`、另一实现放 `balanced`），请求哪个档就用哪个 | 逐次调用 | 同档多份实现时按 `priority` 降序取首个；不指定档位 ⇒ 默认 `quality` |
| **③ 设置页**（逐档下拉 / 命名策略） | 每个能力一张卡：逐档下拉选实现（写入 `tiers.<capability>.<tier>`），或「新增策略」存一套档位映射；选中策略即整套切换 | **全局默认** | 卡上那行「实际使用：xxx」就是当前生效的实现；缺节点的实现显示 `✗ 缺节点 …`，不会被静默选中 |

切换的**粒度是「逐镜 / 逐次调用」**，不是整片级：

* `video_concat` **不检查实现、也不检查分辨率**（它只要求 ≥2 个已就绪的 video 节点）——
  「各段交付尺寸必须一致」是**实践约束**（ffmpeg 后端混分辨率会失败或产出异常），不是被校验的判据 ⇒
  混用两种实现时，先把它们的交付尺寸对齐（可用 `target_width` 收敛到同一口径）；
* **两套实现的数字不可直接比**：`estSeconds` 口径不同（逐帧 CNN 近似线性 vs 扩散模型的 batch/tiling 依赖），
  产物口径也不同（`sizing='factor'` 记 `factor`；`'short-side'` 记 `shortSide` 且 `factor` 为 null）——
  画布标题也会跟着变（「超分 ×2」vs「超分 短边 1088」），这是如实反映，不是 bug。

**当前状态**：SeedVR2 那类实现**尚未加入**（等真机验收：节点是否已装、短边注入后模型是否真按该尺寸渲染）。
加进 `workflows/` 之后上面三条切换路径立刻可用，**工具签名不变**——用户始终只看到一个 `video_upscale`。
这正是 §2.1 那次契约扩展的目的：把「尺寸从哪来 / 显存归谁管」变成可声明的，从而让异质实现能同台。

---

## 3. 尺寸语义（三个反直觉点）

1. **交付尺寸 = 源尺寸 × factor**（`sizing='factor'` 形态），不是画布比例，也不是调用方传的 `width/height`（与生成类相反）。
2. `target_width` 收敛时会**按 32 对齐**（`Math.round(w/32)*32`），高度按原比例同步再对齐。
   超过模型倍率能给的尺寸仍会执行，但会告警「超出部分只是插值，没有新信息」。
3. **比例永远跟源片**：H3 族是 **1.75:1**（1344×768），所以「4032 宽」= **4032×2304**，
   **不是** 16:9 的 3840×2160。把 4032×2304 叫「4K 级」只是宽度口径，别再写成 16:9。

| 源 | ×2 | ×4 |
|---|---|---|
| 832×480（fast 首遍） | 1664×960 | 3328×1920 |
| 1344×768（原生 768p） | 2688×1536 | 5376×3072（缩到 4032 宽 = 4032×2304） |
| 2688×1536（U1 的 2K） | 5376×3072（缩到 4032 宽 = 4032×2304） | — |

---

## 4. 实测账本（A800 · 124 帧 ≈ 5.17s · `scripts/probe-4k.mjs` + `scripts/e2e-upscale.mjs`）

### 4.1 耗时与交付（同一条原生 1344×768 源片）

| 路线 | 交付 | 耗时 | 说明 |
|---|---|---|---|
| 原生 → ×2 | 2688×1536 | **155.7s** | 最便宜的「真 2K 交付」 |
| 原生 → ×2 → area 0.75 | 2016×1152 | 65.2s | 交付像素少一半多，所以快 |
| 原生 → ×4 → area 0.75 | 4032×2304 | **241.3s** | 一趟从原生到 4K |
| U1 的 2K → ×2 | 5376×3072 | 317.5s | 源片本身已被 U1 提过细节 |
| U1 的 2K → ×2 → area 0.75 | 4032×2304 | **261.6s** | 混合路线（U1 打底 + U3 收尾） |
| U1 的 2K → ×2，**248 帧** | 5376×3072 | **551.4s** | 压测：无 OOM（产物张量 ≈25 GB） |
| 原生 → ×2，`lanczos` 下采样 | 4032×2304 | 571.7s | 对照：同尺寸 `area` 只要 261.6s，**lanczos 白贵 310s 且指标无收益** ⇒ 默认 `area` |

### 4.2 有效分辨率（自校准频谱尺子 · 2026-09-23 同一会话重跑，六臂对齐）

口径：全部对**同一条原生 1344×768 基线**标定（基线读数被校准回 1344，实测落在 1344–1411，即尺子有 ±5% 抖动）；
阈值随网格不同（2K 网格 1.74e-3 / 4032 网格 7.75e-3 / 5376 网格 2.25e-2），所以**跨网格只比"增益倍数"**，不比绝对像素。

| 臂 | 交付 | 耗时 | 有效宽 | 增益 | 平坦区闪烁比 | 平坦区锐度（缩回输入网格） |
|---|---|---|---|---|---|---|
| 原生（输入本身） | 1344×768 | — | 1344 | ×1.00 | — | 68.3 |
| U1 单独（生成内两阶段） | 2688×1536 | 1671.2s | 1915 | ×1.425 | 0.972 | 93.3 |
| **原生 → U3 ×2** | 2688×1536 | **155.7s** | **2218** | **×1.65** | 0.958 | 193.9 |
| U1 2K → U3 ×2 | 5376×3072 | 317.5s | 2352 | ×1.667 | 0.949 | 192.5 |
| 原生 → U3 ×4 → 0.75 | 4032×2304 | 241.3s | 2671 | ×1.963 | 0.986 | **362.4** ⚠ |
| U1 2K → U3 ×2 → 0.75 | 4032×2304 | 261.6s | 2268 | ×1.667 | 0.947 | 197.0 |

怎么读这张表（**别只读"有效宽"那一列**）：

1. **同网格、无二次缩放的对比最可信**（2K 那两行）：`原生→U3×2` 增益 ×1.65 > U1 单独 ×1.425，
   而耗时是 **1/10.7**。这是本报告最硬的一条结论。
2. **尺子奖励"高频能量"，不奖励"干净"**：U1 单独那行的平坦区锐度只有 93.3（输入 68.3），
   说明 U1 的二遍（denoise 0.3）输出**明显更平滑**；U3 把平坦区推到 193.9。平滑不等于失真，
   能量高也不等于细节多 ⇒ 两者都得看 §4.3 的眼判图。
3. **4032 两行的排序不可信**：`原生→×4→4032` 读数更高（2671 vs 2268），
   但它的平坦区锐度 **362**（输入的 5.3×）强烈提示**过锐/振铃**——读数是"造出来的高频"而不是"真细节"。
   这一格**必须眼判**，不能拿数字下结论。
4. **降采样会削掉合成的高频**：同为 U1 打底的 ×2，5376 原样交付 2352 px，缩到 4032 后 2268 px ——
   要极限细节就别缩，但要多花 55.9s 且文件更大。
5. **时间稳定性全部过关**：平坦区闪烁比 0.947–0.986（≤1 = 不比输入更闪）⇒ 逐帧超分没有引入帧间抖动。

### 4.3 眼判材料

* `e2e-out/4k/compare-4arms-1to1.png`：四臂（原生 / U1 2K / 原生→×4 4032 / U1→×2 4032）**同归一化区域**的
  ①1:1 原像素、②缩到同一显示宽 两排对照。生成器 `scripts/compare-crops.py`（可换帧号与区域）。
* **已知瑕疵**：5.4K 路径块效应指标 1.191（偏高），是一次放大 16.5M 像素/帧的代价；
  要更干净就收敛到 4032，或分两步（先 ×2 再 ×2）。

## 5. 显存与分块（长片怎么活下来）

产物张量必须**常驻**：`帧数 × 宽 × 高 × 3 × 2B`（fp16 口径）——
5.4K 约 **99 MB/帧**，4K 约 **56 MB/帧**。容器里没有可用的分块 SR 节点
（`IterativeImageUpscale` 需要 Impact 的 `UPSCALER` + VAE，语义不匹配），所以只能靠**分块**。

实测包线：**248 帧 × 5376×3072 = 4.09e9 像素-帧一次通过（无 OOM）**。据此设安全阀（`lib/upscale.js`）：

* 告警/分块线 `PIXEL_FRAME_WARN = 3.0e9`（留在已验证包线以内）
* 每块预算 `PIXEL_FRAME_CHUNK = 2.0e9` ⇒ 5.4K 每块 ≈121 帧、4K 每块 ≈215 帧
* **这条安全阀只对 `chunking='caller'` 的实现成立**（逐帧独立）。声明 `'internal'` 的实现
  （自带跨帧时间先验，如 SeedVR2）超线时 runner 只发告警、**不切块**——切开会打断它自己的时间窗；
  调用方显式传 `chunk_frames=` 仍照办（显式意图优先），但会警告可能出接缝。决策是纯函数
  `planUpscaleChunks()`（有单测），编排留在 runner。

分块的图改法（`sliceUpscaleGraph`，纯函数、有单测）：

```
2 GetVideoComponents ─┬─ ImageFromBatch(batch_index=start, length=frames) → 4 放大
                      └─ TrimAudioDuration(start=start/fps, duration=frames/fps) → 6 CreateVideo
```

**必须切音轨**：不切的话每块都会配整条音轨，拼回去声音就叠了。
切完再把各块（下载→上传）用 `buildConcatGraph` 拼回一条（纯 ComfyUI 节点链路，本机无需 ffmpeg）。

实测：同一 124 帧源片，单块 261.9s → 分 4 块 290.3s（**+11%**），交付仍是 4032×2304、
**帧数守恒 124**（证明切帧/切音轨没丢没错位）、音轨保留。
可用 `chunk_frames=` 手动指定；告警文案会区分「超预算自动分块」和「调用方指定分块」。
切块的接线是**按引用找**的（不认节点类名）：任何吃源帧 `[2,0]` 的输入都会被改到切口上，找不到消费者就抛错
（见 §2.1 第 4 条）；切完必须**帧数守恒**——`scripts/e2e-upscale.mjs --chunk=40` 与
`scripts/e2e-upscale-shortside.mjs` 的 C 臂都把这一条当真机判据。

---

## 6. U1（生成内两阶段）× U3（独立超分）：怎么选

| 你要什么 | 用什么 | 代价（124 帧） | 理由 |
|---|---|---|---|
| **2K 交付**（2688×1536） | **原生 → U3 ×2** | **155.7s** | 有效宽 ×1.65 > U1 的 ×1.425，便宜 10.7× |
| 2K 交付，且必须**在生成图内**完成 | U1（`-ctx-*-2k`，可叠链式续接） | 620–2700s（分档） | 放大后的 latent 还能被第二次 H3 采样消费；无需"先出片再上传" |
| **4K 级交付**（4032×2304） | **原生 → U3 ×4**（或 U1 2K → U3 ×2） | 241.3s / 261.6s | 两条都便宜；选哪条**看眼判图**（尺子在这一格会误判） |
| 极限细节（愿意付 8×） | 不缩放的 5376 交付 | 317.5s（U1 打底） | 降采样会削掉合成高频（2352 → 2268 px） |

**结论（产品口径）**：

1. **交付提分辨率这件事，U3 是默认手段**：同交付尺寸下它比 U1 便宜 6–10×，
   且在唯一"干净可比"的格子（2K、同网格、无二次缩放）里有效宽更高。
2. **U1 的位置变成"生成内"而不是"提分辨率"**：①能与链式续接叠用（见下）；
   ②放大后的 latent 可被第二次 H3 采样消费（U3 只输出像素，做不到）；③少一跳上传/下载。
   **不要再把 U1 当成"上 2K 的手段"**——那条路由已被 U3 取代。
3. **U1 与链式续接可以叠用**（曾经以为不行）：ctx 图的链式存档读的是**首遍 latent**，
   放大在它之后 ⇒ **同一条链内只要首遍尺寸一致就能续，交付尺寸不参与**。
   runner 按此判据实现（`chainGraphMismatch`，纯函数 + GPU-free 单测）。实测 fast 档 2K 族 124/56 帧：
   接缝画面差 **13.33** vs 同实现不续接 **79.57**，响度台阶 **+0.68 dB** vs **−6.34 dB**
   （详见 [`shot-chain-continuity.md`](shot-chain-continuity.md) 附 F）。
4. **U3 建议按分镜做，不要对成片做**：分镜 ≤124 帧 ⇒ 落在已验证的显存包线内、失败只毁一镜、可断点重跑；
   拼接要求各段分辨率一致 —— 对成片超分会让"一镜失败 = 全片重来"。
   真要处理长素材，分块机制能兜住，但黑盒更大。

---

## 6.5 SeedVR2（扩散式恢复）：同一能力下的第三份实现（真机实测 2026-09-24）

`video-upscale-seedvr2-3b`。**ComfyUI 原生支持**（PR #14424），**不需要任何自定义节点包**——
主链路就是核心节点：`ImageScale(交付尺寸) → SeedVR2Preprocess → VAEEncodeTiled → SeedVR2Conditioning
→ KSampler(steps=1/denoise=1) → VAEDecodeTiled → SeedVR2PostProcessing → CreateVideo`。
权重走资产槽 `seedvr2_dit` / `seedvr2_vae`（`models/diffusion_models/` 与 `models/vae/`）。

**与像素链路的四处结构性差别**：

1. **进采样器**：一步扩散恢复 ⇒ `video_upscale` 的口径不再是「不经过模型」（工具描述已改成中性）。
2. **交付尺寸直接喂模型**：图里先把帧重采样到交付尺寸再恢复 ⇒ `target_width` 是**真驱动**
   （不像像素链路那样「先按倍率渲染，再缩到目标」白扔高频）。也因此**代价随交付像素量上升**。
3. **自带跨帧语义**：VAE 编解码按 `temporal_size/temporal_overlap` 分块、restoration 吃多帧 ⇒
   声明 `chunking="internal"`：runner **不**自动分块（外层硬切会打断它的时间窗）。
4. **不做隐式默认**：`priority=-20`（x2 是 0）——它比像素链路贵得多，必须显式 `workflow=` 或改档位映射。

### 实测 A/B（同源同交付：124 帧 · 1344×768 → 2688×1536 · 单卡 Ampere 80GB）

| 臂 | 有效宽（自校准尺子） | 增益 | 平坦区闪烁比 | 平坦区锐度（缩回输入网格） | 耗时 |
|---|---|---|---|---|---|
| 输入 1344×768 | 1344 | ×1.00 | — | 68.3 | — |
| **`video-upscale-x2`（U3）** | 2218 | ×1.65 | **0.958** | 193.9 | **69.0s** |
| **`video-upscale-seedvr2-3b`** | **2654** | **×1.975** | 1.045 | **311.3** ⚠ | **483.4s（7.0×）** |

**1:1 眼判**（`e2e-out/seedvr2/compare-3arms-1to1.png`，`scripts/compare-crops.py` 生成）：
SeedVR2 的确**更实**——砖墙纹理、伞面布纹、霓虹招牌边缘都比 U3 立体；
**但平坦区（暗部墙面、伞面、路面）出现可见的细颗粒**，对应表里 311 那个数字
（与 §4.2 里 4032 那格被判「过锐/振铃」的 362 同一档），平坦区闪烁也比 U3 高（1.045 vs 0.958）。

**怎么选**：要「细节更多、愿意等 7×、能接受平坦区带一点颗粒」→ SeedVR2；
要「干净、便宜、按分镜批量做」→ U3。**对 3D 动画的平坦色块，颗粒注入的风险比实拍素材更高**，
所以这一档在动画片型里默认不推荐（已由 `priority` 保证不会被隐式选中）。

---

## 7. 诚实边界

* **1344×768 以上全是合成的**：U3 没有跨帧先验，逐帧 CNN 造出来的高频**不等于真实细节**。
  上表的「有效分辨率」是自校准频谱阈值法的读数（基线读数会被校准回输入像素宽），它是**相对**指标，不是分辨率证明；
  没有任何 ground truth 可比。
* **块效应**：5.4K 路径 1.191 —— 一次放大 16.5M 像素/帧的代价。要更干净收敛到 4032，或分两步 ×2。
* **dpi 幻觉风险**：RealESRGAN 系是「照片/CG 通用」权重，对 3D 动画的平坦色块可能过度锐化。
  眼判优先：`e2e-out/4k/compare-u3-124-crop-100pct.png` 是 1:1 裁切对照。
* **倍率由权重决定**：`factor` 声明必须与权重一致，插件无法替你校验（换了 `x4` 权重却写 `factor: 2` 会得到错误尺寸）。
* **`sizing='short-side'` 的实现一律未经本机实测**：契约与规划器（`planUpscale` / `planUpscaleChunks`）有单测，
  但「短边注入后模型是否真的按该尺寸渲染」只能在真机上验（`scripts/e2e-upscale.mjs` 加一臂）。
  在跑过之前，不要给这类实现标 `estSeconds`。
* **未测**：RealESRGAN_x4 在 5.4K 输入上的行为；更高位率/更慢编码（h264 默认档在 5.4K 有可见块效应）；
  分块在音频上的边界（末块 <1 帧时 `TrimAudioDuration` 的时长口径）。

---

## 8. 怎么用

```js
// 1) 最便宜的真 2K：原生片段 → ×2
video_upscale({ video_node: '<shot-01 nodeId>' })                       // 自然尺寸 2688×1536

// 2) 4K 级：显式选 ×4 实现，收敛到 4032 宽
video_upscale({ video_node: '<shot-01 nodeId>', workflow: 'video-upscale-x4', target_width: 4032 })

// 3) 长素材：手动指定每块帧数（否则按像素-帧预算自动分块）
video_upscale({ video_node: '<long nodeId>', target_width: 4032, chunk_frames: 120 })

// 4) 短边形态的实现（扩散/恢复类，声明 sizing="short-side"）：target_width 是让模型按目标渲染
video_upscale({ video_node: '<shot-01 nodeId>', workflow: '<某个 short-side 实现>', target_width: 2560 })
```

* `tier` 缺省 `quality`；**写错的档位会显式报错**（曾因静默退化到 quality 白跑一次 5376×3072）。
* 产物写回画布（`kind: video`），记 `width/height/length/fps`（拼接与续接的兼容性判据要用）、
  `upscaleFrom`（溯源）、`sizing` + `factor/shortSide/naturalWidth`（尺寸是怎么来的）、`assets`（用了哪个权重）。
  **短边形态下 `factor` 如实记 null**（倍率是推导的，不编一个数出来），标题也据此写成「超分 短边 1088」。
* TUI / 飞书看不到画布：产物靠 pre-ask 自动送达（媒体直接发原文件）。

---

## 9. 复现与测试

```bash
# 统一入口：清单 → e2e 真机（读画布源节点 → 上传 → 编译图 → 落画布）
node scripts/e2e-upscale.mjs --target=4032                    # 单块：4032×2304
node scripts/e2e-upscale.mjs --target=4032 --chunk=40         # 分块：4 块 + 拼回，帧数守恒
node scripts/e2e-upscale.mjs --src=<mp4> --tag=myrun          # 换源片
node scripts/e2e-upscale.mjs --workflow=video-upscale-seedvr2-3b --src=<mp4> --target=2688   # 换实现（扩散式）

# 短边形态（sizing="short-side"）的**真机**契约验证：走几何探针夹具（不产细节，只验契约链路）
#   DSH_SVS_USER_WORKFLOWS 是测试接缝：清单装进临时目录，不碰用户真实配置
node scripts/e2e-upscale-shortside.mjs                        # 三臂：默认短边 / target_width 反解回注 / internal 下显式分块
node scripts/e2e-upscale-shortside.mjs --src=<竖版 mp4>        # 换源片（探针按「竖版短边=宽」映射）

# 纯逻辑（不连 ComfyUI、不跑 GPU）：清单契约 / 校验 / 两种尺寸规划 / 分块决策 / 切口接线 / 容器解析 / 注册表集成
node scripts/smoke-upscale.mjs                                # 156 项（含两种 sizing / 两种 chunking 的契约）

# 低层探针（直接对裸图，用来标定耗时与显存包线）
node scripts/probe-4k.mjs --src <mp4> --tag t                 # 默认 RealESRGAN_x2
node scripts/probe-4k.mjs --src <mp4> --model RealESRGAN_x4.pth --scale 0.75 --method area --tag t4
node scripts/analyze-u3.mjs <输入.mp4> <产物.mp4> [目标宽]     # 有效分辨率 / 闪烁 / 锐度
```

* 生成清单：`node scripts/make-upscale-manifests.mjs`（清单是产物，改结构请改脚本）。
* 短边探针夹具：`scripts/fixtures/upscale-shortside-probe.json`（`internal: true`，永远不出现在用户的工作流清单里；
  由 `smoke-upscale.mjs` 做 GPU-free 校验，由 `e2e-upscale-shortside.mjs` 做真机验证）。
* 相关文件：`lib/upscale.js`（纯逻辑）、`lib/index.js` 的 `runUpscale` + `video_upscale`、
  `workflows/video-upscale-x{2,4}.json`、`scripts/e2e-upscale.mjs`、`scripts/smoke-upscale.mjs`。
