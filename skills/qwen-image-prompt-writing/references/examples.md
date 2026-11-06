# 弱 → 强对照

每段"强"样本都按 `t2i-spec.md` 的八步写成，可直接拿去当尺子量自己写的。
带 ✅ 的样本是完整长度样本，同时充当 `scripts/check_prompt.mjs --self-test` 的回归用例（标记里的 `mode=` 供检查器识别）。

---

## 例 1 ✅ 促销海报（竖版 2:3，中文文字）

**需求**：「做一张咖啡店秋季促销海报，要有价格，氛围温暖」

**❌ 弱**

> 咖啡店秋季促销海报，温暖氛围，拿铁买一送一，高级感，细节丰富，8K，竖版 2:3

四处机械性违规：质量词（高级感/细节丰富/8K）、比例写进描述、没有位置、没有光照句、没有收尾。

**✅ 强**

> This is a vertical poster advertising an autumn coffee promotion, printed on warm cream paper with a matte finish and a thin deep-terracotta border. The paper surface carries a faint scattered-dust grain and a soft fibre texture that shows most clearly along the deckled left edge. Across the top, a slim horizontal band in deep terracotta holds a small letter-spaced line of off-white text that reads "AUTUMN ROAST". Below the band, centred across the upper third, a hand-lettered headline in dark espresso brown reads "秋日咖啡季", with a thin brush underline running beneath the final character. In the upper-left corner of the frame, a small circular roaster's seal is pressed into the paper in muted olive ink, its edges slightly uneven where the stamp lifted. On the left side of the middle band, a glazed ceramic cup sits on a saucer at three-quarter view, its rim catching a narrow continuous highlight. The cup's handle rises on the right of its body, and a tendril of steam curls upward and drifts toward the centre of the frame. Beside the cup, a short stack of three kraft-paper bags stands at slightly different angles, each stamped with a small circular seal in muted olive. Across the centre of the frame, a rounded banner in pale wheat carries the primary offer in bold condensed black type that reads "拿铁买一送一". Directly beneath that banner, a smaller second line in the same face reads "仅限 10 月". In the lower third, a large numeral in warm terracotta reads "29元", with a much smaller label set to its right that reads "两杯价". Tucked into the lower-left corner, three cinnamon sticks are tied with coarse linen twine, their bark surfaces rough and their broken ends showing a paler core. Tucked into the lower-right corner, a handful of dried maple leaves in dusty amber rest loosely, overlapping one another with visible veins. Along the very bottom edge, a thin rule separates a small centred line of charcoal text that reads "每日 8:00 - 20:00". Between the banner and the lower third, a generous field of clean cream paper sits open and bare, so the offer reads clearly on its own. The lighting is soft diffused daylight entering from the upper left, which lifts the saucer's rim and the near edge of the banner. That light falls away gently across the right side of the composition and leaves soft short shadows beneath the cup, the paper bags and the cinnamon sticks. The overall composition is symmetrical and calm, built on a warm cream, terracotta and espresso palette with muted olive accents and a few dusty amber notes, and the mood is inviting and seasonal rather than loud.

---

## 例 2 ✅ 角色卡·三视图（16:9，零文字）

**需求**：「一个 25 岁的女插画师角色卡，三视图」

**❌ 弱**

> 三视图，正面侧面背面，一个女插画师，25岁，全身，白色背景，高质量

问题：把「正面/侧面/背面」这种版式标注写进描述（**视频模型会把它烙进画面**）、写了岁数、带质量词、没有单格内容。

**✅ 强（mode=card）**

> This is a wide character reference sheet in a clean semi-realistic 3D-rendered style, presented on a plain neutral grey studio background. The background is smooth and uninterrupted, shading from a lighter grey along the top edge of the frame to a deeper grey at the bottom. The sheet is divided into three equal vertical panels arranged in a single row, each showing the same young adult woman at full body in a neutral A-pose. Her scale, spacing and foot placement stay identical across the three panels, so the figures read as one consistent character. In the left panel, the woman faces directly forward, her posture upright, her shoulders level and her arms relaxed slightly away from her body. She is a young adult of moderate build, with a heart-shaped face, warm mid-brown skin and dark brown eyes looking straight ahead. Her expression is calm and faintly curious, her brows relaxed and her mouth closed. Her hair is a shoulder-length mass of loose dark curls, parted slightly off centre, with two strands falling in front of her right shoulder. She wears an oversized oatmeal linen shirt with the sleeves rolled to the elbow, and the weave shows a visible slub texture across the chest. The shirt is tucked loosely into high-waisted charcoal wide-leg trousers of a matte cotton twill, which break once over the top of her shoes. On her feet, worn brown leather loafers carry a soft crease across the toe box and a dull sheen along the heel. A thin brass chain necklace sits at her collarbone, and a small round brass pin is fixed to the upper-left of her chest. In the centre panel, the same figure is shown in a three-quarter side view, so the length of the shirt falls behind her hip and the profile of her jaw and nose are visible. In the right panel, the same figure is shown from directly behind, revealing that her hair gathers into a low loose knot at the nape. That rear view also shows a single back pocket on the trousers and a faint fold running down the centre of the shirt. A soft elliptical shadow grounds each figure directly beneath the feet, and the three shadows match in size and density. The lighting is even studio light from the front left, producing flat clean illumination across each figure. The same light leaves a gentle core shadow along the right side of the body and a thin bright rim along the left arm and shoulder. The overall composition is orderly, evenly spaced and reference-sheet flat, built on a restrained oatmeal, charcoal and warm brown palette against neutral grey, and the mood is practical and neutral.

> ⚠️ 图上**一个字母都不能有**：角色名、「正面/侧面/背面」、FRONT VIEW、水印都不行。文字只进画布节点标题或资产库元数据。
> 单视图**不要照着这段再生成一次**：用 `image_crop(image_node=<三视图>, panel=0, panels=3, card_variant=single, paired_node_id=<三视图>)` 裁正面格。

---

## 例 3 场景卡（分区块走法，节选）

**需求**：「老城区面馆的厨房，早晨」

> This is a medium-width realistic photograph of a small old-city noodle shop kitchen in the early morning, shot from the doorway looking inward. The background is a wall of aged white tile with grout darkened by years of steam, and a single small window at the top of the frame lets in cool grey dawn light. Across the left side, a stainless steel prep counter runs the depth of the room, its surface scratched and dulled, holding a stack of three enamel bowls, a battered cleaver and a mound of fresh dough under a damp cloth. In the centre, a large iron wok sits on a blackened gas burner, a thin haze of steam rising and drifting toward the upper right. On the right side, a tall bamboo steamer stack rests beside a shelf of glass jars holding dark sauces and pickled vegetables, their contents clouded by the glass. In the lower third, the concrete floor is wet in patches, reflecting a soft vertical streak of light from the window. The lighting is cool grey dawn daylight from the window above, supplemented by a single warm tungsten bulb hanging off-centre to the right, so the room reads as cold blue shadows with one warm pool of light over the wok. The overall composition is lived-in and slightly cluttered, built on tile white, steel grey and warm amber, and the mood is quiet and industrious.

（真实交付要写足 20 句：补上人物的手、物件的具体材质、地面反射的细节、边缘的零碎。）

---

## 例 4 改图指令（I2I，单图）

**需求**：「把这张照片的天空换成黄昏，别动别的」

**❌ 弱**

> 把天空改成日落

问题：没说"保留什么"，模型会顺手改光、改色、改构图。

**✅ 强（mode=edit）**

> Replace only the daytime blue sky in the image with a warm dusk sky, with the color at the horizon moving from a pale gold near the roofline to a deeper amber and dusty rose higher up, and a few thin softly lit clouds stretched horizontally across the upper third. Re-light the scene to match the new sky: the building facades take on a warm low-angle glow, the shadows on the pavement lengthen toward the right, and the windows pick up a faint orange reflection. Keep everything else in the image exactly as it is, including the composition, the camera angle, the framing, the two pedestrians on the left, the parked scooter in the foreground, the signage and its lettering, the textures of the brick and asphalt, and the overall level of detail and sharpness. Only the sky and the light on the scene change, while all geometry, framing and existing content stay exactly as they are. Add only warm dusk light and the new sky.

> 注意这版的**保留条款是毯式的**（"everything else … including …"），并明确"只改天上与光"——范围写死，模型才不会顺手重画。

---

## 例 5 透明背景（RGBA，固定句柄）

**需求**：「一个贴纸用的卡通小龙」

> This is an RGBA image with transparency. A cute cartoon dragon sticker, chubby and round, standing on stubby legs with a small pair of folded wings and a curled tail, drawn in a clean flat-vector style with a thick dark outline and soft cel shading. The dragon is mint green with a pale cream belly and warm peach accents along the wing edges, and it grins with one small tooth showing. The lighting is soft even studio light from the front, leaving a gentle shadow under the belly and a thin bright highlight along the top of the head. The overall composition is centred and compact, built on mint green, cream and peach, and the mood is friendly and playful. The image has an alpha channel and the background is transparent, and the transparent area is left completely empty with a clean edge around the dragon.

句柄两句不能省：**开头** `This is an RGBA image with transparency.`，**结尾** `The image has an alpha channel and the background is transparent.`。
存 **PNG**；预览用的近似解码器会丢 alpha，不要拿它做最终解码。

---

## 反例诊断表

| 写的 | 为什么不行 | 改成 |
|---|---|---|
| `masterpiece, best quality, 8K` | 质量词，官方明令禁；挤掉真实描述 | 删掉，把省下的词用在材质与位置 |
| `16:9` / `2048×1152` / `4K` 写在描述里 | 比例归参数，不进 prompt | 走 `width`/`height` 或画布 `aspectRatio` |
| `不要模糊` / `no blur` | `cfg=1` 下负向不参与采样 | `edges are crisp and sharply defined` |
| `请生成一个…` / `make sure the text is sharp` | 指令语气，破坏旁观者视角 | 直述画面：`the text is crisp and evenly spaced` |
| 「正面/侧面/背面」写在描述里 | 版式标注会被视频模型烙进画面 | 删掉标注，用机位语言描述（faces directly forward） |
| 年龄写「25岁」 | 官方规范：只写生命阶段 | `a young adult` / `in her thirties` |
| 元素堆在中间 | 位置短语没覆盖四角/边缘 | 补到 8–14 个位置短语 |
| 全篇没有光照句 | 光必须显式 | 加一句 `The lighting is …` |
| 结尾写两句总结 | 收尾只许一句 | 合并成一句 `The overall composition …` |
| 写「各种装饰」 | 概括不是描述 | 逐个数出来 |
| 拼一张多视图参考图去喂 | 改形态也改风险 | 单张整图喂，不拼图 |
