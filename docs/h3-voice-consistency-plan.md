# H3 声音一致性实现方案

> 状态：**P0 + P1 已实现（2026-10-23）**，P2（评测 / 2K·hires / skill 映射）待做 · 设计稿 v1
> 依据：[`docs/research/h3-audio-consistency.md`](research/h3-audio-consistency.md)（机制与证据）、[`docs/research/h3-audio-local.md`](research/h3-audio-local.md)（本仓代码与实测）
> 结论先行：本仓离"可用的跨镜音色一致"只差一条通道——**参考音频没有接进工作流**。本方案把这条通道补上，并把 prompt、资产、评测三侧一起收口。

---

## 0. 一句话方案

在 **manifest 层**新增 `inject: "audio"` 注入原语（`LoadAudio → ref_audios.ref_audio_i`），在 **工具层**新增 `audio_ref_nodes` 参数（画布音频节点 / 视频节点音轨 / `voice:` 资产），在 **prompt 层**加声明守卫，在 **评测层**加音色回归脚本；不传 `audio_ref_nodes` 时图与今天逐字节相同。

### 0.1 已经用真机 spike 验证过（不是纸面设计）

| 验证项 | 结果 |
|---|---|
| ComfyUI 接受音频上传 | `POST /upload/image` 上传 `voice_probe.wav` → `{"name":"voice_probe.wav","type":"input"}` ✅ |
| `LoadAudio` 能识别该文件 | `object_info.LoadAudio` 的 options 里出现 `voice_probe.wav` ✅ |
| `ref_audios` 槽真实存在 | `object_info.MiniMaxH3ReferenceToVideo.optional` 有 `ref_audios`（max 3）/ `ref_video_audios`（max 3） ✅ |
| `audio_vae` 已接线 | ref2v 全家族 node 5 的 inputs 含 `audio_vae: ["4a",0]` ✅ |
| **端到端能跑** | fast 档 832×480 / 124 帧，**45.4s 成功**，产物 5.17s、24fps、**含 `soun` 轨** ✅ |
| 参考音频真的影响生成 | 同 prompt / 同 seed，有参考 vs 无参考 **md5 不同**（`49646a…` vs `4edc22…`），音频轨道统计不同 ✅ |
| `LoadAudio` 可直接吃视频 | 参考音频用的是 **mp4**（`spike_voice.mp4`），无需 ffmpeg ✅ |

> ⚠️ spike 只证明"通道通了、条件生效"，**没有证明音色真的迁移**——那需要 speaker embedding 指标，见 §7。

---

## 1. 目标与非目标

### 目标

1. **跨镜音色可控**：同一个角色在不同镜头可以喂同一份 2–15s 人声参考，而不是只靠文字描述"quiet, breathy voice"。
2. **可验证**：每条"音色一致"的结论有客观指标或盲测记录，不靠感觉。
3. **可回退**：不传新参数时，39 个现有清单的图结构、行为、性能完全不变（清单文件只多一个不被注入的 params 键）。
4. **不写死实现**：仍然只表达能力 + 档位；音频注入点由清单声明，换实现不用改调用方。

### 非目标（本期不做）

- voice id / 声纹注册（H3 官方就没有，见调研 §2.4）；
- 独立 TTS 或后期配音轨（H3 是 AV 联合生成，加 TTS 会重新引入音画不同步）；
- 多角色同镜音色分离（官方失败模式，见调研 §6）；
- 后期混音 / 母带处理；
- 训练 / LoRA。

---

## 2. 现状盘点

| 能力 | 状态 | 证据 |
|---|---|---|
| 音画联合采样 | ✅ 已有 | `workflows/minimax-h3-ref2v-quality.json`：node 10 同时喂 `VAEDecode`(11) 与 `VAEDecodeAudio`(11a) |
| 链式 AV latent 续接 | ✅ 已有 | `MiniMaxH3MotionContext`（22 帧画面 + 24 帧音频） |
| 参考图通道 | ✅ 已有 | `params.refs` → `LoadImage` → `ref_images.ref_image_${i}`（max 8） |
| **参考音频通道** | ❌ **缺失** | 39 份清单（ref2v 20 / i2v 19）`ref_audios` 零命中；`lib/` 里 `ref_audio` 零命中 |
| i2v 带参考音频 | ❌ 不可行 | `object_info.MiniMaxH3ImageToVideo` 无 `audio_vae` / `ref_audios` 输入（真机查询） |
| prompt 规范 | ✅ 已有 | `skills/h3-prompt-writing/references/ref-en.txt` §2.4/§4.2/§5.4 |
| 音色客观指标 | ❌ 缺失 | 全仓只有接缝级指标（MAD / 相关 / 响度台阶） |
| 画布音频节点 | ⚠️ 半支持 | 交付侧认 `kind==='audio'`（`lib/index.js:2863`），但上传/播放/入库都没有 |

**结论**：结构、续接、prompt 都已就位，唯一断点是"音频文件进不了图"。

---

## 3. 设计原则

1. **缺省零影响**：不声明/不传音频时，`buildGraphFromManifest` 产物必须与今天 **逐字节相同**（进回归测试）。
2. **清单声明式**：音频槽由模板 `params` 声明，工具不认工作流 id、不认模型名。
3. **显式失败优于静默降级**：i2v 传音频、超过 3 段、缺伴随图 → 报错；turbo 档 → 警告但放行。
4. **产物与源头分离**：`scripts/h3-templates/*.json` 是源头，`workflows/*.json` 是产物——只改源头，再 `make-h3-variants.mjs` 重建。
5. **先能测再谈好**：没有指标就不说"一致"。

---

## 4. 总体数据流

```
调用方 comfy_generate_video(audio_ref_nodes=[...])
        │
        ├─ 形状校验（只 r2v；必须伴随至少 1 张参考图/首帧）
        ├─ 解析来源（画布 audio 节点 / 画布 video 节点音轨 / voice: 资产）
        ├─ 规格校验（≤3 段、2–15s、≤15MB、总时长 ≤15s）
        ├─ 上传 ComfyUI input（/upload/image，实测接受 wav/mp4）
        │
        ▼
buildGraphFromManifest(job.ref_audios=[...])
        │  params.ref_audios { inject:"audio", node:"LoadAudio",
        │                       input:"audio", to:"5:ref_audios.ref_audio_${i}", max:3 }
        ▼
graph: LoadAudio(9000) ──► node5.inputs["ref_audios.ref_audio_0"] = ["9000",0]
                             node5.inputs.audio_vae = ["4a",0]   ← 已有
        ▼
采样（同一 SamplerCustomAdvanced）→ VAEDecode + VAEDecodeAudio → CreateVideo
        ▼
画布节点记录 audioRefNodes / audioRefMeta / audio_ref_mode
```

---

## 5. 详细设计

### 5.1 清单层（`lib/manifest.js` + 模板）

**改动 1：注入原语**

```js
// 现在
const INJECT_KINDS = ['scalar', 'image', 'video']
// 改为
const INJECT_KINDS = ['scalar', 'image', 'video', 'audio']
```

**改动 2：模板声明**（`scripts/h3-templates/minimax-h3-ref2v*.json`，全部 ref2v 家族）

```json
"params": {
  "ref_audios": {
    "inject": "audio",
    "via": "node",
    "node": "LoadAudio",
    "input": "audio",
    "to": { "node": "5", "field": "ref_audios.ref_audio_${i}" },
    "max": 3
  }
}
```

**改动 3：注入分支**（`buildGraphFromManifest`，紧挨现有 `inject: 'image'`）

```js
} else if (p.inject === 'audio') {
  const audios = Array.isArray(value) ? value : [value]
  for (let i = 0; i < audios.length; i++) {
    const outId = buildLoaderChain(graph, allocId, audios[i], p, job) // LoadAudio + input 字段
    setField(graph, p.to.node, resolveTemplate(p.to.field, { ...job, i }), [outId, 0])
  }
}
```

**改动 4：把 `buildImageChain` 泛化为 `buildLoaderChain`**

```js
const loaderClass = p.node || 'LoadImage'
const inputField = p.input || (loaderClass === 'LoadAudio' ? 'audio' : 'image')
graph[nid] = { class_type: loaderClass, inputs: { [inputField]: filename } }
```

> 兼容性：不传 `job.ref_audios` 时 `value` 为 `undefined`，注入循环 `continue`，图与今天完全一致。
> `max` 由工具层校验；清单层不校验（与 refs 的现有做法一致）。

**改动 5：生成器传递**
`scripts/make-h3-variants.mjs` 从模板整份继承 `params`，无需额外逻辑；`scripts/make-h3-ctx-templates.mjs` 派生 ctx 模板时需**保留** `ref_audios`（现有实现是复制节点 + 追加 Motion Context 节点，params 整体拷贝即可）。

**范围裁定**：只加在 `ref2v` 家族（`minimax-h3-ref2v-*` 与 `-ctx-*`）。**i2v 家族不加**——`MiniMaxH3ImageToVideo` 没有音频输入（真机 schema 已确认），加了只会得到一条静默丢弃的字段。

### 5.2 工具层（`lib/index.js`）

**新增可选参数**（`comfy_generate_video` 与 `comfy_render` 两处 schema 同步；`comfy_render` 用 `capability: video.reference2video` 时生效）：

```ts
audio_ref_nodes?: string[]   // ≤3；画布 audio 节点 / 画布 video 节点（取其音轨）/ voice: 资产
```

**为什么单独开参数而不是并进 `ref_nodes`**：
- `ref_nodes` 有角色卡双版本选版逻辑（`resolveCharacterRefs`），音频节点没有 `character/cardVariant`，混在一起会让那段逻辑对音频节点做无意义查询；
- 形状契约要求 i2v 明确拒绝音频（`ref_nodes` 在 i2v 已被禁止，语义会打架）；
- 返回值与节点记录需要分开记账（`audioRefs` vs `refNodes`）。

**校验顺序（全部在提交前完成）**

| # | 规则 | 失败级别 | 文案要点 |
|---|---|---|---|
| 1 | `type !== 'r2v'` 且传了音频 | **error** | i2v 没有音频输入；改 r2v，或把音频当后期 |
| 2 | 段数 > 3 | **error** | 官方上限 3 段（`object_info` max=3） |
| 3 | 没有任何图像参考/首帧 | **error** | 官方：参考音频不能单独作为输入，必须伴随图像或视频 |
| 4 | 时长 <2s 或 >15s | **error**（能测时） | 用 ffprobe / 画布节点 `length/fps` 估算；测不了 → warning |
| 5 | 单文件 >15MB / 总时长 >15s | **error**（能测时） | 官方 API 限制 |
| 6 | `tier=fast`（4 步 turbo） | **warning** | ComfyUI 文档：turbo "weaker reference/audio"，建议 balanced/quality |
| 7 | prompt 里没有 `<Audio N>` / `subject_definitions` | **warning** | 声明缺失时参考音频可能只被当背景音；给补写提示 |
| 8 | 解析到不支持音频的实现 | **error** | 该实现清单没有 `params.ref_audios`（如 hires 未改）→ 显式报错，不静默丢 |

**解析器**（新增，仿 `resolveRefImage`）：

```js
async function resolveRefAudio(root, project, lib, ref) {
  if (isAssetRef(ref) && isVoiceAsset(ref)) → 资产文件上传
  const n = project.nodes.find(x => x.id === ref)
  if (!n) → 资产回退/报错
  if (n.kind === 'audio') → 直接上传
  if (n.kind === 'video') → 上传 mp4（LoadAudio 会抽音轨，spike 已验证）
  else → 报错（图片节点没有音频）
}
```

**节点记账**（`runRender` 写画布节点时）：

```js
audio_ref_nodes: audioRefNodes,
audioRefMeta: [{ node, kind, durationSec, sourceName }],
...(/audio_ref/.test(effectivePrompt) ? { audio_ref_declared: true } : {}),
```

**返回值**：`audioRefs: [{node, durationSec}]`，与 `refNodes` 平级。

### 5.3 上传与格式

- **复用 `/upload/image`**：真机验证它接受 `.wav`（返回 `type: input`），且现有代码注释已说明它同时吃 mp4（`lib/index.js:2618`）。
- **不新增上传端点**，避免第二套鉴权/大小限制。
- 命名：沿用 `comfyUploadImage` 的内部逻辑，重命名为 `comfyUploadMedia` 并保持行为不变（调用点仅 3 处）。
- **格式建议**：wav / mp3 / m4a / flac / mp4（视频音轨）。H3 内部是 32 kHz 立体声；上传侧不做重采样（ComfyUI 的 `LoadAudio` 会处理）。

### 5.4 画布与资产（`studio/` + `lib/assets.js`）

**画布**

1. `POST /canvas/upload` 目前走 `importManualImage`（只认 png/jpg/webp/gif）。改为 `importManualMedia`：
   - data URL mime 白名单扩展 `audio/wav|mpeg|mp4|flac|ogg`；
   - 按 mime 决定 `kind: 'audio' | 'image'`；
   - 保留 `params.source='manual-upload'`。
2. `studio/app.js` 的媒体渲染分支（当前 `:747` 对 audio 只给下载链接）加 `<audio controls>` 播放器；卡片按钮保持"入库 / 替换 / 删除"。
3. `copyAssetToCanvas`（`:788`）增加 `kind === 'audio'` 分支（拷贝文件、`kind:'audio'`、写 `params.assetId`）。
4. `asset_to_canvas` 的说明文字更新（"视频/文本"→"视频/音频/文本"）。

**资产库**

1. `ASSET_TYPES` 增加 `'voice'`（`lib/assets.js:27`），`ASSET_KINDS` 增加 `'audio'`，`TYPE_KINDS.voice='audio'`。
2. `isAssetRef` 正则增加 `voice:`（`:121`）；`canonAssetId` 无需改。
3. `registerAsset` 的 else 分支已按 `kind` 拷文件，音频只需扩展名兜底（当前 `kind==='video'?'.mp4':'.png'`，改为按 kind）。
4. `asset_list` 的 `type` 枚举加 `voice`（`lib/index.js` 两处 schema 文案）。

> 入库存放目录沿用 `ASSET_DIR/images/`（历史命名不可改，避免迁移）；只按扩展名区分。

### 5.5 Prompt 层

**不变的部分**：H3 结构化六段式仍由 `h3-prompt-writing` skill 产出，本方案不改写规范。

**新增守卫**（工具层只警告，不改写用户的 prompt）：

- 传了 `audio_ref_nodes` 但 prompt 不含 `<Audio \d` → warning：
  > 「已传参考音频，但 prompt 未声明 `<Audio N>`。参考音频可能只被当环境音；按官方 Ref2VA 规范补 `<Audio 1> is the voice-timbre reference for <Subject 1> (S1).` 与 `<Audio 1>: reference - …`。」
- prompt 含 `<Audio N>` 但没传音频 → warning（防止"声明了却无输入"的空绑定）。

**skill 侧改动**

1. `skills/h3-prompt-writing/references/studio-mapping.md` 增加一行映射：`声线参考（音频节点）→ subject_definitions 的 <Audio N> + retention_analysis 的 reference marker + 同 (Sx)`，并注明"只借音色就**不要**把参考音频原台词写进 `<d>`"。
2. `skills/story-short-generator/SKILL.md`：
   - 镜头表"音频与对白轨"增加子字段 `声线参考`（角色名 / none）；
   - 逐镜生成步骤：当项目有 `voice:` 资产且该镜 `speaker != none` 时，传 `audio_ref_nodes=[该角色声线资产]`；
   - 自检门增加一条：同一说话人在不同镜必须引用**同一份**声线资产（按 assetId 判等）。
3. `skills/story-short-generator` 的 STEP 3（角色卡）可选增加"声线样本"步骤：用户上传 2–15s 干声 → 画布 audio 节点 → 入库 `voice:`。

### 5.6 与链式续接 / 2K 的关系

| 组合 | 是否允许 | 说明 |
|---|---|---|
| 参考音频 + `continuity_from` | ✅ | 两者职责不同：音频参考管**跨镜身份**，续接管**接缝连续**。ref2v-ctx 家族已同时具备 `audio_vae` 与 `ref_audios` 槽 |
| 参考音频 + i2v 首末帧 | ❌ | i2v 节点无音频输入；需要时改 r2v + 首帧（若实现支持） |
| 参考音频 + 2K 放大族 / hires 两阶段 | ⚠️ 暂不支持 | 这些模板尚未加 `ref_audios`；P0 先覆盖普通与 ctx 家族，2K/hires 留 P2（二遍是否保声线未验证） |
| 参考音频 + fast 档 | ⚠️ 允许但警告 | 4 步 turbo 削弱参考强度（ComfyUI 文档）；建议 balanced/quality |
| 换参考音频后 | 必须连锁重渲 | 与现有"重渲连锁"一致：该镜及其下游 `接 该镜` 全部重渲，否则切点音色跳变 |

### 5.7 档位策略

- 传递 `audio_ref_nodes` **不改变档位解析**——仍由 `tier` 走注册表。
- 建议默认：有声线参考的镜头走 `balanced`（8 步）或 `quality`（20 步）；`fast` 只用于调试，并在返回值里带警告。
- 不新增"voice 档"之类的伪档位（档位语义由注册表定义，见 `docs/tier-strategy-design.md`）。

### 5.8 评测（本期必须有，否则无法验收）

1. **接缝指标**（已有 `e2e-out/ctx-test/measure_seam.py`，需修两处口径）：
   - 报告**最佳滞后**，并新增 **零滞后相关**；现有 ±440ms 峰值相关不足以证明波形连续（调研 §5.3）。
   - 保留响度台阶（最硬指标）。
2. **音色指标**（新增 `scripts/eval-voice-consistency.mjs`）：
   - 输入：同一 `voice:` 资产生成的 N 镜；
   - 方法：若本机有 speaker embedding 模型（3D-Speaker / ECAPA / Resemblyzer 任一），算两两 cosine；没有则输出"仅盲测"；
   - 输出 `e2e-out/voice-consistency/report.json` + 一页 HTML（并排音频 + 相似度矩阵）。
3. **盲测协议**：每对镜头抽 3s 干净对白，5 人盲听（A/B 是否同一人），记录 8/10 通过线。
4. **回归基线**：同 seed、同参考音频、同 prompt 的两次生成，应稳定在同一说话人区间（记录而非断言，扩散模型有随机性）。

---

## 6. 接口契约

### 6.1 参数

| 参数 | 类型 | 默认 | 约束 |
|---|---|---|---|
| `audio_ref_nodes` | `string[]` | 无 | ≤3；元素为画布 audio/video 节点 id 或 `voice:` 资产 id |

### 6.2 错误码（工具返回 `ok:false` + `error`）

| 场景 | 文案前缀 |
|---|---|
| i2v + 音频 | `audio-ref-shape: type=i2v 没有音频输入…` |
| 超过 3 段 | `audio-ref-limit: 最多 3 段…` |
| 缺伴随图 | `audio-ref-companion: 参考音频不能单独使用…` |
| 格式/文件缺失 | `audio-ref-invalid: …` |
| 实现不支持 | `audio-ref-unsupported: 实现 X 没有 ref_audios 注入点…` |

### 6.3 警告（`warnings[]`）

| 场景 | 文案要点 |
|---|---|
| fast 档 | turbo 削弱参考/音频，建议 balanced/quality |
| prompt 未声明 | 参考可能只被当环境音，需补 `<Audio N>` |
| 时长无法校验 | 本机无 ffprobe，未校验 2–15s |
| prompt 声明但无输入 | 空绑定 |

---

## 7. 实施阶段

### P0 — 通道打通（约 1.5 人日）

| 任务 | 文件 | 验收 |
|---|---|---|
| 注入原语 + 泛化 loader | `lib/manifest.js` | 单测：有/无 `ref_audios` 的图差异 |
| 模板加音频参数 | `scripts/h3-templates/minimax-h3-ref2v*.json` 中**非 2K / 非 hires 的 8 份** | `make-h3-variants --dry` 通过 |
| 工具参数 + 校验 + 解析 + 记账 | `lib/index.js` | 8 条校验路径各有测试 |
| 重建受影响家族 | `workflows/minimax-h3-ref2v-*.json` | 重建后**未传音频时图逐字节相同**；其余 19 份 i2v 清单无 diff |
| 上传函数改名 + 音频扩展名 | `lib/index.js` | 上传 wav 成功 |

**DoD**：`comfy_generate_video(type='r2v', audio_ref_nodes=[...])` 能跑通一镜，产物含音频，画布记录 `audioRefNodes`。

### P1 — 画布/资产/取音（约 2 人日）

| 任务 | 文件 |
|---|---|
| 通用媒体上传（audio） | `lib/index.js` `importManualImage` → `importManualMedia` |
| 音频节点播放器 + 入库按钮 | `studio/app.js` |
| `voice:` 资产类型 | `lib/assets.js` |
| `asset_to_canvas` / `asset_list` 支持音频 | `lib/index.js` |
| "从视频抽声线"工具（可选 ffmpeg；无 ffmpeg 时走 ComfyUI `LoadVideo→GetVideoComponents→SaveAudio`） | `lib/index.js` 新工具 `extract_audio` |

**DoD**：用户能在画布上传一段人声 → 入库 → 在三个镜头里复用同一份 `voice:` 资产。

### P2 — 评测与策略（约 2 人日）

| 任务 | 文件 |
|---|---|
| 音色回归脚本 + HTML 报告 | `scripts/eval-voice-consistency.mjs`（新） |
| 接缝指标补零滞后 + 滞后报告 | `e2e-out/ctx-test/measure_seam.py` |
| 2K 家族加音频参数 | `scripts/h3-templates/*-2k.json` |
| skill 映射与镜头表字段 | `skills/h3-prompt-writing/references/studio-mapping.md`、`skills/story-short-generator/SKILL.md` |
| 文档 | `docs/shot-chain-continuity.md` 增"音频参考 × 续接"节 |

**DoD**：同一 `voice:` 资产 3 镜的盲测与（可选）embedding 相似度有报告；skill 流程能自动带上 `audio_ref_nodes`。

---

## 8. 测试计划

### 8.1 单元（无 GPU）

- `buildGraphFromManifest`：
  - 不传 `ref_audios` → 图与基线**深比较相等**；
  - 传 1/3 段 → 生成 `LoadAudio` 节点、字段 `ref_audios.ref_audio_0..2` 正确；
  - 超过 `max` → 由工具层拦截（清单层不抛）。
- `resolveRefAudio`：audio 节点 / video 节点 / `voice:` 资产 / 图片节点（应报错）/ 不存在 id。
- 校验矩阵：8 条错误/警告各一条。

### 8.2 冒烟（mock ComfyUI）

`scripts/smoke-voice-ref.mjs`（新增）：mock `/upload/image` 与 `/prompt`，断言提交图里包含 `LoadAudio` 与 `ref_audios.ref_audio_0`，且 `audio_vae` 仍在。

### 8.3 端到端（真渲染，fast 档）

- 两镜同一角色、同一 `voice:` 资产、同 prompt；
- 对照：同样两镜不传音频；
- 记录：耗时、接缝响度台阶、零滞后相关、盲测结论；
- 产物落 `e2e-out/voice-consistency/`。

### 8.4 回归

- `node scripts/make-h3-variants.mjs --dry`（全清单校验）；
- 重建全量后，`git diff --stat` 只应出现 ref2v 模板/清单的 `params.ref_audios` 新增（i2v 19 份零 diff）；
- 既有 `smoke-render` / `smoke-submit` / `smoke-video-shape` 全绿。

### 8.5 性能

- 同一镜：1 段音频参考 vs 无参考，fast 档耗时差（spike 参考值：45.4s，无参考对照同量级）。
- 3 段音频参考的显存峰值（balanced 档）——超过 24GB 则限制为 2 段并写进警告。

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 参考音频被静默忽略 | 以为一致、实际没有 | 校验 `audio_vae` 已接线；e2e 对照实验（有/无参考必须不同）；prompt 声明守卫 |
| turbo 档参考"持不住" | fast 档音色漂 | fast 必带警告；文档建议 balanced/quality |
| 参考音频带 BGM/混响 | 音色被污染、串层 | skill 引导"干声、单人、2–15s"；校验总时长；不做自动降噪（P2 可加） |
| 多说话人 + 音频参考错配 | 台词分错人 | 沿用"一镜一说话人"硬约束；一人一份 `voice:` 资产 |
| 参考音频原台词被搬运 | 内容串味 | prompt 明确 `reference` marker + "只借音色"；skill 规范已有 |
| 时长/格式不合法 | 提交后模型侧失败 | 前置校验；无 ffprobe 时降级为警告并如实说明 |
| 2K 家族未接 | 用户升 2K 后音色退化 | P0 显式报"该实现不支持参考音频"，P2 再补 |
| 画布音频无播放器 | 用户无法确认素材 | P1 补 `<audio>` 与波形（波形可选） |
| 隐私/版权 | 人声素材合规风险 | 资产库仅本地；文档提示需授权；不做"声纹库" |

---

## 10. 文件改动清单

| 文件 | 改动 |
|---|---|
| `lib/manifest.js` | `INJECT_KINDS += audio`；`buildImageChain → buildLoaderChain`（`p.input`）；`inject: 'audio'` 分支 |
| `lib/index.js` | 两处工具 schema 加 `audio_ref_nodes`；`resolveRefAudio`；8 条校验；fast/prompt 警告；节点记账；`comfyUploadMedia`；`importManualMedia`；`copyAssetToCanvas` audio 分支；`asset_list`/`asset_to_canvas` 文案；可选 `extract_audio` |
| `lib/assets.js` | `ASSET_TYPES += voice`；`ASSET_KINDS += audio`；`TYPE_KINDS.voice`；`isAssetRef` 加 `voice:`；`registerAsset` 扩展名兜底 |
| `scripts/h3-templates/minimax-h3-ref2v*.json` | 非 2K / 非 hires 的 8 份加 `params.ref_audios`（P2 再评估 hires + 2K 共 6 份） |
| `scripts/make-h3-variants.mjs` | 无需逻辑改动（params 整体继承），仅重建 |
| `scripts/make-h3-ctx-templates.mjs` | 派生 ctx 模板时保留 `params.ref_audios` |
| `workflows/minimax-h3-ref2v-*.json` | 生成物（勿手改） |
| `studio/app.js` | 音频播放器、上传 accept、入库按钮 |
| `skills/h3-prompt-writing/references/studio-mapping.md` | 声线参考映射 |
| `skills/story-short-generator/SKILL.md` | 镜头表 `声线参考`、生成步骤、自检门 |
| `scripts/eval-voice-consistency.mjs`（新） | 音色回归 |
| `scripts/smoke-voice-ref.mjs`（新） | 冒烟 |
| `docs/shot-chain-continuity.md` | 音频参考 × 续接 |
| `docs/h3-voice-consistency-plan.md`（本文件） | 方案 |

---

## 11. 开放问题（需要实验回答）

1. **音色迁移效果**：H3 的 `reference` 到底能多像？需要 embedding 指标 + 盲测，建议先跑 3 个不同声线 × 3 镜。
2. **参考音频长度**：官方 2–15s，但"多长最稳"没有公开数据；建议 A/B 3s / 8s / 15s。
3. **参考音频与 prompt 音色描述冲突时谁赢**：例如参考是低沉男声、prompt 写"bright female voice"——需要实验确定优先级。
4. **3 段音频参考的显存与质量拐点**。
5. **2K 再生成是否保声线**：官方未说明，需实测 `Regenerate-2K` 前后 embedding 相似度。
6. **`ref_video_audios`（参考视频音轨）** 是否比 `ref_audios` 更稳：留 P2 评估。

---

## 附录 A：spike 原始记录

```text
# 上传
POST /upload/image  voice_probe.wav → {"name":"voice_probe.wav","type":"input"}
GET  /object_info/LoadAudio → options 含 voice_probe.wav

# 建图（ref2v-fast 清单 + 手工加 LoadAudio）
prompt: Ref2VA 六段式，含 <Audio 1> … <Subject 1> (S1)
width 832 height 480 length 124 seed 42424242 steps 4
graph["9000"] = LoadAudio{audio: spike_voice.mp4}
graph["5"].inputs["ref_audios.ref_audio_0"] = ["9000", 0]

# 提交
POST /prompt → 200 {"prompt_id":"26e73060-…","node_errors":{}}
/history → success，elapsed 45.4s
产物 refaudio_00001_.mp4：832×480、5.17s、24fps、124 帧、含 soun 轨

# 对照（去掉 LoadAudio 与字段）
noaudio_00001_.mp4，750519 B；refaudio 748594 B
md5 49646a6d58d7ee51474b3685568496a5 vs 4edc22934d271955685e5b251f62ffb7 → 不同
音频抽取（ComfyUI LoadVideo→GetVideoComponents→SaveAudio）：
  ref 5.184s / no 5.184s / source 5.888s，均 32kHz stereo
  零滞后相关 0.0016（两次生成是不同 take，符合扩散模型预期）
  频谱质心 ref 2500.7 / no 2643.8 / source 1248.6
  → 只证明"条件生效"，未证明"音色迁移"
```

## 附录 B：H3 节点音频槽（真机 `object_info` 摘录）

```json
"optional": {
  "vae": ["VAE", {"tooltip": "Video VAE. Without it reference images/videos only condition the text encoder."}],
  "audio_vae": ["VAE", {"tooltip": "Audio VAE. Without it reference audio only conditions the text encoder."}],
  "ref_images":       {"prefix": "ref_image_",       "min": 0, "max": 9},
  "ref_videos":       {"prefix": "ref_video_",       "min": 0, "max": 3},
  "ref_video_audios": {"prefix": "ref_video_audio_", "min": 0, "max": 3},
  "ref_audios":       {"prefix": "ref_audio_",       "min": 0, "max": 3}
}
```

> 注意 `audio_vae` 的 tooltip：**没有它时参考音频只进文本编码器**。ref2v 家族已接线；这是本方案能在 ref2v 上成立、而 i2v 不成立的根本原因。


---

## 附录 C：P0 / P1 落地记录（2026-10-23）

### 已实现

| 层 | 改动 | 文件 |
|---|---|---|
| 清单 | `INJECT_KINDS += 'audio'`；`buildImageChain` 支持 `p.input`（LoadAudio 用 `audio`）；`inject:'audio'` 分支 | `lib/manifest.js` |
| 模板 | 12 份 ref2v 模板加 `params.ref_audios`（8 普通/ctx + 4 PDD）；**hires / 2K 刻意不加** | `scripts/h3-templates/*.json` |
| 清单产物 | 重建 39 份，14 份 ref2v 带 `ref_audios`，19 份 i2v 零 diff | `workflows/*.json` |
| 工具 | `audio_ref_nodes`（两处 schema）；`resolveRefAudio`（画布音频 / 视频音轨 / `voice:`·`clip:` 资产）；8 条校验；prompt 守卫；fast 档警告；节点记账 + 返回值 `audioRefs` | `lib/index.js` |
| 解析 | `/upload/image` 通用化（`comfyUploadMedia`）；WAV 头直读时长（本机无 ffprobe 也能校验）；ffprobe 兜底 | `lib/index.js` |
| 画布 | 手动上传接受音频（wav/mp3/m4a/flac/ogg/webm）；`kind='audio'` 节点；播放器；音频入库 | `lib/index.js`、`studio/app.js`、`studio/app.css` |
| 资产 | `voice` 类型（kind audio）；`voice:` 前缀；`asset_to_canvas` / `/assets` 路由支持；`NODE_KINDS.audio` | `lib/assets.js`、`lib/index.js` |
| 取声线 | `extract_audio(video_node)`：ffmpeg 优先，缺失时走 ComfyUI `LoadVideo→GetVideoComponents→SaveAudio` | `lib/index.js` |
| 文档 | 工具契约（systemPrompt + README）、本方案 | `lib/index.js`、`README.md`、本文件 |

### 验证结果

- `scripts/smoke-voice-ref.mjs`：19 项全过（声明面 14/20、i2v 0/19、图编译缺省零影响、注入指针正确、形状真值表 5 条）。
- `scripts/e2e-voice-ref.mjs --audio=/tmp/voice_sample.wav`：**真机 fast 档 26.6s** 全过——
  画布音频节点（5.00s）→ 生成 124 帧 → `audioRefMeta`/`audio_ref_declared` 记账正确 →
  产物含音轨 → i2v+音频显式拒跑 → `extract_audio`（后端 comfyui，2.1s）。
- 组合验证：**参考音频 + 链式续接**（`minimax-h3-ref2v-ctx-fast`）真机跑通——起链 124 帧（clip 4968），
  续接镜 136 帧（load 4968 / save 4969），两镜都带了 `audioRefs`。设计里「参考音频管音色、续接管接缝」的组合成立。
- 回归：39 份清单在**不传 `ref_audios`** 时编译图与 `HEAD` **逐字节相同**（39/39，0 diff）。
- 既有 smoke：`smoke-tools`(200)、`smoke-manifest`、`smoke-render`、`smoke-video-shape`(31)、`smoke-assets`(145)、`smoke-upload-assets`(41)、`smoke-canvas-theme`(28)、`preview-canvas --assert`(91) 全绿。

### 与设计稿的偏差（如实记录）

1. **新增 WAV 头时长解析**：设计稿只写 ffprobe；本机没有 ffprobe，而 2–15s 是硬校验，所以在**上传时**直接从 WAV 头算时长并记进节点 `params.durationSec`，`resolveRefAudio` 优先读它。mp3/m4a 仍需 ffprobe，缺失时按设计降级为警告。
2. **PDD 家族一并接入**（14/20 而非 12/20）：PDD 是非 2K / 非 hires 的 ref2v 实现，node 5 与 `audio_vae` 均满足，纳入后用户 pin PDD 时不会突然丢参考音频。
3. **`extract_audio` 走 ComfyUI 兜底**：`SaveAudio` 实际落 `.flac`（16bit/32kHz），媒体路由已补 `audio/flac` 等 content-type。

### 已知边界（P2 或后续）

- `2K`（5 份）与 `hires`（1 份）实现未接 `ref_audios`：选中会显式报 `audio-ref-unsupported`，不会静默丢音频。
- 音色相似度指标、盲测脚本仍是 P2（skill 的 `声线参考` 字段与自检门已随试镜流程落地，见 `docs/research/audio-capability-roadmap.md` 附录）。
- `AUDIO_REF_MAX_COUNT` 只在工具层生效；清单里的 `max: 3` 仍是声明性的（与既有 `refs` 一致）。
