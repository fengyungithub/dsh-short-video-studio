---
name: h3-prompt-writing
description: Write MiniMax H3 video generation prompts for T2VA, I2VA, FL2VA, L2VA, and Ref2VA. Use when rewriting multimodal requests into H3 prompt structures, composing integrated_multimodal_description, overall_soundscape, and non_diegetic_music, aligning keyframes, or defining reference labels for images, videos, and audio. dsh-short-video-studio 适配版：还负责把画布上的镜头表/分镜/参考绑定重写为 H3 结构化 prompt（见文末「插件对接」适配节）。
compatibility: Portable to any agent that can read local files — no external API calls, MiniMax Hub tools, or proprietary runtime required. The agents/openai.yaml file only adds optional ChatGPT/Codex UI metadata; it does not restrict the skill to OpenAI agents.
---

# H3 Prompt Writing

> 以下正文为 MiniMax 官方 SKILL.md 原文（Source: github.com/MiniMax-AI/MiniMax-H3, skills/h3-prompt-writing/SKILL.md, License: MiniMax H3 Community License），
> 只读引用；dsh-short-video-studio 的插件适配内容见文末「插件对接（dsh-short-video-studio 适配）」节。

## Workflow

1. Identify the input mode: T2VA, I2VA, FL2VA, L2VA, or full-reference Ref2VA.
2. For base text/keyframe modes, read `references/base-en.txt` and follow its final prompt structure.
3. For full-reference mode, read `references/ref-en.txt` and follow its six-section rewrite format.
4. Preserve the exact field names, section order, labels, and timing notation from the selected guide.

## Base Modes

- T2VA: build the full audiovisual timeline from text.
- I2VA: start from the first frame and develop forward from it.
- FL2VA: describe the continuous path between the first and last frames.
- L2VA: infer a plausible opening and converge to the supplied last frame.

Use `integrated_multimodal_description`, `overall_soundscape`, and `non_diegetic_music` in the order shown in `references/base-en.txt`.

## Full-Reference Mode

Ref2VA rewrites use `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and `non_diegetic_music` in that order. Reference labels stay consistent across all sections.

Read `references/ref-en.txt` for label rules, retention analysis, and complete examples.

## Output Rules

- Write rewrite sections in English; preserve dialogue, lyrics, and visible scene text in their original language.
- Describe each shot by composition, subjects, environment, actions, camera, sound, and the exact point where referenced content appears.
- Avoid plot summaries, unresolved reference labels, and timing that does not match the requested duration.

## Tips for Better Results

- Always match the total duration of the description to the requested video length (4–15 seconds).
- Keep reference labels consistent (e.g. `<Picture 1>`, `<Video 1>`, `<Audio 1>`) across every section.
- Prefer concrete visual and audio details over abstract words like "cinematic" or "beautiful".
- When using keyframes (I2VA / FL2VA / L2VA), clearly state how the first and/or last frame connects to the timeline.

---

# 插件对接（dsh-short-video-studio 适配）

> 以下为 dsh-short-video-studio 适配追加，非官方原文。职责：把画布上的片型产物
> （镜头表 / 分镜 / 参考绑定 / 音频模式）重写为 H3 结构化 prompt，本地复刻官方
> H3-Context-IR 的核心产物。完整映射见 `references/studio-mapping.md`。

## 输入与条件启用

- 输入：片型 skill（如 3d-animation-short-generator）在逐镜生成时提供的「本镜分镜章节 + 镜头表 `参考锚点` / `音频与对白轨` 行 + ref_nodes / first_frame / last_frame 绑定」。
- **仅当**当前 capability 的 `preferred` 工作流 id 前缀为 `minimax-h3-` 时应用本重写；其他工作流跳过（片型 skill 自由格式组装，模型无关）。
- 参考图硬规则（单视图 / 图内零文字 / 不拼图 / first_frame 仅同场景续接）由插件工具契约统一约束，本 skill 遵守不重述。

## 重写路径

- **参考绑定镜**（`ref_nodes`，无首末帧）→ 读 `ref-en.txt`，输出 **Ref2VA 六段式**：
  `subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`。
- **首末帧串联镜 / 转场镜**（`first_frame_node` / `last_frame_node`）→ 读 `base-en.txt`，按 **I2VA**（仅首帧）或 **FL2VA**（首末帧都有）输出：
  对齐指令（首行）+ `integrated_multimodal_description` + `overall_soundscape` + `non_diegetic_music`。

对齐指令按官方模板：
- I2VA：`For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`
- FL2VA：`How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.`

## 字段映射速查

| 插件产物 | H3 字段 |
|---|---|
| 镜头描述四象限 | `detailed_description` / `integrated_multimodal_description` 的 `[Shot N]` |
| 对白（说话人/语气/时间） | `(Sx)` + `<d>[语言] 台词</d>`（ID 按发声顺序分配、跨镜复用） |
| 口型纪律 | 显式 mouth-open / mouth-closed（旁白用官方 off-screen voiceover 句式） |
| 音效 / 环境音 | `overall_soundscape` |
| BGM 意图 | `non_diegetic_music`（无则 `N/A`） |
| 参考锚点 / 角色卡 / 场景卡 | `subject_definitions` + `retention_analysis` + `detailed_description` 空间描述 |

详细映射、对齐指令模板与项目级后缀边界见 `references/studio-mapping.md`。

## 与片型 skill 的边界

- 本 skill 输出 **H3 结构核心**（六段式 / 三段式 + 对齐指令 + `<d>` 对白）。
- **风格锁、字幕烧录指令、负向意图**由片型 skill 在本输出之后拼接，不归本 skill（见 `references/studio-mapping.md` §4）。

## 字幕（实验定稿，2025-08-31）

- 字幕**必须**以英文双引号 on-screen text 声明**内嵌在 `detailed_description` 的 `<d>` 对白附近**（`a Chinese subtitle "字幕原文" is displayed centered at the bottom of the frame`）。
- **不用末尾/内嵌中文指令**（实测：六段式下中文措辞指令任何位置均不烧录）。
- dialogue 镜成片用 **quality 档**保证字准；fast 档仅调试（字幕字准不可靠，可接受或回退旧格式）。
- 详细矩阵见 `references/studio-mapping.md` §5 与画布「A/B 实验结论」节点。

## 失败回退

- 结构化重写后某镜质量倒退（字幕 / 口型 / 一致性 / 音频任一指标）→ 该镜回退为旧自由格式 prompt 重渲，**prompt 首行加 `[PROMPT_FALLBACK]` 标记**（插件质检门据此放行），结论记入交付清单。
- 全局关闭：删除本适配节 / 覆盖本文件即可，片型 skill 自动回到自由格式组装。
