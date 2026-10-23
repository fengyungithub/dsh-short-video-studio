# 声音能力路线：声线生成 + BGM + 试镜过渡

> 状态：**P0 + P1 已实现（2026-10-23）**，P2（TTS 实测）待做 · 调研汇总 v1
> 三份底层报告：
> - [`voice-generation-models.md`](voice-generation-models.md)（18 个 TTS/克隆候选，许可与集成）
> - [`music-generation-models.md`](music-generation-models.md)（21 个音乐模型，许可与集成）
> - [`audition-voice-pipeline.md`](audition-voice-pipeline.md)（试镜取声流水线设计）
>
> 本机事实（`[LOCAL]`，2026-10-23 实测）：ComfyUI **0.42.1**，GPU **NVIDIA A800 80GB**，RAM 540GB，Python 3.14 / torch 2.15。
> **MiniMax Music 3 权重已在本机**；**没有任何 TTS 权重**；H3 音频参考通道已实现。

---

## 0. 结论先行

| 方向 | 结论 | 现在能不能用 |
|---|---|---|
| **1a. 声线生成 / 声纹** | 本机没有 TTS。开源里许可干净且中文强的：**Fun-CosyVoice3-0.5B（Apache-2.0，zh-SS 78.0）**、**Qwen3-TTS 0.6B/1.7B（Apache-2.0，3s 克隆）**；要“一个角色锁死一整季”用 **GPT-SoVITS（MIT，1min 微调）** | ❌ 需装模型 + 加 1 份 `audio.tts` 清单 |
| **1b. BGM** | **MiniMax Music 3 已经装好，我已真机跑通**：10s 28.6s / 30s 122.0s，44.1kHz 立体声。缺的只是仓库侧 `audio.music` 清单 | ⚠️ 模型可用，缺 manifest + `duration` 参数 |
| **2. 试镜取声** | 纯 H3 链路，**不需要新模型**：角色卡 → 5s 试镜 → 用户确认 → `extract_audio` → `voice:` 资产 → 每镜 `audio_ref_nodes` | ✅ 能力已齐，缺 skill 步骤 |

**一句话排期**：先上 **BGM（1–2 天）** 和 **试镜（1–2 天）**，这两件不需要新模型；再花 **3–5 天**接 TTS，把“试镜取声”升级成“TTS 造声”。

---

## 1. 本机实际有什么（先把前提校准）

### 1.1 硬件与 ComfyUI

| 项 | 值 | 影响 |
|---|---|---|
| GPU | **A800 80GB**（不是 24GB） | 13GB 级的 Music 3、1.5B 级 TTS 都放得下；可同时驻留 H3 + 音乐 |
| ComfyUI | **0.42.1** | 原生注册了音乐节点（Music 3 / ACE-Step 1.5 / YuE2 / Stable Audio），无需装自定义节点 |
| Python / torch | 3.14 / 2.15.0.dev+cu132 | TTS 依赖冲突风险高（多数 TTS 钉 `transformers` 旧版）→ 优先自定义节点或 sidecar 隔离 |

### 1.2 已装权重（`[LOCAL]`）

| 文件 | 大小 | 用途 |
|---|---|---|
| `minimax_music3_dit_fp16.safetensors` | 4.58 GB | MiniMax Music 3 DiT |
| `minimax_music3_text_encoder_pruned_int8_convrot.safetensors` | 8.57 GB | 文本编码器 |
| `minimax_music3_dav.safetensors` | 0.21 GB | 音频 VAE |
| `minimax_h3_audio_vae_fp32.safetensors` | — | H3 音频 VAE（参考音频走它进 latent） |

**没有** ACE-Step / Stable Audio / YuE2 / 任何 TTS 权重。

### 1.3 原生节点 vs 云 API 节点（容易混淆）

| 类型 | 节点 | 性质 |
|---|---|---|
| **本地** | `MiniMaxMusic3TextEncode`、`EmptyMiniMaxMusic3LatentAudio`、`TextEncodeAceStepAudio1.5`、`YuE2GenerateMusic`、`ConditioningStableAudio` | 开源/本地权重，可离线 |
| **云 API** | `ByteDanceSeedAudio`、`ElevenLabs*`、`FishAudio*`、`Sonilo*` | `category=partner/audio/*`，走 Comfy 云端/厂商 API，**不是开源**（Seed-Audio 支持 3 段克隆/图像取声，但要 API 凭据与费用） |

> 注意：`ByteDanceSeedAudio` 的“audio reference / image reference”看起来很诱人，但它是 partner 节点，不是本地模型。我们的方案不依赖它。

### 1.4 BGM 真机实测（`[MEASURED]`）

用 30 步、cfg 1.7、空 lyrics 的纯器乐 prompt：

| 请求时长 | 耗时 | 产物 | 采样率 |
|---|---|---|---|
| 10s | **28.6s** | 10.0s 立体声 mp3 | 44.1 kHz |
| 30s | **122.0s** | 30s 立体声 mp3 | 44.1 kHz |

结论：**BGM 能力今天就在**，只差把它包成能力注册表里的 `audio.music`。

---

## 2. 方向 1a：声线生成（TTS / 克隆）

### 2.1 先说“声纹”的两种含义

| 含义 | 谁提供 | 跨镜一致性 |
|---|---|---|
| **H3 参考样本**（每次重喂 2–15s） | H3 `audio_ref_nodes` | 无持久身份，靠复喂 + 同 prompt |
| **TTS enrolled voice**（权重/参考留在本地） | CosyVoice / Qwen3-TTS / GPT-SoVITS | 可持久；微调后最稳 |

两者不是替代关系：**TTS 造嗓子，H3 让嗓子在画面里对口型**，`voice:` 资产是交接物。

### 2.2 短名单（详见 voice-generation-models.md §8）

| 档位 | 建议实现 | 许可 | 理由 |
|---|---|---|---|
| fast（预演/定时长） | **Qwen3-TTS-0.6B-Base** | Apache-2.0 | 3–6GB、3s 克隆、节点最热（1955★，2026-09 仍在更新） |
| balanced（日常旁白） | **Fun-CosyVoice3-0.5B-2512** | Apache-2.0 | 官方对比表开放权重里 zh-SS 最高（78.0），18 种中文方言 |
| quality（整季固定） | **GPT-SoVITS v4**（每角色 1min 微调） | MIT | 唯一“真·enrolled”：微调后音色锁死；需要 sidecar |

**不是 OSI 开源但可商用**：IndexTTS-2.5（bilibili 许可，<1 亿 MAU / 10 亿元营收可商用）——情绪向量 + `duration_factor` 语速控制最好，但依赖最重，建议 sidecar。

### 2.3 一票否决（写进实现 PR）

- ❌ **F5-TTS / Spark-TTS / XTTS-v2 / Higgs v3**：代码宽松但**权重 NC**，商用产物不行；
- ❌ **VibeVoice-TTS**：代码已撤回、权重 Disabled；
- ❌ **MiniMax Speech 2.x**：**没有公开权重**（HF 上只有 H3 / Music3）；
- ❌ **MegaTTS3**：Apache 但**缺 WaveVAE encoder**，本地无法注册新音色——不满足“每角色一份参考”；
- ⚠️ **Fish-Speech**：2026-10 改为 Community License，商用限营收 50 万美元。

### 2.4 集成路径（推荐 a 为主、b 兜底）

**a. 原生 manifest（首选）**

- `audio.tts` 已在能力词表与 schema 里（`lib/manifest.js:36`、`schemas/workflow-manifest.schema.json:33`）；
- 新增一份 `audio.tts` 清单：`params.text`（scalar）、`params.ref_audio`（`inject:"audio"`，接 `voice:` 资产）、`seed`；
- runner 侧把“输出里有 audio”收成 `kind:'audio'` 节点——`comfyOutputs` 已遍历 `audio`，只缺 mediaType/title/resolution 的音频分支；
- 调用方不新增工具名：`comfy_render(capability='audio.tts', prompt=…, audio_ref_nodes=[voice:id])`。

**b. sidecar（依赖冲突时）**

- `localhost:8189` 的 FastAPI（参考音频 + 文本 + 情绪/语速），加一个极薄 `SidecarTTS` 节点回写 `SaveAudio`；
- 现有 manifest 契约只认 `runner:"comfyui"`，要新增 runner 类型（3–5 天）——**只在 IndexTTS / GPT-SoVITS 这种依赖钉死的引擎上才值得**。

### 2.5 落地前必须实测（当前全是上游数字）

1. Qwen3-TTS / CosyVoice3 / IndexTTS-2.5 各跑 3 句中文（10/30/80 字）+ 1 句中英混排：RTF、峰值显存、首音延迟；
2. 中文念白盲测（用真实台词，不用新闻句）；
3. **说话人相似度**（embedding 余弦）——本仓目前没有音色客观指标，TTS 会放大这个缺口，建议和 H3 共用同一套评测脚本；
4. 输出采样率与 32kHz（H3 参考）的重采样路径；
5. 长文本重复/漏字；跨语言同声纹漂移。

---

## 3. 方向 1b：BGM 生成

### 3.1 候选（详见 music-generation-models.md §6）

| 排名 | 模型 | 许可 | 定位 |
|---|---|---|---|
| 1 | **ACE-Step 1.5** | MIT | 10–600s、2B turbo、BPM/调式/拍号可控、原生模板；最均衡 |
| 2 | **Stable Audio 3 Small-Music / Medium** | Stability Community（<$1M 营收免费商用） | 120/380s、44.1kHz、纯器乐最强、全授权训练数据 |
| 3 | **MiniMax Music 3** | Community（署名 + <$20M 阈值） | 最高上限、已装；8B planner，官方建议双卡，本机单卡可跑（实测 30s=122s） |

**不可商用**：MusicGen（含 melody）、MAGNeT、AudioLDM2、Tango/Tango2、MusicLDM、TangoFlux、**YuE2 权重（CC BY-NC）**。YuE v1 是 Apache-2.0，可用。

### 3.2 仓库侧要改什么（1–2 天）

| 改动 | 位置 | 说明 |
|---|---|---|
| `audio.music` 清单（Music 3） | `scripts/*-templates` → `workflows/` | 照官方 blueprint：UNETLoader + CLIPLoader(type=minimax) + MiniMaxMusic3TextEncode + EmptyMiniMaxMusic3LatentAudio + KSampler(euler/simple, 30 步) + VAEDecodeAudio + SaveAudioAdvanced |
| `duration` 参数 | `comfy_render` schema + `buildGraphFromManifest` | 秒 → `max_duration` / `Empty*LatentAudio.seconds`；视频的 `length` 是帧数，不能复用 |
| 音频分支 | `runRender` | 跳过分辨率推导/告警，title 兜底改“音乐”，产物 `kind:'audio'` |
| 可选别名 | 新工具 | `comfy_generate_music(prompt, duration, tier, title)`，内部走 `comfy_render` |
| 混音（后续） | 交付层 | `loudnorm -16 LUFS`、对白 ducking（`sidechaincompress`）、loop crossfade |

**验收**：60s 器乐请求不出人声；立体声 ≥32kHz；−16 LUFS / 真峰 ≤ −1dBTP；10/30/60s 时长误差 ≤1s；同 seed 可复现；画布节点记 `model/licence/duration/sampleRate/seed`。

---

## 4. 方向 2：试镜取声（过渡方案）

### 4.1 流程（详见 audition-voice-pipeline.md）

```
角色卡两版锁定
  → 每角色一份试镜提示词（Ref2VA，单镜单人一句台词，无 BGM 无字幕）
  → comfy_generate_video(type='r2v', tier='balanced', ref_nodes=[角色卡], length=124)
  → 用户确认（只听声线 / 声线+画面 / 换 seed 重抽 / 上传真人声线）
  → extract_audio(video_node) → audio 节点（32kHz）
  → 入库 voice:<hex> → 写「声线清单」文本节点
  → 后续每镜 r2v + audio_ref_nodes=['voice:<hex>']，prompt 里 <Audio 1> … (S1)
```

### 4.2 为什么是“过渡”

- ✅ 不需要新模型、今天就能跑；
- ✅ 声线来自 H3 自己，和后续镜头的“发声分布”最接近；
- ⚠️ **不是声纹注册**：H3 没有 voice id，每次生成重新条件化，跨镜仍可能漂；
- ⚠️ 32kHz 天花板；试镜里的环境音/配乐会被一起抽进去（试镜 prompt 必须 `non_diegetic_music: N/A` + 干净声景）；
- ⚠️ 换声线 = 该角色所有镜 + 续接下游连锁重渲。

### 4.3 成本

| 档位 | 试镜耗时（5.17s / 124 帧） | 建议 |
|---|---|---|
| fast | ~25s（832×480） | 只试口型/构图 |
| **balanced** | **166s**（1344×768） | **默认**：音质与成本平衡 |
| quality | 397s | 定稿角色再抽 1 条 |

每角色 2–3 抽 ≈ 6–8 分钟（balanced）。

---

## 5. 三者怎么组合（目标形态）

```
角色设定 ──► TTS 造“声线样本”（CosyVoice/Qwen3-TTS/GPT-SoVITS）
                │  产物：voice:<hex>（2–15s 干声）
                ▼
镜头生成 ──► H3 r2v + audio_ref_nodes=[voice:<hex>] ──► 带声音的画面（口型对齐）
                │
BGM ────────► audio.music（Music 3 / ACE-Step）──► 独立音轨
                ▼
交付 ──────► concat + loudnorm + 对白 ducking（后续）
```

- **对白在画面里**：H3 原生音频 + 参考样本（口型天然对齐）。
- **旁白/独白/电话音**：TTS（不需要口型，可逐句重录、调语速）。
- **声线资产**：以 TTS 的 enrolled voice 为准；H3 的参考样本从 TTS 产物或试镜产物派生。
- **试镜**：在 TTS 接入前承担“造样本”；接入后可保留为“看脸+听声”的联合验收。

---

## 6. 分期与工作量

| 阶段 | 内容 | 工作量 | 依赖 |
|---|---|---|---|
| **P0** | `audio.music` + Music 3 清单 + `duration` 参数 + 音频 runner 分支 | **1–2 天** | 无（权重已装，已实测） |
| **P1** | 试镜流水线：SKILL STEP 3.5 + 声线清单 + 画布分组 + 验收门 | **1–2 天** | P0 无关，可并行 |
| **P2** | TTS 阶段 0：TTS-Audio-Suite 实测 Qwen3-TTS 0.6B / CosyVoice3 / IndexTTS-2.5 | 1 天 | GPU 空闲窗口 |
| **P3** | `audio.tts` 清单 + runner 音频分支 + `voice:` 资产对接（Qwen3-TTS 先通链路） | 2–3 天 | P2 结论 |
| **P4** | 质量档：GPT-SoVITS 微调或 IndexTTS sidecar；三档模型分工 | 3–5 天 | P3 |
| **P5** | 评测与混音：speaker embedding、loudnorm、ducking、BGM 自动铺轨 | 2–3 天 | P0/P3 |

**建议顺序**：P0 → P1 → P2 → P3 → P5 → P4（先把能用的用起来，再追质量）。

---

## 7. 风险与决策点

| 风险 | 影响 | 缓解 |
|---|---|---|
| TTS 依赖与 ComfyUI（py3.14/torch2.15）冲突 | 装不上 / 拖垮现有节点 | 优先 TTS-Audio-Suite 的隔离运行时；冲突就上 sidecar |
| 许可踩雷（NC 权重） | 商用成片不能用 | 本文一票否决清单；下载权重时再读一次 LICENSE |
| H3 与 Music/TTS 抢显存 | OOM | 80GB 总量够；串行提交，ComfyUI 自动换载；长音频用 tiled decode |
| BGM 盖住对白 | 成片不可用 | 交付层 ducking + −16 LUFS 统一响度 |
| 试镜声线漂移 | 跨镜不一致 | 每镜复喂、同 prompt、balanced 起步；P3 后改 TTS 造声 |
| 采样率不齐（TTS 24k / H3 32k / Music 44.1k） | 参考音质损失 | 统一重采样到 32k 再喂 H3；成片 44.1k/48k 输出 |
| `audio.tts` 被误解为“替代 H3 音轨” | 口型不同步 | 明确分工：对白用 H3，TTS 只做旁白/样本/独白 |

---

## 8. 引用入口

- 声线：[`voice-generation-models.md`](voice-generation-models.md)（18 模型 / 75 链接 / 评分表 §8.1）
- 音乐：[`music-generation-models.md`](music-generation-models.md)（21 模型 / 114 链接 / 评分表 §6）
- 试镜：[`audition-voice-pipeline.md`](audition-voice-pipeline.md)（五步流程 / 成本 / 实验计划）
- 机制：[`h3-audio-consistency.md`](h3-audio-consistency.md)、[`h3-audio-local.md`](h3-audio-local.md)
- 已实现通道：[`../h3-voice-consistency-plan.md`](../h3-voice-consistency-plan.md)


---

## 附录：P0 / P1 落地记录（2026-10-23）

### P0 — BGM（`audio.music`）

| 改动 | 位置 |
|---|---|
| 新增清单 `minimax-music3`（本地权重，原生节点；duration/seed/steps/cfg/lyrics 注入；记 `sampleRate`/`license`） | `workflows/minimax-music3.json` |
| runner 音频分支：跳过分辨率/尺寸告警、title 兜底「音乐」、节点记 duration/sampleRate/license、不复用提示词库 | `lib/index.js` |
| `comfy_render` 新增 `duration` / `lyrics` / `cfg` 参数 | `lib/index.js` |
| 新工具 `comfy_generate_music(prompt, duration?, lyrics?, seed?, steps?, cfg?, …)` | `lib/index.js` |
| 冒烟 | `scripts/smoke-music.mjs`（17 项：清单/注入/默认值/档位解析/duration 边界） |

**实测**：10s 器乐 ≈8.3s（热态；cold ~28s）、30s ≈122.0s，44.1kHz 立体声 mp3；`duration` 越界在提交前报错且不建节点。

### P1 — 试镜取声（skill 流程）

| 改动 | 位置 |
|---|---|
| 新增 STEP 3.5「声线试镜」：写试镜 prompt → balanced 生成 → 人工确认 → `extract_audio`（自动上画布）→ 入库 `voice:` → 声线清单 | `skills/story-short-generator/SKILL.md` |
| 画布新增分组 `voice auditions`（groupOrder 十组） | 同上 |
| 镜头表「音频与对白轨」新增 `声线参考` 字段；自检门第 7 项校验同角色同一 `voice:` | 同上 |
| STEP 7 对白镜传 `audio_ref_nodes` + `<Audio N>` 声明要求 | 同上 |
| 试镜镜头的 H3 结构规范（禁环境音/配乐、不写 `<Audio N>`、单人单句） | `skills/h3-prompt-writing/references/studio-mapping.md` §6 |

**实测**：试镜 prompt（fast 832×480）45.4s、124 帧、0 warning；`extract_audio` 2–3s 产出画布 audio 节点；画布最终 4 个节点（角色卡 / 试镜视频 / 提示词库 / 声线样本）齐全。

### 边界（未做）

- BGM 混音（loudnorm / 对白 ducking / loop crossfade）尚未实现；BGM 目前是独立音轨。
- TTS 仍未接入（P2）：`audio.tts` 能力在词表里但没有实现清单。
- 2K / hires 实现不支持 `audio_ref_nodes`（显式报 `audio-ref-unsupported`）。
- **新增清单/工具需要重启 DSH 宿主进程**（热重载只刷新入口模块）。
