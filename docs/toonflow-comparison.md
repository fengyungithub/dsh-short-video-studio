# Toonflow-app 对比与可借鉴方向

> 对象：[HBAI-Ltd/Toonflow-app](https://github.com/HBAI-Ltd/Toonflow-app)（本地 `/Users/seiue/Workspace/Toonflow-app`，v2.0.0，MIT，Bun monorepo，2026-09-21 起 64 次提交）
> 对比对象：本项目 `dsh-short-video-studio` v1.9.0
> 取证材料：`docs/research/toonflow-agent-architecture.md`（Agent/插件架构）+ 本轮对两仓库的直接读码；所有 Toonflow 事实均给出文件路径。

---

## 0. 一句话结论

两者**不是同类产品**，可比的是「同一问题的两种解法」：

| | Toonflow | 本项目 |
|---|---|---|
| 形态 | 独立应用（Electrobun 桌面 / Android / Docker / 服务器） | DSH 双面插件（宿主半 + 浏览器半） |
| Agent | SDK `@earendil-works/pi-coding-agent` 自建运行时 | 宿主 DSH 本体 |
| 生成后端 | 远程 HTTP 供应商（TF-Router / APIMart / 秘塔 / 优云），**无 ComfyUI** | 本地 ComfyUI，**能力 × 档位注册表** |
| 画布角色 | Vue Flow 文档 + 节点各自驱动生成，**无调度器** | 会话视图，产物陈列 + Agent 工具直读写 |
| 扩展机制 | 编译产物的 **banner 注释即元数据**，`data/*` 目录即注册表 | workflow **JSON manifest 即数据**，配置面解析档位 |
| 一致性策略 | 身份条件：多参参考槽位（`imageReference:N`） | 图结构：参考图形态门禁 + seed + 文风锚点 + 链式续接 |

**核心判断**：本项目在**生成后端抽象、档位成本模型、链式续接、逐镜续接取证、交付链路**上明显领先；Toonflow 在**插件生态工程化、人机授权门、团队/多 Agent 编排、跨端与外部 Agent 接入**上明显领先。下面按「值得借鉴 → 不要学 → 结构性问题」排序。

---

## 1. 最值得借鉴的六件事（按性价比排序）

### 1.1 「算力授权」三态门 —— 直接补本项目最大的人因缺口 ★★★★★

Toonflow 把「确认」拆成三个**互不等价**的状态，并写进系统提示词与 skill：

- **内容确认**（题材/角色/风格）≠ **生成授权**（本次扣算力）≠ **结果采用**（这段保留）
- 生成前必须给出「对象 / 数量 / 模型 / 规格 / 完整提示词 / 参考 / 次数」并取得明确同意
- 明确写死：「制作意愿、风格确认、普通『继续』均不等于批准」
- `askUser` 的**跳过**记录为「已跳过」，不代表同意或通过阶段确认
- 状态文件要求确认绑**独立历史快照**——「等待期间被修改的内容不能顺便批准」
  （`packages/tools/askUser/readme.md`、`apps/server/src/agent/runtime/prompt.ts`、`packages/skills/workflow/references/stateAndDelivery.md`）

**本项目现状**：skill 里有 `ask_user_question` 开场门控与「生成前硬确认」，但**没有把三种确认状态区分开**，也没有「跳过 ≠ 批准」的显式语义。ISSUE-001 记录的「抽卡一张定生死」正是这个缺口的症状——没有授权单位，就没有「先抽 2 张再定稿」的预算语义。

**落地**：把该契约写进 `GUIDANCE`（派生面）或在 skill 层统一措辞；若要做进工具面，可在 `comfy_render` 前加「授权令牌」参数（由 ask 返回），但**更划算的是文档层统一**——成本近零，收益是消除一类静默超支。

### 1.2 「供应商 / 工作流接入向导」是一个 Agent，不是一个表单 ★★★★★

Toonflow 让**零基础用户用自然语言对话生成一个可导入的 `.ts` 适配文件**
（`apps/web/src/components/settings/panels/mediaModel/providerPrompt.ts`，181 行）。要点：

- 一次只问一个问题，普通引导回复 ≤120 字，禁止打包提问
- 「平台名 / 官网首页 / 用途」都**不算拿到接口资料**，没有资料就停在资料收集阶段，**不许凭记忆编协议**
- 自行搜索**默认关闭**，只有用户明确要求才允许定向代找
- 不索取真实 API Key，不让密钥进代码
- 有专门的 **ComfyUI 工作流接入分支**：先要用户发一份「能正常生成的 ComfyUI 工作流文件（优先 API 格式导出）」，读文件而不是问节点编号

**本项目现状**：新增实现 = 手写/转换 workflow manifest JSON（`lib/convert.js` 能从 ComfyUI API 导出转 manifest），设置页有导入入口。**但接入过程是格式驱动的，不是对话驱动的**——用户得先知道「API 格式导出」「manifest」「注入点」这些概念。

**落地**：本项目已有 `lib/convert.js` 的 `todos` 人工待办列表，把它**升格为一个接入 skill**（如 `workflow-onboarding`）：Agent 读用户贴的 ComfyUI API JSON → 调 `convert` → 补齐 `$assets`/`params`/`output` 注入点 → 写出 user 目录 manifest → 自检后提示用户在画布确认。**复用现有转换器，不新增运行时**。这是本项目投入产出比最高的一项。

### 1.3 团队 / 多 Agent 作为**声明式包** ★★★★☆

Toonflow 的 `packages/teams/*` 是纯声明：

```jsonc
// packages/teams/storyboardTeam/team.json
{ "entry": "director",
  "members": {
    "director": { "delegates": ["writer","reviewer"], "tools": ["read","ls"],
                  "skills": ["storyboard"], "knowledge": ["continuity.md"] },
    "writer":   { "delegates": [], "tools": ["read","ls"], "skills": ["storyboard"] },
    "reviewer": { "delegates": [], "tools": ["read","ls"] } } }
```

- 成员 = 指令文件 + **最小权限工具子集** + 私有 skill/knowledge
- 委派关系在**构建期做环检测**；`delegate` 工具只暴露该成员的 `delegates`
- 团队自带私有工具插件（`privatePlugins`），工具名冲突 = 硬报错
- 同一个团队包既能在对话里跑，又经 **A2A**（`/a2a/:name`、AgentCard、Bearer、taskId 续跑）被外部 Agent 驱动

**本项目现状**：skill 是散文指令，**没有角色分工与工具最小权限的声明面**。`story-short-generator` 单 skill 承担全部阶段，靠文字纪律约束「不要越权」。

**落地**：本项目宿主已有 Agent Teams 能力。可在 skill 层引入**轻量角色卡**（同一 skill 内的阶段化指令 + 显式「本阶段允许调用的工具」清单），而不引入新的运行时。真正的团队包化留给 DSH 团队机制，不重复造。

### 1.4 画布操作走**串行 RPC + 每次调用超时**，而不是让 Agent 写 JSON ★★★★☆

Toonflow 的 `canvas` 工具声明 ~19 个 zod 操作，但**服务端只做转发**：经 Agent 事件流把 `canvasCall` 发到浏览器，由 `useCanvasTools.ts` 对**活的 Vue Flow 状态**执行
（`apps/server/src/agent/bridge/canvas.ts`）：

- **全局串行队列**：轮到当前调用才开始计时，避免排队吃掉执行超时
- 单次调用 **120s 超时**，超时错误文案是「画布调用超时，请确认画布仍然打开」
- AbortSignal 直通；`canvasOperations.find(...).parameters.parse(args)` **每次调用都校验参数**
- 服务端 `pendingCalls` 是进程内存；代码里用 `ACT:` 注释写明「多进程部署需共享请求通道」

**本项目现状**：`canvas_*` 工具**直接读写 `project.json`**（原子写 + 每会话写锁）。这在「单写者 + 无并发编辑」前提下更简单、更可靠，**不应该为了对齐而改成 RPC**。真正值得借鉴的是它的**边界纪律**：每次调用参数校验、单调用超时、串行化、失效前提用 `ACT:` 标注。

**落地**：本项目已有原子写 + 写锁，但缺**版本冲突可见性**。可低成本补：给 `project.json` 加 `revision`，`canvas_write_node` 等写操作接受可选 `expectedRevision`，不匹配返回冲突而非静默覆盖——这对应 Toonflow 资产库的 sha256 `revision` + 409 `ESTALE` 乐观锁（`packages/tools/assetOperator/readme.md`），本项目资产库已有类似语义，画布却没有。

### 1.5 「模型能力声明」作为一等数据，而不是靠调用方猜 ★★★☆☆

Toonflow 的 `ProviderModel`（`packages/providers/types.d.ts`）声明：

```ts
type VideoMode = "singleImage" | "startEndRequired" | "endFrameOptional"
  | "startFrameOptional" | "text" | (`${"video"|"image"|"audio"}Reference:${number}`)[];
interface ProviderModel { mode?: (ImageMode|VideoMode)[]; durationResolutionMap?: ...;
  imageSizes?: string[]; imageRatios?: string[]; voices?: ...; audio?: boolean|"optional"; }
```

Agent 生成前**必须先调 `listMediaModels`**，工具描述写死「不能猜测模型 ID」（`packages/tools/mediaGeneration/src/index.ts`）。供应商还必须在 `generateVideo` 里把**最终媒体**返回，**不允许把 job id 泄漏过抽象层**。

**本项目现状**：`comfy_list_workflows` 提供 capability × tier × 交付尺寸 × 实测耗时，但**没有「该实现声明自己支持哪些条件路径 / 哪些槽位上限」的机读声明**——模型特异性只能靠散文（`GUIDANCE` 的参考图形态规则）与代码里的 `makeH3PromptGateListener` 兜。

**落地**：manifest 已有 `modes` / `constraints` 键，可把「参考图槽位上限」「是否支持续接」「是否原生带音」显式化为 `comfy_list_workflows` 的返回字段，让 skill 能**断言**而非背诵。这与 §4.1 的「消除双源」是同一件事的两面。

### 1.6 长任务的**流信封 + 取消贯通** ★★★☆☆

- 生成 POST **劫持响应**：每 20s 写一个空格保活，最后写终态 JSON，避免中介缓冲/掐断（`routes/ai/media/generate.ts`）
- 取消 = `AbortController` 接 `res.close` / `req.aborted` / `socket.close`，一路穿进 provider 的 `fetch`
- 会话历史是**树**：重发 = 移动叶子并追加模型切换标记，不丢可恢复点；`clearQueue()` 把未投递的 steer 消息**退回历史**，停止不丢消息
- 子 Agent 结果 16 000 字符截断，**改成指向工作区产物的指针**（而不是截断即丢）

**本项目现状**：`comfyWait` 有 15 分钟超时并尊重 AbortSignal，但**没有心跳**——DSH 宿主/网关若对静默超时敏感，长镜头会被误判。子 Agent 截断这点本项目也适用（skill 交付的文本节点可能很长）。

---

## 2. 明确**不要**借鉴的五件事

1. **把画布当执行图**。Toonflow 无调度器，每个 Vue 节点组件自持生成生命周期，数据靠响应式 `data.outputs` 拉取（`packages/nodeScaffold/src/nodeInputs.ts`）。代价是**生成任务挂在打开的页面上——关窗 / 卸载节点即中断**（`references/videoProduction.md` §5 自认）。本项目「Agent 主动调工具生成、产物落画布」在可靠性上更优，不要为了「所见即所得」退回浏览器驱动。

2. **撤销不含节点内容**。Toonflow 的 `useCanvasHistory.ts` 只快照**结构 + 名称**（≤100 步），「节点内部内容、生成结果和外部文件不属于撤销历史」。本项目节点带 `params`（含 seed、tier、宽高），若照搬会让「重出这一镜」无法复原参数——这是本项目的核心资产，必须保留。

3. **把模型名写进代码分支**。`makeH3PromptGateListener`（`lib/index.js` L2692）按实现 id 前缀 `minimax-h3-` 拦截视频提示词、缺 Ref2VA/I2VA 章节就 deny（最多 2 次后放行）。这与本项目「插件不认识模型名」的核心主张**直接冲突**，属于已知架构债，应下沉为 manifest 声明式约束（如 `prompt.requiredSections`）。

4. **无 seed**。全仓无 seed 概念，重出即换样，一致性只能靠参考图。本项目已把 seed 记入节点参数，是明显优势，不要对齐。

5. **契约三处维护 / 文档漂移**。Toonflow 的 `SKILL.md`(1406 行) 是真正的管线定义，`AGENTS.md` 是规范主文档，两者与代码各说一遍。本项目 `ARCHITECTURE.md` §9.2 已自认同一问题（工具契约 × GUIDANCE × SKILL.md 三处），**引以为戒而非效仿**——Toonflow 的漂移已经实证：其 ARCHITECTURE 自述 v0.1.1 / 4 份 manifest / 13 工具 / i2v balanced 空缺，实际是 v1.9.0 / 51 / 15 / 已有。

### 附：两边都缺的能力

- **没有一方具备「身份锁」**（IPAdapter / InstantID / PuLID）。Toonflow 侧全仓无 LoRA/embedding；本项目侧对本机 1184 个节点扫描**零命中**。⇒ 一致性目前都建立在「参考图 + seed + 散文」上。本项目 `docs/consistency-optimization-plan.md` 若能把身份条件作为**可选前置**（而非替代图结构策略）纳入，是从「断言」走向「取证」的最大增量。
- **没有一方有字幕时间轴 / 烧录 / 对口型**。本项目靠 H3 的**画面内原生字幕**绕开——这是更聪明的解法，应在文档里明确标为「设计选择」而非「缺失」。

---

## 3. 本项目自身的三个结构性问题（对比暴露出来的）

1. **`validateManifest` 与 `workflow-manifest.schema.json` 是双源**（`lib/manifest.js` L86 手写零依赖版 vs `schemas/*.json`），会漂移。Toonflow 用 zod 单源 + `z.toJSONSchema()` 生成工具 schema（`packages/tools/mediaGeneration/src/index.ts`）解决了同类问题。本项目可直接用 `zod`（或已有依赖）从 schema 派生校验器，或反过来从校验器生成 schema 并加一致性 smoke。

2. **`schemaVersion:1` 写了但从不检查/迁移**（`emptyProject()` L594、`loadProject` L603 解析失败静默返回空）。Toonflow 的画布同样「读时校验」但至少显式标记。建议：加载时校验 `schemaVersion`，未知版本**拒绝加载并报错**，而不是静默清空——静默清空是数据丢失。

3. **`/api/config` 与 `/api/workflows` 的**整个** admin 面对本机无鉴权（含写入）——已核验。 `requireToken(req, runtime)` 排在 `lib/index.js` **L3580**，而以下分支全部在它**之前** `return`：

   | 行 | 路由 | 后果 |
   |---|---|---|
   | L3490 | `GET /api/config` | 回显 `baseUrl` / **`apiKey`** / `models` / `tiers` / `strategies` 全量配置 |
   | **L3494** | **`POST /api/config`** | **任意本地进程可覆盖 `baseUrl`（指向攻击者 ComfyUI）与 `apiKey`** |
   | L3521 | `GET /api/workflows` | 泄漏清单与资产覆盖 |
   | **L3527** | **`POST /api/workflows`** | **写入 `USER_WORKFLOWS_DIR/*.json` + `reloadRegistry()` 立即生效** |
   | **L3569** | **`DELETE /api/workflows`** | 删除任意用户清单 |

   两个变更路由（含改 `baseUrl`/`apiKey` 的那个）**完全无守卫**；代码注释「工作流注册表（tokenless，与 /config 同级：管理本地清单，不涉及会话数据）」（L3520）**自认了这一点但不是设计论据**——写入 admin 配置与注册表不是「不涉及会话数据」就能豁免的。这是本轮对比中**唯一发现的真实安全缺陷**，且修法是一行级：把 `requireToken` 上移到 L3494 之前（GET 分支可按需白名单）。

   > 影响面被低估的原因：`/media` 与所有 `canvas_*` 变更路由**都在守卫之后**，所以「大部分路由有 token」的直觉成立，缺口只在这两个 admin 前缀上。
   >
   > 修法：`requireToken` 上移至 `POST /config` 与 `POST|DELETE /workflows` 之前（GET 保留 tokenless 或显式白名单），并补一条 smoke 断言「无 token 的 POST /config 返回 403」。

---

## 4. 建议的行动顺序

| 优先级 | 动作 | 落点 | 成本 |
|---|---|---|---|
| P0 | 新增 `workflow-onboarding` skill：对话式把 ComfyUI API 导出转成可用 manifest（复用 `lib/convert.js`） | `skills/` | 中，纯文档+编排 |
| P0 | 在 skill/GUIDANCE 层引入「内容确认 ≠ 生成授权 ≠ 结果采用」+「跳过 ≠ 批准」 | `GUIDANCE` / skill | 低，纯措辞 |
| P0 | `requireToken` 上移到 `POST /config` 与 `POST|DELETE /workflows` 之前（一行级）+ smoke 断言 403 | `lib/index.js` | 低 |
| P1 | 画布加 `revision` 乐观锁（对齐资产库已有语义） | `lib/index.js` | 低 |
| P1 | manifest 双源收敛为单一权威 + 一致性 smoke | `lib/manifest.js` / `schemas/` | 中 |
| P1 | `schemaVersion` 加载校验，未知版本报错而非静默清空 | `lib/index.js` | 低 |
| P2 | 把 `comfy_list_workflows` 扩为携带机读能力声明（槽位上限 / 是否支持续接 / 是否原生带音） | manifest + 工具 | 中 |
| P2 | `makeH3PromptGateListener` 下沉为 manifest 声明约束 | `lib/index.js` + manifest | 中 |
| P2 | 长任务心跳 + 子 Agent 长文本改为产物指针 | `lib/index.js` | 低 |
| P3 | 身份锁（IPAdapter/PuLID）作为**可选**条件路径纳入取证 | 新 manifest + 实测 | 高 |

---

## 5. 一句话记法

> Toonflow 的强项是**把「谁在什么授权下、用谁的插件、跑什么模型」工程化**；
> 本项目的强项是**把「哪个能力、哪一档、什么尺寸、怎么续接」数据化**。
> 前者补本项目的人因与生态，后者是 Toonflow 的短板——**互相学对方的短板，而不是学对方的长处**。
