# MiniMax H3 音频 / 声音一致性 —— 本地仓证据笔记

> 调研对象：`/Users/seiue/Workspace/short-video/dsh-short-video-studio`（下称"本仓"）+
> 已安装 skill `/Users/seiue/.dsh/skills/h3-prompt-writing`（下称"skill"）。
> 只读调研，未修改任何既有文件（本文件为新增）。
> 日期：2026-10-23。

## 0. 证据分级与读法

本文每条结论都带分级，**不要把四类证据混为一谈**：

| 标记 | 含义 |
|---|---|
| `[CODE]` | 代码 / 工作流 JSON 里**实际这样接线**，可被任何人在本机复核 |
| `[DOC]` | 文档或 skill 的**规范性声明**（设计意图、契约、官方 prompt 规范），不等于本机跑过 |
| `[MEASURED]` | 有**实测数字**，但注意 §4.5 的口径与样本量问题 |
| `[INFERRED]` | 我的推断（从邻证推出），已标注为推断 |

三条贯穿全文的硬事实，先摆出来：

1. **H3 的音频与画面是同一个扩散采样器的同一次输出**，只是最后用两个 VAE 分别解码 —— 这是"音画一致"的**根机制**，`[CODE]` 可证（§1）。它不是"先生成画面再配音"。
2. **跨镜音频连续性不是模型能力，是一个第三方 ComfyUI 插件包（Motion Context）把上一镜的 AV latent 钉进新镜开头**，`[CODE]` 可证（§3）。
3. **参考音频（`<Audio N>` 音色参考）在 skill 规范里写得很完整，但本仓的插件管线没有把它接进任何工作流** —— 只有 `ref_images` 槽位（§2.4）。这是本次调研**最重要的负面发现**。

---

## 1. 音画联合生成：音频和视频在同一个 latent 序列里吗？

### 1.1 结论：是。一次采样 → 一个 latent → 两个 VAE 分别解码

`[CODE]` 以 quality 档参考实现 `workflows/minimax-h3-ref2v-quality.json` 为例，采样与解码段是这样接的：

| 环节 | 节点 | 行号 |
|---|---|---|
| 条件 + 初始 latent | `MiniMaxH3ReferenceToVideo`（node 5），输出槽 **0 = CONDITIONING**、**槽 1 = LATENT**；`audio_vae` 作为**条件输入**接在 `["4a", 0]` | 82–95 |
| 采样器 | `SamplerCustomAdvanced`（node 10），`latent_image: ["5", 1]` | 141–160 |
| 视频解码 | `VAEDecode`（node 11），`samples: ["10", 0]`，`vae: ["4", 0]`（video VAE） | 165–177 |
| **音频解码** | `VAEDecodeAudio`（node 11a），`samples: **["10", 0]**`（**同一个采样器输出**），`vae: ["4a", 0]`（audio VAE） | 211 起 |
| 封装 | `CreateVideo`（node 12），`images: ["11", 0]`、`audio: ["11a", 0]` | 179–187 |
| 音频 VAE 加载 | `VAELoader`（node 4a），`$assets.audio_vae` → `minimax_h3_audio_vae_fp32.safetensors` | 204–208；资产声明 36–39 |

关键点：`VAEDecode`（视频）与 `VAEDecodeAudio`（音频）**读的是同一个 `["10", 0]`**。也就是说采样器吐出的是一份**联合 AV latent**，两个 VAE 只是把它拆成两种模态。

同一结构在代码里的第二处实现（旧版静态图构造器）`lib/index.js` 更直白：

- `lib/index.js:487`：`音频经 VAEDecodeAudio(audio_vae) → CreateVideo(audio) 合成，不再静音。`
- `lib/index.js:502`：`'4a': { class_type: 'VAELoader', inputs: { vae_name: models.h3AudioVae } }`
- `lib/index.js:529-530`：
  ```js
  graph['11a'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['10', 0], vae: ['4a', 0] } }
  graph['12']  = { class_type: 'CreateVideo',    inputs: { images: ['11', 0], audio: ['11a', 0], fps: H3_FPS } }
  ```

`[DOC]` 文档侧的说法与此一致：`docs/i2v-vs-ref2v-and-model-comparison.md:84` 称音频为"**独立 H3-AudioVAE**，32 kHz 立体声，**联合预测**"；`:179` 称"**原生立体声 32 kHz**，与视频联合生成"。`[MEASURED]` 采样率可证：`e2e-out/chain-bench/rows.json` 里每条记录都有 `"audio_rate": [32000, 32000]`。

### 1.2 音频与视频**共用一个 sigma 调度，但可以分别调 shift**

`[CODE]` 所有 39 个 `minimax-h3-*.json` 都带一个 `MiniMaxH3SigmaShift` 节点，两路参数：

```json
"class_type": "MiniMaxH3SigmaShift",
"inputs": { "model": ["$model", 0], "shift_video": 12, "shift_audio": 3 }
```
（`workflows/minimax-h3-ref2v-quality.json:58-66`，`…-fast.json:64-65`，`…-i2v-quality.json:64-65` 同）

这**只改噪声调度的时间重参数化**（sigma shift），没有第二个采样器、没有独立步数：音频与视频**共享同一个 `BasicScheduler` 步数与同一条 `SamplerCustomAdvanced` 采样轨迹**。`[CODE]` `BasicGuider`（node 7）也只有一条 conditioning 输入。

> ⇒ **没有"音频 cfg"**。本仓所有 H3 图里**不存在**音频专用 CFG / guidance 节点。`BasicGuider` 无 cfg 输入（quality 档走官方 `cfg=1` 类路径），`[DOC]` `docs/minimax-h3-video-benchmark.md` 的 LoRA 表里把 shift 写成 `12/3`、`6/3` 形式，说明 shift 是**"步数 × 分辨率 × shift" 三元组**的一部分，且 **audio shift 与 video shift 一起随档位换**（见 `docs/minimax-h3-video-benchmark.md` LoRA 与配对规则表）。

`[MEASURED]` 从服务端日志可以读出音频 latent 的形状与步率（`docs/shot-chain-continuity.md:262`，附 E）：

```text
h3_motion_context: saved AV latent to .../clip_01259.safetensors (video (1,24,37,30,52), audio (1,32,2,207))
h3_motion_context: video from latent, video/head, 22 frames -> 7 cond blocks at indices 0..18,
  158 frame clip at 832x480, trim 22, audio 24 frames -> 40 latent steps (1.000s) from latent,
  on the timeline ending at frame 22.200
```

读法：视频 latent 是 24 通道；**音频 latent 是 32 通道**（`audio (1,32,2,207)`）。同一条日志说 24 个音频上下文帧 → 40 个 latent step 覆盖 1.000 s，即**音频 latent 的步率约 40 Hz**。

> ⚠️ **一处内部不一致，值得记下**：`docs/shot-chain-continuity.md:43`、`docs/ref2va-shot-continuity-research.md:54` 都说 `audio_context_length = 24 帧 = 1 秒`，而日志说 **40 step = 1.000 s**。若步率真是 40 Hz，则 24 帧只有 0.6 s。二者不可能同时精确成立（可能"帧"与"step"是两个不同单位：帧 ≈ 48 Hz？无法从本仓判定）。**本仓没有解释这个换算关系**，所以本文不把它当成已定论。

### 1.3 音频是不是"token 序列的一部分"

`[INFERRED]` 从接线看：联合 latent 经同一采样器 → 两个解码器，且 Motion Context 节点能**按帧切视频 latent、按步切音频 latent 并分别钉住**（`audio_context_length` 与 `context_length` 是两个独立参数，§3.2），说明 latent 内部是**按模态分段、但共享同一时间轴的联合张量**，而不是两路独立生成后对齐。

`[DOC]` 上游（第三方包作者）的说法在 `docs/ref2va-shot-continuity-research.md:45`："把钉住音频的**时间坐标**改写到新片段自己的时间轴上（而不是当参考），接缝处互相关从 ~0.45 升到 0.95+" —— 这条**只有在音频是同一时间轴上的可续接 token 时才成立**，可视为对"联合时间轴"的旁证。

**本仓不揭示**：训练期如何做音画对齐（是否存在 audio-text 对比损失、lip-sync 判别器、音频 tokenizer 的 codebook 细节）。仓库里只有推理侧的 ComfyUI 图，**没有任何训练代码或模型结构源码**。`docs/i2v-vs-ref2v-and-model-comparison.md:84` 的"联合预测"是引用官方口径的描述，不是本仓的实证。

---

## 2. 参考音频条件（Ref2VA `<Audio N>`）

### 2.1 `[DOC]` 规格：`<Audio N>` 能干什么（skill `ref-en.txt` §2.4）

`/Users/seiue/.dsh/skills/h3-prompt-writing/references/ref-en.txt:93-101`（§2.4）原文：

> ``<Audio N>`` represents a standalone audio asset or an enabled synchronized audio track from a reference video. Common uses include:
> - Copying all or part of an audio signal
> - Referencing a background-music style
> - **Referencing a speaker's voice timbre and delivery**
> - Using dialogue, lyrics, or sound effects from the original audio
> - **Referencing beat, rhythm, or audio continuity**

同节 `:103` 给了**音色参考绑定到说话人**的唯一写法：

> When an `<Audio N>` explicitly corresponds to a target speaker, reuse that speaker's global ID in the definition: write `<Subject N> (Sx)` when the speaker maps to a defined subject, or use a stable voice description followed by `(Sx)` otherwise. The ID comes from the target video's global speaker order and is **not independently assigned or renumbered in the audio definition**. See Section 5.4 for the speaker-numbering rules:

```text
<Audio 1> is the voice-timbre reference for <Subject 1> (S1).
```

`:109`：一个音频资产承担多个角色时，**一句话说完，不要另开小节**。

### 2.2 `[DOC]` 四种关系标记（`ref-en.txt` §4.2）

`ref-en.txt:191-200`（§4.2 Audio）原文表：

| Relationship marker | Meaning |
|---|---|
| `fully_copy` | The complete source audio serves as the target video's complete final audio track |
| `partially_copy` | Only part of the timeline or selected audio layers are copied, or other sounds are added, removed, or replaced after copying |
| `reference` | The signal is not copied directly; only timbre, rhythm, music style, dialogue content, or sound texture is referenced |
| `weak_reference` | Only broad similarity in category or atmosphere is retained |

两个官方例句（`ref-en.txt:202-208`）：

```text
<Audio 1>: fully_copy - <Audio 1> is reused 1:1 as the target video's complete final audio track.
<Audio 2>: reference - the target speaker follows <Audio 2>'s voice timbre and measured delivery without copying the original signal.
```

约束（`:210`）：关系标记**只能在该标签于 `subject_definitions` 里已定义的角色范围内选**；目标视频新增的动作 / 背景 / 剧情不算"参考保真度损失"。

> ⇒ **`fully_copy` vs `reference` 的语义分界**：`fully_copy` 是**成品音轨级 1:1 复用**（目标视频的完整最终音轨就是它，等于放弃原生音频生成）；`reference` 是**只借音色/节奏/风格，不复制波形**（目标视频仍然自己发声）。这正是"声音一致性"最需要的那个模式。

### 2.3 `[DOC]` 标签编号规则（`ref-en.txt` §2.5）

`:111-117`：

> ``<Video N>`` and ``<Audio N>`` are numbered **independently**. Each index indicates only the label's order within its own category and does not encode a pairing between the two categories. The same reference video may therefore correspond to `<Video 1>` and `<Audio 2>`; different indices do not prevent them from coming from the same source asset.
>
> An ordinary reference video **does not create `<Audio N>` merely because the file contains sound.**

上一句很重要：**参考视频自带的声音不会自动变成音频参考**，必须显式声明 `<Audio N>`。

### 2.4 `[DOC]` 说话人 ID `(Sx)` 的分配与复用规则（`ref-en.txt` §5.4 + `base-en.txt` §4.4）

`ref-en.txt:269`：

> `<Subject N>` identifies the referenced subject, while `(Sx)` identifies the actual speaker. When the subject speaks, write `<Subject N> (Sx)`. If the same subject speaks **off-screen**, keep the same form and mark it as `off-screen`. When the speaker does not correspond to a defined subject, use **a stable voice description followed by `(Sx)`**.

`ref-en.txt:281`（编号权威规则）：

> Assign `(Sx)` **once according to the order of actual vocal events in the target video**. Reuse the corresponding ID at every actual vocal event in `detailed_description`; an `<Audio N>` definition bound to a target speaker in `subject_definitions` also reuses the same `(Sx)` but **never assigns a new one independently**. **Do not write `(Sx)` in `retention_analysis`.**

`ref-en.txt:271-275`：纯 BGM / 成品音轨里的一句人声（没有独立发声主体）用 `<Audio N>` 作声源，**不要凭空造 `(Sx)`**。

`ref-en.txt:279`：**只借音色时不要把参考音频里的原台词搬进目标视频** —— 这条直接决定"音色参考"与"台词复用"是两件事。

`base-en.txt:130`（T2VA 侧，`(Sx)` 的字面定义）：

> Subjects who speak, sing, or produce an off-screen human voice use stable IDs such as `(S1)` and `(S2)`. ... **A speaker keeps the same ID across shots**; characters who never vocalize receive no speaker ID.

`base-en.txt:132`（**首次出场必须给足身份信息** —— 这是"音色一致性"在 prompt 层的核心机制）：

> When a speaker first appears, provide enough information from the visual and audio context to establish a stable identity, such as **character type, age, gender, whether the person is on-screen, pitch, timbre, speaking rate, or accent**.

### 2.5 ⚠️ 最重要的负面发现：本仓**没有**把参考音频接进管线

`[CODE]` 全仓 `workflows/` 搜索 `ref_audio` / `ref_video` 的结果：

- 39 个 H3 清单里，`ref_*` 字段只出现 `ref_image_`（×20）、`ref_image_size`（×20）、`ref_images`（×20）。
- **零** `ref_audios` / `ref_video_audios` / `ref_videos`。
- `workflows/minimax-h3-ref2v-quality.json` 的 `params.refs` 只有一个 `"inject": "image"` 通道（`via: node LoadImage` → `node 5, field ref_images.ref_image_${i}`，`max: 8`）；node 5 的 inputs 里也只有 `ref_image_size`，没有音频槽。

`[CODE]` 代码侧同样没有音频参考通道：`lib/index.js` 里 `audio_vae` 只作为**VAE 解码器**出现（`:502`、`:1220`、`:1223` 的资产槽），`ref_audio` 字符串在整个 `lib/` 中零命中。

同时注意 `docs/ref2va-shot-continuity-research.md:38` 记录的上游节点能力：`MiniMaxH3ReferenceToVideo` 理论上有 `ref_videos`(≤3) / `ref_video_audios`(≤3) / `ref_audios`(≤3) 槽位，`:24` 甚至把"把上一镜尾段接进 `ref_videos`/`ref_video_audios`"列为一条零安装路线（R1）。

> **结论**：`<Audio N>` 这套规范在本仓是**"可写但不可达"** —— skill 能把 prompt 写成合法的 `<Audio 1> is the voice-timbre reference for <Subject 1> (S1).`，但插件**没有办法把那个音频文件送进 ComfyUI**。因此本仓实际生产中**跨镜音色一致性完全靠文本描述 + 链式续接**，不靠音频参考。这是"文档承诺"与"代码能力"之间最大的一处缺口，且**没有任何文档承认这个缺口**（各片型 skill 也没写"音频参考不可用"）。

---

## 3. 跨镜续接（`continuity_from`）：到底搬了什么

### 3.1 `[CODE]` 清单侧：四个专用节点 + 两个独立窗口参数

`workflows/minimax-h3-ref2v-ctx-quality.json` 在普通图基础上**多出 4 个节点**（`requiresNodes` 声明于 `:422-425`）：

| node | class_type | 作用 | 行号 |
|---|---|---|---|
| 20 | `MiniMaxH3MotionContextLoadLatent` | 从槽位读上一镜 AV latent（`latent_path: "h3_context"`, `clip_index`） | 204–210 |
| 21 | `MiniMaxH3MotionContext` | 把上下文钉进条件；输出 **槽 0 = CONDITIONING**、**槽 1 = trim_frames** | 211–233 |
| 22 | `MiniMaxH3MotionContextSaveLatent` | 存本镜 AV latent 到槽位（`filename_prefix: "h3_context/clip"`） | 234–243 |
| 23 | `MiniMaxH3MotionContextTrim` | 从**画面与音频两侧**裁掉继承段（`match_tail: true`, `fps: 24`） | 245–260 |

接线变化（对比 `…-quality.json`）：

- `BasicGuider.conditioning` 从 `["5", 0]` 改为 **`["21", 0]`**（`…-ctx-quality.json:109-115`，guider 读 Motion Context 的输出）
- `MiniMaxH3MotionContext.inputs` = `{ conditioning: ["5",0], vae: ["4",0], latent: ["5",1], context_length: "22", audio_context_length: 24, context_latent: ["20",0] }`（`:211-233`）
- `MiniMaxH3MotionContextSaveLatent.latent` = **`["10", 0]`** ⇒ 存的是**首遍采样器输出**，放大发生在它之后（`docs/shot-chain-continuity.md:290-292` 明确点出这条接线事实）
- `CreateVideo.images` 改读 `["23", 0]`（裁过的图）、`audio` 仍读 `["11a", 0]`（`VAEDecodeAudio` 是**先解音频再裁**，裁在 `Trim` 节点里）

**两个窗口是分开的参数**，都做成 `inject: scalar` 以便按清单/实验调整：

```jsonc
"context_length":       { "inject": "scalar", "to": { "node": "21", "field": "context_length" },       "default": "22" }
"audio_context_length": { "inject": "scalar", "to": { "node": "21", "field": "audio_context_length" }, "default": 24 }
```
（`workflows/minimax-h3-ref2v-ctx-quality.json:352-366`；图中硬编码值在 `:226-227`）

`[CODE]` **全部 22 个 `*ctx*` 清单取值完全一致**：`context_length = "22"`、`audio_context_length = 24`（对 `workflows/minimax-h3-*ctx*.json` 全量 grep 的结果，无例外）。

### 3.2 到底搬了什么：**视频 latent 帧 + 音频 latent 帧，都是 latent 级**

`[DOC]` `docs/shot-chain-continuity.md:43-46`（权威语义节）：

> 续接会把上一镜末段 **22 帧画面 + 24 帧（1 秒）音频**钉进新镜的开头（**latent 级，不经解码/再编码**），采样时多采这部分、交付前裁掉——所以**请求帧数 ≠ 采样帧数**。
> 相关节点：`MiniMaxH3MotionContext`（钉上下文）、`…Trim`（裁掉继承段）、`…SaveLatent` / `…LoadLatent`（槽位读写）、`…SeamProbe`（接缝测量）。

`[MEASURED]` 服务端日志把"搬了什么"写得很具体（`docs/shot-chain-continuity.md:265`）：

```text
video from latent, video/head, 22 frames -> 7 cond blocks at indices 0..18,
  158 frame clip at 832x480, trim 22,
  audio 24 frames -> 40 latent steps (1.000s) from latent,
  on the timeline ending at frame 22.200
```

逐项解读：
- **视频**：22 帧被转成 **7 个 cond block（index 0..18）** —— 说明钉进采样器的不是像素、也不是裸 latent 帧，而是**已经过条件编码的 block**。
- **音频**：24 帧 → 40 个 latent step，**时间轴终点对齐到 frame 22.200**（22.2/24fps ≈ 0.925 s）⇒ **音频不是"从 0 重新开始"，而是结束于接缝**。这正是 §2.4 引用的上游说法"把时间坐标改写"的具体形态。
- **裁剪**：`trim 22` —— 交付比采样短 22 帧。

`[MEASURED]` 另一条日志（`docs/shot-chain-continuity.md:264`）说明**首帧锚点会被丢弃**：

```text
h3_motion_context: dropped 1 keyframe anchor(s) at frame(s) [0]:
  the pinned head already decides frames 0..21. A last_frame anchor is kept.
```
⇒ 链式 i2v 里 `first_frame_node` **被丢弃**（head 已决定 0..21 帧），`last_frame_node` 保留。这条已写进契约（`docs/shot-chain-continuity.md:169`、`skills/story-short-generator/SKILL.md:390`）。

**回答"是音频 latent 帧还是最后的音频 token？"**：按本仓可见证据，是**音频 latent 的一段（24 帧 / 40 step），且被重写到"结束于接缝"的时间坐标上**。日志措辞是 `audio 24 frames -> 40 latent steps (1.000s) from latent`，即**从 latent 取的、按时间轴铺的**，不是"最后几个离散 token 的文本级拼接"。**但本仓看不到上游包的 Python 源码**（包在远端 ComfyUI 容器里，`docs/ref2va-shot-continuity-research.md:236` 只记录"0.6.2 装载成功（6 个节点注册）"），所以"具体怎么改写坐标"属于**不可复核区间**。

### 3.3 `[CODE]` 槽位序号与长度换算（插件自己的逻辑）

`lib/manifest.js`：
- `:69` `export const CHAIN_SOURCES = ['clip-latent']` —— 只承认"服务端 latent"这一种来源形态
- `:124-140` 校验 `chain.source / sampleExtra / lengthGrid`，并要求 `params.context_clip_index` 与 `params.save_clip_index` 必须存在（"把链序号注入到 Load/Save 节点"）

`lib/index.js`：
- `:2300-2301` `wantContinuity` → `resolveTieredManifest(..., { chainOnly: wantContinuity })` —— **传了 `continuity_from` 就只在声明了 `chain` 的实现里解析**，不会悄悄退回普通生成
- `:2413-2445` 序号与长度：
  ```js
  chainLoadIdx = prevIdx          // 本镜 Load = 上一镜的 Save 槽位
  chainSaveIdx = prevIdx + 1
  sampledLength = snapLengthToGrid(wantLength + chain.sampleExtra, grid)   // 多采 sampleExtra 帧
  deliveredLength = Math.max(1, sampledLength - chain.sampleExtra)          // 交付 = 采样 - 继承
  ```
  起链分支 `:2438-2442`：`chainLoadIdx = 0`、`chainSaveIdx = allocateChainIndex(project)`、`deliveredLength = sampledLength`（起链没有继承帧要裁）
- `:2465` 注入图参数：`...(chain ? { length: sampledLength, context_clip_index: chainLoadIdx, save_clip_index: chainSaveIdx } : {})`
- `:2517-2524` 画布节点记录：`requestedLength / sampledLength / clipIndex / contextClipIndex / continuityFrom / chain`

`workflows/minimax-h3-ref2v-ctx-quality.json:413-419` 的 chain 声明：`{ source: "clip-latent", sampleExtra: 22, lengthGrid: [17, 5] }` —— **`sampleExtra` 恰好等于 `context_length`（22）**，这是清单层的自洽要求。

长度换算的 `[MEASURED]` 例子（`docs/shot-chain-continuity.md:109`）：请求 124 → 采样 158（124+22=146 按 17k+5 上取整）→ **交付 136**。三者都记在节点上。

### 3.4 硬约束：**首遍尺寸**必须一致（不是交付尺寸）

`[CODE]` `lib/index.js:1442-1450`：

```js
export function chainGraphMismatch(prevParams, graphSize) {
  const w = Number(prevParams?.graphWidth ?? prevParams?.width)
  const h = Number(prevParams?.graphHeight ?? prevParams?.height)
  if (!w || !h) return null                    // 旧节点没记尺寸：不判死
  if (w === graphSize.w && h === graphSize.h) return null
  return `链式续接要求**首遍尺寸**一致：上一镜首遍 ${w}×${h}，本镜 ${graphSize.w}×${graphSize.h}。` +
    '链上传递的是首遍 latent（放大发生在其之后），latent 无法缩放——' +
    '请让两镜用首遍尺寸相同的实现（交付尺寸可以不同），或从这里另起一链（不传 continuity_from）'
}
```

**理由**（`:2427-2429` 注释 + `docs/shot-chain-continuity.md:290-295`）：`MiniMaxH3MotionContextSaveLatent` 读的是 node 10（首遍采样器输出），两阶段放大在其后 ⇒ **链上流动的是首遍 latent，不能缩放**；因此**交付尺寸可以不同**（`-ctx-quality` 1344×768 可以接 `-ctx-quality-2k` 2688×1536），但首遍不同（fast 832×480 ↔ quality 1344×768）**拒跑**。

另一条硬约束（`[CODE]` `lib/index.js:2420-2426`）：**上一镜必须是链式实现渲染的**，否则报"上一镜没有链式序号"：

```js
`上一镜没有链式序号（params.clipIndex）：它必须也是链式实现渲染的。` +
`上一镜「${prev.title || fromId}」用的是 ${prev.params?.workflow || '未知'}——...`
```

`[DOC]` 完整失败模式表见 `docs/shot-chain-continuity.md:105-111`（5 行：首镜必须链式、首遍尺寸一致、17k+5 上取整、跨会话共享输出目录、链长上限 9999）。

### 3.5 已知劣化（作者与文档都承认）

- `[DOC]` 音频"**在长链上会逐渐变闷**"（`docs/shot-chain-continuity.md:124`；`docs/ref2va-shot-continuity-research.md:46` 更细："每一环都建在上一环的输出上 + 一次音频 VAE 往返"）
- `[DOC]` `docs/ref2va-shot-continuity-research.md:46`：**Spectrum 一类跳步加速器必须关**（"钉住的行不演化，是预测器的退化输入"）；**turbo LoRA 会同时伤音频与细节**
- `[DOC]` 续接**不继承身份**（`skills/story-short-generator/SKILL.md:596`、skill `references/studio-mapping.md:38`）—— 认人永远看参考卡
- `[DOC]` 重渲连锁（`docs/shot-chain-continuity.md:147`、`skills/story-short-generator/SKILL.md:830`）：任何镜重渲 ⇒ 所有 `接 该镜` 的下游必须顺次重渲，否则"画面/声音在切点跳变"

---

## 4. 实测证据（数字与它们的口径）

### 4.1 机制验证矩阵（裸图直提 ComfyUI，`docs/shot-chain-continuity.md:175-198` 附 A）

| 路径 | 上一镜 → 本镜 | 画面接缝 MAD (0–255) | 音频相关 1s | 包络相关 | 接缝响度台阶 |
|---|---|---|---|---|---|
| 像素路径（尾 22 帧 + 尾 1s 音频） | A → B **续接** | **11.1** | 0.44 | — | −1.7 dB |
| 像素路径 · 同一对**不续接** | A → B 对照 | 57.4 | 0.31 | — | **−16.0 dB** |
| latent 路径（Save/Load Latent） | B → C **续接** | **3.2** | 0.49 | — | +5.2 dB |
| 音乐型素材（100 BPM） | A3 → B3 **续接** | **7.2** | **0.60** | **0.87** | +15.9 dB |
| 音乐型素材 · **不续接** | A3 → B3 对照 | 62.8 | 0.17 | 0.25 | +1.9 dB |
| 自测基线（同一条片首帧 vs 末帧） | — | 58.2 | — | — | — |

文档自己的读法（`:191-195`）：画面接缝压到对照的 1/8–1/11，**已低于"同一条片子首尾帧的自然差异"58.2**；latent 路径优于像素路径（3.2 vs 11.1，省掉一次解码→再编码的有损往返）；**音频只在有结构的素材上可测**（100 BPM 音乐型 0.87 vs 0.25）；**不续接的对照普遍在切点塌音量**（−16.0 / −8.78 / −19.83 dB）。

### 4.2 档位 × 加速件覆盖矩阵（`docs/shot-chain-continuity.md:206-211` 附 B）

同 prompt、同 seed、各档原生分辨率、音乐型声景、每档三镜（起链 → 续接 → 对照）：

| 档位实现 | 加速件 | 分辨率 | 帧数 | 画面 MAD 续接→对照 | 音频相关 1s | 包络相关 | 响度台阶 |
|---|---|---|---|---|---|---|---|
| `…ctx-fast` | 4 步蒸馏 | 832×480 | 124/136/136 | **7.016** → 67.559 | **0.391** → 0.060 | −0.216 → −0.142 | **+0.69** → −19.83 dB |
| `…ctx-balanced` | 8 步 768p | 1344×768 | 124/136/136 | **2.631** → 32.350 | **0.534** → 0.017 | +0.134 → −0.091 | **−0.77** → −8.78 dB |
| `…ctx-balanced-pdd` | PDD nfe=8 | 1344×768 | 124/136/136 | **3.436** → 51.176 | **0.305** → 0.065 | **+0.827** → −0.293 | **−0.26** → −14.62 dB |
| `…ctx-quality` | 无（20 步） | 1344×768 | 124/136/**141** | **2.605** → 35.546 | **0.552** → 0.096 | −0.097 → −0.267 | **+0.09** → −24.04 dB |

文档结论（`:222-227`）：四档一致（接缝 2.6–7.0 vs 对照 32–68）；**音频在音乐型素材上四档全部正向**（1 s 窗相关 0.305–0.552 vs 0.017–0.096）；**续接带来的是"同一段画面"，不是"更高画质"**（MAD 与档位几乎无关）。

### 4.3 i2v 版（fast 档，`docs/shot-chain-continuity.md:253-281` 附 E）—— **文档自己承认没测出效果**

| 接缝指标 | 续接镜（i2v ctx） | 对照（普通 i2v，同首帧同 seed） |
|---|---|---|
| 帧数 | 136 | 141 |
| 画面 MAD | 8.473 | **4.345**（对照更好） |
| 音频相关 100/250/500/1000 ms | 0.406 / 0.231 / 0.181 / 0.157 | **0.489 / 0.433 / 0.395 / 0.313**（对照全面更好） |
| 包络相关 1s | −0.198 | −0.082 |
| 响度台阶 | **+7.18 dB** | −10.13 dB |

文档的诚实读法（`:279`）：① 画面列在 i2v 上**无区分度**（两镜共享同一张首帧图）；② **音频列对照反而更高**，疑为"同 seed + 同首帧"造成的趋同而非真连续 ⇒ **对照设计必须重做**；③ 响度台阶方向相反，须人工听核。**"机制可用已证，效果优劣未证。"**

### 4.4 2K 放大族（`docs/shot-chain-continuity.md:297-319` 附 F）

| 指标 | 续接 | 对照（同实现·不续接） |
|---|---|---|
| 画面接缝 MAD | **13.33** /255 | **79.57** /255 |
| 音频宽带相关（100 ms） | **0.898** | 0.391 |
| 音频包络相关 | −0.231 | −0.025 |
| 响度台阶 | **+0.68 dB** | **−6.34 dB** |

结论：>2K 交付与链式续接**可以叠用**；放大族接缝绝对值略糙（13.33 vs 2.6–7.0），但相对"另起一镜"仍紧 6 倍，音频"确实接着走"。

### 4.5 ⚠️ 对这些数字的质疑（请务必连同本节一起引用）

1. **n = 1**。`e2e-out/chain-bench/rows.json` 只有 **4 条记录**（每档 1 条），每档只有**一对** A→B 与**一对** A→对照。**没有重复采样、没有方差、没有置信区间**。文档从未声称多次重复 —— 所以这是**单次本机运行**的结果，不能当统计结论。
2. **`音频相关 1s` 这个指标是"允许大幅滞后的峰值互相关"**。`e2e-out/ctx-test/measure_seam.py:111` 的搜索窗是 `int(w*0.4)+40` ms —— 对 1000 ms 窗就是 **±440 ms**。而 `rows.json` 里的**最佳滞后**在续接组普遍远离 0：

   | 档 | 续接组 1000 ms 窗最佳滞后 | 100 ms 窗最佳滞后 |
   |---|---|---|
   | fast | **+340.22 ms** | −64.66 ms |
   | balanced | **−287.69 ms** | −57.47 ms |
   | balanced-pdd | **−415.06 ms** | **+2.12 ms** |
   | quality | **−334.59 ms** | +18.16 ms |

   ⇒ **1000 ms 窗的"高相关"是在滞后 0.3–0.4 s 处取的峰**。对 100 BPM（周期 0.6 s）的音乐型素材，周期性本身就能产生这种峰。**文档表格只报相关系数、不报滞后**，读者会误以为"波形在接缝处对齐"。只有 `balanced-pdd` 的 100 ms 窗（滞后 2.12 ms）才真正支持"接缝处波形连续"。**这是本文对仓库最实质的一处反驳。**
3. **包络相关在续接组有三档是负的**（fast −0.216、balanced +0.134、quality −0.097），只有 PDD 档强正（+0.827）。文档"四档全部正向"说的是**宽带相关**，不是包络相关 —— 措辞上容易被读成"所有音频指标都变好"。
4. **响度台阶是最可信的指标**：它是单一标量（最后 120 ms 的 RMS vs 最前 120 ms 的 RMS，`measure_seam.py:133`），无搜索窗、无自由参数，四档续接全部落在 ±0.8 dB 内、对照全部落在 −8.8…−24 dB。**"不续接会在切点塌音量"这个结论是这一整节里最硬的。**
5. **fast 档对照镜耗时 2.3 s 是 ComfyUI 缓存命中**（同图同 seed → 逐比特相同），文档自己在 `:218` 标注了"别当耗时基准"。
6. **噪声型声景上音频指标完全失效**（`docs/shot-chain-continuity.md:234`）："续接与'随便两段'给不出差别，只能靠听；响度台阶仍有效"。所以上述"音频正向"结论**只对音乐/对白类素材成立**。
7. **`docs/ref2va-shot-continuity-research.md:13` 自陈**："本机上一条量化 A/B 都没跑（§6 是待跑实验清单）。所有「更好/更差」都是机制推断 + 引用证据" —— 该文 §0–§7 的对照判断（R1/R2/R4/R5）**全部是推断**，只有 §8 是实测。

---

## 5. Prompt 层的音色/声音一致性手段

### 5.1 稳定说话人 ID + 首次出场的音色描述

`[DOC]` 这是**唯一能在"每镜独立生成"的模型上维持音色**的手段（因为没有音频参考，见 §2.5）：

- `base-en.txt:130`："A speaker keeps the same ID across shots"（**注意范围**：这里的"shots"指**同一次生成里**的 `[Shot N]`，不是跨 API 调用）
- `base-en.txt:132`："When a speaker first appears, provide enough information ... **pitch, timbre, speaking rate, or accent**"
- skill `SKILL.md:77` 映射表："对白（说话人/语气/时间）→ `(Sx)` + `<d>[语言] 台词</d>`（**ID 按发声顺序分配、跨镜复用**）"
- skill `references/studio-mapping.md:25`："说话人 ID 按目标视频实际发声顺序分配、**跨镜复用**；`<Subject N> (Sx)` 说话时两者并用"

> ⚠️ **`[INFERRED]` 关键限制**：`ref-en.txt:281` 明确说 `(Sx)` 是"according to the order of actual vocal events **in the target video**" —— 也就是**每次生成内部**编号。本仓的"跨镜复用"是**片型 skill 的自我约定**（把同一个 `(S1)` 写进每一镜的 prompt），**模型侧没有跨调用的 ID 绑定**。所以它只能通过"稳定的音色文字描述"起作用，**没有任何机制保证两镜音色相同**。本仓**没有任何文档承认这一点**，反而多处把"跨镜复用"写得像是模型能力。

### 5.2 台词跨剪辑延续（`<scenetrans>` / `carries over`）

`[DOC]` `base-en.txt:145` 原文：

> When the same line of dialogue or lyrics crosses a cut, use `<scenetrans>` at the connecting points in both parts and explicitly state that **the audio continues across the cut**. Use `<cutoff>` when speech is truncated by the end of the video. Continuity may be expressed with `continues seamlessly across the cut`, `continues uninterrupted into the next shot`, **`carries over from the previous shot`**, or `remains audible across the transition`.

⇒ 四个官方认可的措辞是给**一次生成内的切点**准备的。本仓把它同时用于**跨镜（跨调用）**的场景，靠的是同一段文字在下一镜 prompt 里重复出现 + 链式续接把音频 latent 接上（§3）。**这属于"提示词层借用"，不是官方为跨调用设计的机制。**

### 5.3 旁白 / 画外音规则（口型安全）

`[DOC]` `base-en.txt:139-143`：

> For voiceover, use the exact phrase **`says in an off-screen voiceover`**. Immediately after every voiceover `<d>` block, state that the corresponding on-screen character's **lips remain closed**:

```text
The man (S1) says in an off-screen voiceover: <d>[English] I still remember that road.</d> while his lips remain completely closed.
```

`[DOC]` 同族规则还有 `ref-en.txt:269`（同一个人画外说话时**保持同一形式并标 `off-screen`**）与 `ref-en.txt:271`（BGM 里的人声不另造 `(Sx)`）。

`[DOC]` 片型侧把它落成**可机检的断言**：`docs/consistency-optimization-plan.md:197` 计划把"音频模式 + 口型安全（**一镜一说话人**、非说话人闭嘴、`speaker ∈ characters`）"编译成 `shotlist_validate()` 代码断言；`skills/story-short-generator/SKILL.md:408` 已把它写进镜头表列规则（`口型` 列：说话人 `mouth-open`，同镜其他角色 `mouth-closed`，`silent` 镜全员 `mouth-closed`），`:441` 的第 7 项自检门强制执行"**一镜只有一个说话人**"。

> 这条设计的**音频动机**很实际：一镜多说话人时，模型必须在一个 5 s 窗口里切换多个音色，音色漂移与串音风险陡增。**一镜一说话人是本仓最有效的'音色稳定'工程手段**（它是约束，不是生成能力）。

### 5.4 声景连续性措辞

`[DOC]` `base-en.txt:155-161`（§4.6 `overall_soundscape`）：

> Use 1–4 English sentences in one continuous paragraph to summarize the ambient sound, physical action sounds, and non-verbal human sounds across the full video ... Dialogue, singing, and diegetic music already belong in the multimodal description and **should not be repeated here**. Use `N/A` only when the user explicitly requests complete silence.

`[DOC]` `ref-en.txt:299-304`（参考音频时的分轨规则）：

> When reference audio is used, state its copy or reference relationship **only in the section that matches the audible layer**: ambience and sound effects belong in `overall_soundscape`, while audience-only score belongs in `non_diegetic_music`.

```text
overall_soundscape: The copied ambience layer from <Audio 1> continues throughout the target video.
non_diegetic_music: <Audio 2> is directly reused as the complete audience-only score.
```
（`ref-en.txt:302-303`）

**连续性措辞的实际用法**：本仓没有"声景连续性"的专用句式，靠的是**同一个场景卡 + 同一段 `overall_soundscape` 文字在每一镜重复**（`overall_soundscape` 在 H3 三段式里是**每镜 prompt 的一部分**，没有跨镜继承机制）。`[INFERRED]` 由于没有音频参考槽（§2.5），声景连续性**只能靠 prompt 文字复用**，实际效果未测。

### 5.5 续接镜的 prompt 侧约束（把"前 1 秒还是上一镜"写进指令）

`[DOC]` 这是本仓把"机制事实"翻译成"提示词纪律"的地方，也是音频连续性在 prompt 层最具体的一条：

- skill `references/studio-mapping.md:33-37`：
  > 续接镜 ... 它的**开局约 1 秒是上一镜结尾的延续**（服务端 latent 已钉住上一镜最后约 22 帧画面 + 1 秒音频），因此：
  > - `summary` 里点明这是**同场景的连续镜头**（continuation of the previous shot），不要写成全新开场；
  > - `detailed_description` 的 `[Shot 1]` 起点必须与上一镜结尾的**运动方向、光位、姿态、音量**接得上 ...
  > - 本镜要有上一镜结尾没有的角色 / 道具 / 字幕登场时，登场安排在**第 1 秒之后**
- `skills/story-short-generator/SKILL.md:441`（自检门第 10 项"续接可行"）：
  > 标 `接 S0x` 的镜，**开场约 0.9–1s 的画面与声音仍然是上一镜结尾的延续**（latent 已钉住它），所以：① 本镜的 `连续性衔接` 必须与上一镜结尾的**运动方向、光位、姿态、音量**接得上 ... ② ... 该登场必须安排在**第 1 秒之后** ... ③ 真的需要「开场立刻是全新画面」时 → 该镜标 `起链`
- 同一条（`:441`）里 **"音量"被显式列为必须接上的四要素之一**（运动方向 / 光位 / 姿态 / **音量**）—— 这是音频连续性在规划层唯一被提到"接得上"的物理量。

### 5.6 转场帧洁净（音频动机）

`[DOC]` `skills/story-short-generator/SKILL.md:439` 第 8 项：

> 每个**跨场景边界**的**前一镜最后 0.5s 必须无对白无字幕**。两种继承都会把烧录字幕带过去：... **续接镜则继承上一镜最后约 22 帧画面（≈0.9s）连同 1 秒音频**（字幕被整段继承）。

⇒ **音频侧的真实动机**：继承 1 秒音频意味着上一镜的**尾音、气口、环境声**会被原样带进下一镜开头。所以规划时要求"前一镜尾巴干净"——这是**用剪辑纪律换音画接缝质量**，本仓唯一一条**不依赖模型**的音频一致性工程手段。

---

## 6. 本仓**不**揭示的内容（明确列出）

1. **训练期音频一致性机制**：没有训练代码、没有模型结构源码、没有 loss 设计、没有音频 tokenizer / codebook 细节。`docs/i2v-vs-ref2v-and-model-comparison.md:84` 的"联合预测"是**引用官方口径**，非本仓实证。
2. **`MiniMaxH3MotionContext*` 四个节点的 Python 实现**：包在远端 ComfyUI 容器里（`docs/ref2va-shot-continuity-research.md:236` 只记"0.6.2 装载成功（6 个节点注册）"）。"音频时间坐标怎么改写""24 帧怎么变 40 step"**在本仓不可复核**。
3. **`audio_context_length` 24 与 40 step/s 的换算关系**：见 §1.2 的不一致，本仓无解释。同理"24 帧 = 1 秒"这句在各文档反复出现，但与日志的 40 step = 1.000 s 无法同时精确成立。
4. **音色的客观度量**：全仓**没有**任何 speaker-embedding / 音色相似度 / MCD / WER 指标。所有音频指标都是**接缝级**（相关、包络、响度台阶），**没有一条是"跨镜音色是否同一个人的声音"**。`docs/consistency-optimization-plan.md:233` 也只是把"说话人身份"降级为**人工并排复核**（"真正的自动身份比对（人脸/特征嵌入距离）成本高，建议先做并排复核"）。
5. **`<Audio N>` 音频参考的任何实测**：因为插件根本没接（§2.5），**零实测**。skill 里有官方规范与官方例句（`ref-en.txt:319-333` 的完整 Ref2VA 例子含 `<Audio 1>` 音色参考），但**本仓没有任何一镜是用音频参考生成的**。
6. **参考视频带入音频（`ref_videos` + `ref_video_audios`）**：`docs/ref2va-shot-continuity-research.md:126-133` 记为路线 R1，**未跑**（`:223` "R1 的成本 ... 未知"）。
7. **长链音质衰减的量化**：只验到 3 镜（`docs/shot-chain-continuity.md:124`、`docs/ref2va-shot-continuity-research.md:280`），**"越链越闷"是作者转述 + 主观，没有曲线**。
8. **`docs/three-view-experiment.md` 与音频无关**：全文 221 行，grep `voice|音色|speaker|音频` **零命中** —— 三视图实验是纯画面的身份一致性实验，本文不引用它作为音频证据。

---

## 7. 五条最强机制（摘要）

1. **音画同源采样**：一个 `SamplerCustomAdvanced` 输出被 `VAEDecode` 与 `VAEDecodeAudio` 分别解码（`workflows/minimax-h3-ref2v-quality.json:141/165/211`）。`shift_video=12 / shift_audio=3` 只是同一调度的两路重参数化，**无独立音频采样器、无音频 cfg**。`[CODE]`
2. **链式续接把 AV latent 钉进下一镜**：`MiniMaxH3MotionContext` 以 `context_length=22`（画面帧）+ `audio_context_length=24`（音频帧）继承，音频**结束于接缝**（日志：`on the timeline ending at frame 22.200`），交付前用 `MiniMaxH3MotionContextTrim` 裁掉。`[CODE]`
3. **首遍尺寸锁死整条链**：`chainGraphMismatch()`（`lib/index.js:1442`）—— 链上流动的是首遍 latent，不能缩放；交付尺寸可以不同。`[CODE]`
4. **接缝质量最硬的证据是响度台阶**：四档续接 −0.77…+0.69 dB、对照 −8.78…−24.04 dB；而"音频相关"指标因允许 0.3–0.44 s 滞后搜索，**不足以证明波形连续**（§4.5）。`[MEASURED, n=1]`
5. **prompt 层只有三件真东西**：稳定 `(Sx)` + 首次出场写足音色（`base-en.txt:130/132`）、**一镜一说话人**的口型纪律（`SKILL.md:438` 门 7）、续接镜"前 1 秒仍是上一镜"的写作纪律（`studio-mapping.md:33-37`）。**音色跨镜一致性没有任何模型级保证**，因为音频参考槽在本仓是空的（§2.5）。`[DOC] + [CODE 反证]`

---

## 附：引用文件清单

| 文件 | 用途 |
|---|---|
| `workflows/minimax-h3-ref2v-quality.json` | 基础 r2v 图；音频解码路径（:141/:161/:211）、shift（:58-66）、资产（:36-39） |
| `workflows/minimax-h3-ref2v-ctx-quality.json` | 续接图；4 个 Motion Context 节点（:205/:212/:235/:246）、两个窗口参数（:226-227, :352-366）、chain 声明（:413-419） |
| `workflows/minimax-h3-i2v-ctx-*.json`、`…-ctx-*-2k.json` | 22 个 ctx 清单，`context_length`/`audio_context_length` 取值一致性核对 |
| `lib/index.js` | 旧图构造器（:487-530）、`chainGraphMismatch`（:1442-1450）、序号与长度换算（:2413-2445）、图参数注入（:2465）、节点记账（:2517-2524） |
| `lib/manifest.js` | `CHAIN_SOURCES`（:69）、`chain` 校验（:124-140） |
| `docs/shot-chain-continuity.md` | 续接权威契约；附 A/B/E/F 全部实测数字 |
| `docs/ref2va-shot-continuity-research.md` | 上游包能力与版本门槛；§8 实测（:233-282）；audio_context_length 独立（:54） |
| `docs/consistency-optimization-plan.md` | 镜头表 `speaker` 字段（:169-170）、口型安全断言（:197）、人工复核（:233） |
| `docs/i2v-vs-ref2v-and-model-comparison.md` | 联合预测 / 32 kHz 口径（:84, :179） |
| `docs/minimax-h3-video-benchmark.md` | 音频 VAE 资产（:65）、shift 三元组与 LoRA 配对表 |
| `e2e-out/chain-bench/rows.json` | 原始数据（4 条），`audio_rate`、滞后值 —— §4.5 质疑的出处 |
| `e2e-out/ctx-test/measure_seam.py` | 指标定义：滞后搜索窗（:111）、包络相关（:131）、响度台阶（:133） |
| `/Users/seiue/.dsh/skills/h3-prompt-writing/references/ref-en.txt` | `<Audio N>` 规范（§2.4 :93-109、§2.5 :111-122、§4.2 :191-210、§5.4 :261-281、§6 :283-306） |
| 同上 `base-en.txt` | `(Sx)` 与音色描述（§4.4 :128-145）、声景（§4.6 :155-161）、音乐（§4.7 :163-169） |
| 同上 `SKILL.md` / `references/studio-mapping.md` | 适配层映射（:77-81）、续接镜写作纪律（:31-38）、音频分轨映射（:25-28） |
| `skills/story-short-generator/SKILL.md` | 七列镜头表（:380-411）、自检门 7/8/9/10（:441）、续接不继承身份（:596）、重渲连锁（:830） |

> 核对：`skills/h3-prompt-writing/references/ref-en.txt` 与 `.dsh` 安装版 **逐字节相同**（`diff -q` 无输出），`base-en.txt` 同。故本文引用行号对两处都成立。
