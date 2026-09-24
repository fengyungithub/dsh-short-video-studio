/**
 * 轻量 markdown → HTML 渲染器（零依赖、纯函数、双端共享）。
 *
 * 服务端（lib/index.js → PDF 导出）与浏览器画布（studio/app.js → text 节点预览）
 * 共用同一实现，保证两端渲染一致。只覆盖流程内容域语法：
 * 标题（h1-h6）/ 表格（含分隔行剔除、混合内容）/ 有序无序列表 / 引用 / 代码块 /
 * 段落（连续行合并）/ 粗体 / 斜体 / 行内代码；不做嵌套列表、链接、图片、脚注。
 *
 * 安全：先转义 HTML 再解析行内格式，原始 HTML 不会注入。
 * 表格输出带 class="node-table"：画布 CSS 用类选择器，PDF 端 CSS 用元素选择器（均匹配）。
 */

/** 转义 HTML 特殊字符（防注入）。 */
export function escapeHtmlText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 行内格式：粗体 / 斜体 / 行内代码（入参已转义）。 */
export function inlineFormat(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

/** markdown → HTML 正文（标题/表格/列表/引用/代码块/段落）。 */
export function markdownToHtml(content) {
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let codeBuf = null
  let i = 0
  const flushCode = () => {
    if (codeBuf !== null) {
      out.push('<pre><code>' + escapeHtmlText(codeBuf.join('\n')) + '</code></pre>')
      codeBuf = null
    }
  }
  const collect = (pred) => {
    const rows = []
    while (i < lines.length && pred(lines[i])) rows.push(lines[i++])
    return rows
  }
  const isTableRow = (l) => l.trim().startsWith('|') && l.trim().endsWith('|')
  const isListItem = (l) => /^([-*+]|\d+[.)])\s+/.test(l.trim())
  const isQuote = (l) => /^>\s?/.test(l.trim())
  const isHeading = (l) => /^(#{1,6})\s+/.test(l.trim())

  while (i < lines.length) {
    const raw = lines[i]
    const t = raw.trim()
    if (codeBuf !== null) {
      if (t.startsWith('```')) flushCode()
      else codeBuf.push(raw)
      i++
      continue
    }
    if (t.startsWith('```')) { flushCode(); codeBuf = []; i++; continue }
    if (t === '') { i++; continue }

    const h = /^(#{1,6})\s+(.*)$/.exec(t)
    if (h) {
      flushCode()
      const lvl = h[1].length
      out.push(`<h${lvl}>${inlineFormat(escapeHtmlText(h[2]))}</h${lvl}>`)
      i++
      continue
    }

    if (isTableRow(t)) {
      flushCode()
      const rows = collect(isTableRow)
      const parsed = rows.map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
      // 剔除分隔行（|---|）
      const body = parsed.filter((r) => !(r.length === 1 && /^[\s|:-]+$/.test(r[0]) && r[0].includes('-')))
      if (body.length) {
        const [head, ...rest] = body
        let html = '<table class="node-table"><thead><tr>' + head.map((c) => '<th>' + inlineFormat(escapeHtmlText(c)) + '</th>').join('') + '</tr></thead>'
        if (rest.length) html += '<tbody>' + rest.map((r) => '<tr>' + r.map((c) => '<td>' + inlineFormat(escapeHtmlText(c)) + '</td>').join('') + '</tr>').join('') + '</tbody>'
        out.push(html + '</table>')
      }
      continue
    }

    if (isQuote(t)) {
      flushCode()
      const rows = collect(isQuote)
      out.push('<blockquote>' + rows.map((l) => '<p>' + inlineFormat(escapeHtmlText(l.trim().replace(/^>\s?/, ''))) + '</p>').join('') + '</blockquote>')
      continue
    }

    if (isListItem(t)) {
      flushCode()
      const ordered = /^\d+/.test(t)
      const items = collect(isListItem)
      const tag = ordered ? 'ol' : 'ul'
      out.push('<' + tag + '>' + items.map((l) => '<li>' + inlineFormat(escapeHtmlText(l.trim().replace(/^([-*+]|\d+[.)])\s+/, ''))) + '</li>').join('') + '</' + tag + '>')
      continue
    }

    // 普通段落（合并连续普通行）
    flushCode()
    const paras = collect((l) => {
      const tt = l.trim()
      return tt !== '' && !tt.startsWith('```') && !isHeading(tt) && !isTableRow(tt) && !isQuote(tt) && !isListItem(tt)
    })
    out.push('<p>' + paras.map((l) => inlineFormat(escapeHtmlText(l))).join('<br>') + '</p>')
  }
  flushCode()
  return out.join('\n')
}
