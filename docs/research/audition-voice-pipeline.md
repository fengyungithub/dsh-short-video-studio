# 试镜片段 → 声线参考（audition → voice reference）流水线设计

> 状态：**设计稿 v1（2026-10-23）**，只写文档、不改代码。落地时按 §7 改 skill / 按 §8 先取证。
> 目标读者：后续实现者 + 想用 `voice:` 资产锁音色的片型 skill 维护者。
> 依赖能力（**已实现**）：`audio_ref_nodes`（`lib/index.js:3446`、`lib/index.js:3918`、`lib/index.js:4777`）、`extract_audio`（`lib/index.js:2771`）、`voice` 资产类型（`lib/assets.js:27`、`lib/assets.js:31`-`38`）。
> 机制与边界：[`docs/research/h3-audio-consistency.md`](h3-audio-consistency.md)、[`docs/h3-voice-consistency-plan.md`](../h3-voice-consistency-plan.md)。

证据分级沿用本仓惯例：`[CODE]` 代码可复核 / `[MEASURED]` 本机实测 / `[DOC]` 官方或文档 / `[ASSUMED]` 假设待证。

---

## 0. 先纠正两件事（否则后面全是过度承诺）

### 0.1 我们生产的是「声线参考样本」，不是「声纹指纹」

H3 没有 voice id / speaker embedding / voice clone 这类注册机制（`docs/research/h3-audio-consistency.md:132`-`136`；官方 API 唯一入口是 `role=reference_audio`）。参考音频是**条件输入**：每次生成都要重新喂一遍，模型在当次去噪轨迹里"照着音色说新台词"。所以：

- 流水线产物 = 一段 **2–15s 的干声样本**（`voice:` 资产）+ 一条"每镜复喂"的纪律；
- **不存在**"一次登记、服务端永久记住这把嗓子"；
- 跨调用音色一致**没有官方保证**，作用域只到单次 4–15s（`docs/research/h3-audio-consistency.md:154`-`160`）。

⇒ 本文档标题里的 "voice fingerprint" 只当产品名；实现与验收一律按 **reference sample（参考样本）** 口径说话。命名建议：画布节点标题用「XX 声线样本」，不要用「XX 声纹」。

### 0.2 用户给的成本前提要修一处

> "fast ≈25s, balanced ≈166s, quality ≈397s at 1344×768"

`[MEASURED]` 三个数字里只有后两个是 1344×768：balanced 166.3s、quality 396.6s（`docs/minimax-h3-video-benchmark.md:103`-`104`）。**fast 的 24.6s 是 832×480**（同文件 `:21`）；fast 跑 1344×768 是 **94.8s**，且属于「4 步 LoRA（544p 训练）跑 768p」的不配对格（`:129`），只能当预演。本仓档位本来就按「长边」推导（`comfy_list_workflows`：fast 832 / balanced 1344 / quality 1344），所以试镜按档位各自的原生长边报价即可，不要混着比。

---

## 1. Flow

### 1.1 落点：STEP 3 之后、STEP 4 之前

现行 skill 的顺序是「角色卡（两版）→ 场景卡 → 道具卡 → 七列镜头表 → 分镜 → 逐镜」（`skills/story-short-generator/SKILL.md:239`-`251`）。试镜必须插在**角色卡锁定之后、镜头表之前**，原因不是审美，是账：

- 镜头表要新增「声线参考」列（规划期就要知道每个说话人对应哪个 `voice:` 资产，见 `docs/h3-voice-consistency-plan.md:247`）；
- **换参考音频 = 连锁重渲**：所有用了该声线资产的镜必须重渲（`docs/h3-voice-consistency-plan.md:260`），续接链下游还要顺次重渲（`skills/story-short-generator/SKILL.md:829`-`830`）。所以音色必须在 STEP 7 之前定死，越晚改越贵。

建议命名 **STEP 3.5：声线试镜与声线资产**（§7.1 给正文骨架）。

### 1.2 五步（外加两个前提）

```
前提 P1  角色卡两版已生成、AI 自检过、用户已「锁定角色设计」（SKILL.md:315-325）
前提 P2  该角色 speaks_on_screen（speaksOnScreen 会随资产物化带到画布节点，lib/index.js:906）；
         audioMode=silent 的项目整步跳过（SKILL.md:200）

A. 角色卡（single + three）已锁定，按 STEP 0 的 characterCardVariant 决定视频引用哪一版
      ↓
B. 写一份试镜提示词库（每角色一份，三档同文）→ comfy_generate_video(type='r2v', ref_nodes=[角色卡])
      ↓  产物：5.17s 试镜片段（带音、单人、一句固定台词、口型可见、无 BGM、无字幕）
C. 用户在画布确认：只听声线（画面可丢）/ 声线+画面都要 / 换 seed 重抽 / 上传真人声线替换
      ↓
D. 通过 → extract_audio(该试镜视频) → 画布 audio 节点（32kHz；本机走 ComfyUI → .flac）
      ↓
E. 用户点该音频卡「入库」→ 类型 voice → 得到 voice:<16hex>
      ↓  记进画布「声线清单」文本节点（角色 → voice id → 试镜节点 → seed/tier/length）
F. 后续每一镜（说话人在屏）：
     comfy_generate_video(type='r2v', ref_nodes=[角色卡, 场景卡], audio_ref_nodes=['voice:<hex>'])
     prompt 里写 <Audio 1> … (S1) + <Audio 1>: reference - …
```

**关键约束（全部由代码兜底，不靠自觉）**

| 约束 | 证据 |
|---|---|
| 只有 `r2v` 能带参考音频；i2v 没有音频输入槽 | `lib/index.js:1361`-`1363` |
| 参考音频**必须伴随** `ref_nodes`（不能单独做唯一输入） | `lib/index.js:1367`-`1369` |
| ≤3 段、每段 2–15s、总 ≤15s、单文件 ≤15MB | `lib/index.js:415`-`420`、`:1364`-`1366`、`:2151`-`2152` |
| 2K / hires 实现**没有** `ref_audios` 注入点，会显式报 `audio-ref-unsupported` | `lib/index.js:2492`-`2494`；`workflows/*` 里带 `ref_audios` 的 14 份中不含 `-ctx-*-2k` 与 `-hires` |
| 传了参考音频但 prompt 没有 `<Audio N>` → 警告「参考可能只被当环境音」 | `lib/index.js:2511`-`2513` |
| prompt 声明了 `<Audio N>` 但没传 → 警告「空绑定」 | `lib/index.js:2514`-`2516` |
| `fast` 档会警告「turbo 削弱 reference/audio」 | `lib/index.js:2509` |

### 1.3 为什么试镜片段**不能**当镜头用

试镜是**声音采样素材**，不是成片素材：它不在镜头表里、不进 `shot clips` 组、不参与 `video_concat`、也不做 `extract_frame` 的锚点（否则固定台词/字幕/中性背景会被焊进成片）。它的唯一用途是"给用户听、然后抽音轨"。

---

## 2. 精确工具调用

下面所有 id 用占位符：`<CARD_SINGLE>` / `<CARD_THREE>` 为角色卡节点 id，`<BANK>` 为提示词库节点 id，`<AUDITION>` 为试镜视频节点 id，`<VOICE>` 形如 `voice:3f9c…`。

### 2.1 渲染前预检（一次，项目级）

```text
comfy_list_workflows()      // 确认 video.reference2video 有 balanced（长边 1344）
```

再确认**该项目档位实际解析到的实现**带音频注入点：两类会踩线——`-hires`、`-ctx-*-2k`（`grep -l '"ref_audios"' workflows/*.json` 只有 14 份，2K/hires 不在其中）。若用户在设置页把 `quality` 钉到了 2K/hires，试镜与所有对白镜都会在 `lib/index.js:2492` 直接报错。**处理**：改钉非 2K 实现，或该项目放弃音频参考（走纯文本音色描述）。

### 2.2 A. 写试镜提示词库（每角色一份）

```text
canvas_write_prompt_bank(
  title="Mia 试镜 提示词（分档）",
  group="voice auditions",
  prompts={ fast: <同一份完整 Ref2VA 六段文本>,
            balanced: <同上，逐字一致>,
            quality: <同上，逐字一致> },
  note="试镜专用：单镜、单人、一句固定台词、无 BGM、无字幕。改档只变采样。"
)
→ 记下 nodeId = <BANK>
```

三档同文沿用本仓现行策略（`skills/story-short-generator/SKILL.md:134`-`151`）：换档只变采样预算，变量干净。**提示词库是唯一的 prompt 权威**，重抽不要手抄 prompt。

### 2.3 B. 生成试镜片段

```text
comfy_generate_video(
  type='r2v',
  tier=<试镜档位，见 §4.4；默认 'balanced'>,
  prompt_node=<BANK>,
  ref_nodes=[<角色卡节点>],              // 只有角色卡；不要场景卡（§3.2）
  ref_variant=<single|three>,            // = 项目选择；tier=fast 时强制 single（SKILL.md:571-573）
  length=124,                            // 5.17s @24fps（benchmark:36）；73=3.04s（§4.2）
  seed=<显式记录，抽卡时换>,
  title="Mia 声线试镜",
  group="voice auditions"
)
→ 返回 node（含 media / absPath）、promptNodeId、warnings
```

要点：

- **只传一个 ref**：身份由角色卡给，环境靠 prompt 里的纯色摄影棚描述。多一张场景卡会把环境材质/氛围带进试镜，也会把环境声写进参考样本（§5 风险 4）。
- `ref_variant` 必须显式传，工具不再按 tier 自动选版（`skills/story-short-generator/SKILL.md:571`）。`tier=fast` 时必须 `single`（G-ref 门禁，`:573`）。
- 试镜也走 **H3 结构化闸门**：prompt 必须是 Ref2VA 六段式，否则 `tools/pre-execute` 会 deny（`lib/index.js:3292`-`3296`、`:3357`-`:3377`）。
- 长度网格 17k+5（`:5/22/39/56/73/90/107/124…`，`docs/minimax-h3-video-benchmark.md:240`），`length` 会自动向上取整（`lib/index.js:501`-`508`）。

### 2.4 C. 用户确认（选项卡，必须）

```text
ask_user_question(
  question="Mia 的声线试镜（5.2s）——先听声线，再看画面。怎么处理？",
  options=[
    { label:"通过：用这条的声线（推荐）", description:"立刻抽音轨入库；画面仅供试听，不进成片" },
    { label:"只认可声线，画面不动、也不重抽", description:"直接抽音轨；试镜片段标为“仅声线有效”" },
    { label:"换 seed 重抽（声线不像 / 有杂音）", description:"同 prompt 同档位，只换 seed；累计 ≤3 次" },
    { label:"改台词 / 语速后重抽", description:"先改提示词库的 quality 源文本，再同步三档" },
    { label:"我上传真人声线（2–15s）代替", description:"画布上传音频 → 入库 voice；质量上限最高的一条路" }
  ]
)
```

人工这一步不可省：**AI 不能听音**，所有音频验收都必须人耳（`skills/story-short-generator/SKILL.md:653`、`:673`）。飞书渠道下，`ask` 前插件会自动把未送达的媒体节点发出去（试镜 mp4 直接可播），所以「先听后批」在飞书上也是成立的。

### 2.5 D. 抽音轨

```text
extract_audio(
  video_node=<AUDITION>,
  title="Mia 声线样本",
  group="voice auditions"
)
→ 返回 { node, backend: 'ffmpeg' | 'comfyui', ... }
```

注意：`extract_audio` 写出的节点 `params` 只有 `{ source, sourceTitle, backend }`，**不记 `durationSec`**（`lib/index.js:2818`）——所以时长只能靠 WAV 头/ffprobe 兜（`:2143`-`2155`）。反过来，用户手动上传的音频节点会按 WAV 头记 `durationSec`（`lib/index.js:836`、`:851`），这也是「上传真人声线」路径在时长校验上更省事的原因。

`[CODE]` 两条后端（`lib/index.js:2786`-`2810`）：

| 后端 | 产物 | 采样率/声道 | 时长能否本地校验 |
|---|---|---|---|
| 有 ffmpeg | `<nodeId>.wav` | `-ac 2 -ar 32000`（`:2789`） | 能（WAV 头直读，`lib/index.js:423`-`441`、`:2154`） |
| 无 ffmpeg（**本机就是**，`which ffmpeg` 为空） | ComfyUI `LoadVideo → GetVideoComponents → SaveAudio` → **`.flac`**（`:2797`-`:2807`） | 32kHz 立体声（`docs/h3-voice-consistency-plan.md:511`） | 不能：FLAC 头读不了、本机也没 ffprobe（`:444`-`453`）⇒ 2–15s 校验降级为 warning（`:2497`-`:2508`） |

32kHz 不是缺陷：H3 的 AudioVAE 输出就是 **32kHz 立体声**（`docs/research/h3-audio-consistency.md:44`），ffmpeg 路径的 32k 正好是原生速率，不引入重采样损失。

### 2.6 E. 入库（**必须由人点按钮**）

```text
// AI 不调用任何入库动作。用户在画布音频卡上点「入库」→ 类型选“音频” → 命名「Mia 声线」
asset_list(type='voice')          // 取回稳定 id，形如 voice:3f9c2a…
// 跨会话复用时：
asset_to_canvas(id='voice:3f9c…', title="Mia 声线样本", group="voice auditions")
```

- 入库按钮与类型收窄：`studio/app.js:857`-`869`、入库表单 `:602`；音频类型显示名「音频」、kind 固定 `audio`（`studio/app.js:92`-`98`、`lib/assets.js:31`-`38`）。
- 资产 id 是**不透明随机 id**（`lib/assets.js:142`-`155`），改名不换 id（`:311`-`357`）——所以「Mia 声线」这个显示名只是给人看的，后续引用一律用 id。
- 手动上传的音频默认落在 group `voice refs`（`studio/app.js:105`-`108`）；本流程产出的音频用 `voice auditions`，两者都可以，别在画布上同时铺开太多组名。
- 入库是**唯一**把音频变成跨会话资产的路；AI 忘记录 id 就直接丢上下文。所以 E 步同时写一张 **`声线清单`** 文本节点（§7.3）。

### 2.7 F. 后续镜引用（现行 `audio_ref_nodes` 用法）

```text
comfy_generate_video(
  type='r2v',
  tier=<项目档位>,
  prompt_node=<该镜提示词库>,
  ref_nodes=[<角色卡>, <场景卡>],                 // 必须有图像伴随（lib/index.js:1367）
  ref_variant=<single|three>,
  audio_ref_nodes=['voice:3f9c…'],                // 只有说话人在屏的镜才传；一镜一说话人
  continuity_from=<上一镜节点 id>,                // 与音频参考正交，可同时用（plan:256）
  title="S03 片段",
  group="shot clips"
)
```

prompt 侧必须写两句（否则被 `lib/index.js:2511` 警告）：

```text
<Audio 1> is the voice-timbre reference for <Subject 1> (S1).
...
<Audio 1>: reference - the target speaker follows <Audio 1>'s voice timbre and measured delivery without copying the original signal.
```

⚠️ **`(S1)` 是"目标视频里的说话人序号"，不是"试镜里的序号"**：`(Sx)` 按目标视频实际发声顺序分配（`skills/h3-prompt-writing/references/ref-en.txt:281`）。同一镜若有第二个说话人，该角色可能是 `(S2)`，而 `<Audio 1>` 的定义必须复用它 —— **不得在音频定义里另起编号**（同文件 `:103`）。

### 2.8 兜底：模型在后续 take 里换了嗓子

**先分清是"参考没生效"还是"参考生效但不够"**——前者是 bug，后者是模型上限。

| # | 现象 | 动作 | 依据 |
|---|---|---|---|
| 0 | 返回带 `warnings` 说 prompt 无 `<Audio N>` | 补声明再渲，别当模型问题 | `lib/index.js:2511`-`2513` |
| 1 | 有/无参考音频输出**逐字节相同** | 通道没生效，停；查实现是否真的声明 `ref_audios` | `lib/index.js:2492` |
| 2 | 音色偶发漂移（同参考、不同 seed） | **本镜**换 seed 重渲（同 prompt / 同参考）；记录哪条通过 | 扩散采样随机性，`docs/research/h3-audio-consistency.md:244` |
| 3 | 系统性偏（每镜都不像） | 升档（`fast`→`balanced`/`quality`）；4 步 turbo 会削弱参考强度 | `lib/index.js:2509`、`docs/research/h3-audio-consistency.md:181` |
| 4 | 升档仍偏 | 换**更干净的参考**（重抽试镜，去掉混响/杂音/多说话人）；必要时用 2 段短样本（总 ≤15s） | `lib/index.js:2504`-`2505` |
| 5 | 只在某些镜偏（同角色不同场景） | 检查 prompt 里的音色形容词是否与试镜矛盾（如「低沉男声」vs 参考是清亮女声）；统一描述 | plan 开放问题 §11.3 |
| 6 | 全片都不行 | 不要硬肝：走 §9 的 TTS / 真人声线路线 | — |

**不要做的**：重复提交未改动的同一请求（`skills/story-short-generator/SKILL.md:637`）；也不要为了"稳"给全片共用一个 seed —— 社区实测共用 seed 会让脸和嗓子一起漂（`docs/research/h3-audio-consistency.md:175`）。

### 2.9 硬禁止

- ❌ 试镜 prompt 里写 `<Audio N>`（此时没有音频输入，会触发"空绑定"警告 `lib/index.js:2514`-`2516`）；
- ❌ 用 i2v / 转场镜带 `audio_ref_nodes`（无音频槽，直接报 `audio-ref-shape`，`lib/index.js:1361`）；
- ❌ 把试镜 mp4 直接塞进 `video_concat` 或当 `first_frame_node`；
- ❌ 一次试镜里写两个说话人 / 背景人声 / 笑声（§5 风险 6）；
- ❌ 抽完音轨又重渲试镜，却不更新 `voice:` 资产（旧资产仍被下游引用，且不同 take 的音色不同）。

---

## 3. 试镜提示词模板

### 3.1 结构要求（不可省）

试镜走 Ref2VA，即**六段式**，且是 H3 闸门硬校验的（`lib/index.js:3295`、`:3357`-`3365`）：

```
subject_definitions → summary → retention_analysis → detailed_description
→ overall_soundscape → non_diegetic_music
```

- 正文英文；台词原文放 `<d>[语言] …</d>`（`skills/h3-prompt-writing/references/ref-en.txt:8`、`:223`）；
- 无音频参考 ⇒ **不出现 `<Audio N>`**，`retention_analysis` 里也就没有音频行；
- 单镜：只有 `[Shot 1]`，不加时间戳（`ref-en.txt:221`）；
- `non_diegetic_music: N/A`（无配乐），环境音压到最低（`ref-en.txt:287`-`297`）。

### 3.2 逐字段该写什么（试镜专用）

| 段 | 写什么 | 为什么 |
|---|---|---|
| `subject_definitions` | 一条 `<Subject 1>`：从哪张角色卡来 + 外观锚点（脸/发型/服装主色/体型/签名道具） | 试镜是**特写**，外观错得最明显；也决定模型给什么音色（外观与音色强相关） |
| `summary` | `[reference generation]` + 一句话：单镜、单人、面向镜头说一句短台词的中性试镜 | 只做 reference，不做 keyframe completion |
| `retention_analysis` | 一行 `<Subject 1> (appears in [Shot 1]): fully_preserved - …` | 没有音频行；不要在这里写 `(Sx)`（`ref-en.txt:281`） |
| `detailed_description` | 风格一句 + `[Shot 1]`：中近景、胸口以上、**口唇完全可见无遮挡**、正面/微侧、单一连续镜头、极轻微推近；`<Subject 1> (S1) 用清亮的中音区、放松的语速说 <d>[Chinese] …</d>`；说完**闭唇**并保持柔和表情到结尾 | 口型可见 = 用户能判断"这是这个角色的说话方式"；连续镜头 = 无切点、无第二机位 |
| `overall_soundscape` | 「安静、干燥的室内房间底噪；无音乐、无音效、无其他人声」 | 参考样本要干净；房间声太强会被当声景带进成片（§5 风险 4） |
| `non_diegetic_music` | `N/A` | 无 BGM 是硬要求（试镜里出现音乐 = 参考被污染） |

末尾追加一行负向（片型侧，`skills/h3-prompt-writing/references/studio-mapping.md:78`）：

```text
no subtitle, no burned-in dialogue text, no on-screen text, no watermark, no storyboard marks.
```

**字幕说明**：试镜**一律不要字幕**，与项目 STEP 0 的「字幕」选择无关——试镜不进成片，任何烧录文字只会干扰审听、并可能在抽帧时被误用。若仍冒出字幕，重抽（不要为此改项目字幕开关）。

### 3.3 拷贝即用示例（中文台词，5.17s）

```text
subject_definitions:
<Subject 1> is the young woman in <Picture 1>, with a round face, straight black shoulder-length hair, dark-brown eyes, a mustard-yellow knit sweater, and a small silver hoop earring on her left ear.

summary:
[reference generation] The target video is a single continuous medium close-up audition of <Subject 1> speaking one short neutral Chinese line to camera, in a plain studio with no music and no other people.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - the round face, straight black shoulder-length hair, dark-brown eyes, mustard-yellow knit sweater, and silver hoop earring are retained.

detailed_description:
The target video is a clean neutral studio audition take with soft even key light and a plain light-grey backdrop.
[Shot 1] A medium close-up frames <Subject 1> from the chest up, centered, facing the lens at a very slight three-quarter angle. Her whole mouth and jaw are fully visible and unobstructed; no hand, hair, or prop crosses her lips. She looks into the lens with a calm, natural expression, opens her lips and says in a clear warm mid-register voice at a relaxed conversational pace, <d>[Chinese] 今天的风很轻，我们慢慢走。</d> Her lips and jaw move only while the line is spoken. After the final syllable her lips close and she holds a soft closed-mouth smile until the last frame. One continuous take, no cuts, no other shot, only a very slight slow push-in.

overall_soundscape:
A quiet, dry indoor room tone; no music, no sound effects, no other voices.

non_diegetic_music:
N/A

no subtitle, no burned-in dialogue text, no on-screen text, no watermark, no storyboard marks.
```

台词字数：`今天的风很轻，我们慢慢走。` = 11 个汉字 + 句末标点，约 2.5–3s 说完，落在 5.17s 里，前后各留约 1s 静音（抽出的参考不会从半个音节开始/结束）。

### 3.4 台词库（固定句，跨角色/跨 take 复用同一句）

固定句是**控制变量**：同一句才能比较两个角色的音色、也才能比较同一角色的不同 take。

| 语言 | 建议句 | 字数/词数 | 说明 |
|---|---|---|---|
| 中文 | `今天的风很轻，我们慢慢走。` | 11 字 | 声母/韵母有区分度（jīn / fēng / qīng / zǒu），吐字可辨；覆盖阴平/上声/去声与轻声 |
| 中文（问候型） | `你好，我是米娅，今天由我来讲。` | 12 字 | 更接近"自我介绍"语感；别写角色真名以外的信息 |
| English | `The wind is light today, so let us walk slowly.` | 10 词 | 与中文件同构；换语言时**所有角色都换**，别混 |

**硬规则**：固定句**不得**是成片里的任何一句台词。只借音色时，官方明确要求不要把参考音频里的原台词搬进目标视频（`ref-en.txt:279`、`docs/research/h3-audio-consistency.md:128`）；固定句与成片台词重合会让"是否泄漏"无法判断（§6.2 第 6 条）。

### 3.5 常见写错

| 写法 | 后果 |
|---|---|
| 写 `<Audio 1>` 想"顺便锁音色" | 空绑定警告，且模型开始猜音色（`lib/index.js:2514`） |
| 试镜 prompt 里写「两只手」「正侧背三格」 | 三视图/多主体参考在 `fast` 档必出副本（`SKILL.md:111`-`115`） |
| 用「no music」当唯一手段 | 音乐在 H3 里是独立层，`non_diegetic_music: N/A` 才是主机制（`ref-en.txt:283`-`297`） |
| 台词 20+ 字 | 5s 内说不完 → 结尾被截，参考样本尾巴是半个词 |
| 说「speak in a deep male voice」而参考是女声 | 语义冲突，参考可能被压过（plan §11.3 未定论） |

---

## 4. 成本

### 4.1 `[MEASURED]` 实测（124 帧 = 5.17s，单卡 Ampere）

| 档位 | 分辨率 | 试镜单条 | 3 takes / 角色 | 2 角色 × 3 takes | 抽音轨 |
|---|---|---|---|---|---|
| `fast` | 832×480 | **24.6s**（`benchmark:21`） | 74s | 2.5 min | ~2s（ComfyUI）／≈0（ffmpeg） |
| `balanced` | 1344×768 | **166.3s**（`benchmark:103`） | 8.3 min | **16.6 min** | 同上 |
| `quality` | 1344×768 | **396.6s**（`benchmark:104`） | 19.8 min | 39.7 min | 同上 |

补充实测：`fast` + 参考音频的端到端链路（生成 124 帧 + 抽音轨）**28.7s**；抽音轨走 ComfyUI 后端产出 `.flac`（`e2e-out/voice-ref/report.json`）。`[DOC]` 另一份 P0 记录里 fast 档 26.6s、`extract_audio` 2.1s（`docs/h3-voice-consistency-plan.md:499`-`501`）。

### 4.2 3s 试镜（`length=73`）的**推算**（未实测）

用 benchmark 的拟合 `t ≈ 固定开销 + 步数 × 单步`，其中单步成本 ∝ token^1.5、token ∝ 宽×高×帧数（`docs/minimax-h3-video-benchmark.md:107`、`:203`）。以 768p 单步 18.86s（37.2k token）为基准，73 帧 ≈ 21.9k token：

| 档位 | 124 帧实测 | 73 帧推算 | 备注 |
|---|---|---|---|
| fast 832×480 | 24.6s | **≈15s** | 固定开销按 480p 反解得 ≈6s |
| balanced | 166.3s | **≈90s** | 固定开销 ≈19s |
| quality | 396.6s | **≈195s** | 同上 |

误差预计 ±10–20%，且**短于 124 帧属未测区**（`skills/story-short-generator/SKILL.md:720` 记了 `length=39` + fast 中段糊、建筑形变）。⇒ 3s 版本只在 §8 里当实验臂，不进默认流程。

### 4.3 真正贵的不是试镜，是"改声线"

试镜本身 ≈ 3 分钟/角色（balanced ×1 take）。但**换 `voice:` 资产 = 所有用它的镜重渲 + 续接链下游顺次重渲**（`docs/h3-voice-consistency-plan.md:260`、`skills/story-short-generator/SKILL.md:829`-`830`）。一条 10 镜 balanced 的片 ≈ 28 分钟渲染，改声线等于再付一遍。

⇒ 两条纪律：
1. **预算里给重抽留 2–3 take**（balanced 下 ≤8.3 min/角色），比渲完整片再返工便宜一个数量级；
2. **声线在 STEP 3.5 锁死**；STEP 7 之后改声线要按"换风格/换档重做"同级显式确认（`SKILL.md:73` 的破坏性操作口径）。

### 4.4 推荐档位：`balanced`

理由（按强度排序）：

1. **样本要当锚点**：它会被每一镜复喂，参考样本本身的干净度/可信度直接决定上限，返工代价沿下游放大（§4.3）。
2. **`fast` 的已知弱点是参考强度**：4 步 turbo 会削弱 reference/audio（`docs/research/h3-audio-consistency.md:181`、`lib/index.js:2509`）。注意这条**不直接适用于试镜本身**（试镜不吃参考音频），它适用于"拿试镜去条件化后续镜"——而试镜档位与成片档位不一致时，音色域差是否存在**尚未取证**（§9 开放问题 3）。
3. **`quality` 的 2.4 倍耗时买不到关键收益**：试镜的主要风险是"用户不喜欢这把嗓子"（重抽解决），不是"分辨率/采样不够"；397s × 3 takes = 20 分钟/角色，换来的边际收益未被证明。

**推荐组合（分两段，成本可控）**：

| 场景 | 做法 | 2 角色总成本 |
|---|---|---|
| 默认（项目档位 balanced 或更低） | 每角色 **2 takes @ balanced**，挑一条，另一条留档 | ≈11 min |
| 项目档位 = quality | 每角色 **2 takes @ balanced** 初筛 → **1 take @ quality** 定稿（用初筛选中的 seed + 同 prompt） | ≈11 + 13.2 = 24 min |
| 只走通链路 / 试流程 | 1 take @ fast | ≈1 min |

> 为什么"初筛用 balanced 再 quality 定稿"而不是全 quality：初筛拼的是"用户偏好"，用 166s 的样本足够判断；定稿才需要与成片同档。

---

## 5. 质量风险与失效模式

| # | 风险 | 机制 / 证据 | 检测 | 缓解 |
|---|---|---|---|---|
| 1 | **跨 take 音色漂移** | 跨调用没有 ID 绑定，每次都是新的去噪轨迹（`docs/research/h3-audio-consistency.md:154`-`160`）；共用 seed 会让脸和嗓子一起漂（`:175`） | §6.3 盲听 A/B | 每镜复喂同一 `voice:` 资产；逐镜独立 seed；档位 ≥ balanced；显式 `(Sx)` + 音色文字描述 |
| 2 | **32kHz 天花板** | H3 AudioVAE 输出 32kHz 立体声（`:44`），抽音轨也定在 `-ar 32000`（`lib/index.js:2789`） | 频谱 >16k 空 | 不要"升采样"伪造带宽；参考直接用 32k；全程无损格式（wav/flac），避免再压 mp3 |
| 3 | **fast 档参考"持不住"** | 4 步蒸馏削弱 reference/audio（`:181`；工具也 warning，`lib/index.js:2509`） | 同 prompt 有/无参考差异很小 | 对白镜不用 fast；fast 只做链路冒烟 |
| 4 | **BGM / 声景糊进参考** | 参考是音频信号，房间声/配乐会一起被条件化；`overall_soundscape` 与 `non_diegetic_music` 是不同层（`ref-en.txt:283`-`299`） | 试镜里听到音乐/明显混响/风噪 | prompt：`non_diegetic_music: N/A` + 干燥室内底噪；`retention_analysis` 写 `reference`（只借音色，不复刻信号，`ref-en.txt:207`） |
| 5 | **口型/身份崩** | 多主体参考在 fast 档必出副本/污染（`SKILL.md:111`-`115`）；近景口型遮挡最容易被看出来 | 抽首/中/末帧看：单人、嘴无遮挡、唇动只在台词段 | fast 强制单视图卡（G-ref，`SKILL.md:573`）；非 fast 出污染先 `ref_variant='single'` 重渲（`:630`） |
| 6 | **出现第二个说话人** | 多说话人 + 参考音频是官方列的失败模式（`docs/research/h3-audio-consistency.md:169`）；模型容易补出"听者"或笑声 | 人耳：是否有第二个声源、笑声、回声 | prompt 写"only <Subject 1> speaks; no other voices, no laughter, no off-screen voices"；仍出现就重抽 |
| 7 | **字幕/文字烧进试镜** | 本仓支持原生字幕（`SKILL.md:202`-`207`），不声明也可能偶发 | 看画面有没有字 | 负向尾句 + 不写任何字幕声明；出现即重抽。**注意**：字幕只污染画面，不污染抽出的音轨，所以别为了它放弃一条好声线 |
| 8 | **参考时长/体积不合规** | 2–15s、≤15MB、总 ≤15s、≤3 段（`lib/index.js:415`-`420`）；单次生成最多 310 帧 ≈12.9s（`workflows/minimax-h3-ref2v-fast.json` 的 `constraints.maxDurationFrames`，且网格上限 294 帧 ≈12.25s） | 工具会报错/告警 | 5.17s 稳过；**想拿 15s 长参考是做不到的**（单次 H3 出不到 15s），不要设计 15s 试镜 |
| 9 | **抽音轨格式** | 本机无 ffmpeg ⇒ ComfyUI `SaveAudio` → `.flac`（`lib/index.js:2807`、`docs/h3-voice-consistency-plan.md:511`） | `.flac` 时长本机不可读 → 2–15s 校验降级 warning（`lib/index.js:2497`-`2508`） | 接受 warning（5.17s 本来就在区间内）；或请在装了 ffmpeg 的机器跑，产出 `.wav` 可直读时长 |
| 10 | **入库漏做** | 入库只能人工点按钮（`SKILL.md:327`），id 是不透明 hex | `asset_list(type='voice')` 查不到 | 画布写「声线清单」节点；入库后立刻 `asset_list` 回写 id |
| 11 | **2K / hires 档不支持音频参考** | `ref_audios` 只在 14 份清单里（不含 `-hires`、`-ctx-*-2k`）；选中会显式报错（`lib/index.js:2492`-`2494`） | 渲染前 `comfy_list_workflows` + 一次 probe | 钉非 2K 实现，或放弃音频参考 |
| 12 | **参考原台词被"搬运"** | 只借音色时官方要求不复刻原话（`ref-en.txt:279`） | 听成片是否出现试镜那句话 | 固定句与成片台词不重合；`reference` marker；`retention_analysis` 明确 "without copying the original signal" |
| 13 | **口音/语速被带跑** | 锁 24fps；改帧率会听出偏（`docs/research/h3-audio-consistency.md:177` 社区经验） | 人耳 | 项目统一 24fps（本仓默认 24，`lib/index.js:2660`） |
| 14 | **外观改动后声线不匹配** | 模型按外观选音色；角色卡换了年龄/性别/体型后，旧声线会"不像这个人" | 听 + 看 | 服装/发型微调 → 声线不动；**年龄/性别/体型/物种变化 → 重试镜**（与双版本卡同步重出的纪律一致，`SKILL.md:823`） |

---

## 6. 验收与自检

### 6.1 机器能查的（AI 必做，交人工前）

1. **通道生效**：本次调用返回里 `audioRefs` 非空、节点 `params.audio_ref_nodes` 有值、`params.audio_ref_declared === true`（`lib/index.js:2666`-`2670`、`:2757`）。
2. **无告警**：`warnings` 里没有 `audio-ref-*`、没有"prompt 未出现 `<Audio N>`"、没有"fast 削弱参考"。
3. **时长合规**：抽出的音频 ≈ `length/24` s，落在 2–15s。
4. **画面自检（试镜）**：单人 / 口唇可见 / 无遮挡 / 无字幕 / 无第二个身体 / 无分镜痕迹 —— 抽首帧+中段帧（`SKILL.md:645`-`649` 的抽样口径）。
5. **跨镜引用一致**：同一说话人在所有镜里引用**同一个** `voice:` id（按 assetId 判等，`docs/h3-voice-consistency-plan.md:249`）。

### 6.2 人耳清单（试镜通过前逐条过）

- [ ] **只有一个声音**：没有第二个人声、笑声、和声、回声；
- [ ] **没有音乐**：任何乐器/节奏型都算不过；
- [ ] **干声**：没有明显混响/房间尾巴/风噪/爆音；
- [ ] **边界干净**：开头不是半个音节，结尾不是被截断的半个词；词后有明显静音；
- [ ] **是这个人**：年龄、性别、音区、语速、口音与角色设定一致；
- [ ] **不是成片台词**：试镜这句不许出现在任何成片片段里（出现即参考被搬运，`ref-en.txt:279`）；
- [ ] **口型对得上**：台词段唇在动，说完闭唇（这条决定"这条试镜能不能当角色的语音形象"）。

### 6.3 要不要做 A/B：**要**，但要分清两种 A/B

| A/B | 问的问题 | 做法 | 通过线 |
|---|---|---|---|
| **通道 A/B**（技术） | 参考音频到底有没有被用？ | 同 prompt / 同 seed，`audio_ref_nodes` 有 vs 无；比较输出（音轨 md5、频谱统计） | 必须**不同**。相同 = 通道没生效，停。`[MEASURED]` P0 spike 已证有/无参考 md5 不同（`docs/h3-voice-consistency-plan.md:22`），但那是一次手工改图；插件路径上要在 balanced 复核一次 |
| **听感 A/B**（效果） | 后续镜听起来像不像试镜？ | 见 §8.4 盲听协议 | 预注册：with-ref ≥8/10 判"同一人"；without-ref 对照组 ≥7/10 判"不同人" |

**A/B 的常见误读**：同 seed 不等于同像素——换采样轨迹/换实现都会变（`docs/minimax-h3-video-benchmark.md:44`）。所以"有/无参考同 seed 不同"只能证明条件生效，不能证明"更像"；"更像"只能靠人耳。

### 6.4 怎么让试镜"有代表性"

试镜是**基准样本**，它必须和成片对白的语言/口音/语域/情绪基线一致：

- **语言/口音**：跟项目台词语言一致（`SKILL.md:191`：用户没指定语言时不要默认英文）；中文项目别用英文试镜，否则口音会被当"角色设定"复喂；
- **语域**：用角色的**基线语域**（日常说话），不要用极端情绪（咆哮/耳语/哭腔）。台词情绪由镜 prompt 承担，参考只给音色；若全片 70% 是耳语，才考虑单独出一条耳语参考；
- **语速**：按角色说话习惯来（同一句，急脾气与慢性子读出来长度不同——这本身是"角色特征"，但会让参考时长在 3–5s 间浮动）；
- **别把表演写进参考**：试镜只演"说话"，不演剧情；剧情细节留给分镜，否则参考会带上情绪包袱。

---

## 7. Skill / UX 改动

### 7.1 新增 STEP 3.5（插在 STEP 3 与 STEP 4 之间）

SKILL.md 骨架（放在 `## STEP 3` 之后，`skills/story-short-generator/SKILL.md:327` 之前后均可，建议紧接角色卡锁定提示）：

```markdown
## STEP 3.5：声线试镜（仅 speaks_on_screen 的角色；audioMode=silent 跳过）

角色卡锁定后，按 STEP 0 的「声线策略」执行：
1. 「试镜生成」→ 每角色一条试镜片段（§3 模板，group `voice auditions`，标题「XX 声线试镜」）
2. 「上传真人声线」→ 用户上传 2–15s 干声 → 画布 audio 节点 → 入库 voice
3. 「不要声线资产」→ 跳过，后续只靠文字音色描述 + 链条续接

试镜档位：默认 balanced（理由见 docs/research/audition-voice-pipeline.md §4.4）；
项目档位为 quality 时按「2 takes @ balanced 初筛 + 1 take @ quality 定稿」。

流程：写提示词库 → 渲试镜 → 用户确认（声线 / 声线+画面 / 重抽 / 上传真人）→
extract_audio → 用户点「入库」→ asset_list(type='voice') → 写「声线清单」。

纪律：
- 试镜不进镜头表、不进 `shot clips`、不参与拼接；
- 固定台词不得是成片台词；同一项目所有角色用同一句（控制变量）；
- 声线在 STEP 7 之前锁死：改声线 = 所有对白镜重渲 + 续接链顺次重渲（破坏性操作，须显式确认）。
```

### 7.2 STEP 0 增加一项「声线策略」

三选一（默认**试镜生成**）：

| 选项 | 说明 | 成本 |
|---|---|---|
| **试镜生成**（推荐） | 每角色一条 5.2s 试镜，抽音轨入库 | ≈3 min/角色（balanced 1 take） |
| **上传真人声线** | 用户提供 2–15s 干声（演员/本人）；质量上限最高 | 0 渲染 |
| **不要声线资产** | 只靠文字音色描述 + 链式续接（现状） | 0 |

**为什么把"上传真人声线"放进首屏**：真实人声没有"模型随机编一把嗓子"的问题，reference 条件强度也最直接；对已经有配音/演员的项目，试镜反而是降级方案。这条也顺带回答了 §0.1 的焦虑——真正的"声纹锚"应该来自人，而不是模型的一次采样。

同时把这一项写进 project brief（与字幕一样没有 state 字段，`SKILL.md:232` 的口径）。

### 7.3 画布分组 / 标题 / 清单节点

- `groupOrder` 在 STEP 0 一次性声明（`SKILL.md:252`），**在 `character cards` 之后插 `voice auditions`**：

```text
["story planning","character cards","voice auditions","scene cards","prop cards",
 "shot table","text storyboards","shot prompts","shot clips","final delivery"]
```

- 节点标题（用于飞书自动送达的文件名，`SKILL.md:790`）：
  - 视频：`Mia 声线试镜`
  - 音频：`Mia 声线样本`
  - 提示词库：`Mia 试镜 提示词（分档）`
  - 清单：`声线清单`（text，group `voice auditions`）
- `声线清单` 建议表格内容：

| 角色 | voice 资产 id | 试镜节点 id | 档位 | seed | 时长 | take | 状态 |
|---|---|---|---|---|---|---|---|
| Mia | `voice:3f9c…` | `1a2b…` | balanced | 20261023 | 5.17s | #2 | 已锁定 |

> 用户手动上传的音频默认落 group `voice refs`（`studio/app.js:105`-`108`），不在上面的 `groupOrder` 里 → 会排在声明分组之后。可接受；若要整齐，把 `voice refs` 也加进 `groupOrder`。

### 7.4 确认选项与重抽政策

- 选项卡见 §2.4（5 个选项）。**每个角色一次**，不要每 take 一次。
- **重抽上限 3 take**（同 prompt、同档位、只换 seed）；第 3 次仍不行 → 停，出选项卡：改台词/语速（先改提示词库 quality 源文本，再同步三档，`SKILL.md:827`）/ 降要求接受 / 上传真人声线 / 放弃声线资产。
- **重抽 = 新节点**，不覆盖旧节点；旧 take 标「废弃」，不再作任何资产来源（`SKILL.md:841` 的版本纪律）。
- 一条已通过并入库的试镜**不得**被后来的 take 静默替换：换 `voice:` 资产属于破坏性操作，必须说明"会影响哪些已渲片段"并显式确认。

### 7.5 STEP 5 / 7 / 8 的增量

| 步骤 | 改动 |
|---|---|
| STEP 5 镜头表 | `音频与对白轨` 下增加子字段 **`声线参考`**（角色 → `voice:<id>` / `none`）；`silent` 镜写 `none`（plan 已规划，`docs/h3-voice-consistency-plan.md:247`） |
| STEP 7 组装 | 说话人在屏的镜 → `audio_ref_nodes=['voice:<id>']`（+ 必带 `ref_nodes`）；prompt 内补 `<Audio N>` 定义与 `retention_analysis` 的 `reference` 行；**`(Sx)` 用目标视频的序号**，不是试镜的 S1 |
| STEP 7 自检 | 门 3 第 5 项（音频，人工听核）加一条：**同一说话人跨镜必须是同一个 `voice:` id**（按 assetId 判等）；并听"是否出现试镜那句台词"（泄漏） |
| STEP 8 终检 | 交付清单加：声线参考清单（角色 → id）、盲听结论、未做项（如某角色无试镜、只靠文字） |

### 7.6 不要改的

- 不要为"声线"新增档位（档位语义由注册表定义，`docs/h3-voice-consistency-plan.md:266`）；
- 不要写死实现名 / 工作流 id（`SKILL.md:48`）；
- 不要让 AI 自动入库（`SKILL.md:327` 与插件契约）；
- 不要把试镜塞进 `shot clips`（会污染镜头数与拼接顺序）。

---

## 8. 实验计划（<1h GPU，验证前提）

> 目的：证明/推翻"试镜样本 → 后续 take 音色一致"这个前提。**没有这一步就不要把 STEP 3.5 设成默认开启。**

### 8.1 假设

| H | 命题 | 判定 |
|---|---|---|
| H1 | 带 `audio_ref_nodes` 的镜，人耳判"与试镜同一说话人"的比例显著高于不带 | 盲听通过线 §8.4 |
| H2 | 试镜本身的 take 间差异（take1 vs take2）**小于** 试镜→成片的差异 | 盲听 + 代理指标 |
| H3 | 有/无参考的输出不同（通道生效） | md5 / 像素差 |
| H4 | 参考音频会把**房间声/配乐**带进成片 | 听声景；A/B 频谱 |
| H5 | 试镜档位（fast vs balanced）会影响后续成片音色 | 仅 1 个角色，作探索 |

### 8.2 实验臂与预算（balanced，1344×768，length=124，同一固定句）

| 臂 | 内容 | 次数 | 耗时 |
|---|---|---|---|
| E1 | 2 角色 × 3 take 试镜 | 6 | 16.6 min |
| E2 | 2 角色 × {带 voice ref, 不带} × 1 镜（同 prompt / 同 seed） | 4 | 11.1 min |
| E3 | 2 角色 × 1 镜，改用 **take2** 的音频作参考（测 take 间漂移） | 2 | 5.5 min |
| E4 | 1 角色 × 1 take @ fast 试镜（探索档位影响，可选） | 1 | 0.4 min |
| — | 抽音轨（E1 的 2 条 + E2/E3 的 6 条） | 8 | ≈0.3 min |
| **合计** | | **13 次渲染** | **≈34 min + 模型加载** |

角色选择：优先用**已有角色卡**（省掉出卡成本）；若必须新出，2 张单视图 @ quality 图片档 ≈ 1.5 min（`comfy_list_workflows`：图片 quality ≈45s）。两个角色要**明显不同**（性别/年龄各一），否则"同一人"判断没有区分度。

### 8.3 量什么

**(a) 后续镜是否像试镜**

- 主指标：§8.4 盲听（唯一能回答"是不是同一个人"的手段；本仓**没有任何 speaker embedding / 音色指标**，`docs/research/h3-audio-consistency.md:244`）。
- 代理指标（**只能抓粗漂移**，不能当相似度）：中位 F0、频谱质心、语速（音节/秒）、长时平均谱余弦。判据：代理指标若显示"性别级/年龄级"跳变 → 直接判漂移；代理指标正常但人耳判不同 → 以人耳为准。
- 泄漏检查：成片里是否出现试镜固定句。

**(b) 接缝 / 响度**

- 抽出的音频：语音段 RMS(dBFS)、峰值、首尾静音长度；
- 把「试镜尾 → 成片头」硬拼，测响度台阶（dB）与零滞后相关；本仓已有工具：`e2e-out/ctx-test/measure_seam.py`（在**容器内**跑，依赖 `av`+numpy；本机 workstation 没有 ffmpeg/ffprobe 也没有 soundfile，`which ffmpeg` 为空、`python3` 仅有 numpy/scipy）；
- 同一角色不同 take 之间的响度/语速差（H2 的量化面）。

**(c) 盲听 A/B 协议（预注册，先写死再听）**

1. 刺激：每对 3–5s 干净对白；A/B 随机左右；音量归一化（否则响度会泄漏答案）。
2. 组对（每角色）：① 试镜 vs 带参考的镜；② 试镜 vs 不带参考的镜；③ 带参考 vs 不带参考；④ **同一文件重复**（注意力控制对，必须判"同一人"）；⑤ 另一角色的片段（负控制对，必须判"不同人"）。
3. 听者：5 人，且**能听懂台词语言**（中文项目找中文母语听者；否则口音差异会被误判）。
4. 问题：二选一「同一说话人？」+ 置信度 1–5；附一个三选一 odd-one-out（试镜 / 带参考 / 不带参考，问"哪个不像另外两个"）——identity 任务上 odd-one-out 比 pairwise 更敏感。
5. 通过线：带参考 ≥ **8/10** 判"同一人"；不带参考对照组 ≥ **7/10** 判"不同人"；控制对 100% 正确，否则该听者数据作废。
6. 记录方式：每对记 `{pairId, listener, choice, confidence, correct?}`，算比例与置信区间（n 小，报原始计数即可，不要报 p 值）。

### 8.4 有效性与公平

- **同 seed 不能保证同像素**（`docs/minimax-h3-video-benchmark.md:44`），所以有/无参考的对比只能说明"条件生效 + 听感差异"，不能把差异全部归因给参考。
- 有/无参考两臂必须**同 prompt 文本**（除 `<Audio N>` 声明外）——否则测的是文案不是参考。
- 试镜 take 必须同 prompt / 同档位 / 同 length，只换 seed。
- 记录**全部** warnings（工具返回里）；带 `audio_ref` 相关 warning 的样本单独标出。
- 先跑 1 个角色的 E1+E2 做 smoke（≈14 min），确认链路与产出可听，再跑满 13 次。

### 8.5 产物与判定

产物落 `e2e-out/voice-audition/`：

```text
auditions/   sha_*.mp4 ×6            # E1
shots/       *_withref.mp4 ×2        # E2
             *_noref.mp4 ×2
             *_take2ref.mp4 ×2       # E3
audio/       *.flac / *.wav          # 抽出的参考与片段音轨
metrics.json                          # (a) 代理指标 + (b) 响度/接缝
blind/       sheet.csv + 听者原始记录
report.md                             # 一页结论
```

**判定规则（先定，不许事后改）**

| 结果 | 结论 | 行动 |
|---|---|---|
| H1 通过 且 H3 通过 | 前提成立 | STEP 3.5 设默认开启，`audio_ref_nodes` 进 STEP 7 常规路径 |
| H1 不过 但 H3 通过 | 参考生效但人耳无感 | 保留试镜作为**用户选声线**的 UI（价值仍在：一次选定、文字描述固化），音频参考降为可选 |
| H3 不过（输出相同） | 通道无效 | 停止推广；先查实现/声明（§2.8 第 1 条） |
| H1/H3 都不过 | 前提被推翻 | 走 §9 的 TTS/真人路线评估 |

---

## 9. 开放问题与"什么时候换成真 TTS / 克隆"

### 9.1 必须用实验回答（按优先级）

1. **音色到底能迁移多少**：官方从未量化（`docs/research/h3-audio-consistency.md:267`）；本仓只有"条件生效"（md5 不同）与"接缝级"指标（`:244`）。这是 §8 的 H1。
2. **参考时长与"最稳"区间**：官方 2–15s，无"多长最稳"数据（`docs/h3-voice-consistency-plan.md:426`）。注意单次 H3 出不到 15s（`constraints.maxDurationFrames=310`，网格上限 294 帧 ≈12.25s）⇒ 要 15s 参考必须多段（≤3 段、总 ≤15s），而多段 = 多 take = 音色混杂风险。
3. **试镜档位与成片档位不一致会不会造成音色域差**：本文推荐"初筛 balanced、定稿 quality"就是踩在这条未证假设上。
4. **参考音频 vs prompt 音色描述冲突时谁赢**（`docs/h3-voice-consistency-plan.md:427`）。
5. **参考的房间声/配乐会不会被复刻**（H4）——如果会，试镜就必须"干燥无音乐"，而这条会反过来限制"用真实电影片段当参考"的用法。
6. **seed 政策**：逐镜独立 seed（社区经验，`docs/research/h3-audio-consistency.md:175`）还是同 seed 复用，哪个更稳——本仓没有对照数据。
7. **多角色同镜**：一镜一说话人是现行硬约束（`SKILL.md:200`），一旦放开，多份参考 + 归属歧义是官方列出的失败模式（`:169`）。
8. **2K 再生成是否保声线**（`docs/h3-voice-consistency-plan.md:429`）：目前 2K/hires 实现**连参考音频注入点都没有**（§5 风险 11），所以这条要等实现补齐后才有意义。
9. **观测工具缺口**：本仓没有 speaker embedding（`docs/research/h3-audio-consistency.md:244`）；要量化，得引入 ECAPA / 3D-Speaker / Resemblyzer 任一并接受"指标≠人耳"的局限。**建议**：在补齐指标前，验收一律以盲听为准，代理指标只作粗筛。

### 9.2 什么时候该换成真 TTS / 声音克隆

**触发条件（满足任意 2 条即立项）**

1. 盲听通过率长期 **<70%**（连续 3 个角色、每个 ≥2 镜，跨 take）；
2. 该角色对白总量大（>30s）或对白镜数多（>10 镜）——重渲成本与漂移概率都随镜数放大；
3. 需要**逐字可控 / 补录（pickup）/ ADR**：H3 里台词与画面同源生成，改一句就得重渲整镜；
4. 需要**跨语言多语种**，或情绪跨度极大（耳语↔嘶吼）——参考样本只能表达一种"基线嗓音"；
5. 需要精确口型 / 台词长度对齐（例如品牌片、字幕严格对位）。

**换的代价（必须提前讲）**

- H3 是 **AV 联合生成**：加一条独立 TTS 会重新引入音画不同步，需要口型对齐链路；`docs/h3-voice-consistency-plan.md:41` 把"独立 TTS/后期配音轨"列为**非目标**就是这个原因。
- 但如果接受"音频先定、画面再对齐"，路径是通的：参考音频可以以 `fully_copy` / `partially_copy` 进 H3（官方 marker，`ref-en.txt:197`-`208`）——即用 TTS 产出目标台词，再让 H3 把这段音频当**完整/部分音轨**用。这是"TTS 主导 + H3 补画面"的组合，与本文档的 `reference`（只借音色）是两种不同模式，**不要混用**。
- 能力位已经在：`audio.tts` / `audio.music` 在能力枚举里（`lib/manifest.js:35`-`36`），但当前**没有实现**（`comfy_list_workflows` 未列出 audio.*；`SKILL.md:739` 也记了没有 BGM 工作流）。⇒ 接入一个 TTS 实现是"配置面 + 一份清单"的事，不需要改调用方协议。
- 声纹/版权的合规边界：本地资产库只在本机（`lib/assets.js:1`-`19`），但克隆真人声音需要授权；本文档的"上传真人声线"路径同样需要。

### 9.3 不打算做的

- 训练角色 LoRA / 声纹微调（`docs/h3-voice-consistency-plan.md:44` 的非目标）；
- 把 H3 当声纹库（它没有这个语义，§0.1）；
- 自动音色相似度评分替代人耳（在补齐 embedding 之前）;
- 多角色同镜的音色分离（官方失败模式）。

---

## 附录 A：证据索引（本文引用的仓库位置）

| 主张 | 位置 |
|---|---|
| `audio_ref_nodes` 参数与工具契约 | `lib/index.js:3446`、`:3918`、`:4777` |
| 形状校验（仅 r2v / 必须伴随图像） | `lib/index.js:1357`-`1370` |
| 参考音频解析（节点/资产/视频取音轨） | `lib/index.js:2118`-`2158` |
| 规格（≤3、2–15s、≤15s、≤15MB） | `lib/index.js:415`-`420`、`:2498`-`:2505`、`:2151` |
| fast 档警告、prompt 守卫、空绑定 | `lib/index.js:2509`、`:2511`-`2516` |
| 2K/hires 无注入点 | `lib/index.js:2492`-`2494`；`workflows/` 中 14 份含 `ref_audios` |
| 画布记账与返回值 | `lib/index.js:2666`-`2670`、`:2746`-`2759` |
| `extract_audio` 两条后端 | `lib/index.js:2771`-`2833`（ffmpeg `:2789`；ComfyUI `.flac` `:2797`-`2807`） |
| `voice` 资产类型 / 引用前缀 / 只认音频 | `lib/assets.js:27`、`:31`-`38`、`:121`-`123`、`:199`-`205`、`:212`-`216` |
| 入库 / 重命名 / 随机 id | `lib/assets.js:224`-`265`、`:311`-`357`、`:142`-`155` |
| 画布音频上传与入库 UI | `studio/app.js:92`-`98`、`:105`-`108`、`:602`、`:857`-`869` |
| H3 六段式闸门 | `lib/index.js:3292`-`3296`、`:3357`-`3377` |
| Ref2VA 规范（`<Audio N>` / marker / `(Sx)` / 不复刻原话） | `skills/h3-prompt-writing/references/ref-en.txt:93`-`110`、`:191`-`208`、`:261`-`281` |
| 片型映射（六段式 + 负向尾句） | `skills/h3-prompt-writing/references/studio-mapping.md:16`-`30`、`:72`-`78` |
| STEP 3 / STEP 7 / 门 3 / 重渲连锁 | `skills/story-short-generator/SKILL.md:268`-`327`、`:557`-`624`、`:626`-`675`、`:819`-`841` |
| 分组与 groupOrder | `skills/story-short-generator/SKILL.md:239`-`252`、`:797`-`803` |
| 档位与耗时 | `docs/minimax-h3-video-benchmark.md:16`-`24`、`:100`-`107` |
| 32kHz / 无 voice id / 跨调用无保证 / turbo 弱参考 | `docs/research/h3-audio-consistency.md:44`、`:132`-`136`、`:154`-`160`、`:181` |
| P0/P1 落地记录与已知边界 | `docs/h3-voice-consistency-plan.md:480`-`517`（2K/hires 未接 `:515`；skill 侧仍欠 `:516`） |
| fast + 参考音频端到端实测 | `e2e-out/voice-ref/report.json`（28.7s，抽音轨 backend=comfyui，`.flac`） |

> ⚠️ `docs/research/h3-audio-consistency.md` §5.2（`:214`-`224`）写的是 "参考音频可写但不可达"，那是 **P0 之前**的状态；P0/P1 已把通道打通（`docs/h3-voice-consistency-plan.md:480`-`505`、`README.md:437`-`444`）。引用该调研时不要把那一段当成现状。

## 附录 B：复现与核对命令

```bash
# 哪些实现声明了音频注入点（应为 14 份，且不含 -hires / -2k）
grep -l '"ref_audios"' workflows/minimax-h3-ref2v-*.json

# 每个 ref2v 实现：最长帧数 / 长度网格 / 是否带音频参考
node -e "const fs=require('fs');for(const f of fs.readdirSync('workflows').filter(x=>x.startsWith('minimax-h3-ref2v')&&x.endsWith('.json'))){const w=JSON.parse(fs.readFileSync('workflows/'+f));console.log(f,(w.constraints||{}).maxDurationFrames,JSON.stringify(w.lengthGrid),!!(w.params&&w.params.ref_audios))}"

# 本机有没有 ffmpeg / ffprobe（决定抽音轨走 wav 还是 flac）
which ffmpeg ffprobe

# 参考音频链路冒烟（真机，fast 档；产物落 e2e-out/voice-ref/）
node scripts/e2e-voice-ref.mjs --audio=/tmp/voice_sample.wav --length=124

# 接缝/响度（在 ComfyUI 容器内跑，依赖 av + numpy）
python3 e2e-out/ctx-test/measure_seam.py <A.mp4> <B.mp4> <outdir>
```

---

*本文档只做设计；未改任何代码。落地顺序建议：§8 取证（<1h）→ §7.1/7.2 skill 改动 → §7.3-7.5 增量 → 视 §8 结论决定是否默认开启。*
