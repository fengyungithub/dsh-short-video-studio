# H3 自带 BGM：方案记录（本期实现）

> 日期：2026-10-26 ｜ 决策：**本期只实现 `bgmMode=in-model`（H3 逐镜自带 BGM）**；Music 3 独立音轨 + 混音作为下一期。
> 依据：实验 A/B（[h3-inmodel-bgm-experiment.md](h3-inmodel-bgm-experiment.md)）——H3 确实执行 `non_diegetic_music`；但 BGM 烘进该镜音轨，链内可能衰减，硬切可能断。

## 1. 选项定义

项目级参数 `bgmMode`：

| 值 | 行为 | 状态 |
|---|---|---|
| `none`（默认） | H3 所有镜头 `non_diegetic_music: N/A`；无 BGM | 本期 |
| `in-model` | 按剧本/镜头表 BGM 提示，逐镜写 H3 `non_diegetic_music`；BGM 烘进片段音轨 | **本期实现** |
| `separate` | H3 `N/A`；Music 3 生成独立 BGM；后期混音 | **下一期** |

> `separate` 本期不暴露给用户；plan 里预留，schema 暂不收该值（或后续再放开）。

## 2. 数据流

```
writer 剧本「♪ 音乐提示」（场次级）
→ story 镜头表「音频与对白轨.BGM」（逐镜：in/out/乐器/速度/动态/对白下处理）
→ h3-prompt-writing：BGM 字段 → non_diegetic_music
→ comfy_generate_video：H3 逐镜生成，BGM 随片段音轨
→ 拼接：BGM 随片段走；硬切/跨场景可能换曲
→ 交付：标注「BGM 已随片（H3 自带），无独立 BGM 轨」
```

## 3. 实现范围（本期）

### 3.1 skill / 选项
- 单片 STEP 0：增加 `bgmMode: none | in-model`（默认 none）。
- 剧集 S-STEP 0：增加 `bgmMode`；写系列圣经 §1、`production-state.series`、集制作包 ⑥。
- 剧集 E-STEP 0：只读/校验 `bgmMode`，不逐集重问。
- 不新增工具；H3 已有 `non_diegetic_music` 字段。

### 3.2 剧本 / 镜头表
- writer 保留 `♪ 音乐提示`；建议按**场次**写：情绪、乐器、速度、进/出点、是否对白下压低。
- story 七列镜头表 `音频与对白轨` 增加 `BGM` 子字段：
  - `N/A`，或
  - `in: 0–3s, sparse solo piano, slow, low under dialogue; out: 4.5s fade`
- 逐镜字段是 H3 唯一能看到的 BGM 信息；不能写“整场从第 3 分钟进 BGM”。

### 3.3 H3 prompt
- `bgmMode=in-model`：`non_diegetic_music` 写本镜的乐器/速度/动态/进点/淡出；有对白时写“low under dialogue”。
- `bgmMode=none`：`non_diegetic_music: N/A`。
- 仍然遵守 H3 六段式/三段式；`overall_soundscape` 只写环境音/物理音，不写 BGM。

### 3.4 交付 / 自检
- `in-model`：交付清单写 **BGM 已随片（H3 自带）**；不提供独立 BGM 轨；提示硬切/跨场景可能换曲。
- `none`：交付清单写无 BGM。
- 人工听核：BGM 是否盖对白、接缝是否可接受、是否每镜换曲。
- AI 不能听音：把“BGM 是否可听/是否盖对白/接缝”列入片段卡/交付卡的人工听核项。

## 4. 已知限制（必须写进交付/选项说明）

- BGM 与对白/音效在同一条音轨，**不能单独替换/duck/导出**。
- H3 逐镜生成：链内可能衰减，硬切/跨场景可能换曲；不是一条全局配乐。
- 与 `separate` 不能同时开；否则双 BGM。
- H3 音频 32kHz；Music 3 44.1kHz（下一期混音要重采样）。
- 本机没有 ffmpeg；本期不需要，下一期混音需要。

## 5. 验收

1. 同一画面/seed，`bgmMode=none` vs `in-model`，音频差异可听/可测。
2. 2 镜链式续接 + 同 BGM：接缝可接受（实验 B 已提示相关性仅 0.44，需人听）。
3. 有对白镜：BGM 不盖对白（至少主观可接受）。
4. 交付清单明确“BGM 随片 / 无独立轨”。
5. smoke：skill 含 `bgmMode`、镜头表含 `BGM`、h3 映射含 `non_diegetic_music`。

## 6. 下一期（Music 3）

- `bgmMode=separate`：H3 `N/A` + `comfy_generate_music` 独立 BGM。
- 需要：音频混音/贴轨能力、cue 时间线、ducking、响度标准化、重采样、BGM 资产类型、封装。
- 最小 MVP：固定音量 + 淡入淡出 + amix；再上 ducking/loudnorm。
- 详见 [h3-inmodel-bgm-experiment.md](h3-inmodel-bgm-experiment.md) §4 与本期讨论。
