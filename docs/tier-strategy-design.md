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
**枚举是词汇表，不是每份清单的档位清单**：一个能力可以有多份实现（如 ref2v 的 lightx2v 版与 PDD 版），
每份只声明自己的档（轻量/激进蒸馏实现可以只提供 `balanced`），能力层的档位列表 = 各实现的并集。

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

## 4. 策略（配置页条目）

**策略 = 一套档位组合，由用户命名。** 注册表只提供一条**内置默认**，其余由用户自建——`workflow` 是原材料，
谁和谁凑成"一条策略"是用户的判断，不该由插件替他认定（Sol / PDD / 蒸馏版本只是可选清单）。

| 条目 | 来源 | 每档取值 |
|---|---|---|
| `<主家族名>`（内置默认） | 注册表 | 该档的**非加速首选实现**（priority 降序 → 非 accel 优先 → id 升序）；选中它 = **清空**该能力的档位快照 → 跟随注册表首选 |
| `<用户起的名字>` | 配置 `strategies[capability][]` | 用户在配置页逐档挑的实现 id（可为空档 → 该档跟随注册表首选）；选中它 = 写入这份**快照** |
| `自定义（逐档自由组合，未保存为策略）` | 派生 | 当前生效组合不等于任何已命名策略时显示 |

- **点选即快照**：写的是具体实现 id，不是活引用。缺节点时按 §5 显式报错，绝不静默替换成别的实现。
- **选中态判定 = 实际生效口径**：显式选择优先、未显式选择的档位取注册表首选。因此"balanced 显式 + quality 跟随默认"也能被正确点亮，不会永远显示成"自定义"。
- **消歧**：若某条用户策略的组合恰好等于默认，按匹配规则会两条同时点亮 → 以用户实际点过的 `strategyOf` 为准，只点亮那一条。
- **新增／重命名／删除**都在配置页完成（`＋ 新增策略（命名 + 逐档组合）`）；新增即选用。删除只删策略，当前档位选择保持不变（回落到"自定义"）。
- 策略列表上限 24 条/能力，名字截 40 字；配置里指向不存在实现的选择在投影时被丢弃（不留死引用）。

### 4.1 配置形状

```jsonc
{
  // 真正生效的档位选择（快照）：capability → tier → 实现 id
  "tiers": {
    "video.image2video": { "balanced": "minimax-h3-i2v-balanced-pdd-sol" }
  },
  // 用户自建策略（可命名、可删、可复用）
  "strategies": {
    "video.image2video": [
      { "id": "s-demo", "name": "我的 PDD 快出片（8 步 + Sol）",
        "tiers": { "balanced": "minimax-h3-i2v-balanced-pdd-sol", "quality": "minimax-h3-i2v-quality-sol" } }
    ]
  },
  // 最近一次点过的策略（仅用于 UI 点亮与消歧）
  "strategyOf": { "video.image2video": "s-demo" }
}
```

## 5. 解析与错误语义

```
输入：capability + tier（+ 可选显式 workflow）
1. 显式 workflow → 直接用；若其 tier ≠ 请求档位 → **报错**（不静默）
2. 取配置中该 (capability, tier) 选定的实现
3. 未配置 → 该 capability 下**所有实现**里，该档的候选按 `priority desc → 非 accel 优先 → id asc` 取首个
   （这是**跨实现**排序；把某份实现设成 `priority < 0` 即可让它"**可显式选中、但不参与隐式默认**"
   ——PDD 清单正是这么做的，它依赖第三方节点）
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
  (•) MiniMax H3 参考生成视频            [内置默认]   ← 跟随注册表首选（各档非加速首选）
      fast → fast　｜　balanced → balanced　｜　quality → quality
  ( ) 我的 PDD 快出片（8 步 + Sol）      [重命名] [删除]   ← 用户自建：balanced → …-pdd-sol
  ( ) 自定义（逐档自由组合，未保存为策略）
  ＋ 新增策略（命名 + 逐档组合）  ← 展开＝策略名 + 每档一个下拉（按家族 optgroup 分组，可跨清单）
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
- ~~i2v 的 `balanced` 是否补~~ → **已补齐**（2026-09，i2v 8 步 768p fl2v LoRA + shift 6/3 专用模板 `minimax-h3-i2v-8step`，实测 177.3s）。
- **PDD 是否再加档位**：目前 PDD 清单只提供 `balanced`（nfe=8，已实测）。官方还允许 `nfe=4`（块长重排，未实测）与"两段式超分"（`MiniMaxH3AVLatentUpscaleBy`，节点包自带纯 resize，未实测）——需要更低成本时再补清单，不动现有清单。
- **PDD 的多镜头一致性未验**：现有画质结论来自单帧/单 seed；同一部片子若混用 PDD 与非 PDD 档，观感是否漂移未知（与 Sol 的"不逐镜混用"同理需要一部完整片子验证）。
- 长 duration（250/372 帧）的耗时线性假设未实测。
- 多行/竖版字幕在各档的字准样本量不足（n=1）。**当前状态**：配方已单源到 `skills/h3-prompt-writing` §字幕（唯一权威版），已实测的是 quality 逐字一致 / balanced 整段未烧 / fast 有错字；样本量为 1，多行与竖版待补测后回填该节。
