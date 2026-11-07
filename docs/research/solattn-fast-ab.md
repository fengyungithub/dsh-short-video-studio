# Fast 档 Sol-Attn（原生块稀疏）A/B 速度实验

> 实验时间：2026-10-26 20:00–20:15（Asia/Shanghai）
> 目的：验证 **fast 档（4 步 / 832×480 / 124f）** 开 Sol-Attn 到底能快多少。
> 结论：**能快，但只有约 1.15×（省 13–14%，约 2.9s/镜），不是翻倍**；`tau=1.3` 只再快 0.3s，
> 画质却明显更软，**若要用，选 `tau=1.0`**。

---

## 0. 一句话结论

| 配置 | 基线（无 Sol） | Sol-Attn | 加速比 | 每 5.17s 镜头节省 |
|---|---|---|---|---|
| **fast + tau=1.0** | **22.63s** | **19.69s** | **1.149×** | **2.94s（13.0%）** |
| fast + tau=1.3 | 22.63s | 19.41s | 1.166× | 3.22s（14.2%） |

- 数据为 ComfyUI `execution_start → execution_success` 内部耗时，n=4，热态，同 prompt/参考图/分辨率/帧数。
- `tau=1.3` 相对 `tau=1.0` 只多省 **0.28s**，但画面（毛发/地表细节）明显更软 → **不划算**。
- 画质：`tau=1.0` 目视与基线同档，后段略软；**无结构崩坏、无参考图污染，音轨正常**。
- 与历史结论的关系：文档里"480p 只有 1.03×、不要开"测的是**第三方 `SolAttnMiniMaxH3`**；
  本次用的是 ComfyUI **原生 `BlockSparseAttention`（selection=sol-attn）**，结论更新为 **1.15×**。

---

## 1. 测试条件

| 项 | 取值 |
|---|---|
| 机器 | 单卡 **本机单卡**；ComfyUI **0.42.1**；torch 2.15.0.dev+cu132；py3.14；`cudaMallocAsync` |
| 工作流 | `minimax-h3-ref2v-ctx`（fast 档，链式续接模板；config 的 `video.reference2video.fast` 就是它） |
| 两臂差异 | **唯一差异**：Sol 臂多一个 `2b = BlockSparseAttention`，并把 `7 BasicGuider.model` / `9 BasicScheduler.model` 改指 `2b` |
| 采样 | 4 步，`res_multistep`，shift **12/3**，fast LoRA `minimax_h3_ref2v_turbo_4step_v0.1` |
| 资产 | ref2va `pruned_int8_convrot` + 视频 VAE `int8_convrot` + CLIP nvfp4 + audio VAE fp32 |
| 画面 | **832×480**（16:9），**124 帧**（5.17s @24fps） |
| 参考图 | `canvas/session-bc8f982d-…/e9cd2fee-…_00001_.png`（与历史加速实验同一张单视图狐狸卡） |
| prompt | 与 `docs/minimax-h3-video-benchmark.md` 基准臂同一份 H3 结构化 prompt |
| 续接 | 起链：`context_clip_index=0`（不读上一镜 latent）；`save_clip_index=9001`（避开生产链 slot，防止覆盖别的会话） |
| Sol 参数 | `selection=sol-attn`，`start_percent=0.2`，`min_tokens=12288`，`sink_conditioning=exact_kv_and_rows`，`dense_first_percent` 不适用（原生节点无此项） |

> 分辨率 token 量：832×480/124f ≈ **15.9k**（含 1536 前缀），高于 `min_tokens=12288`，稀疏确实触发；
> 但 `sink_conditioning` 会让文本/音频/参考前缀保持稠密，这是收益被限制的主要原因之一。

---

## 2. 方法（以及一个必须避开的坑）

1. **同图 A/B**：两臂由同一份 `minimax-h3-ref2v-ctx` 模板派生，脚本会校验「除 `2b` 与 `7/9.model` 外，
   编译出的图逐字段一致」，否则拒绝开跑。
2. **热机**：两臂各跑一次（含 UNet 加载 / 首次 Sol kernel 初始化），热机耗时不计入统计。
3. **交替顺序**：每对按 `base→sol` / `sol→base` 翻转，抵消热漂移；每对 **共享同一个 seed**，
   保证噪声与构图可比。
4. **缓存坑（首轮作废）**：ComfyUI 会按节点输入哈希做全局缓存。首轮同 seed 重复提交时，
   采样直接命中缓存，测出 **0.0–0.2s** 的假结果。**修复**：每对用**不同 seed**（成对共享），
   强制重跑采样；热机 seed 与正式 seed 再错开 10^6，避免命中热机缓存。
5. **取数**：用 `/history` 的 `execution_start → execution_success` 时间戳，与历史 benchmark 口径一致；
   同时记录 wall time（含提交/轮询/下载）作参考。

---

## 3. 结果

### 3.1 tau=1.0（推荐档）

seed 77770000–77770003，交替顺序。

| 臂 | 逐次内部耗时（s） | 中位数 | min–max | sd |
|---|---|---|---|---|
| base | 22.50 / 22.50 / 22.76 / 23.07 | **22.63** | 22.50–23.07 | 0.23 |
| sol | 19.55 / 19.56 / 19.82 / 19.98 | **19.69** | 19.55–19.98 | 0.18 |

- **加速比 1.149×**，节省 **13.0%**。
- wall time 中位数：base ≈ 24.4s，sol ≈ 20.7s（差 ~3.7s，含轮询/下载开销）。
- 热机复核：base 22.57s，sol 19.49s —— 与正式测量一致。

### 3.2 tau=1.3（更稀疏，收益饱和）

seed 88880000–88880003。

| 臂 | 逐次内部耗时（s） | 中位数 | min–max | sd |
|---|---|---|---|---|
| base | 22.55 / 22.60 / 22.66 / 22.82 | **22.63** | 22.55–22.82 | 0.10 |
| sol | 19.29 / 19.39 / 19.42 / 19.63 | **19.41** | 19.29–19.63 | 0.12 |

- **加速比 1.166×**，节省 **14.2%**。
- 相对 tau=1.0 只多 **0.28s**；稀疏度从 ~16% 块降到 ~7% 块，但端到端几乎不动
  ⇒ 瓶颈已不在注意力块选择上。

---

## 4. 画质核对（同 seed 成对目视 + 指标）

取每对首/中/末帧，抽帧核对：

- **结构/身份**：两臂都保持狐狸角色、橙色宇航服、月面场景；无角色副本、无参考图文字被投影、无环境材质替换。
- **音轨**：所有产物均含音轨（mp4 `mp4a` box 存在），124 帧 / 24fps / 832×480。
- **细节**：
  - `tau=1.0`：首帧清晰度与基线相当；后段（f62/f123）毛发与月壤略软，但仍在 fast 档"预演可用"范围。
  - `tau=1.3`：首帧、后段都明显更软（毛发边缘糊、月面细节丢失），**不建议**。
- **客观指标**（Laplacian 方差 / Tenengrad，均值；仅作趋势参考——两臂采样轨迹不同，内容本身会变）：

| 配置 | 帧 | base lapvar / ten | sol lapvar / ten |
|---|---|---|---|
| tau=1.0 | f0 | 314 / 8460 | 318 / 8057 |
| tau=1.0 | f62 | 198 / 7800 | 165 / 6313 |
| tau=1.0 | f123 | 167 / 7004 | 138 / 5359 |
| tau=1.3 | f0 | 373 / 9164 | 265 / 6563 |
| tau=1.3 | f62 | 264 / 8411 | 148 / 5787 |
| tau=1.3 | f123 | 174 / 6815 | 129 / 5155 |

- 文件体积：tau=1.0 时 sol 略大（1.38MB vs 1.24MB）——主要来自运动/噪声差异，不能单独当画质判据。

对比图：

- `e2e-out/solattn-fast-ab/compare/tau1c-pair1.jpg`（tau=1.0，base 上 / sol 下）
- `e2e-out/solattn-fast-ab/compare/tau13-pair2.jpg`（tau=1.3，明显更软）

---

## 5. 解读

1. **为什么只有 1.15×**：fast 档端到端里，4 步采样只是一部分；文本/参考/音频前缀（~1.5k token）
   被 `sink_conditioning` 强制稠密，VAE 解码、音频解码、封装是固定成本。Sol 只省"视频 token 的注意力"，
   而 480p 的 token 量（15.9k）刚过 `min_tokens` 阈值，稀疏收益本来就不大。
2. **为什么 tau 1.0→1.3 不涨**：注意力已不是主瓶颈；再稀疏只减少少量 attention 计算，
   却更早伤到细节。继续加大 tau 没有性价比。
3. **和旧结论的差异**：旧文档 §9.8 的 480p 1.03× 是**第三方 `SolAttnMiniMaxH3`**
   （torch.compile flex_attention，且在 0.35+ cudaMallocAsync 上会崩）；本次原生节点无崩溃、1.15×，
   说明原生路径的固定开销更低，值得更新结论。
4. **批量收益**：以 20 镜/集计，fast 档每集约省 **59s**（20 × 2.94s）；对"预演/调 prompt"环节是净收益。

---

## 6. 建议

- **若接入 fast 档**：用 **tau=1.0**，**做成可选实现 / 速度策略，不设为默认**。
  理由：+13% 速度换后段轻微变软；fast 档本来就是预演档，是否值得取决于片型。
- **不要用 tau=1.3**：只快 0.28s，画质下降肉眼可见。
- **未测但值得下一步**：
  1. **续接镜（clip_index > 0）**：带上一镜 latent 时 token 更多，Sol 的收益可能比 1.15× 更大；
  2. **i2v fast**：fl2va 路径是否同样 ~1.15×；
  3. **9:16 竖版**：同像素数，预期与 16:9 接近，但分块布局可能有差异；
  4. **是否登记进注册表**：新增 `minimax-h3-ref2v-ctx-fast-solattn` / `minimax-h3-i2v-ctx-fast-solattn`
     两个清单 + 设置页可选（不设默认），需要单独做一次"开/关"配置验证。

---

## 7. 复现与产物

```bash
# dry run：打印两臂配方并写图
node scripts/experiment-solattn-fast.mjs --dry

# tau=1.0，4 对，seed 77770000 起
node scripts/experiment-solattn-fast.mjs --pairs=4 --seed=77770000 --tag=tau1c

# tau=1.3
node scripts/experiment-solattn-fast.mjs --pairs=4 --seed=88880000 --tau=1.3 --tag=tau13
```

产物（均在 `e2e-out/solattn-fast-ab/`）：

| 文件 | 内容 |
|---|---|
| `tau1c-results.json` / `tau13-results.json` | 全部逐次耗时、seed、产物文件名、统计 |
| `run-tau1c.log` / `run-tau13.log` | 运行日志（含热机） |
| `tau1c-base-*.mp4` / `tau1c-sol-*.mp4` | tau=1.0 两臂视频 |
| `frames-tau1c/` `frames-tau13/` | 抽帧（f0 / f62 / f123） |
| `compare/tau1c-pair*.jpg` `compare/tau13-pair*.jpg` | 两臂并排对比图 |
| `quality-tau1c.json` `quality-tau13.json` | 画质指标原始数据 |
| `tau1-results.json` | 首轮缓存命中作废的原始记录（保留以便追溯） |

脚本：`scripts/experiment-solattn-fast.mjs`（不修改生产注册表；两臂都是临时 manifest）。
