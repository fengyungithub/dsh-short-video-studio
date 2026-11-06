/**
 * scripts/experiment/collect-runs.mjs — 批量判分多个实验臂
 *
 * 臂 → 画布会话的映射不靠 agent 自报：从该臂 state 的 finalNodeId / clipNodeIds 反查
 * canvas/<sid>/project.json，命中即该臂的画布。这样即使 agent 报错 sessionId 也不会串。
 *
 * 用法：node scripts/experiment/collect-runs.mjs --runs experiment/runs --trace experiment-out/L1/comfy-trace.jsonl
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const argOf = (n, d) => (argv.indexOf('--' + n) >= 0 ? argv[argv.indexOf('--' + n) + 1] : d)
const runsDir = resolve(argOf('runs', 'experiment/runs'))
const trace = argOf('trace', '')
const tier = argOf('tier', 'fast')
const root = resolve(new URL('../..', import.meta.url).pathname)

const arms = readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
const sessions = readdirSync(join(root, 'canvas'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .map((sid) => {
    const p = join(root, 'canvas', sid, 'project.json')
    if (!existsSync(p)) return null
    try {
      const project = JSON.parse(readFileSync(p, 'utf8'))
      return { sid, ids: new Set((project.nodes || []).map((n) => n.id)), nodes: (project.nodes || []).length }
    } catch { return null }
  })
  .filter(Boolean)

const rows = []
for (const arm of arms) {
  const statePath = join(runsDir, arm, 'series/production-state.json')
  if (!existsSync(statePath)) { rows.push({ arm, session: '—', note: '无 state' }); continue }
  let state = {}
  try { state = JSON.parse(readFileSync(statePath, 'utf8')) } catch {}
  const ep = state?.episodes?.ep001 || {}
  const wanted = [ep.finalNodeId, ...(ep.clipNodeIds || [])].filter(Boolean)
  const hit = wanted.length ? sessions.find((s) => wanted.some((id) => s.ids.has(id))) : null
  const session = hit?.sid || '—'
  const note = hit ? `${wanted.filter((id) => hit.ids.has(id)).length}/${wanted.length} 节点命中` : '未找到画布'
  let p0 = null, p1 = null, detail = ''
  if (hit) {
    const args = [join(root, 'scripts/experiment/assert-run.mjs'), '--workspace', join(runsDir, arm), '--canvas-root', root, '--session', session, '--tier', tier, '--json', '--allow-missing-concat']
    if (trace) args.push('--trace', resolve(trace))
    try {
      const out = execFileSync(process.execPath, args, { encoding: 'utf8' })
      const r = JSON.parse(out)
      p0 = `${(r.p0 || []).filter((x) => x.ok).length}/${(r.p0 || []).length}`
      p1 = `${(r.p1 || []).filter((x) => x.ok).length}/${(r.p1 || []).length}`
      detail = (r.p0 || []).filter((x) => !x.ok).map((x) => x.id).join(';')
    } catch (e) {
      const r = JSON.parse(String(e.stdout || '{}'))
      p0 = `${(r.p0 || []).filter((x) => x.ok).length}/${(r.p0 || []).length}`
      p1 = `${(r.p1 || []).filter((x) => x.ok).length}/${(r.p1 || []).length}`
      detail = (r.p0 || []).filter((x) => !x.ok).map((x) => x.id).join(';')
    }
  }
  rows.push({ arm, session, p0, p1, note, p0Fail: detail })
}

console.log('\n臂 | 画布会话 | P0 | P1 | 说明')
for (const r of rows) console.log(`${r.arm} | ${r.session} | ${r.p0 ?? '—'} | ${r.p1 ?? '—'} | ${r.note}${r.p0Fail ? ' ｜ 失败: ' + r.p0Fail : ''}`)
const report = { at: new Date().toISOString(), trace, tier, rows }
const out = join(runsDir, '..', '..', 'experiment-out', 'report-' + Date.now() + '.json')
try { writeFileSync(out, JSON.stringify(report, null, 2)) ; console.log('\n报告 →', out) } catch {}
const anyP0Fail = rows.some((r) => r.p0 && r.p0.split('/')[0] !== r.p0.split('/')[1])
process.exitCode = anyP0Fail ? 1 : 0
