import { markdownToHtml } from './markdown.js'

(function () {
  'use strict'

  const ROUTE_ROOT = '/dsh-short-video-studio'
  const TOKEN = window.__DSH_SVS_TOKEN__ || ''
  const params = new URLSearchParams(window.location.search)
  const sessionId = params.get('sessionId') || ''
  const workspaceId = params.get('workspaceId') || ''

  // ---- 主题：跟随 DSH 的浅色/深色 ----
  // 首屏由 index.html 的 inline 脚本定（?theme= 优先，其次系统偏好），这里只管**运行中**的跟随：
  // 宿主 lib/client.js 在 DSH 主题变化时 postMessage 过来。监听器在 load() 之前注册，
  // 所以即使画布数据加载失败，主题跟随仍然有效。
  const THEME_CHANNEL = 'dsh-short-video-studio'
  function applyTheme(t) {
    if (t !== 'light' && t !== 'dark') return
    if (document.documentElement.getAttribute('data-theme') === t) return
    document.documentElement.setAttribute('data-theme', t)
  }
  window.addEventListener('message', (e) => {
    // 只认同源消息；再用 channel + type 把主题消息和其他消息区分开
    if (e.origin !== window.location.origin) return
    const d = e.data
    if (d && d.channel === THEME_CHANNEL && d.type === 'theme') applyTheme(d.theme)
  })
  // 宿主没给 ?theme=（宿主没装主题服务，或本页被单独打开）时跟随系统，并在系统切换时跟着变
  if (!params.get('theme') && typeof matchMedia === 'function') {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const syncTheme = () => applyTheme(mq.matches ? 'dark' : 'light')
    syncTheme()
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', syncTheme)
  }

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
    addUpload: document.getElementById('add-upload'),
    addAssets: document.getElementById('add-assets'),
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

  /** 资产库缩略图地址（asset=<id> 由服务端从 .dsh-assets 解析伺服）。 */
  function assetMediaUrl(assetId) {
    const u = new URLSearchParams({ token: TOKEN, sessionId, workspaceId, asset: assetId })
    return ROUTE_ROOT + '/media?' + u.toString()
  }

  const ASSET_TYPE_LABEL = { character: '角色', scene: '场景', style: '风格锚点', clip: '视频片段', text: '文本' }
  const ASSET_TYPE_ORDER = ['character', 'scene', 'style', 'clip', 'text']
  // 载体（kind）与语义类别（type）是两个正交概念：kind 决定怎么存/怎么物化，type 决定分组。
  // 每个 kind 只允许一组 type，服务端也会校验（lib/assets.js TYPE_KINDS），这里保持一致，
  // 目的只是让下拉框一开始就不给出非法组合。
  const NODE_ASSET_KIND = { image: 'image', video: 'video', text: 'text', table: 'text' }
  const ASSET_TYPES_FOR_KIND = { image: ['character', 'scene', 'style'], video: ['clip'], text: ['text'] }
  const ASSET_KIND_HINT = { image: '角色卡 / 场景卡 / 风格锚点', video: '视频片段', text: '文本（镜头表 / 分镜 / 提示词）' }
  const UPLOAD_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
  const UPLOAD_MAX_BYTES = 24 * 1024 * 1024

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
      host.className = 'svs-modal-host'
      const box = document.createElement('div')
      box.className = 'svs-modal'
      const p = document.createElement('p')
      p.textContent = message
      box.appendChild(p)
      const actions = document.createElement('div')
      actions.className = 'svs-modal-actions'
      const close = (val) => { host.remove(); resolve(val) }
      if (o.cancel) {
        const no = document.createElement('button')
        no.className = 'btn'
        no.textContent = '取消'
        no.onclick = () => close(false)
        actions.appendChild(no)
      }
      const yes = document.createElement('button')
      yes.className = 'btn btn-accent'
      yes.textContent = o.okText || '确定'
      yes.onclick = () => close(true)
      actions.appendChild(yes)
      box.appendChild(actions)
      host.appendChild(box)
    })
  }

  const confirmBox = (message) => modal(message, { okText: '删除', cancel: true })
  const alertBox = (message) => modal(message, { okText: '知道了' })

  // ---- 自绘大对话框（上传分组 / 资产库取用），返回 body / 底部按钮栏 / close ----
  function openDialog(titleText) {
    const host = document.createElement('div')
    host.className = 'dialog-host'
    const box = document.createElement('div')
    box.className = 'dialog'
    const head = document.createElement('div')
    head.className = 'dialog-title'
    const t = document.createElement('span')
    t.textContent = titleText
    const x = document.createElement('button')
    x.className = 'btn dialog-x'
    x.textContent = '✕'
    x.title = '关闭'
    const body = document.createElement('div')
    body.className = 'dialog-body'
    const foot = document.createElement('div')
    foot.className = 'dialog-actions'
    head.appendChild(t)
    head.appendChild(x)
    box.appendChild(head)
    box.appendChild(body)
    box.appendChild(foot)
    host.appendChild(box)
    document.body.appendChild(host)
    const close = () => host.remove()
    x.addEventListener('click', close)
    return { body, foot, close }
  }

  function dialogBtn(text, onClick, cls) {
    const b = document.createElement('button')
    b.className = 'btn' + (cls ? ' ' + cls : '')
    b.type = 'button'
    b.textContent = text
    b.addEventListener('click', onClick)
    return b
  }

  /** 读取本地文件为 base64 dataURL。 */
  function readFileDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(fr.result)
      fr.onerror = () => reject(new Error('读取失败：' + file.name))
      fr.readAsDataURL(file)
    })
  }

  /**
   * 手动添加资产 ①：从本机选图上传 → 画布资产卡。
   * 先选文件，再弹「分组」框（可留空 = 未分组，之后每张卡仍可单独改分组）；
   * 入库保持可选——需要跨会话复用再点卡片上的「入库」。
   */
  async function chooseFilesAndUpload() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = UPLOAD_ACCEPT
    input.multiple = true
    input.addEventListener('change', async () => {
      const files = Array.from(input.files || [])
      if (!files.length) return
      const okFiles = files.filter((f) => f.size <= UPLOAD_MAX_BYTES)
      const skipped = files.filter((f) => f.size > UPLOAD_MAX_BYTES).map((f) => f.name)
      if (!okFiles.length) {
        alertBox('所选图片均超过 24MB，无法上传。')
        return
      }
      const picked = await pickGroupForUpload(okFiles.map((f) => f.name))
      if (!picked) return // 用户取消

      let reading = []
      for (const f of okFiles) {
        try {
          reading.push({ filename: f.name, dataUrl: await readFileDataUrl(f) })
        } catch (e) {
          skipped.push(f.name + '（' + e.message + '）')
        }
      }
      if (!reading.length) {
        alertBox('没有可上传的图片。')
        return
      }
      try {
        const d = await api('/canvas/upload', {
          method: 'POST',
          body: JSON.stringify({ files: reading, group: picked.group }),
        })
        let msg = '已添加 ' + d.added.length + ' 张资产卡'
        if (d.added.length) msg += '：' + d.added.map((x) => x.title).join('、')
        const problems = (d.errors || []).map((e) => (e.filename || '?') + '（' + e.message + '）').concat(skipped)
        if (problems.length) msg += '\n失败 ' + problems.length + ' 项：' + problems.join('；')
        alertBox(msg)
      } catch (e) {
        alertBox('上传失败：' + (e.message || String(e)))
      }
      await load()
    })
    input.click()
  }

  /** 上传前选分组的小对话框：resolve(null)=取消，否则 { group }（''=未分组）。 */
  function pickGroupForUpload(fileNames) {
    return new Promise((resolve) => {
      const dlg = openDialog('上传 ' + fileNames.length + ' 张图片到画布')
      const list = document.createElement('ul')
      list.className = 'file-list'
      for (const n of fileNames.slice(0, 20)) {
        const li = document.createElement('li')
        li.textContent = n
        list.appendChild(li)
      }
      if (fileNames.length > 20) {
        const li = document.createElement('li')
        li.textContent = '…等共 ' + fileNames.length + ' 张'
        list.appendChild(li)
      }
      dlg.body.appendChild(list)

      const lbl = document.createElement('label')
      lbl.className = 'field-label'
      lbl.textContent = '分组（可留空 = 未分组；如「角色卡 / 场景卡」等，之后每张卡仍可单独改分组）'
      const groupInput = document.createElement('input')
      groupInput.type = 'text'
      groupInput.setAttribute('list', 'dsh-svs-groups')
      groupInput.placeholder = '未分组'
      dlg.body.appendChild(lbl)
      dlg.body.appendChild(groupInput)
      const note = document.createElement('p')
      note.className = 'form-note'
      note.textContent = '上传即成为画布上的图片资产卡，可作 ref 参考直接生成视频；需要跨会话复用时可再点卡上的「入库」。'
      dlg.body.appendChild(note)

      const cancel = dialogBtn('取消', () => { dlg.close(); resolve(null) })
      dlg.foot.appendChild(cancel)
      const go = dialogBtn('上传', () => { dlg.close(); resolve({ group: groupInput.value.trim() }) }, 'btn-accent')
      dlg.foot.appendChild(go)
      groupInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); go.click() }
        if (e.key === 'Escape') cancel.click()
      })
      groupInput.focus()
    })
  }

  /** 编辑 image 资产卡：选一张本地图片替换该节点图片（保留节点 id / 标题 / 分组）。 */
  function replaceImageByUpload(node) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = UPLOAD_ACCEPT
    input.addEventListener('change', async () => {
      const f = (input.files || [])[0]
      if (!f) return
      if (f.size > UPLOAD_MAX_BYTES) {
        alertBox('图片超过 24MB 上限，请压缩后再试。')
        return
      }
      let dataUrl
      try {
        dataUrl = await readFileDataUrl(f)
      } catch (e) {
        alertBox('读取失败：' + (e.message || String(e)))
        return
      }
      try {
        const d = await api('/canvas/node/replace-image', {
          method: 'POST',
          body: JSON.stringify({ nodeId: node.id, filename: f.name, dataUrl }),
        })
        let msg = '已用本地上传替换「' + (node.title || node.id) + '」的图片'
        if (d.assetIdCleared) {
          msg += '\n该卡此前已入库（' + d.prevAssetId + '），替换后已解除绑定；需要继续跨会话复用请重新点「入库」登记为新版本。'
        }
        alertBox(msg)
      } catch (e) {
        alertBox('替换失败：' + (e.message || String(e)))
      }
      await load()
    })
    input.click()
  }

  /** 手动添加资产 ②：从跨会话资产库带缩略图取用 / 删除。 */
  async function openAssetLibrary() {
    const dlg = openDialog('跨会话资产库 · 点卡片加入画布')
    const body = dlg.body
    const foot = dlg.foot

    async function render() {
      body.innerHTML = ''
      foot.innerHTML = ''
      let assets = []
      try {
        const d = await api('/assets')
        assets = (d && d.assets) || []
      } catch (e) {
        const p = document.createElement('p')
        p.className = 'lib-empty-hint'
        p.textContent = '读取资产库失败：' + (e.message || String(e))
        body.appendChild(p)
        foot.appendChild(dialogBtn('关闭', () => dlg.close()))
        return
      }

      if (!assets.length) {
        const p = document.createElement('p')
        p.className = 'lib-empty-hint'
        p.innerHTML = '资产库还是空的。<br>画布上的图片、视频、文本卡片都能点「入库」登记（选类型 + 填小写英文名），<br>之后任意会话都能从这里直接取用到画布；图片类还能直接当 ref 参考图。'
        body.appendChild(p)
        foot.appendChild(dialogBtn('完成', () => dlg.close()))
        return
      }

      const grid = document.createElement('div')
      grid.className = 'asset-grid'
      const sorted = [...assets].sort((a, b) => {
        const ta = ASSET_TYPE_ORDER.indexOf(a.type)
        const tb = ASSET_TYPE_ORDER.indexOf(b.type)
        return (ta < 0 ? 99 : ta) - (tb < 0 ? 99 : tb) || String(a.name || '').localeCompare(String(b.name || ''), 'zh')
      })
      let lastType = ''
      for (const a of sorted) {
        if (a.type !== lastType) {
          lastType = a.type
          const h = document.createElement('div')
          h.className = 'asset-group-title'
          h.textContent = (ASSET_TYPE_LABEL[a.type] || a.type) + ' · ' + (a.state && a.state !== 'default' ? a.state + ' ' : '') + sorted.filter((x) => x.type === a.type).length
          grid.appendChild(h)
        }
        const card = document.createElement('div')
        card.className = 'asset-card'
        card.dataset.assetId = a.id

        const kind = a.kind || 'image'
        const thumb = document.createElement('div')
        thumb.className = 'thumb'
        if (kind === 'text') {
          // 文本资产没有文件：显示正文摘要（取首几行，超出用省略号）
          const pre = document.createElement('div')
          pre.className = 'text-preview'
          const t = String(a.text || '').replace(/\s+/g, ' ').trim()
          pre.textContent = t.length > 180 ? t.slice(0, 180) + '…' : (t || '（空文本）')
          thumb.appendChild(pre)
        } else {
          const media = kind === 'video' ? document.createElement('video') : document.createElement('img')
          if (kind === 'video') {
            media.muted = true
            media.playsInline = true
            media.preload = 'metadata'
            media.controls = false
          } else {
            media.loading = 'lazy'
          }
          media.alt = a.id || ''
          media.src = assetMediaUrl(a.id)
          media.onerror = () => {
            media.remove()
            const m = document.createElement('span')
            m.className = 'missing'
            m.textContent = kind === 'video' ? '🎬 视频缺失' : '🖼 图缺失'
            thumb.appendChild(m)
          }
          thumb.appendChild(media)
          if (kind === 'video') {
            const badge = document.createElement('span')
            badge.className = 'kind-badge'
            badge.textContent = '🎬 视频'
            thumb.appendChild(badge)
          }
        }
        card.appendChild(thumb)

        const info = document.createElement('div')
        info.className = 'info'
        const tag = document.createElement('span')
        tag.className = 'asset-tag ' + (a.type || '')
        tag.textContent = ASSET_TYPE_LABEL[a.type] || a.type || 'asset'
        info.appendChild(tag)
        const name = document.createElement('div')
        name.className = 'name'
        name.textContent = a.name || a.id
        info.appendChild(name)
        const idLine = document.createElement('div')
        idLine.className = 'id'
        idLine.textContent = a.id
        info.appendChild(idLine)
        card.appendChild(info)

        const acts = document.createElement('div')
        acts.className = 'actions'
        const addBtn = dialogBtn('＋ 加入画布', async () => {
          addBtn.disabled = true
          addBtn.textContent = '添加中…'
          try {
            await api('/assets/to-canvas', { method: 'POST', body: JSON.stringify({ id: a.id }) })
            addBtn.textContent = '已添加 ✓'
          } catch (e) {
            addBtn.textContent = '重试'
            addBtn.disabled = false
            alertBox('添加失败：' + (e.message || String(e)))
          }
        }, 'btn-accent')
        acts.appendChild(addBtn)

        const delBtn = dialogBtn('删除', async () => {
          const okToDelete = await confirmBox(
            '从资产库删除 ' + a.id + ' ？\n\n' +
            '· 库里的索引会被移除' + (kind === 'text' ? '（文本内容一并删除）' : '，文件同时清理') + '\n' +
            '· 已经取到画布上的卡片**不受影响**（它们各自持有副本）\n' +
            '· Agent 之后不能再引用这个资产 id'
          )
          if (!okToDelete) return
          delBtn.disabled = true
          delBtn.textContent = '删除中…'
          try {
            await api('/assets?id=' + encodeURIComponent(a.id), { method: 'DELETE' })
            await render()
          } catch (e) {
            delBtn.textContent = '重试'
            delBtn.disabled = false
            alertBox('删除失败：' + (e.message || String(e)))
          }
        }, 'btn-danger')
        acts.appendChild(delBtn)
        card.appendChild(acts)
        grid.appendChild(card)
      }
      body.appendChild(grid)
      foot.appendChild(dialogBtn('完成（刷新画布）', () => {
        dlg.close()
        load()
      }, 'btn-accent'))
    }

    await render()
  }

  /**
   * 入库表单：资产类型（下拉，按节点载体收窄）+ 资产名（文本）。取消返回 null。
   * node 决定可选类型：图片→角色/场景/风格锚点；视频→视频片段；文本/表格→文本。
   */
  function assetRegisterBox(node, defaultName) {
    const kind = NODE_ASSET_KIND[node && node.kind] || 'image'
    return new Promise((resolve) => {
      const host = ensureModalHost()
      host.innerHTML = ''
      host.className = 'svs-modal-host'
      const box = document.createElement('div')
      box.className = 'svs-modal lg'
      const label = (t) => { const l = document.createElement('div'); l.className = 'svs-field-label'; l.textContent = t; return l }

      box.appendChild(label('资产类型（该节点是' + (ASSET_KIND_HINT[kind] || kind) + '）'))
      const typeSel = document.createElement('select')
      typeSel.className = 'svs-field'
      for (const v of (ASSET_TYPES_FOR_KIND[kind] || ['character'])) {
        const o = document.createElement('option')
        o.value = v
        o.textContent = ASSET_TYPE_LABEL[v] || v
        typeSel.appendChild(o)
      }
      box.appendChild(typeSel)

      box.appendChild(label('资产名（小写英文/拼音，如 luna）'))
      const nameInput = document.createElement('input')
      nameInput.type = 'text'
      nameInput.value = String(defaultName || '')
      nameInput.className = 'svs-field'
      box.appendChild(nameInput)

      const hint = document.createElement('p')
      hint.className = 'svs-hint'
      hint.textContent = kind === 'text'
        ? '文本资产存正文（不存文件）；复用时可取回画布当参考，不能作 ref 参考图。'
        : kind === 'video'
          ? '视频资产拷入库；复用时可取回画布当素材，不能作 ref 参考图。'
          : '图片资产可作 ref 参考图直接驱动生成。'
      box.appendChild(hint)

      const actions = document.createElement('div')
      actions.className = 'svs-modal-actions'
      const close = (val) => { host.remove(); resolve(val) }
      const no = document.createElement('button')
      no.className = 'btn'
      no.textContent = '取消'
      no.onclick = () => close(null)
      actions.appendChild(no)
      const yes = document.createElement('button')
      yes.className = 'btn btn-accent'
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
    } else if (node.kind === 'image') {
      // image 节点「编辑」= 用本地上传图替换本卡（保留节点/标题/分组；原图留在磁盘）
      const editBtn = document.createElement('button')
      editBtn.className = 'btn'
      editBtn.textContent = '编辑'
      editBtn.title = '上传本地图片替换本卡图片（若已入库会解除绑定，替换后可重新「入库」）'
      editBtn.onclick = () => replaceImageByUpload(node)
      actions.appendChild(editBtn)
    }

    const redoBtn = document.createElement('button')
    redoBtn.className = 'btn'
    redoBtn.textContent = '重做'
    redoBtn.onclick = () => askAi('重做画布节点 ' + (node.id || '') + '（' + (node.title || node.kind) + '）：请按画布当前参数重新生成/重写该节点。')
    actions.appendChild(redoBtn)

    // 入库：图片（角色/场景/风格锚点）、视频（片段）、文本/表格（镜头表/分镜/提示词）都可登记。
    // 载体由节点 kind 决定，可选类型随之收窄——避免出现「视频被登记成角色卡」这种语义错位的
    // 记录（agent 拿到它当 ref 图会直接失败）。
    const nodeAssetKind = NODE_ASSET_KIND[node.kind]
    if (nodeAssetKind) {
      const regBtn = document.createElement('button')
      regBtn.className = 'btn'
      if (node.params && node.params.assetId) {
        regBtn.textContent = '已入库'
        regBtn.title = node.params.assetId
        regBtn.disabled = true
      } else {
        regBtn.textContent = '入库'
        regBtn.title = '登记为跨会话资产（' + ASSET_KIND_HINT[nodeAssetKind] + '）'
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
    const form = await assetRegisterBox(node, slugify(node.title || ''))
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
      + ' · 档位 ' + (project.settings?.mode || 'quality')
      + ' · 节点 ' + nodes.length
      + (nodes.length ? '（主线 ' + main.length + (frames.length ? ' · 抽帧 ' + frames.length : '') + (discards.length ? ' · 作废 ' + discards.length : '') + '）' : '')

    if (nodes.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'empty'
      empty.innerHTML =
        '<h2>画布为空</h2>' +
        '<p>在对话里让 Agent 走生产流程（由流程 skill 定义），各步骤产物会落到这里；也可以先把自己的素材放上画布：</p>' +
        '<p class="empty-actions">' +
        '<button class="btn btn-accent" id="empty-upload" type="button">＋ 上传图片</button>' +
        '<button class="btn" id="empty-library" type="button">📚 从资产库添加</button>' +
        '</p>' +
        '<p>快速开始：<code>把「一只想当宇航员的小狐狸」做成 30 秒静音 3D 动画短片</code></p>'
      const eu = empty.querySelector('#empty-upload')
      if (eu) eu.onclick = () => chooseFilesAndUpload()
      const elb = empty.querySelector('#empty-library')
      if (elb) elb.onclick = () => openAssetLibrary()
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

  // 手动添加资产：顶栏按钮（空画布空态的 CTA 在 render 里单独绑定）
  if (el.addUpload) el.addUpload.addEventListener('click', () => chooseFilesAndUpload())
  if (el.addAssets) el.addAssets.addEventListener('click', () => openAssetLibrary())

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
