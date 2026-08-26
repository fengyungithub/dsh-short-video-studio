# 三视图必要性与重复角色问题 · 实验报告

**结论先行：三视图对 H3 参考绑定没有必要性，拼成一张图是重复角色的直接原因。修复应在 workflow 层做，且零 JS 改动即可。**

实验环境：本机 ComfyUI 0.33.3 / A800 80GB / `minimax_h3_ref2va_pruned_int8_convrot`，`mode=fast`（4 步 Lightning LoRA），832×480，`length=124`（5.17s），每臂约 28s。

方法：复用项目自身的 `lib/manifest.js` `buildGraphFromManifest()`，跑的就是生产路径。所有臂固定 `seed=42424242`、固定 prompt（J/K 组换 seed 与 prompt，组内固定），只变参考图与参数。额外在 `VAEDecode` 后挂 `ImageFromBatch → SaveImage` 抽帧用于逐帧目视比对。

> 每个臂都产出了真实音视频 mp4（`tracks=['vide','soun']`、5.17s、带音轨）。报告里的 PNG 是从这些视频里抽出的帧，不是独立生成的静图。

---

## 0. 起因：仓库素材与文档自相矛盾

`examples/fox/` 下三张角色卡（`char_fox_no_suit.png` / `char_fox_with_suit.png` / `char_rabbit.png`，均 1344×768）**实物全部是正/侧/背三视图拼图**。

但：

| 位置 | 表述 |
|---|---|
| `README.md` §3 标题 | 「角色卡（character cards，**单视图**参考）」 |
| `README.md` 实战要点 1 | 「参考图用**单视图**」 |
| `SKILL.md:39` | 「**单视图**正面全身」 |
| `lib/index.js:1776`（GUIDANCE Step 3） | 「含正/侧/背**三视图**」 |

素材是三视图、文档说单视图、systemPrompt 又要求三视图。三方矛盾。

另外狐狸卡底部有一行 FLUX 渲染失败的中文乱码（「正面坐坐身」「汪正面丁」「哈莴陀汀锶皈」），它也是参考图的一部分。

---

## 1. 实验矩阵与结果

| 臂 | 参考图 | prompt / 参数 | 结果 |
|---|---|---|---|
| **A** | 三视图原卡（带乱码） | 普通 | ❌ **多只狐狸**，底部出现模糊假汉字 |
| **B** | 裁切正面单视图 | 普通 | ✅ 单只狐狸，干净 |
| **C** | 三视图原卡 | + 「同一角色多角度，只出现一只」 | ❌ **仍是多只**，声明无效 |
| **D** | 单视图 | `ref_image_size=max` | ⚠️ 与 B **像素级完全相同**（diff=0.0） |
| **E** | 三视图，**裁掉全部文字** | 普通 | ❌ **仍是 3 个角色**（中间狐狸 + 左右两个穿格子衣的类人生物） |
| **F** | 三视图 + **清晰英文标注** | 普通 | ❌ 多只 **且 `FRONT VIEW`/`SIDE VIEW`/`BACK VIEW` 被印刷级清晰地烙进画面** |
| **G** | 单视图 + 清晰英文标注 | 普通 | ✅ 单只，底部无文字渗透 |
| **H** | 正/侧/背**三张单图占 3 个 ref 槽位** | 普通 | ✅ 单只狐狸，干净 |
| **I** | 三视图原卡 + manifest `preprocess: ImageCrop` | 普通 | ✅ **与 B 像素级完全相同**（diff=0.0） |
| **J** | 仅正面单视图 | 强制转身 prompt | ✅ 转身全程身份稳定 |
| **K** | 正+侧+背 3 槽位 | 强制转身 prompt | ✅ 稳定，**但并不优于 J** |

---

## 2. 四条被实验证伪/证实的判断

### 2.1 重复角色由「视图数量」决定，与文字无关（E 臂证实）

E 臂把乱码全部裁掉，只留三视图画面 → **依然生成 3 个角色**。所以文字不是重复的原因。参考图里有几个身体，模型就倾向画几个。

### 2.2 prompt 声明「只出现一只」完全无效（C 臂证伪）

C 臂在 prompt 里明确写 `The reference image shows multiple view angles of the SAME single fox character; only ONE fox appears in the scene.` → 输出仍是多只。A vs C 像素差 29-31（prompt 变了所以画面变了），但**两者都是多只**。

这直接证伪了当前 systemPrompt 的 fallback 建议：

```
lib/index.js:1790
「…或必要时在三视图参考时于 prompt 声明『参考图是同一角色的多个角度、只出现一只角色』」
```

**这条建议无效，必须删除。** 它给了 Agent 一个"三视图也能用"的错误退路。

### 2.3 用英文标注不是解决方案，反而更糟（F 臂证伪）

这是本次实验最反直觉的一条。乱码中文只是渗成模糊污块；换成清晰的 `FRONT VIEW` / `SIDE VIEW` / `BACK VIEW`，H3 把它们**一字不差、印刷级清晰地渲进了成片**。

**标注越清晰，污染越严重。** H3 有很强的文字渲染能力（这正是它能做原生中文字幕的原因），参考图里的任何清晰文字都会被当作"应该出现在画面里的内容"。

对比 G 臂（单视图 + 同样清晰的英文标注）底部干净——说明文字渗透与参考图被缩放的程度、文字占比有关，但结论不变：**参考图应当零文字**。角色标注属于元数据，应存在资产库记录里（`displayName` / `identityPrompt`），不该烧在像素上。

### 2.4 多角度信息对 H3 没有增量价值（J≈K）

这是回答"必要性"的核心。J/K 用强制转身 prompt（正面起手 → 转身 → 背对镜头走远），6 个时间点采样：

- J（仅正面 1 槽位）：转身全程身份稳定
- K（正+侧+背 3 槽位）：稳定，但**看不出优于 J**

H3 是视频模型，本身具备 3D 空间理解，正面单图已足够支撑转身。三视图想解决的"多角度身份信息"问题，在这个模型上并不存在。

---

## 3. 那三视图还有用吗？

**作为渲染参考：没有必要，且有害。** 上面四条已经说明。

**作为人工审稿物料：有价值。** 三视图便于人类一眼确认角色设计是否成立（比例、尾巴、配色在不同角度是否自洽）。这是美术流程的正当需求。

所以正确的定位是：

> 三视图 = **可选的、面向人的审稿产物**；渲染参考**必须**是单视图。两者物理分离，不同资产记录。

如果确实想在渲染时利用多角度，正确用法是 **H 臂的多槽位**（`ref_image_0/1/2` 各放一张单视图），而不是拼成一张图。`ref_images` 是 `COMFY_AUTOGROW_V3`，上限 **9** 槽（manifest 当前写 `max: 8`，可放宽）。但基于 J≈K，**默认不建议**，因为它白占 3 个 ref 槽位（场景卡、风格锚点还要用）且增加约 4s 生成时间。

---

## 4. 是否该优化 workflow？该，而且零 JS 改动

**I 臂是本次最有价值的工程结论。**

给 manifest 的 `refs` 参数挂一个 `preprocess`：

```jsonc
// workflows/minimax-h3-ref2v.json
"refs": {
  "inject": "image", "via": "node", "node": "LoadImage",
  "to": { "node": "5", "field": "ref_images.ref_image_${i}" },
  "max": 9,
  "preprocess": [
    { "class_type": "ImageCrop", "inputs": { "width": 448, "height": 675, "x": 0, "y": 0 } }
  ]
}
```

`buildGraphFromManifest` 自动注入了 `ImageCrop` 节点并把 `ref_image_0` 重新指向它：

```
注入的 ImageCrop 节点: [["1001",{"class_type":"ImageCrop","inputs":{"width":448,"height":675,"x":0,"y":0,"image":["1000",0]}}]]
ref_image_0 指向: ["1001",0]
```

输出与"预先裁好的单视图"（B 臂）**像素级完全相同**：`bbox=None, mean=0.000`，三个采样帧全部为 0。

意义：

- **零 JS 改动**。manifest 的 `preprocess` 原语（`lib/manifest.js` 已实现）本来就是为这类图像预处理设计的，这次验证了它足够表达裁切。
- **历史资产可自动救回**。已入库的三视图卡不用重新生成。
- 印证了 `docs/workflow-contract.md` 的 M5 验收标准：能力扩展只需改 json。

但**硬编码裁切参数不能直接上生产**——不同卡的视图布局不同。落地方案见 §6。

---

## 5. 顺带发现（都影响一致性，均已实测）

| 发现 | 证据 | 影响 |
|---|---|---|
| **`ref_image_size=max` 在当前配置下无效果** | D vs B 像素级相同 | tooltip 说 `match` 是「down only」缩放到生成像素面积，`max` 用短边 2048。裁出的单视图 448×675（30 万像素）小于生成面积 832×480（40 万），两模式都不缩放 → 输出相同。**只有高分辨率参考图才可能体现差异**，需另测 |
| **H3 原生支持 `ref_videos`（2-15s，最多 3 个）与 `ref_audios`（3 个）** | `object_info` 节点规格 | 项目完全没用。参考**视频**做跨镜一致性，理论上强于末帧串静图。这是比现有方案更高的天花板 |
| **in-workflow 抽帧可行** | `ImageFromBatch → SaveImage` 本次全程在用 | **末帧串联不需要 ffmpeg**（本机也没装 ffmpeg）。`architecture-review`/`consistency-optimization-plan` 里的 ffmpeg 方案应改为 ComfyUI 内实现 |
| **本地无 IPAdapter / InstantID / PuLID** | `object_info` 1184 个节点全扫，零命中 | 之前"可加身份锁 manifest"的建议**不成立**。身份只能靠参考图 + seed + 提示词 |
| **`ref_images` 上限是 9，manifest 写 8** | `COMFY_AUTOGROW_V3` `max: 9` | 小事，顺手放宽 |
| **`constraints` 在代码里从未被强制** | `grep` 只在 validate 和列表回显里出现 | `aspectRatios` / `maxDurationFrames`（310 帧≈12.9s）都是纯声明。超时长镜头不会被提前拦住 |

---

## 6. 落地建议（按优先级）

### P0 · 消除三方矛盾，禁掉三视图作参考

1. 改 `lib/index.js:1776`：「含正/侧/背三视图」→「单视图正面全身」。
2. **删掉 `lib/index.js:1790` 的 prompt 声明 fallback**（C 臂已证伪）。
3. 新增硬规则：**参考图不得包含任何文字**（F 臂证据）。角色名/视图标注放资产库元数据。
4. 重做 `examples/fox/` 三张卡为单视图，或至少在 README 里标注「示例卡为历史三视图，非推荐用法」。当前素材与文档矛盾会持续误导。

### P1 · 角色卡生成用代码保证单视图

`comfy_generate_image` 加 `preset: 'character-card'`，由代码拼固定后缀：单个角色、正面全身、中性背景、**画面内不得出现任何文字/标签/水印**、留边。不要指望 Agent 每次自己写对——当前 systemPrompt 自己都写矛盾了。

### P2 · workflow 层兜底（I 臂方案产品化）

硬编码裁切不可直接上生产。两种做法：

- **推荐**：资产记录加 `refCrop: {x,y,w,h}` 字段（可空）。入库时若判定为多视图卡，让用户框选正面区域并存下来；渲染时把它翻译成 `preprocess` 的 `ImageCrop` 参数。一次标注，永久复用。
- 或者：入库时就把裁切结果另存为一条新的单视图资产（`character:fox/front`），渲染永远只用单视图资产。更简单，代价是存两份图。

配合在 `runRender` 前加断言：参考图长宽比异常宽（如 > 2.2:1）时告警"疑似多视图卡"。

### P3 · 探索 `ref_videos`

用上一镜的**视频片段**（而非末帧静图）作为下一镜参考，是当前架构没触及的方向，且 H3 原生支持。建议在 W4（末帧串联）落地后单独做一组 A/B。

---

## 7. 修正之前文档里的错误判断

本次实验推翻了我在前两份文档里的两处结论，需一并更正：

- `consistency-optimization-plan.md` §W2 写「可加 IPAdapter/InstantID 变体 manifest 做身份锁」→ **本地无这些节点，不成立**。
- 同文档把 `ref_image_size=max` 视为「免费的一致性提升」→ **在参考图小于生成面积时完全无效果**，需高分辨率参考图重测才能定论。
- 两份文档都假设抽帧要引入 ffmpeg → **应改为 ComfyUI 内 `ImageFromBatch`**，本机无 ffmpeg 且无需引入。

---

## 附：复现

实验脚本在 `/tmp/consistency-exp/`（`run.mjs` A-D、`run2.mjs` E-G、`run3.mjs` H-I、`run4.mjs` J-K），均直接 import 项目的 `lib/manifest.js`。对比图 `grid.png`（A-D）、`grid2.png`（E-G）、`grid3.png`（B/H/I）、`grid4.png`（J/K 转身序列）。
