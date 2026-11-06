/**
 * scripts/smoke-production-gate.mjs — 冒烟：短剧制片门（stage / G-P / 版本 / 资产锁定）
 *
 * 它补的是「画布层门看不见系列层状态」的洞：
 *   - 阶段没到就开渲（跳过阶段 C）
 *   - G-P 方案卡没批准就烧 GPU
 *   - 改了台词但没重建包（版本对不上）
 *   - library 模式资产没锁定 / 参考图不是资产库物化的
 *
 * 用法：node scripts/smoke-production-gate.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, _internals } from '../lib/index.js'

const { makeProductionGateListener } = _internals
let passed = 0
const ok = (cond, name, extra = '') => { assert.ok(cond, name + (cond ? '' : ' ← ' + extra)); passed++; console.log('  ok -', name) }

const ws = mkdtempSync(join(tmpdir(), 'dsh-svs-prodgate-'))
const SID = 'sid-prod'
mkdirSync(join(ws, 'canvas', SID), { recursive: true })

const project = {
  schemaVersion: 1,
  sessionId: SID,
  settings: { aspectRatio: '9:16', mode: 'balanced', shotGate: 'verdict' },
  nodes: [
    { id: 'card1', kind: 'image', title: '林晚 单视图', group: 'character cards', media: `canvas/${SID}/c.png`, params: { cardVariant: 'single' } },
    { id: 'card2', kind: 'image', title: '林晚 单视图（资产库）', group: 'character cards', media: `canvas/${SID}/c2.png`, params: { cardVariant: 'single', assetId: 'character:abc' } },
  ],
}
writeFileSync(join(ws, 'canvas', SID, 'project.json'), JSON.stringify(project, null, 2))

const state = (over = {}) => ({
  series: { title: 'T', episodes: 1, assetMode: 'draft' },
  assets: { characters: [], scenes: [], props: [], voices: [] },
  episodes: { ep001: { stage: 'clips', package: 'series/episodes/ep001/package.md', scriptVersion: 1, packageVersion: 1, gate: { package: { status: 'approved' }, clips: { status: 'pending' }, delivery: { status: 'pending' } } } },
  next: 'ep001/clips',
  ...over,
})
const pkgMd = (over = {}) => {
  const json = { contract: 'episode-package/v1', episode: { number: 1, id: 'EP001', title: 't', sourceScript: 'episodes/ep001.md', scriptVersion: 1, packageVersion: 1, episodeVersion: 1 }, targetSeconds: 45, shotBudget: 8, paywall: false, hookType: 'suspense', scenes: [], dialogue: [], shots: [], assets: { characters: [], scenes: [], props: [], voices: [], toBuild: [] }, params: { assetMode: 'draft' }, ...over }
  return '```json\n' + JSON.stringify(json) + '\n```\n\n# EP001 集制作包\n'
}

function writeState(s) {
  mkdirSync(join(ws, 'series/episodes/ep001'), { recursive: true })
  writeFileSync(join(ws, 'series/production-state.json'), JSON.stringify(s, null, 2))
}
function writePkg(over) {
  mkdirSync(join(ws, 'series/episodes/ep001'), { recursive: true })
  writeFileSync(join(ws, 'series/episodes/ep001/package.md'), pkgMd(over))
}

const ctx = { workspaceRegistry: { get: (id) => (id === 'ws' ? { id: 'ws', path: ws, sessionIds: [SID] } : undefined), list: () => [{ id: 'ws', path: ws, sessionIds: [SID] }] } }
const gate = makeProductionGateListener(ctx)
const next = () => ({ kind: 'allow' })
let seq = 0
const call = (over = {}) => ({
  name: 'comfy_generate_video',
  arguments: { type: 'r2v', tier: 'balanced', title: 'S01 片段', prompt: 'x', sessionId: SID, ref_nodes: ['card1'], ...over },
  agent: { id: `agent-${++seq}`, session: { id: SID, meta: { cwd: ws } } },
})

try {
  // 1. 没有 series 目录 → 单片项目，不触发
  rmSync(join(ws, 'series'), { recursive: true, force: true })
  ok((await gate(call(), next)).kind === 'allow', '无 series 目录：不触发（单片不受影响）')

  // 2. state 损坏 → 放行
  mkdirSync(join(ws, 'series'), { recursive: true })
  writeFileSync(join(ws, 'series/production-state.json'), '{ not json')
  ok((await gate(call(), next)).kind === 'allow', 'state 损坏：放行（不阻塞生成）')

  // 3. 阶段没到（先落一份 draft 包）
  writePkg({})
  writeState(state({ episodes: { ep001: { ...state().episodes.ep001, stage: 'assets' } } }))
  let r = await gate(call(), next)
  ok(r.kind === 'deny' && String(r.reason).includes('stage=assets'), '阶段还在 assets：deny', JSON.stringify(r))

  // 4. G-P 未批准
  writeState(state({ episodes: { ep001: { ...state().episodes.ep001, gate: { package: { status: 'pending' } } } } }))
  r = await gate(call(), next)
  ok(r.kind === 'deny' && String(r.reason).includes('G-P'), 'G-P 未批准：deny', JSON.stringify(r))

  // 5. 正常（draft）
  writeState(state())
  ok((await gate(call(), next)).kind === 'allow', 'stage=clips + G-P approved：放行')

  // 6. 包版本不一致
  writeState(state({ episodes: { ep001: { ...state().episodes.ep001, packageVersion: 3 } } }))
  r = await gate(call(), next)
  ok(r.kind === 'deny' && String(r.reason).includes('包版本不一致'), '包版本不一致：deny', JSON.stringify(r))

  // 7. 剧本版本不一致（改台词没重建包）
  writeState(state({ episodes: { ep001: { ...state().episodes.ep001, scriptVersion: 2 } } }))
  r = await gate(call(), next)
  ok(r.kind === 'deny' && String(r.reason).includes('剧本版本不一致'), '剧本版本不一致：deny', JSON.stringify(r))

  // 8. library 模式资产台账为空
  writeState(state())
  writePkg({ params: { assetMode: 'library' } })
  r = await gate(call(), next)
  ok(r.kind === 'deny' && String(r.reason).includes('阶段 C'), 'library 但资产台账为空：deny', JSON.stringify(r))

  // 9. library 模式资产锁定，但参考图不是资产库物化的
  writeState(state({
    assets: {
      characters: [{ name: '林晚', status: 'locked' }], scenes: [{ name: '办公室', status: 'locked' }], props: [], voices: [{ character: '林晚', status: 'locked' }],
    },
  }))
  r = await gate(call({ ref_nodes: ['card1'] }), next)
  ok(r.kind === 'deny' && String(r.reason).includes('params.assetId'), 'library 但参考图非资产库节点：deny', JSON.stringify(r))

  // 10. library + 锁定 + 资产库节点 → 放行
  ok((await gate(call({ ref_nodes: ['card2'] }), next)).kind === 'allow', 'library + 资产锁定 + 资产库节点：放行')

  // 11. 防死循环：同一 agent 连续 deny 3 次后放行
  writePkg({})
  writeState(state({ episodes: { ep001: { ...state().episodes.ep001, stage: 'assets' } } }))
  const fixedAgent = { id: 'loop-agent', session: { id: SID, meta: { cwd: ws } } }
  const loopCall = { name: 'comfy_generate_video', arguments: { type: 'r2v', tier: 'balanced', title: 'S01 片段', prompt: 'x', sessionId: SID }, agent: fixedAgent }
  const a = await gate(loopCall, next); const b = await gate(loopCall, next); const c = await gate(loopCall, next)
  ok(a.kind === 'deny' && b.kind === 'deny' && c.kind === 'allow', '连续 deny 2 次后降级放行')

  // 12. off 开关
  process.env.DSH_SVS_PRODUCTION_GATE = 'off'
  ok((await gate(call(), next)).kind === 'allow', 'DSH_SVS_PRODUCTION_GATE=off：整体关闭')
  delete process.env.DSH_SVS_PRODUCTION_GATE
} finally {
  rmSync(ws, { recursive: true, force: true })
}
console.log(`\n✓ smoke-production-gate：${passed} 项通过`)
