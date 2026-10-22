# 欧美漫画半调（`comic-halftone`）

## 1. 适用与不适用

- **适用**：超英、暗黑奇幻、西部、漫改、动作与复仇题材；需要强张力与"漫画感"的作品。
- **不适用**：治愈日常与幼态题材（改用 `pixar-3d` / `ghibli-2d`）；需要细腻写实光比的题材（改用 `cinematic-live-action`）。

## 2. 视觉 DNA

| 层 | 规则 |
|---|---|
| 渲染风格 | 欧美漫画：粗黑轮廓线 + 半调网点（halftone）阴影；旧纸 / 印刷噪点肌理；夸张戏剧化透视 |
| 角色造型 | 强调体块与力量感的英雄式解剖：宽肩、窄腰、方下巴；阴影直接塑形，不靠渐变过渡 |
| 比例语言 | 约 7–8 头身、偏英雄化；反派与巨物可进一步夸张比例做压迫感 |
| 发丝 / 毛发 | 发块用实心黑 + 白色高光带切分；发梢硬朗，偶用飞白笔触 |
| 皮肤 / 材质 | 以网点密度表现明暗层次，不用柔和高光；皮革、金属、布料靠硬边阴影区分 |
| 表演风格 | 张力外放：大幅度的肢体语言、咬牙、怒目、拳头紧握；情绪靠姿态与阴影而非微表情 |
| 动态风格 | 强动态线 + 速度线 + 冲击波；关键姿态定格，动作用夸张透视（仰拍 / 俯冲）强化 |
| 情绪尺度 | 高对比高张力；允许面部戏剧化变形与"漫画式"夸张，但轮廓必须清晰可读 |

## 3. 负向风格约束

不要柔和高饱和粉彩、不要写实摄影、不要 3D render、不要日系大眼睛萌系比例、不要水彩晕染、不要扁平极简。

## 4. 风格锁后缀（追加到每次生成的 prompt 尾部）

**分两段用**——A 段所有产物通用，B 段**只有角色卡与视频片段**才带（见第 5 段）：

```text
[锁 A · 渲染与材质 —— 所有产物通用]
STYLE LOCK-A — American comic book illustration, bold black ink outlines, halftone dot shading for all midtones and shadows, aged newsprint paper texture with subtle registration noise, dramatic exaggerated perspective. NOT soft pastel high-key palette, NOT photorealistic photography, NOT 3D render, NOT watercolour bleed, NOT flat minimal illustration.
```

```text
[锁 B · 表演与动态 —— 仅角色卡与视频片段追加；场景卡 / 道具卡不要带]
STYLE LOCK-B — heroic blocky anatomy with squared jaw and emphasised mass, solid black hair masses with hard white highlight bands, dynamic speed lines and impact effects, high-tension posing and clenched-fist body language. NOT big-eyed moe anime proportions.
```

## 5. 分层适配

- **角色卡**：双版本（单视图正面全身 + 三视图横排；视频引用版本由 STEP 0 用户选择：`fast` 只能单视图，`balanced`·`quality` 可选单视图或三视图）+ **锁 A + 锁 B**。**阴影方案（光源方向 + 网点密度）写进节点描述**，跨镜复用同一套。
- **场景卡**：只画环境 + **只加锁 A**；城市 / 废墟 / 西部小镇是本风格强项，透视可夸张。⚠️ **不要带锁 B**——`heroic blocky anatomy` / `high-tension posing` 会把人物拉进画面（**实测已复现**：本风格的场景卡里出现了一个肌肉男，违反"场景卡只展示环境"）。
- **道具卡**：单件道具单视图 + **只加锁 A**；金属与皮革靠硬边高光区分。
- **视频片段（r2v / i2v）**：**锁 A + 锁 B**，追加在 H3 结构化 prompt **之后**。动作镜可用荷兰角与冲击线；注意半调网点在运动中容易产生摩尔纹，**未实测**，必要时降低网点密度。
- **铅笔分镜图**：**不套本风格锁**（始终纯黑白线稿）。

## 6. 与参考图契约的关系

本风格**不改变**形态规则（角色卡固定双版本（单视图 + 三视图）；视频引用版本由 STEP 0 用户选择，`fast` 只能单视图）与「零文字 / 不拼图」硬规则；`fast` 档仍受 G-ref 门禁约束（见 [reference-image-contract.md](../reference-image-contract.md)）。

## 7. 已知风险与未实测项

- **风险**：半调网点在逐帧视频里可能产生摩尔纹 / 闪烁，**需实测确认**。
- **风险**：粗黑轮廓 + 高对比在低分辨率档位下容易糊成一团，建议 `balanced` 以上。
- **未实测**：本后缀与动作镜运镜的配合；与续接链叠加的表现。

## 8. 实测状态

| 日期 | 档位 | 抽卡结论 | 备注 |
|---|---|---|---|
| 2026-10-08 | balanced | ⚠️ **场景卡不通过**（角色卡未单独抽卡） | 场景卡风格本身准确（粗轮廓 + 网点 + 夸张透视），但画面里**出现了一个肌肉男**——违反"场景卡只展示环境"。**已修**：后缀拆为 A（渲染/材质，通用）+ B（表演/动态，仅角色卡与视频），场景卡只加 A。**修复后未复测** |
| 2026-10-08 | balanced | ✅ **复测通过** | 与原失败轮相同的基础提示词重跑：粗黑轮廓 + 旧纸质感 + 雨中街景，**零人物零文字** ⇒ 「场景卡只加锁 A」确认有效。同轮补建 2:3 竖版角色卡（`896×1344`）：合规、风格保真良好（英雄式体块 + 硬边高光）。**视频层未测**（网点摩尔纹风险仍未验证） |
