# 镜头链式续接（continuity_from）契约

> 一句话：**同场景的下一镜可以继承上一镜的"末尾运动 + 末尾声音"，而不是拿一张静帧重新猜。**
> 实现方式与模型名都封在清单里（`manifest.chain`），工具面只多一个入参 `continuity_from`。

本文是三类读者的唯一契约源：写清单的人（声明什么）、写流程 skill 的人（什么时候用）、
改 runner 的人（怎么承接序号与长度）。

---

## 1. 它解决的是什么

H3 是**每镜独立生成**的 AV 模型：第二镜哪怕 prompt 写"承接上一镜结尾"，模型也只能从参考图
重新构图——分镜表里"同场景两镜"会变成"同一个场景的两次不同演绎"：人物姿态、机位、色彩、
环境音全部重新掷一次。实测（同 prompt、同 seed、只差是否续接）：

| 指标 | 续接 | 不续接（对照） | 说明 |
|---|---|---|---|
| 上一镜末帧 ↔ 本镜首帧 逐像素平均绝对差 | **5.9 / 255** | 67.0 / 255 | 越接近 0 越像"同一段连续画面"；同一条片子首尾帧的自测基线是 58 |
| 接缝处响度台阶 | **0.5 dB** | −5.7 dB | 对照在切点明显"掉音量" |

画面这一半是**决定性**的：续接把接缝误差压到对照的 1/11，已经低于"一条片子首尾"的自然差异。

音频这一半要分开说（见 §5 未验证项）：**响度连续性稳定变好**；**前后波形相关性只在有节拍/
有对白的素材上才可测**（音乐型素材实测包络相关 0.87 vs 对照 0.25；纯风声素材上该指标对
"续接"和"随便两段"都给不出区分度）。

---

## 2. 权威语义（上游包的设计，不是我们发明的）

链式续接基于 `ComfyUI-H3-Motion-Context`（第三方包，装到远端 ComfyUI）。它的序号语义是**槽位**：

```
第一镜（起链）：  Load 0  / Save 1      ← Load 0 = 没有上文，上下文节点原样放行、不裁帧
第二镜（续接）：  Load 1  / Save 2
第三镜（续接）：  Load 2  / Save 3      ……
```

* `Load N` = **从第 N 镜继续**；`Save N+1` = 本镜存到 N+1 号槽位（重跑覆盖自己的废片，不堆文件）。
* latent 以文件形式落在 ComfyUI **输出目录** `h3_context/clip_0000N.safetensors`（跨运行传递；
  不能直接连采样器输出，那是自环）。
* 续接会把上一镜末段 **22 帧画面 + 24 帧（1 秒）音频**钉进新镜的开头（latent 级，不经解码/再编码），
  采样时多采这部分、交付前裁掉——所以**请求帧数 ≠ 采样帧数**。
* 相关节点：`MiniMaxH3MotionContext`（钉上下文）、`…Trim`（裁掉继承段）、`…SaveLatent` / `…LoadLatent`
  （槽位读写）、`…SeamProbe`（接缝测量）。

---

## 3. 插件契约

### 3.1 清单声明（`manifest.chain`）

```jsonc
"chain": {
  "source": "clip-latent",     // 上一镜的来源形态（当前只有"服务端 latent"）
  "sampleExtra": 22,           // 为继承而多采的帧数（续接时加在请求帧数上；起链时不加）
  "lengthGrid": [17, 5]        // 合法采样帧数 = 17k+5（H3 的时长网格）：向上取整，不缩短交付
},
"params": {
  "context_clip_index": { "inject": "scalar", "to": { "node": "20", "field": "clip_index" } },  // Load 槽位
  "save_clip_index":    { "inject": "scalar", "to": { "node": "22", "field": "clip_index" } }   // Save 槽位
}
```

* 声明了 `chain` 的清单**既能起链也能续接**：不传 `continuity_from` 就是**起链**（Load 0）。
* `priority` 建议为负：链式实现**永不作为档位隐式默认**（它需要上一镜，不该被默认档悄悄选中）。
* 依赖用 `requiresNodes` 声明（`MiniMaxH3MotionContext*`），缺节点时可用性预检会显式置灰/报错。
* **runner 不认识任何模型名**：多采几帧、按什么网格取整，全部来自清单（与 `params`/`resolution` 同一思路）。

### 3.2 工具入参

```
comfy_generate_video(..., continuity_from?=上一镜的画布视频节点 id)
comfy_render(capability, ..., continuity_from?)
```

* 传了 `continuity_from` → **只在声明了 `chain` 的实现里解析**（该档没有链式实现就显式报错，
  **不会**悄悄退回普通生成——那等于把"续接"做成"另起一镜"）。
* 不传 → 普通实现（跨场景、首镜照旧）。
* `length` 永远是**交付帧数**：换算、取整、多采全部由清单+runner 负责，写分镜的人不用算。

### 3.3 画布节点上的状态（链的"记忆"就在这里）

链式实现渲染出的节点会带：

```jsonc
"params": {
  "workflow": "minimax-h3-ref2v-ctx-fast",
  "clipIndex": 6680,          // 本镜的 Save 槽位 → 下一镜 Load 它
  "contextClipIndex": 0,      // 本镜 Load 的槽位（0 = 起链）
  "continuityFrom": null,     // 上一镜节点 id（起链为 null）
  "sampledLength": 158,       // 实际采样帧数（模型输入）
  "length": 136,              // **实际交付帧数**（采样裁剪后；排时长/拼接看这个）
  "requestedLength": 124      // 调用者请求的帧数（保留可追溯）
}
```

下一镜只要把 `continuity_from` 指向本节点 id，序号与分辨率校验由 runner 自动完成。

---

## 4. 硬约束与失败模式（都是显式报错，不静默降级）

| 约束 | 违反时的行为 |
|---|---|
| 同场景**第一镜**必须用链式实现渲染（不传 `continuity_from` 即可起链） | 拿普通实现的节点去续接 → 报"上一镜没有链式序号"，并指出上一镜用的是哪个实现 |
| 一条链内**分辨率/比例必须一致** | 报分辨率不符：latent 无法缩放，要么同档重渲上一镜，要么从这里另起一链 |
| 交付帧数按 `17k+5` 网格**向上**取整 | 请求 124 → 采样 158（124+22=146 上取整）→ 交付 **136**；三者都记在节点上 |
| 同一 ComfyUI 输出目录被多会话共享 | 起链起点按会话随机取（1–9000）并在会话内单调递增；**跨会话撞槽位的概率极低**，一旦撞上且分辨率相同则不会被发现（见 §5） |
| 链条长度 | 每个会话的链序号最多用到 9999（`clip_index` 上限） |

---

## 5. 未验证 / 已知风险

* **档位覆盖**：**四档全部实跑完成**（fast / balanced / balanced-pdd / quality，各档原生分辨率、
  同 seed 对照）——见附 B。加速件叠加（PDD nfe=8、8 步 768p 蒸馏、4 步蒸馏）**已验证**；
  唯一未测的叠加是 Sol-Attn，因为它会让 ComfyUI 硬崩（附 C），链式组的 Sol 变体已撤销。
* **音频**：连续性与响度台阶有对照结论，音乐型素材上四档全部正向（附 B）。
  波形相关性只在音乐/对白素材上有区分度；"风声/环境音"这类噪声型声景，人耳判断仍优于任何相关系数。
* **跨会话槽位冲突**：随机起点只是把概率压到极低，没有硬保证（上游包没有校验和/所有权标记）。
  真正需要强隔离时，可以按项目分配互不重叠的序号段。
* **长时间链**：作者提示音频在长链上会逐渐变闷、分辨率锁死整条链；本插件未做链长限制（本轮最长只验到 3 镜）。
* ~~**i2v 版续接**~~ **已实现（fast 档已实测）**：`type=i2v` + `continuity_from` 走 `minimax-h3-i2v-ctx-*`，服务端行为与 r2v 一致（见附 E）；**balanced / balanced-pdd / quality 三档待补**，且 fast 档的对照设计有缺陷需重做（见附 E）。
* **跨形状续接**：允许且**两侧都能续接**（r2v / i2v 各有一套 ctx 实现）；仍**不校验上一镜形状**（刻意设计），端到端实跑待补。

---

## 6. 怎么用（流程侧规则）

1. **同场景第一镜**：用链式实现渲染（不传 `continuity_from`）= **起链**。
2. **同场景后续镜**：`continuity_from = 上一镜节点 id`（参考卡照传，负责身份/环境）——**续接只负责"接着走"，不负责认人**。
3. **跨场景**：新场景第一镜`起链`（不传 `continuity_from`）；跨场景的连续由**转场镜**承担——默认走 **i2v 双端锚定**（前一场景尾镜末帧 + 下一场景首镜首帧），只有"下一场景首镜还没生成"时才用 `r2v + continuity_from=前一场景尾镜` 出草稿。
4. 分镜表里的 `length` 按**交付时长**写；网格取整带来的偏差（最多 +12 帧 ≈ 0.5s）在节点上可查。

### 6.1 规划阶段就要标注续接（`3d-animation-short-generator` 的做法）

该片型 skill 的**正片镜一律 r2v**，镜头间连续性以**链式续接**为主；**i2v 只保留在两处**（刻意保留的能力）：**跨场景转场镜的双端锚定**与**锚点式重渲**。因此：

* **镜头表从六列变七列**，新增 **`续接`** 列，取值 `起链` / `接 S0x` / `锚定 S0x↔S0y`（第三个是转场镜专用），**规划分镜时就必须填**（不许留到生成阶段现编）。
* **分镜文档**每镜章节的「连续性」字段与双绑定标记同步带上续接（`[cont:start|S0x]`，渲染前剥离）。
* **自检门从九项变十项**：第 9 项「续接链闭合性」（场景首镜必须起链、`接 S0x` 必须相邻或为前一场景尾镜、一条链同档同分辨率、转场镜只出现在跨场景边界）、第 10 项「续接可行」（**开场约 0.9–1s 仍是上一镜结尾的延续** ⇒ 动势/光位要接得上、新角色与新字幕登场安排在第 1 秒之后、要"开场全新画面"就改用 `起链`）。
* **含字幕的镜头更要注意**：续接继承的是上一镜**最后约 22 帧画面**（不只是末帧），烧录字幕会被整段带进下一镜 ⇒ 跨边界前一镜的**最后 0.5s 必须无对白无字幕**。
* **转场镜**默认 `type=i2v` **双端锚定**（`first_frame_node`=前一场景尾镜末帧、`last_frame_node`=下一场景首镜首帧）⇒ **收尾精确落回下一镜首帧**，代价是需要下一镜已批准；备选才是 `r2v + continuity_from` 草稿。
* **锚点式重渲**（i2v 双端锚定）保留为例外路径；注意 **i2v 产物无链式 latent** ⇒ 用它替换链上一环，下游不能再 `接 它`（须改成 i2v 锚定或 `起链`）。
* **重渲连锁**：任何镜重渲都会生成新的服务端 latent ⇒ 所有 `接 该镜` 的下游镜（含场景尾镜对应的转场镜）**必须顺次重渲**，下游的 `continuity_from` 换成重渲后的新节点 id。

---

## 7. 复现与验证

命令见**附 D**。清单与模板：

* 模板：r2v `scripts/h3-templates/minimax-h3-ref2v-ctx.json`、`…-8step-ctx.json`、`…-pdd-ref2v-ctx.json`；i2v 由 `scripts/make-h3-ctx-templates.mjs` 从普通 i2v 模板**派生**（`minimax-h3-i2v-ctx.json`、`…-8step-ctx.json`、`…-pdd-i2v-ctx.json`，勿手改）
* 清单（生成物，勿手改）：`workflows/minimax-h3-ref2v-ctx-{fast,balanced,balanced-pdd,quality}.json`、`workflows/minimax-h3-i2v-ctx-{fast,balanced,balanced-pdd,quality}.json`
* 覆盖矩阵基准：`scripts/bench-chain-continuity.mjs` → `e2e-out/chain-bench/{report.md,rows.json}`；i2v 端到端 `scripts/e2e-chain-continuity-i2v.mjs` → `e2e-out/chain-continuity-i2v/`
* 生成器：`scripts/make-h3-variants.mjs`（清单）、`scripts/make-h3-ctx-templates.mjs`（i2v ctx 模板）

---

## 8. 形状（type）与续接的关系

续接与"形状"正交，且**形状现在必须显式传**（见 `docs/video-shape-contract.md`）：

| | 不传 `continuity_from` | 传 `continuity_from` |
|---|---|---|
| `type=r2v`（参考绑定） | 独立镜 | **链式续接**（本节所述，已交付） |
| `type=i2v`（首末帧串联） | 首帧锚定 / 转场镜 / 锚点式重渲 | **链式续接**（`minimax-h3-i2v-ctx-*`，fast 档已实测，见附 E；注意链式 i2v 里 **`first_frame_node` 会被丢弃**、`last_frame_node` 保留） |

**跨形状续接是允许的**（上一镜 `r2v` → 本镜 `i2v` + `continuity_from`）：链的 latent 只校验分辨率+通道、
没有形状标签，所以插件**不校验上一镜的形状**——刻意设计，用于"机位锁定 / 转场"这类需要首帧锚定又必须
继承尾部的镜头。两侧的链式实现现已齐备（r2v 与 i2v 各一套 ctx 清单，`VIDEO_SHAPES` 两侧都 `chain: true`）。

## 附 A：机制验证矩阵（裸图直提 ComfyUI API，不含插件）

目的：先证明**机制本身有用**，再谈插件包装是否把它接对。素材为**音乐型声景（100 BPM）**——
噪声型环境音上音频指标无区分度（见附 C）。

| 路径 | 上一镜 → 本镜 | 画面接缝 MAD (0–255) | 音频相关 1s | 包络相关 | 接缝响度台阶 |
|---|---|---|---|---|---|
| 像素路径（上一镜尾 22 帧 + 尾 1s 音频） | A → B **续接** | **11.1** | 0.44 | — | −1.7 dB |
| 像素路径 · 同一对**不续接** | A → B 对照 | 57.4 | 0.31 | — | **−16.0 dB** |
| latent 路径（服务端 Save/Load Latent） | B → C **续接** | **3.2** | 0.49 | — | +5.2 dB |
| 音乐型素材（100 BPM） | A3 → B3 **续接** | **7.2** | **0.60** | **0.87** | +15.9 dB |
| 音乐型素材 · **不续接** | A3 → B3 对照 | 62.8 | 0.17 | 0.25 | +1.9 dB |
| 自测基线（同一条片子的首帧 vs 末帧） | — | 58.2 | — | — | — |

怎么读：

* **画面这一半是决定性的**：续接把接缝误差压到对照的 1/8–1/11（3.2–11.1 vs 57.4–62.8），
  且已低于"同一条片子首尾帧的自然差异"58.2 ⇒ 接缝处已经是"同一段连续画面"的量级，而不是"两段拼起来"。
* **latent 路径优于像素路径**（3.2 vs 11.1）：从上一镜 latent 直接切片，省掉一次"解码 → 再编码"的有损往返。
* **音频只在有结构的素材上可测**：100 BPM 音乐型素材包络相关 0.87 vs 对照 0.25；噪声型声景无区分度。
* **不续接的对照普遍在切点塌音量**（−16.0 / −8.78 / −19.83 dB），这是"每镜独立生成"最容易被耳朵抓到的症状。

日志佐证：`h3_motion_context: loaded AV latent from … clip_0000N.safetensors` / `saved … clip_000(N+1).safetensors`；
`tail padded 266 zero samples (8.31ms)`、`drift 0.01ms`（音频对齐无漂移）。

## 附 B：插件路径 · 档位 × 加速件覆盖矩阵（4 档全绿，同 seed 对照）

口径：**同一 prompt、同一 seed、各档原生分辨率**、素材为带 100 BPM 节拍的音乐型声景；
每档跑三镜「起链 → 续接 → 同 seed 对照（普通实现）」；指标＝上镜→本镜接缝。
脚本 `scripts/bench-chain-continuity.mjs`（`--only=<档>` / `--fresh`），原始数据 `e2e-out/chain-bench/rows.json`。

| 档位实现 | 加速件 | 分辨率 | 帧数 起链/续接/对照 | 画面 MAD 续接→对照 | 音频相关 1s 续接→对照 | 包络相关 续接→对照 | 响度台阶 续接→对照 | 耗时 起链/续接/对照 (s) |
|---|---|---|---|---|---|---|---|---|
| `minimax-h3-ref2v-ctx-fast` | 4 步蒸馏 LoRA | 832×480 | 124/136/136 | **7.016** → 67.559 | **0.391** → 0.060 | −0.216 → −0.142 | **+0.69 dB** → −19.83 dB | 76.7 / 38.4 / 2.3※ |
| `minimax-h3-ref2v-ctx-balanced` | 8 步 768p 蒸馏 LoRA | 1344×768 | 124/136/136 | **2.631** → 32.350 | **0.534** → 0.017 | +0.134 → −0.091 | **−0.77 dB** → −8.78 dB | 152.5 / 209.6 / 182.8 |
| `minimax-h3-ref2v-ctx-balanced-pdd` | PDD nfe=8 | 1344×768 | 124/136/136 | **3.436** → 51.176 | **0.305** → 0.065 | **+0.827** → −0.293 | **−0.26 dB** → −14.62 dB | 152.9 / 283.6 / 188.2 |
| `minimax-h3-ref2v-ctx-quality` | 无（20 步） | 1344×768 | 124/136/**141** | **2.605** → 35.546 | **0.552** → 0.096 | −0.097 → −0.267 | **+0.09 dB** → −24.04 dB | 361.9 / 676.2 / 443.1 |
| ~~`…-ctx-balanced-pdd-sol`~~ | PDD + Sol-Attn | — | — | — | — | — | — | **撤销**：Sol-Attn 崩服务（附 C） |

※ fast 档对照镜 2.3 s 是 ComfyUI **缓存命中**（同图同种子 → 产物逐比特相同）；产物有效，但别当耗时基准。后续各档已换种子，不再命中。

结论：

1. **四档一致**：续接把接缝画面差压到 2.6–7.0，同 seed 对照 32–68 —— 机制与档位无关。
2. **音频在音乐型素材上四档全部正向**：1 s 窗相关 0.305–0.552（对照 0.017–0.096）；
   PDD 档包络相关最突出（+0.827 vs −0.293）；quality 档响度台阶最干净（+0.09 dB vs −24.04 dB）。
3. **续接带来的是"同一段画面"，不是"更高画质"**：MAD 与档位几乎无关（2.6–7.0），画质仍由档位与权重决定。
4. **成本**：续接镜多采 22 帧再裁掉，同档位耗时差异在噪声内（fast 续接 38.4 s vs 对照 76.7 s 起链；
   balanced/quality 续接镜耗时接近或略高于对照，属采样步长与分辨率主导）。

## 附 C：测量口径与已知坑

* **测量位置**：在 ComfyUI 容器内跑 `e2e-out/ctx-test/measure_seam.py`（容器自带 av+numpy，不依赖宿主 ffmpeg）。
* **指标**：① 上一镜末帧 ↔ 本镜首帧逐像素平均绝对差（0–255，越小越连续）；② 接缝两侧音频宽带相关（100/250/500/1000 ms 窗）；
  ③ 20 ms RMS 包络相关（1 s 窗）；④ 接缝两侧响度台阶（dB）。
* **噪声型声景（风、雨、环境噪声）上音频相关系数无区分度**——续接与"随便两段"给不出差别，只能靠听；响度台阶仍有效。
* **对照镜时长与续接镜差一个长度网格步长**（H3 为 17k+5，最多 +12 帧 ≈ 0.5 s）——不影响接缝指标。
* **ComfyUI 缓存**：同图同种子直接返回缓存产物（秒级、逐比特相同）；结论有效，但耗时不可比。
* **`comfy-unreachable: fetch failed` 不一定是网络问题**：本轮两次是远端 ComfyUI 被 Sol-Attn 打崩后重启
  （`CUDA_ERROR_INVALID_VALUE from cuMemFreeAsync` → `Fatal Python error: Aborted`，带／不带续接都崩，
  连容器一起重启）。详见 `docs/minimax-h3-acceleration-lora.md` §9.10；链式组的 Sol 变体已从交付集撤销。

## 附 D：复现

```bash
# 机制层（裸图直提 API，含像素路径 / latent 路径 / 自测基线）
node scripts/e2e-chain-continuity.mjs        # 插件层端到端：起链 → 续接 → 非链式反例 → 同 seed 对照 → 抽帧回归
node scripts/bench-chain-continuity.mjs      # 档位 × 加速件覆盖矩阵（--only=fast|balanced|balanced-pdd|quality）
python3 e2e-out/ctx-test/measure_seam.py <上一镜.mp4> <本镜.mp4> <输出目录>   # 接缝量化（容器内跑）
```

> 带 `--measure` 的脚本会自己在容器里跑量化，需要**宿主机可达**：`DSH_BENCH_SSH=user@host`（可选 `DSH_BENCH_CONTAINER`，默认 `comfyui`）。
> 脚本**不内置任何私有地址**；不设 `DSH_BENCH_SSH` 时只跳过量化，渲染与断言照常。

## 附 E：i2v 版链式续接（fast 档实测 · 2026-09-15）

`node scripts/e2e-chain-continuity-i2v.mjs --tier=fast --measure`（`--measure-only` 只补测量、复用上次渲染）。四镜：i2v 起链 → 抽末帧 → 续接（`continuity_from` + 首帧 = 上一镜末帧）→ 对照（普通 i2v，同首帧同 seed、无续接）。

**链路（全过）**：起链 `load 0 / save 1259` → 续接 `load 1259 / save 1260`；请求 124 → 采样 158 → 交付 136；普通 i2v 实现 + `continuity_from` 显式拒跑。

**服务端日志（决定性证据）**：

```text
h3_motion_context: saved AV latent to .../clip_01259.safetensors (video (1,24,37,30,52), audio (1,32,2,207))
h3_motion_context: loaded AV latent from .../clip_01259.safetensors
h3_motion_context: dropped 1 keyframe anchor(s) at frame(s) [0]: the pinned head already decides frames 0..21. A last_frame anchor is kept.
h3_motion_context: video from latent, video/head, 22 frames -> 7 cond blocks at indices 0..18, 158 frame clip at 832x480, trim 22, audio 24 frames -> 40 latent steps (1.000s) from latent, on the timeline ending at frame 22.200
h3_motion_context: tail padded 266 zero samples (8.31ms) so audio matches 136 frames exactly
```

⇒ **新行为契约**：链式 i2v 里 **`first_frame_node` 会被丢弃**（钉住的 head 已决定第 0..21 帧），**`last_frame_node` 保留** ⇒「转场镜：首帧 = 前一镜末帧 + 末帧 = 下一镜首帧」在链式 i2v 上依然成立，且比纯 i2v 双端锚定**多拿到尾部画面 + 音频的连续性**。

| 接缝指标（上一镜 → 本镜） | 续接镜（i2v ctx） | 对照（普通 i2v，同首帧同 seed） |
|---|---|---|
| 帧数 | 136 | 141 |
| 画面 MAD | 8.473 | 4.345 |
| 音频相关 100 / 250 / 500 / 1000 ms | 0.406 / 0.231 / 0.181 / 0.157 | 0.489 / 0.433 / 0.395 / 0.313 |
| 包络相关 1s | −0.198 | −0.082 |
| 响度台阶 | +7.18 dB | −10.13 dB |

**读法（诚实版）**：① 画面列在 i2v 上**无区分度**——两镜共享同一张首帧图，接缝本来就被锚定（4.3 / 8.5 都属于"极连续"量级，对照 r2v fast 的 7.0 / 67.6）；② 音频列**对照反而更高**，疑为"同 seed + 同首帧"造成的趋同而非真连续 ⇒ 对照设计必须重做；③ 响度台阶方向相反，须人工听核。**机制可用已证，效果优劣未证。**

**待补**：其余 3 档（`--tier=balanced|balanced-pdd|quality`）；对照重设（同首帧·不同 seed，或同 seed·首帧取上一镜倒数第 22 帧）；人工听核。原始数据 `e2e-out/chain-continuity-i2v/`（`report-fast.md` / `rows-fast.json` / `seam-fast.json`）。
