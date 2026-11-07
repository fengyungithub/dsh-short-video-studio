# EP002 资产复用桥接验证（episode-package v1）

> 日期：2026-10-26 ｜ 范围：EP02 前两场（灵河岸·晨 / 灵河岸·夜），验证「已有卡片 node id 复用 + 同一物理场景 + 露瓶复用 + 0 TO-BUILD」。
> 输入：`04-分集剧本/ep002-灵河岸-甘露化形.md`（前两场）+ `series/production-state.json` 的 node id。
> 迁移副本：[package.md](package.md) ｜机读块：[machine.json](machine.json)
> 校验器：[scripts/validate-episode-package.mjs](../../../scripts/validate-episode-package.mjs)

## 0. 结果

```
✓ 通过：0 个错误 / 0 个警告
```

**24 镜 / 94.7s / 2 个屏幕场次（同 1 个物理场景）/ 16 行对白 / 0 TO-BUILD / 2 条入库声线（existing）/ assetMode=library**。

## 1. 复用验证

| 资产 | 来源 | 机读块字段 | 结论 |
|---|---|---|---|
| 绛珠 | EP01 卡片 | `singleNodeId` / `threeNodeId` | ✅ 复用 node id |
| 神瑛 | EP01 卡片 | `singleNodeId` / `threeNodeId` | ✅ 复用 node id |
| 灵河岸 | EP01 场景卡 | `assets.scenes[].nodeId` | ✅ 复用 node id |
| 露瓶 | EP01 道具卡 | `assets.props[].nodeId` | ✅ 复用 node id |
| 声线 | EP02 试镜 v2 → 已入库 | `voices[]` 用 `voiceAssetId`、`voicePlan=existing` | ✅ 跨会话 existing 路径（`voice:` 资产） |

## 2. 这次暴露的问题与契约修正

1. **`nodeId` 字段缺失（已修）**：旧 schema 的角色有 node id，场景/道具只有 `assetId`；真实 state 里 `assetId` 全为空、只有 node id。⇒ 给 `assets.scenes[]` / `assets.props[]` 增加可选 `nodeId`，否则「未入库但可复用」的卡片无法写进机读块。
2. **同地点日夜不是转场（已修校验器）**：SC01 晨 / SC02 夜同属灵河岸，中间是时间跳，用 `硬切`，不需要 TRANSITION 镜。校验器原先按「场次数 ≥2 且无转场」告警，现改为**按物理地点数**判断。
3. **资产库 id 为空是现实**：state 里 `assetId: ""`，只有画布 node id。桥接证明**node-id 复用路径可用**；跨会话复用仍应让用户点「入库」拿到 `asset:`/`character:` id，或在每集会话 `asset_to_canvas` 物化。
4. **声线已入库并切 library**：8 项 EP02 资产（4 张角色卡 + 灵河岸 + 露瓶 + 2 条声线）已登记进资产库；EP02 的 `voicePlan=existing`、`assetMode=library`，对白 `voiceRef=voice:`，校验 0 error。
5. **完整 EP02 需要新卡**：SC03（太虚幻境·天门）新增**兼美、仙婢甲、仙婢乙**三个说话角色，且灵河岸 → 天门需要 1 个转场镜。脚本头部「出场人物：绛珠、神瑛」**漏了 SC03 的三人**——cast 必须按场次列，不能按集列。
6. **对白密度可落在区间内**：16 行对白 / 24 镜 / 94.7s，证明「对白密集 24–26 镜、T ≤110s」的口径能装下两场戏；完整 EP02 的 30 行对白会超 110s，必须在剧本层砍/拆。

## 3. 与 EP01 桥接的对照

| 项 | EP001 | EP002（前两场） |
|---|---|---|
| 镜数 / 时长 | 25 / 105.8s | 24 / 94.7s |
| TO-BUILD | 7（建卡集） | **0**（node-id 复用） |
| 声线 | text-only（无资产） | **existing（`voice:` 资产，已入库）** |
| 续接 | 6 处同场景 `硬切` | 1 处同场景时间跳 `硬切` |
| 转场 | 1 个 TRANSITION | 0（同物理场景） |
| 结果 | 0 error / 2 warning | **0 error / 0 warning** |

## 4. 证明 / 未证明

**证明**：node-id 复用路径、0 TO-BUILD、同地点时间跳用硬切、24 镜密集集、场景/道具 nodeId 契约都能跑通；校验器能对真实包做 0 警告。

**未证明**：
- 完整 EP02（SC03 三张新卡 + 天门转场）与真实渲染质量。
- 完整 EP02（SC03 三张新卡 + 天门转场）——需先建卡。
- 视频画质、口型、接缝、音色。

## 5. EP02 资产 ID（library）

| 资产 | 资产 id |
|---|---|
| 绛珠-常服-单视图-v1 | `character:0c3728dd746e944b` |
| 绛珠-常服-三视图-v1 | `character:7ac72cfe2cbdc53e` |
| 神瑛-常服-单视图-v1 | `character:546e89f81d8c8d3c` |
| 神瑛-常服-三视图-v1 | `character:0a9324424a4c2dc8` |
| 灵河岸-晨昏-v1 | `scene:90d53096e6a30af1` |
| 露瓶-白玉-v1 | `scene:f62f2f5a26aea46d` |
| 绛珠-声线-v2 | `voice:6a4ff47b59671b7e` |
| 神瑛-声线-v2 | `voice:c6fc197a2cf0f029` |

## 6. 复现

```bash
node scripts/validate-episode-package.mjs docs/analysis/ep002-bridge/package.md
```

## 6. 下一步

1. 补 EP02 SC03 的三张角色卡（兼美/仙婢甲/仙婢乙）+ 天门场景卡，再做完整 EP02 包与 1 个转场镜。
2. ~~阶段 C 声线试镜~~ ✅ 已完成：v2 试镜通过、入库 `voice:`，EP02 切 `existing`。
3. 把 EP001 + EP002 两个桥接包挂进 `npm run validate:bridge`（当前已加 EP002 命令则跳过）。
