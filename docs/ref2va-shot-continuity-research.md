# Ref2VA 镜头续接方案研究：Motion Context / Add Guide / 混合 checkpoint

> **本文性质**：技术选型与可行性研究文档，**不是插件契约的一部分**。
> 插件本体保持模型无关——本文出现的模型名、节点名、包名**不得**写进 skill 流程、prompt 模板或工具契约；
> 落地形态一律是「新增 workflow JSON 清单」，契约见 `docs/workflow-contract.md` 的 M5（丢 JSON 即可）。
>
> **触发问题**：当前插件用 `video.reference2video`（Ref2VA，锚身份）与 `video.image2video`（FL2VA，锁首/末帧构图）
> 两条 capability 分工。希望**在保留参考绑定（角色卡/场景卡）的同时**拿到镜头间的无缝续接——
> 也就是「Ref2VA + 上一镜尾帧」这种单次生成里两个 checkpoint 互斥、无法同时成立的组合。
>
> **证据口径**：① 本机与远程 ComfyUI 现场核查（命令与输出见 §2）；② ComfyUI 核心源码与 release note；
> ③ 三个社区节点包的 README/CHANGELOG/源码；④ 官方教程与工作流模板。
> **未做的**：本机上一条量化 A/B 都没跑（§6 是待跑实验清单）。所有「更好/更差」都是机制推断 + 引用证据，不是本机实测结论。

---

## 0. 三十秒结论

| 问题 | 答案 |
|---|---|
| 提案方向对不对？ | **对**。Ref2VA 与 FL2VA 在 ComfyUI 里就是两个独立条件节点，目标图里没有 `first_frame`/`last_frame` 输入，"参考 + 上一镜尾帧"确实要靠额外机制补。 |
| 提案里的技术描述准确吗？ | **大体准确，有三处要修正**：① 包名/归属混了（见 §1.2）；② 这些包在本机 **ComfyUI 0.33.3 上基本装不了**（硬版本门）；③「无缝」的性质是 **latent 级钉住 + 音频沿时间轴续接**，不是 FL2VA 的像素级端点锁定。 |
| 本机的真正前置条件是什么？ | **ComfyUI 核心 ≥ 0.34.0**（`MiniMaxH3AddGuide`，PR #15439，0.34.0 引入；本机 0.33.3 为零命中）。不升级核心时，**唯一**可用的是 Niko 包的旧版 `0.3.1`，代价是它会 runtime patch 核。 |
| 有没有「不装任何东西、今天就能测」的路？ | 有。Ref2VA 的 `ref_videos` / `ref_video_audios` 槽位本身就是"多模态参考"，把上一镜尾段（2–15s）+ 尾段音频接进去，是现成图能表达的——语义上是**模仿**而非**续接**（§3 R1）。 |
| 不想动核、又想拿到"参考 + 端点锚定"呢？ | 有第三条：社区**合并权重**（fl2va×ref2va，4 个 int8 变体各 ≈19.5GiB）+ "Image + Reference to Video" 节点，不 patch 核；但它**同样不续接音频**，且质量口径在社区内部有分歧（§3 R4）。 |
| 官方有没有原生答案？ | 有，而且很直接：官方模板 **MiniMax H3 Multiframe Reference** = `ReferenceToVideo` + **链式 Add Guide**，官方定位就是"视频续写与多镜头场景"。它给画面锚点，但**不续接音频**（guide audio 只能从锚点向前铺）。 |
| 那 Motion Context 到底多给什么？ | 三件事：① 从**上一镜 latent 里切片**而不是"解码→再编码"（省掉一次有损往返，接缝更干净）；② 音频**结束于接缝、向前回溯**（真续接，实测相关性 0.45 → 0.95+）；③ 配套 Trim/Seam Probe 工具。 |
| 建议怎么走？ | **先量基线（E0），再决定升不升核（E1/E2），第三方包放最后（E3）**，混合 checkpoint 作为"身份/锚帧双要求"的备选（E4）。见 §6。 |
| 最后怎么走的？ | **R3 已落地**：远端核升到 0.35.2、装 `ComfyUI-H3-Motion-Context`、插件新增链式续接清单（`minimax-h3-ref2v-ctx-*` 四档）+ 工具入参 `continuity_from`；实测与契约见 **§8** 与 `docs/shot-chain-continuity.md`。 |

---

## 1. 提案的事实核查

### 1.1 成立的部分（有源码/官方证据）

- **两个 checkpoint、两个条件节点互斥**：
  - `MiniMaxH3ReferenceToVideo`：必填 `clip/vae/audio_vae/prompt/width/height/length/ref_image_size`，可选 `ref_images`(≤9) / `ref_videos`(≤3, 每段 2–15s) / `ref_video_audios`(≤3) / `ref_audios`(≤3)。**没有** `first_frame`/`last_frame`。
  - `MiniMaxH3ImageToVideo`：可选 `first_frame` / `last_frame`。**没有** `ref_images`。
  - 两者都是"条件节点 → CONDITIONING + LATENT → guider/sampler"的同一个位置，所以只能二选一。
- **Motion Context 类节点真实存在**，且用法就是"接在 Ref2VA 之后"：Niko 包 README 专门有一节 *Reference mode*——
  "Put this node after `MiniMaxH3ReferenceToVideo` and wire it as above. Your reference blocks (image, video, video with audio, audio) are left alone entirely"，
  并说明 0.2.0 起不再覆盖参考列表（更早版本会"quietly threw your references away"，≤0.3.1 会把钉住的音频塞进参考列表并因此产生每处接缝的爆音）。
- **连接方式与参数**：把 Motion Context 插在条件与采样器之间，`context_length` 控制继承多少帧；`context_latent` 走 Save/Load Latent 在两次运行之间搬 latent；Trim 把钉住的头部（画面+声音）从交付里去掉。
- **音频续接是它最独特的贡献**，且作者给了量化证据：把钉住音频的**时间坐标**改写到新片段自己的时间轴上（而不是当参考），接缝处互相关从 ~0.45 升到 0.95+。
- **代价与边界**：音频长链会越来越闷（每一环都建在上一环的输出上 + 一次音频 VAE 往返）；分辨率在链中不能变（latent 不能缩放）；**Spectrum 一类跳步加速器必须关**（钉住的行不演化，是预测器的退化输入）；turbo LoRA 会同时伤音频与细节。

### 1.2 需要修正的部分

| 提案说法 | 实际 | 证据 |
|---|---|---|
| "节点包 `ComfyUI-MiniMaxH3-Context-Loop`，其核心逻辑是 H3 Motion Context 节点" | 这是**同源两包被混成了一个**：源头与手动路径是 [`NikoDemon80/ComfyUI-H3-Motion-Context`](https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context)（`MiniMaxH3MotionContext` / `…Trim` / `…SaveLatent` / `…LoadLatent` / `…Chain` / Seam Probe）；[`ethanfel/ComfyUI-MiniMaxH3-Contex-Loop`](https://github.com/ethanfel/ComfyUI-MiniMaxH3-Context-Loop) 是它的 **fork**，把重复的 Ref2VA 图变成一次递归采样体（`MiniMaxH3Chain*` + `MiniMaxH3LoopTrim`），公开名现已改为 **Context-Loop** | 两仓库 README；Context-Loop 无 GitHub release，版本号在 pyproject（0.6.9） |
| "它包含一个针对 Ref2VA 多参考的兼容性补丁" | 多参考（MultiRef）这条线由 **seitanism** 独立成包 [`ComfyUI-H3-Motion-Context-MultiRef`](https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef)，且 Context-Loop 的 install 段要求**两个包一起装** | Context-Loop README install 段两条 `git clone` |
| "调整 `context_length` 控制继承多少帧和音频" | `context_length` **只管画面**；音频窗口是独立参数 `audio_context_length`（推荐 24 帧 = 1 秒，须落在 40 Hz 音频网格上） | Niko README *Settings* 节 |
| "本质上是用参考视频/上下文去模拟衔接，不是 FL2VA 那样像素级锁定" | 方向对，但**比这个说法更硬**：latent 路径下钉住的帧"the same numbers they were, bit for bit"（比 FL2VA 的像素级端点更精确，因为不经过解码/编码）；它弱的地方不是精度，而是**钉住的头帧会从交付里被剪掉**、交付片段比采样长度短 `context_length` 帧 | Niko README *Why this exists* / *Writing prompts for a chain* |
| （未提及）版本门槛 | Niko 包 **0.4.0 起要求 ComfyUI ≥ 0.34.0**，且在旧核上**主动拒绝运行**；`0.3.1` 是唯一"两代 layout 都能跑"的版本。seitanism MultiRef 依赖原生 PR #15439，**0.33.3 上直接抛错**。Context-Loop 要求 native Add Guide + 伴随 seitanism 包 | 三包 CHANGELOG/README/源码，见 §2.3 |

### 1.3 一个提案没提到、但决定方案走向的事实

ComfyUI **自己**在 0.34.0（PR #15439）就把"任意帧锚点"做进核里了 —— `MiniMaxH3AddGuide`：

```python
class MiniMaxH3AddGuide(io.ComfyNode):
    """Anchor image and/or audio guides at an arbitrary pixel frame of the target video."""
    # inputs: positive(CONDITIONING), vae?, audio_vae?, latent(LATENT),
    #         image?(IMAGE, 多帧批次按 17k+5 裁剪成 5/22/39… 作为 clip 钉住),
    #         audio?(AUDIO, 与 image 同一 frame_idx 起向前铺、裁到剩余时长),
    #         frame_idx(INT, 负值从末尾数)
    # outputs: positive(CONDITIONING)   # 只是往 minimax_keyframes 里追加，可与任何 H3 条件串联
```

- 它**接受 Ref2VA 的 conditioning**（只是追加 `minimax_keyframes`），官方模板 *MiniMax H3: Multiframe Reference* 就是 `ReferenceToVideo` + 链式 Add Guide，官方教程的原话是"生成视频续写与多镜头场景"。
- 官方教程同时点破了它的短板，且有两条正好对应 Motion Context 的卖点：
  1. "仅连接到 Add Guide 节点的图像会固定特定帧的构图，但**文本编码器看不到它们**"（要 prompt 能引用就得多塞进 `ref_images` 槽位）；
  2. guide 的 audio 只能**从锚点起向前**铺 —— 续接一段**已经播过**的声音，原生机制表达不了。
- 所以路线选择可以拆成两个正交问题：**画面锚点**（原生 Add Guide 就够）与**音频续接 + latent 级无往返**（只有 Motion Context 给）。

---

## 2. 本机现场核查（可复核）

### 2.1 运行环境

| 项 | 值 | 怎么拿到的 |
|---|---|---|
| ComfyUI 核心 | **v0.33.3**，`/data/comfyui/storage/ComfyUI`，git tag `v0.33.3`，working tree 干净 | `git log -1` / `git describe --tags` / `git status --porcelain` |
| 部署形态 | docker 容器 `comfyui`，镜像 `yanwk/comfyui-boot:nightly-gcc`，端口 `127.0.0.1:8188` | 远端 `~/comfyui/docker-compose.yml`；`sudo docker ps` |
| 接入方式 | 本机 `ssh -L 8188:localhost:8188 <user>@<gpu-host>`（常驻隧道进程），插件 `baseUrl=http://localhost:8188` | `lsof -nP -iTCP:8188`；`pgrep -fl ssh` |
| 卡 | **sm_80 架构、单卡大显存**（按本仓库公开口径只描述架构，不点名具体机型） | `nvidia-smi` |
| 磁盘 | `/data` 14T，已用 3.7T | `df -h /data` |
| custom_nodes | ComfyMath / Impact-Pack / LTXVideo / **ComfyUI-Manager** / **ComfyUI-MiniMax-H3-PDD-Acc** / SolAttn-Ampere | `/data/comfyui/storage/ComfyUI/custom_nodes` |
| 网络（装包/下权重相关） | 远端：github.com ✅(0.9s) · hf-mirror.com ✅ · pypi.org 慢(≈6s) · huggingface.co ❌；本机：raw.githubusercontent.com ✅ · github.com ❌ · huggingface.co ❌ | 两侧 `curl -o /dev/null -w %{http_code}` |
| H3 权重 | `minimax_h3_ref2va_pruned_int8_convrot.safetensors`、`minimax_h3_fl2va_pruned_int8_convrot.safetensors`（各 ~20.9GB）+ 音频/视频 VAE + 4 步/8 步 turbo LoRA + `MiniMax-H3-Ref2VA-Acc-8Step_pruned_comfy.safetensors` | `models/diffusion_models`、`models/loras` |

### 2.2 关键负面事实

- **本机核里没有任何 Add Guide 节点**：`grep -c "Add Guide for MiniMax H3" comfy_extras/nodes_minimax_h3.py` → **0**。
  `/object_info` 里与 H3 相关的只有 `MiniMaxH3ImageToVideo` / `MiniMaxH3ReferenceToVideo` / `MiniMaxH3SigmaShift` / `EmptyMiniMaxH3LatentAV`，
  加上 PDD/SolAttn 两个第三方包的节点与 LTX 的一批（`LTXVAddGuide*` 是 LTX 的，不能替代）。
- ComfyUI 当前主线为 **0.35.0**（`pyproject.toml`），0.34.0 release 明写 "Add MiniMaxH3AddGuide for anchoring image and audio guides at any frame (PR #15439)"。
- ⇒ **不升核 = 用不到 Add Guide，也就用不到建立在它之上的 Motion Context 新版本。**

### 2.3 三个包的版本门槛（决定"装哪个"）

| 包 | 在 0.33.3 上 | 在 0.34+ 上 | 说明 |
|---|---|---|---|
| `NikoDemon80/ComfyUI-H3-Motion-Context` **0.3.1** | ✅（官方指定旧核版本：*"Use 0.3.1 on anything older"*） | ✅ | 自带 `patch_layout.py` / `patch_payload.py`，**runtime patch ComfyUI**；只注册 4 个节点（无 Chain）；Save/Load Latent 的 `clip_index` 默认 0 且 0 = 载入最新文件（源码自述 *NOT retry-safe*）；带 fl2va+ref2va 示例 |
| 同包 **≥0.4.0** | ❌ 主动拒绝 | ✅ | 0.4.0 起**不再 patch 核**，改 `layout_contract.py` 自检；旧核上报错 "this ComfyUI still has the older H3 layout … use pack version 0.3.1" |
| `seitanism/…-Motion-Context-MultiRef` | ❌ 硬报错 | ✅ | 依赖原生 #15439；缺失时抛 "requires native MiniMax H3 guide/MultiRef support from ComfyUI PR #15439" |
| `ethanfel/ComfyUI-MiniMaxH3-Contex-Loop` 0.6.9 | ❌（guide 模式有旧核 fallback，但 README 要求 native Add Guide、依赖的 seitanism 包在旧核拒绝、masked 模式明确不支持旧架构） | ✅ | 需要**两个包一起装**；定位是"整套场景计划 + 检查点 + 人工 Review Gate 的递归渲染引擎" |

### 2.4 插件侧接入点（为什么这件事对插件是"加数据"而不是"改架构"）

- 清单契约：`params` 支持 `inject: scalar | image | video`（`lib/manifest.js:43`），字段名支持 `${i}` 占位与点号路径（`ref_images.ref_image_${i}`）。
- 视频注入已有先例：`workflows/extract-frame.json` 用 `inject: video → LoadVideo.file` 把画布视频节点送进图。
- 通用 runner 已有"画布 video 节点 → 上传到 ComfyUI input → 文件名"的通道：`resolveSourceVideo()`（`lib/index.js:1571`），并在 `runRender` 里以 `opts.video_node → job.source_video` 注入（`lib/index.js:1621`）。
- **新参数会被自动透传**：`buildRenderGraph` 显式遍历 `manifest.params`，把 `opts` 里同名字段塞进 job（`lib/index.js:1538-1542`，注释写明"避免新 param 漏注入"）。
- 可用核心节点（本机 0.33.3 实测存在）：`LoadVideo` / `GetVideoComponents`（IMAGE+AUDIO+FPS+帧数）/ `ImageFromBatch`（**支持负 batch_index**，抽帧清单已在用）/ `TrimAudioDuration` / `CreateVideo` / `SaveVideo` / `VAEDecodeAudio`。
- 现有抽帧清单只取 1 帧（`ImageFromBatch(batch_index=-1, length=1)`）；Add Guide 的"clip 锚点"与 Motion Context 的 `context_frames` 需要**一段**（5/22/39 帧），把 `length` 暴露成 scalar 参数即可，仍是清单改动。
- 清单还支持 `requiresNodes`（预检缺节点 → 显式不可用，**不静默替换**）与 `tier` / `priority` / `internal`，正好用来安置"依赖第三方节点的实验档"。

---

## 3. 候选路线（按"装什么"从轻到重）

### R1 · 原生 Ref2VA + `ref_videos`（零安装，今天就能跑）

把上一镜尾段（2–15s）→ `ref_videos.ref_video_0`，尾段音频 → `ref_video_audios.ref_video_audio_0`，参考图槽位照旧放角色卡/场景卡。

- 图：`LoadVideo(上一镜) → GetVideoComponents → ImageFromBatch(负索引取尾段) → Ref2VA.ref_videos`；`GetVideoComponents.AUDIO → TrimAudioDuration → Ref2VA.ref_video_audios`。
- **得**：动作/节奏/氛围音"同一场戏"的倾向；零安装、零核升级、零第三方依赖。
- **失**：语义是**参考（模仿）**——Motion Context 作者的原话是"a cover band, not the same recording"；画面不做任何像素/latent 锚定，接缝仍在。
- **成本未知项**：参考视频是逐采样步参与的 token，2s=48 帧 vs 5s=124 帧的开销必须实测（可能显著慢于仅参考图）。

### R2 · 原生 Ref2VA + Add Guide（升核，官方路径）

`Ref2VA → Add Guide(上一镜尾帧/尾段, frame_idx=0) → guider/sampler`，尾段按 17k+5 裁成 5/22/39 帧即可当"clip 锚点"。

- **得**：官方模板与官方教程背书的"续写 + 多镜头"路径；画面头部被真实锚住（≈ FL2VA 的首帧语义），**同时保留参考绑定**。
- **失**：① 文本编码器看不到 guide 帧（教程原话），官方给的补救是"把这些图也塞进 `ref_images` 槽位"——槽位有限（≤9）且参考图越多越贵；② 锚帧走"解码→编码"往返（Niko 指出这正是长链色彩漂移与发糊的来源）；③ **音频不续接**（guide audio 只能从锚点向前）；④ 必须处理"钉住头部"带来的长度/时间码预算（Add Guide 模式下由 Trim 或 prompt 侧补偿）。
- 附加收益：同一机制可以让**一镜之内**出现多个关键帧（官方 multiframe 模板的多镜写法），也就是 §3 R5。

### R3 · Ref2VA + Motion Context（升核 + 第三方包）

`Ref2VA → MotionContext(context_latent=上一镜 latent 或 context_frames+context_audio) → guider/sampler → decoder → Trim → SaveVideo`；
latent 用 `…SaveLatent`/`…LoadLatent` 跨运行搬运（首镜 Load 0 / Save 1，第二镜 Load 1 / Save 2）。

- **得**：① latent 级钉住（bit-for-bit，无编解码往返）；② **音频真续接**（坐标改写，实测 0.45 → 0.95+，且误差不随链长累积）；③ Trim/Seam Probe 让接缝可测。
- **失 / 约束**：链式音频逐环变闷；分辨率链中不可变（latent 不能缩放）；交付片段比采样短 `context_length` 帧（22 帧 ≈ 0.92s，prompt 时间码要按采样长度写）；**跳步加速器与 turbo LoRA 都会额外伤音频**——本机 `fast`/`balanced` 两档正是 4 步/8 步蒸馏档，必须实测叠加效应；旧核上用 0.3.1 会 runtime patch 核（官方警告同机只装一个 H3 chaining 包）。

### R4 · 混合 checkpoint + "I2V + Reference" 节点（不升核的替代）

社区做法：**FL2VA/Ref2VA 合并权重** + 一个同时吃首末帧与参考素材的节点（`BigStationW/ComfyUi-MiniMax-H3-Image-And-Reference-To-Video`，注册单节点 `MiniMaxH3ImageAndReferenceToVideo`；权重见 `smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models`）。

- **权重形态**：4 个变体 `b15-49 / b20-49 / b25-49 / b30-49`，**统一为 int8 safetensors，各 ≈19.5GiB**（无 bf16 / fp8 / GGUF）。建法是把 50 层里 blocks N–49 的 per-block `adaln_proj` 换成 ref2va 的、其余全取 fl2va；区间越大越偏参考（参考更强、画质略降），作者建议从 `b25-49` 起试。base 是 **pruned int8-convrot**，与本机现有权重同一量化族。
- **节点行为**：`first_frame` / `last_frame` 同时进 Qwen3-VL 视觉上下文**和** DiT 的 `minimax_keyframes`；`ref_images`(≤10) / `ref_videos`(≤4) / `ref_video_audios`(≤4) / `ref_audios`(≤4) 走 `minimax_refs`——两套在同一次调用内共存，正是 Ref2VA 缺的那一半。**不 patch 核**：复用 `comfy_extras.nodes_minimax_h3` 的私有助手（因此对核私有 API 变动敏感）。
- **得**：单次生成里同时拿到参考绑定与端点锚定，且作者主张其相对"Add Guide + Ref2VA"的优势是**文本编码器能看到锚帧**；不需要升级核。
- **失 / 风险**：① 多一份 ~19.5GiB 权重与一次模型切换重载；② 社区合并权重，质量口径分歧（有"b20-49 全面好用，我把原生 fl2va/ref2va 归档了"的好评，也有"prompt 遵循被摧毁"的报告——后者发帖人已更正为误用 Blackwell 专用 `nvfp4_awq` 文本编码器所致）；③ 有白皮书主张 FL2VA 本身已带参考通道、叠加只改变约 0.4% 的调制输出，并点名 `25–49` 一族"更锐但会累积伪影"——即"该不该合并"本身有争议；④ 与 motion context 不叠加（**仍不解决音频续接**，该路线在所有一手来源里都没有跨镜音频证据）；⑤ 需较新的核（`io.Autogrow` API），版本要求未声明。
- 定位：只有当 E2/E3 在"锚帧被文本编码器忽略"这一项上反复失败时才值得投入。

### R5 · 官方 multiframe 模板：一次生成多镜（正交的另一半答案）

官方 *MiniMax H3 Multiframe Reference* 模板把 N 张关键帧分别锚在 0 / 1.5s / 3.0s / 5.0s…，prompt 里按 `<Picture N>` 与时间戳切换镜头——**镜间接缝从"要缝合的问题"变成"不存在的问题"**。

- 对本机约束：单次长度上限 310 帧（≈12.9s），所以一次生成约 2–3 个短镜。
- 与插件模型的冲突：插件是"一镜一节点"，这个模式是"一次生成产出多镜"。若采用，需要新的能力词汇（例如 `video.multishot2video` + shotlist 入参）或让一次生成只承载一个"镜头组"。
- 建议先作为**同一场景内的 2–3 镜**手段验证，而不是替换逐镜流程。

---

## 4. 机理对照表

| 维度 | R1 参考视频 | R2 原生 Add Guide | R3 Motion Context | R4 混合 checkpoint | R5 一次多镜 |
|---|---|---|---|---|---|
| 需要装什么 | 无 | 核 ≥0.34 | 核 ≥0.34 + 第三方包（0.33.3 上退化为 Niko 0.3.1 + runtime patch） | 第三方节点 + 合并权重（≈19.5GiB int8，不升核） | 核 ≥0.34（官方模板） |
| 参考绑定（角色/场景卡） | ✅ 原生 | ✅ 原生（可与 guide 并存） | ✅ 原生 | ✅（合并权重语义） | ✅ 原生 |
| 画面锚定 | ❌（只影响倾向） | ✅ 端点/任意帧，像素往返 | ✅ latent bit-for-bit | ✅ 端点，走文本编码器 | ✅ 多锚点 |
| 音频续接 | ❌（模仿） | ❌（只能向前） | ✅（时间轴续接） | ❌（无任何跨镜音频证据） | 不适用（同一次生成） |
| 文本编码器能看到锚帧 | 不适用 | ❌（官方教程明确；补救=也塞 ref_images） | ❌（同上） | ✅（作者主张） | ✅（作为 ref 槽位） |
| 主要已知劣化 | 参考内容污染、成本未知 | 色偏/发糊（往返）、音频重启 | 音频逐环变闷、分辨率锁、剪头 22 帧 | 社区权重质量口径分歧（有"prompt 遵循被摧毁"报告，后被更正为文本编码器误用） | 单次时长上限、prompt 复杂度 |
| 本机一键可行？ | ✅ | 需升核 | 需升核 + 装包 | 需下 19.5GiB 模型 + 装节点 | 需升核 |

---

## 5. 建议的落地形态（与现有契约对齐）

1. **新增清单，不改 skill 词汇**：把上述路线做成 `workflows/` 里的新 JSON（如 `*-ref2v-ctx-*.json`），用 `requiresNodes` 声明依赖（`MiniMaxH3AddGuide` / `MiniMaxH3MotionContext`），缺依赖时**显式不可用**而不是静默退回。
2. **R1 先做，因为它几乎只是数据**：清单 + `source_video` 复用（`opts.video_node`）即可，不需要动 JS；若要更语义化的入参，再加一个 `context_video_node`（照 `resolveSourceVideo` 复制一行）。
3. **R2/R3 需要一个"链状态"概念**：Motion Context 的 Save/Load Latent 是**文件槽位**（`clip_00002.safetensors` + `clip_index`），Add Guide 需要"上一镜尾帧/尾段"作为输入。两者都可以由 runner 从**画布上已存在的上一镜节点**推导（抽帧已有 `extract_frame`），但"哪个镜是上一镜、是否同场景"属于流程策略——按现有设计应来自镜头表的 `continuity` 段（见 `docs/consistency-optimization-plan.md` 的 W3/W4），**不要写进工具描述**。
4. **口子留干净**：把 `context_length` / `audio_context_length` / `anchor_mode` 一类参数作为清单 `params`（scalar 注入），而不是硬编码进图模板，便于 A/B 与回退。
5. **加速件与链条的关系要实测**：本机默认档是蒸馏档（4 步/8 步 + PDD 头 + 可选 Sol-Attn），而链条 + 蒸馏对音频是**双重**损失源。建议给"连续性档"单独标注，并保留一条"不蒸馏"的对照。

---

## 6. 待跑实验（每步都给通过线）

| # | 实验 | 变量 | 指标 | 通过线 | 粗估成本 |
|---|---|---|---|---|---|
| **E0** | 基线与工具就位 | 现网 r2v（仅参考图）vs 现网 i2v（首帧串联）vs R1（+参考尾段 2s） | 接缝指标：`seam_probe.py`（音频互相关/滞后）、`level_step.py`（响度/底噪跳变）、`freeze_detect.py`（画面是否冻住）+ 人眼首帧比对 | 拿到三条可复现的基线曲线（没有基线就无法证明任何"改善"） | 3 × fast（~25s/镜）+ 本地 numpy 分析 |
| **E1** | 升核回归（0.33.3 → ≥0.34，先不动任何图） | 现网 4 档 × 1 镜 | 是否可加载、耗时、音轨是否存在 | 4 档全部仍可跑且音轨在；否则立刻回滚 | 30 min 运维 + 4 × 各档耗时 |
| **E2** | R2 原生 Add Guide + Ref2VA（官方模板改造） | guide = 上一镜尾段（5/22/39 帧）@ frame 0；开/关"把尾帧也塞进 ref_images" | 接缝（画面级差 + 音频）+ 身份是否仍保（与角色卡并排比对） | 画面接缝优于 E0 的 i2v 基线；且身份不劣化 | 每变体 1 × balanced（~140–190s） |
| **E3** | R3 Motion Context（latent 路径） | `context_length` 22；`audio_context_length` 24；音频 timeline vs ref 模式 | `seam_probe` 相关性与滞后、`level_step` | 音频相关性显著高于 E2（作者数据 ~0.95+），滞后恒定不累积 | 装包 + 每变体 1 × balanced；建议同时跑一版 quality 定调 |
| **E4** | R4 混合 checkpoint | 仅当 E2/E3 在"锚帧被文本编码器忽略"上反复失败才做 | 同上 + 色偏/拉扯 | 明显优于 E2 | 需下 20–40GB 权重 + 额外显存 |
| **E5** | R5 一次多镜（官方 multiframe） | 同场景 2–3 镜写进一次生成 | 镜间连续性（无接缝即为满分）+ 单镜可控性 | 组内连续性明显优于逐镜拼接 | 1 × balanced（长度 ×2–3） |

> **实测进度（2026-09-15）**：E1（升核回归）✅ 已完成（0.35.2，四档清单字段兼容，仅 `CreateVideo` 多一个 `color_space`）；E3（R3 Motion Context）✅ 已完成并落地为插件清单——结论与数据见 §8；E0 用自建度量替代（同 prompt 同 seed 的"续接 vs 不续接"对照，比跨实现基线更能隔离变量）；E2 / E4 / E5 未跑（R3 已满足需求，不再为对照烧机时）。

**测量工具**：Niko 包自带 `tests/seam_probe.py` / `level_step.py` / `freeze_detect.py`（**只需 numpy，可在本机跑**），是这套研究里现成的客观尺子；CLI 版有 ~8ms 的"幽灵滞后"来自按文件末尾推断接缝位置，图内 Seam Probe 节点没有这个问题。注意 H3 输出 **32 kHz** 音频，重封装/拼接脚本不要硬编码 48 kHz。

**顺序理由**：E0 无风险且产出了衡量后面一切的标准；E1 是前置门（不升核，R2/R3/R5 全部不成立）；E2 用官方路径拿"画面续接"；E3 才付第三方包的信任与维护成本换"音频续接 + latent 级无往返"；E4/E5 是正交备选。

---

## 7. 风险、回滚与未验证

**风险与回滚**
- 升核（`git checkout v0.34.x` + `pip install -r requirements.txt` + 重启容器）会同时改变 PDD-Acc 与 Sol-Attn 两个第三方包的运行环境；两包都声明支持 0.33.0+（PDD 明说 pre/post-#15375 核都行），但**没在本机验证过**。回滚路径很短：容器镜像不变、核在宿主目录且是干净 git 仓库，`git checkout v0.33.3` + 重装依赖即可。
- 本机档位的 `estSeconds` 是 0.33.3 上实测的，升核后耗时可能漂移 → 清单里的实测值需要重跑一次（`scripts/bench-h3.mjs`）。
- 旧核上用 Niko 0.3.1 意味着**核被 runtime patch**：与已有的 PDD-Acc / SolAttn 包共同作用未见证据，且官方警告同机只装一个 H3 chaining 包。
- 制作侧连锁：链式音频逐环变闷 ⇒ 长片不应整片走链条，建议只在"同场景续接段"内链，跨场景重置。

**未验证（不要在文档/对话里当成结论）**
1. R1 的成本：把 2–15s 参考视频接进 Ref2VA，采样耗时与显存增量未知（参考 token 每步参与）。
2. Add Guide 与参考图槽位同时使用时的相互影响（教程只说"文本编码器看不到 guide 帧"，没说会不会挤压参考 token 预算）。
3. Motion Context 的钉头 22 帧 + 本机 8 步 PDD 蒸馏档 + Sol-Attn 的组合效果（三者的音频/细节损失是否叠加）。
4. seitanism MultiRef 的 masked/extension 能力（对"品牌原素材不许重绘"这类硬约束可能比 motion context 更有用）尚未评估。
5. R4 混合 checkpoint 的**速度**（无 hybrid vs 原版的可复现对比）与**许可**（该 HF 库写 `license: other`，衍生库标 H3 community license）；合并权重族内部对"该用哪个区间"仍有分歧。
6. ~~本机尚未有任何一条 A/B~~ → **2026-09-15 已补**：R3 与对照的 A/B 见 §8；§4 表格里其余路线（R1/R2/R4/R5）的"优于"仍是机制推断。
7. **装包/下权重的网络路径**（§2.1）：远端能直连 GitHub，本机不能；HF 官方站两侧都不通，只能走 hf-mirror。Niko/seitanism/ethanfel 三包与 19.5GiB 混合权重都得在**远端**拉。

---

## 8. 实测结论（2026-09-15 · R3 落地）

**环境**：远端 ComfyUI **0.35.2**（升核后 PDD-Acc / Sol-Attn 仍注册可用，现网 4 档清单字段兼容），
`ComfyUI-H3-Motion-Context` 0.6.2 装载成功（6 个节点注册），sm_80 单卡。

**机制验证（裸图，直接提交 ComfyUI API）**

| 路径 | 结果 |
|---|---|
| 像素路径（`LoadVideo` 尾 22 帧 + 尾 1s 音频 → `context_frames`/`context_audio`） | 跑通；画面接缝 MAD **11.1**，对照 **57.4** |
| latent 路径（`Save/Load Latent` + `clip_index`） | 跑通；接缝 MAD **3.2**（同一对片子的最优值），日志 `drift 0.01ms` |
| 不续接对照 | MAD 57–67；自测基线（同一条片子首尾帧）58 ⇒ 续接后的接缝已优于"同片自然差异" |
| 音频（音乐型素材，包络相关） | 续接 **0.87** vs 对照 **0.25**；宽带相关（1s 窗）0.60 vs 0.17 |
| 音频（风声型素材） | 相关指标对"续接/随便两段"都给不出区分度 ⇒ **噪声型声景只能听，不能算**；响度台阶倒是稳定：续接 0.5dB vs 对照 −5.7dB |

**档位 × 加速件覆盖（4 档全部实跑，同 seed 对照，各档原生分辨率）**

| 档位实现 | 加速件 | 分辨率 | 画面 MAD 续接→对照 | 音频相关 1s 续接→对照 | 响度台阶 续接→对照 |
|---|---|---|---|---|---|
| `…-ctx-fast` | 4 步蒸馏 LoRA | 832×480 | **7.016** → 67.559 | **0.391** → 0.060 | **+0.69 dB** → −19.83 dB |
| `…-ctx-balanced` | 8 步 768p 蒸馏 LoRA | 1344×768 | **2.631** → 32.350 | **0.534** → 0.017 | **−0.77 dB** → −8.78 dB |
| `…-ctx-balanced-pdd` | PDD nfe=8 | 1344×768 | **3.436** → 51.176 | **0.305** → 0.065 | **−0.26 dB** → −14.62 dB |
| `…-ctx-quality` | 无（20 步） | 1344×768 | **2.605** → 35.546 | **0.552** → 0.096 | **+0.09 dB** → −24.04 dB |

四档结论一致：续接把接缝画面差压到 2.6–7.0，同 seed 对照 32–68；音频在音乐型素材上四档全部正向。
**续接带来的是"同一段画面"，不是"更高画质"**（MAD 与档位几乎无关）。完整表（含包络相关与耗时）
见 `docs/shot-chain-continuity.md` 附 B；原始数据 `e2e-out/chain-bench/rows.json`。

**Sol-Attn 叠加未测且不可测**：`…-ctx-balanced-pdd-sol` 会让 ComfyUI 硬崩
（`CUDA_ERROR_INVALID_VALUE from cuMemFreeAsync` → `Fatal Python error: Aborted`，容器重启），
带／不带续接都崩 ⇒ 与 Motion Context 无关；该变体已从交付集撤销，见 `docs/minimax-h3-acceleration-lora.md` §9.10。

**成本**：多采的 22 帧被裁掉，同档位耗时差异在噪声内（fast 50.8s vs 50.1s；插件路径 38.6s/镜）。

**插件落地**（本轮实际改动）

- 清单契约新增 `manifest.chain`（`source` / `sampleExtra` / `lengthGrid`）+ 校验；
  runner 只做两件事：从画布上一镜节点承接槽位序号（`Load=上一镜序号`、`Save=+1`，不传即起链 `Load 0`）、
  按清单声明的补偿与网格换算交付帧数。**模型名仍然只出现在清单里。**
- 新组 `minimax-h3-ref2v-ctx`（4 档，priority −100 ⇒ 永不为隐式默认），工具面新增 `continuity_from`。
- 顺手修掉一个真 bug：`comfyOutputs` 会把 `LoadVideo` 的输入回显（`type=input`）当产物收集——
  链式实现里这会把"上一镜"当成这一镜的成片存进画布。
- 端到端脚本 `scripts/e2e-chain-continuity.mjs`（起链 → 续接 → 非链式反例 → 同 seed 对照）。

**仍未验证**（2026-09 更新）：

* **i2v 版链式续接**：未实现（`type=i2v` + `continuity_from` 显式报错）；跨形状续接（r2v → i2v）已允许但未实跑。
* **长链（>5 镜）的音质衰减**：本轮最长只验到 3 镜（起链 → 续接 → 对照）。
* **跨会话槽位冲突**：随机起点只把概率压低，无硬保证（上游包无校验和/所有权标记）。
* 已完成（原列于此，现已覆盖）：balanced / quality 逐档实跑、PDD 与 4 步蒸馏叠加后的音频表现、四档接缝量化。

---

## 附：参考来源

- ComfyUI 核心源码（`MiniMaxH3AddGuide` / `MiniMaxH3ReferenceToVideo` / `MiniMaxH3ImageToVideo`）：<https://raw.githubusercontent.com/Comfy-Org/ComfyUI/master/comfy_extras/nodes_minimax_h3.py>
- ComfyUI v0.34.0 release（含 "Add MiniMaxH3AddGuide … PR #15439"）：<https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.34.0>
- 官方教程《ComfyUI MiniMax H3 多帧参考工作流》：<https://docs.comfy.org/zh/tutorials/video/minimax/minimax-h3-multiframe>
- 官方模板 JSON：<https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_multiframe_reference.json>
- NikoDemon80/ComfyUI-H3-Motion-Context（README/CHANGELOG/nodes.py/probe_node.py）：<https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context>
- seitanism/ComfyUI-H3-Motion-Context-MultiRef：<https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef>
- ethanfel/ComfyUI-MiniMaxH3-Context-Loop（0.6.9，前身名 Contex-Loop）：<https://github.com/ethanfel/ComfyUI-MiniMaxH3-Context-Loop>
- BigStationW/ComfyUi-MiniMax-H3-Image-And-Reference-To-Video：<https://github.com/BigStationW/ComfyUi-MiniMax-H3-Image-And-Reference-To-Video>
- 合并权重 `smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models`：<https://huggingface.co/smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models>
- 插件侧契约：`docs/workflow-contract.md`（M5：加工作流=丢 JSON）、`docs/tier-strategy-design.md`、`docs/consistency-optimization-plan.md`（W3 镜头表 / W4 串联决策）

*文档日期：2026-09-15（§8 实测补充）· 环境事实：远端已升到 0.35.2；社区包行为来自其 README/CHANGELOG/源码；R3 的 A/B 见 §8。*
