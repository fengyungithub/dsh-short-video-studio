/**
 * scripts/lib/ui-probe.mjs — UI 走查共用：宿主主题变量 + 浏览器内度量脚本。
 *
 * 为什么必须有主题变量：插件在真机上跑在 DSH 的两套主题里。早期走查用白底页面，
 * 结果「深色主题下控件白底浅字」这类问题在预览里完全看不见。这里把 DSH 真实色板
 * 注入预览页面，并附带对比度（WCAG）计算，让「看不清内容」成为可量化判据。
 *
 * 色值取自 DSH 静态色板（--dsw-static-neutral-bluish-* / red-*）。
 */

export const THEMES = {
  dark: {
    '--dsw-alias-bg-base': '#151517',
    '--dsw-alias-bg-layer-1': '#232324',
    '--dsw-alias-label-primary': '#f9fafb',
    '--dsw-alias-label-secondary': '#cfd3d6',
    '--dsw-alias-label-caption': '#adb2b8',
    '--dsw-alias-border-l1': '#ffffff0f',
    '--dsw-alias-border-l2': '#ffffff1f',
    '--dsw-alias-interactive-bg-hover': '#ffffff14',
    '--dsw-alias-state-error-primary': '#f25a5a',
    '--dsw-alias-state-business-primary': '#5b8cff',
  },
  light: {
    '--dsw-alias-bg-base': '#ffffff',
    '--dsw-alias-bg-layer-1': '#ffffff',
    '--dsw-alias-label-primary': '#0f1115',
    '--dsw-alias-label-secondary': '#61666b',
    '--dsw-alias-label-caption': '#81858c',
    '--dsw-alias-border-l1': '#0000000a',
    '--dsw-alias-border-l2': '#0000001a',
    '--dsw-alias-interactive-bg-hover': '#2631480f',
    '--dsw-alias-state-error-primary': '#ec1313',
    '--dsw-alias-state-business-primary': '#4d6bfe',
  },
}

/** 生成 `:root{...}` 主题变量声明。 */
export const themeCss = (name = 'dark') =>
  ':root{' + Object.entries(THEMES[name] || THEMES.dark).map(([k, v]) => `${k}:${v}`).join(';') + '}'

/**
 * 度量代码（字符串）：先 page.evaluate(PROBE_CONTRAST) 注入，之后用
 * `globalThis.__uiProbe.lowContrast(root)` 调用（也便于单独调试中间值）。
 * 提供 lowContrast(target)：把元素自身与祖先的半透明背景层层合成后算 WCAG 对比度，
 * 返回不达标的清单（普通文本 4.5:1，≥18px 大字号 3:1）。
 */
export const PROBE_CONTRAST = `
  const parseColor = (c) => {
    const s = String(c)
    // color-mix() 在计算样式里会被解析成 color(srgb r g b / a)，通道值是 **0–1**（不是 0–255）。
    // 不单独处理的话会被下面的 rgb() 正则顺手匹配到 "srgb(" 上，把 0.05 当成 5/255 读，
    // 半透明底色就静默算错了。
    const cm = s.match(/^color\\(srgb\\s+([\\d.eE+-]+)\\s+([\\d.eE+-]+)\\s+([\\d.eE+-]+)(?:\\s*\\/\\s*([\\d.eE+-]+))?\\)$/)
    if (cm) {
      const ch = (v) => Math.max(0, Math.min(255, Number(v) * 255))
      return { r: ch(cm[1]), g: ch(cm[2]), b: ch(cm[3]), a: cm[4] === undefined ? 1 : Number(cm[4]) }
    }
    const m = s.match(/rgba?\\(([^)]+)\\)/)
    if (!m) return null
    const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number)
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  const blend = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 })
  // 取元素背后真实可见的底色：收集自身到祖先的**所有**非透明背景，再从最底层
  // （不透明那层，没有就当作白底）往上逐层合成。逐层向上时若把下层当不透明，
  // 半透明叠加会被算成浅色，进而把深色主题下的高对比误判为低对比。
  const effectiveBg = (el) => {
    const stack = []
    for (let n = el; n; n = n.parentElement) {
      const c = parseColor(getComputedStyle(n).backgroundColor)
      if (!c || c.a === 0) continue
      stack.push(c)
      if (c.a === 1) break
    }
    let acc = stack.length && stack[stack.length - 1].a === 1
      ? stack.pop()
      : { r: 255, g: 255, b: 255, a: 1 }
    while (stack.length) acc = blend(stack.pop(), acc)
    return acc
  }
  const relLum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
  }
  const contrastOf = (a, b) => { const l1 = relLum(a), l2 = relLum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) }
  const lowContrast = (root) => {
    const out = []
    for (const el of root.querySelectorAll('input:not([type=radio]):not([type=checkbox]),select,textarea,button,strong,span,p,h3,h4,label')) {
      const isField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)
      const txt = isField ? (el.value || el.placeholder || '') : (el.textContent || '').trim()
      if (!txt) continue
      const cs = getComputedStyle(el)
      const fg = parseColor(cs.color)
      if (!fg) continue
      const bg = effectiveBg(el)
      const ratio = contrastOf(blend(fg, bg), bg)
      const min = parseFloat(cs.fontSize) >= 18 ? 3 : 4.5
      if (ratio < min) out.push(\`\${el.tagName.toLowerCase()}\${el.className ? '.' + el.className : ''} "\${String(txt).slice(0, 22)}" 对比度 \${ratio.toFixed(2)} < \${min}\`)
    }
    return out
  }
  globalThis.__uiProbe = { parseColor, effectiveBg, contrastOf, lowContrast }
`
