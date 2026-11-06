```json
{
  "contract": "episode-package/v1",
  "episode": {
    "number": 1,
    "id": "EP001",
    "title": "签字",
    "sourceScript": "episodes/ep001.md",
    "sourceDialogueCount": 6,
    "scriptVersion": 1,
    "packageVersion": 1,
    "episodeVersion": 1
  },
  "targetSeconds": 45,
  "shotBudget": 8,
  "paywall": false,
  "hookType": "suspense",
  "prevRecap": "第 1 集，无前情",
  "nextTeaser": "董事会前夜，顾言第一次主动找她",
  "beats": [
    { "id": "B01", "label": "协议被推到桌心，开场钩子", "sceneId": "SC01" },
    { "id": "B02", "label": "顾言羞辱并逼签", "sceneId": "SC01" },
    { "id": "B03", "label": "林晚平静反击", "sceneId": "SC01" },
    { "id": "B04", "label": "林晚亮出底牌暗示", "sceneId": "SC01" },
    { "id": "B05", "label": "顾言失控拍桌", "sceneId": "SC01" },
    { "id": "B06", "label": "走廊收尾：林晚宣战", "sceneId": "SC02" }
  ],
  "scenes": [
    {
      "id": "SC01",
      "intExt": "内",
      "location": "总裁办公室",
      "dayNight": "日",
      "cast": ["林晚", "顾言"],
      "event": "林晚递上离婚协议，顾言逼她净身出户",
      "escalation": "从冷嘲到一掌拍桌",
      "landmarks": [
        { "name": "desk", "position": "画面中" },
        { "name": "door-frame", "position": "右侧 1/3" },
        { "name": "drawer", "position": "右下" }
      ],
      "lightBaseline": "冷白顶光主光 + 右侧窗光补光"
    },
    {
      "id": "SC02",
      "intExt": "内",
      "location": "走廊",
      "dayNight": "日",
      "cast": ["林晚"],
      "event": "门合上，林晚在窗光里停步宣战",
      "escalation": "从沉默到宣战",
      "landmarks": [
        { "name": "window-light", "position": "左侧" },
        { "name": "elevator", "position": "画面中" }
      ],
      "lightBaseline": "顶部暖光 + 左侧窗光"
    }
  ],
  "dialogue": [
    { "no": 1, "speaker": "顾言", "text": "签了它，你一分钱都别想带走。", "emotion": "居高临下", "targetSeconds": 4.0, "subtitle": "none", "voiceRef": "voice:demo-gu", "sfx": [] },
    { "no": 2, "speaker": "林晚", "text": "我只要我该得的那一份。", "emotion": "平静", "targetSeconds": 3.5, "subtitle": "none", "voiceRef": "voice:demo-lin", "sfx": [] },
    { "no": 3, "speaker": "顾言", "text": "你拿什么跟我算这笔账？", "emotion": "讥讽", "targetSeconds": 3.5, "subtitle": "none", "voiceRef": "voice:demo-gu", "sfx": [] },
    { "no": 4, "speaker": "林晚", "text": "拿你不敢给董事会看的东西。", "emotion": "冷笑", "targetSeconds": 4.0, "subtitle": "none", "voiceRef": "voice:demo-lin", "sfx": [] },
    { "no": 5, "speaker": "顾言", "text": "站住！把协议捡起来！", "emotion": "失控", "targetSeconds": 3.5, "subtitle": "none", "voiceRef": "voice:demo-gu", "sfx": [] },
    { "no": 6, "speaker": "林晚", "text": "那就让他慢慢等着吧。", "emotion": "冷", "targetSeconds": 4.0, "subtitle": "none", "voiceRef": "voice:demo-lin", "sfx": [] }
  ],
  "shots": [
    { "shotId": "S01", "seconds": 4.6, "sceneId": "SC01", "speaker": null, "line": null, "performance": "协议推到桌心，指节发白", "shotSizeCamera": "特写 / 锁定", "screenPositions": "协议：桌中；手：画面下缘", "chainIntent": "起链", "beat": "钩子", "beatId": "B01" },
    { "shotId": "S02", "seconds": 5.2, "sceneId": "SC01", "speaker": "顾言", "line": "签了它，你一分钱都别想带走。", "performance": "靠椅背，眼皮都不抬", "shotSizeCamera": "中景 / 轻微下压", "screenPositions": "顾言：右中景；门框：右1/3", "chainIntent": "接 S01", "beat": "爽点-打脸", "beatId": "B02" },
    { "shotId": "S03", "seconds": 5.2, "sceneId": "SC01", "speaker": "林晚", "line": "我只要我该得的那一份。", "performance": "平静，把笔推回去", "shotSizeCamera": "近景 / 缓推", "screenPositions": "林晚：左前景", "chainIntent": "接 S02", "beat": "反转", "beatId": "B03" },
    { "shotId": "S04", "seconds": 5.2, "sceneId": "SC01", "speaker": "顾言", "line": "你拿什么跟我算这笔账？", "performance": "起身绕过桌角", "shotSizeCamera": "中景 / 横移跟", "screenPositions": "顾言：右→中；林晚：左", "chainIntent": "接 S03", "beat": "危机", "beatId": "B03" },
    { "shotId": "S05", "seconds": 5.2, "sceneId": "SC01", "speaker": "林晚", "line": "拿你不敢给董事会看的东西。", "performance": "不躲，抬下巴，眼神扫过抽屉", "shotSizeCamera": "近景 / 锁定", "screenPositions": "林晚：左中景；抽屉：右下", "chainIntent": "接 S04", "beat": "揭露", "beatId": "B04" },
    { "shotId": "S06", "seconds": 4.6, "sceneId": "SC01", "speaker": "顾言", "line": "站住！把协议捡起来！", "performance": "一掌拍桌，协议滑落桌沿", "shotSizeCamera": "中景 / 急推", "screenPositions": "顾言：中；协议：桌沿", "chainIntent": "接 S05", "beat": "危机", "beatId": "B05" },
    { "shotId": "S07", "seconds": 3.0, "sceneId": "TRANSITION", "speaker": null, "line": null, "performance": "镜头随门缝合拢，走廊灯亮起", "shotSizeCamera": "特写→上摇 / 转场", "screenPositions": "门框：画面中；走廊：后景", "chainIntent": "转场", "beat": "转场", "beatId": "B06" },
    { "shotId": "S08", "seconds": 4.6, "sceneId": "SC02", "speaker": "林晚", "line": "那就让他慢慢等着吧。", "performance": "窗光里停步，轻声，抬眼", "shotSizeCamera": "近景 / 侧跟", "screenPositions": "林晚：右中景；窗光：左", "chainIntent": "起链", "beat": "钩子", "beatId": "B06" }
  ],
  "assets": {
    "characters": [
      { "name": "林晚", "state": "常服-白衬衫", "episodes": "1" },
      { "name": "顾言", "state": "深灰西装", "episodes": "1" }
    ],
    "scenes": [
      { "name": "总裁办公室", "assetId": "scene:exp-office", "landmarks": [{ "name": "desk", "position": "画面中" }, { "name": "door-frame", "position": "右侧 1/3" }, { "name": "drawer", "position": "右下" }], "lightBaseline": "冷白顶光主光 + 右侧窗光补光" },
      { "name": "走廊", "assetId": "scene:exp-corridor", "landmarks": [{ "name": "window-light", "position": "左侧" }, { "name": "elevator", "position": "画面中" }], "lightBaseline": "顶部暖光 + 左侧窗光" }
    ],
    "props": [],
    "voices": [
      { "character": "林晚", "voiceAssetId": "voice:demo-lin", "source": "audition", "tier": "balanced", "seed": 1001, "episodes": "1" },
      { "character": "顾言", "voiceAssetId": "voice:demo-gu", "source": "audition", "tier": "balanced", "seed": 1002, "episodes": "1" }
    ],
    "toBuild": []
  },
  "params": {
    "styleId": "cinematic-live-action",
    "aspectRatio": "9:16",
    "duration": "45 秒（实验例外，见圣经 §1）",
    "audioMode": "dialogue-led",
    "subtitleMode": "none",
    "videoTier": "balanced",
    "imageTier": "balanced",
    "characterCardVariant": "single",
    "deliveryQuality": "native",
    "reviewMode": "batch",
    "voicePlan": "existing",
    "storyboardMode": "text",
    "groupOrderVersion": ["story planning", "character cards", "voice auditions", "scene cards", "prop cards", "shot table", "text storyboards", "shot prompts", "shot clips", "final delivery"],
    "assetMode": "draft",
    "bgmMode": "none"
  },
  "budget": { "estimatedMinutes": 25, "shotCount": 8, "dialogueCount": 6 },
  "gates": { "packageApprovedAt": null, "approvedBy": null, "changeApprovedAt": null, "changeRequestId": "" }
}
```

# EP001 集制作包

## ① 集元数据
- 集号/标题：EP001《签字》
- 目标时长：45s（`episodeSecondsException`：实验项目）｜镜数预算：8
- 付费卡点：否 ｜ 集内主干节拍：钩子 → 逼签 → 反击 → 揭露 → 失控 → 宣战
- 前情：第 1 集，无
- 下集预告：董事会前夜，顾言第一次主动找她
- 合规：无
- **beat 清单**：B01 开场钩子 / B02 逼签 / B03 反击 / B04 底牌 / B05 失控 / B06 宣战（详见机读块 `beats[]`）

## ② 场次表
| 场 | 内外/地点/日夜 | 出场 | 事件 | 冲突升级 |
|---|---|---|---|---|
| SC01 | 内 · 总裁办公室 · 日 | 林晚、顾言 | 林晚递上离婚协议，顾言逼她净身出户 | 从冷嘲到一掌拍桌 |
| SC02 | 内 · 走廊 · 日 | 林晚 | 门合上，她在窗光里停步宣战 | 从沉默到宣战 |

## ③ 对白表
| # | 说话人 | 台词（逐字） | 情绪 | 目标时长 | 字幕 |
|---|---|---|---|---|---|
| 1 | 顾言 | 签了它，你一分钱都别想带走。 | 居高临下 | 4.0s | none |
| 2 | 林晚 | 我只要我该得的那一份。 | 平静 | 3.5s | none |
| 3 | 顾言 | 你拿什么跟我算这笔账？ | 讥讽 | 3.5s | none |
| 4 | 林晚 | 拿你不敢给董事会看的东西。 | 冷笑 | 4.0s | none |
| 5 | 顾言 | 站住！把协议捡起来！ | 失控 | 3.5s | none |
| 6 | 林晚 | 那就让他慢慢等着吧。 | 冷 | 4.0s | none |

> 核算：台词 68 字 ÷ 4 字/秒 ≈ 17s 口播；6 个对白镜共 22.6s + 2 个非对白镜 7.6s + 转场 3.0s ≈ 38s；加反应尾 ≈ 45s ✅

## ④ 8 列镜头意图
| 镜号/时长 | 场 | 说话人&台词 | 表演意图 | 景别/运镜 | 空间位置 | 续接意图 | beatId & 节拍 |
|---|---|---|---|---|---|---|---|
| S01 / 4.6s | SC01 | — | 协议推到桌心，指节发白 | 特写 / 锁定 | 协议：桌中；手：画面下缘 | 起链 | B01 钩子 |
| S02 / 5.2s | SC01 | 顾言：签了它，你一分钱都别想带走。 | 靠椅背，眼皮都不抬 | 中景 / 轻微下压 | 顾言：右中景；门框：右1/3 | 接 S01 | B02 爽点-打脸 |
| S03 / 5.2s | SC01 | 林晚：我只要我该得的那一份。 | 平静，把笔推回去 | 近景 / 缓推 | 林晚：左前景 | 接 S02 | B03 反转 |
| S04 / 5.2s | SC01 | 顾言：你拿什么跟我算这笔账？ | 起身绕过桌角 | 中景 / 横移跟 | 顾言：右→中；林晚：左 | 接 S03 | B03 危机 |
| S05 / 5.2s | SC01 | 林晚：拿你不敢给董事会看的东西。 | 不躲，抬下巴，眼神扫过抽屉 | 近景 / 锁定 | 林晚：左中景；抽屉：右下 | 接 S04 | B04 揭露 |
| S06 / 4.6s | SC01 | 顾言：站住！把协议捡起来！ | 一掌拍桌，协议滑落桌沿 | 中景 / 急推 | 顾言：中；协议：桌沿 | 接 S05 | B05 危机 |
| S07 / 3.0s | TRANSITION | — | 镜头随门缝合拢，走廊灯亮起 | 特写→上摇 / 转场 | 门框：画面中；走廊：后景 | 转场 | B06 转场 |
| S08 / 4.6s | SC02 | 林晚：那就让他慢慢等着吧。 | 窗光里停步，轻声，抬眼 | 近景 / 侧跟 | 林晚：右中景；窗光：左 | 起链 | B06 钩子 |

## ⑤ 本集资产清单
- 角色
  - 林晚 · 常服-白衬衫 · `TO-BUILD`（阶段 C 建 single + three）
  - 顾言 · 深灰西装 · `TO-BUILD`（阶段 C 建 single + three）
- 场景
  - 总裁办公室 · `scene:exp-office` · 地标：`desk:画面中`、`door-frame:右侧1/3`、`drawer:右下`
  - 走廊 · `scene:exp-corridor` · 地标：`window-light:左侧`、`elevator:画面中`
- 道具
  - 离婚协议 · 只写文字描述（不建卡）
- 声线（来自阶段 C 台账）
  - 林晚 · `voice:demo-lin`（实验占位；阶段 C 建立后替换）
  - 顾言 · `voice:demo-gu`（同上）

## ⑥ 生产参数预填
- 画面比例：9:16 ｜ 集时长：45s（实验例外）｜ 音频模式：dialogue-led ｜ 语言：中文
- 画面内字幕：none
- 视频档位：balanced（实验干跑可用 fast）｜ 图片档位：balanced ｜ 角色卡引用版本：single ｜ BGM 模式：none
- 片段审查节奏：batch ｜ 交付画质：原生
- 声线方案：existing
- 分镜模式：text
- 视觉风格：cinematic-live-action
- 场景数：2（1 个转场镜 S07）｜ 镜数：8 ｜ 对白：6 句 ｜ 台词字数：68
- 成本估计：8 镜 × 166s ≈ 22 min；重渲系数 1.3 ⇒ ≈ 29 min
- 合规：无
