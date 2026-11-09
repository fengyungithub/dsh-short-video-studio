# 更新日志

> 完整历史（按版本倒序）。README 只保留最近两个版本；更早版本见本文件。
> 历史条目中的实测数字是当次测量的原始记录，条件（冷/热、源片、目标）未统一时以 [`docs/benchmarks.md`](docs/benchmarks.md) 的口径表为准。

> 更早版本的完整变更见 [GitHub Releases](https://github.com/fengyungithub/dsh-short-video-studio/releases)（每次打 `v*` tag 自动生成）。

### 未发布 — 创作批准门（approval gate）· 审计补卡片检查

> **修复**：角色卡锁定、场景卡锁定、镜头表批准、分镜批准、门 3 片段批准此前只是 SKILL.md 里的文字纪律，agent 跳过完全合法（实测会话 `ff621764`：6 张角色卡前后 0 次 ask，`audit:session` 仍 7/7）。本版把「用户已人工批准」落成 `project.approvals`，并在推进下一步前做代码硬校验。

- **新工具 `canvas_approve(target=assets|shotTable|storyboard|clips, nodeIds?, nodeId?, note?)`**：把用户的锁定/批准落账。`shotTable` 要求表顶已有 `shot-table self-check: passed` 戳；`clips` 要求片段已 `canvas_record_check(pass)`。
- **创作批准门（`tools/pre-execute`，story/series）**：出新角色卡前其他角色卡必须已批；出场景/道具卡前角色卡必须已批；写七列镜头表前资产卡必须全批；Sxx 视频前资产/镜头表/分镜必须已批；`video_concat` 前所有输入镜头必须在 `approvals.clips`。**没有连续 deny 降级**；逃生阀 `DSH_SVS_APPROVAL_GATE=off`。
- **失效规则**：批准绑定 `settings.breakingRev` 与内容哈希；重出卡 / 改表 / 改分镜 / 重渲片段会失效对应批准，破坏性配置变更清空全部批准。
- **`canvas_get_state` 返回 `approvals` 摘要**；门组新增 `approval`，并删掉声明了但从未实现的 `deliver` 死字段。
- **`audit:session` 修复**：单片模式不再 SKIP A1/A2，改为检查角色卡/场景卡确认、镜头表+分镜 ask 在首个 Sxx 视频之前；`--session` 同时识别裸 id 与 `session-` 前缀，显式 sid 找不到时 exit 2（不再静默审计最新会话）；新增 `scripts/smoke-audit-session.mjs`。

### v1.18.0 — 会话归档搬迁画布目录 · Open-H3 重生成 Sol-Attn 变体（2026-11-09）

> **本版重点：归档会话时画布不再原地积压**——配置 `archiveRoot` 后，DSH 里归档会话会把该会话的 `<工作区>/canvas/<sessionId>`（`project.json` + 全部图片/视频/音频）整体搬到归档路径（本地盘 / 外置盘 / NAS），取消归档再搬回；**不配置则与旧版本完全一致**。
>
> **另一项（可选、不改默认）**：`video.regenerate` 新增 Sol-Attn 变体 `open-h3-regenerate-2k-solattn`（2K 整轮 **2.50×**），`priority: -31`，需在设置页显式选用。

#### 会话归档 → 画布目录搬迁（`archiveRoot`）

- **背景**：DSH 的「归档会话」只写一个标记（`~/.dsh/storages/workspace.json` 的 `archivedSessionIds`），**不搬不删工作区文件**；画布媒体因此长期留在工作区。本版补上搬迁。
- **行为**：归档 → `<工作区>/canvas/<sessionId>` → `<archiveRoot>/<sessionId>/`；取消归档 → 搬回原位置。插件启动 8 秒后自动对账，设置页「立即同步归档」可手动补搬（把已归档但仍在工作区的搬出去、已取消归档但仍在归档区的搬回来）。
- **不丢数据**：跨盘（NAS / 外置盘）`rename` 失败自动退化为「拷到 `<目标>.partial-*` → 改名就位 → 删源」，中断时源目录原样保留；目标已有同名不同内容文件改名 `.dup-<时间>` 保留，**绝不覆盖**；崩溃后重放按内容一致去重；归档/取消归档均幂等。
- **竞态**：按 sessionId 串行，执行前复核 registry 现状；「归档 → 立刻取消归档」不会把刚回迁的画布再搬走；归档留 2s 稳定等待、搬后复查 3s，避开「停止并归档」的取消时序。
- **回迁体验**：`GET /canvas` 在「已取消归档但回迁未落位」时等待完成再返回，避免读到空工程（大工程从 NAS 回迁需几秒到几十秒）。
- **索引**：归档区 `.dsh-svs-archive-index.json` 记录来源工作区 / 标题 / 时间 / 大小；工作区被删后仍可兜底定位。
- **设置页**：ComfyUI → 归档 新增 `归档路径 archiveRoot`（系统目录选择器「浏览…」+ 手输）、路径探测（不存在 / 不可写）、归档区份数与最近操作、「立即同步归档」。
- **注意**：① 该路径属于**本机插件配置**，对所有工作区生效；② 改归档路径**不会**自动迁移旧归档区里的内容；③ 「浏览…」弹的是 DSH 原生对话框（`osascript` + `NSOpenPanel`），其标准文案按调用方 app bundle 选语言，**中文系统下也会显示英文**（DSH 实现所致，插件无法改其语言）；④ `archiveRoot` 留空＝不迁移，行为与旧版本完全一致。
- **配置**：`archiveRoot`（环境变量 `DSH_SVS_ARCHIVE_ROOT` 可覆盖；`DSH_SVS_ARCHIVE_SETTLE_MS` 调稳定等待）。

#### `video.regenerate`：Sol-Attn 变体（2K 整轮 2.50×）

- **清单**：`workflows/minimax-h3-regenerate-2k-solattn.json`——与 dense 版逐字相同，只在 `OpenH3RegenLora` 与 `BasicGuider` 之间插原生 `BlockSparseAttention`（sol-attn，`tau=1.0`、`start_percent=0.2`、`min_tokens=12288`）；`priority: -31`，**不改隐式默认**，设置页可显式选用。
- **实测（本机 80GB · 124 帧 · 2560×1440 · 同草稿/同 prompt/同 seed）**：3 步采样 **506.2s → 176.9s（2.86×）**，整轮 **549.7s → 220.2s（2.50×）**；`tau=1.3` 再降至 149.7s / 193.9s（3.38× / 2.84×）。
- **质量**：与 dense 输出 PSNR Y 31.2 dB / SSIM 0.930，闪烁代理 7.20 vs 7.37（没有变抖），1:1 目检无可见差；快解码器（`sol_h3_vae`）19.2s vs 原版 VAE 54.1s（2.82×）。
- 细节与复现见 [`docs/video-regenerate.md`](docs/video-regenerate.md) §11。

#### 测试 / 文档

- 新增 `scripts/smoke-archive-move.mjs`（**78 项**：迁移 / 回迁 / 幂等 / 冲突 / 崩溃重放 / 跨盘语义 / 事件联动 / 竞态 / 对账 / 路径边界），并入 `npm run smoke`。
- `scripts/smoke-client-settings.mjs` 新增 6 项：设置页「浏览…」选择、自动保存、无系统选择器环境降级。
- `scripts/smoke-regenerate.mjs` 改为**不读本机配置**（此前用户把 `video.regenerate` 的 quality 档选成 Sol-Attn 变体后，"默认仍是 dense" 的断言会失败），发布门与本机状态解耦。
- README 与 USER-MANUAL 更新（配置键 `archiveRoot` + 新增 3.5 节「会话归档与画布搬迁」）。
- 全量 `npm run smoke` 通过（与 CI 发布门同一条链路）。

### v1.17.0 — Open-H3 Regenerate 2K · RelayVSR 超分 · balanced 自动存 draft latent（2026-11-07）

> **本版重点：社区加速 / 放大技术全部「可选化」**——Pika H3 Flex 6 步、PDD 8 步、Sol-Attn 块稀疏、SeedVR2 3B、RelayVSR ×2/×4、Open-H3 Regenerate 2K、RIFE 补帧都已在注册表里，可在设置页「＋ 新增策略 / 逐档下拉」选用；**全部不改变既有默认**（`priority<0` / `internal`），缺节点 / 缺权重会如实置灰。速查表见 [社区加速与放大技术](#社区加速与放大技术2026-11-重点)。
>
> **升级须知**：① 新能力 `video.regenerate` 需自装 `ComfyUI-Open-H3-Regenerate` 节点包与对应权重（base **FL2VA** + 合并 LoRA）；② RelayVSR 需 ComfyUI 含 PR #17511 且 `comfy-kitchen ≥ 0.2.41`；③ 28 份 balanced 视频清单都新增了一个**旁路** `OpenH3SaveRefinedLatent`（可选依赖：缺包时 runner 自动摘除 + 告警，balanced 照常出片）。

#### 新能力：视频重生成 `video.regenerate`（Open-H3 Regenerate）

- **是什么**：画布上**已有的 768p 片段** + 提示词 → latent 3D 放大 → **σ0.909 起 3 步 Euler（CFG=1）** 在**目标网格**上**重画**；交付 **1080p 1920×1080** / **2K 2560×1440**（竖屏自动翻转），帧数与源片一致、**源音轨原样接回**（音频 mask σ=0，从不经过采样器）。**会改内容，不是超分**——身份 / 口型可能漂，产物必须抽帧核对。
- **契约**：清单声明 `regenerate.targets`（`graph` 32 对齐与实际渲染网格 / `delivery` 裁切后的交付尺寸，1080p 渲 1088 行再裁回）+ 训练域护栏（24fps、121–362 帧、必须有提示词）；校验器 fail-closed。图 23 节点：`PrepareDraft → VAEEncode → LatentUpscale → RefineLatent → SamplerCustomAdvanced(3 步) → Finish(裁帧/接回原音轨)`。
- **latent 交接**：28 份 balanced 清单渲染时**顺手存 draft latent**（旁路节点，不影响出片）；`video_regenerate(handoff='auto'|'latent'|'video')` 缺省 `auto`——源节点有可用 latent（文件在服务端、121–362 帧、不大于目标网格）就走 latent，否则退回视频入口并在 `handoffReason` 说明；显式 `latent` 不满足**直接报错**，不静默退。
- **实测（本机 · 124 帧 · 2K）**：**557.3s**（≈9.3min，显存峰值 ≈57GiB）——对照 `-ctx-quality-2k` 的 **2120.9s** 为 **3.8×**、`-ctx-quality-pdd2-2k` 的 1277.8s 为 **2.3×**。B 方案（latent 交接）同草稿同 seed 精修 **540.3s vs 557.2s**（快 3.0%，端到端约 4.5%），但 1:1 眼判差异很小 ⇒ B 的精修清单保持 `internal` 实验件，不替换 C。
- **短剧系列**：`delivery=regen2k`（9:16 交付 **1440×2560**，≈+150 min/集，≈3.2× 原生；**整季同一路线、不混**）；样片集对照卡新增「2K 重生成」一臂。
- 文档：[`docs/video-regenerate.md`](docs/video-regenerate.md)（契约 / 图 / 护栏 / A/B / 装法）· 调研 [`docs/research/open-h3-regenerate-2k.md`](docs/research/open-h3-regenerate-2k.md)。

#### 新超分实现：RelayVSR ×2 / ×4

- **接入**：`video-upscale-relayvsr-x2` / `-x4` 两份清单（Comfy-Org 重打包权重，ComfyUI **原生支持**，不需要自定义节点包）。结构 = 每 15 帧抽一帧过一次**一步 Wan2.2 5B 参考分支**（无文本条件）→ `VSRDecode` 的 Flash 解码器逐帧结合「低清帧 + keyframe latent」输出；音轨不进模型。`x2`（lightx2v 版）与 `x4`（原生 4×）是**两套权重** ⇒ 两份平级清单；自带因果窗口 + int8 K/V cache ⇒ `chunking="internal"`。
- **依赖**：ComfyUI ≥ PR #17511 + `comfy-kitchen ≥ 0.2.41`。权重：`relayvsr_x2_lightx2v_int8_convrot.safetensors` / `relayvsr_x4_int8_convrot.safetensors`（`models/diffusion_models/`，各 5.16 GB）与 `relayvsr_flash_vae_x2_fp32.safetensors` / `relayvsr_flash_vae_x4_fp32.safetensors`（`models/vae/`，各 128 MB）。
- **实测（124 帧 · 1344×768 · 含权重加载）**：×2 → 2688×1536 **25.3s**；×4 → 5376×3072 **83.4s**。同会话对照：像素 U3 ×2 **68.1s**、SeedVR2 3B **187.2s** ⇒ RelayVSR ×2 是像素链路的 **1/2.7**、SeedVR2 的 **1/7.4**。
- **画质（自校准尺子，2K 网格）**：有效宽 **2117（×1.575）**、平坦区闪烁 **1.057**、锐度 192.7；像素 U3 ×2 是 2218 / 0.958 / 193.9，SeedVR2 是 2654 / 1.045 / 311.3 ⇒ RelayVSR 是「**便宜 + 干净**」的一档（1:1 眼判招牌边缘振铃更少），**不是细节最多**。

#### 社区加速与放大（本版重点整理）

- **Pika H3 Flex 6 步**：ref2v **178.8 → 135.9s**、i2v **173.6 → 132.2s**（**1.30–1.32×**），叠原生块稀疏 **84.4s**；两个 1.82GB LoRA 放 `models/loras/`，策略里选 `…-balanced-pika`。
- **PDD 8 步蒸馏**：8 步拿到 20 步以上细节（锐度 +10.3% / +7.9%）：ref2v 184.7s / i2v 178.8s；叠 Sol **137.3 / 134.1s**。
- **Sol-Attn 块稀疏**：成片档 1.27× / 1.25×、balanced 1.23×；fast / 480p 仅 1.03× 且高频 −13.8% ⇒ 低档不要开。
- **SeedVR2 3B**：2K 187.2s（同会话复测）；细节最多、平坦区带颗粒 ⇒ `video.upscale` 的 quality 并列实现。
- **RIFE 补帧**：48fps 124 帧 768×1344 **10.5s**；逐镜补、成片不补。

#### 文档 / 测试

- 新增 `scripts/smoke-regenerate.mjs`（129 项）并接入 `npm run smoke`；新增 `docs/video-regenerate.md`、`docs/research/open-h3-regenerate-2k.md`。
- [`docs/video-upscale.md`](docs/video-upscale.md) 新增 §6.6（RelayVSR 结构 / 依赖 / 实测 / 装法）；README 新增「社区加速与放大技术」速查表。
- 全量 `npm run smoke` 通过（与 CI 发布门同一条链路）。自带 skill 升版：`story-short-generator` **3.9.0**（开场交付规格新增「逐镜重生成 2K / 生成内放大 / 48fps」组合）、`short-drama-series-production` **0.3.0**（`delivery=regen2k`）。

### v1.16.0 — Pika H3 Flex 6 步 · Sol-H3-VAE 解码变体（2026-11-06）

> **升级须知**：本版只**新增**实现，不动既有任何默认。新清单全部 `priority < 0`（不做隐式默认，必须在设置页「＋ 新增策略」里显式挑），所以不下载权重也不会影响你现在的流程。
> 要用需自备两个 Pika 适配器（各 1.82 GB）放 `ComfyUI/models/loras/`；Sol-H3-VAE 变体另需 `sol_h3_vae.safetensors`（6.1 GB）放 `models/vae/`，且 **ComfyUI ≥ 0.44.0**（低版本 `VAELoader` 不认识该权重）。

#### Pika H3 Flex 6 步（ref2v / i2v 的 balanced 并列实现）

- **是什么**：Pika 在 MiniMax H3 上后训练的 **6 步蒸馏**版本，两个 LoRA 适配器（`fl2va` / `ref2va`）跑在同一批 base 上，不是新架构。采样配方固定为 `lcm` + `ManualSigmas`（7 个 sigma = 6 步）+ `BasicGuider`、LoRA `strength_model = 1.0`；**不能接 `MiniMaxH3SigmaShift`、不能叠 turbo / Lightning LoRA**（官方明确会破坏输出）⇒ 与现有 8 步 balanced 是**互斥选择**。
- **新增 12 份清单 + 6 份模板**：ref2v 9 份（`-balanced-pika`、`-ctx-balanced-pika`、`-ctx-balanced-pika-solattn`、`-ctx-balanced-pika-solattn-solvae`、`-fast-pika`、`-fast-pika-solvae`、`-ctx-fast-solvae`、`-ctx-fast-pika-solattn`、`-ctx-fast-pika-solattn-solvae`）、i2v 3 份（`-balanced-pika`、`-ctx-balanced-pika`、`-ctx-balanced-pika-solattn`）。模板在 `scripts/h3-templates/minimax-h3-pika-*.json`，由 `make-h3-variants.mjs` 生成清单。
- **实测（本机 80GB · 1344×768 · 124 帧 · 同 prompt 同 seed）**：ref2v **178.8s → 135.9s**、i2v **173.6s → 132.2s**，即 **1.30–1.32×**，四次重复稳定（8 步 173.4–178.8s / Pika 133.4–136.1s）。叠**原生块稀疏**再快 1.5×（84.4s），但 ref2v 上帧锐度 −11%（i2v 未掉）。
- **中文内嵌字幕：逐字烧出**（2 张角色卡 × 5/14/15 字台词共 3 例，含中文标点），与 PDD 同级；现有 lightx2v 8 步是整段不烧。**但出镜窗由模型决定且随台词长度变化**：短句 2–3s 退场、长句挂到片尾，不跟 prompt 声明的结束点走。
- **链式续接可用**：起链 126.6s / 续接 163.1s，接缝 PSNR **31.0 dB**。
- **fast 档 Pika 4 步**（`-fast-pika`）是**实验实现**：官方只发 6 步 schedule，4 步 sigma（`1.0, 0.948025, 0.8, 0.452381, 0.0`）由 6 步曲线线性插值得来，整镜 ~20s。
- **配置键**：`models.h3PikaLora` / `models.h3PikaFlLora`（env `DSH_SVS_H3_LORA_PIKA` / `DSH_SVS_H3_LORA_FL_PIKA`）；在设置页把某档选成 `…-balanced-pika` 即可。

#### Sol-H3-VAE 解码器变体（`-solvae`）

- **是什么**：NVIDIA 蒸馏的 H3 **纯解码器**（24 层非因果，1.62B），替换原 36 层 decoder。**只能解码**——直接改 `assets.vae` 会在 encode 处报 `'MiniMaxH3VideoVAE' object has no attribute 'quant_conv'`；变体的做法是**另加一个 VAELoader 只喂 `VAEDecode`**（节点 `4b` + 资产槽 `vae_decode`），编码链路仍用 `int8_convrot`。
- **实测**：`VAEDecode` **9.90s → 5.37s（1.84×）**，整镜 −5.7%（balanced 1344）/ −10.5%（标准 fast 832）——**收益由采样占比决定**，短镜与 fast 档更划算。画质 PSNR 41.9 dB(Y)、SSIM 0.985，音轨逐字节相同，无时间偏移。
- **代价**：+6.1 GB 常驻、不能 tile（整片解码，显存随片长/分辨率涨）。配置键 `models.h3SolVae`（env `DSH_SVS_H3_SOL_VAE`）。
- **A/B 两个坑**（写进文档了）：① ComfyUI 按节点输入哈希缓存，同 seed 重跑会**跳过采样**，端到端对比必须换新 seed；② 两臂**编码 VAE 必须一致**，否则采样缓存失效、整镜对比失真。

#### 为什么不做成默认

注册表的可用性预检只查**节点**、不查**权重文件**。把 Pika 设成 balanced 默认，会让没下那两个 1.8 GB LoRA 的环境直接渲染失败；所以它定位为「装了就能在策略里选」的可选实现，默认仍是 8 步。

#### 其它

- `lib/index.js`：两个族的资产表登记 `lora_pika` / `vae_decode`；新增 id 进 `H3_REF2V_IDS` / `H3_I2V_IDS`（否则 `smoke-tier-resolution` 的「每份清单都有 assetOverrides 继承入口」会红）。
- `scripts/smoke-voice-ref.mjs` 的清单计数断言改为**结构断言**（「要么完整声明 `ref_audios`，要么属于 2K / hires 家族」），新增实现不再让它变红。
- `scripts/bench-h3.mjs` 支持打印 `ManualSigmas` / 无 `SigmaShift` 的配方。
- 新增文档：[`docs/research/pika-h3-flex-assessment.md`](docs/research/pika-h3-flex-assessment.md)（落地评估 · A/B · 字幕 · OOM 复现）、[`docs/research/sol-h3-vae-ab.md`](docs/research/sol-h3-vae-ab.md)（节点级计时与三档对比）；`docs/h3-prompt-integration.md` §5.4 补实现级字幕矩阵与新窗口结论。

### v1.15.0 — 短剧制片门 · 集制作包 beat 契约 · Qwen 提示词 skill（2026-11-06）

> 自 `1.14.1` 起的五个批次合并发布。**升级须知**：① 系列模式新增**制片门**（默认开启，`DSH_SVS_PRODUCTION_GATE=off` 可关；只验留痕）；② 新建集制作包必须有 `beats[]` 且每镜 `beatId`（旧包只告警），`targetSeconds` 下限 60 → **30**；③ 新增 `qwen-image-prompt-writing` skill 与两个 `qwen-image-21-t2i-pe-*` 清单；④ `story-short-generator` 升到 **3.8.0**、`short-drama-series-production` 升到 **0.2.0**，自带 skill 会在插件加载时自动刷新到 `~/.dsh/skills/`。

#### 短剧制片门 + 集制作包 beat 契约 + 两处渲染修复（2026-11-06）

- **新增「短剧制片门」**（`lib/index.js` 的 `makeProductionGateListener`，`tools/pre-execute`，**只在工作区有 `series/production-state.json` 时激活**，单片项目零影响）：每镜生成前校验本集 `stage` 已到 `shotlist` 及以后、方案卡（G-P）批准留痕、集制作包与 state 的 `packageVersion`/`scriptVersion` 一致、`assetMode=library` 时资产全部 `locked` 且参考图都带 `params.assetId`。它验的是**留痕**，真实性由新增的 `npm run audit:session` 从会话记录核对；`DSH_SVS_PRODUCTION_GATE=off` 可关。冒烟 `scripts/smoke-production-gate.mjs`（12 项）。
- **集制作包新增 `beats[]` + 每镜 `beatId`**（schema + `validate-episode-package.mjs`）：这是「每个 beat 至少被 1 镜覆盖」的**唯一机械证据**——剧集模式原本没有编号可回指，只能自创 B01…，漏拍一个反转节拍不会被任何检查发现。校验器把「镜缺 `beatId` / `beatId` 不在清单 / 某 beat 无镜覆盖」判错（旧包无 `beats[]` 只告警）。同时 `targetSeconds` 下限 60→30（低于 60 必须在圣经 + state 显式声明例外）。
- **修复「拼接永远走不到 ComfyUI 兜底」**：`runConcat` 用带 `roots` 的探测能选中 ffmpeg 后端，而 `ffmpegConcat` 内部又做了一次**只看 PATH**的无参探测 ⇒ 抛 `concat-no-ffmpeg`，兜底不可达。改为由调用方把探测到的 bin 传进去（回归 `scripts/smoke-concat-ffmpeg.mjs`）。
- **参考音频接受 `canvas:` 前缀**：镜头表按规范写 `canvas:<音频节点 id>`，而工具以前只认裸节点 id ⇒ 门永远比对不上、只能手改两边。
- **镜头表 `画面文案` 升为独立子字段**：它此前会被并进 `字幕`，字幕门把「门牌 / 招牌文字」当成要逐字核的字幕。
- **skill 修订**：`story-short-generator` **3.8.0**（`length` 是请求帧不是交付帧、续接头只在采样期存在且交付已裁掉、`段名:` 行格式、字幕核验留痕 `<N> 帧 / <M> 例`、抽帧不可判读写 `na`、转场镜 ≥73 帧、场景卡按物理场景一张）；`short-drama-series-production` **0.2.0**（S-STEP 0 改为 A/B/C 三套餐 + 微调、样片集删掉「三档成本实测」换成声线听核矩阵、阶段 C 的委托边界与防死循环声明、时长回写改双向、集间硬切写进交付清单）。
- **新增 `qwen-image-21-t2i-pe-{balanced,quality}` 两个清单**：出图图里串了官方 PE 改写器，可以直接用一句短需求生成（skill 与规则见下一条 11-03 条目）。
- **实验与调研**（`docs/experiments/`）：L1 干跑 3 臂（抓到 15 个真问题、12 个已修）、L2 真机 8 镜 + 拼接零重编码、L3 6/6 故障注入全部被拦；装置在 `experiment/` + `scripts/experiment/`（`npm run experiment:selftest`）。另加阿里云 FC GPU 价格 / 运行时可行性调研与 `scripts/fc-cost-model.mjs` 成本模型。

#### 新增 `qwen-image-prompt-writing` skill（2026-11-03）

- **来源**：Qwen 官方 `Qwen-Image-2.1/prompt_rewrite` 的 PE-T2I / PE-I2I `system_prompt.txt`（Qwen Research License）。规则原文未改，只做本地化、工具映射与示例化。
- **内容**：八步骨架（拆题/定画幅/开篇/盘点/走画面/定文字/光照句/单一收尾）、改图属性解耦、画幅决策表（扩图 / 全景 / 三视图 / 多图画布）、五条硬事实（`cfg=1` 无负向提示词、比例不进 prompt、禁质量词、RGBA 固定句柄、图内文字原语种）。
- **检查器**：`skills/qwen-image-prompt-writing/scripts/check_prompt.mjs`（`t2i` / `edit` / `card` 三模式，`--json` / `--strict`，`--self-test` 回归 `references/examples.md` 的完整长度示例）；契约冒烟 `scripts/smoke-image-prompt-skill.mjs` 已并入 `npm run smoke`。
- **与 10-27 决定的关系**：当时「明确不做 7.0.1 Prompt Lint」指的是**视频侧的 hook 门禁**（与门 3 / 失败阶梯重复）；本次是**图片侧 skill 内的离线自查**，不接 `tools/pre-execute`、不 deny、不进片型流程。
- **明确不做**：不加 hook 门禁、不改 `lib/index.js`、不给 prompt 加新字段。

#### 分镜 / prompt 门控最小补丁（A/B 实测后收敛）（2026-10-27）

- **两轮 A/B 结论**（画布 `AB 实验` 组，记录节点 `ea2c7380…`，对照图 `e2e-out/ab/`）：
  - **卡里已有的内容，prompt 否定会换来镜头内形变**：S01 天刑台场景卡本来是玉柱 + 台座，prompt 写 `no pedestal / plain timber post` 后，前 1/3 仍是玉柱、后 2/3 被掰成木柱，台座只削弱未消失。
  - **卡里没有的道具，形状 + 唯一特征 + 三条否定确实有效**：同 seed 下 `a small jade plaque` 出圆头指状玉条/小瓶；补 `flat rectangular + chipped corner + not a bottle/orb/cylinder` 后出带缺角的矩形玉牌（再加 `thin as a coin / face-on` 仅边际改善，且会把镜头推成特写）。
- **落地（最小集，不加新门）**：`story-short-generator` STEP 5.5 扩到**十四项**（第 13 项对白容量、第 14 项**资产—设定一致性**：卡里有台座就按台座写，禁止用 prompt 否定卡内容）；STEP 5 新增**签名道具写法**与 `背景人物` / `画面文案` 两个数据字段（非门禁）；STEP 7 渲染前新增**分镜标记残留复查**；提示词库建议写 provenance（必须放 `note` 区，写进 `## quality` 会被当 prompt 发出）；`h3-prompt-writing` 映射表补三行并澄清 `<Picture N>` 只作来源引用。
- **明确不做**：STEP 6.5 十一项门（与 STEP 6 章节结构重复）、7.0 映射表（与 studio-mapping 重复）、7.0.1 Prompt Lint（与门 3 / 失败阶梯 0.5 重复）、镜头表加两列（七列是契约名）、`≤3 refs` 写成硬限制（`refs.max` = 8，≤3 只是未验证的安全区）。
- 细节见 [`docs/min-patch-prompt-gating.md`](docs/min-patch-prompt-gating.md)。

#### 角色卡改「先三视图、裁正面当单视图」（2026-10-27）

**🎯 两版身份一致性从"两次生成碰运气"变成"按构造成立"**

- **新增能力 `image.crop` + 工具 `image_crop`**：ComfyUI `ImageCrop` 纯像素裁切（`LoadImage → ImageCrop → SaveImage`），**无提示词、无采样器、1:1 像素不缩放**。参数 `image_node`（画布图片节点 id 或图片资产 id）+ `panel`/`panels`（按竖条均分；三视图 ⇒ `panel=0, panels=3` 取正面）或显式 `x/y/width/height`，矩形自动夹进源图边界；可带 `character` / `card_variant` / `paired_node_id` 写角色卡双版本元数据。未分档（唯一实现），`comfy_render(capability='image.crop')` 同一条路径。
- **`story-short-generator` STEP 3 顺序反转**：先出**三视图横排**（16:9、1×3 正/侧/背、全身含脚）→ 自检三视图本体 → `image_crop(panel=0, panels=3)` 裁**正面格当单视图** → 核裁切边界。旧的「两版各自文生图 + 同 seed + 文本锁 + 并排比对」废弃（同 seed 不保证跨画幅一致，实测会出现换发型 / 加配饰）。
- **尺寸**：三视图 `fast` 1024×576 · `balanced` 1344×768 · `quality` 2048×1152；单视图 = 正面格（三视图宽的 1/3）`fast` 341×576 · `balanced` 448×768 · `quality` 682×1152（比例 ≈0.59）。代价：单视图分辨率约为整张 1/3（quality ≈0.79MP，低于旧 2:3 的 1344×2016）；收益：人物占画面比例更大，且**两版必然同源**。**不要再按旧 2:3 尺寸单独生成单视图**。
- **自检口径**：三视图本体查「恰好三格 / 同一角色 / 正侧背可辨 / 全身含脚 / 无分隔线 / 零文字」；单视图查「正面 / 单主体 / 左右边缘无相邻格残留 / 零文字」；三视图不过 ⇒ 重出三视图再重裁，单视图不过 ⇒ 只调裁切矩形。
- **改设定的纪律**：改角色设定只能改三视图，改完必须**重新裁一次单视图**（复用同一 nodeId）并保持 `pairedNodeId` 双向有效。
- **旧资产兼容**：库里已有的 2:3 独立单视图卡继续合法可用（全档）；只有单视图不必回填三视图；只有三视图时先裁一版单视图即可。
- **验证**：`scripts/smoke-crop.mjs`（39 项：矩形收敛 / 清单编译 / 工具面 / 尺寸口径）+ `scripts/e2e-crop.mjs` 真机（三视图 2048×1152 → 正面格 **682×1152**；配对双向、复用 nodeId 重裁不堆节点）。
- **落点**：`lib/manifest.js`、`workflows/image-crop.json`、`lib/index.js`（`computeCropRect` / `runCrop` / `image_crop` / `comfy_render` 分支 / systemPrompt）、`skills/story-short-generator`（SKILL.md STEP 3 + §1.1 + 5.5 第 11 项 + 重生成纪律、`references/{asset-catalog,reference-image-contract,style-selection,single-film-mode}.md`、7 份 `styles/*.md`）、`short-drama-series-production`、`image-generate` / `video-generate` / `h3-prompt-writing` 口径同步。

#### 图片档位默认 balanced · 系列资产台账（2026-10-26）

- **图片档位默认从 `quality` 改为 `balanced`**（单片与连续短剧一致）：文生图长边 1344，≈6s/张；`quality`（2048，≈45s/张）改为按需选择，不再默认。`fast` 仍只用于抽卡。
- **系列资产三层**：资产库（唯一身份权威）/ 系列台账（asset id 索引）/ 每集画布（临时副本）；集制作包加 `params.assetMode=draft|library`，EP01 draft、EP02 起 library。
- **`asset_ingest` 工具**：系列模式下用户批准「入库清单」后由 AI 登记资产（审计字段 / 默认拒绝覆盖 / 幂等）；`asset_ingest` 需重启 DSH 后出现在工具列表。
- **H3 自带 BGM（本期）**：新增 `bgmMode=none|in-model`；镜头表 `BGM` 子字段 → H3 `non_diegetic_music`；实验见 `docs/research/h3-inmodel-bgm-experiment.md`，方案见 `docs/research/h3-inmodel-bgm-plan.md`。
- **修复 `extract_frame` / `extract_audio` 路由**：`extract_frame` 不再被通用 prompt 门禁拦截（`image.from_video` 免 prompt）；`extract_audio` 重新把 `exec` 传给会话解析，不传 `sessionId` 也能用当前会话。与「本机是否有 ffmpeg」无关（ffmpeg 只决定抽音轨后端）。

### v1.14.0 — 声线参考 + BGM + 短剧系列化（2026-10-23）

**✨ 声线一致性：参考音频（H3 Ref2VA `<Audio N>`）**

- 视频参考生成新增 `audio_ref_nodes`（`comfy_generate_video` / `comfy_render`）：≤3 段、每段 2–15s、总 ≤15s、单文件 ≤15MB；支持画布音频节点 / 画布视频节点（自动取音轨）/ `voice:` 资产 / `clip:` 资产。
- 只在 `type='r2v'` 生效且必须同时传 `ref_nodes`；i2v、2K、hires 实现**显式拒跑**（`audio-ref-shape` / `audio-ref-unsupported`），不做静默降级。
- prompt 守卫：传了音频却没写 `<Audio N>`（会被当环境音）、或写了 `<Audio N>` 却没传音频（空绑定），都会给出明确 warning。
- 新增 `extract_audio`：从画布视频节点抽音轨（有 ffmpeg 走 ffmpeg，否则 ComfyUI `LoadVideo → GetVideoComponents → SaveAudio`），产物可直接作声线参考。
- 资产库新增 **`voice` 类型 / `audio` 载体**：音频节点可入库、可 `asset_to_canvas` 物化回画布、可跨会话复用；`asset_list(type='voice')` 可查。
- 时长校验优先读 WAV 头（本机没有 ffprobe 也能校验 2–15s），其余格式降级 ffprobe / 警告。

**✨ 背景音乐：`audio.music` + MiniMax Music 3**

- 新工具 `comfy_generate_music(prompt, duration, lyrics?, seed?, steps?, cfg?)`，产物直接是画布音频节点（44.1kHz 立体声）。
- 新增内置清单 `minimax-music3`（`audio.music`，未分档）：`prompt → caption`、`duration → max_duration`（秒，1–360）、`lyrics` / `seed` / `steps` / `cfg` 注入；纯器乐把 `lyrics` 留空并在 prompt 写 instrumental。
- 能力面新增 `audio.music`，`comfy_render` 可直接按能力调用；音频能力跳过分辨率推导（没有画面尺寸）。

**✨ 画布与资产：音频上传 / 声线分组**

- 画布顶栏「＋ 上传素材」支持图片与音频（wav/mp3/m4a/aac/flac/ogg/opus，单文件 ≤24MB）；纯音频上传默认归 `voice refs` 组，卡片仍可改分组。
- 资产库对话框新增「音频」类型；入库覆盖**四类载体**：图片 / 视频 / 音频 / 文本（kind = image / video / audio / text）。
- 媒体上传路由同时接受图片与音频；`asset_to_canvas` 音频资产 → 画布 audio 节点。

**✨ 短剧系列化（组合式）**

- 新增 `short-drama-series-production`（v0.1.1）：系列圣经 → 集制作包（8 列镜头意图 + 本集资产清单 + 预填参数）→ 委托 `story-short-generator` 的 STEP 3–8 → 每集交付 / 资产台账 / 成本闸门；默认 90s / 9:16 / 中文 / 无字幕 / balanced / 单视图 / batch。
- 剧本层 `short-drama-series-writer` 收编进仓库（自 `0xsline/short-drama`，MIT，v0.2.0）：选题、分集目录、单集剧本与导出，只出文本。
- `story-short-generator` v3.6.1：STEP 0 新增**片型门**（短视频故事 / 连续短剧）——选连续短剧时按「画布 → 资产库 → 工作区」三级查剧本，有集制作包直接从 STEP 3 生产，缺包则转 series skill 补齐；并新增**声线试镜**（STEP 3.5：试镜片段 → `extract_audio` → `voice:` 资产，对白镜带 `audio_ref_nodes`）。

**📝 文档 / 测试**

- 新增调研与设计文档：`docs/research/h3-audio-consistency.md` · `h3-audio-local.md` · `h3-audio-web.md` · `voice-generation-models.md` · `music-generation-models.md` · `audio-capability-roadmap.md` · `audition-voice-pipeline.md` · `docs/h3-voice-consistency-plan.md` · `docs/short-drama-series-integration-research.md`。
- 新增冒烟 `scripts/smoke-music.mjs` / `scripts/smoke-voice-ref.mjs` 并接入 `npm run smoke`；新增真机端到端 `scripts/e2e-voice-ref.mjs`（`npm run e2e:voice`）。
- README / ARCHITECTURE / H3 映射表同步参考音频、试镜规则与 BGM 能力。

**已知限制**：参考音频只支持 r2v 的非 2K / 非 hires 实现；BGM 目前只产独立音轨，loudnorm / 对白 ducking / loop 尚未自动化。

### v1.13.0 — 资产库重命名与不透明 id + 画面内字幕开关（2026-10-23）

**✨ 资产库：重命名 / 不透明 id / 同类型显示名唯一**

- **入库 id 改为不透明随机 id**：新入库资产 id 形如 `character:<16 位 hex>`，入库时生成、**永久不变**；显示名与 id 彻底解耦（老库的可读 id `character:luna` 保留不动，不做迁移，历史引用继续有效）。
- **重命名只改显示名**：资产库对话框新增「重命名」；id、库文件、各会话画布上的 `params.assetId` / `params.model`、文本节点与历史对话里的引用**全部不受影响**，不需要迁移。
- **同类型内显示名唯一**：同类型同名再次入库 = 更新同一资产（沿用原 id、保留 `createdAt`）；重命名撞名返回 409（不同状态也算重名）；不同类型可以同名。
- **state 退到历史字段**：入库 / 重命名界面不再提供「状态」输入；老资产带的值只在分组标题里只读展示，不参与重名判定、不影响任何行为。
- **落点**：`lib/assets.js`（`newAssetId` / `renameAsset` / `findAssetByLabel` / 显示名解析）、`lib/index.js`（`POST /api/assets/rename`、入库按名更新、`asset_list` 输出可读字段）、`studio/app.js`（重命名弹窗、卡片 id / 名字行）、`docs/ARCHITECTURE.md`、`USER-MANUAL.md` 第 11 章。

**✨ 故事短片 skill：STEP 0 新增「画面内字幕」开关（v3.5.0）**

- 开场新增字幕选择：`burned-in` 要字幕（默认）/ `none` 不要字幕（对白照常发声、`<d>` 说话人绑定照写，但不写字幕声明，成片无字幕）。
- 选择贯通镜头表 `字幕` 列、逐镜 prompt 组装、门 3 自检与终检；`audioMode=silent` 时自动 `none`、免问。本流程没有后期字幕轨，改开关要重写受影响镜的提示词并重渲。
- **落点**：`story-short-generator` 的 SKILL.md / meta.yaml（v3.5.0）、插件 systemPrompt 口径。

**📝 文档 / 测试**

- README / USER-MANUAL / ARCHITECTURE 同步资产 id 模型、重命名语义、字幕开关。
- 冒烟：`smoke-assets` 145 项（不透明 id / 同名更新 / 老库兼容 / 重命名 / 唯一性）、`preview-canvas` 91 项（重命名弹窗只有显示名、请求体不含 state、id 不变）。

### v1.12.0 — 角色卡双版本 + 提示词库 + 资产名 + 参考图选择器（2026-10-22）

**✨ 角色卡：每个角色固定出「单视图 + 三视图」两版**

- **出卡规则**：每个角色都出 `single` 单视图正面全身（2:3、纯底、零文字）与 `three` 三视图横排（16:9、正 / 侧 / 背 1×3、纯底、零文字）；两版共享同一份角色设定与风格锁，用 `character` / `cardVariant` / `pairedNodeId` 配对（`comfy_generate_image` 新增 `character` / `card_variant` / `paired_node_id` 参数，两节点互记配对 id）。
- **视频引用版本由 STEP 0 用户选择**：`canvas_set_state(characterCardVariant='single'|'three')`；`fast` 只能 `single`，`balanced`·`quality` 可选 `single` 或 `three`。`comfy_generate_video` 的 `ref_variant` 只接受显式 `single` / `three`（不再有 `auto`），每镜按 state + 当次 tier 传入。**非 fast 档若自检发现参考图形态类污染**（多角色副本 / 参考图版面或文字被投影 / 环境材质被替换）→ **传 `ref_variant=single` 重渲本镜**（同 prompt / 同 seed 优先），再走 prompt 失败阶梯。
- **自检**：两版都查（单视图单主体、三视图恰好三格同一角色），并新增**跨版本一致性**核对（脸 / 发型 / 身材 / 服饰主色 / 签名道具）。
- **落点**：`story-short-generator` v3.4.0（STEP 0/3/5/5.5/7/门 3/重渲纪律）、`reference-image-contract.md`、`image-generate` / `video-generate` / `h3-prompt-writing` 的口径与插件 systemPrompt。

**✨ 视频提示词分档持久化（prompt bank）**

- **每镜一份画布文本节点**（group `shot prompts`，标题如「S01 提示词（分档）」），用 `canvas_write_prompt_bank` 写入 `fast` / `balanced` / `quality` 三段；**三档写同一份完整 quality 提示词（逐字一致）**，换档只变采样。工具本身仍支持三段不同内容。
- **生成时传 `prompt_node`**：`comfy_generate_video` / `comfy_render` 按本次 `tier` 读对应段；缺该档自动回退最近较低档（没有则较高档）并在 `warnings` 说明。生成后工具把本次实际 prompt **回写该档段**，所以每次生成的提示词都落在画布上。
- **升档重渲**：复用同一个 `prompt_node` + 新 `tier`（或同一视频 `nodeId` 重渲且不传 prompt，工具会读回该镜提示词库）——不重写、不手抄旧 prompt。
- **只传 `prompt` 也兼容**：视频工具会自动创建 / 更新提示词库节点并返回 `promptNodeId`（`persist_prompt:false` 可关闭），后续升档用该 id。
- **新增工具**：`canvas_write_prompt_bank` / `canvas_get_prompt`；`comfy_generate_video` / `comfy_render` 新增 `prompt_node` / `persist_prompt` / `prompt_group`，视频工具另加 `ref_variant`（显式 `single` / `three`，由 STEP 0 用户选择驱动；fast 只能 single）。H3 结构化质检门同步支持从 `prompt_node` 取段校验。
- **落点**：`lib/index.js`（prompt bank 解析 / 回退 / 自动持久化 / 工具 / 质检门）、`story-short-generator` v3.4.0、`brand-promo-video-generator` v1.3.0、`video-generate` v1.2.0、`docs/prompt-bank.md`、`scripts/smoke-prompt-bank.mjs`。

**✨ 提示词库策略更新（全档位共用 quality，同日追加）**

- **策略变更**：每个镜头的 `fast` / `balanced` / `quality` 三段**都写同一份完整 quality 提示词（逐字一致）**；换档只改变采样预算，不再更换 prompt。
- **写入方式**：先写一份 quality prompt，再用 `canvas_write_prompt_bank` 原样复制到三段；不再为 fast / balanced 另写精简版。
- **工具不变**：`prompt_node` 仍按 tier 取段，三段同文时读到的都是同一份 quality 文本；缺档回退机制保留，正常流程不会触发。
- **旧库迁移**：已有三档不同文案的 `SXX 提示词（分档）`，先读 quality 段，再用 `canvas_write_prompt_bank(nodeId=…, prompts={fast:q, balanced:q, quality:q})` 统一；Skill 已把这一步写进流程。
- **依据与边界**：1 seed pilot 显示“全档同文”不会崩，但 fast 档会出现构图拉宽、人物变小，quality 档的表演落点也可能偏移；因此这是**流程策略选择**，不是“全档更优”的保证。生产仍以门 3 自检的动作/走位/景别为准。


**✨ 资产库命名支持中文**

- `slugifyName` / `normalizeAssetId` 从「只允许小写英文/数字」改为允许 **Unicode 字母/数字（含中文）** + `. _ -`：中文标题不再被吃掉，`POST /assets` 可直接登记 `character:小狐狸` 这类资产 id；文件名为 `character-小狐狸.png`，跨会话 `asset_to_canvas` / `ref_nodes` / `/media` 均按 URL 编码正常工作。
- 画布入库表单的默认名与提示同步改成「中文 / 英文 / 拼音都可以」；非法名（如含冒号）仍返回 400 并说明规则。

**✨ 输入框图片 / 视频参考图支持从画布与资产库选取**

- 「🎨 图片 · 图生图参考图」与「🎬 视频 · r2v 参考图 / i2v 首末帧」的「＋」现在打开统一选择器：**从画布已有图片节点、资产库图片资产、本地文件**三处取图。
- 画布节点是**引用**：移除时不删除原画布卡；资产库图片会先物化到画布，移除时只删这份物化副本；本地文件仍按原逻辑上传落画布。
- 资产库选择器只列图片类资产（角色 / 场景 / 风格锚点），视频 / 文本资产不会出现在参考图列表里。

### v1.11.0 — 片段审查节奏可选：逐镜审查 / 批量审查（2026-10-12）

**✨ `story-short-generator` v3.2.0 · 新增开场选项：门 3 的人工确认时机可配**

- **STEP 0 新增「片段审查节奏」选项卡**（第 8 项）：`per-shot` **逐镜审查**（**默认推荐**——每渲完一镜 AI 自检 + 人工确认，确认通过才渲下一镜；坏镜头当场发现、返工不连锁）/ `batch` **批量审查**（全部正片 + 转场镜渲完、自检全过后出**一张批量审查卡**一次批准；人力往返最少，代价是坏镜头晚发现，且**续接链上的重渲会成串**）。
- **AI 自检在两种模式下都逐镜执行、不许推迟**——批量审查省的只是「人工确认次数」，不是「自检次数」。门 3 自检第 3 项（口型 / 字幕字准）不过关时，两种模式都**当场**弹单镜处置卡，不压到批量卡里；「同一镜连续 3 次失败」的求助门同样保留。
- **持久化**：`canvas_set_state` 新增 `reviewMode`（`per-shot` | `batch`，缺省 `per-shot`），画布头部显示「审查 逐镜 / 批量」；STEP 7 渲染前 `canvas_get_state` 读回，**中途可改**（改 state 即生效，已渲片段不重做）。
- **批量模式的纪律**：批准以**整卡**为单位（不接受部分批准——要改就重渲选定镜，然后**只列受影响片段**重出批量卡）；片段收集、转场镜、拼接、重渲连锁纪律都按 `reviewMode` 分支描述。
- **未改动 `brand-promo-video-generator`**：品牌片当前没有逐镜人工门（片段后一次确认），本次不动，两侧口径保持各自现状。
- **落点**：`story-short-generator` 的 SKILL.md（STEP 0 / 1 / 7 渲染前的门 / 门 3 / 转场镜 / 片段收集 / STEP 8 拼接 / 选项卡纪律 / 重渲连锁纪律）与 `meta.yaml`；插件 `canvas_set_state` 工具 schema、画布头部元信息。

### v1.10.0 — 角色卡形态分档：单视图 / 三视图横排随视频档位（2026-10-10）

**✨ `story-short-generator` v3.1.0 · 规则变更：角色卡默认形态跟着项目视频档位走**

- **`fast`** → **单视图正面全身**（一图一人）；**`balanced` / `quality`** → **三视图横排**（正 / 侧 / 背全身，1×3，纯底、零文字）。判定键是 STEP 0 选定、`canvas_set_state(mode=…)` 持久化的**视频档位**（不是图片档位——图片档位只决定采样尺寸）。
- **`fast` 档的形态门禁 G-ref 不变**，仍按**每次调用实际传入的 `tier`** 判定；**混合档位下最常见的踩线点**是非 `fast` 项目里把某镜临时降到 `fast`——该镜要么升档、要么临时补一张单视图。
- **只改角色卡**：场景卡、道具卡**不随档位改形态**（仍单视图）——多视图对这两类资产在非 `fast` 档没有实测依据。
- **卡片画幅**：单视图 2:3 竖版（`fast` 672×1024 · `balanced` 896×1344 · `quality` 1344×2016）；三视图 16:9 横版（`fast` 1024×576 · `balanced` 1344×768 · `quality` 2048×1152）。尺寸按图片档位长边推导，32 对齐。
- **依据**：`fast` 档多主体参考图必漏（角色卡 4 身体 → 成片 5 个实例）；`balanced` 档角色卡、`quality` 档三视图实测均**只出 1 个角色**，且「档位 vs 实现」混淆已由钉实现实验拆开（差异跟档位 / 采样配置，不跟实现家族）。完整矩阵见 [`reference-image-contract.md`](skills/story-short-generator/references/reference-image-contract.md)。
- **待补证**（已登记在契约 §4）：`balanced` 档的三视图横排、`quality` 档的角色卡布局尚未单独实测——按多主体 + 纯底 + 零文字的共性外推。
- **落点**：`story-short-generator` 的 SKILL.md（STEP 0 / 3 / 4 / 4.5 / 5.5 / 7、参考图形态与档位节）、`references/{asset-catalog,reference-image-contract,style-selection}.md`、7 份 `references/styles/*.md`、`meta.yaml`；`image-generate` / `video-generate` / `h3-prompt-writing` 的口径同步；插件 systemPrompt 的「参考图硬规则」同步。

### v1.9.0 — skill 改名 `story-short-generator` · 七套视觉风格 · 道具卡 · 参考图形态门禁（2026-10-08）

**⚠️ 破坏性变更：自带 skill 改名**

- `3d-animation-short-generator` → **`story-short-generator`**（目录名与 frontmatter `name:` 同步改）。原因：新增**电影真人写实 / 吉卜力 2D 手绘**等风格后，「3D」已名不符实。
- **升级后一般无需手动清理**：`syncBundledSkills` 新增**孤儿回收**——目标端带本插件安装戳、但源 bundle 里已无同名目录的 skill 会被自动删除。安全底线：**无安装戳的目录（非本插件安装）永不删**；**你改过的副本默认也不删**，只提示（`DSH_SVS_SKILL_REFRESH=force` 才强删）。
- 如果你**改过**旧 skill 副本（或在别处装过同名 skill）：确认不需要后手动 `rm -rf ~/.dsh/skills/3d-animation-short-generator`。

**✨ `story-short-generator` v3.0.0**

- **七套内置视觉风格**（STEP 0 可选，默认 `pixar-3d` = 旧行为）：皮克斯感 3D / 电影真人写实 / 吉卜力 2D 手绘 / 日式二次元赛璐璐 / 水墨东方古风 / 欧美漫画半调 / **国风仙侠 3D**（`guofeng-xianxia`，仙侠 / 修真 / 玄幻）。**一风格一文件**（`references/styles/<id>.md`，8 段固定模板，含可直接复制的英文风格锁后缀），选型指引与换风格纪律在 `references/style-selection.md`。原全局写死的风格锁（含「不要写实真人摄影」——与真人风格直接冲突）已按风格拆分。
- **风格锁后缀按产物取用（抽卡实测换来的规则）**：后缀拆成 **锁 A 渲染基调**（无角色词也无场景物件词，通用）/ **锁 B 角色与表演**（角色卡 + 视频）/ **锁 C 环境与氛围**（场景卡 + 视频）。**污染是双向的**——角色词会让空场景冒出人物（`anime-cel` / `ink-wash-oriental` / `comic-halftone` 的场景卡均复现），环境词会让纯底角色卡长出松树石台与光束（`guofeng-xianxia` 复现）。⇒ 场景卡/道具卡不带 B，角色卡不带环境段。
- **新增道具卡**（STEP 4.5 + 画布分组 `prop cards`）：签名道具单独建卡并可进 `ref_nodes`，避免形状 / 材质逐镜漂移。**收编为单视图单件**（`film-assets` 的多视图道具卡不适合本流程的参考绑定）。资产库无 `prop` 类型，入库推荐归到 `scene`（id 形如 `scene:prop-<name>`）。
- **参考图形态门禁 G-ref（仅 `fast` 档）**：实测确认「多主体参考图出副本」是 **`fast` 档特有**现象——`fast` 档下角色卡出 5 个、一图两身体出 3 个、三视图让环境被换材质、设定图被投影成墙纸；**`balanced` / `quality` 档全部只出 1 个角色**（同一 prompt、同一 seed）。故 `fast` 档强制「单主体 / 单视图 / 零文字 / 无拼图」，不通过则不出图、给四个出路。完整矩阵与结论强度见 `skills/story-short-generator/references/reference-image-contract.md`（**「档位 vs 实现」混淆已在随后一轮钉实现实验中拆开——差异跟档位/采样配置，不跟实现家族；每格 N 仍小，属方向性证据**）。
- **新增资产目录** `references/asset-catalog.md`（角色卡 / 场景卡 / 道具卡 / 风格锚点 / 片段 / 文本：形态规范、生成要求、自检项、入库限制）。
- **图片档位独立于视频档位，默认 `quality`**（2026-10-26 起默认改为 `balanced`；本条为 v3.0.0 历史记录）：STEP 0 新增「图片档位」选项卡（与「生成档位（视频）」分开）。图片默认走 **`quality`**（长边 2048）——卡片是全程复用的身份 / 环境锚点，细节不够会连带重做镜头表、分镜与已渲片段。`balanced` / `fast` 只用于抽卡试构图，**其产物不得直接锁定**（锁定前须用选定档位重出定稿）。原「生成档位」一项现在明确为**视频档位**。
- 镜头表自检门从**十项扩到十一项**（第 11 项：按当前档位的参考图形态合规）；门 3 自检新增第 6 项（风格一致）；终检新增道具一致性与风格一致性。

**📝 文档 / 其它**

- 插件 systemPrompt 的「参考图硬规则」改为**档位限定**表述（原文把 `fast` 档的结论当成了普适规则）。
- [`docs/three-view-experiment.md`](docs/three-view-experiment.md) **追加**「补记：档位维度」——原实验全程只跑 `fast`（`mode=fast`、4 步 Lightning LoRA、832×480），结论**未被推翻**，只是缺档位维度。
- README 实战要点 1–3 同步档位限定；`scripts/smoke-skill-install.mjs` 新增 4 组孤儿回收用例（含「无戳目录永不删」安全底线）。

### v1.8.1 — 仓库不再跟踪 pnpm 本地缓存（2026-09-29）

> **包内容零变化**：本版只动仓库卫生（`.gitignore` + 取消跟踪），`lib` / `studio` / `skills` / `workflows` / `schemas` 与 v1.8.0 完全一致，升级无行为影响。

**📝 文档/其它**

- 仓库不再跟踪 **`.pnpm-store/`**：pnpm 在本机默认把 store 建在**项目根**（`.pnpm-store/v10`），这个 31 MB / 2315 个内容寻址文件的纯下载缓存因 `.gitignore` 漏配规则被一次 `git add -A` 误入库、并随 v1.8.0 推到远端。本版补上忽略规则并 `git rm -r --cached`，磁盘缓存与 `node_modules` 原样保留。
- 顺带说明为什么此前没被发现：`package.json` 的 `files` 白名单本就不含它，npm tarball 一直是干净的——污染只在仓库体积（`.git` 里 25.6 MB）。历史清理需重写历史 + force push，本版未做。

### v1.8.0 — 统一档位与工具面（图片并入 tier · 不再接受 `workflow=`）· Qwen-Image 2.1 接入 · 超分尺寸契约（2026-09-24）

> ⚠️ **破坏性变更**：① `comfy_render(workflow=…)` / `video_upscale(workflow=…)` 会**报错并指路**——实现改由配置决定（`preferred` 家族序 / `tiers` 档位选择 / `pins` 钉实现）；② 图片清单 id 由 `flux-text2image` 变为 `flux-text2image-{fast,balanced,quality}`（一档一清单）；③ 旧参数 `mode=` 已移除，档位一律用 `tier=`。

**✨ 新增**

- **Qwen-Image 2.1 接入**（文生图 + 图生图，各三档共 6 份清单）：官方模板图结构（`UNETLoader → TextEncodeQwenImage21 → KSampler`，i2i 多一层 `QwenImage21Cache`），需要 ComfyUI ≥ v0.37.0；原生 2K（1:1 2048² / 16:9 2752×1536 / 9:16 1536×2752 实测 63–65s，int8 三件套 ≈16.1 GiB）。i2i 参考图可传 **10 张**，`ref_nodes` 按 1 起的槽位 `images.image_N` 映射。
- **图片与视频统一到同一套档位体系**：图片能力从「未分档 + `mode` 轴」并入 `tier`（`fast` / `balanced` / `quality`，一档一清单、`group` = 家族）。图片长边 1024 / 1344 / **2048**（t2i），i2i 按档注入**参考图重采样预算** 768 / 1056 / **2048** ⇒ **i2i 首次能出 2K 改绘**。
- **清单由模板生成**：`scripts/image-templates/*.json`（4 个家族）→ `scripts/make-image-variants.mjs` → 12 份 `workflows/<家族>-<档位>.json`；`--check` **已进冒烟链**（产物与模板漂移即失败）。
- **配置面「钉实现」`pins`** + **`preferred` 升级为家族序**：`pins["image.text2image"]="qwen-image-21-t2i"`（家族名或实现 id，跨档冲突会报错）；原有 `preferred: ["qwen-image-21-t2i"]` 这类**家族名写法零改动继续生效**。
- **视频超分尺寸契约**：`upscale.sizing`（`factor` = 交付 = 源 × 倍率；`short-side` = 交付由实现的目标短边推导，`target_width` 变成**让模型按目标渲染**）与 `upscale.chunking`（`caller` 可被外层分块 / `internal` 自带跨帧时间窗、外层不切）；**SeedVR2 实现 `video-upscale-seedvr2-3b` 随包发布**（v1.7.0 文档提到过、当时未随包）。
- **设置页**：**默认只列策略与名称**，档位表单点该策略的「编辑档位」才展开（内置默认那条＝一次配齐逐档实现，保存为逐档显式选择；另有「恢复跟随首选」）；后端新增 `effective` 矩阵，设置页标题/摘要/表单预填与实际执行**同源**。

**🐛 修复**

- **删除「按 mode 名隐式挑实现」路径**——它是「同一请求被悄悄换成另一个模型」的根因（实测踩过：漏传 `workflow` 时落到了别的模型）；未分档能力现在只按 `preferred` / 候选序取一个，并**明确告警忽略请求档位**。
- **交付尺寸如实记账**：产物落盘后读真实像素回填节点 `width`/`height`（i2i 不再把名义 1344×768 记成交付尺寸），与首遍尺寸不同时另记 `graphWidth`/`graphHeight`。
- **未支持参数显式告警**：调用方传了、实现没有注入点的参数进 `warnings`（工具返回 + 节点 `params.warnings`），不再静默丢弃（如 Qwen 清单的 `guidance`、i2i 的 `width`/`height`）。
- **只传一边宽高不再被静默忽略**：另一边按画布比例推导（此前只有 `width && height` 同时给才生效）。
- **图片分辨率跟随画布比例**：图片清单改用 `policy: "aspect-ratio"`（此前 `explicit` 下画布 9:16 对图片无效，竖版必须每次显式传宽高）。

**📝 文档/其它**

- 新增 [`docs/unified-tier-tool-design.md`](docs/unified-tier-tool-design.md)（统一档位与工具面的设计定稿 + 决策记录 + 滚动状态）与 [`docs/open-issues.md`](docs/open-issues.md)（登记已查证但暂不实施的问题，首个条目＝ 3d skill 的角色卡/场景卡未定义档位与尺寸）。
- README 全面同步：去掉 `workflow=` / `mode=` 旧口径，补图片档位表与「工具面只认 capability + tier」契约。
- 冒烟链加入 `variants:check`；新增 `npm run e2e:tier`（真机跑 t2i/i2i/video 三能力并核对记账）；设置页走查支持 `--edit-builtin` / `--block=<capability>` 局部截图。

### v1.7.0 — 两阶段放大（hires / >2K）· 视频超分（U3）· `resolutionLock`（2026-09-23）

**✨ 新增**

- **视频补帧 `video.interpolate`（VFI）**：新能力 + 新工具 `video_interpolate(video_node, target_fps?, multiplier?)`。输入是画布上**已有的视频节点**，RIFE 整数倍补帧（×2–×16），音轨直通、分辨率不变；**D2 尾部补齐**让母版帧数 = 源帧数 × 倍率、时长严格等于源。非整数倍目标（24→60、24→30）先出整数倍母版，再由 **ffmpeg 抽取**到目标帧率（`ffmpeg` 解析顺序：env → 配置 `ffmpegPath` → **PATH（全局安装）** → 从工作区/插件包根逐级向上找 `tools/ffmpeg`；全局装了就直接用，要钉版本用前两项显式指定）。`video_concat` 新增**帧率一致性守卫**（混帧率拼接会半速播放且不报错，现在直接拒绝）并记录 `fps/width/height/length`。权重 `rife_v4.25.safetensors`（21.6 MB，ComfyUI `models/frame_interpolation/`）。实测 124 帧 768×1344：×2 **10.5s**、×5 **21.0s**。详见 [`docs/video-interpolate.md`](docs/video-interpolate.md)。
- **视频超分 `video.upscale`（U3）**：新能力 + 新工具 `video_upscale(video_node, …)`。输入是**画布上已有的视频节点**（不是提示词），逐帧 CNN ×2 / ×4，**音轨原样带回**（全程不经过模型，也不占 H3 的 token）。内置像素链路 `video-upscale-x2`（`RealESRGAN_x2.pth`）/ `video-upscale-x4`（`RealESRGAN_x4.pth`），模型走资产槽 `upscale_x2` / `upscale_x4`（**换权重必须换同倍率的**，倍率写死在权重里）；另有**扩散式**的 `video-upscale-seedvr2-3b`（SeedVR2，ComfyUI 原生支持、无需自定义节点；**交付尺寸直接喂模型**所以 `target_width` 真驱动；`priority=-20` 不做隐式默认；实测 124 帧 2K **483.4s** vs U3 的 **69.0s**，细节更多但平坦区会注入细颗粒）。交付尺寸 = **源尺寸 × factor**，可用 `target_width` 收敛（按 32 对齐）；**比例永远跟源片**——H3 族是 1.75:1，所以 4032 宽对应 **4032×2304**，不是 16:9 的 3840×2160。逐帧独立 ⇒ 代价线性、**天然可分块**，长片按 `ImageFromBatch` + `TrimAudioDuration` 切块再拼回（**不需要 ffmpeg**）。实测 124 帧：原生→×4→4032 **241.3s**；U1 的 2K→×2→4032 **261.6s**；248 帧 5376 一次过 **551.4s**（无 OOM）。详见 [`docs/video-upscale.md`](docs/video-upscale.md)。
- **两阶段潜空间放大（hires）**：`minimax-h3-ref2v-hires` / `minimax-h3-i2v-hires`（仅 `quality`，`priority: -50`）。**开源版 H3 原生上限就是 768p**，往更高直接采样会出复制伪影 ⇒ 首遍 **896×512** 解运动/构图/声音 → 视频 latent **×1.5** → 二遍 **denoise 0.35** 重建细节，交付 **1344×768 带声音**（音频 latent 全程未被放大、二遍不进音频分支）。模板由 `scripts/make-hires-template.mjs` 从 ref2v/i2v 两个 base 各自派生，两阶段尾段逐字节一致。详见 [`docs/hires-two-pass-upscale.md`](docs/hires-two-pass-upscale.md)。
- **>2K：学习式潜空间放大 + 链式续接**：`minimax-h3-{ref2v,i2v}-ctx-{quality,quality-pdd2,balanced,fast}-2k`（8 份在役；`-balanced-pdd-2k` 一对已弃用）。hires 的插值放大器只能把首遍**拉回**原生 768p，要**超过**原生上限，放大器必须在 latent 空间真造细节 —— 用 `MinimaxH3LatentUpscaler3DRefineHandoff`（`custom_nodes.Comfyui_Minimax_h3_latent_Upscaler`，权重 `minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors`，本机已装）做 ×2 放大 + 低 σ（denoise 0.3）精修。**首遍尺寸不锁**（`resolutionLock: { scale: 2 }`）：图内目标尺寸是算术模板 `"${width * 2}"`，跟着画布比例 × 档位长边走 ⇒ **16:9 / 9:16 / 1:1 都支持**——16:9 交付 **2688×1536**（`fast` **1664×960**）、9:16 交付 **1536×2688**（`fast` **960×1664**）、1:1 交付 **2688×2688**（`fast` 1664×1664，像素量为 16:9 的 **1.78×**，最重）。`priority: -60`、各档一份清单、`maxDurationFrames: 124`（精修在 ≈500k token 上超线性）。跨比例**不能**链式续接（判据是首遍尺寸一致）。⚠️ **1:1 显存余量薄**：`fast` 档 124 帧实测峰值 72.6/79.2 GiB（余量 6.6 GiB）且另有一次被中断 ⇒ 1:1 尽量压帧数；高分辨率档的 1:1（2688×2688）未实测。详见 [`docs/learned-latent-upscale-2k.md`](docs/learned-latent-upscale-2k.md)。
- **`resolutionLock` 清单字段**（两种形态）：① **图锁定** `{ graph, scale, note }` —— 首遍尺寸是图结构的一部分，不能被显式 `width`/`height` 或画布 `aspectRatio` 覆盖（hires 族用这种，只支持 16:9）；② **只锁倍率** `{ scale, note }` —— 首遍照常推导，交付 = 首遍 × scale（2K 族用这种，支持任意比例）。两种形态都**交付 = 首遍 × `scale`**，并**强制带一条 `warnings`** 如实说明首遍与交付的关系（不静默）。`video.upscale` 则相反：尺寸跟着输入视频走，**必须**声明尺寸来源（`upscale.sizing` + `factor` / `shortSide`）且**不得**声明 `resolutionLock`（两者语义互斥，校验器会拒）；`sizing='short-side'` 时还必须留 `params.out_short_side` 注入点，且 `upscale.chunking` 决定显存归谁管（`caller` / `internal`）。契约见 [`docs/tier-strategy-design.md`](docs/tier-strategy-design.md) §2。另新增 `constraints.maxDurationFramesByRatio`（如 `{"1:1": 56}`，**只声明不强制**：渲染不被拦，供 UI/文档/排障提示）——`maxDurationFrames` 是单一数字，表达不了「同一实现在某些比例下余量更小」，所以给 1:1 单独留了个结构化出处；只对实测过的档声明，未实测的不编数字。校验器对比例键做 fail-closed（写错会被判非法，否则静默失效）。

**🔧 修正**

- **「两阶段放大不能与链式续接叠用」是错的**：正确判据是「**同一条链内首遍尺寸一致**」。放大发生在链式存档**之后**（`MiniMaxH3MotionContextSaveLatent` 读的是首遍采样器输出）⇒ 链上流动的永远是首遍 latent，**交付尺寸不参与续接**——一条链里可以有「首遍相同、交付不同」的镜（`-ctx-quality` 1344×768 接 `-ctx-quality-2k` 2688×1536），首遍不同则显式拒跑。runner 按此实现（`chainGraphMismatch`，纯函数）。
- **PDD 清单补 `MiniMaxH3PDDAccApply` 依赖声明**：`minimax-h3-i2v-ctx-balanced-pdd` 及其模板此前漏声明该第三方节点，缺节点时可用性预检会**假装可用**。现已在 `requiresNodes` 补上（缺节点如实置灰，不静默回退）。

**✅ 验证**

- 新增 `scripts/smoke-hires-lock.mjs`（`resolutionLock` 语义 + 插值/学习式两阶段图结构 + 通用契约块：枚举所有带锁的实现）、`scripts/e2e-hires.mjs`、`scripts/e2e-upscale.mjs`、`scripts/smoke-upscale.mjs`、`scripts/probe-2k.mjs`、`scripts/probe-2k-aspect.mjs`（画幅比例出片探针，独立进程直连 ComfyUI 以绕开插件的模块缓存）、`scripts/probe-pdd-sigmas.mjs`、`scripts/analyze-2k-detail.mjs`、`scripts/compare-crops.py`。
- `scripts/smoke-tier-resolution.mjs` **109 断言**、`scripts/verify-h3-variants.mjs` **154 断言**（各份单档清单的 id/档位/尺寸/可编译性），全部通过。
- 新增实测报告：[`docs/2k-pdd-ab-verdict.md`](docs/2k-pdd-ab-verdict.md)（2K + PDD 的 56/124 帧 A/B：全长 **2.02×**、画质持平且判据略优、**音轨逐样本相同**）。
- **画幅比例实机出片**（`fast` 档，产物尺寸从 mp4 box 直读，不信工具自报）：**9:16 → 960×1664 带音轨，638.5s**（首遍 480×832；像素量与 16:9 相同 ⇒ 解比例零代价，耗时落在 `estSeconds` 口径上）；**1:1 → 1664×1664 带音轨，992.8s**（22 / 56 / 124 帧都出片）。⚠️ 1:1 峰值显存 72.6/79.2 GiB（余量仅 6.6 GiB，另有一次运行被中断），且耗时是 `estSeconds` 的 **1.6×**——`estSeconds` 是 16:9 · 124 帧口径，UI 原样显示、**不按帧数或画幅修正**；高分辨率档的 1:1（2688×2688）与 9:16 未实测。

### v1.6.0 — 资产库支持三种载体 · 可删除（2026-09-18）

**✨ 新增 / 改进**

- **入库不再只管图片**：此前只有 `kind === 'image'` 的节点才有「入库」按钮，视频片段、镜头表、分镜文档、提示词这些同样值得跨会话复用的产物只能干看着。现在 **图片 / 视频 / 文本 / 表格** 节点都有「入库」按钮（生成失败、已作废的节点也照有——入库只看节点类型，不看生成状态）。
- **载体（kind）与语义类别（type）拆成两个正交维度**：`type` 决定资产库里的分组与用途（角色 / 场景 / 风格锚点 / 视频片段 / 文本），`kind` 由 type 推导（`character|scene|style → image`、`clip → video`、`text → text`）并决定**怎么存、怎么取回、能不能当 ref 参考图**。两个直接收益：
  - 入库表单的**类型下拉按节点载体收窄**——视频节点只给「视频片段」，文本节点只给「文本」，图片节点仍是「角色 / 场景 / 风格锚点」。服务端还会再校验一遍（比如「视频节点 + 角色卡」直接 400 并说明允许的类型），避免库里出现语义错位的记录——agent 拿到一条 `character:xxx` 会当成参考图去驱动生成，必然失败。
  - `resolveAssetImagePath` 现在**硬性只认 image**，视频/文本资产永远不会被当成 `ref_nodes` 图片传给 ComfyUI；视频/文本要走 `/media?asset=` 时改走 `resolveAssetPath`（此前该路由只认图片，视频资产会 404）。
- **文本资产不落文件，存正文**：入库 `text`/`table` 节点时保存 `text` + `title` + `nodeKind`，取回画布时按 `nodeKind` **还原成 text 还是 table**——表格类资产取回来仍是表格，不会退化成纯文本。
- **资产库可删除**（对话框每张卡片新增「删除」，二次确认）：删除索引的同时**清理库文件**，但有两个安全边界——① 仅当库里没有别的记录引用同一文件时才删（同图多状态/多名字的情况不会误删）；② **画布上已取用的副本不受影响**（它们是各自独立的文件），确认文案里写明了这一点。删除接口是 `DELETE /api/assets?id=…`，返回 `fileDeleted` 说明是否连带删了文件。
- **对话框按载体渲染缩略图**：图片用 `<img>`，视频用 `<video>`（右上角挂「🎬 视频」角标，取不到时回落成「🎬 视频缺失」），文本资产不请求图片、直接把正文摘要显示在缩略图位（6 行截断）。
- **顺带修掉一个 500**：入库名不合法（如含冒号的名字）时 `normalizeAssetId` 抛的是普通 `Error`，路由没转成 `HttpError`，前端拿到的是 500 而不是带原因的 400。（中文名已从「非法」改为合法，见 v1.12.0。）

**🎨 走查中量出来并修掉的两处**

- **「＋ 加入画布」被挤成两行**：加上「删除」按钮后卡片里两个按钮共 144px，实测卡片宽 172.5px 时主按钮只剩 92.5px，文案折成 2 行（截图走查发现，随后改为量 `Range.getClientRects()` 的行数断言）。把资产网格最小列宽 168px → **190px**（主按钮 154px）并加 `white-space: nowrap`，两套主题下按钮都是单行。
- **缩略图占位文字在浅色主题不达 AA**：`.thumb .missing` 借用 `--muted`，而缩略图底色两套主题都是纯黑——浅色主题的 `--muted`（`#5c6470`）压黑底实测只有 **3.51:1**。新增与主题无关的 `--media-fg`（`#aab2bf`，黑底上 ~9:1）。这是**存量问题**，只是此前没有测到资产库对话框。

**✅ 验证**

- 新增 `scripts/smoke-assets.mjs`（**77 项**）：隔离 HOME/配置/skill 目录后 `apply()` 起**真路由**，对 `handleApi`/`handleMedia` 发真请求——覆盖三种载体的入库、非法组合（视频+角色卡、audio 节点、空文本节点、非法名）分别落到 4xx、`GET /assets` 给老记录补 `kind`、视频资产 `/media` 的 content-type 与字节、`to-canvas` 三种产物化（视频→video 节点、文本→text、表格→table）、删除（含**共享文件不误删**、最后一条引用才删文件、文件本就不存在时不报假的 `fileDeleted`）、以及 v1.4 旧库（只有 `{type, image}`）的兼容与覆盖登记不残留旧字段。
- `scripts/preview-canvas.mjs` **46 → 82 项**：新增真浏览器交互段——打开资产库对话框核对三种载体的缩略图分支、分组、按钮与危险色，**开着对话框切浅/深主题**并复测对比度，点删除走确认→确认后列表与分组同步消失（并断言真的发出了 `DELETE`）；再逐个节点核对「入库」按钮的有无与三个下拉的选项集合；正文可滚动、滚到底最后一张卡完整可见；按钮行数与截断用 Range 行盒实测。
- 两个新截图：`e2e-out/ui/canvas-asset-library{,-light}.png`、`canvas-asset-register.png`。

### v1.5.0 — 画布跟随 DSH 浅色/深色 · 顶栏文案与布局（2026-09-18）

**✨ 新增 / 改进**

- **画布页现在跟随 DSH 的浅色/深色**（自动，无开关）：读 `ui-theme` 的 `active.colorScheme`，所以「跟随系统」和自定义主题的浅/深都能正确识别。此前画布页只有一套深色调色板，浅色应用里会是一整块深色。
- **首屏不闪**：宿主把当前浅/深写进 iframe 的 `?theme=`（进 `src`，只读一次，不会因主题变化触发 iframe 重载而丢滚动位置）；随后主题变化走 `postMessage` 实时下发，iframe `onLoad` 时再补发一次兜底。宿主没装主题服务时**不猜**，让画布页按 `prefers-color-scheme` 自己兜底。
- **两套调色板写全**：`studio/app.css` 的 `:root`（浅，默认）/ `:root[data-theme="dark"]` 变量名完全对等，低透明度底色一律用 `color-mix()` 从语义色派生（DSH 自身也是这个写法）。`color-scheme` 两套都声明，原生下拉/滚动条/复选框跟着变。
- **顶栏改为响应式三块布局**：A 品牌 / B 工程参数（画幅·时长·音频·档位·节点数）/ C 按钮。**宽栏一行 A B C**（B 吃掉中间剩余空间，C 靠右）；**窄栏竖直 A B C**（各占一行）。断点 960px。此前参数那串不定长文本（节点多的工程能到 60+ 字）与按钮挤在同一行，窄栏（右侧面板 ~360px）会把按钮推到不可预期的位置。
- **画布品牌文案**：`🎬 短剧画布` → **`🎬 短视频画布`**（本页文档标题、iframe 无障碍名、右栏引导页胶囊、设置页提示一并同步）。标签页仍叫「画布」。
- **顺带修掉两处「只有浅色」的角落**：iframe 内自绘的确认/入库模态框原先是写死的白色内联样式（深色主题下会跳出一块白板），改走调色板并收敛为 `.svs-modal*` 类；深色主题的 `--border` 由 `#2e3342` 微调到 `#363c4d`（原值压在 `--panel-2` 上只有 1.18:1，chip 的 1px 边框几乎看不见）。
- **验证**：新增 `scripts/smoke-canvas-theme.mjs`（28 项，纯 Node：调色板对等 / 调色板之外零颜色字面量 / 每个 `var()` 都有定义 / 首屏时序 / WCAG 对比度 + 边框可分）与 `scripts/preview-canvas.mjs`（46 项，真浏览器：起 stub 服务喂一份覆盖每种节点类型/状态/分区的样例工程，两套主题各量一遍实际合成像素的对比度，**宽栏 1100 + 窄栏 360 两档**断言 A B C 的横/竖两种排法、按钮不越界、无横向滚动，并断言 postMessage 切换、非法取值不误改、无 `?theme=` 时跟随系统偏好）。两者均已进 `npm run smoke`。
- **顺带修掉走查工具的一个洞**：`scripts/lib/ui-probe.mjs` 的 `parseColor` 不认识 `color-mix()` 在计算样式里的形态 `color(srgb 0.05 0.42 0.28 / 0.12)`（通道是 0–1 而非 0–255），会把半透明底静默算错——正是它让「chip 底色」这类元素此前的对比度检查形同空跑。

**📝 待办**

- README 里 [`examples/harness-dialogue-2.png`](examples/harness-dialogue-2.png) 是重命名前的界面截图，顶栏仍显示「短剧画布」，需在运行中的 DSH 里重新截一张。

### v1.4.0 — 画布可挂右侧栏（`canvasHome`）· 边看对话边生成（2026-09-18）

**✨ 新增 / 改进**

- **画布的家变成插件级配置项 `canvasHome`**（设置页 **ComfyUI → 界面**）：`"tab"`（默认，与「对话」并列的视图标签页）或 `"sidebar"`（**右侧栏**标签页）。挂右栏后对话与画布同屏，「跟随最新」自动滚动**第一次真正可用**（此前切到对话会卸载画布 iframe），并且能浮动成可拖拽缩放的面板——这是视图标签页给不了的能力。
- **互斥由结构保证**：插件启动时**只注册选中的那一个家**，所以任何时刻只可能有一个 studio iframe 实例，不存在两个实例抢同一份工程的状态问题（原先设想的「挂载期互斥守卫」不需要了）。代价是**改完需刷新页面**（启动时读一次），设置页写明并给了「立即刷新」按钮。
- **入口照抄宿主原生做法**（`ui-sidebar-files`）：右栏折叠时从会话标题栏右上角的展开按钮进入，在引导页点「短视频画布」胶囊（`guide[].order=5`，排在「工作区文件」「新建终端」之前）。不自造输入框按钮等非原生控件。
- **一份实现、两个家**：两个挂载点复用同一个 `CanvasView`，iframe 的 `postMessage` 桥（`ask-ai` → `inputActions.setDraft`）、工程数据、生成能力、Agent 工具全都与「家」无关。右侧栏服务走 `ctx.inject` **软注入**，宿主禁用右侧栏插件时浏览器半照常加载。
- 新增离线冒烟 `scripts/smoke-canvas-home.mjs`（65 项，v1.5.0 起扩到 90 项）：断言两种配置下的席位注册**互斥**、胶囊定义、配置不可用时回落默认家、右侧栏缺席不抛异常，以及设置页下拉/提示/保存。**它在实现期抓到一个真 bug**：正文席位必须以**实现 id** 为 key（shell 用 `entryKey: definition.id ?? tab.kind` 派发），写成 kind 会静默派发不到、正文退化成「此标签页不可用」。

**📝 文档 / 其它**

- 新增 [`docs/right-sidebar-canvas-research.md`](docs/right-sidebar-canvas-research.md)：DSH 右侧栏扩展点全量调研（三种外挂方式、逐项可行性、官方「不做」清单的影响、实现草图、版本门槛、风险表），含两条被否决的备选路线及其否决理由（运行时「一键换家」按钮；输入框自造入口）。
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 补展示层的「画布的家」分支与配置项说明。

### v1.3.0 — 形状契约 · 链式续接落地（含 i2v）· skill 版本戳（2026-09-15）

**✨ 新增 / 改进**

- **视频形状 `type` 必填**（`r2v` 参考绑定 / `i2v` 首末帧串联）：形状与参数冲突**直接报错并给修法**，此前是静默丢弃参数；`comfy_generate_video` / `comfy_render` / `POST /generate/video` 共用同一张真值表，校验在**上传参考图之前**完成（非法请求零副作用）。视频节点现在记 `params.type`，画布可辨识转场镜 / 锚点式重渲。
- **链式续接（`continuity_from`）全面落地**：同场景续接镜把上一镜的**服务端 latent 逐帧钉进本镜**、**音频从接缝继续**（实测接缝画面差 2.6–7.0，无续接对照 32–68；响度台阶稳定变好）。四档覆盖矩阵全绿，附录含测量口径与已知坑。
- **i2v 也有链式实现**（组「MiniMax H3 首末帧·链式续接」，4 份清单）：模板由 `scripts/make-h3-ctx-templates.mjs` 从普通 i2v 模板**派生**（可复现）。**实测行为契约**：链式 i2v 里 `first_frame_node` **会被丢弃**（钉住的 head 已决定开头约 22 帧）、`last_frame_node` **保留** ⇒ 转场镜「续接上一场景尾镜 + 末帧锚定下一场景首镜」成为当前最优解，锚点式重渲也不再脱离续接链。**fast 档已端到端实测**（链路索引、22 帧 + 1.000s 音频上下文、裁剪与尾对齐补零、非链式反例拒跑全部通过）。
- **续接变成规划期的一等公民**：`story-short-generator` v2.3.0 的镜头表从六列扩到**七列**（新增「续接」列：`起链` / `接 S0x` / `锚定 S0x↔S0y`），自检门扩到**十项**（续接链闭合性、续接可行性）；正片镜走 r2v + 续接，i2v 收敛为「转场镜 / 锚点式重渲」两处专用能力。
- **自带 skill 版本戳刷新**：安装时复制到 `~/.dsh/skills/` 的每个副本带 `.dsh-studio-manifest`（插件版本 + 内容 sha256）；内容没被你改过就**随插件升级自动刷新**，改过就**只提示、不覆盖**（`DSH_SVS_SKILL_REFRESH=off|force` 可关/强制）。

**📝 文档 / 其它**

- 新增 [`docs/shot-chain-continuity.md`](docs/shot-chain-continuity.md)（机制验证矩阵、档位 × 加速件覆盖矩阵、i2v 实测、测量口径与已知坑、复现命令）与 [`docs/video-shape-contract.md`](docs/video-shape-contract.md)（形状真值表、片型对照、i2v ctx 状态与待补项）；[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 补 skill 安装语义（五种情形 + 环境变量 + 回归入口）。
- **仍待补（已在文档记录）**：i2v 链式续接的 balanced / balanced-pdd / quality 三档实测、i2v 续接的**对照重设**（现有对照与上一镜同 seed + 同首帧，会把"同种子趋同"混进音频指标）、接缝的**人工听核**、跨形状续接的端到端实跑。

### v1.2.2 — 字幕写法单源 · I2V/Ref2V 选型文档（2026-09-14）

**✨ 新增 / 改进**

- **字幕与画面内文案的写法收归单一权威**：`h3-prompt-writing` 该节升级为「字幕与画面内文案（唯一权威版）」，四条定稿写法 + 失败写法 + 容量阈值 + 档位口径集中一处；`story-short-generator` / `brand-promo-video-generator` **只引用、不复述**（原先各自带一份简化版，漏限定词会导致字幕整段不烧，属已实测缺陷）。画面内文案与字幕**同源同法**（标牌 / UI / 品牌文案同理）。
- **适用面扩到「声明支持字幕的实现」**：H3 走结构化内嵌路径（Ref2VA 的 `detailed_description`、I2VA·FL2VA 的 `integrated_multimodal_description`），非 H3 走自由格式路径（英文引号逐字声明紧随对白 / 文案句，**不用末尾中文指令**）；两条路径的四条写法一致。
- **档位口径写清**：字幕能力是**实现级属性**，判定权在逐镜自检门；**没有「某档必须出字幕」的硬规则**（默认 `quality`，同档换实现前先按取证入口验证）。
- **新增选型参考文档** [`docs/i2v-vs-ref2v-and-model-comparison.md`](docs/i2v-vs-ref2v-and-model-comparison.md)：I2V 与 Ref2V 的机制差别、角色一致性 / 分辨率 / 时长 / 速度 / 音频与字幕 / 部署成本逐维对照（LTX-2.5 vs MiniMax H3）、按镜头类型的选型建议与未验证清单。**该文不属于插件契约**（插件侧只说能力、保持模型无关）。

**📝 文档 / 其它**

- 修正 `docs/tier-strategy-design.md` 中指向旧节名的两处失效引用（节名已改）。
- 公开文档不再出现测试机器的型号与显存数字（延续 v1.2.1 的口径）；技术前提（架构、无 FP8 路径、无 nvcc）全部保留。
- 本版为**技能 + 文档**版本：接口、档位契约与工作流清单零变化。

### v1.2.1 — 文档（2026-09-14）

- 公开文档不再点名测试机器（README / skill / docs 一致），耗时数字保留但注明**只作量级参考**、随硬件与版本浮动；docs 里的实验报告改按架构描述（sm_80 单卡），技术前提（架构、无 FP8 路径、无 nvcc）全部保留。
- 这一版是**纯文档版本**：为了让 npm 页面渲染到清理后的 README 而发布。

### v1.2.0 — 档位契约 · 策略模型 · PDD 8 步（2026-09-14）

**✨ 新增 / 改进**

- **受控三档 `tier`（`fast` / `balanced` / `quality`）**：一个工作流 json = 一个档位实现（`group` = 家族），`comfy_generate_image(tier=…)` / `comfy_generate_video(tier=…)` / `comfy_render(tier=…)`。**工具面不接受 `workflow=`**（实现由配置解析）。请求**不存在的档位显式报错并列出可用档位**（不静默换档）；分辨率＝清单声明的长边 × 画布比例推导（只传一边宽高时另一边按比例补出来）。
- **视频清单从 2 份扩到 18 份**：参考生成（ref2v）与首末帧生成（i2v）各有 `fast` / `balanced` / `balanced-sol` / `quality` / `quality-sol`，外加每条能力的抽帧与内部诊断清单——档位与加速实现可以按能力自由组合。
- **策略＝每能力一条内置默认 + 你自己命名并组合的策略**：设置页「＋ 新增策略」起名 + 逐档挑实现（**挑 ≥1 档即可**，可跨清单组合），支持重命名 / **编辑档位** / 删除。**策略声明它提供哪些档位**：没挑的档位在设置页逐档区与工具条都不出现，**显式**请求会报错（不回退到别的实现），**不指定档位**时按该策略自身最靠前的档解析。
- **PDD 8 步蒸馏（可选，需自装第三方节点包与权重）**：`nfe=8` 就拿到成片档以上的细节量——ref2v **184.7s**、i2v **178.8s**（同条件 20 步成片档 394.4s / 392.4s，帧锐度还高 +10.3% / +7.9%），叠加 Sol-Attn 后 **137.3s / 134.1s**。落地为四个普通清单，**不做隐式默认**（`priority<0`，缺节点时如实置灰）。
- **设置页能力×档位矩阵**：逐档下拉按家族分组、带实测耗时与「缺哪个节点」标记，不可用实现置灰；策略单选 + 策略管理（新增/重命名/编辑档位/删除）。
- **i2v 改用 FL2VA base**（修正原先"用 Ref2VA base 跑 i2v"的跨变体错配），新增独立配置键 `models.h3FlUnet` / `models.h3FlFastLora`（env `DSH_SVS_H3_MODEL_FL` / `DSH_SVS_H3_LORA_FL_FAST`），旧键只作用于 ref2v。

**⚠️ 升级须知**

- 旧视频清单 id `minimax-h3-ref2v` / `minimax-h3-i2v` 已拆成上表里的单档清单；配置中指向旧 id 的 `preferred` **不再决定视频档位**（改由 `tiers` / 策略决定），但旧 **asset id 仍按继承规则生效**（`assetOverrides` 不必改）。
- i2v 换 base 需额外下载 FL2VA 权重（+21GB 左右）；不想多下可用配置钉回旧组合，见下方「版本兼容」。
- 视频默认档是 **`quality`（20 步，最慢最贵）**，技能与手工调用建议显式传 `tier=`。
- 新的策略模型要**重启插件**（或导入/删除任意清单触发注册表重载）后才会出现在设置页。

**📝 文档**

- 新增 [`docs/tier-strategy-design.md`](docs/tier-strategy-design.md)（档位/策略契约全文，含"策略声明它提供哪些档位"的解析语义）与 [`docs/minimax-h3-video-benchmark.md`](docs/minimax-h3-video-benchmark.md)（A/B 实测）；[`docs/minimax-h3-acceleration-lora.md`](docs/minimax-h3-acceleration-lora.md) §9.9 收录 PDD 复核（含先前"不可用"结论及其两个成因的更正）。

---
