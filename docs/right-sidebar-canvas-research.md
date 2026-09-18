# 右侧栏可否扩展 · 画布入右栏可行性调研

> 调研对象：DeepSeek Harness Web Client 的**右侧栏**（right Sidebar），以及把本插件的「画布」从会话视图 tab 迁入右侧栏的可行性。
> 方法：源码勘查（`~/Workspace/deepseek-harness`）+ 官方子系统文档 + 本插件现有实现对照 + 离线渲染垫片可验证性评估。
> 基线：DSH `0.1.6-alpha.1`（安装于 `~/.npm/_npx/17a9d21cb3cbed8e/node_modules/@deepseek-ai/dsh`；源码 checkout `dsh-v0.1.6-alpha.1-5-g0d1f50007f`），插件 `dsh-short-video-studio@1.3.0`。

---

## 0. 结论摘要

| 问题 | 结论 |
|---|---|
| 右侧栏能否扩展？ | **能，而且是官方一等公民扩展点**，不是 hack。有完整的「tab 类型注册表 + 两个 keyed 正文席位 + 导航服务」，源码注释明说 key 域保持开放字符串空间**就是为了让产品之外的包注册类型**。 |
| 把画布放进右栏可行吗？ | **技术上完全可行，改动很小**：只动浏览器半（`lib/client.js` + `package.json` 一行），宿主半与 `studio/` 页零改动，约 60–100 行。 |
| 有硬阻塞吗？ | **没有硬阻塞**。有 3 个软约束：① 布局不持久化（刷新后右栏回到折叠态，要重新打开画布）；② 插件无法以编程方式把右栏切到全屏（只有用户点面板控件）；③ 若「会话区画布 tab」与「右栏画布 tab」同时挂载，同一会话会出现两个 studio 实例（数据安全，但可能显示不同步）。 |
| 推荐做法？ | **右栏作为画布的新家 + 保留会话区 tab 作为大屏入口，用「一键换家」按钮做互斥**（详见 §6 方案 C 与 **§12**）。右栏的杀手级收益是「**对话与画布同屏**」——今天切到对话会卸载画布 iframe，「跟随最新」自动滚动因此失效；右栏让它真正可用。 |
| 「画布上放一个换家按钮」可行吗？ | **可行，双向都只用公开 API**（见 **§12**）：句柄是 `conversation.view` 条目手里的 `openView` owner prop。但这个方案已被 **§13 的静态配置方案取代**——后者更简单且结构上排除双实例。 |
| **最终采纳方案** | **把「家」做成插件级配置项 `canvasHome: 'tab' \| 'sidebar'`，放在「设置 → ComfyUI」**（见 **§13**）。改动约 25 行分支 + 设置页一个下拉 + 配置白名单两行；只注册一个家 ⇒ 结构上不可能双实例；代价是改配置后需刷新页面。**右栏入口照抄 `files`/`terminal` 的原生做法**——类型定义里加 `guide` 字段（3 行），出现在右栏引导页的胶囊上，不自造入口（§13.5）。 |

---

## 1. 右侧栏是什么

右侧栏不是「一个可以塞组件的 div」，而是一套**按地址寻址的停靠面（docking surface）**，每个会话一份：

```
rightbar                      ← root 作用域席位（ui-layout 声明）
└── rightbar.session           ← session 作用域；每个会话一个停靠面
    └── DockSurface (ui-dockkit)  ← 纯布局引擎：pane 树 / tab 条 / 拖拽 / 浮窗
        ├── sidebar.right.pane.tab        (keyed, session)  tab 正文
        ├── sidebar.right.pane.tab.title  (keyed, session)  chip 活标题
        ├── sidebar.right.tab.menu.item   (list,  session)  tab 菜单追加项
        └── sidebar.right.tab.guide       (chain, session)  替换引导页正文
```

- 官方文档：`docs/subsystems/sidebar-right.zh.md`（本调研大量引用）。
- 内置类型：`guide`（引导页）、`files`（文件树）、`text`（文档预览）、`terminal`。
- 默认在 Web 里启用：`@deepseek-ai/dsh-web-app/cordis.patch.yml` 的浏览器 roster 里 `ui-sidebar-right` / `-documentpreview` / `-terminal` / `-files` 四行都是启用状态（该文件 L222–236）。
- 入口：折叠时由会话 header 角落席位的一个按钮展开（`conversation.session.header.corner`，即 `ExpandButton`）；展开后 tab 条最右端有「形态切换 / 折叠」两个控件。

---

## 2. 扩展点清单（官方支持的三种外挂方式）

### 2.1 注册一个 tab 类型（两阶段）

这是**唯一需要的方式**，两阶段都在插件自己的 `ctx.effect` 里，随插件同生共死。

**阶段一：静态定义**（`ctx.sidebarRightTabs.register(definition)`）

| 字段 | 说明 |
|---|---|
| `id` | 实现身份，全局唯一（包名是自然取值）。**同时是阶段二注册用的 key。** |
| `kind` | 类型判别名，`openTab` 点名的对象。**kind 可以不唯一**（extension 能接管 builtin）。 |
| `patterns?` | 资源地址 glob。**页面类型省略**（画布属于页面类型）。 |
| `priority?` | `extension`（缺省，最高）／`builtin`／`fallback`。产品外的类型缺省就是最高档。 |
| `canOpen?` | 同步否决谓词。 |
| `title(address)` | chip 文本，**打开时捕获一次**，之后不再改写（要活标题得注册标题席位）。 |
| `guide?` | `[{ id, order, title(), description?(), icon? }]` 引导页入口胶囊；省略则不上引导页。 |
| `multiple?` | 每次打开创建独立实例（终端用；画布不需要）。 |

**阶段二：正文**（keyed 席位，key 就是上面的 `id`）

```js
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
  { name: 'sidebar.right.pane.tab', key: definition.id }, Body,
))
```

可选再注册 `sidebar.right.pane.tab.title` 拿活标题。

**权威代码**：`packages/client/ui-sidebar-right/src/client/index.ts:108-109`（provide 两个服务）、`contract/slots.ts:42-90`（SlotMap 声明）、`tab-registry.ts`（注册表与档位）、`ui-sidebar-files/src/client/index.ts`（最小完整范本，40 行）。

**外部包是一等公民的直接证据**（源码原文）：

> `contract/slots.ts:26` — "The key domain stays the open string space because **a tab type may ship from outside this repository**."
>
> `packages/client/ui-sidebar-right/src/client/index.ts:22` — "The guide registers through those stages unmodified, exactly as a type shipped from another package does — **`ui-sidebar-documentpreview` is the live proof**."

### 2.2 导航服务 `ctx.sidebarRight`

| 方法 | 用途 | 对本插件的价值 |
|---|---|---|
| `openTab(kind, options?)` | 按 kind 打开页面，**同一步自动展开右栏**（"用户看不见的内容不算打开"） | 工具栏按钮一键把画布推到右栏 |
| `openResource(address, options?)` | 按 `dsh-resource://` 地址打开 | 用不上 |
| `close(tabId)` / `active()` | 关 / 读当前活动 tab | `active()` 可做互斥守卫 |
| `isExpanded()` / `toggleExpanded()` | 读 / 翻转展开态 | 可做「画布是否可见」判断 |
| `focus` / `split` / `float` / `dock` | 聚焦、分栏、**浮窗**、收回 | `float()` 把画布变成可拖拽缩放的浮动大窗 ★ |
| `registerCloseHandler(kind, handler)` | 显式关闭前的同步清理 | 画布无需清理，可不注册 |

放置选项：`paneId` / `replaceTab` / `revealIfOpened`（页类型在目标格内恒定去重）。

**没有**：`setExpanded` / `setMode`（形态切换）不在公开面上 → **插件无法编程式切全屏**；也没有布局快照与订阅（服务只暴露操作，文档「不做」清单明确列出）。

### 2.3 标准 props —— 关键的一条

官方文档 `docs/subsystems/slots.zh.md:79`：

> 「当前组合中的 adapter 会添加以下标准 props。**它们按目标 slot 的 scope 提供，与注册组件来自哪个包无关。**」

| 可用范围 | Props |
|---|---|
| 所有 scope | `useSessions`、`useSessionPendingInteraction`、**`useWorkspaces`**、`usePanelInfo` |
| `session` | **`sessionId`**、`useSession`、`useProjection`、**`useConversation`、`useInput`、`inputActions`**、`useChat`、`useTrajectory` |

这条直接把「画布组件需要的三个 props 在右栏还能不能拿到」变成了确定性问题 —— **能**，见 §3.1。

---

## 3. 画布入右栏：逐项对照

### 3.1 组件契约对照（`lib/client.js:40` 的 `CanvasView`）

`CanvasView` 一共只依赖三样东西：

| 依赖 | 现挂载点 `conversation.view`（session scope） | 目标挂载点 `sidebar.right.pane.tab`（session scope） | 判定 |
|---|---|---|---|
| `props.sessionId` | ✅ | ✅ `ui-session` 的标准 prop | **等价** |
| `props.useWorkspaces` | ✅ | ✅ 所有 scope 都有（`ui-workspace`） | **等价** |
| `props.inputActions`（`ask-ai` → `setDraft` 桥） | ✅ | ✅ `session` scope 标准 prop（`ui-conversation`） | **等价** |
| `tab.actions` / `signal` / `navigation` | 无 | 额外获得 `useTabInfo()` | **净增能力** |

结论：**`CanvasView` 可以原样搬过去，一行不改。** 这也解释了为什么这个改动量能压到几十行。

### 3.2 运行时环境对照

| 项 | 现挂载点 | 右栏 | 判定 |
|---|---|---|---|
| iframe 同源 | 宿主路由 `/dsh-short-video-studio/`，同源 | 同一 DOM 文档内，同源 | 同 |
| iframe sandbox 属性 | 自带 `allow-same-origin allow-scripts …` | 不变 | 同 |
| studio 页 token 注入 | `lib/index.js:3151` 伺服时把 `__DSH_SVS_TOKEN_VALUE__` 替换为进程级随机 token（`:3405`） | **同一进程同一个 token，多 iframe 无冲突** | 同 |
| 浮窗场景 | — | `FloatLayer` portal 到 `document.body`；iframe 仍同源，`event.source === iframeRef.current.contentWindow` 判定不变 | 新场景可用 |

### 3.3 尺寸与形态

| 形态 | 几何 | 画布适配度 |
|---|---|---|
| `push`（默认） | 宽 = `max(300, 45% × viewport)`，上限 `70%`，且中栏保底 400px；可拖拽调宽（`ui-layout/columns.ts:11,25,27,29`） | 1440px 视口约 648px。**可接受**：`studio/app.css:198` 的 `.canvas` 是纵向 flex 列（组/卡片自上而下），`.asset-grid` 用 `repeat(auto-fill, minmax(168px, 1fr))`（`:123`），顶栏 `flex-wrap: wrap`（`:36`）——**天然是响应式的纵向卡片流，不是自由画布**，窄列不破版。 |
| `fullscreen` | 面板 `width:100%` 覆盖窗口，宽屏保留底层列宽 | **等价于现在的整屏画布 tab**。⚠️ 只能由用户点面板控件切换。 |
| `auto fullscreen` | 视口 < 768px 自动全屏 | 移动/窄屏自动等于现在的体验 |
| `float`（浮窗） | 任意 `{x,y,width,height}`，可拖拽缩放，压在对话之上，且**不受整栏折叠影响** | ★ **现在完全没有的形态**。插件可 `openTab` 后用 `active()` 拿到 tabId 再 `float(id, rect)` 直接给一个大浮窗。 |
| 分栏 | 最多 2 格，20%–80%，宽度不足时拒绝 | 可与文件树/终端并排 |

### 3.4 引导页与发现路径

- 引导页默认页规则：**恰好 1 个 `guide` 入口 → 直接用该入口；0 个或多个 → 引导页**。当前 `files`(order 10) + `terminal`(order 20) 两个入口，所以默认是引导页。
- 画布注册 `guide` 入口后，会变成引导页上的第 3 枚胶囊（**入口 ≤4 个时会显示 description**）→ 用户点一下即在右栏打开画布。
- 更顺手的入口：复用已有的 🎬 生成开关（`conversation.input.left` 的 `GenToggle`，`lib/client.js:913/1206`）。它本来就在输入框工具行、每个会话都在场，注入一个 `openCanvasSidebar` 回调即可。

---

## 4. 双实例问题（唯一需要认真设计的点）

**今天只有一个 studio 实例。** `ui-conversation` 渲染会话视图时用 `only: active.id`（`skeleton/DefaultConversationViews.tsx:37`）——**只有当前选中的 view 会挂载**，所以从画布切到对话时画布 iframe 被卸载。

**并列注册后会出现第二个实例**，因为右栏面板「折叠时仍保持挂载」（`shell/SidebarRight.tsx` 的注释与实现：面板只是被平移出右边缘），且 `DockSurface` 只渲染 pane 的 active tab（`ui-dockkit/src/components/TabPanel.tsx:412`）。于是当「右栏当前 tab = 画布」且「会话区当前 view = 画布」同时成立时，两个 iframe 都活着。

**风险有多严重？——数据安全，显示可能不同步：**

| 层面 | 事实 | 判定 |
|---|---|---|
| 写入路径 | 宿主端每个变更端点都是 `loadProject → 改 → saveProject`（`lib/index.js:2929+` / `2957` / `2970` / `2987` …），**客户端只发增量**，服务端是权威 | 不会因为「另一个页面有旧副本」而整体覆盖 |
| 写入原子性 | `saveProject` tmp + rename 原子写 + per-`(root:sessionId)` 串行锁（`lib/index.js:609-630`） | 无双写撕裂 |
| 残留竞态 | 锁只串行化 **save**，`load → save` 之间未加锁 → 理论上有丢失更新的窗口 | **既有问题**：Agent 的 `canvas_write_node` 与用户浏览器编辑本来就会并发，不是本次改动引入 |
| 显示同步 | studio 页只在「跟随最新」勾选 且 `document.visibilityState==='visible'` 且非编辑中时每 2.5s 拉一次 `/canvas` 重渲染（`studio/app.js:990-1008`）；否则要点「刷新」 | ⚠️ 未勾跟随/未刷新时，两个实例看到的节点列表可能不同 |

**结论**：可以接受，但要显式处理。三种处理方式（见 §6）。

---

## 5. 官方「不做」清单里对本需求有影响的条目

摘自 `docs/subsystems/sidebar-right.zh.md` 末尾与 README「已知限制」：

1. **布局只在内存里** —— 刷新后每个会话从折叠开始，任何 tab 都不会跨会话出现。→ 画布 tab **每次刷新都要重新打开一次**。缓解：引导胶囊 + 🎬 按钮（一键）；根治需上游加持久化（当前无 persist 声明的 store）。
2. **没有会话就没有停靠面** —— hero（未选会话）画面右侧什么都不显示。
3. **标题在打开时固定** —— 活标题必须走标题席位（画布不需要）。
4. **没有内容导航栈 / 面向用户的撤销** —— 与画布无关。
5. **服务只暴露操作** —— 没有布局快照/订阅，所以「右栏现在有没有画布」只能**挂载时读一次** `ctx.sidebarRight.active()`，不能响应式订阅。

---

## 6. 可选方案

### 方案 A：并列（保留 `conversation.view` + 新增右栏 tab）
- 改动最小，向后兼容，用户两种用法都在。
- 代价：双实例（§4），需要互斥守卫，否则显示不同步会让人困惑。

### 方案 B：迁移（移除 `conversation.view`，只留右栏 tab）
- 单一实例、语义干净、无歧义。
- 代价：**丢掉整屏画布这个默认入口**（要靠用户点全屏按钮才能拿回）；刷新后必须从引导页/🎬 按钮重新打开，比现在「点一下画布 tab」多一步；插件自我定位（"画布工作室"）与产品叙事也要跟着改。

### 方案 C（推荐）：右栏为并行一等入口 + 挂载期互斥守卫
- 保留 `conversation.view`（大屏工作态），新增右栏 tab（边看边生成态），并在 `CanvasView` 挂载时守卫：若 `ctx.sidebarRight.active()?.kind === CANVAS_KIND`，则渲染一句「画布已在右侧栏打开」的提示而不是第二个 iframe。
- 理由：
  - **拿到右栏的杀手级收益**——对话与画布同屏，`跟随最新` 真正可用（现在切到对话就没画布了）。
  - 白送**浮窗**形态（可拖拽缩放的画布大窗），这是会话区 tab 给不了的。
  - 不给现有用户造成回归（会话区 tab 仍在）。
  - 互斥守卫是**挂载期读一次**即可，正好卡在「用户在会话区点画布」这一动作上，无需订阅。
- 不足：两个入口的心智负担；守卫是「一次读」，极端时序下仍可能短暂双实例（可接受）。

---

## 7. 实现草图（可直接落地）

### 7.1 `package.json`

```jsonc
"dsh": {
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-client-ui-sidebar-right"   // ← 新增：包级依赖边，保证右栏工厂先到
    ]
  }
}
```

### 7.2 `lib/client.js`（在 `apply(ctx)` 里新增，约 40 行）

```js
const CANVAS_KIND = 'short-video-canvas'
const CANVAS_ID = 'dsh-short-video-studio'

// 可选：引导页图标（省略则用引导页自带立方体占位）
function CanvasGuideIcon({ size }) {
  return React.createElement('span', { style: { fontSize: (size || 16) + 'px', lineHeight: 1 } }, '🎬')
}

function apply(ctx) {
  // …原有 conversation.view / input.left / settings.section 注册不变…

  // ★ 右栏画布：用 ctx.inject 做「可选依赖」，右栏插件缺席时不连累整个插件
  try {
    ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => {
      // 阶段一：类型定义
      scope.effect(() => scope.sidebarRightTabs.register({
        id: CANVAS_ID,
        kind: CANVAS_KIND,               // 页面类型：不给 patterns
        // priority 缺省 = 'extension'（产品外类型，最高档）
        title: () => '画布',
        guide: [{
          id: 'short-video-canvas',
          order: 30,                      // files=10, terminal=20
          title: () => '短视频画布',
          description: () => '在右栏边看边生成：角色卡 / 场景卡 / 镜头 / 片段',
          icon: CanvasGuideIcon,
        }],
      }), 'svs: sidebar canvas type')

      // 阶段二：正文（复用同一个 CanvasView）
      scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
        name: 'sidebar.right.pane.tab',
        key: CANVAS_ID,
      }, CanvasView)), 'svs: sidebar canvas body')
    })
  } catch (e) {
    console.warn('[dsh-short-video-studio] 右栏画布注册失败（可忽略；画布仍在会话区 tab）:', e)
  }
}
```

### 7.3 一键入口 + 浮窗（在 `GenToggle` 的 inject 里加一个回调）

```js
// apply 内，先备好两个动作（都做存在性守卫）
const openCanvasInSidebar = (float) => {
  if (!ctx.sidebarRight) return false
  try {
    ctx.sidebarRight.openTab(CANVAS_KIND)      // 自动展开右栏
    if (!float) return true
    const tab = ctx.sidebarRight.active()      // openTab 后新 tab 即活动 tab
    if (tab && tab.kind === CANVAS_KIND) {
      ctx.sidebarRight.float(tab.id, {
        x: 80, y: 72,
        width: Math.round(window.innerWidth * 0.7),
        height: Math.round(window.innerHeight * 0.78),
      })
    }
    return true
  } catch (e) { console.warn('[svs] 右栏打开画布失败:', e); return false }
}

// 原注册处（lib/client.js:1206）的 inject 改为：
ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
  name: 'conversation.input.left',
  id: 'svs-generator-toggle',
  order: 10,
  inject: (sessionId) => ({ sessionId, openCanvasInSidebar }),
}, GenToggle))
```

### 7.4 互斥守卫（方案 C 用，`CanvasView` 内）

```js
// 挂载时读一次：右栏已经开着画布就不重复挂 iframe（服务没有订阅，只能读一次）
const [sidebarOwns] = React.useState(() => {
  try { return props.__sidebarActiveKind === CANVAS_KIND } catch { return false }
})
```

> 实现时更干净的做法：`apply` 闭包里读 `ctx.sidebarRight.active()?.kind`，把结果作为 `sidebarOwns` 注入 `CanvasView`（组件不拿 `ctx`，这是本仓库的硬约定）。用 `useState(初始值)` 冻结在挂载那一刻即可。

---

## 8. 验证方法

### 8.1 离线（本仓库已有基础设施，成本极低）

本仓库已有一套**真跑组件 + Chrome 离屏截图**的垫片：`scripts/lib/react-shim.mjs` + `scripts/preview-toolbar.mjs` / `preview-settings.mjs`。它把 `window.__ModuleLoader__.load` 与假 `ctx.slots` 拼起来，直接 `T.apply(fakeCtx)` 后取组件渲染。

沿用这套可以断言：

1. `fakeCtx.slots.register` 收到的注册表里出现 `{ name: 'sidebar.right.pane.tab', key: 'dsh-short-video-studio' }`；
2. `ctx.sidebarRightTabs.register` 收到的定义含 `kind: 'short-video-canvas'` 与一条 `guide` 入口；
3. 直接渲染该正文组件（喂假 `sessionId` / `useWorkspaces` / `inputActions` / `useTabInfo`），断言产出 `iframe`，且 `src` 携带正确的 `sessionId` / `workspaceId`，`postMessage({channel,type:'ask-ai'})` 能把文本灌进假 `inputActions.setDraft`；
4. 宽度断言：在 640 / 480 / 360 三档宽度下用 `scripts/lib/ui-probe.mjs` 的溢出度量，确认窄列不破版。

建议新增 `scripts/smoke-sidebar-canvas.mjs` 并挂进 `package.json` 的 `smoke` 链。

### 8.2 真机（Web GUI）

1. 改完 `lib/client.js` 后刷新页面（客户端 bundle 的 `rev` 是内容 sha1，`dsh-client-modules` 会因哈希变化换 URL；若未刷新可重启 dsh）。
2. 会话 header 右上角展开按钮 → 右栏出现引导页 → 点「短视频画布」胶囊 → 画布在右栏打开。
3. 对照检查：对话与画布同屏；「跟随最新」在对话里跑 Agent 生成时能自动滚动；拖动右栏左缘调宽；点面板全屏按钮；右侧栏 tab 菜单 → 浮出。
4. 回归：从对话切到会话区「画布」tab，确认互斥守卫生效（右栏已开时第二实例不挂载）。
5. 刷新页面 → 确认右栏回到折叠态（已知限制，非缺陷）。

### 8.3 回滚

删除 `ctx.inject(['sidebarRightTabs', …])` 那一段即可，改动完全隔离，不影响任何现有功能。

---

## 9. 版本与依赖要求

| 项 | 值 | 依据 |
|---|---|---|
| 右侧栏 tab 扩展 API 首次出现 | commit `b67e0a838c`（2026-09-07，"feat(sidebar): add tab navigation, injected information, and fullscreen shell"），首个包含它的 tag：**`dsh-v0.1.5-alpha.1`** | `git log` / `git tag --contains` on `tab-registry.ts`、`service.ts`、`package.json` |
| 本机运行时 | `0.1.6-alpha.1` ✅ | 已安装包版本 |
| 线上 npm 版本 | `@deepseek-ai/dsh@0.1.6-alpha.1`（本机 profile 实际解析到的版本） | `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh/package.json` |
| 插件侧新增依赖 | 无运行时 npm 依赖；只是包级依赖边 + 类型/服务引用 | — |

> 兼容性写法建议：**不要**把 `sidebarRightTabs` 加进 `exports.inject`（那会让整个浏览器半在右栏插件缺席时拒绝加载，画布会彻底消失），而是用 `ctx.inject(['sidebarRightTabs','sidebarRight'], scope => …)` 做可选注入 + `try/catch` 兜底——与本插件现有 `conversation.input.left` / `settings.section` 的处理风格一致。

---

## 10. 风险与未验证项

| # | 项 | 状态 | 验证方式 |
|---|---|---|---|
| 1 | 右栏 tab 正文确实能拿到 `inputActions` / `useWorkspaces` / `sessionId` | **文档级已确证**（`slots.zh.md:79-92`：按 scope 提供、与包无关；`ui-conversation/src/client/apply.ts:225-238` 的 `uiSession.provide({props:['inputActions']})` 是 session 级而非某棵子树级） | 8.1 第 3 条 |
| 2 | `ctx.inject(['sidebarRightTabs',…])` 在客户端插件里的可用性与延迟解析行为 | 代码级可信（同仓库 `ui-conversation` 用 `ctx.inject(['commandUi'],…)`），未在本插件实测 | 8.1 / 8.2 |
| 3 | `openTab()` 之后立刻 `active()` 能否拿到新 tab（store 提交是否同步可读） | **未验证**，影响浮窗配方（§7.3） | 8.2 真机点一次浮窗按钮 |
| 4 | 插件能否编程式切全屏 | **不能**（公开面无 `setMode`；形态切换只在面板自身控件） | 源码 `service.ts` ISidebarRight 面 |
| 5 | 双实例显示不同步 | 机制清楚（§4），严重度取决于是否开「跟随最新」 | 8.2 第 4 条 + 开两个实例改一个看另一个 |
| 6 | 窄列（300–450px）下画布可用性 | CSS 层面判为可用（纵向卡片流 + auto-fill 网格 + 顶栏换行），但未实测触控/滚动体验 | 8.1 第 4 条 |
| 7 | 上游若变更 `sidebar.right.pane.tab` 契约 | 属官方子系统契约，有专门文档与测试；key 域明确对外部包开放，稳定性预期高于普通内部 API | 升 DSH 版本时跑一次 8.1 |

---

## 11. 结论

1. **右侧栏是官方设计的可扩展面**，扩展点清晰（tab 类型两阶段注册 + 4 个 slot + 导航服务），且明确欢迎「产品之外的包」贡献 tab 类型——本插件不需要 fork、不需要 patch 宿主、不需要 monkey-patch。
2. **把画布放进右栏是可行的，且成本很低**：`CanvasView` 原样复用（它需要的 3 个 props 在右栏同样可得），改动集中在 `lib/client.js` 约 40 行 + `package.json` 一行，宿主半与 `studio/` 页零改动；`docs/ARCHITECTURE.md` 的分层（浏览器半只做视图挂载）不需要调整。
3. **真正的设计题不是「能不能」，而是「画布的家放哪」**。建议按 **方案 C**：右栏新增为并行入口（拿到「对话 + 画布同屏」和浮窗这两个新能力），会话区 tab 保留为整屏工作态。而**「一键换家」按钮（§12）是这套方案的粘合剂**：它把「双实例」这个唯一的结构性风险变成了一条不变式——换家即同时切换两处挂载点，任何时刻只有一个 iframe 活着，原先设想的「挂载期互斥守卫」不再需要。
4. 三处已知代价必须在产品上认账：**刷新后右栏回折叠**（要一键重开）、**无法编程全屏**、**换家句柄（`openView`）是内存缓存，刷新后需要一次退化处理**（§12.4）。前两条是上游限制，若要根治需向上游提需求（右栏布局持久化 / 服务暴露展开与形态控制）。

---

## 12. 追加调研：「一键换家」按钮（会话区 tab ⇄ 右栏）※ 已被 §13 的静态配置方案取代

> 需求：画布上放一个按钮——当前在右栏时按钮是「放回标签页」，当前在标签页时按钮是「切换到侧边栏」。

### 12.1 结论

**可以，双向都能做，且全程只用公开 API。** 更值一提的是：**这个按钮天然消灭了 §4 的双实例问题**——「换家」这个动作本身就同时切换两处挂载点，所以任何时刻只会有一个 iframe 活着，不再需要「挂载期互斥守卫」这种补丁。房态即互斥。

### 12.2 唯一的句柄：`openView` owner prop

`DefaultConversationViews` 把 owner props 交给**当前活动**的 `conversation.view` 条目：

```tsx
// ui-conversation/src/client/skeleton/DefaultConversationViews.tsx:37-40
renderSlot('conversation.view', { viewRequest, openView, completeViewRequest }, { only: active.id })
```

`ConvViewOwnerProps.openView(view, focus)` 就是「切换会话区主视图」的公开回调——**DSH 自己就是这么用的**：`ui-chat` 的 `ChatView.tsx:246` 用它 `openView('trajectory', callId)` 跳到轨迹视图。所以插件只要**渲染过一次画布视图**，就拿到了该会话的切换句柄，且这个闭包按会话稳定（`conversation.session` 席位的 inject 闭包捕获 `sessionId` + store actions，与当前哪个视图在前台无关），可以缓存起来在右栏里继续用。

**为什么没有别的路（已逐条排除）：**

| 候选 | 结果 | 依据 |
|---|---|---|
| `ctx.uiConversation`（**是公开 Service**，`declare module` 里有声明） | ❌ `binding(sessionId).activate(id)` 只做**装配层**激活（构建该 target 的快照），**不改变 UI 选中** | `conversation/assembly.ts:85`；`apply.ts:167-170` 里 `activateView` 与 `actions.openView` 是**两步**，后者才决定显示 |
| `conversationStore.view`（UI 选中的唯一来源） | ❌ 写它的三条路 `setView` / `openView` / `selectView` 全部只在 ui-conversation 内部 | `apply.ts:292-294`（`conversation.session` 注入）、`apply.ts:305-315`（header 注入 `selectView`） |
| `conversation.session.header.actions` 席位 | ❌ owner props 传的是空对象 `{}`，`selectView` 没有下传 | `skeleton/ConversationSession.tsx:130` |
| 直接写 localStorage 偏好 `dsh.conversation.<sessionId>` | ❌ store 实例已水合且按会话缓存，改存储不会改活着的 `view` | `stores.ts:41-50` + `defineStore` per-scope 缓存 |
| `ctx.sidebarRight` 有 `find` / 布局订阅 | ❌ 官方「不做」清单明确没有 | `docs/subsystems/sidebar-right.zh.md` |

**净结论**：UI 主视图的切换句柄**只有** `conversation.view` 条目手里的 `openView`。

### 12.3 双向流程

| 方向 | 步骤 | 用到的 API | 公开性 |
|---|---|---|---|
| **tab → 右栏**<br>「⇥ 移到右侧栏」 | ① `ctx.sidebarRight.openTab('short-video-canvas')`（自动展开右栏；页类型恒定在目标格去重）<br>② 顺手把 `props.openView` 存进按会话的缓存<br>③ `openView('chat', '')` 把会话区主视图切走 → 画布 iframe 卸载<br>④（可选）注销自己的 `conversation.view` 注册，让「画布」chip 从主视图标签条形里消失 | `ctx.sidebarRight.openTab`<br>`props.openView`<br>`ctx.slots.inject(...)` 返回的 disposer | ✅ 全公开 |
| **右栏 → tab**<br>「⇤ 放回标签页」 | ①（若上一步注销了）重新 `ctx.slots.inject('conversation.view', () => ctx.slots.register(...))`<br>② 缓存里有 `openView` → `openView('short-video-canvas', focus)` 选中它<br>③ `useTabInfo().tab.actions.close()` 关掉右栏画布 tab（右栏若是唯一 tab 会自动收起） | 同上 + `SidebarRightTabActions.close()` | ✅ 全公开 |

**顺序很重要**：先确保目的地能开（`openTab` 可能因无挂载会话面抛错），成功后再切走源；反过来会「两边都没有」。右栏→tab 同理，先激活主视图再关右栏 tab，避免中间闪一下空白。

```js
// ——— 模块级、按会话的状态（组件不拿 ctx，是本仓库硬约定）———
const homeBySession = new Map()      // sessionId -> 'tab' | 'sidebar'
const openViewBySession = new Map()  // sessionId -> (view, focus) => void  ← 唯一句柄

// ——— tab 页里的按钮 ———
function moveCanvasToSidebar(props) {
  if (!openCanvasInSidebar()) return                 // ctx.sidebarRight.openTab(kind)
  openViewBySession.set(props.sessionId, props.openView)  // ① 缓存句柄（此时它一定在手上）
  props.openView('chat', '')                         // ② 主视图切走 → 单实例
  unregisterCanvasView()                             // ③ 可选：让「画布」chip 消失
}

// ——— 右栏里的按钮 ———
function moveCanvasBackToTab(sessionId, closeSelf) {
  registerCanvasView()                               // ① 重新登记 main-area 视图
  const openView = openViewBySession.get(sessionId)
  if (openView) openView('short-video-canvas', '')   // ② 选中它
  closeSelf()                                        // ③ useTabInfo().tab.actions.close()
}
```

### 12.4 冷缓存边界（唯一需要认账的地方）

`openViewBySession` 是**内存缓存，页面刷新即丢**。它需要「本会话内画布视图在会话区渲染过至少一次」才会被填充。

- **正常流**：默认家在 tab 页 → 用户第一次点「移到右侧栏」时画布正在渲染，句柄**必定在手上**。之后整段会话都可用。
- **冷缓存**：刷新页面后（或直接从右栏引导胶囊打开画布）缓存为空 →「放回标签页」无法直接选中主视图。

三种缓解，按推荐度排：

1. **别注销 `conversation.view` 注册**（取消 §12.3 的步骤 ④）。这样「画布」chip 始终在会话区标签条上，冷缓存时用户点一下 chip 就完成了放回；同时右栏按钮在无缓存时退化为「已就绪，点上方『画布』标签」的提示。这是最省事、最不容易出错的组合。
2. **持久化房态 + 加载后续开**：把 `home` 存进本插件自己的 localStorage 键（如 `dsh.svs.canvasHome.<sessionId>`，就像现在存 `autofollow` 那样）。刷新后若 `home === 'sidebar'`，可以在始终挂载的 🎬 `GenToggle`（`conversation.input.left`）里补一次 `openTab(kind)`。但**主视图选中仍然补不回来**（缓存是空的），所以这条只能改善右栏侧，不能替代缓解 1。
3. **接受降级**：无缓存时按钮文案不变，点击后给出一次性提示。不推荐单独使用。

> 顺带一个收益：`openView(id, focus)` 的第二个参数是**一次性 focus 载荷**，会以 `props.viewRequest = { view, focus }` 抵达视图。所以我们还能做「在右栏点某个节点 → 放回标签页并定位到该节点」，只要给 iframe 加一种 `{type:'locate', nodeId}` 的 postMessage。视图侧处理完后记得调 `props.completeViewRequest()` 消掉这个 one-shot 请求。

### 12.5 按钮放在哪

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（推荐）插件自己的外壳** | 在 `CanvasView` 外层加一个极薄容器，按钮用绝对定位压在 iframe 右上角（不占布局高度） | 零 iframe 协议改动；插件天然知道自己在哪个家；tab/右栏共用同一个组件、只传 `home` 参数 |
| B 塞进 studio 页顶栏 | 与「📚 资产库 / 跟随最新」并排，需要给 iframe URL 加 `&home=sidebar` 让 studio 知道该显示哪个文案，并新增一种 postMessage 上报点击 | 视觉上更「在画布上」，但要动 `studio/index.html` + `app.js`，且窄列里顶栏已经 5 个控件（`flex-wrap` 会折行，更挤） |

### 12.6 需要你拍板的三件事

1. **默认家**：默认 tab 页（现状，向后兼容）／默认右栏（更贴「边看边生成」的主张）／记住上次（需持久化房态）。
2. **换到右栏时，「画布」chip 是否从会话区标签条消失**：消失更干净、更像「搬家」；保留则冷缓存有天然退路（§12.4 缓解 1）。
3. **是否要「定位到某节点」的深链**（`openView(id, nodeId)` + iframe `locate` 消息）——顺手可做，价值不小。

### 12.7 证据索引（本节新增）

| 结论 | 位置 |
|---|---|
| `openView` 是 `conversation.view` 的 owner prop | `packages/client/ui-conversation/src/client/contract/slots.ts:249-256` |
| 框架把 `openView` 交给当前活动视图 | `.../skeleton/DefaultConversationViews.tsx:37-40` |
| DSH 自己的用法先例（跳到轨迹视图） | `packages/client/ui-chat/src/client/chat/ChatView.tsx:246` |
| `ctx.uiConversation` 是公开 Service（有 Context 声明） | `packages/client/ui-conversation/src/client/index.ts:73-78` |
| `activate(target)` 只做装配层激活 | `.../conversation/assembly.ts:30-36, 85-87` |
| UI 选中 = `resolveActiveView(tabs, store.view)` | `.../view-selection.ts` + `skeleton/DefaultConversationViews.tsx:16-18` |
| `selectView` 未下传给 header 子席位（传的是 `{}`） | `.../skeleton/ConversationSession.tsx:130, 146-152` |
| 视图偏好持久化键与格式 | `.../stores.ts:22-33, 41-50`（键 `dsh.conversation.<sessionId>`） |
| 右栏 tab 可自关（`tab.actions.close()`） | `packages/client/ui-sidebar-right/src/client/contract/slots.ts`（`SidebarRightTabActions.close`） |
| `slots.inject` 返回 disposer（可动态注销） | `packages/client/ui-renderer/src/client/registry.ts:172-200` |
| `openTab` 自动展开右栏 | `packages/client/ui-sidebar-right/src/client/stores.ts:305-308` |

---

## 13. 简化方案（采纳）：「家」做成插件级配置项，放在「设置 → ComfyUI」

> 需求演进：不做画布上的换家按钮，而是把「画布住在会话区标签页还是右侧栏」做成一个**静态配置项**，在设置 → ComfyUI 里选。

### 13.1 为什么这个简化是对的（收益比看上去大）

「家」从**运行时可变状态**变成**启动时读到的常量**，于是：

| 上一轮的动态机制 | 简化后 |
|---|---|
| `openView` 句柄缓存（§12.2，唯一句柄，且刷新即丢） | **不再需要** |
| `conversation.view` 动态注册 / 注销（§12.3） | **不再需要**（启动时按配置注册一次） |
| `useTabInfo().tab.actions.close()` 自关右栏 tab | **不再需要** |
| 冷缓存退化处理（§12.4） | **不再需要**（没有"切换"这个动作） |
| 双实例问题（§4）+ 挂载期互斥守卫（§6 方案 C） | **结构上不可能**：只有一个家被注册 |

改动量从 §12 的约 100 行动态逻辑，降到 **约 25 行分支 + 设置页一个下拉 + 配置白名单两行**。

> §12 的价值保留为调研记录：它证明了「运行时换家」的唯一句柄是 `openView`、以及为什么它必然有刷新即丢的边界——**正是这个边界让静态配置成为更优解**。

### 13.2 配置放哪：插件自己的配置 JSON

放 `~/.dsh/dsh-short-video-studio.json`（与 ComfyUI 页其余配置同源，经宿主路由 `/dsh-short-video-studio/api/config`，tokenless），**不引入 DSH 的 settings 体系**——comfyui 设置页本来就是插件自己的 config 表单，加一个字段是顺理成章的。

```jsonc
// ~/.dsh/dsh-short-video-studio.json
{
  "canvasHome": "tab",        // "tab"（默认）| "sidebar"
  "baseUrl": "http://localhost:8188",
  // …
}
```

三处改动：

1. **`lib/index.js` · `normalizeCfg`（约 L129 一带）** — 白名单兜底：
   ```js
   canvasHome: c.canvasHome === 'sidebar' ? 'sidebar' : 'tab',
   ```
2. **`lib/index.js` · `POST /config`（约 L2836 的 `safe` 白名单）** —
   ```js
   canvasHome: body.canvasHome === 'sidebar' ? 'sidebar' : getCfg().canvasHome,
   ```
3. **`lib/client.js` · `ComfyUISettings`** — 加一组「界面」（沿用现成的 `grp(...)` + `field(...)` 助手）：
   ```
   界面
     画布位置   [ 会话标签页（默认） ▾ ]   说明：右侧栏需刷新页面后生效
                       └ 右侧栏
   ```

### 13.3 客户端怎么注册（`apply` 里的分支）

`apply(ctx)` 是同步的，而配置只能异步 fetch。三种时序做法：

| 做法 | 评价 |
|---|---|
| (a) 纯异步注册：`fetch(CONFIG_API).then(cfg => register(cfg.canvasHome))` | 启动瞬间会缺「画布」chip；配置请求失败时无兜底。 |
| (b) localStorage 镜像 `canvasHome` 同步读 | 快，但两处真相会漂移（配置文件被手改时）。 |
| **(c) 同步注册默认家 + 异步纠正（推荐）** | 零回归、失败即默认、不引入镜像。 |

```js
// ① 同步按默认家注册（'tab' = 现状），保证任何情况下画布可达
let home = 'tab'
let disposeHome = registerTabHome()          // 现有那段 ctx.slots.inject('conversation.view', …)

// ② 异步读配置，只在需要换家时切一次
fetch(CONFIG_API).then(r => r.json()).then(d => {
  const next = d?.config?.canvasHome === 'sidebar' ? 'sidebar' : 'tab'
  if (next === home) return
  disposeHome?.()                            // inject 返回的 disposer（registry.ts:172）
  home = next
  disposeHome = next === 'sidebar' ? registerSidebarHome() : registerTabHome()
}).catch(() => {})
```

- `registerTabHome()` = 现有的 `ctx.slots.inject('conversation.view', () => ctx.slots.register({ name:'conversation.view', id:'short-video-canvas', order:20, label:'画布' }, CanvasView))`（`lib/client.js:1197-1203`），**`CanvasView` 一行不改**。
- `registerSidebarHome()` = §7.2 的两阶段注册（`ctx.sidebarRightTabs.register` + keyed `sidebar.right.pane.tab`），**复用同一个 `CanvasView`**。
- 只注册一个家 ⇒ 只可能有一个 iframe 实例。

### 13.4 必须认账的一点：改配置后需要刷新页面

配置在插件启动时读，所以设置页保存后**要么刷新，要么重开 dsh**。这不是妥协，而是这个简化买来的东西：正因为启动时只注册一个家，刷新后两种配置都是干净的单实例状态。

**不要去做「保存后实时切换」**——那会把 §12 的 `openView` 问题重新拉回来：切回 `tab` 时无法以编程方式选中主视图，只能靠用户自己点「画布」chip，反而更差。

建议实现：保存后提示「已保存 · 刷新页面生效」+ 一个「立即刷新」按钮（`location.reload()`），一次点击完成。

### 13.5 `home = 'sidebar'` 时的入口：照抄 `files` / `terminal` 的原生做法

**结论：不需要自造入口。** DSH 已有一套既有的进入路径——「右栏折叠 → 会话 header 角落按钮展开 → 引导页列出各类型贡献的入口胶囊 → 点击进入」，**工作区文件与新建终端走的就是它**。画布只需在类型定义里加一个 `guide` 字段（3 行），与 `files` 完全一致。

| 类型 | `guide` 定义 | 是否注册自定义胶囊卡片 |
|---|---|---|
| **`files`**（最小范本，画布照抄这个） | `definition.tsx:35-40` | ❌ 不注册任何额外席位，胶囊由引导页默认卡片渲染 |
| **`terminal`**（多一层可选增强） | `index.ts:49` | ✅ 另按类型 `id` 注册 `sidebar.right.tab.guide.entry`（`index.ts:62-68` → `TerminalGuide.tsx`），卡片自己调 `tab.actions.openTab('terminal', { replaceTab: true })` |
| **画布** | 同 `files`：只加 `guide: [...]` | ❌ 先不注册。将来若想让胶囊显示活信息（如「本会话已生成 N 个片段」）再加 |

**点击语义**（`GuideBody.tsx:100-101`）：胶囊不是页面，是**门**——

```jsx
tab.actions.openTab(entry.kind, { replaceTab: true })   // 引导页让位给它打开的那个页
```

**六个必须踩准的细节：**

| 细节 | 事实 | 对画布的含义 |
|---|---|---|
| 描述显示条件 | 引导页**总入口 ≤ 4 个**时才在标题下渲染 `description`（`MAX_DESCRIBED_ENTRIES = 4`，`GuideBody.tsx:41,86-98`） | 现 files(10)+terminal(20)=2，加画布=3 → 描述照常显示。但**标题必须能独立成立**：未来再加一个类型就会掉光描述 |
| 默认页规则 | **恰好 1 个** guide 入口 → 直接打开该页；0 个或 ≥2 个 → 引导页 | 有 files/terminal 在，永远是引导页；画布既抢不到、也不需要抢默认页 |
| 排序 | `guide[].order` 升序：files=10、terminal=20 | 画布取值是口味问题：**`order: 5`** 让引导页读作「短视频画布 / 工作区文件 / 新建终端」（本插件主面在前）；**`order: 30`** 跟在宿主内置之后更「守规矩」。建议 **5** |
| 去重 | 省略 `multiple` → 每格内同 kind 只保留一页 | 再点胶囊是**聚焦**已开的那页，不会开出第二个画布（与 files 一致；只有 terminal 需要 `multiple: true`） |
| 没有引导页时 | tab 条上的「添加」控件**只在该格没有引导 tab 时**绘制，用 `openTab('guide', …)` 打开引导页 | 用户把画布开进右栏后，仍能回到引导页找其它入口 |
| 图标 | `icon?: ComponentType<IconProps>`，`IconProps` 只有 `{ size?, className? }` | 照 `TerminalGuideIcon` 写个 28×28 内联 SVG；**省略 `icon` 也能跑**，引导页会用自带立方体占位符（`GuideBody.tsx:49`） |

**代码**——这就是「入口」的全部实现，加在 `registerSidebarHome()` 的类型定义里：

```js
scope.sidebarRightTabs.register({
  id: CANVAS_ID,
  kind: CANVAS_KIND,
  title: () => '画布',
  guide: [{
    id: 'canvas',
    order: 5,                       // files=10, terminal=20
    title: () => '短视频画布',
    description: () => '在右栏边看边生成：资产 / 镜头 / 片段',
    icon: CanvasGuideIcon,          // IconProps = { size?, className? }
  }],
})
```

> **因此原 §13.5 的「输入框工具行加一枚 🖼 按钮」降级为可选、可延后**：它不是必需入口（引导页已覆盖），且会给输入框工具行加一个 DSH 原生没有的控件。若以后确实嫌两步太远，再考虑加，且应只在 `home === 'sidebar'` 时出现。

### 13.6 不受影响的部分（换家只换挂载点）

- **宿主半完全不动**：ComfyUI 引擎、工作流注册表、画布存储、HTTP 路由、Agent 工具（`comfy_*` / `canvas_*` / `asset_*`）全部与「家」无关。
- **数据完全不动**：同一个会话仍写同一份 `canvas/<sessionId>/project.json`，画布内容与配置无关。
- **`ask-ai` 桥仍然成立**：右栏 tab 正文同样拿到 `inputActions`（§3.1）。
- **TUI / 飞书不受影响**：浏览器半本来只在 Web 挂载。

### 13.7 拍板结果（已定）

1. **默认值** → `'tab'`（现状，零回归；右栏是显式选项）。
2. **引导页入口 `order`** → `5`（画布排在「工作区文件」(10) /「新建终端」(20) 之前，本插件主面在前）。
3. **「刷新页面生效」提示 + 立即刷新按钮** → 要（已写在设置项旁）。
4. **入口照抄 `files`** → 是：只在类型定义加 `guide`，不自造输入框按钮；省略 `multiple`（同格内去重）。

### 13.8 证据索引（本节新增）

| 结论 | 位置 |
|---|---|
| 插件配置路径与默认值归一化 | 本仓库 `lib/index.js:90`（`CONFIG_PATH`）、`:129` 一带（`normalizeCfg`） |
| 配置 GET/POST 路由与写入白名单 | 本仓库 `lib/index.js:2829-2857` |
| 设置页分组助手与字段行 | 本仓库 `lib/client.js:101`（`ComfyUISettings`）、`:517`（`grp`/`h4` 用法） |
| 现有 `conversation.view` 注册点（默认家） | 本仓库 `lib/client.js:1197-1203` |
| `slots.inject` 返回 disposer，可用于换家 | `packages/client/ui-renderer/src/client/registry.ts:172-200` |
| **`files` 的引导入口（画布照抄）** | `packages/client/ui-sidebar-files/src/client/definition.tsx:35-40` |
| **`terminal` 的引导入口 + 自定义卡片** | `packages/client/ui-sidebar-terminal/src/client/index.ts:49, 62-68`；`TerminalGuide.tsx:52` |
| 胶囊渲染与 `MAX_DESCRIBED_ENTRIES = 4` | `packages/client/ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx:41, 68-78, 86-101` |
| 胶囊点击 = `tab.actions.openTab(kind, { replaceTab: true })` | 同文件 `:100-101`；`TerminalGuide.tsx:52` |
| 胶囊图标的 `IconProps`（`size?`/`className?`） | `packages/client/ui-sidebar-terminal/src/client/TerminalIcon.tsx:20` |
| `openTab` 自动展开右栏 | `packages/client/ui-sidebar-right/src/client/stores.ts:305-308` |
| 引导页默认页规则 / 入口数 | `docs/subsystems/sidebar-right.zh.md`（「引导页」段） |
| 右栏无持久化、默认折叠 | 同文档「不做」 |

### 13.9 落地记录（✅ 已实现，2026-09-18）

按 §13 实现，实际改动面与草图一致，另有两处实现期发现：

| 文件 | 改动 |
|---|---|
| `lib/index.js` · `getCfg`（L102-106） | `canvasHome: c.canvasHome === 'sidebar' ? 'sidebar' : 'tab'`（白名单兜底） |
| `lib/index.js` · `POST /config` 白名单 | `canvasHome: body.canvasHome === 'sidebar' ? 'sidebar' : (body.canvasHome === 'tab' ? 'tab' : getCfg().canvasHome)`——比草稿更保守：**字段缺失时保留原值**，老客户端发来的部分 body 不会把配置冲成 `tab` |
| `lib/client.js` · `ComfyUISettings` | 新增「界面」段：`canvasHome` 下拉（两项）+ 随取值切换的入口说明 + 「改选即保存，刷新页面后生效」+「立即刷新」按钮。**改选即保存**（同本页策略单选的做法）：换家后用户下一步就是刷新，若还要求先滚到底部点「保存配置」，很容易改完直接刷新 → 改动丢失 |
| `lib/client.js` · `apply` / 新增 `applyCanvasHome` | 拆出 `registerTabHome` / `registerSidebarHome`；同步注册默认家 → 异步读配置 → 只在读到 `'sidebar'` **且右栏服务确实可用**时，注册右栏家再注销 tab 家（**单向换家**，比草图更短） |
| `lib/client.js` · 新增 `CanvasGuideIcon` | 28×28 内联 SVG 分镜格（`IconProps` 只有 `size`/`className`） |
| `lib/client.js` · `shellStyle` | 补 `flex:'1 1 auto'` / `minWidth:0` / `boxSizing` —— 会话区视图槽的父级是 flex 列（靠 `flex:1`），右栏 pane body 是有确定高度的块级容器（靠 `height:100%`），两者同给才在两种家里都铺满 |
| `scripts/smoke-canvas-home.mjs` | 新增，65 项，已挂进 `npm run smoke` |

**实现期发现（三处）**

1. **正文席位的 key 是「实现 id」，不是 kind** —— `SidebarRight.tsx` 用 `renderSlot(seat, {}, { entryKey: definition?.id ?? tab.kind })` 派发。草图里若按直觉写 `key: CANVAS_KIND`，派发**静默落空**、正文退化成「此标签页不可用」这个 fallback（不报错）。由 `smoke-canvas-home.mjs` 抓出并固化为回归断言。
2. **`shellStyle` 原本只为会话区视图槽调过**（`height:100%`），右栏 pane body 虽然是有确定高度的块级滚动容器（`FilesBody.module.css` 的注释可证），但父级布局方式与会话区不同，补 `flex:'1 1 auto'` 后两种家都稳。
3. **`ctx.inject` 的回调不是「可用性判断」** —— 依赖**稍后才出现**时回调会在彼时执行。若按「回调是否立刻执行」来决定要不要注销会话区家，就会出现「稍后右栏注册 + 会话区家还在」= **两个家**，正好破坏本节的核心不变式。改为先用 `ctx.get('sidebarRightTabs')` 做**同步**探测，探测通过才注册并注销会话区家。附带收益：宿主禁用右侧栏时 `registerSidebarHome` 返回 false，**会话区家被保留**——配置成 `sidebar` 却遇到服务不可用，画布不会消失（优于草图设想的行为）。

**未做（有意）**

- 运行时「一键换家」按钮（§12）：静态配置 + 刷新已覆盖需求，且能结构上排除双实例。
- 输入框工具行的自造入口（§13.5 降级项）：引导页胶囊已覆盖，不为一个可有可无的入口给原生工具行加控件。
- 进会话自动展开右栏：默认关，避免打扰。

**验证**

- 离线：`npm run smoke` 全绿（退出码 0），其中 `smoke-canvas-home.mjs` 65 项、`smoke-client-settings.mjs` 无回归。
- 真机待验（需浏览器，本机 GUI 有鉴权无法自动探测）：① `ctx.inject(['slots','sidebarRightTabs'])` 在真 cordis 下确实执行；② 引导页胶囊出现且顺序正确；③ 点胶囊后右栏渲染 `CanvasView` 且 iframe 正常加载；④ 右栏内 `inputActions`（`ask-ai` 回填）可用。

---

## 附录：证据索引

| 结论 | 位置 |
|---|---|
| 右栏服务与注册表在此 provide | `packages/client/ui-sidebar-right/src/client/index.ts:108-109` |
| 右栏面板折叠时保持挂载 | 同文件 `:14-24`；`shell/SidebarRight.tsx` 顶部注释 |
| 4 个扩展 slot 的契约声明 | `packages/client/ui-sidebar-right/src/client/contract/slots.ts:42-90` |
| key 域对外开放（外部包可注册类型） | 同文件 `:26` |
| 两阶段注册的公开路径与外部包先例 | `index.ts:22`、`:188-200` |
| 档位 `extension`/`builtin`/`fallback` | `tab-registry.ts:28-43`、`:44-56` |
| `openTab` 同一步展开右栏 | `stores.ts:305-308`（`planSetExpanded(state, true)`） |
| 导航服务公开面（含 `float`/`split`/`registerCloseHandler`） | `service.ts:141-215` |
| 标准 props 按 scope 提供、与包无关 | `docs/subsystems/slots.zh.md:79-92` |
| `inputActions` 是 session 级 provide | `packages/client/ui-conversation/src/client/apply.ts:225-238` |
| 会话视图只渲染 active view（单实例的由来） | `packages/client/ui-conversation/src/client/skeleton/DefaultConversationViews.tsx:37` |
| pane 只渲染 active tab 正文 | `packages/client/ui-dockkit/src/components/TabPanel.tsx:410-412` |
| 右栏宽度常量 | `packages/client/ui-layout/src/client/columns.ts:11,25,27,29,52-56` |
| 右栏默认在 Web 启用 | `@deepseek-ai/dsh-web-app/cordis.patch.yml:222-236` |
| 引导页默认页规则 / 入口数 | `docs/subsystems/sidebar-right.zh.md`（内置类型·guide 段） |
| 「不做」清单（无持久化、无布局快照、无展开控制） | 同文档末尾「不做」；`packages/client/ui-sidebar-right/README.zh.md`「已知限制与延期工作」 |
| 最小完整 tab 类型范本（40 行） | `packages/client/ui-sidebar-files/src/client/index.ts` |
| 画布现挂载点 | 本仓库 `lib/client.js:1197-1203` |
| 画布组件及其三处 props 依赖 | 本仓库 `lib/client.js:40-100` |
| 生成开关可复用为右栏入口 | 本仓库 `lib/client.js:913`、`:1206-1213` |
| studio 页 token 注入 | 本仓库 `lib/index.js:3151`、`:3405` |
| 服务端增量变更端点 + 原子写 + 串行锁 | 本仓库 `lib/index.js:609-630`、`:2929+` |
| studio 页轮询/跟随 | 本仓库 `studio/app.js:990-1008` |
| studio 页窄列适配（纵向卡片流 + auto-fill 网格 + 顶栏换行） | 本仓库 `studio/app.css:36,123,198` |
| 扩展 API 首个可用 tag | `dsh-v0.1.5-alpha.1`（commit `b67e0a838c`） |
