/**
 * scripts/smoke-client-settings.mjs — P3/P4 客户端冒烟测试（不启浏览器）。
 *
 * 用轻量 React 垫片 + 宿主 ModuleLoader 仿真加载 lib/client.js，然后：
 *  1) 真跑一遍「ComfyUI 设置页」渲染（喂真实 /api/workflows 形状的数据），断言
 *     策略条目、逐档下拉、可用性告警、未分级清单、导入表单的组名/档位字段都在；
 *  2) 断言工具条命令行拼装：档位三档 → tier= + 尺寸随档位（fast 832 / 其余 1344）；
 *  3) 断言 tierPick 的取值与后端解析同源（配置选择 > 注册表首选）。
 *
 * 用法：node scripts/smoke-client-settings.mjs
 */

// 测试隔离：不读本机 ~/.dsh 里的真实配置（里面可能有用户自建策略/档位选择，
// 会把「未指定档位」「档位列表」等断言前提改掉）。纯逻辑测试一律跑在空配置上。
process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || '/nonexistent/svs-smoke-config.json'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { _internals } from '../lib/index.js'
import { React as shimReact, renderStable, findAll, textOf, resetHooks } from './lib/react-shim.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `期望 ${want}，实际 ${got}`)

// 渲染垫片与预览工具共用（scripts/lib/react-shim.mjs）
const React = shimReact
// --- 加载客户端模块 ----------------------------------------------------------
let mod = null
global.window = { __ModuleLoader__: { load: (m) => { mod = m } } }
await import('../lib/client.js')
ok('client.js 通过 ModuleLoader 注册', Boolean(mod && mod.factory))
const moduleExports = mod.factory((name) => {
  if (name === 'react') return React
  return {} // 其它宿主注入（slots 等）在本测试里不需要
})
ok('暴露 apply/inject', typeof moduleExports.apply === 'function' && Array.isArray(moduleExports.inject))

// --- 捕获设置页组件 ----------------------------------------------------------
let settingsComponent = null
const cfgFixture = {
  baseUrl: 'http://localhost:8188', apiKey: '', pollMs: 2000, timeoutMs: 900000,
  models: {}, assetOverrides: {},
  preferred: { 'video.reference2video': ['minimax-h3-ref2v-quality'] },
  tiers: { 'video.reference2video': { quality: 'minimax-h3-ref2v-quality-sol' } },
}
// cfg 显式传空对象：**不使用本机真实配置**。否则用户/开发机在里面存过的策略与档位选择
// 会改变档位列表（availableTiers 收敛）与选中态，测试前提随之漂移。
const apiPayload = await _internals.describeWorkflowsApi(_internals.getRegistry(), { probe: false, cfg: {} })
global.fetch = async (url) => {
  const u = String(url)
  const body = u.includes('/api/config') ? { ok: true, config: cfgFixture } : apiPayload
  return { json: async () => body, ok: true }
}
moduleExports.apply({
  slots: {
    inject: (name, fn) => { if (name === 'settings.section') fn() },
    register: (def, Component) => { if (def.name === 'settings.section') settingsComponent = Component },
  },
  effect: () => {},
  log: () => {}, warn: () => {}, error: () => {},
})
ok('设置页注册了 ComfyUI 段', typeof settingsComponent === 'function')

console.log('\n[1] 设置页渲染（真实 /api/workflows 形状数据）')
{
  let tree
  let err = null
  resetHooks()
  try { tree = await renderStable(settingsComponent, {}) } catch (e) { err = e }
  ok('渲染不抛异常', !err, err && err.stack && err.stack.split('\n').slice(0, 3).join(' | '))
  const text = textOf(tree)
  // 新契约：每能力只放一条**内置默认**策略（label = 家族名），其余策略由用户自己命名与组合
  ok('显示内置默认策略（label = 家族名）', text.includes('MiniMax H3 参考生成视频'))
  ok('标注「内置默认」', text.includes('内置默认'))
  ok('顶部说明讲清策略＝一套档位组合', text.includes('策略＝一套档位组合'))
  ok('有「新增策略」入口', text.includes('新增策略'))
  // 摘要＝**只读**的「这条策略实际会用什么」：档位 → 完整实现 id（含 preferred 家族序 / pins 的结果）
  ok('策略摘要列出该策略提供的档位与实际实现', /fast → minimax-h3-\S+/.test(text) && /quality → minimax-h3-\S+/.test(text))
  ok('摘要只列策略自己提供的档位（不写"→ 默认"凑数）', !/→ 默认/.test(text))
  ok('策略摘要按档位顺序（fast → balanced → quality）',
    text.indexOf('fast → ') < text.indexOf('balanced → '))
  ok('三档都在摘要里出现', ['fast →', 'balanced →', 'quality →'].every((t) => text.includes(t)))
  ok('显示实测耗时（来自注册表 estSeconds）', text.includes('约 397s') || text.includes('约 311s'))
  // 新交互：**默认视图只显示策略列表与名称**，档位表单（下拉）必须点「编辑档位」才出现
  ok('策略行有「编辑档位」入口', text.includes('编辑档位'))
  ok('显示未分级清单提示', text.includes('未分级') || text.includes('未分档'))
  ok('导入表单有组名字段', text.includes('组名 group（同名成组）'))
  ok('导入表单有档位字段', text.includes('档位 tier'))
  ok('i2v 也有自己的内置默认策略', text.includes('MiniMax H3 首末帧生成视频'))
  ok('不再自动生成「（无加速）/（有加速）」策略条目', !text.includes('（无加速）') && !text.includes('（有加速）'))

  // 默认视图**不得**常显档位表单：档位下拉里带「（不选＝…」占位的那种，只应出现在编辑态
  const formSelects = findAll(tree, (n) => n.type === 'select' && findAll(n, (o) => String(o.props.children || '').includes('不选＝')).length > 0)
  ok('默认视图不出现档位表单下拉', formSelects.length === 0, `实际 ${formSelects.length} 个`)
  // 实现 id 仍在（只读摘要里），只是不再以下拉形式铺开
  ok('摘要里能读到各档实际实现 id', ['minimax-h3-ref2v-fast', 'minimax-h3-ref2v-quality-sol'].some((id) => text.includes(id)))
}

console.log('\n[2] 工具条命令行拼装（tier= 与尺寸随档位）')
{
  const T = moduleExports.__test
  ok('__test 暴露工具条函数', Boolean(T && T.svsVideoHeader && T.tierPick))
  const base = { pipeline: 'r2v', ratio: '16:9', seconds: 124, refs: [{ nodeId: 'n1' }], first: null, last: null }
  // 长边由清单提供（调用方传入）：命令行不再按档位名硬编码尺寸
  const hf = T.svsVideoHeader({ ...base, videoTier: 'fast' }, { longSide: 832 })
  const hb = T.svsVideoHeader({ ...base, videoTier: 'balanced' }, { longSide: 1344 })
  const hq = T.svsVideoHeader({ ...base, videoTier: 'quality' }, { longSide: 1344 })
  ok('fast 档命令行（长边来自清单）', hf.includes('tier=fast') && hf.includes('size=832x480'), hf)
  ok('balanced 档命令行', hb.includes('tier=balanced') && hb.includes('size=1344x768'), hb)
  ok('quality 档命令行', hq.includes('tier=quality') && hq.includes('size=1344x768'), hq)
  ok('未传长边 → 兜底 1344（不按档位名猜）', T.svsVideoHeader({ ...base, videoTier: 'fast' }).includes('size=1344x768'))
  ok('档位未知 → 不拼 tier=（交给服务端按清单解析）', !T.svsVideoHeader({ ...base, videoTier: '' }).includes('tier='))
  ok('带 refs 节点', hf.includes('refs=n1'), hf)
  const hi2v = T.svsVideoHeader({ pipeline: 'i2v', videoTier: 'quality', ratio: '9:16', seconds: 124, first: { nodeId: 'f1' }, last: null }, { longSide: 1344 })
  ok('i2v 命令行（首帧 + 竖版）', hi2v.includes('tier=quality') && hi2v.includes('size=768x1344') && hi2v.includes('first=f1'), hi2v)
  ok('9:16 尺寸推导与后端一致', T.svsDims('9:16', 1344).width === 768 && T.svsDims('9:16', 1344).height === 1344)

  // UI 不得预设档位：列表/默认值都来自矩阵（能力有几个档由注册表决定）
  const r2vTiers = T.tiersOf(apiPayload, 'video.reference2video')
  const i2vTiers = T.tiersOf(apiPayload, 'video.image2video')
  ok('r2v 档位列表来自矩阵', r2vTiers.length > 0 && r2vTiers.includes('fast'), r2vTiers.join(','))
  ok('i2v 档位列表来自矩阵（已补齐 balanced）', i2vTiers.join(',') === 'fast,balanced,quality', i2vTiers.join(','))
  ok('默认档位 = 列表首个（非写死）', T.GEN_DEFAULT.videoTier === '' && T.GEN_DEFAULT.imageTier === '')
  const i2iModes = T.modesOf(apiPayload, 'image.image2image')
  ok('图片 i2i「档位」读清单 modes', i2iModes.length > 0, i2iModes.join(','))
  // 图片已并入 tier 体系（一档一清单）：t2i 的档位列表来自矩阵，长边来自该档清单
  const t2iTiers = T.tiersOf(apiPayload, 'image.text2image')
  ok('图片 t2i 档位列表来自矩阵', t2iTiers.length > 0 && t2iTiers.includes('fast'), t2iTiers.join(','))
  const t2iQ = T.tierPick(apiPayload, 'image.text2image', 'quality')
  ok('t2i quality 档长边读清单', t2iQ && t2iQ.longSide === 2048, String(t2iQ && t2iQ.longSide))
}

console.log('\n[3] tierPick 与后端解析同源')
{
  const T = moduleExports.__test
  const refCap = 'video.reference2video'
  // 不依赖本机配置是否已选过策略：有 selection 就必须用它，没有才回退注册表首选
  const refCap0 = apiPayload.capabilities.find((c) => c.capability === refCap)
  const selQuality = (refCap0.selection || {}).quality
  const pickDefault = T.tierPick(apiPayload, refCap, 'quality')
  eq('有配置选择 → 用配置', pickDefault.id, selQuality || 'minimax-h3-ref2v-quality')
  // 注入选择（= 设置页选了「有加速」策略或逐档改选）
  const withSel = JSON.parse(JSON.stringify(apiPayload))
  const withSelCap = withSel.capabilities.find((c) => c.capability === refCap)
  withSelCap.selection = { quality: 'minimax-h3-ref2v-quality-sol' }
  // 后端的 effective 是「选择 + 家族序」算出来的；这里只改 selection，所以把它清掉以测**回退链**
  delete withSelCap.effective
  eq('配置选择生效（quality → sol 实现）', T.tierPick(withSel, refCap, 'quality').id, 'minimax-h3-ref2v-quality-sol')
  // 无选择时才回退到注册表首选（同档第一个候选）
  const noSel = JSON.parse(JSON.stringify(apiPayload))
  const capNoSel = noSel.capabilities.find((c) => c.capability === refCap)
  capNoSel.selection = {}
  eq('无配置选择 → 注册表首选（标准实现）', T.tierPick(noSel, refCap, 'quality').id, capNoSel.groups[0].tiers.quality[0].id)
  eq('读到该档长边（来自清单）', pickDefault.longSide, 1344)
  const fast = T.tierPick(apiPayload, refCap, 'fast')
  eq('fast 档长边（来自清单）', fast.longSide, 832)
  eq('fast 档耗时（来自清单）', Math.round(fast.estSeconds), 25)
  eq('i2v balanced 档来自清单', T.tierPick(apiPayload, 'video.image2video', 'balanced').id, 'minimax-h3-i2v-balanced')
  eq('未分档能力 → null', T.tierPick(apiPayload, 'image.from_video', 'quality'), null)
}

console.log('\n[4] 布局回归断言（防溢出：option 文本必须紧凑、控件必须可收缩）')
{
  let tree
  resetHooks()
  tree = await renderStable(settingsComponent, {})
  // 档位下拉**只在编辑态**出现（默认视图只有策略列表）→ 先点开第一条「编辑档位」再量尺寸/文本
  const openEdit = findAll(tree, (n) => n.type === 'button').find((b) => String(textOf(b)).includes('编辑档位'))
  if (openEdit) { openEdit.props.onClick(); tree = await renderStable(settingsComponent, {}) }
  // 档位下拉＝带 optgroup 的那些（option 文本会撑大 select 的 min-content 宽度）；
  // 单一全宽下拉（资产覆盖）允许长文本，select 自身会裁剪。
  const tierSelOpts = findAll(tree, (n) => n.type === 'optgroup').flatMap((g) => findAll(g, (n) => n.type === 'option'))
  const allOpts = findAll(tree, (n) => n.type === 'option')
  const longOpts = tierSelOpts.filter((o) => String(o.props.children || '').length > 42)
  ok(`档位下拉选项文本 ≤ 42 字（档位项 ${tierSelOpts.length} 个 / 全部 ${allOpts.length} 个）`, longOpts.length === 0,
    longOpts.slice(0, 3).map((o) => String(o.props.children).slice(0, 60)).join(' / '))
  ok('档位下拉按组 optgroup 归类', findAll(tree, (n) => n.type === 'optgroup').length > 0)
  const ctrls = findAll(tree, (n) => (n.type === 'input' || n.type === 'select' || n.type === 'textarea')
    && n.props.style && !['radio', 'checkbox'].includes(n.props.type))
  const bad = ctrls.filter((n) => {
    const st = n.props.style
    return st.width !== '100%' || !st.boxSizing || st.minWidth !== 0
  })
  ok(`输入/下拉控件均可收缩（width:100% + box-sizing + minWidth:0，共 ${ctrls.length} 个）`, bad.length === 0,
    `不合规 ${bad.length} 个：` + bad.slice(0, 3).map((n) => n.props.type || n.type).join(','))
  const grids = findAll(tree, (n) => n.props.style && n.props.style.gridTemplateColumns)
  const badGrid = grids.filter((n) => /1fr/.test(n.props.style.gridTemplateColumns) && !/minmax\(0,\s*1fr\)|auto-fit/.test(n.props.style.gridTemplateColumns))
  ok('栅格列只使用 minmax(0,1fr)/auto-fit（1fr 会被内容撑破）', badGrid.length === 0,
    badGrid.slice(0, 2).map((n) => n.props.style.gridTemplateColumns).join(' / '))
}

console.log('\n[5] 主题适配断言（防硬编码颜色：深色主题下白底浅字＝内容看不见）')
{
  resetHooks()
  const tree = await renderStable(settingsComponent, {})
  const fields = findAll(tree, (n) => ['input', 'select', 'textarea', 'button'].includes(n.type) && n.props.style)
  const literals = []
  for (const n of fields) {
    for (const k of ['color', 'background', 'backgroundColor', 'border', 'borderColor']) {
      const v = n.props.style[k]
      if (typeof v === 'string' && !v.includes('var(--dsw-') && /#|rgb|white|black/i.test(v)) {
        literals.push(`${n.type}.${k}=${v}`)
      }
    }
  }
  ok(`控件颜色全部走宿主主题变量（检查 ${fields.length} 个控件）`, literals.length === 0,
    `硬编码 ${literals.length} 处：` + literals.slice(0, 3).join(', '))
  // 文本/标签同样不能硬编码（否则深色主题下标签几乎不可见）
  const textNodes = findAll(tree, (n) => ['span', 'p', 'div', 'strong', 'label'].includes(n.type) && n.props.style && n.props.style.color)
  const badText = textNodes.filter((n) => !String(n.props.style.color).includes('var(--dsw-'))
  ok(`文本颜色全部走宿主主题变量（检查 ${textNodes.length} 处显式 color）`, badText.length === 0,
    badText.slice(0, 3).map((n) => n.props.style.color).join(', '))
}

// 新契约：策略＝**用户可命名的一套档位组合**（内置默认那条＝跟随注册表首选）。
// 用合成 payload 覆盖三条路径：① 单选/应用；② 新增策略（命名 + 逐档挑，含跨组）；③ 重命名/删除。
console.log('\n[6] 策略：内置默认 / 用户自建 / 新增（命名 + 自由组合）')
{
  const impl = (id, group, tier, accel = '') => ({
    id, displayName: group, group, tier, accel, available: true, missingNodes: [], requiresNodes: [],
    estSeconds: 10, note: '', source: 'builtin', modes: [tier], longSide: 832, steps: 4,
  })
  const mkGroup = (id, name, withAccel) => ({
    id, displayName: name,
    tiers: {
      fast: [impl(id + '-fast', id, 'fast')],
      balanced: [impl(id + '-balanced', id, 'balanced')].concat(withAccel ? [impl(id + '-balanced-sol', id, 'balanced', 'sol')] : []),
      quality: [impl(id + '-quality', id, 'quality')].concat(withAccel ? [impl(id + '-quality-sol', id, 'quality', 'sol')] : []),
    },
  })
  const payload = {
    ok: true, tiers: ['fast', 'balanced', 'quality'], errors: [],
    capabilities: [
      {
        capability: 'video.multi', tiered: true, tiers: ['fast', 'balanced', 'quality'], unclassified: [],
        groups: [mkGroup('grpA', '甲族', true), mkGroup('grpB', '乙族', true)],
        availableTiers: ['balanced'],   // 当前策略只提供 balanced（其余档位对它而言不存在）
        strategies: [
          { id: '__default', label: '甲族', builtin: true, available: true, selected: false, tiers: { fast: 'grpA-fast', balanced: 'grpA-balanced', quality: 'grpA-quality' } },
          { id: 's1', label: '我的快档', builtin: false, available: true, selected: true, tiers: { balanced: 'grpB-balanced-sol' } },
        ],
        workflows: ['grpA', 'grpB'].flatMap((g) => [impl(g + '-fast', g, 'fast'), impl(g + '-balanced', g, 'balanced'), impl(g + '-balanced-sol', g, 'balanced', 'sol'), impl(g + '-quality', g, 'quality'), impl(g + '-quality-sol', g, 'quality', 'sol')]),
        selection: { balanced: 'grpB-balanced-sol' },
      },
      {
        capability: 'video.other', tiered: true, tiers: ['fast'], unclassified: [],
        groups: [mkGroup('grpC', '丙族', false)],
        availableTiers: ['fast'],
        strategies: [{ id: '__default', label: '丙族', builtin: true, available: true, selected: true, tiers: { fast: 'grpC-fast' } }],
        workflows: [impl('grpC-fast', 'grpC', 'fast')],
        selection: {},
      },
    ],
  }
  const cfg0 = { tiers: { 'video.multi': { balanced: 'grpB-balanced-sol' }, 'video.other': { fast: 'grpC-fast' } }, strategies: { 'video.multi': [{ id: 's1', name: '我的快档', tiers: { balanced: 'grpB-balanced-sol' } }] }, strategyOf: { 'video.multi': 's1' } }
  const posts = []
  global.fetch = async (url, opts2) => {
    const isCfg = String(url).includes('/api/config')
    if (isCfg && opts2 && opts2.method === 'POST') posts.push(JSON.parse(opts2.body))
    return { ok: true, json: async () => (isCfg ? { ok: true, config: cfg0 } : payload) }
  }
  resetHooks()
  let tree = null
  try { tree = await renderStable(settingsComponent, {}) } catch (e) { ok('多能力渲染不抛异常', false, e.message) }
  if (tree) {
    const radios = findAll(tree, (n) => n.type === 'input' && n.props.type === 'radio' && String(n.props.name || '').startsWith('strategy-'))
    const names = [...new Set(radios.map((r) => r.props.name))]
    eq('单选组按能力隔离（不串台）', names.length, 2)
    eq('单选组名带能力 id', names.sort().join(','), 'strategy-video.multi,strategy-video.other')
    eq('共 3 条策略单选（2+1）', radios.length, 3)
    const checked = radios.filter((r) => r.props.checked)
    eq('每条被选中的策略来自注册表 selected 标记', checked.length, 2)
    eq('内置默认与用户策略各点亮一条', checked.map((r) => r.props.name).sort().join(','), 'strategy-video.multi,strategy-video.other')

    // ① 应用内置默认 → 清空该能力显式选择（跟随注册表首选），并记下选中策略
    const defRadio = radios.find((r) => r.props.name === 'strategy-video.multi' && !r.props.checked)
    if (defRadio) { await defRadio.props.onChange({ target: {} }); await new Promise((r) => setImmediate(r)) }
    let last = posts[posts.length - 1] || {}
    ok('应用内置默认会写配置', Boolean(last.tiers), JSON.stringify(last).slice(0, 140))
    eq('内置默认 → 清空该能力档位快照（不再被冻住）', Object.keys(last.tiers?.['video.multi'] || {}).length, 0)
    eq('内置默认 → strategyOf 记为 __default', last.strategyOf?.['video.multi'], '__default')
    const before = posts.length
    // ② 应用用户策略 → 写入其档位快照
    const userRadio = radios.find((r) => r.props.name === 'strategy-video.multi' && r.props.checked)
    if (userRadio) { await userRadio.props.onChange({ target: {} }); await new Promise((r) => setImmediate(r)) }
    last = posts[posts.length - 1] || {}
    ok('应用用户策略会写配置', posts.length > before)
    eq('用户策略 → 写入它的档位快照', last.tiers?.['video.multi']?.balanced, 'grpB-balanced-sol')
    eq('用户策略 → strategyOf 记为它的 id', last.strategyOf?.['video.multi'], 's1')

    // ③ 新交互：默认只显示策略列表与名称；点「编辑档位」才展开该策略的档位表单
    const idle = findAll(tree, (n) => n.type === 'select' && findAll(n, (o) => String(o.props.children || '').includes('不选＝')).length > 0)
    eq('默认视图不出现档位表单下拉', idle.length, 0)
    const idleText = textOf(tree)
    ok('用户策略摘要只列它挑过的档位（不写别的档位凑数）',
      idleText.includes('balanced → grpB-balanced-sol') && !idleText.includes('fast → grpA-fast'), idleText.slice(0, 200))
    const editBtn = findAll(tree, (n) => n.type === 'button').find((b) => String(textOf(b)).includes('编辑档位'))
    ok('策略行有「编辑档位」按钮', Boolean(editBtn))
    if (editBtn) {
      editBtn.props.onClick()
      tree = await renderStable(settingsComponent, {})
      const formSel = findAll(tree, (n) => n.type === 'select' && findAll(n, (o) => String(o.props.children || '').includes('不选＝')).length > 0)
      ok('点「编辑档位」后出现档位下拉', formSel.length >= 1, `实际 ${formSel.length} 个`)
      ok('表单预填当前生效/该策略挑过的实现',
        formSel.some((sel) => String(sel.props.value || '').length > 0), formSel.map((x) => String(x.props.value)).join('|'))
    }

    // ③ 新增策略：表单字段齐全（策略名 + 每档一个下拉，选项来自各组 = 跨组自由组合）
    const addBtn = findAll(tree, (n) => n.type === 'button' && String(textOf(n)).includes('新增策略'))
    ok('有「新增策略」按钮', addBtn.length === 2, `实际 ${addBtn.length}`)
    if (addBtn.length) {
      await addBtn[0].props.onClick({ target: {} })
      await new Promise((r) => setImmediate(r))
      const tree2 = await renderStable(settingsComponent, {})
      const nameInput = findAll(tree2, (n) => n.type === 'input' && String(n.props.placeholder || '').includes('例如'))
      ok('展开后有策略名输入框', nameInput.length === 1)
      const optgroups = findAll(tree2, (n) => n.type === 'optgroup').map((g) => g.props.label)
      ok('每档下拉按组分类（跨组自由组合）', optgroups.includes('甲族') && optgroups.includes('乙族'), optgroups.join(','))
      const saveBtn = findAll(tree2, (n) => n.type === 'button' && String(textOf(n)).includes('保存并选用'))
      ok('同一时刻只展开一个新增表单（保存并选用按钮唯一）', saveBtn.length === 1, `实际 ${saveBtn.length}`)
      ok('表单说明"只挑你关心的档位就行（≥1）"', textOf(tree2).includes('只挑你关心的档位就行'))
      ok('未挑的档位写明"不属于这条策略"（不是跟随默认）',
        textOf(tree2).includes('不选＝这条策略不含这一档') && textOf(tree2).includes('没挑的档位不属于这条策略'))

      // ④ 只挑 1 个档位也能存（不必凑三档）；存下来的就是被挑中的那几个
      const posts2 = []
      global.fetch = async (url, opts2) => {
        const isCfg = String(url).includes('/api/config')
        if (isCfg && opts2 && opts2.method === 'POST') posts2.push(JSON.parse(opts2.body))
        return { ok: true, json: async () => (isCfg ? { ok: true, config: cfg0 } : payload) }
      }
      resetHooks()
      let t3 = await renderStable(settingsComponent, {})
      await findAll(t3, (n) => n.type === 'button' && String(textOf(n)).includes('新增策略'))[0].props.onClick({ target: {} })
      await new Promise((r) => setImmediate(r))
      t3 = await renderStable(settingsComponent, {})
      const nameIn = findAll(t3, (n) => n.type === 'input' && String(n.props.placeholder || '').includes('例如'))[0]
      await nameIn.props.onChange({ target: { value: '只要一档' } })
      await new Promise((r) => setImmediate(r))
      t3 = await renderStable(settingsComponent, {})
      // 找到该能力的新增表单里 balanced 那一档的下拉（表单在策略区之后，取最后一个匹配）
      const formSelects = findAll(t3, (n) => n.type === 'select').filter((sel) => findAll(sel, (o) => String(o.props.children || '').includes('不选＝这条策略不含这一档')).length > 0)
      ok('新增表单每档一个下拉（可留空）', formSelects.length >= 3, `实际 ${formSelects.length}`)
      await formSelects[1].props.onChange({ target: { value: 'grpB-balanced-sol' } })
      await new Promise((r) => setImmediate(r))
      t3 = await renderStable(settingsComponent, {})
      const saveBtn2 = findAll(t3, (n) => n.type === 'button' && String(textOf(n)).includes('保存并选用'))[0]
      await saveBtn2.props.onClick({ target: {} })
      await new Promise((r) => setImmediate(r))
      const lastPost = posts2[posts2.length - 1] || {}
      const savedList = (lastPost.strategies || {})['video.multi'] || []
      const saved = savedList[savedList.length - 1] || {}
      eq('只挑一个档位即可保存', saved.name, '只要一档')
      eq('存下来的就只有被挑中的那一档（不凑三档）', Object.keys(saved.tiers || {}).join(','), 'balanced')
      eq('档位快照也只写被挑中的档', Object.keys(lastPost.tiers?.['video.multi'] || {}).join(','), 'balanced')
    }
  }
}

