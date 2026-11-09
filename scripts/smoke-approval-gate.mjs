/**
 * 冒烟：创作批准门（approval gate，tools/pre-execute）+ canvas_approve
 * 覆盖：
 *  - 卡 → 表 → 分镜 → 视频 → 拼接 四道批准
 *  - 同角色/同标题重出放行，跨角色/跨卡未批准拒绝
 *  - 镜头表批准要求 shot-table self-check: passed 戳
 *  - clips 批准要求片段已 canvas_record_check pass，且与已有批准合并
 *  - 无连续 deny 降级；DSH_SVS_APPROVAL_GATE=off 放行
 *  - 批准按 breakingRev 失效
 * 用法：node scripts/smoke-approval-gate.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, _internals } from '../lib/index.js'

const {
  makeApprovalGateListener, approvalSummary, approvalIsCurrent, gateOn,
} = _internals

let passed = 0
function ok(cond, name, detail = '') {
  assert.ok(cond, name + (detail ? `：${detail}` : ''))
  passed++
  console.log('  ok -', name)
}

const root = mkdtempSync(join(tmpdir(), 'svs-approval-gate-'))
const sid = 'sid-approval'
const canvasDir = join(root, 'canvas', sid)
mkdirSync(canvasDir, { recursive: true })

const SHOT_ROW = '| S01 / 5s | 开场 | 起链 | 室内 | setup | 剧本依据: B01 — 0–5s | 模式: silent；对白: 无；口型: mouth-closed；声线参考: none；音效: 风；BGM: N/A；字幕: none |'
const TABLE_HEAD = [
  '| 镜头编号 & 时长 | 连续性衔接 | 续接 | 参考锚点（空间+身份） | Hook 类型 | 镜头描述（每秒指令） | 音频与对白轨 |',
  '|---|---|---|---|---|---|---|',
]
const STAMP = 'shot-table self-check: passed at 2026-11-09T08:00:00.000Z'

function tableNode(extra = STAMP) {
  return {
    id: 't1', kind: 'table', title: '七列镜头表', group: 'shot table', status: 'ready', order: 4,
    content: [extra, '', ...TABLE_HEAD, SHOT_ROW].join('\n'),
  }
}
const charA = { id: 'ch1', kind: 'image', title: 'Mia 角色卡·三视图', group: 'character cards', status: 'ready', order: 1, params: { character: 'Mia', cardVariant: 'three' } }
const charB = { id: 'ch2', kind: 'image', title: 'Leo 角色卡·三视图', group: 'character cards', status: 'ready', order: 2, params: { character: 'Leo', cardVariant: 'three' } }
const scene1 = { id: 'sc1', kind: 'image', title: '场景卡·门厅', group: 'scene cards', status: 'ready', order: 3 }
const scene2 = { id: 'sc2', kind: 'image', title: '场景卡·街道', group: 'scene cards', status: 'ready', order: 4 }
const storyboard = { id: 'sb1', kind: 'text', title: '单文本分镜 · 测试', group: 'text storyboards', content: '分镜正文', status: 'ready', order: 6 }
const video1 = { id: 'v1', kind: 'video', title: 'S01 片段', group: 'shot clips', status: 'ready', order: 10, params: { shot: true, selfCheck: { status: 'pass' } } }

const baseSettings = {
  flow: 'story', configured: true, aspectRatio: '9:16', mode: 'balanced',
  reviewMode: 'per-shot', shotGate: 'verdict', rev: 1, breakingRev: 0,
}

function writeProject(nodes, settings = baseSettings, approvals = {}) {
  writeFileSync(join(canvasDir, 'project.json'), JSON.stringify({
    schemaVersion: 1, sessionId: sid, settings, approvals, nodes,
  }, null, 2), 'utf8')
}
function readProject() {
  return JSON.parse(readFileSync(join(canvasDir, 'project.json'), 'utf8'))
}
function reset(nodes = [charA]) {
  writeProject(nodes)
}

const ctx = {
  workspaceRegistry: {
    get: (id) => (id === 'w' ? { id: 'w', path: root, sessionIds: [sid] } : undefined),
    list: () => [{ id: 'w', path: root, sessionIds: [sid] }],
  },
}
const gate = makeApprovalGateListener(ctx)
const next = async () => ({ kind: 'allow' })
function exec(name, args, agentId = 'agent-' + Math.random().toString(36).slice(2)) {
  return {
    name,
    arguments: { sessionId: sid, ...args },
    agent: { id: agentId, session: { id: sid, meta: { cwd: root } } },
  }
}
const img = (extra = {}) => exec('comfy_generate_image', { prompt: 'x', title: 'Leo 角色卡·三视图', character: 'Leo', card_variant: 'three', ...extra })
const vid = (extra = {}) => exec('comfy_generate_video', { type: 'r2v', title: 'S01 片段', tier: 'balanced', length: 120, ref_variant: 'single', ref_nodes: ['ch1'], ...extra })
const writeTable = (content) => exec('canvas_write_node', { kind: 'table', title: '七列镜头表', content })

// ---------- 0. 门组 ----------
console.log('# 门组')
ok(gateOn({ flow: 'story' }, 'approval') === true, 'story 开启 approval 门')
ok(gateOn({ flow: 'free' }, 'approval') === false, 'free 不开 approval 门')
ok(gateOn({ flow: 'story' }, 'deliver') === false, '未实现的 deliver 已从门组移除')

// ---------- 1. 卡片 ----------
console.log('# 卡片批准')
reset([charA])
let r = await gate(img(), next)
ok(r.kind === 'deny' && /角色卡还没人工锁定/.test(r.reason), 'A 未锁 → 新角色 B 被拒', r.reason)
r = await gate(img({ title: 'Mia 角色卡·三视图', character: 'Mia' }), next)
ok(r.kind === 'allow', '同角色重出 → 放行')
writeProject([charA, charB])
r = await gate(img({ title: '场景卡·街道', character: undefined }), next)
ok(r.kind === 'deny' && /角色卡还没人工锁定/.test(r.reason), '角色卡未锁 → 场景卡被拒', r.reason)
writeProject([charA, scene1], baseSettings, { assets: { at: Date.now(), configRev: 0, nodeIds: ['ch1'] } })
r = await gate(img({ title: '场景卡·街道', character: undefined }), next)
ok(r.kind === 'deny' && /上一张场景卡还没人工锁定/.test(r.reason), '上一张场景卡未锁 → 下一张被拒', r.reason)
r = await gate(img({ title: '场景卡·门厅', character: undefined }), next)
ok(r.kind === 'allow', '同标题场景卡重出 → 放行')

// ---------- 2. 用 canvas_approve 写账本 ----------
console.log('# canvas_approve')
const tools = {}
const mockCtx = new Proxy({
  webServer: { register: () => () => {} },
  tools: { register: (t) => { tools[t.name] = t; return () => {} }, get: () => undefined, execute: async () => ({}) },
  systemPrompt: { section: () => () => {} },
  workspaceRegistry: ctx.workspaceRegistry,
  effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
}, { get(target, prop) { return prop in target ? target[prop] : () => () => {} } })
apply(mockCtx)
const call = (name, args) => tools[name].execute({ sessionId: sid, ...args }, { agent: { id: sid, session: { id: sid, meta: { cwd: root } } } })

writeProject([charA])
let out = await call('canvas_approve', { target: 'assets' })
ok(out.ok && out.nodeIds.includes('ch1'), 'assets 缺省批准全部资产卡')
ok(readProject().approvals.assets.nodeIds.includes('ch1'), 'approvals.assets 已落盘')

writeProject([charA, scene1, storyboard, tableNode('')], baseSettings, {})
out = await call('canvas_approve', { target: 'shotTable' })
ok(!out.ok && /自检戳/.test(out.error), '无自检戳 → shotTable 批准被拒', out.error)
writeProject([charA, scene1, storyboard, tableNode()], baseSettings, {})
out = await call('canvas_approve', { target: 'shotTable' })
ok(out.ok && out.nodeId === 't1', '有戳 → shotTable 批准成功')
out = await call('canvas_approve', { target: 'storyboard' })
ok(out.ok && out.nodeId === 'sb1', 'storyboard 批准成功')

writeProject([charA, scene1, tableNode(), video1])
out = await call('canvas_approve', { target: 'clips', nodeIds: ['v1'] })
ok(out.ok && out.nodeIds.includes('v1'), '片段已自检 pass → clips 批准成功')
writeProject([charA, scene1, tableNode(), { ...video1, params: { shot: true, selfCheck: { status: 'pending' } } }])
out = await call('canvas_approve', { target: 'clips', nodeIds: ['v1'] })
ok(!out.ok && /还没通过 AI 自检/.test(out.error), '未自检 pass → clips 批准被拒', out.error)

// ---------- 3. 镜头表写入 ----------
console.log('# 镜头表写入')
reset([charA])
r = await gate(writeTable(tableNode().content), next)
ok(r.kind === 'deny' && /资产卡还没人工锁定/.test(r.reason), '卡片未锁 → 写七列镜头表被拒', r.reason)
writeProject([charA], baseSettings, { assets: { at: Date.now(), configRev: 0, nodeIds: ['ch1'] } })
r = await gate(writeTable(tableNode().content), next)
ok(r.kind === 'allow', '卡片已锁 → 写镜头表放行')

// ---------- 4. 视频 ----------
console.log('# 视频')
const allApproved = {
  assets: { at: Date.now(), configRev: 0, nodeIds: ['ch1', 'sc1'] },
  shotTable: { at: Date.now(), configRev: 0, nodeId: 't1', hash: _internals.textHash(tableNode().content) },
  storyboard: { at: Date.now(), configRev: 0, nodeId: 'sb1', hash: _internals.textHash('分镜正文') },
}
writeProject([charA, scene1, storyboard, tableNode(), video1], baseSettings, {})
r = await gate(vid(), next)
ok(r.kind === 'deny' && /资产卡未全部人工锁定/.test(r.reason), '资产未批 → 视频被拒', r.reason)
writeProject([charA, scene1, storyboard, tableNode(), video1], baseSettings, { ...allApproved, shotTable: undefined })
r = await gate(vid(), next)
ok(r.kind === 'deny' && /镜头表未人工批准/.test(r.reason), '表未批 → 视频被拒', r.reason)
writeProject([charA, scene1, storyboard, tableNode(), video1], baseSettings, { ...allApproved, storyboard: undefined })
r = await gate(vid(), next)
ok(r.kind === 'deny' && /分镜未人工批准/.test(r.reason), '分镜未批 → 视频被拒', r.reason)
writeProject([charA, scene1, storyboard, tableNode(), video1], baseSettings, allApproved)
r = await gate(vid(), next)
ok(r.kind === 'allow', '全部批准 → 视频放行')
r = await gate(exec('comfy_generate_video', { type: 'r2v', title: 'Mia 试镜', tier: 'balanced' }), next)
ok(r.kind === 'allow', '试镜片段（无 Sxx）不参与批准门')

// 表内容改了 → 旧批准失效（批准绑定内容哈希）
writeProject([charA, scene1, storyboard, tableNode('<!-- changed -->'), video1], baseSettings, allApproved)
r = await gate(vid(), next)
ok(r.kind === 'deny' && /镜头表未人工批准/.test(r.reason), '表内容改了 → 旧批准失效、视频被拒', r.reason)

// ---------- 5. 拼接 ----------
console.log('# 拼接')
writeProject([charA, scene1, storyboard, tableNode(), video1], baseSettings, allApproved)
r = await gate(exec('video_concat', { nodes: ['v1'] }), next)
ok(r.kind === 'deny' && /还没有人工片段批准/.test(r.reason), '片段未批 → 拼接被拒', r.reason)
writeProject([charA, scene1, storyboard, tableNode(), video1], baseSettings, {
  ...allApproved, clips: { at: Date.now(), configRev: 0, nodeIds: ['v1'] },
})
r = await gate(exec('video_concat', { nodes: ['v1'] }), next)
ok(r.kind === 'allow', '片段已批 → 拼接放行')

// ---------- 6. 防绕过 ----------
console.log('# 防绕过')
reset([charA])
let rs = []
for (let i = 0; i < 3; i++) rs.push((await gate(exec('comfy_generate_image', { prompt: 'x', title: 'Leo 角色卡·三视图', character: 'Leo' }, 'same-agent'), next)).kind)
ok(rs.every((x) => x === 'deny'), '同一 agent 连续 3 次仍 deny（无降级放行）', JSON.stringify(rs))
process.env.DSH_SVS_APPROVAL_GATE = 'off'
r = await gate(img(), next)
ok(r.kind === 'allow', 'DSH_SVS_APPROVAL_GATE=off → 放行')
delete process.env.DSH_SVS_APPROVAL_GATE

// ---------- 7. breakingRev 失效 ----------
console.log('# 配置版本失效')
writeProject([charA, scene1, storyboard, tableNode(), video1], { ...baseSettings, breakingRev: 1 }, allApproved)
r = await gate(vid(), next)
ok(r.kind === 'deny' && /资产卡未全部人工锁定/.test(r.reason), 'breakingRev 变化 → 旧批准失效', r.reason)
ok(approvalIsCurrent(readProject(), 'assets') === false, 'approvalIsCurrent 识别失效')
ok(approvalSummary(readProject()).assets.approved === false, 'approvalSummary 识别失效')

console.log(`\n结果：${passed} 项通过`)
