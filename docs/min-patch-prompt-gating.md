# 最小补丁：分镜 / prompt 门控（A/B 实测后收敛）

> 状态：已落地（2026-10-27）。这份文件是**收敛后的补丁说明**——原始提案的 9 个 patch 里有 6 个是重复/错层，本文只留经得起实测与仓库既有架构的 6 条。
> 证据：画布 `AB 实验` 组，记录节点 `ea2c7380-b4a3-4624-9511-abcf790e6e07`；对照图 `e2e-out/ab/*.png`。

## 0. 两轮 A/B 的结论（决定“补什么”）

| 实验 | 变量 | 结果 |
|---|---|---|
| S01 刑台 | 5 条 invariant vs 原文（同 seed / 档 / refs / 实现） | **反例**：场景卡里本来就有玉柱 + 台座；prompt 去否认 → 前 1/3 玉柱、后 2/3 被掰成木柱（**镜头内形变**），台座只削弱未消失 |
| P01 河岸玉牌 | 道具句（卡里**没有**的道具） | **正例**：`a small jade plaque` → 圆头指状玉条/小瓶；补 `flat rectangular + chipped corner + not a bottle/orb/cylinder` → **带缺角的矩形玉牌** |

⇒ 结论不是“加一道 prompt 门”，而是：

1. **卡里已有的内容，只能改卡或改设定**——prompt 否定会换来形变；
2. **卡里没有、但本镜必须出现的内容**（手持道具、背景人数、画面文案）才写进 prompt；
3. 其余几条 invariant（`[LIGHT]` / `[EXTRA]` / `[HANDOFF]`）两轮都**无信号**，不写成“已验证规则”。

## 1. 补丁内容（6 条）

### P1 · 5.5 新增第 13 项：对白容量

- 落点：`story-short-generator/SKILL.md` STEP 5.5
- 规则：单镜单句 ≤16 字（12–13 字最稳），≥18 字拆相邻两镜；**阈值不在这里复述**，指向 `h3-prompt-writing`「字幕与画面内文案」§3。
- 理由：规则早就存在（STEP 5 列规则里有引用），但 5.5 门不查它 ⇒ 30 字台词能一路走到渲染。成本只是数一遍字数。

### P2 · 5.5 新增第 14 项：资产—设定一致性（最重要的一条）

- 落点：同上
- 规则：逐镜核对「本镜要求的物 / 人 / 光 / 环境」与 `绑定` 的卡是否一致；不一致只能 **改卡** 或 **改镜头设定**；**禁止用 prompt 否定卡里的内容**（附 S01 实测作为理由）。
- 理由：这是本轮实验真正指向的缺口。原提案把这类问题当成 prompt 遗漏，实测证伪。

### P3 · 镜头表加「签名道具写法」（无卡时的配方）

- 落点：`story-short-generator/SKILL.md` STEP 5 列规则之后
- 规则：能建卡就建卡（顺序 角色 → 场景 → 道具，≤3 槽位；`refs.max` 是 8 但 >3 未实测）；无卡时写「材质 + 平面形状 + 唯一识别特征 + 三条否定」；**否定只用于无生命道具**（角色解剖仍走铁律一正向构造）；道具句只放在「道具就是主体」的镜（实测会劫持景别）；未处理的道具不要写“手持”。
- 理由：P01 A/B 直接验证。

### P4 · 参考锚点补 `背景人物`、音频轨补 `画面文案`（数据字段，非门禁）

- 落点：`story-short-generator/SKILL.md` STEP 5
- `背景人物`：`无` / `exactly N` + 坐站 + 衣色 + 虚化；写 `exactly N`，别用自相矛盾的 `completely empty`。**未单独实测**，只补“prompt 没写、模型自由发挥人数”的信息缺口。
- `画面文案`：与 `字幕` 分开（h3 本来就有「画面内文案」写法），字幕 `none` 时仍可单独声明。
- 理由：`h3-prompt-writing` 的映射表已经在引用「画面文案」数据，但镜头表没有这个字段；背景人数全库没有承载处。

### P5 · 渲染前的门补一条：分镜标记残留复查

- 落点：`story-short-generator/SKILL.md` STEP 7「渲染前的门」
- 规则：发出前扫一眼提示词库该段，不得残留 `[char:` / `[scene:` / `[hook:` / `[audio_mode:` / `[speaker:` / `[cont:` / `[BEAT]` / `[HANDOFF`；命中就剥掉、回写同一 nodeId（保持三档同文）再渲。
- 理由：现有流程只写“交给重写前剥离”，渲染前无人复查；标记与参考图文字同类，一旦进 prompt 会被当成要画的内容。

### P6 · 提示词库 provenance 写 `note`（建议，非门禁）

- 落点：`story-short-generator/SKILL.md`「提示词分档持久化」
- 规则：`canvas_write_prompt_bank(..., note="source-shot-table: … · source-storyboard: … · prompt-version: vN")`。
- 关键实现细节：**必须写在 `note`（`## fast` 之前）**——解析器把首段当 `note`，生成回写时原样保留；写进 `## quality` 段会被当成 prompt 原文发给模型。

### 配套：`h3-prompt-writing` 映射表

- 新增三行映射：`背景人物` → `detailed_description`；`画面文案` → 画面内文案写法；签名道具（无卡）→ 形状 + 否定。
- 澄清：**r2v 里被参考的内容用 `<Subject N>`**；`<Picture N>` 只作来源图引用（ref-en §2 允许挂在 `<Subject N>` 定义里）。

## 2. 明确不做（并给出理由）

| 原提案 | 不做理由 |
|---|---|
| STEP 6.5「分镜完整性门」11 项 | 与 STEP 6「每镜章节结构」1–11 逐条重复；立成新门 = 同一规则两份文本，必然漂移 |
| STEP 7.0「Prompt Assembly Contract」映射表 | 与 `h3-prompt-writing/references/studio-mapping.md` §1 重复；映射表只能有一份 |
| STEP 7.0.1「Prompt Lint」10 项 | 与门 3 自检、失败阶梯 0.5 重复；且几乎无法代码化，靠 AI 打勾=仪式化。真要硬，应下沉为工具 warnings |
| 镜头表加两列（背景人物 / 画面文案） | 七列是契约名，牵连 5.5、8 列映射、schema、冒烟测试；做成已有列的子字段即可 |
| 「≤3 refs」写成硬限制 | `refs.max` 实际是 8（`workflows/minimax-h3-ref2v-quality.json`）；≤3 只是未验证的安全区 |
| 冲突优先级（Patch 9） | 已有「用户修改与计划冲突的处理（权威链：镜头表 → 分镜 → 片段）」 |

## 3. 验收

- 结构：`node scripts/smoke-skill-contract.mjs`、`smoke-skill-install.mjs` 通过（计数从十二项 → 十四项后仍全绿）。
- 行为：下一集先在一场戏里按 P2 做一次“资产—设定核对”，把上一集 S01 那类“卡里有台座却写无台座”的镜提前拦掉；P1 用一条 ≥18 字台词的镜验证拆镜。
- 未验证项（保留观察）：`背景人物` / `画面文案` 两个字段的实际收益；`[LIGHT]` / `[HANDOFF]` 是否需要单独规则。

## 4. 变更文件

- `skills/story-short-generator/SKILL.md`（5.5 十三/十四项、STEP 5 道具写法与两字段、STEP 7 标记复查、prompt bank provenance、计数）
- `skills/story-short-generator/references/series-delegated-mode.md`（计数）
- `skills/short-drama-series-production/SKILL.md`（计数与项号说明）
- `skills/h3-prompt-writing/references/studio-mapping.md`（三行映射 + `<Picture N>` 澄清）
- `skills/story-short-generator/meta.yaml`（3.6.1 → 3.7.0）、`skills/h3-prompt-writing/meta.yaml`（1.0.0 → 1.0.1）
- `README.md`（能力表计数 + 更新日志）
