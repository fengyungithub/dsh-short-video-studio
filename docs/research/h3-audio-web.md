# MiniMax H3 音频 / 声线一致性：公开信息调研

> 调研时间：2026-10-23。标注约定：**【官方】**＝MiniMax 官方博客/README/API 文档/官方 skill；**【ComfyUI】**＝Comfy 官方文档（Comfy 是 H3 官方授权的商用渠道）；**【社区】**＝第三方个人/厂商内容，未经独立复验；**【缺口】**＝公开信息不足。
> 一句话版本事实：H3 于 **2026-07-31** 发布（[launch blog](https://www.minimax.io/blog/minimax-h3)），**2026-08-03** 开源权重（[open-source news](https://www.minimax.io/news/minimax-h3-open-source)），别名 Hailuo 3.0；**没有官方 arXiv 技术报告**（见 (f)）。

---

## (a) 一句话结论

**【官方】** H3 **没有独立的"声线克隆/voice embedding"模块**，它的声线一致性是"**统一多模态序列 + 单个 Transformer 联合预测音视频 latent**"的副产品：一段参考音频被 AudioVAE 编码进**同一个 packed 多模态上下文**，再由 `<Audio N>` / `(Sx)` 这套**自然语言标签**声明"这是谁的声音、是复制还是只参考音色"，模型在同一次生成的连续 latent 里把对白、音效、配乐一起画出来 ⇒ **同一镜/同一段 4–15s 内的多镜头声线是"一次生成内的一致"；跨多次生成的一致没有任何官方机制，只能靠"重复同一份参考音频 + 重复同一段声音描述 + 同一 speaker ID"来外部约束**。官方文档从未给出"跨镜声线一致性"的量化承诺——这一点必须如实标注为信息缺口。

---

## (b) 架构层机制

### b1. 统一打包序列，音频不是后挂的 TTS

**【官方】** H3-Base "encodes different modalities using their corresponding encoders or VAEs and organizes the encoded representations into a unified packed multimodal sequence"，经 MM-RoPE 后整体送入 H3-Omni-Transformer：

- 文本 → **H3-Encoder**（Qwen3-VL-32B 全量权重，取第 50 层 hidden states；tokenizer 增加 `<d>` 等特殊 token）
- 视觉 → **H3-Encoder + H3-VisualVAE**（f16t4d24，再 patchify `1×2×2` ⇒ 有效 32× 空间下采样 / 4× 时间下采样）
- **音频 → 仅 H3-AudioVAE**（不经过 H3-Encoder）
- → **H3-Omni-Transformer 联合预测 video latent 与 audio latent**，再分别解码成画面与立体声

来源：[README · Model Architecture](https://github.com/MiniMax-AI/MiniMax-H3#model-architecture)、[官方开源公告](https://www.minimax.io/news/minimax-h3-open-source)。

⇒ 关键含义：**说话人音色不是外挂的 speaker embedding / voice id，而是"音频 latent 序列里的信息"**，与画面 latent 在同一个注意力场里被共同建模。这是"音画同步 + 口型 + 音色"能同时成立的结构性原因。

### b2. H3-AudioVAE：32 kHz / 40 Hz，左右声道独立

**【官方】** H3-AudioVAE 逐条：

- 左右声道**共用同一套 encoder/decoder，但各自独立处理**，解码后再合成 ⇒ 原生立体声输入与输出
- 每声道把 **32 kHz** 音频压成 latent token，时间速率 **40 Hz**
- 借鉴 **VA-VAE** 优化 latent 空间（保重建质量、降生成学习难度）

来源：[README · H3-AudioVAE](https://github.com/MiniMax-AI/MiniMax-H3#h3-audiovae)。

> ⚠️ **纠正任务简报里的假设**：不是 44.1 kHz。官方输出规格写明 **"Output audio: 32 kHz stereo"**（[开源公告规格表](https://www.minimax.io/news/minimax-h3-open-source)、中文页同："输出音频：32 kHz 立体声" [minimax.cn](https://www.minimax.cn/news/minimax-h3-open-source)）。40 Hz × 2 声道 ≈ 每秒 80 个音频 latent token，与 24 fps 画面（4× 时间压缩 ⇒ 6 latent 帧/秒）在序列里逐段交错。

### b3. 扩散，不是自回归

**【官方】** 发布的是 "**CFG-distilled** Omni Transformer model weights"；推理是**多步去噪**（ComfyUI 默认 20 步，可选 4 步 Lightning turbo LoRA），`BasicGuider` 在 **cfg=1、无 negative 分支**下运行。
来源：[README · 本地部署](https://github.com/MiniMax-AI/MiniMax-H3#local-deployment-of-h3-base)、[ComfyUI 文档](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native.md)。

**【第三方】** 独立论文亦把 H3 描述为 "multi-step iterative denoising process"（[Sol-H3, arXiv 2609.35110](https://arxiv.org/abs/2609.35110)，2026-09-28 提交）。

⇒ 所以**不存在"逐 token 自回归地续写同一把嗓子"**这种机制；一致性来自"同一条去噪轨迹覆盖整段时长"。

### b4. 原生多镜头建模（同一段内）

**【官方】** 预训练任务表明确列有 **"Native multi-shot modeling"**，并把音频侧写成 **"Text-to-audio: No separation between voice, sound effects, and music — all jointly modeled"**，另有 "Audio-to-audio reference and editing"、"Audio-video-to-audio-video reference and editing"。
来源：[launch blog · H3's Design Philosophy](https://www.minimax.io/blog/minimax-h3)。

⇒ **同一镜内 `[Shot 2] At 00:03.500, the camera cuts to...` 切镜时，音频是连续的**——这是官方唯一"跨镜声线一致"的结构性保证，但它的作用域**只有单次生成的 4–15 秒**。

### b5. 三层系统里，只有中间层开源

**【官方】** H3 = **H3-Context-IR**（托管，闭源）+ **H3-Base**（开源，768p）+ **H3-Regenerate-2K**（未开源，in-context 再生成）。Context-IR 负责"解析指令、跨模态关联、时序理解、复杂逻辑推理"，并把理解**序列化成结构化表示**；官方明确 "H3-Context-IR is critical to the quality of the final output"。
来源：[开源公告 · Model Architecture](https://www.minimax.io/news/minimax-h3-open-source)。

⇒ 重要推论：**"哪段音频是音色参考、对应哪个人物、要不要复刻原话"这层判断，很大一部分发生在闭源的 IR 阶段**，而不是开源权重内部。本地跑 H3-Base 时这层要靠人肉写 prompt 补齐（见 (c)）。

---

## (c) 参考音频 / 声线绑定机制

### c1. 输入能力与硬约束（Ref2VA）

**【官方】** 只有 **H3-Base-Ref2VA** 接参考音频；FL2VA 只接首/尾帧。Ref2VA 上限：

| 类型 | 上限 | 附加约束 |
|---|---|---|
| 图像 | ≤ 9 张 | — |
| 视频 | ≤ 3 段 | 每段 2–15s，总计 ≤ 15s |
| **音频** | **≤ 3 段** | **必须有图像或视频同时输入，不能单独作为唯一输入**；每段 2–15s，总计 ≤ 15s |
| 混合 | 全部文件 ≤ 12 个 | — |

来源：[开源公告 · Model Variants](https://www.minimax.io/news/minimax-h3-open-source)、[GitHub README](https://github.com/MiniMax-AI/MiniMax-H3)。
**【官方 API】** `content[]` 里以 `role=reference_audio` 表达；格式 WAV/MP3，单文件 ≤ 15 MB，每段 2–15s，总计 ≤ 15s；且 **`reference_audio` 与 `first_frame`/`last_frame` 互斥，不可混用**（[platform.minimax.io · video-generation-v2-create](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)）。

⇒ **"纯音频 → 克隆声线"这条路在 H3 里被明确堵死**：音频必须"附着"在一个视觉主体上。这也解释了为什么它叫 **Ref2VA**（参考→音视频）而不是 voice cloning。

### c2. 绑定是三件事的组合：`<Audio N>` + `(Sx)` + retention marker

**【官方】** 官方 prompt 规范（`skills/h3-prompt-writing/references/ref-en.txt`，即 ComfyUI 所指的 Full-reference mode 指南）规定了三段式：

1. **在 `subject_definitions` 里声明角色**，例如：
   `<Audio 1> is the voice-timbre reference for <Subject 1> (S1).`
   若该音频对应某个已定义主体，**必须复用该主体的全局 speaker ID**；ID 来自"目标视频的全局说话人顺序"，**不得在音频定义里另起编号**。
2. **在 `retention_analysis` 里声明复制强度**（四个 marker）：

   | marker | 含义 |
   |---|---|
   | `fully_copy` | 整段源音频 1:1 作为目标视频的完整最终音轨 |
   | `partially_copy` | 只复制部分时间线/部分音层，或复制后又增删替换 |
   | `reference` | **不直接复制信号，只参考音色、节奏、音乐风格、台词内容或声音质感** |
   | `weak_reference` | 只保留类别或氛围上的宽泛相似 |

   典型写法：`<Audio 2>: reference - the target speaker follows <Audio 2>'s voice timbre and measured delivery without copying the original signal.`
3. **在 `detailed_description` 的镜头里把说话人写出来**：`<Subject 1> (S1) says, <d>[English] ...</d>`

来源：[ref-en.txt · §2.4 `<Audio N>` / §4.2 Audio](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt)。

### c3. "只借音色，不借内容"是明文规则

**【官方】** 两条互补的规定，正对"声线一致但台词不同"这个需求：

- *"When only timbre, rhythm, emotion, or delivery is referenced, **do not carry the original dialogue from the reference audio into the target video**."*（只参考音色/节奏/情绪/表演时，不要把参考音频里的原台词搬进目标视频）
- 反之，若确实要复刻参考音频里的台词/歌词，则**逐字保留原文与原始语言**放在 `<d>` 内，听不清写 `[unclear]`，不得改写或意译。

来源：同上 §5.4 Speakers, Audio Sources, and Dialogue。

**【ComfyUI】** 把这条压缩成一句操作口径：**"Audio carries timbre, not words. Specify delivery; one audio ref per speaker when assignment must be exact."** 同时给出接线规则：参考视频的声轨必须把 `ref_video_audio_N` 与 `ref_video_N` 配对，否则该文件的音频**不会**被当作 `<Audio N>`；编号顺序是"先视频声轨（按视频顺序），再独立音频片段"；独立音频只需要接 `audio_vae`。
来源：[ComfyUI · R2V prompting tips](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native.md)。

### c4. 官方样例：这就是唯一的"声线参考"官方示范

**【官方】** 开源公告里的 Ref2VA reproducible case，prompt 原文含：

```
<Audio 2> is the voice timbre reference for <Subject 1>'s voice, containing a spoken male voiceover.
...
<Audio 2>: reference - the target audio references the male voice timbre from <Audio 2>
   to generate <Subject 1>'s spoken dialogue.
...
<Subject 1> (S1) speaks softly, <d>[English] Follow the wind, live free.</d>
```

即"原视频复用画面/构图 + `<Audio 1>` 复用 BGM + `<Audio 2>` 只借音色来说**新**台词 + 口型重新对齐"。
来源：[开源公告 · case-Ref2VA](https://www.minimax.io/news/minimax-h3-open-source)。

**【官方博客】** 另一个更直白的例子，演示 prompt 是：*"Reference the Hitchcock camera movement from Video 1, have the character in Image 2 sing, with the vocals matching Audio 3."*（[launch blog](https://www.minimax.io/blog/minimax-h3)）——注意这里"唱歌"也走同一条参考音频通道。

### c5. 有没有"原生 voice clone 功能"？

- **【官方】API 面上没有**：`video-generation-v2-create` 的参数集里没有 `voice_id`、`speaker_id`、`voice_clone` 之类字段；声线只有一个入口 `role=reference_audio`（[API 文档](https://platform.minimax.io/docs/api-reference/video-generation-v2-create)）。H3 产品线里 Speech / Music 是**独立产品**（Speech 2.8、Music 3.0），与 H3 的参考音频**没有公开的打通文档**。
- **【ComfyUI】本地节点也没有**：只有 `LoadAudio` + 音频 VAE 的参考通路。
- **【社区】用户确实在找这个能力**：Hugging Face 上有 "Voice cloning?" 的提问帖，以及"How define audio ref to the Subject 1 - Ref2V"的讨论（我在本机网络下**无法打开** HF 页面，仅看到搜索摘要：用户照抄了 `(S1) speaker follows <Audio 1>'s voice timbre and measured delivery without copying the ...`）——说明"官方规范怎么写"本身就是社区摩擦点。**这两条我只按摘要标注，未读原文。**

⇒ 结论：**H3 提供的是"参考音频条件化"（reference-conditioned），不是"声线身份注册"（voice identity enrollment）**。没有可复用的 voice id，每次生成都得重新喂同一段音频。

---

## (d) 跨镜 / 长视频一致性做法

### d1. 作用域先划清：单次 4–15 秒

**【官方】** 输出 4–15s（API：H3 4–15s，H3-Max 5–15s），24 fps，短边默认 768，2K 需再生成。**没有"无限延长"的官方路径。**
**【社区·第三方厂商博客】** 说得更直白："This method does not promise infinite generation"（[seedance.tv 教程](https://www.seedance.tv/blog/minimax-h3-continuous-talking-avatar-workflow)，注意这是竞品厂商的内容营销，仅作方法论参考）。

### d2. 官方支持的三条做法（都能在文档里找到依据）

1. **能一镜到底就别切次**——把多镜头塞进同一次生成，用 `[Shot N] At 00:03.500` 切镜。官方预训练就有 **native multi-shot modeling**，且音频在同一条 latent 里连续（[blog](https://www.minimax.io/blog/minimax-h3)）。
2. **同一 `(Sx)` 跨镜不变**——"A speaker keeps the same ID across shots; characters who never vocalize receive no speaker ID."；多人同时说话用 `(S1,S2)`（[base-en.txt §4.4](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/base-en.txt)）。
3. **台词跨剪切点时用 `<scenetrans>`**——*"When the same line of dialogue or lyrics crosses a cut, use `<scenetrans>` at the connecting points in both parts and explicitly state that the audio continues across the cut."*（同上）这是官方给出的"声音跨镜不断"的唯一显式指令词。

### d3. 跨多次生成（真正的长视频）——官方没有方案，只有可推断的最小约束

**【官方隐含】** 由于没有 voice id，唯一的"身份锚"就是**每次都喂同一份参考音频**；由于音频必须伴随视觉输入，锚定声线时通常要"角色卡 + 参考音频 + 场景卡"一起给（≤9 图 / ≤3 视频 / ≤3 音频 / 共 ≤12 文件）。
**【ComfyUI】** 提供的是**画面**侧的续接：`MiniMaxH3AddGuide` 可在任意 `frame_idx` 锚定 guide，**音频 guide 会"在同一帧号对齐、裁到剩余时长"**，前 22 帧接在 frame 0 可"continues both streams"；`video_minimax_h3_i2v_continuation` 模板只续画面。另外 per-token noise mask 可对 **audio latent** 做"保留/重绘"（0 = keep，1 = regenerate，mask 只能按整个 audio latent 帧切）。
来源：[ComfyUI · Anchoring guides at any frame](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native.md)。

### d4. 社区长链方案（有量测数据，但属第三方）

**【社区】** `joeygambino/MiniMax-H3-Multishot-Workflow`（"H3 Seamless Chain" ComfyUI 节点包）是公开信息里**唯一带量化记录**的跨镜一致性工程。其与声线直接相关的做法：

- **两套链机制**：① `first_frame` 链（把上一镜末帧交给下一镜首帧，走 fl2va 训练好的续接任务；接缝音频做 **40 ms equal-power weld** 防爆音）；② `context_pin`（上一镜**末 22 帧以原始 latent** 送进下一镜，无 VAE 往返，配**时间线对齐的音频参考**）。
- **`seed_per_shot` 必须 ON**：*"Measured: per-shot seeds hold the face; **a single seed shared across all shots drifted both face and voice**."* ⇒ 反直觉但很关键：**全片共用一个 seed 会让脸和嗓子一起漂**。
- **每个角色各自的音频参考**：v2.7.0 加入 `voice_ref_2` / `voice_ref_3`，"each character keeps their own voice across a chained scene - verified blind across a full chain, **no cross-speaker bleed**"；更早有 `voice_ref` / `self_anchor_voice`（标为 v1.5 的头号特性）。
- **接缝工艺**：AIRLOCK（每镜开头先"保持上一镜收尾姿态 + 约 2 秒静默"再说话）；**每镜前 ~1 秒是"丢弃重放"**（对白从第 0 帧开口会被吃掉开头音节）；一句台词永远不跨两镜；每镜预留约 2 秒余量；
- **提示词层面**：每个角色的外形描述**与房间/光线描述**在每一镜里**逐字重复**；
- **帧率锁 24**：*"Keep fps at 24. Other rates **audibly shift voice accents**."*
- 自报**已知限制**：长链纹理每接缝 +13%（尖锐化），7 窗时肉眼可见；建议单次续接 ≤ ~4 窗（约 30–40s）。

来源：[joeygambino/MiniMax-H3-Multishot-Workflow README](https://huggingface.co/joeygambino/MiniMax-H3-Multishot-Workflow)（我通过镜像读取全文；原始 HF 域名在本机网络下不可达）。**【社区】数字为其自报，未独立复验。**

---

## (e) 社区实测与失败模式

| 失败模式 | 证据等级 | 说明与建议 |
|---|---|---|
| **多说话人 + 参考音频时"张冠李戴"**（台词分给了错误的人） | 【ComfyUI】官方文档明写 | *"Multi-speaker + audio refs: Wrong-speaker assignment can happen. Tie lines to visible events, not timecodes."* 建议：把台词绑到**可见事件**而非时间码；必要时**按人分别外部生成音频**，再用对的 marker（`fully_copy` vs `partially_copy`）引用（[ComfyUI prompt guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide.md)） |
| **跨镜声线漂移**（尤其全片共用同一 seed） | 【社区】有量测口径 | 见 d4：`seed_per_shot` ON 才稳；单 seed 会"face and voice 一起漂" |
| **跨说话人串音 / bleed** | 【社区】 | 靠"每角色一份 `voice_ref`"解决（v2.7.0，盲测通过） |
| **turbo 低步数削弱声线参考** | 【ComfyUI】 | 4-step Lightning LoRA "faster, **weaker reference/audio**"；"Prefer 20–25 steps when references must hold"（[R2V tips](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native.md)） |
| **帧率改动 → 口音/音色听感变化** | 【社区】 | 锁 24 fps |
| **BGM / 音效串层**（音乐糊进对白层，或反之） | 【官方 + ComfyUI】 | 音层必须写对位置：环境音/拟音进 `overall_soundscape`，观众专属配乐进 `non_diegetic_music`，对白只留在 `<d>` 里；*"If unwanted speech appears, fill both fields explicitly"*（`N/A` 只在真静音时用） |
| **参考音频的原台词被"顺"进新片** | 【官方】 | 只借音色时明文禁止搬运原台词（c3）；要复刻才逐字保留 |
| **切镜处爆音/断音** | 【社区】 | 40 ms equal-power weld；`<scenetrans>` 声明跨切连续 |
| **参考音轨没被当成 `<Audio N>`**（本地） | 【ComfyUI】 | 忘接 `ref_video_audio_N` 就会静默丢弃该文件音轨 |
| **满配 9 图 + 3 视频 + 3 音频 的一致性** | 【社区·中文实测】 | 明确写"作者没有做满全部输入的极限测试，因此本文不把接口容量等同于满载稳定性"（[bbs.monster 详测](https://bbs.monster/thread-4561-1-22.html)）；另一篇 200+ 样本实测强调"多说话人用固定编号 S1/S2，中途不要交换编号"（[bbs.monster 实测](https://bbs.monster/thread-4917-1-11.html)） |
| **口型/声音评判方法** | 【社区·第三方厂商】 | 分轮看：正常速看语义 → 静音看身份/牙齿/嘴唇/下颌 → 闭眼只听音色/语速/房间音 → 逐帧看每段首尾 12 帧 → 手机尺寸复查；出现"**声音突然变年龄或变距离**"即判废（[seedance.tv](https://www.seedance.tv/blog/minimax-h3-continuous-talking-avatar-workflow)） |

---

## (f) 未证实 / 信息缺口（请勿在这些点上"脑补"）

1. **没有官方技术报告 / 论文**。arXiv 全文检索 "MiniMax-H3" 命中的都是**第三方**工作，无一为 MiniMax 官方架构论文：Sol-H3 推理加速（[2609.35110](https://arxiv.org/abs/2609.35110)，2026-09-28）、物理世界理解评测（[2609.18323](https://arxiv.org/abs/2609.18323)，2026-09-16）等。⇒ **架构细节的唯一一手来源就是博客 + README**，粒度仅到"模块级"，没有训练数据配比、没有消融。
2. **官方从未量化"声线一致性"**。没有任何 speaker similarity / SECS / 声纹相似度指标，也没有 "voice consistency" 的评测章节；官方叙事只到"原生立体声 + 联合建模 + 参考音色"。
3. **"跨多次生成保持同一把嗓子"没有官方保证**。官方文档的作用域始终是**单次生成**；跨调用的一致性属于社区工程实践（d4），且其量测是自报。
4. **H3-Context-IR 闭源**，所以"模型如何决定哪段音频对应哪个人物"**无法本地复现**；本地部署时的表现差距，官方自己说"差距可能来自缺这层预处理"（开源公告原文：Context-IR "is critical to the quality of the final output"）。
5. **2K 再生成（H3-Regenerate-2K）是否保声线**：官方只讲"复用原始多模态上下文以恢复细节（小字、纹理）"，**未提音频是否重绘、是否漂移**；该模块亦未开源。
6. **32 kHz 的具体档位与听感**：官方只给"32 kHz stereo"；AudioVAE 左右声道**独立编解码**，是否存在声道相位/相关性损失，无公开数据。
7. **音频参考的最优时长/信噪比/是否需去 BGM**：官方只给 2–15s 的机械限制；"用多干净的样本"属社区经验（去 BGM、单说话人、固定麦克风距离、按句切分、对齐响度与房间音——均出自 [seedance.tv](https://www.seedance.tv/blog/minimax-h3-continuous-talking-avatar-workflow)、[bbs.monster](https://bbs.monster/thread-4917-1-11.html) 这类第三方，**非官方**）。
8. **网络可达性限制**：`huggingface.co` 在本机不可达（curl 与 fetch 均超时），HF 上的 discussion #64、`comfy-MiniMax-H3-workflows` 的 "Voice cloning?" 帖**我只看到搜索摘要、未读原文**；`joeygambino` 的 README 经镜像读取。故 (e) 中涉 HF 讨论的两条应按"未验证"对待。
9. **"H3 有 voice clone 功能"这一说法在任何官方页面都找不到**；把它写进产品说明属**推断而非事实**。

---

## (g) 来源清单

**官方（MiniMax）**
1. [MiniMax H3: An Open Model Breaking the Boundaries Between Tasks and Modalities](https://www.minimax.io/blog/minimax-h3) — 2026-07-31 发布博文；含"native multi-shot modeling"、"No separation between voice, sound effects, and music"、"vocals matching Audio 3" 示例。
2. [Open General Intelligence: MiniMax H3 Is Now Open Source](https://www.minimax.io/news/minimax-h3-open-source) — 2026-08-03；规格表（32 kHz stereo）、模型变体与参考输入上限、H3-AudioVAE/VisualVAE/Omni-Transformer 架构、Ref2VA case 全文。
3. [开放通用智能，MiniMax H3 正式开源（中文）](https://www.minimax.cn/news/minimax-h3-open-source) — 中文对照；"音色参考、原始音频复用"表述。
4. [GitHub MiniMax-AI/MiniMax-H3 · README](https://github.com/MiniMax-AI/MiniMax-H3) — 架构章节（AudioVAE 32 kHz / 40 Hz / 声道独立；33B dense；MM-RoPE；CFG-distilled）。
5. [官方 prompt 规范 · Full-reference（ref-en.txt）](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/ref-en.txt) — `<Audio N>`、`retention_analysis` 四 marker、§5.4 说话人与 `<d>` 规则、"只借音色不搬台词"。
6. [官方 prompt 规范 · Base（base-en.txt）](https://github.com/MiniMax-AI/MiniMax-H3/blob/main/skills/h3-prompt-writing/references/base-en.txt) — `(S1)`/`(S1,S2)`、跨镜同一 speaker ID、`<scenetrans>`/`<cutoff>`。
7. [platform.minimax.io · Create Video Generation Task](https://platform.minimax.io/docs/api-reference/video-generation-v2-create) — `role=reference_audio`、WAV/MP3 ≤15 MB/2–15s/≤3 段、与 first/last_frame 互斥；H3 vs H3-Max。

**ComfyUI 官方文档（H3 商用授权渠道）**
8. [MiniMax H3 总览](https://docs.comfy.org/tutorials/video/minimax/minimax-h3) — 原生立体声、参考驱动、"lock identity, style, motion, camera, or voice"。
9. [Native workflows（T2V/I2V/R2V）](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native.md) — R2V 十三条 prompting tips（"Audio carries timbre, not words"、`ref_video_audio_N` 接线、audio 编号顺序、turbo 削弱参考）、`MiniMaxH3AddGuide` 音频 guide、audio latent noise mask。
10. [Prompt guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide.md) — 说话人规则汇总、多说话人错配告警、"per-speaker audio externally + 正确 marker"。

**第三方 / 社区（未独立复验）**
11. [joeygambino/MiniMax-H3-Multishot-Workflow（H3 Seamless Chain）](https://huggingface.co/joeygambino/MiniMax-H3-Multishot-Workflow) — 自报量测：`seed_per_shot` 对脸/声的影响、per-subject `voice_ref`、context_pin 22 帧、40 ms weld、24 fps 与口音、长链纹理 +13%/接缝。
12. [seedance.tv · Continuous Talking Avatar Workflow](https://www.seedance.tv/blog/minimax-h3-continuous-talking-avatar-workflow) — **竞品厂商内容**；分段/边界帧/AIRLOCK/评审清单方法论，自称"非 H3 输出"的样片仅作基线。
13. [bbs.monster · MiniMax H3 详测](https://bbs.monster/thread-4561-1-22.html) / [超大杯实测 200 样本](https://bbs.monster/thread-4917-1-11.html) — 中文社区实测转写；接口上限 ≠ 满载稳定性；固定 S1/S2 编号建议。
14. [Sol-H3（arXiv 2609.35110）](https://arxiv.org/abs/2609.35110) — 第三方推理加速论文，佐证 H3 为多步扩散、"33B"、"5s 1344x768 with audio"。
15. [Can MiniMax-H3 Reason About the Physical World?（arXiv 2609.18323）](https://arxiv.org/abs/2609.18323) — 第三方评测（与音频一致性无关）。
16. [lebao-arch/comfyui-h3-audio-drive-auto](https://github.com/lebao-arch/comfyui-h3-audio-drive-auto) — 社区节点：把音频锁进 joint AV latent、离线口型打分（2026-10-20 建仓，仅 1 star，成熟度低）。

**未能读取（仅搜索摘要）**
17. `https://huggingface.co/MiniMaxAI/MiniMax-H3/discussions/64`（"How define audio ref to the Subject 1 - Ref2V"）、`https://huggingface.co/javawock7618/comfy-MiniMax-H3-workflows/discussions/4`（"Voice cloning?"）——本机网络对 huggingface.co 不可达。

---

## 附：写进生产流程时的最小可用结论

1. **要声线一致，先决定"是不是一次生成"**：能在 4–15s 内说完的，别切次；切了次就没有官方保证。
2. **每镜都带同一份参考音频**（去 BGM、单说话人、2–15s），并逐镜重复同一句 `<Audio N> is the voice-timbre reference for <Subject N> (Sx).`
3. **`(Sx)` 编号全片固定**，绝不中途换号；多人同场务必一人一份 `voice_ref`。
4. **只借音色就写 `reference`**，别让模型把参考音频的原台词搬过来；要复刻原话则逐字写进 `<d>` 并升级为 `partially_copy`。
5. **不要全片共用一个 seed**（社区量测：脸和嗓子会一起漂）；**锁 24 fps**；**参考要"持住"就别用 4 步 turbo**（用 20–25 步）。
