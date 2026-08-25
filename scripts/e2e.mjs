// 端到端：真实 ComfyUI 生成 + 画布持久化（临时 workspace 目录）。
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { _internals } from '../lib/index.js'

// 无法直接 import 非导出的 runImageGeneration，故通过工具定义执行路径来测：
// 这里直接 import apply 不行（工具闭包需要 ctx）。改为重新构造一个最小宿主 ctx，
// 调用 apply 后，从 registered 工具里取 comfy_generate_image / comfy_generate_video 执行。
const { apply } = await import('../lib/index.js')

const tmpRoot = resolve('/Users/seiue/Workspace/short-video/.tmp-workspace')
await rm(tmpRoot, { recursive: true, force: true })
await mkdir(tmpRoot, { recursive: true })

const SID = 'e2e-session-001'
const registered = []
const workspace = { id: 'ws-e2e', path: tmpRoot, sessionIds: [SID] }

const mockCtx = {
  webServer: { register: () => () => {} },
  tools: { register: (t) => { registered.push(t); return () => {} } },
  systemPrompt: { section: () => () => {} },
  workspaceRegistry: {
    get: (id) => (id === 'ws-e2e' ? workspace : undefined),
    list: () => [workspace],
  },
  effect: (fn) => fn(),
}

apply(mockCtx)
const byName = Object.fromEntries(registered.map((t) => [t.name, t]))

async function runImage() {
  const tool = byName['comfy_generate_image']
  const r = await tool.execute({
    prompt: 'a friendly orange fox astronaut, stylized 3d animation, warm lighting',
    width: 512, height: 512, seed: 42, steps: 6, count: 1,
    title: '主角卡', group: 'character cards', sessionId: SID, workspaceId: 'ws-e2e',
  }, { agent: { id: SID, session: { meta: { cwd: tmpRoot } } } })
  console.log('IMAGE TOOL RESULT:', JSON.stringify(r))
  return r
}

async function runVideo() {
  const tool = byName['comfy_generate_video']
  const r = await tool.execute({
    prompt: 'a small fox waves hello, warm 3d animation, locked camera',
    width: 512, height: 512, length: 5, seed: 43, steps: 4,
    title: 'S01 片段', group: 'shot clips', sessionId: SID, workspaceId: 'ws-e2e',
  }, { agent: { id: SID, session: { meta: { cwd: tmpRoot } } } })
  console.log('VIDEO TOOL RESULT:', JSON.stringify(r))
  return r
}

const img = await runImage()
const vid = await runVideo()

console.log('\n--- 画布目录内容 ---')
const files = []
async function walk(d) {
  for (const e of await readdir(d, { withFileTypes: true })) {
    const p = resolve(d, e.name)
    if (e.isDirectory()) await walk(p)
    else files.push(p)
  }
}
await walk(tmpRoot)
for (const f of files) console.log('  ' + f.replace(tmpRoot, '<root>'))

const project = JSON.parse(await readFile(resolve(tmpRoot, 'canvas', SID, 'project.json'), 'utf8'))
console.log('\n--- project.json 节点 ---')
for (const n of project.nodes) console.log(`  ${n.kind}\t${n.group}\t${n.title}\t${n.status}\tmedia=${n.media}`)

const ok = img.ok && vid.ok && project.nodes.length >= 2 && project.nodes.every((n) => n.status === 'ready' && n.media)
console.log('\n' + (ok ? '✓ 端到端通过' : '✗ 端到端失败'))
process.exit(ok ? 0 : 1)
