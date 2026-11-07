# 实测数据（canonical）

> **单一事实源**：README 与其他文档只引用这里的 headline 值；历史版本里的旧值（如 155.7s / 483.4s / 541.5s）是当次测量，条件和本表不同，见 §4。
> **口径**：除特别标注外，均为**本机单卡**、ComfyUI 本地、16:9、124 帧、原生 768p（1344×768；fast 例外为 832×480），空队列、同 prompt/seed 连续跑。**绝对耗时随硬件与模型加载状态变化**，本表用于同条件相对比较与量级参考，不承诺复现同一秒数。
> **冷/热**：`热` = 模型已在显存/进程缓存中；`冷` = 含首次权重加载。README 同一指标若同时给两个值，以本表的 cold/warm 标注为准。

## 1. H3 生成档位（16:9 · 124 帧）

| 能力 | fast | balanced | balanced + Sol | quality | quality + Sol |
|---|---|---|---|---|---|
| ref2v（832×480 / 1344×768） | 24.6s | 166.3s | 136.3s | 396.6s | 311.2s |
| i2v（832×480 / 1344×768） | 26.1s | 177.3s | 130.5s | 394.8s | 314.7s |

- **续接镜（`…-ctx-*`）**：同档比标准实现慢约 **1.3–1.5×**（多采 22 帧 + Motion Context 条件）。i2v fast：起链 36.4s / 续接 40.4s（标准 i2v fast 对照 30.5s）。
- **Pika H3 Flex 6 步**：ref2v **135.9s** / i2v **132.2s**（对 8 步 1.30–1.32×，四次重复稳定）；叠原生块稀疏 **84.4s**。
- **PDD 8 步**：ref2v **184.7s** / i2v **178.8s**；叠 Sol **137.3s / 134.1s**；同条件 20 步成片档 394.4s / 392.4s（PDD 锐度还高 +10.3% / +7.9%）。
- **画质**：balanced（8 步）帧锐度比 quality（20 步）高约 13%；fast 细节最弱（调构图/走位用）。

> 更完整的 LoRA × 分辨率 × 档位矩阵与 token/成本模型：[`minimax-h3-video-benchmark.md`](minimax-h3-video-benchmark.md)；加速选型：[`minimax-h3-acceleration-lora.md`](minimax-h3-acceleration-lora.md)。

## 2. 放大 / 重建（124 帧 · 1344×768 源片）

| 实现 | 交付 | 耗时 | 条件 |
|---|---|---|---|
| 像素 U3 ×2 | 2688×1536 | **68.1s（热）** / 155.7s（冷，含加载） | 逐帧 CNN，最便宜 |
| 像素 U3 ×4 | 4032×2304（从 5376 收敛） | 241.3s | 一趟到 4K 级 |
| U1 2K → U3 ×2 | 4032×2304 | 261.6s | 混合路线（U1 打底） |
| U1 2K → U3 ×2 | 5376×3072 | 317.5s | 不缩放交付 |
| SeedVR2 3B | 2688×1536 | **187.2s（热）** / 483.4s（冷） | 一步扩散恢复；细节最多、平坦区带颗粒 |
| RelayVSR ×2 | 2688×1536 | **25.3s** | 每 15 帧一次 Wan 参考分支 + Flash 解码 |
| RelayVSR ×4 | 5376×3072 | **83.4s** | 同上，4× 权重 |
| Open-H3 Regenerate | 2K 2560×1440 | **557.3s**（≈9.3min，显存峰值 ≈57GiB） | 3 步重画（CFG=1, σ0.909）；B 方案 latent 交接 540.3s |
| 生成内 3D latent ×2 | 2688×1536 | 620–2700s（分档） | 二遍精修在 ≈500k token 上超线性 |
| RIFE 补帧 | 分辨率不变 | 480×832 ×2 **6.3s**；768×1344 ×2 **10.5s**、×5 **21.0s** | 时长不变，D2 尾部补齐 |

- **对照**：2K 重生成 557.3s 对 `-ctx-quality-2k` 2120.9s = **3.8×**、`-ctx-quality-pdd2-2k` 1277.8s = **2.3×**。
- **2K 像素-帧包线**：248 帧 × 5376×3072 = 4.09e9 一次通过（无 OOM）；超 3.0e9 自动分块（仅 `chunking=caller`）。

## 3. 画质指标（自校准频谱尺子，2K 网格）

| 臂 | 有效宽 | 增益 | 平坦区闪烁比 | 平坦区锐度 |
|---|---|---|---|---|
| 输入 1344×768 | 1344 | ×1.00 | — | 68.3 |
| 像素 U3 ×2 | 2218 | ×1.65 | **0.958** | 193.9 |
| SeedVR2 3B | **2654** | **×1.975** | 1.045 | **311.3** ⚠ |
| RelayVSR ×2 | 2117 | ×1.575 | 1.057 | 192.7 |

> 指标含义、眼判图与「合成高频 ≠ 真实细节」的边界见 [`video-upscale.md`](video-upscale.md) §4/§6。

## 4. 历史测量与旧值

| 旧值 | 出现处 | 说明 |
|---|---|---|
| 像素 U3 ×2 = 155.7s | 早期 README / `video-upscale.md` | **冷启动（含模型加载）**；同条件热值 68.1s |
| SeedVR2 = 483.4s | 早期文档 | **冷启动**；热值 187.2s |
| Regenerate 2K = 541.5s | 早期 README | 已退役，canonical 为 557.3s（含解码，同口径） |
| U3 ×4 → 4032 = 241.3s | 历史 | 仍有效（冷/热未单列，属 4K 路线） |

## 5. 复现

```bash
node scripts/e2e-tier-render.mjs --workflow=minimax-h3-ref2v-fast   # H3 单镜
node scripts/e2e-upscale.mjs --workflow=video-upscale-x2 --src=<mp4> --target=2688
node scripts/e2e-upscale.mjs --workflow=video-upscale-relayvsr-x2 --src=<mp4> --target=2688
node scripts/e2e-upscale.mjs --workflow=video-upscale-seedvr2-3b --src=<mp4> --target=2688
node scripts/e2e-2k-vs-regen.mjs                                    # 2K vs 重生成
node scripts/e2e-b-handoff.mjs                                      # latent 交接 A/B
node scripts/analyze-u3.mjs <输入.mp4> <产物.mp4>                    # 有效宽/闪烁/锐度
```

---

## 附：H3 档位原始记录（历史正文）

### 实测耗时（16:9 · 124 帧 ≈ 5.17s）

| 能力 | `fast` | `balanced` | `balanced` 带加速 | `quality` | `quality` 带加速 |
|---|---|---|---|---|---|
| ref2v（832×480 / 1344×768） | 24.6s | 166.3s | 136.3s | 396.6s | 311.2s |
| i2v（832×480 / 1344×768） | 26.1s | 177.3s | 130.5s | 394.8s | 314.7s |

> 耗时随硬件、驱动、模型文件版本而变，上表只作**量级参考**（决定选哪一档、加速值不值得开）。

**续接镜（`…-ctx-*`）**：同一档位下比标准实现慢约 **1.3–1.5×**（多采 22 帧 + 一组 Motion Context 条件）。i2v `fast` 实测：起链 36.4s / 续接 40.4s（同档标准 i2v `fast` 对照 30.5s）。

**PDD 清单**（长边 1344，需自己在设置页组进策略）：ref2v **184.7s** / 叠加 Sol **137.3s**；i2v **178.8s** / 叠加 Sol **134.1s**。同条件下的 20 步成片档为 394.4s / 392.4s（PDD 的锐度还高 +10.3% / +7.9%）→ **PDD 相当于用 8 步的钱买 20 步的画质**。

画质：`balanced`（8 步）帧锐度比 `quality`（20 步）高约 13%；`fast` 档细节最弱、适合调构图 / 走位；PDD 8 步则**高于**成片档。


> **⚠️ 版本兼容（v0.1.x → 现在）**：组 `minimax-h3-i2v`（拆分后是多份单档清单，见上表）的 base 已从 `minimax_h3_ref2va_pruned_int8_convrot` 换成 **`minimax_h3_fl2va_pruned_int8_convrot`（+21GB 下载）**，LoRA 换成 `minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy`（+2GB）。原因是原先 i2v 用 Ref2VA base 跑 `MiniMaxH3ImageToVideo` 属**跨变体错配**（拿不到 fl2v 系迭代红利）。这两个资产现在由**独立配置键**驱动（`models.h3FlUnet` / `models.h3FlFastLora`，或 env `DSH_SVS_H3_MODEL_FL` / `DSH_SVS_H3_LORA_FL_FAST`）——旧键 `h3RefUnet` / `h3FastLora` **只作用于 ref2v 档**，不再被 i2v 复用。若不想多下 21GB，用配置把它按旧组合钉回去即可（i2v 会退回旧行为）：
>
> ```jsonc
> "assetOverrides": {
>   "minimax-h3-i2v-quality": {
>     "unet": "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
>     "fast_lora": "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"
>   }
> }
> ```
>
> **旧 id 的配置无需改写**（P2 迁移已内置）：`assetOverrides` 按族继承——新 id 会同时读旧 id 的覆盖（`minimax-h3-ref2v-*` 继承 `minimax-h3-ref2v`，`*-balanced*` 额外继承 `minimax-h3-ref2v-8step`，`minimax-h3-i2v-*` 继承 `minimax-h3-i2v`），且精确匹配新 id 的覆盖优先级更高；旧 `models.*` 键也按族映射到各档清单。所以你**不必**逐档重写配置。
>
> **⚠️ LoRA 与 shift 必须配对**（硬约束）：544p 系 LoRA（`ref2v/fl2v 4step v0.1`）= shift **12/3**；768p 系 LoRA（`*_8step_v1.0_768p`、`fl2v v1.1/v1.2 768p`）= shift **6/3**，且分辨率必须进 768p 训练域（本插件用 1344×768）。错配不是"略糊"而是**结构性崩坏**。shift 写在清单 `graph` 里（`modes` 不支持按档改标量），所以**换档位 pairing 的正确做法是加一份新清单**。
