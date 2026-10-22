# 皮克斯感 3D 卡通（`pixar-3d`）

> **默认风格。本文件同时是其余 5 套风格文件的格式范例**——每套都必须给全这 8 段，尤其第 4 段的「风格锁后缀」（可直接复制的英文串）。

## 1. 适用与不适用

- **适用**：合家欢、童话、成长故事、纪念短片、品牌故事；需要亲和力与高辨识度角色设计的题材。
- **不适用**：写实犯罪 / 悬疑 / 纪实（改用 `cinematic-live-action`）；需要手绘笔触或东方留白的题材（改用 `ghibli-2d` / `ink-wash-oriental`）。

## 2. 视觉 DNA

| 层 | 规则 |
|---|---|
| 渲染风格 | 皮克斯感 3D 卡通渲染，C4D + Octane 渲染器质感，高级动画电影质量 |
| 角色造型 | 夸张几何概括与极佳材质质感的平衡。不追求 100% 真人解剖结构，用高概括度几何形体、强剪影、高辨识度设计 |
| 比例语言 | 亲和的风格化比例；可爱 / 幼态角色用 2.5–3 头身 Q 版比例，大头小身、体块清晰、轮廓易读 |
| 发丝 / 毛发 | 整体有清晰块面结构，边缘保留精细发丝或绒毛细节；光照下既硬朗有形又有细腻触感 |
| 皮肤 / 材质 | 温润次表面散射（SSS）质感，耳朵 / 脸颊 / 鼻尖 / 指尖可有微红透光；避免生硬塑料感 |
| 表演风格 | 夸张灵动的迪士尼 / 皮克斯式表演，运用挤压与伸展，强化眉毛、眼角、瞳孔、嘴唇、脸颊形变 |
| 动态风格 | 高能量态势、清晰动作线、前倾势能、强预备动作、快速但可读的节奏、弹性身体机制、丰富微表情 |
| 情绪尺度 | 在可爱与爆发力之间平衡；强情绪允许戏剧性面部变形，但必须保留角色魅力 |

## 3. 负向风格约束

不要写实真人摄影、不要扁平二次元、不要塑料玩具皮肤、不要僵硬人体姿势、不要真实解剖僵硬感、不要无生命表情。

## 4. 风格锁后缀（追加到每次生成的 prompt 尾部）

**分两段用**——A 段所有产物通用，B 段**只有角色卡与视频片段**才带（见第 5 段）：

```text
[锁 A · 渲染基调 —— 所有产物通用；无角色词、也无场景物件词]
STYLE LOCK-A — stylized 3D animated feature render, Pixar-like art direction, C4D + Octane look, high-end animation film quality, clear geometric volume and strong readable silhouette. NOT live-action photography, NOT flat 2D anime, NOT plastic toy skin.
```

```text
[锁 B · 角色与表演 —— 仅角色卡与视频片段追加；场景卡 / 道具卡不要带]
STYLE LOCK-B — appealing stylized proportions, crisp silhouette shapes with fine strand and fuzz detail in hair, warm subsurface scattering skin with subtle translucency at ears, cheeks, nose tip and fingertips, expressive exaggerated performance with squash and stretch, high-energy posing, clean action lines, believable elastic body mechanics. NOT stiff human anatomy, NOT lifeless expression.
```

## 5. 分层适配

- **角色卡**：双版本（单视图正面全身 + 三视图横排；视频引用版本由 STEP 0 用户选择：`fast` 只能单视图，`balanced`·`quality` 可选单视图或三视图）+ **锁 A + 锁 B**。Q 版比例写进**角色卡节点描述**，不画进图内文字。
- **场景卡**：只画环境 + **只加锁 A**。⚠️ 场景卡**不要带锁 B**——B 段里的表演 / 解剖语言会把人物拉进画面（实测：`anime-cel` / `ink-wash-oriental` / `comic-halftone` 的场景卡就是因为后缀里的表演条款而出现了人物，违反"场景卡只展示环境"）。
- **道具卡**：单件道具单视图 + **只加锁 A**。
- **视频片段（r2v / i2v）**：**锁 A + 锁 B**，追加在 H3 结构化 prompt **之后**（风格锁与负向由片型侧拼接，不归 `h3-prompt-writing`）。
- **铅笔分镜图**：**不套本风格锁**（始终纯黑白线稿）。

## 6. 与参考图契约的关系

本风格**不改变**形态规则（角色卡固定双版本（单视图 + 三视图）；视频引用版本由 STEP 0 用户选择，`fast` 只能单视图）与「零文字 / 不拼图」硬规则；`fast` 档仍受 G-ref 门禁约束（见 [reference-image-contract.md](../reference-image-contract.md)）。

## 7. 已知风险与未实测项

- 高概括度造型 + 强剪影对跨镜一致性有利，是 7 套里跨镜漂移风险最低的一套（**方向性判断，未做定量对照**）。
- **未实测**：后缀长度是否影响口型与字幕渲染；在非默认实现上的表现。

## 8. 实测状态

| 日期 | 档位 | 抽卡结论 | 备注 |
|---|---|---|---|
| 2026-10-08 | — | **未单独抽卡** | 本文件是**现有全局风格锁的等价移植**（原文照搬 + 新增英文后缀串），有效性依据为旧流程的成片经验。同日按其它 5 套的抽卡发现，把后缀拆成 **A 渲染/材质 + B 表演/动态** 两段（场景卡 / 道具卡只加 A） |
