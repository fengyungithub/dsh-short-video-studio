---
name: video-generate
description: 把「提示词 + 参考图/首帧图 + 尺寸/档位/时长/比例」等参数生成为一段单镜头视频。支持 r2v（参考图生成，ref_nodes 绑定角色/场景）与 i2v（首帧/末帧生成，first/last_frame 串联）。适用于「输入框手动生成」这条轻量链路：用户在输入框用 `/video-generate` 斜杠命令加载本 skill、在工具条选参数、写 prompt，发送后由本 skill 解析命令行参数并调度 comfy_generate_video 出片。不适用于完整片型流程（简报/大纲/镜头表/分镜/逐镜交付），那些请用 3d-animation-short-generator 或 brand-promo-video-generator。
whenToUse: |
  用户消息以 `/video-generate` 斜杠命令开头（内联 `type/tier/ratio/size/length/refs/first/last` 参数 + 空行后的 prompt 正文），或用户要求「用输入框手动生成一段视频 / 参考图生成 / 首帧生成 / 单镜头出片」时使用。档位由注册表决定（一个能力多档，具体见 `comfy_list_workflows`；旧参数 `mode=` 为兼容别名）。
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
| `tier` | 档位：`fast`（调试 / 调构图，长边 832）/ `balanced`（日常，画质与耗时平衡，长边 1344）/ `quality`（成片，长边 1344） | quality |
| `ratio` | 画面比例 | 16:9 |
| `size` | 显式宽×高（已 snap32，`x` 分隔） | 1344x768 |
| `length` | 帧数（24fps） | 124（≈5 秒） |
| `refs` | 画布节点 id 列表（r2v，作 `ref_nodes`，逗号分隔） | node-a,node-b |
| `first` / `last` | 画布节点 id（i2v，作 `first_frame_node` / `last_frame_node`） | node-c |

**档位口径**：`tier=<档位名>`，**可用档位以 `comfy_list_workflows` 为准**（不要假设档位数量/名称，用户增删工作流后会变）；**建议显式传 `tier=`，不要依赖缺省**（缺省 `quality` 成本最高）。旧参数 `mode=` 保留为兼容别名——`mode=fast|balanced|quality` 与 `tier` 等价，新写法一律用 `tier=`。

**能力可用性（失败梯度）**：不同能力的可用档位可以不同（**以 `comfy_list_workflows` 为准，不要假设**）——请求该能力没有的档时工具**会显式报错并列出可用档位**（不会静默换档）。遇到这类报错就**改请求可用档位**，**不要原样重试同一请求**。

## 流程

1. **解析字段**：从任务消息读出参数头各字段与空行后的 prompt 正文。`type` 是**必填**（r2v / i2v，工具面不接受缺省），缺失就按下方默认值 `r2v` 处理并在回报里点明。其它字段缺省值：档位 quality、比例 16:9、时长 124；关键字段缺失（r2v 缺参考图、i2v 缺首帧、无 prompt）则回报缺什么，不瞎猜。消息里写 `mode=` 也接受（兼容别名，等同 `tier=`），但回报时按 `tier` 口径说。
2. **校验前置**：`canvas_get_node` 或 `canvas_list_nodes` 确认参考图/首末帧节点存在且为图片节点；缺失就回报用户「请先上传参考图/首帧」。
3. **分辨率**：直接传消息里的 `尺寸`（`width`/`height`，已 snap32）。若消息没带尺寸，则按比例 + 档位推导：`fast` 长边 832、`balanced`/`quality` 长边 1344，snap32。
4. **调用生成**（按类型二选一）：
   - r2v：`comfy_generate_video(prompt, type='r2v', tier=档位, width, height, length=时长, ref_nodes=[参考图节点...], title='手动 r2v · 档位 · 比例', group='手动生成')`
   - i2v：`comfy_generate_video(prompt, type='i2v', tier=档位, width, height, length=时长, first_frame_node=首帧, last_frame_node=末帧(可选), title='手动 i2v · 档位 · 比例', group='手动生成')`
   （**`type` 必须原样透传**（r2v/i2v）——它决定用参考绑定还是首末帧串联，工具会据此校验参数：r2v 带首/末帧、i2v 带 `ref_nodes` 都会直接报错。`tier` 也显式传；i2v 无 `balanced`，见上方失败梯度。）
5. **回报结果**：工具已把产物写回画布；回复里给出视频节点标题、媒体相对路径与「画布」tab 入口。工具返回带 `tier` / `implementation` / `resolution`，**如实回报实际用到的档位与实现 id**（透明化：用户选的策略可能把该档解析到不同实现，别只复述请求的档位）——一句话说明用了哪个能力、哪个档位、哪个实现；有 `warnings` 也一并说明。
6. **失败不盲重试**：失败先看报错类型——**档位缺失类报错**（如 i2v 请求 `balanced`）直接改请求可用档位；其它失败再改锚点 / 缩时长 / 改档（升档修字准；降档省成本，注意 i2v 无 `balanced`）/ 简化动作后重试。同一请求不要原样重复提交。

## 参考图硬规则（严格遵守）

- **单视图**：参考图里有几个身体，成片就倾向出现几个角色。三视图拼图会产生角色副本，prompt 里声明「同一角色」无效——只传单视图。
- **图内零文字**：参考图上的角色名/「正面·侧面」/FRONT VIEW/水印会被视频模型印进成片；文字只写画布节点标题或资产库元数据。
- **多角度无增量**：单张正面卡足以支撑转身/走远；确需多角度时把多张单视图分别放进不同 `ref_nodes` 槽位，绝不拼成一张图。
- **first_frame 仅同场景续接**：跨场景只传角色卡 + 场景卡，不带上一镜末帧。

## 与片型 skill 的边界

本 skill 只承担「一段视频」的手动生成，不产出简报/大纲/镜头表/分镜、不做逐镜编排与成片拼接。需要完整短剧/动画/品牌片流程时，交给 `3d-animation-short-generator` 或 `brand-promo-video-generator`。
