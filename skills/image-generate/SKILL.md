# 图片生成（image-generate）

最简单的图片生成流程：解析任务消息里的字段，调用 ComfyUI 图片工具出图，产物落画布并回报结果。支持**文生图（t2i）**与**参考图生图（i2i，FLUX.2 ReferenceLatent 改绘）**。

## 工具映射（本插件工具，已注册）

| 用途 | 用这个工具 |
|---|---|
| 文生图（无参考，FLUX） | `comfy_generate_image`（= capability `image.text2image` 的别名） |
| 参考图生图（改绘：换装/改背景/风格迁移/构图微调） | `comfy_render`（capability=`image.image2image` + `ref_nodes`） |
| 通用渲染（显式 capability/workflow/mode） | `comfy_render` |
| 查可用能力与工作流（换模型前必查） | `comfy_list_workflows` |
| 读画布节点 / 列表（核对参考/产物存在） | `canvas_get_node` / `canvas_list_nodes` |
| 需要用户选择时 | `ask_user_question`（选项卡） |

不要写死模型名：默认工作流由能力注册表 `preferred` 决定；换模型先 `comfy_list_workflows` 核对再 `comfy_render` 显式指定 `workflow`。

## 输入契约（任务消息结构）

发送进会话的任务消息由输入框草稿直接构成，结构为：**`/image-generate` 斜杠命令行（加载本 skill，参数以 `key=value` 内联）+ 一个空行 + 用户 prompt 正文**。示例：

t2i 文生图：

```
/image-generate type=t2i ratio=16:9 size=1344x768 count=2

一只戴草帽的橘猫坐在海边礁石上，黄昏逆光，电影感胶片色调
```

i2i 参考图生图（参考图必须是当前会话画布的图片节点 id）：

```
/image-generate type=i2i tier=quality count=1 refs=c71ee706-7256-4258-9215-4f3e69e31ffe

Keep the flying pig exactly as it is, only change the sky from daytime blue to a warm golden sunset
```

| 字段 | 含义 | 示例 |
|---|---|---|
| prompt（空行后的正文） | 画面描述（t2i）或「保留什么、改什么」的改动描述（i2i） | 一只戴草帽的橘猫… |
| `type` | `t2i`（文生图）或 `i2i`（参考图生图） | t2i |
| `tier` | 档位（仅 i2i）：`quality` 成片 20 步 / `fast` 调试 8 步 Turbo LoRA | quality |
| `ratio` | 画面比例（仅 t2i） | 16:9 |
| `size` | 显式宽×高，已 snap32、`x` 分隔（仅 t2i） | 1344x768 |
| `count` | 生成张数（1–4） | 2 |
| `refs` | 画布节点 id（i2i，单个，作 `ref_nodes`） | c71ee706-… |

## 流程

1. **解析字段**：从任务消息读出参数头各字段与空行后的 prompt 正文。缺字段用默认值（类型 t2i、比例 16:9、张数 1）；无 prompt 则回报缺什么，不瞎猜。
2. **校验前置**：`canvas_get_node` / `canvas_list_nodes` 核对参考节点存在且为图片节点（i2i 必须有**恰好 1 个** `refs`；多个或缺失都回报「请上传/提供一张参考图节点 id」，不拿其它节点顶替）。参考图硬规则见下。
3. **分辨率**：
   - t2i：直接传消息里的 `尺寸`（`width`/`height`）；没带则按比例 + 长边 1344 推导并 snap32（16:9→1344x768、9:16→768x1344、1:1→1344x1344）。
   - i2i：**尺寸跟随参考图**（工作流内缩放到 ≤1MP），不传 width/height。
4. **调用生成**（按类型二选一）：
   - t2i：`comfy_generate_image(prompt, width=…, height=…, count=张数, title='手动 t2i · 比例', group='手动生成')`。
   - i2i：`comfy_render(capability='image.image2image', mode=档位(quality/fast), prompt=改动描述, ref_nodes=[参考节点 id], count=张数, title='手动 i2i · 档位 · 参考改绘', group='手动生成')`。档位取消息 `tier` 字段（缺省 quality）；调试/挑构图用 fast（8 步 Turbo LoRA，细节弱于 quality 但快 5×+）。
5. **回报结果**：工具已把产物写回画布；回复里给出图片节点标题、媒体相对路径与「画布」tab 入口，一句话说明用了哪个能力与档位。
6. **失败不盲重试**：失败先简化改动描述 / 换档位（fast↔quality）/ 换参考图再重试；同一请求不要原样重复提交。

## 提示词建议

- t2i：中文描述亦可，英文长描述通常更稳；包含主体、动作、环境光、镜头/画幅、风格材质关键词。
- i2i：英文描述通常更稳，格式「Keep/保留 X exactly as it is, only 改动 Y…」。明确「保留什么、改什么、别加什么（no extra characters / no text）」，避免模型添加新角色或文字。
- 多张（count>1）用于挑图：prompt 不变，种子由工作流内部随机。
- 画布/资产库已有角色卡、场景卡想照着出图时：选 i2i 路径，参考图用资产 id 或画布节点 id，别用三视图拼图。

## 参考图硬规则（i2i 同样遵守）

- **单视图**：参考图里有几个身体，结果就倾向出现几个角色；三视图拼图会产生角色副本。只传单视图。
- **图内零文字**：参考图上的角色名/标注/水印会被模型保留或转印；文字只写画布节点标题或资产库元数据。
- i2i 是「以图作图」：描述里写明哪些特征要保留（否则可能被改），要移除什么（否则可能被保留）。

## 与片型 skill 的边界

本 skill 只承担「手动生成图片」（文生图 / 参考图改绘），不产出简报/大纲/角色卡/镜头表，不做逐镜编排。需要完整短剧/动画/品牌片流程时，交给 `3d-animation-short-generator` 或 `brand-promo-video-generator`。
