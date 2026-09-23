# 两阶段潜空间放大（hires）：提升 H3 成片分辨率

> 状态：**已实现**（清单 `minimax-h3-ref2v-hires` / `minimax-h3-i2v-hires`）
> 契约：`docs/tier-strategy-design.md` §2（档位受控三档）· `docs/workflow-contract.md` §4（清单字段）
> 相关：`docs/minimax-h3-video-benchmark.md`（实测表）· `docs/minimax-h3-acceleration-lora.md`（加速件）

## 0. 为什么需要它

**开源版 MiniMax H3 的原生上限就是 768p（1344×768）。**

于是「提升分辨率」不是把 width/height 传大就能解决的事——超过训练分辨率直接采样会出现复制/克隆伪影，
越高越明显。正确的做法是把「创意决策」与「细节重建」分开（社区称之为 two-pass / 两阶段工作流）：

1. **首遍**在模型原生尺寸上解运动、构图、镜头与声音——这是模型最擅长的事，也是失败成本最低的事；
2. **二遍**把视频 latent 放大，再以**低噪声**在同一模型上重建微观纹理——不是重画表演。

这不是我们的发明：ComfyUI 0.35 内置节点 `MiniMaxH3AVLatentUpscaleBy` 的官方说明原文就是
> Upscales the video half of a MiniMax-H3 AV latent (audio untouched) for two-pass latent-upscale workflows:
> **full PDD pass at low res → this node → partial-denoise PDD pass**

且其 `scale_by` 的 tooltip 直接点名了甜点区：
> 1.5 on a 896x512 pass-1 render lands exactly on the **model-native 1344x768**

本实现就是这条官方路径的清单化落地。

## 1. 结构：图里多了什么

以 ref2v 为例，相对标准 quality 清单只多三块：

```
node 5  MiniMaxH3ReferenceToVideo（首遍条件 + 空 latent）
node 10 首遍采样（20 步 / denoise 1.0 / shift 12,3）
   │
   ├─ node 14  MiniMaxH3AVLatentUpscaleBy(scale_by 1.5, bislerp)   ← 只放大视频那一半
   │
   ├─ node 6b  RandomNoise(seed = ${seed + 1000000})                ← 二遍必须是新噪声
   ├─ node 9b  BasicScheduler(steps 6, denoise 0.35)                ← 低噪声重建，不重画
   └─ node 10b SamplerCustomAdvanced(noise 6b, sigmas 9b, latent 14)
          │
          └─ 11b VAEDecode / 11c VAEDecodeAudio → CreateVideo → SaveVideo
```

首遍尺寸 **896×512**，×1.5 = **1344×768**（模型原生）。选择 896×512 而不是其他尺寸的理由：
它是原生分辨率的 1/1.5，放大后**正好落回模型最擅长重建的尺寸**；首遍的像素量只有原生的 44%，
要重做的失败草稿便宜一半。

音频不需要特别照顾：`MiniMaxH3AVLatentUpscaleBy` 的语义就是「只放大 AV latent 的视频那一半，
音频原样穿过」，所以音轨与口型天然沿用首遍，二遍的噪声也不进音频分支。

## 2. 为什么需要 `resolutionLock`（**图锁定**形态）

> 本文讲的是 `resolutionLock` 的**图锁定**形态（`graph` + `scale`），hires 族用它。
> 2026-09 起还有第二种**只锁倍率**形态（只给 `scale`，首遍不锁）——learning 式放大族用它来支持
> 任意画幅比例，见 [`learned-latent-upscale-2k.md`](learned-latent-upscale-2k.md) §4。
> 两者的共同点是「交付 = 首遍 × scale 且必有 warning」；差别是首遍尺寸是否可被调用方改写。

首遍尺寸是**图结构的一部分**（放大倍率写死在节点上），所以它不能被调用方传的
`width`/`height` 或画布 `aspectRatio` 覆盖——否则「放大」会从错的底片开始，
而且调用方拿到的 width/height 与成片尺寸会静默不一致。

因此清单新增一个字段：

```jsonc
"resolutionLock": {
  "graph": [896, 512],     // 首遍采样尺寸（注入图里的 width/height）
  "scale": 1.5,            // 二遍放大倍率 → 交付 = graph × scale
  "note": "为什么锁定（会拼进解析警告）"
}
```

语义（实现在 `lib/index.js` 的 `computeManifestSize` / `manifestDeliverySize`）：

| 场景 | 行为 |
|---|---|
| 有 `resolutionLock` | **图分辨率 = lock.graph**；显式 width/height 与画布比例一律被忽略 |
| 交付尺寸 | `manifestDeliverySize()` = graph × scale，**画布节点记的是交付尺寸**（拼接/续接的一致性判断读它） |
| 不静默 | 每次调用锁定实现都会带一条 warning，写明「图分辨率被锁定为 A×B、实际交付 C×D」 |
| 图内首遍尺寸 | `buildRenderGraph` 仍按 lock 注入，调用方无法绕过 |
| 无 `resolutionLock` | 行为完全不变（显式宽高 > 画布比例 > default） |

画布节点的 `params` 在锁定生效时额外记 `graphWidth` / `graphHeight` / `upscaleScale`，便于复现与排障。

## 3. 怎么用

```jsonc
// 显式选中实现（档位解析不会自动落到它：priority < 0）
comfy_render({ capability: "video.reference2video", workflow: "minimax-h3-ref2v-hires", prompt: "..." })
```

或在配置页用「新增策略」把它设成某 capability 的某档实现（它与标准实现同能力、同为 `quality` 档，
只是 `group` 不同——UI 里显示为「两阶段放大」家族）。

**只提供 `quality` 档**：两阶段本身很贵，而 `fast` 档存在的意义是「便宜地验构图」——
那个需求由标准 fast 清单满足，不该在这里伪装便宜。

**hires 只支持 16:9**：放大倍率是插值节点上的字面量，且首遍必须落在原生 ÷1.5，
换比例会让「放大后落在原生分辨率」这个前提失效。（学习式放大族把目标尺寸改成算术模板
`"${width * 2}"`，因此那一边支持任意比例——见 `learned-latent-upscale-2k.md` §4。）
（需要竖版时要另建一套 graph/scale 组合，或改用 `graph: [512, 896]` 的独立清单。）

### 可调参数

| 参数 | 位置 | 默认 | 说明 |
|---|---|---|---|
| 首遍步数 | `params.steps` → node 9 | 20 | 常规档位语义 |
| 二遍步数 | `params.steps2` → node 9b | 6 | 结构参数；少量步数即可，2× 空间放大让每步成本约 ×2.25 |
| 二遍噪声强度 | node 9b `denoise` | 0.35 | **起手值，非调优值**。过高改人物/姿态，过低几乎无增益 |
| 放大倍率 | node 14 `scale_by` + `resolutionLock.scale` | 1.5 | 两处必须一致（改结构请改 `scripts/make-hires-template.mjs` 后重跑） |
| 二遍 seed | node 6b `${seed + 1000000}` | 首遍 seed + 1e6 | 必须与首遍不同，否则二遍退化成重放首遍的高噪声步 |

## 4. 与其它增强的关系

| 增强 | 是否可叠 | 说明 |
|---|---|---|
| 链式续接（`continuity_from`） | **不可叠**（本版） | 续接要求同分辨率同档位（latent 不能缩放）；hires 是独立组、不声明 `chain` |
| Sol-Attn | 未提供 | 本环境 Sol + cudaMallocAsync 有硬崩记录（见 acceleration-lora §9.10），hires 不带 Sol 变体 |
| PDD 8 步 | 未提供 | 二遍用的是标准 20 步模型 + 低噪声，不引入 PDD 的第三方节点依赖 |
| 学习式 latent 放大器 | 未提供 | 需额外权重（[LBH-123-AI](https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler)）；本实现只用内置节点，零安装 |

内置 `MiniMaxH3AVLatentUpscaleBy` 是**插值**放大（bilinear/bislerp 一类），能保住结构、把细节交给二遍重建；
它不会凭空生成细节。要「真·重建细节」需要学习式放大器（另需下载权重），可作为后续增强。

## 5. 失败与排障

| 症状 | 原因 | 处理 |
|---|---|---|
| 二遍输出像纯噪声 / 棋盘格 | 二遍走了 `AddNoise` + `DisableNoise` 的手工路径 | H3 是 CONST 参数化模型，标准 `AddNoise` 会被二次 `(1-sigma)` 缩放。**用 `BasicScheduler` 传 sigmas 即可**（本实现的做法），或改用社区修正节点 `MiniMaxH3AddNoise` |
| 音频失真 / 对白含混 | 音视频 sigma 混用（模型内部音频走 shift 3.0、视频走 12.0） | 本实现不单独给音频加噪（音频 latent 不进放大、不被重新加噪），因此不受影响；自建图请用 `MiniMaxH3ShiftSigmas` 换算 |
| 人物/姿态变了 | 二遍 denoise 过高 | 下调到 0.25–0.30；仍漂移则回到标准档 |
| OOM | 二遍在目标分辨率上采样，峰值显存由它决定 | 降 `scale`、降帧数，或先 `POST /free {"unload_models":true,"free_memory":true}` |
| 画面几乎没变化 | 二遍 denoise 过低 / 步数过少 | 上调 denoise 到 0.4–0.45（逐次只改一个变量） |

## 6. 验收

```bash
node scripts/make-hires-template.mjs      # 生成模板（产物，勿手改）
node scripts/make-h3-variants.mjs         # 生成 workflows/*.json 清单
node scripts/smoke-hires-lock.mjs         # 新契约：锁定语义 / 图结构 / 不静默 / 不隐式默认（331 断言）
node scripts/smoke-tier-resolution.mjs    # 档位解析无回归（109 断言）
node scripts/verify-h3-variants.mjs       # 清单一致性无回归（154 断言）
node scripts/e2e-hires.mjs --compare --steps 20 --length 124   # 真机出片 + 对照
```

真机实测（本环境 A800 80GB，896×512 → 1344×768，56 帧）：

| 配置 | 结果 |
|---|---|
| 4 步 / 56 帧 | 65.3s，交付 1344×768 **含音轨**（2.33s） |
