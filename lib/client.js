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

    function ComfyUISettings() {
      const [cfg, setCfg] = React.useState(null)
      const [msg, setMsg] = React.useState('加载中…')

      React.useEffect(() => {
        fetch(CONFIG_API).then((r) => r.json()).then((d) => {
          if (d && d.ok) { setCfg(d.config); setMsg('') }
          else setMsg('加载配置失败')
        }).catch(() => setMsg('加载配置失败'))
      }, [])

      if (!cfg) return React.createElement('div', { style: { padding: 16 } }, msg)

      const setTop = (k, v) => setCfg({ ...cfg, [k]: v })
      const setModel = (k, v) => setCfg({ ...cfg, models: { ...cfg.models, [k]: v } })
      const field = (label, key, value, onChange, type) =>
        React.createElement('label', { key, style: { display: 'block', margin: '6px 0' } },
          React.createElement('span', null, label),
          React.createElement('input', {
            value: value ?? '', type: type || 'text',
            style: { width: '100%', boxSizing: 'border-box', padding: '6px 8px', marginTop: 3 },
            onChange: (e) => onChange(e.target.value),
          }),
        )

      const save = () => {
        setMsg('保存中…')
        fetch(CONFIG_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg) })
          .then((r) => r.json()).then((d) => setMsg(d && d.ok ? '已保存 ✓' : '保存失败: ' + ((d && d.error) || '')))
          .catch((e) => setMsg('保存失败: ' + e))
      }

      const models = cfg.models || {}
      return React.createElement('div', { style: { padding: 16, maxWidth: 720 } },
        React.createElement('h3', null, 'ComfyUI'),
        React.createElement('p', null, '配置生成服务（FLUX 图片 / MiniMax H3 视频）。保存后即时生效，写入 ~/.dsh/dsh-short-video-studio.json。'),
        field('ComfyUI 服务地址 baseUrl', 'baseUrl', cfg.baseUrl, (v) => setTop('baseUrl', v)),
        field('API Key（可选）', 'apiKey', cfg.apiKey, (v) => setTop('apiKey', v), 'password'),
        field('轮询间隔 pollMs', 'pollMs', cfg.pollMs, (v) => setTop('pollMs', v)),
        field('生成超时 timeoutMs', 'timeoutMs', cfg.timeoutMs, (v) => setTop('timeoutMs', v)),
        React.createElement('hr', null),
        React.createElement('h4', null, '模型（可选，留空用默认）'),
        field('FLUX UNet', 'fluxUnet', models.fluxUnet, (v) => setModel('fluxUnet', v)),
        field('FLUX CLIP', 'fluxClip', models.fluxClip, (v) => setModel('fluxClip', v)),
        field('FLUX VAE', 'fluxVae', models.fluxVae, (v) => setModel('fluxVae', v)),
        field('H3 参考 UNet', 'h3RefUnet', models.h3RefUnet, (v) => setModel('h3RefUnet', v)),
        field('H3 CLIP', 'h3Clip', models.h3Clip, (v) => setModel('h3Clip', v)),
        field('H3 视频 VAE', 'h3VideoVae', models.h3VideoVae, (v) => setModel('h3VideoVae', v)),
        field('H3 音频 VAE', 'h3AudioVae', models.h3AudioVae, (v) => setModel('h3AudioVae', v)),
        field('H3 fast LoRA', 'h3FastLora', models.h3FastLora, (v) => setModel('h3FastLora', v)),
        field('H3 FPS', 'h3Fps', models.h3Fps, (v) => setModel('h3Fps', v)),
        React.createElement('button', { onClick: save, style: { marginTop: 12, padding: '8px 16px' } }, '保存'),
        React.createElement('span', { style: { marginLeft: 12 } }, msg),
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
