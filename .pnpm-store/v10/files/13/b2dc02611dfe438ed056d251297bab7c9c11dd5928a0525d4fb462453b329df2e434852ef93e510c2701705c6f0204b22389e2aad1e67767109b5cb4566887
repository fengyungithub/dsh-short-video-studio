/**
 * scripts/smoke-tools.mjs — 工具定义对宿主的 register 契约校验（离线）。
 *
 * 为什么必须有：宿主 `tools.register()` 是**强制校验**的（dsh-tools/lib/index.js）：
 *
 *   if (output === undefined || typeof output.render !== 'function')
 *     throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
 *   assertSupportedJsonSchema(output.schema)
 *
 * 任何一个工具漏了 `output`（或 schema 用了子集外的关键字），注册时就会抛 →
 * 而 apply() 里工具注册在路由注册**之前** ⇒ 整条 apply 失败 ⇒ 工具与路由一起消失。
 * 用户看到的却是「浏览器端设置页加载失败: SyntaxError: ... Unexpected end of JSON
 * input」——因为客户端那一半是独立入口，照旧加载，于是卡片在、接口全 404 空 body。
 * 这类"症状在浏览器、根因在服务端装配"的错误必须由本测试拦住。
 *
 * 校验项：
 *  1) 结构：name/description/parameters/execute + output{ schema, render }
 *  2) schema 子集：若能在部署环境里解析到宿主 @deepseek-ai/dsh-tools，就用**宿主自己的**
 *     assertSupportedJsonSchema 校验 parameters 与 output.schema（真契约，不是复刻）
 *  3) 名字唯一、描述非空、render 可调用且返回非空字符串（用按 schema 生成的样本值）
 *
 * 用法：node scripts/smoke-tools.mjs
 */

import { createRequire } from 'node:module'
import { _internals, apply as pluginApply } from '../lib/index.js'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const require = createRequire(import.meta.url)

/** 宿主校验器：能解析到就用真件；解析不到就明确跳过（不伪装成通过）。 */
async function loadHostValidator() {
  const candidates = [
    '@deepseek-ai/dsh-tools/lib/index.js',
    '/Users/seiue/.npm/_npx/70d91ba4578130cd/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  ]
  for (const spec of candidates) {
    try {
      const mod = await import(spec)
      if (typeof mod.assertSupportedJsonSchema === 'function') return { mod, spec }
    } catch { /* 换下一个候选 */ }
  }
  return null
}

/** 按 schema 造一个能过校验的最小样本值（只为跑通 render，不求语义）。 */
function sampleFor(schema) {
  if (!schema || typeof schema !== 'object') return {}
  switch (schema.type) {
    case 'object': {
      const out = {}
      for (const [k, v] of Object.entries(schema.properties || {})) out[k] = sampleFor(v)
      return out
    }
    case 'array': return [sampleFor(schema.items)]
    case 'string': return schema.enum ? schema.enum[0] : 'x'
    case 'integer': return 1
    case 'number': return 1
    case 'boolean': return true
    default: return null
  }
}

const host = await loadHostValidator()
console.log(host
  ? `宿主校验器：${host.spec}`
  : '宿主校验器：未解析到 @deepseek-ai/dsh-tools ⇒ 跳过"schema 子集"两项（结构项仍校验）')

const tools = _internals.makeTools()
ok('makeTools() 返回非空数组', Array.isArray(tools) && tools.length > 0, `实际 ${Array.isArray(tools) ? tools.length : typeof tools}`)

const names = tools.map((t) => t && t.name)
ok('工具名唯一', new Set(names).size === names.length, `重复：${names.filter((n, i) => names.indexOf(n) !== i).join(', ')}`)

// ── 调用面契约（P2）：实现选择归配置面，工具面**不得**暴露 workflow ──────────────
// docs/unified-tier-tool-design.md §5：comfy_render / video_upscale 曾用 workflow= 选实现，
// 现在只认 capability + tier（实现由 cfg.pins / cfg.tiers / preferred 解析）。
{
  for (const t of tools) {
    const props = t?.parameters?.properties || {}
    if (props.workflow !== undefined) {
      const deprecated = String(props.workflow.description || '').includes('已废弃')
      ok(`${t.name} · workflow 参数必须标注【已废弃】或移除`, deprecated,
        `schema 里仍有可用的 workflow 参数：${JSON.stringify(props.workflow).slice(0, 90)}…`)
    }
  }
  for (const n of ['comfy_generate_image', 'comfy_generate_video', 'comfy_render']) {
    const props = tools.find((x) => x.name === n)?.parameters?.properties || {}
    ok(`${n} · 暴露 tier（档位是唯一的成本/质量轴）`, Boolean(props.tier), Object.keys(props).join(', '))
    ok(`${n} · 不再暴露 mode`, props.mode === undefined, JSON.stringify(props.mode))
  }
  for (const t of tools) {
    const tier = t?.parameters?.properties?.tier
    if (!tier) continue
    ok(`${t.name} · tier 取值受控（fast/balanced/quality）`, Array.isArray(tier.enum) && tier.enum.join(',') === 'fast,balanced,quality', JSON.stringify(tier.enum))
  }
}

for (const t of tools) {
  const n = t && t.name ? t.name : '(无名)'
  ok(`${n} · name 是非空字符串`, typeof t?.name === 'string' && t.name.trim().length > 0)
  ok(`${n} · description 非空`, typeof t?.description === 'string' && t.description.trim().length > 0)
  ok(`${n} · parameters 是对象 schema`, t?.parameters && typeof t.parameters === 'object' && t.parameters.type === 'object')
  ok(`${n} · execute 是函数`, typeof t?.execute === 'function')

  // 宿主 register 的第一道门：output 存在且 render 是函数
  const hasOutput = t?.output !== undefined && typeof t.output === 'object'
  ok(`${n} · 声明 output{ schema, render }（漏了会让整个插件不加载）`, hasOutput && typeof t.output.render === 'function',
    hasOutput ? 'render 不是函数' : '完全没有 output 字段')
  ok(`${n} · output.schema 是对象`, t?.output?.schema !== undefined && typeof t.output.schema === 'object')

  if (host) {
    for (const [label, schema] of [['parameters', t?.parameters], ['output.schema', t?.output?.schema]]) {
      if (schema === undefined) continue
      let verdict = 'ok'
      try { host.mod.assertSupportedJsonSchema(schema) } catch (e) { verdict = e?.message || String(e) }
      ok(`${n} · ${label} 属于宿主支持的 JSON Schema 子集`, verdict === 'ok', verdict)
    }
  }

  // render 必须能跑：宿主只负责 snapshot 它的返回值（content blocks），所以断言
  // 「非空、且每个块有 type」——返回空串等于模型侧什么都看不到。
  if (typeof t?.output?.render === 'function') {
    const sample = sampleFor(t.output.schema)
    let rendered = null
    let err = ''
    try { rendered = t.output.render({}, sample) } catch (e) { err = e?.message || String(e) }
    const blocks = Array.isArray(rendered) ? rendered : (typeof rendered === 'string' ? [{ type: 'text', text: rendered }] : null)
    const good = err === '' && blocks !== null && blocks.length > 0 &&
      blocks.every((b) => b && typeof b === 'object' && typeof b.type === 'string') &&
      blocks.some((b) => typeof b.text === 'string' && b.text.trim().length > 0)
    ok(`${n} · render 不抛且产出非空 content blocks`, good, err || `返回 ${JSON.stringify(rendered)?.slice(0, 60)}`)
  }
}

// 返回值的形状契约：宿主会用 output.schema **严格校验 execute 的返回值**
// （违反 ⇒ ToolOutputError）。空参数调用会走各工具的失败分支，正好是最容易写错的
// 那半边（历史事故：video_upscale 的 plan 在失败分支返回 null，而 schema 声明 object）。
// 只挑"空参数必然早期失败、且不产生副作用"的工具跑。
const INERT_ON_EMPTY_ARGS = [
  'comfy_list_workflows', 'canvas_list_nodes', 'canvas_get_state', 'canvas_get_node',
  'asset_list', 'video_upscale', 'extract_frame', 'video_concat', 'comfy_render', 'comfy_generate_video',
]
if (host && typeof host.mod.validateJsonSchemaValue === 'function') {
  for (const tool of tools.filter((t) => INERT_ON_EMPTY_ARGS.includes(t?.name))) {
    let value = null
    let err = ''
    try { value = await tool.execute({}, {}) } catch (e) { err = e?.message || String(e) }
    // 直接抛是合法行为（宿主把它变成 error 结果，不参与 output.schema 校验）：
    // 例如画布类工具缺 sessionId 时必须拒绝。只有"返回了值"才校验其形状。
    if (err) { ok(`${tool.name} · 空参数下显式拒绝（抛错 ⇒ 宿主走 error 结果）`, true); continue }
    let violations = []
    try { violations = host.mod.validateJsonSchemaValue(tool.output.schema, JSON.parse(JSON.stringify(value)), 'value') } catch (e) { violations = [e?.message || String(e)] }
    ok(`${tool.name} · 空参数失败分支仍符合 output.schema`, violations.length === 0, violations.join('; '))
  }
}

// --- apply() 装配检查：工具注册在路由注册之前，任一步抛都会让整个插件不加载 ------
// 复刻真宿主的校验语义（output 必填 + schema 子集），断言 apply 能走到最后一步：
// 「1 条 prefix 路由 + 全部工具」都注册上。少了任何一半，设置页/画布就会 404 空 body。
{
  const routes = []
  const registered = []
  const order = []
  const assertSchema = host
    ? (s) => host.mod.assertSupportedJsonSchema(s)
    : () => {}
  const hostCtx = {
    effect: (fn, label) => {
      order.push(label || '(effect)')
      const disposed = fn()
      return typeof disposed === 'function' ? disposed : () => {}
    },
    on: () => () => {},
    tools: {
      register(def) {
        // 宿主 register() 的强制门（dsh-tools/lib/index.js:2877）
        if (def.output === undefined || typeof def.output !== 'object' || typeof def.output.render !== 'function') {
          throw new TypeError(`tool "${def.name}" must declare output { schema, render, presentationMeta? }`)
        }
        assertSchema(def.output.schema)
        registered.push(def.name)
        return () => {}
      },
      get: () => undefined,
    },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    systemPrompt: { section: (s) => { order.push('systemPrompt.section:' + s.name); return () => {} } },
    workspaceRegistry: { get: () => undefined, list: () => [] },
  }
  let applyErr = ''
  try { pluginApply(hostCtx) } catch (e) { applyErr = e?.stack?.split('\n').slice(0, 3).join(' | ') || String(e) }
  ok('apply() 全程不抛（抛出 = 工具与路由一起消失）', applyErr === '', applyErr)
  ok(`apply() 注册全部 ${tools.length} 个工具`, registered.length === tools.length, `实际 ${registered.length}`)
  ok('apply() 注册了 prefix 路由（设置页/画布都要它）', routes.length === 1 && routes[0].path === '/dsh-short-video-studio' && routes[0].kind === 'prefix',
    JSON.stringify(routes.map((r) => r.kind + ':' + r.path)))
  ok('apply() 注册顺序：工具 → systemPrompt → 路由（路由必须最后且被执行到）',
    order.indexOf('dsh-short-video-studio: tools') < order.findIndex((l) => String(l).startsWith('systemPrompt.section')) &&
    order.indexOf('dsh-short-video-studio: routes') === order.length - 1,
    order.join(' → '))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)