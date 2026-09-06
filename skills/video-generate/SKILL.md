---
name: video-generate
description: 把「提示词 + 参考图/首帧图 + 尺寸/档位/时长/比例」等参数生成为一段单镜头视频。支持 r2v（参考图生成，ref_nodes 绑定角色/场景）与 i2v（首帧/末帧生成，first/last_frame 串联）。适用于「输入框手动生成」这条轻量链路：用户在输入框用 `/video-generate` 斜杠命令加载本 skill、在工具条选参数、写 prompt，发送后由本 skill 解析命令行参数并调度 comfy_generate_video 出片。不适用于完整片型流程（简报/大纲/镜头表/分镜/逐镜交付），那些请用 3d-animation-short-generator 或 brand-promo-video-generator。
whenToUse: |
  用户消息以 `/video-generate` 斜杠命令开头（内联 `type/tier/ratio/size/length/refs/first/last` 参数 + 空行后的 prompt 正文），或用户要求「用输入框手动生成一段视频 / 参考图生成 / 首帧生成 / 单镜头出片」时使用。
---

# 参考视频生成（video-generate）

最简单镜头视频生成流程：解析任务消息里的字段，校验前置条件，调用 ComfyUI 视频工具出片，产物落画布并把结果回报给用户。本 skill 只做「一段视频」，不做剧本、镜头表、分镜等完整片型编排。

## 工具映射（本插件工具，已注册）

| 用途 | 用这个工具 |
|---|---|
| 生成单镜头视频（自带声音，AV 模型） | `comfy_generate_video` |
| 查可用能力与工作流（换模型前必查） | `comfy_list_workflows` |
| 读画布节点 / 列表（核对参考图存在） | `canvas_get_node` / `canvas_list_nodes` |
| 抽帧（i2v 取末帧做续接等） | `extract_frame` |
| 通用渲染（显式 capability/workflow） | `comfy_render` |
| 需要用户选择时 | `ask_user_question`（选项卡） |

不要写死模型名：默认工作流由能力注册表 `preferred` 决定；换模型先 `comfy_list_workflows` 核对再 `comfy_render` 显式指定 `workflow`。

## 输入契约（任务消息结构）

发送进会话的任务消息由输入框草稿直接构成，结构为：**`/video-generate` 斜杠命令行（加载本 skill，参数以 `key=value` 内联）+ 一个空行 + 用户 prompt 正文**。示例：

```
/video-generate type=r2v tier=quality ratio=16:9 size=1344x768 length=124 refs=node-a,node-b

一只橘猫在夕阳天台伸懒腰
```

| 字段 | 含义 | 示例 |
|---|---|---|
| prompt（空行后的正文） | 画面描述（用户输入框原文） | 一只橘猫在夕阳天台伸懒腰 |
| `type` | `r2v`（参考图生成）或 `i2v`（首/末帧生成） | r2v |
| `tier` | `quality`（成片）或 `fast`（调试） | quality |
| `ratio` | 画面比例 | 16:9 |
| `size` | 显式宽×高（已 snap32，`x` 分隔） | 1344x768 |
| `length` | 帧数（24fps） | 124（≈5 秒） |
| `refs` | 画布节点 id 列表（r2v，作 `ref_nodes`，逗号分隔） | node-a,node-b |
| `first` / `last` | 画布节点 id（i2v，作 `first_frame_node` / `last_frame_node`） | node-c |

## 流程

1. **解析字段**：从任务消息读出参数头各字段与空行后的 prompt 正文。缺字段时先用可用的默认值（档位 quality、比例 16:9、时长 124），关键字段缺失（r2v 缺参考图、i2v 缺首帧、无 prompt）则回报缺什么，不瞎猜。
2. **校验前置**：`canvas_get_node` 或 `canvas_list_nodes` 确认参考图/首末帧节点存在且为图片节点；缺失就回报用户「请先上传参考图/首帧」。
3. **分辨率**：直接传消息里的 `尺寸`（`width`/`height`，已 snap32）。若消息没带尺寸，则按比例 + 档位推导：quality 长边 1344、fast 长边 832，snap32。
4. **调用生成**（按类型二选一）：
   - r2v：`comfy_generate_video(prompt, mode=档位, width, height, length=时长, ref_nodes=[参考图节点...], title='手动 r2v · 档位 · 比例', group='手动生成')`
   - i2v：`comfy_generate_video(prompt, mode=档位, width, height, length=时长, first_frame_node=首帧, last_frame_node=末帧(可选), title='手动 i2v · 档位 · 比例', group='手动生成')`
5. **回报结果**：工具已把产物写回画布；回复里给出视频节点标题、媒体相对路径与「画布」tab 入口，一句话说明用了哪个能力与档位。
6. **失败不盲重试**：失败先改锚点/缩时长/降档（quality→fast）/简化动作，再重试；同一请求不要原样重复提交。

## 参考图硬规则（严格遵守）

- **单视图**：参考图里有几个身体，成片就倾向出现几个角色。三视图拼图会产生角色副本，prompt 里声明「同一角色」无效——只传单视图。
- **图内零文字**：参考图上的角色名/「正面·侧面」/FRONT VIEW/水印会被视频模型印进成片；文字只写画布节点标题或资产库元数据。
- **多角度无增量**：单张正面卡足以支撑转身/走远；确需多角度时把多张单视图分别放进不同 `ref_nodes` 槽位，绝不拼成一张图。
- **first_frame 仅同场景续接**：跨场景只传角色卡 + 场景卡，不带上一镜末帧。

## 与片型 skill 的边界

本 skill 只承担「一段视频」的手动生成，不产出简报/大纲/镜头表/分镜、不做逐镜编排与成片拼接。需要完整短剧/动画/品牌片流程时，交给 `3d-animation-short-generator` 或 `brand-promo-video-generator`。
