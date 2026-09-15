# 工作流契约设计：可替换任意模型 / 任意 ComfyUI 工作流

> 目标：让 `dsh-short-video-studio` 从「硬编码 FLUX 图片 + MiniMax H3 视频」演进为
> **一个通用 ComfyUI 工作流执行器 + 注册表**。新增模型 / 换工作流 = 增删一份 JSON 清单，
> 不再改 JS、不再改工具描述、不再改 systemPrompt、不再改 skill。

---

## 1. 现状诊断：刚性来自 4 处硬编码

| 硬编码点 | 位置 | 影响 |
|---|---|---|
| 工作流图（节点 id / class_type / 连线） | `buildFluxImageWorkflow` `buildH3VideoWorkflow` `buildH3ImageToVideoWorkflow` | 换工作流必须改 JS |
| 模型资产（具体文件名） | `getCfg().models`（fluxUnet / h3Clip / …） | 换模型必须改代码 + 配置 |
| 能力语义（mode / ref_nodes / first_frame / lora） | `makeTools()` 参数 + `runVideoGeneration()` | 能力与模型强绑定 |
| 能力描述文本 | `GUIDANCE` systemPrompt 段 + `SKILL.md` | 每加一个模型要改 5 处 |

这四处**互相耦合**：一个「图片模型」的假设（CLIP type=flux2、FluxGuidance 节点、EmptyFlux2LatentImage）
被同时写死在工具描述、工作流构造、systemPrompt 与 skill 里。要让「任意模型 / 任意工作流」可替换，
必须把 **「Agent 想做什么」（语义）** 与 **「某个工作流怎么做」（实现）** 彻底切开。

---

## 2. 核心思想：三层正交契约

```
┌─────────────────────────────────────────────────────────────┐
│ ① 任务契约 Task Contract        Agent 只描述「要什么」          │
│    capability + 类型化输入（prompt/宽高/seed/refs…）          │
├─────────────────────────────────────────────────────────────┤
│ ② 能力契约 Capability Contract   抽象作业词汇表（小、可扩展）     │
│    image.text2image / video.reference2video / audio.tts …    │
├─────────────────────────────────────────────────────────────┤
│ ③ 工作流绑定契约 Workflow Binding  声明式 JSON 清单（数据非代码） │
│    一份清单 = 一个 capability → 一个 ComfyUI 图 + 注入点 + 资产  │
└─────────────────────────────────────────────────────────────┘
```

关键判据：**工作流清单是数据**。宿主插件退化为一个**通用 runner**：读清单、注入参数、提交、轮询、取产物、写画布。
宿主从此不认识「FLUX」「H3」这两个名字，只认识 capability 与 manifest。

---

## 3. 能力契约：能力词汇表（Capability Vocabulary）

一个小而开放的能力枚举。每个能力有**规范输入 schema** 和**输出契约**。Agent 与 skill 只按能力说话。

```jsonc
{
  // 输出契约
  "image.text2image":       { "mediaType": "image", "inputs": ["prompt","width","height","seed","steps","guidance","negative"] },
  "image.image2image":      { "mediaType": "image", "inputs": ["prompt","source_image","denoise","width","height","seed"] },
  "video.text2video":       { "mediaType": "video", "hasAudio": "optional", "inputs": ["prompt","width","height","length","fps","seed","steps","audio"] },
  "video.image2video":      { "mediaType": "video", "hasAudio": "optional", "inputs": ["prompt","first_frame","last_frame","width","height","length","seed","steps"] },
  "video.reference2video":  { "mediaType": "video", "hasAudio": "optional", "inputs": ["prompt","refs[]","width","height","length","seed","steps"] },
  "audio.tts":              { "mediaType": "audio", "inputs": ["text","voice"] },
  "audio.music":            { "mediaType": "audio", "inputs": ["prompt","duration"] },
  "compose.concat":         { "mediaType": "video", "runner": "ffmpeg", "inputs": ["clips[]","bgm"] }  // 非 ComfyUI
}
```

能力是**开放集合**：新模型引入新能力（如 `image.edit`、`video.lip-sync`）只需在词汇表里登记，
不影响已有清单。`runner` 字段预留了「非 ComfyUI 执行器」（ffmpeg / 云端 API）的扩展位。

---

## 4. 工作流绑定契约：Workflow Manifest（核心）

### 4.1 清单结构

```jsonc
{
  "id": "minimax-h3-ref2v-quality",         // 唯一 id（H3 视频已分档：`<组名>-<档位>[-sol]`）
  "version": 1,
  "capability": "video.reference2video",    // 实现哪个能力
  "displayName": "MiniMax H3 参考绑定视频",
  "description": "…",

  // ① 输出契约（覆盖/细化能力默认输出）
  "output": { "mediaType": "video", "hasAudio": true },

  // ② 资产：图引用的模型/LoRA，文件名可被 env/配置覆盖
  "assets": {
    "unet":      { "kind": "checkpoint", "loader": "UNETLoader", "field": "unet_name", "default": "minimax_h3_ref2va_pruned_int8_convrot.safetensors", "env": "DSH_SVS_H3_MODEL_REF" },
    "clip":      { "kind": "clip",      "loader": "CLIPLoader", "field": "clip_name", "default": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "type": "minimax", "env": "DSH_SVS_H3_CLIP" },
    "vae":       { "kind": "vae",       "loader": "VAELoader",  "field": "vae_name",  "default": "minimax_h3_video_vae_fp16.safetensors", "env": "DSH_SVS_H3_VAE" },
    "audio_vae": { "kind": "vae",       "loader": "VAELoader",  "field": "vae_name",  "default": "minimax_h3_audio_vae_fp32.safetensors", "env": "DSH_SVS_H3_AUDIO_VAE" },
    "fast_lora": { "kind": "lora",      "loader": "LoraLoaderModelOnly", "field": "lora_name", "default": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors", "env": "DSH_SVS_H3_LORA_FAST" }
  },

  // ③ 图模板：ComfyUI API 格式（不变的部分照抄，可变部分留空由 params 注入）
  "graph": {
    "1":  { "class_type": "UNETLoader",   "inputs": { "unet_name": "$assets.unet", "weight_dtype": "default" } },
    "3":  { "class_type": "CLIPLoader",   "inputs": { "clip_name": "$assets.clip", "type": "minimax" } },
    "4":  { "class_type": "VAELoader",    "inputs": { "vae_name": "$assets.vae" } },
    "4a": { "class_type": "VAELoader",    "inputs": { "vae_name": "$assets.audio_vae" } },
    "2":  { "class_type": "MiniMaxH3SigmaShift", "inputs": { "model": ["$model", 0], "shift_video": 12.0, "shift_audio": 3.0 } },
    "5":  { "class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
              "clip": ["3", 0], "vae": ["4", 0], "audio_vae": ["4a", 0],
              "prompt": null, "width": null, "height": null, "length": null, "ref_image_size": "match" } },
    "6":  { "class_type": "RandomNoise",       "inputs": { "noise_seed": null } },
    "7":  { "class_type": "BasicGuider",       "inputs": { "model": ["2", 0], "conditioning": ["5", 0] } },
    "8":  { "class_type": "KSamplerSelect",    "inputs": { "sampler_name": "res_multistep" } },
    "9":  { "class_type": "BasicScheduler",    "inputs": { "model": ["2", 0], "scheduler": "simple", "steps": null, "denoise": 1.0 } },
    "10": { "class_type": "SamplerCustomAdvanced", "inputs": { "noise": ["6",0], "guider": ["7",0], "sampler": ["8",0], "sigmas": ["9",0], "latent_image": ["5",1] } },
    "11": { "class_type": "VAEDecode",       "inputs": { "samples": ["10",0], "vae": ["4",0] } },
    "11a":{ "class_type": "VAEDecodeAudio",  "inputs": { "samples": ["10",0], "vae": ["4a",0] } },
    "12": { "class_type": "CreateVideo",     "inputs": { "images": ["11",0], "audio": ["11a",0], "fps": null } },
    "13": { "class_type": "SaveVideo",       "inputs": { "video": ["12",0], "filename_prefix": null, "format": "mp4", "codec": "h264" } }
  },

  // ④ 注入点：任务输入 → 图字段（契约的核心机制）
  "params": {
    "prompt":  { "inject": "scalar", "to": { "node": "5", "field": "prompt" } },
    "width":   { "inject": "scalar", "to": { "node": "5", "field": "width" } },
    "height":  { "inject": "scalar", "to": { "node": "5", "field": "height" } },
    "length":  { "inject": "scalar", "to": { "node": "5", "field": "length" } },
    "seed":    { "inject": "scalar", "to": { "node": "6", "field": "noise_seed" } },
    "steps":   { "inject": "scalar", "to": { "node": "9", "field": "steps" } },
    "fps":     { "inject": "scalar", "to": { "node": "12", "field": "fps" }, "default": 24 },
    "refs":    { "inject": "image", "via": "field", "to": { "node": "5", "field": "ref_images.ref_image_${i}" }, "node": "LoadImage", "max": 8 },
    "prefix":  { "inject": "scalar", "to": { "node": "13", "field": "filename_prefix" } }
  },

  // ⑤ 质量档（mode）：纯数据，描述 steps / LoRA 插入 / 分辨率
  "modes": {
    "quality": { "steps": 20, "longSide": 1344, "loras": [] },
    "fast":    { "steps": 4,  "longSide": 832,  "loras": [ { "asset": "fast_lora", "onWire": "$model", "strength": 1.0 } ] }
  },

  // ⑥ 分辨率策略
  "resolution": { "policy": "aspect-ratio", "snap": 32, "default": { "fast": [832,480], "quality": [1344,768] } },

  // ⑦ 约束（解析时用来匹配/过滤）
  "constraints": { "aspectRatios": ["16:9","9:16","1:1"], "maxDurationFrames": 310, "supportsSubtitles": true }
}
```

### 4.2 注入原语（`inject` 类型）——「任意工作流」的落地关键

ComfyUI 图是「字段写入」与「节点连线」的混合。为了让任意工作流都能被数据驱动，注入分 5 类：

| inject | 语义 | 说明 |
|---|---|---|
| `scalar` | 把任务值写到某节点字段 | prompt / width / height / seed / steps / fps… |
| `image` `via:field` | 上传图片 → 把文件名写入某字段 | H3 的 `ref_images.ref_image_N`（dotted 字段，`${i}` 占位符索引展开） |
| `image` `via:node` | 上传图片 → 建 LoadImage 节点 → 连线到目标字段 | H3 的 `first_frame` / `last_frame`（可带 `preprocess` 链：ImageScale 等） |
| `wire` | 连接某节点输出到目标输入 | 把动态构造的节点（LoRA/LoadImage）接到固定节点 |
| `asset` | 图内 `$assets.<name>` 引用解析为模型文件名 | 模型资产可替换，图结构不变 |

**寻址用 `{node, field}`**（而非 JSON Pointer），更贴近 ComfyUI 原生语义、便于校验；`field` 支持 dotted key
（`ref_images.ref_image_0`）。对非标工作流可追加 `jsonPointer` 兜底。

**`$model` 哨兵**：图内所有需要「可选 LoRA 链插入」的连线写 `["$model", 0]`；runner 按 mode 的 `loras` 声明，
在 `$model` 之前动态插入 `LoraLoaderModelOnly` 节点，把模型链路重定向。这样「fast 档插 LoRA」这类能力差异
也被降级为纯数据。

### 4.3 关键不变量

- **图模板只描述「不变的结构」**，所有「每镜可变」的值（prompt/宽高/seed/refs/前缀）都走 `params` 注入，绝不写死在清单里。
- **manifest 只描述「这个工作流」**，不描述「这个模型好不好」；模型能力上限由 `constraints` 声明，由 runner 校验。
- **一份 manifest = 一个 capability 的一条实现路径**。同一 capability 可有多个 manifest（不同模型/不同质量），由解析排序决定默认。

---

## 5. 工具契约：泛化 + 自发现

### 5.1 新增两个通用工具

```jsonc
// ① 自发现：Agent 不再硬编码「有什么模型可用」
comfy_list_workflows() -> {
  "capabilities": [ { "id": "video.reference2video", "workflows": [
      { "id": "minimax-h3-ref2v-quality", "group": "minimax-h3-ref2v", "tier": "quality", "constraints": {...} } ] } ],
  "assets": { ... }   // 当前生效的模型文件名（便于展示/排错）
}

// ② 统一渲染入口
comfy_render({
  capability: "video.reference2video",   // 必填：能力（能力词汇表）
  workflow: "minimax-h3-ref2v-quality",  // 可选：显式指定实现（其 tier 与请求档位不符会报错，不静默）
  tier: "quality",                       // 可选：档位 fast|balanced|quality（缺省 quality）；mode= 为兼容别名
  prompt, width, height, seed, steps, length, refs[], first_frame, last_frame, // 能力输入
  title, group, nodeId, sessionId, workspaceId                              // 画布落库参数（与能力无关，宿主统一处理）
}) -> { ok, nodeId, media, tier, implementation, resolution, warnings }
```

> **档位解析**：显式 `workflow` > 配置 `tiers[capability][tier]` > 组内该档标准实现；该档无实现或实现不可用**一律报错**（含可用档位列表 / 缺哪个节点），**不静默跨档替换**。旧 `modes` 仅作只读兼容（未分档清单按 mode 名匹配）。详见 `docs/tier-strategy-design.md`。

### 5.2 保留旧工具作为薄别名（向后兼容，流水线不中断）

```js
comfy_generate_image = comfy_render({ capability: "image.text2image", ... })
comfy_generate_video = comfy_render({ capability: "video.*", 按**显式必填**的 type 分派（r2v→video.reference2video / i2v→video.image2video）... })
# 形状真值表与校验见 docs/video-shape-contract.md（type 必填；参数与形状冲突显式报错）
```

旧工具保留签名不变，内部走 registry 分派。这样现有 skill 与 pipeline **零改动即可继续跑**，
而新模型接入后 skill 逐步迁移到 `comfy_render` + 能力词汇。

### 5.3 画布落库与能力解耦

`runImageGeneration` / `runVideoGeneration` 里「解析 root → 提交 → 轮询 → 下载 → persistMedia → 写 node」
这段**与模型无关**，抽成通用 `runRender(ctx, {capability, workflow, mode, inputs, canvasMeta})`。
`node.params` 里不再写死 `model: 'flux'`，而记录 `workflowId` / `mode` / `assets`（可复现）。

---

## 6. 注册表与解析（Registry + Resolution）

### 6.1 清单来源（优先级从低到高）

1. **内置清单**：插件 `workflows/*.json`（随包分发，如 flux-text2image / h3-ref2v / h3-i2v）。
2. **用户清单**：`~/.dsh/dsh-short-video-studio/workflows/*.json`（用户/第三方新增，覆盖同名内置）。
3. **资产覆盖**：`~/.dsh/dsh-short-video-studio.json` 的 `models.*` 或 `DSH_SVS_*` env（只换文件名，不动图结构）。

### 6.2 解析算法（生成时）

```
comfy_render(capability, hints…):
  候选 = registry.filter(manifest.capability == capability)
        .filter(constraints 满足 hints: aspect / duration / hasAudio / subtitles…)
        .sort(priority 降序)
  若显式 workflow → 直接取；否则取第一个满足 mode 的候选
  若空 → 抛「no workflow for capability」+ 附 comfy_list_workflows 的可用清单
  注入：assets 解析 → params 注入 → mode 的 loras 插入 → graph 提交
  失败 → 走既有失败梯度（重试→拆镜/降分辨率/简化→选项卡→占位），并把候选 manifest 顺延
```

解析顺序（默认模型）从「写死在 systemPrompt 里的推荐文案」变成**注册表里的 `priority` 字段**，
所以「默认 H3、用户指定才换」这类策略也降级为数据。

---

## 7. 迁移路径（可增量、不破坏现有流水线）

| 阶段 | 动作 | 风险 |
|---|---|---|
| M1 | 新增 `runner + registry + manifest 校验`，把现有 3 个 builder 各翻译成 1 份内置 manifest；builder 保留为对照 | 低（纯新增） |
| M2 | `runRender` 通用化；`comfy_generate_*` 改为分派到 `comfy_render`；新增 `comfy_list_workflows` | 低（双写对照，回滚容易） |
| M3 | systemPrompt `GUIDANCE` 段 + `SKILL.md` 改为**能力词汇**表述（「文生图 / 参考绑定视频」而非「FLUX / H3」）；默认模型改由 registry priority 决定 | 中（需回归流水线语义） |
| M4 | 设置页 `client.js` 从「固定字段列表」改为「按 registry 动态渲染 assets/constraints」，支持导入任意 manifest | 中（UI 重构） |
| M5 | 新增第 4 个模型仅需：丢一份 `wan2.1-text2video.json` / `qwen-image-edit.json` → 重启 → `comfy_list_workflows` 可见 | 零 JS 改动（验收标准） |

**验收判据（Definition of Done）**：在不动任何 JS 的前提下，通过新增/编辑一份 manifest，
成功把「图片」从 FLUX 换成任意文生图工作流、把「视频」从 H3 换成任意视频工作流，且
`comfy_list_workflows` 能自发现、旧 pipeline 与画布落库行为不变。

---

## 8. 附：一条「新增模型」的对照（说明收益）

**现状**（加一个 SDXL 文生图）：改 `buildFluxImageWorkflow`、改 `getCfg().models`、改 `comfy_generate_image` 描述、
改 `GUIDANCE`、改 `SKILL.md` —— 5 处 JS/文案，且 CLIP type、guidance 节点、latent 节点全要新写代码。

**新契约**：新增 `~/.dsh/dsh-short-video-studio/workflows/sdxl-text2image.json`（照抄 ComfyUI 导出的 API JSON，
声明 `capability:"image.text2image"`、`params` 注入点、`assets`、`modes`、`resolution`），
设 `priority` 高于 flux 即成为新默认，或让 Agent 显式 `workflow:"sdxl-text2image"`。**零 JS 改动**。

---

## 9. 已定案（决策记录，4 项均按推荐）

1. **寻址**：以 `{node, field}` 为主（ComfyUI 原生、易校验、dotted 字段天然支持 `ref_images.ref_image_N`）；
   保留可选 `jsonPointer` 作为非标工作流的兜底。二者共存，`{node,field}` 优先，`jsonPointer` 仅当字段无法用
   node+field 表达时使用。
2. **image 注入 `via:node` 预处理链**：进清单。用 `preprocess: [{ "class_type": "ImageScale", "inputs": {...} }]`
   声明「LoadImage → 预处理 → 目标字段」的辅助链；`preprocess` 内可用 `${width}` / `${height}` 引用能力输入。
3. **非 ComfyUI runner**：预留 `runner` 字段（默认 `comfyui`），本期只实现 `comfyui`；
   `compose.concat`（拼接/BGM）继续走既有 ffmpeg 脚本，不进 manifest。
4. **manifest 校验**：加载期用 JSON Schema 强校验；校验失败拒绝加载，并在 `/api/workflows` 返回明确错误，
   不静默降级、不部分应用。

---

## 10. 用户操作：换模型 / 换工作流怎么配 + 配置 UI 集成

### 10.1 三种操作与对应入口

| 用户想做什么 | 语义 | 操作入口 | 是否改 manifest |
|---|---|---|---|
| **换模型文件** | 同一工作流，只换 checkpoint/VAE/CLIP 文件名 | 设置页「资产覆盖」改文件名（或 env） | 否 |
| **换 / 加工作流** | 换整张图 + 注入点（如 FLUX→SDXL） | 设置页「导入工作流」贴 JSON / 上传 | 是（新增清单） |
| **换默认模型** | 某 capability 默认用哪个工作流 | 设置页「工作流注册表」设默认 / 排序 | 否（改 `preferred`） |

三者解耦：换模型文件不碰图结构；换工作流不碰 Agent 语义；换默认只改优先级。

### 10.2 配置存储（扩展 `~/.dsh/dsh-short-video-studio.json`）

```jsonc
{
  "baseUrl": "http://localhost:8188",
  "apiKey": "",
  "pollMs": 2000,
  "timeoutMs": 900000,

  // 换模型：manifestId -> assetKey -> 文件名（分档后按**单档清单 id** 覆盖，逐档写）
  "assetOverrides": {
    "minimax-h3-ref2v-quality": { "unet": "minimax_h3_ref2va_pruned_int8_convrot.safetensors" }
  },

  // 档位选择：capability -> tier -> 实现 id（H3 视频分档后的主路径，见 tier-strategy-design §4.1）
  "tiers": {
    "video.reference2video": { "fast": "minimax-h3-ref2v-fast", "balanced": "minimax-h3-ref2v-balanced-sol", "quality": "minimax-h3-ref2v-quality-sol" }
  },

  // 未分档清单的固定选择：capability -> 有序 workflowId 列表（第 1 个 = 默认，其余 = fallback 顺序）
  "preferred": {
    "image.text2image": ["flux-text2image", "sdxl-text2image"],
    "image.image2image": ["flux2-img2img"]
  }
}
```

**资产解析优先级**：`env`（`DSH_SVS_*` 或 manifest `assets[].env`） > `assetOverrides` > manifest `assets[].default`。

**向后兼容**：现有 `models.fluxUnet` 等键作为旧别名自动映射（如 `models.fluxUnet → assetOverrides["flux-text2image"].unet`），
升级后旧配置不失效。

### 10.3 配置 UI 集成（重构 `client.js` 的 `ComfyUISettings`：固定字段 → 清单驱动）

设置页「ComfyUI」卡片由原来的「连接 + 固定模型字段」重构为四段：

1. **连接**：`baseUrl` / `apiKey` / `pollMs` / `timeoutMs`（保持不变）。
2. **工作流注册表**（新增）：
   - 按 capability 分组列出已装清单（`id` / `displayName` / `modes` / `hasAudio`）。
   - 每个 capability 内：⭐ 设默认 + ↑↓ 调整优先级（写回 `preferred`）。
   - 「导入工作流」按钮：粘贴 JSON 或上传 `.json` → 加载期 JSON Schema 校验 → 存
     `~/.dsh/dsh-short-video-studio/workflows/`。
   - 内置清单只读；用户清单可同名遮蔽内置、可删除。
3. **资产覆盖**（新增，替换原固定模型字段列表）：
   - 选中某工作流 → **动态渲染其 `manifest.assets` 字段**（文件名可编辑，标注 env 变量名）。
   - 保存写 `assetOverrides[workflowId]`。不再硬编码 FLUX/H3 字段名。
4. **校验 / 测试**（可选）：对当前默认工作流发一次最小图空跑，验证 ComfyUI 可达性与图合法性。

### 10.4 宿主 API 新增

| 路由 | 作用 |
|---|---|
| `GET /api/workflows` | 已装清单 + 各自 `assets` + `preferred` |
| `POST /api/workflows` | 导入 / 覆盖用户清单（JSON Schema 校验后落盘） |
| `DELETE /api/workflows?id=` | 删除用户清单（内置清单不可删，仅遮蔽） |
| `POST /api/config` | 扩展接受 `assetOverrides` + `preferred`（兼容旧 `models.*` 别名） |

### 10.5 上手路径（从易到难）

- **只想换个 checkpoint 文件**：设置页「资产覆盖」改文件名 → 保存 → 即时生效（零 manifest、零重启）。
- **想用另一个现成 ComfyUI 工作流**：设置页「导入工作流」贴 ComfyUI 导出的 API JSON →
  补 `capability` + 注入点（或先用「骨架向导」自动生成注入点）→ 设默认。下一阶段可做
  「从 ComfyUI API JSON 生成清单骨架」的向导（问：哪个能力？哪个是输出节点？哪些字段是 prompt/宽高/seed？），
  MVP 先提供「贴 JSON + 校验 + 手填注入点」。
- **想接云端 / 非 ComfyUI 执行器**：本期不支持，`runner` 字段已预留，下期扩展。

> 结论：**换模型 / 换工作流完全集成进现有「设置 → ComfyUI」配置 UI**，不用手改文件（也保留手改
> `~/.dsh/...` 文件 + `env` 的高级路径）。Agent 侧无需知道用户怎么配的——它只调 `comfy_render`，
> 由 registry 按 `preferred` 解析默认工作流，用户换默认后 Agent 无感切换。

## 11. 从 ComfyUI 导出的工作流怎么转成清单

**标准格式 = ComfyUI 的「Export (API)」**，即 `{nodeId:{class_type,inputs}}`。它就是我们的 `graph` 字段定义、
提交给 `/prompt` 的原样格式，稳定且无 UI 噪声。ComfyUI 的「直接导出（Save/Export workflow）」在 0.3.x
是同一结构 + 一层 `_meta`（标题/坐标），导入时会自动剥掉 `_meta` 归一化成 API 格式；旧版（<0.3）的
`{nodes:[],links:[]}` workflow 格式不支持，导入路由会拒绝并提示改用「Export (API)」。

ComfyUI 菜单「导出 API」得到的 JSON 就是我们的 `graph` 格式（`{nodeId:{class_type,inputs}}`），
二者同构。缺的只是「元数据 + 注入点」两件事。转换规则如下：

### 11.1 直接保留
- 整个 `graph`（节点 id、`class_type`、连线 `["id", idx]`）原样照搬。
- 采样器/调度器的固定超参（如 KSampler 的 `sampler_name`、`scheduler`、`cfg`、`denoise`）原样保留。

### 11.2 抽成资产（assets）
- 把「模型文件名」从图里挖出来放进 `assets`，图内换成 `$assets.<key>`，这样设置页「资产覆盖」才能换文件：
  | 节点 | 字段 | 资产 key |
  |---|---|---|
  | `CheckpointLoaderSimple` / `UNETLoader` / `DiffusionModelLoader` | `ckpt_name` / `unet_name` / `model_name` | `checkpoint` / `unet` |
  | `CLIPLoader` / `DualCLIPLoader` | `clip_name` / `clip_name1` | `clip` |
  | `VAELoader` | `vae_name` | `vae` |
  | `LoraLoader` / `LoraLoaderModelOnly` | `lora_name` | `lora` |

### 11.3 标量注入点（params）
- 把「每次生成都要变的量」置 `null` 并在 `params` 声明注入点（`{node, field}`）：
  | 语义 | 常见字段 |
  |---|---|
  | prompt | `CLIPTextEncode.text`（sampler `positive` 指向的那个）/ 某些视频节点的 `prompt` |
  | width / height | `EmptyLatentImage`、`EmptySD3LatentImage`、`EmptyFlux2LatentImage`、`ModelSamplingFlux` 的 `width`/`height` |
  | seed | `RandomNoise.noise_seed`、`KSampler.seed` |
  | steps | `KSampler.steps`、`BasicScheduler.steps`、`Flux2Scheduler.steps` |
  | guidance | `FluxGuidance.guidance` |
  | 输出前缀 | `SaveImage.filename_prefix`、`SaveVideo.filename_prefix` |

### 11.4 语义绑定（必须手判）
- **参考图 / 首末帧**：`LoadImage` 节点无法自动判断语义，要改成 `params` 里的
  `inject:"image"`（`refs` 用 `via:"node"` 绑定参考；`first_frame`/`last_frame` 用 `via:"node"` +
  `preprocess` 缩放）。同场景续接走 `first_frame_node`，跨场景只放角色+场景参考。
- **正/负向提示词**：`negative` 指向的 `CLIPTextEncode` 本期 runner 不注入，保留导出时的原值即可。
- **LoRA 换档**：若 fast/quality 靠不同 LoRA 切换，才需要 `$model` 哨兵 + `modes.<mode>.loras`；
  普通工作流硬连线即可，无需 `$model`。

### 11.5 自动转换脚本
`scripts/import-comfy.mjs` 自动完成 11.2 + 11.3（资产、标量、prompt、`$assets`/`null` 替换），
并打印 11.4 的「需手动补充」清单：

```
node scripts/import-comfy.mjs exported.json \
  --id sdxl-text2image --capability image.text2image --name "SDXL 文生图" \
  --out ~/.dsh/dsh-short-video-studio/workflows/sdxl-text2image.json
```

产出的清单 `validateManifest` 即通过，可直接被 `comfy_render` 执行；剩下的就是补
`modes`/`resolution`/`constraints`/`output.hasAudio` 等策略字段，以及按 11.4 完成参考图绑定。
