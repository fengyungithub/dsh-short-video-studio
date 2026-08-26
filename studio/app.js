(function () {
  'use strict'

  const ROUTE_ROOT = '/dsh-short-video-studio'
  const TOKEN = window.__DSH_SVS_TOKEN__ || ''
  const params = new URLSearchParams(window.location.search)
  const sessionId = params.get('sessionId') || ''
  const workspaceId = params.get('workspaceId') || ''

  const GROUP_ORDER = [
    'story planning',
    'character cards',
    'scene cards',
    'shot table',
    'text storyboards',
    'shot clips',
    'final delivery',
  ]

  const el = {
    canvas: document.getElementById('canvas'),
    meta: document.getElementById('meta'),
    refresh: document.getElementById('refresh'),
  }

  function apiUrl(action) {
    const u = new URLSearchParams({ sessionId, workspaceId })
    return ROUTE_ROOT + '/api' + action + '?' + u.toString()
  }

  async function api(action, init) {
    const res = await fetch(apiUrl(action), {
      ...init,
      headers: { 'content-type': 'application/json', 'x-dsh-svs-token': TOKEN, ...(init?.headers || {}) },
    })
    if (!res.ok) {
      let msg = res.status
      try { msg = (await res.json()).message || msg } catch {}
      throw new Error(msg)
    }
    return res.json()
  }

  function mediaUrl(media) {
    const u = new URLSearchParams({ token: TOKEN, sessionId, workspaceId, path: media })
    return ROUTE_ROOT + '/media?' + u.toString()
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  }

  function renderMarkdownTable(content) {
    const lines = content.split('\n')
    const tableLines = lines.filter((l) => l.trim().startsWith('|') && l.trim().endsWith('|'))
    if (tableLines.length < 2) return null
    const parse = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
    const header = parse(tableLines[0])
    const body = tableLines.slice(2).filter((l) => l.trim().startsWith('|'))
    if (body.length === 0) return null
    let html = '<table class="node-table"><thead><tr>'
    for (const h of header) html += '<th>' + escapeHtml(h) + '</th>'
    html += '</tr></thead><tbody>'
    for (const line of body) {
      const cells = parse(line)
      html += '<tr>'
      for (let i = 0; i < header.length; i++) html += '<td>' + escapeHtml(cells[i] ?? '') + '</td>'
      html += '</tr>'
    }
    html += '</tbody></table>'
    return html
  }

  function renderTextContent(content) {
    const table = renderMarkdownTable(content)
    if (table) return table
    return '<div class="text-content">' + escapeHtml(content) + '</div>'
  }

  function groupTitle(group) {
    const map = {
      'story planning': '故事规划',
      'character cards': '角色卡',
      'scene cards': '场景卡',
      'shot table': '镜头表',
      'text storyboards': '文本分镜',
      'shot clips': '镜头片段',
      'final delivery': '最终交付',
    }
    return map[group] || group
  }

  function askAi(text) {
    window.parent.postMessage({ channel: 'dsh-short-video-studio', type: 'ask-ai', text }, window.location.origin)
  }

  function paramsSummary(node) {
    if (!node.params || typeof node.params !== 'object') return ''
    const keys = ['model', 'seed', 'width', 'height', 'length', 'steps', 'guidance']
    const parts = keys.filter((k) => node.params[k] !== undefined && node.params[k] !== null)
      .map((k) => k + '=' + node.params[k])
    return parts.join(' · ')
  }

  function nodeCard(node) {
    const card = document.createElement('div')
    card.className = 'node'
    card.dataset.nodeId = node.id

    const head = document.createElement('div')
    head.className = 'node-head'
    const kind = document.createElement('span')
    kind.className = 'node-kind'
    kind.textContent = node.kind || 'text'
    const title = document.createElement('div')
    title.className = 'node-title'
    title.textContent = node.title || '(无标题)'
    const status = document.createElement('span')
    status.className = 'status ' + (node.status || 'ready')
    status.textContent = node.status || 'ready'
    const id = document.createElement('span')
    id.className = 'node-id'
    id.textContent = (node.id || '').slice(0, 8)
    head.appendChild(kind)
    head.appendChild(title)
    head.appendChild(status)
    head.appendChild(id)
    card.appendChild(head)

    const body = document.createElement('div')
    body.className = 'node-body'

    if (node.media) {
      if (node.kind === 'video') {
        const v = document.createElement('video')
        v.className = 'media'
        v.controls = true
        v.src = mediaUrl(node.media)
        body.appendChild(v)
      } else if (node.kind === 'image') {
        const a = document.createElement('a')
        a.href = mediaUrl(node.media)
        a.target = '_blank'
        const img = document.createElement('img')
        img.className = 'media'
        img.src = mediaUrl(node.media)
        img.alt = node.title || ''
        a.appendChild(img)
        body.appendChild(a)
      } else {
        // audio / fallback：给下载链接
        const a = document.createElement('a')
        a.href = mediaUrl(node.media)
        a.target = '_blank'
        a.textContent = '下载媒体'
        body.appendChild(a)
      }
    }

    if (node.content) {
      const contentWrap = document.createElement('div')
      contentWrap.innerHTML = renderTextContent(node.content)
      body.appendChild(contentWrap)
    }

    if (node.error) {
      const err = document.createElement('div')
      err.className = 'error-line'
      err.textContent = '错误: ' + node.error
      body.appendChild(err)
    }

    const ps = paramsSummary(node)
    if (ps) {
      const p = document.createElement('div')
      p.className = 'params'
      p.textContent = ps
      body.appendChild(p)
    }

    card.appendChild(body)

    // actions
    const actions = document.createElement('div')
    actions.className = 'node-actions'

    if (node.kind === 'text' || node.kind === 'table') {
      const editBtn = document.createElement('button')
      editBtn.className = 'btn'
      editBtn.textContent = '编辑'
      editBtn.onclick = () => startEdit(node, card, body)
      actions.appendChild(editBtn)
    }

    const redoBtn = document.createElement('button')
    redoBtn.className = 'btn'
    redoBtn.textContent = '重做'
    redoBtn.onclick = () => askAi('重做画布节点 ' + (node.id || '') + '（' + (node.title || node.kind) + '）：请按画布当前参数重新生成/重写该节点。')
    actions.appendChild(redoBtn)

    if (node.kind === 'image') {
      const regBtn = document.createElement('button')
      regBtn.className = 'btn'
      if (node.params && node.params.assetId) {
        regBtn.textContent = '已入库'
        regBtn.title = node.params.assetId
        regBtn.disabled = true
      } else {
        regBtn.textContent = '入库'
        regBtn.title = '一键登记为跨会话资产（角色卡/场景卡）'
        regBtn.onclick = () => registerAssetToLibrary(node)
      }
      actions.appendChild(regBtn)
    }

    const groupSel = document.createElement('select')
    groupSel.title = '分组'
    for (const g of GROUP_ORDER) {
      const opt = document.createElement('option')
      opt.value = g
      opt.textContent = groupTitle(g)
      if (node.group === g) opt.selected = true
      groupSel.appendChild(opt)
    }
    if (node.group && !GROUP_ORDER.includes(node.group)) {
      const opt = document.createElement('option')
      opt.value = node.group
      opt.textContent = node.group
      opt.selected = true
      groupSel.appendChild(opt)
    }
    groupSel.onchange = () => updateNode(node.id, { group: groupSel.value })
    actions.appendChild(groupSel)

    const up = document.createElement('button')
    up.className = 'btn'
    up.textContent = '↑'
    up.title = '上移'
    up.onclick = () => moveNode(node.id, -1)
    actions.appendChild(up)
    const down = document.createElement('button')
    down.className = 'btn'
    down.textContent = '↓'
    down.title = '下移'
    down.onclick = () => moveNode(node.id, 1)
    actions.appendChild(down)

    const del = document.createElement('button')
    del.className = 'btn'
    del.textContent = '删除'
    del.onclick = async () => {
      if (!confirm('删除节点 ' + (node.title || node.id) + '？')) return
      await api('/canvas/node?id=' + encodeURIComponent(node.id), { method: 'DELETE' })
      await load()
    }
    actions.appendChild(del)

    card.appendChild(actions)
    return card
  }

  function startEdit(node, card, body) {
    const ta = document.createElement('textarea')
    ta.className = 'edit'
    ta.value = node.content || ''
    body.innerHTML = ''
    body.appendChild(ta)
    ta.focus()

    const save = async () => {
      const content = ta.value
      await updateNode(node.id, { content })
      await load()
    }
    ta.addEventListener('blur', save)
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save() }
      if (e.key === 'Escape') { load() }
    })
  }

  async function updateNode(id, patch) {
    const body = { id, ...patch }
    await api('/canvas/node', { method: 'POST', body: JSON.stringify(body) })
  }

  async function registerAssetToLibrary(node) {
    let type = 'character'
    if (node.group === 'scene cards') type = 'scene'
    else if (node.group === 'character cards') type = 'character'
    const name = prompt('资产名（小写英文/拼音，如 luna）', slugify(node.title || ''))
    if (!name) return
    try {
      const d = await api('/assets', { method: 'POST', body: JSON.stringify({ nodeId: node.id, type, name }) })
      if (d && d.ok) {
        await updateNode(node.id, { params: { ...(node.params || {}), assetId: d.id } })
        alert('已入库: ' + d.id)
        await load()
      } else {
        alert('入库失败: ' + ((d && d.error) || ''))
      }
    } catch (e) {
      alert('入库失败: ' + (e.message || String(e)))
    }
  }

  async function moveNode(id, delta) {
    const project = await api('/canvas')
    const nodes = [...project.nodes].sort((a, b) => (a.order || 0) - (b.order || 0))
    const idx = nodes.findIndex((n) => n.id === id)
    if (idx < 0) return
    const target = idx + delta
    if (target < 0 || target >= nodes.length) return
    ;[nodes[idx], nodes[target]] = [nodes[target], nodes[idx]]
    await api('/canvas/reorder', { method: 'POST', body: JSON.stringify({ nodeIds: nodes.map((n) => n.id) }) })
    await load()
  }

  function render(project) {
    el.canvas.innerHTML = ''
    el.meta.textContent = '画幅 ' + (project.settings?.aspectRatio || '16:9')
      + (project.settings?.duration ? ' · 时长 ' + project.settings.duration : '')
      + ' · 音频 ' + (project.settings?.audioMode || 'silent')
      + ' · 模式 ' + (project.settings?.mode || 'quality')
      + ' · 节点 ' + (project.nodes || []).length

    const nodes = [...(project.nodes || [])].sort((a, b) => (a.order || 0) - (b.order || 0))
    if (nodes.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.innerHTML = '<h2>画布为空</h2><p>在对话里让 Agent 走短剧流水线（Step 0→9），各步骤产物会落到这里。</p><p>快速开始：<code>把「一只想当宇航员的小狐狸」做成 30 秒静音 3D 动画短片</code></p>'
      el.canvas.appendChild(empty)
      return
    }

    const groups = new Map()
    for (const g of GROUP_ORDER) groups.set(g, [])
    for (const n of nodes) {
      const g = n.group || 'story planning'
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g).push(n)
    }

    for (const [group, groupNodes] of groups) {
      if (groupNodes.length === 0) continue
      const section = document.createElement('section')
      section.className = 'group'
      const h = document.createElement('h2')
      h.className = 'group-title'
      h.textContent = groupTitle(group) + ' · ' + groupNodes.length
      section.appendChild(h)
      for (const n of groupNodes) section.appendChild(nodeCard(n))
      el.canvas.appendChild(section)
    }
  }

  async function load() {
    el.refresh.disabled = true
    try {
      const project = await api('/canvas')
      render(project)
    } catch (err) {
      el.canvas.innerHTML = '<div class="empty"><h2>加载失败</h2><p class="error-line">' + escapeHtml(err.message || String(err)) + '</p></div>'
    } finally {
      el.refresh.disabled = false
    }
  }

  el.refresh.addEventListener('click', load)

  if (!sessionId) {
    el.canvas.innerHTML = '<div class="empty"><h2>缺少会话</h2><p>请从工作区打开本会话后重试。</p></div>'
  } else {
    load()
  }
})()
