# 开源 TTS / 零样本声音克隆模型调研 —— 为本地 ComfyUI 管线选「可复用声纹 + 逐句合成」

> 调研对象：本仓 `dsh-short-video-studio`（DSH 插件 + 本地 ComfyUI `localhost:8188` + MiniMax H3 音视频模型）。
> 只读调研：**未修改任何代码**，本文件为新增。
> 取证日期：**2026-10-23**（所有 star / 最后提交 / 许可标签均为当日实抓，见 §1）。
> 关联文档：[`audition-voice-pipeline.md`](audition-voice-pipeline.md)（H3 侧的「参考样本」流水线设计）、[`h3-audio-local.md`](h3-audio-local.md)（H3 音频机制）、[`../h3-voice-consistency-plan.md`](../h3-voice-consistency-plan.md)（音频通道实现方案）。

**English TL;DR.** The repo has no TTS engine today, but it already has the plumbing a TTS engine needs (`audio.tts` is a declared capability, `voice:` assets exist, canvas audio nodes exist, `extract_audio` already builds a `SaveAudio` graph). Licence-clean zero-shot cloners with strong Mandarin: **Qwen3-TTS 0.6B/1.7B Base (Apache-2.0, 3-s clone)**, **Fun-CosyVoice3-0.5B (Apache-2.0, best vendor-reported similarity among open models)**. **MegaTTS3 is Apache-2.0 too but ships without the WaveVAE encoder, so you cannot enrol a new voice locally** (§4.5). Best quality-but-custom-licence: **IndexTTS-2.5** (bilibili Model Use License — commercial OK below 100M MAU / RMB 1B revenue; emotion + `duration_factor` pace control). **F5-TTS, Spark-TTS, XTTS-v2, Echo-TTS are NOT commercially usable.** **VibeVoice-TTS is withdrawn** (code removed, weights disabled). **MiniMax Speech 2.x has no public weights.** Recommended integration: native ComfyUI custom node behind the existing `audio.tts` capability (option a), with a sidecar FastAPI only as a dependency-conflict fallback.

---

## 0. 结论先行

### 0.1 三条硬结论

1. **能同时满足「Apache-2.0 级宽松许可 + 中文母语级 + 零样本克隆 + 有活跃 ComfyUI 节点」的，今天只有 Qwen3-TTS 与 Fun-CosyVoice3 两家**（MegaTTS3 许可同等宽松，但缺 WaveVAE encoder、注册链路不闭环，见 §4.5）；IndexTTS-2.5 综合质量最好但许可不是 OSI 开源（§4.2 逐条给出原文阈值）。
2. **本仓加 TTS 不是"从零接一条新链路"**：能力词表里 `audio.tts` 早已登记（`lib/manifest.js:35`），音色资产类型 `voice:`（`lib/assets.js:37`）与音频画布节点、`SaveAudio` 建图样板（`lib/index.js:2800`）都已存在。缺的只有「清单 + 一个返回音频的 runner 分支」。
3. **"voice fingerprint" 这个词要区分两种含义**，否则会和 [`audition-voice-pipeline.md`](audition-voice-pipeline.md) §0.1 的结论打架：
   - **H3 的参考音频** = 每次生成都要重喂的条件样本，模型端不留状态（该文档口径）；
   - **TTS 模型的 enrolled voice** = 真正的持久音色（参考音频或微调权重留在本地，逐句合成时复用）。
   本文件讨论的是后者；前者在 H3 侧仍然必要，二者不互相替代，见 §7.3。

### 0.2 Top-3（评分见 §8.1）

| 排名 | 模型 | 加权分 | 一句话理由 |
|---|---|---|---|
| 1 | **Fun-CosyVoice3-0.5B-2512** | 4.85 | 权重 Apache-2.0、官方对比表里开放权重模型 zh-SS 最高（78.0）、18 种中文方言、0.5B 单卡无压力——四项里三项满分 |
| 2 | **Qwen3-TTS 1.7B Base**（0.6B 作 fast 档） | 4.45 | 唯一「Apache-2.0 权重 + 官方声明 3 秒克隆 + 中文母语 + ComfyUI 节点 1955★ 且 2026-09 仍在更新」四项全中，且 0.6B/1.7B 正好对 fast/quality 两档 |
| 3 | **GPT-SoVITS v2 ProPlus / v4** | 4.45 | 唯一能拿到「真·enrolled 声纹」的路线：5s 零样本起步、**1 分钟数据微调后音色锁死**，MIT + RTF 0.014（4090）；代价是要走 sidecar 且节点停更 |

> 并列第 2/3 按「集成工作量」打破平手（Qwen3-TTS 5 分 vs GPT-SoVITS 3 分）。
> **特别提名：IndexTTS-2.5**（4.05）—— 质量分数最高（zh-SS 76.5 + 情绪向量 + `duration_factor` 语速控制），被"自定义许可 + 依赖最重"拖到第 4；如果你需要**逐句情绪控制**且能接受 bilibili 许可，它是最优解（§4.2）。
> **一句话取舍**：只要"最强中文 + 许可干净"→ 选 1；只要"最快上线 + 许可干净"→ 选 2；只要"一个角色锁死一整季"→ 选 3。

---

## 1. 取证方法与证据分级

沿用本仓惯例的四级标记（见 [`h3-audio-local.md`](h3-audio-local.md) §0），本文另加一个 `[LIVE]` 表示「2026-10-23 当日从 API/仓库实抓的元数据」：

| 标记 | 含义 |
|---|---|
| `[LIVE]` | 当日实抓：GitHub REST API（stars / `pushed_at` / SPDX）、`raw.githubusercontent.com` 的 LICENSE 原文、Hugging Face API/模型卡（经 `hf-mirror.com` 镜像，因本机直连 `huggingface.co` 不通） |
| `[PRIMARY]` | 上游一手文档：仓库 README / LICENSE / HF 模型卡 / 论文 |
| `[COMMUNITY]` | 第三方汇总或社区节点自述（如 `TTS-Audio-Suite` 的引擎对比表、ComfyUI 节点 README），**未经上游确认** |
| `[CODE]` | 本仓代码里实际这样接线，可被任何人在本机复核 |
| `[INFERRED]` | 我的推断 |

**两点方法学限制，先说清楚**：

- 直连 `huggingface.co` 在本机返回 `000`（连接失败），模型卡与许可标签经 `hf-mirror.com` 读取（同源镜像，`/api/models/*` 与 `/raw/main/README.md` 均可通）。因此 HF 侧元数据为 `[LIVE]` 但走镜像，若镜像滞后则可能偏差；关键许可结论我都用**仓库 LICENSE 原文**二次交叉验证。
- **没有做本机实测**：本文所有 VRAM / RTF 数字来自上游自述或第三方表格，均标注来源；本仓 24GB Ampere 上的真实数字见 §9 待实测清单。

---

## 2. 本仓现状：为什么"加一个 TTS"比想象中便宜，又比想象中贵

### 2.1 已经就位的部分（`[CODE]`）

| 已有物件 | 位置 | 对 TTS 的意义 |
|---|---|---|
| 能力词表含 `audio.tts` / `audio.music` | `lib/manifest.js:35`-`36`；`schemas/workflow-manifest.schema.json:32`-`33` | 不需要扩词汇表，只需加清单 |
| `voice` 资产类型（映射到 `audio`） | `lib/assets.js:37`，落盘逻辑 `lib/assets.js:252` | 「声纹」可直接入资产库，跨会话复用 |
| 画布音频节点 + 上传白名单 + 时长探测 | `lib/index.js:807`（`AUDIO_UPLOAD_EXTS`）、`lib/index.js:836`、`lib/index.js:245`-`248` | 产物可直接落画布、显示时长 |
| `SaveAudio` 建图样板（现用于 `extract_audio`） | `lib/index.js:2800` | TTS 出音频的建图可照抄这一形态 |
| `audio_ref_nodes` 参考音频通道 | `lib/index.js:3446`、`:3918`、`:4777` | TTS 的「参考音频入参」复用同一套解析（画布节点 / `voice:` / 视频取音轨） |
| 交付侧认 `kind==='audio'` | `lib/index.js:3114`；`lib/index.js:2814` | 产物能进交付/送达链路 |

**结论**：`audio.tts` 的**调用面、资产面、产物面都已存在**，缺的是「实现面」（一份 manifest + 一条把 ComfyUI 输出收成音频节点的 runner 分支）。

### 2.2 真正的成本在两处（`[INFERRED]`）

1. **产物回收分支**：现有通用 runner 的产物收集按图/视频形态写（`lib/index.js` 的 `comfyOutputs` → `persistMedia` 路径主要服务 image/video），`extract_audio` 那条是**专用函数**而不是通用分支。要做 `audio.tts` 档位化（fast/balanced/quality 换模型/步数），得先把「返回音频」做成通用分支，否则每个 TTS 引擎都要写一个专用函数。
2. **Python 环境隔离**：中文最强的一批（IndexTTS、CosyVoice、Fish、GPT-SoVITS）对 `transformers` / `torch` 版本要求互相冲突，且与本仓现有 H3/FLUX 节点共存于同一个 ComfyUI 进程有风险。第三方套件 `TTS-Audio-Suite` 已经踩过这个坑，用 `Main` / `Shared` 两套运行时隔离（`[COMMUNITY]` [ENGINE_COMPARISON.md](https://github.com/diodiogod/TTS-Audio-Suite/blob/main/docs/ENGINE_COMPARISON.md) 的 `Isolation` 列）。

### 2.3 与既有设计的一处张力（必须记录）

`docs/h3-voice-consistency-plan.md` §1 把「独立 TTS 或后期配音轨」列为**非目标**，理由是「H3 是 AV 联合生成，加 TTS 会重新引入音画不同步」。这条对**"H3 出画 + TTS 后期配音"**成立，但对**本文的场景**不成立：本仓还有大量**非对白用途**（旁白、预告、角色独白、镜头外的电话音、以及未来可能脱离 H3 的纯音频产物）。所以正确表述不是"推翻非目标"，而是**把 `audio.tts` 定位为旁路能力**：不进 H3 图、不替换 H3 音轨，只服务旁白/独立配音/声线资产制作。§7.3 给落地边界。

---

## 3. 总表（18 个候选，按许可友好度排序）

> 列说明：**参考长度**=上游文档给出的零样本参考音频时长；**zh**=中文支持与口音质量（含上游自述与第三方评测）；**体积/显存**=权重体积（第三方表 `[COMMUNITY]`）或上游明示显存；**ComfyUI**=最相关节点仓（★/最后提交，`[LIVE]`）；**成熟度**=发布-维护节奏（`[LIVE]`）。

| # | 模型 | 许可（代码 / 权重） | 零样本克隆 | zh | 体积/显存 | ComfyUI 节点（★ / 最后提交） | 采样率/长文本 | 成熟度 |
|---|---|---|---|---|---|---|---|---|
| 1 | **Qwen3-TTS 0.6B/1.7B** | Apache-2.0 / Apache-2.0 `[LIVE]` | ✅ 官方 "3-second rapid voice clone" `[PRIMARY]` | 10 语种含中英；9 个音色含京/川方言 `[PRIMARY]` | 0.6B/1.7B，`~3–6GB` `[COMMUNITY]` | [flybirdxx/ComfyUI-Qwen-TTS](https://github.com/flybirdxx/ComfyUI-Qwen-TTS) 1955★ / 2026-09-22；[DarioFT](https://github.com/DarioFT/ComfyUI-Qwen3-TTS) 313★ | 12Hz codec；支持 batch list `[PRIMARY]` | 2026 新发布，节点生态最热 `[LIVE]` |
| 2 | **Fun-CosyVoice3-0.5B-2512** | Apache-2.0 / Apache-2.0 `[LIVE]` | ✅ 零样本（跨语种） `[PRIMARY]` | 9 语种 + 18 种中文方言/口音 `[PRIMARY]` | 0.5B，`~5.4GB` `[COMMUNITY]` | [AIFSH/CosyVoice-ComfyUI](https://github.com/AIFSH/CosyVoice-ComfyUI) 298★ / 2024-09-10（旧）；[filliptm/ComfyUI_FL-CosyVoice3](https://github.com/filliptm/ComfyUI_FL-CosyVoice3) 150★ / 2026-08-23 | 24kHz（CosyVoice 系列）；双流式 150ms `[PRIMARY]` | 仓库 2026-05 迁至 QwenAudio 组织，仍在维护 `[LIVE]` |
| 3 | **MegaTTS3** | Apache-2.0 / Apache-2.0 `[LIVE]` | ⚠️ 零样本，但**权重不含 WaveVAE encoder**，只能吃官方预提取的 latent（见 §4.5）`[PRIMARY]` | en+zh（模型卡 `language: en, zh`）`[PRIMARY]` | 未明示（权重卡未给参数量） | [billwuhao/ComfyUI_MegaTTS3](https://github.com/billwuhao/ComfyUI_MegaTTS3) 211★ / 2025-06-11；[1038lab](https://github.com/1038lab/ComfyUI-MegaTTS3) 51★ | 未在卡中明示 | 2025-03 发布，2026-06 仍在收 PR `[LIVE]` |
| 4 | **Chatterbox Multilingual V3** | MIT / MIT `[LIVE]` | ✅ 零样本（10s 级）`[PRIMARY]` | V3 覆盖 23+ 语种，另有 6 个单语精调包 `[PRIMARY]` | 500M，`~4.3GB` `[COMMUNITY]` | [filliptm/ComfyUI_Fill-ChatterBox](https://github.com/filliptm/ComfyUI_Fill-ChatterBox) 242★ / 2026-08-24；[wildminder/ComfyUI-Chatterbox](https://github.com/wildminder/ComfyUI-Chatterbox) 104★ / 2026-10-22 | 水印（PerTh）内建 `[PRIMARY]` | Resemble 商业公司在维护，2026-07 发 V3 `[LIVE]` |
| 5 | **MOSS-TTS（含 TTSD 对话版）** | Apache-2.0 / Apache-2.0 `[COMMUNITY]` | ✅（含 reference-free 音色设计）`[COMMUNITY]` | 24–31 语种 `[COMMUNITY]` | 1.7B/8B；`~8.5GB tokenizer + 6.1–18GB` `[COMMUNITY]` | 经 TTS-Audio-Suite（无独立高星节点） | 支持长文本/TTSD 1–5 说话人 `[COMMUNITY]` | OpenMOSS 学术线，2026 活跃 `[LIVE]` |
| 6 | **VoxCPM / VoxCPM2** | Apache-2.0 / Apache-2.0 `[COMMUNITY]` | ✅ 零样本 `[COMMUNITY]` | 30 语种（V2）`[COMMUNITY]` | 0.5B；`~3–6GB` `[COMMUNITY]` | [wildminder/ComfyUI-VoxCPM](https://github.com/wildminder/ComfyUI-VoxCPM) 518★ / 2026-10-14；[Saganaki22/ComfyUI-VoxCPM2](https://github.com/Saganaki22/ComfyUI-VoxCPM2) 202★ | V2 声称 48kHz `[COMMUNITY]` | 2025 起，节点 2026-10 仍更新 `[LIVE]` |
| 7 | **GPT-SoVITS v2 ProPlus / v4** | MIT / MIT（代码仓单一 MIT）`[LIVE]` | ✅ 5s 零样本 + 1min 微调 `[PRIMARY]` | 中文是其主战场（含中文 ASR/标注工具链）`[PRIMARY]` | 小（SoVITS 数十 MB 级 + GPT 权重） | [AIFSH/ComfyUI-GPT_SoVITS](https://github.com/AIFSH/ComfyUI-GPT_SoVITS) 256★ / **2024-08-09（停更）** | v4 原生 48kHz（v3 为 24k）`[PRIMARY]` | 63557★ 全榜第一，2026-10-19 仍更新 `[LIVE]`，但节点侧停滞 |
| 8 | **IndexTTS-2.5 / 2（1.5 另有）** | **bilibili 自定义许可** / 同（1.5 权重 Apache-2.0）`[LIVE]` | ✅ 单条参考音频 `[PRIMARY]` | zh 母语级；2.5 起 zh/en/ja/es/ar（2 仅 zh/en）`[PRIMARY]` | 1.5B；`~4.7 / 5.49GB` `[COMMUNITY]` | [chenpipi0807/ComfyUI-Index-TTS](https://github.com/chenpipi0807/ComfyUI-Index-TTS) 769★ / 2026-09-02；[billwuhao](https://github.com/billwuhao/ComfyUI_IndexTTS) 557★；[yolain](https://github.com/yolain/ComfyUI-Easy-IndexTTS2) 279★ | 未在 README 明示；支持 `duration_factor` 0.5–2.0 `[PRIMARY]` | 24658★，2026-09-29 更新，2026-08 发 2.5 `[LIVE]` |
| 9 | **Fish-Speech（Drama 3 / S2-Pro）/ OpenAudio** | **Fish Audio Community License v1.0** `[LIVE]` | ✅ 10–30s 参考 `[PRIMARY]` | ~100 语种，zh 强 `[PRIMARY]` | S2-Pro 4B `~10.3GB`；**Drama 3 = 35B-A3B（24GB 单卡不现实）** `[PRIMARY]` | [Saganaki22/ComfyUI-FishAudioS2](https://github.com/Saganaki22/ComfyUI-FishAudioS2) 303★ / 2026-04-27；[PedroMarinhoDev/ComfyUI-Drama3](https://github.com/PedroMarinhoDev/ComfyUI-Drama3) 99★ / 2026-10-17 | S2-Pro RTF 0.195（H200）`[PRIMARY]` | 33366★，2026-10 许可换版 + 新旗舰 `[LIVE]` |
| 10 | **Higgs TTS 2（3B）/ 3（4B）** | 代码 Apache-2.0；**权重 `license: other`** `[LIVE]`（第三方表：v2 Community License、v3 Research & Non-Commercial）`[COMMUNITY]` | ✅ 零样本 `[PRIMARY]` | v2 五语种 / v3 100+ 语种 `[COMMUNITY]` | 3B `~9GB`；4B `~8GB` `[COMMUNITY]` | [Saganaki22/Higgs_v3-TTS-ComfyUI](https://github.com/Saganaki22/Higgs_v3-TTS-ComfyUI) 74★ / 2026-09-05；[ShmuelRonen/ComfyUI-HiggsAudio_Wrapper](https://github.com/ShmuelRonen/ComfyUI-HiggsAudio_Wrapper) 27★ | 未明示 | 8368★，2026-06 更新；HF 上 v2 原 id 已改名（`higgs-tts-2-3b-base`）`[LIVE]` |
| 11 | **Spark-TTS 0.5B** | Apache-2.0 代码 / **CC-BY-NC-SA-4.0 权重** `[LIVE]` | ✅ 零样本 + 音色创建 `[PRIMARY]` | zh+en（BiCodec 单流）`[PRIMARY]` | 0.5B | [1038lab/ComfyUI-SparkTTS](https://github.com/1038lab/ComfyUI-SparkTTS) 125★ / 2025-04-15；[billwuhao](https://github.com/billwuhao/ComfyUI_SparkTTS) 52★ | 未明示 | 10986★，但 `pushed_at` 停在 2025-04-09 `[LIVE]` |
| 12 | **F5-TTS** | **MIT 代码 / CC-BY-NC-4.0 权重** `[LIVE]` | ✅ 零样本（参考音频 + 其转写文本；**上游未明示时长**）`[PRIMARY]` | zh+en（Emilia 双语训练）`[PRIMARY]` | 0.3B `~1.2GB/语言包` `[COMMUNITY]` | [HighInBC/F5-TTS-Node](https://github.com/HighInBC/F5-TTS-Node) 5★（生态基本靠套件） | 24kHz Vocos `[PRIMARY]`；RTF 0.147（PyTorch）/0.040（TRT-LLM）`[PRIMARY]` | 15440★，2026-10 仍更新 `[LIVE]`，但**权重非商用** |
| 13 | **XTTS-v2** | MPL-2.0 代码 / **CPML（非商用）** `[LIVE]` | ✅ 6s 克隆 `[PRIMARY]` | 17 语种含 zh-cn `[PRIMARY]` | ~1.8GB | [AIFSH/ComfyUI-XTTS](https://github.com/AIFSH/ComfyUI-XTTS) 70★ / **2024-06-24（停更）** | 24kHz `[PRIMARY]` | **上游已死**：`coqui-ai/TTS` 最后提交 2024-08-16 `[LIVE]` |
| 14 | **Kokoro-82M** | Apache-2.0 / Apache-2.0 `[LIVE]` | ❌ **不支持克隆**（54 个预置 voicepack）`[PRIMARY]` | v1.0 八语种；中文需 v1.1-zh 分支 `[COMMUNITY]` | 82M，CPU 可跑 | [benjiyaya/ComfyUI-KokoroTTS](https://github.com/benjiyaya/ComfyUI-KokoroTTS) 70★ / 2025-03-18 | 24kHz 级 | 9601★，2025-08 后停更 `[LIVE]` |
| 15 | **Orpheus-TTS 3B** | Apache-2.0 / Apache-2.0 `[LIVE]` | ✅ 零样本（音色靠 prompt 内 speaker 名）`[PRIMARY]` | **主力是英文**；多语种为 research preview `[PRIMARY]` | 3B | [ShmuelRonen/ComfyUI-Orpheus-TTS](https://github.com/ShmuelRonen/ComfyUI-Orpheus-TTS) 12★（最成熟节点仅 12★） | 未明示；~200ms 流式 `[PRIMARY]` | 6366★，2025-12 后基本停更 `[LIVE]` |
| 16 | **Dia-1.6B** | Apache-2.0 / Apache-2.0 `[LIVE]` | ⚠️ 音频条件（非真正克隆）`[PRIMARY]` | ❌ **仅英文** `[PRIMARY]` | 1.6B，bf16 **~4.4GB 显存** `[PRIMARY]` | 无主流节点（套件未收） | 双人对话一次生成 | 19404★，2025-11 后停更 `[LIVE]` |
| 17 | **VibeVoice-TTS** | MIT 代码 / MIT（但**权重已下架**）`[LIVE]` | — | — | 1.5B/7B | [Enemyx-net/VibeVoice-ComfyUI](https://github.com/Enemyx-net/VibeVoice-ComfyUI) 1569★ / 2026-02-18 | — | ❌ **2025-09-05 官方移除 TTS 代码**，`VibeVoice-1.5B` 在 HF 标 `Disabled` `[PRIMARY]` |
| 18 | **Seed-VC / RVC（声线转换路线）** | **GPL-3.0** / MIT 框架（社区模型各异）`[LIVE]` | 转换而非克隆：给定 prompt 音频迁移音色 `[PRIMARY]` | 语言无关（内容由源音频决定）`[PRIMARY]` | Seed-VC tiny 25M；RVC 100–300MB `[PRIMARY]` | 经 TTS-Audio-Suite 的 RVC 引擎（含训练）`[COMMUNITY]` | Seed-VC 22.05kHz `[PRIMARY]` | RVC 生态最大；Seed-VC 2026 仍更新 `[LIVE]` |

**未列入主表但值得知道的**（第三方表 `[COMMUNITY]`，未逐一验证许可）：**Step Audio EditX**（Apache-2.0，14 种情绪 + 32 种说话风格，适合做"二次编辑"）、**Dots TTS**（Apache-2.0，19 语种）、**OmniVoice**（Apache-2.0，600+ 语种）、**DramaBox**（LTX-2 Community License，16.4GB，仅英文）。

---

## 4. 许可这一列到底能不能商用（逐条给原文）

这是本次调研**最容易踩坑的一列**：几乎所有中文 TTS 都是「代码宽松、权重自定」，且 2026 年出现了两轮换版（Fish 换 Community License、bilibili 换 Model Use License）。

### 4.1 真·宽松（代码与权重都允许商用）

| 模型 | 证据 |
|---|---|
| **Qwen3-TTS** | HF 权重卡 `license: apache-2.0`（[1.7B-Base](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base)、[CustomVoice](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice)）`[LIVE]` |
| **CosyVoice 全系** | 仓库 LICENSE 原文为 Apache License 2.0（[LICENSE](https://github.com/QwenAudio/CosyVoice/blob/main/LICENSE)）；[CosyVoice2-0.5B](https://huggingface.co/FunAudioLLM/CosyVoice2-0.5B) 与 [Fun-CosyVoice3-0.5B-2512](https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512) 卡均 `license: apache-2.0` `[LIVE]` |
| **MegaTTS3** | 仓库 [LICENSE](https://github.com/bytedance/MegaTTS3/blob/main/LICENSE) = Apache-2.0；HF 权重卡 `license: apache-2.0`（[ByteDance/MegaTTS3](https://huggingface.co/ByteDance/MegaTTS3)）`[LIVE]` |
| **Chatterbox** | 仓库 LICENSE = MIT（[resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox)）`[LIVE]`；模型卡同为 MIT `[COMMUNITY]` 交叉印证（TTS-Audio-Suite 表） |
| **GPT-SoVITS** | 仓库 LICENSE = MIT `[LIVE]`；注意其**预训练权重**来自多方（含 BigVGAN 的 NVIDIA 许可），严格商用前需自行核对权重清单 |
| **Kokoro-82M** | 仓库 Apache-2.0，模型卡 `license: apache-2.0` 并明示 "deployed in numerous projects and commercial APIs"（[卡](https://huggingface.co/hexgrad/Kokoro-82M)）`[LIVE]`——但**它不能克隆** |
| **MOSS-TTS / VoxCPM / Dots / OmniVoice / Step-Audio-EditX** | 仅第三方表标 Apache-2.0 `[COMMUNITY]`，**未取到上游原文**，商用前必须自查 |

> ⚠️ 表中 **MegaTTS3 许可虽好，但音色注册链路不闭环**（缺 WaveVAE encoder），不要据许可列把它排进主链路 —— 见 §4.5。

### 4.2 有门槛但可商用（阅读原文后的实际结论）

**IndexTTS-2 / 2.5 —— bilibili Model Use License**（仓库与权重同一份文本：[仓库 LICENSE](https://github.com/index-tts/index-tts/blob/main/LICENSE)、[权重 LICENSE.txt](https://huggingface.co/IndexTeam/IndexTTS-2/blob/main/LICENSE.txt)）`[LIVE]`：

- §2.1 授予「worldwide, non-exclusive, royalty-free」有限许可 —— **默认允许商用**；
- §2.2 唯一规模门槛：**月活 > 1 亿** 或 **上一年营收 > 人民币 10 亿** 需另签书面许可（原文："more than 100 million monthly active users… or … exceeded RMB 1 billion"）；
- §3c 额外限制：**不得用 IndexTTS 的产物去改进其他 AI 模型**（除自身衍生或非商用模型）；
- ⇒ 对本仓（个人/小团队短剧）**可商用**，但要保留版权声明并接受"非 OSI 开源"这一事实。
- **IndexTTS-1.5 权重是 Apache-2.0**（[卡](https://huggingface.co/IndexTeam/IndexTTS-1.5)）`[LIVE]` —— 要绝对干净的许可可选旧版，代价是质量与英文稳定性更差（README：「1.5 显著提升稳定性与英文」）。

**Fish-Speech —— Fish Audio Community License v1.0（2026-10-13 版）**（[LICENSE 原文](https://github.com/fishaudio/fish-speech/blob/main/LICENSE)）`[LIVE]`：

- §II 研究/非商用免费；
- §III(a) **年营收 < 50 万美元**可商用（"Community Commercial License"）；
- §III(c) 定义 "Hosted Service" 需另签，但**明确排除**两类：① 为你自己创作的内容生成语音（旁白/配音/游戏角色/助手回复）；② **代理/工作室按单交付成品**（"as an agency, studio, or freelancer producing voiceovers, dubbing, or audiobooks"）——本仓做短剧正落在排除项里；
- 附义务：分发时保留 Notice 并**显著标注 "Built with Fish Audio"**；
- §IV(b) 禁止用其产物训练其他基础生成模型；并提到**水印/来源信号**不可移除（说明权重带 provenance 标记）。
- ⚠️ 第三方表把 Fish 标成 "Fish Audio Research License" `[COMMUNITY]`，与仓库现行 LICENSE **不一致**（很可能是旧版标签或 S2-Pro 权重的单独声明）。**以仓库 LICENSE 为准，并在实际下载权重时再核一次权重仓的 LICENSE**。

### 4.3 ❌ 明确不能商用（权重非商用）

| 模型 | 证据 | 后果 |
|---|---|---|
| **F5-TTS** | HF [SWivid/F5-TTS](https://huggingface.co/SWivid/F5-TTS) `license: cc-by-nc-4.0` `[LIVE]`（代码仓是 MIT，**不覆盖权重**） | 商用短剧**不能用**，除非自训权重 |
| **Spark-TTS** | HF [SparkAudio/Spark-TTS-0.5B](https://huggingface.co/SparkAudio/Spark-TTS-0.5B) `license: cc-by-nc-sa-4.0` `[LIVE]`（代码 Apache） | 同上 |
| **XTTS-v2** | HF [coqui/XTTS-v2](https://huggingface.co/coqui/XTTS-v2) `license: other` → **Coqui Public Model License**（[coqui.ai/cpml](https://coqui.ai/cpml)）`[LIVE]` | 非商用；且上游 2024-08 停更 |
| **Higgs Audio v3（4B）** | HF `license: other` `[LIVE]` + 第三方表写 "Research and Non-Commercial License" `[COMMUNITY]` | 商用前必须拿到 Boson 书面许可 |
| **Echo-TTS** | 第三方表 CC-BY-NC-SA-4.0 `[COMMUNITY]` | 非商用 |

### 4.4 ❌ 不是"开源权重"或已不可用

- **MiniMax Speech 系列**：见 §5 专项，**没有公开权重**。
- **VibeVoice-TTS**：仓库 README 原文 "2025-09-05: … we have removed the VibeVoice-TTS code from this repository"（[README](https://github.com/microsoft/VibeVoice)）；模型表里 `VibeVoice-TTS-1.5B` 状态写 **Disabled**；`VibeVoice-1.5B` 权重卡已不可用 `[LIVE]`。**结论：不要把它列进候选**，即使它有 54936★。仓库现在主打 ASR 与 Realtime 分支。
- **Kokoro**：许可 OK，但**没有克隆能力**（音色 = 54 个预置 voicepack，训练数据自述 "No synthetic audio from open TTS models or 'custom voice clones'"）`[PRIMARY]`，不满足「3–15s 注册 + 复用」的需求。

### 4.5 ⚠️ 许可干净但"用不了"的反例：MegaTTS3 缺 WaveVAE encoder

MegaTTS3 是本次调研里唯一「代码 + 权重都 Apache-2.0、且中英双语」的模型，但它的模型卡里有一条容易漏读的限制（原文，`[LIVE]` 取自 HF 卡）：

> "For security issues, we do not upload the parameters of WaveVAE encoder to the above links. You can only use the pre-extracted latents from [link1] for inference. If you want to synthesize speech for speaker A, you need 'A.wav' and 'A.npy' in the same directory."

⇒ **推论** `[INFERRED]`：本仓最核心的需求「用户提供 3–15s 参考音频 → 立刻得到该音色的合成」**在本地做不到**，因为把 wav 编码成 latent 的那一半（WaveVAE encoder）没有发布；要么提交音频到作者维护的 Google Drive 队列（每段 ≤24s，人工审核后回传 `.npy`），要么只用公开 latent 里的音色。这对"每部剧新角色都要新音色"的流水线是**硬阻断**，不是工程优化能解决的。

**这条也是本文最值得记的方法论教训**：许可列全绿 ≠ 可用；必须同时核「音色注册链路是否闭环」。同理，凡是"零样本克隆"的宣传，都要追问一句——**编码参考音频的那部分权重给没给**。

---

## 5. 专项：MiniMax 的语音模型到底开不开源？

**结论：不开源。截至 2026-10-23，MiniMax 没有任何语音/TTS 权重公开。**

证据链（三条独立）`[LIVE]`：

1. **HF 官方组织清单里没有 TTS 模型**。`MiniMaxAI` 组织下有 `MiniMax-H3`（图生视频，本仓正在用的那个）、`MiniMax-M3/M2.x`（LLM）、`MiniMax-Music3`（text-to-audio）、`MiniMax-VL-01` 等，**没有任何 Speech/TTS 条目**（组织列表：<https://huggingface.co/MiniMaxAI>）。
2. **同行评测表把它标为闭源**。CosyVoice 官方 README 的 Seed-TTS-eval 对比表里 "MiniMax-Speech" 的 `Open-Source` 列是 **❌**，同时给出其指标（test-zh CER 0.83 / SS 78.3），说明评测方拿到了 API 成绩但没有权重（[README](https://github.com/QwenAudio/CosyVoice)）`[PRIMARY]`。
3. **Speech 2.x 的可获取形态是 API/商业平台**，公开渠道只有第三方模型库的规格页（如 [DataLearner 的 Speech 2.6 页](https://www.datalearner.com/en/ai-models/pretrained-models/minimax-speech-2-6)），没有权重下载入口。

**副产品发现（对本仓有用）**：同组织有 **`MiniMaxAI/MiniMax-Music3`（pipeline_tag: text-to-audio）**，与本仓已登记但未实现的 `audio.music` 能力对应；该仓**未声明 license 标签**（`[LIVE]` 查 `cardData.license = None`），要用必须先解决许可问题。另有社区非官方复现（[ishine/minimax-speech](https://github.com/ishine/minimax-speech)），README 自述 "unofficial text to speech from minimax technical report"，**不是官方权重**，不能当替代。

> 结论对选型的影响：H3 自带音频（32kHz 立体声，联合采样）已经覆盖「镜头内对白」；TTS 只应服务旁白/独立配音。**不要为了"追上 MiniMax Speech"而等权重**——它不会来。

---

## 6. ComfyUI 支持全景（含"官方有没有节点"这个问题的诚实答案）

**候选里没有一家提供"官方"ComfyUI 节点** —— ComfyUI 核心仓库的音频节点只覆盖 `LoadAudio`/`SaveAudio`/`GetVideoComponents` 这类基础件（本仓已在用，见 `lib/index.js:2800`），模型集成全部由社区承担。所以问题变成"社区节点够不够活跃"。（`[INFERRED]`：结论来自本次对 14 组关键词的 GitHub 仓库检索，未发现任何模型作者组织下的官方节点仓；若有遗漏属检索假阴性。）

| 模型 | 最相关节点仓 | ★ | 最后提交 | 观察 |
|---|---|---|---|---|
| Qwen3-TTS | [flybirdxx/ComfyUI-Qwen-TTS](https://github.com/flybirdxx/ComfyUI-Qwen-TTS) | 1955 | 2026-09-22 | **最热**，另有 3 个实现（DarioFT 313★、1038lab 261★、filliptm 154★）→ 有竞争、有冗余 |
| IndexTTS 2/2.5 | [chenpipi0807/ComfyUI-Index-TTS](https://github.com/chenpipi0807/ComfyUI-Index-TTS) | 769 | 2026-09-02 | 4 个实现并存，覆盖 2.5 |
| VibeVoice | [Enemyx-net/VibeVoice-ComfyUI](https://github.com/Enemyx-net/VibeVoice-ComfyUI) | 1569 | 2026-02-18 | 节点很热但**模型侧已撤回**，等于空壳 |
| VoxCPM | [wildminder/ComfyUI-VoxCPM](https://github.com/wildminder/ComfyUI-VoxCPM) | 518 | 2026-10-14 | 活跃 |
| GPT-SoVITS | [AIFSH/ComfyUI-GPT_SoVITS](https://github.com/AIFSH/ComfyUI-GPT_SoVITS) | 256 | **2024-08-09** | **节点停更**，实际用法是跑 GPT-SoVITS 自带 WebUI/API 当 sidecar |
| CosyVoice3 | [filliptm/ComfyUI_FL-CosyVoice3](https://github.com/filliptm/ComfyUI_FL-CosyVoice3) | 150 | 2026-08-23 | 跟上了 CosyVoice3；老牌 AIFSH 节点停在 2024-09 |
| Fish S2-Pro / Drama3 | [Saganaki22/ComfyUI-FishAudioS2](https://github.com/Saganaki22/ComfyUI-FishAudioS2) | 303 | 2026-04-27 | Drama3 另有 99★ 节点（2026-10-17） |
| MegaTTS3 | [billwuhao/ComfyUI_MegaTTS3](https://github.com/billwuhao/ComfyUI_MegaTTS3) | 211 | 2025-06-11 | 一年未动，但模型本身稳定 |
| Chatterbox | [filliptm/ComfyUI_Fill-ChatterBox](https://github.com/filliptm/ComfyUI_Fill-ChatterBox) / [wildminder](https://github.com/wildminder/ComfyUI-Chatterbox) | 242 / 104 | 2026-08-24 / 2026-10-22 | wildminder 那个更新更勤 |
| Spark-TTS | [1038lab/ComfyUI-SparkTTS](https://github.com/1038lab/ComfyUI-SparkTTS) | 125 | 2025-04-15 | 模型侧也停更 |
| Kokoro | [benjiyaya/ComfyUI-KokoroTTS](https://github.com/benjiyaya/ComfyUI-KokoroTTS) | 70 | 2025-03-18 | 够用（无克隆需求时） |
| XTTS | [AIFSH/ComfyUI-XTTS](https://github.com/AIFSH/ComfyUI-XTTS) | 70 | 2024-06-24 | 停更 + 权重非商用 |
| Orpheus | [ShmuelRonen/ComfyUI-Orpheus-TTS](https://github.com/ShmuelRonen/ComfyUI-Orpheus-TTS) | 12 | 2025-05-03 | 生态薄 |
| Higgs | [Saganaki22/Higgs_v3-TTS-ComfyUI](https://github.com/Saganaki22/Higgs_v3-TTS-ComfyUI) | 74 | 2026-09-05 | v3 节点有，但 v3 权重非商用 |
| **聚合套件** | [diodiogod/TTS-Audio-Suite](https://github.com/diodiogod/TTS-Audio-Suite) | **1240** | **2026-10-17** | 一个节点包吃下 19 个引擎（F5/Chatterbox/VibeVoice/Higgs/IndexTTS/CosyVoice3/Qwen3-TTS/Fish/RVC/MOSS…），并自带 `Main`/`Shared` 运行时隔离 |

**这张表最重要的一行是最后一行** `[INFERRED]`：如果只是"让本仓有 TTS"，装 `TTS-Audio-Suite` 一个包就能拿到 8–10 个引擎的即用节点，代价是**依赖面巨大**（19 个引擎共用一套 ComfyUI 环境）且许可混杂（囊括了 NC 权重）。它适合"先跑通、再收敛"，不适合作为长期唯一依赖。

---

## 7. 三种集成形态的评估（针对本仓）

### 7.1 形态对照

| 维度 | (a) 原生 ComfyUI 自定义节点 | (b) sidecar + 薄节点 | (c) 纯 HTTP 工具（绕开 ComfyUI） |
|---|---|---|---|
| 与本仓架构契合 | ✅ 完美：`capability=audio.tts` + manifest + tier 解析，全部现成（`lib/manifest.js:35`、§2.1） | ⚠️ 需要一个「转发节点」把 HTTP 结果伪装成图输出，属新增机制 | ❌ 绕开注册表/档位/画布产物链路，要新写工具 + 新写产物落盘 |
| 依赖冲突风险 | 高（与 H3/FLUX 共用 `torch`/`transformers`） | 低（独立 venv/进程，可 pin 版本） | 低 |
| 换模型成本 | 低（加清单 + 加节点） | 中（改 sidecar 实现，不动调用方） | 高（调用方要改） |
| 流式 / 长文本 | 受 ComfyUI 图执行限制 | ✅ 原生支持流式、长文本分块 | ✅ |
| 与 tier 三档语义 | ✅ 天然：fast=0.6B，balanced/quality=1.7B+情绪 | ⚠️ 要在 sidecar 里再实现一遍档位 | ❌ 无档位概念 |
| 交付/画布/资产 | ✅ 复用 `SaveAudio` + `kind:'audio'`（`lib/index.js:2800`、`:3114`） | ✅ 同样复用（节点返回音频即可） | ❌ 需另建 |
| 实现工作量（估算） | 1 份 manifest + 1 条 runner 分支 + 安装节点 | 1 个 FastAPI + 1 个转发节点 + 1 份清单 | 1 个工具 + 产品落盘 + 文档 |
| 适合的引擎 | Qwen3-TTS、CosyVoice3、MegaTTS3、Chatterbox | IndexTTS-2.5（版本钉死）、Fish（10GB+）、GPT-SoVITS（自带 API） | 试验期快速验证 |

### 7.2 推荐：**(a) 为主，(b) 为兜底**，并加一条前置动作

**推荐路线（按阶段）**：

1. **阶段 0（1 天，不改代码）**：装 `TTS-Audio-Suite`，用它把 Qwen3-TTS 0.6B 与 IndexTTS-2.5 各跑通一句中英混排，拿到本机 RTF/显存/主观音质。**这一步就能否掉一半候选**（§9 清单）。
2. **阶段 1（形态 a）**：为 `audio.tts` 写第一份 manifest，绑定 **Qwen3-TTS 1.7B-Base**（quality）/ **0.6B-Base**（fast），参数走 `params`：`text`（标量注入）、`ref_audio`（`inject: audio`，接 `voice:` 资产）、`seed`。产物用 `SaveAudio`（照 `lib/index.js:2800` 的形态），runner 侧把「图执行结果里有音频」收成 `kind:'audio'` 节点。**不新增工具名**，直接复用 `comfy_render(capability='audio.tts')`。
   —— 这里用 Qwen3-TTS 只是为了**先把链路打通**（节点最成熟、依赖最轻）；最终三档该挂哪个模型见 §8.2，换模型只改 manifest/配置，不动调用方。
3. **阶段 2（按需）**：若 IndexTTS-2.5 的依赖与 H3 冲突（很可能，因为它对 `transformers` 版本敏感），上 **(b)**：一个 `localhost:8189` 的 FastAPI（`POST /tts`，参考音频 + 文本 + emo 向量 + `duration_factor`），再加一个极薄的自定义节点 `SidecarTTS`（把 HTTP 结果写成 `SaveAudio` 能吃的音频），manifest 仍按 `audio.tts` 声明。**调用方无感**——这正是本仓「能力+档位、不写死实现」的价值。
4. **阶段 3**：把 `voice:` 资产与 TTS 的 enrolled voice 对齐（§7.3）。

**不推荐 (c)**：本仓的一切产物都必须落画布（`[DOC]` 系统约束），纯 HTTP 工具会同时丢掉画布、资产库、档位与交付四件事，等于重写一遍插件。

### 7.3 与 H3 的分工边界（避免两套"音色一致"打架）

| 场景 | 用谁 | 理由 |
|---|---|---|
| 镜头内对白（口型要对） | **H3 原生音频 + `audio_ref_nodes` 参考样本** | 音画联合采样，口型天然对齐（[`h3-audio-local.md`](h3-audio-local.md) §1） |
| 旁白 / 预告 / 独白 / 电话音 | **TTS**（`audio.tts`）+ `voice:` 参考 | 不需要口型，且可逐句重录、可调语速 |
| 角色"声纹"资产管理 | **TTS 的 enrolled voice** 为准，H3 的参考样本从其产物里 `extract_audio` 派生 | TTS 侧是持久身份（可微调、可固定 seed），H3 侧只是每次重喂的条件输入 |
| 声线转换（已有成片要换嗓子） | Seed-VC / RVC | 内容不变只换音色；注意 Seed-VC 是 **GPL-3.0** |

一句话：**TTS 负责"造出这把嗓子"，H3 负责"让这把嗓子在画面里对口型"**；`voice:` 资产是两者之间的交接物。这也解释了为什么 [`audition-voice-pipeline.md`](audition-voice-pipeline.md) 里"试镜"这一步值得插在角色卡之后——未来它应该产出的是 **TTS 音色样本**，而不只是 H3 的参考片段。

---

## 8. Top-3 评分表与推荐

### 8.1 评分（1–5，5 最好；权重按"本仓做中文短剧"场景）

| 维度（权重） | Qwen3-TTS 1.7B | IndexTTS-2.5 | Fun-CosyVoice3 | MegaTTS3 | Chatterbox V3 | GPT-SoVITS | Fish S2-Pro |
|---|---|---|---|---|---|---|---|
| 许可（25%） | **5** Apache-2.0 | 3 自定义（<1亿MAU 可商用） | **5** Apache-2.0 | **5** Apache-2.0 | **5** MIT | **4** MIT（权重来源需自查） | 3 营收<50万美元 |
| 中文质量（25%） | 4 母语级（官方 9 音色含方言） | **5** 业内最强档（第三方 zh-SS 76.5） | **5**（官方表 zh-SS 78.0，18 方言） | 4（en+zh，但生态小） | 3.5（V3 才补多语，中文属"支持"不属"专精"） | **5**（中文社区最大） | 4.5 |
| 克隆相似度（20%） | 4（官方 3s 克隆，缺公开 SS） | **5**（第三方 zh-SS 76.5 / en 70.6） | **5**（78.0 / 71.8） | 3（**无法本地编码新音色**，见 §4.5） | 4（V3 主打相似度提升） | 4.5（5s 零样本 + 可微调） | 4.5（10–30s） |
| 显存/速度（15%） | **5**（0.6B/1.7B，3–6GB） | 4（1.5B，4.7–5.5GB） | **5**（0.5B，5.4GB，150ms 流式） | 4 | 4.5（500M，4.3GB） | **5**（RTF 0.014 @4090） | 2（S2-Pro 10.3GB；Drama3 35B 不可行） |
| 集成工作量（10%） | **5**（节点最热 + 官方 API 简洁） | 2（依赖重、需钉版本，建议 sidecar） | 3.5（节点跟上了 3 但依赖 conda+submodule） | **1.5**（能跑节点，但音色注册不闭环） | 4 | 3（节点停更 → 走 sidecar） | 2.5（10GB + 许可义务） |
| 成熟度（5%） | 3（2026 新，但生态爆发式） | **5**（2→2.5 稳定迭代，vLLM recipe） | **5**（3 代迭代，2026-05 迁组织仍维护） | 4 | 4.5 | **5**（63.5k★，48k 原生） | 4.5 |
| **加权总分** | **4.45** | **4.05** | **4.85** | **3.80** | 4.22 | **4.45** | 3.55 |

> 计分公式：`0.25·许可 + 0.25·中文 + 0.20·相似度 + 0.15·显存/速度 + 0.10·集成 + 0.05·成熟度`（各项 1–5）。同分按集成工作量排序。

> 分数口径：`[INFERRED]`，依据 §3/§4 的事实列线性打分（"无公开 SS"按 4 计）；中文质量与相似度主要参考 CosyVoice 官方 README 的 Seed-TTS-eval 对比表 `[PRIMARY]`（Index-TTS2 zh-SS 76.5、VibeVoice-1.5B 74.4、HiggsAudio-v2 3B 74.0、CosyVoice2 75.7、Fun-CosyVoice3 78.0、F5-TTS 74.1、Spark-TTS 66.0），**该表由竞品自己汇总，存在选择性风险**，故一律标注为"厂商汇总的第三方评测"。

### 8.2 最终建议（三档落地）

| 档位 | 建议实现 | 说明 |
|---|---|---|
| **fast**（预演/对齐用） | **Qwen3-TTS-0.6B-Base** | 3–6GB、3s 克隆、Apache-2.0；出片前用它把每句台词的**时长**定下来 |
| **balanced**（日常成片） | **Fun-CosyVoice3-0.5B-2512** | 0.5B、方言多、Apache-2.0、节点跟上了 3；适合大量旁白 |
| **quality**（重点镜头 / 整季固定声纹） | **GPT-SoVITS v4（每角色 1min 微调）**；需要逐句情绪/语速时换 **IndexTTS-2.5**；许可洁癖时退 **Qwen3-TTS-1.7B-Base** | 三种质量路线的差别不在"清晰度"，而在**一致性从哪来**：微调（权重里）> 条件（参考音频里）> 指令（文本里）。短剧角色跨几十集，微调最稳 |

> ⚠️ 这三档**不是同一个模型的三个规模**，而是三个不同模型——落地时必须做到「换档 = 换 manifest/实现，调用方无感」（本仓注册表本来就是这么设计的：`capability` + `tier` → 配置解析，`lib/manifest.js` 的 `CAPABILITIES`/`TIERS` 与设置页档位选择）。这正是 §7.2 阶段 2 要守住的边界。

**"一票否决"清单**（这几条务必写进实现 PR 的描述）：

1. 不要引入 **F5-TTS / Spark-TTS / XTTS-v2 / Higgs v3 / Echo-TTS** 的**权重**做商用产物（NC 许可）；
2. 不要引入 **VibeVoice-TTS**（代码已撤回、权重 Disabled）；
3. 不要等 **MiniMax Speech** 权重（不存在）；
4. 不要把 **MegaTTS3** 排进"每角色新音色"的主链路（缺 WaveVAE encoder，注册不闭环，§4.5），它只适合"复用公开 latent 音色"的实验。

---

## 9. 待实测清单（本机 24GB Ampere，落地前必须回答）

以下都是我**没有实测**、只能靠上游数字的项，建议按此顺序取证（每项记进 `e2e-out/`，格式沿用本仓既有实测报告）：

1. **RTF 与峰值显存**：Qwen3-TTS 0.6B/1.7B、CosyVoice3-0.5B、IndexTTS-2.5、Chatterbox V3，各测 3 句中文（10/30/80 字）+ 1 句中英混排；记录 `nvidia-smi` 峰值与首音延迟。
2. **中文口音质量盲测**：同一句台词（含多音字、儿化、数字、英文专名）四模型对比；本仓需要的是"短剧念白"而不是"朗读"，建议直接用真实台词而非新闻句。
3. **克隆相似度客观指标**：上游多用 speaker-embedding 余弦（如 `eresnetv2`/`campplus`）。⚠️ 本仓**目前没有音色客观指标**（[`../h3-voice-consistency-plan.md`](../h3-voice-consistency-plan.md) §2 已记这条缺口），TTS 会把这个缺口放大——建议一并补一个 embedding 脚本，H3 与 TTS 共用。
4. **跨语言一致性**：同一声纹说中文与英文，音色是否漂移（IndexTTS/CosyVoice 都宣称跨语种克隆，需实测）。
5. **长文本行为**：500 字以上是否重复/漏字/加速；分段合成的接缝是否可接受（短剧多为逐句合成，接缝比长文本更重要）。
6. **word-level timestamps**：**没有一个候选把"词级时间戳"作为主能力**（`[INFERRED]`，逐个 README 未见）。若要字幕对轴，现实路径是**后接强制对齐器**：第三方表里 **Granite ASR 的 `-plus` 变体自带原生词级时间戳** `[COMMUNITY]`，或复用本仓 `funasr` 系工具（CosyVoice 依赖 FunASR）。**不要假设 TTS 会给你时间戳。**
7. **TensorRT / vLLM 加速**：IndexTTS-2.5 有官方 [vLLM recipe](https://recipes.vllm.ai/IndexTeam/IndexTTS-2.5)；F5-TTS 有 TRT-LLM（RTF 0.147→0.040 `[PRIMARY]`）。本机若已有 TRT 环境，优先压 F5/GPT-SoVITS。
8. **许可复核**：实际下载权重时**再读一次权重仓 LICENSE**（Fish 与 IndexTTS 都在 2026 年换过版；第三方表的标签与仓库原文已出现不一致）。

---

## 10. 参考索引（一手源）

**仓库 / 许可**
- CosyVoice（现 `QwenAudio/CosyVoice`，由 `FunAudioLLM` 迁移）：<https://github.com/QwenAudio/CosyVoice>｜[LICENSE](https://github.com/QwenAudio/CosyVoice/blob/main/LICENSE)
- IndexTTS：<https://github.com/index-tts/index-tts>｜[LICENSE（bilibili Model Use License）](https://github.com/index-tts/index-tts/blob/main/LICENSE)
- F5-TTS：<https://github.com/SWivid/F5-TTS>｜[权重卡 CC-BY-NC-4.0](https://huggingface.co/SWivid/F5-TTS)
- GPT-SoVITS：<https://github.com/RVC-Boss/GPT-SoVITS>
- Fish-Speech：<https://github.com/fishaudio/fish-speech>｜[LICENSE（Community v1.0）](https://github.com/fishaudio/fish-speech/blob/main/LICENSE)
- Spark-TTS：<https://github.com/SparkAudio/Spark-TTS>｜[权重卡 CC-BY-NC-SA-4.0](https://huggingface.co/SparkAudio/Spark-TTS-0.5B)
- Chatterbox：<https://github.com/resemble-ai/chatterbox>
- XTTS / Coqui TTS：<https://github.com/coqui-ai/TTS>｜[XTTS-v2 权重卡（CPML）](https://huggingface.co/coqui/XTTS-v2)
- Kokoro：<https://github.com/hexgrad/kokoro>｜[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
- Orpheus：<https://github.com/canopyai/Orpheus-TTS>
- Dia：<https://github.com/nari-labs/dia>
- Higgs Audio：<https://github.com/boson-ai/higgs-audio>｜[higgs-tts-2-3b-base](https://huggingface.co/bosonai/higgs-tts-2-3b-base)｜[higgs-tts-3-4b](https://huggingface.co/bosonai/higgs-tts-3-4b)
- VibeVoice：<https://github.com/microsoft/VibeVoice>
- MegaTTS3：<https://github.com/bytedance/MegaTTS3>｜[权重卡](https://huggingface.co/ByteDance/MegaTTS3)
- Seed-VC：<https://github.com/Plachtaa/seed-vc>｜RVC：<https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI>
- Qwen3-TTS：<https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base>｜<https://github.com/QwenLM/Qwen3-TTS>
- VoxCPM：<https://huggingface.co/openbmb/VoxCPM2>
- MOSS-TTS：<https://huggingface.co/OpenMOSS-Team/MOSS-TTS>
- MiniMax 组织：<https://huggingface.co/MiniMaxAI>

**论文**
- CosyVoice 3：<https://arxiv.org/abs/2505.17589>
- CosyVoice 2：<https://arxiv.org/abs/2412.10117>
- IndexTTS-2：<https://arxiv.org/abs/2506.21619>｜IndexTTS-2.5：<https://arxiv.org/abs/2601.03888>｜IndexTTS-1.5：<https://arxiv.org/abs/2502.05512>
- Spark-TTS：<https://arxiv.org/pdf/2503.01710>
- MegaTTS3：<https://huggingface.co/papers/2502.18924>

**社区汇总（`[COMMUNITY]`，务必自行复核）**
- TTS-Audio-Suite（19 引擎对照，含许可列）：<https://github.com/diodiogod/TTS-Audio-Suite>｜[ENGINE_COMPARISON.md](https://github.com/diodiogod/TTS-Audio-Suite/blob/main/docs/ENGINE_COMPARISON.md)

---

## 附：本文未验证/存疑的三处（留给下一轮）

1. **Qwen3-TTS 的输出采样率**：模型卡只写 `Qwen3-TTS-Tokenizer-12Hz`（12Hz 语义-声学 tokenizer），**没有明示输出 kHz**；本仓 H3 音频是 32kHz（[`h3-audio-local.md`](h3-audio-local.md) §1.1），若 TTS 产物要进 H3 做参考，需先确认采样率与重采样路径。
2. **Fish-Speech 的许可标签不一致**：仓库 LICENSE 写 Community v1.0（2026-10-13），第三方表写 "Fish Audio Research License"。**可能是 S2-Pro 权重仓有单独声明**，未取到 `fishaudio/s2-pro` 的 LICENSE 原文（HF 镜像对部分 id 返回空）。
3. **Higgs v2 权重许可全文**：HF 只给 `license: other`，未读到 Boson 自定义许可正文；"Community License" 与 "Research and Non-Commercial" 的差别（尤其是否允许商用、是否限营收）**没有原文验证**，因此 §3 只把它列为"需另行确认"，不给"可商用"结论。
