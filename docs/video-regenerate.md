# 视频重生成（video.regenerate）：把 768p 片段在目标分辨率上重画

> 状态：**已实现 · 首版**（2026-11-07）· balanced 渲染自动存 draft latent，`handoff='auto'` 已接线（§9.5）
> 能力 `video.regenerate` · 工具 `video_regenerate(video_node, prompt?, target?, start_sigma?, steps?, tier?, seed?)`
> 清单 `open-h3-regenerate-2k`（`priority: -30`，不做隐式默认）
> 相关：[`research/open-h3-regenerate-2k.md`](research/open-h3-regenerate-2k.md)（选型调研）·
> [`video-upscale.md`](video-upscale.md)（**保内容**的放大，不是一回事）·
> [`learned-latent-upscale-2k.md`](learned-latent-upscale-2k.md)（生成内两遍放大）·
> [`research/sol-h3-vae-ab.md`](research/sol-h3-vae-ab.md)（快解码器）

## 0. 它是什么 / 不是什么

| | 说明 |
|---|---|
| 能力 | `video.regenerate`（与 generation / upscale / interpolate 并列） |
| 工具 | `video_regenerate(video_node, prompt?, target?, start_sigma?, steps?, tier?, seed?)` |
| 输入 | 画布上**已存在**的视频节点（通常是本插件渲出的 768p 片段）+ 提示词 |
| 输出 | **同帧数**、源音轨原样接回的 mp4；画面在**目标网格**上**重新生成** |
| **不是超分** | 超分（`video.upscale`）承诺「同帧数 / 同 fps / 同音轨、内容不变、尺寸由源片推导」；重生成会**改内容**（身份/口型可能漂）、尺寸由**清单声明**、要提示词 |
| **不是生成** | 不生成新镜头（没有镜头号、不进镜头表一致性门）；它是**后处理**，输入是已有片段 |
| 实现 | Open-H3-Regenerate-2K（NVIDIA）：latent 3D 放大 → 音频 mask → **3 步 Euler（σ0.909 起）** → 快解码 |
| 模型 | base **FL2VA**（精修段必须是 fl2va，不能用 Ref2VA）+ 合并 LoRA（refiner + LightX2V FL2VA Turbo + LMS Sharp）+ 50 条 Sharp 曲线分支 |

**为什么单开一个能力而不是塞进 `video.upscale`**：两份契约的承诺直接冲突（提示词 / 尺寸来源 / 内容不变性 /
fps 与帧数不变量 / 门禁待遇）。逐条对比见 [`research/open-h3-regenerate-2k.md`](research/open-h3-regenerate-2k.md) §6.5。

## 1. 契约（清单字段）

```jsonc
"regenerate": {
  "targets": {
    "1080p": { "graph": [1920, 1088], "delivery": [1920, 1080] },
    "2k":    { "graph": [2560, 1440], "delivery": [2560, 1440] }
  },
  "default": "2k",
  "inputFps": 24, "fpsTolerance": 0.02,
  "minFrames": 121, "maxFrames": 362,
  "requiresPrompt": true
}
```

* **`graph` / `delivery` 分开**：`graph` 是图内真正渲染的网格，必须 **32 对齐**；`delivery` 是裁切后的交付尺寸。
  1080p 必须渲染 1088 行再裁掉 8 行——1080 不是 32 的倍数（4K 的 2160 同理，需要 2176）。
* **竖屏自动翻转**：源片 `h > w` 时 runner 把 `graph`/`delivery` 的宽高对调（2K 竖屏 = 1440×2560）。
* **尺寸不来自源片**：源片比例只决定方向，不决定像素量。这是与 `upscale.sizing` 的根本差异。
* **护栏是声明的**：`inputFps` / `minFrames` / `maxFrames` / `requiresPrompt` 由清单给，runner 只执行、不认模型名。
* 校验器（`lib/manifest.js`）fail-closed：缺 `regenerate` 块、`graph` 不对齐 32、`delivery > graph`、
  `default` 不在 `targets` 里、缺 `params.{source_video,prompt,width,height}`、误声明 `upscale`/`resolutionLock` 都拒绝加载。

工具注入点（清单 `params`）：`source_video`（video → `LoadVideo.file`）、`prompt`（→ `CLIPTextEncode.text`）、
`width`/`height`（→ 放大器目标网格）、`seed`、`audio_mode`、`steps`、`start_sigma`、`prefix`。

## 2. 图（23 节点，清单 `open-h3-regenerate-2k`）

```
1 LoadVideo(源片) → 2 GetVideoComponents
   ├─ 3 OpenH3RegenPrepareDraft(768p)     ← 覆盖缩放/居中裁到 768p，帧数补齐到 17k+5
   │    → 4 VAEEncode($vae)               ← 编码草稿（fp16 视频 VAE）
   │    → 5 LatentUpscaleModelLoader($latent_upscaler)
   │    → 6 MiniMaxH3LatentUpscaleWithModel(width=$width, height=$height)   ← 图内网格
   │    → 7 OpenH3RegenRefineLatent(audio_mode=$audio_mode, audio_vae, audio=源音轨)
   │         ↑ 音频 mask=0（σ=0 不参与重采样），视频部分由采样器重新加噪
   ├─ 8 UNETLoader($unet=fl2va) → 9 OpenH3RegenLora($regenerate_lora + $sharp_curves + $curve_table)
   ├─ 10 CLIPLoader(minimax) → 11 CLIPTextEncode($prompt)     ← 精修是**纯文本**条件
   └─ 12 OpenH3RegenSigmas(steps, start_sigma) 13 RandomNoise 14 euler 15 BasicGuider
        → 16 SamplerCustomAdvanced(latent=7)
        → 18 VAEDecode(vae=17 VAELoader($vae_decode=sol_h3_vae))
        → 19 OpenH3RegenFinish(frame_count=3.frame_count, audio=源音轨)  ← 裁掉补齐帧/裁 1088→1080
        → 20 CreateVideo(audio=19.audio) → 21 SaveVideo
```

要点：

* **音频从不经过采样器**：`RefineLatent` 把音频 mask 在 σ=0；出片用 `Finish` 裁到保留帧数后接回源音轨。
  ⇒ 音轨是**源片那一份**（重采样到 32 kHz 再编码），不是模型重新生成的。
* **精修条件只有文本**：不传角色卡/场景卡（身份由草稿承载）；源节点 `params.prompt` 就是默认提示词。
* **快解码器走独立 `VAELoader`**：与编码 VAE 分开（Sol-H3-VAE 是 decoder-only，直接替换编码 VAE 会报
  `'MiniMaxH3VideoVAE' object has no attribute 'quant_conv'`）。
* **帧数不变**：`PrepareDraft` 补齐到 17k+5 网格、`Finish` 按源帧数裁回 ⇒ 交付帧数 = 源帧数。

## 3. 源片护栏（跑在分布外宁可报错）

| 护栏 | 规则 | 报错/告警 |
|---|---|---|
| 帧率 | 必须 ≈ `inputFps`（默认 24，容差 0.02） | 报错并指路：`video_interpolate` / 转码到 24fps |
| 帧数 | `minFrames ≤ n ≤ maxFrames`（121–362，即 5–15s） | 短了指路 `video_upscale`；长了要求按分镜拆开 |
| 提示词 | 源节点没有 `params.prompt` 时必须显式传 | 报错（精修是条件生成，空条件等于自由发挥） |
| 帧率读不出 | 允许，但记一条告警（按 24fps 处理） | 告警 |
| 源片 >768p | 允许，但会先降到 768p 再重画 | 告警「细节是重画的，不是保留的」 |
| 源片 <720p | 允许，但草稿信息少 | 告警「会补出模型认为该有的细节」 |

## 4. 与另外两条「提清晰度」路线的取舍

| | **video.upscale**（U3/SeedVR2） | **2K 清单**（`…-2k`，生成内两遍） | **video.regenerate**（本条） |
|---|---|---|---|
| 输入 | 任意已有视频 | 提示词 + 参考图（重渲一遍） | 已有片段 + 提示词 |
| 尺寸来源 | 源片 × 倍率 / 短边 | 首遍 ×2（`resolutionLock`） | **清单声明的目标网格** |
| 内容 | 不变 | 低噪声补细节（denoise 0.3） | **重画**（σ0.909 起 3 步） |
| 音轨 | 原样 | 锁在 σ=0 | 锁在 σ=0，源音轨接回 |
| 代价（A800） | 69 s（×2，124 帧） | 2120.9 s（quality）/ 1277.8 s（PDD2） | **557.3 s（2K，124 帧，实测）** |
| 适用 | 交付前统一提分辨率；保身份 | 生成时直接出 2K | **已经渲好的片子想更清晰/更真实，且愿意接受重画** |

**顺序建议**：新片优先走 2K 清单（提示词与自检都在同一镜头里）；只有「片段已经存在、不想重渲」时才用
`video_regenerate`（例如历史素材、外部草稿、临时加急）。要保内容的放大永远用 `video_upscale`。

## 5. 实测（A800 80GB PCIe · ComfyUI 0.44.1）

| 用例 | 图内网格 | 帧数 | 墙钟 | 备注 |
|---|---|---:|---:|---|
| 接线冒烟 | 2560×1440 | 5 | **32.8 s** | 冷启：含加载合并 LoRA（12.45 GB）+ 曲线分支；产物 2560×1440 / 24fps / 带音轨 |
| **全量（生产口径）** | 2560×1440 | **124** | **557.3 s**（≈9.3 min） | 暖机、dense（无 Sol-Attn/MXFP8）、int8 FL2VA、源音轨接回；**显存峰值 ≈57 GiB**；产物 31.7 MB |

对照（同卡、124 帧）：`-ctx-quality-2k` **2120.9 s**、`-ctx-quality-pdd2-2k` **1277.8 s**
⇒ 本实现 **3.8× / 2.3×** 更快。`estSeconds` 按 557 s 填（暖机含解码；换卡或换帧数要重测）。
同卡另一组参考：U3 像素超分 ×2 只要 69 s——**它便宜 8×**，但保内容、不重画细节。

## 6. 已知边界

* **会改内容**：σ₀0.909 的 3 步重画幅度大（社区实测「小狐狸的脸漂向狼」）。`start_sigma` 0.8 更贴草稿；
  无论哪种，**产物必须抽帧核对身份/口型**（`extract_frame` + `canvas_record_check`）。
* **口型**：音轨是源片那一份、画面是重画的，可能出现「嘴型对不上」。逐镜听核；必要时降 `start_sigma`。
* **比例会轻微变化**：H3 草稿 1344×768 = 1.75，2K 网格 2560×1440 ≈ 1.778（官方映射本来就不是等比）。
  9:16 用 1440×2560。
* **4K 未提供**：4K 需要两次放大（经 2K），不是一份图能表达的；要做另加清单。
* **能力门禁**：不进镜头表一致性门 / 制片门 / 逐镜自检门（它是后处理，不产生新镜头）。
  但**产物仍需人工看片**——工具结果里每次都会带一条「会重画内容」的告警。
* **依赖第三方节点包**：`rdh9616/ComfyUI-Open-H3-Regenerate`（Apache-2.0），`requiresNodes` 会显式缺节点置灰。
  其中存 latent 的节点是**可选依赖**（没装也不影响 balanced 出片，只是不存 latent）。
* **`handoff='auto'` 能不能走 latent，取决于该镜怎么渲的**：只有 **balanced** 清单会顺手存 latent；
  fast / quality / 外部导入 / 拼接片段没有 ⇒ auto 退回视频入口（返回 `handoff=video` + 原因）。
* **许可**：模型权重是 MiniMax H3 Community License，不随插件分发，由用户自备。

## 7. 怎么用

```js
// 1) 最常用：把一个已经渲好的 768p 镜头重生成到 2K（提示词沿用该镜头记录的 prompt）
video_regenerate({ video_node: '<S03 片段>' })

// 2) 想更贴草稿（少重画）：降起始噪声
video_regenerate({ video_node: '<S03 片段>', start_sigma: 0.8 })

// 3) 外部/拼接片段没有 prompt：必须显式给
video_regenerate({ video_node: '<外部片段>', prompt: '...' })

// 4) 1080p（少一半像素，快很多）
video_regenerate({ video_node: '<S03 片段>', target: '1080p' })

// 5) 交接方式（缺省 auto）：balanced 渲染过的镜头会自动带 draft latent，auto 直接用；
//    显式强制 / 禁止 latent 也可（latent 不可用时会直接报错，不会静默退）
video_regenerate({ video_node: '<S03 片段>', handoff: 'latent' })
video_regenerate({ video_node: '<S03 片段>', handoff: 'video' })
```

验收：

```bash
node scripts/smoke-regenerate.mjs   # 100 断言：目标解析 / 护栏 / 图编译 / 校验器 / 工具注册
```

## 8. 安装（本机已就绪，换机器时照这个来）

宿主机（`server@211.68.76.4`）上 ComfyUI 跑在 docker 容器 `comfyui` 里，挂载关系：

| 宿主机 | 容器内 | 用途 |
|---|---|---|
| `/data/comfyui/storage/ComfyUI` | `/root/ComfyUI` | 代码与 `custom_nodes/` |
| `/data/comfyui/storage-models/models` | `/root/ComfyUI/models` | 权重 |

```bash
# 1) 节点包（Apache-2.0）
git clone --depth 1 https://github.com/rdh9616/ComfyUI-Open-H3-Regenerate \
  /data/comfyui/storage/ComfyUI/custom_nodes/ComfyUI-Open-H3-Regenerate

# 2) 权重（13.7 GB；下载后校验 sha256）
cd /data/comfyui/storage-models/models/loras
wget -c https://hf-mirror.com/Efficient-Large-Model/Open-H3-Regenerate-2K/resolve/main/lora/open_h3_regenerate_2k_lora.safetensors
wget -c https://hf-mirror.com/Efficient-Large-Model/Open-H3-Regenerate-2K/resolve/main/lora/sharp_curve_branches.safetensors
sha256sum open_h3_regenerate_2k_lora.safetensors sharp_curve_branches.safetensors
#   open_h3_regenerate_2k_lora  8e36a0912ab72f7f3b00f41e3c7c97c7dfdec21e66c88ab22f08b9b0c681bb04
#   sharp_curve_branches        26ff1c4ea50fc5b0cea252912b67ec308a65d534cef026ef56f415ae92102e4e

# 3) 重启容器（必须：新节点只在启动时加载）
sudo docker restart comfyui     # 若报 "did not receive an exit event"，用 sudo docker start comfyui

# 4) 验收：节点与权重可见
curl -s localhost:8188/object_info | python3 -c "import sys,json;d=json.load(sys.stdin);print([k for k in d if k.startswith('OpenH3Regen')])"
```

**不需要**再下的两件（本机已有、与上游同文件，sha256 已核对）：

| 资产 | 本机文件 | 与上游关系 |
|---|---|---|
| 快解码器 | `models/vae/sol_h3_vae.safetensors`（6.47 GB） | sha256 `8658f1e8…` = 上游 `vae_fast/fast_h3_vae_noncausal_24l.safetensors` |
| 学习式放大器 | `models/latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` | sha256 `4f57821f…` = 上游 `latent_upsampler/` 同名文件 |

资产槽可用 env 覆盖：`DSH_SVS_OPEN_H3_LORA` / `DSH_SVS_OPEN_H3_CURVES`（`DSH_SVS_H3_SOL_VAE` /
`DSH_SVS_H3_LATENT_UPSCALER` 沿用已有）。曲线表 `curve_table` 默认读
`minimax_h3_ref2va_pruned_int8_convrot.safetensors` 里的 `adaln_t_table`（只读 32KB）。

## 9. B 方案实验：latent 交接（A/B 实测，2026-11-07）

> 目的：验证「两段作业 + latent 交接」是否值得从实验变成产品路径。**结论：B 略快、交接更干净，但这一镜上眼判差异很小；暂留实验清单（`internal`），不替换 C。**

### 9.1 实验清单（都是内置、`internal: true`，不进档位矩阵）

| 清单 | 角色 |
|---|---|
| `minimax-h3-ref2v-ctx-balanced-pika-solattn-solvae`（balanced 清单本身） | **草稿段**：**§9.5 已产品化**——`OpenH3SaveRefinedLatent`（存采样输出 latent + 帧数 + 音轨）进**全部 balanced 清单**，不再单开 `-latent` 克隆（实验期的克隆已退役） |
| `open-h3-regenerate-2k-latent` | **质量档精修段**：`OpenH3LoadRefinedLatent → 3D 放大 → σ0.909/3 步 → 快解码`，**没有 mp4 解码与 VAE 重编码** |
| `open-h3-regenerate-2k` | 对照（C）：入口是视频（`LoadVideo → PrepareDraft → VAEEncode`） |

> 草稿段的两个注入点：`latent_prefix`（文件名前缀）与 `latent_frame_count`（**交付**帧数——链式续接镜要填
> `deliveredLength`，不是多采了 22 帧的采样长度；第二段会按它裁帧/裁音轨）。**§9.5 已接到 `runRender` 的账本**，
> `scripts/e2e-b-handoff.mjs` 仍可单独复现 B 臂。

### 9.2 设计

同一份草稿（pika ctx + solattn + solvae，6 步，124 帧，1344×768，含音轨）、同一 prompt、同一 refine seed（42）、
同一目标网格（2K）。**只换交接物**：B 吃草稿的 latent，C 吃草稿的 mp4。

### 9.3 结果（A800 80GB，2K，124 帧，同进程连跑）

| | 草稿段 | 精修段（B，latent） | 精修段（C，视频） |
|---|---:|---:|---:|
| 墙钟 | **116.5 s** | **540.3 s** | **557.2 s** |
| 产物 | 4.6 MB mp4 + 15 MB latent | 32.4 MB（2560×1440） | 29.1 MB（2560×1440） |
| 交接开销 | — | 0（latent 直通） | +8.7 s 上传 + 解码 + VAE 重编码 |

* **B 比 C 快 16.9 s（3.0%）**；把它省掉的上传（8.7 s）也算进去 ⇒ 端到端约 **4.5%**。
* **交接噪声（精修前）**：两臂「放大到 2K 的 latent」相对 L2 **0.182**、相关系数 0.9836、MAE 0.131 ——
  h264 往返 + VAE 重编码确实改了 18% 的 latent（不是舍入级）。
* **产物差异**：B vs C 输出 PSNR Y **28.81 dB**（avg 30.5）、SSIM Y **0.898**（All 0.926）——
  3 步模型在 σ0.909 上对初始状态很敏感，18% 的输入差被放大成两张"同场景不同细节"的图。
* **细节量**：同一帧的 Laplacian 方差 B **701.5** vs C **596.9**（+17.5%）；1:1 裁切眼判两者几乎不可分，
  B 的石桥/树冠边缘略干净（但这一项不足以单独作为决策依据）。
* **与草稿的距离**：两臂缩回 768p 与草稿比，PSNR ≈18.1 dB、SSIM ≈0.43 —— 重画幅度本来就大，这个指标只作口径参考。

图：`e2e-out/b-handoff/`（两臂 mp4、同帧 1:1 裁切、`result.json`）。复现：

```bash
node scripts/e2e-b-handoff.mjs                 # 默认宝钗镜；约 20 分钟
node scripts/e2e-b-handoff.mjs --target 1080p  # 换目标网格
```

### 9.4 观察与结论

* **B 的价值是"确定性的干净交接 + 3–5% 时间"**，不是画质跃升；C 已经能交付。
* **显存**：两段作业在同一 ComfyUI 进程里连跑时，ref2va（草稿）与 fl2va（精修）两个 base 会同时被缓存，
  实测峰值 **≈80.8 GiB / 82 GiB**（另一轮单段、草稿来自旧文件时是 ≈57 GiB）⇒ 同机连跑要按这个规划；
  跨机/换进程则天然只有一个 base。
* **升级为产品路径的条件**（满足任意一条再动）：
  1) 2K 变成默认交付（每镜都走重生成，3–5% 会累积）；
  2) 实拍/皮肤/布料/小字素材上出现「h264 伪影被画实」的证据（B 从源头避免）；
  3) 需要直接消费外部 H3 latent（别的工具只给 latent）。
* 否则维持现状：C 是产品能力，B 是实验清单 + 一个可复现脚本。

### 9.5 已接线：balanced 自动存 latent + `handoff='auto'`（2026-11-07）

A/B 之后我们把交接链路做成了产品可用的形态（B 的清单仍是 `internal` 实验件）：

1. **29 份 balanced 视频清单**都加了 `OpenH3SaveRefinedLatent`（旁路存采样输出 latent + 帧数 + 音轨），
   由 `scripts/add-latent-save.mjs` 幂等维护（生成器重跑后需再执行一次）。
   - `samples` 接**采样器输出**、`audio` 接**同一遍的音频解码**；2K 清单接的是**第一遍 768p 采样**，
     存下来的正是能当 draft 用的 latent（放大在它之后）。
2. **runner 注入与回抓**：`runRender` 给每次渲染注入 `latent_prefix = <canvas>/<sid>/<nodeId>_latent` 与
   `latent_frame_count = deliveredLength`（链式续接镜是**交付帧数**，不是多采 22 帧后的采样长度），
   并从 history 的 ui.text 里抓回文件名，写进节点 `params.latentFile / latentFrames / latentWidth / latentHeight`。
3. **可选依赖**：`OpenH3SaveRefinedLatent` **不写进 `requiresNodes`**；节点包没装时 runner 会把这个旁路节点从图里
   摘掉并告警，**balanced 照常出片**（随后 `handoff='auto'` 自然退回视频入口）。写进 requiresNodes 会让整个
   balanced 档在没装包的环境里变成「缺节点」，那是误伤。
4. **`handoff` 三态**（默认 `auto`）：`video_regenerate(..., handoff='auto'|'latent'|'video')`。
   - `auto` 全部条件通过才走 latent：源节点有 `latentFile`、文件在服务端（读 `OpenH3LoadRefinedLatent` 的下拉）、
     帧数 121–362、latent 不大于目标网格（放大器只升不降）；任一不满足**退回视频入口**并把原因写进
     `handoffReason`（工具返回 + 节点 params 都记）。
   - `latent` 是显式要求：不满足**直接报错**，不静默退。
   - `video` 强制走视频入口。
5. **真机验证（2K 对比实验）**：balanced Pika 草稿渲完 `params.latentFile` 已写入；
   `video_regenerate(..., handoff='auto')` 返回 `handoff: "latent"`（reason 写了文件名与 124 帧），
   精修 **541.5 s**；同草稿像素超分 **77.8 s**、SeedVR2 **347.1 s**（详见 §10）。

> 升级为**默认路径**仍建议等条件成熟（2K 默认交付 / 出现 h264 伪影证据 / 需要外部 latent）：
> 现在 `handoff=auto` 会让"有没有 latent"影响耗时与结果（3–5% 时间 + 交接噪声），属于可解释但非零的差异。

## 10. 2K 路线对比：像素超分 / SeedVR2 / 重生成（2026-11-07）

同一份 **balanced Pika** 草稿（1344×768 · 124 帧 · 新写的「雨巷」场景 prompt）、同 seed、同帧数，
三条 2K 路线（A800 80GB，单机）：

| | 像素超分 ×2 | SeedVR2 3B | 重生成 2K |
|---|---:|---:|---:|
| 能力 / 入口 | `video.upscale` / x2 | `video.upscale` / seedvr2-3b | `video.regenerate`（handoff=auto ⇒ latent） |
| 耗时 | **77.8 s** | 347.1 s | **541.5 s** |
| 交付 | 2688×1536（跟随源片 1.75:1） | 2560×1472 | **2560×1440（16:9 网格）** |
| Laplacian 方差（同帧，共同区域） | 36.2 | 61.1 | **136.3** |
| 时域闪烁（逐帧 mean\|Δ\|，8-bit） | **3.02** | 3.48 | 4.23 |
| PSNR/SSIM（Y）对像素臂 | — | 19.55 / 0.608 | 18.33 / 0.537 |
| PSNR/SSIM（Y）对 SeedVR2 | — | — | 21.93 / 0.599 |

口径：三条路线都从同一帧草稿出发；像素臂与 SeedVR2 按源片比例交付，重生成按目标网格，
指标与 1:1 裁切在**居中共同区域 2560×1440** 上计算。对照图：
[`e2e-out/2k-vs-regen/compare-3arms-crops.png`](../e2e-out/2k-vs-regen/compare-3arms-crops.png)（画布「实验·2K对比」组里也有）。

**结论**

- 像素 ×2 最便宜、最稳（闪烁最低），但**最软**——它只搬像素、不造细节。
- SeedVR2 中档：细节比像素臂多 ≈1.7×（Laplacian 61 vs 36），代价 ≈4.5× 时间，闪烁 +15%。
- 重生成细节最高（≈3.8× 像素臂 / 2.2× SeedVR2），但**最贵**（≈7× 像素臂）且**会重画内容**——
  这次布幡上的伪汉字被画实、闪烁 +40%。适合"要纹理/小字/材质"的镜头，不适合"必须逐像素保内容"的镜头。
- **三条路线不要混**：重生成 2560×1440、超分跟随源片 1.75:1，混用会让拼接尺寸不一致。全片统一一条路线。

复现：`node scripts/e2e-2k-vs-regen.mjs`（新写 prompt，约 12–15 分钟，产物落 `e2e-out/2k-vs-regen/`）。

## 11. 参考

- 调研与选型：[`research/open-h3-regenerate-2k.md`](research/open-h3-regenerate-2k.md)
- 上游：<https://huggingface.co/Efficient-Large-Model/Open-H3-Regenerate-2K> ·
  <https://nvlabs.github.io/Sana/Open-H3-Regenerate-2K/>
- ComfyUI 适配包：<https://github.com/rdh9616/ComfyUI-Open-H3-Regenerate>（Apache-2.0）
- 快解码器（Sol-H3-VAE = StreamRender-H3 24 层）：[`research/sol-h3-vae-ab.md`](research/sol-h3-vae-ab.md)
