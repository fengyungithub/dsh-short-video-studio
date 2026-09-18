/**
 * scripts/smoke-canvas-theme.mjs — 画布页「跟随 DSH 浅/深」的离线冒烟。
 *
 * 为什么必须有这个测试：画布页（studio/）跑在 iframe 里，读不到宿主文档的 CSS 变量，
 * 所以它自带两套调色板，由 <html data-theme> 选择。这类「同一份样式跑两套色」最容易出的
 * 问题都不是崩溃，而是**静默变色**——某个变量只在一套里定义了、某处又写死了一个浅色，
 * 于是切到另一套主题时那一个角落还是老样子，没人会发现。这里把三条硬规矩变成断言：
 *
 *   1. 两个调色板块定义**完全相同**的变量名（少一个 = 切过去就没颜色）；
 *   2. 调色板块之外**零颜色字面量**（写死的色值 = 切主题时不会跟着变）；
 *   3. 用到的每个 var(--x) 都在两套里都定义了（拼错名字不会报错，只会静默失效）。
 *
 * 外加两件事：
 *   - 首屏时序：主题脚本必须在样式表**之前**（否则先按浅色画一帧再跳深色，闪一下）；
 *   - WCAG 对比度：纯 JS 合成半透明底再算比值，两套调色板的主要「字/底」配对都要达 AA。
 *     （真浏览器的合成结果由 scripts/preview-canvas-theme.mjs 量，那个是权威；
 *      这里是快速网，能在没有 Chrome 的机器上先拦一道。）
 *
 * 用法：node scripts/smoke-canvas-theme.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(ROOT, 'studio/app.css'), 'utf8')
const html = readFileSync(join(ROOT, 'studio/index.html'), 'utf8')
const js = readFileSync(join(ROOT, 'studio/app.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `期望 ${want}，实际 ${got}`)

// --- 解析两套调色板 ----------------------------------------------------------

/** 抠出首个匹配的 CSS 规则体。 */
function ruleBody(source, headRe) {
  const m = headRe.exec(source)
  if (!m) return null
  const start = source.indexOf('{', m.index)
  const end = source.indexOf('}', start)
  return start < 0 || end < 0 ? null : source.slice(start + 1, end)
}

/** 解析 `--name: value;` 声明（值里可能含 `;`（如 color-mix…无），按行切足够）。 */
function parseVars(body) {
  const out = {}
  for (const line of (body || '').split('\n')) {
    const m = /^\s*(--[\w-]+)\s*:\s*(.+?);\s*$/.exec(line)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

const light = parseVars(ruleBody(css, /^:root\s*\{/m))
const dark = parseVars(ruleBody(css, /^:root\[data-theme="dark"\]\s*\{/m))
const palettes = { light, dark }

// --- [1] 两套调色板对等 ------------------------------------------------------
console.log('\n[1] 两套调色板：变量名必须完全对等')
{
  ok(':root 解析出调色板（浅色，默认）', Object.keys(light).length > 10, `${Object.keys(light).length} 个变量`)
  ok(':root[data-theme="dark"] 解析出调色板', Object.keys(dark).length > 10, `${Object.keys(dark).length} 个变量`)
  const onlyLight = Object.keys(light).filter((k) => !(k in dark))
  const onlyDark = Object.keys(dark).filter((k) => !(k in light))
  eq('浅色独有的变量', onlyLight.join(',') || '（无）', '（无）')
  eq('深色独有的变量', onlyDark.join(',') || '（无）', '（无）')
  // color-scheme 决定原生控件（下拉/滚动条/复选框）的配色，必须两套都给
  ok('两套都声明了 color-scheme', /color-scheme:\s*light/.test(css) && /color-scheme:\s*dark/.test(css))
}

// --- [2] 调色板之外零颜色字面量 ----------------------------------------------
console.log('\n[2] 调色板之外不得出现颜色字面量')
{
  // 抠掉两个调色板块后再找色值：色值只允许出现在调色板里
  const withoutPalettes = css
    .replace(/\{[\s\S]*?\}/g, (block) => '')
  // 上面的粗暴替换会把所有规则体都删掉，包括调色板——这正是我们要的「只剩选择器壳」
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g
  const hits = withoutPalettes.match(LITERAL) || []
  eq('调色板之外的颜色字面量', hits.join(',') || '（无）', '（无）')

  // 反过来确认调色板**里面**确实有颜色（否则上面的检查会因为整块被误删而假通过）
  const paletteValues = [...Object.values(light), ...Object.values(dark)].join(' ')
  ok('调色板内确实含色值（防止检查假通过）', /#[0-9a-fA-F]{3,8}\b/.test(paletteValues))

  // app.js 也不该写死颜色（它的自绘模态曾经是白底，深色主题下会跳出一块白板）
  const jsHits = js.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || []
  eq('app.js 里的颜色字面量', jsHits.join(',') || '（无）', '（无）')
}

// --- [3] 用到的 var() 都定义了 -----------------------------------------------
console.log('\n[3] 每个 var(--x) 都要在两套调色板里定义')
{
  const used = new Set()
  const re = /var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g
  let m
  while ((m = re.exec(css)) !== null) used.add(m[1])
  const missing = [...used].filter((name) => !(name in light) || !(name in dark))
  eq('未定义的变量', missing.join(',') || '（无）', '（无）')
  ok('样式表确实在用变量', used.size >= 15, `用了 ${used.size} 个`)

  // 调色板内部也不该引用外部变量（除同块内互相派生，如 --lane-bg 用 --panel）
  const unresolved = []
  for (const [name, palette] of Object.entries(palettes)) {
    for (const [key, value] of Object.entries(palette)) {
      const refs = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((x) => x[1])
      for (const ref of refs) if (!(ref in palette)) unresolved.push(`${name}:${key} → ${ref}`)
    }
  }
  eq('调色板内引用到未定义变量', unresolved.join(',') || '（无）', '（无）')
}

// --- [4] 首屏时序：主题脚本必须在样式表之前 ----------------------------------
console.log('\n[4] 首屏时序：先定主题，再上样式表（否则会闪一下另一种底色）')
{
  const themeScriptAt = html.indexOf('data-theme')
  const cssLinkAt = html.indexOf('app.css?v=')
  ok('index.html 里存在主题脚本', themeScriptAt > 0)
  ok('样式表链接存在', cssLinkAt > 0)
  ok('主题脚本在样式表之前', themeScriptAt > 0 && cssLinkAt > 0 && themeScriptAt < cssLinkAt, `script@${themeScriptAt} link@${cssLinkAt}`)
  ok('主题取自 ?theme= 参数', /URLSearchParams\(location\.search\)\.get\('theme'\)/.test(html))
  ok('没有 ?theme= 时回落 prefers-color-scheme', /prefers-color-scheme:\s*dark/.test(html))
  ok('只接受 light/dark 两种取值', /t !== 'light' && t !== 'dark'/.test(html))
  ok('样式表与脚本都带缓存版本号', /app\.css\?v=\d+/.test(html) && /app\.js\?v=\d+/.test(html))
}

// --- [5] 运行时跟随：message 监听要早于数据加载 ------------------------------
console.log('\n[5] 运行时跟随：宿主切主题 → postMessage → 画布换色')
{
  const listenerAt = js.indexOf("addEventListener('message'")
  const loadAt = js.lastIndexOf('load()')
  ok('app.js 注册了 message 监听', listenerAt > 0)
  ok('监听注册在数据加载之前（加载失败也要能跟随主题）', listenerAt > 0 && listenerAt < loadAt, `listen@${listenerAt} load@${loadAt}`)
  ok('校验同源', /e\.origin !== window\.location\.origin/.test(js))
  ok('校验 channel + type（和 ask-ai 消息区分开）', /d\.channel === THEME_CHANNEL && d\.type === 'theme'/.test(js))
  ok('只接受 light/dark（非法值不写进 DOM）', /t !== 'light' && t !== 'dark'/.test(js))
  ok('系统配色变化时也跟随（宿主没给 ?theme= 时）', /mq\.addEventListener\('change'/.test(js))
}

// --- [6] WCAG 对比度（两套调色板 × 关键配对） --------------------------------
console.log('\n[6] 对比度：两套调色板的关键「字/底」配对都要达 WCAG AA')

const toRgb = (hex) => {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) }
}
/** 把 CSS 值解析成 {r,g,b,a}：支持 #hex / var(--x) / color-mix(in srgb, X N%, transparent) / transparent。 */
function resolveCss(expr, palette) {
  const value = String(expr).trim()
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const v = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)
  if (v) {
    if (!(v[1] in palette)) throw new Error(`未定义变量 ${v[1]}`)
    return resolveCss(palette[v[1]], palette)
  }
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/.exec(value)
  if (mix) {
    const inner = resolveCss(mix[1], palette)
    return { ...inner, a: Number(mix[2]) / 100 }
  }
  if (/^#[0-9a-fA-F]{3,8}$/.test(value)) return { ...toRgb(value), a: 1 }
  throw new Error(`不认识的色值: ${value}`)
}
const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
})
const lum = (c) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}
const ratio = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}
/** 字色（可能带 alpha）叠在底色（可能带 alpha，最终叠在页面底）上算比值。 */
function contrastOf(fgExpr, bgExpr, palette, pageBase = 'var(--bg)') {
  const base = over(resolveCss(bgExpr, palette), resolveCss(pageBase, palette))
  const fg = over(resolveCss(fgExpr, palette), base)
  return ratio(fg, base)
}

// [说明, 字色, 底色]：与 studio/app.css 里的实际用法一一对应
const PAIRS = [
  ['正文/面板', 'var(--text)', 'var(--panel)'],
  ['正文/页面底', 'var(--text)', 'var(--bg)'],
  ['次要字/面板', 'var(--muted)', 'var(--panel)'],
  ['次要字/页面底', 'var(--muted)', 'var(--bg)'],
  ['次要字/次级面（按钮、chip）', 'var(--muted)', 'var(--panel-2)'],
  ['正文/次级面（按钮、输入框）', 'var(--text)', 'var(--panel-2)'],
  ['强调字（分组标题）/页面底', 'var(--accent)', 'var(--bg)'],
  ['强调字（分组标题）/面板', 'var(--accent)', 'var(--panel)'],
  ['顶栏主按钮字/其渐变底（起点）', 'var(--accent-ink)', 'color-mix(in srgb, var(--accent) 22%, transparent)'],
  ['顶栏主按钮字/其渐变底（终点）', 'var(--accent-ink)', 'color-mix(in srgb, var(--accent-2) 16%, transparent)'],
  ['主按钮 hover 字/渐变底（起点）', 'var(--on-accent)', 'color-mix(in srgb, var(--accent) 22%, transparent)'],
  ['ready chip 字/其底色', 'var(--ok)', 'color-mix(in srgb, var(--ok) 12%, transparent)'],
  ['failed chip 字/其底色', 'var(--danger)', 'color-mix(in srgb, var(--danger) 12%, transparent)'],
  ['pending chip 字/其底色', 'var(--warn)', 'color-mix(in srgb, var(--warn) 12%, transparent)'],
  ['作废 chip 字/其底色', 'var(--warn)', 'color-mix(in srgb, var(--warn) 14%, transparent)'],
  ['「跟随最新」开启态字/按钮底', 'var(--ok)', 'var(--panel-2)'],
  ['角色 tag 字/卡片底', 'var(--tag-character)', 'var(--panel-2)'],
  ['场景 tag 字/卡片底', 'var(--tag-scene)', 'var(--panel-2)'],
  ['风格 tag 字/卡片底', 'var(--tag-style)', 'var(--panel-2)'],
  ['报错行/面板', 'var(--danger)', 'var(--panel)'],
  ['收纳区标题/收纳区底', 'var(--muted)', 'color-mix(in srgb, var(--panel-2) 55%, transparent)'],
  ['表头字/表头底', 'var(--muted)', 'var(--panel-2)'],
]

for (const [themeName, palette] of Object.entries(palettes)) {
  const bad = []
  for (const [label, fg, bg] of PAIRS) {
    let r
    try { r = contrastOf(fg, bg, palette) } catch (e) { bad.push(`${label}: ${e.message}`); continue }
    if (r < 4.5) bad.push(`${label} = ${r.toFixed(2)}`)
  }
  eq(`「${themeName}」全部配对达 AA(4.5:1)`, bad.join('；') || '（全部达标）', '（全部达标）')

  // 边框/分隔线不适用 AA（它是 1px 线不是文字），但也不能和底色糊在一起看不见。
  // 1.2:1 是「能看出有一条线」的经验下限。
  const faint = []
  for (const [label, fg, bg] of [
    ['卡片边框/卡片底', 'var(--border)', 'var(--panel)'],
    ['卡片边框/页面底', 'var(--border)', 'var(--bg)'],
    ['次级面边框/次级面底', 'var(--border)', 'var(--panel-2)'],
  ]) {
    let r
    try { r = contrastOf(fg, bg, palette) } catch (e) { faint.push(`${label}: ${e.message}`); continue }
    if (r < 1.2) faint.push(`${label} = ${r.toFixed(2)}`)
  }
  eq(`「${themeName}」边框与底色可分（≥1.2:1）`, faint.join('；') || '（全部可分）', '（全部可分）')
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
