# 吉卜力 2D 手绘（`ghibli-2d`）

## 1. 适用与不适用

- **适用**：治愈、自然、成长、奇幻冒险、田园与日常题材；需要"手绘动画电影"温润质感的作品。
- **不适用**：写实犯罪 / 纪实（改用 `cinematic-live-action`）；科幻硬表面机械（改用 `pixar-3d` / `comic-halftone`）；需要水墨留白的东方古典题材（改用 `ink-wash-oriental`）。

## 2. 视觉 DNA

| 层 | 规则 |
|---|---|
| 渲染风格 | 手绘赛璐璐动画：平涂色块 + 手绘勾线；背景是水彩 / 水粉美术，天光与云层层次丰富 |
| 角色造型 | 圆润柔和的体型与五官，线条轻松有手绘抖动；不做写实解剖，也不做美式夸张透视 |
| 比例语言 | 约 5–6 头身，儿童角色更短；体态自然朴素，不刻意 Q 版化 |
| 发丝 / 毛发 | 整块色块 + 手绘发丝分组，高光用一条或几条弧形亮带；毛躁碎发用短线点缀 |
| 皮肤 / 材质 | 平涂肤色 + 单层柔和阴影；不做 SSS 渲染，不做高光塑料感 |
| 表演风格 | 细腻生活化的表演，强调小动作、停顿与呼吸；夸张只用于喜剧节拍且克制 |
| 动态风格 | 自然流畅的作画节奏，风吹草木、云影移动、衣摆与发丝随动是标志性动态母题 |
| 情绪尺度 | 温和克制；高情绪靠静默、背影与自然环境的呼应表达，不做戏剧性面部变形 |

## 3. 负向风格约束

不要 3D render、不要 CG 塑料感、不要写实摄影、不要厚涂油画、不要美式漫画粗黑轮廓与网点、不要霓虹高饱和。

## 4. 风格锁后缀（追加到每次生成的 prompt 尾部）

**分两段用**——A 段所有产物通用，B 段**只有角色卡与视频片段**才带（见第 5 段）：

```text
[锁 A · 渲染与材质 —— 所有产物通用]
STYLE LOCK-A — hand-drawn 2D cel animation in the classic Japanese animated feature tradition, clean hand-inked linework with slight organic waver, flat cel colour fills with a single soft shadow layer, painterly watercolour and gouache background art with layered skies and cloud banks, lush hand-painted foliage, gentle warm sunlight and soft ambient bounce. NOT 3D render, NOT CG plastic look, NOT photorealistic photography, NOT thick impasto oil paint, NOT American comic bold outlines or halftone dots, NOT neon oversaturation.
```

```text
[锁 B · 表演与动态 —— 仅角色卡与视频片段追加；场景卡 / 道具卡不要带]
STYLE LOCK-B — rounded soft body shapes with relaxed hand-drawn contours, naturalistic understated acting with small pauses and breathing, wind-driven environmental motion in leaves cloth and hair. NOT stiff anatomy.
```

## 5. 分层适配

- **角色卡**：双版本（单视图正面全身 + 三视图横排；视频引用版本由 STEP 0 用户选择：`fast` 只能单视图，`balanced`·`quality` 可选单视图或三视图）+ **锁 A + 锁 B**。色指定（发色 / 服装色）写进节点描述。
- **场景卡**：本风格的核心竞争力所在——环境卡可以画得比角色更细，但仍要**单视图**、零文字、无人物，且**只加锁 A**。⚠️ **不要带锁 B**——表演语言会把人物拉进画面（实测发现，见 `pixar-3d.md` 第 5 段）。
- **道具卡**：单件道具单视图 + **只加锁 A**。
- **视频片段（r2v / i2v）**：**锁 A + 锁 B**，追加在 H3 结构化 prompt **之后**。风景 / 运镜镜（云、风、光）是本风格的强项，可多排。
- **铅笔分镜图**：**不套本风格锁**（始终纯黑白线稿）。

## 6. 与参考图契约的关系

本风格**不改变**形态规则（角色卡固定双版本（单视图 + 三视图）；视频引用版本由 STEP 0 用户选择，`fast` 只能单视图）与「零文字 / 不拼图」硬规则；`fast` 档仍受 G-ref 门禁约束（见 [reference-image-contract.md](../reference-image-contract.md)）。

## 7. 已知风险与未实测项

- **风险**：2D 手绘风格下，视频模型可能悄悄"立体化"（出现 CG 体积感），负向里已写明但**未做定量验证**。
- **风险**：平涂风格下角色换角度容易走形（缺少体积信息），转身类镜头建议保守规划。
- **未实测**：本后缀对运动质感的影响；与续接链叠加的表现。

## 8. 实测状态

| 日期 | 档位 | 抽卡结论 | 备注 |
|---|---|---|---|
| 2026-10-08 | balanced | ✅ **场景卡 + 角色卡通过** | 场景卡：手绘线稿 + 水彩天空与云层 + 绿植，吉卜力感很强。角色卡：柔线 + 平涂，单视图白底全身 |
