// dsh-short-video-studio — 浏览器半。
// 通过 window.__ModuleLoader__.load 注册 client 模块，把「画布」作为
// conversation.view 会话视图 tab 注入（iframe 指向宿主伺服的自包含 studio 页）。
window.__ModuleLoader__.load({
  id: 'dsh-short-video-studio',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    const inject = ['slots']

    const ROUTE_ROOT = '/dsh-short-video-studio'

    const shellStyle = {
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      height: '100%',
      minHeight: 0,
      background: '#f6f7f9',
    }
    const frameStyle = {
      flex: 1,
      width: '100%',
      minHeight: 0,
      border: 0,
      background: '#f6f7f9',
    }
    const emptyStyle = {
      display: 'grid',
      placeContent: 'center',
      gap: 8,
      height: '100%',
      padding: 32,
      color: '#70757f',
      textAlign: 'center',
    }

    function CanvasView(props) {
      const sessionId = props.sessionId
      const useWorkspaces = props.useWorkspaces
      const inputActions = props.inputActions
      const iframeRef = React.useRef(null)

      const workspace = useWorkspaces
        ? useWorkspaces((state) => state.items.find((item) => item.sessionIds.includes(sessionId)))
        : null

      React.useEffect(() => {
        const receive = (event) => {
          if (event.origin !== window.location.origin) return
          if (event.source !== iframeRef.current?.contentWindow) return
          const data = event.data
          if (!data || data.channel !== 'dsh-short-video-studio') return
          if (data.type === 'ask-ai' && typeof data.text === 'string' && inputActions && typeof inputActions.setDraft === 'function') {
            inputActions.setDraft(data.text)
          }
        }
        window.addEventListener('message', receive)
        return () => window.removeEventListener('message', receive)
      }, [inputActions])

      if (!workspace) {
        return React.createElement(
          'div',
          { style: emptyStyle },
          React.createElement('strong', null, '画布需要工作区'),
          React.createElement('span', null, '请从已注册的 DeepSeek Harness 工作区打开本会话。'),
        )
      }

      const query = new URLSearchParams({
        sessionId: String(sessionId),
        workspaceId: String(workspace.workspaceId),
      })

      return React.createElement(
        'section',
        { style: shellStyle, 'aria-label': '短剧画布' },
        React.createElement('iframe', {
          ref: iframeRef,
          title: '短剧画布',
          src: ROUTE_ROOT + '/?' + query.toString(),
          style: frameStyle,
          sandbox: 'allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts',
        }),
      )
    }

    // ComfyUI 设置卡片（DSH 设置页 settings.section）
    const CONFIG_API = ROUTE_ROOT + '/api/config'
    const WORKFLOWS_API = ROUTE_ROOT + '/api/workflows'
    const CAPABILITY_OPTIONS = [
      'image.text2image', 'image.image2image', 'video.text2video',
      'video.image2video', 'video.reference2video', 'audio.tts', 'audio.music',
    ]

    function ComfyUISettings() {
      const [cfg, setCfg] = React.useState(null)
      const [registry, setRegistry] = React.useState(null)
      const [selWorkflow, setSelWorkflow] = React.useState('')
      const [importText, setImportText] = React.useState('')
      const [importId, setImportId] = React.useState('')
      const [importCapability, setImportCapability] = React.useState('image.text2image')
      const [importName, setImportName] = React.useState('')
      const [msg, setMsg] = React.useState('加载中…')

      React.useEffect(() => {
        Promise.all([
          fetch(CONFIG_API).then((r) => r.json()),
          fetch(WORKFLOWS_API).then((r) => r.json()),
        ]).then(([c, w]) => {
          if (c && c.ok) setCfg(c.config)
          if (w && w.ok) setRegistry(w)
          setMsg('')
        }).catch((e) => setMsg('加载失败: ' + e))
      }, [])

      if (!cfg || !registry) return React.createElement('div', { style: { padding: 16 } }, msg)

      const setTop = (k, v) => setCfg({ ...cfg, [k]: v })
      const field = (label, value, onChange, type) =>
        React.createElement('label', { style: { display: 'block', margin: '6px 0' } },
          React.createElement('span', null, label),
          React.createElement('input', {
            value: value ?? '', type: type || 'text',
            style: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', marginTop: 3 },
            onChange: (e) => onChange(e.target.value),
          }),
        )

      const post = (url, body, method) =>
        fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
          .then((r) => r.json())

      const saveConfig = () => {
        setMsg('保存中…')
        post(CONFIG_API, cfg, 'POST')
          .then((d) => setMsg(d && d.ok ? '已保存 ✓' : '保存失败: ' + ((d && d.error) || (d && d.errors) || '')))
          .catch((e) => setMsg('保存失败: ' + e))
      }

      const setDefault = (cap, wid) => {
        const next = { ...cfg, preferred: { ...(cfg.preferred || {}), [cap]: [wid] } }
        setCfg(next)
        post(CONFIG_API, next, 'POST')
          .then((d) => {
            setMsg(d && d.ok ? '默认已更新 ✓' : '更新失败: ' + ((d && d.error) || ''))
            if (d && d.ok) return refreshRegistry()
          })
          .catch((e) => setMsg('更新失败: ' + e))
      }

      const refreshRegistry = () =>
        fetch(WORKFLOWS_API).then((r) => r.json()).then((w) => { if (w && w.ok) setRegistry(w) })

      const importWf = () => {
        let m
        try { m = JSON.parse(importText) } catch (e) { setMsg('JSON 解析失败: ' + e); return }
        const isRaw = m && typeof m === 'object' && !Array.isArray(m) && m.id === undefined && m.graph === undefined
        let payload = m
        if (isRaw) {
          if (!importId || !importCapability) { setMsg('原始导出需填写「工作流 id」与「能力 capability」'); return }
          payload = { raw: m, id: importId, capability: importCapability, displayName: importName || importId }
        }
        setMsg('导入中…')
        post(WORKFLOWS_API, payload, 'POST').then((d) => {
          if (d && d.ok) {
            setImportText('')
            setMsg('已导入 ✓' + (d.todos && d.todos.length ? '（' + d.todos.length + ' 处语义绑定需手动补）' : ''))
            return refreshRegistry()
          }
          setMsg('导入失败: ' + ((d && d.errors && d.errors.join('; ')) || (d && d.error) || ''))
        }).catch((e) => setMsg('导入失败: ' + e))
      }

      const deleteWf = (id) => {
        if (!window.confirm('删除工作流清单 ' + id + '？')) return
        setMsg('删除中…')
        fetch(WORKFLOWS_API + '?id=' + encodeURIComponent(id), { method: 'DELETE' }).then((r) => r.json()).then((d) => {
          if (d && d.ok) { setMsg('已删除 ✓'); return refreshRegistry() }
          setMsg('删除失败: ' + ((d && d.message) || ''))
        }).catch((e) => setMsg('删除失败: ' + e))
      }

      const capabilities = registry.capabilities || []
      const allWorkflows = capabilities.flatMap((c) => (c.workflows || []).map((w) => ({ ...w, capability: c.capability })))
      const sel = allWorkflows.find((w) => w.id === selWorkflow) || allWorkflows[0] || null
      const overrides = cfg.assetOverrides || {}

      const capBlocks = capabilities.map((c) => {
        const defaultId = ((cfg.preferred && cfg.preferred[c.capability] && cfg.preferred[c.capability][0]))
          || (c.preferred && c.preferred[0])
          || (c.workflows[0] && c.workflows[0].id)
          || ''
        const rows = (c.workflows || []).map((w) =>
          React.createElement('label', { key: w.id, style: { display: 'flex', alignItems: 'center', margin: '4px 0' } },
            React.createElement('input', { type: 'radio', name: 'dflt-' + c.capability, checked: w.id === defaultId, onChange: () => setDefault(c.capability, w.id) }),
            React.createElement('span', { style: { marginLeft: 6 } }, w.displayName + '（' + w.id + (w.modes && w.modes.length ? ' · ' + w.modes.join('/') : '') + '）'),
            w.source === 'user'
              ? React.createElement('button', { onClick: () => deleteWf(w.id), style: { marginLeft: 10 } }, '删除')
              : null,
          ),
        )
        return React.createElement('div', { key: c.capability, style: { margin: '10px 0', padding: '8px', border: '1px solid #e3e5e8', borderRadius: 6 } },
          React.createElement('strong', null, c.capability),
          rows,
        )
      })

      const assetRows = sel
        ? Object.entries(sel.assets || {}).map(([k, a]) => {
            const label = (a && (a.label || (a.env ? k + '（env: ' + a.env + '）' : k))) || k
            const val = (overrides[sel.id] && overrides[sel.id][k] !== undefined) ? overrides[sel.id][k] : ((a && a.default) || '')
            return field(label, val, (v) => {
              const wid = sel.id
              setCfg({ ...cfg, assetOverrides: { ...overrides, [wid]: { ...(overrides[wid] || {}), [k]: v } } })
            })
          })
        : []

      return React.createElement('div', { style: { padding: 16, maxWidth: 760 } },
        React.createElement('h3', null, 'ComfyUI'),
        React.createElement('p', null, '配置生成服务。换模型/换工作流均在此完成，保存后即时生效。'),
        React.createElement('h4', null, '连接'),
        field('ComfyUI 服务地址 baseUrl', cfg.baseUrl, (v) => setTop('baseUrl', v)),
        field('API Key（可选）', cfg.apiKey, (v) => setTop('apiKey', v), 'password'),
        field('轮询间隔 pollMs', cfg.pollMs, (v) => setTop('pollMs', v)),
        field('生成超时 timeoutMs', cfg.timeoutMs, (v) => setTop('timeoutMs', v)),
        React.createElement('h4', null, '工作流注册表（选默认模型/工作流）'),
        capBlocks,
        React.createElement('h4', null, '资产覆盖（换模型文件）'),
        React.createElement('select', { value: sel ? sel.id : '', onChange: (e) => setSelWorkflow(e.target.value), style: { width: '100%', padding: '6px 8px' } },
          allWorkflows.map((w) => React.createElement('option', { key: w.id, value: w.id }, w.displayName + '（' + w.id + '）')),
        ),
        assetRows,
        React.createElement('h4', null, '导入工作流'),
        React.createElement('p', { style: { color: '#666', fontSize: 12, margin: '4px 0' } }, '可粘贴「Workflow Manifest」或 ComfyUI「导出 API」原始工作流；原始工作流需填下方 id + 能力，系统会自动转换。'),
        React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 8 } },
          React.createElement('label', { style: { flex: 1 } },
            React.createElement('span', null, '工作流 id'),
            React.createElement('input', { value: importId, placeholder: '如 z-image-turbo-t2i', style: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', marginTop: 3 }, onChange: (e) => setImportId(e.target.value) }),
          ),
          React.createElement('label', { style: { flex: 1 } },
            React.createElement('span', null, '能力 capability'),
            React.createElement('select', { value: importCapability, style: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', marginTop: 3 }, onChange: (e) => setImportCapability(e.target.value) },
              CAPABILITY_OPTIONS.map((c) => React.createElement('option', { key: c, value: c }, c)),
            ),
          ),
          React.createElement('label', { style: { flex: 1 } },
            React.createElement('span', null, '显示名（可选）'),
            React.createElement('input', { value: importName, placeholder: '可选', style: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', marginTop: 3 }, onChange: (e) => setImportName(e.target.value) }),
          ),
        ),
        React.createElement('textarea', { value: importText, rows: 6, placeholder: '粘贴 Workflow Manifest JSON，或 ComfyUI「导出 API」的原始工作流 JSON（原始导出会自动转换）', style: { width: '100%', boxSizing: 'border-box', padding: '6px 8px' }, onChange: (e) => setImportText(e.target.value) }),
        React.createElement('div', { style: { marginTop: 10 } },
          React.createElement('button', { onClick: importWf, style: { padding: '8px 16px' } }, '导入'),
          React.createElement('button', { onClick: saveConfig, style: { marginLeft: 10, padding: '8px 16px' } }, '保存配置'),
          React.createElement('span', { style: { marginLeft: 12 } }, msg),
        ),
        (registry.errors && registry.errors.length)
          ? React.createElement('div', { style: { color: '#c0392b', marginTop: 8 } }, '清单校验错误：' + registry.errors.join('; '))
          : null,
      )
    }

    // =========================================================================
    // 生成模式面板（共用 dsh 输入框）：conversation.input.left 开关 + input.dock 参数条。
    // 无 skill、无 Agent 的手工生成入口：prompt 直接在 dsh 输入框输入，点「生成」
    // 即把当前草稿送 /generate/* 出片，产物落画布 tab（canvas 节点）并在参数条内预览。
    // =========================================================================
    const GEN_CSS_ID = '@dsh-short-video-studio/gen.css'
    const GEN_CSS = [
      '.svsg{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,760px);margin:0 auto;padding:0 8px 2px;font-family:var(--dsw-font-family,inherit);color:var(--dsw-alias-label-primary,#1f2329)}',
      '.svsg-bar{display:flex;align-items:center;gap:6px;padding:6px;background:var(--dsw-alias-bg-elevated,rgba(28,31,40,.9));border:1px solid var(--dsw-alias-border-l1,#2e3342);border-radius:12px;flex-wrap:wrap}',
      '.svsg-brand{font-size:12px;color:var(--dsw-alias-label-caption,#8a8f99);margin:0 6px 0 2px;white-space:nowrap}',
      '.svsg-seg{display:inline-flex;gap:2px;background:var(--dsw-alias-bg-base,#232734);border:1px solid var(--dsw-alias-border-l1,#2e3342);border-radius:9px;padding:2px}',
      '.svsg-seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12.5px;line-height:26px;padding:0 12px;border-radius:7px;cursor:pointer;white-space:nowrap}',
      '.svsg-seg button:hover{color:var(--dsw-alias-label-primary,#e8eaf0)}',
      '.svsg-seg button.on{background:var(--dsw-alias-state-business-tertiary,rgba(51,112,255,.16));color:var(--dsw-alias-state-business-primary,#5b8cff);font-weight:600}',
      '.svsg-spacer{flex:1}',
      '.svsg-hint{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-caption,#8a8f99);margin:0}',
      '.svsg-panel{margin-top:6px;padding:10px;background:var(--dsw-alias-bg-elevated,rgba(28,31,40,.92));border:1px solid var(--dsw-alias-border-l1,#2e3342);border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.14)}',
      '.svsg-panel h4{margin:0 0 8px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.svsg-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}',
      '.svsg-lbl{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa1b1);white-space:nowrap}',
      '.svsg-ta{width:100%;box-sizing:border-box;min-height:72px;resize:vertical;border:1px solid var(--dsw-alias-border-l2,#3a4050);background:var(--dsw-alias-bg-base,#1b1e27);color:var(--dsw-alias-label-primary,#e8eaf0);border-radius:10px;padding:9px 11px;font:inherit;font-size:13px;outline:none}',
      '.svsg-ta:focus{border-color:var(--dsw-alias-state-business-primary,#5b8cff)}',
      '.svsg-select{background:var(--dsw-alias-bg-base,#1b1e27);color:var(--dsw-alias-label-primary,#e8eaf0);border:1px solid var(--dsw-alias-border-l2,#3a4050);border-radius:8px;padding:5px 8px;font-size:12.5px}',
      '.svsg-drop{border:1px dashed var(--dsw-alias-border-l2,#3a4050);border-radius:10px;padding:10px;background:var(--dsw-alias-bg-base,#1b1e27);display:flex;flex-direction:column;gap:8px;min-width:200px;flex:1}',
      '.svsg-drop .t{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa1b1)}',
      '.svsg-chip{display:flex;gap:8px;align-items:center;border:1px solid var(--dsw-alias-border-l1,#2e3342);background:var(--dsw-alias-bg-base,#1b1e27);border-radius:10px;padding:6px;position:relative}',
      '.svsg-chip img{width:46px;height:46px;object-fit:cover;border-radius:6px;background:#000}',
      '.svsg-chip .n{font-size:12px;min-width:0;flex:1;word-break:break-all}',
      '.svsg-chip .x{border:0;background:transparent;color:var(--dsw-alias-label-caption,#8a8f99);cursor:pointer;font-size:14px;padding:2px 6px;border-radius:6px}',
      '.svsg-chip .x:hover{color:var(--dsw-alias-state-error-primary,#ff6b6b);background:rgba(255,107,107,.1)}',
      '.svsg-upload{border:0;background:transparent;color:var(--dsw-alias-state-business-primary,#5b8cff);cursor:pointer;font-size:12px;padding:2px 0;text-align:left}',
      '.svsg-go{flex:none;border:0;border-radius:9px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;color:#fff;background:linear-gradient(135deg,#5b8cff,#7c5cff)}',
      '.svsg-go:hover{filter:brightness(1.08)}',
      '.svsg-go:disabled{opacity:.55;cursor:default;filter:none}',
      '.svsg-status{font-size:12px;color:var(--dsw-alias-state-warning-primary,#d97706);display:flex;gap:6px;align-items:center;margin:6px 2px 0}',
      '.svsg-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#ff6b6b);margin:6px 2px 0;word-break:break-all;line-height:1.5}',
      '.svsg-results{margin-top:8px;display:flex;flex-direction:column;gap:8px}',
      '.svsg-result{border:1px solid var(--dsw-alias-border-l1,#2e3342);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-base,#1b1e27)}',
      '.svsg-result .m{background:#000}',
      '.svsg-result img,.svsg-result video{display:block;max-width:100%;max-height:320px;margin:0 auto}',
      '.svsg-result .meta{display:flex;align-items:center;gap:10px;padding:6px 10px;font-size:11.5px;color:var(--dsw-alias-label-caption,#8a8f99);flex-wrap:wrap}',
      '.svsg-result .meta a{color:var(--dsw-alias-state-business-primary,#5b8cff);text-decoration:none}',
      '.svsg-foot{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-caption,#8a8f99);line-height:1.5}',
    '.svsg-tools{display:inline-flex;align-items:center;gap:4px}',
    '.svsg-tool{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#9aa1b1);font-size:12px;line-height:26px;padding:0 8px;border-radius:8px;cursor:pointer;white-space:nowrap}',
    '.svsg-tool:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));color:var(--dsw-alias-label-primary,#e8eaf0)}',
    '.svsg-tool.on{background:var(--dsw-alias-state-business-tertiary,rgba(51,112,255,.2));color:var(--dsw-alias-state-business-primary,#7aa2ff);font-weight:600}',
    '.svsg-strip{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px)*2 - var(--dsh-composer-dock-inset,8px)*2);max-width:calc(var(--dsh-composer-card-max-width,792px) - var(--dsh-composer-dock-inset,8px)*2);margin:0 auto calc(0px - var(--dsh-composer-stack-gap,6px) - 3px);padding:0 var(--dsh-composer-dock-inset,8px);flex:none}',
    '.svsg-strip .inner{background:var(--dsw-alias-bg-elevated,#20232f);border:1px solid var(--dsw-alias-border-l1,#2e3342);border-bottom:none;border-radius:12px 12px 0 0;padding:8px 10px 6px;box-shadow:0 -6px 18px rgba(0,0,0,.08)}',
    '.svsg-tip{font-size:12px;color:var(--dsw-alias-state-success-primary,#3fba62);margin:4px 2px 0;line-height:1.5}',
    '.svsg-skill{display:inline-flex;align-items:center;gap:4px;background:var(--dsw-alias-accent-subtle,rgba(76,140,255,.14));color:var(--dsw-alias-accent,#4c8cff);border:1px solid var(--dsw-alias-accent-soft,rgba(76,140,255,.32));border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600;white-space:nowrap}',
    ].join('')
    let genCssInjected = false
    function ensureGenCss() {
      if (genCssInjected) return
      genCssInjected = true
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(GEN_CSS_ID) + ']')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = '@dsh-short-video-studio'
      tag.dataset.pluginCss = GEN_CSS_ID
      tag.textContent = GEN_CSS
      document.head.appendChild(tag)
    }
    ensureGenCss()

    const h = React.createElement

    // 访问令牌：插件静态页注入 __DSH_SVS_TOKEN__（同源可读，缓存在模块内）
    let svsTokenPromise = null
    function ensureSvsToken() {
      if (!svsTokenPromise) {
        svsTokenPromise = fetch(ROUTE_ROOT + '/?t=' + Date.now()).then((r) => r.text()).then((html) => {
          const m = html.match(/__DSH_SVS_TOKEN__\s*=\s*"([^"]+)"/)
          if (!m) throw new Error('插件令牌解析失败（studio 静态页未注入）')
          return m[1]
        }).catch((e) => { svsTokenPromise = null; throw e })
      }
      return svsTokenPromise
    }

    /** 通用插件 API（带 token；sessionId 用于工作区解析）。 */
    async function svsApi(sessionId, action, opts = {}) {
      const token = await ensureSvsToken()
      const method = opts.method || 'POST'
      const u = new URLSearchParams()
      if (sessionId) u.set('sessionId', sessionId)
      const res = await fetch(ROUTE_ROOT + '/api' + action + '?' + u.toString(), {
        method,
        headers: { 'content-type': 'application/json', 'x-dsh-svs-token': token },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      })
      if (!res.ok) {
        let msg = String(res.status)
        try { msg = (await res.json()).message || msg } catch { /* 保留状态码 */ }
        throw new Error(msg)
      }
      return res.json()
    }

    /** 画布媒体 URL（需要已解析的 token；token 未就绪返回空串）。 */
    function svsMediaUrl(sessionId, media, token) {
      if (!media || !token) return ''
      const u = new URLSearchParams({ token, sessionId, path: media })
      return ROUTE_ROOT + '/media?' + u.toString()
    }

    const GEN_RATIOS = { image: ['16:9', '9:16', '1:1', '4:3', '3:2'], video: ['16:9', '9:16', '1:1'] }
    const GEN_SECONDS = [
      { label: '≈3s', frames: 73 }, { label: '≈5s', frames: 124 }, { label: '≈8s', frames: 192 },
      { label: '≈10s', frames: 243 }, { label: '≈13s', frames: 310 },
    ]
    function svsDims(ratio, longSide) {
      const snap = (n) => Math.max(32, Math.round(n / 32) * 32)
      const [rw, rh] = String(ratio).split(/[:/x]/).map(Number)
      if (!rw || !rh) return { width: longSide, height: 768 }
      if (rw >= rh) return { width: longSide, height: snap(longSide * rh / rw) }
      return { width: snap(longSide * rw / rh), height: longSide }
    }

    const VIDEO_SKILL_HEAD = '/video-generate'

    /** 生成 video-generate 斜杠命令行（含参数；prompt 作为正文跟在空行后）。 */
    function svsVideoHeader(cur) {
      const dims = svsDims(cur.ratio, cur.tier === 'fast' ? 832 : 1344)
      let args = 'type=' + cur.pipeline + ' tier=' + cur.tier + ' ratio=' + cur.ratio
      args += ' size=' + dims.width + 'x' + dims.height + ' length=' + cur.seconds
      if (cur.pipeline === 'r2v') {
        args += ' refs=' + (cur.refs || []).map((r) => r.nodeId).join(',')
      } else {
        args += ' first=' + (cur.first ? cur.first.nodeId : '')
        if (cur.last) args += ' last=' + cur.last.nodeId
      }
      return VIDEO_SKILL_HEAD + ' ' + args
    }

    /** 从草稿里提取用户 prompt：/video-generate 命令行后第一个换行之后的正文；无命令行则整段视为 prompt。 */
    function svsPromptOf(draft) {
      const d = typeof draft === 'string' ? draft : ''
      if (d.startsWith(VIDEO_SKILL_HEAD)) {
        const i = d.indexOf('\n')
        return i >= 0 ? d.slice(i).replace(/^\n+/, '') : ''
      }
      return d
    }

    /** 用当前参数重写 /video-generate 命令行，保留用户已输入的 prompt（默认发送键提交的就是这条草稿）。 */
    function svsSetHeader(inputActions, cur, draft) {
      if (!inputActions || typeof inputActions.setDraft !== 'function' || !cur) return
      const p = svsPromptOf(draft)
      inputActions.setDraft(svsVideoHeader(cur) + (p ? '\n\n' + p : ''))
    }
    function readFileDataUrl(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result)
        fr.onerror = () => reject(new Error('读取失败：' + file.name))
        fr.readAsDataURL(file)
      })
    }
    function nowLabel() {
      const d = new Date()
      const p = (n) => String(n).padStart(2, '0')
      return d.getMonth() + 1 + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    /** 上传一张本地图到画布（返回画布节点），作为 r2v 参考 / i2v 首末帧。 */
    async function svsUploadRef(sessionId, file) {
      if (!file) throw new Error('未选择文件')
      if (file.size > 24 * 1024 * 1024) throw new Error('图片超过 24MB：' + file.name)
      const dataUrl = await readFileDataUrl(file)
      const d = await svsApi(sessionId, '/canvas/upload', { body: { files: [{ filename: file.name, dataUrl }], group: '手动生成·参考' } })
      const added = (d && d.added && d.added[0])
      if (!added) {
        const msg = (d && d.errors && d.errors[0] && d.errors[0].message) || '上传失败'
        throw new Error(msg)
      }
      return { name: file.name, dataUrl, nodeId: added.id, media: added.media }
    }

    function pickFile(accept, multiple, onPicked) {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = accept || 'image/*'
      input.multiple = !!multiple
      input.addEventListener('change', () => onPicked(Array.from(input.files || [])))
      input.click()
    }


    // ------------------------------------------------------------------
    // 生成模式 per-session store：input.left 工具行开关 与 composer 接管卡共享。
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // 生成模式 per-session store：input.left 开关 与 input.dock 参数条共享。
    // prompt 不在此存储——输入框就是 dsh 官方输入器，生成时读取其草稿。
    // ------------------------------------------------------------------
    const GEN_DEFAULT = { mode: 'chat', pipeline: 'r2v', tier: 'quality', ratio: '16:9', seconds: 124, refs: [], first: null, last: null, results: [] }
    const genStore = { map: new Map(), subs: new Map() }
    function genStateOf(sid) {
      if (sid == null || sid === '') return null
      if (!genStore.map.has(sid)) genStore.map.set(sid, { ...GEN_DEFAULT })
      return genStore.map.get(sid)
    }
    function genPatch(sid, patch) {
      const s = genStateOf(sid)
      if (!s) return
      Object.assign(s, patch)
      const subs = genStore.subs.get(sid)
      if (subs) for (const fn of Array.from(subs)) { try { fn(s) } catch (e) { console.warn('[dsh-short-video-studio] gen-store sub error:', e) } }
    }
    function useGenSession(sid) {
      const [state, setState] = React.useState(() => (genStateOf(sid) ? { ...genStateOf(sid) } : null))
      React.useEffect(() => {
        if (sid == null || sid === '') { setState(null); return }
        setState({ ...genStateOf(sid) })
        const fn = (s) => setState({ ...s })
        let arr = genStore.subs.get(sid)
        if (!arr) { arr = []; genStore.subs.set(sid, arr) }
        arr.push(fn)
        return () => {
          const list = genStore.subs.get(sid) || []
          const i = list.indexOf(fn)
          if (i >= 0) list.splice(i, 1)
          if (!list.length) genStore.subs.delete(sid)
        }
      }, [sid])
      return state
    }
    function seg(options, value, onChange) {
      return h('div', { className: 'svsg-seg', role: 'group' },
        options.map((o) => h('button', { key: o[0], type: 'button', className: value === o[0] ? 'on' : '', onClick: () => onChange(o[0]) }, o[1])))
    }

    /** input.left 工具行开关：共用 dsh 输入框；点「🎬 视频」把 video-generate 参数头写入草稿。 */
    function GenToggle(props) {
      const sessionId = props.sessionId
      const st = useGenSession(sessionId)
      const active = st ? st.mode : 'chat'
      if (!sessionId) return null
      const go = (mode) => {
        const nextMode = active === mode ? 'chat' : mode
        genPatch(sessionId, { mode: nextMode })
        const cur = genStateOf(sessionId)
        const draft = props.input && typeof props.input.draft === 'string' ? props.input.draft : ''
        const ia = props.inputActions
        if (nextMode === 'video') {
          svsSetHeader(ia, cur, draft)
        } else if (nextMode === 'chat') {
          if (ia && typeof ia.setDraft === 'function') ia.setDraft(svsPromptOf(draft))
        }
      }
      return h('div', { className: 'svsg-tools', role: 'group', title: '生成模式：点「🎬 视频」把 /video-generate 斜杠命令（含参数）写入输入框加载 skill；发送用 dsh 默认发送键' },
        h('button', { type: 'button', className: 'svsg-tool' + (active === 'image' ? ' on' : ''), title: '图片生成（文生图，后续接入）', onClick: () => go('image') }, '🎨 图片'),
        h('button', { type: 'button', className: 'svsg-tool' + (active === 'video' ? ' on' : ''), title: '视频生成：加载 video-generate skill（r2v 参考图 / i2v 首末帧）', onClick: () => go('video') }, '🎬 视频'),
      )
    }




    /**
     * input.dock 生成工具条（video-generate skill 的可视化入口）：
     * 点「🎬 视频」把 video-generate 参数头写入官方输入框草稿；prompt 接着写在
     * 官方输入框，参数一变就重写头部、保留 prompt。发送用 dsh 默认发送键（提交整条
     * 草稿），不额外做发送按钮、不劫持 Enter。
     */
    function GenStrip(props) {
      const sessionId = props.sessionId
      const st = useGenSession(sessionId)
      const [error, setError] = React.useState('')
      const [tip, setTip] = React.useState('')
      const [token, setToken] = React.useState('')
      const draftRef = React.useRef('')
      React.useEffect(() => { ensureSvsToken().then(setToken).catch(() => setToken('')) }, [])
      const mode = st ? st.mode : 'chat'
      if (!sessionId || !st || st.mode === 'chat') return null
      const draft = props.input && typeof props.input.draft === 'string' ? props.input.draft : ''
      draftRef.current = draft
      const dims = svsDims(st.ratio, st.tier === 'fast' ? 832 : 1344)
      const inputActions = props.inputActions
      const mediaUrl = (media) => svsMediaUrl(sessionId, media, token)

      // 参数变化：更新 store 并重写草稿头部（保留 prompt）
      function mutate(patch) {
        const cur = genStateOf(sessionId)
        if (!cur) return
        const next = Object.assign({}, cur, patch)
        genPatch(sessionId, patch)
        svsSetHeader(inputActions, next, draftRef.current)
      }

      function removeCanvasNode(nodeId) {
        if (!nodeId) return
        svsApi(sessionId, '/canvas/node?id=' + encodeURIComponent(nodeId), { method: 'DELETE' }).catch(() => {})
      }
      function pickUploadRef(role) {
        pickFile('image/png,image/jpeg,image/webp,image/gif', role === 'r2v', async (files) => {
          setError(''); setTip('')
          for (const f of files) {
            try {
              const rec = await svsUploadRef(sessionId, f)
              const cur = genStateOf(sessionId)
              if (!cur) continue
              const recRec = { nodeId: rec.nodeId, name: rec.name, media: rec.media }
              if (role === 'r2v') mutate({ refs: [...cur.refs, recRec].slice(0, 8) })
              else if (role === 'first') { if (cur.first) removeCanvasNode(cur.first.nodeId); mutate({ first: recRec }) }
              else { if (cur.last) removeCanvasNode(cur.last.nodeId); mutate({ last: recRec }) }
            } catch (e) {
              setError('上传失败：' + (e && e.message ? e.message : String(e)))
            }
          }
        })
      }
      function dropRef(index) {
        const cur = genStateOf(sessionId)
        if (!cur) return
        const rec = cur.refs[index]
        if (rec) removeCanvasNode(rec.nodeId)
        mutate({ refs: cur.refs.filter((_, i) => i !== index) })
      }
      function dropFrame(which) {
        const cur = genStateOf(sessionId)
        if (!cur || !cur[which]) return
        removeCanvasNode(cur[which].nodeId)
        mutate({ [which]: null })
      }
      function sel(options, value, onChange) {
        return h('select', { className: 'svsg-select', value, onChange: (e) => onChange(e.target.value) },
          options.map((o) => h('option', { key: o[0], value: o[0] }, o[1])))
      }

      if (mode === 'image') {
        return h('div', { className: 'svsg-strip' },
          h('div', { className: 'inner' },
            h('div', { className: 'svsg-row' },
              h('span', { className: 'svsg-hint' }, '🎨 图片生成将在后续版本接入（当前仅视频生成可用），先切到「🎬 视频」体验。'),
            ),
          ),
        )
      }

      const uploadRow = st.pipeline === 'r2v'
        ? h('div', { className: 'svsg-row' },
            st.refs.map((r, i) => h('div', { key: r.nodeId + '-' + i, className: 'svsg-chip' },
              r.media ? h('img', { src: mediaUrl(r.media), alt: '' }) : null,
              h('span', { className: 'n' }, r.name),
              h('button', { type: 'button', className: 'x', title: '移除（画布节点一并删除）', onClick: () => dropRef(i) }, '✕'),
            )),
            st.refs.length < 8
              ? h('button', { type: 'button', className: 'svsg-upload', onClick: () => pickUploadRef('r2v') }, '＋ 参考图')
              : null,
          )
        : h('div', { className: 'svsg-row' },
            (st.first
              ? h('div', { className: 'svsg-chip' },
                  st.first.media ? h('img', { src: mediaUrl(st.first.media), alt: '' }) : null,
                  h('span', { className: 'n' }, '首帧 · ' + st.first.name),
                  h('button', { type: 'button', className: 'x', title: '移除', onClick: () => dropFrame('first') }, '✕'))
              : h('button', { type: 'button', className: 'svsg-upload', onClick: () => pickUploadRef('first') }, '＋ 首帧')),
            (st.last
              ? h('div', { className: 'svsg-chip' },
                  st.last.media ? h('img', { src: mediaUrl(st.last.media), alt: '' }) : null,
                  h('span', { className: 'n' }, '末帧 · ' + st.last.name),
                  h('button', { type: 'button', className: 'x', title: '移除', onClick: () => dropFrame('last') }, '✕'))
              : h('button', { type: 'button', className: 'svsg-upload', onClick: () => pickUploadRef('last') }, '＋ 末帧（可选）')),
          )

      return h('div', { className: 'svsg-strip' },
        h('div', { className: 'inner' },
          h('div', { className: 'svsg-row' },
            h('span', { className: 'svsg-skill' }, '🎬 video-generate 已加载'),
            h('span', { className: 'svsg-lbl' }, '类型'),
            sel([['r2v', 'r2v 参考图'], ['i2v', 'i2v 首/末帧']], st.pipeline, (v) => { mutate({ pipeline: v }); setTip(''); setError('') }),
            h('span', { className: 'svsg-lbl' }, '档位'),
            sel([['quality', 'quality'], ['fast', 'fast']], st.tier, (v) => mutate({ tier: v })),
            h('span', { className: 'svsg-lbl' }, '比例'),
            sel(GEN_RATIOS.video.map((r) => [r, r]), st.ratio, (v) => mutate({ ratio: v })),
            h('span', { className: 'svsg-lbl' }, '时长'),
            sel(GEN_SECONDS.map((s) => [s.frames, s.label]), st.seconds, (v) => mutate({ seconds: v })),
            h('span', { className: 'svsg-hint' }, '尺寸 ' + dims.width + '×' + dims.height),
          ),
          uploadRow,
          h('div', { className: 'svsg-row' },
            h('span', { className: 'svsg-hint' }, '已把 /video-generate 命令行写入输入框；prompt 写在空行后，改参数会自动更新命令行，直接点 dsh 发送键出片。'),
          ),
          (tip || error) ? h('div', { className: tip ? 'svsg-tip' : 'svsg-error' }, tip || error) : null,
        ),
      )
    }


    function apply(ctx) {
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'short-video-canvas',
        order: 20,
        label: '画布',
      }, CanvasView))

      // 输入框生成模式（共用 dsh 输入框 + 默认发送键）：工具行左端开关 + 输入卡上方 video-generate 工具条。
      try {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'svs-generator-toggle',
          order: 10,
          inject: (sessionId) => ({ sessionId }),
        }, GenToggle))
      } catch (e) {
        console.warn('[dsh-short-video-studio] conversation.input.left 注册失败（可忽略；生成入口不可用）:', e)
      }
      try {
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'svs-generator-strip',
          order: 30,
          inject: (sessionId) => ({ sessionId }),
        }, GenStrip))
      } catch (e) {
        console.warn('[dsh-short-video-studio] conversation.input.dock 注册失败（可忽略；生成参数条不可用）:', e)
      }

      // DSH 设置页新增「ComfyUI」一级设置段
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'comfyui',
          order: 120,
          label: () => 'ComfyUI',
        }, ComfyUISettings))
      } catch (e) {
        console.warn('[dsh-short-video-studio] settings.section 注册失败:', e)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
