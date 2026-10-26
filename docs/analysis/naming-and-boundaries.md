# 三个 skill 的命名、边界与改名成本调研

- 审计对象：`skills/story-short-generator/`（v3.6.1，SKILL.md 976 行，references 10 文件）、`skills/short-drama-series-writer/`（v0.2.0，609 行，references 8 文件）、`skills/short-drama-series-production/`（v0.1.1，355 行，references 3 文件）；三者 references 合计 21 文件 / 3452 行（story 10/846、writer 8/2126、production 3/480）。
- 审计方式：只读（read / grep / git / 宿主安装包源码 / `~/.dsh/skills` 实机状态）。**未调用 skill 工具加载这三个 skill**，未修改任何 skill、代码、文档。
- 证据口径：结论一律给 `文件:行号`。凡属推断而无直接依据的，写「未证实」。
- 计数口径：`grep` 均排除 `node_modules/`、`e2e-out/`、`canvas/`、`.git/`、`.pnpm-store/`、`docs/analysis/`（后者是本轮并行审计产物，写入过程中会自然带上 skill 路径引用，故不计入波及面）。README.md 只报「命中行数」，不贴正文。`.dsh-assets/` 是 `gitignore` 的运行时资产库（`.gitignore:13-14`），不计入源码波及面。
- 本次唯一写入：本文件。

---

## 0. 结论速览

1. **三个名字在事实层面都还站得住**，没有一个像上次「`3d-animation-short-generator` 里写死 3D」那样被现实推翻（那次先例见 `README.md:622-627`）。真正的问题是**三件套不在同一命名族**、以及**最关键的描述段落落在模型看不见的窗口外**。
2. **决定性事实：模型只读得到 `name` + `description` 的前 500 字**（`dsh-tool-skill/lib/index.js:767` `DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH = 500`；`:1087-1090` 截断；`:1021-1023` 目录行只渲染 name + description，**`whenToUse` 不进目录**）。`story-short-generator` 的 description 有 **1150 字**，而「片型」「连续短剧」分别在第 **616 / 636** 字处 —— 模型在技能目录里**看不到**它承接连续短剧单集生产。本会话的技能目录实测正好截在「…**开场还会确认「声线方案」**——有对白」处，与该 500 字预算吻合。
3. ⇒ **改描述的收益远大于改名，而且是必做项**；改名解决不了这条（目录照样只给 500 字）。
4. **改名技术上可行，但宿主没有 alias 机制**：同名技能按 rank 择优 + 告警（`dsh-skill/lib/index.js:114-115`、`:186-188`），插件安装逻辑只认**目录名**（`lib/index.js:4979-4982`），旧目录走**孤儿回收**删除（`lib/index.js:5037-5065`）。旧名无法保留为「同一技能的别名」，只能靠「新名描述里写旧名」或「额外发一个旧名 shim skill」两种软兼容。
5. **推荐方案 A（保留三个 id，只改描述 + 文档标签）**：必须同步改 **6 个文件、10 处**，0 个目录、0 行代码。若一定要动名字，**只改 `short-drama-series-production` → `short-drama-series-producer`（方案 A′，8 文件 / 25 行 / 1 目录）**，收益最高、波及最小。全量家族化（B / C）要 **34 文件 / 142 行 / 3 目录**，且会把「通用故事短片」这名副其实的主线用例错标成「短剧」。
6. 「**不改名只改描述**」结论：**可行，且有充分依据**（名字语义无误、路由由 description 驱动、500 字预算内可完成消歧），但有 3 个前提：① 三个描述的前 500 字重写到能自解释分工与交接；② README 的过期标签「3D 动画短片」修掉；③ 对外部同域 skill（`shortdrama-*`、Hub `short-drama-production`、`film-assets`）加显式排除句。

三个数字：

| 指标 | 值 |
|---|---|
| 推荐方案 A 必须同步改的文件数 | **6**（10 处 = story 描述 1 + 三个 `meta.yaml` 的 summary/desc 6 行 + README 3 行；0 目录 / 0 代码） |
| 若最小改名（A′，只改 production） | **8 文件 / 25 行 / 1 目录**（另 1 行历史 changelog 不改） |
| 若全量改名（B/C，三件套） | **34 文件 / 142 行 / 3 目录**（另有 2 处运行时产物不建议改） |

---

## 1. 现状：名字 — 描述 — 实际职责

### 1.1 三个 skill 实际在干什么（证据）

| skill | 自述定位 | 实际职责（证据） | 体量 |
|---|---|---|---|
| `story-short-generator` | 名字=故事短片生成器（`SKILL.md:2`、`meta.yaml:1`） | ① 通用「一句话故事 → 风格化短片」全流程：简报→大纲→角色卡双版本→声线试镜→场景/道具卡→七列镜头表→自检门→分镜→prompt bank→逐镜→拼接→终检（`SKILL.md:9-25`、`:190-292`、`:860-927`）；② **连续短剧的「单集生产引擎」**——STEP 0 第一道门就是片型二选一（`SKILL.md:194-200`），选连续短剧后按「画布→资产库→工作区」三级查剧本并转 `short-drama-series-production`（`SKILL.md:200-221`）；③ 被反向委托时的入口（`SKILL.md:220`） | 976 行 + 10 refs |
| `short-drama-series-writer` | 微短剧剧集编剧（`SKILL.md:2`、`meta.yaml:1`） | 选题→创作方案→人物→分集目录→单集剧本→自检→合规→出海格式→导出；状态文件 `.drama-state.json`（`SKILL.md:42`、`:100`）；`/export` 强制导出「总文档 + `export/episodes-production/` 逐集制作包 + 索引」（`SKILL.md:419-440`），每集 18–25 句对白、默认 12 镜（`:435-436`）。**只出文本、不调生成工具** | 609 行 + 8 refs |
| `short-drama-series-production` | 短剧系列制片（`SKILL.md:2`、`meta.yaml:1`） | 系列层总控：分工与路由（`SKILL.md:27-44`）、锁定参数、六阶段门 G-S/G-B/G-A/G-SAMPLE/G-E、`series/production-state.json`、资产台账、成本闸门、跨集一致性、每集交付包；产出**集制作包**（`SKILL.md:285-306`，唯一交接物）后把单集生产**委托**给 story 的 STEP 3–8（`SKILL.md:12`、`:223`）。**不拍片、不生成任何视频**（`SKILL.md:350-355`） | 355 行 + 3 refs |

### 1.2 逐个评价：偏差在哪

| # | skill | 名字声称 | 实际职责 | 偏差类型 | 严重度 |
|---|---|---|---|---|---|
| N1 | `story-short-generator` | 故事短片生成器 | 通用短片引擎 **+ 连续短剧单集生产引擎 + 片型路由器** | **描述失焦**（名字本身不算错：它确实在生成「故事短片」，短剧的单集也是短片）；且关键交接信息落在 500 字窗口外（`SKILL.md:616/636` vs 目录 500 字） | **S2**（每集会误导路由） |
| N2 | `short-drama-series-writer` | 系列编剧 | 剧本 + 分集目录 + 状态文件 + 导出「分集制作包」 | 名字准确。真实问题是**产物名撞车**：它导出的 `episodes-production/`「分集制作包」（12 镜口径，`SKILL.md:435-436`；另见 `:340`、`:343` 的创作标准）与 production 的「集制作包」（17–18 镜口径，`SKILL.md:285-306`）同名不同物、且前者**没有任何消费者** | S2（术语层，非 id 层） |
| N3 | `short-drama-series-production` | 系列制片 | L0 系列层 + L1 集层（集制作包），**不拍片** | `production` 在工程师语境里默认读成「生产/出片」，而它明确「不定义拍摄规则、不出片」（`SKILL.md:350-353`）；中文 display「短剧系列制片」比英文 id 更准 | S3（读者困惑，不致命） |
| N4 | 整套 | — | — | **族名不齐**：`short-drama-series-writer` / `short-drama-series-production` 成对，`story-short-generator` 单独在外；而与外部 `shortdrama-*` 家族只差两个连字符（§6） | S3 |
| N5 | 文档侧 | — | — | **名字改了、文档没跟**：`README.md:44/291/295` 仍把第一个 skill 叫「**3D 动画短片**」，而它的 display-name 是「故事短片生成器」（`meta.yaml:1`）、内置 7 套风格（含电影真人写实，`SKILL.md:53-75`）。这是本次调研里**唯一确凿的「名不符实」**，且与是否改名无关 | S2 |

> 关于 N5 的补证：上一轮改名的动因正是「新增真人/吉卜力等风格后『3D』名不符实」（`README.md:626`），但同一次改动只改了 skill 内部与 frontmatter，**README 的场景表没跟上**。也就是说：**文档标签漂移已经是既成事实，与 id 改不改名无关**。

### 1.3 命名风格约束（bundled skill 横向对比）

包内 7 个自带 skill 的命名形状（id 取 frontmatter `name`，中文取 `meta.yaml:display-name-zh`）：

| skill id | display-name-zh | 形状 |
|---|---|---|
| `brand-promo-video-generator` | 品牌宣传短片 | `<场景>-<修饰>-video-generator`（含产物词 video） |
| `story-short-generator` | 故事短片生成器 | `<题材>-short-generator`（无视频/影片类产物词；继承自旧名 `3d-animation-short-generator`） |
| `short-drama-series-writer` | 微短剧剧集编剧 | `<领域>-<层>-<角色>` |
| `short-drama-series-production` | 短剧系列制片 | `<领域>-<层>-<角色>` |
| `video-generate` / `image-generate` | 参考视频生成 / 图片生成 | `<产物>-<动词>`（最短，输入框手动链路专用，`video-generate/SKILL.md:3`） |
| `h3-prompt-writing` | H3 提示词优化 | `<模型>-<对象>-<动名词>` |
| （外部 vendored）`film-assets` | — | `<对象>-<名词>`（用户自装，非本插件 bundle） |

可提炼的硬/软约束：

- **硬约束（宿主语法）**：`^[a-z0-9]+(?:-[a-z0-9]+)*$`（`dsh-skill/lib/index.js:17` `SKILL_NAME`）。全小写、连字符分词、不能有下划线/大写/点。`short-drama-episode`、`short-drama-series-producer` 都合法。
- **硬约束（安装）**：id 必须等于**目录名**，否则安装后目录与技能名两套身份（见 §2.1）。
- **软约束（本仓习惯）**：
  1. 完整片型流程用「**角色/agent 名词**」结尾（`-generator` / `-writer` / `-production`），轻量输入框链路用「**动词**」结尾（`-generate`）。→ 新名不该用 `-generate` 表达全流程。
  2. 有模型绑定时把模型名做前缀（`h3-`）。
  3. 中文 display 一律 **4–7 字名词短语、无标点、以产物或角色结尾**（短片 / 生成器 / 编剧 / 制片 / 优化 / 生成）。
  4. `meta.yaml` **没有 `name` 字段**（全仓 7/7 都没有，见 §2.1），中文名只由 `display-name-zh` 承载。

### 1.4 各 skill 的候选菜单（只列，不推荐全采纳）

| skill | 候选 | 评价 |
|---|---|---|
| `story-short-generator` | 保留 / `short-film-generator` / `story-film-generator` | 改名收益低：`short` 已表达短片；换成 `short-film-` 只是把隐含词显式化。若未来把「连续短剧单集生产」拆成独立 skill，才轮到它改名 |
| `short-drama-series-writer` | 保留 / `short-drama-writer` | 保留：`series-` 明确它写整季，且与 production 成对 |
| `short-drama-series-production` | 保留 / `short-drama-series-producer` / `short-drama-showrunner` | `-producer`（制片）语义最准：管圣经/包/台账/成本/交付，不管拍摄；`showrunner` 更准但业内黑话 |

---

## 2. 改名可行性的机制层事实（先看机制，再谈方案）

### 2.1 「四处身份」实为「两处功能性 + 两处文案」

任务里假设的四处 `frontmatter name / meta.yaml name / .dsh-studio-manifest name / 目录名`，实测是：

| 位置 | 是否承载身份 | 谁在读 | 结论 |
|---|---|---|---|
| **目录名** `skills/<name>/` | **是（安装键）** | 插件安装逻辑：按目录名复制到 `~/.dsh/skills/<name>`（`lib/index.js:4979-4988`、`:5073-5074`），并按目录名做孤儿回收（`:5037-5065`） | **必须与新 id 一致**：目录名是安装键，frontmatter name 是路由键；两者不一致时功能能跑，但 `~/.dsh/skills/<目录>`、文档路径、`/手势` 会指向两个不同的名字 |
| **`SKILL.md` frontmatter `name`** | **是（宿主键 + `/slash` 手势 + 模型目录显示名）** | 宿主解析：`name`/`description` 缺一即拒（`dsh-skill-filesystem/lib/index.js:682-690`）；目录行只渲染 name + description（`dsh-tool-skill/lib/index.js:1021-1023`）；`/name` 手势语法见 `dsh-tool-skill/lib/index.js:1101` | **必须改**；且跨 skill 的「加载 `X`」指令靠它才解析得到 |
| `meta.yaml` | **否** | 宿主**完全不读** `meta.yaml`（在 `@deepseek-ai/*` 里 grep `meta.yaml` 零命中）；它只供 Hub/技能中心展示（`display-name-zh` / `tags` / `summary-*` / `desc-*`） | **没有 `name` 字段**（全仓 7/7 无），所以「meta.yaml name 同步」这一项不存在；要改的是 `desc-*` / `summary-*` 里的**文字提及** |
| `.dsh-studio-manifest` | **否（来源标记）** | 源码树里的这份是**静态说明**（`name:` + 中文名注释，如 `skills/story-short-generator/.dsh-studio-manifest:4-5`）；真正生效的是安装时**重写**的版本戳（含 pluginVersion / contentHash / installedAt，`lib/index.js:4922-4935`、`:4988`） | 改不改都不影响功能；但不同步会在源码里留下自相矛盾的说明，**建议同步**（2 行/个） |

> 补充：`image-generate/SKILL.md` **完全没有 frontmatter**（首行是 `# 图片生成（image-generate）`），靠目录名 + 宿主宽松解析活着 → 说明本仓对「frontmatter name」的执行并不严格；但**改名时它才是路由真正依赖的键**，不能照抄这个例外。

### 2.2 安装 / 刷新 / 回收的完整逻辑（`lib/index.js`）

- 唯一分发实现：`syncBundledSkills()`（`lib/index.js:4963-5067`），源 `packageRoot/skills`，目标 `~/.dsh/skills`（`:5073-5074`）。**没有「bundled skill 清单」文件** —— 直接 `readdirSync(srcRoot)`（`:4979`），所以增删改名=纯目录操作，`package.json` 的 `files` 只写了 `"skills"` 目录（`package.json:51-61`），不用改。
- 四种目标态（注释 `lib/index.js:4966-4973`）：
  1. 带戳 + 哈希未变 → 内容不同就**刷新**（删旧拷新 + 重写戳，`:5019-5024`）；相同则只补戳（`:5026-5032`）。
  2. 带戳 + 哈希变了（用户改过）→ **不覆盖**，记 `keptUserEdited` 并打印取新版指引（`:5010-5018`、`:5081-5087`）。
  3. 带戳但无哈希（旧版安装）→ 与源一致则补戳，不一致按「用户改过」保守处理（`:5014-5018`）。
  4. **不带戳**（用户自装同名）→ **永不覆盖**，记 `conflicts` 并给合并指引（`:4993-5005`、`:5100-5105`）。
- 孤儿回收（**改名专用路径**）：目标端带本插件戳、但源 bundle 里已无同名目录 → 删除（`:5037-5065`）；注释写明动机就是「改名/下线时必须清旧目录，否则新旧触发词打架」（`:5038-5040`）。安全底线：**无戳永不删**；**用户改过的孤儿默认也不删**，只提示（`:5055-5057`、`:5094-5098`），`DSH_SVS_SKILL_REFRESH=force` 才强删。
- `DSH_SVS_SKILL_REFRESH=off` 时：既不全量刷新也不做回收（`:5007`、`:5041`），旧目录会**永久残留**。
- 本机实况：`~/.dsh/skills/` 里八个目录，其中七个带戳、`film-assets` 无戳（用户自装）；本插件装的三份与仓库内容 `diff` **一致**（仅版本戳差异），戳里写 `pluginVersion: 1.13.0`，而仓库 `package.json` 是 `1.14.1` → **下次启动会刷新**。⇒ 在本机做改名，三份旧目录属于「未改过」→ 会被**自动回收**，不会留脏。

### 2.3 用户已装目录会怎样（按情形给结论）

| 用户侧情形 | 升级到改名版后 |
|---|---|
| 没改过自带副本（绝大多数） | 旧目录被**孤儿回收自动删除**，新目录安装；日志 `已回收下线/改名的自带 skill：…`。干净，无需手动操作 |
| 改过旧副本（自己加过规则） | **新旧并存**：旧目录保留 + 警告「已下线/改名，但你的副本被改过」；用户必须自己删，否则两个技能抢触发词 |
| 旧名目录是**别处装的同名 skill**（无戳） | 旧目录**永不删**（不是我们的）；同时新名若与它撞名，我们的会被记 `conflicts` 且**不覆盖** → 需要用户先删 |
| 设了 `DSH_SVS_SKILL_REFRESH=off` | 旧目录永不回收，长期双份；日志也不提示 |
| 用 `npm pack`/离线包手动拷的用户 | 不经过安装逻辑，旧目录永久留在 `~/.dsh/skills/` |

### 2.4 alias 是否可行：**没有原生 alias**

- 宿主技能注册表**没有 alias / 别名 / deprecated-by 字段**；`invocation` 只有 `model-invocable` / `user-invocable` 两个语义开关（`dsh-skill-filesystem/lib/index.js:853-860`），没有名称别名。
- 同名双目录不算 alias：同一层内同名**先到者胜**，重复者只记一条 warning 并拿到 no-op disposer（`dsh-skill/lib/index.js:186-188`）；跨层则「最近的层整条胜出」（`:114-115`）。⇒ 写两个 `name: story-short-generator` 的目录，只会有一个生效，另一个只留一条 warning 后被丢弃。
- 因此「旧名兼容」只有三种现实做法：

| 做法 | 机制 | 代价 |
|---|---|---|
| **① 描述内别名（推荐，零成本）** | 在新名的前 500 字描述里写一句「（原 `<旧名>`：…）」。用户/历史会话提到旧名时，模型能在目录里看到这个字符串，从而命中新名 | 占描述预算；需要保留一个版本周期后再删 |
| ② 旧名 shim skill | 额外发一个 `skills/<旧名>/SKILL.md`，正文 10 行「本技能已改名为 `<新名>`，请加载 `<新名>`」 | 永久占一个目录与一条目录行；安装逻辑会把它当正常 bundled skill 安装并加戳（不会被回收）；触发词与新名打架；将来下线它又要再走一次回收流程 |
| ③ 不做别名 | 靠孤儿回收清干净 + README 破坏性变更说明（先例 `README.md:622-627`） | 历史会话里的 `/旧名` 手势失效；用户肌肉记忆断一次 |

- **旧目录在新名下继续工作？** 不能。目录名就是安装键，旧目录不会被扫描为技能（除非它自带 `SKILL.md` 且用户没删——那时它是**另一个**技能，不是别名）。

---

## 3. 命名方案对比

波及面按 §4 的口径（源码 + 文档，排除运行时 `.dsh-assets/` 与并行审计产物）。

| | 方案 | 做法 | 优点 | 缺点 | 波及面 | 用户心智 | 迁移步骤 |
|---|---|---|---|---|---|---|---|
| **A** | 保留现名，只改描述与文档标签（**推荐**） | 三 id 不动；重写三个 `description` 的前 500 字；修 `README.md:44/291/295` 的「3D 动画短片」；`meta.yaml` 的 summary/desc 同步 | 零破坏：无目录改名、无重装、无孤儿回收风险；40+ 行文档路径引用（`skills/story-short-generator/SKILL.md:NNN`）继续有效；9 个历史会话里的旧名继续可用；**直接命中真正的病（描述超预算）** | 族名依旧不齐；`production` 的歧义只在描述里消；对外部 `shortdrama-*` 的近似前缀仍靠描述区分 | **6 文件 / 10 处 / 0 目录 / 0 代码**（story 描述 1 + meta 6 行 + README 3 行） | 零迁移；老用户无感，新用户靠描述分流 | ① 改 description → ② 改 meta → ③ 改 README 标签 → ④ 重启看目录 → ⑤ 三条探针语验路由（§5.4）。**无破坏性变更声明** |
| **A′** | 最小必要改名：只把 `short-drama-series-production` → `short-drama-series-producer` | `git mv` 一个目录 + 改 frontmatter name + 同步 8 个文件的 25 行提及 | 只治最歧义的那一个；`writer ↔ producer` 对仗（编剧/制片）；成本是全量的 1/6；孤儿回收可自动清旧目录 | 仍是 breaking：历史会话 `/short-drama-series-production` 失效；族名还是不齐（story 在外）；`producer` 多一个音节 | **8 文件 / 25 行 / 1 目录** | 一次小断点；名字更准 | 同 §5 的改名 runbook，但只涉及 1 个目录 |
| **B** | 三件套统一 `short-drama-*` 前缀（`short-drama-writer` / `short-drama-generator` / `short-drama-series`） | 三个目录全改 | 族名统一、可发现性最好；中文 display 可统一前缀 | **把最大用例改错**：`story-short-generator` 的主战场是「一句话故事 → 30–180s 风格化短片」（`SKILL.md:190-292`、7 套风格），不是短剧；套上 `short-drama-` 会让「做一条皮克斯风短片」的请求绕开它。`short-drama-generator` 也语焉不详（生成什么？） | **34 文件 / 142 行 / 3 目录** | 老用户要重新记三个名字；文档/历史会话大面积失效 | §5 全量 runbook；需破坏性变更声明 |
| **C** | 按层命名（`short-drama-script` / `short-drama-episode` / `short-drama-series-producer`） | 三个目录全改，名字说「层」不说「动作」 | 与调研文档的分层一一对应（`docs/short-drama-series-integration-research.md:156-175` 的 L0/L1/L2）；最不容易再失准 | 同上把通用短片锁进短剧；`script` 是名词、像文件名不像技能；层号是内部术语，用户不共享 | **34 文件 / 142 行 / 3 目录** | 中英双层语义都要重学 | 同 B |
| **D** | 不改名，改**边界**（把「连续短剧单集生产」从 story 拆成独立薄 skill） | 新增一个 skill（如 `short-drama-episode`），story 回到纯单片 | 治的是根因：一个 skill 两个受众 | 工作量在流程重构（拆 STEP 3–8 的调用链与门控），不在命名；会改动三 skill 的交接契约 | 新增 1 skill + 改动 3 个 skill（远大于 34 文件） | 长痛换短痛 | 不在本次范围，列为后续选项 |

### 3.1 为什么推荐 A（而不是 B/C）

1. **名字没错，只有描述错位**。上一个改名先例的判据是「名字被事实推翻」（`README.md:626`：加了真人风格 → 「3D」不成立）。现在三个名字都还对得上职责，够不上那条判据。
2. **路由由 description 决定，不由 name 决定**。宿主目录只给 `name + description(≤500)`（`dsh-tool-skill/lib/index.js:767/1021-1023/1087-1090`），模型据描述选技能。改名的唯一直接收益是「目录里更好读」，而 `story-short-generator` 的 500 字窗口连「连续短剧」都装不下 —— 这条不修，改成什么名字都没用。
3. **成本差 5.7 倍**（6 文件 vs 34 文件），而 B/C 还会新增一个语义错误（通用短片被标成短剧）。
4. **A 可以叠加 A′**：如果团队一定要看到「命名在动」，只在 A 之上加 A′ 即可，收益/风险比最好。

> 反方意见（记录在案）：如果产品的长期定位收敛为「短剧工厂」，通用故事短片只是副线，那么 B 的「族名统一」会随时间变得更值；但那是**产品定位决策**，不是命名审计能定的。

---

## 4. 改名波及清单

### 4.1 汇总数字

| 类别 | 文件数 | 命中行数 | 说明 |
|---|---|---|---|
| `skills/**`（含三个目标 skill 自身与其它 skill 的引用） | 15 | 48 | 见 4.2 P0 |
| `README.md` | 1 | 21 | 其中**当前态 4 行**、历史 changelog 17 行（4.3 / 4.4） |
| `USER-MANUAL.md` | 1 | 3 | 4.3 |
| `docs/**` | 17 | 70 | 4.3（1 个决策文档）+ 4.4（16 个引用型） |
| `lib/` `studio/` `package.json` `scripts/` `examples/` `schemas/` `workflows/` `.github/` | **0** | **0** | 见 4.5 |
| **合计（源码 + 文档）** | **34** | **142** | 三名字合并去重 |
| （运行时产物，不建议改）`.dsh-assets/` | 2 | 2 | 4.4 |

> 校验：含 `docs/analysis/` 与 `.dsh-assets/` 的原始口径是 36 文件 / 144 行；扣掉并行审计产物与运行时资产后为 34 / 142。
> 对照：**上一次改名**（`3d-animation-short-generator` → `story-short-generator`，commit `f6dcceb`）在改名前一刻的旧名足迹是 **15 文件 / 22 行**（`git grep -c '3d-animation-short-generator' f6dcceb^`）。18 天后（上次改名 2026-10-08，本次 2026-10-26）同样一次三件套改名是 **34 文件 / 142 行**，主要是 docs 的 `skills/<name>/SKILL.md:行号` 引用膨胀所致。

### 4.2 P0：不改就会「指到不存在的技能」（15 文件）

按「跨 skill 的加载指令 / 自身身份 / 安装键」三类。行号为当前 HEAD 实测。

| 文件 | 行 | 内容性质 |
|---|---|---|
| `skills/story-short-generator/SKILL.md` | 2 | frontmatter `name`（自身身份） |
| 同上 | 4, 6 | description / whenToUse 里转 `short-drama-series-production`、`short-drama-series-writer` |
| 同上 | 199, 214, 215, 218, 220 | 门 0 分支表与委托入口的「加载 `short-drama-series-production`」 |
| `skills/short-drama-series-production/SKILL.md` | 2 | frontmatter `name` |
| 同上 | 4, 6, 12, 19, 23, 31, 33, 37, 38, 40, 143, 152, 223, 352, 355 | 分工表/路由/委托/边界里对 story 与 writer 的 15 处引用（含简称 `series-writer`，`:352`） |
| `skills/short-drama-series-writer/SKILL.md` | 2 | frontmatter `name`（正文无他人引用，`meta.yaml` 里才有） |
| `skills/short-drama-series-production/references/episode-package.md` | 3, 170 | 「本文件是 `short-drama-series-production` 的唯一交接物」「⑥ 预填表 ↔ `story-short-generator` STEP 0 十项」 |
| `skills/short-drama-series-production/references/production-runbook.md` | 14 | 「加载 story-short-generator，从 STEP 3 起」 |
| `skills/story-short-generator/meta.yaml` | 13, 14 | summary 里 hand off to `short-drama-series-production` |
| `skills/short-drama-series-production/meta.yaml` | 15, 16 | desc 里 writer / story 的委托关系 |
| `skills/short-drama-series-writer/meta.yaml` | 13, 14 | desc 里「script layer used by `short-drama-series-production`」 |
| `skills/h3-prompt-writing/SKILL.md` | 57 | 「片型 skill（如 story-short-generator）提供的…」 |
| `skills/h3-prompt-writing/references/studio-mapping.md` | 43 | 「`story-short-generator` 的正片镜一律 r2v」 |
| `skills/image-generate/SKILL.md` | 73, 77, 83 | 角色卡双版本 / 形态门禁「见 `story-short-generator` 的参考图契约」+ 边界「交给 `story-short-generator`」 |
| `skills/video-generate/SKILL.md` | 3, 64, 71 | description 与正文的「完整流程用 story-short-generator」 |
| `skills/story-short-generator/.dsh-studio-manifest` | 4, 5 | 中文名注释 + `name:`（不载荷，但不同步会自相矛盾） |
| `skills/short-drama-series-writer/.dsh-studio-manifest` | 4, 5 | 同上 |
| `skills/short-drama-series-production/.dsh-studio-manifest` | 4, 5 | 同上 |

> 注意：上表 15 个文件是「全量改名」的 P0。若只做 A′（只改 production → producer），实际改动是 **8 文件 / 25 行 / 1 目录**：`short-drama-series-production/SKILL.md:2`（1 行）+ `.dsh-studio-manifest:4-5`（2 行）+ `references/episode-package.md:3`（1 行）+ `story-short-generator/SKILL.md`（7 行）+ `story-short-generator/meta.yaml:13-14`（2 行）+ `writer/meta.yaml:13-14`（2 行）+ `README.md:297`（1 行，`:528` 的历史 changelog 不改）+ `docs/short-drama-series-integration-research.md`（9 行）。

### 4.3 P1：用户可见文案（3 文件）

| 文件 | 行 | 处理 |
|---|---|---|
| `README.md` | 50, 297, 302, 431 | 当前态：技能表与「另有剧本层」说明、参考图契约的相对链接 `skills/story-short-generator/...` |
| `USER-MANUAL.md` | 499, 1171, 1338 | 第 5 章主线技能名、15.4「实现参考」表、旁白范围说明 |
| `docs/short-drama-series-integration-research.md` | 1, 3, 5, 11, 13, 19, 31, 37, 145, 152, 171, 172, 230, 232, 240, 392, 414, 416, 418, 448, 462 | 其中 **`:414-418` 是命名决策本身**（「不要叫 `short-drama-production`」「三件事的触发词要分开」），改名方案必须回头改这一节，否则文档与实现打架 |

### 4.4 P2 / 不改：引用型文档 16 个 + 历史内容

- **引用型文档（16 文件 / 61 行）**：路径引用 `skills/<name>/SKILL.md:行号`，改名后**文件名失效、行号也会因编辑漂移**。逐文件行号：
  `docs/ARCHITECTURE.md:43,321`；`docs/architecture-review.md:25`；`docs/consistency-optimization-plan.md:5,148`；`docs/h3-prompt-integration.md:41,74,174,204`；`docs/h3-voice-consistency-plan.md:246,250,344,415`；`docs/open-issues.md:14,38`；`docs/prompt-bank.md:4`；`docs/research/audio-capability-roadmap.md:260`；`docs/research/audition-voice-pipeline.md:36,39,109,131,150,228,348,352,443,668,669`；`docs/research/h3-audio-local.md:243,301,302,411,442,448,498`；`docs/shot-chain-continuity.md:137`；`docs/three-view-experiment.md:3,218,221`；`docs/toonflow-comparison.md:77`；`docs/unified-tier-tool-design.md:155`；`docs/video-shape-contract.md:85`；`docs/video-workflow-comparison.md:49,74,75,86,95,108,142`。
  建议：**批量 `sed` 改路径前缀，行号不重算**（重算成本高于收益，且这些文档的行号本来就已漂移 —— 例：`docs/short-drama-series-integration-research.md:5` 写 story `SKILL.md` 845 行，实际已是 **976** 行）。
- **不加改动（历史留档）**：
  - `README.md` 的 changelog 17 行（528, 529, 530, 554, 568, 577, 601, 608, 612, 618, 620, 622, 626, 630, 635, 766, 778）—— 其中 `:622-627` 记录的是**上一次改名**，是历史事实，必须原样保留；改名时**只新增一条变更记录**。
  - `.dsh-assets/绛珠泪-交付包/08-项目状态/.drama-state.json`、`.dsh-assets/绛珠泪-交付包/series/episodes/ep001/package.md` —— 真实项目产物，是运行时资产（`.gitignore:13-14`），属于历史证据，不改。

### 4.5 「以为要改、其实不用改」的地方（这些是好消息）

| 位置 | 结论 | 证据 |
|---|---|---|
| `lib/`、`studio/` | **0 命中**。插件对具体 skill 名**零认知**，systemPrompt 只写「画布/短剧/动画短片/故事转视频/卡通短片」这类领域词 | `grep` 三名字在 `lib/ studio package.json` = 0；`lib/index.js:4826`（GUIDANCE）、`package.json:4` |
| `package.json` | **无 bundled skill 清单**，`files` 只写 `"skills"` 目录 | `package.json:51-61` |
| `scripts/` | **0 命中**。`smoke-skill-install.mjs` 用的是 `alpha`/`beta` 假技能，安装/刷新/回收策略的测试与真名无关 | `scripts/smoke-skill-install.mjs:33-46` |
| `examples/`、`schemas/`、`workflows/`、`.github/`、`cordis.patch.yml` | **0 命中** | — |
| 用户插件配置 `~/.dsh/dsh-short-video-studio.json` | **无 skill 名**（只有 ComfyUI 模型槽/画布配置） | 实测 grep 无命中 |
| CI | 不引用 skill 名；`npm run smoke` 里包含 `smoke-skill-install.mjs`，改名不影响 | `package.json:75-77` |

### 4.6 改名会破坏什么（效应清单）

1. **用户已装目录**：未改过 → 自动回收（安全）；改过 → 新旧并存（需人工删，见 §2.3）。
2. **历史会话**：本机 `~/.dsh/storages/session_projcache/sessions` 里，提到 `story-short-generator` 的会话 **9 个**、`short-drama-series-writer` **3 个**、`short-drama-series-production` **2 个**。这些会话若被重放/续跑，里面的「加载 `旧名`」会解析失败（中文说明还在，模型通常能改用新名，但 `/旧名` 手势一定失败）。软兼容用 §2.4 的「描述内别名」。
3. **文档链接/引用**：34 文件里 16 个 docs 是 `path:line` 引用，改名后**路径立刻 404、行号本就漂移**。
4. **e2e / 冒烟**：**不受影响**（脚本不引用真名）。
5. **外部生态**：若有人从 Hub 重装 `short-drama-production`，或本项目把名字改成 `short-drama-production`（历史文档已明确否决，`docs/short-drama-series-integration-research.md:414`），会与备份里的 Hub skill 撞名撞词（§6）。
6. **技能中心/市场展示**：`meta.yaml` 的 `display-name-zh` 与 `desc-*` 是 Hub 展示文案；改 id 不改 `meta.yaml` 会出现「目录名新、展示名旧」。

---

## 5. 迁移步骤

### 5.1 方案 A（推荐：只改描述）—— 7 步，无破坏性

1. **重写 `story-short-generator` 的前 500 字**（`skills/story-short-generator/SKILL.md:3-7` 的 description），把「片型门 / 连续短剧 / 转 production」提到前 500 字内；把声线、字幕、画质、审查节奏等细项挪到 500 字之后。建议骨架：
   - 第 1 句：定位（一句话故事 → 30–180s 风格化短片全流程，7 套风格）。
   - 第 2 句：**片型门**（单片 / 连续短剧）；连续短剧只做**单集生产**，系列层（圣经/分集剧本/集制作包）转 `short-drama-series-production`；**触发词**写全：「某一集 / 第 N 集 / 已有分集剧本要拍」。
   - 第 3 句：不适用（单图、单独镜头、纯剧本、实拍剪辑）。
   - 之后：才写角色卡双版本、声线试镜、字幕、交付画质、审查节奏。
2. **`short-drama-series-production` 的描述首句加「制片总控，不拍片」**（`SKILL.md:3-5`），并保留「委托 story STEP 3–8」。
3. **`short-drama-series-writer` 的描述首句加「只出文本、不出视频」+ 区分两类包**（`meta.yaml:13-14` 的 desc 已接近，可加一句「`/export` 的『分集制作包』≠ 制片层的『集制作包』」）。
4. **同步 `meta.yaml` 的 summary/desc**（story `:13-16`、production `:13-16`、writer `:11-14`）。`meta.yaml` **没有 name 字段，不用改**。
5. **修 README 标签**：`README.md:44`、`:291`、`:295` 的「3D 动画短片」→「故事短片（7 套风格）」。这是与改名无关的**必做项**（§1.2 N5）。
6. **不动任何目录、不动安装逻辑、不需要破坏性变更声明**；版本号走 patch/minor 即可。
7. **验证**：
   - 重启/刷新后看技能目录三条目的前 500 字（模型侧 catalog message）；
   - 跑三条探针语（见 5.4）；
   - 确认 `~/.dsh/skills/*/.dsh-studio-manifest` 的 `contentHash` 已随刷新更新。

### 5.2 方案 A′ / B / C（真改名）—— 通用 runbook

1. **前置检查**：目标新名在 `~/.dsh/skills/` 不存在、也不是外部同名 skill（Hub 版见 §6.2）；`DSH_SVS_SKILL_REFRESH` 未设为 `off`。
2. `git mv skills/<old> skills/<new>`（连同 `references/` 与 `LICENSE`）。
3. 改 `SKILL.md:2` 的 `name:`；改 `.dsh-studio-manifest:4-5`（中文名注释 + `name:`）。
4. 按 §4.2 逐行改跨 skill 引用（P0 15 文件）→ §4.3（README/USER-MANUAL/决策文档）→ §4.4（`sed` 批量改 16 个 docs 的路径前缀，行号不重算）。
5. **在新名描述里加「（原 `<旧名>`）」**（软 alias，§2.4 ①）；是否再发旧名 shim 由发布策略定（不推荐，长期占位）。
6. 发版 + **新增一条 README 变更记录**（照 `README.md:622-627` 的「⚠️ 破坏性变更：自带 skill 改名」格式），明确：旧目录会被自动回收、改过副本的用户需手动删。
7. 重启插件，核对 `installBundledSkills` 日志四类：`installed` / `refreshed` / `reaped` / `keptOrphans`（`lib/index.js:5078-5105`）。
8. 处理异常：
   - `keptOrphans` → 提示用户 `rm -rf ~/.dsh/skills/<旧名>` 或 `DSH_SVS_SKILL_REFRESH=force`；
   - `conflicts` → 目标名被用户自装同名占着，先让用户删；
   - `refresh=off` → 旧目录不会回收，必须临时打开再跑一次。
9. 验证：`/新名` 手势、三 skill 互引、历史会话提示；本机可用 `diff -rq skills/<new> ~/.dsh/skills/<new>` 确认副本一致。

### 5.3 旧名兼容/alias 是否可行（结论摘要）

- **原生 alias：不可行**（宿主无字段，同名按 rank 择优 + warning，`dsh-skill/lib/index.js:17/114-115/186-188`）。
- **可行且推荐**：新名描述里写旧名（零成本，靠 500 字预算）。
- **可行但不推荐**：额外发旧名 shim skill（永久占目录 + 抢触发词）。
- **不可行**：靠「保留旧目录」当别名 —— 安装逻辑只认目录名，旧目录要么被回收、要么变成一个独立技能。

### 5.4 路由探针（发布前必跑）

| 探针语 | 期望命中 | 常被误命中（现状） |
|---|---|---|
| 「把一句话故事做成 30 秒皮克斯感短片」 | `story-short-generator` | —（正常） |
| 「我有 80 集分集剧本，拍第 12 集」 | `short-drama-series-production` | **现状可能命中 story**（它的目录描述里看不到「连续短剧」） |
| 「只要分集大纲、爽点和付费卡点」 | `short-drama-series-writer` | production（描述含「剧本」）或外部 `shortdrama-director` |
| 「给主角做张角色卡 + 三视图」 | `story-short-generator`（STEP 3） | `film-assets`（trigger-words 含「角色卡/三视图」，本机已装且无戳） |

---

## 6. 生态重叠与路由

### 6.1 仓库外 `shortdrama-*`（5 个，ai-show）

| skill | 自述职责（`/Users/seiue/Workspace/ai-show/skills/<name>/SKILL.md:3`） | 与本仓三件的重叠 | 冲突点 |
|---|---|---|---|
| `shortdrama-director` | 「把一句话创意/大纲/网文 IP 转化为剧本和结构化分镜脚本（shotlist JSON）…G1/G3 审核」 | **= writer + story 的 STEP 5/6** | 它也产出「剧本 + 分镜」，用户说「短剧剧本/分镜」时两者都像 |
| `shortdrama-character` | 「短剧角色设计…角色卡、多视图定妆参考图、可选 LoRA…G2」 | **= story STEP 3** | 角色卡口径不同（它允许 LoRA/Qwen Image Edit） |
| `shortdrama-comfyui` | 「读取 shotlist.json…提交工作流…归档产物」，环境写死 `LTX-2/ltx-2-19b-dev` | **= 本插件工具层**（`comfy_generate_*`） | **技术栈不同**（LTX-2 vs H3），照它的指令会绕开能力注册表 |
| `shortdrama-memory` | 「`production-state.json`、每集进度、角色版本、决策记录」 | **= production 的状态文件** | **同名文件、不同 schema**，指向同一项目目录会互相覆盖（`shortdrama-memory/SKILL.md:13` vs `short-drama-series-production/SKILL.md:111`） |
| `shortdrama-review` | 「G1–G7 审核门状态机…`docs/production/<ep>/reviews/<G1..G7>.md`」 | **= production 的 G-S/G-B/G-A/G-SAMPLE/G-E** | 两套门号（G1–G7 vs G-S…）会混淆用户与模型 |

- 现状：**未安装**（`~/.dsh/skills/` 无 `shortdrama-*`），所以当前不参与路由；一旦安装即形成 **8 个技能同场，其中 7 个描述含「短剧」**（本仓 writer / production + 外部 5 个）。
- 前缀风险：`shortdrama-*` 与 `short-drama-*` 只差两个连字符，人眼和模型都容易串。
- 已有历史判断：这些只算「先例」，本仓方案明确「不改造、不融合」（`docs/short-drama-series-integration-research.md:5`、`:156-175`）。

### 6.2 Hub 版 `short-drama-production`（已卸载，备份仍在）

- 实体证据：备份 `/tmp/short-drama-production-backup-20261023-122329.tar.gz` **现在仍存在**（10/23 12:23，10497 字节）；解包看到的 frontmatter 是 `name: short-drama-production`，description 仅一句「**根据用户要求做短剧。**」，`meta.yaml` 里 `display-name-zh: 短剧全流程制作`、`version: 0.1.1`；SKILL.md 34 行。
- 决策留档：`docs/short-drama-series-integration-research.md:414-421` —— ① 新 skill 叫 `short-drama-series-production`、**不要叫 `short-drama-production`**；② 三件事的触发词要分开；③ 冲突以「卸载 Hub 版」解决（备份路径与理由见 `:420`）。
- **风险仍然存在**：备份可随时重装；Hub 版 display 名「短剧全流程制作」与本仓「短剧系列制片」极像，description 又极宽（一句「做短剧」）→ 重装后必然抢路由。建议在 README/手册里保留「不要同时装 Hub 版」的显式告诫，并在 production 描述里写「本技能不是 Hub 的 `short-drama-production`」。

### 6.3 本机已装的 `film-assets`（用户自装、无戳）

- `~/.dsh/skills/film-assets/SKILL.md:1-20`：trigger-words 直接含 `角色卡`、`人物卡`、`三视图`、`四视图`、`转身图`、`道具视图` 等 —— 与 story 的 STEP 3/4/4.5 **正面撞词**。
- 它是**用户自装**（无 `.dsh-studio-manifest`）→ 安装逻辑**永不覆盖、永不回收**（`lib/index.js:4993-5005`、`:5052`），所以只能靠描述消歧。
- 边界其实清楚：`film-assets` 只做静态资产（不生成视频），story 做全流程。但触发词层面会抢，尤其「角色卡」这种单词。

### 6.4 「用户说短剧」时谁会被命中（现状路由矩阵）

按宿主目录可见的 `description`（前 500 字）判断：

| 说法 | 应命中 | 现状可能的竞争者 | 原因 |
|---|---|---|---|
| 「写一部 80 集短剧 / 分集大纲 / 爽点」 | writer | production、`shortdrama-director`（若装）、Hub 版（若重装） | 三者描述都含「剧本/短剧」 |
| 「把第 12 集拍出来 / 整部量产」 | production | **story**（描述前 500 字看不到片型门）、`shortdrama-comfyui`（若装） | N1 的 500 字失焦 + 技术栈混淆 |
| 「把一句话故事做成短片 / 皮克斯风」 | story | —（`film-assets` 只在「角色卡」类词上抢） | 正常 |
| 「做张角色卡 / 三视图」 | story（STEP 3） | `film-assets` | 撞词 |
| 「审核门 G3 / 审核通过」 | production 的 G-* 门 | `shortdrama-review`（G1–G7） | 两套门号 |

### 6.5 建议（按优先级）

1. **描述即路由（最高优先）**：三个 description 的前 500 字都要**自解释**并**互指**：story 写「连续短剧只做单集，系列层转 production」；production 写「不拍片，拍摄委托 story」；writer 写「只出文本，成片找 production」。这比改名字有效一个数量级（§0.2）。
2. **加显式排除句（disambiguating description）**：在 production 里写「不与 Hub 的 `short-drama-production` 共存；若已装请卸载」；在 story 里写「不做单图/单镜头（→ `image-generate` / `video-generate`）；角色静态资产可用 `film-assets`，但本流程内建角色卡」。
3. **不要采用会与生态撞车的名字**：不要叫 `short-drama-production`（历史否决，`:414`）；不要采用 `shortdrama-` 前缀（与 ai-show 族混淆）；`short-drama-*` 与外部族只差连字符，若走 B/C 方案必须在描述首句声明「本仓版 vs ai-show 版」。
4. **门号统一**：production 的门若长期与 `shortdrama-review` 并存，建议在文档里给一张「G-S/G-B/G-A/G-SAMPLE/G-E ↔ G1–G7」对照，或直接改名成 `Gate-S` 这类不会撞的形态（低成本，纯文案）。
5. **状态文件防撞**：production 的 `series/production-state.json` 与 `shortdrama-memory` 的 `production-state.json` 同名不同 schema。建议 production 侧改名为 `series/state.json`（或 `series/episode-state.json`）——**这是本次调研里唯一建议「改产物名」的地方**，比改 skill 名便宜且收益直接。
6. **README/手册保留三条告诫**：不要同时装 Hub 版；`shortdrama-*` 是另一套（LTX-2 技术栈）；`film-assets` 只做静态资产。

---

## 附录 A · 关键证据索引（代码与机制）

| 结论 | 证据 |
|---|---|
| skill id 语法 `^[a-z0-9]+(?:-[a-z0-9]+)*$` | `/Users/seiue/.npm/_npx/57e83f33d8ab027d/node_modules/@deepseek-ai/dsh-skill/lib/index.js:17` |
| 同名技能按层/rank 择优，重复只告警 | 同上 `:114-115`、`:186-188` |
| 缺少 name/description 即拒载 | `@deepseek-ai/dsh-skill-filesystem/lib/index.js:682-690` |
| 技能目录行 = `name: description`，且 description 截断 500 字（可配） | `@deepseek-ai/dsh-tool-skill/lib/index.js:767`、`:1021-1023`、`:1087-1090` |
| `whenToUse` 不进模型目录 | 同上 `:1021-1023`（只取 name/description）；`entries = catalogSourceEntries` |
| 宿主不读 `meta.yaml` | `@deepseek-ai/*` 内 grep `meta.yaml` 零命中 |
| 安装源/目标与「无清单，直接 readdir」 | `lib/index.js:4979`、`:5073-5074` |
| 安装戳字段（含 contentHash/pluginVersion） | `lib/index.js:4921-4935`、`:4988` |
| 四种目标态与 `keptUserEdited` / `conflicts` | `lib/index.js:4963-5035`（注释 `:4966-4973`），告警 `:5081-5105` |
| 改名后的孤儿回收 | `lib/index.js:5037-5065`（注释动机 `:5038-5040`） |
| `DSH_SVS_SKILL_REFRESH=off/force` | `lib/index.js:4892-4893`、`:5007`、`:5010`、`:5041`、`:5055` |
| `package.json` 无 skill 清单 | `package.json:51-61` |
| 上次改名的先例与用户影响说明 | `README.md:622-627`；commit `f6dcceb`（`R064` manifest、`R076` SKILL.md） |
| 本次三件套命名决策（含否决 `short-drama-production`） | `docs/short-drama-series-integration-research.md:414-421` |
| 「短剧」触发词冲突的历史处置（卸载 Hub 版） | 同上 `:420`、`:447` |
| 分层方案的官方图（L0/L1/L2） | 同上 `:156-175` |

## 附录 B · 计数方法与复现命令

```bash
# 1) 三名字合并：文件数 + 命中行数（排除生成物/依赖/并行审计产物）
grep -rIl --exclude-dir=node_modules --exclude-dir=e2e-out --exclude-dir=canvas \
  --exclude-dir=.git --exclude-dir=.pnpm-store --exclude-dir=analysis \
  -e 'story-short-generator' -e 'short-drama-series-writer' -e 'short-drama-series-production' . | wc -l
grep -rIF ... 同上 ... | wc -l

# 2) 路径引用（会失效的那种）
grep -rF --exclude-dir=... 'skills/story-short-generator' .

# 3) 历史会话引用
grep -rl 'story-short-generator' ~/.dsh/storages/session_projcache/sessions | wc -l

# 4) 上一次改名的真实波及面（对照）
git grep -c '3d-animation-short-generator' f6dcceb^ -- . ':(exclude)node_modules'
```

口径说明：
- README.md「命中行数」用 `grep -Fc`（匹配行数，不是出现次数）；正文不转载。
- `docs/analysis/` 是本轮并行审计产物，统计时**排除**；若纳入，`docs/**` 会多出若干 `skills/<name>/SKILL.md` 路径引用。
- `.dsh-assets/` 是 `gitignore` 的运行时资产库，单列为「不建议改」。
- 已装副本是否「用户改过」用 `diff -rq skills/<name> ~/.dsh/skills/<name>` 判定（仅版本戳不同 = 未改过）。

## 附录 C · 描述改写预算表（方案 A 落地用）

| skill | 现状 description 长度 | 是否被 500 字截断 | 必须进入前 500 字的信息 | 建议移出前 500 字的 |
|---|---|---|---|---|
| `story-short-generator` | **1150** | **是**（「片型」在 616、「连续短剧」在 636） | 定位一句话 / 片型门（单片 vs 连续短剧）/ 连续短剧只做单集、系列层转 production / 不适用清单 | 角色卡双版本细则、声线试镜三步、字幕开关细则、交付画质选项、审查节奏选项 |
| `short-drama-series-production` | 323 | 否（完整可见） | 制片总控不拍片 / 集制作包是唯一交接物 / 委托 story STEP 3–8 / 与 Hub `short-drama-production` 不同 | 六阶段细节、成本口径 |
| `short-drama-series-writer` | 197 | 否（完整可见） | 只出文本不出视频 / 两类包的区别 / 何时该找 production | 题材清单、出海格式细则 |

> 备注：`description` 是 YAML 块标量，改长改短不影响解析；`whenToUse` 可以继续长写（不进目录，但模型打开技能后能读到）。
