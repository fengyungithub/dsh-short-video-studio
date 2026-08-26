# 架构审查与优化意见

对 `dsh-short-video-studio` 当前架构的审查。与 `consistency-optimization-plan.md`（功能层：一致性与镜头规划）互补，本文只谈**架构层**：代码组织、真相来源、信任边界、可测试性。

审查基线：`lib/` 2827 行（`index.js` 1905 / `manifest.js` 369 / `client.js` 293 / `convert.js` 142 / `assets.js` 118）。

---

## 0. 先说做得好的部分

这些是应当保留并继续依赖的架构决策：

- **manifest 契约层设计干净**。`capability` 词汇 + inject 原语（`scalar` / `image via:field` / `image via:node`）+ `$model` 哨兵 + `$assets.*` 占位，配合 `validateManifest`，做到了"加第四个模型只需丢一份 json"。这是整个项目最有价值的一层。
- **路径安全严谨**。`handleMedia`（lib/index.js:1716）做了 `safeRelative` → `resolve` → `inside` → `realpath` → 再 `inside` 的五步校验，连符号链接逃逸都堵了。这在同类插件里少见。
- **写入安全**。`saveProject` 用 tmp + rename 原子写，配 per-session 写锁。
- **插件边界清晰**。零 `@deepseek-ai/*` 运行时导入，全靠注入 `ctx`，宿主/浏览器两半分明。
- **校验失败即拒绝**。`loadBuiltinManifests` 对非法清单报错而非静默降级。

下面的问题不影响上述判断——它们大多是"快速迭代出功能后没回头整理"的产物，不是设计缺陷。

---

## 1. 三套真相并存，且已经漂移（P0）

`systemPrompt` 的 `GUIDANCE` 常量（lib/index.js:1761-1797）与 `skills/3d-animation-short-generator/SKILL.md` 有大面积内容重复：工具契约、Step 0-8 流水线、门控纪律、实践要点、边界，两边各写一遍。

### 1.1 三视图/单视图矛盾 —— ✅ 已修复

曾经的三方矛盾（历史记录）：

| 位置 | 关于角色卡视图的表述 |
|---|---|
| `lib/index.js:1776`（GUIDANCE Step 3） | 「含正/侧/背**三视图**与 speaks_on_screen 标注」 |
| `lib/index.js:1790`（同一段 GUIDANCE 实践要点） | 「三视图会导致**多个角色副本**；请用单视图，或在 prompt 声明只出现一只」 |
| `SKILL.md:39` | 「**单视图**正面全身」 |

同一个 prompt 内部先让 Agent 生成三视图，再告诉它三视图会出副本——这是直接导致角色一致性劣化的活 bug。

已按 `three-view-experiment.md` 的实测结论修完（GUIDANCE Step 3 改单视图；删除被 C 臂证伪的「prompt 声明只出现一只」退路；新增「参考图零文字」与「多角度无增量价值」两条实测硬规则；README/SKILL.md 同步；`examples/fox/` 标注为反面示例）。`mock-apply.mjs` 校验通过。

### 1.2 GUIDANCE 与 SKILL.md 大面积重复 —— 仍未解决

工具契约、Step 0-8 流水线、门控纪律、实践要点、边界，两边各写一遍。1.1 的矛盾就是这种重复的必然产物：改一处忘另一处。**修掉一次矛盾不等于消除了产生矛盾的机制。**

建议：

1. GUIDANCE 只保留「工具契约 + 项目语义 + 指向 skill」，Step 0-8 的流程细节全部只在 SKILL.md 维护。理由：skill 可热更新、可被技能中心发现、可被用户覆盖；GUIDANCE 编译进插件，改一次要重装。流程细节放在低频变更的那一侧是错的。
2. 若确实需要 GUIDANCE 里有流程摘要，让它**从 SKILL.md 构建时生成**，而不是手抄。

这一条应排在其他架构改动之前——散文层只要还有两份真相，下游任何一致性改造都会重新长出矛盾。

---

## 2. 约 160 行 legacy 死代码（P1）

`runImageGeneration`（586）、`runVideoGeneration`（631）、`buildFluxImageWorkflow`（327）、`buildH3VideoWorkflow`（383）、`buildH3ImageToVideoWorkflow`（436）**已无生产调用点**。全部 12 个工具和 2 条生成路由都走 `runRender`（1018 / 1061 / 1328 / 1697 / 1707）。

这些函数目前只通过 `_internals`（1880）导出给 `scripts/smoke-manifest.mjs` 做「manifest 编译结果 vs legacy 构造结果」的节点类型等价性比对。

问题在于**两套图构造逻辑并存的维护成本**：改 manifest 时不会有人同步改 legacy builder，于是等价性测试从"保护网"退化成"误报源"——它会在一次正当的 manifest 演进后失败，然后被人为放宽或注释掉。

建议：等价性比对已完成 M1 迁移的历史使命。

- 要么删除 legacy 路径，`smoke-manifest.mjs` 改为对**冻结的期望图快照**做断言（golden file）；
- 要么把 legacy builder 明确移到 `test/fixtures/legacy-builders.js`，标注 test-only、不再随 manifest 演进，并从 `_internals` 移除。

第一种更好：golden file 快照能表达"这次改动确实改了图"，而 legacy 对照只能表达"和一个不再演进的旧实现一样"。

---

## 3. `lib/index.js` 1905 行承担 8 个职责（P1）

当前单文件包含：配置解析、ComfyUI HTTP 客户端、工作流构造、画布持久化、渲染编排、HTTP 路由、12 个工具定义、systemPrompt 文本。

项目已经拆出 `assets.js` / `manifest.js` / `convert.js`，说明拆分方向是明确的、只是没走完。建议继续按现有风格拆：

```
lib/
  comfy.js      ComfyUI 客户端（comfyFetch/Submit/Wait/Outputs/Download/UploadImage）
  canvas.js     project.json 读写、锁、nextOrder、GROUP_ORDER、persistMedia
  render.js     resolveManifest/resolveMode/computeManifestSize/buildRenderGraph/runRender
  routes.js     makeRoutes + handleApi/handleMedia/handleStatic
  tools.js      makeTools
  guidance.js   systemPrompt 段（见第 1 节，理想情况下由 SKILL.md 生成）
  index.js      配置 + apply() 装配
```

这不只是审美问题。`runRender` 里混着尺寸推导、资产覆盖、上传、提交、轮询、下载、落盘、写节点八件事，任何一环要加测试都得把整条链路搭起来。拆开后 `buildRenderGraph`（已是纯函数，`smoke-render.mjs` 已在测它）之外的部分也能单独测。

配套：**给工具定义加一层 wrapper**。当前 12 个工具各写一遍

```js
try { ... } catch (error) { return { ok: false, ..., error: error?.message || String(error) } }
```

抽成 `defineTool({ name, description, schema, output, run })` 统一兜错。收益不止是少写 12 遍——错误信息的可诊断性可以集中改进（目前直接透传 `e.message`，`generation-error: ComfyUI 无输出` 这类信息对用户没有下一步指引）。

---

## 4. 没有测试入口，也没有 CI（P1）

`package.json` **没有 `scripts` 字段**。`scripts/` 下 8 个文件全靠手动 `node scripts/xxx.mjs` 执行。

这些文件其实分两类，混在一起是问题所在：

| 需要活的 ComfyUI | 纯逻辑，可 CI |
|---|---|
| `e2e.mjs`、`e2e-comfy.mjs`、`smoke-flux2.mjs`、`smoke-submit.mjs` | `smoke-manifest.mjs`、`smoke-render.mjs`、`mock-apply.mjs` |

右边三个不需要任何外部依赖，却和左边一样只能手跑。建议：

```jsonc
"scripts": {
  "test": "node scripts/smoke-manifest.mjs && node scripts/smoke-render.mjs && node scripts/mock-apply.mjs",
  "test:e2e": "node scripts/e2e.mjs",          // 需 ComfyUI
  "import": "node scripts/import-comfy.mjs"
}
```

加一个只跑 `npm test` 的 GitHub Action。理由：`consistency-optimization-plan.md` 里提的 `shotlist_validate()`（把七项自检编译成代码断言）价值完全取决于有没有地方持续运行它。没有 `npm test`，新增的校验逻辑第二周就会腐烂。

另外 `e2e-out/` 和 `docs/`、`lib/assets.js`、`workflows/` 等一批文件目前未纳入 git（`git status` 显示 untracked）。生成产物应进 `.gitignore`，源码应尽快提交——当前状态下 M1/M2 的成果不在版本控制里。

---

## 5. tokenless 路由的信任边界（P2，需明确而非必须改）

会话数据路由都有 token（`requireToken`，1577）、`/media` 用 query token，做得对。但 `/config` 和 `/workflows` 是显式 tokenless 的（注释在 1490、1516）。

其中 `POST /workflows` 会把请求体里的 manifest 校验后**写入 `USER_WORKFLOWS_DIR` 并 `reloadRegistry()`**。manifest 的 `graph` 允许任意 `class_type`、`assets.default` 是任意 safetensors 文件名。`POST /config` 可以改 `baseUrl`——把后续所有生成请求指向任意 URL。

威胁模型上这是本地插件、监听本地端口、由 DSH 设置页调用，攻击面有限。但"任何能访问该端口的本地进程都能改写工作流清单和后端地址"值得是一个**明确的决定**，而不是注释里一句"tokenless，仅读写本插件配置"带过——`/workflows` 写的不是配置，是会被执行的图。

建议二选一：

- 给这两条路由也加 token（`client.js` 本来就持有 token，成本极低）；
- 或在 `docs/` 里写清威胁模型，并确认服务绑定 `127.0.0.1`。

倾向前者：成本几乎为零，且移除了一个需要读注释才能理解的例外。

---

## 6. `schemaVersion` 有字段无迁移（P2）

`emptyProject`（499）写入 `schemaVersion: 1`，但全仓库只有这一处引用——`loadProject` 从不检查，也没有 `migrate()`。

单看无害，但 `consistency-optimization-plan.md` 的 W3 会引入新节点类型 `kind: 'shotlist'` 和新字段结构，届时老会话的 `project.json` 需要迁移路径。建议现在就补一个骨架：

```js
function migrateProject(p) {
  if (p.schemaVersion === 1) { /* v1 → v2 */ }
  return p
}
```

在 `loadProject` 里调用。趁只有一个版本时把机制立起来，比事后补便宜得多。

---

## 7. 前端两处需要在功能改造前先动（P2）

`studio/app.js`：

- `registerAssetToLibrary`（291）用 `window.prompt` 收资产名、`alert` 报错。iframe 内的 `prompt` 体验差，更关键的是**只能收一个字段**。W1 要求入库时录入 `displayName` / `state` / `identityPrompt` / `speaksOnScreen`，必须改成表单。这是 W1 的前置项。
- 节点渲染是全量重建（`load()` 后重画）。当前规模没问题，不建议优化。

`lib/client.js` 设置页仍是**固定字段列表**（fluxUnet/h3Clip/... 逐个硬编码），而 manifest 已经声明了 `assets` 及其 `label`/`env`。这正是 `docs/workflow-contract.md` 里 M4 的内容：改为按 registry 动态渲染。当前状态下加一份新 workflow 虽然"零 JS 改动"就能被 `comfy_list_workflows` 看到，但它的资产在设置页里配不了——解耦只做了一半。

---

## 8. 优先级汇总

| 优先级 | 事项 | 规模 | 理由 |
|---|---|---|---|
| ~~P0~~ ✅ | ~~修 GUIDANCE 三视图/单视图矛盾（§1.1）~~ **已完成** | — | 活 bug，已按实测结论修复 |
| **P0** | 消除 GUIDANCE / SKILL.md 重复，单一真相（§1.2） | 小 | 否则一致性改造无准绳；与 M3 合并做 |
| **P1** | 补 `npm test` + CI（§4） | 小 | 后续所有校验逻辑的载体 |
| **P1** | 提交未入库源码、`e2e-out/` 进 gitignore（§4） | 小 | M1/M2 成果目前不在版本控制 |
| **P1** | 清理 legacy 死代码，改 golden file（§2） | 中 | 消除两套图构造逻辑 |
| **P1** | 拆分 `index.js` + `defineTool` wrapper（§3） | 中 | 可测试性前置条件 |
| **P2** | tokenless 路由加 token（§5） | 小 | 移除需读注释才懂的例外 |
| **P2** | `migrateProject` 骨架（§6） | 小 | W3 前置，趁早立机制 |
| **P2** | 入库表单化（§7） | 中 | W1 前置 |
| **P2** | 设置页按 registry 动态渲染（§7，即 M4） | 中 | 补完 manifest 解耦 |

建议节奏：**P0 两项 + P1 前两项先做**（合计改动很小，但把"矛盾的指令"和"没有测试"这两个会污染后续一切工作的问题清掉），然后再进 `consistency-optimization-plan.md` 的 P0/P1。

---

## 9. 不建议做的事

- **不要重写 manifest 契约层**。它是项目最好的一层，后续所有模型扩展（身份锁、image2image、抽帧）都应该以"丢一份 json"的方式接入，而不是加 JS 分支。
- **不要拆 `project.json` 为 per-node 文件**。当前全量读写 + 写锁 + 原子 rename 对短片规模（数十节点、media 只存相对路径）完全够用。单会话镜头数上到 50+ 再议。
- **不要引入构建步骤给 `studio/`**。自包含无构建的前端是这个插件能被 `dsh plugin add` 直接装起来的原因之一，加 bundler 得不偿失。
- **不要在拆分 `index.js` 的同时改行为**。先纯搬迁 + 跑通 `npm test`，再改逻辑。两件事混做会让 legacy 清理的风险无法界定。
