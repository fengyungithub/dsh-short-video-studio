/**
 * 冒烟：画布「⚙ 配置」面板（真浏览器）
 * 覆盖：顶栏按钮 → 面板渲染全部字段 → 改画幅 → POST /canvas/state（含 expectedRev）
 *       → 保存后面板关闭、画布刷新、顶栏摘要更新；配置卡显示「编辑配置」按钮。
 * 用法：node scripts/preview-config-panel.mjs
 * 产物：e2e-out/ui/config-panel.png
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, normalize } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STUDIO = join(ROOT, 'studio')
const OUT = join(ROOT, 'e2e-out', 'ui')
const ROUTE_ROOT = '/dsh-short-video-studio'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const PROJECT = {
  schemaVersion: 1,
  sessionId: 's-preview',
  settings: {
    aspectRatio: '16:9', duration: '90 秒', audioMode: 'dialogue-led',
    mode: 'balanced', imageTier: 'balanced', delivery: 'native',
    characterCardVariant: 'single', voicePlan: 'existing', subtitles: 'none',
    language: 'zh', style: 'cinematic-live-action', bgmMode: 'none',
    reviewMode: 'batch', shotGate: 'verdict', flow: 'story',
    rev: 4, breakingRev: 4, configured: true,
    meta: { updatedBy: 'agent', sources: { flow: 'agent', aspectRatio: 'agent' } },
    groupOrder: ['项目配置', 'story planning'],
  },
  nodes: [
    {
      id: 'cfg-s-preview', kind: 'text', title: '项目配置（STEP 0）', group: '项目配置',
      status: 'ready', order: -1, content: '## 项目配置（STEP 0）\n\n| 项 | 值 |\n| --- | --- |\n| 画幅 | 16:9 |',
      params: { configCard: true, configRev: 4, config: { rev: 4 } },
    },
    { id: 'n-brief', kind: 'text', title: '项目简报', group: 'story planning', status: 'ready', order: 1, content: '# 项目简报' },
  ],
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' }
const jsonRes = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

let savedPatch = null
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const rel = url.pathname.startsWith(ROUTE_ROOT + '/') ? url.pathname.slice(ROUTE_ROOT.length + 1) : ''
  if (rel === 'api/canvas') { jsonRes(res, 200, PROJECT); return }
  if (rel === 'api/canvas/state' && req.method === 'POST') {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try { savedPatch = JSON.parse(raw) } catch { savedPatch = {} }
      const patch = savedPatch.patch || {}
      Object.assign(PROJECT.settings, patch, { rev: (PROJECT.settings.rev || 0) + 1 })
      PROJECT.nodes[0].content = '## 项目配置（STEP 0）\n\n| 项 | 值 |\n| --- | --- |\n| 画幅 | ' + PROJECT.settings.aspectRatio + ' |'
      PROJECT.nodes[0].params.configRev = PROJECT.settings.rev
      jsonRes(res, 200, { ok: true, rev: PROJECT.settings.rev, changed: Object.keys(patch) })
    })
    return
  }
  if (rel === 'media') { res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.alloc(0)); return }
  const file = rel === '' ? 'index.html' : normalize(rel)
  const full = join(STUDIO, file)
  if (!full.startsWith(STUDIO) || !existsSync(full)) { res.writeHead(404).end('not found'); return }
  let body = readFileSync(full)
  if (file === 'index.html') body = Buffer.from(body.toString('utf8').replace('__DSH_SVS_TOKEN_VALUE__', 'preview-token'), 'utf8')
  const ext = file.slice(file.lastIndexOf('.'))
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' }).end(body)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

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
  console.error('未安装 puppeteer-core 或未找到 Chrome — 跳过配置面板预览')
  server.close()
  process.exit(0)
}

mkdirSync(OUT, { recursive: true })
const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 900 })
  await page.goto(`${ORIGIN}${ROUTE_ROOT}/?sessionId=s-preview&workspaceId=w-preview&theme=dark`, { waitUntil: 'networkidle0' })

  ok('顶栏有「⚙ 配置」按钮', await page.$('#config') !== null)
  ok('配置卡有「编辑配置」按钮', await page.evaluate(() => [...document.querySelectorAll('.node')].some((n) => n.dataset.nodeId === 'cfg-s-preview' && [...n.querySelectorAll('button')].some((b) => b.textContent.includes('编辑配置')))))
  ok('配置卡没有裸文本「编辑」按钮', await page.evaluate(() => {
    const n = [...document.querySelectorAll('.node')].find((x) => x.dataset.nodeId === 'cfg-s-preview')
    return ![...n.querySelectorAll('button')].some((b) => b.textContent.trim() === '编辑')
  }))
  ok('顶栏摘要显示 rev / 片型', await page.evaluate(() => document.getElementById('meta').textContent.includes('片型 story') && document.getElementById('meta').textContent.includes('rev 4')))

  await page.click('#config')
  await page.waitForSelector('.dialog')
  ok('面板标题正确', await page.evaluate(() => document.querySelector('.dialog-title').textContent.includes('项目配置')))
  const rows = await page.$$eval('.config-row', (els) => els.length)
  ok('面板渲染 15 个字段', rows === 15, `实际 ${rows}`)
  ok('画幅输入框初值 16:9', await page.evaluate(() => {
    const row = [...document.querySelectorAll('.config-row')].find((r) => r.querySelector('.config-label')?.textContent === '画幅')
    return row?.querySelector('input')?.value === '16:9'
  }))

  // 改画幅 → 保存
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.config-row')].find((r) => r.querySelector('.config-label')?.textContent === '画幅')
    const input = row.querySelector('input')
    input.value = '9:16'
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.dialog-actions button')].find((b) => b.textContent.includes('保存配置'))
    btn.click()
  })
  // 有产物时会先弹确认框
  await page.waitForSelector('.svs-modal', { timeout: 3000 }).catch(() => {})
  if (await page.$('.svs-modal')) {
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.svs-modal button')].find((b) => b.textContent.includes('仍然保存'))
      btn.click()
    })
  }
  await page.waitForFunction(() => !document.querySelector('.dialog'), { timeout: 5000 })
  ok('保存后提交 patch', savedPatch && savedPatch.patch && savedPatch.patch.aspectRatio === '9:16')
  ok('保存带 expectedRev=4', savedPatch && savedPatch.expectedRev === 4)
  await page.waitForFunction(() => document.getElementById('meta').textContent.includes('9:16'), { timeout: 5000 })
  ok('刷新后顶栏画幅更新为 9:16', true)

  await page.screenshot({ path: join(OUT, 'config-panel.png'), fullPage: true })
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项（截图 e2e-out/ui/config-panel.png）`)
} finally {
  await browser.close()
  server.close()
}
process.exit(fail ? 1 : 0)
