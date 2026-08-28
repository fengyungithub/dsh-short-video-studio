import { markdownToHtml } from './markdown.js'

(function () {
  'use strict'

  const ROUTE_ROOT = '/dsh-short-video-studio'
  const TOKEN = window.__DSH_SVS_TOKEN__ || ''
  const params = new URLSearchParams(window.location.search)
  const sessionId = params.get('sessionId') || ''
  const workspaceId = params.get('workspaceId') || ''

  const DEFAULT_GROUP = 'ungrouped'

  // 当前项目里出现过的分组（settings.groupOrder + 节点实际分组），供分组输入框的候选列表用
  let knownGroups = []

  const el = {
    canvas: document.getElementById('canvas'),
    meta: document.getElementById('meta'),
    refresh: document.getElementById('refresh'),
  }

  function apiUrl(action) {
    // action 可能自带 query（如 '/canvas/node?id=…'），此时用 & 拼接，避免第二个 ? 把 sessionId 吞进参数值
    const u = new URLSearchParams({ sessionId, workspaceId })
    return ROUTE_ROOT + '/api' + action + (action.includes('?') ? '&' : '?') + u.toString()
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

  function renderTextContent(content) {
    // 完整 markdown 渲染（与 lib/index.js 共享 studio/markdown.js）：标题/表格/列表/引用/代码块/粗体等
    return '<div class="text-content">' + markdownToHtml(content) + '</div>'
  }

  // 分组名由流程 skill 自由定义，画布不做任何领域词汇映射，原样展示
  function groupTitle(group) {
    return group === DEFAULT_GROUP ? '未分组' : group
  }

  /** 分组输入框的候选列表（本项目已出现的分组），全页共享一个 datalist。 */
  function renderGroupDatalist() {
    let dl = document.getElementById('dsh-svs-groups')
    if (!dl) {
      dl = document.createElement('datalist')
      dl.id = 'dsh-svs-groups'
      document.body.appendChild(dl)
    }
    dl.innerHTML = ''
    for (const g of knownGroups) {
      const opt = document.createElement('option')
      opt.value = g
      dl.appendChild(opt)
    }
  }

  function askAi(text) {
    window.parent.postMessage({ channel: 'dsh-short-video-studio', type: 'ask-ai', text }, window.location.origin)
  }

  // ---- 页面内对话框（iframe 内原生 alert/confirm/prompt 可能被禁用，改用 DOM 自绘）----
  let _modalHost
  function ensureModalHost() {
    if (_modalHost && document.body.contains(_modalHost)) return _modalHost
    _modalHost = document.createElement('div')
    _modalHost.id = 'dsh-svs-modal'
    document.body.appendChild(_modalHost)
    return _modalHost
  }

  /** 自绘模态。opts = { okText, cancel }。resolve(true) 确认 / resolve(false) 取消。 */
  function modal(message, opts) {
    const o = opts || {}
    return new Promise((resolve) => {
      const host = ensureModalHost()
      host.innerHTML = ''
      host.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);z-index:9999;font-family:inherit'
      const box = document.createElement('div')
      box.style.cssText = 'background:#fff;color:#222;border-radius:10px;padding:18px 20px;min-width:280px;max-width:420px;box-shadow:0 10px 40px rgba(0,0,0,.25);font-size:14px'
      const p = document.createElement('p')
      p.style.cssText = 'margin:0 0 14px;white-space:pre-wrap;line-height:1.5;word-break:break-word'
      p.textContent = message
      box.appendChild(p)
      const actions = document.createElement('div')
      actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end'
      const close = (val) => { host.remove(); resolve(val) }
      if (o.cancel) {
        const no = document.createElement('button')
        no.className = 'btn'
        no.textContent = '取消'
        no.onclick = () => close(false)
        actions.appendChild(no)
      }
      const yes = document.createElement('button')
      yes.className = 'btn btn-primary'
      yes.textContent = o.okText || '确定'
      yes.onclick = () => close(true)
      actions.appendChild(yes)
      box.appendChild(actions)
      host.appendChild(box)
    })
  }

  const confirmBox = (message) => modal(message, { okText: '删除', cancel: true })
  const alertBox = (message) => modal(message, { okText: '知道了' })

  /** 入库表单：资产类型（下拉）+ 资产名（文本）。取消返回 null。 */
  function assetRegisterBox(defaultName) {
    return new Promise((resolve) => {
      const host = ensureModalHost()
      host.innerHTML = ''
      host.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);z-index:9999;font-family:inherit'
      const box = document.createElement('div')
      box.style.cssText = 'background:#fff;color:#222;border-radius:10px;padding:18px 20px;min-width:300px;max-width:420px;box-shadow:0 10px 40px rgba(0,0,0,.25);font-size:14px'
      const fieldCss = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:14px;margin-bottom:14px'
      const label = (t) => { const l = document.createElement('div'); l.style.cssText = 'margin-bottom:6px;color:#555'; l.textContent = t; return l }

      box.appendChild(label('资产类型'))
      const typeSel = document.createElement('select')
      typeSel.style.cssText = fieldCss
      for (const [v, t] of [['character', '角色 character'], ['scene', '场景 scene'], ['style', '风格锚点 style']]) {
        const o = document.createElement('option')
        o.value = v
        o.textContent = t
        typeSel.appendChild(o)
      }
      box.appendChild(typeSel)

      box.appendChild(label('资产名（小写英文/拼音，如 luna）'))
      const nameInput = document.createElement('input')
      nameInput.type = 'text'
      nameInput.value = String(defaultName || '')
      nameInput.style.cssText = fieldCss
      box.appendChild(nameInput)

      const actions = document.createElement('div')
      actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end'
      const close = (val) => { host.remove(); resolve(val) }
      const no = document.createElement('button')
      no.className = 'btn'
      no.textContent = '取消'
      no.onclick = () => close(null)
      actions.appendChild(no)
      const yes = document.createElement('button')
      yes.className = 'btn btn-primary'
      yes.textContent = '入库'
      yes.onclick = () => {
        const name = nameInput.value.trim()
        if (!name) { nameInput.focus(); return }
        close({ type: typeSel.value, name })
      }
      actions.appendChild(yes)
      box.appendChild(actions)
      host.appendChild(box)
      nameInput.focus()
      nameInput.select()
    })
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

    // 分组是自由字符串：用输入框 + datalist 候选（候选来自本项目已出现的分组），允许任意新分组名
    const groupInput = document.createElement('input')
    groupInput.type = 'text'
    groupInput.className = 'group-input'
    groupInput.title = '分组（可直接输入新分组名）'
    groupInput.setAttribute('list', 'dsh-svs-groups')
    groupInput.value = node.group || DEFAULT_GROUP
    groupInput.onchange = () => {
      const v = groupInput.value.trim() || DEFAULT_GROUP
      groupInput.value = v
      if (v !== (node.group || DEFAULT_GROUP)) updateNode(node.id, { group: v })
    }
    actions.appendChild(groupInput)

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
      if (!(await confirmBox('删除节点 ' + (node.title || node.id) + '？'))) return
      del.disabled = true
      try {
        await api('/canvas/node?id=' + encodeURIComponent(node.id), { method: 'DELETE' })
      } catch (e) {
        alertBox('删除失败：' + (e.message || String(e)))
      } finally {
        del.disabled = false
      }
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
    const form = await assetRegisterBox(slugify(node.title || ''))
    if (!form) return
    try {
      const d = await api('/assets', { method: 'POST', body: JSON.stringify({ nodeId: node.id, type: form.type, name: form.name }) })
      if (d && d.ok) {
        await updateNode(node.id, { params: { ...(node.params || {}), assetId: d.id } })
        alertBox('已入库: ' + d.id)
        await load()
      } else {
        alertBox('入库失败: ' + ((d && d.error) || ''))
      }
    } catch (e) {
      alertBox('入库失败: ' + (e.message || String(e)))
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
      empty.innerHTML = '<h2>画布为空</h2><p>在对话里让 Agent 走生产流程（由流程 skill 定义），各步骤产物会落到这里。</p><p>快速开始：<code>把「一只想当宇航员的小狐狸」做成 30 秒静音 3D 动画短片</code></p>'
      el.canvas.appendChild(empty)
      return
    }

    // 分组展示顺序：settings.groupOrder 声明的在前，未声明的按首次出现顺序排在其后
    const declared = (project.settings?.groupOrder || []).filter((g) => typeof g === 'string' && g.trim())
    const groups = new Map()
    for (const g of declared) groups.set(g, [])
    for (const n of nodes) {
      const g = n.group || DEFAULT_GROUP
      if (!groups.has(g)) groups.set(g, [])
      groups.get(g).push(n)
    }
    knownGroups = [...groups.keys()]
    renderGroupDatalist()

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
