/**
 * scripts/lib/react-shim.mjs — 离屏渲染 lib/client.js 的最小 React 垫片（测试/预览共用）。
 *
 * 用途：不启浏览器也能「真跑」插件客户端组件（组件函数 + hooks + 元素树），
 * 并把元素树序列化成静态 HTML 供 puppeteer 截图（scripts/preview-settings.mjs）。
 * 只实现插件的客户端用到的能力：createElement / useState / useEffect / useRef /
 * useCallback / useMemo / Fragment。
 */

let hooks = []
let hi = 0
let dirty = false

export const React = {
  createElement: (type, props, ...children) => ({
    __el: true, type, props: { ...(props || {}), children: children.length > 1 ? children : children[0] },
  }),
  Fragment: 'Fragment',
  useState: (init) => {
    const i = hi++
    if (!(i in hooks)) hooks[i] = typeof init === 'function' ? init() : init
    return [hooks[i], (v) => {
      const nv = typeof v === 'function' ? v(hooks[i]) : v
      if (nv !== hooks[i]) { hooks[i] = nv; dirty = true }
    }]
  },
  useRef: (v) => ({ current: v }),
  useCallback: (f) => f,
  useMemo: (f) => f(),
  // 副作用只跑一次（key 由调用位次决定），fetch 的 .then 会在 renderStable 的 await 里落地
  useEffect: (fn) => { const i = 'e' + hi++; if (!(i in hooks)) { hooks[i] = true; fn() } },
}

/** 重置 hooks（换组件渲染前调用，避免位次串台）。 */
export function resetHooks() { hooks = []; hi = 0; dirty = false }

/** 渲染组件直到状态稳定（最多 20 轮，每轮让微任务/promise 落地）。 */
export async function renderStable(Component, props) {
  for (let i = 0; i < 20; i++) {
    hi = 0
    dirty = false
    const out = Component(props)          // 抛异常＝渲染崩溃，直接冒泡
    await new Promise((r) => setImmediate(r))
    if (!dirty) return out
  }
  throw new Error('渲染未收敛（状态一直变化）')
}

/** 在元素树里按条件查找所有节点。 */
export function findAll(node, pred, acc = []) {
  if (!node || typeof node !== 'object') return acc
  if (Array.isArray(node)) { node.forEach((n) => findAll(n, pred, acc)); return acc }
  if (node.__el) {
    if (pred(node)) acc.push(node)
    findAll(node.props && node.props.children, pred, acc)
  }
  return acc
}

/** 元素树里的全部文本（调试与断言用）。 */
export function textOf(tree) {
  const out = []
  const walk = (n) => {
    if (n === null || n === undefined || n === false || n === true) return
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return }
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (n.__el) walk(n.props && n.props.children)
  }
  walk(tree)
  return out.join(' | ')
}

// --- 元素树 → 静态 HTML（供 puppeteer 截图）---------------------------------

const UNITLESS = new Set([
  'flex', 'flexGrow', 'flexShrink', 'fontWeight', 'lineHeight', 'opacity', 'zIndex',
  'order', 'gridColumn', 'gridRow', 'columnCount',
])
const kebab = (k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function styleToCss(style) {
  if (!style) return ''
  return Object.entries(style).map(([k, v]) => {
    if (v === null || v === undefined) return ''
    const val = typeof v === 'number' && !UNITLESS.has(k) ? v + 'px' : String(v)
    return `${kebab(k)}:${val}`
  }).filter(Boolean).join(';')
}

// value 必须序列化：漏掉它会让截图里所有输入框显示为空（会掩盖真实的文字颜色问题）
const ATTRS = ['type', 'value', 'placeholder', 'rows', 'cols', 'title', 'disabled', 'readOnly', 'colSpan', 'rowSpan', 'id', 'htmlFor']
const VOID = new Set(['input', 'br', 'hr', 'img'])

/**
 * 序列化元素树。select 需要特殊处理：HTML 里 select 的 value 属性不生效，
 * 必须把 selected 打到匹配的 option 上（radio 用 checked 属性即可生效）。
 */
export function toHtml(node, selectValue) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map((n) => toHtml(n, selectValue)).join('')
  if (!node.__el) return ''
  const { type, props = {} } = node
  if (typeof type === 'function') return toHtml(type(props), selectValue) // 内联函数组件
  const attrs = []
  const css = styleToCss(props.style)
  if (css) attrs.push(`style="${css}"`)
  if (props.className) attrs.push(`class="${esc(props.className)}"`)
  for (const a of ATTRS) {
    if (props[a] === undefined || props[a] === null || props[a] === false) continue
    if (a === 'readOnly' && props.readOnly !== true) continue
    attrs.push(props[a] === true ? a : `${kebab(a)}="${esc(props[a])}"`)
  }
  if (type === 'input' && props.checked) attrs.push('checked')
  if (type === 'select') {
    const v = props.value === undefined ? selectValue : props.value
    if (v !== undefined && v !== null) attrs.push(`data-value="${esc(v)}"`)
  }
  if (type === 'option') {
    attrs.push(`value="${esc(props.value === undefined ? '' : props.value)}"`)
    if (selectValue !== undefined && String(props.value) === String(selectValue)) attrs.push('selected')
  }
  const open = `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  if (VOID.has(type)) return open
  // textarea 的 value 是内容而非属性
  if (type === 'textarea') return `${open}${esc(props.value === undefined || props.value === null ? '' : props.value)}</textarea>`
  // option 文本直接输出（避免多余空白）
  const kids = type === 'option'
    ? esc(String(props.children ?? ''))
    : (type === 'select'
        ? (Array.isArray(props.children) ? props.children : [props.children]).map((c) => toHtml(c, props.value)).join('')
        : toHtml(props.children, undefined))
  return `${open}${kids}</${type}>`
}
