---
name: short-drama-series-production
description: |
  微短剧整部量产的**制片总控**（默认 90 秒/集、竖屏 9:16、中文、无画面内字幕、balanced 档）。**不拍片、不写剧本**：剧本交给 `short-drama-series-writer`，单集拍摄委托 `story-short-generator` 的 STEP 3–8。本 skill 负责系列圣经、分集目录、资产与声线台账、集制作包（唯一交接物：6 节 + 8 列镜头意图 + 资产清单 + 生产参数预填）、每集状态与成本台账、样片集闸门、跨集一致性抽查、每集与整季交付。触发词：整部短剧、短剧量产、分集制片、第 N 集、样片集、继续拍下一集、已有分集剧本要拍出来。

  默认片型：50–100 集 × 90 秒，9:16，中文，无画面内字幕，balanced，角色卡单视图，batch 审查。**不是** Hub 的 `short-drama-production`；不适用于单片故事短片（→ `story-short-generator`）、单条独立镜头、纯剧本创作（→ writer）。
whenToUse: |
  用户要把一部短剧**从剧本做成整部成片**（多集、量产、分集、第 N 集、样片集、继续拍下一集），或已有分集剧本要「拍出来」。若用户只要剧本/大纲/爽点/付费卡点，交给 short-drama-series-writer；若只做一条单片或单场景，交给 story-short-generator。
---

# 短剧系列制片（dsh-short-video-studio 适配版）

本 skill 是**总控**：管「拍什么」（系列圣经 / 分集剧本 / 集制作包 / 资产台账 / 成本闸门 / 集进度）。
**「怎么拍」全部委托 `story-short-generator`**（角色卡、七列镜头表、分镜、逐镜生成、续接链、门 3 自检、拼接、终检），本 skill **不复述、不改写**它的硬规则。

一句话流程：

```
series-writer 剧本（文件）
  → 集制作包（本 skill：8 列镜头意图 + 资产清单 + 预填参数）
  → story-short-generator STEP 3–8（画布：卡片 → 镜头表 → 分镜 → 片段 → 成片）
  → 每集交付包 + 成本台账 + 下一集
```

参考图硬规则（图内零文字 / 不拼图）、双版本角色卡、三档同文提示词库、续接链硬约束；入库规则是「单项目用户点入库；系列 G-A 批准后 AI 可 asset_ingest」——**全部由插件契约与 `story-short-generator` 定义，本文不复述**。

---

## 0. 三个 skill 的分工（先读，决定路由）

| 触发 | 用哪个 | 产出 |
|---|---|---|
| 要**剧本**：题材/大纲/人物/分集目录/爽点/卡点/合规/出海 | `short-drama-series-writer` | 文件（`creative-plan.md` / `characters.md` / `episode-directory.md` / `episodes/epNNN.md`） |
| 要**整部成片**：分集拍摄、量产、第 N 集、样片集、继续拍 | **本 skill** | 系列圣经 + 集制作包 + 每集成片 + 交付包 |
| 要**单片/单场景**：一条 30–180s 的完整短片 | `story-short-generator` | 单项目画布全套 |

**路由规则**（开场第一条就判）：

1. **没有已批准的分集剧本** → 加载 `short-drama-series-writer`，跑它的**完整剧本流水**，不是只让它出大纲：
   - A 段（本 skill 阶段 A 内）：`/start` → `/plan` → `/characters` → `/outline`（先有分集目录）；
   - B 段（本 skill 阶段 B 内）：`/episode 1-10` → `/review N`，前 10 集优先；
   - 只有零散剧本、缺人物/目录 → 先让 writer 补齐 `/characters` / `/outline`，不要 production 自造设定；
   - writer 未安装/加载失败 → **停线告知用户**；**本 skill 不代写剧本、不改台词**。
2. 只有一句话创意、目标是一条片子 → 转 `story-short-generator`，不要用本 skill。
3. 有分集剧本、目标是多集成片 → 本 skill。
4. **由 `story-short-generator` 的门 0 转入**（它查到系列上下文，或用户选了「连续短剧」）时：story **必须立即停止提问**，本 skill 接住；**不再重复问片型**，直接接住剧本/集制作包（没有就按本 skill 阶段 A/B 产出），完成后交回它做单集生产。
5. **story 侧探测规则**：有系列上下文 → 直接委托模式、不弹片型门；完全没有上下文才问。本 skill 不依赖用户是否提到「短剧」。

> 推荐基线（**S-STEP 0 可改，不是写死**）：**整部量产 · 80–110s/集（默认 90s）· 中文 · 无画面内字幕 · balanced**。S-STEP 0 选定后写进系列圣经，全季不逐集重问；改规格按「切换成本」处理。

### 0.1 职责边界（RACI，先看这张表）

| 事项 | Owner | 明确不做 |
|---|---|---|
| 系列圣经 / 分集目录 / 资产台账 / 集进度 / 成本 / 交付治理 | **production** | 不写剧本、不定义拍摄规则 |
| 剧本题材 / 场次 / 逐字台词 / 钩子 / 卡点 | **writer** | 不写镜头表 / 分镜 / 角色卡 |
| 集制作包（6 节 + 8 列镜头意图 + 资产清单 + 预填参数） | **production** | 不写每秒指令 / 参考锚点 / 口型 |
| 角色卡 / 场景卡 / 道具卡 / 声线试镜节点 / 镜头表 / 分镜 / 提示词库 / 逐镜 / 拼接 / AI 自检 | **story-short-generator** | 不写系列台账 / 资产库 / 成本模型 |
| 资产入库（asset_ingest）/ 台账 / 状态 / 成本 / 交付包 | **production** | **不调用任何图片/视频生成工具** |
| 每集 3 张人工卡（方案 / 片段 / 交付） | **production** | story 只做 AI 自检与异常门，不重复弹卡 |
| 单镜失败重试 / 计划内微调 | **story 执行** | production 只记录成本/门，不改拍摄规则 |

一句话：**production 管「拍什么、用哪些资产、花多少、到哪了、谁批准」；story 管「怎么拍、每镜怎么生成、AI 自检过不过」。**

---

## 1. 本片型参数（S-STEP 0 一次选定；默认只是推荐）

| 参数 | 推荐默认（可改） | 说明 / 代价 |
|---|---|---|
| 画幅 | `9:16` 竖屏 | 画布 `aspectRatio=9:16`；场景卡跟随；角色卡**三视图 16:9 + 单视图取正面格（≈0.59）**（尺寸由图片档位决定，见 §6.1） |
| 单集时长 | **目标 80–110s（默认 90s）** | 由对白反推：`时长 ≈ 台词字数 ÷ 4 字/秒 + 0.5–1s 反应尾`；≈ 17–20 个 124 帧镜。超出区间先砍台词 / 拆镜，**不压语速**；单集例外必须写入集制作包 ① 与 state 的 `episodeSecondsException` |
| 音频模式 | `dialogue-led` | 对白主导；`silent` 仅纯画面 + SFX（短剧一般不用） |
| 集数 | 用户指定（50–100） | 分集目录为准；本 skill 按集推进 |
| 语言 | 中文 | 台词逐字进镜头表 `对白` 与 `字幕` 字段（字幕列全 `none`） |
| 画面内字幕 | **不要（`none`）** | 全表 `字幕` 列写 `none`；逐镜 prompt 负向尾句加 `no subtitle, no burned-in dialogue text`；**不写任何字幕声明** |
| 视频档位 | **`balanced`** | 9:16 交付 **768×1344 ≈ 1.03MP**（长边 1344）；实测约 166s/镜 |
| 图片档位 | `balanced` | 卡片是全程复用的锚点；≈6s/张；需要更高细节时再选 `quality`（≈45s/张） |
| 角色卡引用版本 | `single`（竖屏默认） | `three` 在 9:16 下**未实测**；要试就只在样片集试，别整季混用 |
| 片段审查节奏 | `batch` | 量产默认全部渲完一次确认；口型/一致性不过关仍**当场**弹单镜处置卡 |
| 声线方案 | **`existing`**（阶段 C 一次性建立） | 有对白角色在阶段 C 做一次试镜 / 复用 `voice:`，全季复用；`text-only` 仅作降级，交付清单必须记「跨集音色无保证」。无 state 字段，写进系列圣经与集制作包 ⑥ |
| 每集场景数 | **1–2 个物理场景** | 上游「每集 3–5 场」必须压缩：同一物理场景的多次换景算 1 场；**跨场景每个边界要 1 个转场镜**（占 1 镜预算） |
| 交付画质 | **先原生，样片后定** | 原生 768×1344；要 1080×1920 只能**逐镜超分**（9:16 不支持生成内放大），+≈78 min/集；要 **2K 纹理/小字**可走**逐镜重生成**（`regen2k`，9:16 交付 **1440×2560**，+≈150 min/集，**会重画内容**、要求每镜 ≥124 帧 24fps）；**48fps 只能逐镜补帧**（成片不补），+≈3 min/集，见 §9 |
| 视觉风格 | `cinematic-live-action` | 真人写实最适合国内竖屏短剧；由用户最终确认（7 选 1，见 story skill） |

**开场必须用 `canvas_set_state` 一次写全**（主会话与每集会话各写一次；下面是**示例**，实际值按 S-STEP 0 结果填）：

```
aspectRatio=9:16
duration=90 秒（默认；按包 ① 目标 80–110s 调整）
audioMode=dialogue-led
mode=balanced
characterCardVariant=single
reviewMode=batch
shotGate=verdict        # 逐镜自检门：默认开启；off=关闭，frames=只要求抽帧
groupOrder=[主会话] 或 [story skill 的十个分组（含 voice auditions）]
# 声线方案无 state 字段：existing（阶段 C 建）/ text-only（降级），写进系列圣经与集制作包 ⑥
```

**切换成本**：改画幅 / 改档位 / 改字幕开关 = 已产集作废、需重渲；改风格 = 全部卡片与片段作废。逐项都要显式确认，不许静默改。

### 1.1 S-STEP 0：系列规格卡（一次，默认不跳过）

**表里的默认值只是推荐，不是写死。** 开场用**一张「系列规格卡」**让用户逐项选（可一次全选推荐，也可改单项）；选完才写系列圣经 §1 + `canvas_set_state` + `production-state.series`，再进 G-S。

| 项 | 可选值（推荐在前） | 选择后的影响 |
|---|---|---|
| 画幅 | `9:16` / `16:9` / `1:1` | 改 = 全部卡片与片段重做 |
| 单集时长 | `90s` / `80s` / `100s` / `110s` / 自定义 | 改 = 镜头预算/成本重算；例外写 `episodeSecondsException` |
| 音频模式 | `dialogue-led` / `silent` | `silent` 无对白/声线；短剧一般不用 |
| 视频档位 `tier` | `balanced` / `quality` / `fast` | `fast` 只能单视图、G-ref 生效；`quality` 成本约 2.4× |
| 图片档位 `imageTier` | `balanced` / `quality` / `fast` | 卡片复用锚点；`quality` ≈7× 耗时 |
| 画面内字幕 `subtitles` | `none` / `burned-in` | `burned-in` 需逐镜烧字，实测要 `quality` 才稳；成本上升 |
| BGM 模式 `bgmMode` | `none` / `in-model`（本期） | `in-model`=H3 逐镜自带 BGM，烘进片段；不可单独替换/duck，硬切可能换曲。`separate`（Music 3）下一期 |
| 角色卡版本 `characterCardVariant` | `single` / `three`（仅 balanced/quality） | 9:16 下 three 未实测；切换 = 已产集重渲 |
| 片段审查 `reviewMode` | `batch` / `per-shot` | per-shot 每镜一张卡，人力 ×N |
| 逐镜自检门 `shotGate` | `verdict`（默认，每镜必须记录 pass）/ `frames`（只抽帧）/ `off`（关闭） | 关闭 = 坏镜头晚发现、返工成串；量产建议保持 `verdict` |
| 声线方案 `voicePlan` | `existing`（复用/缺的补建，推荐）/ `audition`（全部重新试镜）/ `text-only` | text-only 无音色锚点，交付记风险；audition = 新季换声/重做声线 |
| 交付画质 `delivery` | `native` / `upscale1080` / `upscale2k` / `upscale4k` / `regen2k` / `fps48` | 超分 ≈+78 min/集（1080）；**重生成 `regen2k` ≈+150 min/集（1440×2560，会重画内容）**；补帧 48fps ≈+3 min/集；**整季同一路线，不混**（尺寸/观感必须一致） |
| 视觉风格 | `cinematic-live-action` / 其余 6 套 | 改 = 全部卡片与片段作废 |
| 语言 / 出海 | 中文 / English（出海） | 英文台词+字幕未实测，先 1 镜验证 |

**S-STEP 0 提交方式：先给 4 个套餐，再允许逐项微调**（不许静默按默认通过；用户说“按默认”也要回显规格卡确认）：

| 套餐 | 内容 | 适合 |
|---|---|---|
| **A · 原生量产（推荐）** | 9:16 / 90s / dialogue-led / `balanced` / `balanced` / `single` / `batch` / `verdict` / 字幕 `none` / 声线 `existing` / 交付 `native` / `cinematic-live-action` / 中文 | 先跑通整季；后续要更大尺寸再逐镜超分（不断链） |
| **B · 1080 精修** | 同 A，`delivery=upscale1080`（逐镜超分，+≈78 min/集） | 平台要 1080×1920 交付 |
| **C · 高画质** | 同 A，`tier=quality`（≈2.4× 成本，80 集约 223 GPU 小时） | 样片集 / 预算充足的重点集 |
| **D · 2K 重生成** | 同 A，`delivery=regen2k`（逐镜重生成到 1440×2560，+≈150 min/集，≈3.2× 原生） | 平台/投放要 2K 竖屏，且画面要有纹理/小字/材质细节；**接受重画内容**、镜头表每镜 ≥124 帧 |

**微调入口**：选中套餐后，下面四组仍可改单项（改任意一项 → 回本卡重选，并按「切换成本」处理已产集）：

1. **画面 / 时长**：`9:16`（推荐）/ `16:9` / `1:1`；`90s`（推荐）/ `80s` / `100s` / `110s` / 自定义。
2. **画质 / 成本**：视频 `tier` = `balanced`（推荐）/ `quality` / `fast`；图片 `imageTier` = `balanced`（推荐）/ `quality` / `fast`；交付 `delivery` = `native`（推荐）/ `upscale1080` / `upscale2k` / `upscale4k` / **`regen2k`（逐镜重生成，+≈150 min/集，会重画内容）** / `fps48`（逐镜补帧，+≈3 min/集）；字幕 `subtitles` = `none`（推荐）/ `burned-in`；BGM `bgmMode` = `none`（默认）/ `in-model`（H3 逐镜自带，本期）。
3. **资产 / 声音**：角色卡 `characterCardVariant` = `single`（推荐）/ `three`（仅 balanced/quality）；声线 `voicePlan` = `existing`（推荐，阶段 C 复用/缺的补建）/ `audition`（强制每个说话角色重新试镜）/ `text-only`（降级）。
4. **审查 / 自检 / 风格**：`reviewMode` = `batch`（推荐）/ `per-shot`；**逐镜自检门 `shotGate` = `verdict`（推荐，默认）/ `frames` / `off`**；视觉风格 7 选 1；语言中文 / English（出海，先 1 镜验证）。

**规格卡还要写**：预计单集成本、整季成本、样片集是否先做。

> **写入位置**：系列圣经 §1 + `production-state.series` + 主会话 `canvas_set_state`（只有 state 字段的项）；`imageTier` / `subtitles` / `delivery` / `voicePlan` / `style` 无 state 字段，必须写圣经与本卡。E-STEP 0 只读校验，不再问。

### 1.1 覆盖 / 沿用表（与上下游冲突时以本表为准）

| 项 | 上游 / 下游口径 | 本片型 | 性质 |
|---|---|---|---|
| 单集时长 | WRI 旧稿可能仍写 1–3 分钟 / 120s | **80–110s（默认 90s）**，由对白字数反推 | **覆盖** |
| 镜数 | 旧稿可能写 12 / 15–20 镜 | 17–20 镜典型；对白密集可 24–26（T ≤110s） | **覆盖** |
| 对白句数 | 旧稿可能写 18–25 句 | ≤ 对白镜数；按台词字数反推 | **覆盖** |
| 场次 | WRI 的 3–5 个戏剧场次 | 压缩到 1–2 个**物理场景** | **覆盖** |
| 画面内字幕 | SSG 默认 `burned-in` | `none` | **覆盖** |
| 角色卡引用版本 | SSG 非 fast 推荐 `three` | 9:16 默认 `single`（three 未实测） | **覆盖** |
| 转场镜档位 | SSG 旧文写"成片 quality" | 与正片同档（`balanced`） | **覆盖** |
| 一镜一说话人 / ≤15s/镜 / ≤3 重要角色 | SSG | 同 | **沿用，不可覆盖** |
| 续接链 / G-ref / 门 3 AI 自检 | SSG | 同 | **沿用，不可覆盖** |
| 角色卡双版 / 场景单视图 / 道具单视图 | SSG | 同 | **沿用** |
| 试产/干跑档位 | 整季锁 `balanced` | **干跑可用 `fast`（非交付档）**：必须在 `production-state.series` 记 `dryRun: true`，成片不得与该季交付集混拼 | **例外（仅试产）** |

> WRI 从 P1 起已收缩为纯剧本（不再写镜数 / 句数 / 分镜），本表用于防止旧稿与旧文档残留口径回灌。

---

## 2. 阶段总览

| 阶段 | 在哪 | 产物 | 门 |
|---|---|---|---|
| A 立项与系列圣经 | 主会话 | 系列圣经 + 分集目录 + `production-state.json` | **G-S**（圣经/目录/参数） |
| B 剧本流水 | 主会话 | `episodes/epNNN.md`（前 10 集优先，之后领先影像 5–10 集） | **G-B**（每批剧本） |
| C 资产锁定 | **EP01 会话（首个集会话）** | 角色双版本卡 + 状态卡 + 场景卡 + 道具卡 + **声线试镜 / 复用** + 资产台账 | **G-A**（一次批准，跨集复用） |
| D 样片集 | EP01 会话 | 第 1 集成片 + 一致性基线 + 声线听核矩阵 | **G-SAMPLE**（决定整季档位/超分/是否放开 three） |
| E 量产 | 每集一个会话 | 每集成片 + 交付包 + 成本台账 | **G-E**（每集 3 张卡：方案 / 片段 / 交付） |
| F 收尾 | 主会话 | 整季交付清单 + 成本复盘 + 重渲记录 | **G-F** |

**顺序硬约束**：A → B（至少前 1 集）→ C → D → E。**不允许**在 C 之前开渲片段（否则身份锚点会变，全部返工）。

---

## 3. 会话模型、状态与画布分组

### 3.1 会话模型（量产的关键）

- **主会话 1 个**：系列圣经、分集目录、资产台账、集进度、成本记录。**不渲片段**。
- **每集一个会话**：该集全部生产节点（卡片物化 / 镜头表 / 分镜 / 提示词库 / 片段 / 成片）。一期一会话，避免画布爆炸与上下文漂移。
- 跨会话只靠两样东西：**`series/` 目录**（文件权威）+ **资产库**（身份/环境权威）。

### 3.2 目录与状态

**集号格式（全项目统一）**：`EP001`（画面标题）/ `ep001`（文件与目录）/ `episodes["ep001"]`（state 键）；一律**三位补零**，禁止 `ep01` / `EP003` 混用。下文 `epNNN` 均指三位补零。

```
{项目目录}/
├── creative-plan.md / characters.md / episode-directory.md   # series-writer 产出，原样保留
├── episodes/epNNN.md                                          # 分集剧本（series-writer）
├── export/                                                    # series-writer 的导出（可选）
└── series/
    ├── bible.md                    # 系列圣经（本 skill）
    ├── production-state.json       # 集进度/资产台账/成本（本 skill，机读）
    ├── episodes/epNNN/package.md   # 集制作包（本 skill，唯一交接物）
    └── delivery/epNNN/             # 每集交付包（成片路径/清单/配乐点单）
```

`stage` 七态语义：`script`（剧本就绪）→ `package`（包就绪）→ `assets`（卡物化）→ `shotlist`（镜头表 + 分镜已批准）→ `clips`（片段渲完 + 片段卡批准）→ **`final`（已拼接、交付卡待批）** → `delivered`（交付卡已批准）。

`production-state.json` 草案（每次推进都更新，**先写文件再回复用户**）：

```json
{
  "series": { "title": "", "episodes": 80, "episodeSeconds": 90,
              "episodeSecondsRange": [80, 110],
              "episodeSecondsException": { "ep001": 105.8 },
              "mode": "domestic",
              "aspectRatio": "9:16", "style": "cinematic-live-action",
              "audioMode": "dialogue-led", "tier": "balanced", "imageTier": "balanced",
              "subtitles": "none", "delivery": "native|upscale1080|regen2k|fps48",
              "characterCardVariant": "single", "reviewMode": "batch", "shotGate": "verdict",
              "voicePlan": "audition|existing|text-only", "bgmMode": "none|in-model", "packageContract": "episode-package/v1", "assetMode": "library" },
  "assets": {
    "characters": [{ "name": "林晚",
                     "states": [{ "state": "常服", "assetIdSingle": "character:…", "assetIdThree": "character:…",
                                  "version": 1, "status": "locked", "episodes": "1-20" }] }],
    "scenes": [{ "name": "总裁办公室", "assetId": "scene:…", "landmarks": ["door-frame:右1/3"],
                 "lightBaseline": "冷白顶光", "version": 1, "status": "locked" }],
    "props":  [{ "name": "离婚协议", "assetId": "scene:prop-…", "version": 1, "status": "locked", "episodes": "3-12" }],
    "voices": [{ "character": "林晚", "voiceAssetId": "voice:…", "source": "audition",
                 "version": 1, "status": "locked", "episodes": "1-60" }]
  },
  "episodes": {
    "ep001": { "stage": "script|package|assets|shotlist|clips|final|delivered",
              "package": "series/episodes/ep001/package.md", "shots": 18,
              "scriptVersion": 1, "packageVersion": 1, "episodeVersion": 1,
              "changeRequest": null,
              "doneShots": ["S01","S02"], "clipNodeIds": [], "finalNodeId": "",
              "costMinutes": 0,
              "gate": {
                "package": { "status": "pending|approved|rejected", "at": "" },
                "clips":   { "status": "pending|approved|rejected", "at": "" },
                "delivery":{ "status": "pending|approved|rejected", "at": "" }
              },
              "delivery": "" }
  },
  "next": "ep002/package"
}
```

### 3.3 画布分组（两套，按会话用）

- **主会话**：`canvas_set_state(groupOrder=["series bible","episode plan","production ledger","series delivery"])`
  - `series bible`（圣经 + 资产台账）· `episode plan`（分集目录 + 集制作包索引）· `production ledger`（集进度/成本表）· `series delivery`（整季交付清单）
- **每集会话**：用 `story-short-generator` 的十个分组
  `["story planning","character cards","voice auditions","scene cards","prop cards","shot table","text storyboards","shot prompts","shot clips","final delivery"]`
  - 集制作包文本节点放 `story planning`（与它的简报/大纲同组，避免新增未声明分组）。
  - **`groupOrder` 以 story skill 的十个分组为准**，本 skill 不再自写一套；每集开场由本 skill 写入一次，story 进入时只校验不自写。

---

## 4. 阶段 A：立项与系列圣经（门 G-S）

1. **S-STEP 0 系列规格卡（§1.1）**：逐项选（默认只是推荐），写系列圣经 §1 / state / 规格卡；**不默认跳过**。
2. 没有剧本 → 加载 `short-drama-series-writer`，跑 A 段 `/start` → `/plan` → `/characters` → `/outline`（**它的 references 按阶段读，不要一次全读**）；**writer 的 A 段只做剧本/目录；系列圣经仍由本 skill 第 3 步写，制作包在阶段 B 写**。
3. 写 `series/bible.md`，同时落主会话文本节点（group `series bible`）。必须包含：
   - 一句话故事 + 三幕结构（集数范围）+ 全剧节奏波形（高潮/低谷/卡点位置）
   - 人物关系图 + 每个主要角色的**视觉锚点**（脸/发型/身材/服饰主色/签名道具/不可改特征）与**状态卡需求**（哪几段会有换装/受伤/年龄跨度）
   - 场景清单（名称/内外景/日夜/连续性地标/光位基线）+ 道具清单（签名道具）
   - **声线清单**：哪些角色说话、库内已有 `voice:` 资产、缺哪些（阶段 C 补）
   - 付费卡点集清单（8–12% / 18–25% / 35–45% / 末 3–5 集）+ 每集钩子类型规划
   - 版式：9:16 · **目标 80–110s（默认 90s）· 17–20 镜** · 每集 1–2 个物理场景
   - 合规基调（series-writer 的 compliance 清单要点）
4. 初始化 `series/production-state.json`，写主会话 `production ledger` 表头。
5. **门 G-S**（`ask_user_question`）：批准圣经并开始剧本（推荐）/ 回 S-STEP 0 改规格 / 调整卡点与钩子规划 / 先看前 10 集分集目录。

> 圣经是**唯一真相**：后续每集只引用它，不在每集重问参数。

---

## 5. 阶段 B：剧本流水（门 G-B）

- **前 10 集优先**：投流与样片都在这一批；写满 10 集就停下来做样片，不要一口气写 80 集。
- 之后按批写（每批 5–10 集），**剧本领先影像 5–10 集**，用生产反馈修正后续剧本（避免成片暴露的问题在全季重复）。
- B 段仍由 **writer** 写：批量入口 `/episode 1-10`（支持区间）；每集完跑 `/review N`，不过关先改再进（它的 45/50 分线）。**production 只接收场次/逐字台词/钩子，不代写。**
- **每集只落到本 skill 需要的三件事**：场次（压缩到 1–2 个物理场景）、逐字台词、集尾钩子 + 下集回应。
- **门 G-B**：每批剧本批准（沿用 series-writer 的输出，不再重复问创作取向）。

---

## 6. 阶段 C：资产锁定（门 G-A，一次性）

**目标**：全季身份与环境**只建一次**，之后每集只做「物化 + 复刻」，不重画。

**在哪做**：**EP01 会话（首个集会话）**——该会话已声明 story 的十个分组，卡片与 `voice auditions` 都有落点。主会话只保留圣经 / 目录 / 台账，**不建卡**（否则节点会掉进未声明分组）。

> **分工（必须照做）**：本阶段 = **本 skill 主持 + 委托 `story-short-generator` 执行生成与 AI 自检**（STEP 3 角色卡 / 3.5 声线 / 4 场景卡 / 4.5 道具卡；人工锁卡并入 G-A 一张卡）。本 skill 只负责：资产清单、资产总览卡、入库清单、`asset_ingest`、台账。**本 skill 全程不调用任何图片 / 视频生成工具。**
>
> 委托时**必须**声明两句，否则会死循环：①「本会话为**阶段 C 资产建卡**」；②「**跳过门 0 与 E-STEP 0**，不建本集镜头表、不弹规格卡」。原因：此时 EP01 的 `package.md` 还没建，story 的入口探测会判「有圣经缺本集包」→ 反过来加载本 skill 补包 ⇒ `PROD → SSG → PROD` 循环。

### 6.1 角色

- 每个角色**两版**都建：先出 `three` 三视图 16:9 横排，再 `image_crop` 裁正面格当 `single`（同源像素、身份按构造一致），`character` / `card_variant` / `paired_node_id` 配对——即使视频只用 `single`，两版也要齐（换档/试三视图时不用返工）。单视图尺寸 = 正面格（`balanced` 448×768 / `quality` 682×1152），不再是 2:3。
- **状态卡**：只有「持续 ≥3 镜或跨 ≥2 集」的变化才建（换装/受伤等级/妆发/年龄跨度）。每状态一对卡，标题「角色名 + 状态 + 版本」；只持续 1–2 镜的变化写进镜头 prompt，不建卡。
- **入库**：阶段 C 的**资产总览卡**审核通过后，由 production 写「资产入库清单（已批准）」并调用 `asset_ingest`（**系列模式例外**；未批准不得入库）。**一次集中入库**，之后每集 `asset_list` 直接引用资产 id。资产 id 永久不变，改名不影响引用。单项目/未批准场景仍由用户点「入库」。

### 6.2 声线（有对白角色；与角色卡同门锁定）

- **每个说话角色一条声线**，阶段 C 一次做完、全季复用：先 `asset_list(type=voice)` 命中即复用；没有就按 `story-short-generator` 的 STEP 3.5（`references/voice-audition.md`）生成试镜（单人单句、无环境音、balanced），`extract_audio` 后进入**资产总览卡**；批准后由 production 调 `asset_ingest` 得到 `voice:<id>`（单项目/未批准仍由用户点「入库」）。本 skill 只登记台账，不重跑 story 的规则。
- 声线方案写进系列圣经与集制作包 ⑥：
  - `existing`（默认，推荐）：先 `asset_list(type=voice)` 复用；**没有的才试镜补建**；每个说话角色最终都有 `voice:` → 每集对白镜带 `audio_ref_nodes`。
  - `audition`：**强制每个说话角色重新试镜**（即使库内已有 voice），产生新的 `voice:` 资产/版本；旧 voice 标 `deprecated`；所有后续集用新声线，已交付集标 stale（换声线 = 全对白镜+下游链重渲）。
  - `text-only`：不做试镜、不传参考音频；交付清单必须记「跨集音色无保证」。
- **换声线 = 该角色全部对白镜 + 续接下游重渲**（story skill 铁律），必须在阶段 C 定死；样片集只做基线抽检，不重选。

### 6.3 场景 / 道具

- **每个物理场景一张卡**：集制作包 ② 有几个场次就建几张（本片型 1–2 张）；场景卡**单视图**、跟随影片比例（9:16）、**无人物零文字**；地标名与屏幕位置写节点描述（供镜头意图 `空间位置` 列直接引用）。
- 道具卡单视图单件、1:1；**只给叙事关键且反复出现的道具建卡**（每张卡占一个参考槽位，单镜 `ref_nodes` >2 未实测）。
- 资产库**没有 `prop` 类型**：道具归 `scene`（`scene:prop-<name>`），台账里注明真实语义。

### 6.4 门 G-A：资产审核 + 是否入库

资产生成完（角色/场景/道具/声线都齐）后，**必须先出「资产总览卡」让用户审核，并明确询问是否入库**；不许跳过，也不许说“AI 不代劳、请自己点入库”。

`ask_user_question`（资产总览 + 入库）：
- **批准全部并入资产库（推荐）** → production 写「EP00X 资产入库清单（已批准）」（正文含 `asset-ingest-approved` + 每个 nodeId/srcPath/name/type/character/cardVariant/source）→ 调 `asset_ingest` → `asset_list` 校验 → 台账
- **只批准选中项** → 只列选中的条目，其余保持画布引用
- **先不入库（仅本会话）** → 允许 EP01/试产；量产集 `assetMode=library` 会拦，跨会话不可复用
- **重出某卡 / 补状态卡 / 换某角色声线（重听）/ 调场景光位**

批准后把资产 id 与 `voice:` 写进 `production-state.json` 的 `assets`（含 `voices[]`），并在主会话 `series bible` 组写一张资产台账表（角色/状态/场景/道具/声线 → 资产 id → 适用集范围）。**未批准的条目不得入库**；`asset_ingest` 默认拒绝覆盖同名。

---

## 7. 阶段 D：样片集（EP01，门 G-SAMPLE）

样片集是**整季的校准件**，不是「先做一集看看」的随意产物。按 §8 的每集 SOP 走 EP01（**3 张集卡**：方案 / 片段 / 交付），另外必须做到：

> **不做「三档成本实测」。** 档位决策不需要现跑：成本用 `comfy_list_workflows` 的实测耗时 + §9.1 的实测表，画质有 story skill 的结论（`balanced` 帧锐度实测**高于** `quality` 约 13%，`quality` 的收益更平滑、代价 2.4×），EP01 自己的 `costMinutes` 是拼完成片自然产生的。额外抽 3 镜实测既会踩「链内首遍尺寸必须一致」（改档 = 断链），又会把 EP01 与整季撕成两个档。**只有**用户主动要比较某档、或注册表耗时与 §9.1 差 >30%、或换了实现/卡/驱动后的第一个项目，才临时测 **1 镜**（用临时副本节点、不传 `continuity_from`、不进拼接），并在 G-SAMPLE 卡上写明结论。

1. **一致性基线**：抽 5 帧（首/中/末 + 两个说话窗）对照角色卡与场景卡，记录漂移项。
2. **声线基线（听核矩阵，不要只抽 1 句）**：每个说话角色抽 **3 种镜**各 1 句，人工听核「是否同一人 / 有无环境音 / 有无幻听」：① 近景对白镜（口型最易看清）、② 全景/群戏对白镜（声像与混响最容易飘）、③ **续接镜**（继承上一镜 1 秒音频，最容易出现音色突变）。任一处不一致 → 回阶段 C 换 `voice:`（换声线要连锁重渲该角色全部对白镜 + 下游续接镜，宁可在样片集发现）。成本 ≈ +5 min，换掉全季最大的未测项。
3. **字幕开关复核**：确认成片**画面内没有任何字幕 / 烧录文字**（负向尾句是兜底，主机制是「不写声明」）。
4. **交付画质对照**：原生 768×1344 与「超分到 1080×1920」各做 1 镜；若考虑 `regen2k`，**再加 1 镜「2K 重生成」对照（1440×2560）**，给出耗时与「是否重画/身份口型是否漂」的眼判结论；`delivery=fps48` 时再加 1 镜 48fps 对照（补帧前后抽同时间点 1 帧，看双影 / 字幕边缘）。
5. **可选三视图对照**：用户要试 `three` 时，只在本集挑 1–2 镜用 `ref_variant='three'` 对照（竖屏未实测，通过了再讨论整季切换；切换 = 已产集重渲）。
6. **门 G-SAMPLE**：`ask_user_question` 列「成片 + 漂移项 + 声线基线 + 超分/帧率对照」，选项：**按 balanced 原生量产（推荐）** / 整季升 quality（更平滑、2.4× 成本，锐度实测不及 balanced，见 story skill 实测表）/ 整季逐镜超分到 1080 / **整季 2K 重生成（+≈150 min/集，会重画内容）** / **整季逐镜补到 48fps** / 放开 three 视图（需重渲本集）/ 先修资产或剧本再量产。

> 样片集未批准，不进第 2 集。

---

## 8. 阶段 E：量产（每集 SOP，门 G-E）

### 8.1 每集会话开场 SOP（新会话必做；第 8 步仅续跑时执行）

1. **读状态**：`series/production-state.json` → 当前集 / stage / doneShots / 资产台账（含 `voices[]`）。
2. **读输入**：`episodes/epNNN.md` + 分集目录该行 + `series/bible.md` 相关段（不要全读，按需）。
3. **写画布设置**：`canvas_set_state` 一次写全（§1 代码块：`9:16` / 目标时长（80–110s，默认 90 秒）/ `dialogue-led` / `balanced` / `single` / `batch` / `verdict`（自检门）/ 十个分组）。**这是 `reviewMode`、`shotGate`、`groupOrder` 与「图片尺寸基准」的唯一写入点**——**必须先写 state 再物化/建卡**：画布的 `aspectRatio` 决定图片档位的宽高，缺省是 16:9，9:16 项目若先建卡再写 state，角色卡/场景卡会按横版生成（L1 实测踩过）；story 进入后只读、校验、缺值告警，不重写。**漏了这一步 = story 读不到 `reviewMode`：每集从 3 张卡变成「1 张方案 + 18 张片段 + 1 张交付」（≈20 张）。**
4. **物化资产**：只从台账/集制作包的 **asset id** 物化——`asset_list` 校验 → `asset_to_canvas(id=…)` 把本集用到的角色/状态/场景/道具/声线取回画布（复用也要可见）。**不要用上一集的 node id**；`asset_to_canvas` 会在节点写 `params.assetId`，可据此校验来源。
5. **写本集规格卡**：`canvas_write_node(kind="text", group="story planning", title="EP00X 本集规格", content=…)`，只读展示 `9:16 / 目标时长 / dialogue-led / 视频档位 / 图片档位 / 单视图 / batch / 字幕 none / 交付画质（native/upscale…）/ 风格 / 声线方案 / assetMode`，并附**当前节点数（动态，主线/总）**。**它不是新参数来源**：参数来源是系列圣经 §1 + 集制作包 ⑥；节点数只是画布状态。
6. **建集制作包**：按 §10 生成 `package.md`，同时写该集画布文本节点（group `story planning`）。量产集 `params.assetMode=library`；EP01/试产才用 `draft`。
7. **委托生产**：加载 `story-short-generator`，按 §8.2 从 STEP 3 起执行，并声明**每集 3 张卡的合并规则**（方案 / 片段 / 交付）。
8. 若 `stage` 已是 `clips` 且有 `doneShots`：**断点续跑**——`canvas_list_nodes` 找回已渲片段，从第一个缺的镜继续（不要重渲已完成的镜）。

### 8.2 委托时的覆盖规则（组合税，必须照做）

| 处 | 做什么 | 不许做什么 |
|---|---|---|
| STEP 0 | 读 ⑥ 预填表落地；state 已由 §8.1 第 4 步一次写全，这里只校验 | **不许再向用户逐项问十三项**；不许第二次写 state 覆盖 §8.1 |
| STEP 1/2 | 跳过（简报/大纲已被系列圣经与集制作包覆盖）；只在 `story planning` 写一页「本集简报」，**必须承载交付画质 / 风格 / 图片档位 / 字幕 / 声线方案五个无 state 字段的配置** | 不许重写整片 8 拍弧 |
| STEP 3/3.5/4/4.5 | 先 `asset_list` / `asset_to_canvas`；**缺卡才新建**，且按本片型形态（角色双版、场景单视图、道具单视图）。**STEP 3.5 不重跑试镜**：从台账 `voices[]` 取 `voice:<id>`，缺 id 才算缺口 | 不许绕过资产台账另建一套；不许每集重抽声线 |
| STEP 5 | 用 8 列镜头意图生成七列镜头表；`续接` 按实际场景边界重定；台词逐字；**第 8 列的 `beatId` 逐镜回填到 `镜头描述` 首行 `剧本依据: B0x`**（B0x = 包 §2.1 beat 清单的编号，**不许自创序号**） | 不许改台词、不许改事件；不许丢掉 beat 回指 |
| 门 1 / 门 2 / 分镜模式 / 分镜批准 / 渲染参数 | **合并为「方案卡（G-P）」**：包 ①③⑤⑥ + 镜头表 + 分镜 + 渲染参数 + 成本估计，一张卡批准 | **STEP 5.5 十四项自检照跑**（第 12 项核对剧本覆盖：**包 §2.1 的 beatId 集合 ↔ 镜表首行，每个 beat 至少被 1 镜引用**；第 13 项对白容量，第 14 项资产—设定一致性）；不许把门 1/2 再单独弹给用户 |
| STEP 5.5–8 | **规则照执行**（十四项自检、门 3 AI 自检、续接链、失败梯度、拼接、终检）；人工门按 **3 张卡**（方案 / 片段 / 交付） | **硬约束不可覆盖**——这些是实测资产；不许把 3 张卡拆回逐门确认 |

### 8.3 本集执行顺序（只留指针）

本集编排的**唯一详细版本**在 [`references/production-runbook.md`](references/production-runbook.md) §2（3 张人工卡 + 资产物化/入库 + handback）。本 skill 只负责系列层：资产/台账/方案卡/片段卡/交付卡/状态；拍摄规则、门禁、失败梯度一律以 `story-short-generator` 为准，**本文不复述**。

> 一句话：production 决定「这一集拍什么、用哪些 asset id、花多少、谁批准」；story 执行「怎么拍、每镜怎么生成、AI 自检」。两者交接物是集制作包 + 本集终检/片段清单。

### 8.4 量产节奏（单卡顺序执行，无并行）

- **一次一集**，串行。不要在同一条机器上并发多集（显存与显存峰值不可控，且拼接/超分要排同一队列）。
- 一集 ≈ 50 min 生成 + 10–20 min 重渲 + 分钟级拼接；**一晚上 4–6 集**是现实节奏。选 `regen2k` 时每集再加 **≈150 min 重生成**（≈2.5 h/集）⇒ 一晚 1–2 集。
- 每 5 集做一次**系列抽查**（跨集一致性 + 成本偏差 + 剧本-成片一致性），偏差 >20% 就停下来查资产或流程，不要闷头跑完 80 集。
- 每集交付后更新 `production ledger`：集号 / 镜数 / 重渲镜数 / GPU 分钟 / 卡片新增数 / 交付路径。

---

## 9. 成本模型与闸门

### 9.1 本片型（目标 80–110s / 9:16 / balanced / 无字幕）实测口径

> 下表按 **90s 典型集（18 镜）** 计；T 在 80–110s 内按镜头数近似线性缩放（±11 镜 ≈ ±15% 成本）。

| 项 | 单值 | 每集（18 镜） |
|---|---|---|
| 片段 `balanced` 768×1344 | ≈166s/镜 | ≈50 min |
| 转场镜（≤1 个，i2v） | ≈177s | ≈3 min |
| 重渲（经验系数 1.3–1.5） | — | +15–25 min |
| 逐镜超分到 1080×1920（可选） | ≈262s/镜 | +78 min |
| **逐镜重生成到 2K 1440×2560（`regen2k`，可选）** | ≈541s/镜（124 帧） | **+150 min**（18 镜×541s≈162 min；受「每镜 ≥124 帧」约束后按 17 镜≈153 min，取 ≈150） |
| 逐镜补帧到 48fps（可选，成片不补） | ≈10.5s/镜 | **+3 min** |
| 抽帧自检 / 拼接 / 导出 | 秒–分钟级 | ≈2 min |
| **单集合计** | | **≈70 min（原生）/ ≈150 min（超分）/ ≈220 min（2K 重生成）** |
| 整季 80 集 | | **≈93 GPU 小时（原生）≈ 4 天满负荷；超分版 ≈8 天；2K 重生成 ≈293 GPU 小时 ≈ 12 天** |

> `regen2k` 的两条硬约束：① **每镜源片 121–362 帧（5.04–15 s）且 24fps**——选它时镜头表**每镜至少 124 帧**（建议统一 124），短镜要合并/拉长，否则该镜会被工具直接拒；**90s 集因此镜头数最多 17（17×5.17≈88s）**，要保留 18 镜就把目标时长提到 ≥93s 或把两镜合并；② 交付 **1440×2560（9:16）**，**不要与超分/原生混**（尺寸口径不同），整季统一。

卡片一次性：角色 5–8 人 × 2 版（+ 状态卡）+ 场景 10–20 + 道具 3–8 ≈ 30–50 张 × 6s ≈ **3–5 min**（`balanced` 默认；改用 `quality` 则 ≈ 25–40 min）。
声线一次性：每个说话角色 1 条试镜（balanced ≈166s）+ 人工听核；5–8 个角色 ≈ **15–25 min**，全季复用。`text-only` 省这一步，但跨集音色无保证。

### 9.2 三道闸门

1. **样片闸**：EP01 未过 G-SAMPLE 不进第 2 集。
2. **档位闸**：整季同一档（`balanced`）；**不要混档**（链内首遍尺寸必须一致，混档会打断续接链且拼接后清晰度跳变）。用户要「更好看」先分清：要更大尺寸 → 超分（不重画、不断链）；**要更实的纹理/小字 → 2K 重生成（会重画内容、须逐镜抽帧核对）**；要更顺 → **逐镜补 48fps**（后处理、不改尺寸、不断链）；要更好画面 → 改档重渲（断链、连锁下游）。**`regen2k` 与超分/原生整季不混**（交付尺寸 1440×2560 vs 1080×1920/768×1344）。**整季必须同一帧率**：混帧率拼接会被 `video_concat` 拒绝。
3. **规模闸**：≥20 集的项目，先出「集数 × 档位 × 是否超分」预算表让用户确认；跑批期间每 5 集报一次成本偏差。

### 9.3 省钱顺序（不许跳）

先 `fast` 调构图 → `balanced` 定稿 → 只在交付尺寸不够时超分；**不要**用 `quality` 生成再超分（尺寸一样、只是更贵），也不要用超分去救内容问题（构图错/口型错放大只会更明显）。`regen2k` 是**最贵的一档**（≈150 min/集，≈2× 超分、≈3× 原生）且会重画内容：只在「纹理/小字/材质」确实是卖点、且样片对照眼判过关时才整季启用。

---

## 10. 集制作包（唯一交接物）

一个文件 `series/episodes/epNNN/package.md` + 该集画布文本节点（group `story planning`）。**开头放机读块**（```json，`contract: "episode-package/v1"`，字段见 `schemas/episode-package.schema.json`），其后固定 6 节；六节与机读块同源。**生成后必须跑校验器**（在插件仓库/安装目录里跑；用户项目工作区没有 `scripts/`）：`node scripts/validate-episode-package.mjs <package.md>`（六节 + beat 覆盖 + assetMode 闭合），契约冒烟用 `node scripts/smoke-skill-contract.mjs`；拿不到脚本就按 `references/episode-package.md` §7 的 12 项手工核对并留痕。完整模板与 8 列细则见 `references/episode-package.md`：

1. **集元数据**：集号/标题/目标时长（80–110s，默认 90s）/是否付费卡点/钩子类型/前情/下集预告/合规标记。
2. **场次表**：**压缩到 1–2 个物理场景**（同场景不同机位算同一场）；每场写目标、阻力、结果、冲突升级点。
3. **对白表**：逐句「说话人 / 台词（逐字）/ 情绪 / 目标时长 / 字幕=`none`」。
4. **8 列镜头意图**：镜号&时长 / 场 / 说话人&台词 / 表演意图 / 景别&运镜 / 空间位置 / 续接意图 / **`beatId` + 节拍**。
5. **本集资产清单**：角色（含状态卡）/ 场景（含地标）/ 道具 / **声线（`voice:` 或未入库的 `canvas:<音频节点 id>`，来自台账）**，**优先写资产库 id**；缺卡标 `TO-BUILD`。
6. **生产参数预填**：⑥ 预填表 13 项（对应 story 的 STEP 0 生产规格 + STEP 6 分镜模式）+ 镜头预算 + 成本估计 + 合规标记。

**beat 清单（`beats[]`）**：机读块 + ④ 之前各写一份，8–14 个，来源 = ② 场次的冲突升级点；每镜 `beatId` 必须回指它、每个 beat 至少被 1 镜引用。**这是「剧本覆盖」唯一的机械证据**——没有它，「每个 beat 至少被 1 镜覆盖」就退化成同义反复，漏拍不会被发现。细则见 `references/episode-package.md` §2.1。

**镜头预算公式**（必须先算再排镜）：

```
T = 目标时长（80–110s，默认 90s）
镜长(s) ≈ 本镜台词字数 ÷ 4 字/秒 + 0.5–1s 反应/动作尾
镜头预算 ≈ T ÷ 平均镜长(4–5s)        # 90s ≈ 17–20 镜；对白密集可 24–26（T ≤110s）；跨场景每个边界 −1 镜给转场
对白镜数 = 镜头预算 − 动作/反应/特写镜(3–4) − 转场镜(0–1)
对白句数 ≤ 对白镜数                  # 一镜一说话人；同一人连说可 2–3 句
整集台词字数 ÷ 4 字/秒 + 反应尾 ≤ T   # 超了先砍台词，别压语速
```

**时长回写（硬规则，双向）**：STEP 5.5 通过后，若 **|实际时长 − T| > T×0.1** 或实际镜数 ≠ 包预算，必须回写集制作包 ① 与 `production-state.json`（`episodeSecondsException` / `shots`），并在方案卡报告偏差；**超时和欠时都要回写、不许静默**（真实项目 EP01 已出现 105.8s / 25 镜，必须走这条而非人工补字段）。

---

## 11. 跨集一致性纪律（量产最容易翻车的地方）

1. **身份只认资产 id**：每镜 `ref_nodes` 从台账取；不要凭记忆写角色描述。
2. **续接不继承身份**：重渲/续接沿用画面，但服装妆容不保证——换装集必须换对应状态卡。
3. **每集 `起链`，集间硬切（明确选择，不是省略）**：`continuity_from` 消费的是**服务端 latent**，而上一集片段在**另一个会话的画布**里 ⇒ 跨集续接在架构上不可用。集间观感靠「同场景卡 + 同光位基线 + 集尾钩子」，**交付清单必须写明「本集与上一集为硬切衔接、非续接」**，不要向用户承诺连戏。跨集转场镜（i2v 双端锚定）需要「帧资产」把上集末帧传进本集会话——**列为下一期能力，本期不做**。
4. **风格锁只来自系列圣经**：每镜 prompt 追加同一份风格锁后缀与负向约束（由 story skill 执行，本 skill 只校验）。
5. **画幅/档位/字幕/语言/时长目标区间整季不变**：变了就是「换规格」，已产集必须标注作废或重渲，不许静默混用；单集时长例外走 `episodeSecondsException` 并回写包 ①。
6. **音色**：AV 模型自带声音，跨集音色默认无保证；**优先用统一 `voice:` 参考音频提高一致性**（阶段 C 一次建立，每镜 `audio_ref_nodes`）。「无 TTS」只限制生成新音色 / 后期克隆配音，不限制复用参考音色。跨集一致性尚未实测，样片集必须做听核基线；`text-only` 时交付清单如实记录风险。
7. **每 5 集抽查**：同一角色跨集对照（脸/发型/身材/服饰主色/签名道具）、同一场景地标位置、风格漂移。

---

## 12. 交付（每集 + 整季）

**每集交付包**（`series/delivery/epNNN/` + 该集画布 `final delivery` 组）：
- 成片（节点 id + 媒体路径 + 时长 + 尺寸 + 档位）
- 镜头表导出（PDF）+ 本集剧本（`episodes/epNNN.md`）
- BGM：`bgmMode=in-model` → 写「BGM 已随片（H3 自带），无独立轨；硬切可能换曲」；`none` → 写「无 BGM」；`separate`（下一期）→ 写「独立 BGM 素材 + 配乐点单（情绪/入点/duck/曲风），插件无混音/贴轨，需后期」。
- **集间关系**：写「本集与上一集为**硬切衔接（非续接）**」；若有共用场景，写「场景卡 / 光位基线 / 地标位置与 EPxxx 一致」。
- 终检清单（沿用 story skill 的终检项）+ 本集成本（GPU 分钟 / 重渲镜数）
- **`regen2k` 路线额外落两行**：逐镜重生成记录（镜号 → 画布节点 id → `handoff=latent|video`）+ **抽帧核对留痕**（身份/口型/构图/画面文字；`canvas_record_check` 结论），以及「本集交付尺寸 1440×2560、与超分/原生未混」
- **字幕核验**：`字幕核验：<总帧数> 帧 / <命中> 例`（来自逐镜 notes；没有这一行 = 交付包不合格）
- 人工听核项：对白清晰度、音效同步、有无幻听人声

**交付卡（G-E）**：每集一张，列成片（节点 id / 时长 / 尺寸 / 档位）+ 终检结论 + 本集成本 + 台账；批准后才把 `stage` 写成 `delivered`。选项：**批准交付（推荐）** / 重渲某镜 / 重拼 / 逐镜超分 / **逐镜重生成 2K（`video_regenerate`；会重画内容，需抽帧核对后重拼）** / **逐镜补帧（48fps）** / 补做终检某项。

**整季交付**（主会话 `series delivery` 组）：集清单（集号 → 成片路径 → 时长）、未落地项（BGM 贴轨 / `text-only` 音色风险 / 待重渲）、总成本、资产台账快照。

**渠道**：ask 前插件会自动把画布未送达产物发到飞书（媒体直接发、文本节点转 PDF），**不要手动调 send_file**；单文件超 20 MiB（超分版与 **2K 重生成版（1440×2560 常见 30 MiB）**常见）会失败并记在节点 `params.deliveryError`，改用更小 `target_width` 或提示用户到画布取。

---

## 13. 失败与异常（系列层）

| 现象 | 处置 |
|---|---|
| 单镜连续 3 次失败 | 弹选项卡：换档（先 `comfy_list_workflows` 核对）/ 放宽要求 / 跳过并标 `placeholder: missing clip` / 手动提供参考（story skill 的求助门，不许静默降级） |
| 角色卡被改 / 重出 | 台账版本 +1；**该角色所有未交付集重渲**；已交付集标注作废 |
| 场景卡失效 | 重出 + 重新核对引用该场景的 `固定地标` / `光位基线` |
| 换声线 | 该角色**全部对白镜 + 续接下游**重渲；已交付集标作废；台账 `voices[]` 版本 +1 |
| 剧本变更（制作期） | **见 §13.1**：只由 writer 改 → G-CHG 变更卡 → 重建包 → 重新过门 → 按 L1–L4 重渲；不覆盖已交付 |
| 换档 / 换画幅 / 换字幕开关 | 已产集作废清单化，逐集重渲；不许新旧混拼 |
| 会话中断 | 读 `production-state.json` + `canvas_list_nodes`，从 `doneShots` 之后续跑 |
| 画布节点过多（>200） | 新会话重新物化资产；旧集画布只读归档 |

### 13.1 剧本变更（production 期间）

**唯一入口是 writer**：production 不改台词、story 不改台词；需要改就回 `short-drama-series-writer` 改 `episodes/epNNN.md`，`scriptVersion+1`。

1. **停线登记**：`stage=paused`，state 写 `changeRequest`（level L1–L4 / scope / reason / at / status），受影响范围停止提交渲染。
2. **writer 改稿**：改剧本 + 跑 writer 自检/合规；production 不直接改。
3. **影响分析 + G-CHG**：production diff 新旧稿，定级、列受影响镜/资产/相邻集、估成本，出**剧本变更卡**（按影响面重渲 / 只改台词 / 整集重做 / 取消）。
4. **重建包**：新剧本 → 新 `package.md`，`packageVersion+1`，跑 12 项自检。
5. **重新过门**：G-B（剧本）/ G-CHG / G-P 方案卡（镜头表/分镜/渲染参数变了才出）/ 片段卡（只审受影响）/ G-E；资产变更走 G-A 增量 + `asset_ingest`。
6. **按级重渲**：L1 首受影响镜 + 下游续接链；L2 受影响场景；L3 整集 + 相邻集；L4 所有引用集（旧交付标 `superseded`）。
7. **收尾**：写 `scriptVersion/packageVersion/episodeVersion/rework`；交付包带版本；不覆盖旧成片。

> 完整分级、时点代价、三个例子与反模式：[references/script-change.md](references/script-change.md)。铁律：台词变 = 音频/口型都变，不能只换音轨；镜长变 = 下游续接链顺次重渲；已交付不覆盖。

---

## 14. 边界

- **不写剧本**（委托 series-writer）；**不定义拍摄规则**（委托 story-short-generator）。
- 不自动把 BGM 混进成片（可生成独立 BGM 素材，贴轨仍需后期）；不做后期字幕轨、不做实拍剪辑、不做配音克隆。
- 不承诺「一键整季」：量产是「按集串行 + 门控 + 成本台账」，一集一集推进。
- 用户只要单片 / 单场景 / 单条镜头 → 转 `story-short-generator` 或 `video-generate`。
