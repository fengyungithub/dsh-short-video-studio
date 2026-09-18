/**
 * scripts/smoke-canvas-home.mjs — 「画布的家」冒烟测试（不启浏览器）。
 *
 * 覆盖插件级配置项 canvasHome（设置 → ComfyUI → 界面）的两种取值：
 *  1) 'tab'（默认）  → 注册 conversation.view 会话区视图 tab，**不**注册右侧栏类型；
 *  2) 'sidebar'      → 注销会话区 tab，改注册右侧栏 tab 类型 + 正文席位 + 引导页胶囊；
 *  3) 读不到配置/请求失败 → 回落 'tab'（插件默认家，画布始终可达）；
 *  4) 右侧栏插件缺席 → 软注入不执行、不抛异常（不得拖垮整个浏览器半）；
 *  5) 设置页「界面」组：下拉两项、刷新生效提示、改选后 POST 带 canvasHome。
 *
 * 全程只做一件事的断言：**任何时刻「画布的家」恰好一个**——这是「结构上排除双实例」
 * （同时存在两个 studio iframe）的不变式，见 docs/right-sidebar-canvas-research.md §13。
 *
 * 用法：node scripts/smoke-canvas-home.mjs
 */

// 测试隔离：不读本机 ~/.dsh 里的真实配置（本机可能已把 canvasHome 设成 sidebar）
process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || '/nonexistent/svs-smoke-canvas-home.json'

import { _internals } from '../lib/index.js'
import { React as shimReact, renderStable, findAll, textOf, resetHooks } from './lib/react-shim.mjs'

const React = shimReact

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `期望 ${want}，实际 ${got}`)

// --- 加载客户端模块 ----------------------------------------------------------
let mod = null
// window.location 是插件运行时的硬前提（postMessage 要投给同源），仿真里必须给上；
// addEventListener 供 CanvasView 的 ask-ai 监听用。
global.window = {
  __ModuleLoader__: { load: (m) => { mod = m } },
  location: { origin: 'http://127.0.0.1:3080' },
  addEventListener: () => {},
  removeEventListener: () => {},
}
await import('../lib/client.js')
ok('client.js 通过 ModuleLoader 注册', Boolean(mod && mod.factory))
const moduleExports = mod.factory((name) => (name === 'react' ? React : {}))

const H = moduleExports.__canvasHome
ok('暴露 __canvasHome 测试面', Boolean(H && H.registerTabHome && H.registerSidebarHome && H.applyCanvasHome))

/**
 * 宿主 ctx 仿真：记录每一次席位注册与注销，供「家恰好一个」的断言统计。
 * @param {{ sidebarRight?: boolean, theme?: 'light'|'dark' }} opts -
 *   `sidebarRight: false` 模拟宿主没装右侧栏插件；`theme` 模拟宿主装没装 ui-theme。
 * @returns {{ ctx: object, log: object[], listeners: Record<string, Function[]> }}
 */
function makeHost(opts = {}) {
  const log = []
  const listeners = {}
  const ctx = {
    effect: (fn) => fn(),
    // 事件：真 cordis 的 ctx.on(event, listener) 返回注销函数
    on: (event, listener) => {
      ;(listeners[event] = listeners[event] || []).push(listener)
      return () => { listeners[event] = listeners[event].filter((l) => l !== listener) }
    },
    slots: {
      // slot 注入：声明已存在就直接跑回调（真宿主的行为），返回注销函数
      inject: (name, fn) => fn(),
      register: (def, Component) => {
        log.push({ op: 'register', seat: def.name, def, Component })
        return () => { log.push({ op: 'unregister', seat: def.name, def }) }
      },
    },
    // 服务软注入：缺依赖时真宿主**不执行回调**，这里如实模拟
    inject: (deps, cb) => {
      if (deps.includes('sidebarRightTabs') && opts.sidebarRight === false) return
      cb(ctx)
    },
    // 同步服务探测（真 cordis 的 ctx.get）：registerSidebarHome / readScheme 用它
    get: (name) => {
      if (name === 'sidebarRightTabs') return opts.sidebarRight === false ? undefined : ctx.sidebarRightTabs
      if (name === 'theme') return opts.theme ? { getTheme: () => ({ active: { colorScheme: opts.theme } }) } : undefined
      return undefined
    },
  }
  if (opts.sidebarRight !== false) {
    ctx.sidebarRightTabs = {
      register: (def) => { log.push({ op: 'register', seat: 'sidebarRightTabs', def }); return () => { log.push({ op: 'unregister', seat: 'sidebarRightTabs', def }) } },
    }
  }
  return { ctx, log, listeners }
}

/** 同一席位同一键被 register 后又被 unregister 的净存活数（家的个数按这个算）。 */
const live = (log, seat, match = () => true) => {
  const keys = new Map()
  for (const e of log) {
    if (e.seat !== seat) continue
    if (e.op === 'register') { if (match(e)) keys.set(e.def.id || e.def.key || '(root)', true) }
    else if (keys.has(e.def.id || e.def.key || '(root)')) keys.set(e.def.id || e.def.key || '(root)', false)
  }
  return [...keys.values()].filter(Boolean).length
}

const settle = () => new Promise((r) => setImmediate(r))

// --- [1] canvasHome = 'tab'（默认）------------------------------------------
console.log("\n[1] canvasHome = 'tab'（默认家：会话区视图 tab）")
{
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, config: { canvasHome: 'tab' } }) })
  const { ctx, log } = makeHost()
  moduleExports.apply(ctx)
  await settle(); await settle()

  const viewReg = log.find((e) => e.seat === 'conversation.view' && e.op === 'register')
  ok('注册了 conversation.view', Boolean(viewReg))
  eq('视图 id', viewReg?.def.id, H.CANVAS_VIEW_ID)
  eq('视图 order', viewReg?.def.order, 20)
  eq('视图 label', viewReg?.def.label, H.CANVAS_LABEL)
  eq('视图组件就是 CanvasView', viewReg?.Component, H.CanvasView)
  eq('未注册右侧栏类型', log.filter((e) => e.seat === 'sidebarRightTabs').length, 0)
  eq('未注册右侧栏正文席位', log.filter((e) => e.seat === 'sidebar.right.pane.tab').length, 0)
  eq('家恰好一个', live(log, 'conversation.view') + live(log, 'sidebarRightTabs'), 1)
}

// --- [2] canvasHome = 'sidebar' --------------------------------------------
console.log("\n[2] canvasHome = 'sidebar'（家：右侧栏 tab 类型）")
{
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, config: { canvasHome: 'sidebar' } }) })
  const { ctx, log } = makeHost()
  moduleExports.apply(ctx)
  await settle(); await settle()

  // ① 先注册的默认家必须被注销掉，否则两个家同时活着＝两个 iframe
  const viewUnreg = log.find((e) => e.seat === 'conversation.view' && e.op === 'unregister')
  ok('会话区 tab 已被注销', Boolean(viewUnreg))
  eq('会话区家净存活 0 个', live(log, 'conversation.view'), 0)

  // ② 右栏类型定义
  const typeReg = log.find((e) => e.seat === 'sidebarRightTabs' && e.op === 'register')
  ok('注册了右侧栏类型', Boolean(typeReg))
  eq('类型 id（实现身份，也是正文席位的 key）', typeReg?.def.id, H.CANVAS_ID)
  eq('类型 kind（openTab 用的判别名）', typeReg?.def.kind, H.CANVAS_KIND)
  eq('类型 title', typeReg?.def.title?.(), H.CANVAS_LABEL)
  ok('省略 multiple → 同格内同 kind 只保留一页（再点胶囊是聚焦而非新开）', typeReg?.def.multiple === undefined)
  ok('按页类型注册（不声明 patterns 资源地址）', typeReg?.def.patterns === undefined)

  // ③ 引导页胶囊（照抄 ui-sidebar-files 的做法：入口只靠这一个字段）
  const guide = (typeReg?.def.guide) || []
  eq('引导页胶囊 1 个', guide.length, 1)
  eq('胶囊 id', guide[0]?.id, 'canvas')
  eq('胶囊 order（files=10 / terminal=20，画布排在其前）', guide[0]?.order, H.CANVAS_GUIDE_ORDER)
  eq('胶囊 order 具体值', H.CANVAS_GUIDE_ORDER, 5)
  eq('胶囊 title', guide[0]?.title?.(), '短视频画布')
  ok('胶囊 description 非空（总入口 ≤4 时会显示）', typeof guide[0]?.description?.() === 'string' && guide[0].description().length > 0)
  eq('胶囊 icon 是组件', guide[0]?.icon, H.CanvasGuideIcon)
  eq('胶囊无 icon 也能跑（保留兜底：省略时引导页画立方体占位）', guide[0]?.icon === undefined, false)

  // ④ 正文席位：keyed by **实现 id**（shell 用 `entryKey: definition.id ?? tab.kind` 派发，
  // 用 kind 当 key 会静默派发不到 → 正文退化成「此标签页不可用」），且复用同一个 CanvasView
  const bodyReg = log.find((e) => e.seat === 'sidebar.right.pane.tab' && e.op === 'register')
  ok('注册了右侧栏正文席位', Boolean(bodyReg))
  eq('正文席位 key = 实现 id（不是 kind）', bodyReg?.def.key, H.CANVAS_ID)
  ok('正文席位 key 确实不是 kind（回归防线）', bodyReg?.def.key !== H.CANVAS_KIND)
  eq('正文组件与 tab 家是同一个 CanvasView（一份实现、两个家）', bodyReg?.Component, H.CanvasView)
  eq('未注册 tab 标题席位（可省，chip 用类型定义的 title）', log.filter((e) => e.seat === 'sidebar.right.pane.tab.title').length, 0)

  // ⑤ 不变式
  eq('家恰好一个', live(log, 'conversation.view') + live(log, 'sidebarRightTabs'), 1)
}

// --- [3] 读不到配置 / 请求失败 → 回落默认家 ---------------------------------
console.log("\n[3] 配置不可用时回落默认家 'tab'（画布必须始终可达）")
{
  for (const [label, impl] of [
    ['请求 reject', async () => { throw new Error('offline') }],
    ['返回非 ok', async () => ({ ok: true, json: async () => ({ ok: false }) })],
    ['字段缺失/非法', async () => ({ ok: true, json: async () => ({ ok: true, config: { canvasHome: 'bogus' } }) })],
  ]) {
    global.fetch = impl
    const { ctx, log } = makeHost()
    moduleExports.apply(ctx)
    await settle(); await settle()
    eq(`${label} → 仍是会话区家`, live(log, 'conversation.view'), 1)
    eq(`${label} → 无右栏注册`, log.filter((e) => e.seat === 'sidebarRightTabs').length, 0)
  }
}

// --- [4] 宿主没装右侧栏插件 --------------------------------------------------
console.log('\n[4] 右侧栏插件缺席：不抛异常，且**保留**会话区家（画布不消失）')
{
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, config: { canvasHome: 'sidebar' } }) })
  const { ctx, log } = makeHost({ sidebarRight: false })
  let threw = null
  try { moduleExports.apply(ctx); await settle(); await settle() } catch (e) { threw = e }
  ok('apply 不抛异常', !threw, threw && threw.message)
  eq('右侧栏类型未注册', log.filter((e) => e.seat === 'sidebarRightTabs').length, 0)
  eq('会话区家被保留（配置成 sidebar 但服务不可用时降级，而不是让画布消失）', live(log, 'conversation.view'), 1)
  ok('未注销会话区家', !log.some((e) => e.seat === 'conversation.view' && e.op === 'unregister'))
  eq('家恰好一个', live(log, 'conversation.view') + live(log, 'sidebarRightTabs'), 1)

  // 探测点：registerSidebarHome 必须**返回 false**（不能只靠 inject 回调是否立刻执行来判断，
  // 依赖「稍后才出现」时回调会在彼时执行 → 与会话区家同时存在＝两个家）
  const { ctx: ctx2 } = makeHost({ sidebarRight: false })
  eq('registerSidebarHome 返回 false', H.registerSidebarHome(ctx2), false)
  const { ctx: ctx3 } = makeHost()
  eq('服务可用时 registerSidebarHome 返回 true', H.registerSidebarHome(ctx3), true)
}

// --- [5] 硬依赖陷阱：sidebarRightTabs 不得进 exports.inject -----------------
console.log('\n[5] 依赖声明：不得把 sidebarRightTabs 写进 exports.inject')
{
  ok('exports.inject 只含 slots', Array.isArray(moduleExports.inject) && moduleExports.inject.join(',') === 'slots',
    JSON.stringify(moduleExports.inject))
  ok('未把右侧栏服务声明为硬依赖（否则禁用右侧栏时整个浏览器半加载失败）',
    !moduleExports.inject.includes('sidebarRightTabs') && !moduleExports.inject.includes('sidebarRight'))
}

// --- [6] 引导页图标可渲染 ----------------------------------------------------
console.log('\n[6] 引导页胶囊图标')
{
  const el = H.CanvasGuideIcon({ size: 26, className: 'x' })
  ok('返回 svg 元素', Boolean(el && el.__el && el.type === 'svg'))
  eq('尺寸跟随入参', el?.props?.width, 26)
  ok('aria-hidden（装饰性图标，不读给读屏）', el?.props?.['aria-hidden'] === 'true')
  const el2 = H.CanvasGuideIcon()
  eq('缺省尺寸 26', el2?.props?.width, 26)
}

// --- [7] 设置页「界面」组 ----------------------------------------------------
console.log('\n[7] 设置页：画布位置下拉 + 刷新生效提示')
{
  let settingsComponent = null
  const cfgFixture = {
    baseUrl: 'http://localhost:8188', apiKey: '', pollMs: 2000, timeoutMs: 900000,
    canvasHome: 'tab',
    models: {}, assetOverrides: {}, preferred: {}, tiers: {},
  }
  const apiPayload = await _internals.describeWorkflowsApi(_internals.getRegistry(), { probe: false, cfg: {} })
  const posts = []
  global.fetch = async (url, opts) => {
    const isCfg = String(url).includes('/api/config')
    if (isCfg && opts && opts.method === 'POST') posts.push(JSON.parse(opts.body))
    return { ok: true, json: async () => (isCfg ? { ok: true, config: cfgFixture } : apiPayload) }
  }
  const { ctx } = makeHost()
  ctx.slots.register = (def, Component) => { if (def.name === 'settings.section') settingsComponent = Component; return () => {} }
  moduleExports.apply(ctx)
  await settle(); await settle()
  ok('设置页注册了 ComfyUI 段', typeof settingsComponent === 'function')

  resetHooks()
  let tree = null
  let err = null
  try { tree = await renderStable(settingsComponent, {}) } catch (e) { err = e }
  ok('渲染不抛异常', !err, err && err.stack && err.stack.split('\n').slice(0, 3).join(' | '))

  const text = textOf(tree)
  ok('有「界面」分组', text.includes('界面'))
  ok('有画布位置字段', text.includes('画布位置 canvasHome'))
  ok('说明「改选即保存，刷新页面后生效」', text.includes('改选即保存，刷新页面后生效'))
  ok('有「立即刷新」按钮', findAll(tree, (n) => n.type === 'button' && String(textOf(n)).includes('立即刷新')).length === 1)

  // 下拉：两个选项，当前值 = 配置里的 'tab'
  const sel = findAll(tree, (n) => n.type === 'select' && findAll(n, (o) => o.props.value === 'sidebar').length > 0)
  eq('画布位置下拉唯一', sel.length, 1)
  const opts = findAll(sel[0], (n) => n.type === 'option').map((o) => o.props.value)
  eq('两个选项（tab / sidebar）', opts.join(','), 'tab,sidebar')
  eq('回显配置值', sel[0]?.props.value, 'tab')
  ok('选 tab 时提示走会话区 tab', text.includes('会话区视图标签页'))

  // 改选 → **改选即保存**（不要求用户再滚到底部点「保存配置」，否则改完直接刷新会丢改动）：
  // 断言 onChange 之后 POST 就已经带上 canvasHome，且提示同步更新。
  // 注意：第二次渲染**不能** resetHooks（会清掉刚设进去的状态，断言就假过了——
  // 垫片的 state 就存在 hooks 数组里）。同 smoke-client-settings 的写法。
  const postsBefore = posts.length
  await sel[0].props.onChange({ target: { value: 'sidebar' } })
  await settle()
  ok('改选即发保存请求（无需再点底部保存）', posts.length > postsBefore)
  eq('保存请求带上 canvasHome', posts[posts.length - 1]?.canvasHome, 'sidebar')
  tree = await renderStable(settingsComponent, {})
  ok('改选后提示改为右侧栏入口', textOf(tree).includes('会话标题栏右上角的展开按钮'))
  ok('保存成功提示写明「刷新页面后生效」', textOf(tree).includes('刷新页面后生效'))
}

// --- [8] 画布主题：跟随宿主浅/深 --------------------------------------------
console.log('\n[8] 画布主题：跟随宿主浅/深（?theme= 首屏 + postMessage 运行时）')
{
  const T = moduleExports.__canvasTheme
  ok('暴露 __canvasTheme 测试面', Boolean(T && T.readScheme && T.postThemeToFrame && T.watchTheme && T.subscribeScheme))

  // 读不到主题服务 → null（**不猜**：不往 iframe 传 ?theme=，让它按 prefers-color-scheme 兜底）
  T.resetThemeCache()
  eq('宿主没装主题服务时读数为 null', T.readScheme(), null)

  // 宿主的浅/深
  T.resetThemeCache()
  T.watchTheme(makeHost({ theme: 'dark' }).ctx)
  eq('宿主 dark → dark', T.readScheme(), 'dark')
  T.resetThemeCache()
  T.watchTheme(makeHost({ theme: 'light' }).ctx)
  eq('宿主 light → light', T.readScheme(), 'light')

  // 主题服务抛错 → 不能让画布挂掉
  T.resetThemeCache()
  T.watchTheme({ on: () => {}, get: () => ({ getTheme: () => { throw new Error('boom') } }) })
  eq('主题服务抛错时回落 null（不抛异常）', T.readScheme(), null)

  // 首屏主题**冻结**：它进了 iframe 的 src，跟着变会让 iframe 重载（丢滚动位置/正在输入的内容）
  T.resetThemeCache()
  const opts = { theme: 'dark' }
  T.watchTheme(makeHost(opts).ctx)
  eq('首屏主题取一次 = dark', T.bootSchemeOnce(), 'dark')
  opts.theme = 'light'
  eq('宿主已切到 light', T.readScheme(), 'light')
  eq('首屏主题仍为 dark（冻结，不改 src）', T.bootSchemeOnce(), 'dark')

  // 宿主切主题 → 订阅者收到新值；单个订阅者抛错不影响其他
  T.resetThemeCache()
  const opts2 = { theme: 'dark' }
  const host = makeHost(opts2)
  T.watchTheme(host.ctx)
  const seen = []
  T.subscribeScheme(() => { throw new Error('订阅者自己炸了') })
  T.subscribeScheme((s) => seen.push(s))
  eq('已订阅宿主 theme/change', (host.listeners['theme/change'] || []).length, 1)
  eq('尚未切主题 → 无通知', seen.length, 0)
  opts2.theme = 'light' // 同一个宿主 ctx，服务值变了（模拟 DSH 里切换配色）
  host.listeners['theme/change'].forEach((l) => l({ active: { colorScheme: 'light' } }))
  eq('宿主切主题 → 订阅者收到新值（抛错的那个不影响它）', seen.join(','), 'light')

  // 宿主没有事件能力（ctx.on 缺席）→ 只降级为「挂载时读一次」，不得抛错
  T.resetThemeCache()
  let threw = null
  try { T.watchTheme({ get: () => ({ getTheme: () => ({ active: { colorScheme: 'dark' } }) }) }) } catch (e) { threw = e }
  ok('宿主缺 ctx.on 时 watchTheme 不抛异常（主题跟随降级而不是崩掉）', !threw, threw && threw.message)
  eq('降级后仍能读到配色', T.readScheme(), 'dark')

  // 下发给 iframe 的载荷
  const posted = []
  const fakeWin = { postMessage: (msg, origin) => posted.push({ msg, origin }) }
  ok('有效主题 → 下发成功', T.postThemeToFrame({ contentWindow: fakeWin }, 'dark') === true)
  eq('下发通道', posted[0]?.msg.channel, 'dsh-short-video-studio')
  eq('下发类型', posted[0]?.msg.type, 'theme')
  eq('下发主题', posted[0]?.msg.theme, 'dark')
  eq('同源投递', posted[0]?.origin, global.window.location.origin)
  eq('iframe 未挂载 → 不下发（等 onLoad 兜底）', T.postThemeToFrame(null, 'dark'), false)
  eq('未知主题 → 不下发', T.postThemeToFrame({ contentWindow: fakeWin }, null), false)
  eq('已被销毁的 iframe → 不下发', T.postThemeToFrame({}, 'dark'), false)

  // 端到端（离屏）：宿主 dark 时，iframe 的 src 带 &theme=dark
  const renderCanvas = async (theme) => {
    T.resetThemeCache()
    resetHooks()
    const h = makeHost(theme ? { theme } : {})
    moduleExports.apply(h.ctx)
    await settle(); await settle()
    const tree = await renderStable(H.CanvasView, {
      sessionId: 's1',
      // 垫片里 useWorkspaces 就是普通函数：直接给一个工作区，省掉 store 仿真
      useWorkspaces: () => ({ workspaceId: 'w1', sessionIds: ['s1'] }),
    })
    return findAll(tree, (n) => n.type === 'iframe')[0]
  }
  const darkFrame = await renderCanvas('dark')
  ok('宿主 dark → iframe src 带 &theme=dark', String(darkFrame?.props.src).includes('&theme=dark'), darkFrame?.props.src)
  const lightFrame = await renderCanvas('light')
  ok('宿主 light → iframe src 带 &theme=light', String(lightFrame?.props.src).includes('&theme=light'), lightFrame?.props.src)
  const noThemeFrame = await renderCanvas(null)
  ok('宿主无主题服务 → 不传 theme（交给 prefers-color-scheme）', !String(noThemeFrame?.props.src).includes('theme='), noThemeFrame?.props.src)
  ok('iframe 每次都挂了 onLoad 补主题', typeof darkFrame?.props.onLoad === 'function')
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) process.exit(1)
