# 剧集委托模式（series delegated mode）

> **适用**：工作区已有 `series/bible.md` + `series/episodes/epNNN/package.md`，或从 `short-drama-series-production` 委托进入。
> 进入本模式前必读本文件；本文件只定义**入口/交接/门**，拍摄规则仍走 SKILL 的 STEP 3–8。
> 单片模式见 `single-film-mode.md`；声线见 `voice-audition.md`。

### 门 0 · 入口探测（上下文优先，提问兜底）

**第一件事不是提问，是探测。** 按**画布 → 资产库 → 工作区**查系列上下文，查到即停：

| 级 | 怎么查 | 命中标志 |
|---|---|---|
| 1 画布 | `canvas_list_nodes()` | 标题/正文含「系列圣经 / 集制作包 / 分集剧本 / EP0xx」，或 group 是 `series bible` / `episode plan` |
| 2 资产库 | `asset_list(type=text)` | 名字或描述含「剧本 / 分集 / 集制作包 / 系列圣经 / 短剧」；命中就 `asset_to_canvas(id=…)` 物化 |
| 3 工作区 | `glob` 搜索（项目根或子目录都算） | `**/series/bible.md`、`**/series/episodes/epNNN/package.md`、`**/episodes/epNNN.md` |

判定与去向（**有上下文就直接进委托模式，不弹片型门**）：

| 探测结果 | 去向 |
|---|---|
| 系列圣经 + **本集制作包** | **委托模式**：读包 ⑥ 预填表（12 项，含声线方案 / 分镜模式）→ 校验 `canvas_set_state`（已由 production 写入则只校验；从本 skill 直接进入且尚未写入时才补写一次）→ **从 STEP 3 起**生产本集（跳过 STEP 1/2 与全部 STEP 0 选项卡） |
| 只有分集剧本，或只有系列圣经但**缺本集制作包** | 加载 `short-drama-series-production`，先补系列圣经 / 该集制作包（阶段 A→C），完成后回本 skill STEP 3 |
| 有系列圣经/目录，但**没有本集剧本** | 加载 `short-drama-series-production`（它会转 `short-drama-series-writer` 写该集），补包后回 STEP 3 |
| **完全没有系列上下文** | **才弹门 0**：`短视频故事`（单片，默认）/ `连续短剧`（多集）。选连续短剧后再按本表走 |
| 用户明确只要单片 / 一句话故事 | 跳过探测，直接走单片流程 |

- 选「连续短剧」但系列 skill 未安装、且用户同意 → 降级为单片，并在简报里注明「无系列上下文」。
- **不重复问**：进入委托模式后，生产规格与分镜模式由集制作包 ⑥ 预填（12 项），不再逐项追问，只补问包里缺的项；与 `short-drama-series-production` 冲突时以它为准。
- **委托模式的门合并**：每集人工确认由 production 合并为 **3 张卡**（方案卡 = 集制作包 + 镜头表 + 分镜 + 渲染参数；片段卡 = 门 3 batch；交付卡 = 终检 + 交付）。本 skill 的**门 1 / 门 2 / 分镜模式 / 分镜批准 / 渲染参数卡不再单独弹**，但 **STEP 5.5 十一项自检与门 3 的 AI 逐镜自检照做**——省的是人工确认次数，不是自检。遇到 G-ref / 同镜 3 次失败 / 口型字幕不过 / 意图冲突，仍按本 skill 的异常门当场打断。
- **委托模式的资产/交付边界**：资产**物化、入库、台账**由 production 负责；本 skill 只校验物化节点 `params.assetId`，缺卡时生成后**交回 production 入库**，不自己写资产库。交付包 / 系列台账 / 成本由 production 汇总；本 skill 只写**本集终检结论与片段清单**，委托模式下**不弹交付卡、不写系列交付包**。
- **委托模式的 handback**：每集收尾向 production 交回 `finalNodeId` / `clipNodeIds` / `shots` / `rework` / `costMinutes` / `warnings` / `assetNodeIds`（本集新生成的卡）；production 写 `production-state.json` 与 ledger。
- **剧本冲突**：台词/事件与剧本不一致、或镜头装不下时，**停线退回 production/writer**；本 skill 只拆镜/改时长/改表演，**不许自行改写台词或事件**。
- **反向兼容**：由 `short-drama-series-production` 委托进来时（画布已有集制作包、或对话已声明系列总控），视为已探测命中，跳过门 0。

## 委托模式的硬边界

- **门**：production 出 3 张人工卡（方案 / 片段 / 交付）；SKILL 的 门 1 / 门 2 / 分镜模式 / 分镜批准 / 渲染参数卡不再单独弹，但 STEP 5.5 十一项自检与门 3 AI 逐镜自检照做。
- **资产**：物化/入库/台账归 production；SKILL 只校验物化节点 `params.assetId`，缺卡生成后交回 production 入库，不写资产库。
- **交付**：交付包/系列台账/成本归 production；SKILL 只写本集终检与片段清单，不弹交付卡、不写系列交付包。
- **handback**：`finalNodeId` / `clipNodeIds` / `shots` / `rework` / `costMinutes` / `warnings` / `assetNodeIds` / `changedShots` / `scriptVersion`。
- **剧本冲突**：台词/事件与剧本不一致、或镜头装不下时，停线退回 production/writer；只拆镜/改时长/改表演，不改台词。
- **生产参数**：读集制作包 ⑥（12 项）与 `production-state.json`；`assetMode=library` 时不得用 canvas 节点作持久引用。
- **组排/state**：production 写 `canvas_set_state`；SKILL 只读、校验、缺值告警，不重写。
