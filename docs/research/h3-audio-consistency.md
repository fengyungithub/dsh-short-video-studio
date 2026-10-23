# MiniMax H3 如何解决「声音一致性」——调研总报告

> 调研日期：2026-10-23。合并两份底层笔记：
> - [`h3-audio-local.md`](h3-audio-local.md)：本仓代码 / 工作流 / 实测（证据分级 `[CODE]` / `[DOC]` / `[MEASURED]` / `[INFERRED]`）
> - [`h3-audio-web.md`](h3-audio-web.md)：官方与公开资料（`【官方】` / `【ComfyUI】` / `【社区】` / `【缺口】`）
>
> 一句话：**H3 的"声音一致性"不是靠一个声纹模块解决的，而是三件事叠加——① 音视频在同一个 packed 序列里被同一个 Transformer 联合去噪（结构保证同源）；② 参考音频以 `<Audio N>` 条件进入上下文，用 `(Sx)` 绑到人（身份保证）；③ 单次生成内原生多镜头 + `<scenetrans>` 让一段台词跨切点不断（时间保证）。超出单次 4–15s 的跨调用一致性，官方没有机制，全靠工程补丁。**

---

## 0. 先把"声音一致性"拆成三个不同的问题

混在一起谈会得出错误结论。三者机制完全不同，证据强度也不同：

| 子问题 | 官方有没有解 | 靠什么 | 证据强度 |
|---|---|---|---|
| **A. 音画同步 / 口型对得上** | 有，结构性 | 音视频 latent 联合预测，不是后期配音 | 强（官方架构 + 本机接线） |
| **B. 一次生成内的多镜头，声音不断、还是同一个人** | 有 | native multi-shot + `<scenetrans>` + 固定 `(Sx)` | 中（官方声明，无量化） |
| **C. 跨多次生成（长片/多镜分次跑）音色不变** | **没有官方解** | 重复参考音频 + 重复描述 + latent 续接 | 弱（社区自报 + 本机单次实测） |

官方文档的承诺范围始终是 **单次生成 4–15 秒**。把 C 当成模型能力写进产品说明，属于把工程补丁说成模型能力。

---

## 1. 结构层：音频不是"后挂的 TTS"，是同一个去噪轨迹里的一段 latent

### 1.1 官方架构（`【官方】`）

H3-Base 把各模态编码后**打包成一条统一多模态序列**，整体送进 33B dense 单流 `H3-Omni-Transformer`：

- 文本 → `H3-Encoder`（Qwen3-VL-32B 全量权重，取第 50 层 hidden states）
- 视觉 → `H3-Encoder` + `H3-VisualVAE`（f16t4d24，再 patchify `1×2×2` ⇒ 有效 32× 空间 / 4× 时间下采样）
- **音频 → 只经 `H3-AudioVAE`**（不经过语言编码器）
- Transformer **联合预测 video latent 与 audio latent**，再分别解码成画面与立体声

来源：[README · Model Architecture](https://github.com/MiniMax-AI/MiniMax-H3#model-architecture)、[发布博文](https://www.minimax.io/blog/minimax-h3)、[开源公告](https://www.minimax.io/news/minimax-h3-open-source)。

关键含义：**说话人音色不是外挂的 speaker embedding，而是音频 latent 序列里的信息**，和画面 latent 在同一个注意力场里共同建模。这是"口型 + 音画同步 + 音色"能同时成立的结构性原因，也是它区别于"视频模型 + 独立 TTS"的地方。

### 1.2 音频 VAE 规格（`【官方】`，本机可证采样率）

| 项 | 规格 |
|---|---|
| 输出 | **32 kHz 立体声**（不是 44.1k） |
| 声道处理 | 左右声道共用同一套 encoder/decoder，但**各自独立处理**，解码后合成 |
| latent 速率 | 每声道 **40 Hz**（≈ 每秒 80 个音频 token，与 24fps 画面按 4× 时间压缩后的 6 latent 帧/秒交错） |
| 训练技巧 | 借鉴 VA-VAE 优化 latent 空间（保重建、降学习难度） |

来源：[README · H3-AudioVAE](https://github.com/MiniMax-AI/MiniMax-H3#h3-audiovae)。
本机旁证：`e2e-out/chain-bench/rows.json` 每条记录 `"audio_rate": [32000, 32000]`。

### 1.3 本机工作流的接线（`[CODE]`，可复核）

`workflows/minimax-h3-ref2v-quality.json`：

| 环节 | 节点 | 说明 |
|---|---|---|
| 条件 + 初始 latent | `MiniMaxH3ReferenceToVideo`（node 5） | 输出槽 0 = CONDITIONING、槽 1 = LATENT；`audio_vae` 作条件输入 |
| 采样 | `SamplerCustomAdvanced`（node 10） | **只有这一个采样器** |
| 视频解码 | `VAEDecode`（node 11） | `samples: ["10", 0]` |
| **音频解码** | `VAEDecodeAudio`（node 11a） | **同一个 `["10", 0]`** |
| 封装 | `CreateVideo`（node 12） | `images: ["11",0]`、`audio: ["11a",0]` |

⇒ 音频和画面**共享同一条采样轨迹**。全仓 39 个 H3 清单里都没有音频专用采样器、没有音频 CFG；只有同一条调度上的两路重参数化：

```json
"class_type": "MiniMaxH3SigmaShift",
"inputs": { "model": ["$model", 0], "shift_video": 12, "shift_audio": 3 }
```

这条与官方口径一致（`BasicGuider` cfg=1、无 negative 分支）。**注意它不是"音频一致性机制"，只是采样调度**；把它当成"模型会记住音色"是误读。

### 1.4 不是自回归

`【官方】` 发布的是 **CFG-distilled** 权重，推理是多步去噪（默认 20 步，4 步 Lightning turbo LoRA 可选）。`【第三方】` 独立论文亦描述为 multi-step iterative denoising（[Sol-H3, arXiv 2609.35110](https://arxiv.org/abs/2609.35110)）。

⇒ 不存在"逐 token 续写同一把嗓子"；一致性来自**同一条去噪轨迹覆盖整段时长**。这也解释了为什么切成两次生成后一致性会掉（见 §4）。

---

## 2. 参考音频条件：H3 唯一的"声线绑定"入口

### 2.1 能力与硬约束（`【官方】`）

只有 **H3-Base-Ref2VA** 接参考音频（FL2VA 只接首/尾帧）：

| 类型 | 上限 | 约束 |
|---|---|---|
| 图片 | ≤ 9 | — |
| 视频 | ≤ 3 段 | 每段 2–15s，总计 ≤ 15s |
| **音频** | **≤ 3 段** | 每段 2–15s、总 ≤ 15s、单文件 ≤ 15MB；**不能单独作为唯一输入，必须伴随图像或视频** |
| 混合 | 共 ≤ 12 个文件 | — |

来源：[开源公告 · Model Variants](https://www.minimax.io/news/minimax-h3-open-source)、[API 文档](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)（`role=reference_audio`，与 `first_frame`/`last_frame` 互斥）。

⇒ **"纯音频 → 克隆声线"被明确堵死**。它叫 Ref2VA 而不是 voice clone，不是命名随意：音频必须"附着"在一个视觉主体上。

### 2.2 绑定是三件事的组合（`【官方】`）

```text
subject_definitions:
<Audio 2> is the voice-timbre reference for <Subject 1> (S1).

retention_analysis:
<Audio 2>: reference - the target speaker follows <Audio 2>'s voice timbre and
measured delivery without copying the original signal.

detailed_description:
[Shot 1] <Subject 1> (S1) speaks softly, <d>[English] Follow the wind, live free.</d>
```

1. **`<Audio N>` 定义角色与归属**：音色参考必须复用该主体的全局 speaker ID（`<Subject N> (Sx)`），**不得在音频定义里另起编号**。
2. **`retention_analysis` 声明复制强度**，四档语义分界很清楚：

| marker | 含义 | 什么时候用 |
|---|---|---|
| `fully_copy` | 整段源音频 1:1 作为目标视频**完整最终音轨** | 等于放弃原生音频生成 |
| `partially_copy` | 只复制部分时间线/音层，或复制后增删替换 | 保留 BGM + 新对白 |
| **`reference`** | **不复制信号，只借音色/节奏/风格/声音质感** | **"同一把嗓子说新台词"——一致性主用档** |
| `weak_reference` | 只保留类别或氛围的宽泛相似 | 弱约束 |

3. **在镜头描述里让主体真的开口**：`<Subject 1> (S1) says, <d>[English] ...</d>`。

来源：[ref-en.txt §2.4 / §4.2 / §5.4](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt)。

### 2.3 三条容易踩的规则（`【官方】`）

- **只借音色时，不要把参考音频里的原台词搬进目标视频**（"When only timbre ... is referenced, do not carry the original dialogue"）。要复刻台词才逐字保留 + `[unclear]`。
- **参考视频自带的声音不会自动变成 `<Audio N>`**：必须显式声明；本机 ComfyUI 里还要 `ref_video_audio_N` 与 `ref_video_N` 配对，否则该音轨被静默丢弃（`【ComfyUI】`）。
- **`(Sx)` 按"目标视频实际发声顺序"分配且全片复用**；多人同时说话用 `(S1,S2)`；不发声的角色不给 ID。

### 2.4 没有 voice id / voice clone

- `【官方】` API 无 `voice_id`/`speaker_id`/`voice_clone` 字段，唯一入口是 `role=reference_audio`。
- `【ComfyUI】` 本地节点也只有 `LoadAudio` + 音频 VAE 参考通路。
- ⇒ H3 是 **reference-conditioned（参考条件化）**，不是 **voice identity enrollment（声纹注册）**。每生成一次就得重新喂同一段音频——这正是跨镜一致性在工程上要反复"复述"的原因。

---

## 3. 单次生成内的"跨镜"：官方唯一的结构性保证

`【官方】` 预训练任务里明确有 **native multi-shot modeling**，音频侧是 **"No separation between voice, sound effects, and music — all jointly modeled"**（[发布博文](https://www.minimax.io/blog/minimax-h3)）。同一段 4–15s 内用 `[Shot 2] At 00:03.500, the camera cuts to...` 切镜时：

- 音频仍在**同一条 latent / 同一次去噪**里，切点两侧天然同源；
- 官方给了一条显式跨切指令：*"When the same line of dialogue or lyrics crosses a cut, use `<scenetrans>` at the connecting points in both parts and explicitly state that the audio continues across the cut."* 可用措辞：`continues seamlessly across the cut` / `continues uninterrupted into the next shot` / `carries over from the previous shot` / `remains audible across the transition`（`base-en.txt §4.4`）；
- 说话人 ID 跨 `[Shot N]` 不变（`A speaker keeps the same ID across shots`）。

⇒ **"能一次生成就别切次"是最高优先级的声音一致性策略**，不是风格偏好。

> 作用域警告：这里说的 "across shots" 是**同一次生成内的 shots**。本仓片型 skill 把同一个 `(S1)` 写进每一镜的 prompt、并称之为"跨镜复用"，那是**提示词层的自我约定**；模型侧没有跨调用 ID 绑定。该约定只能通过"稳定的音色文字描述"起作用，**没有任何机制保证两次调用的音色相同**。

---

## 4. 跨多次生成：官方缺失，工程补丁有四种

### 4.1 官方口径（`【官方】`/`【缺口】`）

- 输出 4–15s、24 fps、短边默认 768，2K 靠 `H3-Regenerate-2K` 二次生成。
- **没有任何"跨调用保持同一把嗓子"的机制或承诺**；也没有 speaker similarity / SECS / 声纹指标。
- `H3-Context-IR`（"哪段音频对应哪个人、要不要复刻原话"的理解层）**闭源**，官方称它 "critical to the quality of the final output"。本地跑 H3-Base 时，这层判断要人肉写进 prompt 补齐。

### 4.2 四种工程补丁

| 补丁 | 做法 | 证据 |
|---|---|---|
| **① 参考音频逐镜复喂** | 每镜都带同一份 2–15s 干净人声，逐镜重复 `<Audio N> is the voice-timbre reference for <Subject N> (Sx)` | `【官方】` 规范；效果无官方量化 |
| **② 音频锚点 / AV latent 续接** | ComfyUI `MiniMaxH3AddGuide` 可在任意 `frame_idx` 钉 guide，**音频 guide 在同一帧号对齐、裁到剩余时长**；"first 22 frames of a clip at frame 0 continues both streams"。本仓 `continuity_from` 更进一步：把上一镜 **AV latent** 直接钉进新镜开头（见 §5） | `【ComfyUI】` 文档；本仓 `[CODE]` |
| **③ 局部重绘 audio latent** | per-token noise mask：0 = keep，1 = regenerate；音频 mask 只能按**整个 audio latent 帧**切（`【ComfyUI】`） | 文档 |
| **④ 声线参考按人分开** | 每个角色各自一份 `voice_ref`，避免串音；多说话人 + 参考音频时**台词绑到可见事件而非时间码**，否则会张冠李戴（ComfyUI 明写此失败模式） | `【ComfyUI】` + `【社区】` |

### 4.3 社区长链经验（`【社区】`，自报，未独立复验）

来自 `joeygambino/MiniMax-H3-Multishot-Workflow`（"H3 Seamless Chain"）：

- **`seed_per_shot` 必须开**：*"a single seed shared across all shots drifted both face and voice"* —— 反直觉：全片共用 seed 会让脸和嗓子一起漂。
- 接缝做 **40 ms equal-power weld** 防爆音；**每镜前约 1 秒是"丢弃重放"**（对白从第 0 帧开口会被吃掉开头音节）；一句台词永远不跨两镜。
- **锁 24 fps**：*"Other rates audibly shift voice accents."*
- 每镜开头 ~2s 静默的 AIRLOCK、角色与光线的描述逐字重复。
- 自报限制：长链纹理每接缝 +13%，建议单次续接 ≤ ~4 窗（30–40s）。

`【ComfyUI】` 另有两条与"音色强度"直接相关的操作口径：4 步 turbo LoRA 会 **weaker reference/audio**，参考要"持住"就用 **20–25 步**；多说话人错配时"按人外部生成音频 + 用对 marker（`fully_copy` vs `partially_copy`）"。

---

## 5. 本仓（dsh-short-video-studio）实际做了什么

### 5.1 已实现：链式 AV latent 续接（`[CODE]`）

`workflows/minimax-h3-*-ctx-*.json` 比普通图多四个节点：

| 节点 | 作用 |
|---|---|
| `MiniMaxH3MotionContextLoadLatent` | 读上一镜 AV latent（槽位 + `clip_index`） |
| `MiniMaxH3MotionContext` | 钉上下文；`context_length: "22"`（画面帧）+ `audio_context_length: 24`（音频） |
| `MiniMaxH3MotionContextSaveLatent` | 存本镜**首遍**采样 latent |
| `MiniMaxH3MotionContextTrim` | 从画面与音频两侧裁掉继承段 |

服务端日志（`docs/shot-chain-continuity.md:265`）说明搬了什么：

```text
video from latent, video/head, 22 frames -> 7 cond blocks at indices 0..18,
  158 frame clip at 832x480, trim 22,
  audio 24 frames -> 40 latent steps (1.000s) from latent,
  on the timeline ending at frame 22.200
```

⇒ 音频**不是从 0 重新开始，而是结束于接缝**（22.2/24 ≈ 0.925s）。这是"声音接着走"的具体形态。另外 `first_frame_node` 在链式镜里会被丢弃（`dropped 1 keyframe anchor(s) at frame(s) [0]`），因为 head 已决定前 22 帧。

两条硬约束（`lib/index.js`）：

- **首遍尺寸必须一致**（`:1442 chainGraphMismatch`）：链上流动的是首遍 latent，不能缩放；交付尺寸可以不同。
- **上一镜必须也是链式实现渲染的**（`:2420`），否则报"上一镜没有链式序号"。

### 5.2 ⚠️ 最大缺口：参考音频"可写但不可达"

39 个 H3 清单里 `ref_*` 只有 `ref_image_*`（×20）、`ref_image_size`、`ref_images`；**零** `ref_audios` / `ref_video_audios` / `ref_videos`。`lib/` 里 `ref_audio` 零命中，`params.refs` 只有一个 `"inject": "image"` 通道。

⇒ 片型 skill 能写出完全合法的 `<Audio 1> is the voice-timbre reference for <Subject 1> (S1).`，但**插件没有办法把音频文件送进 ComfyUI**。所以本仓生产里：

- **跨镜音色一致性完全靠"文本描述 + 链式续接"**，不靠音频参考；
- 声景连续性只能靠同一段 `overall_soundscape` 文字逐镜重复；
- 上游节点其实有 `ref_videos`/`ref_video_audios`/`ref_audios` 槽位（`docs/ref2va-shot-continuity-research.md:38`），只是没接。

这是"文档承诺"与"代码能力"之间最大的一处缺口，且**没有任何文档承认它**。

### 5.3 实测数字与它们的水分（`[MEASURED, n=1]`）

接缝质量（`docs/shot-chain-continuity.md` 附 A/B/F）：

| 指标 | 续接 | 不续接对照 |
|---|---|---|
| 画面接缝 MAD（0–255） | **2.6–7.0**（放大族 13.3） | 32–68（放大族 79.6） |
| 接缝响度台阶 | **−0.77…+0.69 dB** | **−8.78…−24.04 dB** |
| 音频 1s 窗相关 | 0.305–0.552 | 0.017–0.096 |

必须连同这些限定一起引用：

- **n = 1**：每档只有一对 A→B、一对对照，无重复采样、无方差。
- **"音频相关"是允许 ±440 ms 滞后的峰值互相关**。`rows.json` 里 1s 窗最佳滞后普遍在 **+340 / −288 / −415 / −335 ms**；对 100 BPM 音乐型素材，周期性本身就能造出这种峰。**只有 `balanced-pdd` 的 100 ms 窗（滞后 2.12 ms）真正支持"接缝处波形连续"**。文档表格只报系数不报滞后，容易被读成"波形对齐"。
- **包络相关在续接组有三档是负的**；"四档全部正向"说的是宽带相关。
- **最硬的指标是响度台阶**（单一标量、无搜索窗）：续接全在 ±0.8 dB、对照全在 −8.8…−24 dB。"不续接会在切点塌音量"是整节最可信的结论。
- **噪声型声景上音频指标完全失效**，只能靠听。
- **i2v 版对照反而更好**，文档自陈"机制可用已证，效果优劣未证"。
- 全仓**没有任何音色相似度指标**（speaker embedding / MCD / SECS 皆无）——所有音频指标都是**接缝级**，没有一条回答"跨镜是不是同一个人的声音"。

---

## 6. 失效模式速查

| 现象 | 根因 | 对策 | 证据 |
|---|---|---|---|
| 跨镜音色漂移 | 跨调用无 ID 绑定；单 seed 会连脸带声一起漂 | 参考音频逐镜复喂；per-shot seed；固定 `(Sx)` | 官方规范 + 社区自报 |
| 台词分给错误的人 | 多说话人 + 参考音频的归属歧义 | 台词绑可见事件；一人一份 voice ref；必要时按人外部分轨 | `【ComfyUI】` 明写 |
| 切点爆音 / 塌音量 | 两次生成各自从静音起 | AV latent 续接；40 ms equal-power weld；前一镜尾巴留 0.5s 干净 | 本机实测 + 社区 |
| 开头音节被吃 | 对白从第 0 帧开口 | 前 1 秒"丢弃重放"；对白安排在第 1 秒后 | 社区 |
| 口音/音色变了 | 改了帧率 | 锁 24 fps | 社区 |
| 参考音频的原台词被"顺"进新片 | 没区分"借音色"与"复刻台词" | 只借音色就写 `reference` 并明确不复刻 | 官方 |
| BGM/音效糊进对白层 | 音层没写对位置 | 环境音/拟音 → `overall_soundscape`；观众专属配乐 → `non_diegetic_music`；对白只留 `<d>` | 官方 + ComfyUI |
| 参考音轨静默丢失 | 本地忘接 `ref_video_audio_N` | 与 `ref_video_N` 成对连线 | `【ComfyUI】` |
| turbo 档参考"持不住" | 4 步蒸馏削弱 reference/audio | 参考必须稳时用 20–25 步 | `【ComfyUI】` |

---

## 7. 明确的信息缺口（不要脑补）

1. **没有官方技术报告/论文**：架构信息只到模块级（博客 + README），无训练配比、无消融。
2. **官方从未量化声线一致性**：没有 speaker similarity 章节。
3. **跨多次生成无官方保证**：作用域始终是单次 4–15s。
4. **`H3-Context-IR` 闭源**：模型如何决定"哪段音频对应谁"无法本地复现。
5. **`H3-Regenerate-2K` 是否保声线未知**：官方只讲复用上下文恢复视觉细节（小字、纹理），未提音频是否重绘/漂移。
6. **`MiniMaxH3MotionContext*` 的 Python 实现不可复核**（在远端容器里）；"24 帧 ↔ 40 step/s"的换算本仓无解释（`audio_context_length=24` 被反复写作"1 秒"，与 40 step = 1.000s 不能同时精确成立）。
7. **长链音质衰减只有主观转述**（"越链越闷"），只验到 3 镜，无曲线。

---

## 8. 如果要把声音一致性做扎实：优先级清单

1. **能不切次就不切次**：4–15s 内说完的戏，用 `[Shot N] At 00:0X.XXX` 一次生成；跨镜"声音不断"只有这条是官方保证。
2. **接上参考音频通道**（本仓当前最大缺口）：给 `MiniMaxH3ReferenceToVideo` 开 `ref_audios` 槽 + `LoadAudio` + `audio_vae`，把"每角色一份 2–15s 干净人声"接进管线；prompt 端按 §2.2 三段式写 `reference`。
3. **一镜一说话人**（本仓已是硬约束）：多说话人时模型要在 5s 内切音色，漂移与串音风险陡增；这是最有效的**约束型**稳定手段。
4. **固定 `(Sx)` + 首次出场写足音色**（pitch / timbre / speaking rate / accent）：没有音频参考时，这是唯一的音色锚。
5. **跨镜用链式续接，别用首帧拼接**：latent 级 AV 续接把上一镜末段（22 帧画面 + 24 帧音频）钉进新镜，音频结束于接缝——本机实测响度台阶 ±0.8 dB，远好于另起一镜的 −8.8…−24 dB。
6. **不要共用 seed；锁 24 fps；参考要稳就别用 4 步 turbo**。
7. **验收别只看画面**：闭眼听音色/语速/房间音，出现"声音突然变年龄或变距离"即判废；本仓目前**没有自动化音色指标**，只能人工并排复核。

---

## 附：来源

**官方**
- [MiniMax H3 发布博文](https://www.minimax.io/blog/minimax-h3)（2026-07-31）
- [H3 开源公告](https://www.minimax.io/news/minimax-h3-open-source)（2026-08-03；规格表、Ref2VA case）
- [GitHub MiniMax-AI/MiniMax-H3 README](https://github.com/MiniMax-AI/MiniMax-H3)（架构、AudioVAE、CFG-distilled）
- [ref-en.txt](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt) / [base-en.txt](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/base-en.txt)（`<Audio N>`、marker、`(Sx)`、`<scenetrans>`）
- [API: video-generation-v2-create](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)（`reference_audio` 约束）

**ComfyUI 官方文档**
- [H3 总览](https://docs.comfy.org/tutorials/video/minimax/minimax-h3) / [Native workflows](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native) / [Prompt guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide) / [Multiframe Reference](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-multiframe)

**社区（未独立复验）**
- [joeygambino/MiniMax-H3-Multishot-Workflow](https://huggingface.co/joeygambino/MiniMax-H3-Multishot-Workflow)
- [Sol-H3 (arXiv 2609.35110)](https://arxiv.org/abs/2609.35110)

**本仓**
- `workflows/minimax-h3-ref2v-quality.json`、`workflows/minimax-h3-ref2v-ctx-quality.json`
- `lib/index.js`（`chainGraphMismatch` :1442、链序号 :2413-2445）、`lib/manifest.js`
- `docs/shot-chain-continuity.md`、`docs/ref2va-shot-continuity-research.md`、`docs/consistency-optimization-plan.md`
- `e2e-out/chain-bench/rows.json`、`e2e-out/ctx-test/measure_seam.py`
