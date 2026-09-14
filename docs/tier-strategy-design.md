# 档位 · 策略 · 工作流：契约定稿

> 状态：**设计冻结**（2026-09，讨论定稿）· **实现完成**（P1–P5 已落地，见 §8）。实现按本文档执行；改设计先改本文档。
> 背景数据见 `docs/minimax-h3-video-benchmark.md`（耗时/画质/加速实测）与 `docs/minimax-h3-acceleration-lora.md`（Sol-Attn 细则）。

## 0. 要解决的问题

现状有两个结构性缺陷：

1. **档位与实现的关系不诚实**：`modes` 允许一个 json 覆盖多档（`minimax-h3-ref2v.json` 同时是 quality 与 fast），而真正的档位差异（shift/采样器/是否插加速节点）又必须拆成独立 json（`-8step`、`-sol`）。结果是"产品层显示 3 档、实际只有 1 个实现"的假象，以及"清单内档位 / 清单级档位"两套概念并存。
2. **跨档静默降级**：`resolveMode()`（`lib/index.js:962`）在显式 `mode` 不在清单 `modes` 里时**静默取首个 mode**。用户把某能力默认工作流设成单档清单后，工具条默认的 `fast` 会被静默换成该清单首档（例如 20 步），而 UI 仍按 `fast?832:1344` 硬编码显示尺寸 → 档位与尺寸双重失真，技能侧还会把"fast 档"写进简报。

## 1. 三层模型

```
原材料层  <组名>-<档位>[-sol].json   一个 json = 一个实现单元，只属于一个档位（可含加速节点）
注册层    同名聚合成「组」；每实现带可用性预检、实测耗时、提示文案；策略由注册层投影
产品层    每能力 × 每档 → 用户选中的一个实现；用户只看到「组名（档位列表）」与两个策略条目
```

原则：**workflow 是原材料，注册表是策略，产品层只暴露档位。**

## 2. 档位词汇（锁定）

`fast` | `balanced` | `quality`，**受控枚举，不做第四档**。导入时必须从枚举里选，不接受自由文本。

| 档位 | 语义 | 内置实现（ref2v 例） |
|---|---|---|
| `fast` | 验证链路/构图，允许画质下降 | 4 步 544p LoRA · 长边 832 · shift 12/3 · res_multistep · **无 Sol** |
| `balanced` | 日常主力 | 8 步 768p LoRA · 长边 1344 · shift 6/3 · euler · **带 Sol** |
| `quality` | 成片 | 20 步 · 长边 1344 · shift 12/3 · res_multistep · **带 Sol** |

## 3. 清单字段契约

```jsonc
{
  "id": "minimax-h3-ref2v-quality-sol",     // 落盘约定 <组名>-<档位>[-sol]，由 UI/生成器产出
  "group": "minimax-h3-ref2v",              // 组的唯一依据（不从文件名猜）
  "tier": "quality",                        // 受控枚举
  "accel": "sol",                           // 信息性：UI 标注/分组，不参与解析
  "capability": "video.reference2video",
  "displayName": "MiniMax H3 参考生成视频",  // 组内一致；策略条目 = displayName +「（无加速）/（有加速）」
  "requiresNodes": ["SolAttnMiniMaxH3"],    // 预检依据：缺 → 显式不可用（不静默回退）
  "estSeconds": 311,                        // 口径：16:9 · 124 帧 · 该档长边 的实测秒数
  "note": "Sol-Attn 加速 · 1344×768 实测 1.27× · 480p 无收益",
  "internal": false,                        // true → 诊断清单（如 -sol-stats）不进任何 UI/技能选项
  "priority": 0
}
```

- `estSeconds`：内置清单由生成器从 benchmark 数据自动填；用户上传留空 → UI 显示「耗时未知」。
- 口径修正：UI 预估 = `estSeconds × 帧数/124 × 画幅修正`（16:9 = 1.00，9:16 = 1.08，来自 832 长边 24.6s vs 26.6s 的实测）。长 duration 的线性缩放**未实测**，标注为近似。
- **兼容**：`modes` 仅作只读兼容（老的自定义清单仍可跑），**不再参与档位解析**；`preferred` 退化为「未分级清单」的固定选择。

## 4. 策略投影（配置页条目从组内实现自动生成）

| 条目 | 投影规则 |
|---|---|
| `<displayName>（无加速）` | 每档 → 组内该档的**非 accel 实现** |
| `<displayName>（有加速）` | 每档 → 组内该档的 **accel 实现**；该档无 accel 实现则用标准实现 |
| 「自定义」 | 用户逐档覆盖（可跨组、可混加速）；一旦覆盖即显示为「自定义」 |

- 策略**不是活引用**：点击即把具体实现 id 写入配置（快照语义）。否则节点缺失时策略会变成隐式回退，与"不静默"自相矛盾。
- **投影结果相同时只显示一条**：若某组没有任何 accel 实现（两条投影逐档完全一致），配置页**不显示「（有加速）」条目**——否则又会出现"两个选项选出来一样"的假象。
- **默认条目 =（无加速）**。等一条完整片子验完再考虑翻默认。
- 某档在组内无任何实现 → 该档不出现/置灰（**不是回退，是根本没有候选**）。

### 4.1 配置形状

```jsonc
{
  "tiers": {
    "video.reference2video": {
      "fast":     "minimax-h3-ref2v-fast",
      "balanced": "minimax-h3-ref2v-balanced-sol",
      "quality":  "minimax-h3-ref2v-quality-sol"
    }
  }
}
```

## 5. 解析与错误语义

```
输入：capability + tier（+ 可选显式 workflow）
1. 显式 workflow → 直接用；若其 tier ≠ 请求档位 → **报错**（不静默）
2. 取配置中该 (capability, tier) 选定的实现
3. 未配置 → 组内该档标准实现（priority desc → id asc）
4. 所选实现不可用（缺 requiresNodes / 文件被删）→ **报错**，
   信息含：节点名、安装途径、当前选择、「一键改选标准实现」按钮（显式动作，绝不自动替换）
5. 该档无任何实现 → 报错并给出可用档位列表
```

- **可用性预检**：注册表加载时读 ComfyUI `/object_info`（TTL 缓存），写入矩阵；渲染前再走缓存校验一次。
- **ComfyUI 离线 = 未知**，不判死（否则断网时设置页全灰）；此时照常可选，渲染时校验。
- **禁止 `resolveMode` 式静默回退**：显式档位/模式不匹配一律报错。
- 允许但要说实话：fast 档挂 Sol（832 实测仅 1.03×，480p 高频 −13.8%）、跨组混档（观感可能漂移）——不禁止，UI 一行小字给出实测依据。

## 6. 产品面

### 6.1 配置页（`settings.section`）
```
video.reference2video
  ( ) MiniMax H3 参考生成视频（无加速）      ← 默认
  (•) MiniMax H3 参考生成视频（有加速）
      fast      minimax-h3-ref2v-fast            ✓ 可用 · 实测 24.6s @832×480
      balanced  minimax-h3-ref2v-balanced-sol    ✓ 可用 · 实测 136.3s @1344×768 · Sol 1.23×
      quality   minimax-h3-ref2v-quality-sol     ✓ 可用 · 实测 311.2s @1344×768 · Sol 1.27×
  ( ) 自定义 ▾   （逐档下拉，按组分组，可跨组）
  ── 未分级清单： my-wf（未声明档位 · 画质/成本未知）
```
不可用实现置灰 + 原因；当前选中项不可用时页面顶部告警横幅。导入表单：**名字 + 档位（受控枚举）** → 落盘 `<组名>-<档位>`，并写入 `group`/`tier`。

### 6.2 工具条
档位下拉 = 当前能力可用档位（缺档置灰）；尺寸与耗时**读解析结果**（删除 `fast?832:1344` 硬编码）；**无加速开关**。

### 6.3 技能
只谈档位；缺档不列；开场选项卡显示档位 + 全片耗时预估；「全片同档同实现」由硬规则降为**提示 + 逐镜自检门**；字幕等文字质量问题用自检门发现并给选项，不强制升档。`tier` 与所选实现随 canvas state 持久化。

## 7. 内置清单拆分

一个 json 只服务一个档位（含 sol 折叠进同档实现），`modes` 退役为只读兼容：

| 组 | 档位实现 | 备注 |
|---|---|---|
| `minimax-h3-ref2v` | `-fast`（标准）/ `-balanced-sol` / `-quality-sol` | 有加速条目 = balanced+quality 带 Sol |
| `minimax-h3-i2v` | `-fast`（标准）/ `-balanced-sol` / `-quality-sol` | 有加速条目 = balanced+quality 带 Sol；`balanced` 于 2026 补齐（fl2v 8 步 **768p** LoRA + shift 6/3，独立模板） |
| 诊断 | `-sol-stats`（`internal: true`） | 永不进 UI/技能 |

**json 是产物**：由 `scripts/make-h3-variants.mjs` 从一份 base 定义产出（自动填 `requiresNodes`/`estSeconds`/`note`），人只改 base。孪生实现（同档 -sol 与标准版）保持同步是生成器的责任。

## 8. 实施阶段与验收（P1–P5 已全部完成）

| 阶段 | 内容 | 状态 | 验收 |
|---|---|---|---|
| P1 | schema 加字段（`group`/`tier`/`accel`/`requiresNodes`/`estSeconds`/`internal`）；注册表输出**档位 × 实现 × 可用性矩阵**（`describeTierMatrix`）；解析层按 tier 解析 + **删除 `resolveMode` 静默回退** + 缺档/不可用**显式报错**；`/object_info` 预检；**旧 id 配置迁移**（`LEGACY_MODEL_ASSET_MAP` 按族登记 + `ASSET_OVERRIDE_ALIASES`：拆分后新 id 继承旧 id 的 `assetOverrides`，旧 `models.*` 键继续生效，旧配置不失效） | ✅ 完成 | `node scripts/smoke-tier-resolution.mjs` — **50 断言全过**：每 (capability,tier) 解析到预期实现；未分档旧清单按 mode 名匹配、匹配不到报错；缺节点报错文案正确；`internal` 清单不进矩阵；`probe=false` → 可用性未知(null)；**每份档位清单都有旧 id 的 `assetOverrides` 继承入口 + `models.*` 兜底映射 + 实际生效资产值齐备，别名表指向合法旧 id** |
| P2 | `scripts/make-h3-variants.mjs` 生成器 + `scripts/h3-templates/` 模板 + **8 份单档清单**（ref2v 5 份 / i2v 3 份 / 诊断 1 份 `internal`，sol 折叠进同档实现）；`estSeconds`/`requiresNodes`/`note` 自动填 | ✅ 完成 | `node scripts/verify-h3-variants.mjs` — **108 断言全过**：各 (capability,tier) → 预期实现 id；16:9 / 9:16 尺寸推导正确；quality 清单可编译（含音频/视频 VAE 解码）；诊断清单 `internal=true` 且不参与任何隐式解析候选 |
| P3 | 配置页：**策略条目**（`〈displayName〉（无加速）` / `（有加速）`）+ **逐档下拉** + 可用性置灰与告警横幅 + 导入表单**组名 + 档位（受控枚举）** | ✅ 完成 | 手动验证：选「有加速」→ 三档实现正确（ref2v = fast 标准 / balanced+quality 带 Sol）；断网显示「未知」；缺节点置灰；投影结果相同时不显示「（有加速）」条目 |
| P4 | 工具条：**档位三档下拉**、**尺寸与耗时读档位矩阵**（清单 `longSide` / `estSeconds`，矩阵未加载时按档位内置口径 fast 832 / 其余 1344 兜底）、无加速开关 | ✅ 完成 | UI 显示尺寸 = 实际出片尺寸；耗时读 `estSeconds`（按帧数/画幅修正）；显示解析到的实现 id 与缺节点告警 |
| P5 | **技能 3 份（本次）+ 字幕配方单源化 + 契约文档（README / tier-strategy-design）** | ✅ 完成（本次） | 三份 skill 无旧二元档位表述；`h3-prompt-writing` §字幕为唯一权威版；`tier=` 取代 `mode=`；README 旧清单 id 已更新 |

**验收脚本**（改档位契约后必须两个都跑）：

- `node scripts/smoke-tier-resolution.mjs` — **50 断言**：解析层语义（显式 workflow 跨档报错、配置选定实现、组内该档标准实现、缺档列可用档位、旧 `modes` 清单兼容不崩、`describeTierMatrix` 数据源），以及**旧 id 资产覆盖继承 / `models.*` 兜底映射 / 别名表合法性**。
- `node scripts/verify-h3-variants.mjs` — **108 断言**：8 份单档清单的 id/档位/尺寸/可编译性，以及诊断清单不进产品面。

**P5 技能侧落地口径**（技能里只出现这些）：

- 档位受控三档 `fast`（调试/调构图，长边 832）/ `balanced`（日常，长边 1344）/ `quality`（成片，长边 1344）；呼叫工具**显式传 `tier=`**，`mode=` 仅作兼容别名不写进技能。
- **技能里绝不出现 sol / Sol-Attn / 加速实现 id 或节点名**：加速是用户设置的**策略条目**，技能只谈 `tier`。
- i2v 缺 `balanced` → 技能如实写「i2v 只有 fast/quality，请求 balanced 会报错」，并把「改请求可用档位」写进失败梯度（不原样重试）。
- 字幕：**每档都能出字幕，无档位硬规则**；配方单源在 `h3-prompt-writing` §字幕（唯一权威版），片型 skill 只引用不另立简化版。
- 拼接：**所有片段必须同分辨率**，跨档升档在生成前决定。


## 9. 未决

- 默认策略条目：暂定「无加速」，整片验证后可翻「有加速」。
- i2v 的 `balanced` 是否补（需 i2v 8 步 LoRA 资产）。**当前状态**：刻意空缺——矩阵置灰，`tier=balanced` 显式报错并列出可用档位（fast / quality），技能侧已按此口径写明失败梯度。
- 长 duration（250/372 帧）的耗时线性假设未实测。
- 多行/竖版字幕在各档的字准样本量不足（n=1）。**当前状态**：配方已单源到 `skills/h3-prompt-writing` §字幕（唯一权威版），已实测的是 quality 逐字一致 / balanced 整段未烧 / fast 有错字；样本量为 1，多行与竖版待补测后回填该节。
