# 视频补帧（fps）：技术方案讨论

> 目标（2026-10-26 与用户确认）：**A. 平台交付帧率（30/60fps）** + **B. 观感更顺（48fps）**。
> 本文只讨论方案与落点，不含实现；细节取证见
> [`research/fps-interp/landscape.md`](research/fps-interp/landscape.md)（外部资料）、
> [`research/fps-interp/integration.md`](research/fps-interp/integration.md)（仓库落点）、
> [`research/fps-interp/comfy-probe.md`](research/fps-interp/comfy-probe.md)（ComfyUI 探针）。

---

## 0. 结论速览

1. **「补帧」是两个不同的问题，必须分开做**：
   - **时基转换**（改容器 fps，复制/丢帧）→ 解决 *平台要求 30/60fps* 的**合规**问题，零画质风险、零 GPU、秒级；
   - **运动插帧**（VFI 生成中间帧）→ 解决 *观感更顺* 的问题，需要 GPU 模型，有画质风险。
   把两者混成一个「补帧」按钮，最容易交付「标称 60fps、实际 3:2 重复帧」或「帧数变了但成片半速」的坏片。
2. **当前链路把 fps 固定在 24**：H3 原生 24fps（`lib/index.js:94` 的 `H3_FPS`，`CreateVideo` 直接吃它），`length` 是 24fps 帧数；超分保持 fps；`concat` 的 ComfyUI 后端**直接取首段的 fps**（`lib/concat.js:49`）——混 fps 拼接**不报错但时基错**。
3. **30/60 在模型侧做不到**：ComfyUI 原生 `FrameInterpolate` 只接受**整数倍** 2–16（[源码](https://github.com/comfyanonymous/ComfyUI/blob/master/comfy_extras/nodes_frame_interpolation.py)），24→30（1.25×）、24→60（2.5×）都不在集合里。真要做只能 **24→120（5×）再整数抽取到 60/30**，而抽取需要 ffmpeg。
4. **48fps 是最现实的整数倍**（24×2），但**不建议默认开**：需要先在服务器放 RIFE/FILM 权重（RIFE 4.25 仅 21.6MB，FILM 65.7MB）、按镜头做 A/B，确认不会把运动模糊变成双影、不把字幕插糊。
5. **建议顺序**：先做「时基正确 + 平台合规」（不依赖 GPU/权重）→ 再做「48fps 逐镜补帧」（先 A/B 后上线）→ 慢动作与 60fps 母版派生放最后。
6. **今天两条路各缺一个依赖**：30/60 缺 **ffmpeg**（本机与宿主都没有）；48fps 缺**一个权重文件**（服务器 `models/frame_interpolation/` 为空，RIFE 4.25 仅 21.6MB）。两个依赖都很小，但都需要先拍板。
7. **两条硬拒**：① 成片（跨硬切）补帧——模型没有场景检测，硬切处会生成两个镜头之间的形变帧；② 用 `ffmpeg -r/-vf fps` 冒充补帧——那只是复制帧，不产生新信息。

---

## 1. 需求拆解：四个「补帧」，四种机制

| 需求 | 机制 | 画面变顺？ | 时基/时长 | 依赖 |
|---|---|---|---|---|
| **平台交付 30/60fps** | 时基转换（复制/丢帧/pulldown） | ❌ 只改时间轴 | 时长不变 | ffmpeg（本机当前无） |
| **观感更顺（48fps）** | 运动插帧（VFI） | ✅ 真生成中间帧 | 时长不变（fps=源×倍率） | GPU + 权重 |
| **慢动作（升格）** | 插帧 + 时间轴拉伸 | ✅ | 时长 ×N | GPU + 权重 + 音频重定时/替换 |
| **混素材时基归一** | 时基转换 + 拼接守卫 | — | 时长不变 | ffmpeg 或统一生成口径 |

> 用户这次选的是前两项。**慢动作不在本期**，但架构要留位（见 §4.5）。

---

## 2. 现状与硬约束（可复核）

### 2.1 生成侧：fps 是常量，不是参数

- `H3_FPS = env('DSH_SVS_H3_FPS', 24)`（`lib/index.js:94`）；所有 H3 图的 `CreateVideo.fps` 都吃它（`:581/:637`），画布视频节点 `params` 记 `fps/length/width/height`（`:1075`）。
- `length` 是**交付帧数**，124 ≈ 5.17s。改 `fps` 只会让同一批帧**播快/播慢**，不会让模型多生成时间信息。
- 结论：**生成侧没有「提高帧率」这个旋钮**；H3 的 24fps 是时域采样率，补帧只能发生在采样之后。

### 2.2 后期侧：超分保 fps，拼接假设 fps 一致且不校验

- `video.upscale` 的产物「同帧数、同 fps、同音轨」（`docs/video-upscale.md:15`；`runUpscale` 用源 `fps` 注入 `CreateVideo`，`lib/index.js:2984`）。
- `buildConcatGraph` 的 `CreateVideo.fps` 直接接**首段**的 `GetVideoComponents`（`lib/concat.js:39,49`）；`ImageBatch` 把各段首尾拼成一个长批次 ⇒ 24fps 段与 48fps 段混拼时，48fps 段**半速播放**，整片时基崩，**不报错**。
- `runConcat` 产物只记 `{backend,reencoded,sources}`（`lib/index.js:2925`），**不记 fps/width/height/length** ⇒ 补帧后下游拿不到 fps，只能靠容器探测。

### 2.3 交付体积：20 MiB 是现实门槛

- 飞书 `send_file` 单文件默认 **20 MiB**（插件说明 `lib/index.js:5019`）。
- 实测一个 35s、768×1344、24fps 的 H3 片段 **22.6 MB**（≈5.2 Mbps）；5s 镜约 3.2 MB。
- 同 CRF 下 48fps 码率约 **+40%~70%**（不是 ×2）⇒ 30s 成片 48fps 约 **27–33 MB，必超 20 MiB**。
- ⇒ **补帧能力的交付策略必须单独设计**：降低 CRF/码率、只交付单镜、或「24fps 代理文件 + 画布取全质量文件」。

### 2.4 ComfyUI 侧：节点在，权重不在

- ComfyUI **0.42.1** 自带核心节点：`FrameInterpolationModelLoader`（`INTERP_MODEL`）+ `FrameInterpolate`（`images + multiplier 2..16 → IMAGE`）+ 官方蓝图（`fps` 乘不乘的显式开关 = 补帧 vs 慢动作），见官方 PR [#13258](https://github.com/Comfy-Org/ComfyUI/pull/13258) 与[文档](https://docs.comfy.org/tutorials/utility/frame-interpolation)。
- 源码事实（本次直接读 `comfy_extras/nodes_frame_interpolation.py`）：
  - 只认 **FILM** 与 **RIFE（IFNet）** 两种权重格式；其他格式报 `Unrecognized frame interpolation model format`；
  - **输出帧数 = `(N−1)×multiplier + 1`**（保留首尾真帧，不补尾）；
  - 输入 <2 帧或 `multiplier<2` 时**原样返回、不报错**（静默 no-op，调用方要自己防）；
  - 结果张量分配在 `intermediate_device()`（CPU 侧），逐帧对前向、OOM 时自动减 batch；
  - 音频不经过模型——必须由 `CreateVideo(images, fps, audio)` 把源音轨接回去。
- 权重目录 `ComfyUI/models/frame_interpolation/` **当前为空**（`GET /models/frame_interpolation → []`）。官方权重：[Comfy-Org/frame_interpolation](https://huggingface.co/Comfy-Org/frame_interpolation)，推荐 `rife_v4.25.safetensors`（**21.6MB**；FILM 为 `film_net_fp16.safetensors` 65.7MB）。放文件即可，**不用重启**（`folder_paths` 按目录 mtime 失效）。
- 显存/内存量级（按源码公式，**耗时未实测**）：1344×768、124 帧输入张量 1.53GB；m=2 输出 3.06GB、m=4 输出 6.11GB（**CPU 侧 fp32**，因为实例没开 `--gpu-only/--fp16-intermediates`）；单帧对激活峰值 FILM ≈3.5GB / RIFE ≈0.62GB，与帧数无关 ⇒ **单镜 1344×768 不需要分块**，卡在内存不卡显存。
- 远端环境：ComfyUI 在 `t0-server` 的 docker 容器 `comfyui`；模型目录映射为宿主 **`/data/comfyui/storage-models/models`** → 容器 `/root/ComfyUI/models`。服务器 **huggingface.co 不通、hf-mirror.com 通**（2026-10-26 探针核实）。
- **已实测的三条关键行为**（[`comfy-probe.md`](research/fps-interp/comfy-probe.md)）：
  1. 权重不在目录里 ⇒ `/prompt` 直接 **400 校验失败**（不是运行时错误），图提交不进去；
  2. `CreateVideo(fps=48)` **只改标签**：24 帧输入 → 24 帧输出、0.5s，不会复制帧；
  3. `CreateVideo` 的音轨 = `min(输入音频, 画面时长)`，且按 AAC 包粒度截断（≈32ms）。**补帧后画面会比源短 `(m−1)/(m·f)`**（m=2 约 20.8ms/镜）⇒ 不 pad 就会**逐镜剪掉音频尾巴**，这正是 §4.2 必须 `N×m` 的原因。

### 2.5 本机没有 ffmpeg

- 本机与宿主机 **都没有 ffmpeg**（`which ffmpeg` 空，2026-10-26 实测）；`/usr/local/bin/brew` 存在（可安装，但未装）。容器内是否有 ffmpeg 未能只读确认。
- 没有 ffmpeg 时，`video_concat` 会退到 ComfyUI 纯节点链路（`lib/concat.js:1-15`）——**但「30/60 抽帧」「慢动作时间轴拉伸」没有 ComfyUI 兜底**，只能 fail-closed。

### 2.6 画质风险（决定「值不值得做」）

| 风险 | 机制 | 处置 |
|---|---|---|
| **运动模糊双影** | H3 每帧自带运动模糊时，VFI 在两张「已糊」的帧之间插值，容易叠成双重曝光 | 先 A/B；不合格镜头不补或降倍率 |
| **画面内字幕/文字** | 文字是硬边高频，插帧会拉丝/重影/半透明叠字 | 有字幕镜头跳过；或生成时关原生字幕、补帧后再烧字（需要字幕层） |
| **硬切鬼影** | 模型没有场景检测，跨切点会生成 A/B 混合帧 | **只逐镜补，成片不补** |
| **纹理沸腾/闪烁被放大** | AI 视频相邻帧本就有细微差异，VFI 把它当运动 | 48fps 优先、96fps 只做母版；必要时先时域降噪 |
| **HFR「塑料感」/肥皂剧效应** | 24fps 的电影感部分来自低帧率 + 运动模糊 | 只在用户明确要「顺」时开，默认保持 24 |
| **96fps 兼容性** | 部分播放器/IM 内置播放器不支持 >60fps | 96/120 只作中间母版，不交付 |

---

## 3. 方案空间与对比

### 3.1 时基转换（解决「平台合规」，不解决「顺」）

| 做法 | 24→30 | 24→60 | 代价 | 说明 |
|---|---|---|---|---|
| `ffmpeg -vf fps=30/60`（复制/丢帧） | 5:4 节奏，每 5 帧重复 1 帧 | **3:2 pulldown**：每 5 帧里 3 帧是保持帧（A,A,A,B,B），节奏明显 | 秒级、零 GPU | 只改容器时基；观感不改善 |
| 120fps 母版 → `fps=30/60` 抽取 | 120→30（每 4 取 1） | 120→60（每 2 取 1） | 需要模型 ×5 + ffmpeg | **真顺**；母版体积大、不交付 |
| `minterpolate`（任意比） | 支持 | 支持 | CPU 极慢（1080p 可达数十倍实时） | 无 GPU/无权重时的兜底；块状/文字崩 |

**要点**：24→30 的 5:4 复制节奏通常可接受（严格说仍有每 5 帧 1 次的顿挫），适合「只求合规」；24→60 的 3:2 重复帧明显，要 60 就应走 120 母版。

### 3.2 运动插帧（解决「顺」）

| 实现 | 倍率 | 质量 | 成本 | 部署 |
|---|---|---|---|---|
| **ComfyUI 原生 + RIFE 4.25/4.22.lite** | 整数 2–16 | 中高（官方专门为扩散生成视频调过 4.22.lite/4.24+） | 低（单帧对毫秒级；**未实测**，不写秒数） | 只需放 21.6MB 权重（RIFE 4.25） |
| ComfyUI 原生 + FILM | 整数 2–16 | 大位移更好、慢 | 高 | 同上 |
| 自定义包 GMFSS / GIMM-VFI / IFRNet | 整数 | 动漫（GMFSS）/遮挡（GIMM）更好 | 中高（cupy/显存） | 装自定义节点，风险高 |
| `ffmpeg minterpolate` | 任意比 | 中低 | CPU 极慢 | 零权重 |

**结论**：本期只考虑 **原生节点 + RIFE**（部署最轻、速度最好、官方背书）；FILM 作为 quality 档候选；自定义包不引入。

### 3.3 生成侧「直接出 30/60」：不可行

H3 的 24fps 是模型时域采样率；`length` 只是帧数。把 `CreateVideo.fps` 改成 30 会让 5s 镜变成 4s（25% 加速），不是「更多帧」。**排除**。

### 3.4 不补，直接交 24fps

- 抖音/快手/视频号**未见公开 fps 规范**（`research/fps-interp/landscape.md:132-135`）；24fps 在移动端可接受是**经验判断**（120Hz 屏整除、60Hz 屏 3:2），不是平台官方口径。
- 如果渠道实际不卡 30fps，**这是成本最低、画质风险最小的选项**；应优先确认平台审核口径，而不是先写补帧代码。

---

## 4. 推荐架构：两个原语，分开落地

### 4.1 交付层：`video_conform_fps`（时基转换，确定性操作）

- 定位：**delivery 层的确定性操作**，与 `video_concat` 同级（不进模型注册表）——它没有模型、没有档位、只依赖 ffmpeg。
- 签名：`video_conform_fps({ video_node | nodes[], target_fps: 24|30|48|60, mode: 'dup'|'master120', title?, group?, nodeId? })`。
- `mode='dup'`：`ffmpeg -vf fps=<target> -c:a copy`；**明确标注「仅时基，不增信息」**。
- `mode='master120'`：要求上游已是 120fps 母版，抽帧到目标；工具只做抽取与封装，不负责生成母版。
- 记录：产物 `params.fps/width/height/length` + `conformFrom/conformMode`；**音频 `-c:a copy`，时长不变**。
- 无 ffmpeg ⇒ **提交前 fail-closed**，文案给出安装路径（`brew install ffmpeg`）或「改用 24fps 交付」。
- 顺带解决混素材：把各镜统一到同一 target 后再 `video_concat`；并在 `runConcat` 增加 **fps 一致性守卫**（有值且不一致就报错，缺值降级告警）。

### 4.2 模型层：`video.interpolate`（注册表能力，逐镜、整数倍）

为什么进注册表而不是塞进 `video_conform_fps`：它有模型、有权重、有档位、有 GPU 失败模式，与超分同构；而时基转换没有。混在一起会让「无 ffmpeg 也能跑」和「无权重不能跑」两种失败模式缠在一起。

- 能力：`video.interpolate`；实现清单（manifest）声明：
  ```jsonc
  "interpolate": {
    "mode": "param",                 // 倍率由 runner 注入
    "multiplier": 2, "minMultiplier": 2, "maxMultiplier": 5,
    "outRule": "n-minus-1-times-m-plus-1",
    "chunking": "none",              // 逐镜通常 90–150 帧（现有画布也有 846 帧长片），先不做分块
    "audio": "passthrough"
  },
  "params": { "source_video": {…}, "multiplier": {…}, "out_fps": {…}, "prefix": {…} }
  ```
- **帧数口径**：模型输出 `(N−1)m+1`；为让时长严格守恒，**尾部补 `m−1` 个重复末帧**，使输出 = `N×m`，`out_fps = m × source_fps`。不补的话 `CreateVideo` 会把音频剪到画面长度（**实测**：m=2、124 帧时每镜少 20.8ms 音频），而且逐镜各剪一刀、成片总时长变短——不是「看起来差不多」的问题。
- **音频**：走 `CreateVideo(images, out_fps, audio=源音轨)`，不经模型、不重采样；产物必须验「音频时长 = 源时长」。
- **工具**：`video_interpolate({ video_node, multiplier | target_fps?, tier?, title?, group?, nodeId? })`；`target_fps` 只接受 `source_fps × 整数`，非整数倍**显式报错并列出可达帧率**（24 ⇒ 48/72/96/120），不静默降级。
- **落点**：只对**单个分镜**补帧，拼接前完成；**全片同一倍率**（补就全补），否则 concat 时基会坏。
- **倍率上限取 5**：这是产品约束（24→120 是 24/30/60 的公倍数，便于交付层派生）；2–4 是常规，5 只用于母版/慢动作，>5 的中间帧占比过高、画质断崖（RIFE 官方 4× HD 数据已见明显下滑）。
- **顺序**：**先超分 → 再补帧**。超分逐帧独立、补帧跨帧对；反过来会让每张合成帧独立超分，高频逐帧不一致、闪烁被放大（`research/fps-interp/integration.md:187-193`）。
- **记账**：产物 `params` 记 `fps=out_fps, sourceFps, multiplier, interpolateFrom, chainable:false`；**不记 `clipIndex`**（链式续接的 latent 在采样阶段，补帧在采样之后，不能续接）。
- **守卫**：`comfy_render` 的 capability 枚举来自 `CAPABILITIES`，会把 `video.upscale`/`video.interpolate` 这类后期能力漏进通用渲染入口（upscale 已有此暗坑）；应抽 `POSTPROCESS_CAPABILITIES` 在 `runRender` 入口显式拒绝并指路。

### 4.3 非整数倍（24→30/60）的 canonical 路径

```
24fps 源 ──FrameInterpolate(m=5)──> 120fps 母版 ──ffmpeg fps=60/30──> 交付
                                         └─ 或 m=2 → 48fps 直接交付（若要 48）
```
- 24→30 = 120÷4；24→60 = 120÷2；**只在交付层抽帧，不改时长**。
- 母版不交付（体积/兼容性），只作为中间产物；产物节点标 `internal: true` 或不进自动送达。
- 若只求「容器是 30/60」而不求顺：`mode='dup'` 即可，别用 120 母版浪费 GPU。

### 4.4 流程落点（三个 skill）

| skill | 落点 | 默认 |
|---|---|---|
| `story-short-generator` | STEP 0 规格卡加「交付帧率（24 原生 / 30 合规 / 48 顺）」；STEP 8「超分」之后加「可选：补帧」，顺序 **超分→补帧→concat** | 24 |
| `brand-promo-video-generator` | 与超分并列一节；LOGO/产品界面/包装镜头**不补帧**（文字/硬边风险） | 不补 |
| `short-drama-series-production` | 系列规格卡 `deliveryFps`，整季二选一（混倍率会炸 concat）；成本台账加一行 | 24 |

### 4.5 慢动作（本期不做，架构留位）

- 做法：生成 24fps → 插帧 ×4/×5 → `setpts` 拉伸 → 以 24fps 封装（4×/5× 慢放）。
- **音频必须单独决策**：H3 自带对白/音效，慢放会变低频拖音。可选「丢弃原音 + BGM/SFX」或 ffmpeg `atempo` 链（本机无 ffmpeg 时不可用）。
- 因此**不要**把慢动作塞进 `video.interpolate` 的默认语义（时长会变、音轨直通契约失效）；将来单列 `video.retime` 能力或工具参数 `playback_fps`。

---

## 5. 成本与交付体积（估算，均标未实测）

| 项 | 124 帧 5s 镜头（768×1344≈1.0MP） | 30s 成片（6×5s） |
|---|---|---|
| RIFE 补帧 ×2（48fps） | 约 7–15 s（按公开吞吐外推，未实测） | 约 1–1.5 min |
| RIFE 补帧 ×5（120fps 母版） | 约 18–35 s（同上，未实测） | 约 2–3.5 min |
| ffmpeg 时基 dup | <1 s | 数秒 |
| ffmpeg minterpolate（兜底） | 约 30–120 s（CPU，经验量级） | 数分钟–十几分钟 |
| 文件体积 | 24fps≈3.2MB → 48fps≈4.5–5.5MB | 48fps ≈27–33MB（**超 20MiB**） |

> 这些数字只用于量级判断；`research/fps-interp/comfy-probe.md` 已明确「权重未装、耗时未实测」，上线前必须用真机 `estSeconds` 校准（本仓纪律：没跑过不写 estSeconds）。

---

## 6. 验证与止损

### 6.1 先做「值不值得」的 A/B（不写产品代码）

- 选 3 类镜头各 1 条：**慢摇/运镜**、**人脸特写**、**快速动作**（再加 1 条**带画面内字幕**的）。
- 每条出 24fps 原片 + 48fps 补帧片，盲看：双影、脸/手、字幕、边缘拉丝、闪烁。
- 通过标准（建议）：无明显双影/鬼影；字幕可读；主观「更顺」≥2/3 人认可。
- 不通过 ⇒ 产品结论可以是「不做 48fps 默认」，而不是硬上。

### 6.2 数值验收（实现后）

| 指标 | 判据 |
|---|---|
| 帧数 | 输出 = `N×m`（精确，含尾部 pad） |
| 时长 | 与源差 = 0（不是「约等于」） |
| 音频 | 时长相同、逐样本相同（抽轨 md5） |
| fps | 容器 fps = `m×source_fps`；`concat` 各段一致 |
| 接缝（若将来分块） | 接缝局部帧差比 ∈[0.6,1.6] |
| 闪烁 | 平坦区闪烁比 ≤1.15 |
| tOF | 三帧一致性 ≤1.3 |

失败梯度：帧数不符 → 查 pad/trim；双影/闪烁 → 降 m 或换权重；音画不同步 → 查 `CreateVideo.fps`；体积超限 → 降 CRF / 只交付单镜 / 提示画布取文件（`params.deliveryError` 已有重试机制）。

---

## 7. 实施计划

| 阶段 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| **P0 合规层** | 装 ffmpeg（`brew install ffmpeg`）；新增 `video_conform_fps`（dup/master120 抽取）；`runConcat` 记 fps + 一致性守卫；`probeMp4` 增 `mdhd` 精确 fps；文档 | 无 GPU、无权重 | 0.5–1 天 |
| **P1 补帧能力** | 服务器放 `rife_v4.25.safetensors`（21.6MB，**需用户批准**）；`video.interpolate` capability + manifest + runner + 工具 + smoke；`POSTPROCESS_CAPABILITIES` 守卫 | P0 + 权重 | 2–4 天 |
| **P2 流程** | 三个 skill 的规格卡/步骤；A/B 素材；体积策略（CRF/代理文件） | P1 | 1–2 天 |
| **P3 后续** | 60/30 母版派生、慢动作、FILM/GMFSS 质量档、分块（若上整片） | 视需求 | — |

关键前置（需要用户点头的两件事）：
1. **服务器放权重**：`sudo cp rife_v4.25.safetensors /data/comfyui/storage-models/models/frame_interpolation/`（容器内即 `/root/ComfyUI/models/frame_interpolation/`；可回滚，21.6MB；服务器走 hf-mirror 下载）。
2. **本机装 ffmpeg**（30/60 交付与慢动作的前提；当前无）。

---

## 8. 待拍板

| # | 决策 | 选项 |
|---|---|---|
| **D1** | 渠道是否真的强制 30/60fps？ | 24 可接受 ⇒ 先不补；必须 30/60 ⇒ P0 时基转换 |
| **D2** | 48fps 是否值得做 | 先 A/B 3–4 条镜头再定；通过才建 `video.interpolate` |
| **D3** | 是否允许放 RIFE 权重（21.6MB）/ 装 ffmpeg | 权重只在做 P1 时需要；ffmpeg 在 P0 就需要 |
| **D4** | 慢动作是否进本期 | 建议不进；进了要先定音频策略（丢原音 or atempo） |
| **D5** | 交付体积策略 | 48fps 成片超 20MiB 时：降 CRF / 只发单镜 / 发 24fps 代理 + 画布取全质量 |

---

## 9. 与既有文档/代码的关系

- 能力契约与分块/校验细节：`research/fps-interp/integration.md`（含 15 项 PR 清单与 file:line）。
- VFI 模型与平台口径：`research/fps-interp/landscape.md`（15 个一手来源，证据分级）。
- ComfyUI 侧事实与「跑通最少要做什么」：`research/fps-interp/comfy-probe.md`。
- 超分先例：`docs/video-upscale.md`；拼接：`lib/concat.js`；生成 fps：`lib/index.js:94`。
