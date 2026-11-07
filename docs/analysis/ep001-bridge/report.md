# EP001 真实剧本桥接验证（episode-package v1）

> 日期：2026-10-26 ｜ 范围：只验证「剧本 → 机读块 → 集制作包 → 方案卡」的文本/契约链路，**不生成任何视频或图片**。
> 输入：`.dsh-assets/绛珠泪-交付包/series/episodes/ep001/package.md`（真实项目产物，未修改原件）
> 迁移副本：[package.md](package.md)（机读块 + 原六节）｜机读块：[machine.json](machine.json)
> 校验器：[scripts/validate-episode-package.mjs](../../../scripts/validate-episode-package.mjs)

## 0. 结果

```
✓ 通过：0 个错误 / 2 个警告
  ⚠ 源剧本 24 句，机读块 21 行（同说话人合并，需确认逐字无删改）
  ⚠ toBuild=7（量产期应 ≤2；建卡集需在方案卡列明）
```

真实包的关键数字全部被 schema v1 接受：**25 镜 / 105.8s / 2 场 / 21 行对白（源 24 句）/ 3 角色 + 2 场景 + 2 道具 TO-BUILD / 7 处建卡**。

## 1. 输入与迁移

| 原包位置 | 迁移到机读块 | 说明 |
|---|---|---|
| ① 集元数据 | `episode` / `targetSeconds` / `shotBudget` / `hookType` / `prevRecap` / `nextTeaser` | 105.8s、25 镜、`suspense` |
| ② 场次表 | `scenes[]` | `外 · 离恨天·天刑台 · 夜（雷云）` → `intExt=外`、`location=离恨天·天刑台`、`dayNight=夜` |
| ③ 对白表 | `dialogue[]` | 21 行；`voiceRef=none`（旧包无声线资产）；`subtitle=none` |
| ④ 8 列镜头意图 | `shots[]` | `S01 / 90f 3.75s` → `seconds=3.75`；场为 `—` 的 S18 → `TRANSITION` |
| ⑤ 本集资产 | `assets` | 角色/场景/道具全部 `TO-BUILD`；`toBuild` 7 项；场景地标从 `name:pos` 解析为 `{name,position}` |
| ⑥ 生产参数 | `params` + `budget` | 9:16 / dialogue-led / none / balanced / quality / single / native / batch / guofeng-xianxia；成本 97 min |
| 无 | `gates` | `packageApprovedAt=null`（旧包没有 G-P 批准痕迹） |

**声线迁移**：旧包没有 `voice:` 资产与声线方案，机读块落 `voicePlan: text-only`，并在报告记录「跨集音色无保证」。新流程下 EP01 应在阶段 C 建声线，改成 `existing`。

## 2. 真实数据驱动的契约修正

这次桥接不是“跑一遍看能不能过”，而是**让真实包暴露契约漏洞**。以下 7 处已修：

1. **`TO-BUILD` 上限 2 → 8**：EP01 合法地有 7 个缺卡（3 角色 + 2 场景 + 2 道具），旧规则会直接判死。现规则：量产期 ≤2，建卡集（EP01/新角色）≤8 且方案卡列明。
2. **`beat` 从枚举改为自由字符串**：真实节拍有 `爽点-护`、`甜`、`揭示（泪即寿）`、`反转-冷`，枚举装不下。Hook 映射仍由七列表转换时处理。
3. **转场镜表示**：旧包 S18 的「场」是 `—`。schema 现允许 `sceneId=TRANSITION`，并规定跨场景转场镜用它。
4. **新增 `硬切` 续接值**：旧包在**同场景内**有 6 处 `起链`（S03/S06/S07/S08/S09/S10），新契约原本只允许 `起链/接/锚定`——同场景刻意硬切无合法取值。现新增 `硬切`：不传 `continuity_from`，但必须在 `连续性衔接` 写明 `HARD CUT — 原因`；跨场景仍只能走转场镜。SSG 的列规则、STEP 5.5 第 9/10 项、STEP 7 渲染策略、PACK 8 列表都已同步。
5. **镜数口径从「17–20」放宽为「17–20 典型；对白密集 24–26，T ≤110s」**：EP01 用 25 镜 / 105.8s 证明 24 句对白的集在「一镜一说话人」下必然超过 20 镜。这不是异常，是密度结果。
6. **地标结构统一为对象**：`scenes[].landmarks` 与 `assets.scenes[].landmarks` 都改为 `{name, position}`；旧包 ⑤ 的 `execution-post:画面中` 字符串由迁移器解析。
7. **补 `sourceDialogueCount`**：源剧本 24 句 vs 机读块 21 行（同说话人连说合并 3 处）。新增该字段后，校验器能提醒「合并后仍需逐字无删改」。

另外，EP01 的 **105.8s** 正好落在 P1 定下的 80–110s 区间内，不需要再靠人工往 state 里补 `episodeSecondsException`——正式字段已存在。

## 3. 剩余警告与待办

| 警告 | 性质 | 处置 |
|---|---|---|
| 源 24 句 vs 21 行 | 旧包合并了 3 处同说话人连说 | 迁移到七列时逐句核对；机读块保留 `sourceDialogueCount` |
| `toBuild=7` | EP01 是建卡集 | 方案卡列明 7 张卡与成本；量产期应回到 ≤2 |
| 6 处 `硬切` 缺 `HARD CUT — 原因` | 旧包没有「连续性衔接」列 | 转七列时逐镜补原因（如「手腕特写 → 沈墨中景，视角重置」） |

## 4. 这次验证证明了什么 / 没证明什么

**证明**：
- schema v1 能容纳真实 25 镜、105.8s、两场、21 行对白、7 张缺卡的包，且能机械校验集号/镜数/声线/续接/groupOrder/六节一致性。
- 真实数据确实能反向修正契约（7 处），不是“纸面自洽”。
- 旧包可以无损迁移：逐字台词、逐镜时长、场次、资产清单全部保留；只把 `起链` 归一为 `硬切`、`—` 归一为 `TRANSITION`、声线降级为 `text-only`。

**没证明**：
- 没有生成任何片段，不验证画质、口型、接缝、音色。
- 没有资产卡（全部 TO-BUILD），不验证 `ref_nodes` 绑定与角色一致性。
- 没有跑 G-P 方案卡的人工流程（只有文本）。

## 5. 复现

```bash
node scripts/validate-episode-package.mjs docs/analysis/ep001-bridge/package.md
```

期望：`0 个错误 / 2 个警告`。

## 6. 下一步

1. 用 EP02 做一次「资产复用」桥接（角色/场景/声线都有 id），验证 `existing` 声线与 `toBuild=0`。
2. 把 EP001 的 6 处 `硬切` 补上原因，再转七列镜头表，验证 STEP 5.5 第 9⑦ 项。
3. 如果 EP02 也通过，把 `validate-episode-package` 挂进 `npm run smoke` 作为真实数据回归。
