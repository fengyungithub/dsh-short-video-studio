/**
 * scripts/experiment/selftest-mock.mjs — 验证「假 ComfyUI + 真工具链」这条路能跑通。
 *
 * 做三件事：
 *  1. 起 mock-comfy（子进程），等它就绪；
 *  2. 用最小宿主 ctx 加载插件，执行一次 comfy_generate_image（tier=fast）；
 *  3. 断言：画布节点落盘、媒体文件存在、trace 里恰好 1 条 /prompt 且 graph 里有正向提示词。
 *
 * 用法：node scripts/experiment/selftest-mock.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '..', '..')
const PORT = 8299
const outDir = join(root, 'experiment-out', 'selftest')
rmSync(outDir, { recursive: true, force: true })

const mock = spawn(process.execPath, [join(root, 'scripts/experiment/mock-comfy.mjs')], {
  env: { ...process.env, MOCK_COMFY_PORT: String(PORT), MOCK_COMFY_OUT: outDir },
  stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise((ok, fail) => {
  const timer = setTimeout(() => fail(new Error('mock 启动超时')), 8000)
  mock.stdout.on('data', (d) => {
    if (String(d).includes('mock-comfy')) { clearTimeout(timer); ok() }
  })
  mock.stderr.on('data', (d) => process.stderr.write('[mock] ' + d))
})

process.env.DSH_SVS_COMFY_URL = `http://127.0.0.1:${PORT}`

try {
  const { apply } = await import(join(root, 'lib/index.js'))
  const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-svs-selftest-'))
  const SID = 'selftest-session'
  const workspace = { id: 'ws-selftest', path: tmpRoot, sessionIds: [SID] }
  const registered = []
  apply({
    webServer: { register: () => () => {} },
    tools: { register: (t) => { registered.push(t); return () => {} }, get: () => undefined },
    systemPrompt: { section: () => () => {} },
    workspaceRegistry: { get: (id) => (id === workspace.id ? workspace : undefined), list: () => [workspace] },
    on: () => () => {},
    effect: (fn) => fn(),
  })
  const tool = registered.find((t) => t.name === 'comfy_generate_image')
  if (!tool) throw new Error('没注册到 comfy_generate_image')

  const r = await tool.execute({
    prompt: 'experiment selftest: a single orange cube on a grey background, studio light',
    tier: 'fast', width: 256, height: 256, steps: 2, count: 1,
    title: '自检图', group: 'character cards',
    sessionId: SID, workspaceId: workspace.id,
  })

  // 断言
  const projectPath = join(tmpRoot, 'canvas', SID, 'project.json')
  const project = existsSync(projectPath) ? JSON.parse(readFileSync(projectPath, 'utf8')) : null
  const nodes = project?.nodes || []
  const node = nodes.find((n) => n.id === r.nodeId) || nodes[0]
  const traceLines = readFileSync(join(outDir, 'comfy-trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  const prompts = traceLines.filter((l) => l.kind === 'prompt')

  const checks = [
    ['画布 project.json 落盘', !!project],
    ['生成了图片节点', !!node && node.kind === 'image'],
    ['媒体文件存在', !!node?.media && existsSync(join(tmpRoot, node.media))],
    ['trace 恰好 1 次 /prompt', prompts.length === 1],
    ['graph 里带正向提示词', prompts[0] && JSON.stringify(prompts[0].graph).includes('orange cube')],
    ['graph 记录了采样参数', prompts[0] && Object.values(prompts[0].graph).some((n) => n?.inputs && ('steps' in n.inputs || 'width' in n.inputs))],
  ]
  let bad = 0
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}`)
    if (!ok) bad++
  }
  console.log(bad ? `\n✗ 自检失败：${bad} 项` : '\n✓ 自检通过：假 ComfyUI + 真工具链可用')
  process.exitCode = bad ? 1 : 0
} finally {
  mock.kill('SIGTERM')
}
