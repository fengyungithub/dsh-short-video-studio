# 一致性与镜头规划优化方案

针对四个议题的现状审查与改造方案：**角色卡生成 / 跨场景人物一致性 / 多镜头规划 / 切换过渡一致性**。

审查范围：`lib/*.js`、`workflows/*.json`、`schemas/`、`skills/3d-animation-short-generator/`、`studio/`、`docs/workflow-contract.md`。

---

## 1. 结论摘要

| 议题 | 当前实现 | 承载层 | 缺口 |
|---|---|---|---|
| 角色卡生成 | `comfy_generate_image` → `group="character cards"` 的图片节点 | 全靠 prompt + skill 散文 | 无角色实体、无生成规范、无换装通道 |
| 跨场景一致性 | `ref_images.ref_image_${i}` 参考绑定 + 跨会话资产库 | 代码有、策略无 | 无身份锁、无参考选择规则、无一致性校验 |
| 多镜头规划 | 七列镜头表 = markdown `table` 节点 | 纯自然语言 | 无机器可读镜头清单，Agent 每镜重新解析自己写的 markdown |
| 切换过渡一致性 | `first_frame_node` / `last_frame_node` | **链路断裂** | 无抽帧能力，末帧串联实际不可用 |

一句话概括：**代码把"能力"做得很干净（manifest 契约层做得相当好），但把"一致性纪律"全部下沉到了 prompt 和 skill 散文里**。散文约束不可校验、不可复现、不可回归，这是四个议题共同的根因。

---

## 2. 关键缺陷（附证据）

### D1 · 末帧串联不可用（P0，阻塞性）

`uploadCanvasNodeImage` 不区分节点类型：

```js
// lib/index.js:863
async function uploadCanvasNodeImage(root, project, nid) {
  const n = project.nodes.find((x) => x.id === nid)
  if (!n?.media) return null                    // ← 不校验 n.kind
  const absPath = join(root, ...String(n.media).split('/'))
  ...
  const up = await comfyUploadImage(buf, basename(n.media))   // ← mp4 也会被当图上传
  return up.name
}
```

视频节点 `media` 是 `.mp4`（`runVideoGeneration`，`kind: 'video'`）。`first_frame_node=上一镜末帧` 要求传入"末帧图片"，但**没有任何代码能从上一镜视频里取出末帧**：

- `grep -rn "ffmpeg\|extract\|抽帧\|VHS_\|LoadVideo\|ImageFromBatch" lib/ scripts/ workflows/` → 零命中
- `CAPABILITIES`（lib/manifest.js）里没有抽帧能力
- `docs/workflow-contract.md:58` 只把 `compose.concat` 记为"非 ComfyUI，走既有 ffmpeg 脚本"，而那个脚本不在仓库里

结果：README「关键实现」里写的 S03→S04、S05→S06 末帧串联，只能靠人工截图。文档承诺与代码能力不一致。

### D2 · 资产入库对中文标题失效（P0，小改动高收益）

```js
// lib/assets.js:28
export function slugifyName(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')     // 中文全被吃掉
    .replace(/^-+|-+$/g, '')
}
```

角色卡标题实际是「小狐狸·穿宇航服」→ slug 为空串 → `POST /assets` 抛 `请提供 name`。叠加两条 systemPrompt 硬规则（lib/index.js:1776、1794）——**新卡不自动入库，必须用户手点「入库」按钮，AI 不得调用**——跨会话复用这条一致性主干道在实践中基本走不通。资产库设计得不错，但入口被堵住了。

### D3 · 没有身份锁，只有参考图

三个 workflow manifest 里没有任何 IPAdapter / FaceID / 角色 LoRA 节点。LoRA 只用于 fast 档加速（`minimax-h3-ref2v.json:47`）。身份完全由 `ref_images` + prompt 里的 `[char:]` 标签承载。

同时 `resolution.policy` 之类的约束都进了 manifest，但"参考图怎么选、顺序怎么排"没有：`refs` 只有 `max: 8`，谁先谁后、说话人是否必须排第一，全靠 skill 散文第 4 条。

`style` 资产类型在 `ASSET_TYPES` 里声明了，但 skill 流水线（Step 0-8）从未提及，`asset_to_canvas` 的分组映射也只处理 character/scene（lib/index.js:1439）。风格锚点等于死代码。

### D4 · 镜头表不可机读

七列镜头表以 markdown 存在 `kind: 'table'` 节点里。后果：

- 每生成一镜，Agent 要重读并重新解析自己写的 markdown，才知道该传哪些 `ref_nodes`
- 七项自检（`references/shot-table-spec.md`）是模型自查，无代码校验
- 镜头级状态（用了哪些参考、seed、重试次数、批准状态）无处存放——`node.params` 只在视频生成后事后记录
- 重做单镜时无法还原上次的完整参数组合

`GROUP_ORDER` 是唯一的代码级"结构"，它只管分组排序。

### D5 · 无 image2image，换装必然漂移

`CAPABILITIES` 声明了 `image.image2image`，但 `workflows/` 下只有 `flux-text2image.json`。「同一角色换宇航服」只能重新 text2image 抽卡，身份必然漂移。现行对策是"分状态各建一张卡"——把漂移问题转成了"两张卡本来就不是同一只狐狸"的问题。

### D6 · seed 不可复现

`const seed = intArg(opts, 'seed', Math.floor(Math.random() * 2 ** 31))`。seed 事后写入 `node.params.seed`，`registerAsset` 也会带上（lib/index.js:1683）。但角色卡生成时 Agent 不会主动固定 seed，skill 里也没有"锁 seed"这一步。同角色重生成 = 换脸。

---

## 3. 优化方案

设计原则：**把散文纪律搬进数据结构和代码校验**。凡是 skill 里写「务必遵守」的，都应该有一个 schema 字段或一次断言与之对应。

### W1 · 角色档案（Character Bible）

把"角色卡 = 一张图片节点"升级为"角色 = 有身份契约的实体"。

在资产库记录上扩展（`lib/assets.js` `registerAsset` 的 `meta` 已经是开放结构，无需改存储格式）：

```jsonc
{
  "id": "character:fox/with-suit",
  "type": "character", "name": "fox", "state": "with-suit",
  "image": ".dsh-assets/images/character-fox-with-suit.png",

  // 新增：身份契约
  "displayName": "小狐狸·穿宇航服",     // 中文展示名，与 slug 解耦
  "identityPrompt": "orange-red fur, fluffy oversized tail, round bright eyes, ...",
  "wardrobePrompt": "handmade cardboard spacesuit with paper helmet",
  "seed": 812734,                       // 锁定 seed
  "baseAsset": "character:fox/default", // 同一角色的状态变体溯源
  "speaksOnScreen": true,
  "styleAnchor": "style:pixar-warm"     // 关联风格锚点
}
```

代码改动：

1. **修 `slugifyName`**：中文标题走音译/回退到 `character-<短哈希>`，并把原标题存进 `displayName`。这一条解掉 D2。
2. **放开 AI 入库**：新增 `asset_register(nodeId, type, name, state?, displayName?, identityPrompt?, speaksOnScreen?)` 工具，同时保留画布「入库」按钮。当前"AI 不得入库"的硬规则改为"入库前用 `ask_user_question` 确认"——保住用户控制权，但不再堵死链路。
3. **角色卡生成规范**：`comfy_generate_image` 增加 `preset: 'character-card'`，由代码拼接固定后缀（单视图、正面全身、中性灰底、三点均匀光、无道具遮挡、留边），而不是指望 Agent 每次自己写对。README 实战要点第 1 条（单视图）由此变成代码保证。
4. **新增 `image.image2image` manifest**（`workflows/flux-edit.json`，如本地有 FLUX Kontext / Qwen-Image-Edit 权重）：换装、换表情、换角度都从 `baseAsset` 出发做编辑，而不是重新抽卡。解掉 D5。

验收：同一角色 5 个状态变体，两两人工比对身份一致；`asset_list(type=character)` 返回的每条记录都有非空 `identityPrompt` 与 `seed`。

### W2 · 参考绑定策略引擎

把"该传哪些参考图、按什么顺序"从 skill 散文提到代码里。

新增 `lib/refs.js`：

```js
/**
 * 按镜头意图解析参考绑定，返回有序 ref 列表。
 * 顺序契约（H3 对靠前的参考图权重更高）：说话人 → 其他角色 → 场景 → 风格锚点
 */
export function planRefs(shot, bible) → { refs: string[], warnings: string[] }
```

规则（可校验，替代散文）：

- 说话人角色卡**必须**排第一（`references/model-selection.md` 里的"primary face anchor"从建议变成断言）
- 场景卡只在场景首镜或换场景镜传入
- 风格锚点在全片所有镜头恒定传入 —— 顺带让 `style:` 资产类型真正可用（解掉 D3 尾巴）
- 总数超过 `manifest.params.refs.max`（当前 8）时按优先级截断并 `warnings` 提示，而不是静默丢弃
- 三视图角色卡拒绝作为 ref（用 `preset: 'character-card'` 的标记位判断），落回 W1 的单视图卡

同时在 `buildRenderGraph` 前加一次断言：`video.reference2video` 且 prompt 含 `[SPEAKER]` 非 `n/a` 时，refs 必须非空且首位为该说话人的角色资产，否则报错而非静默生成。

关于身份锁（D3 主体）：本地若有 IPAdapter / InstantID 节点，可加一份 `video.reference2video` 的变体 manifest，把角色卡额外接到身份编码器上。这是 manifest 契约层的天然扩展点（丢 json 即可，`docs/workflow-contract.md` 的 M5 验收标准），不需要改 JS。**建议先做 W2 的策略引擎再评估身份锁**——参考顺序和风格锚点两项修好之后，漂移可能已降到可接受范围，避免过早引入重量级依赖。

### W3 · 结构化镜头清单

在画布引入新节点类型 `kind: 'shotlist'`，内容为受 schema 约束的 JSON（markdown 镜头表仍然生成，作为人读视图，由 JSON 渲染而来，单一数据源）。

新增 `schemas/shotlist.schema.json`：

```jsonc
{
  "version": 1,
  "shots": [{
    "id": "S03",
    "durationSec": 5,
    "sceneId": "scene:forest-path",
    "sceneEntry": true,                    // 是否场景首镜 → 决定是否传场景卡
    "characters": ["character:fox/with-suit", "character:rabbit"],
    "speaker": "character:rabbit",          // null = 静音镜
    "nonSpeakersMouth": "closed",
    "dialogue": "狐狸怎么能当宇航员呀？",
    "hookType": "visual-joke",
    "perSecond": ["...", "...", "...", "...", "..."],

    "continuity": {                        // 过渡契约（W4 消费）
      "prevShot": "S02",
      "sameScene": false,                  // false → 禁止末帧串联
      "chainFromPrevLastFrame": false,
      "transition": { "type": "dissolve", "durationSec": 0.4 },
      "lightingBaseline": "daylight-soft",
      "wardrobeState": "with-suit"
    },

    "render": {                            // 可复现记录
      "seed": null, "mode": "quality",
      "refs": [], "nodeId": null,
      "status": "pending",                 // pending|generating|ready|approved|failed
      "attempts": 0
    }
  }]
}
```

配套工具：

- `shotlist_write(shots)` / `shotlist_get()` / `shotlist_patch(shotId, patch)`
- `shotlist_validate()` —— 把 `references/shot-table-spec.md` 的七项自检**编译成代码断言**：hook 密度、单镜 ≤15s、单镜 ≤3 重要角色、空间锚点继承、每秒指令覆盖数 = `durationSec`、跨镜连续性、音频模式+口型安全（一镜一说话人、非说话人闭嘴、`speaker ∈ characters`）
- 额外校验 manifest 约束：`durationSec * fps ≤ constraints.maxDurationFrames`（当前 310 帧 ≈ 12.9s），提前拦住必然失败的镜头

`comfy_generate_video` 增加 `shot_id` 参数：给了 shot_id 就从 shotlist 推导 prompt 前缀、refs（走 W2 的 `planRefs`）、串联、时长，并把结果回写 `render` 段。Agent 从"每次自己拼参数"变成"声明镜号"。

### W4 · 打通末帧串联

解掉 D1。三步：

1. **新增能力 `video.lastframe`**，在 `CAPABILITIES` 注册，实现走 ffmpeg（与 `compose.concat` 同类，`runner: "ffmpeg"`）：

```js
// lib/frames.js
/** 抽取视频末帧（或指定时间点帧）→ 落盘为画布 image 节点，返回 nodeId */
export async function extractFrame(root, sessionId, videoRel, { at = 'last' })
```

新增工具 `shot_last_frame(nodeId)` → 产出 image 节点，可直接作为下一镜的 `first_frame_node`。

2. **给 `uploadCanvasNodeImage` 加类型断言**：

```js
if (n.kind !== 'image') throw new Error(
  `节点 ${nid} 是 ${n.kind}，不能作为参考图/首末帧。视频请先用 shot_last_frame 抽帧。`
)
```

静默错误变成明确报错——这是当前最省事、收益最高的单点改动。

3. **串联决策交给数据**：`comfy_generate_video(shot_id=...)` 读 `continuity.sameScene`。同场景续接镜自动抽上一镜末帧并作为 `first_frame_node`；跨场景强制不串联。README 实战要点第 3 条从散文变成代码分支。

若本地 ComfyUI 装了视频加载节点，也可以纯 ComfyUI 实现（`LoadVideo → ImageFromBatch(last) → SaveImage`），做成一份 manifest 走现成契约层，避免引入 ffmpeg 依赖。**推荐先探测节点可用性，ffmpeg 作为回退**。

### W5 · 可复现与一致性 QC

- **seed 纪律**：角色卡生成后把 seed 写入角色档案；重生成同角色默认复用该 seed。`comfy_generate_image` 的 `count>1` 目前用 `seed+i`，把每张的实际 seed 都记进节点参数，方便选中后回填档案。
- **一致性自检落地**：`references/qc-checklist.md` 的 Check 11（说话人身份）/ Check 12（口型一致）目前是模型自查。改为 `shotlist_validate()` 的代码断言 + 生成后把每镜首帧与说话人角色卡并排渲进画布，让人一眼比对。真正的自动身份比对（人脸/特征嵌入距离）成本高，建议先做并排复核。
- **`compose.concat` 补齐**：按 shotlist 的 `continuity.transition` 生成 ffmpeg `xfade`/`acrossfade` 参数，而不是让 Agent 每次手写命令行。转场时长从数据来，跨场景 0.4s / 同场景 0.2s 这类规则写进代码。

---

## 4. 实施顺序

| 阶段 | 内容 | 依赖 | 理由 |
|---|---|---|---|
| **P0** | D1 类型断言（W4.2）、`slugifyName` 修复 + `displayName`（W1.1）、`asset_register` 工具（W1.2） | 无 | 三处都是小改动，直接解掉两个阻塞性缺陷 |
| **P1** | `shotlist` schema + 三个工具 + `shotlist_validate`（W3）、`planRefs` 策略引擎（W2） | P0 | 结构化是后续一切自动化的前提 |
| **P2** | 抽帧能力（W4.1/W4.3）、`comfy_generate_video(shot_id)` 联动、`compose.concat`（W5） | P1 | 需要 shotlist 的 `continuity` 段 |
| **P3** | `image.image2image` 换装通道（W1.4）、角色卡 preset（W1.3）、身份锁 manifest 评估（W2 尾） | P2 | 依赖本地权重可用性，先验证再投入 |

P0 之后，skill 与 systemPrompt 里对应的散文条款应同步改写成"调用哪个工具"，避免两套真相并存。这与 `docs/workflow-contract.md` 已规划的 M3（GUIDANCE 改能力词汇表述）是同一件事，建议合并推进。

---

## 5. 不建议做的事

- **不要给 shotlist 做可视化编辑器**。当前画布的 markdown 视图 + Agent 改写已经够用，UI 成本远高于收益。
- **不要一上来就引入 IPAdapter/InstantID**。先修参考顺序、风格锚点、seed 锁三项低成本手段，量化残余漂移之后再决定。manifest 契约层保证了这个决定可以推迟而不产生返工。
- **不要把 `first_frame_node` 用于跨场景**。串联首帧会把上一场景的光照/构图带进新场景，比硬切更糟。这一条应作为 `shotlist_validate()` 的硬断言而非建议。
- **不要保留"AI 不得入库"这条硬规则**。它的初衷（避免资产库被垃圾卡污染）用 `ask_user_question` 确认即可达到，代价却是一致性主干道不通。
