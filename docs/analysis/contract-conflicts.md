# 三 skill 交接契约与口径冲突审计

- 审计对象：`skills/short-drama-series-writer/`、`skills/short-drama-series-production/`、`skills/story-short-generator/`
- 审计方式：只读文本审计（read / grep）。**未调用 skill 工具加载三个 skill**，未修改任何 skill 文件。
- 证据口径：每条结论给出 `文件:行号`。凡属推断而无文本依据的，明确写「未证实」。
- 旁证来源：仓库内真实项目产物 `.dsh-assets/绛珠泪-交付包/`（非 skill 文本，单列于 §9，用于说明冲突已实际发生）。
- 本次唯一写入：本文件。

严重度定义：**S1** = 每集必踩、直接导致返工/超预算；**S2** = 经常踩、需人工纠偏；**S3** = 低成本修正。

---

## 0. 任务 7 问 → 冲突编号索引

| 问题 | 对应条目 |
|---|---|
| 1. 两个「制作包」是不是同一产物 | C1（含 C6 的读取点缺失） |
| 2. 每集数量口径 | C2、C3 |
| 3. 目录/编号/两份状态文件 | C4、C5 |
| 4. 8 列 → 7 列映射与缺失字段 | C6 |
| 5. ⑥ 预填表 ↔ STEP 0 十项 | C8 |
| 6. 画布分组 9 vs 10、谁声明 groupOrder | C9 |
| 7. 双向入口循环 / 重复初始化 | C10（另见 C7 的每集重问） |

---

## 1. 交接物冲突

### C1 · 同名的两个「制作包」是两个不同产物，只有一个被契约承认（S1）

**现象**
- writer 的 `/export` 硬规则要求导出 `export/episodes-production/`：每集一个 `ep001-{标题}.md`，外加 `README-分集索引.md`、`制作包说明.md`、`export-status.md`，且「总集数是多少就必须有多少个独立分集文件」（`skills/short-drama-series-writer/SKILL.md:425-437`、`:480-484`、`:593-594`）。
- production 的交接物是另一个东西：`series/episodes/epNNN/package.md`，固定 6 节（`skills/short-drama-series-production/SKILL.md:112`、`:285-294`；`skills/short-drama-series-production/references/episode-package.md:3`、`:8-23`）。
- 两者名字都叫「（分集）制作包」，但字段集完全不同：writer 包 = 制作信息/人物重点/**分镜稿**/景别/运镜/表情动作/完整拍摄剧本/钩子/导演提示（`skills/short-drama-series-writer/SKILL.md:434`）；production 包 = 集元数据/场次表/对白表/**8 列镜头意图**/资产清单/生产参数预填（`skills/short-drama-series-production/SKILL.md:289-294`）。
- production 只在目录树里把 writer 的导出标为「可选」，**没有任何步骤读它**：每集 SOP 的「读输入」是 `episodes/epNNN.md` + 分集目录该行 + `series/bible.md`（`skills/short-drama-series-production/SKILL.md:108`、`:220`）。
- story 的连续短剧入口查剧本只认三样：`**/series/bible.md`、`**/series/episodes/epNNN/package.md`、`**/episodes/epNNN.md`（`skills/story-short-generator/SKILL.md:207`），完全不查 `export/`。
- production 自己的 reference 断言「只传这一个包」（`skills/short-drama-series-production/references/episode-package.md:3`）。

**影响**
- 80 集项目要额外生成 80+2 个文件的 writer 导出（含分镜稿），但按 skill 文本它不进入生产链 → 纯成本；且它带的 12–15 镜分镜稿与 production 的 17–18 镜预算天然不同（见 C2），一旦被当输入就必须重排。
- 同名导致交接物误认：agent 很可能把 writer 的 `episodes-production/ep001-*.md` 当作集制作包（缺 8 列/资产 id/预填表），到 story 的 STEP 5 才发现字段不够。
- 真实项目里两份都在、且 production 的 package 主动引用了 writer 的包（`.dsh-assets/绛珠泪-交付包/series/episodes/ep001/package.md:3` 写着「上游制作包：`06-分集制作包/ep001-…`（15 个镜头 / 24 句对白）→ 本包按「一镜一说话人」重排为 25 镜 / 105.8s」）——这是**流程文本未规定的自发行为**，不是契约。

**建议**
1. 在 production §3.2 与 §8.1 明确写死：「**永不读取** `export/episodes-production/`；该目录是 series-writer 的对外审阅交付物」。
2. writer `/export` 的定位改为「对外审阅/存档」，并删去「分镜稿 + 12 镜」这类与生产口径冲突的内容（或标注「非生产输入」）。
3. 中文命名区分：writer 侧叫「分集制作稿（审阅用）」，production 侧保留「集制作包（生产交接物）」。
4. 若确要复用 writer 的分镜稿，就在 episode-package.md 增一节「上游草稿 → 8 列」的转换规则，而不是让 agent 临场发挥。

---

## 2. 数量口径

### C2 · 三套每集标准并存，只有「场次」一项写了覆盖规则（S1）

**现象（并列证据）**

| 口径项 | writer | production | story |
|---|---|---|---|
| 单集时长 | **120 秒**硬标准，另称 1–3 分钟（`:340`、`:451`、`:493`） | **90s**（`:51`、`:158`；`references/series-bible.md:13`） | 单片 30–180s（`:198`、`:230`），无每集口径 |
| 镜数 | **默认 12 镜**，付费/高潮 15–20 镜（`:343`、`:436`、`:493`、`:603`） | **17–18 镜**（124 帧≈5.17s）（`:51`、`:158`、`:300`；`references/episode-package.md:58`） | 无镜数标准，仅单镜 **≤15s**（`:560`） |
| 对白量 | **每集 18–25 句有效对白**，少于此即不合格（`:340`、`:435`、`:600`） | **对白句数 ≤ 对白镜数**，镜数 = 预算−动作镜−转场镜（`:302`；`references/episode-package.md:60`） | **一镜一说话人**（`:533`、`:565`），句长超限则拆镜（`:549`） |
| 场次数 | **每集 3–5 个场次**（`:338`） | **1–2 个物理场景**（`:59`、`:158`；`references/episode-package.md:64`） | 无 |

> 表内简写约定：裸 `:行号` 指该列对应 skill 的 `SKILL.md`；写 `references/xxx.md:行号` 者为其 references 文件。

**覆盖规则的实际情况**
- production 只对**场次**写了显式覆盖：「上游「每集 3–5 场」必须压缩」（`skills/short-drama-series-production/SKILL.md:59`）、「场次压缩」（`references/episode-package.md:64`）。
- 对 **120s / 18–25 句 / 12 镜**没有任何覆盖或沿用声明。research 文档明确要求覆盖 12 镜（`docs/short-drama-series-integration-research.md:94`）、并在 §6.5 写了 5 处注入（`docs/short-drama-series-integration-research.md:302-312`），但**落到 production SKILL 的覆盖表只有 5 行、且不含数字口径**（`skills/short-drama-series-production/SKILL.md:226-234`）。
- 唯一涉及数字的是镜头预算公式（`:296-304`），但它没有一句「覆盖 writer 的 X」。
- production 自己的示例是 **18 镜 / 14 句对白**（`references/episode-package.md:68`、`:90-103`），即按 `:194` 的等式「镜数 = 对白句数 + 动作镜 + 转场镜」凑满；而 writer 的口径下 14 句属于「不合格」（`skills/short-drama-series-writer/SKILL.md:435`）。
- 算术层面的张力：18–25 句若坚持「对白之间必须穿插动作停顿、反应切镜」（`skills/short-drama-series-writer/SKILL.md:341`），在 17–18 镜预算内几乎不可能；唯一出路是 production 的「同一人连说可 2–3 句」（`:302`），而这与 writer 的切镜要求方向相反。

**影响**
- 剧本按 writer 标准写 → 90s 装不下（真实项目 EP01 被撑到 105.8s/25 镜，见 §9）；剧本按 production 标准写 → writer 的 `/review`、`/export` 会判不合格（`:409-413`、`:437`），两套自检互相打脸。
- 成本模型按 18 镜/集推（`skills/short-drama-series-production/SKILL.md:261-269`），口径漂移直接把预算打穿。
- 由于没有覆盖条款，行为取决于 agent 读到哪一段，**不可复现**。

**建议**
1. 在 production §1 参数表下加一张「口径覆盖表」，逐行写：`时长 90s 覆盖 120s` / `镜数 17–18 覆盖 12/15–20` / `对白句数 ≤ 对白镜数 覆盖 18–25 句` / `场次 1–2 覆盖 3–5` / `一镜一说话人、≤15s/镜、≤3 重要角色 沿用 story，不可覆盖`。
2. 在 writer 侧**不改文本**（research 已定 M1：上游原文不动，`docs/short-drama-series-integration-research.md:94`），改为 production 声明「仅在连续短剧路径生效」。
3. 给 `对白句数` 增加一个上界（如 ≤ 镜数×2），避免「同镜连说 3 句」抵消切镜要求。

### C3 · 90s 预算与句数口径没有收敛机制，偏差无处回写（S2）

**现象**
- production 的包自检第 4 项写成等式「镜数 = 对白句数 + 动作镜 + 转场镜，且 ≈17–18」（`skills/short-drama-series-production/references/episode-package.md:194`），但预算公式允许 `对白句数 < 对白镜数`（`:60`）。两者不等价：一旦同镜连说 2–3 句，`镜数 ≠ 句数 + 动作 + 转场`，第 4 项必然判错。
- story 允许在 STEP 5.5 因句长超限而**拆镜**（`skills/story-short-generator/SKILL.md:549`），拆镜改变镜数/时长；但 production 没有任何「包被下游改动 → 回写 ① 目标时长 / ⑥ 成本估计 / state」的规则（§8.3 只要求回写 stage/clipNodeIds/costMinutes，`:246`）。
- production 的「剧本改集」处置只写重生成包 + 门 1/2 + 重渲（`:343`），不涉及「下游拆镜后包失效」。

**影响**：包里的数字（镜数、目标时长、成本估计）在进入 story 后即失效，但仍被当作系列层台账依据（`:253` 的成本台账、`:330` 的交付清单）。真实项目 EP01 的 105.8s 没有任何规则要求回写 `episodeSecondsException`——它是人工补的（`.dsh-assets/绛珠泪-交付包/series/production-state.json:7-9`），skill 文本里没有这个字段（`skills/short-drama-series-production/SKILL.md:118-136` 的草案无 exception 字段）。

**建议**：包增加「镜数/时长偏差」回写义务：STEP 5.5 通过后若 `实际镜数 ≠ 包预算` 或 `实测算长 > 包目标 ×1.1`，必须回写包 ① + state，并在 G-E 门报告偏差。

---

## 3. 目录、编号与状态文件

### C4 · 集编号三套写法，路径两层同名（S2）

**现象**
- writer：文件 `episodes/ep{NNN}.md`，**三位数补零**（`skills/short-drama-series-writer/SKILL.md:356`），目录树示例 `ep001.md`（`:22`），导出 `ep001-{标题}.md`（`:32-34`、`:433`）。
- production：分集剧本写 `episodes/epNNN.md`（`skills/short-drama-series-production/SKILL.md:107`、`:31`、`:84`），包写 `series/episodes/epNNN/package.md`（`:112`），但 state 的键是 **`ep01`**、`next` 是 **`ep02/package`**（`:130`、`:135`）；runbook 与模板标题又用 **`EP003`**（`references/production-runbook.md:13`、`:22`；`references/episode-package.md:11`、`:71`）。
- story：命中标志写 `EP0xx`（`skills/story-short-generator/SKILL.md:205`），glob 写 `**/series/episodes/epNNN/package.md`（`:207`）。
- 项目根有两层同名目录：`episodes/`（剧本，writer）与 `series/episodes/`（包，production）（`skills/short-drama-series-production/SKILL.md:107`、`:112`）。

**影响**
- state 里 `ep01` 与目录 `ep001/` 不同构：续跑按 state 拼路径会生成 `series/episodes/ep01/package.md`，与 writer 的 `ep001` 体系分裂；story 的三级查找和 `asset` 命名也会随之摇摆。真实项目统一用了三位（`.dsh-assets/绛珠泪-交付包/series/episodes/ep001/package.md`），但那是 agent 自作主张，**文本没有规定**。
- `episodes/` 与 `series/episodes/` 只差一层，人工/agent 都可能读错源（读包当剧本、或反之）。

**建议**：写死一套：`EP{三位补零}`，`state.episodes["ep001"]` 与目录名同构；`series/episodes/` 改名为 `series/packages/` 彻底避开与根 `episodes/` 的歧义。

### C5 · 两份状态文件字段重叠、无同步规则，writer 的状态只写一次（S1）

**现象**
- writer：`.drama-state.json`，字段 `currentStep / genre / audience / tone / totalEpisodes / completedEpisodes / language / mode / dramaTitle`（`skills/short-drama-series-writer/SKILL.md:42-53`）。**全文件只有一处写入点**：`/start` 汇总后保存（`:100`）。恢复进度靠「检查项目目录下是否已有创作产物」而非读 state（`:39`）。
- production：`series/production-state.json`，字段 `series{} / assets{} / episodes{} / next`（`skills/short-drama-series-production/SKILL.md:118-136`），每次推进都更新（`:116`），并规定「跨会话只靠两样东西：`series/` 目录 + 资产库」（`:100`）——**没有 .drama-state.json**。
- 重叠字段至少 5 个：`mode`（writer: `domestic|overseas` vs production: `domestic`）、`totalEpisodes` ↔ `series.episodes`、`completedEpisodes` ↔ `episodes[*].stage`、`dramaTitle` ↔ `series.title`、`language` 只在 writer 有（production 无对应）。
- 两边都没有「谁读谁」的规则；production 的路由规则里也没有「先读 .drama-state.json」。

**影响**
- writer 的 `completedEpisodes` / `currentStep` 永远停在初值（`/plan`、`/characters`、`/outline`、`/episode`、`/export` 均未要求写状态，`:100` 是唯一写入点）→ 该文件不可信。
- 集数/模式/标题改一次要改两处，且改一处不会报错；续跑时两个「进度」会给出不同答案，而 production 的断点续跑只读自己的 state（`:219`、`references/production-runbook.md:113`）。
- 与 research 的「三权威、不一致就停在门」（`docs/short-drama-series-integration-research.md:219-224`）相反：这条权威链**没有落进任何 skill**（production 全文只有 `:100`、`:163` 的「唯一真相」散句）。

**建议**
1. 明确单一进度权威 = `series/production-state.json`；`.drama-state.json` 降级为「剧本创作阶段局部状态」，并补上 `/plan`…`/export` 的写入点。
2. 在 production §8.1 第 1 步加「一致性检查」：`production-state.series.episodes` 与 `.drama-state.totalEpisodes`、`episodes[*].stage` 与 `completedEpisodes` 不符 → 停在 G-S/G-B 门问用户。
3. 把 research §5.4 的四条权威链（剧本=文件 / 生产=画布 / 进度=state / 不一致停在门）**原样**写进 production SKILL。

---

## 4. 8 列镜头意图 → 7 列镜头表

### C6 · 映射表存在但只在 production 的 reference 里，且三列不可机械映射、六类字段缺失（S1）

**现象**
1. **映射表只在 production 侧，story 正文零认知**：映射表在 `skills/short-drama-series-production/references/episode-package.md:40-50`、节拍→Hook 在 `:155-166`；production SKILL 只在覆盖表里一句「用 8 列镜头意图生成七列镜头表；`续接` 按实际场景边界重定；台词逐字」（`skills/short-drama-series-production/SKILL.md:233`）。story 全文没有「8 列」与「镜头意图」作为输入的说明（grep `镜头意图` 仅命中 `skills/story-short-generator/SKILL.md:906` 的终检项「镜头意图清晰度」）；它对集制作包只声明读 ⑥（`:213`、`:218`），七列定义在 `:506`。
2. **story 的入口只声明读 ⑥**：`skills/story-short-generator/SKILL.md:213` 写「读包 ⑥ 预填表 → canvas_set_state 落地 → 从 STEP 3 起」，也就是说 ③ 对白表、④ 8 列、⑤ 资产清单的读取点**没有被声明**；而 STEP 3 需要 ⑤、STEP 5 需要 ④（`:312-323`、`:500-506`）。按文本执行，agent 只拿到「十项参数+80 列」的一半信息。
3. **三处不可机械映射**：
   - 列 8 `集内节拍` → 七列 `Hook 类型`：映射是多对多（钩子→setup/suspense；危机→chase/suspense；💰卡点→suspense/reversal，`references/episode-package.md:157-166`），且 story 的受控词表有 10 个值（`skills/story-short-generator/SKILL.md:524`），其中 `visual-joke`、`expression-beat`、`climax` **在映射表里没有任何来源** → 三个合法 Hook 值只能靠 agent 自创。
   - 列 7 `续接意图` → 七列 `续接` 三值：词面不一致（`转场` vs `锚定 S0x↔S0y`，`references/episode-package.md:37` vs `skills/story-short-generator/SKILL.md:513-517`），且 reference 自认是「**建议值**，最终由生产层按场景边界定」（`references/episode-package.md:37`）——判定需要「邻居镜已批准、已存在」的状态（`skills/story-short-generator/SKILL.md:567`），包生成时不可能知道。
   - 列 4 `表演意图` + 列 5 `景别&运镜` → 七列 `镜头描述（每秒指令）`：要求逐秒拆解且每条覆盖 5 要素（`skills/story-short-generator/SKILL.md:525-530`），是生成式而非映射。
   - 列 6 `空间位置` → `参考锚点` 五子字段：列 6 只覆盖「固定地标 + 人物位置」，缺 `退场人物状态` / `光位基线` / `绑定`（`skills/story-short-generator/SKILL.md:518-523`）；reference 承认要「生产层补光位/退场状态」（`references/episode-package.md:47`），但包里没有光位基线来源——场景卡的 `landmarks` 在 state 里只有名字+屏幕位置（`skills/short-drama-series-production/SKILL.md:126`），**无 light 字段**，而 series-bible 模板有「光位基线」列（`references/series-bible.md:62-64`）却没进 state。
4. **交接缺失的字段**（对照 story 的七列要求）：
   - `声线参考 voice:<id>`：包 ③ 无（`references/episode-package.md:88-103` 六列表头 = 序号/说话人/台词/情绪/目标时长/字幕），state.assets 只有 characters/scenes/props（`skills/short-drama-series-production/SKILL.md:123-128`），bible 台账同理（`references/series-bible.md:72-81`）。
   - `音效`：包无，reference 明说要「生产层补口型/音效」（`references/episode-package.md:50`）。
   - `口型`：包无，同上。
   - `字幕`：包 ③ 有列且 ⑥ 规定全 `none`（`references/episode-package.md:144`），但同一文件的映射表又说「生产层补口型/音效/字幕」（`:50`）——**责任重复声明**，且 story 的字幕是 STEP 0 的受控开关（`skills/story-short-generator/SKILL.md:241-246`），包不能单方面决定。
   - `角色卡版本`：⑥ 给 `single`（`references/episode-package.md:180`），⑤ 又同时列 single/three 两个 id（`:132-134`）；story 每镜 `ref_variant` 由 `state.characterCardVariant` 决定（`skills/story-short-generator/SKILL.md:698`）→ 双来源，包里的版本字段实际不参与决策。
   - `参考锚点五子字段`：如上，包侧缺 3 个。

**影响**
- 8→7 列转换每次都是自由发挥，不同集之间不一致；`Hook 类型` 的受控词表会被越界使用，STEP 5.5 第 1 项（`:559`）反而无法机械校验。
- 缺 `声线参考` 直接卡死 STEP 5.5 第 7 项：`audition`/`existing` 方案下 `dialogue` 镜的 `声线参考` 不允许为 `none`（`skills/story-short-generator/SKILL.md:565`），而包里没有 voice id → 每集都要回 STEP 3.5 重做（见 C7）。
- 缺 `音效`/`口型` 使「音频与对白轨」列（`:531-538`）只能由 agent 从零编，跨集不可比。

**建议**
1. 把 8→7 映射**搬到 story 的 STEP 5 一节**（或两边都写同一份），标注哪三列是「建议值/生成式」。
2. 给 Hook 映射补全 10 值（新增 `visual-joke`、`expression-beat`、`climax` 的来源，或把这三个从受控词表删掉——二选一，别留悬空）。
3. 包 ③ 扩列：`声线参考`（`voice:<id>` 或 `none`）、`音效`、`口型提示`；字幕列保留但显式标注「由 ⑥ 的项目字幕开关决定，本列仅抄写」。
4. ⑤ 增加 `光位基线`（或直接引用场景卡节点描述），并把 `variant` 从 ⑤ 移到 ⑥ 单点声明。
5. 在 story 的连续短剧入口（`:213`）把读取点写全：STEP 3 读 ⑤、STEP 5 读 ③④、门 1 复核 ④。

---

## 5. 生产参数预填表（⑥）与 STEP 0 十项

### C7 · 声线是本片型最硬的缺口：production 否认跨集音色可统一，而 story 有完整 voice 管线（S1）

**现象**
- story 把声线做成**强制门控**：`audioMode=dialogue-led` 或出现对白时「门控必须作答，不许跳过、不许由 AI 默认」（`skills/story-short-generator/SKILL.md:233-234`），三选一 `audition/existing/text-only`（`:235-239`），并有 STEP 3.5 全流程（试镜→`extract_audio`→入库 `voice:`→声线清单→STEP 7 `audio_ref_nodes` 必传）（`:373-453`、`:719-721`）。
- ⑥ 预填表**没有「声线方案」这一项**：`references/episode-package.md:172-183` 只有 10 行（风格/比例/时长/音频模式/字幕/视频档位/角色卡版本/图片档位/交付画质/审查节奏）；`skills/short-drama-series-production/SKILL.md:294` 称「第 1 节十项」，而 §1 表实际 12 行且同样无声线（`:48-61`）。
- 资产台账没有声音槽位：state.assets 只有 characters/scenes/props（`skills/short-drama-series-production/SKILL.md:123-128`），bible 台账也只有角色/场景/道具（`references/series-bible.md:72-81`），⑤ 资产清单同样三类（`references/episode-package.md:130-140`）。
- production 反而下了相反结论：「**音色**：AV 模型自带声音，跨集音色**无保证**；需要统一音色只能后期配音（**当前无 TTS 能力**）」（`skills/short-drama-series-production/SKILL.md:315`）；§14 边界再次「不做配音克隆」（`:353`）。

**影响**
- 按 story 的「只补问包里缺的项」（`skills/story-short-generator/SKILL.md:218`），**声线方案会在每一集被重问一次**——80 集就是 80 次同一决策；若默认选 `audition`，每集还要重跑试镜（`:406-453`，≈166s/条 + 人工听核）。
- 反过来，若 agent 严格照 production §11.6 执行（跨集音色无保证），story 的 `voice:` 资产就等于白建；而「无 TTS 能力」的说法与 story 的 voice 管线（`extract_audio` + `audio_ref_nodes`）矛盾，交付说明会误导用户接受音色漂移。
- 声线变动会连锁重渲该角色全部对白镜 + 续接下游（`:453`、`:960`），在 EP005 才发现声线不统一的代价是全链重来。

**建议**
1. ⑥ 增加第 11 项「声线方案：`audition` / `existing` / `text-only`」，并规定**整季一次性在 G-A 门锁定**（与角色卡同门）。
2. `production-state.assets` 增加 `voices[]`（`character / voiceAssetId / source / 试镜节点 / tier / seed / episodes`），bible 台账增加一行类型 `声线`。
3. ⑤ 资产清单增加「声线」小节，带 `voice:<id>`；包 ③ 引用它。
4. 改写 §11.6：AV 模型自带音色默认不保证，但**可用 `voice:` 参考音频统一（story STEP 3.5/7）**；「无 TTS」只限制「生成新音色」，不限制「复用参考音色」。

### C8 · ⑥ 覆盖面完整但有三处悬空：声线方案、groupOrder、分镜模式（S1）

**现象**
- ⑥ 的 10 项与 story STEP 0 的 10 项能一一对上（`references/episode-package.md:172-183` ↔ `skills/story-short-generator/SKILL.md:941`）：风格/比例/时长/音频模式/字幕/视频档位/角色卡版本/图片档位/审查节奏/交付画质 ✔。
- 缺项一：**声线方案**（story 的必答门，`:233-239`）不在 ⑥，见 C7。
- 缺项二：**groupOrder**（story 在 STEP 0 同一次调用里声明 10 组，`:271`、`:291`；production 自己另有一套，`:63-73`），见 C9。
- 缺项三：**分镜模式**（单文本 / 单文本+铅笔图，story STEP 6 门，`:578-583`）不在 ⑥；连续短剧路径下 STEP 1/2 被跳过（`skills/short-drama-series-production/SKILL.md:231`），项目简报只剩「本集简报」一页，分镜模式没有落点。
- 「五项没有 state 字段」（`skills/story-short-generator/SKILL.md:271`：交付画质/视觉风格/图片档位/字幕/声线方案）依赖**项目简报**回读；而连续短剧路径里 STEP 1 被替换成「只写一页本集简报」（`skills/short-drama-series-production/SKILL.md:231`），**没有任何规则要求这一页必须承载这五项**。⑥ 覆盖了其中 4 项，声线方案落空。
- 另外 `skills/short-drama-series-production/SKILL.md:294` 的「第 1 节十项」指代不明：§1 是 12 行（`:48-61`，多出「集数」「每集场景数」、缺「音频模式」），③「十项」实际对齐的是 story 的十项，不是 §1。

**影响**：每集开局要么重问（违反「不许再向用户逐项问十项」，`:230`），要么由 AI 默认（违反「声线方案不许 AI 默认」，`skills/story-short-generator/SKILL.md:234`）。交付画质/字幕若在「本集简报」里丢失，STEP 8 的超分与字幕核对就会走错分支（`:872-891`、`:908`）。

**建议**：⑥ 扩到 12 项（+声线方案 +分镜模式），并把「本集简报必含五项无 state 字段」写成 production 8.1 第 5 步的硬要求；同时修正「第 1 节十项」这句指代。

---

## 6. 画布分组与会话初始化

### C9 · 每集会话的分组清单 production 写 9 个、story 写 10 个，且双方都能覆盖 groupOrder（S1）

**现象**
- story 声明 10 组：`story planning / character cards / voice auditions / scene cards / prop cards / shot table / text storyboards / shot prompts / shot clips / final delivery`（`skills/story-short-generator/SKILL.md:291`、`:930-932`）。
- production 两处写「story 的**九个**分组」且清单里**没有 `voice auditions`**：`skills/short-drama-series-production/SKILL.md:143-145`、`:72`；`references/production-runbook.md:22-23` 的开场 `canvas_set_state(...)` 同样只有 9 个。
- 谁声明：两边都声称由自己声明——production §1「开场必须用 canvas_set_state 一次写全（主会话与每集会话各写一次）」（`:63`）、runbook「开场先做的三件状态写入」（`references/production-runbook.md:17-24`）、story STEP 0「同一次调用一并传 groupOrder」（`skills/story-short-generator/SKILL.md:271`）、连续短剧入口「读包 ⑥ → canvas_set_state 落地」（`:213`）。
- `canvas_set_state` 对 `groupOrder` 是**整体替换**（`lib/index.js:3902-3904`：传入数组直接用，不合并）；未声明的分组排在已声明分组之后、按首次出现排序（`lib/index.js:159`、`studio/app.js:1044-1045`）。

**影响**
- 每集会话至少两次写同一批设置，**后写者胜**；因为两处清单不同，谁最后写决定 `voice auditions` 是否被声明。若 production 后写：试镜片段/声线样本/声线清单漂到画布末尾（不报错，但验收时找不到）；若 story 后写：production 声明的 9 组被替换。
- 只要该集走 `audition`（story 默认，`:376`），这个冲突**每集都会发生**。
- 主会话 4 组（`skills/short-drama-series-production/SKILL.md:141-142`）与每集 10 组是两套独立词表，而「阶段 C 资产锁定」被允许放在「主会话**或**首个集会话」（`:85`）——若在主会话做卡片，卡片会落进 4 组词表里没有的组，只能吃「未声明排末尾」。

**建议**
1. 分组清单**只由 story 定义一份**（10 组），production 引用它、不再自写；或 production 自己那份也改成 10 组并删除「九个」。
2. 明确「每集会话的 `canvas_set_state` 只由 production 在开场写一次；story 进入时 `canvas_get_state` 校验、发现缺失只告警不重写」。
3. 阶段 C 的落点二选一定死（主会话 or 首个集会话），并给主会话也声明 story 的卡片组（否则资产物化无处安放）。

### C10 · 双向入口形成「story → production → story」的闭环，重复初始化无仲裁（S1）

**现象**
- story 门 0：选「连续短剧」→ 三级查剧本 → 有圣经+包则 `canvas_set_state` 后从 STEP 3 起；只有剧本或缺包则**加载 production**，补完「回本 skill STEP 3」（`skills/story-short-generator/SKILL.md:194-216`）。
- production 路由规则 4：由 story 的 STEP 0 转入时「视为连续短剧已确认，不再重复问片型，直接接住它查到的剧本/集制作包（没有就按本 skill 阶段 A/B 产出），完成后**交回它**做单集生产」（`skills/short-drama-series-production/SKILL.md:40`）。
- 覆盖表：production 委托时 STEP 0 用 ⑥ 直接落地、不许再问十项（`:230`）；story 反向声明「由 production 委托进来时跳过门 0」（`skills/story-short-generator/SKILL.md:220`）。
- 优先级只有**单向**一条：story 说「与 production 冲突时以它为准」（`:218`）；production 侧没有对应的「以谁为准」条款（全文仅 `:163` 说圣经是唯一真相、`references/episode-package.md:185` 说预填表是唯一来源）。

**影响**
- 闭环本身可控（两处都写了「跳过片型门」），但**初始化职责没有裁决**：state 的 7 个字段（aspectRatio/duration/audioMode/mode/characterCardVariant/reviewMode/groupOrder）由谁写、写哪些、写几次，三处文本都声称拥有（production `:63`、runbook `:17-24`、story `:213`/`:271`）。除 `groupOrder`（9 vs 10）与 `duration` 格式（`"90 秒"` vs `"90s"`）外值相同，所以冲突是**静默**的——没有任何一步会报错。
- 更糟的是 production **只写不读**：其 SKILL 与 references 里 `canvas_set_state` 出现 5 次（`:63`、`:141`、`:151`、`:230`、runbook `:20`），`canvas_get_state` **零次命中**。而 story 在 STEP 7 渲染前必须读回 `reviewMode` 与 `characterCardVariant`（`skills/story-short-generator/SKILL.md:690`、`:698`）——会话中途任何一方再写一次，story 读到的就是被覆盖后的值，且没有校验步骤会提示「设置被改过」。
- 若两个 skill 都被完整加载，两套「开场必做」会同时触发（production 8.1 五步 / story STEP 0 选项卡组），人工门的数量与顺序取决于 agent 先读哪份，不可复现；research 已指出这正是「两个 skill 的开场选项卡互相打架」的风险（`docs/short-drama-series-integration-research.md:151`、`:200`）。
- 反向委托路径（story → production → story）里，production 的阶段 A/B 会带上 G-S/G-B 两道门，story 又要求 STEP 1/2 只写「本集简报」——但 `门 0 → production 阶段 A→C` 的返回点写的是「回本 skill STEP 3」（`skills/story-short-generator/SKILL.md:214`），等于跳过了 story 自己的 STEP 1/2 选项卡（简报/大纲确认），属**声明冲突**而非功能冲突。

**建议**
1. 写一份「初始化归属表」并两边各贴一次：`canvas_set_state` → production（每集会话开场一次，10 组）；`asset_list/asset_to_canvas` → story；`package.md` 读取 → story(⑥+③④⑤)；`production-state.json` → production 独占。
2. production 增加对偶条款：「由 story 门 0 转入时，本 skill 只负责阶段 A/B/C 与状态文件；单集生产一律交回 story，不由本 skill 直接执行 STEP 3–8」。
3. 把 research §5.4 的权威链原样落进 production（见 C5）。

---

## 7. 门与流程口径

### C11 · 唯一的交接物没有人工批准门（S1）

**现象**
- production 的门表只有 G-S / G-B / G-A / G-SAMPLE / G-E / G-F（`skills/short-drama-series-production/SKILL.md:83-88`），**没有「集制作包批准」**。
- 每集 SOP 是「第 4 步建包 → 第 5 步委托生产」（`:222-223`），中间无 ask；覆盖表还写「用 ⑥ 预填表直接落地」（`:230`）。
- 包里只有 AI 自检 10 项（`references/episode-package.md:189-202`），全过即进生产层。
- research 原本要求把「集制作包确认 + STEP 0 十项预填」**合并为一张卡**（`docs/short-drama-series-integration-research.md:296`）。

**影响**：包里的台词、镜数预算、资产清单（决定了 ~70 min/集的生成成本，`skills/short-drama-series-production/SKILL.md:261-268`）没有任何人工确认就开跑；改包代价高（「改剧本 → 重生成包 → 重跑门 1/2 → 重渲」，`:343`）。

**建议**：在 8.1 第 4 步后加 **G-P（集制作包门）**：一张卡展示 ① 目标时长/镜数、③ 对白句数、⑤ TO-BUILD 数、⑥ 预填参数、成本估计；选项「批准并开渲 / 改包某节 / 只渲 1 镜试片 / 回改剧本」。这一道门每集 1 次，与 `batch` 审查节奏兼容。

### C12 · writer 的「输出级别」与 production 需要的产物不对齐，且不在 production 门表里（S2）

**现象**
- writer 写单集前必须确认「本轮输出级别：剧情初稿 / 拍摄制作稿 / **分镜制作包**」（`skills/short-drama-series-writer/SKILL.md:259`）。
- production 委托时只说「跑 `/start` → `/plan` → `/characters` → `/outline`」（`:152`）、批量「`/episode 1-10`」（`:171`），**从不指定输出级别**；同时要求「每集只落到本 skill 需要的三件事：场次（压缩到 1–2 个物理场景）、逐字台词、集尾钩子（`:172`）」。
- 这道 tab 不在 production 的门表（`:83-88`），但会真实弹出（writer 硬规则「每个阶段至少提出 1 组关键选项」，`:609`）。

**影响**：选「剧情初稿」→ 无场次/镜头信息，包 ②④ 只能凭空造；选「分镜制作包」→ 生成 12 镜分镜稿（`:343`），与 17–18 镜冲突（C2）并触发 C1 的双包问题。门计数也不一致（production 说每集一道 G-E，实际多一次创作取向确认）。

**建议**：production §5 写死「委托 `/episode` 时输出级别固定为『拍摄制作稿』」，并把该 tab 并入 G-B；或让 writer 在「被 series 总控委托」时跳过输出级别询问（与它已有的「用户说按默认就按既有标准」`:259` 一致）。

### C13 · 转场镜档位：story 要求成片用 `quality`，production 要求整季同一档 `balanced`（S2）

**现象**
- story：转场镜「`length` 走 17k+5 网格…**成片一律用 `quality` 档重出**，`fast` 只用于验证链路」（`skills/story-short-generator/SKILL.md:851`）；同处又说转场镜「不参与续接链，所以不受『链内首遍尺寸一致』约束」（`:852`）。
- production：视频档位锁 `balanced`（`skills/short-drama-series-production/SKILL.md:55`），档位闸「整季同一档（`balanced`）；**不要混档**」（`:276`）；runbook 的转场镜示例也用 `tier="balanced"`（`references/production-runbook.md:80-81`）。

**影响**：两条规则不能同时满足。若照 story 升 quality：长边同为 1344、拼接能过、观感一致（`:869` 自述 balanced/quality 长边相同），但违反 production 的「整季同档」闸门，且成本从 ≈177s 涨到 ≈395s/镜（`:706`）；若照 production 保持 balanced：违反 story 的「成片一律 quality」。行为取决于 agent 读到哪条。

**建议**：把 story `:851` 改为「成片用**与正片同档**重出（本片型 = `balanced`），quality 仅在正片整季升档时跟随」；或在 production §8.3 显式声明「本片型覆盖 story 的转场 quality 要求」。

### C14 · 「角色卡引用版本」的推荐相反（S3）

**现象**：story 在 `balanced`/`quality` 下**推荐三视图**（`skills/story-short-generator/SKILL.md:85`、`:249`）；production 对本片型（9:16 竖屏）明确「`three` 在 9:16 下**未实测**；要试就只在样片集试，别整季混用」并锁 `single`（`skills/short-drama-series-production/SKILL.md:57`）。

**影响**：委托路径由 ⑥ 压住（`single`）→ 无实际冲突；但用户**直接进 story** 做竖屏短剧（未经 production）时会选到 three，而该组合无实测依据。属「默认值不一致」，会误导。

**建议**：story 的推荐项按画幅收窄：9:16 时推荐 `single`（理由引用 production 的未实测结论）。

### C15 · 「插件不能生成 BGM」已过期（S3，跨 skill 与插件契约）

**现象**：story「**无 BGM**：注册表当前没有 `audio.music` 工作流，插件不能生成配乐」（`skills/story-short-generator/SKILL.md:870`）；production §12「**插件不能生成 BGM**，必须后期贴」、§14「不生成 BGM」（`skills/short-drama-series-production/SKILL.md:326`、`:353`）；research 也这么记（`docs/short-drama-series-integration-research.md:131-133`）。但插件已提供 `audio.music` 能力与 `comfy_generate_music` 工具（`lib/manifest.js:36`、`lib/index.js:3920`、`:3948`）。

**影响**：两份 skill 强制每集交付一张「配乐点单」并声明能力缺失，白白多一道人工；若用户主动要求 BGM，skill 会拒绝。

**建议**：改为「BGM 默认不生成；需要时用 `comfy_generate_music`（能力 `audio.music`）按配乐点单生成，或后期贴」；交付清单从「未落地项」降级为「可选点单」。

---

## 8. 产物读写矩阵（回答「谁写谁读」）

> 表内简写约定：`写入者` 列里的裸 `:行号` 指该 skill 的 `SKILL.md`（writer / production / story 按名字判断）；`runbook` 指 production 的 `references/production-runbook.md`。

| 产物 | 写入者 | 读取者（文本规定） | 契约状态 |
|---|---|---|---|
| `creative-plan.md` / `characters.md` | writer（`:145`、`:198`） | production 不读；story 不读 | 仅 writer 内部用 |
| `episode-directory.md` | writer（`:236`） | production 读「分集目录该行」（`:220`）；story 间接 | ✔ 已规定 |
| `episodes/epNNN.md` | writer（`:356`） | production 读（`:220`）；story 由 production 转述 | ✔ 已规定 |
| `export/{剧名}-完整剧本.md` | writer（`:480`） | 无人读 | 死产物（对外交付除外） |
| `export/episodes-production/*` | writer（`:429-433`） | **无人读**（production 标「可选」`:108`；story 三级查找不含 `export/`，`:205-207`） | C1：同名不同物 |
| `series/bible.md` | production（`:153`） | production 自己 + story 的三级查找命中（`:207`），但 story 入口只说读 ⑥（`:213`） | 读取点不完整 |
| `series/episodes/epNNN/package.md` | production（`:222`） | story 只声明读 ⑥（`:213`）；③④⑤ 的读取点未声明 | C6 |
| `series/production-state.json` | production（`:116`、`:246`） | 只有 production | C5：无对账 |
| `.drama-state.json` | writer，仅 `/start`（`:100`） | 无人读（writer 靠文件恢复，`:39`） | C5：不可信 |
| 画布 `settings`（7 字段） | production（`:63`、`:141`、`:151`、`:230`；runbook `:17-24`）**与** story（`:213`、`:271`） | story 读（`:271`、`:690`、`:698`）；**production 全程不读**（`grep canvas_get_state` 在其 SKILL 与 references 中零命中） | C9/C10：双写、覆盖语义、写完不校验 |
| 资产库（角色/场景/道具/声线） | 用户人工入库（production `:185`；story `:371`、`:445`） | 双方 `asset_list`/`asset_to_canvas` | ✔；但声线无台账槽位（C7） |

---

## 9. 旁证：冲突在真实项目里已经发生（非 skill 文本）

项目 `.dsh-assets/绛珠泪-交付包/`（`production-state.json` 的 `source` 字段指向 `examples/绛珠泪-交付包`，该路径在仓库中已不存在 → 状态文件的来源字段本身也是漂移的）。

1. **两份制作包同时存在**：`06-分集制作包/` 62 个文件（writer 导出的重排版）+ `series/episodes/ep001/package.md`（production 包）→ C1。
2. **数字口径当场打架**：writer 侧产物是「15 个镜头 / 24 句对白」，production 包重排成「**25 镜 / 105.8s**」（`series/episodes/ep001/package.md:3-4`）；bible 把整季规格写成「90s 标准（17–20 镜）| **EP01 例外 105.8s**（源剧本 24 句，一镜一说话人最短排布）」（`series/bible.md:13`），并追加「EP02 起按 90s / ≤20 句对白写」（`:120`）→ C2/C3。这里已经能看出：writer 的 18–25 句与 production 的 90s 无法同时成立，实际做法是**单集破例**，而 skill 文本里没有「破例」这个概念。
3. **state 需要 skill 未定义的字段**：`production-state.json` 出现 `episodeSecondsException`、`imageTier`、`characterCardVariant`、`reviewMode`、`source`、`bible`（`:7-20`），skill 草案（`skills/short-drama-series-production/SKILL.md:118-136`）只定义了 `delivery/aspectRatio/style/tier/subtitles` 等，且 `episodes` 键写成 `ep01`（`:130`）而真实目录是 `ep001` → C4/C5。
4. **⑥ 的十项确实不含声线**：真实包 `:114` 逐项列出「风格 / 9:16 / 105.8s / dialogue-led / 字幕 none / balanced / single / quality / 原生 / batch —— 全部预填」→ C7。
5. **writer 的导出被人工重排成 01–08 编号目录**（`01-创作方案`…`08-项目状态`），与 writer 规定的 `export/episodes-production/` 结构不一致 → 说明该产物的落地形态在生产视角下不可直接用（C1）。

---

## 10. 交接契约最小字段集（建议）

设计原则：**一个包、两处同文（文件 + 画布节点）**、**只写「拍什么」**、**每个字段有唯一写入者与明确消费者**、**能机械校验**。

### 10.1 字段表

| # | 字段（JSON 风格） | 必填 | 写入者 | 消费者 | 为什么必须 / 缺失后果 |
|---|---|---|---|---|---|
| 1 | `episode.number`（int）+ `episode.id`（`EP001`） | 必填 | production | 全部 | C4：杜绝 ep01/epNNN/EP003 三写法；状态键与目录名同构 |
| 2 | `episode.title` | 必填 | production | 交付/画布标题 | 无则节点标题不可读，飞书送达文件名退化 |
| 3 | `episode.sourceScript`（路径 + 行范围/集号） | 必填 | production | 剧本一致性终检 | C1/C6：无法证明台词逐字来源 |
| 4 | `episode.targetSeconds` + `episode.shotBudget` + `episode.budgetTolerance` | 必填 | production | story 的 `length` 换算、成本台账 | C2/C3：90s 与 18 镜是唯一可核对的硬数 |
| 5 | `episode.isPaywall` + `episode.mainBeats[]` | 必填 | production | Hook 规划、门 1 | 缺则卡点集无法识别 |
| 6 | `episode.hookType` + `episode.prevRecap` + `episode.nextTeaser` | 必填 | production | story STEP 5/6 | 集尾钩子是 writer 硬规则（`skills/short-drama-series-writer/SKILL.md:346`），story 侧无来源则自创 |
| 7 | `scenes[]`：`id / intExt / location / dayNight / cast[] / event / escalation / sceneAssetId` | 必填 | production | story STEP 4、包 ② | 场次压缩后仍需物理场景 id 才能绑定场景卡 |
| 8 | `scenes[].landmarks[]`（`name:screenPos`） | 条件必填（有场景卡时） | production（抄自场景卡） | 七列「参考锚点·固定地标」 | C6：地标名是锚点列的唯一可核对来源 |
| 9 | `scenes[].lightBaseline` | 条件必填 | production（抄自场景卡） | 七列「光位基线」 | C6：包侧无光位 → 生产层自行编造 |
| 10 | `dialogue[]`：`no / speaker / text（逐字）/ emotion / targetSeconds` | 必填 | production | 包 ③→④、STEP 5 音频轨 | 逐字是「不许改台词」的唯一依据（`skills/short-drama-series-production/SKILL.md:233`） |
| 11 | `dialogue[].subtitle`（文本或 `none`） | 必填 | production（受 ⑥ 字幕开关支配） | STEP 5.5 第 7 项、门 3 | 责任重复声明（C6），需指定唯一决定者 |
| 12 | `dialogue[].voiceRef`（`voice:<id>` 或 `none`） | 条件必填（对白镜） | production（整季锁定） | STEP 5 `声线参考`、STEP 7 `audio_ref_nodes` | C7：缺则 STEP 5.5 第 7 项必卡，每集重做试镜 |
| 13 | `dialogue[].sfx`（时间锚点 + 描述） | 可选 | production | STEP 5 音频轨 | 缺失时音效全靠 agent 编，跨集不可比 |
| 14 | `shots[]` 8 列：`shotId / seconds / sceneId / speaker / line / performance / shotSizeCamera / screenPositions / chainIntent / beat` | 必填 | production | story STEP 5 → 七列 | C6：这是唯一「拍什么」的结构化载体；缺 `chainIntent` 则续接链规划无从谈起 |
| 15 | `shots[].chainIntent`（`起链/接 Sx/转场`） | 必填（建议值语义须标注） | production | story STEP 5 `续接` 三值 | C6：词表不同、需显式标注「建议，最终由生产层按场景边界重定」 |
| 16 | `assets.characters[]`：`name / state / singleNodeId / threeNodeId / assetIdSingle / assetIdThree / episodes` | 必填 | production（抄资产库） | story STEP 3、每镜 `ref_nodes` | C6：版本 id 与状态卡的唯一来源（story 不再自行选版） |
| 17 | `assets.scenes[]`：`name / assetId / landmarks[] / lightBaseline` | 必填 | production | STEP 4、锚点列 | 同上 |
| 18 | `assets.props[]`：`name / assetId / episodes` | 条件必填 | production | STEP 4.5、`ref_nodes` | 道具一致性终检（`skills/story-short-generator/SKILL.md:912`） |
| 19 | `assets.voices[]`：`character / voiceAssetId / source(audition|existing|text) / auditionNodeId / tier / seed` | 条件必填 | production（G-A 一次锁定） | STEP 3.5、STEP 7 | C7：跨集音色一致性的唯一锚 |
| 20 | `assets.toBuild[]`（缺卡清单，≤2） | 必填（可为空数组） | production | story STEP 3/4/4.5 的「缺卡才建」 | 防止绕过台账另建一套（`skills/short-drama-series-production/SKILL.md:232`） |
| 21 | `params.styleId` | 必填 | production（G-S 锁定） | 每次生成的风格锁 | 风格 id 决定追加哪份锁后缀（`skills/story-short-generator/SKILL.md:69-72`） |
| 22 | `params.aspectRatio / duration / audioMode / subtitleMode` | 必填 | production（G-S 锁定） | `canvas_set_state` | C8/C9：state 字段的唯一来源 |
| 23 | `params.videoTier / imageTier / characterCardVariant / deliveryQuality / reviewMode` | 必填 | production（G-S 锁定） | STEP 0 预填、STEP 7、STEP 8 | 缺则回到逐项追问（违反 `skills/short-drama-series-production/SKILL.md:230`） |
| 24 | `params.voicePlan`（`audition/existing/text-only`） | 必填（有对白时） | production（G-A 锁定） | STEP 3.5 | C7：缺项导致每集重问，且不允许 AI 默认 |
| 25 | `params.storyboardMode`（`text` / `text+pencil`） | 必填 | production | STEP 6 | C8：连续短剧路径下唯一没落点的 STEP 0 相邻决策 |
| 26 | `params.groupOrderVersion` = 10 组清单（常量） | 必填 | **story 定义，production 引用** | `canvas_set_state` | C9：单一词表，避免 9 vs 10 |
| 27 | `budget.estimatedMinutes` + `budget.shotCount` + `budget.dialogueCount` | 必填 | production | G-P/G-E 门、成本台账 | C3/C11：无则成本闸门无可比基准 |
| 28 | `gates.packageApprovedBy/At` + `contentHash` | 必填 | production（G-P 门后） | 续跑、审计 | C11：唯一交接物必须有人工批准痕迹 |
| 29 | `contract.version`（契约版本号） | 必填 | production | 两侧校验 | 现在没有任何版本号，任何字段变更都静默漂移 |

### 10.2 附带的三条硬规则（比字段更重要）

1. **单一声明者**：`canvas_set_state`、`package.md`、`production-state.json` 各只有一个写入者（建议依次：production / production / production），story 只读、只校验、缺失时告警不重写。这样 C9/C10 的静默覆盖直接消失。
2. **包是唯一交接物，且形式化为 schema**：把上表落成 `schemas/episode-package.schema.json`（仓库已有 `schemas/workflow-manifest.schema.json` 的先例），两个 skill 都引用它，story 的 STEP 5 增加「读 ④ 的 8 列 → 校验必填 → 生成七列」的显式步骤；`export/episodes-production/` 明确标注「非生产输入」。
3. **口径覆盖表**：在 production §1 增加一张「本片型覆盖 / 沿用」两列表，把 120s→90s、12/15–20 镜→17–18 镜、18–25 句→句数≤镜数、3–5 场→1–2 物理场景、转场镜档位、角色卡版本默认值六处一次写清；story 的实测硬约束（一镜一说话人、≤15s、≤3 重要角色、续接链、G-ref）标为「不可覆盖」。

---

## 11. 未证实 / 需实测确认

- C9 的「谁最后写」在真实运行中的实际顺序：无运行日志可证，结论基于代码语义（`lib/index.js:3902-3904`）与两处文本都声称「开场写」的并存事实。
- C2 中若严格采用「同一人连说 2–3 句」，18–25 句是否真能压进 90s：未实测；真实项目选择了破例到 105.8s，说明实际操作路径是「破例」而非「压句」。
- C13 转场镜升 quality 对成片观感的影响：story 自述 balanced/quality 长边同为 1344（`skills/story-short-generator/SKILL.md:869`），故拼接可行；但「整季同档」的成本与一致性收益未量化。
- C5 中 .drama-state.json 是否被其他工具（如外部脚本）读写：仅审计 skills，未发现消费者，但未排除仓库外使用。
