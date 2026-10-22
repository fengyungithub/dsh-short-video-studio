/**
 * scripts/smoke-ref-picker.mjs — 输入框参考图选择器（画布 / 资产库）离屏冒烟。
 *
 * 真跑 lib/client.js 的 InnerGenBar：进入视频模式 → 点「＋」→ 选择器列出
 * 画布图片节点与资产库图片资产 → 选资产后物化到画布并写入 refs（owned=true）
 * → 再选画布节点只引用不复制（owned=false）。
 *
 * 用法：node scripts/smoke-ref-picker.mjs
 */
process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || '/nonexistent/svs-ref-picker.json'

import { React, renderStable, resetHooks, findAll } from './lib/react-shim.mjs'
import { _internals } from '../lib/index.js'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, String(got) === String(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)

// --- 假 document（捕获 CSS）--------------------------------------------------
global.document = {
  head: { appendChild: () => {} },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, set textContent(v) { this._t = v }, get textContent() { return this._t } }),
}
let mod = null
global.window = { __ModuleLoader__: { load: (m) => { mod = m } } }
await import('../lib/client.js')
const T = mod.factory((name) => (name === 'react' ? React : {}))

const reg = {}
T.apply({
  slots: { inject: (name, fn) => fn(), register: (def, Component) => { reg[def.name] = { def, Component } } },
  effect: () => {}, log: () => {}, warn: () => {}, error: () => {},
})
const toggle = reg['conversation.input.left']
const bar = reg['conversation.input.attachments']
if (!toggle || !bar) { console.error('未取到组件注册：', Object.keys(reg)); process.exit(1) }

const cfg = _internals.getCfg ? _internals.getCfg() : {}
const apiPayload = await _internals.describeWorkflowsApi(_internals.getRegistry(), { probe: false, cfg: {} })
const ROUTE = _internals.ROUTE_ROOT
const SID = 'smoke-ref-picker'

const canvasProject = {
  schemaVersion: 1,
  sessionId: SID,
  settings: { aspectRatio: '16:9' },
  nodes: [
    { id: 'canvas-img', kind: 'image', title: '画布角色', group: 'character cards', media: `canvas/${SID}/canvas.png`, status: 'ready', order: 1 },
    { id: 'canvas-video', kind: 'video', title: '画布视频', group: 'shot clips', media: `canvas/${SID}/v.mp4`, status: 'ready', order: 2 },
  ],
}
const assetList = [
  { id: 'character:资产角色', type: 'character', kind: 'image', name: '资产角色', title: '资产角色·单视图', state: 'default' },
  { id: 'clip:不要出现', type: 'clip', kind: 'video', name: '不要出现', title: '视频资产' },
  { id: 'text:不要出现', type: 'text', kind: 'text', name: '不要出现', title: '文本资产' },
]

global.fetch = async (url, init) => {
  const u = String(url)
  const json = (v) => ({ ok: true, json: async () => v })
  if (u.includes('/api/config')) return json({ ok: true, config: cfg })
  if (u.includes('/api/workflows')) return json(apiPayload)
  if (u.includes('?t=')) return { ok: true, text: async () => 'window.__DSH_SVS_TOKEN__ = "test-token";' }
  if (u.includes(ROUTE + '/api/assets/to-canvas')) {
    const body = JSON.parse((init && init.body) || '{}')
    return json({ ok: true, nodeId: 'asset-node', media: `canvas/${SID}/asset.png`, title: body.id })
  }
  if (u.includes(ROUTE + '/api/assets')) return json({ ok: true, assets: assetList })
  if (u.includes(ROUTE + '/api/canvas')) return json(canvasProject)
  return json({ ok: true })
}

resetHooks()
const toggleTree = await renderStable(toggle.Component, { sessionId: SID, input: { draft: '' } })
const btns = findAll(toggleTree, (n) => n.type === 'button' || (n.props && n.props.onClick))
const videoBtn = btns.find((n) => String(n.props.children || '').includes('视频'))
videoBtn.props.onClick({ preventDefault() {}, stopPropagation() {} })

const props = {
  sessionId: SID, attachments: [], inputActions: { setDraft: () => {}, insert: () => {}, consume: () => '' },
  useInput: (sel) => (sel ? sel({ draft: '一只猫' }) : { draft: '一只猫' }),
}
resetHooks()
let tree = await renderStable(bar.Component, props)
let addSlot = findAll(tree, (n) => n.props && n.props.className === 'svsg-slot add')[0]
ok('视频模式有参考图加号', Boolean(addSlot))
addSlot.props.onClick({ preventDefault() {}, stopPropagation() {} })
await new Promise((r) => setTimeout(r, 20))
tree = await renderStable(bar.Component, props)

const mask = findAll(tree, (n) => n.props && n.props.className === 'svsg-picker-mask')[0]
ok('点击加号打开参考图选择器', Boolean(mask))
const picks = findAll(tree, (n) => n.props && n.props.className === 'svsg-pick')
const pickTitles = picks.map((n) => findAll(n, (x) => x.props && x.props.className === 'svsg-pick-name').map((x) => x.props.children).join(''))
ok('选择器列出画布图片节点', pickTitles.includes('画布角色'), pickTitles.join(' / '))
ok('选择器列出资产库图片资产', pickTitles.includes('资产角色·单视图'), pickTitles.join(' / '))
ok('选择器过滤掉视频/文本资产', !pickTitles.includes('视频资产') && !pickTitles.includes('文本资产'), pickTitles.join(' / '))

const assetPick = picks.find((n) => pickTitles[picks.indexOf(n)] === '资产角色·单视图')
assetPick.props.onClick({ preventDefault() {}, stopPropagation() {} })
await new Promise((r) => setTimeout(r, 20))
tree = await renderStable(bar.Component, props)
let st = T.__test.genStateOf(SID)
eq('选资产后写入 refs', st.refs[0] && st.refs[0].nodeId, 'asset-node')
eq('资产 ref 标记 owned=true', st.refs[0] && st.refs[0].owned, true)
ok('选择器已关闭', findAll(tree, (n) => n.props && n.props.className === 'svsg-picker-mask').length === 0)

addSlot = findAll(tree, (n) => n.props && n.props.className === 'svsg-slot add')[0]
addSlot.props.onClick({ preventDefault() {}, stopPropagation() {} })
await new Promise((r) => setTimeout(r, 20))
tree = await renderStable(bar.Component, props)
const picks2 = findAll(tree, (n) => n.props && n.props.className === 'svsg-pick')
const canvasPick = picks2.find((n) => findAll(n, (x) => x.props && x.props.className === 'svsg-pick-name').some((x) => x.props.children === '画布角色'))
ok('再次打开选择器可画画布项', Boolean(canvasPick))
canvasPick.props.onClick({ preventDefault() {}, stopPropagation() {} })
await new Promise((r) => setTimeout(r, 20))
tree = await renderStable(bar.Component, props)
st = T.__test.genStateOf(SID)
eq('选画布节点后追加 refs', st.refs[1] && st.refs[1].nodeId, 'canvas-img')
eq('画布 ref 标记 owned=false', st.refs[1] && st.refs[1].owned, false)

// --- 图片 i2i：同一个选择器，单张参考图 ---
T.__test.genPatch(SID, { mode: 'image', imgType: 'i2i', refs: [], first: null, last: null })
resetHooks()
tree = await renderStable(bar.Component, props)
addSlot = findAll(tree, (n) => n.props && n.props.className === 'svsg-slot add')[0]
ok('i2i 模式有参考图加号', Boolean(addSlot), addSlot && addSlot.props.title)
addSlot.props.onClick({ preventDefault() {}, stopPropagation() {} })
await new Promise((r) => setTimeout(r, 20))
tree = await renderStable(bar.Component, props)
const i2iPicks = findAll(tree, (n) => n.props && n.props.className === 'svsg-pick')
const i2iAsset = i2iPicks.find((n) => findAll(n, (x) => x.props && x.props.className === 'svsg-pick-name').some((x) => x.props.children === '资产角色·单视图'))
ok('i2i 选择器同样列出资产', Boolean(i2iAsset))
i2iAsset.props.onClick({ preventDefault() {}, stopPropagation() {} })
await new Promise((r) => setTimeout(r, 20))
tree = await renderStable(bar.Component, props)
st = T.__test.genStateOf(SID)
eq('i2i 选资产后只保留 1 张参考图', st.refs.length, 1)
eq('i2i 参考图节点', st.refs[0] && st.refs[0].nodeId, 'asset-node')

console.log(`\n${fail ? '✗' : '✓'} smoke-ref-picker：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
