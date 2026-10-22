# 水墨东方古风（`ink-wash-oriental`）

## 1. 适用与不适用

- **适用**：古装、仙侠、武侠、历史、神话、东方美学题材；需要留白与意境的抒情段落。
- **不适用**：现代都市、科幻、写实纪实（改用 `cinematic-live-action`）；需要高饱和与强动态的题材（改用 `comic-halftone` / `pixar-3d`）。

## 2. 视觉 DNA

| 层 | 规则 |
|---|---|
| 渲染风格 | 中国工笔线描 + 淡彩水墨晕染；宣纸肌理，近实远虚，大量留白；朱砂 / 石青作点睛 |
| 角色造型 | 传统审美骨相：细长眼、舒展眉、秀挺鼻；衣纹用流畅白描勾线，宽袍大袖的体块感优先于肌肉 |
| 比例语言 | 约 7–7.5 头身的写意人体；姿态重于解剖精度，讲究"气韵"与身段 |
| 发丝 / 毛发 | 成组墨色发片 + 细笔发丝，发梢渐淡；可带一两笔飞白 |
| 皮肤 / 材质 | 极淡肤色渲染，几乎不施阴影；衣料以淡彩分层罩染，避免高光与塑料感 |
| 表演风格 | 含蓄克制、以静制动；靠眼神、衣袖与身段的弧线表达情绪 |
| 动态风格 | 飘逸连贯：衣带、长袖、发丝与雾气随动；打斗用写意笔触与轨迹线概括 |
| 情绪尺度 | 含蓄内敛；强情绪靠墨色浓淡、留白与构图张力，不做面部夸张变形 |

## 3. 负向风格约束

不要西方绘画、不要写实摄影、不要 3D render、不要霓虹高饱和、不要厚涂油画、不要美式漫画粗黑轮廓与网点、**不要书法题款 / 竖排文字 / 印章落款 / 任何画面内文字（水墨风会本能地补题款，实测在视频层必现且多为乱码）**。

## 4. 风格锁后缀（追加到每次生成的 prompt 尾部）

**分两段用**——A 段所有产物通用，B 段**只有角色卡与视频片段**才带（见第 5 段）：

```text
[锁 A · 渲染与材质 —— 所有产物通用]
STYLE LOCK-A — Chinese traditional ink-wash and gongbi fine-line painting, xuan paper texture, delicate brush outlines, mineral-pigment washes in restrained indigo and vermillion accents, extensive negative space, near-solid-far-faded depth, visible brushstroke and ink bleed, misty atmospheric layers. NOT western painting, NOT photorealistic photography, NOT 3D render, NOT neon oversaturation, NOT thick impasto oil paint, NOT American comic bold outlines or halftone, **NOT calligraphy text, NOT vertical inscribed characters, NOT seal stamps, NOT any writing, lettering or characters anywhere in the image**.
```

```text
[锁 B · 表演与动态 —— 仅角色卡与视频片段追加；场景卡 / 道具卡不要带]
STYLE LOCK-B — traditional aesthetic bone structure with elongated eyes and flowing dark ink-outline drapery, elegant and contemplative posture language, drifting sleeves ribbons and hair in the wind, ink-toned tonal shifts for emotional weight.
```

## 5. 分层适配

- **角色卡**：双版本（单视图正面全身 + 三视图横排；视频引用版本由 STEP 0 用户选择：`fast` 只能单视图，`balanced`·`quality` 可选单视图或三视图）+ **锁 A + 锁 B**。**背景务必留白 / 素色**——宣纸肌理容易被背景杂物干扰。
- **场景卡**：本风格强项。山水 / 庭院 / 室内都要写明"近实远虚"的层次与留白位置；**只加锁 A**。⚠️ **不要带锁 B**——`posture language` / `flowing drapery` 会把人物拉进画面（**实测已复现**：本风格的场景卡里出现了一个白衣女子，违反"场景卡只展示环境"）。
- **道具卡**：单件道具单视图 + **只加锁 A**；器物（剑、扇、瓷、灯）用白描勾线。
- **视频片段（r2v / i2v）**：**锁 A + 锁 B**，追加在 H3 结构化 prompt **之后**。运镜宜缓（摇、移、升），避免快速手持。
- **铅笔分镜图**：**不套本风格锁**（始终纯黑白线稿）——本风格的线描气质与铅笔稿天然接近，注意别把晕染带进分镜。

## 6. 与参考图契约的关系

本风格**不改变**形态规则（角色卡固定双版本（单视图 + 三视图）；视频引用版本由 STEP 0 用户选择，`fast` 只能单视图）与「零文字 / 不拼图」硬规则；`fast` 档仍受 G-ref 门禁约束（见 [reference-image-contract.md](../reference-image-contract.md)）。

## 7. 已知风险与未实测项

- **风险**：留白在视频里容易被模型"补内容"（填上多余的山水 / 云 / 建筑），负向里未强制留白，**需实测确认**。
- **风险**：大面积淡彩 + 低对比，字幕与口型的可读性可能下降。
- **未实测**：本后缀对动态笔触的影响；与续接链叠加的表现。
- ✅ **已实测并修复（视频层，2026-10-08）**：**水墨风会在画面里自发添加竖排书法题款**——`fast` 档 5s 镜头实测左缘出现一整列乱码汉字，直接违反「图内零文字」硬规则。**已修**：锁 A 与 §3 负向都补了 `NOT calligraphy text / NOT vertical inscribed characters / NOT seal stamps / NOT any writing`。**修复后未复测**。
- ⚠️ **视频层风格保真偏弱**：同一镜头里成片偏**写实柔光**而非工笔淡墨（与角色卡同病），风格辨识度是 7 套里最弱的。

## 8. 实测状态

| 日期 | 档位 | 抽卡结论 | 备注 |
|---|---|---|---|
| 2026-10-08 | balanced | ⚠️ **场景卡不通过**（角色卡未单独抽卡） | 场景卡风格本身准确（淡墨 + 宣纸 + 留白），但画面里**出现了一个白衣女子**——违反"场景卡只展示环境"。**已修**：后缀拆为 A（渲染/材质，通用）+ B（表演/动态，仅角色卡与视频），场景卡只加 A。**修复后未复测** |
| 2026-10-08 | balanced | ✅ **复测通过** | 与原失败轮相同的基础提示词重跑：宣纸淡墨 + 灯笼 + 传统窗格，**零人物零文字** ⇒ 「场景卡只加锁 A」确认有效。同轮补建 2:3 竖版角色卡（`896×1344`）：合规（单主体/零文字/空背景），但**风格保真偏弱**——偏写实柔光而非工笔淡墨。**已修一处措辞**：锁 B 的 `flowing white-outline drapery` 会产生**剪纸式白边**（水墨衣纹应是**墨线**），已改为 `flowing dark ink-outline drapery`，**待复测**。视频层未测 |
