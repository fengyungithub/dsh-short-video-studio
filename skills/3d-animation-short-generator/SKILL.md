---
name: 3d-animation-short-generator
description: |
  将一句话故事创意做成 30 秒级、风格统一的 3D 动画短片（皮克斯/治愈系/Q 版/动态图形风）。按固定顺序产出项目简报、故事大纲、角色卡、场景卡、七列镜头表、文本分镜、单镜头视频、最终合成，并在关键创意与高成本节点用选项卡确认。支持「静音 / 对白主导」两种音频模式，内置口型安全（说话人绑定 + 非说话人闭嘴 + 一镜一人）。触发词：3D动画短片、动画短片、皮克斯风短片、故事转视频、卡通短片、口型安全。不适用于单图修图、真人写实、单条独立镜头。
whenToUse: |
  用户想把一个故事创意做成完整、连贯的 3D 动画短片（含角色/场景设定、分镜、逐镜视频、合成），或要求「口型安全 / 对白字幕 / 角色一致性 / 末帧串联」等动画短片生产流程时使用。
---

# 3D 动画短片生成器（DSH · dsh-short-video-studio 适配版）

把一句话创意做成完整、风格统一的 3D 动画短片。所有耐用产物落到画布，关键创意点与高成本步骤用选项卡确认。

## 工具映射（本环境专用，替代 MiniMax-hub 的 hub_* 工具）
| 用途 | 用这个工具 |
|---|---|
| 生成角色卡/场景卡/分镜图 | `comfy_generate_image` |
| 生成单镜头视频（带声音） | `comfy_generate_video` |
| 查可用模型/工作流 | `comfy_list_workflows` |
| 通用渲染（指定能力/工作流） | `comfy_render` |
| 写项目简报/大纲/镜头表/分镜 | `canvas_write_node` |
| 读画布节点 | `canvas_get_node` / `canvas_list_nodes` |
| 归组/排序 | `canvas_group_nodes` / `canvas_reorder` |
| 读写项目设置 | `canvas_get_state` / `canvas_set_state` |
| 所有批准/选择关口 | `ask_user_question`（选项卡） |

> 旁白主导（narration-led）不在本 skill 范围；本 skill 只提供「静音 / 对白主导」。

## 实践要点（实战沉淀，务必遵守）
1. **参考图用「单视图」**：角色卡若为三视图（正/侧/背）直接作 `ref_nodes` 会导致生成画面出现多个角色副本；用**单视图角色卡**作参考。同角色不同着装状态（如「不穿 / 穿宇航服」）分别建单视图卡，按镜头状态选用。
2. **视频原生字幕**：对白字幕写进 `comfy_generate_video` 的 prompt 末尾——「画面底部居中显示一条清晰的中文对白字幕，字幕内容即台词文字本身（不加引号、书名号或括号）」，由视频模型端到端渲染（当前 H3 支持，不用 ffmpeg 后期叠加；若换不支持原生字幕的模型，改用后期叠加）。字幕偶有错字，逐镜复核。
3. **模式**：`mode=fast`（4步·Lightning LoRA）用于调试迭代；`mode=quality`（20步）用于成片。**分辨率按画布 `aspectRatio` 推导，两档均支持 16:9/9:16/1:1 等任意比例**（fast 默认 832×480，quality 默认 1344×768），不再写死 16:9。
4. **参考绑定**：起点/换场景镜用 `ref_nodes` 传【说话人角色卡 + 场景卡】；同场景续接镜（如 S03→S04、S05→S06）额外传上一镜末帧（`first_frame_node`）改善过渡。跨场景**不要**带上一镜末帧。
5. **音频**：视频自带声音（AV 模型），对白由 `[SPEAKER]` + `[NON_SPEAKERS_MOUTH:closed]` 约束口型（一镜一人）。

## 流水线（固定顺序）
0. **接收创意** → 会话开始先 `asset_list()` 查库；库非空则 `ask_user_question` 确认【复用范围】（列出库内资产，复用/全新/部分复用）。随后 `ask_user_question` 确认【画面比例 / 总时长 / 音频模式(silent|dialogue-led) / 生成模式(fast|quality)】，用 `canvas_set_state` 持久化。
1. **项目简报**（`canvas_write_node` text，group="story planning"）。
2. **故事大纲**（text，含音频脊柱图，group="story planning"）→ 选项卡批准。
3. **角色卡**（`comfy_generate_image`，group="character cards"，单视图正面全身，标注 speaks_on_screen）→ 选项卡锁定。生成前先 `asset_list(type=character)` 查库，命中则 `asset_to_canvas(id=资产 id)` 物化到画布；角色分状态分别建卡。新卡不自动入库——由用户在画布点「入库」按钮人工登记。
4. **场景卡**（`comfy_generate_image`，group="scene cards"，只环境不出现人物）→ 选项卡锁定。生成前先 `asset_list(type=scene)` 查库，命中则 `asset_to_canvas(id=资产 id)` 物化到画布；新卡由用户在画布点「入库」按钮人工登记。
5. **七列镜头表**（`canvas_write_node` kind=table，group="shot table"）：Shot ID & Duration / Continuity Handoff / Reference Anchors / Hook Type / Per-Second Directives / Audio & Dialogue Track(含 Mouth State) / Audio Mode。随后跑自检（hook 密度、单镜≤15s、单镜≤3 重要角色、空间锚点继承、每秒指令覆盖、跨镜连续、音频模式+口型安全）。详见 `references/shot-table-spec.md`。
6. **文本分镜**（`canvas_write_node` text，group="text storyboards"）：每镜一节，四象限每秒内容 + Mouth State + 双重绑定 `[char:][scene:][hook:][audio_mode:][speaker:]` → 选项卡批准。详见 `references/storyboard-guidelines.md`。
7. **单镜头视频**（`comfy_generate_video` 逐镜，group="shot clips"）：起点/换场景镜 `ref_nodes=[角色卡,场景卡]`；同场景续接镜 `ref_nodes=[角色卡,场景卡]` + `first_frame_node=上一镜末帧`。prompt 加音频前缀 `[AUDIO_MODE][SPEAKER][NON_SPEAKERS_MOUTH][SHOT_DURATION]` + 末尾视频原生字幕指令。按当前 `mode` 出片 → 片段批准卡。
8. **拼接 + BGM + 终检**（group="final delivery"）：按镜头表顺序拼接，跨场景溶解/同场景连续；终检（角色一致性、场景连续性、无分镜痕迹、口型/说话人硬卡、字幕正确、音频可听）。详见 `references/qc-checklist.md`。

## 门控纪律
所有批准/修订/模型/分辨率/继续/重做关口必须用 `ask_user_question` 选项卡（推荐项置首），不允许只用普通聊天让用户回复。

## 默认与失败梯度
默认由能力注册表 preferred 决定（当前：图片 flux-text2image，视频 minimax-h3-ref2v / minimax-h3-i2v）。用户明确要求换模型/换工作流时：先 `comfy_list_workflows` 核对能力，再 `comfy_render` 显式 `workflow`（或改 preferred 默认）。失败按梯度：重试一次（强化锚点/缩短措辞）→ 缩短时长/拆镜/降分辨率/简化动作 → 选项卡 → 占位跳过。不要重复提交未改动的请求。详见 `references/fallback-policy.md` 与 `references/model-selection.md`。

## 边界
不用于单图修图、真人写实、单条独立镜头；旁白主导不在本 skill 范围。
