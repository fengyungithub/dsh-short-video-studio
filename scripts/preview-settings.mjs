/**
 * scripts/preview-settings.mjs — 把插件设置页离屏渲染成 HTML 并截图（UI 走查用）。
 *
 * 为什么要它：设置页/工具条是纯内联样式，靠读代码判断「有没有溢出、对齐是否整齐」
 * 不可靠。本脚本用 scripts/lib/react-shim.mjs 真跑一遍组件 → 序列化成静态 HTML →
 * 用本机 Chrome 按几种容器宽度截图，人（或 agent 的视觉）直接看结果。
 *
 * 用法：
 *   node scripts/preview-settings.mjs                 # 760 / 640 / 520 三档宽度
 *   node scripts/preview-settings.mjs --width=420     # 指定宽度（窄屏溢出排查）
 *   node scripts/preview-settings.mjs --html          # 只产出 HTML 不截图
 * 产物：e2e-out/ui/settings-<宽>.png 与 e2e-out/ui/settings.html
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { React, renderStable, toHtml, resetHooks } from './lib/react-shim.mjs'
import { _internals } from '../lib/index.js'
import { themeCss, PROBE_CONTRAST } from './lib/ui-probe.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'e2e-out', 'ui')

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}
const HTML_ONLY = process.argv.includes('--html')
const widths = arg('width', '') ? [Number(arg('width', '760'))] : [760, 640, 520]

// --- 1) 加载客户端模块 -------------------------------------------------------
let mod = null
global.window = { __ModuleLoader__: { load: (m) => { mod = m } } }
await import('../lib/client.js')
const moduleExports = mod.factory((name) => (name === 'react' ? React : {}))

// --- 2) 造真实形状的数据（后端同一份 payload）--------------------------------
// 默认用**本机真实配置**（读 ~/.dsh 里那份），--fixture 才用手写样本：
// 只有真实数据才能暴露用户实际看到的溢出（真实 tiers 选择/更多能力/长资产名）。
const USE_FIXTURE = process.argv.includes('--fixture')
const cfgFixture = {
  baseUrl: 'http://localhost:8188', apiKey: '', pollMs: 2000, timeoutMs: 900000,
  models: {}, assetOverrides: { 'minimax-h3-ref2v-quality': { vae: 'minimax_h3_video_vae_int8_convrot.safetensors' } },
  preferred: { 'image.image2image': ['flux2-img2img'] },
  tiers: { 'video.reference2video': { fast: 'minimax-h3-ref2v-fast', balanced: 'minimax-h3-ref2v-balanced-sol', quality: 'minimax-h3-ref2v-quality-sol' } },
}
const realCfg = _internals.getCfg ? _internals.getCfg() : null
const cfg = USE_FIXTURE || !realCfg ? cfgFixture : realCfg
const apiPayload = await _internals.describeWorkflowsApi(_internals.getRegistry(), { probe: true })
// 注意：/api/config 必须回**同一份** cfg（payload 用的是哪份就回哪份），否则
// "注册表侧（策略/选中）"与"客户端侧（逐档回显）"会来自两份不同配置，预览会自相矛盾。
global.fetch = async (url) => ({
  ok: true,
  json: async () => (String(url).includes('/api/config') ? { ok: true, config: cfg } : apiPayload),
})

let settingsComponent = null
moduleExports.apply({
  slots: {
    inject: (name, fn) => { if (name === 'settings.section') fn() },
    register: (def, Component) => { if (def.name === 'settings.section') settingsComponent = Component },
  },
  effect: () => {}, log: () => {}, warn: () => {}, error: () => {},
})

// --- 3) 渲染 + 序列化 --------------------------------------------------------
resetHooks()
const tree = await renderStable(settingsComponent, {})
const inner = toHtml(tree)
mkdirSync(OUT, { recursive: true })

const page = (width, themeName = 'dark') => `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>
  ${themeCss(themeName)}
  html,body{margin:0;padding:0;background:var(--dsw-alias-bg-base)}
  body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:var(--dsw-alias-label-primary)}
  /* 模拟 DSH 设置面板的可用宽度：外面给固定宽，里面是插件自己的容器 */
  .pane{width:${width}px;box-sizing:border-box;border-right:1px dashed #c9ced6}
  input,select,textarea,button{font:inherit;color:inherit}
  select,input[type=text],input[type=password],textarea{background:#fff}
  /* 给可滚动/可裁剪元素加可见提示，便于发现溢出 */
  .pane *{outline-offset:-1px}
</style></head><body><div class="pane">${inner}</div></body></html>`

const htmlPath = join(OUT, 'settings.html')
writeFileSync(htmlPath, page(760), 'utf8')
console.log('HTML →', htmlPath)
if (HTML_ONLY) process.exit(0)

// --- 4) 截图 -----------------------------------------------------------------
let puppeteer = null
try { puppeteer = (await import('puppeteer-core')).default } catch { puppeteer = null }
if (!puppeteer) { console.error('未安装 puppeteer-core，跳过截图（HTML 已产出）'); process.exit(0) }

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
]
const exe = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!exe) { console.error('未找到 Chrome，跳过截图'); process.exit(0) }

const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const themes = process.argv.includes('--theme=') ? [arg('theme', 'dark')] : ['dark', 'light']
  for (const w of widths) for (const themeName of themes) {
    const p = await browser.newPage()
    await p.setViewport({ width: w + 40, height: 1200, deviceScaleFactor: 2 })
    await p.setContent(page(w, themeName), { waitUntil: 'load' })
    // 顺便量一下有没有横向溢出（可编程的硬指标）
    await p.evaluate(PROBE_CONTRAST)
    const probe = await p.evaluate(() => {
      const pane = document.querySelector('.pane')
      const bad = []
      for (const el of pane.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        const pr = pane.getBoundingClientRect()
        if (r.right > pr.right + 0.5 || r.left < pr.left - 0.5) {
          bad.push(`${el.tagName.toLowerCase()}${el.className ? '.' + el.className : ''}(${Math.round(r.left - pr.left)}…${Math.round(r.right - pr.left)} vs pane ${Math.round(pr.width)})`)
        }
        if (el.scrollWidth > el.clientWidth + 1 && ['SELECT', 'INPUT', 'DIV', 'SPAN'].includes(el.tagName)) {
          bad.push(`裁剪: ${el.tagName.toLowerCase()}${el.className ? '.' + el.className : ''} scrollW=${el.scrollWidth} clientW=${el.clientWidth}`)
        }
      }
      // 对齐度量：同一父容器内的控件应共享左边缘与宽度（"排列不整齐"的客观判据）
      const misaligned = []
      for (const el of pane.querySelectorAll('div,label')) {
        // radio/checkbox 是"行标记"，天然比文本控件小，不参与高度比对（只比左边缘）
        const all = [...el.querySelectorAll(':scope > input, :scope > select, :scope > textarea, :scope > button, :scope > div > select, :scope > div > input')]
        const ctrls = all.filter((x) => !(x.tagName === 'INPUT' && ['radio', 'checkbox'].includes(x.type)))
        if (ctrls.length < 2) continue
        const lefts = ctrls.map((x) => Math.round(x.getBoundingClientRect().left))
        const widths = ctrls.map((x) => Math.round(x.getBoundingClientRect().width))
        const heights = ctrls.map((x) => Math.round(x.getBoundingClientRect().height))
        const spread = (a) => Math.max(...a) - Math.min(...a)
        const tops = ctrls.map((x) => Math.round(x.getBoundingClientRect().top))
        // 同行（top 相同）的控件宽度本就该不同（按钮随文字宽度）——只查高度；
        // 只有纵向堆叠（top 不同）才要求左边缘与宽度一致。
        const horizontal = new Set(tops).size === 1
        if (horizontal ? spread(heights) > 2 : (spread(lefts) > 2 || spread(widths) > 2)) {
          misaligned.push(`${el.tagName.toLowerCase()}${el.className ? '.' + el.className : ''}: lefts=[${lefts.join(',')}] widths=[${widths.join(',')}] heights=[${heights.join(',')}]`)
        }
      }
      const lowContrast = globalThis.__uiProbe.lowContrast(pane)
      const heights = [...new Set([...pane.querySelectorAll('input:not([type=radio]),select,textarea')].map((x) => Math.round(x.getBoundingClientRect().height)))]
      // 行标记（radio）左边缘应整块一致：同一能力块内所有 radio 的左边缘相同
      const radioLefts = {}
      for (const r of pane.querySelectorAll('input[type=radio]')) {
        const sec = r.closest('div[style*="border-radius: 8px"]')
        const key = sec ? (sec.querySelector('strong') ? sec.querySelector('strong').textContent : '?') : '(块外)'
        radioLefts[key] = radioLefts[key] || new Set()
        radioLefts[key].add(Math.round(r.getBoundingClientRect().left))
      }
      const radioBad = Object.entries(radioLefts).filter(([, v]) => v.size > 1).map(([k, v]) => `${k}: ${[...v].join(',')}`)
      return { overflow: bad, misaligned, heights, radioBad, lowContrast: globalThis.__uiProbe.lowContrast(pane), height: Math.round(pane.getBoundingClientRect().height) }
    })
    const file = join(OUT, `settings-${w}${themeName === 'light' ? '-light' : ''}.png`)
    await p.screenshot({ path: file, fullPage: true })
    console.log(`截图 → ${file}（容器高 ${probe.height}px）`)
    if (probe.lowContrast.length) {
      console.log('  ⚠️ 对比度不足（看不清内容）：')
      for (const s of probe.lowContrast.slice(0, 12)) console.log('    - ' + s)
    } else { console.log('  ✓ 所有文本/控件对比度达标（WCAG AA）') }
    console.log('  控件高度集合：[' + probe.heights.join(', ') + ']px' + (probe.heights.length > 1 ? ' ⚠️ 高度不统一' : ' ✓ 统一'))
    if (probe.radioBad.length) { console.log('  ⚠️ radio 左边缘不一致：' + probe.radioBad.join(' | ')) } else { console.log('  ✓ radio 左边缘一致') }
    if (probe.misaligned.length) {
      console.log('  ⚠️ 同容器内控件未对齐：')
      for (const s of probe.misaligned.slice(0, 12)) console.log('    - ' + s)
    } else {
      console.log('  ✓ 同容器内控件左边缘/宽度一致')
    }
    if (probe.overflow.length) {
      console.log('  ⚠️ 溢出/裁剪嫌疑：')
      for (const s of probe.overflow.slice(0, 25)) console.log('    - ' + s)
    } else {
      console.log('  ✓ 无横向溢出、无裁剪')
    }
    await p.close()
  }
} finally {
  await browser.close()
}
