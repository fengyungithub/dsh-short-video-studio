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
    // 档位词汇表（受控枚举，与 lib/manifest.js 的 TIERS 一致）
    const TIER_OPTIONS = ['fast', 'balanced', 'quality']

    function ComfyUISettings() {
      const [cfg, setCfg] = React.useState(null)
      const [registry, setRegistry] = React.useState(null)
      const [selWorkflow, setSelWorkflow] = React.useState('')
      const [importText, setImportText] = React.useState('')
      const [importId, setImportId] = React.useState('')
      const [importCapability, setImportCapability] = React.useState('image.text2image')
      const [importName, setImportName] = React.useState('')
      const [importGroup, setImportGroup] = React.useState('')
      const [importTier, setImportTier] = React.useState('')
      const [msg, setMsg] = React.useState('加载中…')
      // 新增策略表单：哪个能力展开着、策略名、逐档选择
      const [newStratCap, setNewStratCap] = React.useState('')
      const [newStratName, setNewStratName] = React.useState('')
      const [newStratTiers, setNewStratTiers] = React.useState({})
      const [editStratCap, setEditStratCap] = React.useState('')
      const [editStratId, setEditStratId] = React.useState('')
      const [renameCap, setRenameCap] = React.useState('')
      const [renameId, setRenameId] = React.useState('')
      const [renameText, setRenameText] = React.useState('')

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
      // 字段行统一栅格：左标签定宽 + 右控件撑满剩余宽度（minmax(0,1fr) 保证能收缩、不顶破边框）
      const field = (label, value, onChange, type) =>
        React.createElement('label', { style: { display: 'grid', gridTemplateColumns: '190px minmax(0, 1fr)', gap: 10, alignItems: 'center', margin: '6px 0', minWidth: 0 } },
          React.createElement('span', { title: label, style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #cfd3d6)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
          React.createElement('input', {
            value: value ?? '', type: type || 'text',
            style: ctrlStyle,
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

      // ---- 档位选择（策略＝整组预设快照；逐档下拉＝自由组合）------------------
      const saveTiers = (next, okMsg) => {
        setCfg(next)
        post(CONFIG_API, next, 'POST')
          .then((d) => {
            setMsg(d && d.ok ? okMsg + ' ✓' : '保存失败: ' + ((d && d.error) || (d && d.errors) || ''))
            if (d && d.ok) return refreshRegistry()
          })
          .catch((e) => setMsg('保存失败: ' + e))
      }
      // 策略＝**用户自己命名的档位组合**（内置默认那条＝跟随注册表首选）。
      // 选中内置默认 → 清空该能力的显式选择（跟随注册表首选，不再被快照冻住）；
      // 选中用户策略 → 写入它的档位快照（点选即快照，不做活引用）。
      const applyStrategy = (cap, strategy) => {
        const tiers = { ...(cfg.tiers || {}) }
        if (strategy.builtin) delete tiers[cap]
        else tiers[cap] = { ...strategy.tiers }
        saveTiers({ ...cfg, tiers, strategyOf: { ...(cfg.strategyOf || {}), [cap]: strategy.id } }, `已应用策略「${strategy.label}」`)
      }
      const setTier = (cap, tier, wid) =>
        saveTiers({ ...cfg, tiers: { ...(cfg.tiers || {}), [cap]: { ...((cfg.tiers || {})[cap] || {}), [tier]: wid } } }, `已切换 ${cap} · ${tier} 档`)

      // ---- 用户策略：新增 / 重命名 / 删除（写入 cfg.strategies，按能力分组）---------
      const strategiesOf = (cap) => {
        const raw = (cfg.strategies || {})[cap]
        return Array.isArray(raw) ? raw : []
      }
      const saveStrategies = (cap, list, okMsg, extra = {}) =>
        saveTiers({ ...cfg, strategies: { ...(cfg.strategies || {}), [cap]: list }, ...extra }, okMsg)
      // 新增与编辑共用一套表单：编辑＝就地替换该策略（id 不变）并重新选用
      const saveStrategyForm = (cap) => {
        if (editStratCap === cap && editStratId) return updateStrategy(cap, editStratId)
        return addStrategy(cap)
      }
      const updateStrategy = (cap, id) => {
        const name = newStratName.trim()
        if (!name) { setMsg('请先填策略名'); return }
        const tiers = {}
        for (const [t, v] of Object.entries(newStratTiers)) if (v) tiers[t] = v
        if (!Object.keys(tiers).length) { setMsg('至少挑一个档位（≥1 个即可，只挑一个也行）'); return }
        const clash = strategiesOf(cap).some((s) => s.id !== id && (s.name || '').trim() === name)
        if (clash) { setMsg('同名策略已存在：' + name); return }
        saveStrategies(cap, strategiesOf(cap).map((s) => (s.id === id ? { ...s, name, tiers } : s)), `已更新策略「${name}」`, {
          tiers: { ...(cfg.tiers || {}), [cap]: { ...tiers } },
          strategyOf: { ...(cfg.strategyOf || {}), [cap]: id },
        })
        setNewStratCap(''); setNewStratName(''); setNewStratTiers({}); setEditStratCap(''); setEditStratId('')
      }
      const addStrategy = (cap) => {
        const name = newStratName.trim()
        if (!name) { setMsg('请先填策略名'); return }
        const tiers = {}
        for (const [t, v] of Object.entries(newStratTiers)) if (v) tiers[t] = v
        if (!Object.keys(tiers).length) { setMsg('至少挑一个档位（≥1 个即可，只挑一个也行）'); return }
        if (strategiesOf(cap).some((s) => (s.name || '').trim() === name)) { setMsg('同名策略已存在：' + name); return }
        const id = 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
        // 新增即选用：写策略清单 + 该能力的档位快照 + 选中标记
        saveStrategies(cap, [...strategiesOf(cap), { id, name, tiers }], `已新增并选用策略「${name}」`, {
          tiers: { ...(cfg.tiers || {}), [cap]: { ...tiers } },
          strategyOf: { ...(cfg.strategyOf || {}), [cap]: id },
        })
        setNewStratCap(''); setNewStratName(''); setNewStratTiers({})
      }
      const renameStrategy = (cap, id) => {
        const name = renameText.trim()
        if (!name) { setMsg('策略名不能为空'); return }
        saveStrategies(cap, strategiesOf(cap).map((s) => (s.id === id ? { ...s, name } : s)), `已重命名为「${name}」`)
        setRenameCap(''); setRenameId(''); setRenameText('')
      }
      const deleteStrategy = (cap, id, name) => {
        if (!window.confirm('删除策略「' + name + '」？（只删这条策略，当前档位选择保持原样）')) return
        const extra = {}
        if ((cfg.strategyOf || {})[cap] === id) extra.strategyOf = { ...(cfg.strategyOf || {}), [cap]: '' }
        saveStrategies(cap, strategiesOf(cap).filter((s) => s.id !== id), '已删除策略「' + name + '」', extra)
      }

      const importWf = () => {
        let m
        try { m = JSON.parse(importText) } catch (e) { setMsg('JSON 解析失败: ' + e); return }
        const isRaw = m && typeof m === 'object' && !Array.isArray(m) && m.id === undefined && m.graph === undefined
        let payload = m
        if (isRaw) {
          if (!importCapability) { setMsg('原始导出需填写「能力 capability」'); return }
          if (!importId && !(importGroup && importTier)) { setMsg('原始导出需填写「工作流 id」，或填「组名 + 档位」由系统按 <组名>-<档位> 命名'); return }
          payload = {
            raw: m, id: importId || undefined, capability: importCapability, displayName: importName || importId || importGroup,
            group: importGroup || undefined, tier: importTier || undefined,
          }
        } else if (importTier || importGroup) {
          // 清单 JSON 导入：表单里的组名/档位覆盖清单字段（同名成组、一档一文件）
          payload = { ...m, group: importGroup || m.group, tier: importTier || m.tier }
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

      // ---- 统一控件与栅格样式（防溢出：所有可收缩容器都带 minWidth:0）-------
      // 统一高度：input/select/button 同高（浏览器默认渲染高度不一致，会显得"排不齐"）
      const ctrlStyle = {
        width: '100%', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', height: 30,
        padding: '0 8px', borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2, #ffffff1f)',
        background: 'var(--dsw-alias-bg-layer-1, #232324)',
        color: 'var(--dsw-alias-label-primary, #f9fafb)',
        colorScheme: 'inherit',
      }
      const btnStyle = {
        height: 30, boxSizing: 'border-box', padding: '0 16px', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
        border: '1px solid var(--dsw-alias-border-l2, #ffffff1f)',
        background: 'var(--dsw-alias-interactive-bg-hover, #ffffff14)',
        color: 'var(--dsw-alias-label-primary, #f9fafb)',
      }
      // auto-fit：窄面板自动从 3 列折成 2/1 列，永远不会把控件挤出边框
      const grid2 = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 8 }
      const grid3 = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 8 }
      const small = { color: 'var(--dsw-alias-label-secondary, #cfd3d6)', fontSize: 12, margin: '4px 0', lineHeight: 1.6, overflowWrap: 'anywhere', minWidth: 0 }
      // 11px 小字用 secondary 而非 caption：caption 在浅色主题下只有 3.7:1（低于 AA 4.5）
      const noteStyle = { ...small, fontSize: 11, color: 'var(--dsw-alias-label-secondary, #cfd3d6)', margin: '3px 0 0', lineHeight: 1.5 }
      const formField = (label, control) => React.createElement('label', { style: { display: 'block', minWidth: 0 } },
        React.createElement('span', { style: { display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #cfd3d6)', marginBottom: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
        control,
      )

      // 档位下拉的选项文本：只放**短 id + 加速标记 + 实测耗时 + 可用性**。
      // 不要在这里放长显示名/长 id——option 文本会撑大 select 的 min-content 宽度，
      // 把控件顶出容器边框（这是配置页溢出的根因）。完整 id 放控件下方提示行。
      const optionLabel = (short, w) => {
        let t = short
        if (w.accel) t += ' ⚡' + w.accel
        t += w.estSeconds ? ' · 约 ' + Math.round(w.estSeconds) + 's' : ' · 耗时未知'
        if (w.available === false) t += ' ✗ 缺 ' + (w.missingNodes || []).join('、')
        else if (w.available === null) t += ' ? 可用性未知'
        return t
      }

      // 分档能力：策略条目（整组预设）+ 逐档实现（自由组合）+ 未分级清单
      const tieredBlock = (c) => {
        const cur = (cfg.tiers || {})[c.capability] || {}
        const groups = c.groups || []
        const shortIdOf = (id) => {
          const g = groups.find((x) => id.startsWith(x.id + '-'))
          return g ? id.slice(g.id.length + 1) : id
        }
        const accelOf = (id) => (((c.workflows || []).find((x) => x.id === id)) || {}).accel || ''
        // 策略：一条**内置默认** + 用户自建（可命名、可删除）。
        // 选中态由注册表算好（s.selected）；都不匹配 → 显示「自定义」并允许用户把它存成一条命名策略。
        const strategies = c.strategies || []
        // 只列**这条策略提供**的档位：没挑的档位不属于它（不是"跟随默认"），故不写出来
        const tierSummary = (s) => (c.tiers || []).filter((t) => (s.tiers || {})[t]).map((t) => {
          const id = s.tiers[t]
          return t + ' → ' + shortIdOf(id) + (accelOf(id) ? ' ⚡' : '')
        }).join('　｜　') || '（未指定档位）'
        const strategyRow = (s) =>
          React.createElement('div', { key: s.id, style: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', gap: 6, alignItems: 'start', margin: '5px 0' } },
            React.createElement('input', {
              type: 'radio', name: 'strategy-' + c.capability, checked: Boolean(s.selected), style: { marginTop: 3 },
              onChange: () => applyStrategy(c.capability, s),
            }),
            React.createElement('span', { style: { minWidth: 0, cursor: 'pointer' }, onClick: () => applyStrategy(c.capability, s) },
              React.createElement('span', { style: { display: 'block' } }, s.label + (s.builtin ? '' : '') + (s.available === false ? ' ✗ 所选实现缺节点' : '')),
              React.createElement('span', { style: { display: 'block', ...noteStyle } }, tierSummary(s)),
            ),
            s.builtin
              ? React.createElement('span', { style: noteStyle }, '内置默认')
              : React.createElement('span', { style: { display: 'flex', gap: 4 } },
                  renameCap === c.capability && renameId === s.id
                    ? React.createElement(React.Fragment, null,
                        React.createElement('input', { value: renameText, onChange: (e) => setRenameText(e.target.value), style: { ...ctrlStyle, width: 120, padding: '2px 6px' } }),
                        React.createElement('button', { onClick: () => renameStrategy(c.capability, s.id), style: { ...btnStyle, padding: '2px 8px', fontSize: 12 } }, '存'),
                        React.createElement('button', { onClick: () => { setRenameCap(''); setRenameId('') }, style: { ...btnStyle, padding: '2px 8px', fontSize: 12 } }, '取消'),
                      )
                    : React.createElement(React.Fragment, null,
                        React.createElement('button', { onClick: () => { setRenameCap(c.capability); setRenameId(s.id); setRenameText(s.label) }, style: { ...btnStyle, padding: '2px 8px', fontSize: 12 } }, '重命名'),
                        React.createElement('button', {
                          onClick: () => {
                            if (editStratCap === c.capability && editStratId === s.id) { setEditStratCap(''); setEditStratId('') } else {
                              setEditStratCap(c.capability); setEditStratId(s.id)
                              setNewStratCap(c.capability); setNewStratName(s.label); setNewStratTiers({ ...(s.tiers || {}) })
                            }
                          },
                          style: { ...btnStyle, padding: '2px 8px', fontSize: 12 },
                        }, '编辑档位'),
                        React.createElement('button', { onClick: () => deleteStrategy(c.capability, s.id, s.label), style: { ...btnStyle, padding: '2px 8px', fontSize: 12 } }, '删除'),
                      ),
                ),
          )
        const anySelected = strategies.some((s) => s.selected)
        const strategyRows = strategies.map(strategyRow)
        if (!anySelected && Object.keys(cur).length) {
          strategyRows.push(React.createElement('div', { key: '__custom', style: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 6, margin: '5px 0' } },
            React.createElement('input', { type: 'radio', name: 'strategy-' + c.capability, checked: true, readOnly: true, style: { marginTop: 3 } }),
            React.createElement('span', { style: noteStyle }, '自定义（逐档自由组合，未保存为策略）'),
          ))
        }

        // 「新增策略」表单：起名 + 逐档从现有清单里挑（跨组自由组合），保存后立即可用
        const editing = editStratCap === c.capability && Boolean(editStratId)
        const newStrategyForm = newStratCap === c.capability
          ? React.createElement('div', { style: { margin: '6px 0 2px', padding: '8px 10px', border: '1px dashed var(--dsw-alias-border-l2, #ffffff26)', borderRadius: 8 } },
              React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr)', gap: 10, alignItems: 'center', margin: '2px 0' } },
                React.createElement('span', { style: small }, '策略名'),
                React.createElement('input', { value: newStratName, placeholder: '例如：快出片（PDD + Sol）', onChange: (e) => setNewStratName(e.target.value), style: ctrlStyle }),
              ),
              React.createElement('div', { style: { ...noteStyle, margin: '2px 0 4px' } },
                '只挑你关心的档位就行（≥1 个即可，挑一个两个都可以）。没挑的档位不属于这条策略：请求那个档位会显式报错，不会回退到别的实现——想全都能出就三档都挑。'),
              (c.tiers || []).map((tier) => {
                const withTier = groups.filter((g) => ((g.tiers || {})[tier] || []).length > 0)
                return React.createElement('div', { key: 'ns-' + tier, style: { display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr)', gap: 10, alignItems: 'center', margin: '5px 0' } },
                  React.createElement('span', { style: small }, tier),
                  React.createElement('select', { value: newStratTiers[tier] || '', onChange: (e) => setNewStratTiers({ ...newStratTiers, [tier]: e.target.value }), style: ctrlStyle },
                    React.createElement('option', { value: '' }, '（不选＝这条策略不含这一档）'),
                    withTier.map((g) => React.createElement('optgroup', { key: g.id, label: g.displayName },
                      (g.tiers[tier] || []).map((w) => React.createElement('option', { key: w.id, value: w.id, disabled: w.available === false }, optionLabel(shortIdOf(w.id), w))))),
                  ),
                )
              }),
              React.createElement('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
                React.createElement('button', { onClick: () => saveStrategyForm(c.capability), style: { ...btnStyle, padding: '3px 12px', fontSize: 12 } }, editing ? '保存修改' : '保存并选用'),
                React.createElement('button', { onClick: () => { setNewStratCap(''); setNewStratName(''); setNewStratTiers({}); setEditStratCap(''); setEditStratId('') }, style: { ...btnStyle, padding: '3px 12px', fontSize: 12 } }, '取消'),
              ),
            )
          : null

        // 逐档区只显示**当前策略提供的档位**：策略不含的档位不出现（不是显示成"默认"）——
        // 「没这个档位」与「有这个档位但没单独选」是两件事，回显上必须区分开。
        const ownedTiers = Array.isArray(c.availableTiers) && c.availableTiers.length ? c.availableTiers : null
        const shownTiers = (c.tiers || []).filter((t) => !ownedTiers || ownedTiers.includes(t))
        const tierRows = shownTiers.map((tier) => {
          const withTier = groups.filter((g) => ((g.tiers || {})[tier] || []).length > 0)
          const flat = withTier.flatMap((g) => (g.tiers[tier] || []).map((w) => ({ w, g })))
          const first = flat.length ? flat[0].w : null
          const opts = withTier.map((g) => React.createElement('optgroup', { key: g.id, label: g.displayName },
            (g.tiers[tier] || []).map((w) => React.createElement('option', { key: w.id, value: w.id, disabled: w.available === false },
              optionLabel(shortIdOf(w.id), w)))))
          const effId = cur[tier] || (first ? first.id : '')
          const eff = flat.find((x) => x.w.id === effId)
          const miss = eff && eff.w.available === false ? '　✗ 缺节点 ' + (eff.w.missingNodes || []).join('、') : ''
          return React.createElement('div', { key: tier, style: { display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr)', gap: 10, alignItems: 'center', margin: '7px 0' } },
            React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #cfd3d6)' } }, tier),
            React.createElement('div', { style: { minWidth: 0 } },
              React.createElement('select', { value: cur[tier] || '', style: ctrlStyle, onChange: (e) => setTier(c.capability, tier, e.target.value) },
                React.createElement('option', { value: '' }, first ? '默认（注册表首选：' + shortIdOf(first.id) + '）' : '（该档无实现）'),
                opts,
              ),
              React.createElement('div', { style: noteStyle },
                '实际使用：' + (effId || '—') + (cur[tier] ? '' : '（未单独选择，跟随注册表首选）') + miss + (eff && eff.w.note ? '　· ' + eff.w.note : '')),
            ),
          )
        })
        const unclassified = (c.unclassified || []).length
          ? React.createElement('div', { style: small }, '未分级清单（不可用于档位解析，只能显式 workflow= 调用）：' + c.unclassified.map((w) => w.id).join('、'))
          : null
        const userRows = (c.workflows || []).filter((w) => w.source === 'user').map((w) =>
          React.createElement('div', { key: w.id, style: { ...small, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center', margin: '2px 0' } },
            React.createElement('span', { style: { minWidth: 0 } }, '用户清单：' + w.id + (w.tier ? '（' + w.tier + ' 档）' : '（未分级）')),
            React.createElement('button', { onClick: () => deleteWf(w.id), style: { ...btnStyle, padding: '2px 10px', fontSize: 12 } }, '删除'),
          ),
        )
        return React.createElement('div', { key: c.capability, style: { margin: '10px 0', padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l1, #ffffff0f)', borderRadius: 8, minWidth: 0 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            React.createElement('strong', null, c.capability),
            React.createElement('span', { style: { ...small, margin: 0 } }, '档位：' + (c.tiers || []).join(' / ')),
          ),
          React.createElement('div', { style: { ...small, margin: '2px 0 6px' } }, '策略＝一套档位组合（点选即写入配置快照）；也可以逐档自由组合，或「新增策略」把它存成自己的命名策略。'),
          strategyRows.length
            ? React.createElement('div', null,
                React.createElement('div', { style: { ...small, margin: '4px 0 2px' } }, '策略（单选）：内置默认＝跟随注册表首选；自建策略只提供它挑过的档位（没有的档位下面不显示、请求会显式报错）'),
                strategyRows,
                React.createElement('div', { style: { margin: '4px 0 2px' } },
                  React.createElement('button', { onClick: () => { const open = newStratCap === c.capability && !editing; setNewStratCap(open ? '' : c.capability); setNewStratName(''); setNewStratTiers({}); setEditStratCap(''); setEditStratId('') }, style: { ...btnStyle, padding: '2px 10px', fontSize: 12 } },
                    newStratCap === c.capability && !editing ? '取消新增' : '＋ 新增策略（命名 + 逐档组合）'),
                ),
              )
            : null,
          newStrategyForm,
          React.createElement('div', { style: { marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--dsw-alias-border-l1, #ffffff0f)' } }, tierRows),
          unclassified,
          userRows,
        )
      }

      // 未分档能力：保留「选默认实现」的旧交互
      const legacyBlock = (c) => {
        const defaultId = ((cfg.preferred && cfg.preferred[c.capability] && cfg.preferred[c.capability][0]))
          || (c.preferred && c.preferred[0])
          || (c.workflows[0] && c.workflows[0].id)
          || ''
        const rows = (c.workflows || []).filter((w) => !w.internal).map((w) =>
          React.createElement('label', { key: w.id, style: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', gap: 6, alignItems: 'center', margin: '4px 0' } },
            React.createElement('input', { type: 'radio', name: 'dflt-' + c.capability, checked: w.id === defaultId, onChange: () => setDefault(c.capability, w.id) }),
            React.createElement('span', { style: { minWidth: 0, overflowWrap: 'anywhere' } }, w.id + (w.modes && w.modes.length ? '　mode：' + w.modes.join('/') : '')),
            w.source === 'user'
              ? React.createElement('button', { onClick: () => deleteWf(w.id), style: { ...btnStyle, padding: '2px 10px', fontSize: 12 } }, '删除')
              : null,
          ),
        )
        return React.createElement('div', { key: c.capability, style: { margin: '10px 0', padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l1, #ffffff0f)', borderRadius: 8, minWidth: 0 } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
            React.createElement('strong', null, c.capability),
            React.createElement('span', { style: { ...small, margin: 0 } }, '未分档 · 按 mode 名解析'),
          ),
          rows,
        )
      }

      const capBlocks = capabilities.filter((c) => !(c.workflows || []).every((w) => w.internal)).map((c) => (c.tiered ? tieredBlock(c) : legacyBlock(c)))

      const assetRows = sel
        ? Object.entries(sel.assets || {}).map(([k, a]) => {
            const label = (a && (a.label || (a.env ? k + '（env: ' + a.env + '）' : k))) || k
            // 显示**实际生效值**（后端 effectiveAssets：显式覆盖 > 旧配置映射/别名 > 清单默认），
            // 避免界面显示 A、实际跑 B。
            const eff = (sel.effectiveAssets && sel.effectiveAssets[k] !== undefined) ? sel.effectiveAssets[k] : ((a && a.default) || '')
            const val = (overrides[sel.id] && overrides[sel.id][k] !== undefined) ? overrides[sel.id][k] : eff
            return field(label, val, (v) => {
              const wid = sel.id
              setCfg({ ...cfg, assetOverrides: { ...overrides, [wid]: { ...(overrides[wid] || {}), [k]: v } } })
            })
          })
        : []

      return React.createElement('div', { style: { padding: 16, maxWidth: 760, width: '100%', boxSizing: 'border-box', minWidth: 0 } },
        React.createElement('h3', null, 'ComfyUI'),
        React.createElement('p', null, '配置生成服务。换模型/换工作流均在此完成，保存后即时生效。'),
        React.createElement('h4', null, '连接'),
        field('ComfyUI 服务地址 baseUrl', cfg.baseUrl, (v) => setTop('baseUrl', v)),
        field('API Key（可选）', cfg.apiKey, (v) => setTop('apiKey', v), 'password'),
        field('轮询间隔 pollMs', cfg.pollMs, (v) => setTop('pollMs', v)),
        field('生成超时 timeoutMs', cfg.timeoutMs, (v) => setTop('timeoutMs', v)),
        React.createElement('h4', null, '工作流注册表（档位与实现）'),
        capBlocks,
        React.createElement('h4', null, '资产覆盖（换模型文件）'),
        React.createElement('select', { value: sel ? sel.id : '', onChange: (e) => setSelWorkflow(e.target.value), style: ctrlStyle },
          allWorkflows.map((w) => React.createElement('option', { key: w.id, value: w.id, title: w.id },
            (w.displayName && w.displayName !== w.id ? w.displayName + '（' + w.id + '）' : w.id) + (w.source === 'user' ? ' · 用户清单' : ''))),
        ),
        assetRows,
        React.createElement('h4', null, '导入工作流'),
        React.createElement('p', { style: small }, '一个文件＝一个档位实现。填「组名 + 档位」即自动归入同一组（组内同档多实现 = 可选加速件），id 留空时按 <组名>-<档位> 自动命名。'),
        React.createElement('div', { style: grid2 },
          formField('组名 group（同名成组）', React.createElement('input', { value: importGroup, placeholder: '如 test', style: ctrlStyle, onChange: (e) => setImportGroup(e.target.value) })),
          formField('档位 tier', React.createElement('select', { value: importTier, style: ctrlStyle, onChange: (e) => setImportTier(e.target.value) },
            React.createElement('option', { value: '' }, '（不分档，按 mode 名解析）'),
            TIER_OPTIONS.map((t) => React.createElement('option', { key: t, value: t }, t)),
          )),
        ),
        React.createElement('div', { style: grid3 },
          formField('工作流 id（留空自动命名）', React.createElement('input', { value: importId, placeholder: '如 test-quality', style: ctrlStyle, onChange: (e) => setImportId(e.target.value) })),
          formField('能力 capability', React.createElement('select', { value: importCapability, style: ctrlStyle, onChange: (e) => setImportCapability(e.target.value) },
            CAPABILITY_OPTIONS.map((c) => React.createElement('option', { key: c, value: c }, c)),
          )),
          formField('显示名（可选）', React.createElement('input', { value: importName, placeholder: '可选', style: ctrlStyle, onChange: (e) => setImportName(e.target.value) })),
        ),
        React.createElement('textarea', { value: importText, rows: 6, placeholder: '粘贴 Workflow Manifest JSON，或 ComfyUI「导出 API」的原始工作流 JSON（原始导出会自动转换）', style: { ...ctrlStyle, marginTop: 6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }, onChange: (e) => setImportText(e.target.value) }),
        React.createElement('div', { style: { marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          React.createElement('button', { onClick: importWf, style: btnStyle }, '导入'),
          React.createElement('button', { onClick: saveConfig, style: btnStyle }, '保存配置'),
          React.createElement('span', { style: { ...small, margin: 0, minWidth: 0, overflowWrap: 'anywhere' } }, msg),
        ),
        (registry.errors && registry.errors.length)
          ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary, #f25a5a)', marginTop: 8, overflowWrap: 'anywhere' } }, '清单校验错误：' + registry.errors.join('; '))
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
      '.svsg-seg button.on{background:var(--dsw-alias-state-business-tertiary,rgba(51,112,255,.16));color:var(--dsw-alias-label-primary,#e8eaf0);font-weight:600;box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary,rgba(91,140,255,.5))}',
      '.svsg-spacer{flex:1}',
      '.svsg-hint{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#9aa1b1);margin:0;min-width:0;overflow-wrap:anywhere}',
      '.svsg-panel{margin-top:6px;padding:10px;background:var(--dsw-alias-bg-elevated,rgba(28,31,40,.92));border:1px solid var(--dsw-alias-border-l1,#2e3342);border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.14)}',
      '.svsg-panel h4{margin:0 0 8px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.svsg-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}',
      '.svsg-lbl{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa1b1);white-space:nowrap}',
      '.svsg-grp{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
      '.svsg-ta{width:100%;box-sizing:border-box;min-height:72px;resize:vertical;border:1px solid var(--dsw-alias-border-l2,#3a4050);background:var(--dsw-alias-bg-base,#1b1e27);color:var(--dsw-alias-label-primary,#e8eaf0);border-radius:10px;padding:9px 11px;font:inherit;font-size:13px;outline:none}',
      '.svsg-ta:focus{border-color:var(--dsw-alias-state-business-primary,#5b8cff)}',
      '.svsg-select{background:var(--dsw-alias-bg-base,#1b1e27);color:var(--dsw-alias-label-primary,#e8eaf0);border:1px solid var(--dsw-alias-border-l2,#3a4050);border-radius:8px;padding:5px 8px;font-size:12.5px}',
      '.svsg-drop{border:1px dashed var(--dsw-alias-border-l2,#3a4050);border-radius:10px;padding:10px;background:var(--dsw-alias-bg-base,#1b1e27);display:flex;flex-direction:column;gap:8px;min-width:200px;flex:1}',
      '.svsg-drop .t{font-size:12px;color:var(--dsw-alias-label-secondary,#9aa1b1)}',
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
    '.svsg-tip{font-size:12px;color:var(--dsw-alias-state-success-primary,#3fba62);margin:4px 2px 0;line-height:1.5}',
    // 文本用 label-primary：强调色当文字时在深/浅两套主题下都只有 ~2.8-3.3:1（不达标）
    '.svsg-skill{display:inline-flex;align-items:center;gap:4px;background:var(--dsw-alias-state-business-tertiary,rgba(76,140,255,.16));color:var(--dsw-alias-label-primary,#e8eaf0);border:1px solid var(--dsw-alias-state-business-primary,rgba(76,140,255,.45));border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600;white-space:nowrap}',
    '.svsg-inner{box-sizing:border-box;margin:0 12px;padding:8px 10px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,134,145,.07));border:1px solid var(--dsw-alias-border-l1,#2e3342);border-radius:12px;min-width:0}',
    '.svsg-inner.svsg-dropon{border-color:var(--dsw-alias-state-business-primary,#5b8cff);border-style:dashed}',
    '.svsg-rail{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:6px;min-width:0}',
    '.svsg-slot{box-sizing:border-box;flex:0 0 64px;width:64px;height:64px;position:relative;border:1px solid var(--dsw-alias-border-l2-darkmode-thin);background:var(--dsw-alias-interactive-bg-hover);border-radius:16px;overflow:hidden;padding:0;display:flex;align-items:center;justify-content:center;font-family:inherit}',
    '.svsg-slot img{width:100%;height:100%;object-fit:cover;display:block}',
    '.svsg-slot .x{position:absolute;top:4px;right:4px;z-index:1;width:18px;height:18px;background:var(--dsw-alias-button-contrast-fill);color:var(--dsw-alias-label-primary-inverted);cursor:pointer;opacity:0;border:none;border-radius:50%;padding:0;display:grid;place-items:center;transition:opacity .2s ease-in-out;font-size:12px;line-height:1}',
    '.svsg-slot:hover .x,.svsg-slot .x:focus-visible{opacity:1}',
    '@media (pointer:coarse){.svsg-slot .x{opacity:1}}',
    '.svsg-slot.add{cursor:pointer;color:var(--dsw-alias-label-secondary,#9aa1b1)}',
    '.svsg-slot.add:hover{color:var(--dsw-alias-label-primary,#e8eaf0);border-color:var(--dsw-alias-state-business-primary,#5b8cff)}',
    '.svsg-slot.add:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#5b8cff);outline-offset:1px}',
    '.svsg-slot.add::after{content:"＋";font-size:24px;line-height:1;font-weight:400}',
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

    // 标签 + 控件必须作为一个不可拆分的整体换行：否则窄宽度下会出现
    // 「标签留在上一行末尾、控件被挤到下一行」的错位（实测 720px 宽就会发生）。
    const grp = (label, control) => h('span', { className: 'svsg-grp' },
      label ? h('span', { className: 'svsg-lbl' }, label) : null,
      control,
    )

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
      // action 可能自带 query（如 /canvas/node?id=…）：此时用 & 拼接，避免第二个 ?
      // 把 sessionId 吞进参数值导致 400「sessionId required」
      let apiUrl = ROUTE_ROOT + '/api' + action
      if (sessionId) apiUrl += (action.indexOf('?') >= 0 ? '&' : '?') + 'sessionId=' + encodeURIComponent(sessionId)
      const res = await fetch(apiUrl, {
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

    // 注册表档位矩阵：工具条显示的尺寸/实现/耗时与后端解析**同源**（不硬编码档位参数）。
    let tierMatrixCache = null
    let tierMatrixPromise = null
    function loadTierMatrix() {
      if (tierMatrixCache) return Promise.resolve(tierMatrixCache)
      if (!tierMatrixPromise) {
        tierMatrixPromise = fetch(WORKFLOWS_API).then((r) => r.json())
          .then((w) => { if (w && w.ok) tierMatrixCache = w; return tierMatrixCache })
          .catch(() => null)
      }
      return tierMatrixPromise
    }
    /** 该能力该档会实际用到的实现（配置选择 > 注册表首选），与后端排序规则一致。 */
    function tierPick(matrix, capability, tier) {
      const c = matrix && (matrix.capabilities || []).find((x) => x.capability === capability)
      if (!c || !c.tiered) return null
      const all = (c.groups || []).flatMap((g) => (g.tiers || {})[tier] || [])
      if (!all.length) return null
      const sel = (c.selection || {})[tier]
      return all.find((w) => w.id === sel) || all.find((w) => w.available !== false) || all[0]
    }
    const VIDEO_CAPABILITY = { r2v: 'video.reference2video', i2v: 'video.image2video' }
    /** 该能力**现有**的档位（由注册表推导，UI 不预设档位数量/名称）。 */
    function tiersOf(matrix, capability) {
      const c = matrix && (matrix.capabilities || []).find((x) => x.capability === capability)
      if (!c) return []
      // 选了用户自建策略时，档位＝**该策略提供的那几档**（策略没有的档位就是不存在，不是回退）
      const owned = Array.isArray(c.availableTiers) ? c.availableTiers : null
      if (owned && owned.length) return (c.tiers || []).filter((t) => owned.includes(t))
      return c.tiers || []
    }
    /** 某档的注册表首选实现（供选项标签显示实测耗时等数据）。 */
    function tierMetaOf(matrix, capability, tier) {
      const c = matrix && (matrix.capabilities || []).find((x) => x.capability === capability)
      const all = (c && (c.groups || []).flatMap((g) => (g.tiers || {})[tier] || [])) || []
      return all[0] || null
    }
    /** 未分档清单的长边（图片 t2i 尺寸提示用；读清单，不写死 1344）。 */
    function unclassifiedLongSide(matrix, capability) {
      const c = matrix && (matrix.capabilities || []).find((x) => x.capability === capability)
      const m = ((c && c.unclassified) || [])[0]
      if (!m) return null
      if (m.longSide) return m.longSide
      // 清单只声明了 resolution.default（如 [1344,768]）时取长边作为推导基准
      const def = m.resolution && m.resolution.default
      return Array.isArray(def) && def.length ? Math.max(...def) : null
    }
    /** 未分档能力的 mode 轴（图片 i2i 用；同样从清单读，不写死）。 */
    function modesOf(matrix, capability) {
      const c = matrix && (matrix.capabilities || []).find((x) => x.capability === capability)
      const ms = (c && c.unclassified) || []
      return ms.length ? (ms[0].modes || []) : []
    }

    /** 当前参数下该用的清单长边（视频=档位实现的长边；图片 t2i=未分档清单长边）。 */
    function matrixLongSide(matrix, cur) {
      if (!cur) return null
      if (cur.mode === 'image') return cur.imgType === 'i2i' ? null : unclassifiedLongSide(matrix, 'image.text2image')
      const cap = VIDEO_CAPABILITY[cur.pipeline] || VIDEO_CAPABILITY.r2v
      const meta = cur.videoTier ? tierMetaOf(matrix, cap, cur.videoTier) : null
      return (meta && meta.longSide) || null
    }

    const VIDEO_SKILL_HEAD = '/video-generate'
    const IMAGE_SKILL_HEAD = '/image-generate'

    /** 生成 image-generate 斜杠命令行：t2i 文生图（比例/尺寸/张数）；i2i 图生图（参考图，尺寸跟随参考图）。 */
    function svsImageHeader(cur, opts = {}) {
      const t = cur.imgType || 't2i'
      if (t === 'i2i') {
        const ids = (cur.refs || []).map((r) => r.nodeId).filter(Boolean)
        // 档位（未分档清单的 mode 轴）未知时不拼 tier=，交给服务端按清单解析
        let args = 'type=i2i' + (cur.imageTier ? ' tier=' + cur.imageTier : '') + ' count=' + (cur.count || 1)
        if (ids.length) args += ' refs=' + ids.join(',')
        return IMAGE_SKILL_HEAD + ' ' + args
      }
      const dims = svsDims(cur.ratio, opts.longSide || 1344)
      let args = 'type=t2i ratio=' + cur.ratio
      args += ' size=' + dims.width + 'x' + dims.height
      args += ' count=' + (cur.count || 1)
      return IMAGE_SKILL_HEAD + ' ' + args
    }

    /** 生成 video-generate 斜杠命令行（含参数；prompt 作为正文跟在空行后）。 */
    function svsVideoHeader(cur, opts = {}) {
      const vt = cur.videoTier || ''
      // 长边来自清单（调用方从档位矩阵取），不再按档位名硬编码；未知时用 1344 兜底
      const dims = svsDims(cur.ratio, opts.longSide || 1344)
      let args = 'type=' + cur.pipeline + (vt ? ' tier=' + vt : '') + ' ratio=' + cur.ratio
      args += ' size=' + dims.width + 'x' + dims.height + ' length=' + cur.seconds
      if (cur.pipeline === 'r2v') {
        args += ' refs=' + (cur.refs || []).map((r) => r.nodeId).join(',')
      } else {
        args += ' first=' + (cur.first ? cur.first.nodeId : '')
        if (cur.last) args += ' last=' + cur.last.nodeId
      }
      return VIDEO_SKILL_HEAD + ' ' + args
    }

    /** 从草稿里提取用户 prompt：任一斜杠命令头之后第一个换行之后的正文；无命令头则整段视为 prompt。 */
    function svsPromptOf(draft) {
      const d = typeof draft === 'string' ? draft : ''
      if (d.startsWith(VIDEO_SKILL_HEAD) || d.startsWith(IMAGE_SKILL_HEAD)) {
        const i = d.indexOf('\n')
        return i >= 0 ? d.slice(i).replace(/^\n+/, '') : ''
      }
      return d
    }

    /** 用当前参数重写当前模式的斜杠命令头（video/image），保留用户已输入的 prompt（默认发送键提交的就是这条草稿）。 */
    function svsSetHeader(inputActions, cur, draft, opts = {}) {
      if (!inputActions || typeof inputActions.setDraft !== 'function' || !cur) return
      const p = svsPromptOf(draft)
      const head = cur.mode === 'image' ? svsImageHeader(cur, opts) : svsVideoHeader(cur, opts)
      inputActions.setDraft(head + (p ? '\n\n' + p : ''))
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
    // videoTier/imageTier 留空：档位可用性由注册表决定，UI 不预设（见 tiersOf/modesOf）
    const GEN_DEFAULT = { mode: 'chat', pipeline: 'r2v', videoTier: '', imageTier: '', ratio: '16:9', seconds: 124, refs: [], first: null, last: null, imgType: 't2i', count: 1, results: [] }
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

    /** 画布节点删除（含媒体文件清理由后端完成）；失败不再静默。 */
    function removeRefCanvasNode(sessionId, nodeId) {
      if (!sessionId || !nodeId) return
      svsApi(sessionId, '/canvas/node?id=' + encodeURIComponent(nodeId), { method: 'DELETE' })
        .catch((e) => console.warn('[dsh-short-video-studio] 参考图画布节点删除失败:', nodeId, e?.message || e))
    }

    /** 清空当前会话用过的参考媒体：删掉对应画布节点（含文件）并重置 genStore 的 refs/first/last。 */
    function svsPurgeRefNodes(sessionId) {
      const cur = genStateOf(sessionId)
      if (!cur) return
      const ids = []
      for (const r of cur.refs || []) if (r && r.nodeId) ids.push(r.nodeId)
      if (cur.first && cur.first.nodeId) ids.push(cur.first.nodeId)
      if (cur.last && cur.last.nodeId) ids.push(cur.last.nodeId)
      genPatch(sessionId, { refs: [], first: null, last: null })
      for (const id of ids) removeRefCanvasNode(sessionId, id)
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
        const prevMode = active
        const nextMode = active === mode ? 'chat' : mode
        // 退出任一生成模式（video/image）且切到其它模式：清空参考媒体（画布节点+文件一并删除）
        if (prevMode !== 'chat' && nextMode !== prevMode) svsPurgeRefNodes(sessionId)
        genPatch(sessionId, { mode: nextMode })
        const cur = genStateOf(sessionId)
        const draft = props.input && typeof props.input.draft === 'string' ? props.input.draft : ''
        const ia = props.inputActions
        if (nextMode === 'video' || nextMode === 'image') {
          svsSetHeader(ia, cur, draft, { longSide: matrixLongSide(tierMatrixCache, cur) })
        } else if (nextMode === 'chat') {
          if (ia && typeof ia.setDraft === 'function') ia.setDraft(svsPromptOf(draft))
        }
      }
      return h('div', { className: 'svsg-tools', role: 'group', title: '生成模式：点「🎨 图片」/「🎬 视频」把对应斜杠命令（含参数）写入输入框加载 skill；发送用 dsh 默认发送键' },
        h('button', { type: 'button', className: 'svsg-tool' + (active === 'image' ? ' on' : ''), title: '图片生成：加载 image-generate skill（文生图 / 图生图参考图）', onClick: () => go('image') }, '🎨 图片'),
        h('button', { type: 'button', className: 'svsg-tool' + (active === 'video' ? ' on' : ''), title: '视频生成：加载 video-generate skill（r2v 参考图 / i2v 首末帧）', onClick: () => go('video') }, '🎬 视频'),
      )
    }




    /**
     * 内嵌生成工具条（video-generate skill 的可视化入口，正式内嵌版）：
     * 接管 conversation.input.attachments 席位（priority:-1），渲染位置 = 原生
     * 输入卡内、textarea 上方。点「🎬 视频」（conversation.input.left 的 GenToggle）
     * 进入视频模式后参数条出现；prompt 照旧写在官方输入框，参数一变就重写
     * /video-generate 命令头并保留 prompt，发送用 dsh 默认发送键（不劫持 Enter）。
     * chat 模式/hero 下席位退化为原附件 rail 的最小等价实现（图 chip + 移除 +
     * 添加 + 拖放），避免接管后附件功能回退。
     */
    function InnerGenBar(props) {
      const sessionId = props.sessionId
      const st = useGenSession(sessionId)
      const mode = st ? st.mode : 'chat'
      const attachments = Array.isArray(props.attachments) ? props.attachments : []
      const inputActions = props.inputActions
      const useInput = typeof props.useInput === 'function' ? props.useInput : null
      const [error, setError] = React.useState('')
      const [tip, setTip] = React.useState('')
      const [token, setToken] = React.useState('')
      const [dragging, setDragging] = React.useState(false)
      // 档位矩阵（懒加载一次，进程内缓存）：尺寸/实现/耗时展示与后端解析同源
      const [matrix, setMatrix] = React.useState(tierMatrixCache)
      React.useEffect(() => {
        if (matrix) return
        let alive = true
        loadTierMatrix().then((m) => { if (alive && m) setMatrix(m) })
        return () => { alive = false }
      }, [])
      React.useEffect(() => { ensureSvsToken().then(setToken).catch(() => setToken('')) }, [])
      // 实时草稿来自席位标准套件的 useInput（session-maybe）
      let draft = ''
      if (useInput) {
        try {
          const snap = useInput((s) => (s && typeof s.draft === 'string' ? s.draft : ''))
          draft = typeof snap === 'string' ? snap : ''
        } catch (e) { console.warn('[dsh-short-video-studio] useInput 读取失败:', e) }
      }
      // 无会话（hero 空态等）：不占任何视觉
      const prevDraft = React.useRef(draft)
      const purgeTimer = React.useRef(null)
      const hasRefMedia = !!(st && ((st.refs && st.refs.length > 0) || st.first || st.last))
      React.useEffect(() => {
        if (purgeTimer.current) { clearTimeout(purgeTimer.current); purgeTimer.current = null }
        // 视频/图片生成模式下草稿被整段清空（命令头也没了）：宽限 1.2s 仍为空则清掉参考媒体
        if (sessionId && st && (mode === 'video' || mode === 'image') && hasRefMedia && draft === '' && prevDraft.current !== '') {
          purgeTimer.current = setTimeout(() => {
            const c = genStateOf(sessionId)
            if (c && c.mode !== 'chat' && ((c.refs && c.refs.length) || c.first || c.last)) svsPurgeRefNodes(sessionId)
          }, 1200)
        }
        prevDraft.current = draft
        return () => { if (purgeTimer.current) { clearTimeout(purgeTimer.current); purgeTimer.current = null } }
      }, [sessionId, mode, draft, hasRefMedia, st])
      if (!sessionId || !st) return null
      const canDrop = !!props.canAcceptDrop && typeof props.onAddImages === 'function'
      const mediaUrl = (media) => svsMediaUrl(sessionId, media, token)

      // 参数变化：更新 store 并重写草稿命令头（保留 prompt）
      function mutate(patch) {
        const c = genStateOf(sessionId)
        if (!c) return
        const next = Object.assign({}, c, patch)
        genPatch(sessionId, patch)
        svsSetHeader(inputActions, next, draft, { longSide: matrixLongSide(matrix, next) })
      }
      function removeCanvasNode(nodeId) {
        removeRefCanvasNode(sessionId, nodeId)
      }
      function pickUploadRef(role) {
        pickFile('image/png,image/jpeg,image/webp,image/gif', role === 'r2v', async (files) => {
          setError(''); setTip('')
          for (const f of files) {
            try {
              const rec = await svsUploadRef(sessionId, f)
              const c = genStateOf(sessionId)
              if (!c) continue
              const recRec = { nodeId: rec.nodeId, name: rec.name, media: rec.media }
              if (role === 'r2v') mutate({ refs: [...c.refs, recRec].slice(0, 8) })
              else if (role === 'first') { if (c.first) removeCanvasNode(c.first.nodeId); mutate({ first: recRec }) }
              else { if (c.last) removeCanvasNode(c.last.nodeId); mutate({ last: recRec }) }
            } catch (e) {
              setError('上传失败：' + (e && e.message ? e.message : String(e)))
            }
          }
        })
      }
      function dropRef(index) {
        const c = genStateOf(sessionId)
        if (!c) return
        const rec = c.refs[index]
        if (rec) removeCanvasNode(rec.nodeId)
        mutate({ refs: c.refs.filter((_, i) => i !== index) })
      }
      // i2i 图生图参考图：单张，重传时替换（旧的画布节点一并删除）
      function pickIIRef() {
        pickFile('image/png,image/jpeg,image/webp,image/gif', false, async (files) => {
          setError(''); setTip('')
          const f = files[0]
          if (!f) return
          try {
            const rec = await svsUploadRef(sessionId, f)
            const c = genStateOf(sessionId)
            if (!c) return
            const recRec = { nodeId: rec.nodeId, name: rec.name, media: rec.media }
            const old = c.refs && c.refs[0]
            if (old) removeCanvasNode(old.nodeId)
            mutate({ refs: [recRec] })
          } catch (e) {
            setError('上传失败：' + (e && e.message ? e.message : String(e)))
          }
        })
      }
      // 图片类型切换：i2i → t2i 时清掉参考媒体（画布节点+文件），避免孤儿节点
      function setImgType(v) {
        const c = genStateOf(sessionId)
        if (!c) return
        if ((c.imgType || 't2i') === 'i2i' && v !== 'i2i' && c.refs && c.refs.length) svsPurgeRefNodes(sessionId)
        mutate({ imgType: v })
      }
      function dropFrame(which) {
        const c = genStateOf(sessionId)
        if (!c || !c[which]) return
        removeCanvasNode(c[which].nodeId)
        mutate({ [which]: null })
      }
      function sel(options, value, onChange) {
        return h('select', { className: 'svsg-select', value, onChange: (e) => onChange(e.target.value) },
          options.map((o) => h('option', { key: o[0], value: o[0] }, o[1])))
      }
      const dropZone = {
        onDragOver: (e) => { if (canDrop) { e.preventDefault(); e.stopPropagation(); setDragging(true) } },
        onDragLeave: () => setDragging(false),
        onDrop: (e) => {
          if (!canDrop) return
          e.preventDefault(); e.stopPropagation(); setDragging(false)
          const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => /^image\//.test(f.type))
          if (files.length && props.onAddImages) props.onAddImages(files)
        },
      }
      const pickImages = () => pickFile('image/png,image/jpeg,image/webp,image/gif', true, (files) => { if (files.length && props.onAddImages) props.onAddImages(files) })
      // 媒体格：完全复刻 dsh 原生「上传图片」chip 的样式与尺寸（64px 圆角方块、
      // 细边框、缩略图铺满、hover 右上角 ✕）。空位/新增用同尺寸的 ➕ 格表示；
      // 上传成功的图直接铺满该方块，不显示文件名。
      function mediaSlot(media, onRemove, tip) {
        return h('div', { className: 'svsg-slot', title: tip },
          h('img', { src: media, alt: '' }),
          h('button', { type: 'button', className: 'x', title: tip || '移除', onClick: onRemove }, '✕'),
        )
      }
      function addSlot(onPick, tip) {
        return h('button', { type: 'button', className: 'svsg-slot add', title: tip, 'aria-label': tip, onClick: onPick })
      }
      // 附件 rail（chat / video 共用，样式与原版一致；有图才出现）
      const rail = attachments.length === 0 ? null : h('div', Object.assign({ className: 'svsg-rail' }, dropZone),
        attachments.map((a) => h('div', { key: a.id, className: 'svsg-slot' },
          a.previewUrl ? h('img', { src: a.previewUrl, alt: '' }) : null,
          h('button', { type: 'button', className: 'x', title: '移除图片', onClick: () => { if (props.onRemoveImage) props.onRemoveImage(a.id) } }, '✕'),
        )),
        addSlot(pickImages, '添加图片'),
      )
      if (mode === 'image') {
        const isII = (st.imgType || 't2i') === 'i2i'
        const imgDims = svsDims(st.ratio, 1344)
        const imgCounts = [1, 2, 3, 4].map((n) => [String(n), n + ' 张'])
        const imgRefRow = isII
          ? h('div', { className: 'svsg-row' },
              h('span', { className: 'svsg-lbl' }, '参考图'),
              (st.refs && st.refs[0] && st.refs[0].media
                ? mediaSlot(mediaUrl(st.refs[0].media), () => dropRef(0), '移除参考图（画布节点一并删除）')
                : addSlot(pickIIRef, '上传参考图')),
            )
          : null
        return h('div', Object.assign({ className: 'svsg-inner' + (dragging ? ' svsg-dropon' : '') }, dropZone),
          rail,
          h('div', { className: 'svsg-row' },
            h('span', { className: 'svsg-skill' }, isII ? '🎨 image-generate · 图生图' : '🎨 image-generate · 文生图'),
            grp('类型', seg([['t2i', '文生图'], ['i2i', '图生图']], st.imgType || 't2i', setImgType)),
            isII ? null : grp('比例', sel(GEN_RATIOS.image.map((r) => [r, r]), st.ratio, (v) => { mutate({ ratio: v }); setTip(''); setError('') })),
            isII ? grp('档位', (() => {
              const ms = modesOf(matrix, 'image.image2image')
              const cur = (st.imageTier && ms.includes(st.imageTier)) ? st.imageTier : (ms[0] || '')
              return ms.length
                ? sel(ms.map((m) => [m, m]), cur, (v) => mutate({ imageTier: v }))
                : h('span', { className: 'svsg-hint' }, '档位读取中…')
            })()) : null,
            grp('张数', sel(imgCounts, String(st.count || 1), (v) => mutate({ count: Number(v) || 1 }))),
            h('span', { className: 'svsg-hint' }, isII ? '尺寸跟随参考图' : '尺寸 ' + imgDims.width + '×' + imgDims.height),
          ),
          imgRefRow,
          (tip || error) ? h('div', { className: tip ? 'svsg-tip' : 'svsg-error' }, tip || error) : null,
        )
      }
      // chat 模式：仅附件 rail（视觉上与原 ui-attachment 行为对等）
      if (mode !== 'video') return rail

      const vcap = VIDEO_CAPABILITY[st.pipeline] || VIDEO_CAPABILITY.r2v
      const vTiers = tiersOf(matrix, vcap)
      const vt = (st.videoTier && (!vTiers.length || vTiers.includes(st.videoTier))) ? st.videoTier : (vTiers[0] || '')
      const vimpl = tierPick(matrix, vcap, vt)
      // 长边来自清单（与后端 computeManifestSize 同源）；清单尚未加载时按档位内置口径兜底
      const vLong = (vimpl && vimpl.longSide) || (vt === 'fast' ? 832 : 1344)
      const dims = svsDims(st.ratio, vLong)
      const vhint = '尺寸 ' + dims.width + '×' + dims.height
        + (vimpl ? ' · ' + vimpl.id + (vimpl.accel ? '（' + vimpl.accel + ' 加速）' : '') : '')
        + (vimpl && vimpl.estSeconds ? ' · 约 ' + Math.round(vimpl.estSeconds) + 's' : (vimpl ? ' · 耗时未知' : ''))
        + (vimpl && vimpl.available === false ? '　✗ 缺节点 ' + (vimpl.missingNodes || []).join('、') : '')
      const uploadRow = st.pipeline === 'r2v'
        ? h('div', { className: 'svsg-row' },
            st.refs.map((r, i) => (r.media ? mediaSlot(mediaUrl(r.media), () => dropRef(i), '移除参考图（画布节点一并删除）') : null)),
            st.refs.length < 8 ? addSlot(() => pickUploadRef('r2v'), '添加参考图') : null,
          )
        : h('div', { className: 'svsg-row' },
            h('span', { className: 'svsg-lbl' }, '首帧'),
            (st.first
              ? mediaSlot(mediaUrl(st.first.media), () => dropFrame('first'), '移除首帧')
              : addSlot(() => pickUploadRef('first'), '上传首帧')),
            h('span', { className: 'svsg-lbl' }, '末帧'),
            (st.last
              ? mediaSlot(mediaUrl(st.last.media), () => dropFrame('last'), '移除末帧')
              : addSlot(() => pickUploadRef('last'), '上传末帧（可选）')),
          )

      return h('div', Object.assign({ className: 'svsg-inner' + (dragging ? ' svsg-dropon' : '') }, dropZone),
        h('div', { className: 'svsg-row' },
          h('span', { className: 'svsg-skill' }, '🎬 video-generate 已加载'),
          grp('类型', sel([['r2v', 'r2v 参考图'], ['i2v', 'i2v 首/末帧']], st.pipeline, (v) => { mutate({ pipeline: v }); setTip(''); setError('') })),
          grp('档位', vTiers.length
            ? sel(vTiers.map((t) => {
                const meta = tierMetaOf(matrix, vcap, t)
                return [t, t + (meta && meta.estSeconds ? ' · 约 ' + Math.round(meta.estSeconds) + 's' : '')]
              }), vt, (v) => { mutate({ videoTier: v }); setTip(''); setError('') })
            : h('span', { className: 'svsg-hint' }, '档位读取中…')),
          grp('比例', sel(GEN_RATIOS.video.map((r) => [r, r]), st.ratio, (v) => mutate({ ratio: v }))),
          grp('时长', sel(GEN_SECONDS.map((s) => [s.frames, s.label]), st.seconds, (v) => mutate({ seconds: v }))),
          h('span', { className: 'svsg-hint' }, vhint),
        ),
        uploadRow,
        rail,
        (tip || error) ? h('div', { className: tip ? 'svsg-tip' : 'svsg-error' }, tip || error) : null,
      )
    }

    function apply(ctx) {
      // 内嵌生成工具条：shadow conversation.input.attachments（priority:-1）——
      // 渲染在原生输入卡内、textarea 上方。chat 模式下退化为附件 rail。
      try {
        ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({
          name: 'conversation.input.attachments',
          priority: -1,
          inject: (sessionId) => ({ sessionId }),
        }, InnerGenBar))
      } catch (e) {
        console.warn('[dsh-short-video-studio] conversation.input.attachments 接管失败（附件 rail 由原生提供）:', e)
      }

      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'short-video-canvas',
        order: 20,
        label: '画布',
      }, CanvasView))

      // 输入框生成模式（共用 dsh 输入框 + 默认发送键）：工具行左端开关 + 卡内生成条。
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
    // 测试面（宿主忽略）：工具条命令行拼装与档位取值，供 scripts/smoke-client-settings.mjs 断言
    exports.__test = { svsVideoHeader, svsImageHeader, svsDims, tierPick, tiersOf, tierMetaOf, modesOf, unclassifiedLongSide, GEN_DEFAULT }
    return module.exports
  },
})
