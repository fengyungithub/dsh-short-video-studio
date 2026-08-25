# dsh-short-video-studio

**完全本地 · 免费 · 零云端依赖** 的 类MiniMax-Design 风格**短剧 / 动画画布工作室**，作为 [DeepSeek Harness](https://github.com/deepseek-ai) 双面插件。所有生成（图片 FLUX / 视频 MiniMax H3）都跑在**本地 ComfyUI** 上，无需任何付费云 API/额度，一次生成、无限出片：

- **画布页**：每个会话多一个「画布」视图 tab，按生产顺序预览/编辑各步骤产物。
- **生成服务**：统一走**本地 ComfyUI API**——图片用本地 FLUX（`flux2_dev`），视频用本地 MiniMax H3（**音视频 AV 模型，默认带声音**，支持参考图绑定与原生字幕），**完全本地、免费**。
- **Agent 工具**：`comfy_generate_image` / `comfy_generate_video` / `canvas_*`，Agent 与画布页读写同一份持久状态 `<workspace>/canvas/<sessionId>/project.json`。
- **自带 skill**：安装插件时自动把 `skills/` 下的 skill 安装到 `~/.dsh/skills/`，供模型/技能中心发现；skill 可扩展。

## 对话体验与配置

在 DeepSeek Harness 会话里，Agent 用**流程叙述 + 任务看板**驱动整条流水线，关键节点用选项卡确认；并在「设置」页提供 **ComfyUI** 配置菜单。下图：两张会话截图 + 一张 ComfyUI 设置页（三图一行）：

| 对话截图 1 | 对话截图 2 | ComfyUI 设置 |
|---|---|---|
| ![会话截图1](./examples/harness-dialogue-1.png) | ![会话截图2](./examples/harness-dialogue-2.png) | ![ComfyUI设置](./examples/harness-dialogue-3.png) |

**对话呈现**：

> 我把《一只想当宇航员的小狐狸》做成 30 秒 3D 动画短片。先说清楚一点，然后进入流程：
>
> - 本插件管线用 FLUX（图片/角色卡/场景卡）+ MiniMax H3（视频）生成，"3D 动画"我用 3D CG / Pixar 风格渲染来实现。
> - 按固定流水线推进：项目简报 → 故事大纲 → 角色卡 → 场景卡 → 七列镜头表 → 文本分镜 → 逐镜生成 → 拼接合成。
> - 按照门控纪律，第一步先用选项卡确认关键设定。

**任务看板**（Agent 自动维护，逐项推进，对应画布分组）：

- [x] 项目简报 + 故事大纲（含音频脊柱图）
- [ ] 故事大纲选项卡批准
- [ ] 角色卡：小狐狸（不穿 / 穿宇航服）+ 小兔子（单视图，选项卡锁定）
- [ ] 场景卡：夜晚森林 / 工作台 / 森林小径 / 山顶（选项卡锁定）
- [ ] 七列镜头表 + 自检
- [ ] 文本分镜文档 + 选项卡批准
- [ ] 逐镜生成视频（shot clips，fast 迭代 → quality 成片）

每个「选项卡批准 / 锁定」节点，Agent 都会弹出**选择卡片**（推荐项置首）；任务完成、产物落画布后可逐镜预览/重做。

**ComfyUI 设置**：设置页新增 **ComfyUI** 菜单，可配置 baseUrl / apiKey / 模型 / 轮询 / 超时，保存后即时生效（写入 `~/.dsh/dsh-short-video-studio.json`）。详细配置见下文「配置」。

👉 [查看下方完整画布展示（项目简报 / 角色卡 / 场景卡 / 每镜截图）](#展示30-秒-3d-动画短片一只想当宇航员的小狐狸)

## 特性

- **H3 音视频工作流**：`MiniMaxH3ReferenceToVideo` + `audio_vae` + `VAEDecodeAudio` → `CreateVideo(audio)`，端到端生成**带声音**的单镜头视频（非静音）。
- **参考图绑定**：`ref_nodes` 传角色卡/场景卡，经 `ref_images.ref_image_N`（dotted）绑定身份/环境，避免角色/服装漂移。
- **快速/质量两档**：`mode=fast`（832×480·4步·Lightning LoRA，调试快 5×+）与 `mode=quality`（1344×768·20步，成片）。
- **末帧串联**：同场景续接镜用 `first_frame_node=上一镜末帧` 做连续性过渡。
- **H3 原生字幕**：对白字幕直接写进 prompt，由 H3 端到端渲染（含中文）。
- **项目设置持久化**：`canvas_set_state` 写入画幅/时长/音频模式/生成模式。

## 安装

**从 GitHub 安装**（发布到 GitHub 后）：

```bash
# 方式 A：GitHub shorthand
dsh plugin --profile web add github:fengyungithub/dsh-short-video-studio

# 方式 B：完整 git URL
dsh plugin --profile web add git+https://github.com/fengyungithub/dsh-short-video-studio.git

dsh web   # 重启后会话出现「画布」tab；自带 skill 已自动安装到 ~/.dsh/skills/
```

**从本地源码安装**（开发用）：

```bash
dsh plugin --profile web add file:/path/to/dsh-short-video-studio
dsh web
```

> 安装后会自动把 `skills/` 下的 skill 复制到 `~/.dsh/skills/`，并在 Web 设置页新增 **ComfyUI** 配置菜单。

## 配置

ComfyUI 服务端 `baseUrl`、`apiKey` 与模型名均可配置，优先级：**环境变量 > 配置文件 > 默认值**。GUI 配置菜单见文首「对话体验与配置」。

配置文件：`~/.dsh/dsh-short-video-studio.json`（或 `DSH_SVS_CONFIG` 指定路径）：

```json
{
  "baseUrl": "http://localhost:8188",
  "apiKey": "",
  "pollMs": 2000,
  "timeoutMs": 900000,
  "models": {
    "fluxUnet": "flux2_dev_fp8mixed.safetensors",
    "fluxClip": "mistral_3_small_flux2_bf16.safetensors",
    "fluxVae": "flux2-vae.safetensors",
    "h3RefUnet": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    "h3Clip": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "h3VideoVae": "minimax_h3_video_vae_fp16.safetensors",
    "h3AudioVae": "minimax_h3_audio_vae_fp32.safetensors",
    "h3FastLora": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    "h3Fps": 24
  }
}
```

等价环境变量：`DSH_SVS_COMFY_URL` / `DSH_SVS_COMFY_KEY` / `DSH_SVS_POLL_MS` / `DSH_SVS_TIMEOUT_MS` / `DSH_SVS_FLUX_MODEL` / `DSH_SVS_FLUX_CLIP` / `DSH_SVS_FLUX_VAE` / `DSH_SVS_H3_MODEL_REF` / `DSH_SVS_H3_CLIP` / `DSH_SVS_H3_VAE` / `DSH_SVS_H3_AUDIO_VAE` / `DSH_SVS_H3_LORA_FAST` / `DSH_SVS_H3_FPS`。

`apiKey` 非空时，请求会带 `Authorization: Bearer <apiKey>`（适配需要鉴权的 ComfyUI 网关）。

## 目录

- `lib/index.js` — 宿主半（ComfyUI 引擎、工作流模板、画布存储、HTTP 路由、Agent 工具、systemPrompt 段、skill 自动安装）
- `lib/client.js` — 浏览器半（注册 `conversation.view` 槽，渲染画布 iframe）
- `studio/` — 画布页（自包含 HTML/CSS/JS，无构建）
- `skills/` — 自带 skill（安装时自动复制到 `~/.dsh/skills/`）
- `cordis.patch.yml` — bundle 补丁

## Skills

- 插件自带 `skills/3d-animation-short-generator`（把一句话创意做成 3D 动画短片的完整流程），安装时自动复制到 `~/.dsh/skills/`（幂等，不覆盖已有）。
- **扩展方式**：在 `skills/` 下新增 `<name>/SKILL.md`，或直接在 `~/.dsh/skills/` 放置自己的 skill（skill-filesystem 热扫描）。每个 skill 就是一个目录，含 `SKILL.md`（frontmatter 含 `name`/`description`/`whenToUse`）。

## 流水线（固定顺序）

0 接收创意 → 选项卡确认【画面比例/总时长/音频模式/生成模式】→ 1 项目简报 → 2 故事大纲 → 3 角色卡 → 4 场景卡 → 5 七列镜头表（+自检）→ 6 文本分镜 → 7 单镜头视频（逐镜）→ 8 拼接 + 终检。

详见 `skills/3d-animation-short-generator/SKILL.md` 与 `skills/3d-animation-short-generator/references/`。

## 工具契约

- `comfy_generate_image(prompt, width?, height?, seed?, steps?, guidance?, count?, title?, group?, nodeId?)`：FLUX 生成图片，写入画布。
- `comfy_generate_video(prompt, mode?, ref_nodes?, first_frame_node?, last_frame_node?, width?, height?, length?, seed?, steps?, title?, group?, nodeId?)`：MiniMax H3 音视频模型生成单镜头视频（带声音）。`mode`=quality/fast；`ref_nodes`=参考绑定；`first/last_frame_node`=末帧串联。
- `canvas_list_nodes / canvas_write_node(kind:text|table, title, content, group) / canvas_get_node / canvas_group_nodes / canvas_reorder / canvas_get_state / canvas_set_state`：读写画布与项目设置。

## 实战要点（沉淀自真实生产）

1. **参考图用单视图**：三视图（正/侧/背）直接作参考会生成多个角色副本；用单视图角色卡，或三视图时在 prompt 声明「同一角色多角度、只出现一只」。
2. **H3 原生字幕**：对白字幕写进 prompt 末尾「画面底部居中显示一条清晰的中文对白字幕：『台词』」。
3. **末帧串联仅用于同场景续接**；跨场景只放「角色+场景」参考。
4. **角色分状态建卡**：同一角色不同着装分别建单视图卡。

---

## 展示：30 秒 3D 动画短片《一只想当宇航员的小狐狸》

一个完整走完流水线的示例：6 镜、quality 档、H3 原生字幕。下面按**画布顺序**展示其 markdown 产物、图片产物与每镜画面（截图）。

画布结构：`story planning → character cards → scene cards → shot table → text storyboards → shot clips → final delivery`

### 1. 项目简报（story planning）

**片名与规格**：`一只想当宇航员的小狐狸`（The Little Fox Who Wants to Be an Astronaut）· 3D 卡通渲染（暖色调 Pixar 风）· 16:9 横屏（1344×768）· 30 秒（24fps）· dialogue-led（对白主导）。

**一句话立意**：一只小狐狸怀揣"飞向星星"的梦想，用纸箱造宇航服、用勇气当翅膀，最终在星空下起飞——梦想不需要翅膀，只需要勇气。

**角色**：

| 角色 | 设定 | 声音角色 |
|---|---|---|
| 小狐狸（主角） | 橙红毛色、蓬松大尾巴、自制纸盒宇航服+头盔，眼睛圆亮有神 | 主说话人，元气坚定 |
| 小兔子（朋友） | 白色短毛、长耳朵，天真直率 | 次说话人，质疑→被感染 |

**视觉基调**：夜晚星空蓝紫冷调 × 小狐狸暖橙暖调；3D 卡通渲染，毛茸茸质感，纸箱宇航服粗粝手作感。

**叙事节奏**：梦想开场（仰星）→ 手作筹备（做宇航服）→ 被质疑（低落）→ 坚定回应（上扬）→ 想象起飞（高光）→ 星空入梦（温暖收尾）。

**台词（对白主导，一镜一人）**：
1. 小狐狸：总有一天，我要飞到星星上去！
2. 小狐狸：我要做一件宇航服！
3. 小兔子：狐狸怎么能当宇航员呀？
4. 小狐狸：梦想又不需要翅膀，只需要勇气！
5. 小狐狸：看，我就要起飞啦！
6. 小狐狸（梦呓）：星星……我来啦……

### 2. 故事大纲（story planning，含音频脊柱图）

**主题**：梦想不需要翅膀，只需要勇气。

**三幕结构（30s / 6 镜）**：

- **第一幕·梦想（0–11s）**
  - S01（5s）森林夜空下，小狐狸独自仰头望星空，瞳孔倒映星光，说出梦想。
  - S02（6s）白天，小狐狸在工作台用废纸箱裁剪、组装**纸箱宇航服**，满头大汗、满脸骄傲。
- **第二幕·质疑与坚定（11–21s）**
  - S03（5s）小狐狸穿纸箱宇航服（背影）走过，小兔子捂着嘴笑出道质疑。
  - S04（5s）小狐狸回头，眼神坚定、嘴角上扬，说出金句回应（反应切镜）。
- **第三幕·起飞与入梦（21–30s）**
  - S05（5s）小狐狸爬上山顶，张开双臂迎风，夜空流星划过、星光洒落，想象中"起飞"。
  - S06（4s）镜头缓缓拉远——小狐狸抱着纸盒头盔（头上无头盔）在草地上睡着，星光化作火箭尾焰轨迹，温暖收尾。

**音频脊柱图（dialogue-led）**：

| 时间 | 镜 | 说话人 | 台词 | 口型状态 | 非说话人嘴 |
|---|---|---|---|---|---|
| 0–5s | S01 | 小狐狸 | 总有一天，我要飞到星星上去！ | 开合（清楚） | 无 |
| 5–11s | S02 | 小狐狸 | 我要做一件宇航服！ | 制作时说话 | 无 |
| 11–16s | S03 | 小兔子 | 狐狸怎么能当宇航员呀？ | 开合（轻笑） | 小狐狸闭嘴 |
| 16–21s | S04 | 小狐狸 | 梦想又不需要翅膀，只需要勇气！ | 坚定开合 | 小兔子闭嘴 |
| 21–26s | S05 | 小狐狸 | 看，我就要起飞啦！ | 大笑开合 | 无 |
| 26–30s | S06 | 小狐狸（梦呓） | 星星……我来啦…… | 轻语微动 | 无 |

**音频模式安全约束**：一镜一人；说话人绑定 `[speaker:]`，非说话人强制闭嘴 `[non_speakers_mouth:closed]`；无旁白。

### 3. 角色卡（character cards，单视图参考）
| 小狐狸·不穿宇航服 | 小狐狸·穿宇航服 | 小兔子 |
|---|---|---|
| ![小狐狸不穿宇航服](./examples/fox/char_fox_no_suit.png) | ![小狐狸穿宇航服](./examples/fox/char_fox_with_suit.png) | ![小兔子](./examples/fox/char_rabbit.png) |

### 4. 场景卡（scene cards，只环境不出现人物）
| A·夜晚森林空地 | B·白天工作台 | C·森林小径 | D·夜晚山顶星空 |
|---|---|---|---|
| ![场景A](./examples/fox/scene_A.png) | ![场景B](./examples/fox/scene_B.png) | ![场景C](./examples/fox/scene_C.png) | ![场景D](./examples/fox/scene_D.png) |

### 5. 七列镜头表（shot table）
7 列规范与自检见 `skills/3d-animation-short-generator/references/shot-table-spec.md`。本片 6 镜摘要见下节分镜。

### 6. 文本分镜（text storyboards）
每镜一节含四象限每秒内容 + Mouth State + 双重绑定 `[char:][scene:][hook:][audio_mode:][speaker:]`；规范见 `references/storyboard-guidelines.md`。

### 7. 单镜头视频（shot clips，每镜画面截图）
| S01 | S02 | S03 |
|---|---|---|
| ![S01](./examples/fox/shot_S01.png) | ![S02](./examples/fox/shot_S02.png) | ![S03](./examples/fox/shot_S03.png) |
| S04 | S05 | S06 |
| ![S04](./examples/fox/shot_S04.png) | ![S05](./examples/fox/shot_S05.png) | ![S06](./examples/fox/shot_S06.png) |

每镜对白 / H3 原生字幕：

| 镜 | 说话人 | 字幕 |
|---|---|---|
| S01 | 小狐狸(不穿) | 总有一天，我要飞到星星上去！ |
| S02 | 小狐狸(不穿) | 我要做一件宇航服！ |
| S03 | 小兔子 | 狐狸怎么能当宇航员呀？ |
| S04 | 小狐狸(穿) | 梦想又不需要翅膀，只需要勇气！ |
| S05 | 小狐狸(穿) | 看，我就要起飞啦！ |
| S06 | 小狐狸(穿) | 星星……我来啦…… |

### 8. 最终合成（final delivery）
- 成片：1344×768（16:9）· 24fps · 29.6s · H.264 + AAC（H3 声音）· **H3 原生中文字幕** → 在播放器查看完整视频。

**关键实现**：
- 狐狸分两张**单视图**角色卡（不穿/穿宇航服），按镜头状态作 `ref_nodes` 参考，避免三视图造成的多人物副本。
- 同场景续接镜（S03→S04、S05→S06）用上一镜**末帧**做 `first_frame_node` 串联；跨场景用 0.4s 溶解、同场景 0.2s。
- 每镜 prompt 加 `[AUDIO_MODE][SPEAKER][NON_SPEAKERS_MOUTH][SHOT_DURATION]` 前缀 + 末尾 H3 原生字幕指令，端到端产出声音与字幕。
- 全片用 ffmpeg `xfade` + `acrossfade` 拼接，保留 H3 声轨。

> 复现：在会话里说「把『一只想当宇航员的小狐狸』做成 30 秒 3D 动画短片」，Agent 会按流水线 Step 0→8 逐步落画布并逐镜生成。
