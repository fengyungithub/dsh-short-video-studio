# experiment/ — 三 skill 运行时一致性实验（种子 + 运行目录）

设计文档：[docs/experiments/skill-conformance-experiment.md](../docs/experiments/skill-conformance-experiment.md)

## 目录

```
experiment/
├── seed/                       # 种子项目（复制成每臂的工作区）
│   ├── series/bible.md
│   ├── series/production-state.json
│   ├── series/episodes/ep001/package.md
│   └── episodes/ep001.md
├── golden/                     # 判分器正例（由 make-golden-run.mjs 生成，可重新生成）
└── runs/                       # 每次实验的独立工作区（不提交，见 .gitignore）
```

## 装置自检（零 GPU，≈10 s）

```bash
npm run experiment:selftest
```

它依次做：起假 ComfyUI 并跑一次真工具调用（6 项）→ 生成正例并判分（P0 22/22、P1 7/7）→ 注入 7 种违规并确认全部被抓（7/7）。

## 跑一臂（L1 干跑）

```bash
cp -R experiment/seed experiment/runs/L1-a
MOCK_COMFY_PORT=8301 MOCK_COMFY_OUT=experiment-out/L1-a \
  node scripts/experiment/mock-comfy.mjs &          # ← 保持前台另开也行

# 另开一个全新 agent 会话，工作区 = experiment/runs/L1-a，
# 环境变量 DSH_SVS_COMFY_URL=http://127.0.0.1:8301，
# 按下面的「运行简报」发起，并按「答案卡」回答三张卡。

npm run experiment:assert -- \
  --workspace experiment/runs/L1-a --canvas-root . --session <sid> \
  --trace experiment-out/L1/comfy-trace.jsonl --tier fast
```

> 两个易踩点（L1 实测）：
> - **画布根 ≠ 项目根**：子会话的画布落在仓库根 `canvas/<sid>/`，臂的项目文件在 `experiment/runs/L1-x/` ⇒ 必须给 `--canvas-root`。
> - **子会话的画布工具要显式传 `workspaceId`**，否则报 `workspace not found for session …`（skill 的「开场 `canvas_list_nodes()` 探测」因此在子会话里失效）。
> - 若遇到已知的 `concat-no-ffmpeg`（旧进程 bug），加 `--allow-missing-concat` 把拼接/交付两步记为 SKIP，其余照常判。

## 运行简报（原样发给 agent）

```
你在做一个流程一致性实验：按仓库 skills/ 下的三份 skill
（short-drama-series-writer / short-drama-series-production / story-short-generator）
把本项目 EP001 做出来。以仓库文本为准，不要用 skill 工具加载（缓存可能是旧版）。

项目：experiment/runs/<arm>（已含 圣经 / 第1集剧本 / 集制作包 / production-state.json）
规格（已写进圣经 §1，不要再问）：9:16 / 单集 45s（episodeSecondsException）/ dialogue-led /
tier=fast（实验干跑）/ reviewMode=batch / shotGate=verdict / characterCardVariant=single /
字幕 none / voicePlan=existing / bgmMode=none / 资产模式 draft。

硬约束：
- 不许跳阶段（A→B→C→D→E），不许改台词、不许改包、不许自创 beatId；
- 不许手工造画布节点绕过工具；每镜必须抽帧 + canvas_record_check；
- 三张卡按「答案卡」回答，不要临场改答案；
- 结束后把最终 state 与交付清单落盘，并报告：调用次数 / 重渲镜数 / 用时。
```

## 答案卡（固定，不许临场改）

| 卡 | 选择 |
|---|---|
| 方案卡（G-P） | **批准开渲** |
| 片段卡（batch） | **全部批准并进入拼接**（音频项：人工另行听核） |
| 交付卡（G-E） | **批准交付** |

## 判分

```bash
npm run experiment:assert -- --workspace <dir> --session <sid> --trace <trace.jsonl> --tier fast
```

P0 有任一失败即该臂不合格（退出码 1）；P1 失败只记录。逐条输出带证据。
