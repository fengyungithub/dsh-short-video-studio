/**
 * scripts/preview-canvas.mjs — 画布页的真浏览器走查：主题跟随 + 响应式布局，并出截图。
 *
 * 为什么必须有它：scripts/smoke-canvas-theme.mjs 只做静态检查（调色板对等/无字面量/
 * 纯 JS 算对比度）。真正决定「看不看得清」的是浏览器把半透明底、渐变、color-mix
 * 逐层合成之后的**实际像素**，而「窄栏会不会被挤变形」只有真排版引擎说了算。本脚本：
 *
 *   1) 起一个 stub 服务，把 studio/ 按宿主同样的路径喂出去，/api/canvas 回一份
 *      **覆盖每种节点类型/状态/分区**的样例工程（主线 + 抽帧 + 作废 + 三种 chip + 报错行 +
 *      文本/markdown/表格/图片/视频）；
 *   2) 按 ?theme=light / ?theme=dark 各开一次，断言 <html data-theme> 就是传进去的那个；
 *   3) 跑 ui-probe 的 lowContrast()：把元素自身到祖先的半透明背景层层合成后算 WCAG 比值，
 *      不达标即失败——这是「深色主题下白底浅字」这类问题的可量化判据；
 *   4) 断言运行时跟随：postMessage 换主题后 <html data-theme> 真的变了，而非法取值/
 *      别的消息类型不会误改；
 *   5) 断言无 ?theme= 时回落 prefers-color-scheme；
 *   6) 顺带量一遍 .svs-modal（app.js 自绘模态）在两套主题下的对比度；
 *   7) **响应式布局**：宽栏（1100）+ 窄栏（360，右侧面板宽度）两档，断言顶栏的工程参数行
 *      独占一行、占满整行、内部自己换行而不裁剪，且工具栏控件都在自己行内、页面无横向滚动；
 *   8) 截图到 e2e-out/ui/。
 *
 * 用法：
 *   node scripts/preview-canvas.mjs              # 两套主题 + 两档宽度
 *   node scripts/preview-canvas.mjs --theme=light
 *   node scripts/preview-canvas.mjs --assert      # CI 模式：任一断言失败即退出码 1
 * 产物：e2e-out/ui/canvas-{light,dark}.png、e2e-out/ui/canvas-modal-{light,dark}.png
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, normalize } from 'node:path'
import { PROBE_CONTRAST } from './lib/ui-probe.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STUDIO = join(ROOT, 'studio')
const OUT = join(ROOT, 'e2e-out', 'ui')
const ROUTE_ROOT = '/dsh-short-video-studio'
const ASSERT = process.argv.includes('--assert')
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `期望 ${want}，实际 ${got}`)

// --- 样例工程：覆盖每种会用到主题色的节点面 ----------------------------------
const PROJECT = {
  settings: { aspectRatio: '16:9', duration: '30 秒', audioMode: 'dialogue-led', mode: 'quality', groupOrder: ['角色', '场景'] },
  nodes: [
    {
      id: 'n-brief', kind: 'text', title: '项目简报', group: '角色', status: 'ready', order: 1,
      content: '# 项目简报\n\n**一句话**：一只想当宇航员的小狐狸。\n\n- 片长：30 秒\n- 画幅：16:9\n\n> 温柔、不煽情\n\n| 项 | 值 |\n| --- | --- |\n| 音频 | 对话主导 |\n\n```\nseed: 42\n```\n',
    },
    { id: 'n-card', kind: 'table', title: '角色卡', group: '角色', status: 'ready', order: 2, content: '| 角色 | 外观 |\n| --- | --- |\n| 小狐狸 | 橙色毛发、护目镜 |' },
    { id: 'n-scene', kind: 'image', title: '场景卡 · 发射台', group: '场景', status: 'ready', order: 3, media: 'demo/scene.png', params: { capability: 'image.text2image', width: 1344, height: 768 } },
    { id: 'n-shot', kind: 'video', title: 'S01 片段', group: '场景', status: 'pending', order: 4, media: 'demo/shot.mp4' },
    { id: 'n-fail', kind: 'image', title: 'S02 片段', group: '场景', status: 'failed', order: 5, error: 'ComfyUI 连接超时（样例数据）' },
    { id: 'n-frame', kind: 'image', title: 'S01 检查帧', group: 'ungrouped', status: 'ready', order: 6, media: 'demo/frame.png', params: { capability: 'image.from_video' } },
    { id: 'n-old', kind: 'text', title: '旧版大纲（已废弃）', group: 'ungrouped', status: 'ready', order: 7, content: '这一版已被后面的大纲取代。' },
  ],
}

// 16×16 纯色 PNG（占位画面；只为让 .media 有真实内容可量）
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVR42mP8z8BQz0AEYBxVSF+FjIOsAAMDAwMAHhkC/e3pOFEAAAAASUVORK5CYII=',
  'base64',
)

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' }

// --- 资产库样例：三种载体各一条。删除会真的把它从数组摘掉，好让「对话框重渲染」看得出来。
const assets = [
  { id: 'character:luna', type: 'character', kind: 'image', name: 'luna', state: 'default' },
  { id: 'clip:shot01', type: 'clip', kind: 'video', name: 'shot01', state: 'default' },
  {
    id: 'text:shotlist', type: 'text', kind: 'text', name: 'shotlist', state: 'default', nodeKind: 'table',
    text: '| 镜号 | 景别 | 内容 |\n| --- | --- | --- |\n| S01 | 全景 | 小狐狸站在发射台下 |\n| S02 | 近景 | 它戴上护目镜 |',
  },
]
const jsonRes = (res, status, obj) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj))

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname
  if (!p.startsWith(ROUTE_ROOT)) { res.writeHead(404).end('not found'); return }
  const rel = p.slice(ROUTE_ROOT.length).replace(/^\/+/, '')
  if (rel === 'api/canvas') { jsonRes(res, 200, PROJECT); return }
  if (rel === 'api/assets/to-canvas') { jsonRes(res, 200, { ok: true, nodeId: 'n-from-lib' }); return }
  if (rel === 'api/assets') {
    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id')
      const i = assets.findIndex((a) => a.id === id)
      if (i < 0) { jsonRes(res, 404, { ok: false, message: '资产不存在: ' + id }); return }
      assets.splice(i, 1)
      jsonRes(res, 200, { ok: true, id, kind: 'video', fileDeleted: true })
      return
    }
    jsonRes(res, 200, { ok: true, assets })
    return
  }
  if (rel === 'media') { res.writeHead(200, { 'content-type': 'image/png' }).end(PNG); return }
  const file = rel === '' ? 'index.html' : normalize(rel)
  const full = join(STUDIO, file)
  if (!full.startsWith(STUDIO) || !existsSync(full)) { res.writeHead(404).end('not found'); return }
  let body = readFileSync(full)
  // 与宿主一致：index.html 里的 token 占位符要替换掉
  if (file === 'index.html') body = Buffer.from(body.toString('utf8').replace('__DSH_SVS_TOKEN_VALUE__', 'preview-token'), 'utf8')
  const ext = file.slice(file.lastIndexOf('.'))
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' }).end(body)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const ORIGIN = `http://127.0.0.1:${PORT}`
const PAGE = `${ORIGIN}${ROUTE_ROOT}/?sessionId=s-preview&workspaceId=w-preview`

let puppeteer = null
try { puppeteer = (await import('puppeteer-core')).default } catch { puppeteer = null }
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
]
const exe = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!puppeteer || !exe) {
  console.error(!puppeteer ? '未安装 puppeteer-core' : '未找到 Chrome', '— 跳过画布主题预览')
  server.close()
  process.exit(0)
}

mkdirSync(OUT, { recursive: true })
const themes = arg('theme', '') ? [arg('theme', 'light')] : ['light', 'dark']
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const measured = {}

try {
  for (const theme of themes) {
    console.log(`\n[${theme}] ?theme=${theme}`)
    const p = await browser.newPage()
    await p.setViewport({ width: 1100, height: 2200, deviceScaleFactor: 1 })
    await p.goto(`${PAGE}&theme=${theme}`, { waitUntil: 'networkidle0' })
    await p.waitForSelector('.node', { timeout: 10000 })

    eq('首屏 <html data-theme> 就是宿主传的那个', await p.evaluate(() => document.documentElement.getAttribute('data-theme')), theme)
    ok('画布用的是本页自己的 color-scheme（原生控件跟着走）',
      await p.evaluate(() => getComputedStyle(document.documentElement).colorScheme.includes(document.documentElement.getAttribute('data-theme'))))
    eq('顶栏品牌文案', await p.evaluate(() => document.querySelector('.brand').textContent.trim()), '🎬 短视频画布')

    // 真有内容被渲染出来（否则下面的对比度检查会「空跑通过」）
    const counts = await p.evaluate(() => ({
      nodes: document.querySelectorAll('.node').length,
      lanes: document.querySelectorAll('.lane').length,
      chips: document.querySelectorAll('.status').length,
      md: document.querySelectorAll('.text-content h1, .text-content pre, .text-content blockquote, .text-content table').length,
    }))
    ok(`样例工程渲染完整（${counts.nodes} 卡片 / ${counts.lanes} 收纳区 / ${counts.chips} chip / ${counts.md} markdown 块）`,
      counts.nodes === PROJECT.nodes.length && counts.lanes >= 2 && counts.chips >= PROJECT.nodes.length && counts.md >= 4, JSON.stringify(counts))

    await p.evaluate(PROBE_CONTRAST)
    const low = await p.evaluate(() => globalThis.__uiProbe.lowContrast(document.body))
    if (low.length) { console.log('  ⚠️ 对比度不足：'); for (const s of low.slice(0, 12)) console.log('    - ' + s) }
    eq('全页对比度达 WCAG AA', low.length ? low.slice(0, 3).join(' | ') : '（无）', '（无）')

    // 记下关键元素的**实际像素**配色，供两套主题对比（顺带留证据）
    measured[theme] = await p.evaluate(() => {
      const cs = (sel, prop) => { const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null }
      return {
        body: cs('body', 'backgroundColor'),
        text: cs('body', 'color'),
        node: cs('.node', 'backgroundColor'),
        chipReady: cs('.status.ready', 'color'),
        chipReadyBg: cs('.status.ready', 'backgroundColor'),
        chipFailed: cs('.status.failed', 'color'),
        btnAccent: cs('.btn-accent', 'color'),
        groupTitle: cs('.group-title', 'color'),
        laneBg: cs('.lane', 'backgroundColor'),
      }
    })
    console.log(`  实测色：底 ${measured[theme].body} / 字 ${measured[theme].text} / ready chip ${measured[theme].chipReady} on ${measured[theme].chipReadyBg}`)

    const shot = join(OUT, `canvas-${theme}.png`)
    await p.screenshot({ path: shot, fullPage: true })
    console.log(`  截图 → ${shot}`)

    // --- 运行时跟随：宿主 postMessage 换主题 ---------------------------------
    const send = (data, origin) => p.evaluate((d, o) => window.postMessage(d, o), data, origin ?? ORIGIN)
    await send({ channel: 'dsh-short-video-studio', type: 'theme', theme: theme === 'dark' ? 'light' : 'dark' })
    await new Promise((r) => setTimeout(r, 80))
    eq('宿主 postMessage → 画布立刻换主题', await p.evaluate(() => document.documentElement.getAttribute('data-theme')), theme === 'dark' ? 'light' : 'dark')
    await send({ channel: 'dsh-short-video-studio', type: 'theme', theme: theme })
    await new Promise((r) => setTimeout(r, 80))
    eq('再切回来', await p.evaluate(() => document.documentElement.getAttribute('data-theme')), theme)

    await send({ channel: 'dsh-short-video-studio', type: 'theme', theme: 'blue' })
    await send({ channel: 'other-plugin', type: 'theme', theme: theme === 'dark' ? 'light' : 'dark' })
    await send({ channel: 'dsh-short-video-studio', type: 'ask-ai', text: 'hi' })
    await new Promise((r) => setTimeout(r, 80))
    eq('非法取值 / 别的插件 / 别的消息类型都不会误改主题', await p.evaluate(() => document.documentElement.getAttribute('data-theme')), theme)

    // --- 自绘模态（.svs-modal）的对比度 --------------------------------------
    await p.evaluate(() => {
      const host = document.createElement('div')
      host.className = 'svs-modal-host'
      host.id = 'probe-modal'
      const box = document.createElement('div')
      box.className = 'svs-modal lg'
      const p1 = document.createElement('p')
      p1.textContent = '确定把「旧版大纲（已废弃）」作废吗？作废后它会移出主线预览，随时可以还原。'
      box.appendChild(p1)
      const lb = document.createElement('div')
      lb.className = 'svs-field-label'
      lb.textContent = '资产名（小写英文/拼音，如 luna）'
      box.appendChild(lb)
      const input = document.createElement('input')
      input.className = 'svs-field'
      input.value = 'luna'
      box.appendChild(input)
      const actions = document.createElement('div')
      actions.className = 'svs-modal-actions'
      for (const [cls, label] of [['btn', '取消'], ['btn btn-accent', '入库']]) {
        const b = document.createElement('button')
        b.className = cls
        b.textContent = label
        actions.appendChild(b)
      }
      box.appendChild(actions)
      host.appendChild(box)
      document.body.appendChild(host)
    })
    const modalLow = await p.evaluate(() => globalThis.__uiProbe.lowContrast(document.querySelector('#probe-modal')))
    if (modalLow.length) { console.log('  ⚠️ 模态框对比度不足：'); for (const s of modalLow) console.log('    - ' + s) }
    eq('自绘模态（含输入框/按钮）对比度达 WCAG AA', modalLow.length ? modalLow.slice(0, 3).join(' | ') : '（无）', '（无）')
    const modalShot = join(OUT, `canvas-modal-${theme}.png`)
    await p.screenshot({ path: modalShot, clip: await p.evaluate(() => { const r = document.querySelector('#probe-modal .svs-modal').getBoundingClientRect(); return { x: Math.max(0, r.x - 20), y: Math.max(0, r.y - 20), width: Math.min(500, r.width + 40), height: r.height + 40 } }) })
    console.log(`  截图 → ${modalShot}`)
    await p.close()
  }

  // --- 两套主题必须真的是两套颜色 --------------------------------------------
  console.log('\n[两套主题的差异]')
  if (measured.light && measured.dark) {
    for (const k of Object.keys(measured.light)) {
      ok(`「${k}」两套取值不同`, measured.light[k] !== measured.dark[k], `light=${measured.light[k]} dark=${measured.dark[k]}`)
    }
  }

  // --- 没有 ?theme= 时回落系统偏好 -------------------------------------------
  console.log('\n[没有 ?theme= → 跟随系统偏好]')
  for (const sys of ['dark', 'light']) {
    const p = await browser.newPage()
    await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: sys }])
    await p.goto(PAGE, { waitUntil: 'networkidle0' })
    await p.waitForSelector('.node', { timeout: 10000 })
    eq(`系统 ${sys} → 画布 ${sys}`, await p.evaluate(() => document.documentElement.getAttribute('data-theme')), sys)
    await p.close()
  }

  // --- 响应式布局：顶栏三块 A(品牌) / B(参数) / C(按钮) ------------------------
  // 规格：宽 → 一行 A B C（B 吃中间剩余空间，C 靠右）；窄 → 竖直 A B C。
  // 背景：三块的内容长度都不定——参数那串在节点多的工程能到 60+ 字，按钮数量还可能随
  // 功能增加。混在一起时窄栏（右侧栏 ~360px）会出现「按钮被挤到不可预期的位置 /
  // 撑出横向滚动」。这里用「宽栏 + 窄栏」两档把两种排法都钉住。
  for (const [label, width, mode] of [['宽栏', 1100, 'row'], ['窄栏（右侧面板宽度）', 360, 'column']]) {
    console.log(`\n[布局 · ${label} ${width}px · 期望${mode === 'row' ? '一行 A B C' : '竖直 A B C'}]`)
    const p = await browser.newPage()
    await p.setViewport({ width, height: 900, deviceScaleFactor: 1 })
    await p.goto(`${PAGE}&theme=dark`, { waitUntil: 'networkidle0' })
    await p.waitForSelector('.node', { timeout: 10000 })
    const m = await p.evaluate(() => {
      const box = (el) => {
        const b = el.getBoundingClientRect()
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height, mid: (b.top + b.bottom) / 2 }
      }
      const topbar = document.querySelector('.topbar')
      const brand = document.querySelector('.brand')
      const bar = document.querySelector('.topbar-bar')
      const meta = document.querySelector('.meta')
      const canvas = document.querySelector('.canvas')
      return {
        innerWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        topbar: box(topbar), brand: box(brand), bar: box(bar), meta: box(meta),
        canvasScrollWidth: canvas.scrollWidth, canvasClientWidth: canvas.clientWidth,
        metaScrollWidth: meta.scrollWidth, metaClientWidth: meta.clientWidth,
        topbarPadLeft: parseFloat(getComputedStyle(topbar).paddingLeft),
        metaText: meta.textContent,
        metaDebug: (() => {
          const cs = getComputedStyle(meta)
          const r = document.createRange(); r.selectNodeContents(meta)
          const rects = [...r.getClientRects()]
          return {
            whiteSpace: cs.whiteSpace, overflowWrap: cs.overflowWrap, wordBreak: cs.wordBreak,
            fontSize: cs.fontSize, rectW: +meta.getBoundingClientRect().width.toFixed(2),
            clientH: meta.clientHeight, scrollH: meta.scrollHeight,
            lines: rects.length, lineWidths: rects.map((x) => +x.width.toFixed(1)),
          }
        })(),
        controls: [...bar.querySelectorAll('button, label')].map((el) => ({ label: el.textContent.trim().slice(0, 6), ...box(el) })),
      }
    })

    // 三块永远要满足的：顺序是 A B C、页面不横向滚动、按钮不越出自己的行
    ok(`顺序是 A B C（品牌在参数左/上，参数在按钮左/上）`,
      m.brand.left <= m.meta.left + 0.5 && m.meta.left <= m.bar.left + 0.5,
      `brand.left=${m.brand.left.toFixed(1)} meta.left=${m.meta.left.toFixed(1)} bar.left=${m.bar.left.toFixed(1)}`)
    ok(`无横向滚动（页面 ${m.docScrollWidth} ≤ ${m.innerWidth}）`, m.docScrollWidth <= m.innerWidth + 1)
    ok(`画布区无横向滚动（${m.canvasScrollWidth} ≤ ${m.canvasClientWidth}）`, m.canvasScrollWidth <= m.canvasClientWidth + 1)
    const escaping = m.controls.filter((c) => c.right > m.bar.right + 0.5 || c.left < m.bar.left - 0.5)
    ok(`按钮行 ${m.controls.length} 个控件都在本行内（${escaping.map((c) => c.label).join(',') || '无越界'}）`, escaping.length === 0)

    if (mode === 'row') {
      // 一行：三块的中线对齐（align-items:center，高度不同所以不能比 top）
      ok('三块同一行（中线对齐）',
        Math.abs(m.brand.mid - m.meta.mid) < 2 && Math.abs(m.meta.mid - m.bar.mid) < 2,
        `中线 brand=${m.brand.mid.toFixed(1)} meta=${m.meta.mid.toFixed(1)} bar=${m.bar.mid.toFixed(1)}`)
      ok('参数块在品牌右侧、按钮块在参数右侧（B 吸收中间剩余空间）',
        m.meta.left >= m.brand.right - 0.5 && m.bar.left >= m.meta.right - 0.5,
        `brand=[${m.brand.left.toFixed(0)},${m.brand.right.toFixed(0)}] meta=[${m.meta.left.toFixed(0)},${m.meta.right.toFixed(0)}] bar=[${m.bar.left.toFixed(0)},${m.bar.right.toFixed(0)}]`)
      ok('按钮块靠右端（B 吃掉了剩余空间）',
        Math.abs(m.bar.right - (m.topbar.right - m.topbarPadLeft)) < 1,
        `bar.right=${m.bar.right.toFixed(1)} 期望 ${(m.topbar.right - m.topbarPadLeft).toFixed(1)}`)
      ok('三块确实没被竖排（参数块与品牌块在同一水平带）', m.meta.top < m.brand.bottom && m.bar.top < m.meta.bottom)
      // 参数文本可能溢出自己的盒子几像素（见 app.css 里的实测说明），但**绝不能压到按钮**。
      const textRight = m.meta.left + m.metaScrollWidth
      ok(`参数文本不压到按钮（文本右缘 ${textRight.toFixed(1)} ≤ 按钮左缘 ${m.bar.left.toFixed(1)}）`,
        textRight <= m.bar.left + 0.5,
        `溢出盒子 ${(m.metaScrollWidth - m.metaClientWidth).toFixed(1)}px · ${JSON.stringify(m.metaDebug)}`)
    } else {
      // 竖直：A 在 B 上方，B 在 C 上方
      ok('竖直 A B C（品牌 → 参数 → 按钮，各占一行）',
        m.brand.bottom <= m.meta.top + 0.5 && m.meta.bottom <= m.bar.top + 0.5,
        `brand.bottom=${m.brand.bottom.toFixed(1)} meta.top=${m.meta.top.toFixed(1)} meta.bottom=${m.meta.bottom.toFixed(1)} bar.top=${m.bar.top.toFixed(1)}`)
      ok('三块都占满整行（与顶栏内容区同宽同左边）',
        [m.brand, m.meta, m.bar].every((b) => Math.abs(b.left - (m.topbar.left + m.topbarPadLeft)) < 1 && Math.abs(b.width - (m.topbar.width - 2 * m.topbarPadLeft)) < 1),
        `内容区 ${(m.topbar.left + m.topbarPadLeft).toFixed(1)}+${(m.topbar.width - 2 * m.topbarPadLeft).toFixed(1)}；brand=${m.brand.left.toFixed(1)}+${m.brand.width.toFixed(1)} bar=${m.bar.left.toFixed(1)}+${m.bar.width.toFixed(1)}`)
      ok(`窄栏时按钮在本行内换行（行高 ${m.bar.height.toFixed(0)}px > 单行）`, m.bar.height > 34)
      // 窄栏必须**真折行**：这里没有「溢出到按钮」的余地（下面就是按钮行）。
      ok('参数文本在窄栏内真折行、不溢出盒子',
        m.metaScrollWidth <= m.metaClientWidth + 1,
        `scrollW=${m.metaScrollWidth} clientW=${m.metaClientWidth} · ${JSON.stringify(m.metaDebug)}`)
    }
    console.log(`  品牌 ${m.brand.height.toFixed(0)}px / 参数行 ${m.meta.height.toFixed(0)}px / 按钮行 ${m.bar.height.toFixed(0)}px · 文本「${m.metaText}」`)
    const layoutShot = join(OUT, `canvas-layout-${width}.png`)
    await p.screenshot({ path: layoutShot })
    console.log(`  截图 → ${layoutShot}`)
    await p.close()
  }

  // --- 资产库对话框：三种载体怎么显示、删除怎么走 ------------------------------
  // 这一段是真浏览器交互（点按钮 → 弹确认 → 确认后重渲染），因为「视频缩略图/文本正文
  // 摘要/删除按钮」都是 DOM 行为，纯逻辑测试看不出来。
  console.log('\n[资产库对话框 · 三种载体 + 删除]')
  {
    const p = await browser.newPage()
    await p.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
    const deletes = []
    p.on('request', (r) => { if (r.method() === 'DELETE') deletes.push(r.url()) })
    await p.goto(`${PAGE}&theme=dark`, { waitUntil: 'networkidle0' })
    await p.waitForSelector('.node', { timeout: 10000 })
    await p.evaluate(PROBE_CONTRAST)
    await p.click('#add-assets')
    await p.waitForSelector('.asset-card', { timeout: 5000 })

    const view = await p.evaluate(() => {
      const card = (c) => ({
        id: c.dataset.assetId,
        hasImg: !!c.querySelector('.thumb img'),
        hasVideo: !!c.querySelector('.thumb video'),
        hasTextPreview: !!c.querySelector('.thumb .text-preview'),
        preview: (c.querySelector('.thumb .text-preview') || {}).textContent || '',
        missing: (c.querySelector('.thumb .missing') || {}).textContent || '',
        badge: (c.querySelector('.thumb .kind-badge') || {}).textContent || '',
        thumbPos: getComputedStyle(c.querySelector('.thumb')).position,
        buttons: [...c.querySelectorAll('.actions button')].map((b) => b.textContent.trim()),
        dangerBtn: (() => { const b = [...c.querySelectorAll('.actions button')].find((x) => x.textContent.trim() === '删除'); return b ? b.classList.contains('btn-danger') : false })(),
      })
      return {
        count: document.querySelectorAll('.asset-card').length,
        groups: [...document.querySelectorAll('.asset-group-title')].map((x) => x.textContent.trim()),
        cards: [...document.querySelectorAll('.asset-card')].map(card),
        lowContrast: globalThis.__uiProbe.lowContrast(document.querySelector('.dialog')),
      }
    })

    eq('对话框列出 3 条资产（三种载体）', view.count, 3)
    ok('分组标题按语义类别分：角色 / 视频片段 / 文本',
      ['角色', '视频片段', '文本'].every((t) => view.groups.some((g) => g.startsWith(t))),
      JSON.stringify(view.groups))
    const img = view.cards.find((c) => c.id === 'character:luna')
    const vid = view.cards.find((c) => c.id === 'clip:shot01')
    const txt = view.cards.find((c) => c.id === 'text:shotlist')
    ok('图片资产用 <img> 缩略图', img.hasImg && !img.hasVideo)
    // stub 只提供 PNG，<video> 会触发 onerror → 组件按设计退回「🎬 视频缺失」文案。
    // 这条断言真正要钉的是「走的是 video 分支」：要么 <video> 在，要么是**视频专用**的缺失提示，
    // 绝不能是一个坏掉的 <img>。
    ok('视频资产走 <video> 分支（本 stub 无真视频文件，故落到视频专用兜底而非坏图）',
      (vid.hasVideo && !vid.hasImg) || vid.missing.includes('视频缺失'),
      JSON.stringify({ hasVideo: vid.hasVideo, hasImg: vid.hasImg, missing: vid.missing }))
    ok('  视频卡片挂载体角标', vid.badge.includes('视频'), JSON.stringify(vid.badge))
    eq('  缩略图容器是定位上下文（否则角标会飞到对话框角落）', vid.thumbPos, 'relative')
    ok('文本资产不请求图片，直接显示正文摘要', txt.hasTextPreview && !txt.hasImg && txt.preview.includes('S01'), JSON.stringify(txt.preview.slice(0, 40)))
    ok('每张卡片都有「加入画布」和「删除」',
      view.cards.every((c) => c.buttons.some((b) => b.includes('加入画布')) && c.buttons.includes('删除')),
      JSON.stringify(view.cards.map((c) => c.buttons)))
    ok('删除是危险色（与主操作视觉区分）', view.cards.every((c) => c.dangerBtn))
    ok('对话框内无 AA 以下文本（深色）', view.lowContrast.length === 0, JSON.stringify(view.lowContrast))
    // 对话框也要跟着 DSH 换肤：开着对话框切主题，颜色与对比度都得对
    await p.evaluate((o) => window.postMessage({ channel: 'dsh-short-video-studio', type: 'theme', theme: 'light' }, o), ORIGIN)
    await p.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light', { timeout: 3000 })
    const lightView = await p.evaluate(() => ({
      low: globalThis.__uiProbe.lowContrast(document.querySelector('.dialog')),
      cardBg: getComputedStyle(document.querySelector('.asset-card')).backgroundColor,
      badge: getComputedStyle(document.querySelector('.kind-badge')).color,
      preview: getComputedStyle(document.querySelector('.text-preview')).color,
    }))
    ok('切到浅色后对话框无 AA 以下文本', lightView.low.length === 0, JSON.stringify(lightView.low))
    ok('  卡片底色确实换成了浅色（不是照抄深色变量）',
      lightView.cardBg !== view.cardBgDummy && lightView.cardBg.startsWith('rgb'), JSON.stringify(lightView.cardBg))
    const lightShot = join(OUT, 'canvas-asset-library-light.png')
    await p.screenshot({ path: lightShot })
    console.log(`  截图 → ${lightShot}`)
    await p.evaluate((o) => window.postMessage({ channel: 'dsh-short-video-studio', type: 'theme', theme: 'dark' }, o), ORIGIN)
    await p.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark', { timeout: 3000 })

    // 按钮几何：文字必须单行且不被截断（窄卡片 + 两个按钮最容易把「＋ 加入画布」挤成两行）
    const btns = await p.evaluate(() => [...document.querySelectorAll('.asset-card .actions button')].map((b) => {
      const r = document.createRange(); r.selectNodeContents(b)
      return {
        text: b.textContent.trim(),
        lines: [...r.getClientRects()].length,
        w: +b.getBoundingClientRect().width.toFixed(1),
        clipped: b.scrollWidth - b.clientWidth,
      }
    }))
    const badBtns = btns.filter((b) => b.lines > 1 || b.clipped > 1)
    ok('资产卡按钮文字都是单行且不被截断', badBtns.length === 0,
      `${badBtns.map((b) => `${b.text}(行${b.lines}/溢出${b.clipped}px/宽${b.w})`).join(' ') || JSON.stringify(btns[0])}`)
    console.log(`  按钮宽 ${btns.map((b) => b.w).join('/')}px · 卡片 ${(await p.evaluate(() => +document.querySelector('.asset-card').getBoundingClientRect().width.toFixed(1)))}px`)

    // 卡片多起来时对话框要能滚到底（第 3 张卡在 900px 高视口里已在折线以下）
    const scroll = await p.evaluate(async () => {
      const body = document.querySelector('.dialog-body')
      const before = { sh: body.scrollHeight, ch: body.clientHeight, st: body.scrollTop }
      body.scrollTop = body.scrollHeight
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const last = document.querySelector('.asset-card:last-of-type').getBoundingClientRect()
      const box = body.getBoundingClientRect()
      return { ...before, after: body.scrollTop, lastTop: +last.top.toFixed(1), lastBottom: +last.bottom.toFixed(1), boxTop: +box.top.toFixed(1), boxBottom: +box.bottom.toFixed(1) }
    })
    ok('资产多时对话框正文可滚动', scroll.sh > scroll.ch ? scroll.after > 0 : true,
      JSON.stringify(scroll))
    ok('  滚到底后最后一张卡完整可见（不是被底边切掉）',
      scroll.lastBottom <= scroll.boxBottom + 1 && scroll.lastTop >= scroll.boxTop - 1,
      JSON.stringify(scroll))
    await p.evaluate(() => { document.querySelector('.dialog-body').scrollTop = 0 })

    const dlgShot = join(OUT, 'canvas-asset-library.png')
    await p.screenshot({ path: dlgShot })
    console.log(`  截图 → ${dlgShot}`)

    // 删除：点删除 → 弹确认（必须说明画布上的卡片不受影响）→ 确认 → 卡片从列表消失
    await p.evaluate(() => {
      [...document.querySelectorAll('.asset-card')].find((c) => c.dataset.assetId === 'clip:shot01')
        .querySelectorAll('.actions button')[1].click()
    })
    await p.waitForSelector('.svs-modal', { timeout: 3000 })
    const confirm = await p.evaluate(() => {
      const m = document.querySelector('.svs-modal')
      const cs = getComputedStyle(m.querySelector('p'))
      return {
        text: m.querySelector('p').textContent,
        // 块级 <p> 的 getClientRects() 恒为 1 个矩形，要数行盒必须用 Range 选正文
        lines: (() => { const r = document.createRange(); r.selectNodeContents(m.querySelector('p')); return r.getClientRects().length })(),
        whiteSpace: cs.whiteSpace,
        buttons: [...m.querySelectorAll('.svs-modal-actions button')].map((b) => b.textContent.trim()),
      }
    })
    ok('删除前有确认，且把资产 id 写在里面', confirm.text.includes('clip:shot01'), confirm.text.slice(0, 60))
    ok('  确认文案说明「画布上的卡片不受影响」（避免用户以为会连带删画布）', confirm.text.includes('不受影响'))
    ok('  多行确认文案真的分行（不是挤成一坨）', confirm.lines > 1 && confirm.whiteSpace.includes('pre'), `lines=${confirm.lines} white-space=${confirm.whiteSpace}`)
    ok('  确认框按钮是 取消 / 删除', confirm.buttons.join(',') === '取消,删除', JSON.stringify(confirm.buttons))

    await p.evaluate(() => [...document.querySelectorAll('.svs-modal-actions button')].find((b) => b.textContent.trim() === '删除').click())
    await p.waitForFunction(() => document.querySelectorAll('.asset-card').length === 2, { timeout: 5000 })
    const after = await p.evaluate(() => ({
      count: document.querySelectorAll('.asset-card').length,
      ids: [...document.querySelectorAll('.asset-card')].map((c) => c.dataset.assetId),
      groups: [...document.querySelectorAll('.asset-group-title')].map((x) => x.textContent.trim()),
    }))
    eq('确认后列表只剩 2 条', after.count, 2)
    ok('  被删的那条不在了', !after.ids.includes('clip:shot01'), JSON.stringify(after.ids))
    ok('  它的分组标题也跟着消失（不是留下空标题）', !after.groups.some((g) => g.startsWith('视频片段')), JSON.stringify(after.groups))
    ok('  确实发出了 DELETE /api/assets?id=clip%3Ashot01',
      deletes.some((u) => u.includes('/api/assets?') && u.includes('clip%3Ashot01')),
      JSON.stringify(deletes))
    await p.close()
  }

  // --- 画布节点卡上的「入库」按钮：哪些节点有、类型下拉给出什么 -----------------
  // 用户的原始诉求就是「除了角色卡和场景卡，其他资产也要有加入资产库的按钮」，
  // 所以这里逐个节点核对按钮有无，并把下拉选项钉死（载体不匹配的类别不该出现在选项里）。
  console.log('\n[画布节点 · 入库按钮与类型下拉]')
  {
    const p = await browser.newPage()
    await p.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 })
    await p.goto(`${PAGE}&theme=dark`, { waitUntil: 'networkidle0' })
    await p.waitForSelector('.node', { timeout: 10000 })
    const cards = await p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.node')].map((c) => [
      c.dataset.nodeId,
      { kind: c.querySelector('.node-kind').textContent.trim(), buttons: [...c.querySelectorAll('.node-actions button')].map((b) => b.textContent.trim()) },
    ])))
    for (const [id, want] of [['n-card', 'image'], ['n-scene', 'image'], ['n-shot', 'video'], ['n-brief', 'text'], ['n-old', 'text']]) {
      ok(`${want} 节点 ${id} 有「入库」按钮`, Boolean(cards[id]) && cards[id].buttons.includes('入库'), JSON.stringify(cards[id]))
    }
    const failedCard = cards['n-fail']
    ok('生成失败的图节点也仍有入库按钮（入库只看节点类型，不看生成状态）', failedCard && failedCard.buttons.includes('入库'), JSON.stringify(failedCard))

    const openForm = async (nodeId) => {
      await p.evaluate((id) => {
        const btn = [...document.querySelectorAll(`.node[data-node-id="${id}"] .node-actions button`)].find((b) => b.textContent.trim() === '入库')
        btn.click()
      }, nodeId)
      await p.waitForSelector('.svs-modal select', { timeout: 3000 })
      return p.evaluate(() => ({
        values: [...document.querySelectorAll('.svs-modal select option')].map((o) => o.value),
        options: [...document.querySelectorAll('.svs-modal select option')].map((o) => o.textContent.trim()),
        hint: (document.querySelector('.svs-modal .svs-hint') || {}).textContent || '',
        label: (document.querySelector('.svs-modal .svs-field-label') || {}).textContent || '',
      }))
    }
    const cancelForm = () => p.evaluate(() => {
      const b = [...document.querySelectorAll('.svs-modal-actions button')].find((x) => x.textContent.trim() === '取消')
      if (b) b.click()
    })

    const vidForm = await openForm('n-shot')
    eq('视频节点的资产类型只有 clip 一项', vidForm.values.join(','), 'clip')
    ok('  下拉文案是「视频片段」', vidForm.options[0] === '视频片段', JSON.stringify(vidForm.options))
    ok('  表单标签点明该节点是视频片段', vidForm.label.includes('视频片段'), vidForm.label)
    ok('  提示说明视频资产不能作 ref 参考图', vidForm.hint.includes('不能作 ref'), vidForm.hint)
    await cancelForm()

    const txtForm = await openForm('n-brief')
    eq('文本节点的资产类型只有 text 一项', txtForm.values.join(','), 'text')
    ok('  提示说明文本资产存正文、也不能作参考图', txtForm.hint.includes('正文') && txtForm.hint.includes('不能作 ref'), txtForm.hint)
    await cancelForm()

    const imgForm = await openForm('n-scene')
    eq('图片节点仍提供 角色 / 场景 / 风格锚点', imgForm.values.join(','), 'character,scene,style')
    await cancelForm()

    const formShot = join(OUT, 'canvas-asset-register.png')
    await openForm('n-shot')
    await p.screenshot({ path: formShot })
    console.log(`  截图 → ${formShot}`)
    await p.close()
  }
} finally {
  await browser.close()
  server.close()
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (ASSERT && fail) process.exit(1)
