# 分档提示词库（prompt bank）

> 契约：每个镜头的视频提示词按 `fast` / `balanced` / `quality` 三档持久化到画布；生成时按本次 `tier` 读取；升档重渲复用同一节点、不重写 prompt。
> **当前 story-short-generator / brand-promo-video-generator 的策略：三档写同一份完整 quality 提示词（逐字一致）**，换档只变采样。工具本身仍支持三段不同内容；是否写变体由片型 skill 决定。

## 1. 为什么需要

- 即使当前策略是三档同文，prompt 仍需要落画布：升档 / 降档 / 重渲时要能读回同一份文本，避免手抄丢失细节或改变镜头计划。
- 工具保留三段结构，是为了将来可以按档位写不同密度；当前片型 skill 选择三档同文，换取换档变量干净。
- 插件原先只把 `prompt` 记在视频节点的 `params` 里；升档时没有机器可读的「quality 版 prompt」，Agent 只能重写。
- prompt bank 把提示词变成**画布上的一等产物**：可见、可编辑、可按档读取、生成后自动回写。

## 2. 节点格式

- 节点：`kind: 'text'`，`params.promptBank = true`，`params.tiers = ['fast','balanced','quality']`（实际有内容的档），`params.promptFor` 关联的视频节点 id（可选）。
- 正文（稳定格式，`canvas_write_prompt_bank` 生成）：

```markdown
# S01 提示词（分档）

<!-- dsh-svs-prompt-bank v1 -->

## fast
……fast 档完整提示词……

## balanced
……balanced 档完整提示词……

## quality
……quality 档完整提示词……
```

- 解析：按行首 `## fast|balanced|quality` 分段；段内容保留换行。没有分档标题但整段非空 → 视为旧式单段 prompt（`raw`），任何档都原样使用并给 warning。
- 空段不写；**当前策略三档同文**（同一份 quality prompt 逐字复制）。如果将来改回按档位变体，三档仍必须保持同一镜头计划（景别 / 动作 / 台词 / 字幕 / 时长 / 续接关系不变），只调整描述密度。
- **旧库迁移**：已有三档不同文案的库，先用 `canvas_get_prompt(nodeId, tier="quality")` 读 quality，再用 `canvas_write_prompt_bank(nodeId=…, prompts={fast:q, balanced:q, quality:q})` 统一。

## 3. 读取与回退

请求档位 → 取段顺序：

1. 同档段；
2. 最近的**较低**档（quality 缺段 → balanced → fast）；
3. 最近的**较高**档（fast 缺段 → balanced → quality）。

回退时工具返回 `warnings`，视频节点记录 `params.prompt_fallback_from`。**不静默当成同档**。

## 4. 写入与持久化

- 显式建库：`canvas_write_prompt_bank(title, prompts, group='shot prompts', promptFor?, note?, nodeId?)`。更新已有库时按档合并：只补/改本次给出的档，未给出的档保留（避免单档更新冲掉其它档）。
- 生成时传 `prompt_node`：按 `tier` 读段；如果同时传了 `prompt`，以 `prompt` 为准并**回写该档段**。
- 只传 `prompt`：视频工具自动创建 / 更新该视频节点对应的 prompt bank（`params.promptFor = 视频节点 id`），返回 `promptNodeId`；`persist_prompt: false` 可关闭。
- 同一视频节点 `nodeId` 重渲且 `prompt` / `prompt_node` 都不传 → 沿节点 `params.prompt_node` 读回原库（升档最省参数路径）。
- 工具不会为图片生成自动建 prompt bank（角色卡 / 场景卡的 prompt 仍记在图片节点 `params.prompt`）。

## 5. 角色卡双版本（配套改动）

角色卡不再只按档位出一版，而是**每个角色固定两版**：

| 版本 | 形态 | 画幅 | 视频引用 |
|---|---|---|---|
| `single` | 单视图正面全身 | 2:3 | `fast` 档（硬门禁） |
| `three` | 三视图横排（正 / 侧 / 背） | 16:9 | `balanced` / `quality` 默认 |

- 节点用 `params.character` / `params.cardVariant` / `params.pairedNodeId` 配对；`comfy_generate_image` 的 `character` / `card_variant` / `paired_node_id` 参数写入。
- **视频引用按 STEP 0 用户选择**：`comfy_generate_video` 的 `ref_variant` 只接受显式 `single` / `three`（工具不按 tier 自动选）；`ref_variant` 由 `state.characterCardVariant` + 每镜 tier 推出（fast 镜强制 single）。两版都入库且带 `character` / `cardVariant` 元数据时，资产 id 也能按显式版本换；老资产没有元数据就先 `asset_to_canvas` 物化两版。
- 非 fast 档若自检命中参考图形态类污染（多角色副本、参考图版面 / 文字被投影、环境材质被替换），**先换同角色单视图卡重渲**（同 prompt / 同 seed 优先），再走 prompt 失败阶梯。
- 场景卡、道具卡仍只出单视图。

## 6. 测试

`scripts/smoke-prompt-bank.mjs`（假 ComfyUI HTTP）覆盖：

- 解析 / 序列化 / 按档取段与回退；
- `prompt_node` 按 tier 取段；缺档回退 warning；升档读取 quality 段；
- 只传 prompt 时自动建库、回指视频节点；同 `nodeId` 免 prompt 读回；
- 角色卡 `character` / `cardVariant` / `pairedNodeId` 双向配对；
- 视频 `ref_variant` 显式选版（single / three）；fast 镜强制 single，非 fast 档形态回退用 `ref_variant=single`。
