# 怎么用：触发 skill、路由与触发词重叠

> 日期：2026-10-26 ｜ 适用：dsh-short-video-studio + 本机已安装的短剧相关 skill
> 一句话：**用「范围 + 交付物 + 上下文」说话，或直接用 `/skill-name`**。不要只发「短剧」两个字。

---

## 0. 先看结论：什么需求用哪个 skill

| 你想要 | 用这个 skill | 推荐触发方式 |
|---|---|---|
| 一句话故事 → 一条完整短片（30–180s） | `story-short-generator` | `/story-short-generator` + 故事/规格；或「把…做成 30 秒皮克斯风短片」 |
| 只写剧本：题材/人物/分集大纲/单集剧本/爽点/卡点 | `short-drama-series-writer` | `/short-drama-series-writer` + 题材/集数；或「写一部 80 集女频逆袭短剧，只要剧本」 |
| 整部短剧从剧本到成片 / 拍第 N 集 / 样片集 / 续跑 | `short-drama-series-production` | `/short-drama-series-production` + 项目；或「把这部 80 集短剧整部拍出来，先做 EP01 样片」 |
| 单条镜头（已有 prompt + 参考图/首帧） | `video-generate` | `/video-generate type=r2v tier=balanced ratio=9:16 length=124 refs=…` |
| 只写/改 H3 提示词，不执行 | `h3-prompt-writing` | `/h3-prompt-writing` + 分镜/意图 |
| 品牌/产品宣传短片 | `brand-promo-video-generator` | `/brand-promo-video-generator` + 品牌素材 |
| 单张图片（角色卡/场景图/改绘） | `image-generate` / 直接 `comfy_generate_image` | `/image-generate`（若可用）或「用 comfy_generate_image 生成…」 |

> **硬规则**：用户选「连续短剧（多集）」后，`story-short-generator` **必须立即停止**，不再问视觉风格/画幅/时长/档位/角色卡/审查等任何规格，直接加载 `short-drama-series-production` 接住；只有用户明确改口「改做单片」才继续单片流程。
>
> **单片 vs 单集**：`story-short-generator` 现在**先探测系列上下文**。如果工作区有 `series/` 或集制作包，它会直接进「委托模式」；没有才问片型。所以「拍第 3 集」在有系列上下文时，从 story 进来也能工作；但**整部/多集**建议从 production 进。

---

## 1. 触发机制：不是关键词路由

DSH 的技能选择是**模型读目录里的 `name + description` 前 500 字**，自己决定加载哪个；`trigger-words` / `whenToUse` 字段**不一定进目录**。所以：

- **最可靠**：`/skill-name` 斜杠命令，直接加载。
- **次可靠**：自然语言里同时给**范围 + 交付物 + 上下文**，例如「整部 80 集 / 第 3 集 / 只要剧本 / 到镜头表就停 / 已有分集剧本」。
- **不可靠**：只说「短剧」「分镜」「角色卡」——这些词在多个 skill 的描述里都有。

---

## 2. 触发词重叠矩阵（重点）

### 2.1 本插件三件套内部

| 用户说法 | 可能命中 | 应该用 | 怎么区分 |
|---|---|---|---|
| 「短剧」 | writer / production / story（系列分支） | 看交付物 | 只要文本 → writer；整部成片 → production；单片 → story |
| 「剧本 / 分集 / 大纲」 | writer / production | writer | 加「只要剧本，不出成片」 |
| 「拍第 N 集 / 继续拍」 | production / story | production（有系列上下文）或 story 委托模式 | 加「已有分集剧本 / 有 series 目录」 |
| 「分镜 / 镜头表」 | story / production | story（真正生成）/ production（只做集制作包） | 加「到镜头表就停」或「要逐镜成片」 |
| 「角色卡 / 三视图」 | story | story（本项目流程） | 单张图可用 image 工具，但角色一致性流程走 story |
| 「生成一条视频」 | video-generate / story | video-generate | 单个镜头 → video-generate；完整片子 → story |
| 「审核 / 门」 | production / shortdrama-review | production | 本插件门名是 G-S/G-B/G-A/G-SAMPLE/G-E/G-F 与门 1/2/3 |

### 2.2 与外部 `shortdrama-*` 家族（ai-show 那套）——**已于 2026-10-26 移除**

`~/Workspace/ai-show/skills/shortdrama-{director,character,comfyui,memory,review}` 已于 2026-10-26 **永久删除**（用户决定）。下面保留为**历史误路由排查**；若在别处重装/看到它们，按同样规则忽略。它们**不是本插件的一部分**，而且是**另一套技术栈**（LTX-2 / shotlist.json / G1–G7 / 自己的 `production-state.json`）：

| 外部 skill | 它做什么 | 与本插件谁重叠 | 混用风险 |
|---|---|---|---|
| `shortdrama-director` | 剧本 + shotlist JSON + G1/G3 | writer + story 的镜头表/分镜 | 它产出 shotlist.json，本插件不读；会绕开画布/镜头表 |
| `shortdrama-character` | 角色卡、多视图、LoRA | story STEP 3 | 两套角色卡/资产口径不同 |
| `shortdrama-comfyui` | 读 shotlist.json 调 LTX-2 | 本插件工具层 `comfy_generate_*` | 技术栈不同；照它的指令会绕开能力注册表 |
| `shortdrama-memory` | `production-state.json` + 每集进度 | production 的 `series/production-state.json` | **同名文件、不同 schema**，可能互相覆盖 |
| `shortdrama-review` | G1–G7 审核状态机 | production 的 G-S…G-F 门 | 两套门号混淆 |

**建议（本项目）**：
1. **只用** `/story-short-generator` / `/short-drama-series-production` / `/short-drama-series-writer`；不要调用 `shortdrama-*`。
2. 已按用户决定删除 ai-show 的 5 个目录；当前技能目录只剩本插件三件套 + 其他无关 skill。若别处重装，优先用显式 `/skill-name`，不要让它们抢路由。
3. **绝不要**让两条流水线共用同一个 `production-state.json`；本插件的状态在 `series/production-state.json`，外部在项目根/它自己的目录。

### 2.3 其他相邻 skill

| 说法 | 可能命中 | 应该用 |
|---|---|---|
| 「品牌片 / 产品宣传」 | brand-promo | `brand-promo-video-generator` |
| 「只改提示词 / H3 六段式」 | story / h3 | `h3-prompt-writing`（不执行生成） |
| 「单图 / 改绘 / 换背景」 | story / image-generate | `image-generate` 或 `comfy_generate_image` / `comfy_render` |
| 「BGM / 配乐」 | 无专门 skill | 直接说「用 comfy_generate_music 生成…」 |

---

## 3. 推荐的触发话术

### 单片
```
/story-short-generator
把「一只想当宇航员的小狐狸」做成 30 秒皮克斯感短片。
9:16，有对白，要画面内字幕，图片档位 balanced，视频档位 balanced，逐镜审查。
```
（有系列上下文时它会自动进委托模式；没有才问片型。）

### 只要剧本
```
/short-drama-series-writer
写一部 80 集女频逆袭短剧：先出题材/人物/分集目录，再写前 10 集剧本。
只要剧本，不要成片/镜头表。
```

### 整部 / 单集

> 系列规格（画幅/时长/视频 tier/图片 imageTier/字幕/交付 delivery/声线 voicePlan/卡版本 characterCardVariant/审查/风格）由 production 的 **S-STEP 0「系列规格卡」逐项选**，默认只是推荐，不是写死。
>
> 如果还没有剧本：production 会调用 `short-drama-series-writer` 的**完整流水**（`/start` → `/plan` → `/characters` → `/outline` → `/episode` → `/review`），不是只让它出大纲；production 不代写台词/设定。writer 不可用则停线告知。

```
/short-drama-series-production
已有 80 集分集剧本，整部量产；先做 EP01 样片集，balanced/9:16/无字幕。
```
或：
```
继续拍第 3 集，用已有的 series/ 和集制作包。
```

### 单镜头
```
/video-generate type=r2v tier=balanced ratio=9:16 length=124 refs=<角色卡节点>,<场景卡节点>

<这里是 H3 结构化 prompt>
```

### 只写提示词
```
/h3-prompt-writing
把下面这场戏改写成 H3 Ref2VA 六段式提示词：…
```

---

## 4. 常见误路由与纠正

| 现象 | 原因 | 纠正 |
|---|---|---|
| 只想写剧本，却被拉去拍片 | 「短剧」命中 production | 说「只要剧本 / 不出成片」，或 `/short-drama-series-writer` |
| 只想做一条短片，却被问集数/样片 | 命中 production 或 story 的系列分支 | 说「单片，不要系列」，或 `/story-short-generator`；story 探测不到系列上下文会走单片 |
| 想拍第 N 集，却开始问 13 项单片规格 | 未命中 series 上下文 | 确认工作区有 `series/bible.md` + `series/episodes/epNNN/package.md`；或从 `/short-drama-series-production` 进 |
| 角色卡被外部 skill 抢 | `shortdrama-character` 的描述含「角色卡」 | 用 `/story-short-generator`，或移除外部 skill |
| 分镜变成 shotlist.json | `shortdrama-director` | 用 `/story-short-generator`；它产出画布文本分镜 |
| 状态文件互相覆盖 | `shortdrama-memory` 也用 `production-state.json` | 本插件只认 `series/production-state.json`；不要让外部 skill 写它 |

---

## 5. 一句话口诀

**「什么范围、要什么、有没有系列上下文」——三个都说，路由就稳；说不清就用 `/skill-name`。**
