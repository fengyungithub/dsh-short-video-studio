# 24fps AI 短片补帧到 30/48/60fps + 慢动作：外部技术依据

> 调研对象：本插件（dsh-short-video-studio）用 MiniMax H3 生成的原生 24fps / 带声音 / 画面内原生字幕短片。
> 目标：给出「补帧、改时基、慢动作」的可落地选项与依据，供后续新增 `video.interpolate` 类能力时选型。
> 调研时间：2026-10。**证据分级**：`【数据】`=论文/仓库/官方文档里可查的数字；`【文档】`=官方文档陈述（部分站点本次抓取被拒，见文末「抓取状态」）；`【源码】`=本次直接读到的实现代码；`【经验】`=工程推断/实操经验，非权威出处。

## 0. 结论速览（先看这个）

1. **不要在 ComfyUI 里做「24→60」**：原生插帧节点只接受**整数倍** multiplier（2–16），24→60 是 2.5×，做不了；正确路径是 **24→120（5×）再按整数比丢帧到 60/30**（120 是 24/30/60 的公倍数）。`【源码】`
2. **硬切必须切段再补帧**：ffmpeg `minterpolate` 自带场景检测会退化为复制帧，模型插帧没有场景检测、会把两个镜头混成鬼影。`【源码】`+`【经验】`
3. **画面内字幕与插帧天然冲突**：文字是高频低纹理区，插帧会拉丝/重影。结论：**先把 H3 的画面内字幕关掉，补帧完成后再把字幕烧回去**。`【经验】`
4. **慢动作是补帧唯一「高收益」场景**（24→96/120 → 24fps 播放），fps 转换（24→30/60）对短剧内容收益有限，多数平台 24fps 可接受。`【经验】`
5. **本机无 ffmpeg**（`which ffmpeg` → not found，2026-10 实测）：纯 ffmpeg 方案需先装；ComfyUI 原生节点只能替代「插帧」这一步，丢帧/封装/音轨仍需 ffmpeg 或 VHS 节点。`【源码】`/`【经验】`

## 1. VFI 模型对比（2022–2025，本地可跑）

### 1.1 公共 benchmark（同一评测口径，可直接横向比）

出处：VFIMamba (NeurIPS 2024) Table 2，PSNR/SSIM，**FLOPs 按 720p 计，Runtime 为 1024×1024 单帧插值、2080Ti**：<https://arxiv.org/abs/2407.02315>

| 模型 | Vimeo90K | UCF101 | SNU-FILM easy/med/hard/extreme | FLOPs(T)@720p | Runtime(ms)@1024² |
|---|---|---|---|---|---|
| RIFE (ECCV22) | 35.61/0.9779 | 35.28/0.9690 | 39.80/35.76/30.36/25.27 | 0.20 | **35.2** |
| IFRNet-L (CVPR22) | 36.20/0.9808 | 35.42/0.9698 | 40.10/36.12/30.63/25.26 | 0.79 | 115.3 |
| EMA-VFI-S (CVPR23) | 36.07/0.9797 | 35.34/0.9696 | 39.81/35.88/30.69/25.47 | 0.20 | 76.4 |
| EMA-VFI | 36.64/0.9819 | 35.48/0.9701 | 39.98/36.09/30.94/25.69 | 0.91 | 239.6 |
| AMT-G (CVPR23) | 36.53/0.9817 | 35.41/0.9699 | 39.88/36.12/30.78/25.43 | 2.07 | 403.7 |
| SGM-VFI (2024) | 35.81/0.9793 | 35.34/0.9693 | 40.14/36.06/30.81/25.59 | 1.78 | 942.9 |
| VFIMamba-S | 36.09/0.9800 | 35.36/0.9696 | 40.21/36.17/30.80/25.59 | 0.24 | 128.0 |
| **VFIMamba** | **36.64/0.9819** | 35.45/0.9702 | **40.51/36.40/30.99/25.79** | 0.94 | 310.9 |

补充：VFIMamba 摘要称 X-TEST 上比前 SOTA **+0.80dB(4K) / +0.96dB(2K)**；即分辨率越高、位移越大，Mamba/全局感受野类模型的优势越明显。`【数据】`
RIFE 自报（自家评测脚本）：Vimeo90K 35.615/0.9779、UCF101 35.282/0.9688、HD 32.14；**RIFE_m 的 4× 插值 HD 结果只有 22.96(544×1280)/31.87(720p)/34.25(1080p)**——间隔越大、倍率越高，PSNR 下滑越明显（这是「倍率别超过 4–5×」的主要依据，注意它不是 4× 与 2×2 的严格同口径对照）。出处：<https://github.com/megvii-research/ECCV2022-RIFE> `【数据】`+`【经验】`

SepConv（2017/2021，核方法）：Vimeo90K 33.79/0.9702、UCF101 34.78/0.9669、Xiph 2K 34.77/0.929、4K 32.06/0.880、Middlebury IE 2.27、SNU-FILM 39.41/34.97/29.36/24.31 —— 全面落后且算力高。出处：EMA-VFI Table 1 <https://arxiv.org/abs/2303.00440> `【数据】`

### 1.2 逐模型要点（能否在 ComfyUI 跑、什么场景选它）

- **RIFE 4.x / 4.22 / 4.25**：CNN 光流+IFNet，速度标杆。官方 "30+ FPS for 2X 720p on 2080Ti"；Practical-RIFE 模型列表 4.20→4.26，**默认推荐 4.25**，另有 `4.22.lite`（低算力）。**关键：官方 2024.08 明确写到「4.22.lite / 4.24+ 适合做扩散模型生成视频的后处理」**——这是生成式视频补帧最强的一手依据。出处：<https://github.com/hzwer/Practical-RIFE>、<https://github.com/megvii-research/ECCV2022-RIFE> `【数据】`
- **FILM（ECCV22, Google）**：官方实现是 **TensorFlow 2**（ComfyUI 用的是 PyTorch 社区移植 `dajes/frame-interpolation-pytorch`）；主打大位移/近重复图对；高分辨率必须靠 `--block_height/--block_width` **分块跑再拼**；帧数公式 `(2^times_to_interpolate+1)*(N-1)` ⇒ **只能 2 的幂次**。出处：<https://github.com/google-research/frame-interpolation> `【数据】`/`【文档】`
- **GMFSS Fortuna**：动漫专用（GAN 训练），无标准 benchmark 数字；依赖 `cupy-cuda11x/12x`，有 `union` 模式。出处：<https://github.com/98mxr/GMFSS_Fortuna> `【文档】`
- **GIMM-VFI（NeurIPS24）**：隐式运动建模，主打任意时间步 + 高分辨率。官方给出显存：**V100 上 2K 8× 用 DS_SCALE=0.5 → 7932MiB；4K 8× 用 0.25 → 10922MiB**。有感知增强版 `-P`（加 LPIPS 损失）。ComfyUI 节点由 kijai 提供，需 `cupy-cuda12==13.3.0`。出处：<https://github.com/GSeanCDAT/GIMM-VFI>、<https://github.com/kijai/ComfyUI-GIMM-VFI> `【数据】`
- **EMA-VFI（CVPR23）**：局部窗口注意力，`EMA-VFI-S` 76.4ms 与 RIFE 同级速度但 PSNR 更高，是「RIFE 之上、可接受的成本」的折中。`【数据】`
- **IFRNet（CVPR22）**：中间特征精修，IFRNet-L 质量接近 EMA-VFI，115.3ms。ComfyUI 自定义包有节点。`【数据】`
- **VFIMamba（NeurIPS24）**：Mamba/SSM，全局感受野 + 线性复杂度，**高分辨率/大运动最佳**，但 310.9ms 且需 `mamba_ssm`/`causal_conv1d` 编译环境（CUDA 11.7 + torch 1.13 的旧栈），当前无成熟 ComfyUI 节点。`【数据】`+`【文档】`
- **SepConv**：只作为「老基线」存在，质量/速度双输，不建议新项目采用。`【数据】`

### 1.3 720p / 1080p 吞吐与显存（把论文数字换算成本机预算）

- 上面 Runtime 是 **1024×1024（1.05MP）**。按 FLOPs 线性外推：**1080p（2.07MP）≈ 2×**，即 RIFE 单张中间帧 ≈70ms、EMA-VFI-S ≈150ms、VFIMamba ≈620ms。`【经验】（由【数据】外推）`
- 一条 5s 镜头（124 帧）做 24→120（5×）= 496 张中间帧：RIFE ≈35s/镜，EMA-VFI-S ≈75s/镜，VFIMamba ≈5min/镜（单卡 2080Ti 级）。`【经验】`
- 显存：RIFE/EMA-VFI/IFRNet 在 1080p 单帧插值按 FLOPs(0.2–0.9T) 判断属 **4GB 以内** 量级 `【经验】`；GIMM-VFI 有官方口径：V100 上 2K 8× 约 **8GB**、4K 8× 约 **11GB** `【数据】`；VFIMamba 需按 `scale` 降采样估光流（2K 用 0.5、4K 用 0.25，官方建议）`【文档】`。
- **ComfyUI 原生节点怕的不是显存而是内存**：结果张量分配在 `intermediate_device()`（CPU 侧），1080p fp16 每帧 ≈12.4MB，124 帧 ≈1.5GB，5× 后 620 帧 ≈7.7GB —— **必须按镜头分块，不要整片一次插**。`【源码】`+`【经验】`

## 2. 生成式视频特有的补帧风险（按危害排序）

| 风险 | 机制 | 依据 | 处置 |
|---|---|---|---|
| **纹理沸腾/逐帧闪烁被放大** | H3 相邻帧本就有细微重采样差异；VFI 把「闪烁」误判成运动 → 生成来回拉扯的中间帧，60fps 下反而更明显 | RIFE 官方专门为「扩散生成视频」调过 4.22.lite/4.24+ `【数据】`；机制为 `【经验】` | 优先 4.22.lite/4.25；先做时域降噪（轻微 `hqdn3d`/`nlmeans`）再插帧；不合格镜头宁可不补 |
| **遮挡/大幅运动 warping** | 双向光流在遮挡区无对应点，线性假设失效 → 物体边缘「粘滞」「拉丝」 | GIMM-VFI 论文明确指出线性组合流在遮挡区产生 object shift `【数据】`；VFIMamba 指出 RIFE/EMA-VFI 感受野有限、高分辨率大位移退化 `【数据】` | 大运动/高分辨率镜头换 VFIMamba 或 GIMM-VFI；或将 `--scale 0.5` 降分辨率估流 |
| **人脸/手部** | 低纹理 + 高频细节 + 自遮挡，最易「糊成一团」或「多指」 | `【经验】`（业界通例，无单一权威数字） | 特写镜头降到 2×（48/96）；人脸占比大的镜头不要 5×；必要时逐帧人工挑帧 |
| **烘焙字幕与画面文字** | 文字是硬边高频；插帧把它当刚体运动 → 边缘抖/重影/半透明叠字 | ffmpeg 场景检测之外的模型侧无文字保护 `【经验】` | **最稳做法：生成阶段关掉 H3 画面内字幕 → 补帧/慢动作 → 后期烧字**（ASS/drawtext 在最终帧率上渲染） |
| **硬切跨界** | 模型 VFI 不知道有剪切点，会在 A/B 之间生成「混合帧」 | `minterpolate` 有 `scd=fdiff`（阈值 10）会退化成复制帧 `【源码】`；模型侧无此机制 `【经验】` | 按镜头切段（本插件本来就是逐镜生成，天然分段）；拼接后再补帧是错的 |
| **运动模糊缺失 → 塑料感/肥皂剧效应** | AI 生成帧通常每帧都「锐」，补到 60fps 后运动过于清晰 | 这是 HFR 的普遍观感问题 `【经验】` | 短剧内容建议**不要**为「更顺」而补 60；确需 60 时加轻微方向模糊或降清晰度 |

## 3. 24→30/48/60 的时基方案

### 3.1 数学前提（先算清楚再选工具）

- 24→48 = **2× 整数**；24→30 = **1.25×**；24→60 = **2.5×**。非整数倍是主要麻烦来源。
- `minterpolate` 的插值位置由**输出 PTS 反算 alpha**，因此原生支持任意比（24→30 没问题，只是每帧 alpha 不同）。`【源码】`
- ComfyUI 原生节点 `multiplier` 是整数 2–16，输出 `(N-1)*multiplier+1` 帧 ⇒ **只能整数倍**。`【源码】`

### 3.2 五种做法对比

| 做法 | 24→30 | 24→60 | 画质 | 成本 | 适用 |
|---|---|---|---|---|---|
| 帧复制/丢帧（`fps` 滤镜） | 5:4 复制节奏，有轻微顿挫 | **3:2 pulldown**（A A A B B…），明显 judder | 无新增伪影 | ~0 | 只求容器兼容；字幕/文字密集素材 |
| 帧混合（`mi_mode=blend`/`tmix`） | 可行 | 可行 | 全屏重影，**不推荐** | 低 | 仅纯渐变/慢摇镜头 |
| `minterpolate`（`mci` + `aobmc`） | 支持任意比 | 支持任意比 | 中等，块状/边缘拉丝；文字区易崩 | CPU 极慢（1080p 可达数十倍实时） | 无 GPU 时的兜底；短视频、低分辨率 |
| 模型插帧（RIFE 等） | 需经 120 中转或自写非均匀时间步 | 需经 120 中转 | **最好**（尤其 4.22.lite/4.25） | GPU | 主力方案 |
| **插到 120 再整数丢帧** | 120→30（÷4） | 120→60（÷2） | 同模型质量 | GPU + 一次 ffmpeg | **推荐**：一次母版，多平台派生 |

**为什么「插到 120 再丢」不是浪费**：24→60 无论怎么做，5 个输出帧里只有 2 个落在原始帧上、3 个是合成帧，采样相位以 5 帧为周期循环（0.0/0.4/0.8/0.2/0.6）。先到 120 再 2:1 抽取，等价于直接按 2.5× 插值，但**只需要模型支持 5× 整数倍**，把非整数比问题彻底甩给 ffmpeg。`【经验】`（相位推导）

### 3.3 ffmpeg 具体做法

```bash
# A. 只改容器时基（不补帧）：24→30 复制/丢帧；音频原样
ffmpeg -i in.mp4 -vf "fps=30" -c:v libx264 -crf 18 -c:a copy out_30.mp4

# B. CPU 运动插值兜底：24→60（mci + 自适应 OBMC + 双边估计 + 场景检测）
ffmpeg -i in.mp4 -vf "minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bilat:mb_size=16:search_param=32:vsbmc=1:scd=fdiff:scd_threshold=10" \
  -c:v libx264 -crf 18 -c:a copy out_60.mp4

# C. 120fps 母版 → 派发 60 / 30（本方案核心）
ffmpeg -i master_120.mp4 -vf "fps=60" -c:v libx264 -crf 18 -c:a copy out_60.mp4
ffmpeg -i master_120.mp4 -vf "fps=30" -c:v libx264 -crf 18 -c:a copy out_30.mp4

# D. 慢动作：120fps 母版把时间轴拉伸 5×，再按 24fps 封装 ≈ 20% 速度播放
ffmpeg -i master_120.mp4 -vf "setpts=5*PTS" -r 24 -c:v libx264 -crf 18 \
  -af "atempo=0.5,atempo=0.5" -c:a aac out_slomo5x.mp4
```

> **常见错误**：只写 `-r 24` 不会慢放——那是把 120fps **丢帧到** 24fps（正常速度、还掉帧）。慢放必须用 `setpts=5*PTS`（4× 慢放则 `setpts=4*PTS -r 24`）先拉长时间轴。`【经验】`

- `minterpolate` 选项与默认值（本次直接读源码核实）：`fps` 默认 60；`mi_mode` = dup/blend/**mci(默认)**；`mc_mode` = obmc/**aobmc**；`me_mode` = bidir/**bilat(默认)**；`me` 默认 epzs；`mb_size` 默认 16；`search_param` 默认 32；`vsbmc` 默认 0；`scd` 默认 `fdiff`、`scd_threshold` 默认 10。源码：<https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/vf_minterpolate.c> `【源码】`
- **场景检测的真相**：`detect_scene_change()` 命中后 `interpolate()` 直接 `av_frame_copy`（复制而非插值），所以 `minterpolate` 对硬切是「安全但不平滑」；模型插帧没有这层保护。`【源码】`
- `fps` 滤镜语义是「按需复制/丢弃帧得到恒定帧率」；`framerate` 是运动插值一族（与 minterpolate 同参数体系）。文档：<https://ffmpeg.org/ffmpeg-filters.html#fps>、<https://ffmpeg.org/ffmpeg-filters.html#minterpolate> `【文档】`（本次该页抓取超时，按公开文档描述，未逐字复核 `framerate` 的别名关系）
- 3:2 pulldown / telecine 的标准做法见 `telecine` 滤镜文档：<https://ffmpeg.org/ffmpeg-filters.html#telecine> `【文档】`

### 3.4 音频与音画同步

- **改帧率（时长不变）**：视频帧数变、时长不变，音轨 `-c:a copy` 即可，**不会失步**。这是 24→30/60 的默认安全路线。`【经验】`
- **慢动作（时长变）**：视频变长 N 倍后音频必须一起处理，否则 `-shortest` 会截断、不截断则全程错位：
  - 保音高变速：`atempo`（单次范围 0.5–100，**0.25× 需链式 `atempo=0.5,atempo=0.5`**）。`【文档】`
  - 变调慢放（磁带效果）：`asetrate=48000*0.25,aresample=48000`。`【经验】`
  - 最省事：**慢动作镜头丢弃原音，改配 BGM/音效**（H3 的台词在 5× 慢放下本来也不可用）。`【经验】`
- **H3 特有问题**：视频自带对白/音效，慢放会使台词变成低频拖音；因此慢动作应尽量选**无台词镜头**，或先 `extract_audio` 留存原声另做处理。

### 3.5 慢动作的正确做法（推荐流程）

1. 生成端就按慢动作设计（prompt 写慢速动作），24fps 原生。
2. 目标倍率 = 4× → 插到 96（multiplier=4）；5× → 插到 120（multiplier=5）。**不要超过 5×**：4× 以上中间帧占比过高，PSNR/观感断崖（RIFE_m 4× HD 仅 31.87/34.25 即为例证）。`【数据】`
3. `setpts=4*PTS / 5*PTS` 拉伸时间轴、再以 24fps 封装 ⇒ 4×/5× 慢放；音频按 3.4 处理或替换。
4. 慢动作镜头**逐帧自检**：拉丝、手部、脸部重点看；不合格就降倍率重做，而不是加更多倍率。

## 4. 平台交付口径

| 平台 | fps 相关口径 | 分辨率/画幅主推 | 依据 |
|---|---|---|---|
| YouTube | 官方「推荐上传编码设置」按源帧率上传，列举 24/25/30/48/50/60 fps；60fps 有独立码率档（1080p60 明显高于 1080p30） | 16:9 任意，最高按源 | <https://support.google.com/youtube/answer/1722171> `【文档】`（本次抓取被拒，按公开文档描述） |
| 抖音 | **未检索到官方 fps 规范**；开放平台上传文档给的是格式/大小/时长约束 | 9:16，1080×1920 | <https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/upload-video>（正文 JS 渲染，本次只取到空壳）`【经验】` |
| 快手 | 同上，未见公开 fps 上限 | 9:16，1080×1920 | 无可用一手页 `【经验】` |
| 视频号 | 同上，未见公开 fps 上限；社区经验 ≤60fps 可正常上传 | 9:16，1080×1920 | 无可用一手页 `【经验】` |

- **24fps 可接受吗？** 可以。移动端播放器按屏幕刷新率做节奏映射：**120Hz 屏（ProMotion）24fps 天然整除、很顺；60Hz 屏做 3:2 拉帧、有轻微 judder**。平台转码一般保留源帧率，不会替你插帧。`【经验】`
- **60fps 值不值得？** 对短剧/口播/静态构图内容：**不值得**（体积 +40~70%，观感提升接近 0，还可能暴露 AI 逐帧闪烁）。对**慢动作、运动镜头、屏幕录制/UI 演示**：值得。`【经验】`
- **码率/体积增长**：同 CRF 下 fps 翻倍，码率约 **+40%~70%**（不是 2×，因为帧间冗余增加）；YouTube 官方建议码率表里 1080p60 约为 1080p30 的 1.5 倍。`【经验】`+`【文档】`
- **交付建议**：一次 24→120 母版 → 抖音/视频号出 30fps（体积友好）、YouTube 出 60fps（顺滑）、慢动作单独出 24fps 慢放版。

## 5. ComfyUI 现状

### 5.1 原生节点（官方，`comfy_extras/nodes_frame_interpolation.py`）

- 两个节点：`FrameInterpolationModelLoader`（`model/loaders`，输出 `INTERP_MODEL`）+ `FrameInterpolate`（显示名 **Run Frame Interpolation Model**，`video` 分类，搜索别名 rife/film/slow motion）。`【源码】`
- 模型目录：`ComfyUI/models/frame_interpolation/`；**只认 FILM 与 RIFE(IFNet)** 两种格式，其余报 `Unrecognized frame interpolation model format`；RIFE 权重会做 `block{i}` → `blocks.{i}` 与 `module.`/`flownet.` 前缀重映射，并丢弃 `teacher.`/`caltime.` 前缀 —— 因此**4.2x/4.25 这类同结构权重通常可直接加载**。`【源码】`
- `multiplier`：整数 **2–16**，默认 2；`t_values = [1/m, 2/m, …, (m-1)/m]`；输入帧 <2 或 m<2 时**原样返回不报错**（静默失败，需注意）。`【源码】`
- 输出帧数 `(N-1)*multiplier+1`；支持 fp16 自动、OOM 时 batch 减半重试、跨帧对特征复用、模型有 `forward_multi_timestep` 时「一次提特征、多时间步出帧」（所以 5× 远快于 4 次独立前向）。`【源码】`
- 官方文档（多语言内嵌，本仓库 `embedded-docs`）：<https://docs.comfy.org/built-in-nodes/FrameInterpolate>（本次直连失败，等价内容见 <https://github.com/Comfy-Org/embedded-docs/blob/main/comfyui_embedded_docs/docs/FrameInterpolate/ko.md>）；原生支持由 PR **CORE-29 / #13258（RIFE + FILM）** 引入：<https://github.com/Comfy-Org/ComfyUI/pull/13258> `【文档】`
- **对本插件的直接含义**：能做的只有 2×/4×/5×/8× 等整数倍。24→30、24→60 必须走「先 120 母版再丢帧」，或改用 ffmpeg。

### 5.2 自定义包 `ComfyUI-Frame-Interpolation`

- 节点覆盖：RIFE VFI (4.0–4.9)、FILM VFI、**GMFSS Fortuna VFI**、IFRNet VFI、IFUnet VFI、M2M VFI、AMT VFI、Sepconv VFI、STMFNet/FLAVR（需 ≥4 帧、仅 2×）、ATM-VFI / MoMo（仅 2×）。<https://github.com/Fannovel16/ComfyUI-Frame-Interpolation> `【文档】`
- **CUDA 依赖是主要坑**：靠 `cupy` 做 warping，装错版本直接 import 失败（`install.py` / Windows 用 `install.bat`；`cupy-cuda11x` 与 `cupy-cuda12x` 不可共存）；非 NVIDIA 可切 `taichi` 后端（`config.yaml` 里 `ops_backend: taichi`），但部分节点不支持。`【文档】`
- `clear_cache_after_n_frames` 是 OOM 旋钮（越小越省显存、越慢）。`【文档】`
- 注意：该包 RIFE 节点标注 **4.0–4.9**，未见 4.2x/4.25 选项；要在自定义包里用 4.25 需按 4.9 入口塞权重（不一定被识别），**原生节点反而是更省事的 4.2x 通道**。`【经验】`
- GIMM-VFI 走独立仓库 <https://github.com/kijai/ComfyUI-GIMM-VFI>（`cupy-cuda12==13.3.0`）；**VFIMamba 目前无成熟 ComfyUI 节点**。`【文档】`

## 6. 选型矩阵

| 方案 | 质量（同场景/大运动/文字） | 速度 | 部署成本 | 风险 | 适用场景 |
|---|---|---|---|---|---|
| RIFE 4.22.lite / 4.25（原生节点） | 中高 / 中 / 差 | **极快**（1080p ≈70ms/帧） | 极低（官方节点，放权重即用） | 文字区拉丝；大运动边缘 | **主力默认**：24→48/96/120 |
| FILM（原生节点，PyTorch 移植） | 高 / 高 / 中 | 慢（大位移更好但更贵） | 低（原生节点已支持） | TF2 原生实现高分块慢；移植版行为有差异 | 大位移、近重复帧、单镜头特写 |
| GMFSS Fortuna | 中高（**二次元最佳**）/ 中 / 差 | 中 | 中（cupy） | 真人素材泛化一般 | 动漫/2D 风格短片 |
| GIMM-VFI（-P） | **高**（遮挡最好）/ 高 / 中 | 慢 | 高（cupy + 8–11GB 显存） | 显存/环境；需降采样 | 2K 级高质量镜头、慢动作特写 |
| EMA-VFI-S | 高 / 中高 / 中 | 较快（150ms） | 中（自定义包） | 节点生态较弱 | RIFE 之上的性价比升级 |
| VFIMamba | **最高**（高分辨率尤佳）/ 高 / 中 | 很慢（≈620ms） | 很高（mamba 编译栈） | 无 ComfyUI 节点、环境脆弱 | 离线精修、4K/大运动 |
| SepConv / IFRNet | 低—中 / 低 / 差 | IFRNet 中，SepConv 慢 | 低 | 已被超越 | 不建议新项目 |
| ffmpeg `minterpolate` | 中 / 低 / 很差 | CPU 极慢 | **零**（装 ffmpeg 即可） | 块状伪影、文字崩 | 无 GPU 兜底、批量低价值素材 |
| ffmpeg 帧复制/丢帧 | 无伪影但 judder | 极快 | 零 | 3:2 顿挫 | 仅容器兼容；字幕后置后使用 |

## 7. 三个推荐组合

**组合 A｜生产默认（推荐先落这个）**
RIFE 4.22.lite 或 4.25（ComfyUI 原生节点，fp16，`multiplier=5`）→ 24→120 母版 → ffmpeg `fps=60 / fps=30` 派生；**生成阶段关闭 H3 画面内字幕**，补帧后烧字；按镜头分块处理（5s 镜 ≈35s GPU）。
覆盖：抖音/视频号 30fps、YouTube 60fps、48fps 归档（`fps=48`）。成本最低、风险最小。

**组合 B｜质量优先（慢动作/特写）**
对含人脸特写、大位移的镜头切到 GIMM-VFI-R-P（2K 级 `DS_SCALE=0.5`，约 8GB 显存）或 VFIMamba（离线、4K）；倍率**不超过 4×**，24→96 后以 24fps 封装做 4× 慢放；音频丢弃或 `atempo=0.5,atempo=0.5` 保音高变速。
覆盖：慢动作重头戏、预告片高光镜头。

**组合 C｜零 GPU / 应急**
ffmpeg 内置：纯时基用 `fps=30`（复制帧），需真补帧用 `minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bilat:vsbmc=1`；务必**逐镜切段**输入（绕开模型侧无场景检测的问题），文字密集镜头直接不补帧。
覆盖：CI/无显卡机器、批量返工；本机当前无 ffmpeg，需先装。

## 8. 抓取状态与未决问题

- **抓取被拒/超时**：`support.google.com`（YouTube 编码设置）、`docs.comfy.org`（FrameInterpolate 官方页）、`ffmpeg.org/ffmpeg-filters.html`（单页 ~1MB）、`developer.open-douyin.com`（正文 JS 渲染）、`web.archive.org`。这些条目按公开文档/源码描述，标注为 `【文档】`，**引用前建议二次核对**。
- **已一手核实**：RIFE/Practical-RIFE README、FILM README、GMFSS_Fortuna README、GIMM-VFI README + 论文、VFIMamba README + 论文（含完整 Table 2）、EMA-VFI 论文 Table 1、ComfyUI `nodes_frame_interpolation.py` 源码与 `embedded-docs`、`vf_minterpolate.c` 源码、ComfyUI-Frame-Interpolation / ComfyUI-GIMM-VFI README。
- **仍未解决**：① 24→30 是否值得（缺平台侧实测数据，需 A/B：30fps vs 24fps 在抖音/视频号的完播率差异）；② VFIMamba 在 1080p 的实际显存（论文只给 X-TEST 质量，未给 1080p 显存）；③ 原生节点加载 4.25 权重的实测成功率（结构推断可行，未实机验证）。
- **本插件的能力缺口**：注册表当前没有「视频插帧」能力（只有 `video.upscale`/`video.image2video` 等），要落地需新增 `video.interpolate`（capability + tier）或把 ffmpeg 后处理纳入交付链；无论哪条，`multiplier` 语义都应暴露为「整数倍」并把 24→60 的 2.5× 折算交给调用方/ffmpeg。
