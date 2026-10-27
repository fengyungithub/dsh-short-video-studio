# 补帧（`video.interpolate`）在现有架构中的落点

> 把「视频补帧」做成与 `video.upscale`（U3）**同构**的后期能力：同一注册表、同一档位解析、同一套
> 「清单声明契约 / runner 执行 / 工具写回画布」的分工。只做架构分析，不含产品代码改动。
> 未实测的数字一律不写（ComfyUI 当前未运行、`models/frame_interpolation/` 为空，节点行为由 `comfy-vfi-probe` 交付）。

## 0. TL;DR 与三条必须先拍板的决策

补帧几乎是超分的镜像（输入是画布既有视频、无提示词、无采样器语义、音轨直通、固定拓扑），能复用的比想象的多。
真正新的只有三件事：**① 帧数算术**变成 `源帧数 × m`（`docs/video-upscale.md:18` 写的是「同帧数、同 fps」）；
**② 分块必须带 overlap**（upscale 逐帧独立、任意切点安全，`lib/upscale.js:8-10`；补帧是跨帧对运算）；
**③ 产物 fps 变了**——`CreateVideo.fps` 在全链路上隐含 24（`lib/index.js:581,637`、`lib/concat.js:49`）。

| # | 决策 | 建议 | 不拍板的后果 |
|---|---|---|---|
| **D1** | 语义边界：`video.interpolate` = **只提帧率**（时长与音轨严格不变），**不含慢动作** | 采纳；慢动作另立能力 | 「补帧」默认含慢动作（×2 后按原 fps 播）⇒ 画面慢了声音没慢，音轨直通契约当场失效 |
| **D2** | 帧数口径：产物帧数 = **源帧数 × m**（时长严格 = 源时长），靠末块尾部补 1 帧重复帧达成 | 采纳 | 模型原生 `(N−1)·m+1` 每镜短 1/24 s，逐镜做会让**每镜短一点**，拼接后与音轨逐镜错位累积 |
| **D3** | 落点与顺序：补帧**只在拼接前逐镜做**、**全片同一 m**；与超分顺序是 **先超分 → 再补帧** | 采纳 | 成片补帧会在硬切处生成「两场之间的形变帧」（§6.1）；混 m 让 concat 时基静默崩（§7.1） |

## 1. 命名：`video.interpolate`，不并入 `video.postprocess`

1. **能力字符串是唯一解析键**：`CAPABILITIES`（`lib/manifest.js:25-37`）→ `byCapability`（`:663`）→
   `tierImplementations(capability,tier)`（`lib/index.js:1523`）→ `resolveTieredManifest`（`:1646`），
   **中间没有第二根选择轴**。做成 `video.postprocess` 就要给这条链加「哪种后期」子维度，连带设置页
   （`lib/client.js:422` 按 capability 出卡）、`comfy_list_workflows`（`lib/index.js:4248` 按 capability 遍历）、
   `cfg.tiers[capability][tier]`（`:1533`）全部开洞。
2. **前例就是一能力一变换**：`video.upscale` 里塞了异质实现（逐帧 CNN / 扩散恢复），靠
   `upscale.sizing` + `upscale.chunking` 两个**声明维度**共存（`lib/manifest.js:55-63`、`docs/video-upscale.md:51-80`），
   而不是拆能力。补帧照抄这套。
3. **顺序是调用方语义**：超分与补帧的先后是画质与成本的实质选择（§7.3），两个独立能力让顺序暴露在调用序列里。

边界（写进工具描述，别让调用方猜）：**是**画布既有视频的帧率提升、时长与音轨逐样本不变；**不是**慢动作（D1）、
不是超分（尺寸不变）、不是转码（编码参数沿用 `SaveVideo` mp4/h264，`lib/concat.js:52`）。

## 2. Manifest 契约与 fail-closed

```jsonc
{ "id": "video-interpolate-rife-2x", "capability": "video.interpolate", "tier": "quality",
  "group": "video-interpolate", "priority": 0,
  "interpolate": { "mode": "param",                     // param=倍率由 runner 注入；fixed=写死
    "multiplier": 2, "minMultiplier": 2, "maxMultiplier": 16,   // param 下是默认值，fixed 下是唯一合法值
    "outRule": "n-minus-1-times-m-plus-1",              // 模型输出帧数规则 → 决定要不要后置裁剪
    "chunking": "caller",                               // caller 必须带 overlap；internal 由实现自管跨帧窗
    "audio": "passthrough", "note": "…会拼进解析警告" },
  "assets": { "vfi_weights": { "kind": "other", "default": "rife47.pth",
                               "env": "DSH_SVS_VFI_WEIGHTS", "label": "帧插值权重（models/frame_interpolation/）" } },
  "params": { "source_video": {"inject":"scalar","to":{"node":"1","field":"file"}},
              "multiplier":   {"inject":"scalar","to":{"node":"3","field":"multiplier"}},
              "out_fps":      {"inject":"scalar","to":{"node":"6","field":"fps"}},
              "prefix":       {"inject":"scalar","to":{"node":"7","field":"filename_prefix"}} },
  "requiresNodes": ["LoadVideo","GetVideoComponents","FrameInterpolate","CreateVideo","SaveVideo"],
  "output": { "mediaType": "video" } }                  // estSeconds 实测后才填（§10）
```

* `assets.kind` 只能是 `other`（`ASSET_KINDS`，`lib/manifest.js:67`，`upscale_x2` 就是这么写的）；资产层**不用改**——
  显式覆盖走 `assetOverrides[自身 id]` 优先（`lib/index.js:1285-1298`）。
* `audio: 'passthrough'` 用单值枚举不是洁癖：`CHAIN_SOURCES = ['clip-latent']`（`lib/manifest.js:69`）是同一手法——
  把「本期不做慢动作」编进契约，将来加 `'retime'` 时校验器自然拒掉未实现值。
* **`params.out_fps` 是硬约束**：若照抄 `workflows/video-upscale-x2.json` 的 `CreateVideo.fps: ["2",2]`，
  补完 2 倍帧数仍按源 fps 封装 ⇒ 成片**半速**，而帧数/时长/音轨长度全都"看起来正常"。这是本契约最易静默出错的一处。

**fail-closed（校验器 4 条，照 `lib/manifest.js:381-391` 的模式）**
1. `capability='video.interpolate'` ⇒ **必须**声明 `interpolate` 块。
2. ⇒ **不得**声明 `resolutionLock`（尺寸不归它管）、`upscale`（语义互斥）、`lengthGrid`（帧数不是采样长度，`:114-119`）。
3. `interpolate.outRule` **必填**，枚举 `['n-minus-1-times-m-plus-1','n-times-m']`。缺了就算不出裁几帧，
   只能盲裁/盲放 ⇒ `params.length` 与产物悄悄不符（同类事故见 `lib/index.js:2595-2597`）。
4. `chunking='caller'` ⇒ **必须**同时声明 `params.out_fps` 与 `params.multiplier`（前者防半速，后者防「清单 ×2、图里 ×4」，
   与短边形态强制 `params.out_short_side` 同一条理由，`lib/manifest.js:388-390`）；`mode='fixed'` ⇒ `multiplier` 落在区间内。

**运行期 fail-closed（3 条，靠图结构）**
5. 图必须保持「`1 LoadVideo → 2 GetVideoComponents → … → N CreateVideo → N+1 SaveVideo`」头尾，且**必须声明
   `interpolate.frameNode`**（产出最终帧序列的节点 id）；切片按**引用**找消费者，找不到就抛
   （教训：`docs/video-upscale.md:69-73` 只认类名 ⇒ 换实现静默接不上 ⇒ 每块吐整片、拼回 372 帧 = 124×3）。
6. **产物帧数必须 = `N·m`**，否则抛错（upscale 的对应判据是「帧数守恒」`docs/video-upscale.md:203-208`，这里要精确相等）。
7. **权重缺失早报**：`checkAvailability`（`lib/index.js:1575-1587`）只探类注册（`probeNodeClass` `:1557-1572`），
   **探不到 `models/frame_interpolation/` 为空**——而这正是现状。建议在 `assertImplementationUsable`（`:1590`）
   读 `/object_info/<loader>` 的 `ckpt_name` 枚举，声明的权重不在列表里就**提交前**报错。这条对补帧是前置条件。

## 3. Runner：分块（overlap 数学）、切片、音频

**编排** `runInterpolate`，逐段镜像 `runUpscale`（`lib/index.js:2953-3115`）：源节点校验（`:2957-2964`）→
档位校验、写错不许静默退化（`:2968-2973`，注释里那次 300s 白跑）→ `resolveTieredManifest('video.interpolate')`
（`:2974`；fixed 形态再按 multiplier 过滤候选）→ 源参数 params 优先、`probeMp4` 兜底（`:2979-2984`）→
**新算术 `outFps = sourceFps × m`、`outFrames = sourceFrames × m`** → 分块（对应 `planUpscaleChunks` `lib/upscale.js:288`）→
每块 `buildGraphFromManifest` + `sliceInterpolateGraph` + submit/wait → 多块用 `buildConcatGraph` 拼回（全块同 fps，天然正确）→
帧数/时长校验 → 写画布。

**为什么 overlap 必须有**（设源 `N` 帧 @`f`，倍率 `m`，模型 `out(n)=(n−1)m+1`）：
* 照 upscale 那样「按帧切段、段间无重叠」：块 A 覆盖 `[0,c)` 只吐 `(c−1)m+1` 帧（末帧是源帧 `c−1`，
  **不含** `c−1→c` 的 `m−1` 个中间帧），块 B 从源帧 `c` 起 ⇒ 总帧数 `≠ N·m`（**不守恒**），
  且接缝处那 `m−1` 个中间帧根本不存在 ⇒ 观感是接缝处一次 `m` 倍速的"跳"。
* 正确切法（**右侧 1 帧 overlap + 后置裁剪**）：

| | 喂给模型的源帧 | 模型输出 | 裁到 | 覆盖输出位置 |
|---|---|---|---|---|
| 内部块 | `[s, s+c]`（`c+1` 帧，多吃右邻 1 帧） | `c·m+1` | `c·m`（丢末 1） | `[s·m, (s+c)·m)` |
| 末块 | `[s, N−1]` + **重复末帧 1 次** | `(N−s)·m+1` | `(N−s)·m`（丢末 1） | `[s·m, N·m)` |

* 总帧数 = `N·m` **精确**，时长 = `N·m/(m·f) = N/f` **精确**（D2）。末块重复末帧的代价是尾部 `m−1` 个静帧，
  时长 `(m−1)/(m·f) < 1/f` —— **严格短于一个源帧周期**，源时间分辨率下不可见。这就是 D2 的全部代价。
* 单块（`chunk_frames ≥ N`）走末块分支 ⇒ 最常见的 124 帧单镜只有一次提交，overlap 只影响长片。
* **`sliceUpscaleGraph`（`lib/upscale.js:216-259`）不能直接复用**：它只做源侧切帧 + 源侧切音轨；补帧还要
  ① 源侧 `length=c+1`（末块多一个 `ImageBatch` 接重复帧）② 源侧音轨只切 `c` 帧 ③ **后置**在 `frameNode` 之后插
  `ImageFromBatch(0, c·m)`。能共享的是那段「按引用找消费者 + 接不上就抛错」（`:238-257`）——它是**契约**不是细节，
  建议抽到 `lib/graph-patch.js`：`rewireConsumers()` + `insertAudioTrim()`，两个 slice 共用；若先复制，必须互相引用注释，
  否则两份 fail-closed 判据迟早分叉。

**音频直通的三个前提**（音频从不经过模型，靠 `CreateVideo(images,fps,audio)` 原样接上）：
① `fps` 必须是 `m·f` 不是 `f`（§2）；② 分块时切音轨 `TrimAudioDuration(start=s/f, duration=c/f)`——用**源 fps** 算，
不是 outFps（`lib/upscale.js:230-237` 写法本来就对，参数语义要再确认）；③ 各块时长相加 = `N/f`，与源严格相等 ⇒
不需要任何重采样，顺带成为 §8 的硬判据。无音轨源沿用 upscale 的告警（`lib/index.js:2997`）。

## 4. 工具面与画布记账

```ts
video_interpolate({ video_node: string,          // 必填：画布视频节点（生成产物/拼接产物/导入 mp4 都行）
  multiplier?: 2..16, target_fps?: number,       // 二选一；非整数倍见 §5
  tier?: 'fast'|'balanced'|'quality',            // 缺省 quality
  chunk_frames?: number, title?, group?, nodeId?, sessionId?, workspaceId? })
```
* **不要 `workflow=` 参数**：`explicitImplementationOf`（`lib/index.js:1620-1628`）会直接抛；脚本钉实现走 `implementation=`
  （`scripts/e2e-upscale.mjs:126`）。`output.schema` 遵守宿主子集（缺 output 会在注册时抛、整条 apply 失败，`:4160-4163`），
  可空字段输出侧**省略而非 null**（`:4204-4208`）。
* 产物 `params`（下游全靠它）：`capability/model/tier` + `width,height`（不变）+ **`length: N·m`, `fps: m·f`** +
  `sourceFps, sourceLength` + `multiplier` + `interpolateFrom, interpolateFromMedia`（沿用 `upscaleFrom` 命名，`:3091`）+
  `chunks, outRule, assets`，并显式写 **`chainable: false`**（§7.2）。
  `length`/`fps` 是音频参考时长的来源（`:2146-2149` 用 `len/fps`）——记错会让 2–15s 的时长校验结论反向。
* 标题 `${srcNode.title} · 补帧 ×${m} → ${outFps}fps`：如实反映交付口径（`:3072-3077` 的 `sizeLabel` 同理），
  且会成为飞书送达**文件名**（`deliveryFilename` `:3221-3227`）。
* **`canvas_set_state` v1 不加 `deliveryFps`**：① 先例已定——「交付画质」同为全片级选择却没有 state 字段，
  skill 明确把它放进项目简报（`skills/story-short-generator/SKILL.md:235`）；② state 与既有节点的**一致性无解**：
  改 `deliveryFps` 后已补过帧的节点怎么办？`characterCardVariant` 有答案（每镜显式传 `ref_variant`），补帧是产物级重写。
  v1 把 fps 记在项目简报 + 每节点 `params.fps`，**节点 params 是唯一真值**。若将来要加：字段名用 `deliveryFps`
  （别叫 `fps`，避免与 `H3_FPS` `lib/index.js:94` 混淆）、只作默认值、白名单校验 `∈ {源fps × m | m∈[2,16]}`。

## 5. 非整数倍（24→30 / 60）：工具只收整数倍

1. **模型层**：`multiplier` 是整数枚举（2–16）。24→30 = 1.25、24→60 = 2.5 都不在集合里；只能「插到公共倍率再抽帧」：
   24→30 = 插 ×5 得 120 再每 4 取 1；24→60 = 插 ×5 再每 2 取 1。
2. **抽帧层**：ComfyUI 核心只有 `ImageFromBatch`（**连续**切片，`lib/upscale.js:226-229`），**没有** stride 节点 ⇒
   抽帧只能靠 ffmpeg（`select='not(mod(n,4))',setpts=N/(30*TB)`）。而本机 ffmpeg 是**可选**的（`detectFfmpeg` 会返回 null，
   `lib/concat.js:76-81`，concat 才有 ComfyUI 兜底 `:1-15`）⇒ 非整数倍**没有兜底后端**，无 ffmpeg 机器上必然 fail-closed。
3. **交付层**：`ffmpeg -vf fps=30` 会复制/丢帧，不产生新信息——顿挫被摊到 30fps 时间轴上，**不该冒充补帧**。
* 结论：`target_fps/source_fps` 非正整数（或 > `maxMultiplier`）⇒ **显式报错并列出可达帧率**（源 24 ⇒ 48/72/96；源 30 ⇒ 60/90/120），
  文案给出路（"非整数倍需抽帧，无 ffmpeg 时不可用"）。将来若做，canonical 是 `插 ×p → 抽 1/q`（`target = f·p/q`, `p ≤ 16`），
  抽帧声明为实现字段 `interpolate.decimate: q` 并由 runner 校验，**不许**让 ffmpeg 事后 `-r` 一把梭（会静默改时长）。

## 6. 流程落点：逐镜补帧是**正确性**要求

### 6.1 逐镜 vs 成片
| 维度 | 逐镜（拼接前） | 成片（拼接后） |
|---|---|---|
| 硬切处 | 每镜独立，切点两侧各自插值 ⇒ 干净 | **在硬切处生成两场之间的形变帧** ⇒ 鬼影，一秒可见 |
| 失败代价 | 单镜 ≤124 帧，失败只毁一镜、可断点重跑 | 整片一次过，失败全片重来 |
| 20MiB | 单镜 ×m 多半仍在上限内 | 成片已近/超上限（`canvas/` 里已有 23MB 整片段）⇒ ×2 后**必超** |
| 与超分叠 | 每镜内可控顺序（§7.3） | 代价与显存峰值放大到全片（`docs/video-upscale.md:233-235` 同源） |

第一条是决定性的：**只要成片里有硬切，成片补帧就是错的**。逐镜补帧等于让"帧对"永远落在同一镜头内部，
而这恰是 VFI 运动估计能成立的区间。

### 6.2 三个 skill
| skill | 落点 | 写法要点 |
|---|---|---|
| `story-short-generator` | STEP 0 规格卡加「交付帧率（24 原生 / 48 / 96）」；STEP 8 在 `skills/story-short-generator/SKILL.md:751-767` 的「提分辨率/超分」**之后**加「可选：补帧」一节，顺序 **超分→补帧→concat** | 三条纪律照超分：① 对**单个分镜**补帧，不对成片补；② 补帧后**重跑 concat**；③ **全片同一 m**（补就全补） |
| `brand-promo-video-generator` | `skills/brand-promo-video-generator/SKILL.md:385-392` 之后并列一节 | 强调「补帧不改像素、不重绘 LOGO/包装」（与 `:389` 对身份素材的纪律同源）；品牌片收益有限，**默认不做** |
| `short-drama-series-production` | `skills/short-drama-series-production/SKILL.md:116` 的 `delivery` 旁并列 `deliveryFps`；成本台账 `:377-379` 加一行 | 整季**二选一**（与"交付画质整季二选一"同一句），因为混 m 会炸 concat；`G-SAMPLE`（`:319`）可加 48fps 对照臂 |

## 7. 与既有系统的冲突点（按危险程度）

### 7.1 concat 的 fps 假设 —— 最高危，且现在完全不报错
`buildConcatGraph` 把 `CreateVideo.fps` 直接接**首段**的 `GetVideoComponents`（`lib/concat.js:39,49`：`fps: [comps[0],2]`）。
* **ComfyUI 后端**：`ImageBatch` 把各段帧首尾拼成一个长批次、再按首段 fps 封装 ⇒ 24fps 段与 48fps 段混拼时 48fps 段**半速播放**，
  整片时基崩，**不报错**。**ffmpeg 后端**：`-c copy`（`:102`）遇不同 fps 多半失败并回退重编码（`:105-111`），但 demuxer 仍按单一时间基拼 ⇒ 同样错。
* 必须补两件事（都在 `runConcat` `lib/index.js:2861-2936`）：① **记口径**——产物只记 `{backend,reencoded,sources}`（`:2925`），
  **没有 `fps/width/height/length`**，补帧后下游拿不到 `params.fps` 只能靠 probe 猜；② **fps 一致性守卫**——
  `sources` 里带上 `n.params.fps`（`:2870-2882` 顺手存），都有值且不一致就**报错**。这比"分辨率不一致"更严：
  分辨率混只是观感跳变（`docs/video-upscale.md:100-102` 明确 concat 不检查分辨率、那是实践约束），
  而 **fps 混是时基错**——坏片不是观感问题。缺值（外部导入/老节点）降级为告警。

### 7.2 链式续接
链序号 `params.clipIndex` 只记在生成产物上，`continuity_from` 读不到就报「上一镜没有链式序号」（`lib/index.js:2572-2582`）。
补帧产物没有该字段 ⇒ **续接永远指向生成产物，不指向补帧/超分产物**（与 upscale 现状一致，其产物 params 也不带 clipIndex）。
`chainGraphMismatch`（`:1494-1502`）读 `params.graphWidth/width` 判首遍尺寸，补帧不改宽高 ⇒ 若真让补帧产物带 `clipIndex`
反而会**通过**判据而实际错（链上流动的是 latent，补帧发生在采样之后）⇒ **不记 clipIndex 是安全默认，不是遗漏**，
建议在产物里显式写 `chainable: false`，让报错更准。

### 7.3 超分顺序：先超分 → 再补帧
| 顺序 | 代价（N 帧源） | 画质 |
|---|---|---|
| **超分→补帧**（建议） | 贵阶段跑 N 帧、便宜阶段跑 2N 帧 | VFI 看到高细节**真帧**，运动估计更稳；合成帧只放大一次 |
| 补帧→超分 | 贵阶段跑 2N 帧 | 每张合成帧**独立**超分 ⇒ 合成高频逐帧不一致 ⇒ **闪烁被放大**（`docs/video-upscale.md:169` 的平坦区闪烁判据会恶化） |
用本仓口径估量级：U3 ×2 是 2.2–2.6 s/帧（`lib/upscale.js:8-9`），VFI 每帧对毫秒–百毫秒级（待实测）⇒
超分→补帧 ≈ `N·2.5 + 2N·ε`，补帧→超分 ≈ `N·ε + 2N·2.5`，**前者便宜接近一倍**，还顺带避开闪烁。

### 7.4 画布预览 / 7.5 交付送达 / 7.6 `comfy_render` 枚举
* **预览零改动**：`studio/app.js:762-779` 用原生 `<video>` 播 `node.media`，全仓 `studio/` 无 `fps` 字样；fps 写进容器后播放器自然按新帧率播。
  但 96fps h264 在部分播放器/IM 内置播放器上可能不支持 ⇒ **交付默认 48，96 只作中间产物**。
* **送达**：`mediaDelivery`（`lib/index.js:258-265`）只算 bytes/类型，失败记 `params.deliveryError`（`:3281`）、下次 ask 前重试。
  新风险只是体积（同 CRF 下随帧数约 ×m）。单镜 1.5MB→3MB 仍安全，**96fps + 已超分的 4K 单镜**很可能一次越线。
* **`comfy_render` 枚举被自动扩容**：`capability` 枚举直接就是 `CAPABILITIES`（`lib/index.js:3972`），于是 `video.upscale`
  **现在就已经**出现在通用渲染入口里，而 `runRender`（`:2398`）只会走"提示词+尺寸推导"那条路、对后期能力无守卫。
  加 `video.interpolate` 会复制这个暗坑 ⇒ 抽 `POSTPROCESS_CAPABILITIES = ['video.upscale','video.interpolate']`，
  在 `runRender` 入口显式报错并指路（「这是后期能力，请用 `video_interpolate(video_node=…)`」）。补帧 PR 顺手还掉这笔旧债。

## 8. 验证方案

**`scripts/smoke-interpolate.mjs`（新，GPU-free，对齐 `scripts/smoke-upscale.mjs:1-18` 的清单）**
1) 清单契约（mode/multiplier/outRule/chunking/audio + 资产槽 + requiresNodes）；2) 校验 fail-closed（§2 的 1–4 各一例）；
3) 帧率规划：`24×2=48 / 24×3=72 / 24×4=96`，`target_fps=48` 反解 `m=2`，`target_fps=30` 抛错并**列出可达帧率**，
   `source_fps=23.976 ⇒ 47.952`（**不四舍五入成 48**——这正是 §7.1 时基错的来源）；
4) 帧数算术（纯函数，最高价值）：`N=124,c=40,m=2` ⇒ 4 块含末块 dup、总 **248**；`c=41` ⇒ 总仍 **248**；`c≥124` ⇒ 单块 248；`N=2` 边界；
5) 切片接线：源侧 `length=c+1`、`TrimAudioDuration(s/f, c/f)` 用**源 fps**、后置 `ImageFromBatch(0,c·m)`、**找不到消费者就抛**
   （对应 `lib/upscale.js:251-257`）；6) 注册表集成（能力进 `CAPABILITIES`、缺 nodes 的报错文案）；
7) 容器 fps 解析：给 `probeMp4` 加 `mdhd` timescale（现在只有 `mvhd` duration + `stsz` 样本数，`lib/upscale.js:63-92`，
   只能 `frames/duration` 近似），自造最小 mp4 应读出 `24.000 / 23.976`。

**`scripts/e2e-interpolate.mjs`（新，真机，对齐 `scripts/e2e-upscale.mjs`）**

| 臂 | 做什么 | 判据 |
|---|---|---|
| A0 | 源片基线 | 帧数 124、duration `124/24`、音频时长 |
| A1 | `multiplier=2` 单块 | 帧数 **248**（精确）、`fps=48`、`|Δduration|=0`、音频**逐样本相同** |
| A2 | `multiplier=2, chunk_frames=40` | 帧数 **248**、接缝局部帧差无尖峰、音频总长相同 |
| A3 | 对照 `ffmpeg -r 48`（复制帧） | 帧间差出现**周期性 0** ⇒ 反证补帧不是复制 |
| A4 | `multiplier=4` | 帧数 **496**、`fps=96`、duration 不变（**数字校验，不靠肉眼**） |

**A/B 指标**（复用 `scripts/analyze-u3.mjs:57-107` 的 cv2 口径）

| 指标 | 定义 | 通过线 | 抓什么 |
|---|---|---|---|
| 帧数守恒 | 实际 vs `N·m` | **精确相等** | 分块/裁剪算术错 |
| 时长守恒 | `|dur_out−dur_src|` | **= 0** | `CreateVideo.fps` 注错（半速） |
| 音频直通 | 抽轨逐样本 / md5 | 完全相同 | 音轨被模型碰过或重编码 |
| **接缝局部帧差比** | `max(d(n))@seam±2 ÷ median(d(n))` | `∈[0.6,1.6]` | **overlap 算术**：>2 掉帧/重复，<0.4 卡帧。唯一能定位分块 bug 的指标 |
| 平坦区闪烁比 | `flicker_flat`（`:57-62`）出/入 | ≤1.15 | 合成帧注入的噪声 |
| tOF 三帧一致性 | `‖f_s − warp(f_{s−1}→f_{s+1})‖`（Farneback）合成/真实 | ≤1.3 | 鬼影/撕裂（运动估计失败的典型形态） |
| 最长连续重复帧 | 相邻帧相同游程 | ≤`m−1`（只允许在末尾） | 模型卡帧 / guard 误命中 |

**失败梯度**（禁止原样重试）：① 帧数不符 → 先改 `outRule` 声明（不重渲），再查后置 trim 是否插入；
② 接缝尖峰 → `chunk_frames` 加大/整段一次过，仍不过就声明 `chunking='internal'`（口径同 `lib/upscale.js:308-319`）；
③ 鬼影/闪烁 → 降 `m`（48 优于 96）/换权重，仍不过就**放弃补帧交付原生 24**（可接受的产品结论，不为"做了补帧"而交付坏片）；
④ 音画不同步 → 99% 是 `CreateVideo.fps` 没注入成 `m·f`；⑤ 20MiB 失败 → 走既有 `deliveryError` 重试（`lib/index.js:3281`），降 `m` 或提示到画布取。

**回归面**：`smoke-tools`（新工具 schema 合法、output 齐全）、`smoke-render`、`smoke-tier-resolution`（新能力不该被要求造旧 id 继承入口，
`scripts/smoke-tier-resolution.mjs:297` 原话）、`smoke-manifest`、**`smoke-upscale`**（抽 rewire helper 后 upscale 行为必须一字不变）、
`smoke-concat`（若加 fps 守卫）。

## 9. 实现 PR 清单（按文件）

| # | 文件 | 改动 |
|---|---|---|
| **P0-1** | `lib/manifest.js` | `CAPABILITIES += 'video.interpolate'`（`:25-37`）；新增 `INTERPOLATE_MODES/OUT_RULES/CHUNKINGS/AUDIO`（挨着 `:55-69`）；`validateManifest` 加 `interpolate` 块 + 能力级 must/must-not（照 `:349-391`） |
| **P0-2** | `lib/interpolate.js`（新） | `planInterpolate` / `interpolateChunkRanges` / `sliceInterpolateGraph` / `expectedRawFrames`；`probeMp4`、`snapToAlign` 从 `lib/upscale.js:20,34` **import** 不复制 |
| **P0-3** | `lib/graph-patch.js`（新，建议） | 从 `lib/upscale.js:238-257` 抽 `rewireConsumers()` + `insertAudioTrim()`，两个 slice 共用 |
| **P0-4** | `lib/upscale.js` | `probeMp4` 增 `mdhd` timescale ⇒ 返回精确 `fps`（`:34-97`）；改调 P0-3（行为不变） |
| **P0-5** | `workflows/video-interpolate-*.json` + `scripts/make-interpolate-manifests.mjs`（新） | 清单是产物、改结构请改脚本（`docs/video-upscale.md:338` 同一纪律） |
| **P0-6** | `scripts/smoke-interpolate.mjs`（新） | §8 的 7 组 |
| **P1-1** | `lib/index.js` | `runInterpolate`（镜像 `:2953-3115`）+ `video_interpolate`（挨着 `:4134`）+ 注册 `:4520` + `_internals` 导出 `:5321` |
| **P1-2** | `lib/index.js` | `POSTPROCESS_CAPABILITIES` 守卫 + `runRender` 指路（§7.6） |
| **P1-3** | `lib/index.js` | `runConcat` 补记 `fps/width/height/length`（`:2925`）+ fps 一致性守卫（`:2866-2882`） |
| **P1-4** | `schemas/workflow-manifest.schema.json` | `interpolate` 块（照 `:336-370`） |
| **P1-5** | `scripts/e2e-interpolate.mjs`（新） | §8 四臂 |
| **P2-1** | `lib/client.js` | `CAPABILITY_OPTIONS`（`:184-187`）**现在就已经漏了 `video.upscale`**；改为从 `registry.capabilities` 派生（`:717`），一次性消灭这类漂移 |
| **P2-2** | `lib/index.js:4138`、`docs/video-upscale.md:298` | 文案已过期：`workflow=` 现在会**抛错**（`lib/index.js:1620-1628`），示例/描述改成 `implementation=` / 设置页 |
| **P2-3** | `docs/fps-interpolation.md`（新）、`docs/ARCHITECTURE.md:290`、`README.md:151,164,226,239,695`、`USER-MANUAL.md` | 用户面文档：能力表 + 契约 + 账本（照 `docs/video-upscale.md` 的完整度） |
| **P2-4** | 三个 skill（§6.2 落点） | `story-short-generator`（STEP 0 + `:751-767` 之后）、`brand`（`:385-392` 之后）、`series`（`:116,319,377-379`） |

顺序建议：**P0 全部 + P1-1/P1-3 先合**（离线可测，可先跑 smoke 与 e2e），P1-2/P2 随后。

## 10. 诚实边界（这份报告**没有**验证的事）

* `FrameInterpolate` 的**输出帧数规则**未实测：按 `(n−1)m+1` 推算术，并做成**可声明的 `outRule`** + 运行期帧数校验
  （§2 规则 6）。规则若不同，契约不变、只改枚举值。
* `multiplier` 合法区间、是否 2–16、`models/frame_interpolation/` 该放哪个权重，全部以 `comfy-vfi-probe` 实测为准；
  本文 `minMultiplier/maxMultiplier` 只是**声明位**。
* **`estSeconds` 一律留空**——`docs/video-upscale.md:283-285` 已把这条写成纪律（"在跑过之前不要标 estSeconds"）。
  §8 的通过线都是**判据形状**，不是预算数字。
* 96fps 在飞书/IM 内置播放器的兼容性未测 ⇒ 交付默认 48（§7.5）。
* 「补帧是否真的更顺」是主观项：本文只保证**时基正确、帧数守恒、音轨不变、接缝无算术缺陷**；运动估计质量
  （大位移、遮挡、快速摇镜）属模型能力，必须靠 §8 的 tOF/鬼影指标 + 眼判。
