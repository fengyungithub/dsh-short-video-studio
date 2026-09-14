# H3-Prompt-Writing 集成方案 v3（职能分离 + 官方命名）

> 状态：方案设计（待评审）
> 目标仓库：dsh-short-video-studio（本插件）
> 上游来源：[MiniMax-H3](https://github.com/MiniMax-AI/MiniMax-H3) 的 `skills/h3-prompt-writing`
> v2 变更：按「职能单一」原则重构——片型 skill 只规定流程，prompt 优化独立成专属 skill，片型 skill 在生成视频时**委托**它（v1 的方案 A/B 把映射与重写规则内嵌进 3D 动画 skill，职责混叠，已废弃）。
> v3 变更：命名用官方名 `h3-prompt-writing`（插件适配版 = 官方原样文件 + 适配追加节的**超集**），不再自造 `h3-prompt-refiner`——官方名在检索 / 评审 / 生态一致性上更优；同名冲突是低频且可解的工程细节（§4.2）。

---

## 1. 背景：为什么做这件事

MiniMax 官方 H3 系统 = **H3-Context-IR → H3-Base → H3-Regenerate-2K** 三段式。其中：

- **H3-Context-IR**（云端托管、不开源）负责把用户自由格式的多模态输入（文/图/音/参考视频）深度理解、跨模态关联、补全缺失语义，再序列化为 H3-Base 能直接读懂的结构化 prompt（基础模式三段式：`integrated_multimodal_description` / `overall_soundscape` / `non_diegetic_music`；全参考模式六段式：`subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music`）。
- 官方 README 明确：**「H3-Context-IR is critical to the quality of the final output」**，并给出两条路：① 调官方 IR API；② 按 **Prompting Guidance** 自建上下文处理系统。

本插件是**完全本地、零云端依赖**的产品：本地 ComfyUI 直接跑 H3-Base（`minimax-h3-ref2v-*` 工作流，prompt 注入 `MiniMaxH3ReferenceToVideo` 节点；分档后一个 json = 一个档位，由注册表按 `tier` 解析），**没有也不应引入云端 IR**。当前 prompt 由 agent 按 skill 规则手工拼自由格式自然语言——恰好是官方说「质量受影响」的形态。

**集成目标**：把官方 `h3-prompt-writing` skill 接进来，让本地生成走 H3 结构化 prompt，**用「本地 agent + 独立 prompt 优化 skill」复刻 Context-IR 的核心产物**，保住零云端依赖的同时尽量拉近与官方成片质量的差距。

---

## 2. 现状确认（注入点与改造边界）

| 项 | 现状 | 结论 |
|---|---|---|
| prompt 注入点 | `workflows/minimax-h3-ref2v-<tier>.json`（如 `-quality`）：`params.prompt → node "5" (MiniMaxH3ReferenceToVideo).prompt`，scalar 直通 | **工作流清单无需改动**，重写只发生在 agent 组装 prompt 那一刻 |
| 能力路径 | 参考绑定镜走 `video.reference2video`（Ref2V）；首末帧串联镜 / 转场镜走 `video.image2video`（I2V） | 主要需要 **ref-en.txt（六段式）** 与 **base-en.txt 的 I2VA / FL2VA 格式** |
| 现有 prompt 形态 | `[AUDIO_MODE:...][SPEAKER:...]` 前缀 + 分镜正文 + 风格锁 + 字幕指令 + 负向 | 需与 H3 官方格式**做映射**，见 §5 |
| 模型无关原则 | 插件不认识模型名，只认 capability | H3 结构化重写**必须条件启用**，换 Wan/LTX 等回到通用自然语言，见 §6 |

---

## 3. 设计决策（职能单一原则下的职责切分）

### 3.1 职责边界（核心）

| Skill / 组件 | 职责 | 不负责 |
|---|---|---|
| **片型 skill**（3d-animation-short-generator，未来的电商 / 课件…） | 规定**生成视频的流程规范**：简报 → 大纲 → 卡片 → 镜头表 → 分镜 → 逐镜生成 → 拼接 → 交付，以及门控、失败梯度、项目级后缀（风格锁、字幕指令、负向） | **不**内置任何 H3 字段 / 六段式 / `<d>` 细节 |
| **h3-prompt-writing**（官方名，插件适配版，prompt 优化专属） | **prompt 优化专属**：把「镜头表行 + 分镜章节 + 参考图绑定 + 音频模式」翻译为 H3 结构化 prompt（六段式 / 三段式 + 对齐指令 + `<d>` 对白），含产物字段映射表 | 不规定任何片型流程，不知道简报/卡片/门控是什么 |
| **hook 门**（`tools/pre-execute`，可选） | 校验 comfy_generate_video 的 prompt 是否符合 h3-prompt-writing 的输出契约，不符合 deny 引导 | 不写 prompt，不做内容级判断 |

**依赖方向（单向）**：片型 skill → 委托 h3-prompt-writing → 引用官方规范文件。任何一环不反向依赖。

### 3.2 为什么独立成 skill（v1 方案 A/B 被否的理由）

- **单一职责**：3D 动画 skill 改流程（加转场镜规则）不应牵连 prompt 优化；h3-prompt-writing 升级（官方规范更新、映射表改进）所有片型 skill 同时受益，一处维护多处生效。
- **多片型复用**：电商展示分镜、课件讲解分镜、剧情分镜都用同一套 H3 重写逻辑，不需要每个 skill 各抄一份。
- **可关停**：用户想关掉 H3 优化，覆盖 / 删除 `h3-prompt-writing` 的适配追加节即可，不碰片型 skill。
- **可替换**：未来有比官方 Prompting Guidance 更好的优化策略（或针对 Wan/LTX 的专用优化 skill），换成另一个 prompt skill 即可，片型 skill 的「委托」语句不变。

### 3.3 为什么用官方名（v3 决定）

- 检索 / 评审 / 生态一致：用户、文档、社区都认 `h3-prompt-writing`（`ltx-prompt-generator` 也是同类模式）；不引入自造词，少一次解释。
- 名字描述能力而非输入源：官方版输入是用户原始请求，插件版输入是画布镜头表/分镜——同一能力的适配超集，语义不冲突。
- 同名冲突（用户可能单独装过官方版）是**低频工程细节**，处理见 §4.2。

### 3.4 hook 门 vs 片型 skill

- 主路径 = 片型 skill 委托 h3-prompt-writing → agent **一次写对**；
- 兜底闸 = hook 门校验格式存在性 → 写错打回；
- hook 门**替代不了** h3-prompt-writing（只能查字段标题存在，查不了 `<d>` 对白、说话人 ID、口型纪律等内容正确性），且打回依赖 agent 能加载该 skill 规范——因此 hook 门是寄生增强，不是替代品。

---

## 4. 文件布局与命名冲突处理

### 4.1 文件布局（落地形态）

```text
skills/
├── 3d-animation-short-generator/
│   ├── SKILL.md              # 纯流程；Step 7「prompt 组装」改为委托 h3-prompt-writing
│   └── meta.yaml
└── h3-prompt-writing/        # 官方名；插件适配版 = 官方原样 + 适配追加节
    ├── SKILL.md              # 官方正文原样 + 末尾「插件对接」适配节（标注非官方原文）
    ├── meta.yaml             # description 含触发条件（官方语义 + 插件输入形态）
    └── references/
        ├── base-en.txt       # 官方原文，只读引用（来源/LICENSE 头注释）
        ├── ref-en.txt        # 官方原文，只读引用（来源/LICENSE 头注释）
        └── studio-mapping.md # 本仓库自研：插件产物字段 → H3 字段映射表（§5.2）
```

- 官方文件**原样复制**，不做本地化改写；插件自研内容（映射表、适配节）单独成文件/节，并在 SKILL.md 中显式标注。
- 官方文件头加注释块：`Source: github.com/MiniMax-AI/MiniMax-H3, skills/h3-prompt-writing, License: MiniMax H3 Community License`。

### 4.2 同名冲突处理（插件安装时）

`~/.dsh/skills/h3-prompt-writing` 已存在时，安装逻辑按来源区分：

1. **本插件安装过的**（目录带插件标记，如 `.dsh-studio-manifest`）→ 幂等更新；
2. **非本插件安装（官方版）** → **跳过并 warn**，提示：插件适配版未安装，可删除 `~/.dsh/skills/h3-prompt-writing` 后重装插件，或手动补入 `studio-mapping.md` 与适配节；
3. 全程**不覆盖用户对官方文件的修改**（沿用插件既有 skill 安装契约）。

---

## 5. h3-prompt-writing 设计（prompt 优化专属）

### 5.1 职责说明（SKILL.md「插件对接」适配节）

> 本 skill 把「镜头表行 + 分镜章节 + 参考图绑定 + 音频模式」重写为 MiniMax H3 能直接理解的结构化 prompt（本地复刻官方 H3-Context-IR 的核心产物）。完整书写规范见上方官方正文与 `references/`（官方原文）：
> - **参考绑定镜**（`ref_nodes`，无首末帧）→ 读 `ref-en.txt`，输出 **Ref2VA 六段式**：`subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`。
> - **首末帧串联镜 / 转场镜**（`first_frame_node` / `last_frame_node`）→ 读 `base-en.txt`，按 **I2VA**（只有首帧）或 **FL2VA**（首末帧都有）输出：对齐指令（首行）+ `integrated_multimodal_description` + `overall_soundscape` + `non_diegetic_music`。
> - 对齐指令按官方模板：I2VA 用「For the target video, at 0.00 seconds into the target video, \<Picture 1\> (from [Shot 1]) is fully referenced.」；FL2VA 用「How the reference pictures align with the target video — …」。
> - 全部段落用英文书写；对白原文（含中文）保留在 `<d>[语言] …</d>` 内。
> - **条件启用**：仅当当前 capability 的 `preferred` 工作流 id 前缀为 `minimax-h3-` 时应用本重写；其他工作流（Wan / LTX / CogVideoX…）跳过重写，由片型 skill 直接自由格式组装（模型无关）。

### 5.2 产物字段 → H3 字段映射表（`references/studio-mapping.md`，本仓库自研，核心）

| 插件产物 / prompt 元素 | H3 结构化去向 |
|---|---|
| 镜头表 `镜头描述（每秒指令）` 四象限 | `detailed_description` / `integrated_multimodal_description` 的 `[Shot N]` 分镜正文（景别、镜头运动、动作、空间位置、交接） |
| 镜头表 `音频与对白轨.对白`（说话人、语气、时间） | `detailed_description` 内说话人绑定 `(S1)/(S2)` + `<d>[语言] 台词</d>`；说话人 ID 按本镜/全片实际发声顺序分配 |
| 镜头表 `音频与对白轨.口型` | 在 `detailed_description` 中显式写明「mouth-open: 说话人 / mouth-closed: 其余角色」（对应官方「lips remain completely closed」纪律） |
| 镜头表 `音频与对白轨.音效` + `overall_soundscape` | `overall_soundscape`（环境音、物理音、非语言人声，1–4 句） |
| BGM 意图 / 项目简报的情绪音乐 | `non_diegetic_music`（乐器、速度、节奏、动态；无则 `N/A`） |
| 镜头表 `参考锚点`（地标 / 人物位置 / 光位） | `subject_definitions` 的 `<Subject N>`（角色/环境从哪张参考卡来）+ `detailed_description` 中的空间锚点描述；`retention_analysis` 标注 fully_preserved 等关系 |
| 角色卡 / 场景卡（ref_nodes） | `<Subject N>` 定义（外观/环境特征）+ 参考图在 `ref_nodes` 槽位；**单视图、零文字硬规则不变** |
| 镜头表 `字幕` 字段 | ① 对白进 `<d>`；② 字幕以英文双引号 on-screen text 声明**内嵌 `detailed_description` 对白处**（实验定稿，见 §5.4） |
| 现有 `[AUDIO_MODE:...][SPEAKER:...]` 前缀 | **不再作为前缀**；其语义（dialogue/silent、单说话人、非说话人闭嘴）已内化进 `detailed_description`；实验确认无副作用后移除 |

### 5.3 与片型 skill 的边界（项目级后缀留在片型 skill）

h3-prompt-writing 输出 **H3 结构核心**（六段式 / 三段式 + 对齐指令 + `<d>` 对白）；以下项目级/片型级内容由**片型 skill 在输出之后拼接**，不归 prompt skill：

- **风格锁后缀**（视觉风格是内容级决策，随片型/项目走）；
- **字幕**：字形声明由 h3-prompt-writing 输出（H3 路径内嵌正文对白处；自由格式路径紧随对白 / 文案句，同样不用末尾中文指令，见 §5.4 口径修正）；片型侧不追加任何末尾字幕指令；
- **负向意图**（一句，写在文末）。

### 5.4 实验结论 —— **实证矩阵的家（skill 里不存矩阵）**

> 口径（2026-09-14 定）：**规范（怎么写）在 skill，实证（谁能烧）在本文档 + 注册表**。实现会随 workflow JSON / 权重增删替换而变，把矩阵写进 skill 就是写死过时知识，故本矩阵只在此维护；skill 侧只保留「能力看实现、判定权在自检门、默认 quality」这条策略与本文档的入口。
> 画布对应节点：「A/B 实验结论」（T1–T4）、「PDD 字幕验证」（P1–P3）、「综合判断」「PDD 字幕验证结论」「P0 落地记录」。

**(a) 第一轮：字幕形态 × 档位（2025-08-31，A/B 完成）**

同一分镜（《小狐狸》S01 复刻，5s、seed=20240901、同 ref_nodes）：

| 变体 | 实现（当时档位） | 字幕写法 | 结果 |
|---|---|---|---|
| 旧自由格式 | lightx2v（`fast`） | 末尾中文指令 | ✅ 正确 |
| 六段式 | 任意实现（形态问题） | 末尾中文指令 | ❌ 不烧 |
| 六段式 | lightx2v（`fast`） | 内嵌英文 on-screen 声明 | ⚠️ 烧但错字 |
| 六段式 | **无蒸馏 base（`quality`）** | **内嵌英文 on-screen 声明** | ✅ **正确（逐字一致）** |

**(b) 第二轮：实现级矩阵（2026-09-14，`docs/minimax-h3-acceleration-lora.md` §9.9 的 PDD 落地后补测）**

同条件（同参考卡——本次为**同一张卡按原 prompt/seed 重生成，像素 diff 0.000**、同 seed、`1344×768`、`124 帧`、同 prompt「定稿写法」）：

| 实现 | 档位 · 步骤 | 字幕结果 |
|---|---|---|
| `minimax-h3-*-quality` | `quality` · 20 步 | ✅ 逐字一致 |
| `minimax-h3-ref2v-balanced-pdd` | `balanced` · PDD Acc-8Step nfe=8 | ✅ **逐字一致（n=3：2 seed 短句 + 15 字长句）** |
| `minimax-h3-*-balanced`（lightx2v 768p LoRA） | `balanced` · 8 步 | ❌ 整段未烧（2026-09-14 独立复现） |
| `minimax-h3-*-fast` | `fast` · 4 步 | ⚠️ 烧了但有错字 |

三条读法（**实证，不是规范**）：

1. **字幕能力是实现级属性**：同一 `balanced` 档，PDD 实现逐字烧、lightx2v 实现整段不烧 ⇒ 档位名不能作为判据；「某档整段未烧」这类结论必须绑定当时的实现。
2. **换实现不用改 prompt**：四条定稿写法与实现无关（同一份 prompt 在 `quality` 与 PDD 上都逐字烧出）。
3. **字幕出镜窗比声明短（模型级）**：只给结束点 `~4.0s` 时，PDD 与 `quality` 都在 **2–3s** 就消失（帧 84/108 无字幕）⇒ 排期按台词长度估。
4. 画面内英文标牌（`"Moon Base 7"`）在 `quality` 与 lightx2v `balanced` 都逐字一致（PDD 侧未测）——差异是「对白联动字幕」特有，不外推到所有画面内文字。

**规范侧**（写法四条、失败写法、容量阈值、档位 / 实现策略）以 `skills/h3-prompt-writing/SKILL.md`「字幕与画面内文案（唯一权威版）」为准，本节不复述。

**旧口径修正**：本文档 §5.3 与 §6 里「字幕由片型 skill 拼接 / 自由格式保留末尾中文指令」的表述已过时——字幕**声明**由 h3-prompt-writing 输出（H3 路径内嵌正文、自由格式紧随对白句），片型 skill 只负责镜头表数据、自检门与处置选项，不定义写法。

---

## 6. 片型 skill 的改动（最小化：只加委托，不加实现）

`3d-animation-short-generator/SKILL.md` 的 Step 7「prompt 组装」改为：

> 1. 取本镜分镜章节（已抽取的镜从独立节点）内容与镜头表 `参考锚点` / `音频与对白轨` 行。
> 2. **调用 skill 工具加载 `h3-prompt-writing`**，按它的规范把分镜内容重写为 H3 结构化 prompt（skill 内部读官方正文与 `references/studio-mapping.md` 映射表）。
> 3. 在 h3-prompt-writing 输出之后拼接片型级后缀：风格锁 → 负向意图（**字幕 / 画面内文案的写法完全归 h3-prompt-writing**，片型侧不追加任何字幕指令、不复述限定词、不定义档位 / 实现策略，只提供镜头表 `字幕` / `画面文案` 数据与逐镜自检门——见 §5.4 口径修正）。
> 4. `length` 按 24fps 帧数（124 ≈ 5s）换算；片段写入 group `shot clips`。

- 其余流程（门控、参考绑定策略、失败回退、转场镜、拼接、终检）**完全不动**。
- 未来电商 / 课件 skill 在生成视频环节写同一句委托，即获得相同优化。

---

## 7. hook 门（可选，兜底闸）——基于 `tools/pre-execute`

宿主工具调度器对每个工具调用执行前都过 `tools/pre-execute` waterfall（`dsh-tools` 已确认；本插件已有先例：pre-ask 自动送达用的就是它）。监听器返回 `{kind:"allow"}` 放行、`{kind:"deny", reason}` 物化为 `Error: <reason>` 返回 agent。

- **校验依据**：h3-prompt-writing 的输出契约（六段式 / 三段式字段存在性），与片型 skill 无关。
- **逻辑**：
  - 工作流不是 `minimax-h3-*` → allow（模型无关）；
  - 是 H3 且 prompt 含完整结构字段 → allow；
  - 缺字段 → deny，reason 明确列出缺失字段与修复指引（「请加载 h3-prompt-writing 并按六段式重写」）。
- **防死循环**：按 agent 会话记连续 deny 次数，≥ N 次（建议 2）后降级为 allow + 在画布节点 / 工具结果注记警告，避免 agent 反复撞墙烧 token。
- **不做**：不直接改写 `exec.arguments.prompt`（waterfall 语义是门禁非变换，无契约保证）；不调云端 IR API（违背零云端依赖）。

---

## 8. 实施步骤（评审通过后执行）

1. **拷贝官方规范**：`skills/h3-prompt-writing/references/` 放入官方 `base-en.txt`、`ref-en.txt`（带来源/LICENSE 头注释）；SKILL.md 以官方原文为基底。
2. **编写插件适配层**：SKILL.md 末尾追加「插件对接」适配节（§5.1 职责 + §5.4 实验结论 + 条件启用）+ `references/studio-mapping.md`（§5.2 映射表）+ `meta.yaml`（description 含触发条件）。
3. **改造 3d-animation-short-generator**：Step 7「prompt 组装」改为委托式（§6），其余不动。
4. **安装冲突处理**：lib/index.js 的 skill 安装逻辑加 §4.2 同名来源检测（插件标记 / 跳过提示）。
5. **小规模实验**：取现有《小狐狸》S01 同分镜做 A/B（§5.4），记录结果。
6. **hook 门（可选）**：lib/index.js 注册 `tools/pre-execute` 监听器，按 §7 逻辑实现校验与降级；含单元测试。
7. **README 增补**：说明「H3 结构化 prompt（本地版 Context-IR 替代）」已启用、如何关闭（删适配节 / 覆盖 skill）；更新实战要点。
8. **回归**：跑通一次完整 3D 动画流程（fast 档）验证端到端不破坏现有门控。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 字幕烧录依赖 prompt 形态与档位（六段式须内嵌 on-screen 声明 + quality） | §5.4 实验已定稿；dialogue 镜 quality 成片，fast 仅调试 |
| 说话人 (Sx) 分配出错导致对白错位 | 映射表强制「按实际发声顺序分配、跨镜复用」，纳入 skill 自检 |
| 片型 skill 漏委托 / 用户覆盖掉 prompt skill | hook 门兜底（deny 引导 + 降级上限） |
| 官方规范文件更新后本地副本过期 | 副本带来源链接与版本日期；用户可自行替换 |
| 其他模型被误套 H3 格式 | 条件启用（仅 `minimax-h3-*` 工作流）+ hook 门同规则 |
| skill 间委托链断裂（agent 不加载 prompt skill） | 片型 skill 显式写出「调用 skill 工具加载 h3-prompt-writing」，并列入 Step 7 门控自检 |
| 用户已装官方版导致同名冲突 | §4.2 安装检测：跳过 + warn + 手动合并指引 |
