# 声线试镜（STEP 3.5）

> **单片**：角色卡锁定后、镜头表之前执行本文件全部流程。
> **剧集**：阶段 C 由 production 一次性建声线；单集只从台账 `voices[]` 取 `voice:`，**不重跑试镜**。
> 试镜**不带风格锁 C**；A+B 仍带明显环境声时走 B-only + 数字静音声明（见 §3.5.1）。

## STEP 3.5：声线试镜（角色卡锁定后、镜头表之前；只在有对白角色时做）

**做不做（先读声线方案，不再自行判断）**：

- **被 `short-drama-series-production` 委托时（连续短剧单集）**：方案与 `voice:` 来自集制作包 ⑥ 与 `production-state.json` 的 `voices[]`。`existing` 且台账已有 id → 只做 3.5.4 的「已有声音」校验（物化到画布、核对 id），**不在本集重跑试镜**；台账缺 id 才算缺口，回阶段 C 补（换声线会连锁重渲，不能每集重抽）。`text-only` → 整步跳过。
- **单片模式**：读 STEP 0 的声线方案——
  - `audition`（无现成声音时的默认）→ 走本节全部流程，每个说话角色一份声线样本；不说话的配角跳过；
  - `existing` → **跳过 3.5.1–3.5.3**，执行 3.5.4 的「已有声音」分支（资产库 / 画布音频 / 用户上传 → 入库 → 声线清单）；
  - `text-only` → **整步跳过**（不生成试镜）；镜头表 `声线参考` 全写 `none`，STEP 7 不传 `audio_ref_nodes`。

**为什么必须在这里**：声线样本是镜头表 `声线参考` 列与 STEP 7 `audio_ref_nodes` 的来源；换声线会让该角色**所有对白镜 + 续接下游**连锁重渲，所以必须在镜头表之前定死。

### 3.5.1 写试镜提示词（每角色一份，三档同文）

**硬要求**：单镜、单人、一句台词、**无环境音、无音乐、无音效、无字幕**、口型清晰可见、背景中性。用 `canvas_write_prompt_bank(title="Mia 试镜 提示词（分档）", group="voice auditions", prompts={fast: p, balanced: p, quality: p})`，三档逐字一致。

**试镜只用风格锁 A + B，不带 C**（实测 2026-10-26：带 C 的试镜中段人物消失、只剩云海/建筑——C 的环境词会把纯底试镜拉成场景镜头）。同时写死：`plain neutral seamless studio wall` / `static camera` / `no cut` / `framing stays identical from first to last frame` / `subject remains in frame the whole time`。

**若 A+B 仍带明显环境声**（AV 模型可能自己补 room tone），改走 **v3 路径：只带锁 B + 棚拍后缀**，并在 `detailed_description` 里明确写 `AUDIO: close-mic dry studio recording; only the voice is audible; the rest of the track is digital silence; no room tone, no ambience, no air, no wind, no water, no birds, no reverb, no echo, no music, no sound effects`。

模板（Ref2VA 六段式，H3 路径）：

```text
subject_definitions:
<Subject 1> is the young woman with long dark hair and a light-blue blouse in <Picture 1>.
summary:
[reference generation] A single clean audition shot of <Subject 1> speaking one short line to the camera.
retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - identity, hair and clothing retained.
detailed_description:
[Shot 1] A medium close-up of <Subject 1> in front of a plain neutral wall, static camera, mouth clearly visible. The recording is clean and dry: no room tone, no background noise, no music, no sound effects — only the voice. <Subject 1> (S1) looks into the lens and says: <d>[Chinese] 这是我自己的声音。</d> Her lips close after the line.
overall_soundscape: N/A
non_diegetic_music: N/A
```

- **`overall_soundscape: N/A` 与 `non_diegetic_music: N/A` 是硬要求**（禁环境音/配乐），正文再写一遍 "clean and dry … only the voice"。
- 台词 **8–14 字、单句、中性语气**，不要拟声词/笑声/叹气；语言与后续对白一致（中文项目就用中文）。
- 试镜阶段**还没有参考音频**：不要写 `<Audio 1>`，也不要传 `audio_ref_nodes`。
- 风格锁后缀照常追加；但试镜只用于抽声，画面可以丢。

### 3.5.2 生成试镜片段

```text
comfy_generate_video(type='r2v', tier='balanced', prompt_node=<试镜提示词库>, ref_nodes=[<角色卡节点>],
                     ref_variant=<single|three>, length=124, title='Mia 试镜', group='voice auditions')
```

- 默认 **`balanced`**（166s/条）：`fast` 是 4 步 turbo，官方说明会削弱音频，**不能把 fast 产物当定稿声线**；项目全程 fast 时可先用 fast 看走向，定稿前用 balanced 重出一条。
- 不要传场景卡、首末帧、`continuity_from`；`length=124` ≈5.17s，满足参考音频 2–15s 下限。

### 3.5.3 人工确认（选项卡）

试镜片段渲完、AI 自检（单人 / 口型清晰 / 无字幕）通过后出选项卡；**环境音与配乐由人工在卡里听核**（AI 不能听音）：

**只听声线通过（推荐）** / 声线+画面都通过 / 换 seed 重抽（≤3 次）/ 上传真人声线 / 该角色改为仅文本音色（记录风险）

- 重抽复用同一个 `prompt_node`，只换 seed；连续 3 次不过就换真人声线或跳过，不要无限抽。
- 用户选「该角色改为仅文本音色」时，该角色的镜头 `声线参考` 填 `none`、STEP 7 不传它的参考音频，并在声线清单与交付清单记录“该角色音色无保证”。

### 3.5.4 得到声线样本 → 上画布 → 入库

**`audition` 路径（有试镜片段）**：

```text
extract_audio(video_node=<试镜节点>, title='Mia 声线样本', group='voice auditions')
```

- 产物是**画布 audio 节点**（工具自动上画布，**不要只留文件路径**）；本机无 ffmpeg 时走 ComfyUI，产物为 `.flac`（32kHz）。
- 试镜里的环境音会被一起抽进去 —— 所以 3.5.1 必须禁环境音；确认时若听到底噪/音乐/第二人声，重抽或改真人声线。

**`existing` 路径（没有试镜，直接用已有声音）**：

1. `asset_list(type=voice)` 查资产库；命中就 `asset_to_canvas` 物化到画布（group `voice auditions`），或直接拿资产 id 给 STEP 7 用；
2. 再看画布上是否已有可用音频节点（之前上传/抽取的）；
3. 都没有 → 让用户通过画布「＋ 上传素材」上传 **2–15s、单人、干声、无 BGM、无混响** 的音频（wav/mp3/m4a/flac），落到 `voice auditions` 组；
4. 画布音频节点/上传节点**不需要再 `extract_audio`**。

**两条路径共用**：

- 用户点该音频卡「入库」→ 类型选「音频」→ 得到 `voice:<hex>`。
- 写一份「声线清单」文本节点（group `voice auditions`）：`角色 | voice:<id> 或 canvas:<音频节点 id> | 来源（audition/existing/仅文本）| 试镜节点 id | tier | seed | 时长`。**后续镜头表与 STEP 7 只认这份清单里的 id**；`canvas:` 是未入库的临时引用（仅同会话可用，跨会话前必须点「入库」换 `voice:`）。

### 3.5.5 后续使用（STEP 5 / STEP 7 引用）

- 镜头表「音频与对白轨 → `声线参考`」填 `voice:<id>`（入库后）、`canvas:<音频节点 id>`（未入库临时）或 `none`；**同一角色全片（连续短剧为全季）必须同一个引用**。
- 方案为 `audition` / `existing` 时，STEP 7 对白镜传 `audio_ref_nodes=['voice:<id>']`（未入库时直接传画布音频节点 id），prompt 里写 `<Audio 1> is the voice-timbre reference for <Subject 1> (S1).` + `<Audio 1>: reference - …`（写法委托 `h3-prompt-writing`）；`text-only` 时两者都不写（只保留文本音色描述）。
- 只有 `type='r2v'` 支持；`i2v` / 2K / hires 实现会报 `audio-ref-unsupported`；≤3 段、每段 2–15s、总 ≤15s。
- 换 `voice:` 资产 = 该角色全部对白镜 + 续接下游重渲。