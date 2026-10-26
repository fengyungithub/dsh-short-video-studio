# 连续短剧的资产管理设计（资产库 / 系列台账 / 每集画布）

> 日期：2026-10-26 ｜ 触发问题：声线卡必须人工「入库」→ 连续剧集模式下资产到底怎么管？
> 结论先说：**不是「每集单独管理」，也不是「直接复用上一集画布」；是三层：工作区资产库（唯一身份权威）→ 系列台账（索引）→ 每集画布（临时工作副本）**。节点 id 只是会话内句柄，不是资产。

---

## 0. 一句话结论

- **资产库**（`.dsh-assets/library.json` + 文件）是**跨会话唯一身份权威**，由用户人工「入库」写入，id 永久稳定。
- **系列台账**（`series/production-state.json` 的 `assets`）是**系列层索引**：角色/状态/场景/道具/声线 → 资产 id → 适用集范围 → 版本/状态。
- **每集画布**（`canvas/session-<id>/`）是**临时工作副本**：进入一集时用 `asset_to_canvas` 从资产 id 物化，渲染完可归档；节点 id 不跨集复用。
- **集制作包**是「单集采购单」：只写资产 id 或 `TO-BUILD`，不把节点 id 当持久引用。
- 入库不是 per-episode 负担：**全季资产一次集中入库（G-A）**，每集只物化。系列模式允许**用户批准后 AI 调用入库工具**（见 §4.6），但批准仍是人工门。真正会变成负担的是「把节点 id 当资产」——这正是当前真实项目的问题。

---

## 1. 现状：三个存储 + 一个坏习惯

### 1.1 三个存储

| 层 | 位置 | 作用 | 生命周期 |
|---|---|---|---|
| 资产库 | `.dsh-assets/library.json` + `.dsh-assets/images/` | 跨会话素材：character / scene / style / clip / text / voice | 永久；用户点「入库」写入 |
| 系列台账 | `series/production-state.json` 的 `assets` | 系列索引：角色状态 / 场景 / 道具 / 声线 → id | 全季 |
| 每集画布 | `canvas/session-<id>/` | 该集实际渲染节点（卡片、片段、音频） | 一集；可归档 |

### 1.2 代码事实

- `asset_to_canvas` 把库文件拷进当前画布，并在节点 `params.assetId` 写入资产 id（`lib/index.js:887`）——**这是节点与资产的绑定标记**。
- 用户「入库」按 `类型 + 显示名` 查重：同名更新**同一个 id**、覆盖库文件（`lib/index.js:4636-4642`、`lib/assets.js:224`）。⇒ **资产 id 是“稳定槽位”，不是不可变版本**。
- 用户替换/编辑已绑定资产的画布图，会**解除绑定**（`lib/index.js:927-957`，返回 `prevAssetId` / `assetIdCleared`）。⇒ 改图后必须重新入库。
- 资产类型含 `voice`（`lib/assets.js:27`），音频资产可作 `audio_ref_nodes`；图片才可作 `ref_nodes`。

### 1.3 真实项目已经踩的坑

`.dsh-assets/绛珠泪-交付包/series/production-state.json`：

- 角色只写 `nodeSingle` / `nodeThree`，`assetId` 为空（`:27-29`、`:36-38`、`:45-47`）；
- 场景/道具只写 `node`，`assetId` 为空（`:55-56`、`:66-67`、`:79-80`、`:85-86`）。

⇒ 这些 node id 属于 **EP01 的画布会话**。换到 EP02 新会话时它们不可用，于是只能：
- 重新生成卡片（成本 + 身份漂移），或
- 手工找旧会话文件（不可持续）。

这就是“每集单独管理”的坏结果：**看起来有台账，实际台账里存的是会话句柄**。

---

## 2. 关系图

```
┌──────────────────────────────────────────────┐
│ 工作区资产库 .dsh-assets/library.json         │
│  character:8f2a…（绛珠·single）               │
│  character:91bc…（绛珠·three）                │
│  scene:77de…（灵河岸）                         │
│  voice:3ac1…（绛珠声线）                       │
│  唯一身份权威；id 永久；用户批准 → 入库        │
└───────────────▲──────────────────────────────┘
                │ 入库（人工，一次）
┌───────────────┴──────────────────────────────┐
│ 系列台账 series/production-state.json assets  │
│  角色状态 → assetIdSingle / assetIdThree      │
│  场景/道具 → assetId                          │
│  声线 → voiceAssetId                          │
│  + 版本 / 状态 / 适用集 / 最后物化节点（诊断） │
│  系列层索引；不存图片，只存 id                │
└───────────────▲──────────────────────────────┘
                │ 读台账 / 写回版本
┌───────────────┴──────────────────────────────┐
│ 集制作包（单集采购单）                         │
│  assets: assetId 或 TO-BUILD                  │
│  params: assetMode=library|draft              │
└───────────────▲──────────────────────────────┘
                │ 每集开场：asset_to_canvas(assetId)
┌───────────────┴──────────────────────────────┐
│ 每集画布 canvas/session-<ep>                  │
│  节点 params.assetId = 来源资产 id            │
│  节点 id 仅本会话；渲染完可归档               │
└──────────────────────────────────────────────┘
```

**权威链**：资产库 > 系列台账 > 集制作包 > 每集画布。节点 id 不在权威链上。

---

## 3. 问题清单

### P0 · 台账把 node id 当资产
- 现状字段 `nodeSingle/nodeThree/node` 是会话句柄；新会话必然失效。
- 修法：台账持久字段改为 `assetIdSingle / assetIdThree / assetId`；`lastNodeSingle / lastNodeThree / lastNode` 仅作诊断/续跑提示，不参与解析。

### P0 · 集制作包的角色资产强制 node id
- 当前 schema 的 `assets.characters[]` 必填 `singleNodeId / threeNodeId`，`assetId` 反而可选——逻辑反了。
- 修法：`assetIdSingle / assetIdThree` 必填（可为空 = `TO-BUILD`）；`nodeSingleId / nodeThreeId` 可选、仅本会话。
- 加 `params.assetMode`：`draft` 允许 canvas 节点 id；`library` 必须有资产 id（量产集强制）。

### P1 · 入库的粒度与时机
- 不是“每集入库”，而是**G-A 一次性集中入库**：角色双版 + 状态卡 + 场景 + 道具 + 声线。
- 全季资产量约 30–60 个，点 30–60 次可接受；每集只 `asset_to_canvas`。
- 需要一张「入库清单」：资产名 / 类型 / 是否已入库 / 资产 id；未齐不放进 G-A。

### P1 · 同名覆盖 = 可变槽位
- 入库按「类型 + 显示名」覆盖同一个 id；重新入库会替换库文件。
- 好处：修图后引用不变；坏处：无版本历史，已交付集不可复现。
- 修法：台账记 `version` / `updatedAt` / `fileHash`；重大改版用新显示名（新 id），旧 id 标 `deprecated`。

### P1 · 改图会解绑
- 替换画布图会清 `params.assetId`（`assetIdCleared`）。
- 规则：改图后必须重新入库 + 台账版本 +1；受影响未交付集重渲。

### P1 · 声线的特殊性与“临时 canvas 引用”
- 声线入库前只能同会话用 canvas 节点 id；跨集必须 `voice:`。
- 修法：`assetMode=library` 时 `voices[].voiceAssetId` 必须非空；`canvasNodeId` 仅 `draft` 允许。

### P2 · 资产库没有“系列/角色/状态”索引
- 库有 `type/name/state/character/cardVariant` 等元数据，但没有「这一集用哪些」。
- 系列台账就是这层索引；不要让 agent 靠名字在库里搜。

---

## 4. 目标设计

### 4.1 资产库（持久层）

- 只放**已批准、跨集复用**的资产；由用户批准，系列模式允许 AI 调用 `asset_ingest` 执行（§4.6）。
- 建议元数据：`type`、`name`、`state`、`character`、`cardVariant`（single/three）、`assetVersion`、`sourceSession`、`sourceNode`、`seed`、`prompt`、`fileHash`。
- 命名规范：`角色名-状态-版本`（如「绛珠-常服-v1」）；**同名 = 同一槽位**，改版优先新名字/新 id。

### 4.2 系列台账（索引层）

```json
"assets": {
  "characters": [{
    "name": "绛珠",
    "states": [{
      "state": "常服-白衣仙裙",
      "assetIdSingle": "character:…",
      "assetIdThree": "character:…",
      "version": 1,
      "status": "locked",
      "episodes": "1-60",
      "lastNodeSingle": "…（诊断，可选）",
      "lastNodeThree": "…（诊断，可选）"
    }]
  }],
  "scenes": [{ "name": "灵河岸", "assetId": "scene:…", "landmarks": ["river:右1/3"], "lightBaseline": "…", "version": 1, "status": "locked", "episodes": "2,8,13" }],
  "props":  [{ "name": "露瓶", "assetId": "scene:…", "version": 1, "status": "locked", "episodes": "1-15" }],
  "voices": [{ "character": "绛珠", "voiceAssetId": "voice:…", "source": "audition", "version": 1, "status": "locked", "episodes": "1-60" }]
}
```

- **持久字段只有 asset id**；`lastNode*` 只给断点续跑/诊断，不能拿来跨集。
- `status`：`to-build` / `locked` / `deprecated`；`G-A` 只允许 `locked` 进入量产。
- `version`：同名覆盖入库时 +1；台账保留，交付清单记录。
- 可选 `fileHash`：用于检测库文件被替换（插件当前不自动写，可由脚本补）。

### 4.3 集制作包（采购单）

- `assets.characters[].assetIdSingle / assetIdThree`（必填，空 = `TO-BUILD`）；`nodeSingleId / nodeThreeId` 可选（本会话物化/续跑）。
- `assets.scenes[].assetId`、`assets.props[].assetId` 必填；`nodeId` 可选。
- `assets.voices[].voiceAssetId` 在 `assetMode=library` 时必填；`canvasNodeId` 仅 `draft`。
- `params.assetMode`：`library`（量产）/ `draft`（EP01 或试产，允许 canvas 节点）。
- `toBuild`：只列缺卡，且数量受控；建完必须入库 + 台账更新 + 方案卡重新批准。

### 4.4 每集画布（工作副本）

- 开场：`asset_list` → `asset_to_canvas(assetId)` → 校验节点 `params.assetId` 等于台账 id。
- 渲染：`ref_nodes` / `audio_ref_nodes` 用画布节点 id（本会话）或资产 id（库）。
- 结束：片段/成片留在该集画布；卡片可归档；**不把节点 id 写回台账**。
- 画布节点被编辑/替换 → 绑定解除 → 必须重新入库 + 台账版本 +1。

### 4.5 版本与变更

| 变更 | 做法 |
|---|---|
| 修图/换声线（同一设计） | 同名重新入库 → 同 id、`version+1`；台账记录；未交付集重渲；已交付集标 stale |
| 设计改版（换脸/换装/换声线） | 新显示名/新 id；旧 id `deprecated`；台账指向新；受影响集重渲 |
| 资产库文件被外部替换 | 用 `fileHash` 检测；不匹配 → 停线，重新入库 |
| 交付后 | 成片已渲染，不依赖库；交付清单记 asset id + version |

### 4.6 入库：用户批准后由 AI 执行（系列模式新增）

**决定（2026-10-26）**：系列模式下允许 AI 调用入库工具，**前提是资产已由用户审核确定**。这改变“AI 不能入库”的旧契约，但把人工门从“逐个点按钮”前移到“一次批准清单”。

**流程**

1. AI 准备「入库清单」画布文本节点：每项写 `类型 / 名称 / 状态 / 画布 node id / 预览 / 建议资产名`。
2. **一张批准卡**（`ask_user_question`）：批准全部 / 逐项取舍 / 取消。
3. 用户批准后，AI 对批准的项调用 `asset_ingest`：
   ```
   asset_ingest({
     nodeId, type, name, state?, tags?,
     approval: { approvedBy: "user", approvalNodeId, note? },
     allowOverwrite?: false
   })
   ```
4. 工具写资产库 + 审计字段，返回 `assetId`；AI 再 `asset_list` 校验，写系列台账。
5. 未批准的项**不得入库**；失败项单独报告，不静默跳过。

**工具安全约束（必须实现）**

| 约束 | 说明 |
|---|---|
| 仅系列模式 | `assetIngestPolicy = "approved"`（项目/配置开关）；单项目默认仍是人工按钮 |
| 必须有批准 | 缺 `approval.approvalNodeId` / `approvedBy` 直接拒绝 |
| 只收 `ready` 节点 | 生成中 / 失败 / 被替换的节点拒绝 |
| 类型/载体匹配 | image→character/scene/style；audio→voice；text→text；video→clip |
| 不静默覆盖 | 同名已有资产默认**拒绝**；`allowOverwrite:true` 才覆盖并 `version+1` |
| 审计 | 库记录写 `ingestedBy:"agent"`、`approvedAt`、`approvalNodeId`、`sourceSession`、`sourceNode`、`version` |
| 幂等 | 同一 node+name 重复调用返回同一 assetId |

**仍由用户做的事**：审核资产内容、点批准卡、决定命名/是否覆盖。AI 只做机械登记。

### 4.7 `assetMode`：draft 与 library

集制作包 `params.assetMode` 只有两个值：

| 模式 | 允许什么 | 用在哪 | 校验 |
|---|---|---|---|
| `draft` | 画布 node id / `canvas:<音频节点>` 临时引用；允许 `toBuild` | EP01、样片、试产 | 只警告“跨会话不可复用” |
| `library` | **必须**有 `assetIdSingle/assetIdThree/assetId/voiceAssetId`；node id 只能作 `lastNode*` | 量产集（EP02 起） | 缺 asset id / 只有 canvas 声线 → **直接报错**，方案卡不批准 |

- `library` 不是“更严的标签”，是**跨会话可复用性的硬门槛**：新会话只有 asset id 能解析，node id 一定失效。
- 切换时点：EP01 用 `draft` 建资产 → G-A 批准 + 入库 → EP02 起 `library`。
- 当前 EP02 桥接是 `draft`（声线用 canvas 节点）；`asset_ingest` 工具落地后，入库两条声线 + 主角色卡，再把 EP02 切 `library`。

---

## 5. 单集执行规则（从“入库”问题倒推）

1. **G-A 前**：所有本季资产入库；台账写 asset id；G-A 卡显示 `入库 12/12`。
2. **每集开场**：读台账 → `asset_list` 校验每个 id 存在 → `asset_to_canvas` 物化 → 校验 `params.assetId`。
3. **建包**：只写 asset id；`assetMode=library`；`toBuild` 为空（除非本集新角色，需先走 G-A 增量）。
4. **方案卡**：显示资产 id / 版本 / 物化节点；缺 id 或 `toBuild` 未入库 → 不批准。
5. **渲染**：`ref_nodes` 用物化节点；`audio_ref_nodes` 用 `voice:`（或物化音频节点）。
6. **收尾**：只回写 `stage/clipNodeIds/cost`；不把节点 id 写进 `assets`。
7. **新资产**：本集新建 → 入库 → 台账 +1 → 方案卡重批 → 再渲。

---

## 6. 迁移与落地

### P0（现在就能做）
1. 把 `production-state.json` 的 `nodeSingle/nodeThree/node` 改为 `assetIdSingle/assetIdThree/assetId` 为主；node id 移入 `lastNode*`（诊断）。
2. EP01/EP02 桥接包：`assetMode=draft`，保留 node id；EP02 声线用 `canvas:` 仅 draft。
3. G-A 增加「入库清单」与「未齐不通过」。

### P1（下一轮）
1. 真实项目资产集中入库：绛珠/神瑛/沈墨/灵河岸/露瓶 + 两条声线；写台账 asset id。
2. 集制作包 schema：角色必填 `assetIdSingle/assetIdThree`；`params.assetMode`；validator 在 library 模式下强制 asset id。
3. EP02 从 draft 切 library：`voiceAssetId` 写 `voice:`，`assetIdSingle/Three` 写角色资产 id。

### P2（量产前）
1. `fileHash` / `version` 检测；资产变更 → 受影响集清单。
2. 批量入库 UI（多选，人工确认）。
3. 每 5 集抽查资产 id 是否漂移（`asset_list` + `params.assetId`）。

---

## 7. 已定 / 待拍板

| # | 问题 | 状态 |
|---|---|---|
| 1 | 入库时机 | ✅ **已定：G-A 一次性集中入库**；每集只物化。 |
| 2 | 系列模式是否允许 AI 入库 | ✅ **已定：允许，但必须先由用户批准清单**；新增 `asset_ingest` 工具（§4.6）。 |
| 3 | 资产版本策略 | ✅ **已定：混合**——修图/重抽同名覆盖同一 id + version/fileHash；换脸/换装/换声线新名字/新 id。 |
| 4 | 量产集 `assetMode` | ✅ **已定：EP01 draft，EP02 起 library**；validator 已按此实现。 |
| 5 | `asset_ingest` 是否本轮实现 | ✅ **已实现**（工具 + 审计/拒绝覆盖/幂等）；需重启 DSH 后出现在工具列表。 |

---

## 7.1 本轮落地结果（2026-10-26）

- `asset_ingest` 已写进 `lib/index.js`（批准清单 + 审计 + 默认拒绝覆盖 + 幂等）；`params.assetMode` 已写进 schema/validator。
- 8 项 EP02 资产已入库（4 张角色卡 + 灵河岸 + 露瓶 + 2 条声线），真实台账 `production-state.json` 已从 `nodeSingle/nodeThree/node` 迁移到 `assetIdSingle/assetIdThree/assetId`，node id 移入 `lastNode*`。
- EP02 已切 `assetMode=library`，`validate:bridge` 0/0；EP01 保持 `draft`（TO-BUILD）。
- `asset_ingest` 工具需重启 DSH 后才出现在工具列表；本次迁移用等价脚本完成（`docs/analysis/ep002-bridge/ingest-script.mjs`）。

## 8. 附：当前实现的关键证据

- `lib/index.js:887`：`asset_to_canvas` 写节点 `params.assetId`。
- `lib/index.js:4636-4642`：入库按「类型 + 显示名」查重；同名沿用旧 id。
- `lib/index.js:927-957`：替换画布图会解除 `params.assetId` 绑定。
- `lib/assets.js:27`：资产类型含 `voice`。
- `.dsh-assets/绛珠泪-交付包/series/production-state.json:27-29`：角色只有 node id、`assetId` 空。
- `schemas/episode-package.schema.json`：`assets.characters[]` 目前必填 `singleNodeId/threeNodeId`（应改为 asset id 主、node id 可选）。
- `skills/short-drama-series-production/SKILL.md:151-159`：台账草案已用 asset id，但真实项目没按它执行。
- `skills/short-drama-series-production/references/episode-package.md:36`：声线 `canvasNodeId` 临时引用已记录。
