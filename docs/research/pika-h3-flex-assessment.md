# Pika H3 Flex 调研与落地评估（balanced 档新增实现）

> 调研时间：2026-11-06 · 对象：Pika H3 Flex（MiniMax H3 的 6 步蒸馏后训练版）
> 落点：`video.reference2video` / `video.image2video` 的 **balanced 档新增一个并列实现**
> 结论先行：**可做，改动小（2 个 LoRA 文件 + 2 份模板 + 注册表登记），建议以「可选实现」落地、先不做隐式默认，用三组 A/B 决定是否提为默认。**

---

## 0. 结论摘要

| 问题 | 结论 |
|---|---|
| 能不能做成 balanced 档的新工作流 | **能**。它不是新架构，是 H3 上的两个 LoRA（`fl2va` / `ref2va`），本机节点与权重几乎齐备 |
| 要下载什么 | **只缺 2 个 LoRA**（各 1.82 GiB，共 3.64 GiB）；base / CLIP / VAE / 音频 VAE 本机已有 |
| 要不要升级 ComfyUI | **不用**。本机 0.42.1；Ref2VA / FL2VA 模板要求 ≥ 0.30.0（T2V 模板要 0.43.2，本项目用不到） |
| 值不值得做 | **值得做，但收益待实测**：官方称 5s 1344×768 单卡约 1 分钟；本机现有 balanced 8 步 = 166s、PDD+原生块稀疏 = 112s。若实测落在 110–130s，它只是「同级替代」；要到 ≤100s 才是真收益 |
| 最大未决风险 | ① 是否烧中文内嵌字幕（lightx2v 8 步不烧、PDD 烧，Pika 未知）② 6 步蒸馏在音频/运动上的退化 ③ 不能与 turbo LoRA 叠加 ⇒ 策略层是「二选一」 |

---

## 1. 这个方案是什么（事实）

- Pika 以 **MiniMax H3 为底**做后训练：多任务语料微调 → DMD 蒸馏把 50 步压到 **6 步** → 奖励反馈/偏好优化；产物是**两个 LoRA 适配器**（`fl2va` / `ref2va`），跑在已有 H3 base 上，「no new model architecture」。
- 采样配方是**固定**的（模板写死）：
  - `KSamplerSelect` = **`lcm`**
  - `ManualSigmas` = `1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0`（7 个值 = **6 步**）
  - `BasicGuider`（CFG 1.0 路径）、adapter `strength_model = 1.0`
  - **不要**接 `MiniMaxH3SigmaShift`（sigma 串已含 shift），**不要**再叠 turbo / Lightning LoRA（会破坏输出）
- 能力：T2V / Ref2VA（≤9 图 + 3 视频 + 3 音频）/ FL2VA（首末帧）；原生同步立体声，一条通路出画面 + 声音。
- 与本项目的关系：我们要的 Ref2VA / FL2VA 两个形状**都在**开源适配器覆盖范围里。
- 注意区分：`docs.comfy.org` 上还有 `PikaH3FlexVideoNode`，那是**按秒计费的云端 API 节点**（resolution/duration 计费），本地 ComfyUI 用不了；本地可用的只有上面这套 LoRA 模板。
- 授权：适配器沿用 **MiniMax H3 Community License**（含地域与商用条款），商用前需复核。

来源：
- [Pika H3 Flex ComfyUI 工作流（Comfy 官方文档）](https://github.com/comfy-org/docs/blob/4a9f856b6a9e2c0dac28081353e25725b994100c/tutorials/video/pika/pika-h3-flex.mdx)
- [PikaH3FlexVideoNode（云端 API 节点）](https://docs.comfy.org/built-in-nodes/PikaH3FlexVideoNode)
- [Comfy-Org/MiniMax-H3（LoRA 与权重仓库）](https://huggingface.co/Comfy-Org/MiniMax-H3)

---

## 2. 与本项目档位模型的关系

按 `docs/tier-strategy-design.md` 的契约「**一个 json = 一个档位实现**」：

| 维度 | 取值 |
|---|---|
| 能力 | `video.reference2video`（先做） / `video.image2video`（后补） |
| 档位 | `balanced` |
| 组 | 复用现有家族组 `minimax-h3-ref2v` / `minimax-h3-i2v`（就是并列实现，不新开组） |
| 实现 id | `minimax-h3-ref2v-balanced-pika` / `minimax-h3-i2v-balanced-pika`（后续 ctx 版 `…-ctx-balanced-pika`） |
| priority | 先 `-40`（同 PDD 的 `-30` 之下方，且远低于 0 的常规实现）＝**不做隐式默认**，由用户在设置页「新增策略」里挑 |
| estSeconds | 先填推算值（≈120s），实测后回填 |

为什么不是 fast：fast 是 4 步 832×480，6 步在任何卡上都不会更快。
为什么不是 quality：它是 6 步蒸馏，成片档仍应是 20 步 base。

> 关键含义：Pika 与现有 balanced（lightx2v 8 步）/ PDD 是**互斥选择**，不是叠加件。用户通过策略切换，默认行为不变。

---

## 3. 本机清点：缺什么

### 3.1 模型文件

| 文件 | 目录 | 本机 | 大小 |
|---|---|---|---|
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `diffusion_models` | ✅ | 19.53 GB |
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `diffusion_models` | ✅ | ~19.5 GB |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders` | ✅ | 14.61 GB |
| `minimax_h3_video_vae_int8_convrot.safetensors` | `vae` | ✅ | 2.62 GB |
| `minimax_h3_audio_vae_fp32.safetensors` | `vae` | ✅ | 577 MB |
| `pika_h3_flex_ref2va_v1_bf16.safetensors` | `loras` | ✅ 已下载（2026-11-06） | 1.82 GiB |
| `pika_h3_flex_fl2va_v1_bf16.safetensors` | `loras` | ✅ 已下载（2026-11-06） | 1.82 GiB |

- 本机 `models/loras` 现有的是 lightx2v turbo（4/8 步）与 PDD，**没有** Pika 适配器。
- 提交前先确认 ComfyUI 容器的 `models/` 卷剩余空间 ≥ 5 GB（下载 3.64 GiB + 安全余量）。

### 3.2 节点与版本（本机 ComfyUI 0.42.1，已实测 `/object_info`）

| 节点 | 状态 | 说明 |
|---|---|---|
| `ManualSigmas` | ✅ | 输入 `sigmas` 字符串 |
| `KSamplerSelect` | ✅ | 选项里含 `lcm` |
| `SamplerCustomAdvanced` / `BasicGuider` / `RandomNoise` | ✅ | 现有 H3 清单同构 |
| `LoraLoaderModelOnly` | ✅ | `strength_model` 1.0 |
| `MiniMaxH3ReferenceToVideo` / `MiniMaxH3ImageToVideo` | ✅ | 与现有清单同一个条件节点，参数注入不用改 |
| `MiniMaxH3MotionContext*`（链式续接 4 件套） | ✅ | 后续做 ctx 变体时可直接挂 |
| `BlockSparseAttention`（原生稀疏） | ✅ | 后续做 `-solattn` 变体时用（**不要**用第三方 `SolAttnMiniMaxH3`，0.35+ 会崩） |

### 3.3 下载（hf-mirror 已实测可达：镜像 API 200、文件 302）

```bash
# 两个文件、各 1,956,172,304 字节
BASE=https://hf-mirror.com/Comfy-Org/MiniMax-H3/resolve/main/loras
curl -L --fail --retry 3 -C - -o "$COMFY/models/loras/pika_h3_flex_ref2va_v1_bf16.safetensors" \
  "$BASE/pika_h3_flex_ref2va_v1_bf16.safetensors"
curl -L --fail --retry 3 -C - -o "$COMFY/models/loras/pika_h3_flex_fl2va_v1_bf16.safetensors" \
  "$BASE/pika_h3_flex_fl2va_v1_bf16.safetensors"
```

校验（HF LFS oid = 文件 SHA-256，取自镜像 API）：

```
ref2va  de3745ceb7d8d5c20898dd8fa3a05f1c0b00089ccd55297b2a8bab95c766b0e0  1956172304 bytes
fl2va   cc5453aeecd6189468409003fe4cf1b57e52ff3a830a0a154b87decbe07358b7  1956172304 bytes
```

```bash
shasum -a 256 models/loras/pika_h3_flex_*_v1_bf16.safetensors
```

> 走镜像时 `curl -L` 会跟随 302 到实际存储；若断流，`-C -` 续传即可。不要用 `hf` CLI 直连 huggingface.co（本环境不可达）。

### 3.4 已落地（2026-11-06 执行记录）

- 登录 `server@172.16.190.20`，`sudo docker inspect comfyui` 确认卷映射：
  - **`/data/comfyui/storage-models/models` → `/root/ComfyUI/models`（LoRA 落盘位置）**
  - `/data/comfyui/storage` → `/root`；`/data/comfyui/storage-user/{input,output,workflows}` 分别挂 input/output/workflows
  - 容器 env 已有 `HF_ENDPOINT=https://hf-mirror.com`（容器内 `hf` 下载天然走镜像）
- 已下载并落到宿主卷（`/data` 剩余 10T，足够）：
  ```
  /data/comfyui/storage-models/models/loras/pika_h3_flex_ref2va_v1_bf16.safetensors  1956172304 B
  /data/comfyui/storage-models/models/loras/pika_h3_flex_fl2va_v1_bf16.safetensors  1956172304 B
  ```
- SHA-256 与 HF LFS oid **逐字节一致**：`de3745ce…b0e0` / `cc5453ae…8b7`（见 §3.3）。
- ComfyUI `/models/loras` 已能列出两个文件（bind mount，无需重启容器）。
- 头部结构校验（容器内读 safetensors header）：**416 个张量、全 BF16**、`format=pt`、`base_model=MiniMaxAI/MiniMax-H3`；metadata 注明「alpha folded into lora_B / scale 1.0 baked」⇒ 加载用 `strength_model = 1.0` 即可，与官方模板一致。
- 许可：metadata 明写 `Derivative of MiniMax H3, distributed under the MiniMax H3 Community License Agreement`（商用条款仍需复核，见 §6）。

---

## 4. 落地改动清单（文件级）

### Phase 1 · 模板（`scripts/h3-templates/`）

1. **`minimax-h3-pika-ref2v.json`** —— 由 `minimax-h3-ref2v.json` 派生：
   - 删除 `2`（`MiniMaxH3SigmaShift`）与 `9`（`BasicScheduler`）；
   - `7`（`BasicGuider`）`.model = ["$model", 0]`；`10`（`SamplerCustomAdvanced`）`.sigmas = ["14", 0]`；
   - `8`（`KSamplerSelect`）`.sampler_name = "lcm"`；
   - 新增 `14`：`ManualSigmas`，`sigmas` 写死 `1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0`；
   - `assets` 增加 `lora_pika`（`kind: "lora"`、default `pika_h3_flex_ref2va_v1_bf16.safetensors`、env `DSH_SVS_H3_LORA_PIKA`）；
   - `modes.balanced = { longSide: 1344, loras: [{ asset: "lora_pika", strength: 1 }] }`。
2. **`minimax-h3-pika-i2v.json`** —— 同法由 `minimax-h3-i2v.json` 派生（base 换 `fl2va`、LoRA 换 `pika_h3_flex_fl2va_v1_bf16`）。
3. 参数表**原样保留**（prompt / width / height / length / seed / fps / refs / ref_audios / first_frame / last_frame / prefix）；**不声明 `params.steps`**（sigma 固定，注入 steps 无意义）。
4. `lengthGrid: [17, 5]`、`resolution`、`constraints` 照抄现有 balanced。

> 为什么不是「拿现有 balanced 清单改一个字段」：shift/scheduler 是图结构，必须新模板新清单（与 `make-h3-variants` 的既有约定一致）。

### Phase 2 · 注册表（`lib/index.js`，数据登记、非逻辑改动）

- `H3_REF2V_IDS` / `H3_I2V_IDS` 各加 `…-balanced-pika`（`ASSET_OVERRIDE_ALIASES` 与 `LEGACY_MODEL_ASSET_MAP` 由这两个数组自动展开，冒烟测试会要求每份新 H3 清单都有继承入口）。
- 资产族映射无需新增旧键（`lora_pika` 没有历史 `models.*` 键）；如需可后续补 `h3PikaLora`。

### Phase 3 · 变体表与生成

- `scripts/make-h3-variants.mjs` 的 `VARIANTS` 加 2 条：
  ```js
  { out: 'minimax-h3-ref2v-balanced-pika', group: GROUP_REF2V, tier: 'balanced', priority: -40,
    template: 'minimax-h3-pika-ref2v.json', mode: 'balanced', estSeconds: 120,
    note: 'Pika H3 Flex 6 步（lcm + 固定 sigma）· 1344×768 · 待实测' },
  { out: 'minimax-h3-i2v-balanced-pika', group: GROUP_I2V, tier: 'balanced', priority: -40,
    template: 'minimax-h3-pika-i2v.json', mode: 'balanced', estSeconds: 120, note: '…（同上，FL2VA）' },
  ```
- `node scripts/make-h3-variants.mjs --dry` 通过后正式生成 `workflows/*.json`（产物勿手改）。
- `scripts/verify-h3-variants.mjs` 的 `MAP` 补 2 条（模板 → mode），否则「生成物 vs 模板」校验不覆盖新清单。

### Phase 4 · 验证（见 §5）

### Phase 5 · 可选扩展（按实测结果决定）

- **链式续接 ctx 版**：用 `scripts/make-h3-ctx-templates.mjs` 的同构搬法给 Pika 模板挂 4 个 MotionContext 节点。首遍尺寸 1344×768 与现有 balanced 一致 ⇒ 可与现有链互接（链契约是「同一条链内采样尺寸一致」）。
  - 不做这一步的后果：Pika 镜**不能**出现在续接链里（既不能当上一镜、也不能传 `continuity_from`）。story/短剧流程大量用续接 ⇒ 若 Pika 要当日常主力，ctx 版是必需项。
- **`-solattn` 版**：叠**原生** `BlockSparseAttention`（不是第三方 SolAttn）。Pika 只禁叠加速 LoRA，注意力稀疏不是 LoRA；预期再省 20–35%，需实测确认画质。
- **ref 上限**：条件节点支持 9 图，现有注入 max 8；可顺手放宽到 9（非必需）。

---

## 5. 验证与 A/B（决定去留的地方）

### 5.1 冒烟（不烧 GPU）

```bash
node scripts/make-h3-variants.mjs --dry
node scripts/smoke-manifest.mjs
node scripts/smoke-render.mjs
node scripts/smoke-tier-resolution.mjs
node scripts/verify-h3-variants.mjs
```

### 5.2 单镜实测（同图 / 同 prompt / 同 seed / 124 帧 / 1344×768）

三臂对照：

| 臂 | 清单 | 已知耗时 |
|---|---|---|
| A 现状 balanced | `minimax-h3-ref2v-balanced` | 166.3s |
| B 现状最优（可选） | `minimax-h3-ref2v-ctx-balanced-pdd-solattn` | 112.7s |
| C 候选 | `minimax-h3-ref2v-balanced-pika` | **待测** |

```bash
comfy_render(capability="video.reference2video", workflow="minimax-h3-ref2v-balanced-pika",
             tier="balanced", width=1344, height=768, length=124, seed=42424242,
             ref_nodes=["<角色卡节点>"], prompt="<与 A/B 逐字相同的 prompt>")
```

记录：墙钟耗时、`params.selfCheck` 抽帧（首/中/末）、音轨是否正常、参考一致性。

### 5.3 字幕专项（**最高优先级**）

现有结论：lightx2v 8 步 balanced **整段不烧**中文内嵌字幕，PDD nfe=8 **逐字烧**（含句号）。Pika 6 步未知，而这条直接决定它能否替代 PDD 做字幕镜：

- 用 `docs/h3-prompt-integration.md` 的「字幕定稿写法」与已有判读流程（抽帧 36/60/84/108，逐字转写比对）；
- 判读三件事：**有没有**、**逐字对不对**、**出现/消失窗口**；
- 若不烧：Pika 只能用于无字幕镜，story skill 的「字幕镜走 PDD/quality」规则保持不变。

### 5.4 画质/音频

- 帧锐度 `mean|∇|`（沿用 PDD 那套指标）：不低于 8 步 baseline 的 −5%；
- 音频：人声清晰度、有无爆音/串音/静音段；
- 运动：快速运镜/转身是否有抖或拖影；
- 时长边界：124 帧（5s）与 310 帧（≈12.9s）各测一次（Pika 官方模板按 5–15s 设计，长镜是否退化未知）。

### 5.5 验收门（建议）

| 门 | 阈值 | 不达标处理 |
|---|---|---|
| 速度 | ≤ 133s（现状 166s 的 0.8×） | 保留为可选实现，不推荐 |
| 速度（挑战 PDD） | ≤ 112s | 才考虑提为 balanced 默认候选 |
| 字幕 | 逐字烧（与 PDD 同级） | 只能做无字幕镜 |
| 画质 | 锐度 ≥ baseline −5%，音频无异常 | 只做实验清单 |
| 稳定性 | 连续 3 镜不 OOM（A800 80GB） | 降 ref 数 / 缩时长 |

全部达标 → `priority` 调 0（或写进 README 推荐策略）；否则保留 `priority < 0` 的可选项。

---

## 6. 风险与未决问题

1. **速度声明口径不明**：官方「约 1 分钟」未注明卡型；6 步 vs 8 步理论只省 ~25% 采样，未必到 60s。以本机实测为准。
2. **固定 sigma 不可调**：不能改步数、不能换 sampler；`steps` 参数对它无效（清单不声明 `params.steps`）。
3. **互斥**：不能与 turbo/Lightning LoRA 叠加，也不能接 `MiniMaxH3SigmaShift`；策略层是「二选一」。
4. **字幕行为未知**：这是产品规则的分水岭（见 §5.3）。
5. **AV 模型蒸馏退化**：6 步在音频与运动上最敏感，必须听音 + 看运动，而不能只看单帧锐度。
6. **授权**：MiniMax H3 Community License 的地域/商用条款需在商用前复核。
7. **磁盘/链路**：容器 `models/` 卷需 ≥5GB；huggingface.co 不可达，走 `hf-mirror.com`（已实测通）。
8. **版本漂移**：适配器是 v1，后续可能改配方；清单 note 里要记死 sigma 串与文件版本。

---

## 7. 工作量与建议顺序

| 步骤 | 内容 | 估时 |
|---|---|---|
| 1 | 下载 2 个 LoRA + sha256 校验 | 0.5h（看带宽） |
| 2 | 2 份模板 + 变体表 + `lib/index.js` 登记 + 生成 | 2–3h |
| 3 | 冒烟 + 单镜 A/B（速度/画质/音频/字幕） | 3–4h |
| 4 | 回填 `estSeconds`、更新 README / USER-MANUAL / tier 文档 | 1h |
| 5（可选） | ctx 变体（2 份模板 + 2 条变体） | 3–4h |
| 6（可选） | `-solattn` 变体 + 实测 | 2–3h |

**建议**：先只做 `ref2v` 一条链（模板 → 清单 → 实测），用 §5.5 的门做 go/no-go；通过后再补 `i2v` 与 ctx。这样最坏情况只损失半天，且不触碰任何既有默认行为。

---

## 8. 首轮实测（2026-11-06，A800 80GB · 已落地 ref2v 三份实现）

### 8.1 已落地清单

| 清单 id | 组 / 档位 | 配方 | priority | estSeconds |
|---|---|---|---|---|
| `minimax-h3-ref2v-balanced-pika` | ref2v / balanced | Pika 6 步 · lcm + 固定 sigma · 无 SigmaShift | −40 | 136 |
| `minimax-h3-ref2v-ctx-balanced-pika` | ref2v-ctx / balanced | 同上 + MotionContext 链式续接 | −100 | 140 |
| `minimax-h3-ref2v-ctx-balanced-pika-solattn` | ref2v-ctx / balanced · solattn | 同上 + 原生 `BlockSparseAttention`(sol-attn, tau 1.0) | −55 | 84 |

模板：`scripts/h3-templates/minimax-h3-pika-ref2v{,-ctx,-ctx-solattn}.json`（由 `minimax-h3-ref2v-8step.json` 派生：删 `MiniMaxH3SigmaShift`/`BasicScheduler`，`KSamplerSelect=lcm`，新增 `ManualSigmas` 固定 7 值串，`BasicGuider.model` 走 `$model` 哨兵挂 `lora_pika`）。

### 8.2 单镜 A/B（同参考卡 / 同 prompt / seed 42424242 / 124 帧 / 1344×768）

| 臂 | 内部执行 | wall | 帧锐度 mean\|∇\| | 备注 |
|---|---|---|---|---|
| 8 步 lightx2v（现状 balanced） | **178.8s** | 252.1s | 50.2 | 对照臂（fp16 VAE） |
| **Pika 6 步** | **135.9 / 136.1s** | 456 / 499s | 50.0 | 两次重复一致；**1.31×** vs 8 步 |
| Pika 6 步 + ctx（起链） | 126.6s | 494.1s | — | 链式节点正常跑通 |
| Pika 6 步 + ctx（续接上一镜） | 163.1s | 437.6s | — | **接缝 PSNR 31.0 dB**（上一镜末帧 vs 本镜首帧） |
| **Pika + ctx + sol-attn(tau 1.0)** | **84.4s** | 407.1s | 44.6 | **对 Pika 6 步 1.5×、对 8 步 2.1×**；锐度 −11% |

证据帧（同 seed / 同 prompt / 2.5s 抽帧）：`docs/research/pika-ab/` 下的 `baseline-8step.png`、`pika6.png`、`pika6-solattn.png`、`pika6-subtitle.png`。

- 音轨：所有产物均为 `avc1 + mp4a`，32 kHz 立体声 127 kb/s，时长 5.17s（124 帧）。
- `wall` 远大于内部耗时（每镜换模型要重载 19.5GB base），**以内部执行时间为准**（与文档既有口径一致）。
- 结论：**Pika 6 步 ≈ 1.31×，稳定复现**；叠原生块稀疏再快 1.5×，但帧锐度掉 11%（单帧判据，需多 seed 复核，暂按 §5.5 视为「不达标可选」）。

### 8.3 字幕专项（关键结论 ✅）

同一张参考卡、同一 prompt 加台词「我们到家了。」与字幕要求，抽 1.5 / 2.5 / 3.5 / 4.5s 四帧判读：

- 1.5s、2.5s：底部出现**逐字正确**的中文「我们到家了。」（含句号），白字、清晰；
- 4.5s：已消失（与 PDD 的 ~2–3.5s 窗口一致，比 prompt 声明的 4.0s 早）；
- 对比既有结论：lightx2v 8 步 balanced **整段不烧字幕**，PDD nfe=8 **逐字烧**。

⇒ **Pika 的字幕行为与 PDD 同级，不属于「不烧字幕」的那一类**。这意味着它有能力替代 PDD 承担字幕镜（仍需多素材/多台词长度复验后才改产品规则）。

### 8.4 遗留与下一步

1. 单 seed / 单镜；锐度是单帧判据 ⇒ 需 2–3 seed + 多镜头复核后再动 priority。
2. `i2v`（FL2VA）已补齐 3 份清单，见 §8.5；ctx / solattn 的 i2v 实际耗时仍为推算。
3. sol-attn 的 −11% 锐度是否可接受，取决于是否把它当「快速预览档」而非成片档。
4. 音频质量需人工听核（AI 不做听音判定）。

### 8.5 i2v（FL2VA）补齐与 A/B（2026-11-06）

新增 3 份清单：`minimax-h3-i2v-balanced-pika`（−40）、`minimax-h3-i2v-ctx-balanced-pika`（−100）、`minimax-h3-i2v-ctx-balanced-pika-solattn`（−55）。模板由 `minimax-h3-i2v-8step.json` 同法派生（删 SigmaShift/BasicScheduler、`lcm` + 固定 sigma、base/LoRA 走 `fl2va` / `pika_h3_flex_fl2va_v1_bf16`）。

| 臂（同首帧 / seed 42424242 / 124 帧 / 1344×768） | 内部执行 | 帧锐度 | 备注 |
|---|---|---|---|
| i2v 8 步 fl2v（现状） | 173.6s | 70.0 | 对照 |
| **i2v Pika 6 步** | **132.2s** | 67.0 | **1.31×**，锐度 −4.3%，时间闪烁 5.1 → 2.0 |

产物：1344×768 / 24fps / 5.17s / aac 立体声。`i2v-ctx` 与 `i2v-ctx-solattn` 的 estSeconds（140 / 84）按 ref2v 同比例推算，**未单独实测**。

### 8.6 运行环境事故：容器被内核 OOM（必须记住）

跑 i2v 时 comfyui 容器被内核 OOM killer 杀掉两次（dmesg：`anon-rss:439389460kB` / `351850200kB`，进程 `python3.14`），`RestartPolicy=unless-stopped` 自动拉起后恢复。

- 根因：ComfyUI 会把用过的 base / LoRA / VAE 留在内存里，**连续换模型的批量跑**会累积到几百 GB；宿主 503GB 也扛不住与另一容器（sglang 占 GPU 79GB）叠加。
- 处置：重跑前 `POST /free {"unload_models":true,"free_memory":true}`；批量跑每 2–3 镜 free 一次；或给容器设 `mem_limit`。
- 影响：两次运行各自重试一次才拿到结果；**不是 Pika 特有的崩溃**（i2v 8 步臂同样触发过一次）。

**OOM 复现实验（2026-11-06 15:04–15:29，全程不用 `/free`）**

- 连续 **10 次**真机生成，不调 `/free`，刻意交替 base / LoRA / 形状（ref2va+8步、ref2va+Pika、fl2va+Pika、fl2va+8步、ctx 起链、ctx+块稀疏、i2v ctx）；
- 结果：**0 次 OOM** —— 容器 restart 计数保持 23 不变，dmesg 的 `Out of memory: Killed process` 计数保持 8 不变；
- 内存：50.9 GiB（起点）→ **83.9 GiB（峰值，第 10 次跑完）**，约 **+1.5 GiB/次** 的缓慢增长，离宿主 503 GB 上限很远；
- 结论：**「不调 `/free`」本身不会导致 OOM**。先前两次 OOM 的进程 anon-rss 是 439 GB / 351 GB —— 属**单次异常分配**（叠加宿主 co-tenant 压力），不是"每镜涨一点、涨到阈值就崩"的累积型问题；`/free` 既不是必要手段，也不是根因修复。
- 实践建议：① `/free` 仍值得保留（回收缓存、减少换模型抖动），但别当成防 OOM 的保证；② 真正兜底是给容器加 `mem_limit` + 告警，或排查/升级 ComfyUI 版本；③ 有 ~1.5 GiB/次 的缓慢增长，长跑批（>50 镜）仍建议定期 free 或重启容器。
- 边界：310 帧长镜压力项未跑（实验按用户要求提前停止）；9:16 未测。

---

## 9. 复核与决策（2026-11-06，任务 1/2/3）

### 9.1 多 seed / 多素材（ref2v，同 prompt 内对照）

| 对照 | seed | 素材 | 8 步 lightx2v | Pika 6 步 | 加速比 | 帧锐度（8 步 / Pika） |
|---|---|---|---|---|---|---|
| A（首轮） | 42424242 | 卡1 · 小孩 | 178.8s | 135.9 / 136.1s | 1.31× | 50.2 / 50.0（−0.4%） |
| B | 20240901 | 卡1 · 小孩 | 173.4s | 133.4s | 1.30× | 57.8 / 54.5（−5.7%） |
| C | 777777 | 卡2 · 桃花女 | 176.5s | 133.6s | 1.32× | 57.1 / 69.0（+20.8%） |

- **速度结论稳定**：Pika 四次 133.4–136.1s，8 步三次 173.4–178.8s ⇒ **1.30–1.32×**，不是抖动。
- **画质**：跨素材的锐度差方向相反（−5.7% / +20.8%），说明单帧锐度受画面内容（花瓣/窗格/背景细节）影响很大，**不宜当唯一判据**；三组对照目视身份、服装、构图一致，无多肢体/串脸。
- 首轮「−11%（solattn）」的结论只适用于 ref2v + 块稀疏；i2v 的块稀疏**没有掉**（见 9.2）。

### 9.2 i2v 的 ctx / 块稀疏实测（回填 estSeconds）

| 实现 | 内部执行 | 帧锐度 | estSeconds |
|---|---|---|---|
| `minimax-h3-i2v-ctx-balanced-pika` | **134.3s** | 66.9 | 134（原推算 140） |
| `minimax-h3-i2v-ctx-balanced-pika-solattn` | **90.9s** | 69.8 | 91（原推算 84） |

i2v 上块稀疏 134.3 → 90.9s（**1.48×**）且锐度 69.8 ≥ 66.9（**未掉**），比 ref2v 的 −11% 好。

### 9.3 字幕：多素材 / 多台词长度（任务 3）

| 素材 | 台词 | 字数 | 1.5s | 2.5s | 4.5s |
|---|---|---|---|---|---|
| 卡1 小孩 | 我们到家了。 | 5 | ✅ | ✅ | ⬜ 已消失 |
| 卡1 小孩 | 师父，院子里的玉牌今天又亮了。 | 15 | ✅ | ✅ | ✅ 仍在（挂到片尾） |
| 卡2 桃花女 | 今年的桃花，开得比往年都早。 | 14 | ✅ | ✅ | ✅ 仍在 |

- 三句**全部逐字正确**（含中文标点），跨两张角色卡、两种画风；
- **出镜窗由模型决定且跟台词长度相关**：短句 2–3s 就退场，长句会挂到片尾 —— 与「声明 4.0s 结束」无关；
- 结论：Pika 满足 skill 里「实现级字幕已验证」的门槛，可承担 `burned-in` 字幕镜；但「字幕必须消失」的镜头不能靠 prompt 结束点，得拆短句或用无字幕镜。

### 9.4 决策建议

1. **写进推荐策略，但不改内置默认**：建议 balanced 走 `…-balanced-pika`（速度 1.30×、字幕可用、链式续接可用）；**保持默认 8 步**，原因是注册表的可用性预检只查节点、**不查模型文件**——Pika 依赖两个 1.8GB LoRA，设成默认会让未下载权重的环境直接渲染失败。默认仍是"装好就能跑"的 8 步。
2. **字幕规则**：把 Pika 补进 `docs/h3-prompt-integration.md` §5.4 的实现矩阵（已补），并在 skill 的实现取证入口里作为「已验证」选项；skill 的默认仍是 `quality`（行为最稳），字幕镜改用 Pika 属于「同档更省的已验证实现」，需逐镜过自检门。
3. **solattn 定位**：ref2v 上仍是"快速预览"（−11%）；i2v 上可当"低成本日常"（未掉锐度）。
4. **未覆盖**：9:16 竖屏、>124 帧长镜、音频质量（需人工听核）、更多台词长度（>20 字）。

---

## 10. 叠加 Sol-H3-VAE（2026-11-06）

> **权威记录已独立成篇**：[`docs/research/sol-h3-vae-ab.md`](sol-h3-vae-ab.md)（节点级 WebSocket 计时、balanced / fast / Pika-4 步三档、画质 PSNR/SSIM、A/B 陷阱）。
> 本节只保留两条别处没有的东西：**接线必须避开的坑**，以及本报告口径下的**独立复核数字**。

### 10.1 坑：它是纯解码器，不能直接替换 `assets.vae`

`sol_h3_vae.safetensors`（6.1 GB）是 24 层非因果**蒸馏解码器**，没有 encoder。而 H3 图里同一个 VAE 既喂
`MiniMaxH3ReferenceToVideo.vae` / `MiniMaxH3MotionContext.vae`（编码参考图、出 latent），又喂 `VAEDecode`。
直接整体替换的报错：

```
AttributeError: 'MiniMaxH3VideoVAE' object has no attribute 'quant_conv'
  at comfy/ldm/minimax/vae.py:971 encode → _adaptive_encode → tiled_encode → _encode_moments
```

正确接法：**另加一个 VAELoader 只喂 `VAEDecode`**（该变体里是节点 `4b` + 资产槽 `vae_decode`），编码链路仍用原 `minimax_h3_video_vae_int8_convrot`；音频 VAE 不动。

### 10.2 独立复核（端到端，全新 seed，1344×768×124f，chain 0,1）

| 臂 | seed | 内部执行 |
|---|---|---|
| 解码 = int8_convrot | 91001 / 91002 | 79.1s / 79.7s |
| 解码 = **Sol-H3-VAE** | 91003 / 91004 | **75.4s / 75.6s** |

⇒ **−3.9s / −4.9%**，两组区间不重叠；与 sol-h3-vae-ab.md 的 −5.7% 同量级（差异来自版本/取样）。

**A/B 陷阱（与 sol-h3-vae-ab.md §「必须记住的陷阱」同源，这里独立踩到两次）**：
1. ComfyUI 按节点输入哈希缓存 —— **同 seed 重跑会跳过采样**（实测只剩 2.5–2.9s）。端到端对比必须每次换新 seed；只有「同 seed 一对」才能用来测「同一 latent、只换解码器」的等价性。
2. 两臂**编码 VAE 必须一致**（Pika 清单默认 int8、标准清单默认 fp16；编码侧一变，采样缓存失效，整镜 A/B 失真）。

### 10.3 画质等价（同一 latent，只换解码器）

0.5s / 2.5s / 4.5s 抽帧 PSNR = 31.9 / **36.3** / 33.9 dB；扫 ±0.42s 无时间偏移；124 帧 / 5.17s / 24fps 一致。
（数值低于 sol-h3-vae-ab.md 的 41.9 dB(Y)，因为本次是 h264 输出互比，含两次编码损失。）

证据帧：`docs/research/pika-ab/solvae-int8-decode.png` / `solvae-sol-decode.png`。

### 10.4 结论

- **解码确实提速 ~1.8–2×**（本机 int8 9.9s → Sol 5.4s），但整镜收益由采样占比决定：balanced 1344 约 −5.7%，fast 832 约 −10.5%。
- **代价**：+6.1 GB 常驻、图结构多一个只喂解码的 VAELoader（不能靠 `assetOverrides.vae` 一行切换）、不能 tile（整片解码，显存随片长/分辨率涨）。
- 因此**作为可选实现保留**（`-solvae` 清单，priority<0，只能显式选用），不进任何档位默认；**采样占比越高（短镜 / fast 档 / 2K 大画面）收益越值得开**。
