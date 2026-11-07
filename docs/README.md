# 文档索引

> 先读 README 的 [30 秒速览](https://github.com/fengyungithub/dsh-short-video-studio#30-秒速览) 与 [社区加速与放大技术](https://github.com/fengyungithub/dsh-short-video-studio#社区加速与放大技术2026-11-重点)；本页是深入层的入口。
> 约定：**实测数字的 canonical 口径在 [`benchmarks.md`](benchmarks.md)**；历史测量（冷/热未统一）只出现在发布日志与调研文档。

## 架构与契约
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — 分层、数据流、画布/设置页/路由
- [`workflow-contract.md`](workflow-contract.md) — 清单（manifest）契约、注入原语、资产槽
- [`tier-strategy-design.md`](tier-strategy-design.md) — 档位 / 策略 / 解析语义
- [`unified-tier-tool-design.md`](unified-tier-tool-design.md) — 统一档位与工具面的设计定稿
- [`USAGE-ROUTING.md`](USAGE-ROUTING.md) — 三个内置 skill 的触发边界与重叠
- [`channel-delivery.md`](channel-delivery.md) — 飞书 / TUI 交付
- [`prompt-bank.md`](prompt-bank.md) — 分档提示词库

## 能力实现
- [`video-upscale.md`](video-upscale.md) — 视频超分（像素 U3 / SeedVR2 / RelayVSR），尺寸与分块契约
- [`video-regenerate.md`](video-regenerate.md) — Open-H3 Regenerate（目标网格、latent 交接、A/B）
- [`video-interpolate.md`](video-interpolate.md) — RIFE 补帧（D2 尾部补齐、非整数倍）
- [`hires-two-pass-upscale.md`](hires-two-pass-upscale.md) — 生成内两阶段放大
- [`learned-latent-upscale-2k.md`](learned-latent-upscale-2k.md) — 学习式 3D latent ×2
- [`shot-chain-continuity.md`](shot-chain-continuity.md) — 链式续接机制与实测矩阵
- [`video-shape-contract.md`](video-shape-contract.md) — r2v / i2v 形状与参数契约
- [`h3-prompt-integration.md`](h3-prompt-integration.md) — H3 提示词接入
- [`h3-voice-consistency-plan.md`](h3-voice-consistency-plan.md) — 声线一致性 / 试镜 / 路线图

## 实测与基准
- [`benchmarks.md`](benchmarks.md) — **canonical 实测数据**（冷/热、条件、复现命令）
- [`minimax-h3-video-benchmark.md`](minimax-h3-video-benchmark.md) — H3 分辨率 × 档位 × LoRA × Sol 全矩阵、成本模型
- [`minimax-h3-acceleration-lora.md`](minimax-h3-acceleration-lora.md) — LoRA 全家福、shift/steps 硬约束、PDD / Sol 细节
- [`acceleration.md`](acceleration.md) — 可选加速件（Pika / PDD / Sol / int8 VAE）明细
- [`upscale-latency-optimization-research.md`](upscale-latency-optimization-research.md) — 提分辨率路线调研（历史测量）
- [`2k-acceleration-variants-analysis.md`](2k-acceleration-variants-analysis.md) · [`2k-pdd-ab-verdict.md`](2k-pdd-ab-verdict.md) — 2K 加速变体与 PDD A/B
- [`fps-interpolation.md`](fps-interpolation.md) — 补帧数据与结论

## 生产流程与 skill
- [`series-production-flow.md`](series-production-flow.md) — 短剧系列制片总控流程
- [`short-drama-series-integration-research.md`](short-drama-series-integration-research.md) — 短剧系列化集成研究
- [`short-drama-skills-structure-report.md`](short-drama-skills-structure-report.md) — 短剧 skill 结构
- [`three-view-experiment.md`](three-view-experiment.md) · [`step0-comparison.md`](step0-comparison.md) — 角色卡三视图 / STEP 0 对照
- [`consistency-optimization-plan.md`](consistency-optimization-plan.md) · [`min-patch-prompt-gating.md`](min-patch-prompt-gating.md) — 一致性与提示词门

## 选型 / 对标 / 其它
- [`i2v-vs-ref2v-and-model-comparison.md`](i2v-vs-ref2v-and-model-comparison.md) — i2v 与 ref2v 的概念差别、跨模型选型
- [`video-workflow-comparison.md`](video-workflow-comparison.md) · [`toonflow-comparison.md`](toonflow-comparison.md) — 工作流与同类产品对照
- [`ref2va-shot-continuity-research.md`](ref2va-shot-continuity-research.md) · [`right-sidebar-canvas-research.md`](right-sidebar-canvas-research.md) · [`architecture-review.md`](architecture-review.md) — 研究 / 设计评审
- [`workflows-catalog.md`](workflows-catalog.md) — 内置工作流清单明细
- [`open-issues.md`](open-issues.md) — 已查证但暂不实施的问题

> 实验与专题报告在 [`research/`](research/) 下（Pika、Sol-H3-VAE、Open-H3 选型、音频路线图等）。
