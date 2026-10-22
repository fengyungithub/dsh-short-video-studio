# 电影真人写实（`cinematic-live-action`）

## 1. 适用与不适用

- **适用**：现代剧情、悬疑、犯罪、都市情感、纪实感品牌故事；需要"像真拍的"质感的题材。
- **不适用**：童话 / 合家欢 / 幼态角色（改用 `pixar-3d`）；需要手绘或留白审美的题材（改用 `ghibli-2d` / `ink-wash-oriental`）。
- ⚠️ **本风格是全 7 套里角色一致性压力最大的一套**：写实人脸的跨镜漂移最容易被看出来。角色卡必须严格零文字（视频引用版本由 STEP 0 用户选择：`fast` 只能单视图，其余档可选单视图或三视图），且**成片建议直接走 `quality`**。

## 2. 视觉 DNA

| 层 | 规则 |
|---|---|
| 渲染风格 | 照片级写实数字摄影，真实光比与自然光衰减；35mm / 变形镜头质感，轻微胶片颗粒，电影色彩分级（青橙倾向） |
| 角色造型 | 真实人体解剖与年龄感，不做夸张概括；体型、骨相、肤质按角色设定如实还原 |
| 比例语言 | 写实头身比（约 7–7.5 头身）；不做 Q 版压缩 |
| 发丝 / 毛发 | 单根发丝与真实毛发质感，自然蓬乱与逆光轮廓光；发际线与发缝真实 |
| 皮肤 / 材质 | 真实皮肤纹理：毛孔、细纹、雀斑、汗光、油脂高光；避免磨皮塑料感与过度美颜 |
| 表演风格 | 克制写实的表演，依赖眼神、微表情与呼吸；不做弹性夸张与卡通式形变 |
| 动态风格 | 真实惯性与重量感，动作有起止过渡；手持轻微晃动与真实对焦呼吸 |
| 情绪尺度 | 内敛为主；强情绪靠压迫性沉默、面部细微颤抖与呼吸节奏表达，不靠夸张变形 |

## 3. 负向风格约束

不要卡通、不要 3D 渲染、不要插画、不要动漫、不要夸张形变、不要塑料磨皮、不要游戏 CG 感。

## 4. 风格锁后缀（追加到每次生成的 prompt 尾部）

**分两段用**——A 段所有产物通用，B 段**只有角色卡与视频片段**才带（见第 5 段）：

```text
[锁 A · 渲染基调 —— 所有产物通用；无角色词、也无场景物件词]
STYLE LOCK-A — photorealistic live-action cinematography, 35mm anamorphic lens character, natural volumetric lighting with realistic falloff, cinematic teal-orange colour grade, subtle film grain. NOT cartoon, NOT 3D render, NOT illustration, NOT video-game CG look.
```

```text
[锁 B · 角色与表演 —— 仅角色卡与视频片段追加；场景卡 / 道具卡不要带]
STYLE LOCK-B — real human anatomy and age-appropriate facial structure, true-to-life surface texture with pores fine lines and specular highlights, individual hair strands with natural rim light, restrained naturalistic performance driven by micro-expression and breathing, real weight and inertia in motion. NOT exaggerated deformation, NOT plastic airbrushed skin.
```

## 5. 分层适配

- **角色卡**：双版本（单视图正面全身 + 三视图横排；视频引用版本由 STEP 0 用户选择：`fast` 只能单视图，`balanced`·`quality` 可选单视图或三视图）+ **锁 A + 锁 B**。**背景务必素净**（真人写实下背景杂物极易被误读为画面内容）。
- **场景卡**：只画环境 + **只加锁 A**；写实场景尤其要写清光源方向与色温。⚠️ **不要带锁 B**——表演 / 解剖语言会把人物拉进画面（实测发现，见 `pixar-3d.md` 第 5 段）。
- **道具卡**：单件道具单视图 + **只加锁 A**；材质描述要具体（金属拉丝 / 磨砂塑料 / 做旧皮革）。
- **视频片段（r2v / i2v）**：**锁 A + 锁 B**，追加在 H3 结构化 prompt **之后**。**对白镜建议 `quality` 档**：写实人脸的嘴型偏差最显眼。
- **铅笔分镜图**：**不套本风格锁**（始终纯黑白线稿）。

## 6. 与参考图契约的关系

本风格**不改变**形态规则（角色卡固定双版本（单视图 + 三视图）；视频引用版本由 STEP 0 用户选择，`fast` 只能单视图），反而更敏感：写实参考图上的任何文字 / 水印 / 分隔线都会以更高保真度烙进成片，多视图卡也只在该档实测干净的档位使用。`fast` 档的 G-ref 门禁在本风格下**尤其不要绕过**（见 [reference-image-contract.md](../reference-image-contract.md)）。

## 7. 已知风险与未实测项

- **一致性**：写实人物的跨镜身份漂移风险显著高于风格化风格，角色卡 seed 复用与 `ref_nodes` 绑定要严格执行。
- **口型**：写实人脸的嘴型错误最容易被察觉，建议对白镜走 `quality`。
- **未实测**：本后缀在 `fast` 档的表现；写实 + 续接链的接缝观感；写实风格下 7 套通用的负向是否够用。

## 8. 实测状态

| 日期 | 档位 | 抽卡结论 | 备注 |
|---|---|---|---|
| 2026-10-08 | balanced | ✅ **场景卡 + 角色卡通过** | 场景卡：照片级夜巷、湿地面反光、青橙分级，风格精准。角色卡：单视图白底全身，写实皮肤与服装质感到位。**遗留**：文字提示写 30 岁但出图偏中老年——属文生图模型年龄漂移，与风格锁无关 |
