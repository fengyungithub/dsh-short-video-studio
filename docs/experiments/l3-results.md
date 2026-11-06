# L3 故障注入结果（6/6 拦截）

> 执行：2026-10-28 ／ 装置：`npm run experiment:l3`（mock ComfyUI + 真门禁，零 GPU）／ 代码：`scripts/experiment/l3-inject.mjs`
> 结论：**6 个注入全部被拦，0 静默放过**。每个都断言了「拦下」+「理由里点名了正确的那件事」，防止「拦错理由也算过」。

---

## 1. 结果

| # | 注入 | 拦在哪 | 理由（截断） |
|---|---|---|---|
| F1 | 上一镜未过自检就渲下一镜 | **shotGate** | 逐镜自检门未通过：「S01 片段」是最近一镜（selfCheck=pending，抽帧=0）… |
| F2 | 改台词不改镜头表 | **planGate** | 台词与镜头表 S01 不一致：prompt 里找不到「我不去。」（台词必须逐字） |
| F3 | fast 档引用三视图卡 | **planGate** | fast 档只能用单视图角色卡：ref_variant 不能传 three；不能引用三视图卡「林晚 角色卡·三视图」 |
| F4 | length 与表时长不一致 | **planGate** | 请求 8.3s（200 帧 @24fps）≠ 表 5s |
| F5 | 自由格式 prompt 走 H3 工作流 | **H3 结构化门** | 缺少 subject_definitions / summary / retention_analysis / … |
| F6 | `continuity_from` 指向别的会话节点 | **工具层** | `continuity_from` 指向的画布节点不存在 |

## 2. 这轮补上的两条判据

- **「拦对理由」**：只判 `deny` 会漏掉「用 A 规则拦了 B 违规」。每个用例都断言 reason 含关键字（`canvas_record_check` / `台词` / `三视图` / `时长` / `结构化` / `节点`）。
- **用具名 agent id**：门有「连续 deny N 次后降级放行」的防死循环，复用同一个 agent id 会让第 3 个用例起变得不可判——每个注入独立 agent id。

## 3. 没覆盖到的（诚实边界）

> 三条的补法已落地：见 [p2-gate-hardening.md](p2-gate-hardening.md)（制片门 / 会话审计 / 字幕审核）。


L3 这轮覆盖的是**代码门**（shotGate / planGate / H3 门 / 工具参数校验）。以下三类是**流程门**，代码没拦也不该拦，需要 agent 或人来拦：

| 未覆盖 | 靠什么拦 | 建议 |
|---|---|---|
| 跳过阶段 C 直接渲（G-A 前开渲） | 只有 skill 文本 + `assetMode=library` 校验 | 加一条**机械校验**：`assetMode=library` 且包 ⑤ 缺 asset id 时，E-STEP 0 必须停线（已有文本，但没有代码/判分器核对） |
| 字幕 `none` 却写烧录声明 | 门 3 自检 + 终检 | 只能靠人眼看片；L1/L2 的代理检查只能查「片段 prompt 不含 burned-in 声明」 |
| 集制作包没有人工批准就开渲（G-P 缺失） | skill 的 3 张卡 | 需要 P2 交互层（有人在线）验证 |

## 4. 复现

```bash
npm run experiment:l3
# 期望输出：拦截 6/6
```
