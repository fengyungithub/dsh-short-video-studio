# dsh-short-video-studio

**完全本地 · 免费 · 零云端依赖**的**短剧 / 动画画布工作室**，作为 [DeepSeek Harness](https://github.com/deepseek-ai) 双面插件运行。所有生成都跑在**本地 ComfyUI** 上——不需要任何付费云 API、不消耗额度，装好即用，一次生成、无限出片。

> 一句话：**Agent 按你定义的 skill 编排流程，把生成请求派发到本地 ComfyUI 执行，产物落进可视化画布，还能通过飞书远程操控创作。**

> **🌟 模型无关**：FLUX 2 / MiniMax H3 只是插件随附的**内置默认工作流**，不是产品边界。本插件是通用的 ComfyUI 工作流执行器 + 能力注册表——**任何 ComfyUI 能跑的模型**（SDXL / SD3.5 / Qwen-Image / Wan / CogVideoX / LTX / 本地 Kling 等，图片或视频、带不带声音都可以）都能通过[导入一份工作流清单](#导入你自己的-comfyui-workflow)接入，skill 与工具契约无需任何改动。换模型 = 加一份 JSON。

## 功能亮点

### 🖥️ 本地化、0 成本的视频工作流

- **零云端依赖**：默认图片用 FLUX 2、视频用 MiniMax H3 **音视频 AV 模型**（**带声音**、支持**参考图绑定**与**画面内原生字幕**，对白直接写进 prompt，无需后期叠加）——两者都只是内置默认，可整体替换为你自己的任何 ComfyUI 模型/工作流。
- **画质/速度两档**：视频 `fast`（4 步 + LoRA，调试快 5×+）与 `quality`（20 步，成片）；图生图 `fast`（8 步 + Turbo LoRA）与 `quality`（20 步成片）。分辨率按画布比例自动推导，支持 16:9 / 9:16 / 1:1 等任意画幅，snap32。
- **图片双模（文生图 / 图生图）**：t2i 用 FLUX 2 直接出卡（角色卡 / 场景卡 / 分镜图），i2i 用 FLUX 2 ReferenceLatent **改绘**——保持主体不变、换背景 / 场景 / 画风 / 去水印；单张参考图、尺寸跟随参考图（≤1MP），`quality`（20 步无 LoRA，保真）/ `fast`（8 步 Turbo LoRA，调试快），可一次出 1–4 张。
- **完整后处理**：同场景末帧串联（连续性过渡）、生成式转场镜、抽帧、拼接合成（本机有 ffmpeg 走零重编码，否则 ComfyUI 纯节点链路）——一条龙出片。

### 🎨 可视化画布

- 每个会话多一个「**画布**」tab，按生产顺序预览 / 编辑 / 重做每一步产物：简报、大纲、角色卡、场景卡、镜头表、分镜、逐镜片段、成片。
- 文本节点**实时渲染 markdown**（标题/表格/列表/代码块），媒体节点直接内嵌预览；分组、排序、删除、**入库**（一键登记为跨会话资产）都在画布上完成。
- **自己添加资产**：画布顶栏「＋ 上传图片」可直接把本地 png/jpg/webp/gif 传成角色卡/场景卡等资产节点（无需先生成）；「📚 资产库」带缩略图把已入库的跨会话资产取到当前画布，之后即可作为 ref 参考直接驱动视频生成。
- **生成的卡也能编辑替换**：已生成/已入库的角色卡、场景卡上点「编辑」→ 选本地图即可替换该卡图片（节点/标题/分组保留；若已入库会解除绑定，替换后按需重新「入库」登记新版本）。
- **输入框视频生成（`video-generate` skill 的可视化入口）**：会话输入框工具行左端保留「🎨 图片 / 🎬 视频」开关。点「🎬 视频」即把 **`/video-generate` 斜杠命令（内联 `type/tier/ratio/size/length/refs/first/last` 参数）写入官方输入框**，用 dsh 原生 skill 加载机制加载内置 `video-generate` skill；同时在输入卡上方弹出**紧凑工具条**——类型 **r2v（参考图生成）/ i2v（首/末帧生成）**、**quality / fast 档**、比例、时长（原生下拉菜单）与「参考图 / 首帧 / 末帧」自定义上传元素（经 `/canvas/upload` 落为画布节点；dsh 原生附件无法端到端转成 `ref_nodes`，故保留自定义图片输入）。**prompt 接着写在官方输入框空行后**，改参数时工具条自动重写命令行、保留 prompt；**发送直接点 dsh 默认发送键**（提交整条草稿，不额外做发送按钮、不劫持 Enter），Agent 按对应 skill 解析命令行参数并调用生成工具出片，产物回进对话并落画布。图片生成（🎨 `image-generate`）同机制：工具条切换 **文生图（t2i）/ 图生图（i2i）**——t2i 选比例与张数（默认 1344×768，可 1–4 张）；i2i 上传**单张参考图**（图 chip + ➕ 新增格，与 dsh 原生上传同款 64px 样式）、选 **quality / fast 档**与张数，命令头自动写 `/image-generate type=… tier=… refs=<画布节点id>`。**档位按模式独立记忆**：视频默认 `fast`（调试快）、图生图默认 `quality`（保真优先），手动选过后各自记住；上传的参考图即画布节点（删除/切型/清空草稿都会同步清理，画布不残留）。
- Agent 工具与画布页读写**同一份持久状态**，对话推进的每一步产物都实时可见。

### 🧩 自由扩展：skill 与 workflow

- **skill 可扩展**：生产流程完全由 skill 定义（安装时自动复制到 `~/.dsh/skills/`，可热扫描、可被用户覆盖）。写一个 `SKILL.md` 就能定义你自己的片型流程——**插件本体不认识任何流程、任何片型词汇**。
- **workflow 可扩展**：插件退化为「通用 ComfyUI 工作流执行器 + 能力注册表」。**换模型、换工作流 = 增删一份 JSON**，不动 JS、不动工具、不动系统提示。FLUX 2 / MiniMax H3 只是内置默认，你的任何 ComfyUI 工作流（SDXL / Qwen-Image / Wan / CogVideoX / LTX…）都可以**直接导入**并设为默认（见[导入你的 workflow](#导入你自己的-comfyui-workflow)）。

### 🎬 多场景创作：一套引擎，任意场景

- 默认内置 **3D 动画短片**场景（故事创意 → 角色/场景/镜头/分镜/逐镜/合成），但**场景不是插件边界**。
- **电商宣传视频**（商品/卖点 → 展示分镜 + 口播）、**教育课件讲解**（知识点 → 图解 + 讲解）、品牌故事、纪念短片、Vlog 解说……任何「输入 X → 产出视频」的创作场景，都通过**扩展一个 skill** 覆盖——复用同一套画布、生成工具、资产库与飞书交付，只换编排规则（见[开发你自己的场景 skill](#扩展开发你自己的场景-skill)）。
- **场景与模型双解耦**：场景由 skill 定义、模型由注册表定义，两者互不绑定——电商场景也可以随时切换到你想用的任何 ComfyUI 模型。

### 📱 飞书集成：远程操控工作台创作

- 会话可以跑在**飞书聊天**里（配合 [dsh-lark](https://github.com/deepseek-ai) 飞书渠道）——你在飞书里说一句话，Agent 就在本地工作台上按 skill 走完整条流水线。
- 每次提问前，插件**自动把画布产物送达飞书**：图片/视频直接发原文件，简报/大纲/镜头表/分镜等文本自动导出为 **PDF**（飞书可直接预览）——无需登录任何后台，聊天里就能收片、审片、下指令重做。

**安装说明**：dsh-lark 飞书渠道是 **web profile 的插件**，安装时必须带 `--profile web`；若希望**飞书与 dsh web 共用同一个 profile**（同一份插件、会话与工作区，Web 画布与飞书聊天看到同一块画布）：

```bash
dsh plugin --profile web add dsh-lark-channel@latest
```

装好后在飞书里把 bot 拉进群即可开始远程创作；群聊会先弹审批卡、再出选项卡。

## 快速开始

前置条件：本机或者远程主机已运行 [ComfyUI](http://localhost:8188)，并已下载你计划使用的模型——内置默认（FLUX 2 / MiniMax H3）或你自己导入的模型（见[配置](#配置)与[导入 workflow](#导入你自己的-comfyui-workflow)）。

```bash
# 安装插件（三种来源任选其一；npm 为正式发布渠道，推荐）

# ① npm（正式发布，随版本自动更新安装源）
dsh plugin --profile web add dsh-short-video-studio
# ② GitHub（最新源码）
# dsh plugin --profile web add github:fengyungithub/dsh-short-video-studio
# ③ 本地源码（开发用）
# dsh plugin --profile web add file:/path/to/dsh-short-video-studio

dsh web   # 重启后会话出现「画布」tab；自带 skill 已自动装到 ~/.dsh/skills/
```

安装后自动完成三件事：`skills/` 下 skill 复制到 `~/.dsh/skills/`（幂等，不覆盖你的修改）；Web 设置页新增 **ComfyUI** 配置菜单；会话多出「画布」视图 tab。

开始创作：在会话里说

> 把「一只想当宇航员的小狐狸」做成 30 秒 3D 动画短片

Agent 会按 skill 定义的流程推进：项目简报 → 故事大纲 → 角色卡 → 场景卡 → 镜头表 → 分镜 → 逐镜生成 → 拼接合成，关键节点用选项卡确认。产品界面（真实会话截图）：

| 对话体验：流程叙述 + 任务看板 | 对话体验：可视化画布 |
|---|---|
| ![会话截图1](./examples/harness-dialogue-1.png) | ![画布真实截图](./examples/harness-dialogue-2.png) |

### 输入框生成条（真实 UI 截图）

会话输入框工具行左端「🎨 图片 / 🎬 视频」开关，点开后即在官方输入卡内弹出紧凑参数条，命令头自动写入草稿首行、prompt 写在空行后，直接走 dsh 原生发送键提交（截图均为真实会话）：

| 🎬 视频生成（r2v · 默认 fast 档） | 🎨 图片 · 文生图（t2i） | 🎨 图片 · 图生图（i2i · 参考图 chip） |
|---|---|---|
| ![ui-video](./examples/ui/ui-video.png) | ![ui-image-t2i](./examples/ui/ui-image-t2i.png) | ![ui-image-i2i](./examples/ui/ui-image-i2i.png) |

视频条：类型 **r2v（参考图）/ i2v（首/末帧）** · 档位（默认 **fast**，832 长边调试；quality 1344 成片）· 比例 · 时长，参考图/首帧/末帧可上传画布节点。图片条：类型 **文生图 / 图生图**——t2i 选比例（1344 长边）+ 张数；i2i 传**单张参考图**（尺寸跟随参考图）、档位默认 **quality**、可出 1–4 张。

## 架构概览

完整设计文档见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与 [`docs/workflow-contract.md`](docs/workflow-contract.md)。核心分层：

```
┌──────────────────────────────────────────────────────────────┐
│ 展示层（浏览器半）  lib/client.js + studio/                     │
│  「画布」会话 tab + 「ComfyUI」设置页（配置 / 注册表 / 导入）      │
├──────────────────────────────────────────────────────────────┤
│ 契约层（纯数据 + 校验）  workflows/*.json + lib/manifest.js      │
│  能力词汇表 · 注入原语 · $assets 占位 · $model 哨兵 · 强校验     │
├──────────────────────────────────────────────────────────────┤
│ 执行层（宿主半）  lib/index.js                                 │
│  ComfyUI 客户端 · 渲染编排 · 分辨率策略 · 注册表解析 · 画布存储  │
├──────────────────────────────────────────────────────────────┤
│ 集成层                                                        │
│  Agent 工具注册 · GUIDANCE · HTTP 路由 · skill 安装 · 渠道送达  │
└──────────────────────────────────────────────────────────────┘
```

**设计主张：插件不认识「FLUX」「H3」这些名字，只认识能力（capability）与工作流清单（manifest，数据而非代码）**——FLUX 2 / MiniMax H3 只是注册表里「恰好是默认」的两条记录，任何模型接入后享有同等地位。三层正交契约：

| 层 | 内容 | 载体 |
|---|---|---|
| ① 任务契约 | Agent 只描述「要什么」：capability + 类型化输入 | Agent 工具参数 |
| ② 能力契约 | 抽象作业词汇表：`image.text2image` / `video.reference2video` / `audio.tts`…（开放集合） | `CAPABILITIES` |
| ③ 工作流绑定契约 | 一份清单 = 一个 capability → 一个 ComfyUI 图 + 注入点 + 资产 + 质量档（**JSON 数据**） | `workflows/*.json` |

清单里的 `$assets.<key>` 占位让「换模型文件只改配置」；`["$model", 0]` 哨兵让「按质量档插 LoRA 链」由编译期自动完成。**注册表来源优先级**：内置 `workflows/` < 用户 `~/.dsh/dsh-short-video-studio/workflows/`（同名遮蔽）< `assetOverrides` / 环境变量（换模型文件名，不动图结构）。

## 目录结构

```
├── lib/
│   ├── index.js          # 宿主半：ComfyUI 客户端、渲染编排、画布存储、路由、Agent 工具、GUIDANCE
│   ├── manifest.js       # 契约引擎：能力词汇、manifest 校验、图编译、注册表加载
│   ├── concat.js         # 视频拼接（ffmpeg 优先 / ComfyUI 纯节点退化）
│   ├── convert.js        # ComfyUI「导出 API」JSON → workflow manifest 转换器
│   ├── assets.js         # 跨会话资产库（角色卡 / 场景卡 / 风格锚点）
│   ├── pdf.js            # 文本节点 → PDF（puppeteer-core 优先，CLI 兜底）
│   └── client.js         # 浏览器半：画布 tab + ComfyUI 设置页
├── studio/               # 画布页（自包含 HTML/CSS/JS，无构建）
├── workflows/            # 内置工作流清单（数据，非代码）
├── schemas/              # workflow-manifest 权威 JSON Schema
├── skills/               # 自带 skill（安装时复制到 ~/.dsh/skills/）
├── docs/                 # 架构 / 契约 / 实验报告
└── scripts/              # 冒烟 / e2e / 导入转换脚本
```

## 内置工作流清单（默认，可替换）

> 下表是插件随附的**内置默认**。导入你自己的清单后即可通过 `preferred` 把它设为某能力的默认工作流——内置清单可以不用、可以遮蔽、可以删除。

| 清单 | 能力 | 说明 |
|---|---|---|
| `flux-text2image` | `image.text2image` | FLUX 2 文生图（角色卡 / 场景卡 / 分镜图） |
| `flux2-img2img` | `image.image2image` | FLUX 2 参考图改绘（ReferenceLatent，尺寸跟随参考图，quality 20 步 / fast 8 步 Turbo LoRA） |
| `minimax-h3-ref2v` | `video.reference2video` | H3 参考绑定，`ref_nodes` 绑定身份/环境，**带声音** |
| `minimax-h3-i2v` | `video.image2video` | H3 首/末帧串联（同场景续接镜 / 转场镜），带声音 |
| `extract-frame` | `image.from_video` | 抽帧（末帧 / 首帧 → 图片节点） |

## Agent 工具契约

| 组 | 工具 |
|---|---|
| 生成 | `comfy_generate_image` · `comfy_generate_video` · `comfy_render`（通用入口，模型无关）· `comfy_list_workflows`（查能力/工作流） |
| 后处理 | `extract_frame`（抽帧）· `video_concat`（拼接成片） |
| 画布 | `canvas_list_nodes` · `canvas_write_node` · `canvas_get_node` · `canvas_group_nodes` · `canvas_reorder` · `canvas_get_state` · `canvas_set_state` |
| 资产 | `asset_list` · `asset_to_canvas` |

> 全部工具**模型无关**：capability 由注册表 `preferred` 解析到具体工作流，prompt 与流程里不硬编码模型名。

## 扩展：开发你自己的场景 skill

**适配场景**：插件默认内置两种场景 skill——**3D 动画短片**（故事创意 → 角色/场景/镜头/分镜/逐镜/合成）与**品牌宣传短片**（品牌素材 → 事实核验/创意方向/镜头表/逐镜/合成）。但**场景不是插件边界**——任何「输入 X → 产出视频内容」的创作场景，都能通过扩展 skill 覆盖，复用同一套执行层工具（生成 / 画布 / 资产 / 拼接 / 飞书交付），只换编排规则：

| 场景 | 输入 | skill 定义的编排重点 |
|---|---|---|
| 3D 动画短片（内置） | 一句话故事创意 | 角色一致、场景连续、镜头表自检、H3 原生字幕 |
| 品牌宣传短片（内置） | 品牌素材 / 推广目标 | 身份核验、来源清单、LOGO 首帧锁定、H3 原生画面文案 |
| **电商宣传视频** | 商品 / 卖点文案 | 产品展示分镜、口播逐字稿、卖点高光镜、BGM 与节奏 |
| **教育课件讲解** | 知识点 / 讲义 | 图解卡片、讲解分镜、字幕与口型绑定、节奏控制 |
| 品牌故事 / 纪念短片 / Vlog 解说… | 素材与主题 | 按你的业务规范自定义 |

每个场景 skill 就是一个 `SKILL.md`（纯文本编排规则），插件对它零认知——触发哪个 skill 就完全按它执行。三步即可定义一种新场景：

1. **在 `~/.dsh/skills/` 下新建目录**（或本仓库 `skills/` 下），写 `SKILL.md`，frontmatter 声明触发条件：

```markdown
---
name: my-niche-skill
description: 把 X 素材做成 Y 风格短片的完整流程。当用户提到「X 转 Y 短片」时使用。
whenToUse: 适用于……不适用于……
---

## 生产流程
1. 开场：用 canvas_set_state 声明画幅/时长/音频模式与分组展示顺序
2. 用 comfy_generate_image 建角色卡/场景卡（单视图、零文字）
3. 用 comfy_generate_video 逐镜生成（mode=fast 调试 → quality 成片）
4. 用 video_concat 拼接，交付前把文本要点写进回复（飞书自动送达产物）
```

2. **用能力词汇而非模型名**：skill 里只写 `comfy_render(capability=video.reference2video)` 这类调用；具体工作流由注册表 `preferred` 决定，用户换模型时你的 skill 不用改。

3. **关键节点用选项卡确认**（`ask_user_question`），把耐用产物全部落画布。

## 扩展：导入你自己的 ComfyUI workflow

三种途径，任选其一：

**方式 A · 设置页粘贴（推荐）**：Web 设置页 → ComfyUI → 工作流导入。粘贴你的工作流清单 JSON，或直接粘贴 ComfyUI「**Export (API)**」导出的原始 JSON（`{nodeId:{class_type,inputs}}` 格式）——插件会自动转换：抽取模型资产、识别可注入的标量字段，并输出「待人工确认的语义绑定」清单（哪些字段对应 prompt / 宽高 / 参考图）。

**方式 B · CLI 转换**：

```bash
node scripts/import-comfy.mjs exported.json \
  --id sdxl-text2image --capability image.text2image --name "SDXL 文生图"
```

**方式 C · 手写 manifest**：参照 [`schemas/workflow-manifest.schema.json`](schemas/workflow-manifest.schema.json) 与内置 `workflows/` 示例，写一份清单放到 `~/.dsh/dsh-short-video-studio/workflows/<id>.json`（重启或设置页刷新后即入注册表）。**强校验**保证错误清单被拒绝而不是静默降级：

```json
{
  "id": "my-video",
  "version": 1,
  "capability": "video.reference2video",
  "runner": "comfyui",
  "displayName": "我的视频工作流",
  "output": { "mediaType": "video", "hasAudio": true },
  "assets": { "unet": { "kind": "checkpoint", "default": "my_model.safetensors" } },
  "graph": {
    "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "$assets.unet" } }
  },
  "params": [
    { "name": "prompt", "inject": { "type": "scalar", "to": [["5", "prompt"]] } },
    { "name": "width",  "inject": { "type": "scalar", "to": [["5", "width"]] } }
  ]
}
```

导入后即可用 `comfy_render` / `comfy_list_workflows` 按能力调用；同名清单遮蔽内置版本；`preferred` 决定默认工作流。

## 配置（个性化）

优先级：**环境变量 > 配置文件 > 默认值**。Web 设置页的 **ComfyUI** 菜单提供可视化编辑，保存即生效：

| ComfyUI 设置页 |
|---|
| ![ComfyUI 设置](./examples/harness-dialogue-3.png) |

配置文件：`~/.dsh/dsh-short-video-studio.json`（或 `DSH_SVS_CONFIG` 指定路径）：

```json
{
  "baseUrl": "http://localhost:8188",
  "apiKey": "",
  "pollMs": 2000,
  "timeoutMs": 900000,
  "models": { "fluxUnet": "flux2_dev_fp8mixed.safetensors", "h3Fps": 24, "…": "…" },
  "preferred": { "video.reference2video": ["minimax-h3-ref2v"] },
  "assetOverrides": { "minimax-h3-ref2v": { "unet": "my_custom.safetensors" } }
}
```

- `models.*` / 环境变量（`DSH_SVS_COMFY_URL` / `DSH_SVS_FLUX_MODEL` / `DSH_SVS_H3_MODEL_REF` 等）：换模型文件不改图结构；
- `preferred`：每个能力默认用哪个工作流（设置页「设为默认」写回这里）——**把你导入的工作流设为某能力的默认，即完成「换模型」，内置清单可保留可遮蔽可删除**；
- `assetOverrides`：按清单粒度覆盖资产文件（同 `$assets` 机制，优先级最高）；
- `apiKey` 非空时请求带 `Authorization: Bearer`（适配需鉴权的 ComfyUI 网关）。

## 渠道交付（飞书 / TUI）

> 前置：飞书渠道 dsh-lark 是 **web profile 插件**，需 `dsh plugin --profile web add dsh-lark-channel@latest`（与 dsh web 共用同一 profile，见[飞书集成](#-飞书集成远程操控工作台创作)）。

「画布」tab 只在 Web 可见；跑在 **TUI / 飞书**时，插件在每次提问（`ask_user_question`）前自动把画布未送达产物发到飞书：**媒体文件直接发，文本/表格节点自动导出 PDF**（文件名取节点标题，如 `主角卡.png` / `简报.pdf`）。群聊会先弹审批卡、再出选项卡。Web / TUI 无此通道，产物在画布/工作区，按工具返回的绝对路径自取。详见 [`docs/channel-delivery.md`](docs/channel-delivery.md)。

## 实战要点（沉淀自真实生产）

1. **参考图必须用单视图**：参考图里有几个身体，画面就倾向出现几个角色；三视图拼图必然产生角色副本，且 prompt 声明无效（[实验报告](docs/three-view-experiment.md)）。只用单视图卡。
2. **参考图内不得有任何文字**：角色名、FRONT VIEW 之类标注会被视频模型渲进成片。名字只写画布标题与资产元数据。
3. **多角度对模型无增量价值**：单张正面卡足以支撑转身/走远镜头；多角度时把多张单视图分别放进不同 `ref_nodes` 槽位，绝不拼成一张图。
4. **原生字幕**：使用带原生字幕能力的视频模型（如内置默认 H3）时，对白字幕写进 prompt 末尾即可端到端渲染（含中文）；换成不带该能力的模型后，此条不适用，字幕需走其它方式。
5. **末帧串联仅用于同场景续接**；跨场景只放「角色 + 场景」参考。
6. **角色分状态建卡**：同一角色不同着装分别建单视图卡。

## H3 结构化 prompt（本地版 H3-Context-IR 替代）

本地 H3 工作流（`minimax-h3-*`）的逐镜 prompt 默认走 **H3 结构化格式**，用「本地 agent + skill」复刻官方云端 H3-Context-IR 的核心产物，提升成片质量（官方明言 Context-IR 直接决定输出质量）：

- **`h3-prompt-writing` skill（插件适配版）**：官方 MiniMax 规范（`references/base-en.txt` / `ref-en.txt` 只读引用）+ 插件映射表 `references/studio-mapping.md`。参考绑定镜输出 **Ref2VA 六段式**（subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music）；首末帧串联镜 / 转场镜输出 **I2VA / FL2VA 三段式**（对齐指令 + integrated_multimodal_description + overall_soundscape + non_diegetic_music）。仅当解析工作流 id 前缀为 `minimax-h3-` 时启用，其他模型自动回退自由格式（模型无关）。
- **片型 skill 委托**：3D 动画、品牌宣传等片型 skill 的逐镜生成步骤只写「加载 h3-prompt-writing 重写」，不内置任何 H3 字段细节（职能单一）。
- **hook 门兜底**：`tools/pre-execute` 校验 H3 系工作流的 prompt 是否携带结构化字段，缺失时 deny 并引导 agent 加载 skill 重写（同一 agent 连续 2 次后降级放行，不会死循环）。
- **关闭方式**：覆盖 / 删除 `~/.dsh/skills/h3-prompt-writing` 的「插件对接」适配节（或整体删目录）即回到自由格式组装；`lib/index.js` 的 `H3_PROMPT_GATE` 常量可单独关掉 hook 门。

> ✅ 字幕兼容已实测定稿（A/B 六变体，见画布「A/B 实验结论」）：六段式下字幕**必须**以英文双引号 on-screen text 声明内嵌 `detailed_description` 对白处（中文措辞指令任何位置不生效），dialogue 镜成片用 quality 档保证字准；口型安全 / 一致性 / 音频与旧格式同级，动作执行略优。

## 示例：《一只想当宇航员的小狐狸》

一个完整走完流水线的 30 秒 3D 动画短片（6 镜、quality 档、H3 原生字幕），展示画布各步骤的**真实产物**。

### 角色卡与场景卡

> ⚠️ 以下角色卡为**历史三视图拼图 + 带标注文字**，属**反面示例**（实测会导致多角色副本与文字烙印）；正确做法见上文实战要点——单视图、零文字。

| 小狐狸（不穿） | 小狐狸（穿宇航服） | 小兔子 |
|---|---|---|
| ![小狐狸不穿](./examples/fox/char_fox_no_suit.png) | ![小狐狸穿](./examples/fox/char_fox_with_suit.png) | ![小兔子](./examples/fox/char_rabbit.png) |

| 夜晚森林 | 白天工作台 | 森林小径 | 山顶星空 |
|---|---|---|---|
| ![场景A](./examples/fox/scene_A.png) | ![场景B](./examples/fox/scene_B.png) | ![场景C](./examples/fox/scene_C.png) | ![场景D](./examples/fox/scene_D.png) |

### 逐镜成片截图

| S01 | S02 | S03 |
|---|---|---|
| ![S01](./examples/fox/shot_S01.png) | ![S02](./examples/fox/shot_S02.png) | ![S03](./examples/fox/shot_S03.png) |
| S04 | S05 | S06 |
| ![S04](./examples/fox/shot_S04.png) | ![S05](./examples/fox/shot_S05.png) | ![S06](./examples/fox/shot_S06.png) |

成片 1344×768 · 24fps · 29.6s · H.264 + AAC（H3 声音）· H3 原生中文字幕。对白（含字幕）：S01「总有一天，我要飞到星星上去！」→ S02「我要做一件宇航服！」→ S03 小兔子「狐狸怎么能当宇航员呀？」→ S04「梦想又不需要翅膀，只需要勇气！」→ S05「看，我就要起飞啦！」→ S06「星星……我来啦……」。

> 复现：在会话里说「把『一只想当宇航员的小狐狸』做成 30 秒 3D 动画短片」，Agent 会按 skill 的 Step 0→8 逐步落画布并逐镜生成。

---

## 发布新版本（维护者）

npm 包由 GitHub Actions 自动发布（推送 `v*` tag 触发，见 `.github/workflows/npm-publish.yml`；发布前自动跑冒烟自检并带 provenance 供应链签名）。前提：仓库已配置 `NPM_TOKEN` secret（npmjs.com → Access Tokens → Automation 类型）。

```bash
npm version patch        # bump 版本并打 vX.Y.Z tag（minor / major 同理）
git push origin main --follow-tags   # 推送即触发自动发布
```

发布后安装方式：`dsh plugin --profile web add dsh-short-video-studio`。

---

更多设计细节：架构 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · 工作流契约 [`docs/workflow-contract.md`](docs/workflow-contract.md) · 渠道交付 [`docs/channel-delivery.md`](docs/channel-delivery.md)。
