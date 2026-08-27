# 多渠道交付设计：让 TUI / 飞书也能看到画布产物

> 问题：当前插件的产物（角色卡 / 场景卡 / 分镜图 / 视频片段 / 拼接成片）**只在 Web 的「画布」tab 可见**。当会话跑在 TUI 或飞书（dsh-lark）channel 时，用户看不到产物。
> 本文定位根因，基于对社区飞书插件 `dsh-lark` 源码的实读，给出**不改 dsh-lark、不在插件核心里做渠道探测**的最终方案。

---

## 0. 最终结论（先看这个）

- 产物送达飞书，**只有一条路**：模型调用 dsh-lark 给每个 agent 注册的 `send_file(path)` 工具。dsh-lark 不向 host 提供任何「出站服务」（全仓搜不到 `channelOutbound`），所以**插件 hook 无法主动推文件**。
- 因此方案是「**hook 备路径 + GUIDANCE 让模型推**」：插件工具结果已带 `media`（相对路径）/ `absPath` / `mediaType` / `bytes`；GUIDANCE 告诉模型——媒体产物先 `send_file` 送达、再 `ask_user_question` 提问，文本产物只写进回复。
- 本方案**不改 dsh-lark、不改 SKILL.md（流程 skill）、只改 GUIDANCE**。

---

## 1. 根因：交付层与「Web 画布 tab」耦合，且各渠道渲染能力不同

当前插件把「生产 / 存储」与「展示」合二为一，展示只有一种实现：

```
产物落盘  <workspace>/canvas/<sid>/project.json + 媒体文件
    │
    ├─ 媒体经 /dsh-short-video-studio/media?token=&path= 伺服（仅本机 Web）
    │
    └─ 唯一渲染器 = Web GUI 的「画布」tab（lib/client.js 的 conversation.view 槽，iframe）
```

而 Agent 工具的 `output.render` 只返回纯文本：

```
已生成视频节点 <uuid>
相对路径(send_file 交付): canvas/<sid>/<uuid>.mp4
绝对路径(终端打开): /abs/.../canvas/<sid>/<uuid>.mp4
媒体: video/mp4 · 3.2 MiB
```

三个渠道拿到它的下场各不相同：

| 渠道 | 能看到画布 tab？ | 能渲染工具结果里的图片/视频块？ | 能送达产物的机制 |
|---|---|---|---|
| Web | ✅ iframe「画布」 | ✅（web 渲染器支持 image 块 + `<video>`） | `/media` URL |
| TUI | ❌ | 无视频块；图片块视终端而定 | **绝对路径**（`open` / `cp`） |
| 飞书 dsh-lark | ❌ | ❌ **只渲染 text 块**（见 §2） | **`send_file(path)`**（渠道注册的工具） |

结论：**产物可见性被绑定在 Web 画布 tab 上**，而三个渠道的「最后一公里」各不相同。修复的关键不是给每个渠道各写一个渲染器，而是：**插件把产物发布成渠道无关的契约（相对路径 + 绝对路径 + 媒体类型 + 字节数），把「怎么呈现」交还各渠道已有的机制。**

---

## 2. 飞书 dsh-lark 的实读结论（决定方案形状）

读了 `dsh-lark` 的 `src/outbound.ts` / `src/host.ts` / `src/outbound-file.ts` / `src/bridge.ts` / `src/questions.ts` / `src/files.ts`：

1. **出站只渲染文本。** `host.ts` 的 `toolResultText()` 与 `assistantText()` 都只 `filter(inner => inner.type === 'text')`。工具结果或助手回复里的 `{type:'image', attachment}` 内容块在飞书会被**静默丢弃**。→ 想靠「工具结果返回 image 块」让飞书看到图片，**不可行**。

2. **飞书的产物送达机制是 `send_file`。** 渠道给每个 agent 上下文注册一个 `send_file(path)` 工具（`outbound-file.ts` 的 `SEND_FILE_TOOL`），模型调用它把**工作区内的文件**发到当前聊天：
   - 私聊（p2p）：直接发；
   - 群聊：先弹审批卡（`bridge.ts:2090` `chatType !== 'p2p'` 才 `askFileSend`），批准后才发；
   - 走 SDK 的 media 路径（`bridge.ts` `{ file: { source: bytes, fileName } }`）——落到飞书是 **file 消息**。图片 file 消息通常能预览，**视频 file 消息大概率只能下载、无内联播放（待实测）**，文档类只能下载；
   - 单文件上限**默认 20 MiB，但可配**（`config.ts` `maxSendFileBytes`，`z.number().default(20*1024*1024)`）；路径做 `resolve → realpath → isWithinContainer` 强校验，只接受工作区内文件。

3. **关键对齐点：插件产物已经是「工作区内文件」，且工具返回的 `media` 就是 `send_file` 能直接吃的相对路径。** 插件把媒体写到 `join(root, 'canvas', sessionId, filename)`（`root` 即工作区），节点 `media` 存 `canvas/<sid>/<file>`。而且 dsh-lark 给 agent 设 `meta.cwd = workspace.path`（`bridge.ts:1138`），本插件 `resolveSessionRoot` 优先走 `exec.agent.session.meta.cwd`，两者是**同一个工作区**。因此 `send_file('canvas/<sid>/<uuid>.mp4')` 现在就能直接成功，缺的只是「有人去调它」。

4. **`send_file` 只在飞书渠道、且 `config.sendFiles` 开启时注册。** Web/TUI 的 agent 工具列表里没有它。这就是天然的渠道探针：**模型的工具列表里有 `send_file` ⇔ 当前在飞书且部署开了文件送达**。注意「没有 `send_file`」也可能是「飞书但 `sendFiles=false`」——两种「没有」的兜底行为相同（不推送），故无需区分。

5. **决策机制在飞书已由 dsh-lark 解决。** 本 skill 用 `ask_user_question`（选项卡）做所有关卡。dsh-lark 把 `ask_user_question` shadow 成了**按钮卡片**（`questions.ts`，选项变按钮、点击即答、普通聊天回复也算），所以「让用户决策」在飞书是通的，插件零改动。

6. **重要反证：插件核心里不存在可用的主动送达 hook。** 旧版 `deliverToChannel` 尝试 `ctx.get('channelOutbound')`，但全仓无任何地方 provide 该服务（dsh-lark 零 `provide`），这段是**死代码**。因此「插件 hook 主动推文件」在当前约束下不可行——送达只能由模型调 `send_file` 完成。

---

## 3. 最终方案：hook 备路径 + GUIDANCE 模型推（零 dsh-lark 改动）

### 3.1 插件工具结果备好「渠道无关交付信息」（已落地）

所有产出媒体的工具（`comfy_generate_image` / `comfy_generate_video` / `comfy_render` / `extract_frame` / `video_concat`）返回并渲染：

- `media`：相对路径，`send_file` 直接吃；
- `absPath`：绝对路径，TUI 用户 `open` / `cp`；
- `mediaType` + `bytes`：判断是否超上限、是否可预览。

文本类节点（`canvas_write_node`）**不**返回交付信息——它们只进模型回复。

### 3.2 GUIDANCE 补「渠道交付」纪律（已落地）

GUIDANCE 的「渠道交付」段（只进 GUIDANCE，不进 SKILL.md，保持 skill 纯净）：

- **文本节点只进回复**：简报/大纲/镜头表/分镜/交付清单等，写进助手回复，不为纯文本调 `send_file`。
- **媒体节点先送达、后提问**：图片（角色卡/场景卡/铅笔分镜/抽帧）与视频（逐镜片段/转场镜/拼接成片）落画布后，若可用工具有 `send_file`，先逐一 `send_file(media 相对路径)`，再出 `ask_user_question` 问下一步。
- **没有 `send_file`**：产物已在画布/工作区，无需推送。
- **超限**：`send_file` 报 `too_large` 时改用 fast 档 / 更短镜头 / 分开发，或提示到画布取。

### 3.3（可选，低优先）`canvas_get_media(nodeId)` 工具

按需取任意节点的 `media`/`absPath`/`mediaType`/`bytes`，模型不必重读画布就能拿到送达路径。当前工具结果已直接带这些字段，此工具非必需。

### 3.4（可选，低优先）视频海报帧 + Web/TUI 图片内联

- 海报帧：复用已落地的 `extract_frame(video_node, frame_index=0)`（ComfyUI `image.from_video` 能力），给 TUI 视频一个可视锚点。**不是** ffmpeg（本机无 ffmpeg，抽帧走 ComfyUI）。
- `ctx.attachments.saveImage()` 图片内联：只对 Web/TUI 有收益，飞书会丢弃；且该 API 存在性未核。低优先。

---

## 4. 落地状态

| 事项 | 状态 |
|---|---|
| 工具结果补 `media`/`absPath`/`mediaType`/`bytes` | ✅ 已落地（`mediaDelivery` + `mediaResultDetail`） |
| GUIDANCE「渠道交付」段（文本进回复 / 媒体先送达后提问） | ✅ 已落地 |
| 移除死代码 `deliverToChannel` + `channelOutbound` 引用 | ✅ 已清理 |
| `canvas_get_media(nodeId)` | 待做（非必需） |
| 视频海报帧（`extract_frame`） | 待做（P2） |
| `ctx.attachments` 图片内联 | 待做（P2，API 待核） |

---

## 5. 注意事项与边界

1. **20 MiB 是默认值、可配置**（`maxSendFileBytes`），判断超限应以 `send_file` 返回的 `too_large` 拒绝为准，不要写死 20。
2. **群聊会弹审批卡**：这是 dsh-lark 的安全设计（防提示注入外泄），不可绕过；照常调用，审批由用户在飞书处理。
3. **不要做**：在插件核心里探测 channel；不要自己实现飞书上传（重复且越权）；不要依赖「工具结果 image 块」解决飞书（会被丢弃）；不要恢复 `channelOutbound` 主动推送（seam 不存在）。
