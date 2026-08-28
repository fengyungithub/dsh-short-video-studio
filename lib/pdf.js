/**
 * 文本节点导出 PDF（确定性后处理，非模型能力）。
 *
 * 渲染层分两级：
 *  1. puppeteer-core（推荐，可选依赖）—— 复用本机 Chrome，`page.pdf()`：
 *     `printBackground`（打印表格底色）、A4 边距、分页，样式保留最完整；
 *     未安装/加载失败时自动降级到 CLI。
 *  2. CLI 兜底（零依赖）—— Chrome `--print-to-pdf`（最优）→ LibreOffice
 *     soffice → cupsfilter（macOS 自带，样式基本丢失）。
 * 均不可用时 detectPdfTool() 返回 null，调用方降级导出 .html。
 *
 * 设计对齐 lib/concat.js：参数走数组不经 shell；spawn 带超时；失败抛错由调用方兜底。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

let _pptr
/** 动态加载 puppeteer-core（可选依赖：未安装返回 null，走 CLI 兜底）。 */
async function loadPuppeteer() {
  if (_pptr !== undefined) return _pptr
  try {
    const mod = await import('puppeteer-core')
    _pptr = mod.default ?? mod
  } catch {
    _pptr = null
  }
  return _pptr
}

/** 用 puppeteer-core 渲染 HTML → PDF（printBackground / A4 / 边距）。失败抛错。 */
async function pdfViaPuppeteer(executablePath, htmlAbs, pdfAbs) {
  const pptr = await loadPuppeteer()
  if (!pptr) throw new Error('pdf-no-puppeteer: puppeteer-core 未安装')
  let browser
  try {
    browser = await pptr.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    })
    const page = await browser.newPage()
    await page.goto(pathToFileURL(htmlAbs).href, { waitUntil: 'networkidle0', timeout: 30000 })
    await page.pdf({
      path: pdfAbs,
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', right: '14mm', bottom: '14mm', left: '14mm' },
      displayHeaderFooter: false,
    })
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
  if (!existsSync(pdfAbs)) throw new Error('pdf-puppeteer-empty: 未生成 PDF 文件')
}

/** 用 Chrome CLI --print-to-pdf 渲染（零依赖兜底，printBackground 不保证）。 */
async function pdfViaChromeCli(bin, htmlAbs, pdfAbs) {
  const href = pathToFileURL(htmlAbs).href
  const flags = ['--headless=new', '--disable-gpu', '--no-sandbox']
  // 新 Chrome 支持 --no-pdf-header-footer；老版本不认，失败后去参重试
  let r = await run(bin, [...flags, '--no-pdf-header-footer', `--print-to-pdf=${pdfAbs}`, href], { timeoutMs: 60000 })
  if (r.code !== 0 || !existsSync(pdfAbs)) {
    r = await run(bin, [...flags, `--print-to-pdf=${pdfAbs}`, href], { timeoutMs: 60000 })
  }
  if (r.code !== 0 || !existsSync(pdfAbs)) {
    throw new Error('pdf-chrome-failed: ' + (r.stderr.split('\n').slice(-3).join(' ').trim() || r.code))
  }
}

/** 跑一条命令。opts.stdout=true 时收集 stdout（cupsfilter 输出 PDF 字节）。 */
function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', opts.stdout ? 'pipe' : 'ignore', 'pipe'] })
    } catch {
      resolve({ code: -1, stdout: '', stderr: 'spawn failed' })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, opts.timeoutMs ?? 30000)
    if (opts.stdout) child.stdout?.on('data', (c) => { stdout += String(c) })
    child.stderr?.on('data', (c) => { stderr += String(c) })
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr || 'spawn error' }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

let _pdfToolProbe
/** 探测本机可用的 PDF 工具，返回 { type, bin } 或 null。结果缓存（进程内）。 */
export async function detectPdfTool() {
  if (_pdfToolProbe !== undefined) return _pdfToolProbe
  for (const c of CHROME_CANDIDATES) {
    if (existsSync(c)) { _pdfToolProbe = { type: 'chrome', bin: c }; return _pdfToolProbe }
  }
  const soffice = await run('soffice', ['--version'])
  if (soffice.code === 0) { _pdfToolProbe = { type: 'soffice', bin: 'soffice' }; return _pdfToolProbe }
  if (existsSync('/usr/sbin/cupsfilter')) { _pdfToolProbe = { type: 'cupsfilter', bin: '/usr/sbin/cupsfilter' }; return _pdfToolProbe }
  _pdfToolProbe = null
  return null
}

/**
 * HTML 文件 → PDF 文件。失败抛错（调用方负责降级）。
 * @param {{type:string, bin:string}} tool detectPdfTool() 的结果
 * @param {string} htmlAbs 输入 HTML 绝对路径
 * @param {string} pdfAbs 输出 PDF 绝对路径
 */
export async function htmlToPdf(tool, htmlAbs, pdfAbs) {
  if (!tool) throw new Error('pdf-no-tool: 本机无 PDF 工具')
  if (tool.type === 'chrome') {
    // 优先 puppeteer-core（printBackground 完整保留表格样式）；失败降级 CLI
    try {
      await pdfViaPuppeteer(tool.bin, htmlAbs, pdfAbs)
      return
    } catch (error) {
      console.warn('[dsh-short-video-studio] puppeteer pdf failed, fallback chrome cli:', error?.message || String(error))
    }
    await pdfViaChromeCli(tool.bin, htmlAbs, pdfAbs)
    return
  }
  if (tool.type === 'soffice') {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-svs-pdf-'))
    try {
      const r = await run(tool.bin, ['--headless', '--convert-to', 'pdf', '--outdir', dir, htmlAbs], { timeoutMs: 90000 })
      const out = join(dir, basename(htmlAbs).replace(/\.html?$/i, '') + '.pdf')
      if (r.code !== 0 || !existsSync(out)) {
        throw new Error('pdf-soffice-failed: ' + (r.stderr.split('\n').slice(-3).join(' ').trim() || r.code))
      }
      await rename(out, pdfAbs)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
    return
  }
  if (tool.type === 'cupsfilter') {
    const r = await run(tool.bin, [htmlAbs], { stdout: true, timeoutMs: 60000 })
    if (r.code !== 0 || r.stdout.length === 0) {
      throw new Error('pdf-cups-failed: ' + (r.stderr.split('\n').slice(-3).join(' ').trim() || r.code))
    }
    await writeFile(pdfAbs, r.stdout)
    return
  }
  throw new Error('pdf-unknown-tool: ' + tool.type)
}
