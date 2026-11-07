# Sol-H3-VAE 解码加速 A/B（Pika ctx + Sol-Attn）

**结论**：在本机单卡、1344×768×124 帧的 Pika 6 步 + BlockSparseAttention 链式续接清单上，
把 `VAEDecode` 换成 Sol-H3-VAE 后 **解码 9.90s → 5.37s（1.84×）**，
**单镜总耗时 80.5s → 75.9s（−5.7%）**；画质 PSNR 43.4 dB / SSIM 0.985（两段 h264 输出互比，
含编码损失），音轨逐字节相同。

- 日期：2026-11-06
- 环境：ComfyUI **0.44.1**（PR #17411 起才认识该权重）、PyTorch 2.15、NVIDIA 本机单卡、24 fps
- 权重：`models/vae/sol_h3_vae.safetensors`（6.47 GB，来自 `Efficient-Large-Model/Sol-H3-VAE`，经 hf-mirror 下载）
- 基线清单：[`workflows/minimax-h3-ref2v-ctx-balanced-pika-solattn.json`](../../workflows/minimax-h3-ref2v-ctx-balanced-pika-solattn.json)
- 实验清单：[`workflows/minimax-h3-ref2v-ctx-balanced-pika-solattn-solvae.json`](../../workflows/minimax-h3-ref2v-ctx-balanced-pika-solattn-solvae.json)

## 变体做法：为什么不是「换个 VAE 文件名」

Sol-H3-VAE 是 **decoder-only** 的蒸馏权重（24 层、非因果、整片解码）。本清单的编码路径也用到
`$assets.vae`：`MiniMaxH3ReferenceToVideo`（参考图编码）与 `MiniMaxH3MotionContext`（续接上下文），
所以不能直接覆盖 `assets.vae.default`。变体的做法是**只给解码器多接一个 VAE**：

- 新增节点 `4b`：`VAELoader { vae_name: "$assets.vae_decode" }`，资产槽 `vae_decode` 默认
  `sol_h3_vae.safetensors`（env `DSH_SVS_H3_SOL_VAE`）；
- 只把 `11`（VAEDecode）的 `vae` 从 `["4",0]` 改指 `["4b",0]`；
- 其余图（Pika LoRA、BlockSparseAttention、Motion Context、Sigmas、SaveVideo）逐节点不变。

两份清单的差异由脚本自动断言（节点集合只多 `4b`、且除 `11.vae` 外逐字段相同），
否则拒绝开跑，避免"假 A/B"。

## 计时方法：WebSocket 节点级耗时

`/history` 只有 `execution_start` / `execution_success` 两个时间戳，没有节点耗时；两臂采样子图又完全相同
（同 seed / 同 prompt / 同 LoRA），ComfyUI 会命中采样缓存，总耗时差被噪声吃掉。所以直接连
`/ws?clientId=…`，按 `executing(node)` 事件的时间戳求「本节点开始 → 下一节点开始」的墙钟：

- 每对用**同一个新 seed**：A 臂完整跑（采样 + 解码），B 臂采样命中缓存、只跑 VAE 加载 + 解码，
  两臂喂给解码器的 latent 完全相同；
- 种子必须每次新取：同 seed + 同图会让 ComfyUI 全图命中缓存（踩过，测出 0.13s 的假数据）。

## 结果（3 对交替，本机单卡，1344×768×124f）

| 指标 | A：H3 视频 VAE（int8_convrot） | B：Sol-H3-VAE | 变化 |
|---|---:|---:|---:|
| `VAEDecode` 节点 | **9.90s**（9.89–9.93） | **5.37s**（5.35–5.39） | **1.84×**，−45.8% |
| 单镜总耗时（含采样） | 80.47 / 80.50s | 75.88s（同 seed 完整跑） | −4.6s，−5.7% |
| 采样（node 10） | 67.2 / 67.6s | 67.7s | 不变 |
| SaveVideo | 2.6–3.7s | 2.6–2.8s | 噪声级 |
| 画质 | 基准 | PSNR 41.9 dB（Y）/ 43.4 dB（avg），SSIM 0.985 | 细纹理差异，肉眼基本一致 |
| 音轨 | 基准 | 逐字节相同（音频 VAE 未变） | — |

## 需要注意

1. **解码占比决定收益**：本清单采样 ~67s、解码 ~10s，所以解码提速 1.84× 只换来整镜 −5.7%。
   换成 fast 档（采样 ~20s）或短镜头，Sol-H3-VAE 的相对收益会明显变大。
2. **不能 tile**：非因果解码器整片解码，`VAEDecodeTiled` 也会退化成整片；显存随片长/分辨率线性涨
   （官方 PR：#17411 实测 362 帧 3.5 GiB 激活，2048×1152×124 5.4 GiB）。
3. **本机 int8 解码偏慢**：官方 RTX 5090 数据是 int8 4.61s / Sol fp16 3.28s，本机 int8 是 9.90s，
   所以 1.84× 是**本机口径**，换卡要重测。
4. **ComfyUI 版本**：必须 ≥ v0.44.0；低版本 `VAELoader` 不认识该权重。
5. 该清单 `priority: -100`、不在任何档位默认里，只能显式选用。

## 复现

```bash
# 节点级 A/B（3 对，自动交替）
node scripts/experiment-solvae-node-timing.mjs --pairs=3

# 整镜 A/B（含产物落盘，注意同 seed 会命中缓存）
node scripts/experiment-solvae-ab.mjs --pairs=3
```

产物：`e2e-out/solvae-ab/solvae-nodes-r1-results.json`、`solvae-r1-results.json`、
`solvae-r1-*.mp4`，对比帧在 `e2e-out/solvae-ab/frames/`。

# fast 档复测（832×480，Pika 4 步 fast 变体）

采样占比越低，解码提速的相对收益越大。为此给 Pika 适配器补了一个 **4 步 fast 清单**
（Pika 官方只发 6 步 7 值 schedule，4 步是自拟 schedule，属实验实现）：

- [`workflows/minimax-h3-ref2v-ctx-fast-pika-solattn.json`](../../workflows/minimax-h3-ref2v-ctx-fast-pika-solattn.json)
  —— lcm + 自拟 4 值 sigma `1.0, 0.948025, 0.8, 0.452381, 0.0`（由官方 6 步 sigma 曲线按 t=0/¼/½/¾/1 线性插值）、Pika LoRA、
  BlockSparseAttention(sol-attn)、832 长边、链式续接
- [`...-fast-pika-solattn-solvae.json`](../../workflows/minimax-h3-ref2v-ctx-fast-pika-solattn-solvae.json)
  —— 同上 + Sol-H3-VAE 解码

## 解码 A/B（832×480×124f，3 对交替）

| 指标 | A：H3 int8 VAE | B：Sol-H3-VAE | 变化 |
|---|---:|---:|---:|
| `VAEDecode` | **4.13s**（3.94–4.16） | **2.23s**（2.09–2.23） | **1.85×**，−46.0% |
| 采样（node 10） | 13.13–13.19s | 13.20s | 不变 |
| 整镜总耗时 | 19.10 / 19.35s | 17.95s（同 seed 完整跑） | −1.4s，−6.6% |
| SaveVideo | 1.57–1.88s | 1.58–2.25s | 噪声 |

**结论**：fast 档解码省 1.9s、整镜省约 6.6%（vs balanced 档 −5.7%）；采样 13s 时解码占 ~21%，
是 Sol-H3-VAE 收益最明显的档位。

## 标准 fast（turbo 4 步 / res_multistep）上的复测

清单：[`workflows/minimax-h3-ref2v-ctx-fast-solvae.json`](../../workflows/minimax-h3-ref2v-ctx-fast-solvae.json)
（由 `minimax-h3-ref2v-ctx-fast` 派生，唯一差异 = 解码器）。3 对交替，832×480×124f：

| 指标 | A：H3 int8 VAE | B：Sol-H3-VAE | 变化 |
|---|---:|---:|---:|
| `VAEDecode` | **4.16s**（4.12–4.19） | **2.12s**（2.03–2.15） | **1.96×**，−49.0% |
| 采样（node 10） | 16.22–16.34s | 16.31s | 不变 |
| 整镜总耗时 | 22.84 / 22.71s | 20.43s（同 seed 完整跑） | −2.4s，−10.5% |
| 画质 | 基准 | PSNR 37.3 dB(avg) / SSIM 0.974 | 同帧锐度 262.6 → 291.2（略更锐） |

**一条必须记住的 A/B 陷阱**：两臂的**编码 VAE 必须一致**。标准 fast 清单默认 fp16 VAE，Pika 清单默认 int8；
第一次跑标准 fast 时 B 臂沿用了清单默认 fp16，导致参考图编码（node 5 依赖 VAE）哈希改变，
采样缓存失效、总耗时多算 16s——解码节点耗时不受影响，但整镜 A/B 会失真。
脚本现在两臂都强制 `assets.vae = VAE_A`，只让 `vae_decode` 不同。

**横向对比**：解码提速倍数三档一致（1.84–2.02×），整镜收益取决于采样占比：
balanced 1344（采样 67s）−5.7% ｜ 标准 fast 832（采样 16s）−10.5% ｜ Pika 4 步 832（采样 13s）−6.6%。

## Pika 4 步 fast 的工作量级（同 prompt / seed / 832×480×124f）


| 实现 | 内部耗时 | 备注 |
|---|---:|---|
| 标准 fast（turbo 4 步 + res_multistep） | 22.84s | 基线 |
| **Pika 4 步（自拟 sigma）+ sol-attn** | **20.06s** | 比基线快 2.8s |
| Pika 6 步 @832（官方 schedule） | 25.97s | 同分辨率对照 |

画质：4 步输出结构/身份正常（狐宇航员场景无崩坏），但高频明显比 6 步与标准 fast 软
（同帧 Laplacian 方差：pika4 142 / pika6 153 / 标准 fast 289），属于自拟 schedule 的代价。
**建议**：4 步 Pika 只做调试/走通全片用，成片仍走 6 步；若要用，必须按镜头抽帧自检。

