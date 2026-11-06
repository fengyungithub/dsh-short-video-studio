/**
 * scripts/experiment/selftest-assert.mjs — 判分器的负例控制组（防止「永远判过」）
 *
 * 做法：拿 make-golden-run 生成的正例，逐个注入 1 个已知违规，断言 assert-run **必须**把
 * 对应的检查判负。任何一条没被抓住 = 判分器失效（变异未被杀死）。
 *
 * 用法：node scripts/experiment/selftest-assert.mjs
 */
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const base = mkdtempSync(join(tmpdir(), 'dsh-exp-golden-'))
execFileSync(process.execPath, [join(root, 'scripts/experiment/make-golden-run.mjs'), '--out', base, '--session', 's'], { stdio: 'ignore' })

const projectPath = join(base, 'canvas/s/project.json')
const tracePath = join(base, 'comfy-trace.jsonl')
const readProject = () => JSON.parse(readFileSync(projectPath, 'utf8'))
const writeProject = (p) => writeFileSync(projectPath, JSON.stringify(p, null, 2))

function runAssert() {
  try {
    const out = execFileSync(process.execPath, [join(root, 'scripts/experiment/assert-run.mjs'),
      '--workspace', base, '--session', 's', '--trace', tracePath, '--tier', 'fast', '--json'], { encoding: 'utf8' })
    return JSON.parse(out)
  } catch (e) {
    // P0 失败时退出码 1，但 stdout 仍是完整 JSON
    return JSON.parse(String(e.stdout || '{}'))
  }
}

const cases = [
  ['断链：抹掉 S03 的 continuityFrom', 'P0 15', () => {
    const p = readProject()
    const c = p.nodes.find((n) => n.title === 'S03 片段')
    c.params.continuityFrom = null
    writeProject(p)
  }],
  ['混档：把 S04 改成 balanced', 'P0 12', () => {
    const p = readProject()
    const c = p.nodes.find((n) => n.title === 'S04 片段')
    c.params.tier = 'balanced'
    writeProject(p)
  }],
  ['自检造假：把 S05 改回 pending', 'P0 16', () => {
    const p = readProject()
    const c = p.nodes.find((n) => n.title === 'S05 片段')
    c.params.selfCheck.status = 'pending'
    writeProject(p)
  }],
  ['拼接乱序：交换前两个 source', 'P0 17', () => {
    const p = readProject()
    const c = p.nodes.find((n) => n.group === 'final delivery')
    const s = c.params.sources
    ;[s[0], s[1]] = [s[1], s[0]]
    writeProject(p)
  }],
  ['beat 自创：把 S02 的剧本依据改成 B99', 'P0 08', () => {
    const p = readProject()
    const t = p.nodes.find((n) => n.group === 'shot table')
    t.content = t.content.replace('剧本依据: B02', '剧本依据: B99')
    writeProject(p)
  }],
  ['重复提交：trace 里多 5 次同样请求', 'P0 21', () => {
    const lines = readFileSync(tracePath, 'utf8').trim().split('\n')
    const one = lines.find((l) => JSON.parse(l).kind === 'prompt')
    writeFileSync(tracePath, [...lines, one, one, one, one, one].join('\n') + '\n')
  }],
  ['提示词库不同文：改 fast 段', 'P0 10', () => {
    const p = readProject()
    const b = p.nodes.find((n) => n.title === 'S06 提示词（分档）')
    b.content = b.content.replace('## fast\n', '## fast\n[DIFFERENT] ')
    writeProject(p)
  }],
]

let killed = 0
for (const [name, checkId, mutate] of cases) {
  cpSync(join(root, 'experiment/golden'), base, { recursive: true })
  mutate()
  const report = runAssert()
  const want = checkId.replace(/^P0\s*/, '')
  const hit = (report.p0 || []).find((r) => r.id.startsWith(want))
  const ok = hit && hit.ok === false
  console.log(`  ${ok ? '✓' : '✗'} ${name} → 期望 ${checkId} 判负${ok ? '' : '（未被抓住！）'}`)
  if (ok) killed++
}
rmSync(base, { recursive: true, force: true })
console.log(`\n${killed === cases.length ? '✓' : '✗'} 变异杀死 ${killed}/${cases.length}`)
process.exitCode = killed === cases.length ? 0 : 1
