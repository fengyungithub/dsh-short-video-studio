# 统一档位与工具面：图片/视频一体化（设计定稿 v1.0）

> 状态：**已拍板，待实施**（P0 完成）
> 关联：[`docs/tier-strategy-design.md`](tier-strategy-design.md)（三层模型原稿）、[`docs/workflow-contract.md`](workflow-contract.md)、[`docs/ARCHITECTURE.md`](ARCHITECTURE.md)

---

## 0. 动机：实现层泄漏进了调用面

| # | 现状 | 问题 |
|---|---|---|
| 1 | 图像能力「未分档」，走 `modes:{quality,fast}` 的旧兼容路径；视频走 `tier` | 同一件事两个词汇表；`mode=` 会**按名字隐式挑实现**（实测踩过：漏传 workflow 时落到 FLUX） |
| 2 | `comfy_render` / `video_upscale` 暴露 `workflow=` | 实现成了调用方参数 ⇒ 技能/prompt/脚本里写满实现 id，违背「只表达能力」 |
| 3 | 图片清单 `resolution.policy="explicit"` | **画布 aspectRatio 对图片不生效**；竖版必须每次显式传宽高 |
| 4 | `computeManifestSize` 要求 `width && height` | **只传一个宽高 = 静默忽略** |
| 5 | i2i 声明 `resolution.default` 但无注入点 | 节点记名义 1344×768、产物跟参考图 ⇒ 拆账错误 |
| 6 | Qwen i2i 的 `resolution` 写死 | **i2i 出不了 2K** |
| 7 | 参数无注入点时静默丢弃（如 Qwen 的 `guidance`） | 调用方以为生效 |
| 8 | `priority<0` 的实验档（ctx/PDD/Sol/x4）靠 `workflow=` 才可达 | 去掉 `workflow=` 后需要配置面通道 |

---

## 1. 三层模型（边界恢复）

```
能力 capability  →  档位 tier (fast < balanced < quality)  →  实现 manifest
   ↑ 调用面只说这个        ↑ 调用面只说这个                    ↑ 只在配置面出现
```

- **调用面（工具 + 技能）** 只接受：能力、档位、画幅/分辨率表达、创作参数（prompt / 参考图 / 首末帧 / 时长）。
- **实现选择是配置面的事**：`cfg.pins` → `cfg.tiers[capability][tier]` → `cfg.preferred[capability]`（家族）→ 候选序。
- **调用面永不出现 `workflow`。**

---

## 2. 决策记录（P0 拍板）

| 决策 | 结论 |
|---|---|
| **D1 档位声明形态** | **一档一清单**（与 H3 一致）：`<family>-<tier>.json`，`group = <family>`；由生成器从模板产出，人只改模板 |
| **D2 钉实现通道** | **保留配置面 `pins`**（设置页可写）；脚本走 `_internals`；调用面仍无 `workflow` |
| **D3 图片默认档** | **`quality`（长边 2048 / 2K）** —— 单张成本从 ~6s 涨到 ~63s（A800 实测），是刻意选择 |
| **D4 列表暴露粒度** | `comfy_list_workflows` 主输出 = 能力 → 档位 → {可用性/交付尺寸/耗时}；**实现 id 收进诊断字段**，技能不引用 |

---

## 3. 清单契约（形态 B 定稿）

### 3.1 命名与分组

```
qwen-image-21-t2i-fast.json    { "id": "qwen-image-21-t2i-fast",     "tier": "fast",     "group": "qwen-image-21-t2i", ... }
qwen-image-21-t2i-balanced.json{ "id": "qwen-image-21-t2i-balanced", "tier": "balanced", "group": "qwen-image-21-t2i", ... }
qwen-image-21-t2i-quality.json { "id": "qwen-image-21-t2i-quality",  "tier": "quality",  "group": "qwen-image-21-t2i", ... }
```

- **`group` = 家族 id**：它就是配置面的选择单位（`pins` / `preferred` 都可以写家族名），与策略矩阵（`groupNameOf`）现有语义一致。
- `modes` 字段**删除**（读兼容一版 + deprecation warning），「按 mode 名匹配」整条路径**移除**。

### 3.2 生成器与模板（与 H3 同构）

```
scripts/image-templates/<family>.json      # 手写源：一份图结构 + 三档差异表
        ↓  node scripts/make-image-variants.mjs
workflows/<family>-<tier>.json             # 产物，勿手改（同 H3 的约定）
```

模板里的档位差异表（示意）：

```jsonc
"tiers": {
  "fast":     { "steps": 20, "longSide": 1024, "estSeconds": 4,  "referencePixels": 768,  "label": "调试" },
  "balanced": { "steps": 30, "longSide": 1344, "estSeconds": 6,  "referencePixels": 1056, "label": "日常" },
  "quality":  { "steps": 40, "longSide": 2048, "estSeconds": 63, "referencePixels": 2048, "label": "成片（2K）" }
}
```

生成器负责：把差异表展开成三份清单（各自写死本档的 `steps` 初值）、按 32 对齐校验长边、把 `longSide` 写进 `resolution`、把 `referencePixels` 接到 `params.reference_pixels`、填 `estSeconds`/`label`/`requiresNodes`。

### 3.3 图片档位参数表（本机 A800 实测校准）

| capability | tier | 长边 | 典型尺寸(16:9) | steps | 实测耗时 |
|---|---|---|---|---|---|
| `image.text2image` | fast | 1024 | 1024×576 | 20 | ~3 s |
| | balanced | 1344 | 1344×768 | 30 | ~6 s |
| | quality | **2048** | 2048×1152 | 40 | ~40–60 s |
| `image.image2image` | fast | （跟随参考图）| referencePixels **768** | 20 | — |
| | balanced | | referencePixels **1056** | 30 | ~? |
| | quality | | referencePixels **2048** | 40 | ~60 s 级 |

> i2i 的「长边」由参考图决定，档位只控制**参考图重采样预算** `referencePixels`（注入 `TextEncodeQwenImage21.resolution`），⇒ i2i 首次具备 2K 能力（清 #6）。

### 3.4 分辨率声明统一

```jsonc
"resolution": { "policy": "aspect-ratio", "snap": 32, "longSide": 2048, "default": [2048, 1152] }
```

解析优先级（修订 `computeManifestSize`）：

```
① resolutionLock.graph      图锁定（放大类）→ 宽高与画布比例都失效 + warning（不变）
② 显式 width / height       两个都给 → 原样；只给一个 → 另一边按画布比例推导（清 #4）
③ policy=aspect-ratio       画布 aspectRatio × 本档 longSide（snap32）
④ resolution.default / 兜底 1344×768
```

---

## 4. 解析语义（修订 tier-strategy-design §5）

```
capability + tier
  1. cfg.pins[capability]           家族名或实现 id，**钉死**；与请求档位不匹配 → 报错（不静默）
       pins 可写成 { "image.text2image": "qwen-image-21-t2i" }（家族）或 "…-quality"（单实现）
  2. cfg.tiers[capability][tier]    设置页选定的实现
  3. cfg.preferred[capability]      **家族序**：取第一个在该档有实现的家族（家族 = group，或 id === family）
  4. 该 (capability,tier) 候选首个   priority 降序 → 无加速优先 → id 升序
  缺档 → 显式报错并列出该能力可用档位（保留）
  未声明 tier 的旧清单 → 过渡期旧路径 + deprecation warning（一版后删除）
```

**`preferred` 语义升级（关键迁移点）**：从「精确 id 列表」变成「**家族优先序**」。
用户现有 `preferred["image.text2image"] = ["qwen-image-21-t2i"]` 在拆分后**无需改动**即继续生效——拆分后的三份清单 `group` 都是 `qwen-image-21-t2i`。

---

## 5. 工具面（调用面收敛）

| 工具 | 变更 |
|---|---|
| `comfy_generate_image` | 加 `tier?`（默认 quality）；其余不变 |
| `comfy_generate_video` | 去 `mode`（保留一版弃用别名 → tier）；`type` 形状契约不变 |
| `comfy_render` | **去 `workflow`、去 `mode`**；`workflow=` 直接报错并指路（配置页 pin / 改档位） |
| `video_upscale` | 去 `workflow`；`tier` + `target_width` 不变 |
| `comfy_list_workflows` | 主输出 = 能力 → 档位 → {可用性, 交付尺寸, 实测耗时, 备注}；实现 id 进 `diagnostics` 字段 |

**钉实现通道**：`cfg.pins`（设置页可写）+ 脚本走 `_internals.resolveTieredManifest(..., explicitWorkflow)`。

---

## 6. 记账与告警（清 #5 #7）

1. **产物尺寸如实回填**：图片落盘后读 PNG/JPEG 头（视频用 `probeMp4`）写节点 `width/height`；与首遍尺寸不同则另记 `graphWidth/graphHeight`。
2. **参数支持面检查**：调用方传了但所选清单无注入点的参数 → `warnings`（工具返回 + 节点 `params.warnings`），禁止静默丢弃。
3. 节点 `params.mode` 只读兼容；新节点写 `tier`。

---

## 7. 技能与文档改写

- 删：全部 `workflow=` 教学、实现 id 举例、「换模型先查注册表再显式指定 workflow」流程。
- 改：「生成 = 选能力 + 选档位 + 给画幅 + 给创作参数；实现由配置决定，技能不参与」。
- 「换工作流」选项卡 → 「该档位不可用时的处置」（改档位 / 改配置 / 跳过）。
- 范围：`3d-animation-short-generator`、`brand-promo-video-generator`、`video-generate`、`image-generate`、`h3-prompt-writing`（含 references）+ `lib/index.js` 的系统提示词 `GUIDANCE`。
- 设置页保留实现列表（配置面），仅改文案。

---

## 7.1 设置页交互契约（2026-09 定稿）

- **默认视图只显示策略列表与名称**：每能力一条「内置默认」（label = **实际生效家族**）+ 用户自建策略；
  右侧只有「编辑档位 / 重命名 / 删除」（内置默认：编辑档位 / 恢复跟随首选）。
  策略行下方是**只读**摘要：`档位 → 实际生效实现（约 Ns）`，缺节点会标 `✗缺节点`。
- **档位表单只在点击「编辑档位」后出现**（多档下拉 + 每档「当前生效」+ 保存/取消），不再常显。
  - 内置默认不是用户对象、没有 id ⇒ 保存时写的是**该能力的逐档显式选择**（`cfg.tiers`），按钮文案＝「保存为逐档选择」；
    清空该能力显式选择用策略行的「恢复跟随首选」。
  - 自建策略的「编辑档位」＝就地更新它的档位快照（按钮＝「保存修改」）。
- **显示口径必须是「实际生效」**：后端在 `/api/workflows` 的每个能力上给出 `effective: {tier → 实现 id}`
  （= pins → `cfg.tiers` → preferred 家族序 → 候选首个），设置页的标题、摘要、表单预填**全部**读它。
  否则会出现「标题写 FLUX、实际跑 qwen」——UI 对用户撒谎。

## 8. 兼容与迁移

| 对象 | 处理 |
|---|---|
| `preferred` 的旧精确 id | 升级为家族语义 ⇒ 图片能力无需改配置即继续生效 |
| `tiers` / `pins` / `models.*` | 语义不变 |
| `assetOverrides[旧 id]` | 新增按 `group` 继承别名（`ASSET_OVERRIDE_ALIASES` 由「按族登记」扩展为「family → <family>-<tier>」） |
| 旧 H3 单档清单 | 不动（天然就是形态 B） |
| 旧图片清单的 `modes` | 读兼容一版 + deprecation |
| 画布旧节点 `params.mode` | 只读兼容 |
| 工具入参 `mode` | 弃用别名 → tier（返回 warning），一版后删除 |
| `comfy_render(workflow=…)` | **报错**并指路 |

---

## 9. 实施阶段与验收

| 阶段 | 内容 | 可执行验收 |
|---|---|---|
| **P0 ✅** | 本文档 + 四项决策 | — |
| **P1** | `make-image-variants.mjs` + `image-templates/` + 图片清单拆分；解析层：删 mode 路径、加 `pins`、`preferred` 家族语义、清单校验（`tier` 必填 + `longSide`/`referencePixels` 32 对齐） | `smoke-tier-resolution`：图片每 (capability,tier) 解析到预期实现；缺档报错列可用档；pins 冲突报错；旧 `preferred` 家族配置仍解析到同族 |
| **P2** | 工具面去 `workflow`/`mode` + `video_upscale` + `comfy_list_workflows` 诊断字段 + 系统提示词 | `smoke-tools`：生成类工具 schema **不含 `workflow`**；`comfy_render(workflow=)` 报错 |
| **P3** | 分辨率统一（aspect-ratio + 单边推导 + `reference_pixels` 注入） | 9:16 画布下 t2i 默认 1152×2048；只传 width → 高度按比例推；i2i quality 出 2K |
| **P4** | 交付尺寸如实回填 + 未支持参数告警 | 节点 `width/height` == 产物真实像素；Qwen+guidance → warnings 有明确提示 |
| **P5** | 技能/README/文档改写 + 全量 smoke + A800 真机 e2e（t2i/i2i/video 各一次） | `npm run smoke` 全绿 + `scripts/e2e-tier-pipeline.mjs` 全绿 |

### 实施状态（滚动更新）

| 阶段 | 状态 | 证据 |
|---|---|---|
| P1 图片并入 tier（一档一清单 + 生成器 + 解析层） | ✅ | `scripts/image-templates/` 4 模板 → 12 份产物；`make-image-variants.mjs --check` 进 smoke 链；旧 4 份未分档清单已删；`pins` / preferred 家族序 / 删 mode 名匹配 |
| P2 工具面去 workflow/mode | ✅ | 四个生成工具的 schema 无 `workflow`/`mode`（smoke-tools 断言）；runner 收到 `workflow=` **报错**；`comfy_list_workflows` 主输出改为「能力→档位」，实现 id 进 `diagnostics`；GUIDANCE 与 5 个技能改写 |
| P3 分辨率统一 | ✅ | 图片清单改 `policy=aspect-ratio`；只传一边→另一边按画布比例推导（smoke-render 断言）。实测 9:16 画布下 t2i fast = 576×1024 |
| P4 记账与告警 | ✅ | `probeImageSize`（PNG/JPEG/WebP）回填真实像素；未支持参数进 warnings（工具返回 + 节点 `params.warnings`）。实测 i2i quality：节点记 1536×2720 == 产物真实像素，且收到「width 未生效」+「交付尺寸以产物为准」两条警告 |
| P5 技能/文档 + 真机 e2e | ✅ | `npm run smoke` exit 0；`scripts/e2e-tier-pipeline.mjs` 三能力真机跑通（t2i 4s / i2i 2K 119s / video fast 98s） |

**遗留**：`~/.dsh/dsh-short-video-studio/workflows/` 下两份**未分档旧清单**（`flux2-img2img.json`、`z-image-turbe-t2i.json`）现为 legacy（只 pin 可达，不参与档位解析），需用户决定迁移或删除。

**回归红线**：任何阶段都不允许「同一请求被隐式换实现」——实现只能来自配置或显式档位。

---

## 10. 遗留风险

- **成本**：图片默认档 = quality(2048) ⇒ 短剧项目里"抽卡"类调用（角色卡/场景卡迭代）单张从 ~6s 涨到 ~63s。缓解：技能里对**迭代**用 `tier=fast/balanced`、只对**定稿**用 quality（该约定写进技能，属 P5）。
- **`estSeconds` 需要重标**：图片三档的实测耗时要在本机跑一遍填回去，否则列表里的代价数字是错的。
