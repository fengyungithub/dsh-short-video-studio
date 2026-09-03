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
    locate: document.getElementById('locate'),
    jump: document.getElementById('jump'),
    autofollow: document.getElementById('autofollow'),
    followToggle: document.getElementById('follow-toggle'),
  }

  // 最新主线节点 id（渲染时记录，供空白点击 / 顶部按钮 / 跟随模式定位）
  let latestMainNodeId = null
  // 跟随最新模式（checkbox）：勾选后进入画布自动定位 + 停留在画布时轮询新主线节点自动跟随
  const FOLLOW_KEY = 'dsh-svs-autofollow:' + sessionId
  let followEnabled = false
  let followInited = false
  let followTimer = null
  let lastMainIds = new Set()

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

  // ---- 节点分区（主线优先预览）----
  // 主线：确认通过 / 等待确认的现行资产（默认，即非作废、非抽帧）。
  // 抽帧：extract_frame 抽出的末帧/首帧/检查帧（params.capability=image.from_video 或标题含 检查帧/抽帧/帧检查）。
  // 作废：用户在卡片上点的「作废」（params.deprecated），或流程里被替换/否定的旧版（标题含 废弃/作废/已弃用 等）。
  const FRAME_TITLE_RE = /(检查帧|抽帧|帧检查)/
  const DEPRECATED_TITLE_RE = /(废弃|作废|已弃用|superseded|obsolete)/i
  const TRUTHY = new Set([true, 1, 'true', '1', 'yes'])

  function nodeLane(node) {
    const p = node.params || {}
    const title = node.title || ''
    if (p.capability === 'image.from_video' || FRAME_TITLE_RE.test(title)) return 'frames'
    if (TRUTHY.has(p.deprecated) || node.status === 'deprecated' || node.status === 'rejected' || DEPRECATED_TITLE_RE.test(title)) return 'discard'
    return 'main'
  }

  function isFrameNode(node) {
    return nodeLane(node) === 'frames'
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
    const lane = nodeLane(node)
    if (lane === 'discard') card.classList.add('deprecated')
    else if (lane === 'frames') card.classList.add('frame-node')

    const head = document.createElement('div')
    head.className = 'node-head'
    const kind = document.createElement('span')
    kind.className = 'node-kind'
    kind.textContent = node.kind || 'text'
    const title = document.createElement('div')
    title.className = 'node-title'
    title.textContent = node.title || '(无标题)'
    const status = document.createElement('span')
    status.className = 'status ' + (lane === 'discard' ? 'deprecated' : (node.status || 'ready'))
    status.textContent = lane === 'discard' ? '作废' : (node.status || 'ready')
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

    // 作废 / 还原：把用户否定的、被替换的旧版移出主线预览（可随时还原）；抽帧中间产物不用此按钮
    if (!isFrameNode(node)) {
      const depBtn = document.createElement('button')
      depBtn.className = 'btn'
      const isDep = nodeLane(node) === 'discard'
      depBtn.textContent = isDep ? '还原' : '作废'
      depBtn.title = isDep ? '恢复到主线分组（作废标记会清除）' : '移出主线预览（作废/否定，可随时还原）'
      depBtn.onclick = async () => {
        depBtn.disabled = true
        try {
          await toggleDeprecated(node.id, !isDep)
        } catch (e) {
          alertBox('操作失败：' + (e.message || String(e)))
        }
        await load()
      }
      actions.appendChild(depBtn)
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
    const nodes = [...(project.nodes || [])].sort((a, b) => (a.order || 0) - (b.order || 0))

    // 分区：主线（确认/待确认的现行资产）优先；抽帧与作废各自收纳到页尾折叠区
    const main = []
    const frames = []
    const discards = []
    for (const n of nodes) {
      const lane = nodeLane(n)
      if (lane === 'frames') frames.push(n)
      else if (lane === 'discard') discards.push(n)
      else main.push(n)
    }

    el.meta.textContent = '画幅 ' + (project.settings?.aspectRatio || '16:9')
      + (project.settings?.duration ? ' · 时长 ' + project.settings.duration : '')
      + ' · 音频 ' + (project.settings?.audioMode || 'silent')
      + ' · 模式 ' + (project.settings?.mode || 'quality')
      + ' · 节点 ' + nodes.length
      + (nodes.length ? '（主线 ' + main.length + (frames.length ? ' · 抽帧 ' + frames.length : '') + (discards.length ? ' · 作废 ' + discards.length : '') + '）' : '')

    if (nodes.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.innerHTML = '<h2>画布为空</h2><p>在对话里让 Agent 走生产流程（由流程 skill 定义），各步骤产物会落到这里。</p><p>快速开始：<code>把「一只想当宇航员的小狐狸」做成 30 秒静音 3D 动画短片</code></p>'
      el.canvas.appendChild(empty)
      latestMainNodeId = null
      lastMainIds = new Set()
      syncLocateButton()
      syncJump()
      return
    }

    // 主线分组展示顺序：settings.groupOrder 声明的在前，未声明的按首次出现顺序排在其后
    const declared = (project.settings?.groupOrder || []).filter((g) => typeof g === 'string' && g.trim())
    const groups = new Map()
    for (const g of declared) groups.set(g, [])
    for (const n of main) {
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

    // 页尾收纳区：作废/否定（可还原）与抽帧/检查帧（中间产物），默认折叠，不打断主线预览
    if (discards.length) el.canvas.appendChild(laneSection('discard', discards))
    if (frames.length) el.canvas.appendChild(laneSection('frames', frames))

    // 最新主线节点 = 主线里 createdAt / order 最大者（点画布空白或「最新主线」定位到它）
    let latestMain = null
    for (const n of main) {
      if (!latestMain || ((n.createdAt || n.order || 0) >= (latestMain.createdAt || latestMain.order || 0))) latestMain = n
    }
    latestMainNodeId = latestMain ? latestMain.id : null
    lastMainIds = new Set(main.map((n) => n.id)) // 跟随模式轮询用：比对主线节点集合，发现新增才刷新
    syncLocateButton()
    syncJump()
  }

  /** 页尾折叠收纳区（作废 / 抽帧各一个）。 */
  function laneSection(lane, list) {
    const det = document.createElement('details')
    det.className = 'lane lane-' + lane
    const sum = document.createElement('summary')
    const isDiscard = lane === 'discard'
    const icon = isDiscard ? '♻️' : '🎞'
    const label = isDiscard ? '作废 / 否定（可还原）' : '抽帧 / 检查帧（中间产物）'
    sum.title = isDiscard
      ? '被替换的旧版 / 用户否定的资产，折叠保存历史，点卡片「还原」可回到主线'
      : '末帧串联、转场首末帧、AI 自检检查帧等抽帧产物，默认折叠不影响主线预览，确认无用后可删除'
    sum.innerHTML = '<span class="lane-icon">' + icon + '</span><span class="lane-label">' + label + '</span><span class="lane-count">' + list.length + '</span>'
    det.appendChild(sum)
    const body = document.createElement('div')
    body.className = 'lane-body'
    for (const n of list) body.appendChild(nodeCard(n))
    det.appendChild(body)
    return det
  }

  async function toggleDeprecated(id, deprecated) {
    const project = await api('/canvas')
    const n = project.nodes.find((x) => x.id === id)
    if (!n) return
    const params = { ...(n.params || {}) }
    if (deprecated) params.deprecated = true
    else delete params.deprecated
    await updateNode(id, { params })
  }

  /** 悬浮 top/bottom 按钮：在顶端显示 BOTTOM（到达底部），离开顶端显示 TOP（返回顶端）。 */
  function syncJump() {
    const c = el.canvas
    const canScroll = c.scrollHeight > c.clientHeight + 4
    if (!canScroll) {
      el.jump.classList.remove('show')
      return
    }
    el.jump.classList.add('show')
    const atTop = c.scrollTop <= 24
    if (atTop) {
      el.jump.textContent = '↓ BOTTOM'
      el.jump.title = '到达底部'
    } else {
      el.jump.textContent = '↑ TOP'
      el.jump.title = '返回顶端'
    }
  }

  function syncLocateButton() {
    if (el.locate) el.locate.disabled = !latestMainNodeId
  }

  /** 平滑滚动到指定节点并在卡片上闪一下。 */
  function locateNode(nodeId) {
    const card = el.canvas.querySelector('.node[data-node-id="' + nodeId + '"]')
    if (!card) return
    const c = el.canvas
    const rect = card.getBoundingClientRect()
    const top = rect.top - c.getBoundingClientRect().top + c.scrollTop
    const target = Math.max(0, top - (c.clientHeight - rect.height) / 2)
    c.scrollTo({ top: target, behavior: 'smooth' })
    card.classList.remove('flash')
    void card.offsetWidth // 重启动画
    card.classList.add('flash')
  }

  /** 定位到最新主线节点（手动：空白点击 / 📍 按钮 / 跟随模式共用）。 */
  function locateLatest() {
    if (latestMainNodeId) locateNode(latestMainNodeId)
  }

  // ---- 跟随最新模式（checkbox）----
  // 勾选后：立即定位到最新主线；之后每次「切回画布 tab」都定位到当前最新主线；
  // 停留在画布期间每 2.5s 轮询一次，发现新增主线节点就自动滚动跟随。
  // 未勾选 = 纯手动（点空白 / 📍 才定位）。状态按 sessionId 记在 localStorage，会话内跨 tab 切换 / 刷新保持。
  function initAutoFollow() {
    if (followInited) return
    followInited = true

    if (sessionId) {
      try { followEnabled = localStorage.getItem(FOLLOW_KEY) === '1' } catch { followEnabled = false }
    }
    if (el.autofollow) {
      el.autofollow.checked = followEnabled
      el.autofollow.addEventListener('change', () => {
        followEnabled = el.autofollow.checked
        try { localStorage.setItem(FOLLOW_KEY, followEnabled ? '1' : '0') } catch {}
        syncFollowUi()
        if (followEnabled) {
          scheduleLocate() // 勾选当下立即定位
          startFollowTimer()
        } else {
          stopFollowTimer()
        }
      })
    }
    syncFollowUi()

    // 切回画布 tab（iframe 由隐藏变可见 / 重挂载可见）→ 跟随模式下定位到最新主线
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (followEnabled) {
          scheduleLocate()
          startFollowTimer()
        }
      } else {
        stopFollowTimer()
      }
    })
    if (document.visibilityState === 'visible' && followEnabled) {
      scheduleLocate()
      startFollowTimer()
    }
  }

  function syncFollowUi() {
    if (el.followToggle) el.followToggle.classList.toggle('on', followEnabled)
  }

  function scheduleLocate() {
    setTimeout(() => locateLatest(), 150)
  }

  function startFollowTimer() {
    if (followTimer) return
    followTimer = setInterval(pollFollow, 2500)
  }

  function stopFollowTimer() {
    if (followTimer) {
      clearInterval(followTimer)
      followTimer = null
    }
  }

  /** 用户正在编辑/弹窗时跳过轮询，避免打断输入。 */
  function isBusyEditing() {
    const ae = document.activeElement
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return true
    const modalHost = document.getElementById('dsh-svs-modal')
    if (modalHost && modalHost.childElementCount) return true
    return !!document.querySelector('textarea.edit')
  }

  /** 轮询：Agent 对话期间新增了主线节点 → 重渲染（保留已展开的收纳区）并滚动到新节点。 */
  async function pollFollow() {
    if (!followEnabled || document.visibilityState !== 'visible' || isBusyEditing()) return
    try {
      const project = await api('/canvas')
      const mains = (project.nodes || []).filter((n) => nodeLane(n) === 'main')
      const fresh = mains.filter((n) => !lastMainIds.has(n.id))
      if (fresh.length === 0) return
      const target = [...fresh].sort((a, b) => (Number(b.order) || b.createdAt || 0) - (Number(a.order) || a.createdAt || 0))[0]
      const openLanes = [...el.canvas.querySelectorAll('details.lane[open]')]
        .map((d) => [...d.classList].find((c) => c.startsWith('lane-')))
        .filter(Boolean)
      render(project)
      for (const name of openLanes) {
        const d = el.canvas.querySelector('details.' + name)
        if (d) d.open = true
      }
      locateNode(target.id)
    } catch { /* 单轮轮询失败静默，下轮重试 */ }
  }

  async function load() {
    el.refresh.disabled = true
    try {
      const project = await api('/canvas')
      render(project)
      initAutoFollow()
    } catch (err) {
      el.canvas.innerHTML = '<div class="empty"><h2>加载失败</h2><p class="error-line">' + escapeHtml(err.message || String(err)) + '</p></div>'
    } finally {
      el.refresh.disabled = false
    }
  }

  el.refresh.addEventListener('click', load)

  // 点击画布空白处 → 定位到最新主线节点（点卡片/按钮等交互元素不触发）
  el.canvas.addEventListener('click', (e) => {
    if (e.target === el.canvas && latestMainNodeId) locateLatest()
  })
  if (el.locate) el.locate.addEventListener('click', () => locateLatest())
  if (el.jump) {
    el.jump.addEventListener('click', () => {
      const c = el.canvas
      const atTop = c.scrollTop <= 24
      c.scrollTo({ top: atTop ? c.scrollHeight : 0, behavior: 'smooth' })
    })
  }
  el.canvas.addEventListener('scroll', syncJump, { passive: true })
  window.addEventListener('resize', syncJump)

  if (!sessionId) {
    el.canvas.innerHTML = '<div class="empty"><h2>缺少会话</h2><p>请从工作区打开本会话后重试。</p></div>'
    syncLocateButton()
    syncJump()
  } else {
    load()
  }
})()
