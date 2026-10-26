/**
 * 冒烟：逐镜自检门（shot gate）
 * 覆盖 shotGateLevel 归一化 + 生成/拼接 deny 路径 + 重渲豁免 + 续接来源检查 +
 * 老镜头豁免 + frames 档 + off 档 + 防死循环 + canvas_record_check 的 pass 凭据校验。
 * 用法：node scripts/smoke-shot-gate.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, _internals } from '../lib/index.js'

const {
  makeShotGateListener, shotGateLevel, isShotNode, shotGateSatisfied, selfCheckStatus, shotFrames,
} = _internals

let passed = 0
function ok(cond, name) {
  assert.ok(cond, name)
  passed++
  console.log('  ok -', name)
}

// ---------- 0. 纯函数 ----------
console.log('# shotGateLevel / shotGateSatisfied')
{
  ok(shotGateLevel({}) === 'verdict', '缺省 verdict')
  ok(shotGateLevel({ shotGate: 'verdict' }) === 'verdict', 'verdict')
  ok(shotGateLevel({ shotGate: 'frames' }) === 'frames', 'frames')
  ok(shotGateLevel({ shotGate: 'off' }) === 'off', 'off')
  ok(shotGateLevel({ shotGate: 'bogus' }) === 'verdict', '非法值按 verdict')

  const shot = (status, frames = []) => ({ id: 's', kind: 'video', params: { shot: true, selfCheck: { status }, checkFrames: frames } })
  ok(isShotNode(shot('pending')), '视频产物是镜头')
  ok(!isShotNode({ id: 'x', kind: 'video', params: {} }), '拼接/超分（无 shot 标记）不是镜头')
  ok(!isShotNode({ id: 'y', kind: 'image', params: { shot: true } }), '图片不是镜头')
  ok(!shotGateSatisfied(shot('pending'), 'verdict'), 'pending 未过 verdict 门')
  ok(shotGateSatisfied(shot('pass'), 'verdict'), 'pass 过 verdict 门')
  ok(!shotGateSatisfied(shot('pending', []), 'frames'), '没抽帧未过 frames 门')
  ok(shotGateSatisfied(shot('pending', ['f1']), 'frames'), '抽过帧过 frames 门（frames 档不看结论）')
  ok(selfCheckStatus(shot('fail')) === 'fail', 'selfCheckStatus')
  ok(shotFrames(shot('pass', ['f1', 'f2'])).length === 2, 'shotFrames')
}

// ---------- 1. 准备临时工作区 ----------
const root = mkdtempSync(join(tmpdir(), 'dsh-svs-shotgate-'))
const sid = 'sid-gate'
const canvasDir = join(root, 'canvas', sid)
mkdirSync(canvasDir, { recursive: true })

function writeProject(settings, nodes) {
  writeFileSync(join(canvasDir, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    sessionId: sid,
    settings: { aspectRatio: '9:16', reviewMode: 'batch', shotGate: 'verdict', ...settings },
    nodes,
  }), 'utf8')
}
function readProject() {
  return JSON.parse(readFileSync(join(canvasDir, 'project.json'), 'utf8'))
}
/** 镜头节点（runRender 视频产物形态）。 */
function shotNode(id, order, status, frames = [], extra = {}) {
  return {
    id, kind: 'video', title: `S0${order} 片段`, group: 'shots', status: 'ready', order,
    media: `canvas/${sid}/${id}.mp4`,
    params: { shot: true, selfCheck: { status, frames, at: Date.now() }, checkFrames: frames, ...extra },
  }
}
function imageNode(id, order) {
  return { id, kind: 'image', title: `S0${order} 抽帧`, group: 'shots', status: 'ready', order, media: `canvas/${sid}/${id}.png`, params: {} }
}

// mock 宿主（apply 需要）：workspaceRegistry 指向临时 root，其余 no-op
const mockCtx = new Proxy({
  webServer: { register: () => () => {} },
  tools: { register: () => () => {}, get: () => undefined, execute: async () => ({}) },
  systemPrompt: { section: () => () => {} },
  workspaceRegistry: {
    get: (id) => (id === 'ws-gate' ? { id: 'ws-gate', path: root, sessionIds: [sid] } : undefined),
    list: () => [{ id: 'ws-gate', path: root, sessionIds: [sid] }],
  },
  effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
}, { get(target, prop) { return prop in target ? target[prop] : () => () => {} } })
apply(mockCtx)

const tools = _internals.makeTools()
const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
const recordCheck = byName.canvas_record_check
ok(!!recordCheck, 'canvas_record_check 已注册')
ok(recordCheck.parameters.required.includes('verdict'), 'verdict 必填')

const agent = { id: sid, session: { id: sid, meta: { cwd: root } } }
const gate = makeShotGateListener({ workspaceRegistry: mockCtx.workspaceRegistry })
const next = () => ({ kind: 'allow' })
const genExec = (extra = {}) => ({ name: 'comfy_generate_video', arguments: { type: 'r2v', prompt: 'x', sessionId: sid, ...extra }, agent })

async function record(args) {
  return recordCheck.execute({ sessionId: sid, ...args }, { agent })
}

try {
  // ---------- 2. 生成前门控 ----------
  console.log('# 生成前门控（verdict 档）')
  writeProject({}, [])
  ok((await gate(genExec(), next)).kind === 'allow', '空画布：第一镜放行')

  writeProject({}, [shotNode('s1', 1, 'pending')])
  let r = await gate(genExec(), next)
  ok(r.kind === 'deny', '上一镜 pending：拒绝下一镜')
  ok(String(r.reason).includes('S01 片段'), 'reason 点名被挡镜头')
  ok(String(r.reason).includes('canvas_record_check'), 'reason 给出放行工具')
  ok(String(r.reason).includes('shotGate'), 'reason 给出关闭开关')

  r = await gate(genExec({ nodeId: 's1' }), next)
  ok(r.kind === 'allow', '重渲该镜本人（nodeId=s1）放行')

  writeProject({}, [shotNode('s1', 1, 'pass'), shotNode('s2', 2, 'pending')])
  r = await gate(genExec(), next)
  ok(r.kind === 'deny' && String(r.reason).includes('S02'), '最近一镜 pending：拒绝（点名 S02）')

  writeProject({}, [shotNode('s1', 1, 'pass')])
  ok((await gate(genExec(), next)).kind === 'allow', '最近一镜 pass：放行下一镜')

  writeProject({}, [shotNode('s1', 1, 'fail')])
  r = await gate(genExec(), next)
  ok(r.kind === 'deny' && String(r.reason).includes('fail'), '上一镜 fail：拒绝')

  // 续接来源检查
  writeProject({}, [shotNode('s1', 1, 'pending')])
  r = await gate(genExec({ continuity_from: 's1' }), next)
  ok(r.kind === 'deny' && String(r.reason).includes('续接来源'), '续接来源未过门：拒绝')
  writeProject({}, [shotNode('s1', 1, 'pass')])
  ok((await gate(genExec({ continuity_from: 's1' }), next)).kind === 'allow', '续接来源 pass：放行')

  // 老镜头（打标前生成，无 params.shot）不参与门控
  writeProject({}, [{ id: 'old', kind: 'video', title: '老镜头', status: 'ready', order: 1, media: `canvas/${sid}/old.mp4`, params: {} }])
  ok((await gate(genExec(), next)).kind === 'allow', '老镜头（无 shot 标记）豁免')

  // ---------- 3. frames / off 档 ----------
  console.log('# frames / off 档')
  writeProject({ shotGate: 'frames' }, [shotNode('s1', 1, 'pending', [])])
  r = await gate(genExec(), next)
  ok(r.kind === 'deny' && String(r.reason).includes('extract_frame'), 'frames 档：没抽帧拒绝')
  writeProject({ shotGate: 'frames' }, [shotNode('s1', 1, 'pending', ['f1'])])
  ok((await gate(genExec(), next)).kind === 'allow', 'frames 档：抽过帧即放行（不看结论）')

  writeProject({ shotGate: 'off' }, [shotNode('s1', 1, 'pending')])
  ok((await gate(genExec(), next)).kind === 'allow', 'off 档：完全关闭')

  // ---------- 4. 后处理 / 其他能力不受门控 ----------
  console.log('# 后处理不受门控')
  writeProject({}, [shotNode('s1', 1, 'pass'), shotNode('s2', 2, 'pending')])
  const concatExec = { name: 'video_concat', arguments: { nodes: ['s1', 's2'], sessionId: sid }, agent }
  ok((await gate(concatExec, next)).kind === 'allow', 'video_concat 不受逐镜自检门约束（即使有 pending 镜）')
  ok((await gate({ name: 'video_upscale', arguments: { video_node: 's2', sessionId: sid }, agent }, next)).kind === 'allow', 'video_upscale 不受门控')
  ok((await gate({ name: 'comfy_generate_image', arguments: { prompt: 'x', sessionId: sid }, agent }, next)).kind === 'allow', '图片生成不受门控影响')

  // ---------- 5. 防死循环 ----------
  console.log('# 防死循环')
  writeProject({}, [shotNode('s1', 1, 'pending')])
  const loopExec = genExec()
  ok((await gate(loopExec, next)).kind === 'deny', '第 1 次 deny')
  ok((await gate(loopExec, next)).kind === 'deny', '第 2 次 deny')
  ok((await gate(loopExec, next)).kind === 'allow', '第 3 次降级放行')

  // ---------- 6. canvas_record_check ----------
  console.log('# canvas_record_check')
  writeProject({}, [shotNode('s1', 1, 'pending'), imageNode('f1', 2), imageNode('f2', 3)])

  let rec = await record({ nodeId: 's1', verdict: 'pass' })
  ok(rec.ok === false && /抽帧证据/.test(rec.error), '无抽帧证据：pass 被拒')

  rec = await record({ nodeId: 's1', verdict: 'pass', frames: ['nope'] })
  ok(rec.ok === false && /不存在/.test(rec.error), '帧节点不存在：拒绝')

  rec = await record({ nodeId: 'f1', verdict: 'pass', frames: ['f1'] })
  ok(rec.ok === false && /只有视频节点/.test(rec.error), '非视频节点：拒绝')

  rec = await record({ nodeId: 's1', verdict: 'fail', notes: '角色发型漂移' })
  ok(rec.ok === true && rec.status === 'fail', 'fail 无需抽帧即可记录')
  ok(readProject().nodes.find((n) => n.id === 's1').params.selfCheck.status === 'fail', 'fail 已持久化')

  rec = await record({ nodeId: 's1', verdict: 'pass', frames: ['f1', 'f2'], notes: '一致性 OK' })
  ok(rec.ok === true && rec.status === 'pass', '带抽帧证据 pass 成功')
  const saved = readProject().nodes.find((n) => n.id === 's1')
  ok(saved.params.selfCheck.status === 'pass' && saved.params.selfCheck.frames.length === 2, 'selfCheck 持久化（含帧）')
  ok(saved.params.checkFrames.length === 2, 'checkFrames 同步')

  ok((await gate(genExec(), next)).kind === 'allow', '记录 pass 后下一镜放行')

  // extract_frame 自动记帧：直接验证节点上的 checkFrames 会被记录（无法真抽帧，模拟工具记账后的项目）
  writeProject({}, [shotNode('s1', 1, 'pending', []), imageNode('f1', 2)])
  const p2 = readProject()
  p2.nodes[0].params.checkFrames = ['f1']
  writeFileSync(join(canvasDir, 'project.json'), JSON.stringify(p2), 'utf8')
  rec = await record({ nodeId: 's1', verdict: 'pass' })
  ok(rec.ok === true && rec.frames.length === 1, 'extract_frame 记账的帧可作 pass 凭据')

  // ---------- 7. 默认开启：缺省 / 非法值读回 verdict ----------
  console.log('# shotGate 默认值（默认开启）')
  writeProject({ shotGate: undefined }, [])
  let st = await byName.canvas_get_state.execute({ sessionId: sid }, { agent })
  ok(st.settings.shotGate === 'verdict', '没写 shotGate：读回 verdict（默认开启）')
  writeProject({ shotGate: 'bogus' }, [])
  st = await byName.canvas_get_state.execute({ sessionId: sid }, { agent })
  ok(st.settings.shotGate === 'verdict', '非法值：读回 verdict')
  writeProject({ shotGate: 'off' }, [])
  st = await byName.canvas_get_state.execute({ sessionId: sid }, { agent })
  ok(st.settings.shotGate === 'off', '显式关闭保留 off')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n结果：${passed} passed`)
