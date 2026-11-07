# 视频补帧（`video.interpolate`）

> 输入是**画布上已存在的视频**，输出是**同一时长、更高帧率**的同尺寸视频。
> 与 `video.upscale` 同构：无提示词、无采样器、音轨直通；差异只有两点——
> **帧数算术**（×整数倍 + D2 补齐）和**产物 fps 变了**（拼接前必须统一）。
> 背景与外部资料见 [`fps-interpolation.md`](fps-interpolation.md) 与 [`research/fps-interp/`](research/fps-interp/)。

---

## 0. 一句话契约

| | |
|---|---|
| 能力 | `video.interpolate` |
| 工具 | `video_interpolate(video_node, target_fps?, multiplier?, tier?)` |
| 实现 | `video-interpolate-rife`（ComfyUI 原生 `FrameInterpolate` + RIFE 4.25，`tier=quality`，唯一一档） |
| 帧数 | 产物 = **源帧数 × m**（含 D2 尾部补齐）；时长 = 源时长，误差 0 |
| 帧率 | `target_fps` = 源 fps × m（纯模型），或 源 fps × m ÷ 整数（模型 + ffmpeg 抽取） |
| 音轨 | 直通（不经过模型），时长跟画面；补齐后与源一致 |
| 分辨率 | 不变（补帧只改时间轴） |
| 只做 | **逐镜补**；成片不补（硬切处会生成两场之间的形变帧） |

---

## 1. 为什么不是「把 fps 改成 60」就完事

`CreateVideo.fps` 只是容器标签：24 帧输入标成 60fps → 仍是 24 帧、时长 0.4s（2.5× 快放），
不会让模型多生成时间信息。真补帧必须**先由 VFI 生成中间帧**。实测（2026-10-26）：

| 路径 | 结果 |
|---|---|
| `CreateVideo(fps=60)`，124 帧不变 | 5.167s → 2.067s，**快放**，不是真补帧 |
| 生成 311 帧再标 60fps（fast 档 ≈82s） | 容器 59.99fps，但内容是 24fps 时域采样 ⇒ 同样快放 |
| **VFI ×2（RIFE）** | 247 帧 / 5.146s，容器 48.00fps，**真补帧** |

---

## 2. 帧数算术（D2：为什么必须补齐）

ComfyUI `FrameInterpolate` 的输出帧数是 `(N−1)×m + 1`（保留首尾真帧、不补尾）。
直接用它，每镜会比源**短 `(m−1)/(m·f)` 秒**：

| 源 | 倍率 | 模型输出 | 源时长 | 模型输出时长 | 缺口 |
|---|---|---|---|---|---|
| 124 帧 @24fps | ×2 | 247 | 5.167s | 5.146s | 20.8ms |
| 124 帧 @24fps | ×5 | 616 | 5.167s | 5.133s | 33.3ms |

逐镜拼接时这点缺口会**累积**（每镜短一点，音画逐镜错位）。
所以 runner 在 ComfyUI 图里补 `m−1` 帧（尾部重复末帧，`1/(m·f)` 秒，肉眼不可见）：

```
FrameInterpolate → [4]                         (N−1)m+1 帧
ImageFromBatch(last)  → [5]                    取最后一帧
RepeatImageBatch(m−1) → [6]                    复制 m−1 份
ImageBatch([4], [6])  → [7]                    N×m 帧
CreateVideo(fps = 源fps × m, audio 直通) → SaveVideo
```

于是：母版帧数 = `N×m`，时长 = `N/源fps`（严格等于源），音频不再被裁。

---

## 3. 目标帧率的可达性

模型只支持**整数倍 2–16**（`interpolate.minMultiplier/maxMultiplier`）。
目标帧率 `T` 的选取规则（`planInterpolate`，纯函数）：

1. 若 `T` 能被某整数倍 `m` 整除：`T = src × m / stage`（`stage` 为抽取步长）。
2. 否则报错，并列出可达母版帧率。

| 源 | 目标 | m | 母版 | stage | 说明 |
|---|---|---|---|---|---|
| 24 | 48 | 2 | 48 | 1 | 纯模型 |
| 24 | 72 | 3 | 72 | 1 | 纯模型 |
| 24 | 96 | 4 | 96 | 1 | 纯模型 |
| 24 | 60 | 5 | 120 | 2 | 模型 + ffmpeg 每 2 帧取 1 |
| 24 | 30 | 5 | 120 | 4 | 模型 + ffmpeg 每 4 帧取 1 |
| 24 | 50 | — | — | — | 不可达（报错） |

**非整数倍目标需要本机 ffmpeg**（抽取这一步没有 ComfyUI 兜底）：
`ffmpeg -i 母版.mp4 -vf fps=60 -c:v libx264 -c:a copy out.mp4`。
ffmpeg 解析顺序：`DSH_SVS_FFMPEG` → 配置 `ffmpegPath` → **PATH（全局安装）** → 从工作区/插件包根
逐级向上找 `tools/ffmpeg[/ffmpeg]`、`bin/ffmpeg`、`ffmpeg`。全局装了 ffmpeg（如 `/usr/local/bin/ffmpeg`）
就直接用它；仓库上层目录里的那份只是「没进 PATH 时」的兜底——要钉住某个版本用 `ffmpegPath` 或
`DSH_SVS_FFMPEG` 显式指定。

---

## 4. 工具与清单

```js
// 单镜补到 48fps（纯 ComfyUI，不依赖 ffmpeg）
video_interpolate({ video_node: '<S01 画布视频节点 id>', target_fps: 48 })

// 24 → 60fps（RIFE ×5 出 120fps 母版 → ffmpeg 抽到 60）
video_interpolate({ video_node: '<S01 节点 id>', target_fps: 60 })

// 显式倍率（母版帧率 = 源 × 5；目标必须整除它）
video_interpolate({ video_node: '<S01 节点 id>', multiplier: 5, target_fps: 120 })
```

清单 `workflows/video-interpolate-rife.json` 的契约字段：

```jsonc
"interpolate": {
  "mode": "param",                        // param=倍率由 runner 注入；fixed=写死
  "defaultMultiplier": 2, "minMultiplier": 2, "maxMultiplier": 16,
  "outRule": "n-minus-1-times-m-plus-1",  // 模型帧数规则（决定 D2 补几帧）
  "audio": "passthrough"
}
"assets": { "vfi_weights": { "default": "rife_v4.25.safetensors", "env": "DSH_SVS_VFI_WEIGHTS" } }
"params": source_video / multiplier / pad_from / pad_amount / out_fps / prefix
```

权重放 ComfyUI `models/frame_interpolation/`（`rife_v4.25.safetensors` 21.6 MB），放进去**不用重启**。

---

## 5. 实测（本机单卡，空队列）

| 源 | 补帧 | 端到端 | 产物 | 帧数 | 时长 | 体积 |
|---|---|---|---|---|---|---|
| 124f 480×832 | ×2 → 48fps | **6.3s** | 247f | 5.146s | 5.146s | 1.70 MB |
| 124f 768×1344 | ×2 → 48fps | **10.5s** | 247f | 5.146s | 5.146s | 2.00 MB（源 2.00 MB） |
| 124f 768×1344 | ×5 → 120fps | **21.0s** | 616f | 5.134s | 5.134s | 2.73 MB |

> 上表是**未做 D2 补齐**的裸链路实测；接入 runner 后产物帧数为 248 / 248 / 620 与源同时长。
> 对比生成成本：H3 fast 124 帧 ≈ 23s（还会随分辨率涨），补帧便宜一个量级。

---

## 6. 拼接守卫（`video_concat`）

补帧引入后，成片里最容易踩的坑是**混帧率拼接**：ComfyUI 后端取首段 fps，
24fps 段与 48fps 段混拼时后者**半速播放且不报错**。现在 `video_concat` 会先做帧率一致性检查
（`concatFpsGuard`）：不一致**直接拒绝**并给出下一步（`video_interpolate(target_fps=…)` 统一或重出该镜）；
拼接节点也会记下 `fps / width / height / length`，供终检与下游判断。

---

## 7. 边界与已知限制

- **只逐镜补，成片不补**：模型没有场景检测，硬切处会生成两场之间的形变帧。
- **字幕 / 文字 / 硬边**：插帧可能拉丝或半透明叠字，上线前必须做 A/B。实测（`research/fps-interp/ab-48fps.md`）：
  慢镜/快动作都干净（中间帧 PSNR 32–41 dB），**含硬切的镜头会在切点生成交叉淡化鬼影帧（PSNR 13.9 dB）**，
  烧录字幕的中间帧文字边缘变软（32.8–34.9 dB，仍可读）。⇒ 逐镜补；含切点/转场的镜头跳过；字幕镜先抽中间帧核对。
- **未做分块**：长片（>300 帧 @1344×768）会把整段 IMAGE 张量放进内存；当前依赖
  `FrameInterpolate` 自身的 OOM 降 batch。需要长片时按 `overlap` 分块是下一步。
- **只有 quality 一档**：补帧没有质量阶梯，`tier` 传 fast/balanced 会显式报错。
  FILM 权重可作为第二个 quality 实现（`priority` 更低）后续加入。
- **48fps 交付体积不涨**：同 CRF 下 768×1344 的 48fps 产物与 24fps 源持平（2.00 MB）；
  120fps 母版 +37%。飞书单文件 20 MiB 上限对长片仍要另算。

---

## 8. 测试

```bash
node scripts/smoke-interpolate.mjs    # 离线：清单契约 / 帧数账 / 拼接守卫 / ffmpeg 探测 / 错误路径
node scripts/e2e-interpolate.mjs      # 真机：24→48（纯 ComfyUI）+ 24→60（ffmpeg 抽取）
```
