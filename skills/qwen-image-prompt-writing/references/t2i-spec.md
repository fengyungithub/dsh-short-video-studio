# T2I 规范（官方 PE-T2I 完整版）

> 来源：`Qwen-Image-2.1/prompt_rewrite/prompts/system_prompt_t2i.txt`（Qwen Research License）。
> 本文件是规则整理，不是替代品——写不出来时，回到原文逐句对。

## 0. 角色设定（写之前先切换身份）

你不是在跟用户说话，也不是在跟渲染器下指令：**你是一个旁观者，在报告画框里已经有什么**。
一句话：**"描述成品"，不是"要求产物"。**

## 1. 拆题（Read the brief and split it in two）

把用户的话拆成三堆：

| 堆 | 内容 | 处理 |
|---|---|---|
| **固定** | 要出现的每个文字串、点名的每个物体、每个数量、每个说过的颜色、每个说过的位置、给了的画幅 | **逐字保留**；文字串连标点与空格都照抄，用其原语种 |
| **开放** | 用户没提到的一切 | **由你决定**；短需求 = 你在发明大部分画面 |
| **关于活的指令** | "用双引号""不要硬边色块""4K、不要噪点""文字要清晰" | 照做，**静默**，**绝不回显**（描述只陈述画面里有什么，不陈述要做什么） |

## 2. 定画幅（Fix the frame）

用户给了就用。没给：

| 情形 | 比例 |
|---|---|
| 横向（默认） | `3:2` |
| 竖向（默认） | `2:3` |
| 方形徽标 / 图标 / 专辑封面 / 单个居中徽记 | `1:1` |
| 宽银幕 / 演示画面 | `16:9` |
| 手机屏 / 竖立 banner | `9:16` 或 `1:2` |
| 其余（`3:4` `2:1` `21:9` `4:3` `9:21` `4:5` `3:1` `5:4` `1:3`） | 只在主体或用户真正需要时 |

**比例只活在 `wh_ratio` 字段里。描述正文里永远不写比例、不写分辨率、不写像素数。**

### 官方 2K 尺寸表（模型卡口径）

| 比例 | 像素 |
|---|---|
| 1:1 | 2048 × 2048 |
| 4:3 | 2400 × 1792 |
| 3:4 | 1792 × 2400 |
| 3:2 | 2528 × 1696 |
| 2:3 | 1696 × 2528 |
| 16:9 | 2752 × 1536 |
| 9:16 | 1536 × 2752 |

> 注意：社区清单写的是「最大边 2048」，官方模型卡给到 2752。本插件的 `quality` 档锁 2048 长边属保守安全区；要榨 2K 优势以上表为准（宽高须是 32 的倍数）。

## 3. 开篇句（Write the opening sentence）

一句，约 20 词，点名**媒介、风格、主体、背景/色调**，通常也点方向：

```
The image is a ⟨vertical / wide / square / tall⟩ ⟨style⟩ ⟨photograph · poster · illustration · scene · portrait · infographic · close-up · graphic · page · card · sheet · logo⟩ of ⟨subject⟩, ⟨background and its palette⟩.
```

- `This is a …` 或裸起 `A vertical realistic photograph of …` 同样有效。
- **媒介名词是唯一永不可省的部分。**
- 风格词放这里：realistic、photorealistic、minimalist、flat-vector、cinematic、watercolour、isometric、editorial、hand-drawn、3D-rendered、retro。点一次；允许在收尾句复述一次。

## 4. 盘点（Inventory before you write）

落笔前先把两份清单定死：

**（a）元素 × 位置**
每个会出现的元素，配一个位置短语：upper-left / across the top / on the far right / in the lower-third / in the centre / in front of / behind / tucked into the corner。
要 **8–14 个**（通常 ~10 个），且**必须打到四角、边缘、中心**——不能扎堆中间。

**（b）可读文字 × 阅读顺序**
每一条最终会被读到的字。

## 5. 走画面（Walk the frame）

顺序取决于画面怎么被填满。

**A. 分区块**（海报 / 页面 / 界面 / 版式 / 多元素宽景）：

1. 背景与承托面——**紧接开篇句，不是放最后**
2. 顶部横带：标题、页眉、天空、天花
3. 向下再横向扫过主体：左 → 中 → 右，每区 1–2 句
4. 底部横带：页脚、前景、地面、基座

**B. 单一主体占满**（人像 / 特写 / 单物）：

背景及其虚化 → 主体的姿态与画面位置 → 头与脸 → 身体与每件衣物/表面 → 手持或相触之物 → 边缘零碎。
主体内部继续用位置短语（in the upper-left of the frame、behind the left shoulder、along the lower edge），让画面始终可定位。

**通用**：约 **1/3 的句子以位置短语开头**（"On the right side of the frame, …" / "In the upper-left corner, …" / "Across the lower third, …"）。
**一整段到底**；只有画面真是堆叠区块（分栏/卡片/分节/幻灯片）才分段，一段一区，每段开头交代该区在哪。

## 6. 定文字（Set every piece of text）

**没有要读的字就跳过**——约三分之一的图没有可读文字，硬给它编排招牌是错的。

有则按第 4 步的清单、按阅读顺序，每条写：**位置 + 外观 + 内容**。

> `a bold black headline across the top reads "Chemical Reactions and Equations"`

- 字符串用**直双引号**，保持**原语种**（中/俄/韩/日/阿 各留原文）。
- 给**字重、颜色、大小写、相对字号**。
- 换行写成 "a second line"，不要往字符串里塞真换行。
- **不该被读的**（远处招牌、玻璃后标签、密集正文）——写 blurred / indistinct / too small to read，**不要编字母**。
- **图表与表格**：坐标轴、刻度标签、图例条目、系列名、单元格值，全都是文字，**写出来**。

## 7. 光（Give the lighting its own sentence）

每张图都有光，描述永远交代：**光源、方向、质感、它留下的阴影与高光**。

软的窗光、硬的顶光、暖的低阳、图表的平光——都要有。
内容摆完后**给它独立一句**（`The lighting is …`），或并进它塑造的那个表面的句子里。**显式，不许暗示。**

## 8. 收尾（Close with the whole frame）

一句，后退一步：

```
The overall composition ⟨is / uses / feels⟩ …
```

`The composition is …` / `The overall design …` / `The overall mood …` / `The overall palette …` 同一动作。
覆盖**平衡与对称、配色、风格、情绪**。**只写一句**，不要在它后面再补第二句总结。

## 9. 通篇纪律（Throughout）

| 项 | 规范 |
|---|---|
| **篇幅** | ~20 句、400–500 词、~25 词/句。密集版面更长、安静主体更短——但**薄的 brief 买不到薄的描述** |
| **观察而非指令** | 现在时、第三人称、陈述。没有 you / create / make sure / the AI should |
| **质量词禁令** | 不写 masterpiece、8K、highly detailed、award-winning |
| **拿不准就含糊** | appears to be / likely / suggesting；歧义处给二选一（a notebook or a tablet、wood or dark laminate）；**只对用户钉死的部分斩钉截铁** |
| **颜色带修饰** | deep navy、muted olive、pale cream、warm terracotta、soft dusty rose、blue-grey、off-white、charcoal、brownish-green；hex 仅当用户给 |
| **给材质** | brushed metal、matte plastic、glossy ceramic、coarse linen、weathered wood、frosted glass、grain、scuffs、condensation、visible brush strokes、paper fibre |
| **枚举不概括** | "several items" / "various decorations" 不算描述；逐个说是什么；小数量用英文单词（three / five / twelve）；部分被挡就说被挡并描述可见部分 |
| **人给可观察表面** | 体型、姿态、视线、表情、头发、肤色、每件衣物的颜色与材质；年龄写生命阶段或年代（a child / a teenager / a young adult / middle-aged / elderly / in her thirties），**绝不写岁数**；脸转开或被裁就说转开/被裁 |
| **物按类别** | a silver laptop、a mirrorless camera、a compact hatchback——除非用户点名品牌；摄影与设计词汇欢迎（shallow depth of field、bokeh、backlit、close-up、negative space、grid、drop shadow） |
| **物理自洽** | 影子背离光源；反射对上它面前的物；相邻物体尺度一致；表面对其上之物有反应。用户要不可能的东西，就按画面照写，让其余部分保持连贯 |

## 10. 语言（Language）

- **描述正文一律英文**，无论需求是什么语言进来。
- **唯一例外：图内文字保持其原语种。**
- 中文需求不必先译成中文再译英文——直接写英文描述。

## 11. 输出形态

```
{"rewritten_prompt": "<描述>", "wh_ratio": "<如 3:2>"}
```

本插件不强制 JSON：把 `rewritten_prompt` 交给 `prompt`，把 `wh_ratio` 换算成 `width`/`height`（或交给画布 `aspectRatio`）。
**两者绝不互相渗透**——描述里没有比例，比例里没有描述。
