# 量产运行手册（每集 SOP / 断点续跑 / 成本台账）

> 配合 `SKILL.md` §8 使用。这里只写**可照抄的调用顺序**，不重复规则条文。

---

## 1. 每集会话开场（五步，必做）

```text
1) read  series/production-state.json          # 当前集 / stage / doneShots / 资产台账
2) read  episodes/epNNN.md + 分集目录该行 + series/bible.md（按需段）
3) asset_list()  →  asset_to_canvas(id=…) × N   # 本集用到的角色/状态/场景/道具
4) canvas_write_node(kind=text, group="story planning", title="EP003 集制作包", content=…)
5) 加载 story-short-generator，声明总控与 5 处注入，从 STEP 3 起
```

开场先做的三件状态写入：

```text
canvas_set_state(aspectRatio="9:16", duration="90 秒", audioMode="dialogue-led",
                 mode="balanced", characterCardVariant="single", reviewMode="batch",
                 groupOrder=["story planning","character cards","scene cards","prop cards",
                             "shot table","text storyboards","shot prompts","shot clips","final delivery"])
```

> `production-state.json` 的 `stage` 从 `package` 走到 `delivered`，**每步都先写文件再回复用户**。

---

## 2. 单集生产序列（照抄）

### 2.1 卡片（缺卡才建）

```text
有 id → asset_to_canvas(id)                    # 复用
缺卡   → comfy_generate_image(tier="quality", width=…, height=…,
            character="林晚", card_variant="single", title="林晚 角色卡·单视图", group="character cards")
        → comfy_generate_image(..., card_variant="three", paired_node_id=<上一步 id>, title="林晚 角色卡·三视图")
```

- 角色：`single` 2:3 竖版（quality 1344×2016）+ `three` 16:9（2048×1152）。
- 场景：跟随画布比例 9:16（quality → 1152×2048）。
- 道具：1:1（quality 2048×2048），只给关键道具。
- 两版都查（自检点 1），并核对跨版本是同一角色。

### 2.2 七列镜头表 + 门 1

```text
canvas_write_node(kind=table, group="shot table", title="EP003 镜头表", content=<七列>)
→ 跑 STEP 5.5 十一项自检
→ 表节点顶部加 "shot-table self-check: passed at <时间戳>"
→ ask_user_question（门 1）
```

### 2.3 文本分镜 + 门 2

```text
canvas_write_node(kind=text, group="text storyboards", title="EP003 text storyboards", content=…)
→ ask_user_question（门 2：批准分镜并渲染）
```

### 2.4 逐镜生成（每镜三件套）

```text
canvas_write_prompt_bank(title="S03 提示词（分档）", group="shot prompts",
                         prompts={fast:p, balanced:p, quality:p})       # 三档同文，p 是 quality 全文
→ comfy_generate_video(type="r2v", tier="balanced", ref_variant="single",
                       prompt_node=<上一步 id>,
                       ref_nodes=[角色卡…, 场景卡, 道具卡?],
                       continuity_from=<上一镜 id，起链不传>,
                       length=124, title="S03", group="shot clips")
```

- `续接` 列：同场景后续镜传 `continuity_from`；场景第一镜 `起链`。
- 转场镜（跨场景，1 个）：

```text
extract_frame(video_node=<前一场景尾镜>, frame_index=-1, title="S10 末帧", group="shot clips")
extract_frame(video_node=<下一场景首镜>, frame_index=0,  title="S12 首帧", group="shot clips")
comfy_generate_video(type="i2v", tier="balanced", first_frame_node=…, last_frame_node=…,
                     length=73, title="S11 转场", group="shot clips")
```

- 字幕 `none`：prompt 里不写任何字幕声明，负向尾句 `no subtitle, no burned-in dialogue text`。

### 2.5 门 3（batch）

```text
每渲完一镜：立即自检（抽首/中/末帧 + 说话窗帧，对照卡片与镜头表）
全部渲完且全部通过 → 一张 ask_user_question（批量审查卡）
口型/一致性不过关 → 当场弹单镜处置卡（不压到批量卡）
```

批量卡必须逐条列：镜号 → 节点 id → 时长 → 自检结论（含抽帧核对项）→ 人工听核要点。

### 2.6 拼接 + 交付

```text
video_concat(nodes=[S01…S18 节点 id，含转场镜], title="EP003 拼接成片", group="final delivery")
→ 终检（story skill 清单）
→ 写 series/delivery/epNNN/ 交付清单 + 配乐点单
→ 更新 production-state.json（stage=delivered, finalNodeId, costMinutes, gate=approved）
→ 主会话 production ledger 追加一行
```

---

## 3. 断点续跑

会话中断 / 超时 / 换会话后：

```text
1) read production-state.json（stage / doneShots / clipNodeIds）
2) canvas_list_nodes() 找回 group="shot clips" 的既有片段，与 doneShots 对齐
3) 从第一个缺失镜继续；已完成的镜**不重渲**
4) 缺提示词库的补写（canvas_write_prompt_bank），缺镜的照 2.4 生成
5) 续接链：只从「最后一个已完成且支持续接的镜」往后接；中间断点用 `起链` 硬切，并在台账标注接缝
```

**注意**：已渲片段若与当前镜头表不一致（改过表），按「重渲与续接链」顺次重渲，不要拿旧片段凑数。

---

## 4. 成本台账（主会话 `production ledger` 表）

| 集 | 镜数 | 重渲镜 | GPU 分钟 | 新增卡片 | 超分 | 交付 | 备注 |
|---|---|---|---|---|---|---|---|
| EP001 | 18 | 2 | 74 | 9 | 否 | ✓ | 样片集 |
| EP002 | 18 | 0 | 52 | 0 | 否 | ✓ | 场景全复用 |

判定规则：
- 单集 GPU 分钟 > 预算 ×1.5 → 查重渲原因（prompt？资产？档位？），别直接跑下一集。
- 新增卡片 >0 的集，检查是否本该复用台账资产（量产阶段应趋近 0）。
- 每 5 集汇总：总时长、均值、偏差、最贵集与原因。

---

## 5. 每 5 集系列抽查（清单）

1. **角色**：同角色跨集抽 3 帧，对照台账卡片（脸/发型/身材/服饰主色/签名道具）；状态卡是否用对。
2. **场景**：同场景地标位置是否一致（门框左右、桌子位置、光位方向）。
3. **风格**：抽 3 集各 1 帧并排看，有无画风漂移。
4. **规格**：画幅/档位/字幕/语言是否全季一致（出现字幕 = 立刻停线查 prompt）。
5. **剧本-成片一致**：台词是否逐字、事件是否与剧本一致、集尾钩子是否成立。
6. **成本**：偏差 >20% 停线。
7. **资产库**：用户是否已把新卡入库（未入库的跨集复用会断）。

---

## 6. 异常处置速查

| 情况 | 动作 |
|---|---|
| 单镜 3 次失败 | 弹卡：换档（先 `comfy_list_workflows`）/ 放宽 / 跳过标 placeholder / 手动参考 |
| 参考图污染（多副本/文字被投影） | 非 fast 档也先 `ref_variant="single"` 同 seed 重渲（story skill 0.6） |
| 字幕冒出来 | 停线：查 prompt 是否残留字幕声明 → 重写 prompt bank → 重渲该镜；并全季抽查 |
| 接缝跳变 | 检查下游是否 `continuity_from` 旧节点 / 是否跨档；顺次重渲下游 |
| 卡片改版 | 台账版本 +1，未交付集全部重渲，已交付集标作废 |
| 超分失败/超时 | 降 `target_width` 或分块；不改内容问题 |
| 飞书收不到 | 查节点 `params.deliveryError`；>20 MiB 用更小 `target_width` 或提示到画布取 |

---

## 7. 会话结束前必做

```text
1) production-state.json 写回（stage / doneShots / costMinutes / next）
2) 主会话 production ledger 追加/更新本集行
3) 交付清单落到 series/delivery/epNNN/ 与该集画布 final delivery 组
4) 回复用户：本集结论 + 下一集 + 需要人工听核/补 BGM 的点
```

> 不做第 1 步就结束会话 = 下次续跑会重渲（钱白花）。
