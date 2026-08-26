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

    function apply(ctx) {
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'short-video-canvas',
        order: 20,
        label: '画布',
      }, CanvasView))

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
