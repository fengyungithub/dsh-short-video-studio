# 日式二次元赛璐璐（`anime-cel`）

## 1. 适用与不适用

- **适用**：校园、青春、恋爱、日常、轻小说改编；需要"TV 动画 / 剧场版动画"标准的题材。
- **不适用**：写实纪实（改用 `cinematic-live-action`）；需要厚重手绘笔触与自然美术的题材（改用 `ghibli-2d`）；东方古典水墨（改用 `ink-wash-oriental`）。

## 2. 视觉 DNA

| 层 | 规则 |
|---|---|
| 渲染风格 | 日式赛璐璐：干净锐利的线稿 + 两段式平涂阴影（本影 / 影），高光用几何色块切分，边缘硬朗 |
| 角色造型 | 大眼睛、小鼻口、尖下巴的日系五官比例；发型由明确发片构成，发梢锐利 |
| 比例语言 | 约 6–7 头身；角色设定可适度拉长腿部，保持"动画感"而非解剖写实 |
| 发丝 / 毛发 | 发片分层清晰，高光带硬边；发梢分组锐利，可带一两缕挑发 |
| 皮肤 / 材质 | 平涂肤色 + 硬边两段阴影；腮红为柔和椭圆色块；避免渐变写实渲染 |
| 表演风格 | 动画式夸张但节制：汗滴 / 黑线 / 惊愕符号等日式记号可用，眉眼形变大 |
| 动态风格 | 利落的作画节奏，速度线、集中线与闪白可作强调；关键帧清晰、中割可省 |
| 情绪尺度 | 从日常松弛到热血爆发跨度大；强情绪用夸张符号和面部变形，但不破坏角色魅力 |

## 3. 负向风格约束

不要写实摄影、不要 3D render、不要厚涂油画、不要美式粗黑轮廓与半调网点、不要水彩晕染。

## 4. 风格锁后缀（追加到每次生成的 prompt 尾部）

**分两段用**——A 段所有产物通用，B 段**只有角色卡与视频片段**才带（见第 5 段）：

```text
[锁 A · 渲染基调 —— 所有产物通用；无角色词、也无场景物件词]
STYLE LOCK-A — Japanese cel-shaded anime production art, clean crisp line art, flat colour fills with hard-edged two-tone cel shading, geometric highlight shapes. NOT photorealistic, NOT 3D render, NOT thick impasto painting, NOT American comic bold black outlines or halftone, NOT watercolour bleed.
```

```text
[锁 B · 角色与表演 —— 仅角色卡与视频片段追加；场景卡 / 道具卡不要带]
STYLE LOCK-B — anime facial proportions with expressive eyes and sharp chin, layered hair strands with hard-edged highlight bands and sharp tips, subtle blush ovals, expressive anime acting with exaggerated brow and eye deformation, speed lines and emphasis effects where needed.
```

## 5. 分层适配

- **角色卡**：双版本（单视图正面全身 + 三视图横排；视频引用版本由 STEP 0 用户选择：`fast` 只能单视图，`balanced`·`quality` 可选单视图或三视图）+ **锁 A + 锁 B**。发色 / 瞳色 / 校服配色写进节点描述。
- **场景卡**：只画环境 + **只加锁 A**；日式背景可偏向"动画背景美术"（略概括），但不得出现人物。⚠️ **不要带锁 B**——`anime facial proportions` / `expressive anime acting` 这类条款会把人物拉进空场景（**实测已复现**：本风格的场景卡里出现了一个动漫男性角色，违反"场景卡只展示环境"）。
- **道具卡**：单件道具单视图 + **只加锁 A**。
- **视频片段（r2v / i2v）**：**锁 A + 锁 B**，追加在 H3 结构化 prompt **之后**。对白镜靠表情与口型节拍，注意日式"口パク"式嘴型变化幅度小。
- **铅笔分镜图**：**不套本风格锁**（始终纯黑白线稿）。

## 6. 与参考图契约的关系

本风格**不改变**形态规则（角色卡固定双版本（单视图 + 三视图）；视频引用版本由 STEP 0 用户选择，`fast` 只能单视图）与「零文字 / 不拼图」硬规则；`fast` 档仍受 G-ref 门禁约束（见 [reference-image-contract.md](../reference-image-contract.md)）。

## 7. 已知风险与未实测项

- **风险**：赛璐璐硬边阴影在逐帧视频里容易"跳影"（阴影边缘抖动），**未做定量验证**。
- **风险**：大眼睛 + 尖下巴在侧面 / 俯仰角度下更易走形。
- **未实测**：本后缀对线稿稳定性的影响；与续接链叠加的表现。

## 8. 实测状态

| 日期 | 档位 | 抽卡结论 | 备注 |
|---|---|---|---|
| 2026-10-08 | balanced | ⚠️ **场景卡不通过**（角色卡未单独抽卡） | 场景卡风格本身准确，但画面里**出现了一个动漫男性角色**——违反"场景卡只展示场景"。**已修**：后缀拆为 A（渲染/材质，通用）+ B（表演/动态，仅角色卡与视频），场景卡只加 A。**修复后未复测** |
| 2026-10-08 | balanced | ✅ **复测通过** | 修完后缀后用**与原失败轮完全相同的基础提示词**重跑场景卡：纯空街、赛璐璐平涂 + 夜巷暖窗，**零人物零文字** ⇒ 「场景卡只加锁 A」确认有效。同轮按**新画幅约定**补建角色卡（`896×1344` = 2:3 竖版）：单主体、零文字、空背景、人物占比明显变大，风格保真良好。**视频层未测** |
