# 量产运行手册（每集 SOP / 断点续跑 / 成本台账）

> 配合 `SKILL.md` §8 使用。这里只写**可照抄的调用顺序**，不重复规则条文。

---

## 1. 每集会话开场（七步，必做）

```text
1) read  series/production-state.json          # 当前集 / stage / doneShots / 资产与声线台账
2) read  episodes/epNNN.md + 分集目录该行 + series/bible.md（按需段）
3) asset_list()  →  asset_to_canvas(id=…) × N   # 本集用到的角色/状态/场景/道具
4) canvas_set_state(…)                          # 一次写全：画幅/时长/音频/档位/卡版本/reviewMode/shotGate/十个分组
5) canvas_write_node(kind=text, group="story planning", title="EP00X 本集规格", content=…)  # 只读规格卡：参数 + 节点数（动态）
6) canvas_write_node(kind=text, group="story planning", title="EP00X 集制作包", content=…)
7) 加载 story-short-generator，声明总控与注入点，从 STEP 3 起
```

开场先做的状态写入（**每集唯一写入点；story 只读不写**）：

```text
canvas_set_state(aspectRatio="9:16", duration="90 秒（默认；按包 ① 80–110s 调整）", audioMode="dialogue-led",
                 mode="balanced", characterCardVariant="single", reviewMode="batch", shotGate="verdict",
                 groupOrder=["story planning","character cards","voice auditions","scene cards",
                             "prop cards","shot table","text storyboards","shot prompts",
                             "shot clips","final delivery"])
# 声线方案无 state 字段：existing（阶段 C 建）/ text-only（降级），写进系列圣经与集制作包 ⑥
```

> `production-state.json` 的 `stage` 从 `package` 走到 `delivered`，**每步都先写文件再回复用户**。

---

## 2. 单集生产序列（3 张人工卡，编排权威）

### 2.0 职责与 handback

| 谁 | 做什么 | 不做什么 |
|---|---|---|
| production | 物化资产（asset id）、建集制作包、出 3 张人工卡、asset_ingest/台账、状态/成本/交付包 | 不调用图片/视频生成工具、不改拍摄规则 |
| story | 生成卡片/镜头表/分镜/提示词库/逐镜/拼接、跑 AI 自检与异常门 | 不写系列台账/资产库/交付包 |

**story → production handback**（每集收尾必须交回）：`finalNodeId` / `clipNodeIds` / `shots` / `rework` / `costMinutes` / `warnings` / `assetNodeIds`（本集新生成的卡，交 production 入库）。变更集额外交 `changedShots` 与 `scriptVersion`。production 写 `production-state.json` 与 ledger；story 不写这两个文件。

> 拍摄参数与失败梯度**一律照 `story-short-generator` 的 STEP 5 / 6 / 7**；本片型只固定：`tier=balanced`、`ref_variant=single`、字幕 `none`、声线从台账 `voices[]` 取。这里只列系列层动作，不复述调用参数。

### 2.1 资产物化 / 缺卡交 story

```text
有 id → asset_to_canvas(id)                     # production 物化，节点写 params.assetId
缺卡   → 交 story 生成 single + three（图片档位 balanced、两版配对）
        → production 走 asset_ingest（用户批准清单）→ 台账 → §2.2 方案卡重批
```

- 建卡后的逐卡锁定**不单独弹卡**，并入 §2.2 的方案卡。
- 场景 / 道具 / 声线已在阶段 C 建好；本集只物化，不重画。
- **story 不写资产库**；缺卡生成后只返回节点，由 production 入库/记账。
- **阶段 C 首次建卡同此分工**：production 主持（清单/总览卡/入库清单/台账），生成与自检委托 story（STEP 3 / 3.5 / 4 / 4.5）；委托时必须声明「阶段 C 资产建卡 + 跳过门 0 / E-STEP 0」，否则 story 会判「缺本集包」反过来加载 production（死循环）。

### 2.2 建包 → 镜头表 → 分镜 → 方案卡（G-P，1 张/集）

```text
按 §10 建包（①③④⑤⑥ + beats[] + 镜头预算 + 成本）→ 跑 validate-episode-package.mjs（beat 覆盖）
→ 按 story STEP 5 出七列镜头表（8 列 `beatId` 逐镜回填到 `剧本依据`）→ 跑 STEP 5.5 十四项自检 → 表节点加自检戳
→ 按 story STEP 6 出文本分镜（默认单文本；⑥ 声明可视化才加铅笔图）
→ ask_user_question（方案卡）：包 ①③⑤⑥ + beat 覆盖 + 镜头表摘要 + 分镜 + 渲染参数 + 成本 + 偏差
```

方案卡选项：**批准开渲（推荐）** / 改包某节 / 改镜头表或分镜 / 只渲 1 镜试片 / 回改剧本。
**不要**在方案卡之外再弹 story 的门 1 / 门 2 / 分镜批准 / 渲染参数卡。

### 2.3 逐镜 → 片段卡（门 3，1 张/集）

```text
按 story STEP 7：每镜 prompt bank（三档同文）→ r2v（continuity_from / audio_ref_nodes）→ AI 逐镜自检
全部渲完且全部通过 → 一张片段卡（batch）
口型 / 字幕 / 一致性不过 → 当场弹单镜处置卡（不压到批量卡）
```

- 续接 / 转场镜（i2v 双端锚定）按 story STEP 7 执行；跨场景每个边界 1 个转场镜。
- 片段卡逐条列：镜号 → 节点 id → 时长 → 自检结论（含抽帧核对项）→ 人工听核要点。

### 2.4 拼接 + 终检 → 交付卡（G-E，1 张/集）

```text
[可选，delivery=fps48] 逐镜补帧：video_interpolate(video_node=每镜片段, target_fps=48)
  → 用补帧后的节点去拼接（整片同帧率；含硬切/拼接产物不补）
video_concat(nodes=[按镜头表顺序，含转场镜], title="EP00X 拼接成片", group="final delivery")
→ 按 story 终检清单核对
→ ask_user_question（交付卡）：成片 + 终检结论 + 本集成本 + 台账
→ 批准后写 series/delivery/epNNN/、state=delivered、ledger 追加一行
```

交付卡选项：**批准交付（推荐）** / 重渲某镜 / 重拼 / 逐镜超分 / **逐镜补帧（48fps）** / 补做终检某项。

- 交付清单必写「本集与上一集为**硬切衔接（非续接）**」（架构上跨集 latent 不可用），避免用户把硬切当缺陷。
- 交付清单必写 `字幕核验：<总帧数> 帧 / <命中> 例`（逐镜 notes 汇总）；缺这行 = 交付卡不合格。

---

## 3. 断点续跑

会话中断 / 超时 / 换会话后：

```text
1) read production-state.json（stage / scriptVersion / packageVersion / doneShots / clipNodeIds）
2) canvas_list_nodes() 找回 group="shot clips" 的既有片段，与 doneShots 对齐
3) 从第一个缺失镜继续；已完成的镜**不重渲**；若 `scriptVersion` 与当前剧本不一致，先按 `references/script-change.md` 处理，**不要续跑旧稿片段**
4) 缺提示词库的补写（canvas_write_prompt_bank），缺镜的照 2.3 生成
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
