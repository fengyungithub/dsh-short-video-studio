# EP02 声线试镜记录（绛珠 / 神瑛）

> 日期：2026-10-26 ｜ 画布会话：`session-002884e3-29ba-44ca-b79f-b739766b87ed`
> 结论：**v2 通过用户听核**，两条声线已入库为 `voice:` 资产，EP02 已切 `existing` + `assetMode=library`，校验 0/0。

## 1. 三轮尝试

| 版本 | 提示词 | 结果 |
|---|---|---|
| v1 | 锁 A+B+C（按“视频片段”规则） | ❌ 首帧人物、中段/末帧变纯云海瀑布，人物消失 |
| v2 | 锁 A+B（去掉 C），写死 `static camera / no cut / subject remains in frame` | ✅ 人物全程在框、口型可见、无字幕；**用户听核通过**（有轻微环境底噪） |
| v3 | 锁 B + 棚拍后缀 + `AUDIO: only the voice; rest is digital silence` | 未采用（生成被中止；提示词留作“强制干声”备用） |

**根因**：`guofeng-xianxia` 的锁 C 是环境段（云海/瀑布/建筑）。把它放进 5 秒纯底试镜，模型会把镜头“拉出去”变成风景。⇒ 试镜**不能用 C**。

## 2. 通过版本的事实

| 角色 | 试镜视频 | 声线样本 | 时长 / 采样 |
|---|---|---|---|
| 绛珠 | `24fd3d7c-034e-4ff4-870a-84cf9cf46135` | `1c642566-26e0-4d5b-a8ba-f3706d79a2b6` | 5.184s / 32kHz stereo |
| 神瑛 | `ed5b2357-6d39-4289-b16d-eff2a3b884da` | `e22f2c25-7154-4922-bf66-768d46945a45` | 5.184s / 32kHz stereo |

- 档位：`balanced`；长度 124 帧；画幅 9:16。
- AI 视觉自检：单人、固定中近景、全程在框、口型可见、无字幕、纯中性背景（用 cv2 抽首/中/末帧核对）。
- 音频底噪（afconvert + numpy，100ms 窗 RMS）：
  - 绛珠：末尾约 **−50 dBFS**，中位 −41.5 dBFS；
  - 神瑛：末尾约 **−35 dBFS**，中位 −37.1 dBFS。
  - ⇒ 不是“数字静音”，有轻微环境底噪；用户接受为通过。

## 3. 规则修正（已写回仓库 skill）

1. `story-short-generator` STEP 3.5.1：试镜**只用锁 A+B，不带 C**；写死 `static camera / no cut / subject remains in frame`。
2. 若 A+B 仍带明显环境声：**v3 路径**——只带锁 B + 棚拍后缀，并在 `detailed_description` 写 `AUDIO: close-mic dry studio recording; only the voice; rest is digital silence`。
3. `references/styles/guofeng-xianxia.md`：视频段规则加“试镜例外”，避免以后又按“视频 = A+B+C”把试镜拉成风景。

## 4. 工具问题

- `extract_frame` 在本机调用返回 `缺少 prompt：请传 prompt，或传 prompt_node`（参数没有 prompt / prompt_node），无法抽帧；本次用 Python + cv2 抽帧做视觉自检。
- `extract_audio` 需要显式传 `sessionId`（`session-002884e3-…`）才成功，否则报 `sessionId required`。
- 两个工具问题不阻塞本次试镜，但应登记修复。

## 5. 下一步

1. 两条声线已入库：
   - 绛珠 `voice:6a4ff47b59671b7e`
   - 神瑛 `voice:c6fc197a2cf0f029`
2. EP02 已切 `assetMode=library` + `voicePlan=existing`；对白 `voiceRef=voice:`；`npm run validate:bridge`：EP002 0 error / 0 warning。
3. 角色/场景/道具也同步入库（见 [EP02 桥接报告](../ep002-bridge/report.md) §5）。
4. 若之后要求“强制干声”，再跑 v3（只带锁 B + 数字静音声明）；否则 v2 即为当前声线基线。
