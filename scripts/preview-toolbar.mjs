/**
 * scripts/preview-toolbar.mjs — 离屏渲染「生成参数条」（composer input.attachments 槽位）并截图。
 *
 * 与 preview-settings.mjs 同一套垫片/度量：真跑组件 → 序列化 → Chrome 截图 + 溢出/对齐度量。
 * 生成模式通过先渲染 GenToggle 并触发其点击来切换（store 是模块级的）。
 *
 * 用法：node scripts/preview-toolbar.mjs [--width=640]
 * 产物：e2e-out/ui/toolbar-<宽>.png
 */

// 测试隔离：不读本机 ~/.dsh 里的真实配置（里面可能有用户自建策略/档位选择，
// 会把「未指定档位」「档位列表」等断言前提改掉）。纯逻辑测试一律跑在空配置上。
process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || '/nonexistent/svs-smoke-config.json'

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { React, renderStable, toHtml, resetHooks, findAll } from './lib/react-shim.mjs'
import { _internals } from '../lib/index.js'
import { themeCss, PROBE_CONTRAST } from './lib/ui-probe.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'e2e-out', 'ui')
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}
const widths = arg('width', '') ? [Number(arg('width', '640'))] : [720, 560, 420]

// --- 1) 用假 document 捕获 GEN_CSS（组件样式表）------------------------------
let capturedCss = ''
global.document = {
  head: { appendChild: (tag) => { capturedCss = String(tag.textContent || '') } },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, set textContent(v) { this._t = v }, get textContent() { return this._t } }),
}

let mod = null
global.window = { __ModuleLoader__: { load: (m) => { mod = m } } }
await import('../lib/client.js')
const T = mod.factory((name) => (name === 'react' ? React : {}))

// --- 2) 收集注册的组件 -------------------------------------------------------
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
global.fetch = async (url) => ({
  ok: true,
  json: async () => (String(url).includes('/api/config') ? { ok: true, config: cfg } : apiPayload),
})

const SID = 'preview-session'
// 3) 先渲染开关，点一下进入 video 模式（store 是模块级的，参数条会读到）
resetHooks()
const toggleTree = await renderStable(toggle.Component, { sessionId: SID, input: { draft: '' } })
const btns = findAll(toggleTree, (n) => n.type === 'button' || (n.props && n.props.onClick))
const videoBtn = btns.find((n) => String(n.props.children || '').includes('视频')) || btns[0]
if (!videoBtn) { console.error('开关上没有可点的按钮'); process.exit(1) }
videoBtn.props.onClick({ preventDefault() {}, stopPropagation() {} })

// 4) 渲染参数条
const inputActions = { setDraft: () => {}, insert: () => {}, consume: () => '' }
resetHooks()
let tree
try {
  tree = await renderStable(bar.Component, {
    sessionId: SID, attachments: [], inputActions,
    useInput: (sel) => (sel ? sel({ draft: '一只猫在雨中的霓虹街道上抬头看着雨滴' }) : { draft: '' }),
  })
} catch (e) {
  console.error('参数条渲染失败：', e.message)
  process.exit(1)
}
// 结构断言（--assert，无需 Chrome）：标签必须与控件同在一个不可拆分的组里，
// 否则窄宽度下会被 flex 换行拆散（历史上出现过「时长」标签与下拉框分行）。
const labels = findAll(tree, (n) => n.props && n.props.className === 'svsg-lbl')
const groups = findAll(tree, (n) => n.props && n.props.className === 'svsg-grp')
let orphan = 0
const walk = (n, inGrp) => {
  if (!n || typeof n !== 'object') return
  if (Array.isArray(n)) { n.forEach((x) => walk(x, inGrp)); return }
  if (!n.__el) return
  const cls = (n.props && n.props.className) || ''
  const nowIn = inGrp || cls === 'svsg-grp'
  if (cls === 'svsg-lbl' && !nowIn) orphan++
  walk(n.props && n.props.children, nowIn)
}
walk(tree, false)
if (process.argv.includes('--assert')) {
  // 档位选项必须来自档位矩阵（UI 不预设档位数量/名称）
  const TE = T.__test
  const grpOf = (text) => findAll(tree, (n) => n.props && n.props.className === 'svsg-grp'
    && findAll(n, (x) => typeof (x.props && x.props.children) === 'string' && x.props.children === text).length > 0)[0]
  const tierSel = grpOf('档位') && findAll(grpOf('档位'), (n) => n.type === 'select')[0]
  const tierVals = tierSel ? findAll(tierSel, (n) => n.type === 'option').map((o) => o.props.value) : []
  const capTiers = TE.tiersOf(apiPayload, 'video.reference2video')
  const tiersOk = tierVals.length > 0 && tierVals.join(',') === capTiers.join(',')
  const labelsHaveEst = tierSel ? findAll(tierSel, (n) => n.type === 'option').every((o) => String(o.props.children).includes('约')) : false
  const okAll = orphan === 0 && labels.length > 0 && groups.length > 0 && tiersOk && labelsHaveEst
  console.log(`参数条结构断言：标签 ${labels.length} / 分组 ${groups.length} / 游离 ${orphan} / 档位选项 [${tierVals.join(', ')}] = 矩阵 [${capTiers.join(', ')}] ${tiersOk ? '✓' : '✗'} / 选项含实测耗时 ${labelsHaveEst ? '✓' : '✗'} → ${okAll ? '✓ 通过' : '✗ 失败'}`)
  process.exit(okAll ? 0 : 1)
}
const inner = toHtml(tree)
mkdirSync(OUT, { recursive: true })

const page = (width, themeName = 'dark') => `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>
  ${themeCss(themeName)}
  html,body{margin:0;padding:0;background:var(--dsw-alias-bg-base)}
  body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--dsw-alias-label-primary)}
  .composer{width:${width}px;box-sizing:border-box;padding:10px 0;border:1px dashed var(--dsw-alias-border-l2)}
  ${capturedCss}
</style></head><body><div class="composer">${inner}</div></body></html>`

writeFileSync(join(OUT, 'toolbar.html'), page(widths[0]), 'utf8')
if (process.argv.includes('--html')) { console.log('HTML →', join(OUT, 'toolbar.html')); process.exit(0) }

let puppeteer = null
try { puppeteer = (await import('puppeteer-core')).default } catch { puppeteer = null }
const exe = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome'].find(existsSync)
if (!puppeteer || !exe) { console.error('缺 puppeteer-core 或 Chrome，仅产出 HTML'); process.exit(0) }

const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const themes = process.argv.includes('--theme=') ? [arg('theme', 'dark')] : ['dark', 'light']
  for (const w of widths) for (const themeName of themes) {
    const p = await browser.newPage()
    await p.setViewport({ width: w + 40, height: 900, deviceScaleFactor: 2 })
    await p.setContent(page(w, themeName), { waitUntil: 'load' })
    await p.evaluate(PROBE_CONTRAST)
    const probe = await p.evaluate(() => {
      const host = document.querySelector('.composer')
      const hr = host.getBoundingClientRect()
      const bad = []
      for (const el of host.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        if (r.right > hr.right + 0.5 || r.left < hr.left - 0.5) bad.push(`${el.tagName.toLowerCase()}.${el.className}(${Math.round(r.left - hr.left)}…${Math.round(r.right - hr.left)} vs ${Math.round(hr.width)})`)
        if (el.scrollWidth > el.clientWidth + 1 && ['SELECT', 'INPUT', 'DIV', 'SPAN'].includes(el.tagName)) bad.push(`裁剪: ${el.tagName.toLowerCase()}.${el.className} scrollW=${el.scrollWidth} clientW=${el.clientWidth}`)
      }
      const rowH = [...host.querySelectorAll('.svsg-row')].map((el) => Math.round(el.getBoundingClientRect().height))
      return { bad, rowH, lowContrast: globalThis.__uiProbe.lowContrast(host), height: Math.round(hr.height) }
    })
    const file = join(OUT, `toolbar-${w}${themeName === 'light' ? '-light' : ''}.png`)
    await p.screenshot({ path: file, fullPage: true })
    console.log(`截图 → ${file}（高 ${probe.height}px，参数条各行高 [${probe.rowH.join(', ')}]）`)
    if (probe.lowContrast.length) {
      console.log('  ⚠️ 对比度不足（看不清内容）：')
      for (const s of probe.lowContrast.slice(0, 10)) console.log('    - ' + s)
    } else console.log('  ✓ 文本/控件对比度达标（WCAG AA）')
    if (probe.bad.length) { console.log('  ⚠️ 溢出/裁剪：'); for (const s of probe.bad.slice(0, 15)) console.log('    - ' + s) }
    else console.log('  ✓ 无横向溢出、无裁剪')
    await p.close()
  }
} finally { await browser.close() }
