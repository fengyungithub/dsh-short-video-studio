# 三条「L3 没覆盖」的补法（已落地）

> 2026-10-28 ｜ 背景：[l3-results.md](l3-results.md) §3 ｜ 对象：阶段门 / 借问门 / 字幕审核
> 原则：**能机器验的机器验，验不了的留下可核对的痕迹**——不做「假装验过」的检查。

---

## 1. 制片门（production gate）—— `lib/index.js: makeProductionGateListener`

**补的是**：`planGate`/`shotGate` 都只看画布，没人读 `series/production-state.json`，所以「阶段没到就烧 GPU」「G-P 没批准就开渲」「library 模式资产没锁定」代码完全看不见。

**激活条件**：workspace 里有 `series/production-state.json`（**单片项目零影响**）。

| 检查 | deny 理由（摘要） |
|---|---|
| `stage ∈ [shotlist, clips, final, delivered]` | 本集 stage=assets：还没过方案卡（G-P）就开渲 |
| `gate.package.status === 'approved'` | 方案卡（G-P）未批准 |
| `package.packageVersion === state.packageVersion` | 集制作包版本不一致（改包后回写 state） |
| `package.scriptVersion === state.scriptVersion` | 剧本版本不一致（改台词必须重建包） |
| `assetMode=library` → 三类资产非空且 `locked` | 阶段 C（G-A）没做完 |
| `assetMode=library` → `ref_nodes` 带 `params.assetId` | 参考图不是资产库物化的节点 |

**行为约定**（与现有门一致）：
- 读不到 / 解析失败 / 无 series 目录 → **放行**（不许因缺文件卡死）；
- 连续 deny 2 次降级放行；`DSH_SVS_PRODUCTION_GATE=off` 整体关闭；
- 理由里带下一步动作。

**测试**：`npm run smoke:production` → `scripts/smoke-production-gate.mjs`，**12/12**（无 series 不触发 / state 损坏放行 / 5 种违规 / 正常放行 / library 正例 / 防死循环 / off 开关）。

**诚实边界**：它验的是**留痕**。单 agent 可以自己写 `approved`——真实性由下一条补。

---

## 2. 会话审计 —— `scripts/audit-session.mjs`（`npm run audit:session`）

**补的是**：生产门验不了「人真的点过头」。会话记录是唯一证据源：
`~/.dsh/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`
（**多帧拼接 zstd**——Node 的 `zstdDecompressSync` 只解第一帧，要按 magic `28 B5 2F FD` 切片逐帧解；L2 实测 416 帧 → 2.7 MB → 810 事件 / 170 次工具调用。）

**断言（系列模式）**：

| # | 断言 | 判据 |
|---|---|---|
| A1 | 三张卡都问过 | `ask_user_question` 参数里分别出现「方案卡 / 片段 / 交付卡」 |
| A2 | 先问后渲 | 首个 `comfy_generate_video` 的 `seq` > 方案卡 ask 的 `seq` |
| A3 | 抽帧 / 自检覆盖 | `extract_frame`、`canvas_record_check` 次数 ≥ **不同镜号数**（不是调用次数，重试/重渲不算新镜） |
| A4 | 重渲有边界 | 带 `nodeId` 的调用 ≤ `max(1, ceil(视频调用/2))` |
| A5 | 字幕核验留痕 | 某个 `canvas_write_node` 正文含 `字幕核验` |
| A6 | 无已知违规参数 | 无 `tier=fast` + `ref_variant=three` |

**首次实测（回放现有会话）**：

- L2 真机：**4/7** —— A1/A2 失败（实验用答案卡替代了真 ask，正是它要抓的）、**A5 失败**（没有字幕核验留痕）。
- L1-b：单片模式 → A1/A2/A5 记 SKIP，其余全过。

> 结论：审计器**能抓住「实验装置与真实交互的差别」**，不是橡皮图章。

---

## 3. 字幕审核 —— 立成门 3 的独立一项（不做 OCR）

**补的是**：字幕关了却烧字，代码无法判画面真相。按约定**不引入 OCR**，改为「把审核动作立成必做项 + 留可核对的痕」：

- `SSG 门 3 第 3 项`：**字幕审核是独立一项，不许用「抽帧了」代替「看了」**；留痕格式 `字幕核验：<N> 帧 / <M> 例` 写进 `canvas_record_check` 的 `notes`；`N ≥ 本镜说话窗帧数`；不可判读写 `na` 并说明；**只抽帧没看就写 `subtitle=pass` = 违规**。
- `SSG STEP 8 终检`：交付清单必须落 `字幕核验：<总帧数> 帧 / <命中> 例`，**没有这一行 = 终检未完成**。
- `PROD §12 交付包` + `RUN §2.4 交付卡`：同一行是交付包的必填项。
- `audit-session.mjs` A5：机器核对这行是否存在。

**边界**：这仍是「痕迹」而非「真相」——真正判断画面有没有字，仍靠逐镜抽帧的人眼/AI 视觉；但「没看就写 pass」从此有据可查。

---

## 4. 验证

| 项 | 结果 |
|---|---|
| `scripts/smoke-production-gate.mjs` | **12/12** |
| `smoke-skill-contract` | 61/61 |
| `smoke-plan-gate` / `smoke-shot-gate` | 39 / 56（无回归） |
| `validate:bridge` | 2 份历史包 0 error |
| `audit-session` 回放 L2 | 4/7（A1/A2/A5 正好是实验装置的三个缺口） |

## 5. 还没做的

- **把审计接进 pre-execute**（现在是「只报不挡」）：建议先跑 3–5 个真实项目再考虑。
- **把 `字幕核验` 做成硬门**：可在 `canvas_record_check` 校验 notes 里必须出现该字段（系列模式）；本轮先做文档 + 审计，避免误伤历史项目。
- **G-A 的机械校验前移**：现在靠制片门在渲染时兜；更早的拦截点应在 E-STEP 0（包 + state 一致性），可复用同一份检查函数。
