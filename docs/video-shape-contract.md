# 视频「形状」(type) 契约：显式声明 + 参数校验

> 状态：已落地（2026-09）。工具面 `comfy_generate_video(type=...)` 必填；所有入口（工具 / HTTP 路由 / 脚本）共用同一张真值表。
> 相关：`docs/shot-chain-continuity.md`（续接契约）、`docs/i2v-vs-ref2v-and-model-comparison.md`（两条路径的模型差异）。

## 1. 为什么要显式声明

形状（shape）指"这段视频用哪种条件路径"：**参考绑定**还是**首末帧串联**。它此前是被**副作用**推断出来的：

```js
// 旧行为（已废弃）
capability = (first_frame_node || last_frame_node) ? 'video.image2video' : 'video.reference2video'
```

由此产生两个真实缺陷：

1. **参数被静默丢弃**：`type=i2v` 的清单没有参考图槽位，但 `ref_nodes` 里的图**仍会被上传**到 ComfyUI，
   注入阶段却直接跳过 —— 不报错、不生效，只留下一次无意义的上传和"我明明传了角色卡"的困惑。
2. **报错误导**：同时传 `ref_nodes` + `continuity_from`（正确写法）再顺手传一个 `first_frame_node`，
   能力会被悄悄改成 i2v，然后报「i2v 没有链式续接实现」——用户真正的问题（多传了首帧）根本没被指出。

结论：**形状必须显式传**，冲突必须报错并给出修法。

## 2. 真值表（唯一权威）

| 参数 | `type=r2v`（参考绑定） | `type=i2v`（首末帧串联） |
|---|---|---|
| `ref_nodes` | ✅ 用（绑定身份/环境；不传仍可跑，但给警告） | ❌ **禁止** |
| `first_frame_node` | ❌ **禁止** | ✅ **必需** |
| `last_frame_node` | ❌ **禁止** | ✅ 可选 |
| `continuity_from`（同场景续接） | ✅ 已支持（需链式实现） | ⏳ 显式拒绝（i2v 版 ctx 待补，见 §6） |
| `prompt` / `length` / `seed` / `width` / `height` / `tier` | ✅ | ✅ |
| capability | `video.reference2video` | `video.image2video` |

形状与"续接"是**正交**的两个维度：

| | 不传 `continuity_from` | 传 `continuity_from` |
|---|---|---|
| `r2v` | 参考绑定独立镜（角色/场景卡） | **链式续接**：参考绑定 + 继承上一镜画面/音频 ✅ |
| `i2v` | 首帧（+末帧）串联镜、转场镜 | ⏳ i2v 版链式续接（待补） |

**跨形状续接是允许的**（上一镜 `r2v`、本镜 `i2v` + `continuity_from`）：转场/机位死锁镜的最优组合。
链的 latent 只校验分辨率+通道、没有形状标签，所以运行时**不校验上一镜的形状**——这是刻意设计，不是遗漏。

## 3. 报错文案（必须带修法）

| 触发 | 报错要点 |
|---|---|
| 缺 `type` | 点名 `type` 必填，并列出两条路（`r2v` / `i2v`）与续接写法 |
| `type` 非法 | 列出合法取值 |
| `type=i2v` + `ref_nodes` | 「i2v 不接受 ref_nodes：身份由首帧继承。删掉 ref_nodes，或改 type=r2v」 |
| `type=r2v` + 首/末帧 | 「r2v 没有首帧/末帧槽位（以前会被静默忽略）。同场景续接请用 continuity_from=上一镜节点 id；要首帧锚定请改 type=i2v」 |
| `type=i2v` 缺首帧 | 「必须传 first_frame_node（末帧可选）」 |
| `type=i2v` + `continuity_from` | 「i2v 链式续接尚未实现；续接请用 type=r2v + continuity_from」 |
| `type` 与 `capability` 不一致 | 报出两者对应的能力，指出不一致 |

`type=r2v` 但没传 `ref_nodes` → **警告而非报错**（纯文本生成是合法用法，只是角色/场景一致性无从保证）。

## 4. 落地位置

| 位置 | 作用 |
|---|---|
| `lib/index.js` `VIDEO_SHAPES` | 真值表（形状 → capability / require / forbid / forbidHint / chain 支持） |
| `lib/index.js` `validateVideoArgs(capability, args)` | 唯一校验实现：errors 抛错（带修法），warnings 随结果返回 |
| `runRender` 解析出清单后**立即**调用 | 校验在**上传参考图之前**，非法请求零副作用；所有入口共享同一张表 |
| `comfy_generate_video` | `type` 进 schema 的 `required` + `enum`；不再做能力推断 |
| `comfy_render` | `type` 可选别名：传了必须与 `capability` 一致；不传则按 `capability` 推导形状校验 |
| `POST /generate/video` | 同样要求显式 `type`（缺则 400） |
| `scripts/smoke-video-shape.mjs` | 31 条断言覆盖真值表 / 合法组合 / 冲突报错 / 工具面文案（不触网） |

## 5. 流程 skill 的写法

```text
起链（独立镜头）：comfy_generate_video(type='r2v', tier=档位, ref_nodes=[角色卡, 场景卡], ...)
续接（连续镜头）：comfy_generate_video(type='r2v', tier=档位, ref_nodes=[...], continuity_from=上一镜节点 id, ...)
首帧/末帧串联镜 ：comfy_generate_video(type='i2v', tier=档位, first_frame_node=末帧节点, last_frame_node=可选, ...)
```

输入框链路（`/video-generate`）本来就在命令行里带 `type=r2v|i2v`（工具条 `pipeline`），skill 需**原样透传**。

**两个片型 skill 的形状策略不同（刻意不同，别合并）**：

| 片型 skill | 形状策略 | 连续性机制 |
|---|---|---|
| `3d-animation-short-generator` | **正片镜一律 `r2v`**；**两处用 `i2v`**：跨场景转场镜、锚点式重渲 | **链式续接**：镜头表新增第七列 `续接`（`起链` / `接 S0x` / `锚定 S0x↔S0y`），连续镜头传 `continuity_from`、独立镜头不传；转场镜默认 i2v 双端锚定，若走链式 i2v 实现则额外继承上一镜尾部 |
| `brand-promo-video-generator` | `r2v`（产品英雄镜）+ `i2v`（LOGO / UI 首帧锁定镜） | 首帧锁定是**业务硬需求**（品牌标识逐像素继承），保留 i2v；同场景续接镜仍可用 i2v 首帧串联 |
| `video-generate`（输入框轻量链路） | 由用户在工具条选 `r2v` / `i2v` | 原样透传 `type`，不替用户决定 |

> 3D 动画片型把 i2v 从"逐镜默认路径"降为"**两处专用能力**"：它的身份与环境本来就由角色卡/场景卡保证，而同场景的连续性用链式续接更强（继承 22 帧画面 + 1 秒音频，且不必上传图片）——所以同场景续接不再需要 i2v，顺带消灭了"角色新登场就不能用首帧串联"这类资格限制。
> 但 i2v 的**末帧锚定**在链式续接里没有等价物：**转场镜**要精确落回下一镜首帧、**锚点式重渲**要在改中段时保住下游首帧 ⇒ 这两处刻意保留 i2v。
> 代价已**消解**：i2v 现在也有链式实现（`…-i2v-ctx-*`，见 §6）——用它渲的 i2v 镜同样存 latent，可作下游 `continuity_from` 的源；链式 i2v 与末帧锚定**可以同时用**（实测：首帧锚点会被 head 取代、末帧锚点保留）。仍是**普通 i2v 实现**（无 `clipIndex`）才会把链路切断，那时下游只能改成 i2v 锚定接上或 `起链`。品牌片型的 LOGO/UI 锁定没有参考卡可用（那是真实素材，不能重绘），所以必须保留 i2v。

## 6. i2v 版链式续接（已落地；fast 档已实测，其余档与对照重设待补）

**状态**：模板、清单、注册表与形状表全部就位（`VIDEO_SHAPES.i2v.chain = true`）；**fast 档已端到端实测**，balanced / balanced-pdd / quality **待补**（记录在案，命令见下）。

- **做法**：Motion Context 四个节点挂在**条件节点之后**（conditioning / latent / audio），与用哪种条件节点无关 ⇒ i2v（`MiniMaxH3ImageToVideo`）同样可挂。模板由 `scripts/make-h3-ctx-templates.mjs` 从普通 i2v 模板**派生**（可复现，勿手改）：`minimax-h3-i2v-ctx.json` / `-8step-ctx.json` / `pdd-i2v-ctx.json`。
- **清单**：`minimax-h3-i2v-ctx-{fast,balanced,balanced-pdd,quality}`（`priority: -100`：只被显式指定或链式路径选中），已登记资产继承表（`H3_I2V_IDS` / `H3_I2V_ASSETS`）与 `models.*` 兜底映射。
- **节点参数**：视频节点现在记 `params.type`（`r2v` / `i2v`），画布据此辨识转场镜 / 锚点式重渲这类 i2v 镜。
- **实测（fast 档）**：链路全过 —— 起链 `load 0 / save 1259` → 续接 `load 1259 / save 1260`、请求 124 → 采样 158 → 交付 136；服务端日志确认 `22 frames -> 7 cond blocks at indices 0..18`、`trim 22`、`audio 24 frames -> 40 latent steps (1.000s)`、尾部补零 8.31ms；普通 i2v 实现 + `continuity_from` 显式拒跑。原始数据 `e2e-out/chain-continuity-i2v/{rows-fast.json,seam-fast.json,report-fast.md}`。
- **实测得到的行为契约（重要）**：链式 i2v 里 **`first_frame_node` 会被丢弃**——服务端日志：
  `dropped 1 keyframe anchor(s) at frame(s) [0]: the pinned head already decides frames 0..21. A last_frame anchor is kept.`
  ⇒ 钉住的 head 已决定第 0..21 帧，首帧锚点变冗余；**`last_frame_node` 保留**。所以"转场镜：首帧 = 前一镜末帧、末帧 = 下一镜首帧"的用法在链式 i2v 上依然成立，而且比纯双端锚定**多拿到尾部画面 + 音频的连续性**。
- **fast 档接缝指标（诚实版）**：续接镜 vs 同首帧同 seed 的对照镜 —— 画面 MAD **8.47 / 4.34**（都在"极连续"量级，**该列在 i2v 上无区分度**：两镜共享同一张首帧图，接缝本来就被锚定）；音频 1s 相关 **0.157 / 0.313**、包络 **−0.198 / −0.082**（**对照反而更高**，疑为"同种子趋同"而非"真连续"）；响度台阶 **+7.18 dB / −10.13 dB**（方向相反，须人工听核）。
  **结论：机制可用已证；"i2v 续接是否更好"尚未拿到正面证据，需重设对照后重测。**
- **待补（记录在案）**：
  1. **其余 3 档**：`node scripts/e2e-chain-continuity-i2v.mjs --tier=balanced|balanced-pdd|quality`。
  2. **重设对照**：现有对照与上一镜**同 seed + 同首帧**，会把"同种子趋同"混进音频相关。至少要补其一：**同首帧 · 不同 seed**，或 **同 seed · 首帧取上一镜倒数第 22 帧**。
  3. **人工听核**：包络相关与响度台阶在 i2v 上方向矛盾，最终以耳朵判定。
  4. `scripts/e2e-chain-continuity-i2v.mjs` 支持 `--measure-only`（复用上次渲染结果，不重跑 GPU）。

## 7. 复现

```bash
node scripts/smoke-video-shape.mjs        # 31 条断言，不触网
node scripts/mock-apply.mjs               # 工具 schema / render / execute 完整性
npm run smoke                             # 全量冒烟（含本表）

# i2v 链式续接（真跑 GPU，串行不并行）
node scripts/make-h3-ctx-templates.mjs                      # 派生 3 份 i2v ctx 模板（改了普通 i2v 模板才需要）
node scripts/make-h3-variants.mjs                           # 生成清单
node scripts/verify-h3-variants.mjs                         # 154 条清单/图结构断言
node scripts/e2e-chain-continuity-i2v.mjs --tier=fast --measure   # 端到端 + 接缝量化
node scripts/e2e-chain-continuity-i2v.mjs --tier=fast --measure-only  # 只补测量（复用上次渲染）
# 量化在容器里跑：需 DSH_BENCH_SSH=user@host（可选 DSH_BENCH_CONTAINER，默认 comfyui）；不设则只跳过量化
```
