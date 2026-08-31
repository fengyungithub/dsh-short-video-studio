# 插件产物 → H3 结构化 prompt 映射表（dsh-short-video-studio 适配层）

> 本文件是 `h3-prompt-writing` skill 的**插件适配层**（dsh-short-video-studio 自研），
> 把画布上的片型产物字段翻译为 H3 官方规范（`base-en.txt` / `ref-en.txt`）要求的结构化字段。
> 官方规范见同目录 `base-en.txt` / `ref-en.txt`（只读引用，勿改）。

## 0. 适用条件（条件启用）

本映射仅在以下条件**全部成立**时应用：

- 调用 `comfy_generate_video` / `comfy_render`，且解析后的工作流 id 前缀为 `minimax-h3-`（即 H3 系工作流，如 `minimax-h3-ref2v` / `minimax-h3-i2v`）；
- 参考图 / 首末帧来自画布节点或资产 id。

其他工作流（Wan / LTX / CogVideoX / SDXL…）**跳过本映射**，由片型 skill 直接自由格式组装 prompt（模型无关）。

## 1. 参考绑定镜（video.reference2video）→ Ref2VA 六段式

输出顺序（见 `ref-en.txt`）：`subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`。

| 插件产物 / prompt 元素 | H3 结构化去向 |
|---|---|
| 镜头表 `参考锚点.绑定`（角色卡 / 场景卡 id） | `subject_definitions` 中的 `<Subject N>`：从哪张参考图来 + 外观/环境特征。每个需要单独追踪的内容单元一条 |
| 镜头表 `参考锚点.固定地标 / 人物位置（机位视角） / 光位基线` | `subject_definitions`（环境/角色定义）+ `detailed_description` 各镜空间锚点描述；`retention_analysis` 标注 fully_preserved / partially_preserved / attribute_transfer / weak_reference |
| 镜头表 `镜头描述（每秒指令）` 四象限 | `detailed_description` 的 `[Shot N]` 分镜正文（景别、镜头运动、动作、空间位置、交接）。首个 `[Shot 1]` 无时间戳，后续用 `[Shot N] At MM:SS.mmm, ...` |
| 镜头表 `音频与对白轨.对白` | `detailed_description` 内说话人绑定 `(S1)/(S2)` + `<d>[语言] 台词</d>`。说话人 ID 按目标视频实际发声顺序分配、跨镜复用；`<Subject N> (Sx)` 说话时两者并用 |
| 镜头表 `音频与对白轨.口型` | `detailed_description` 显式写明「mouth-open: 说话人 / mouth-closed: 其余角色」；旁白用官方句式「says in an off-screen voiceover … while his lips remain completely closed」 |
| 镜头表 `音频与对白轨.音效` | `overall_soundscape`（环境音、物理音、非语言人声，1–4 句） |
| 项目简报 BGM 意图 / 情绪音乐 | `non_diegetic_music`（乐器、速度、节奏、动态；无则 `N/A`） |
| 镜头表 `字幕` 字段 | 对白进 `<d>`；**字幕在 `detailed_description` 的 `<d>` 对白附近以英文双引号 on-screen text 声明**（`a Chinese subtitle "字幕原文" is displayed centered at the bottom of the frame`），**不用末尾中文指令**（实测：六段式下末尾/内嵌中文指令均不烧录；英文 on-screen 声明 + quality 档正确烧录） |

## 2. 首末帧串联镜 / 转场镜（video.image2video）→ I2VA / FL2VA 三段式

输出顺序（见 `base-en.txt`）：对齐指令（首行，独占一段）→ `integrated_multimodal_description` → `overall_soundscape` → `non_diegetic_music`。

| 情况 | 对齐指令模板 |
|---|---|
| 只有首帧（I2VA） | `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.` |
| 首末帧都有（FL2VA） | `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.` |

- 首帧画面内容作为 `[Shot 1]` 的起点锚点，描述「先建立图中内容 → 动作推进 → 落点」；FL2VA 描述首末帧之间的连续运动路径，单镜为主。
- 转场镜：只写镜头运动与光线变化，**不写角色动作、不写对白**（对白语义已由片型 skill 的转场规则保证）。

## 3. 全格式通用规则

- 段落用英文书写；**对白 / 歌词 / 画面可见文字保留原语言**，对白放 `<d>[语言] …</d>` 内。
- 对白逐字保留（含标点），不翻译不改写；`<d>` 内只放语言标签与原文。
- 参考标签（`<Subject N>` / `<Picture N>` / `<Video N>` / `<Audio N>`）跨节保持一致，不重复定义。
- 景别、镜头运动（类型 + 幅度 + 速度）、口型纪律全部写进 `detailed_description` / `integrated_multimodal_description`，不留到字段外。
- 参考图硬规则不变：单视图、图内零文字、不拼图、多角度分别占不同 ref_nodes 槽位。

## 4. 与片型 skill 的边界（项目级后缀）

以下内容**不属于**本 skill 的输出，由片型 skill 在 H3 结构之后拼接：

1. **风格锁后缀**（视觉风格关键词串，随片型/项目走）；
2. **字幕声明**：不再用旧式末尾中文指令；字幕已由本 skill **内嵌在 `detailed_description` 对白处**（英文双引号 on-screen text 格式，见 §1 映射表）。片型 skill 仅需确保 quality 档成片；
3. **负向意图**（一句，写在文末，如「不要分镜线稿、不要标签水印、不要真人写实」）。

## 5. 实验结论（2025-08-31 已实测，见画布「A/B 实验结论」节点）

| 变体 | 档位 | 字幕写法 | 结果 |
|---|---|---|---|
| 旧自由格式 | fast | 末尾中文指令 | ✅ 正确 |
| 六段式 | fast/quality | 末尾中文指令 | ❌ 不烧 |
| 六段式 | fast | 内嵌英文 on-screen 声明 | ⚠️ 烧但错字（4 步字准差） |
| **六段式** | **quality** | **内嵌英文 on-screen 声明** | ✅ **正确（逐字一致）** |

**定稿规则**：

1. 六段式下字幕**必须**以英文双引号 on-screen text 声明内嵌 `detailed_description`（对白处），中文措辞指令（任何位置）不生效；
2. dialogue 镜成片用 **quality 档**保证字准；fast 档仅调试，字幕字准不可靠（调试可接受，或该镜回退旧格式）；
3. 口型安全 / 角色一致 / 环境一致 / 音频轨道六段式与旧格式同级，动作执行六段式略优 → 六段式可作为默认路径。
