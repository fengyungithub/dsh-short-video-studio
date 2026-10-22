# 国风仙侠 3D（`guofeng-xianxia`）

## 1. 适用与不适用

- **适用**：仙侠、修真、玄幻、古风奇幻；仙山云海、宫阙、剑修、宗门题材；需要**3D 动画电影级唯美质感**的作品（对标 3D 国漫仙侠剧集的主流观感）。
- **不适用**：写意水墨 / 留白抒情（改用 `ink-wash-oriental`）；真人实拍感仙侠剧（改用 `cinematic-live-action`）；2D 国漫 / 日式风格（改用 `anime-cel`）；合家欢与幼态题材（改用 `pixar-3d`）。
- **与 `pixar-3d` 的区别（最容易被混用的一对）**：两者都是 3D，但 `pixar-3d` 走**高概括造型 + 夸张迪士尼式表演 + 可爱与爆发力平衡**，硬套仙侠会得到「合家欢味的仙侠」；本风格走**唯美半写实骨相 + 清冷克制表演 + 飘逸身法**。

## 2. 视觉 DNA

| 层 | 规则 |
|---|---|
| 渲染风格 | 中国 3D 动画电影级渲染（PBR 离线质感）：**通透的大气**——清澈空气感、明亮的天光、**分层清晰**的云海、干净深邃的阴影；**bloom 必须克制**（只在光源处轻微溢出，不得糊成灰雾）；高动态范围、**明快而自然的色彩**（不要低饱和灰调） |
| 角色造型 | **写实真人级骨相**：真实颅骨结构与写实五官比例；东方审美的清冷 / 出尘靠**神态与造型**表达，**不靠漫画化夸张五官**。服饰为多层汉服 / 道袍 / 仙裙，真实垂坠与刺绣细节；发式与发冠考究 |
| 比例语言 | **写实真人比例**（约 **7.5–8 头身**），修长飘逸的仙侠身姿；**不做 Q 版大头身、不做漫画化比例** |
| 发丝 / 毛发 | 单根发丝 + 自然高光；长发成束飘逸、按组运动、滞空感强；发梢透光；**发际线与发丝分组写实** |
| 皮肤 / 材质 | **真人级皮肤**：可见毛孔、细纹、绒毛与自然油脂高光，次表面散射通透但**有真实肌理**（**不要瓷娃娃磨皮**）；丝绸缎面光泽、纱质半透、金属法器真实反射、玉石通透 |
| 表演风格 | **清冷克制、行止有度**；情绪靠眼神与呼吸。打斗是写意身法与剑势，**不做卡通挤压伸展** |
| 动态风格 | 飘逸流畅：衣袂、长带、发丝、灵气粒子驱动运动；御剑 / 轻功用**平滑长弧线**与长镜头；法术分「能量聚集 → 爆发」两段 |
| 情绪尺度 | 内敛；强情绪靠眼神、灵气浓度变化与环境呼应（云涌、花瓣、雨雪、光变），不做夸张面部变形 |

## 3. 负向风格约束

不要皮克斯式卡通夸张、不要 Q 版大头身、不要**瓷娃娃 / 磨皮脸、不要漫画化夸张五官**、不要塑料玩具感、不要日式赛璐璐平涂、不要西方奇幻（欧式城堡 / 精灵耳 / 龙与地下城）、不要现代元素（电线 / 汽车 / 手机 / 霓虹招牌）、不要**奶白灰雾面纱、不要过曝 bloom 糊掉细节、不要低饱和灰调**。

> ⚠️ **本风格的负向不禁写实**——「人物更贴近真人」正是本风格的目标之一（写实真人级的 **CG** 渲染）。
> 要**真人实拍**质感（实拍剧那种）请改走 `cinematic-live-action`；两者的区别是「高精度写实 CG」vs「照片级实拍」。加任何 `NOT photorealistic` 类负向都会直接和本风格的目标打架。

## 4. 风格锁后缀（追加到每次生成的 prompt 尾部）

**分三段，按产物取用**（见下表）。这是本风格**实测两轮**换来的结论：

| 产物 | 用哪几段 | 为什么 |
|---|---|---|
| 角色卡 | **A + B** | 不能带 C——C 的环境词会让纯底角色卡长出松树 / 石台 / 光束（**实测已复现**） |
| 场景卡 | **A + C** | 不能带 B——B 的服饰 / 皮肤词会让空场景冒出人物（**实测已复现**） |
| 道具卡 | **A** | B、C 都会给单件道具引入多余主体 |
| 视频片段 | **A + B + C** | 人与环境都要 |
| 铅笔分镜图 | **都不用** | 始终纯黑白线稿 |

```text
[锁 A · 渲染基调 —— 所有产物通用；无角色词、也无场景物件词]
STYLE LOCK-A — Chinese high-end 3D animated feature render, cinematic physically-based rendering with realistic material response, crystal-clear atmosphere with strong aerial clarity, luminous bright sky light, crisp separation between cloud layers, clean deep shadows, vivid yet natural colour, wide tonal range with strong contrast, only subtle controlled bloom at light sources. NOT Pixar-style cartoon exaggeration, NOT plastic toy look, NOT flat 2D cel shading, NOT western fantasy castles or elf ears, NOT modern elements such as wires cars phones or neon signage, NOT milky haze veil, NOT washed-out grey desaturation, NOT heavy bloom glare, NOT flat low-contrast grey haze.
```

```text
[锁 B · 角色与服饰 —— 角色卡 + 视频片段]
STYLE LOCK-B — photoreal human likeness on a CG character, accurate real human skull structure and facial proportions, real skin with visible pores fine lines and peach fuzz, natural eye detail, realistic 7.5-8 head proportions with a tall flowing silhouette, layered silk hanfu robes with real drapery weight satin sheen translucent gauze and fine embroidery, long hair as individual strands held in grouped locks with natural highlights, restrained poised acting, weightless wuxia swordplay and qinggong motion on smooth long arcs, sleeves ribbons and hair driving the motion. NOT porcelain doll face, NOT airbrushed smooth skin, NOT stylised doll-like features, NOT cartoon squash-and-stretch, NOT chibi proportions, NOT plastic toy skin.
```

```text
[锁 C · 环境与氛围 —— 场景卡 + 视频片段]
STYLE LOCK-C — luminous crisp cloud seas with clearly separated layers, bright sunlit sky, carved stone and lacquered timber Chinese architecture with upturned eaves, ancient pines with individually readable needles, mossy rock, plunging waterfalls with visible spray, distant peaks with aerial perspective but no grey veil, polished metal ritual implements and translucent jade.
```

## 5. 分层适配

- **角色卡**：双版本（单视图正面全身 + 三视图横排；视频引用版本由 STEP 0 用户选择：`fast` 只能单视图，`balanced`·`quality` 可选单视图或三视图）+ **锁 A + 锁 B**（**不带 C**）。服饰层次、发式、法器写进**角色卡节点描述**，不画进图内文字。
  - ⚠️ **背景用中性中灰（#8a8a8a 左右），不要纯白**。实测教训：白 / 淡色仙裙 + 纯白背景 + bloom 会三重过曝，人物轮廓糊进背景、作为参考卡不可用。
  - ⚠️ **卡片 prompt 里收住发光**：追加 `controlled highlights, minimal bloom`。
- **场景卡**：本风格的绝对强项（仙山云海、宫阙、剑冢、秘境）。**锁 A + 锁 C**、单视图、零文字、无人物。
  - ⚠️ **绝不能带锁 B**——实测即使只把 `hanfu` / `skin` 这类服饰皮肤词留在环境段里，空场景也会冒出人物。
- **道具卡**：单件道具单视图 + **只加锁 A**；法器 / 剑 / 玉佩 / 丹药炉写明材质（金属 / 玉 / 木 / 瓷）。
- **视频片段（r2v / i2v）**：**锁 A + 锁 B + 锁 C**，追加在 H3 结构化 prompt **之后**。御剑 / 轻功镜用平滑长弧线与长镜头；法术镜写「聚集 → 爆发」两段。**对白镜建议 `quality`**。
- **铅笔分镜图**：**不套任何风格锁**（始终纯黑白线稿）。

## 6. 与参考图契约的关系

本风格**不改变**形态规则（角色卡固定双版本（单视图 + 三视图）；视频引用版本由 STEP 0 用户选择，`fast` 只能单视图）与「零文字 / 不拼图」硬规则；`fast` 档仍受 G-ref 门禁约束（见 [reference-image-contract.md](../reference-image-contract.md)）。写实材质会让参考图上的文字 / 水印以**更高保真度**烙进成片，`fast` 档尤其不要绕过门禁。

## 7. 已知风险与未实测项

**已在本轮（2026-10-08 用户反馈后）处理的两项**：

- **发灰 / 雾感 / 过曝 bloom** → 锁 A 与锁 C 已收紧：天光改 `luminous bright sky light` + `crisp separation between cloud layers` + `clean deep shadows`，bloom 改 `only subtle controlled bloom at light sources`，并加负向 `NOT milky haze veil` / `NOT washed-out grey desaturation` / `NOT heavy bloom glare`；锁 C 去掉 `drifting mist layers` / `fading into haze`，改为 `luminous crisp cloud seas` / `aerial perspective but no grey veil`。
- **瓷娃娃磨皮脸** → 锁 B 从 `elegant semi-realistic oriental facial structure` + `porcelain clarity` 改为 `photoreal human likeness` + `accurate real human skull structure` + `real skin with visible pores fine lines and peach fuzz`，并加负向 `NOT porcelain doll face` / `NOT airbrushed smooth skin` / `NOT stylised doll-like features`。

**剩余风险**：

- **写实人脸 + 跨镜一致性压力上升**：写实脸的身份漂移比风格化脸更显眼。角色卡必须严格零文字（形态按视频档位）、**记录并复用 seed**，`ref_nodes` 绑定要严格执行；对白镜建议 `quality`。
- **淡色系仙裙（白 / 淡蓝）仍易过曝**：已靠「中灰底 + 收 bloom」缓解，但白裙镜仍需在 prompt 里写 `controlled highlights`。
- **飘逸长带 / 长发 / 纱质**在长镜头里容易崩形（成组运动对模型是难点）。
- **未实测**：收紧后的新锁在**视频层**的表现；御剑 / 轻功的中段形变；与 `h3-prompt-writing` 字幕写法叠加时亮背景对字幕可读性的影响（必要时给字幕镜选深色背景）。
- ⚠️ **取舍（本轮实测观察到）**：把锁 B 推到 `photoreal human likeness` 后，角色卡的服装质感也跟着走向**真人写真**（布料像实拍），「3D 动画电影 CG 感」被削弱。这是**可调旋钮**：
  - 想要**照片级真人** → 保持当前锁 B。
  - 想要**高精度 3D CG 人脸（3D 国漫那种）** → 把 `photoreal human likeness` 换成 `highly detailed realistic CG human character`，去掉 `real skin with visible pores`，改回 `physically-based subsurface skin with fine texture`，并加 `stylised-but-realistic CG facial rendering`。

## 8. 实测状态

| 日期 | 档位 | 抽卡结论 | 备注 |
|---|---|---|---|
| 2026-10-08 | balanced | ✅ **场景卡 + 角色卡通过**（第 3 轮） | **v1**（统一后缀含表演词）：场景卡 ❌ 冒出白衣女子；角色卡 ❌ 纯白底 + bloom 三重过曝、轮廓糊掉。**v2**（锁 A 去角色词 / 角色卡换中灰底 + 收发光）：场景卡 ✅ 纯仙山云海无人物；角色卡 ⚠️ 对比度修好但背景长出松树石台光束。**v3**（角色卡改 A+B、不带环境段）：✅ 纯中灰底、单人全身、服饰可读。⇒ 本风格改用**三段式**（A 渲染基调 / B 角色与表演 / C 环境与氛围），取用规则见第 4 段 |
| 2026-10-08 | balanced | ✅ **改锁后复测通过** | 用户反馈「人物更贴近真人、场景更透亮清晰」⇒ 改 DNA / 负向 / 三段锁（见第 7 段「已处理」）。复测：**场景卡** ✅ 蓝天白云、云海层次分明、色彩鲜明、建筑与松针清晰、无人物；**角色卡** ✅ 五官写实（不再是瓷娃娃）、中灰底干净、边缘分离光、单人全身。**代价见第 7 段取舍项**（服装走向真人写真）。**视频层仍未测** |
