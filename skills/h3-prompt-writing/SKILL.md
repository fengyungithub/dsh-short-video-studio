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

## 字幕（唯一权威版）

> 本节是字幕写法的**唯一权威来源**：片型 skill（3d-animation / brand-promo）只引用本节，不另立简化版——简化版漏掉限定词是已知缺陷（生成时字幕整段不烧）。实测矩阵与失败样本见 `references/studio-mapping.md` §5。

### 0. 前置：档位不是硬规则

**每一档都可以要求出字幕，没有任何档位硬规则。** 是否带字幕只取决于用户 / 脚本需求；用户可以自由选择升档路线（`fast`→`balanced`、`fast`→`quality`、`balanced`→`quality` 都允许）。

字幕是**文字质量问题**，不是档位门槛：用逐镜自检门（抽说话窗帧核对字幕）发现问题，再把「升档重渲该镜 / 改短句 / 拆镜」作为选项交给用户，**不强制升档**。

### 1. 定稿写法（四条，缺一不可）

字幕声明以英文双引号 on-screen text 形式**内嵌在 `detailed_description` 的 `<d>` 对白处**（**不用**末尾或其它位置的中文指令——实测六段式下中文措辞指令任何位置都不烧录）。四条限定词必须同时给全：

1. **字幕声明紧贴对白句** —— 声明与 `<d>[语言] 台词</d>` 相邻，不隔段、不放到末尾。
2. **写明逐字要求** —— `reading exactly "字幕原文"`，原文**逐字含标点**，不翻译不改写、不加引号/书名号/括号。
3. **强调描边 / 对比** —— `with a subtle dark outline for legibility`（给足可读性对比，缺此限定词会增加漏烧概率）。
4. **只给结束点** —— `fades out gently by about 4.0 seconds`，**不给时间窗**。

定稿句式（对白处内嵌，可直接复制改字）：

```text
<d>[Chinese] 我们到家了。</d> She speaks with her mouth opening and closing naturally on every word, and a Chinese subtitle with a subtle dark outline for legibility reading exactly "我们到家了。" is displayed centered near the bottom of the frame, and the subtitle fades out gently by about 4.0 seconds.
```

### 2. 失败写法（已实测，明确的反例）

- ❌ **给时间窗**：`from 1.0 seconds to 4.0 seconds` 这类**起止时间窗**会压掉字幕（只给结束点才稳）。
- ❌ **台词很晚才开口**：对白到 **1.0s 才起**（长前摇）时字幕容易整段不烧；让台词尽早开始（`beginning almost immediately`，~0.2s 起）。
- ❌ 其它同源失败写法：任何「XX 秒前不要字幕 / 之后必须消失」的负面时间约束；中文字幕指令句（「画面底部显示字幕」）；`silent` 镜写字幕。

### 3. 实测结论（2025-08-31，单镜对白句「我们到家了。」）

| 档位 | 步骤 | 结果 |
|---|---|---|
| `quality` | 20 步 | ✅ **逐字一致**（含标点），位置正确 |
| `balanced` | 8 步 | ❌ **整段未烧**（字幕完全没出现） |
| `fast` | 4 步 | ⚠️ 烧了但**有错字** |

- **画面内英文标牌**（如 `"Moon Base 7"`）在 `quality` 与 `balanced` 两档**都逐字一致**——说明上述差异是**字幕（对白联动）**特有的问题，不是所有画面内文字的普遍规律。
- 结论：字幕成片当前建议走 `quality` 档；`balanced` / `fast` 出字幕需自检门逐镜核对，字准不过就按「升档重渲该镜 / 改短句 / 拆镜」处理（见 §0，**不是硬规则**）。
- 详细矩阵与 A/B 实验记录见 `references/studio-mapping.md` §5。

## 失败回退

- 结构化重写后某镜质量倒退（字幕 / 口型 / 一致性 / 音频任一指标）→ 该镜回退为旧自由格式 prompt 重渲，**prompt 首行加 `[PROMPT_FALLBACK]` 标记**（插件质检门据此放行），结论记入交付清单。
- 全局关闭：删除本适配节 / 覆盖本文件即可，片型 skill 自动回到自由格式组装。
