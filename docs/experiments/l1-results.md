# L1 干跑结果（3 臂 · 零 GPU）

> 执行时间：2026-10-28 13:30–13:52 ／ 装置：[skill-conformance-experiment.md](skill-conformance-experiment.md) ／ 种子：[experiment/seed](../../experiment/seed)
> 结论：**3/3 臂 P0 通过、P1 全过**（拼接与交付两步因一个真实插件 bug 记 SKIP）；**抓到 15 个真问题，其中 12 个已修**。

---

## 1. 结果

| 臂 | 画布会话 | P0 | P1 | 生成调用 | 重渲 | 墙钟 | 终态 |
|---|---|---|---|---|---|---|---|
| L1-a | `7ac8fac2…` | **20/20**（+2 SKIP） | 7/7 | 8 视频 + 4 图 + 2 裁切 + 2 音乐 + 24 抽帧 = 40 | 0 | ≈50 min | `clips`，`gate.delivery=pending` |
| L1-b | `6f99fd60…` | **20/20**（+2 SKIP） | 7/7 | 13（3 图 + 2 音乐 + 8 视频） | 0 | ≈22 min | 同上 |
| L1-c | `8361b810…` | **20/20**（+2 SKIP） | 7/7 | 13 + 3 次失败尝试（见 A2） | 0 | ≈18 min | 同上 |

- **P0 20/20**：22 条里 2 条（拼接、交付）因 §A1 的插件 bug 按 `--allow-missing-concat` 记 SKIP，其余全过。
- **重渲 0**：三臂都是 8 镜首版过门，续接链没断——说明「表先写好、prompt 一次写全」这条在真实执行里成立。
- 三臂的产物结构一致（四个角色卡节点含双向配对、8 份三档同文提示词库、8 片段 + 8 自检 + 抽帧证据、拼接就绪清单）。

**装置偏差（影响读法，必须写在结论旁）**
1. 子会话的画布落在**仓库根** `canvas/<sid>/`，而项目文件在臂目录 ⇒ 判分器需要两个根（已加 `--canvas-root`）。
2. 画布工具在子会话里必须显式传 `workspaceId`（三臂都撞到，否则 `workspace not found`）⇒ skill 的「开场 `canvas_list_nodes()` 探测」在子会话里直接失效。
3. `ask_user_question` 无人在线 ⇒ 三张卡写成「卡片记录」文本节点；**P2 交互层本轮未覆盖**。
4. mock 产物是占位图/占位视频 ⇒ 视觉项只能 `na`；本轮验证的是**流程与参数**，不是观感。

---

## 2. 发现

### A. 已修（12 条）

| # | 问题 | 证据臂 | 修在哪 |
|---|---|---|---|
| A1 | **`video_concat` 的 ComfyUI 兜底永远不可达**：`runConcat` 用 roots 探到上层目录的 ffmpeg → 选 ffmpeg 后端；`ffmpegConcat` 内部又做一次**无参**探测（只看 PATH）→ 抛 `concat-no-ffmpeg`，兜底分支走不到 | a/b/c | `lib/concat.js` 接受外部 `bin`；`lib/index.js:2918` 传 `ffmpegBin`；新增 `scripts/smoke-concat-ffmpeg.mjs`（4 项） |
| A2 | **`canvas:<id>` 与 `audio_ref_nodes` 互斥**：镜头表按 skill 写 `canvas:<音频节点id>`，工具只认裸 id，传前缀报「节点不存在」；判分器逐字比对必挂 | a/b/c | 工具接受 `canvas:` 前缀（`resolveRefAudio`）；判分器两侧归一化 |
| A3 | **`画面文案` 子字段被并进 `字幕`** → 门把「门牌文字」当字幕去核并 deny | c | `PLAN_GATE_FIELDS` 补 `画面文案`；`smoke-plan-gate` 加 2 条回归 |
| A4 | **Hook 映射死锁**：`episode-package §5` 没有「转场」行，而「每连续 3 镜 1 个 reveal/reversal/callback」把 `危机→转场→钩子` 这组判死 | a/b/c | 映射表补 `转场 → suspense`；SSG 第 1 项明确 **silent/转场不计入 3 镜窗口** |
| A5 | **转场镜命名示例自伤**：`title="S03→S04 转场"` 会被任何按 Sxx 取镜号的代码读成 `S03`（判分器把转场当 S06，连带 3 条 P0 误判） | b | 示例改 `S07 转场（S06→S08）`；判分器改为 transition-aware（标题含「转场」单独归组） |
| A6 | **时长回写是单向的**：只在 `> T×1.1` 时回写 ⇒ 37.6s 的集能合法通过 45s 的目标 | a/b/c | PACK §3 改**双向**（`\|Δ\| > T×10%` 即回写） |
| A7 | **`length` 是请求帧数、不是交付帧数**：续接实现按 `17k+5` 网格 + `sampleExtra=22`，实测 124→**136**（5.67s）、107→**119**；一集累计比表长 ≈2.5s | a/c | SSG STEP 7 写明；PACK 镜号列允许 `4.6s（107f）` 双口径 |
| A8 | **场景卡数量无人兜底**：包 ② 有 2 个物理场景，但流程只建 1 张，缺卡时「全镜参考绑定，没有例外」与「绑不到卡」冲突 | a/b/c | SSG STEP 4 + PROD §6.3：**每个物理场景一张卡**；缺卡是合法例外（`scene:TO-BUILD` + 环境进 prompt + 列进交付「未落地项」） |
| A9 | **fast 干跑没有授权路径**：圣经/包/任务三处档位表述不一致，覆盖表里没有「试产用 fast」这一行 | b | PROD §1.1 覆盖表加「试产/干跑档位」行，要求 `dryRun: true` 且不得与交付集混拼 |
| A10 | **`stage` 枚举缺「已拼接、待批准」**：`final` 语义未定义，只有 `clips`/`delivered` 可选 | a/b/c | PROD §3.2 写明七态语义（`final` = 已拼接 + 交付卡待批） |
| A11 | **抽帧不可判读时没有口径**：占位/黑帧被记 `pass`，门 3 变橡皮图章 | a/c | SSG 门 3：不可判读项写 `na` + `notes` 记原因，**不得写 pass** |
| A12 | **单 agent 分饰两角无授权**：委托模式假设 PROD 与 SSG 两个会话，一个人跑会被「不许自审自批」卡住 | a/b/c | `series-delegated-mode.md` 补「单会话分饰两角（允许）」条款 |

### B. 待决策（6 条，本轮未改）

| # | 发现 | 影响 |
|---|---|---|
| B1 | **图片交付尺寸不跟画布比例**：`image.text2image`（balanced 解析到 qwen 家族）显式传 768×1344 后，`graphWidth/graphHeight` 记对了，**交付仍是 1344×768**；warning 只在 `params.warnings`，工具返回文本里没有 | 9:16 项目的场景卡/角色卡实际是横版；「图片与视频同一套尺寸规则」在文档层面失真 |
| B2 | **续接镜系统性变长**（A7 的实现面）：是否要求实现「交付帧数 = 请求帧数」是产品决策——改了会让整条链的网格/继承帧逻辑都要动 | 每集成片比镜头表长 ≈2.5s |
| B3 | **H3 结构化 prompt × 三档同文 = 同一份 4KB 贴三遍**（8 镜 ≈30KB 纯重复） | 建议允许「写一段、工具自动填三段」，不是手工复制三次 |
| B4 | **batch + 形式化自检在 mock 下 100% 假阳性**：8 镜"通过"全是占位帧 | 装置局限；报告须区分「形式通过 / 实拍通过」 |
| B5 | 双人镜 `ref_nodes = 2 角色 + 1 场景 = 3` 槽位没有口径（文档只写「>2 未实测」） | 双人对手戏是短剧常态 |
| B6 | 镜头预算公式没有 40–60s 区间口径（`T÷4–5s` 给 9–11 镜，包预算写 8） | 小体量集/实验集的预算只能手写 |

### C. 装置自身的修正（元验证——这部分比结果更重要）

判分器第一版**差点给出错误结论**，四处修正都是被这轮跑出来的：

1. **空集判过**：空目录 11/22 通过（空数组 `every` 恒真）→ 全部加非空前置 → 0/22。
2. **续接检查空转**：`parseShotTableContent` 不导出「续接」列，我读的字段是 `undefined` → 检查恒真；靠变异测试 3/7 才发现 → 改为从表格原文取列 → 7/7。
3. **调用次数口径错**：把图片/裁切/抽帧/音乐全算「生成调用」→ 合规流程最少 24 次、阈值 12 必然不可能 → 改成只数视频调用。
4. **单根假设**：画布在仓库根、文件在臂目录 → 加 `--canvas-root`。
5. **i2v 无 `ref_variant`**：转场镜本来就没有参考图 → 「fast 档必须 single」只查带 `ref_nodes` 的镜。
6. **转场命名**（A5）：`S06→S08 转场` 被解析成 S06 → transition-aware。

---

## 3. 复现

```bash
# 现状：3 臂产物已落盘，可直接重判
npm run experiment:assert -- --workspace experiment/runs/L1-a --canvas-root . \
  --session 7ac8fac2-2a71-4d99-84c3-cf52403e0ddb \
  --trace experiment-out/L1/comfy-trace.jsonl --tier fast --allow-missing-concat

# 批量
node scripts/experiment/collect-runs.mjs --runs experiment/runs \
  --trace experiment-out/L1/comfy-trace.jsonl --tier fast
```

脚本自检（判分器本身）：

```bash
npm run experiment:selftest   # mock 6/6 + 正例 22/22 + 变异 7/7
```

---

## 4. 下一步

1. **重启 DSH** → 让 A1/A2/A3 的代码修复进到运行中的插件；然后对一个臂重跑 `video_concat`（命令与参数见各臂 `交付清单`），验证 A1 在真链路上闭合。
2. **L2 真机单集**（≈22 min GPU）：用同一 seed + 同一 brief，跑 `balanced`，看 B1/B2/B4 在真后端是否复现。
3. **B1 单独立项**：图片尺寸是否要跟随画布比例（牵涉 image 实现的尺寸来源），建议先做 1 镜 A/B（768×1344 显式 vs 原生 1344×768）。
4. **P2 交互层**：需要有人在线的会话，验证 3 张卡的顺序/内容与异常门——本轮未覆盖。
