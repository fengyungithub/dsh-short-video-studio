# dsh-short-video-studio 架构文档

> 本文档梳理 `dsh-short-video-studio`（v0.1.1）的整体架构：定位、模块划分、分层设计、关键数据流、目录职责与已知架构债。
> 配套文档：`docs/workflow-contract.md`（工作流契约设计）、`docs/architecture-review.md`（架构审查与优化意见）、`docs/consistency-optimization-plan.md`（一致性与镜头规划方案）、`docs/three-view-experiment.md`（参考图实验）。

---

## 1. 项目定位

**一个完全本地、免费、零云端依赖的类 MiniMax-Design 短剧 / 动画画布工作室**，以 **DeepSeek Harness 双面插件**（宿主半 + 浏览器半）形式存在。

- **画布页**：每个会话多一个「画布」视图 tab，按生产顺序预览 / 编辑各步骤产物。
- **生成服务**：统一走**本地 ComfyUI API**——图片用本地 FLUX 2，视频用本地 MiniMax H3（音视频 AV 模型，默认带声音、支持参考图绑定与原生字幕）。
- **Agent 工具**：`comfy_generate_image` / `comfy_generate_video` / `comfy_render` / `canvas_*` / `asset_*`，Agent 与画布页读写同一份持久状态。
- **自带 skill**：安装插件时自动把 `skills/` 下的 skill 复制到 `~/.dsh/skills/`，供模型 / 技能中心发现。

**核心架构主张**（贯穿全篇）：插件退化为一个**通用 ComfyUI 工作流执行器 + 注册表**。宿主不认识「FLUX」「H3」这些名字，只认识**能力（capability）**与**工作流清单（manifest，数据而非代码）**——换模型 / 换工作流 = 增删一份 JSON，不动 JS、不动工具描述、不动 systemPrompt。

---

## 2. 总体结构

```
dsh-short-video-studio/
├── package.json                 # 双面插件声明（dsh.client / bundle patch / exports）
├── cordis.patch.yml             # bundle patch：把插件行插入 web profile roster
├── lib/
│   ├── index.js                 # 宿主半：ComfyUI 引擎、渲染编排、画布存储、HTTP 路由、Agent 工具、GUIDANCE（约 1905 行）
│   ├── manifest.js              # 工作流绑定契约引擎：校验 / 资产解析 / 图编译 / 注册表加载（M1）
│   ├── concat.js                # 视频拼接（ffmpeg 优先 / ComfyUI 纯节点退化）
│   ├── convert.js               # ComfyUI「导出 API」JSON → workflow manifest 转换器
│   └── assets.js                # 跨会话资产库（角色卡 / 场景卡 / 风格锚点）
├── client.js → lib/client.js    # 浏览器半：conversation.view「画布」tab + settings.section「ComfyUI」设置
├── studio/                      # 画布页（自包含 HTML/CSS/JS，无构建）
├── workflows/                   # 内置工作流清单（数据）
│   ├── flux-text2image.json     # image.text2image：FLUX 2 文生图
│   ├── minimax-h3-ref2v.json    # video.reference2video：H3 参考绑定（带声音）
│   ├── minimax-h3-i2v.json      # video.image2video：H3 首/末帧串联（带声音）
│   └── extract-frame.json       # image.from_video：抽帧（末帧/首帧 → 图片）
├── schemas/
│   └── workflow-manifest.schema.json  # manifest 权威 JSON Schema（外部工具/文档参照）
├── skills/
│   └── 3d-animation-short-generator/  # 自带 skill（安装时复制到 ~/.dsh/skills/）
│       ├── SKILL.md             # 流水线散文（Step 0-8、门控纪律、实践要点）
│       └── references/          # 镜头表规范 / 分镜指南 / QC 清单 / 失败梯度 / 模型选择
├── scripts/                     # 冒烟 / e2e / 转换脚本（无 npm scripts 编排，手动执行）
├── docs/                        # 设计文档与实验报告
└── examples/fox/                # 示例片《一只想当宇航员的小狐狸》产物（含反面示例卡）
```

**双半装配**：`cordis.patch.yml` 声明插件行 → 宿主 Node 进程加载 `lib/index.js`（`exports "."`），`package.json` 的 `dsh.client` 声明让浏览器半 `lib/client.js`（`exports "./client"`）以 `/plugins/<id>/client.js` 载入 Web GUI。

---

## 3. 分层架构

```
┌────────────────────────────────────────────────────────────────┐
│ 展示层（浏览器半）  lib/client.js + studio/                      │
│  「画布」会话 tab（iframe）+ 「ComfyUI」设置页（配置/注册表/导入） │
├────────────────────────────────────────────────────────────────┤
│ 契约层（纯数据 + 校验）  workflows/*.json + lib/manifest.js      │
│  能力词汇表 · 注入原语 · $model 哨兵 · $assets 占位 · 强校验     │
├────────────────────────────────────────────────────────────────┤
│ 执行层（宿主半）  lib/index.js                                  │
│  ComfyUI 客户端 · 渲染编排 · 分辨率策略 · 注册表解析             │
├────────────────────────────────────────────────────────────────┤
│ 存储层                                                          │
│  画布 project.json · 媒体文件 · 资产库 · 配置文件               │
├────────────────────────────────────────────────────────────────┤
│ 集成层                                                          │
│  cordis.patch · Agent 工具注册 · systemPrompt GUIDANCE ·        │
│  HTTP 路由 · skill 自动安装                                     │
└────────────────────────────────────────────────────────────────┘
```

### 3.1 契约层：三层正交契约（核心设计）

来源：`docs/workflow-contract.md`。**「Agent 想做什么」（语义）与「某个工作流怎么做」（实现）彻底切开。**

| 层 | 内容 | 载体 |
|---|---|---|
| ① 任务契约 | Agent 只描述「要什么」：capability + 类型化输入（prompt / 宽高 / seed / refs…） | Agent 工具参数 |
| ② 能力契约 | 抽象作业词汇表：`image.text2image` / `video.reference2video` / `audio.tts` …（开放集合） | `CAPABILITIES`（lib/manifest.js） |
| ③ 工作流绑定契约 | 一份清单 = 一个 capability → 一个 ComfyUI 图 + 注入点 + 资产 + 质量档（数据非代码） | `workflows/*.json` |

**注入原语**（`params` 的 `inject` 类型）——「任意工作流」数据驱动的落地关键：

| inject | 语义 | 用例 |
|---|---|---|
| `scalar` | 任务值写到某节点字段（支持 `to[]` 多目标） | prompt / width / height / seed / steps / fps / prefix |
| `image` `via:field` | 上传图片 → 文件名字符串写字段（dotted，`${i}` 索引展开） | H3 `ref_images.ref_image_${i}` |
| `image` `via:node` | 上传 → 建 `LoadImage`（+ 可选 `preprocess` 链：ImageScale 等）→ 连线到字段 | `first_frame` / `last_frame` |
| `video` `via:field` | 上传视频 → 文件名字符串写字段 | `extract-frame` 的 `LoadVideo.file` |

**两个占位机制**：
- `$assets.<key>`：图内模型文件名占位，加载期按 **env > assetOverrides > default** 解析（换模型文件只改配置）。
- `["$model", 0]` 哨兵：图内所有「需要按质量档插 LoRA 链」的连线写哨兵，编译期按 `modes.<mode>.loras` 在模型后动态插入 `LoraLoaderModelOnly` 节点并重定向（fast 档 4 步 turbo / quality 档 20 步无 LoRA 因此降级为纯数据）。

**强校验**：`validateManifest`（lib/manifest.js，与 JSON Schema 同源的手写零依赖实现）校验 id 格式、capability 词汇、graph 连线引用完整性、`$assets` 引用落地、params 注入点合法性、modes 的 loras 资产引用等；**校验失败即拒绝加载**（`loadBuiltinManifests` 报错不静默降级，`POST /workflows` 返回明确错误）。

**graph 模板**：ComfyUI API 格式（`{nodeId: {class_type, inputs}}`），不变结构照抄、每镜可变值留 `null` 由 params 注入。

### 3.2 执行层（宿主半 lib/index.js）

#### ComfyUI 客户端（纯 fetch，零第三方依赖）
- `comfySubmit(graph)` → `POST /prompt`，返回 `prompt_id`；`comfyWait(promptId, signal)` 轮询 `/history/{id}` 直到 completed/error，带超时（默认 15min）与 AbortSignal；`comfyOutputs(entry)` 从 history 抽取 images/videos/gifs/audio；`comfyDownload(file)` 经 `/view` 拉二进制；`comfyUploadImage(buffer, filename)` 经 `/upload/image` 上传参考图。
- `apiKey` 非空时请求带 `Authorization: Bearer`（适配需鉴权的 ComfyUI 网关）。

#### 渲染编排（通用路径 `runRender`）
```
comfy_render / comfy_generate_* → runRender(ctx, opts)
  → resolveSessionRoot()        工作区定位（显式 workspaceId → agent cwd → workspaceRegistry 扫描）
  → getRegistry()               内置 workflows/ + 用户 ~/.dsh/dsh-short-video-studio/workflows/（同名遮蔽）
  → resolveManifest()           显式 workflow > preferred 顺序 > 该 capability 首个清单
  → resolveMode() / computeManifestSize()  质量档 + 分辨率（显式宽高 > aspect-ratio 按 mode.longSide 推导 > default，snap32）
  → resolveRefImage()           参考图/首末帧：资产 id（character:xxx）或画布节点 id → 读取 → comfyUploadImage
  → buildRenderGraph()          纯函数：manifest + job + aspectRatio → {mode, job, graph}
  → comfySubmit / comfyWait / comfyDownload
  → persistMedia()              产物落盘 <workspace>/canvas/<sessionId>/<filename>
  → 写/更新画布节点（kind / media / params 含 workflow、mode、seed、assets，可复现）
```

`comfy_generate_image` / `comfy_generate_video` 是**薄别名**：前者固定 `capability=image.text2image`，后者按是否传 `first/last_frame_node` 自动分派 `video.image2video`（首末帧串联）或 `video.reference2video`（参考绑定）——向后兼容，现有 skill 与流水线零改动即可继续跑。

> 注：`runImageGeneration` / `runVideoGeneration` 与三个 legacy builder（`buildFluxImageWorkflow` / `buildH3VideoWorkflow` / `buildH3ImageToVideoWorkflow`）已无生产调用点，仅经 `_internals` 供 `smoke-manifest.mjs` 做「manifest 编译 vs legacy 构造」节点类别等价性比对（见 §7 架构债）。

#### 视频拼接（`runConcat` + `lib/concat.js`）

拼接是 **delivery 层的确定性操作，不是模型能力**，因此刻意不进 manifest 注册表：拼接图的节点数与连线拓扑随片段数变化（变长左折叠），超出 manifest「静态 graph 模板 + 定点注入」的表达能力，为一个确定性后处理扩展契约层不划算。

两条后端，`runConcat` 按环境自动选择，对 skill 透明：

| 后端 | 条件 | 链路 | 代价 |
|---|---|---|---|
| ffmpeg | 本机 `ffmpeg -version` 成功 | concat demuxer + `-c copy`；copy 失败自动降级 libx264/aac 重编码 | 零重编码、零显存、秒级 |
| ComfyUI | 无 ffmpeg（本机实测即此路径） | 逐段 `POST /upload/image` 进 input（该端点同时接受 mp4）→ `LoadVideo → GetVideoComponents` → `ImageBatch` / `AudioConcat` 左折叠 → `CreateVideo(images, fps, audio)` → `SaveVideo(mp4/h264)` | 整段素材作为 IMAGE 张量进内存（N×帧×W×H×3×4 字节） |

`runConcat` 解析素材时强校验 `kind === 'video'` + `media` 存在 + 文件在盘（顺带堵住了「视频被当图上传」那条老路径）。已实测：3 段片段 7.6s 出片，总时长 14.085s → 产物 14.084s，`vide` + `soun` 双轨完整。限制：**只有硬切无溶解**、片段需同分辨率、不产 BGM（注册表无 `audio.music` 工作流）。

#### 跨场景转场（生成式转场镜）

不做后期溶解，而是用 `extract-frame` 抽前一镜末帧 + 后一镜首帧，喂给既有的 `minimax-h3-i2v`（首末帧串联）生成一个短过渡镜，当普通片段参与拼接。已端到端实跑：抽帧 1.5s ×2 → 转场镜 16.9s（fast/`length=39`）→ 拼接 4.5s；成片 11.250s = 5.167 + 1.625 + 4.459，双轨完整，中间帧是真实运镜、末帧精确落回后一镜首帧。

两条实测坑（已写进 SKILL.md 自检门与 Step 7）：
1. **烧录字幕会被继承**——`dialogue` 镜的末帧带字幕，直接当转场首帧则字幕进转场镜。对策是在镜头表层面要求跨场景边界的前一镜最后 0.5s 无对白（自检门第 8 项）。
2. **`length` 走 17k+5 网格且训练区间 124–362**，短于 124 属未测区，`length=39`+fast 中段会糊、建筑形变。转场镜建议 ≥56，成片用 `quality`。

#### 分辨率策略
- fast 档长边 832 / quality 档长边 1344，按画布 `settings.aspectRatio`（16:9 / 9:16 / 1:1 等任意比例）推导宽高，snap 到 32 倍数；显式传 `width`/`height` 优先。

### 3.3 存储层

| 存储 | 位置 | 机制 |
|---|---|---|
| 画布项目 | `<workspace>/canvas/<sessionId>/project.json` | `schemaVersion:1` + `settings`（aspectRatio / duration / audioMode / mode / groupOrder）+ `nodes[]`；**原子写**（tmp + rename）+ **per-session 写锁**（串行化并发） |
| 媒体产物 | `<workspace>/canvas/<sessionId>/<filename>` | 节点只存相对路径，经 `/media` 路由带 token 伺服 |
| 资产库 | `<root>/.dsh-assets/library.json` + `images/` | 跨会话角色/场景/风格锚点，id 规范 `<type>:<name>[/<state>]`，`char:` 是 `character:` 别名 |
| 插件配置 | `~/.dsh/dsh-short-video-studio.json`（或 `DSH_SVS_CONFIG`） | baseUrl / apiKey / pollMs / timeoutMs / models / assetOverrides / preferred；**优先级 env > 配置 > 默认**，每次调用重读（设置即时生效） |

### 3.4 展示层（浏览器半）

`lib/client.js` 经 `window.__ModuleLoader__.load` 注册（React，无 JSX 语法），两个注入点：

1. **`conversation.view` 槽**（id `short-video-canvas`，order 20，label「画布」）：渲染 iframe 指向宿主伺服的 `/dsh-short-video-studio/?sessionId=&workspaceId=`。iframe 内「重做」按钮通过 `postMessage`（channel `dsh-short-video-studio`，type `ask-ai`）把指令回填父页输入框（`inputActions.setDraft`）。
2. **`settings.section` 槽**（id `comfyui`，order 120）：ComfyUI 设置卡——连接参数、工作流注册表（按 capability 分组、设默认写回 `preferred`）、资产覆盖（选中工作流后按 manifest 动态渲染 assets 字段）、工作流导入（粘贴 manifest 或 ComfyUI「导出 API」原始 JSON，自动转换）、用户清单删除。

`studio/` 为**自包含无构建**画布页（index.html + app.js + app.css）：读取 `/api/canvas` 全量渲染节点卡（文本/表格 markdown 解析、图片/视频媒体、参数摘要、状态），支持节点内编辑、重做（回填给 AI）、**入库**（表单选资产类型 + 资产名，AI 不自动入库）、分组改名（自由输入 + datalist 候选）、上移/下移/删除；**分组词汇由流程 skill 自由定义**，展示顺序取 `settings.groupOrder`（skill 经 `canvas_set_state` 声明），未声明的分组按首次出现顺序排在其后，缺省分组为 `ungrouped`。iframe 内禁用原生 alert/confirm/prompt，自绘 DOM 模态框。

### 3.5 集成层

- **Agent 工具**（原生 ToolDefinition，parameters 直接写 JSON Schema，零 `@deepseek-ai/*` 运行时 import，全部走注入 `ctx`）：15 个工具 = 6 生成/抽帧/拼接/查询（`comfy_generate_image` / `comfy_generate_video` / `comfy_render` / `extract_frame` / `video_concat` / `comfy_list_workflows`）+ 7 画布（`canvas_list_nodes` / `canvas_write_node` / `canvas_get_node` / `canvas_group_nodes` / `canvas_reorder` / `canvas_get_state` / `canvas_set_state`）+ 2 资产（`asset_list` / `asset_to_canvas`）。
- **systemPrompt GUIDANCE 段**（order 150）：基本约定 + 工具契约 + 参考图硬规则（单视图/零文字等实测结论）+ 指向流程 skill 的指针。**不含任何流程、任何片型词汇、任何具体 skill 名**——流程的唯一真相在 skill。
- **HTTP 路由**（`/dsh-short-video-studio`）：
  - `/api/config`、`/api/workflows`：**显式 tokenless**（设置页调用；威胁模型见 §7）；
  - `/api/canvas`、`/api/canvas/node`、`/api/canvas/group`、`/api/canvas/reorder`、`DELETE /api/canvas/node`、`/api/assets`（含「入库」）、`/api/generate/image|video`：需 `x-dsh-svs-token` 头；
  - `/media`：token 走 query（便于 `<img>/<video>` 直接加载），**路径安全五步校验**（`safeRelative` → `resolve` → `inside` → `realpath` → 再 `inside`，连符号链接逃逸都堵）；
  - 静态 `studio/`：index.html 注入 token 后伺服，开发期 no-cache。
- **skill 自动安装**：`apply()` 时把 `<包>/skills/<name>` 复制到 `~/.dsh/skills/<name>`，幂等（目标已存在则跳过，不覆盖用户修改）。
- **配置**：插件 `inject = ['webServer', 'tools', 'systemPrompt', 'workspaceRegistry']`（fiber 等待服务就绪）。

---

## 4. 关键数据流

### 4.1 一次图片/视频生成（Agent 工具路径）
```
Agent 调用 comfy_generate_video(prompt, ref_nodes=[角色卡,场景卡], ...)
  → runRender(capability=video.reference2video)
  → 注册表按 preferred 选中 minimax-h3-ref2v
  → 上传参考图（画布节点 media 或资产库图片 → /upload/image）
  → buildGraphFromManifest：$assets 替换 → params 注入 → $model 按 mode 插 LoRA
  → POST /prompt 提交 → 轮询 /history → 下载 mp4 → 落盘 canvas/<sid>/<nodeId>.mp4
  → 写画布节点（params 记录 workflow/mode/seed/width/height/ref_nodes，可复现）
  → 返回 {ok, nodeId, media} → studio iframe 刷新可见，Agent 弹片段批准卡
```

### 4.2 参考图 / 末帧串联
- **参考绑定（reference2video）**：`ref_nodes` 里的角色卡/场景卡（画布节点 id 或资产 id `character:fox`）→ 上传 → `ref_images.ref_image_N`（dotted）绑定身份/环境。
- **首/末帧串联（image2video）**：`first_frame_node=上一镜末帧` → `LoadImage → ImageScale(宽高=${width}/${height}) → MiniMaxH3ImageToVideo.first_frame`（preprocess 链），身份/环境由首帧真实画面继承；仅用于同场景续接镜。

### 4.3 跨会话资产复用
```
画布节点「入库」按钮（人工）→ POST /api/assets → registerAsset（拷图到 .dsh-assets/images/ + 索引）
→ 新会话 asset_list() → 命中 asset_to_canvas(id) → 物化为画布 image 节点（params.assetId 溯源）
→ comfy_generate_video(ref_nodes=[资产 id]) 直接复用同一张图，保证一致性且不重复生成
```

---

## 5. 内置工作流清单（当前）

| 清单 | 能力 | 图骨架（关键节点） | 质量档 | 分辨率策略 |
|---|---|---|---|---|
| `flux-text2image` | image.text2image | UNETLoader → ModelSamplingFlux → CLIPTextEncode(flux2) → FluxGuidance → EmptyFlux2LatentImage → Flux2Scheduler → SamplerCustomAdvanced → VAEDecode → SaveImage | （无 modes，默认 20 步） | explicit，默认 1344×768 |
| `minimax-h3-ref2v` | video.reference2video | UNETLoader → SigmaShift → **MiniMaxH3ReferenceToVideo**（ref_images dotted）→ SamplerCustomAdvanced → VAEDecode + **VAEDecodeAudio** → **CreateVideo(audio)** → SaveVideo(mp4/h264) | quality 20 步 / fast 4 步 + LoRA | aspect-ratio，longSide 1344/832 |
| `minimax-h3-i2v` | video.image2video | 同上，但 **MiniMaxH3ImageToVideo** + first/last_frame 经 LoadImage→ImageScale preprocess 链 | quality 20 步 / fast 4 步 + LoRA | aspect-ratio，longSide 1344/832 |
| `extract-frame` | image.from_video | LoadVideo → GetVideoComponents → **ImageFromBatch**(batch_index，负数从末尾数) → SaveImage | （无 modes，无采样） | 由源视频决定，不推导 |

**H3 音视频链**是核心卖点：`MiniMaxH3ReferenceToVideo + audio_vae + VAEDecodeAudio → CreateVideo(audio)`，端到端产出**带声音**的单镜头视频（非静音）。

**注册表来源优先级**：内置 `workflows/*.json` < 用户 `~/.dsh/dsh-short-video-studio/workflows/*.json`（同名遮蔽）< `assetOverrides` / env 换模型文件名（不动图结构）。

---

## 6. 目录职责速查

| 路径 | 职责 |
|---|---|
| `lib/index.js` | 宿主入口：配置、ComfyUI 客户端、渲染编排（runRender + legacy）、画布存储、HTTP 路由、13 个工具、GUIDANCE、skill 安装、`_internals` 测试出口 |
| `lib/manifest.js` | 契约引擎：`CAPABILITIES` 词汇、`validateManifest`、`resolveAssets`、`buildGraphFromManifest`（注入引擎）、`loadBuiltinManifests` |
| `lib/convert.js` | ComfyUI 导出 → manifest 机械转换（资产抽取、标量注入点、todos 交人工的语义绑定清单） |
| `lib/assets.js` | 资产库：load/save/register、id 规范化（`normalizeAssetId`）、`isAssetRef` / `canonicalAssetId`、`resolveAssetImagePath`、`slugifyName` |
| `lib/concat.js` | 视频拼接：`buildConcatGraph`（纯函数，变长左折叠图）、`detectFfmpeg`、`ffmpegConcat`（copy 失败降级重编码） |
| `lib/client.js` | 浏览器半：`conversation.view` 画布 tab（iframe）+ `settings.section` ComfyUI 设置卡 |
| `studio/` | 自包含画布页：节点卡渲染、编辑/重做/入库/分组/排序/删除、markdown 表格解析、自绘模态、ask-ai postMessage |
| `workflows/` | 4 份内置 manifest（数据） |
| `schemas/workflow-manifest.schema.json` | manifest 权威 JSON Schema |
| `skills/3d-animation-short-generator/` | 其中一种片型的生产流程 skill（自包含单文件 SKILL.md + meta.yaml）；插件对它零认知 |
| `scripts/` | `mock-apply`（装配冒烟）、`smoke-manifest`（M1 图编译等价）、`smoke-render`（M2 纯逻辑）、`smoke-concat`（拼接图拓扑）、`probe-concat` / `probe-extract-frame`（实跑，需 ComfyUI）、`smoke-flux2` / `smoke-submit` / `e2e` / `e2e-comfy`（需 ComfyUI）、`import-comfy`（CLI 转换） |
| `cordis.patch.yml` | bundle patch：插件行插入 web profile roster |
| `docs/` | 设计文档（workflow-contract）、审查（architecture-review）、方案（consistency-optimization-plan）、实验（three-view-experiment） |

---

## 7. 已知架构债（来自 `docs/architecture-review.md`，非本文作者新增判断）

| 优先级 | 事项 | 说明 |
|---|---|---|
| **P0** ✅ | GUIDANCE 三视图/单视图矛盾 | 已按三视图实验结论修复（单视图 + 参考图零文字 + 多角度无增量价值） |
| **P0** ✅ | GUIDANCE 与 `SKILL.md` 双份真相 | 已修复：GUIDANCE 收敛为「基本约定 + 工具契约 + 参考图硬规则 + skill 指针」，不再写任何流程；流程唯一真相在 `SKILL.md`（单文件，`references/` 已删除）。GUIDANCE 与 `GROUP_ORDER` 均不再出现片型词汇或具体 skill 名 |
| **P1** | ~160 行 legacy 死代码 | `runImageGeneration` / `runVideoGeneration` / 三个 builder 已无生产调用点，仅作 smoke 对照；建议改 golden-file 快照断言或移入 test fixtures |
| **P1** | `lib/index.js` 单文件 8 职责 | 配置 / ComfyUI 客户端 / 图构造 / 存储 / 渲染 / 路由 / 工具 / GUIDANCE；建议拆 comfy.js / canvas.js / render.js / routes.js / tools.js / guidance.js |
| **P1** | 无 `npm test` / CI | `scripts/` 8 个文件全靠手跑；`smoke-manifest` / `smoke-render` / `mock-apply` 是纯逻辑可 CI |
| **P2** | tokenless 路由 `/config` / `/workflows` | `POST /workflows` 会写图文件并 `reloadRegistry`，`POST /config` 可改 baseUrl；建议加 token 或明示威胁模型 |
| **P2** | `schemaVersion` 无迁移 | 只有写入无检查无 `migrate()`，为将来 shotlist 节点预留 |
| **P2** | 设置页资产字段仍硬编码 | 应改为按 registry 动态渲染（即 M4）。入库表单化已完成（资产类型下拉 + 资产名，不再从分组名反推类型） |

另外 `docs/consistency-optimization-plan.md` 指出的功能缺口中，「无拼接能力」已由 `runConcat` 解决，「末帧串联链路断裂（无抽帧能力）」已由 `extract-frame` 清单 + `extract_frame` 工具解决；仍未解决：`slugifyName` 对中文标题失效导致入库堵死、无身份锁（仅参考图 + 散文约束）、七列镜头表不可机读（无 shotlist schema）。

---

## 8. 演进路线（文档既定方向）

1. **工作流契约（M1–M5）**：已完成 M1/M2（manifest 引擎 + 通用 runRender + `comfy_render` / `comfy_list_workflows`）；M3 把 GUIDANCE/skill 改为能力词汇表述；M4 设置页按 registry 动态渲染；M5 验收 = 加第 4 个模型零 JS 改动。
2. **一致性与镜头规划（W1–W5）**：角色档案（character bible）+ `asset_register` + `preset: character-card` → 参考绑定策略引擎 `planRefs` → 结构化镜头清单 `shotlist` + `shotlist_validate()` → 抽帧打通末帧串联 → seed 纪律与 QC。
3. **架构清理**：先做 P0（单一真相）+ P1 前两项（npm test/CI、源码入库），再拆分 index.js，最后 P2。

---

## 9. skill 层与执行层的配合与解耦

> 深化 `architecture-review.md` §1.2（双份真相）与 `workflow-contract.md` §5（工具契约泛化）的交点：skill 层与执行层如何配合、耦合在哪、如何解耦。

### 9.1 现状：三层各司其职，但边界模糊

| 层 | 载体 | 职责 | 对模型的可见方式 |
|---|---|---|---|
| 执行层 | `lib/index.js` 工具 + `lib/manifest.js` + `workflows/*.json` | 能力（capability→manifest→执行）、画布存储、资产库 | 工具 JSON Schema（**硬接口**，每轮必见） |
| GUIDANCE | `lib/index.js` systemPrompt 段（order 150） | 插件存在声明 + 工具契约摘要 + 流水线摘要 | systemPrompt（每轮注入） |
| skill 层 | `SKILL.md` + `references/*.md` | 编排规则：Step 0-8 顺序、门控、镜头表/分镜/QC 规范、失败梯度、模型选择策略 | skill 系统（触发时加载） |

配合链路：模型读 skill → 得到编排规则 → 调执行层工具（经工具系统看到 JSON Schema）→ `runRender` → manifest 引擎 → ComfyUI → 落画布 → 结果回传 → 模型按散文推进；画布页同步渲染同一份 `project.json`。

配合接口两层：**硬接口** = 工具名 + 参数 schema（`makeTools()` 注册）；**软接口** = skill 工具映射表（`SKILL.md` 用散文把「用途」映射到「工具名」）。

### 9.2 耦合：真相来源 3 处重复（非 2 处）

| 内容 | 重复位置 |
|---|---|
| 工具契约（名/参数/语义） | ① `makeTools` description（硬）② `GUIDANCE` 工具契约段 ③ `SKILL.md` 工具映射表 |
| 流水线 Step 0-8 | ① `GUIDANCE` ② `SKILL.md` 正文 ③ `references/`（更细规范） |
| 实践要点（单视图/零文字） | ① `GUIDANCE` ② `SKILL.md` ③ README |
| 模型名 | ① `GUIDANCE`（「图片默认 flux-text2image」）② `SKILL.md` 正文括号备注 |

两个漂移放大器：
1. **skill 是独立副本且不随插件升级更新**——`installBundledSkills()`（`lib/index.js`）是「目标已存在则跳过」，装进 `~/.dsh/skills/` 后升级插件改 `SKILL.md` 不会同步，散文与工具必然漂移。
2. **references 里仍写死 workflow id 作「当前默认」**（`model-selection.md`：「当前 `video.reference2video` → `minimax-h3-ref2v`」）——用户改 `preferred` 后该备注即过时（行为上已用「Do not preselect a named alternative」兜底，但文字 stale 仍在）。

### 9.3 解耦：把「复述」改成「引用」

核心原则与 `workflow-contract.md` 三层正交同源：skill 层落在「任务契约」之上，应做**编排**而非**复述能力**。

目标分工：

| 层 | 只负责 | 不负责 |
|---|---|---|
| skill 层 | 编排（顺序、门控、业务规范、QC 标准） | 复述工具签名、写死模型名 |
| GUIDANCE | 「有这个插件」+ 指向 skill + 极少量门控 | 复述流水线、工具契约 |
| 执行层 description | 唯一的能力真相 | 业务顺序、何时调 |

五条具体动作：

1. **工具契约收敛到执行层 description（唯一真相）**：模型必见 description/parameters，skill 的完整工具映射表与 GUIDANCE 工具契约段删掉，改为语义性描述，让模型自行匹配工具。
2. **流水线只在 SKILL.md 维护**：完整 Step 0-8 + references 只留 skill（可热更新、可被技能中心发现、可被用户覆盖）；GUIDANCE 删 Step 0-8 复制，只留「指向 skill + 门控纪律」。理由：GUIDANCE 编译进插件改一次要重装，skill 是独立文件可热扫——流程细节不放低频变更侧。
3. **模型名 → 能力词汇（M3）**：references 已基本完成（`model-selection.md` 用「capability registry default」而非写死 H3，group 标签不 hard-code 模型名）；剩余耦合是 GUIDANCE 与 SKILL.md 正文的括号备注，应全部改 capability 词汇，默认由 registry `preferred` 决定。
4. **「散文纪律」→「代码保证」单向搬运（解耦的实质）**：skill 里「务必遵守」的规则分两类——纯业务规则（镜头表填法、门控节点、QC 人工判读）留在 skill；可代码校验的规则（单镜≤15s、≤3 角色、`speaker ∈ characters`、说话人卡排 ref 首位、跨场景禁末帧串联、`maxDurationFrames`）下沉为 schema/断言（`shotlist_validate` / `planRefs` / 类型断言，即 W2/W3）。skill 由此退化为「引用可校验工具的编排」，执行层补上缺失的机器可读纪律。
5. **机制上消灭漂移**：GUIDANCE 由 SKILL.md 构建时生成（而非手抄），或至少只写「本机装有本插件，完整流程见 skill」。

### 9.4 落地顺序

1. GUIDANCE 瘦身为「工具契约 + 指向 skill」——P0（`architecture-review.md` §8）
2. skill 层改用能力词汇、删写死的 workflow id 备注——M3（`workflow-contract.md` §7）
3. 可校验规则下沉 `shotlist_validate` / `planRefs` / 类型断言——W2/W3（`consistency-optimization-plan.md` §4）
4. skill 工具映射表合一（不再列签名）——收尾

---

## 10. 一句话总结

`dsh-short-video-studio` 是一个**「契约驱动」的本地生成画布工作室**：Agent 只表达「要什么」（capability + 类型化输入），宿主按注册表把能力解析成具体 ComfyUI 工作流并执行，产物落进会话画布（Agent 工具与画布页共享同一份 `project.json`），角色/场景卡经资产库跨会话复用。其最大架构价值在 manifest 契约层——**加模型即加 JSON**；最大结构风险在散文层双份真相与单文件宿主——均已由 `docs/architecture-review.md` 定位并给出拆分路线。
