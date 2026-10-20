# 生成视频工作流逐步对比：dsh-short-video-studio vs Toonflow-app

> 对比对象：本项目 `dsh-short-video-studio` v1.11.0（本地 checkout，commit `7c0ef9a`）
> Toonflow-app（本地 `/Users/seiue/Workspace/Toonflow-app`，节点包 2.0.0、workflow skill 2.7.0，commit `2c7fb25`）
> 只看「从一句需求 / 定稿剧本，到一条可交付视频」的**执行链路**，不重复 `docs/toonflow-comparison.md` 里的架构层对比。
> 所有 Toonflow 结论均给出文件路径与行号；本项目结论给出 `lib/` / `skills/` 路径。

---

## 0. 一句话结论

| | Toonflow-app | 本项目 |
|---|---|---|
| 谁持有生成任务 | **浏览器里的画布节点**（关页 / 卸载节点即中断） | **宿主进程里的渲染编排**（Agent 工具调用同步等待完成） |
| 原子生成单位 | **片段**（一个视频节点内含多个内部镜头，Seedance 一次 15s / 30s） | **单镜**（一个视频节点 = 一个镜头，默认 124 帧 ≈5s） |
| 镜间连续性靠什么 | **提示词 + 参考资产 + 用户回报的末态**（无 latent 续接） | **服务端 latent 链式续接**（`continuity_from`） |
| 成本 / 规格模型 | **按模型**（模型自带 mode / durationResolutionMap / audio） | **按能力 × 档位**（capability × tier → 实现清单） |
| 可复现性 | 记录 prompt/模型/规格，**无 seed** | 节点记录 **seed / tier / 实现 / 尺寸 / 链序号**，可复现 |
| 收尾 | 交片段索引；拼接要另用 ffmpeg 工具或外部剪辑 | 内建拼接 + 逐镜超分 + 渠道自动送达 |

一句话记法：**Toonflow 把「生成」放进节点、把「授权」放进流程；本项目把「生成」放进宿主、把「连续性与档位」放进契约。**

---

## 1. 两条链路的全景

### Toonflow

```
用户/Agent(skill: workflow)
  → 画布工具(canvas): getCanvas / findCanvasNodes / getNodeTools / nodeTools
  → 节点函数: node:setPrompt / node:setConfig / node:generateVideo
  → 浏览器节点 startGeneration()
      （组装 providerId/modelId/prompt/mode/duration/resolution/ratio/generateAudio
        + images / firstFrame / lastFrame / videos / audios）
  → POST /api/ai/media/generate（流式 JSON，20s 心跳）
  → 服务端 zod 校验 → 读工作区参考文件→base64（100MB 上限）
  → 供应商 TS 适配器（TF-Router / APIMart / 秘塔 / 优云）
      → 提交任务 ID → 每 3s 轮询 → 最多 30min
  → 下载结果 → sniff MIME → 写 assets/<nodeId>/video-<uuid>.mp4
  → 返回相对路径 → 节点 outputs.video
  → 人工预览、反馈、采用
  → （可选）ffmpeg 工具 concat / 外部剪辑
```

### 本项目

```
Agent(skill: story-short-generator / brand-promo / video-generate)
  → comfy_generate_video(type='r2v'|'i2v', tier, ref_nodes / first_frame_node / continuity_from)
  → runRender()
      ① 档位解析：capability + tier → 配置(pins/preferred/selection) → 实现清单
      ② 形状×参数校验（上传前，零副作用）
      ③ 参考图/首末帧/源视频 → /upload/image 进 ComfyUI
      ④ 链式续接：上一镜 clipIndex → Load N / Save N+1，多采 22 帧再裁
      ⑤ manifest 编译：注入 prompt/width/height/length/seed/steps/refs
  → POST /prompt → 每 2s 轮询 /history → 15min 超时
  → /view 下载 → canvas/<sessionId>/<file> + project.json 节点(params 全量记账)
  → 返回 nodeId / absPath / tier / resolution / warnings
  → 抽帧自检（首/中/末 + 说话窗）→ 人工门 → 下一镜
  → video_concat → video_upscale（可选）→ 交付清单 + 渠道送达
```

---

## 2. 逐步对比

### Step 0 · 入口与项目上下文

| | Toonflow | 本项目 |
|---|---|---|
| 上下文载体 | 「项目 + 画布」（Vue Flow 文档）；node 类型与函数要现场发现 | 「会话画布」`canvas/<sessionId>/project.json` + `settings` |
| Agent 先做什么 | `getCanvas` → `findCanvasNodes` → `getCanvasNodes` / `getCanvasEdges` → `getNodeTools`（分页 / 64KiB 限制） | `asset_list` 查库 → `canvas_set_state` 持久化画幅 / 时长 / 音频 / 档位 / 审查节奏 / groupOrder |
| 入口规则 | skill `workflow` 一命中「已定稿剧本 + 要做视频」就锁存 Seedance 路由，先做提示词规划，不许先去查节点配置 | skill `story-short-generator` STEP 0 出 8 张选项卡，全部确认后写简报 |
| 证据 | `packages/skills/workflow/SKILL.md`、`packages/skills/workflow/references/canvasExecution.md` | `skills/story-short-generator/SKILL.md:145`（STEP 0）、`lib/index.js` 画布状态 |

**差别**：Toonflow 的画布是**执行现场**（节点即任务），本项目画布是**产物看板**（Agent 用工具直接读写 project.json）。前者要求「画布必须开着」，后者无此要求。

### Step 1 · 内容 → 剧本 / 分镜文本

| | Toonflow | 本项目 |
|---|---|---|
| 文本流水线 | `workflow` skill 内嵌 PART A（A0–A12）：输入判定 → 剧情保真锁 → 全片段表 → 分段 → 模板 → A11 结构校验 → A12 单次抛光 | STEP 1 简报 → STEP 2 大纲守门 → STEP 5 七列镜头表 → STEP 5.5 十一项自检 → STEP 6 单文本分镜文档 |
| 多 Agent | 可选 `storyboardTeam`（director / writer / reviewer，声明式 team.json，只读工具，**不生成媒体**） | 单 skill 分阶段；无角色分工，靠阶段门控 |
| 交付形态 | 文本节点（`node:setText`）+ 状态文件 `productionState.md` | 画布 text/table 节点 + 分组（story planning / shot table / text storyboards） |
| 证据 | `packages/teams/storyboardTeam/team.json`、`packages/skills/workflow/SKILL.md`（PART A）、`skills/story-short-generator/SKILL.md:197,300,352,375` | 同左 |

**差别**：Toonflow 的提示词规范**内嵌在流程 skill 里**（A9.1 Seedance 2.0 / A9.2 Seedance 2.5 两套模板）；本项目的提示词规范**外置到 `h3-prompt-writing` skill**，主 skill 只负责传数据（镜头表 + 参考锚点 + 音频轨）。

### Step 2 · 资产（角色 / 场景 / 道具）

| | Toonflow | 本项目 |
|---|---|---|
| 做法 | 图片生成节点出角色（面部特写 + 正侧背三视图）/ 场景 / 道具；全局素材库 `assetOperator` 可 `import` 到工作区 | `comfy_generate_image(tier=quality)` 出角色卡 / 场景卡 / 道具卡；`asset_list` / `asset_to_canvas` 复用跨会话资产 |
| 形态规则 | 资产图规范（角色多视图） | **形态随视频档位**：视频 `fast` → 单视图正面全身；`balanced`/`quality` → 三视图横排（`skills/story-short-generator/SKILL.md:72`） |
| 图片规格 | 模型声明 `imageSizes` / `imageRatios`，节点默认最低分辨率、比例 16:9 | 图片档位独立于视频：`fast` 1024 / `balanced` 1344 / `quality` 2048 长边，按画布比例推导（`comfy_list_workflows` 实测同值） |
| 身份约束 | 参考资产 + 提示词；**无 seed、无 LoRA / IPAdapter** | 参考资产 + 提示词 + seed 记账；同样无身份锁，靠「参考图形态门禁 + 文风锚点」 |

**差别**：本项目多一条**参考图形态门禁（G-ref）**——`fast` 档进 `ref_nodes` 的图必须单主体 / 单视图 / 零文字 / 无拼图，否则成片出角色副本（`SKILL.md:97`）。Toonflow 没有这条，因为它把「资产图」和「参考绑定」都交给模型能力与提示词。

### Step 3 · 原子生成单位与规划粒度（最关键的分歧）

| | Toonflow | 本项目 |
|---|---|---|
| 一个视频节点承载什么 | **一个片段**，可含多个内部镜头 / 动作；「不把内部镜头拆成多个节点」 | **一个镜头**，一部片子 N 个片段节点 |
| 单次时长上限 | Seedance 2.0 ≤15s，2.5 ≤30s；单批交付 6 段 / 3 段 | 镜头表硬卡单镜 ≤15s；实际 `length` 走 17k+5 网格（默认 124 ≈5.17s） |
| 连续性规划 | 段内靠提示词写多镜；段间靠 A7.3 景别/角度切换 + A8 状态链**文字重述** | 镜头表 `续接` 列：`起链` / `接 S0x` / `锚定 S0x↔S0y`，生成时翻译为 `continuity_from` / 首末帧 |
| 证据 | `packages/skills/canvas/references/videoProduction.md:7,42`、`SKILL.md` A3.4/A7/A8 | `skills/story-short-generator/SKILL.md:300`（镜头表）、`:503`（续接策略） |

**后果**：Toonflow 用「一次生成多个镜头」换**镜内自然衔接**，代价是**跨段只能硬切 + 文字连续性**；本项目用「一镜一片段」换**可重渲、可续接、可逐镜质检**，代价是**片段数多、拼接与接缝必须自己解决**。

### Step 4 · prompt 组装与参考绑定

| | Toonflow | 本项目 |
|---|---|---|
| 组装依据 | 片段计划（PART A）→ 目标模型模板：2.0 用 A9.1「资产标识 + 正式提示词」，2.5 用 A9.2 `Objective / Reference binding / Immutable locks / Target duration / Timeline / Visual direction / Audio direction / Preserve / Avoid` | 分镜章节 + 镜头表 `参考锚点` / `音频与对白轨` → `h3-prompt-writing`：r2v 走 **Ref2VA 六段式**，i2v 走 **I2VA/FL2VA 三段式** |
| 参考标记 | `{{ref N}}`，N = 有效入边排序（`referenceOrder` + 入边顺序），文本与媒体共用编号；**编号错了不许猜** | `ref_nodes` 直接传画布节点 id / 资产 id；首末帧走 `first_frame_node` / `last_frame_node`；工具面不接受 `{{ref}}` |
| 校验 | 执行层核对 prompt / 引用 / 规格不一致就停 | 宿主 `tools/pre-execute` 监听器：H3 系实现缺 Ref2VA / I2VA 章节**直接 deny** 并提示去加载 skill；`[PROMPT_FALLBACK]` 显式放行（`lib/index.js:2692`） |
| 证据 | `packages/nodeShared/src/useNodeReferences.ts:14-18`、`canvasExecution.md`「真实引用与提示词」 | `lib/index.js:2681-2746`、`skills/h3-prompt-writing` |

**差别**：Toonflow 的 prompt 规范与执行是**同一个 skill 的两段**；本项目是**两个 skill + 一道宿主门禁**。前者一句话就能改规则，后者改规则要同时动 skill 与门禁（已知架构债：门禁按实现 id 前缀 `minimax-h3-` 匹配）。

### Step 5 · 模型 / 能力 / 规格选择

| | Toonflow | 本项目 |
|---|---|---|
| 能力发现 | `listMediaModels` 返回每个模型的 `mode[]` / `durationResolutionMap` / `audio` / `imageSizes`；工具描述写死「不能猜模型 ID」 | `comfy_list_workflows` 返回 **capability × tier**（可用性 / 长边 / 实测耗时 / 是否支持续接） |
| 选择维度 | providerId + modelId + mode + duration + resolution + ratio + generateAudio，**逐项按模型能力校验**（`videoGenerationNode/src/index.vue:176-203`、`generationSettings.vue:58-67`） | **只传 capability + tier**；分辨率由画布 `aspectRatio × 档位长边` 推导（snap32），显式宽高可覆盖；实现由配置面决定 |
| 模式自动匹配 | 按已连素材数量反推可用 mode（text / singleImage / startEndRequired / endFrameOptional / startFrameOptional / `imageReference:N` 数组）；`startFrameOptional` 且只有 1 张图时**该图当尾帧**（`index.vue:160-174,290-291`） | 形状显式声明 `type=r2v|i2v`，冲突直接报错（如 r2v 带首帧）；`VIDEO_SHAPES` 真值表 + `validateVideoArgs`（`lib/index.js:1204-1250`） |
| 不一致时 | 只报错/只改允许的字段，不静默降级 | 参数没有注入点 → **warnings 如实回报**；实现锁分辨率 → 显式宽高不生效并告警 |
| 默认值 | 节点只给未设置项补：**最短时长 + 对应最低分辨率、比例 9:16、声音随模型**（`videoProduction.md:81`） | 画布 `settings` 统一（aspectRatio / duration / mode）；工具缺省 `quality` 档 |
| 证据 | `packages/tools/mediaGeneration/src/index.ts`、`packages/providers/types.d.ts` | `lib/index.js:1230,1291,1526,2033-2047` |

**差别**：Toonflow 的能力声明是**模型级**（换了模型就换一套 mode/时长/分辨率），本项目是**档位级**（同一能力同档可换实现，调用方无感）。前者对模型差异诚实，后者对成本与可替换性友好。

### Step 6 · 生成前授权 / 门禁

| | Toonflow | 本项目 |
|---|---|---|
| 阶段门 | `askUser`：每阶段成果确认后才推进；**内容确认 ≠ 算力授权 ≠ 结果采用**；跳过 / 沉默不算批准；执行前重读节点，防止等待期间的修改被顺便批准 | STEP 0 八项选项卡 → STEP 5.5 镜头表自检门 → STEP 7 渲染参数门 + G-ref → 门 3（`reviewMode` 逐镜 / 批量） |
| 算力授权 | 生成前必须给「对象/数量/模型/规格/完整提示词/参考/次数」并取得明确同意 | STEP 7 渲染参数卡；工具调用本身即授权动作，无独立「授权令牌」 |
| 证据 | `canvasExecution.md`「生成前准备」、`videoProduction.md:20-22`、`packages/tools/askUser/readme.md` | `skills/story-short-generator/SKILL.md:483`（STEP 7 渲染前的门）、`:555`（门 3） |

**差别**：Toonflow 的授权语义更细（三种确认分离、跳过≠批准）；本项目的门禁更偏**生产规格与参考图形态**（档位、G-ref、续接链闭合性）。

### Step 7 · 提交生成（真正发请求）

| | Toonflow | 本项目 |
|---|---|---|
| 发起者 | **浏览器节点** `startGeneration()`（`videoGenerationNode/src/index.vue:267`）；Agent 调 `node:generateVideo` 只是启动它 | **宿主** `runRender()`（`lib/index.js:2008`）；Agent 直接调工具 |
| 请求体 | providerId/modelId/prompt/mode/duration/resolution/ratio/generateAudio + `images` 或 `firstFrame`/`lastFrame` + `videos` + `audios`（`index.vue:279-294`） | manifest 编译图：`prompt / width / height / length / seed / steps / guidance / refs / first_frame / last_frame / context_clip_index / save_clip_index` |
| 传输 | 单次 POST 持住响应，20s 写一个换行保活；`res.close` / `req.aborted` / `socket.close` → AbortController（`apps/server/src/routes/ai/media/generate.ts:19-40`） | `POST /prompt` → `prompt_id`；`GET /history/{id}` 每 2s 轮询，15min 超时（`lib/index.js:308-348`） |
| 适配层 | 供应商 TS 适配器：`generateVideo` 把 mode 映射成平台 metadata（TF-Router 里按模型分支 kling / grok / 通用 references，`packages/providers/src/media/tfRouter.ts:262-325`） | 工作流 JSON manifest：注入点把任务值写进 ComfyUI 图节点；换模型 = 换 JSON |
| 任务生命周期 | 供应商内部提交 taskId，每 3s 轮询，最多 30min（`tfRouter.ts:82-99`） | ComfyUI 队列；宿主轮询 history |
| 另一条入口 | Agent 也可直接调 `generateVideo` 工具写工作区（`packages/tools/mediaGeneration`），但画布规范要求「不绕过节点做画布工作」 | 只有一条入口（工具），HTTP 路由是同一 `runRender` 的另一个壳 |

### Step 8 · 等待与状态

| | Toonflow | 本项目 |
|---|---|---|
| Agent 看到什么 | 节点立即返回 `{status:"generating"}`；`getGenerationStatus` 只反映**本次打开节点后**的内存状态（idle/running/succeeded/failed，`packages/nodeShared/src/useNodeGeneration.ts:10-33`） | 工具调用**同步阻塞**到完成，直接返回 nodeId / 媒体路径 / tier / 尺寸 / warnings |
| 跨轮恢复 | 状态不持久化；刷新后 status 回 idle，旧输出仍在 | 节点已写入 project.json（status=ready），任何时候可读 |
| 中断条件 | 关页 / 卸载节点 / 停止按钮 → abort；供应商不保证撤销任务或退费 | AbortSignal → `generation cancelled`；ComfyUI 任务可能仍在队列里跑 |
| 语义风险 | 必须明确「已提交 ≠ 已完成」，无等待工具就结束本轮请用户回报 | 无此风险（一次调用拿到结果），但长镜头会占住一次工具调用 |

**这是两边最本质的工程差异**：Toonflow 的生成是**页面的副作用**，本项目的生成是**宿主的同步过程**。前者可边聊边生成，后者可靠、可脚本化。

### Step 9 · 取回与落盘 / 记账

| | Toonflow | 本项目 |
|---|---|---|
| 落盘 | `assets/<nodeId>/video-<uuid>.mp4`；服务端嗅探 MIME、限制 100MB、失败回滚本次文件（`apps/server/src/utils/media/generation.ts:131-190`） | `canvas/<sessionId>/<filename>`；节点 `media` 存相对路径 |
| 节点记录 | `data`：prompt / model / duration / resolution / ratio / mode / generateAudio；`outputs.video`：`{url, mimeType}` | `params`：workflow / capability / type / model / mode / tier / seed / width / height / length / requested/sampled / clipIndex / continuityFrom / prompt / ref_nodes / first/last_frame / assets / warnings（`lib/index.js:2158-2206`） |
| 尝试历史 | 靠 `productionState.md` 手工登记；撤销历史只存结构与名称，**不含节点内容与生成结果**（`apps/web/src/pages/workspace/panels/canvas/useCanvasHistory.ts:28-33`） | 节点参数即快照（同一 nodeId 覆盖时保留 order/createdAt）；旧版本靠画布另建候选节点 |
| 可复现 | **无 seed**；同 prompt 重出即换样 | seed + 实现 + 尺寸 + 链序号全记录，可原样复现 |

### Step 10 · 结果审查（QC）

| | Toonflow | 本项目 |
|---|---|---|
| Agent 能看视频吗 | 不能。路径存在 ≠ 看过；`stateAndDelivery.md` 要求如实区分「Agent 已检查 / 未检查」 | 不能直接看视频，但可 `extract_frame` 抽帧后按图片核对 |
| 抽帧能力 | 视频节点 UI 下拉菜单（当前帧 / 首帧 / 尾帧）——**人工操作**；Agent 侧无专用节点函数，只能另用 ffmpeg 工具的 `screenshots` | `extract_frame(video_node, frame_index)` 是 Agent 工具，产物直接是画布图片节点 |
| QC 门 | 无自动质检；由用户预览 + `stateAndDelivery` 的核验清单（身份、穿帮、道具、声音） | 逐镜 AI 自检：首/中/末帧 + 说话窗帧；对照镜头表与角色卡；字幕逐字、口型、无分镜痕迹、风格漂移；音频由人工听核 |
| 人工确认时机 | 每阶段 `askUser`；片段采用由用户决定 | `reviewMode`：`per-shot` 逐镜确认 / `batch` 批量审查（AI 自检两种模式都逐镜做） |
| 证据 | `canvasExecution.md:86-96`、`stateAndDelivery.md:67-69` | `SKILL.md:555`（门 3） |

### Step 11 · 续接与重渲

| | Toonflow | 本项目 |
|---|---|---|
| 镜间连续性机制 | **无 latent 续接**。段内多镜靠一份提示词；段间靠 A8 状态链把「上一段末态」重写成本段绝对初态；首尾帧仅用户明确要求时才用 | `continuity_from=上一镜节点 id` → 消费服务端 latent：钉住末段 22 帧画面 + 24 帧音频，多采后裁掉；接缝画面差实测 2.6–7.0（对照 32–68） |
| 链约束 | — | ① 上游必须是链式实现（否则「上一镜没有链式序号」）② 链内**首遍尺寸**一致（交付尺寸可不同）③ 跨场景不续接 |
| 重渲 | 重新生成即新文件，旧输出保留；**换样不可控**（无 seed） | 同 seed 可复现；改 prompt / 档位 / 尺寸都记在节点上；上游重渲 ⇒ 下游续接镜顺次重渲 |
| 证据 | `SKILL.md` A7.3 / A8；`videoProduction.md` | `lib/index.js:2066-2115`、`docs/shot-chain-continuity.md` |

### Step 12 · 跨场景转场

| | Toonflow | 本项目 |
|---|---|---|
| 有没有 | **没有转场生成**。跨场景靠剪辑点 + A7.3 景别/角度差 ≥2 档 / ≥90° 规避「像错误续帧」 | 生成式转场镜：`extract_frame` 抽前镜末帧 + 后镜首帧 → i2v 双端锚定（可叠 `continuity_from` 拿尾部画面与音频） |
| 已知坑 | — | 烧录字幕会被继承（末帧带字幕 → 转场镜开场带字幕）；`length=39` + fast 中段易糊 → 转场建议 ≥56、成片用 quality |
| 证据 | `SKILL.md` A7.3 | `SKILL.md:602`（跨场景转场镜）、`ARCHITECTURE.md` §3.2 |

### Step 13 · 拼接成片

| | Toonflow | 本项目 |
|---|---|---|
| 内建拼接 | **没有**。`video_concat` 类工具不存在；只有 agent 侧的 `ffmpeg` 插件工具（`operation: concat`）或用户外部剪辑 | `video_concat(nodes[])`：ffmpeg concat demuxer + `-c copy`，失败自动 libx264/aac 重编码；无 ffmpeg 时退化 ComfyUI 纯节点左折叠（`lib/concat.js`） |
| 前置约束 | 无（不承诺能拼） | 硬切无溶解；建议同分辨率；ComfyUI 后端要求各段尺寸一致 |
| 交付口径 | 只有真的合成了才说「成片」，否则交片段索引（`stateAndDelivery.md:74-75`） | 拼接是确定性后处理，产物写回画布 `final delivery` 组 |

### Step 14 · 超分与交付

| | Toonflow | 本项目 |
|---|---|---|
| 提分辨率 | 无后处理超分；只有模型原生 resolution（480p / 720p / 1080p） | `video_upscale(video_node, tier, target_width)`：x2 / x4 / SeedVR2，逐帧、音轨原样带回；不重画内容、不打断续接链；逐镜放大后重跑拼接 |
| 交付通道 | 工作区文件 + 画布预览；无自动外发 | 画布产物 + `ask` 前自动送达（飞书直接发媒体；文本/表格转 PDF；文件名取节点标题；20MiB 上限记录在 `params.deliveryError`） |
| 交付核对 | 交付清单 + 状态文件，区分已生成 / 已采用 / 已合成 / 已归集 | STEP 8 终检清单（一致性 / 连续性 / 口型 / 字幕 / 音频 / 无污染 / 画质与 STEP 0 选择一致） |

---

## 3. 关键分歧的后果

| 分歧 | Toonflow 的收益 | Toonflow 的代价 | 本项目的收益 | 本项目的代价 |
|---|---|---|---|---|
| 生成归属：页面 vs 宿主 | 边聊边生成、所见即所得、天然可取消 | 关页即断；状态不持久；无法脚本化 / 批处理 | 可靠、可恢复、可流水线、可并发控制 | 长镜头占住一次工具调用；进度只能靠日志 |
| 原子单位：片段 vs 单镜 | 镜内衔接自然、调用次数少、成本低 | 跨段只能硬切；坏一个内部镜头要整段重生成的粒度 | 逐镜可重渲、可质检、可续接、可替换 | 片段多；接缝与拼接必须自己解决 |
| 连续性：文字 vs latent | 实现简单、无服务端状态 | 同场景两镜会「重新演绎」；接缝靠剪辑规避 | 接缝接近同一段画面；音频也延续 | 有链约束（同首遍尺寸、上游必须链式实现）；上游重渲会连锁 |
| 成本模型：模型档 vs 档位 | 对模型差异诚实；换模型即换能力 | 调用方要懂模型；不同模型规格不可比 | 调用方只说 capability + tier；换实现不动流程 | tier 语义依赖配置正确；可能被配置悄悄换实现（已有 pins / 显式报错兜底） |
| 可复现：无 seed vs seed | 实现轻 | 重出不可控，一致性只能靠参考图 | 同 seed 可复现；参数全记账 | seed 不能跨实现迁移；换实现即换样 |
| 音频 / 字幕 | 按模型能力开关，不强行烧字幕 | 对白片需要后期字幕 / 口型风险 | AV 模型原生声音 + 画面内原生字幕，无后期 | 字幕写法与口型完全绑模型；换模型能力可能消失 |
| 收尾 | 交片段索引，剪辑自由 | 拼接与超分要靠外部工具，流程断在最后一步 | 拼接 + 超分 + 渠道送达闭环 | 拼接只硬切；无 BGM；2K/4K 易超送达上限 |

---

## 4. 各自适合什么

- **Toonflow 更适合**：多模型 / 多供应商的商业化生产（Seedance 2.0/2.5 多参、Kling、Wan、MiniMax 混用）、需要**平台级授权与计费语义**、需要桌面 / 移动 / 服务器多端、需要外部 Agent 通过 A2A 驱动、以及「一段多镜」的广告 / 短剧片段式生产。
- **本项目更适合**：完全本地、零云端依赖、要求**逐镜可控与可复现**、要求**镜间接缝质量**、要求**成本档位可预测**、以及需要把生产流程交给 Agent 自动跑完（含拼接 / 超分 / 送达）的场景。

**不要互相照搬的两件事**：
1. 不要把本项目的画布改成「节点自持生成」——会丢掉可靠性与可恢复性（Toonflow 自己也承认关页即断）。
2. 不要把 Toonflow 的「按模型名分支」搬进本项目——本项目的主张是插件不认识模型名，模式差异应下沉到 manifest 声明。

---

## 5. 一页速查

```
                   Toonflow-app                         dsh-short-video-studio
原子单位            片段（可多内部镜头）                  单镜
谁执行              浏览器节点                            宿主进程
后端                远程 provider（TS 适配器）            本地 ComfyUI（JSON manifest）
选择维度            provider + model + mode + 时长/分辨率   capability + tier
规格来源            模型 durationResolutionMap            画布 aspectRatio × 档位长边
连续性              提示词 + 参考图                       服务端 latent 续接
seed                无                                    有
生成等待            Agent 立即返回 generating，人工回报    工具同步阻塞到完成
抽帧                人工 UI / ffmpeg 工具                  Agent 工具 extract_frame
质检                用户预览 + 人工核验                    AI 逐镜抽帧自检 + 人工门
转场                无（靠剪辑与景别差）                   生成式 i2v 转场镜
拼接                外部 ffmpeg / 剪辑                     内建 video_concat
超分                无                                     内建 video_upscale
交付                片段索引                               成片 + 交付清单 + 渠道送达
```

---

## 6. 附：Toonflow 如何保证「分镜 = 成片」

> 先给结论：**它不做「生成后比对」，而是做「生成前把分镜编译成一份自包含、可执行、可审计的 prompt」，再把视频验收交给用户。**
> 它自己明确写了这条边界：`SKILL.md:1297`「本节是提示词侧的穿帮风险审计，不等于真实生成视频已经无穿帮……必须在媒体实际可读取时另做结果验收」。

### 6.1 第一层：单一事实源 —— 分镜就是 prompt

Toonflow 的生产路径**不产出「七列镜头表 → 分镜文档 → prompt」三层**，而是让 PART A 直接产出最终提示词（2.0 走 A9.1，2.5 走 A9.2）。「分镜」和「prompt」是同一份文档，因此没有二次翻译损耗。

保证靠三件事：

1. **源剧情账本 `E##`**（`SKILL.md:274-297`）：先按原文顺序拆原子节拍并编号；后续 Timeline 里**每一个会改变人物/道具/位置/数量/关系/信息的动作都必须能映射回某个 `E##`**，找不到就是 AI 新增剧情，必须删。
2. **剧情保真锁 A0.1**（`SKILL.md:96-168`）：只导演不编剧；新增、删除、替换、改顺序、改执行者、补前史全部禁止。
3. **单向审计**：A11.3 从 `E01→E02→…` 正查每个节拍是否都在成片计划里（`SKILL.md:1090-1101`）；A12.19 再把「不允许改变」的清单钉死并规定只做一轮（`SKILL.md:1299-1346`）。

→ **保证的是「提示词没有偏离剧本」**，不是「模型照做」。

### 6.2 第二层：把分镜写成模型能执行的状态（可执行化）

这一层是 Toonflow 真正花力气的地方——把「分镜语言」改写成「模型可执行的状态描述」：

| 机制 | 做法 | 位置 |
|---|---|---|
| 每段自包含 | 每段重写**世界坐标 + 画面坐标**，禁止写「延续上一段」；模型看不到上一段画面 | `SKILL.md:553-601` |
| 首帧锁 | 每个镜头首帧写清：有无人物、站/坐、画面左右、相对距离、朝向、视线、手里拿什么、道具在哪、机位高度、前中后景 | `SKILL.md:1150-1163` |
| 出镜锁 | 本镜不该出现的角色，显式写「不出脸/身体/手/倒影/影子」，防模型自动补人 | `SKILL.md:1165-1173` |
| 道具状态链 | 持有人 / 使用手 / 绝对位置 / 可见性 / 数量 / 开合 / 液面 / 损耗 / 段末去向 | `SKILL.md:1214-1225` |
| 参考绑定 | 真实节点/资产句柄**原样引用**、逐段重新列出、保留「仅站位/仅服装」用途限定、冲突不自行融合 | `SKILL.md:217-248`、`:952-961` |
| 模板硬门 | 2.5 最终正文只允许白名单字段，出现旧式外壳即判格式失败、不得交付 | `SKILL.md:852-869` |

→ **保证的是「计划是明确、可执行、无自相矛盾的」**；模型是否 100% 执行仍无保证。

### 6.3 第三层：风险前置（降低崩坏概率）

- **A11.4 生成稳定性预检**（`SKILL.md:1103-1140`）：先识别高风险组合（3 人以上同时大幅移动、双手精细接触 + 复杂运镜、镜子/玻璃/透明容器、多张参考互相冲突……），再按固定顺序降复杂度——**先删无关控制，再简化摄影机，最后才重分段**；明确「不能以稳定为理由删剧情」。
- **A12.18.1 最终穿帮审计**（`SKILL.md:1283-1297`）：为每段建「起态/末态快照」，只比较 A8 判定为连续关联的段对，检查人物瞬移/重复、道具消失/复制/换手、空间穿模、镜像多人物——但**只审文本，不看视频**。
- **段间衔接规则 A7.3**（`SKILL.md:663-692`）：相邻独立生成段至少满足「主体类型不同 / 景别差 ≥2 档 / 角度差 ≥90°」之一，避免两个独立片段看起来像错误续帧。

### 6.4 第四层：执行绑定（不让执行悄悄偏离计划）

- **节点能力逐项校验**：`mode` 必须匹配已连素材数量、`duration` 必须在 `durationResolutionMap` 里、`resolution` 必须匹配该时长、`audio` 必须匹配模型能力（`videoGenerationNode/src/index.vue:160-203, 385-401`）。prompt 写「6 秒」不能把 4 秒的节点变成 6 秒（`videoProduction.md:77`）。
- **引用顺序可核对**：`{{ref N}}` = 真实入边顺序 + `referenceOrder`；编号无法确认时**不猜、不触发**（`canvasExecution.md:56-62`）。
- **临执行复核**：读回节点 prompt / 配置 / 引用 / 旧输出，再与用户批准方案比对；等待期间被改过的内容不能顺便批准（`canvasExecution.md:75-80`、`SKILL.md:1392-1394`）。
- **授权快照**：内容确认 ≠ 算力授权 ≠ 结果采用；跳过/沉默不算批准（`SKILL.md:1390-1396`）。

→ **保证「发出去的请求 = 用户批准的那一版计划」**，这一层是硬约束。

### 6.5 第五层：结果验收（唯一真正的视频验收）

- **图片可核验**：Agent 的 `read` 工具支持图片附件（模型 `input: ["text","image"]`），所以角色/场景资产能由 Agent 读图检查身份、数量、服装、环境（`stateAndDelivery.md:61`）。
- **视频不可核验**：Agent 读不了视频，`stateAndDelivery.md:63-69` 要求请用户预览并回报问题、采用决定与下一段依赖的结束状态；Agent 必须标注「已检查 / 未检查」。
- **尝试台账**：每次生成登记提示词快照、模型与完整参数、参考文件/顺序/用途、调用前输出、授权范围与返回文件；**提示词版本与结果版本分开**（`stateAndDelivery.md:23-28, 47`）。
- **采用语义**：已采用文件挂独立素材节点；修订另建候选节点，旧版保留，下游确认后才切换（`stateAndDelivery.md:49-51`）。
- **抽帧是可选能力**：只有「真实需要且工具支持」时才抽帧；视频节点 UI 能截当前/首/尾帧，Agent 侧要另用 ffmpeg 插件的 `screenshots`——**不是默认质检门**（`stateAndDelivery.md:69`）。

### 6.6 它到底保证了什么

| 问题 | 靠什么 | 保证强度 |
|---|---|---|
| 分镜事件不被 AI 增删改 | `E##` 账本 + A11.3 + A12.19 | **强**（文本侧） |
| 提示词明确、可执行、无歧义 | 自包含站位 + 首帧/出镜/道具锁 + 模板硬门 | **强**（文本侧） |
| 引用的是真实资产 | 真实句柄 + 入边顺序 + 临执行复核 | **强** |
| 生成结果符合提示词 | 模型能力 | **无保证**（概率） |
| 成片符合分镜 | 用户预览 | **人工** |
| 跨段角色/场景一致 | 参考图 + 文字重述 | **弱**（无 seed、无 latent 续接） |
| 重出可复现 | —（无 seed） | **无** |

### 6.7 三个结构性弱点

1. **自检不是检测**：A11/A12 都是同一个 Agent 的文本自检，不是独立审查，也不是对成片的检测；A12.18.1 自己声明「不等于视频无穿帮」。
2. **视频验收外包给用户**：没有「抽首/中/末帧 → 对照 Timeline」的强制流程；抽帧要另装 ffmpeg 插件，且不在默认门里。
3. **一致性的物理基础薄**：无 seed、无 latent 续接、无 LoRA/IPAdapter 身份锁；跨段一致靠参考图 + 文字重述，**重出即换样**。另外节点会把**所有已连接的图片**都发给模型（`videoGenerationNode/src/index.vue:275`），提示词没提到的参考图仍可能造成污染，只能靠「只接本段需要的素材」的纪律规避。

### 6.8 一句话

**Toonflow 的一致性 = 把分镜写成一份自包含、可执行、可审计的 prompt，然后让用户验收。它优化的是「每段像计划」，不是「段与段像同一段」。**

对照本项目：我们把「分镜」拆成镜头表 + 分镜文档 + 结构化 prompt 三层，多了同步成本；但用 `extract_frame` 抽帧自检、seed 记账、latent 续接把「结果验收」和「段间一致」补上了一部分——代价是流程更重、依赖本地模型能力。
