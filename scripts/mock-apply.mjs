// 用 mock cordis 上下文验证 apply() 不会抛错、工具/路由/systemPrompt 都能注册。
import { apply } from '../lib/index.js'

const registered = { routes: [], tools: [], sections: [] }

const mockCtx = {
  webServer: {
    register: (route) => { registered.routes.push(route); return () => {} },
  },
  tools: {
    register: (tool) => { registered.tools.push(tool); return () => {} },
  },
  systemPrompt: {
    section: (spec) => { registered.sections.push(spec); return () => {} },
  },
  workspaceRegistry: {
    get: () => undefined,
    list: () => [],
    resolveByPath: async () => undefined,
  },
  effect: (fn) => fn(),
}

try {
  apply(mockCtx)
  console.log('apply OK')
  console.log('routes:', registered.routes.map((r) => r.kind + ' ' + r.path).join(', '))
  console.log('tools:', registered.tools.map((t) => t.name).join(', '))
  console.log('sections:', registered.sections.map((s) => s.name + '(' + s.text.length + ' chars)').join(', '))
  // 校验每个工具的 output.schema 与 render 存在
  for (const t of registered.tools) {
    if (!t.name || !t.description || !t.parameters || !t.output?.schema || typeof t.output.render !== 'function' || typeof t.execute !== 'function') {
      console.error('✗ tool 不完整:', t.name)
      process.exit(1)
    }
    // render 冒烟
    const blocks = t.output.render({}, {})
    if (!Array.isArray(blocks) || !blocks[0]?.type) {
      console.error('✗ tool render 异常:', t.name)
      process.exit(1)
    }
  }
  console.log('✓ 所有工具 schema/render/execute 校验通过')
} catch (e) {
  console.error('✗ apply 抛错:', e.message)
  console.error(e.stack)
  process.exit(1)
}
