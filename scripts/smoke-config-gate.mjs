/**
 * 冒烟：配置门（config gate，tools/pre-execute）
 * 覆盖：R12 未建卡 / R1 画幅 / R2 fast+三视图 / R3 single 配置却用三视图 /
 * R4 三→单回退 / 节点级三视图识别 / 连续 deny 降级 / DSH_SVS_CONFIG_GATE=off。
 * 用法：node scripts/smoke-config-gate.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _internals } from '../lib/index.js'

const { applyProjectConfig, makeConfigGateListener, configGateOp } = _internals

let passed = 0
function ok(cond, name) {
  assert.ok(cond, name)
  passed++
  console.log('  ok -', name)
}

const root = mkdtempSync(join(tmpdir(), 'svs-config-gate-'))
const sid = 's-gate'
mkdirSync(join(root, 'canvas', sid), { recursive: true })

const ctx = {
  workspaceRegistry: {
    get: (id) => (String(id) === 'w' ? { id: 'w', path: root, sessionIds: [sid] } : undefined),
    list: () => [{ id: 'w', path: root, sessionIds: [sid] }],
  },
}
const gate = makeConfigGateListener(ctx)
const next = async () => ({ kind: 'allow' })
let seq = 0
const exec = (name, args, agentId = 'a' + (++seq)) => ({
  name,
  arguments: { sessionId: sid, ...args },
  agent: { id: agentId },
})

// ---- 0. 操作归类 ----
console.log('# configGateOp')
{
  ok(configGateOp('comfy_generate_image', {}) === 'image', '图片生成')
  ok(configGateOp('comfy_generate_video', {}) === 'video', '视频生成')
  ok(configGateOp('video_concat', {}) === 'post', '拼接是后处理')
  ok(configGateOp('comfy_render', { capability: 'video.upscale' }) === 'post', 'comfy_render 超分是后处理')
  ok(configGateOp('comfy_render', { capability: 'image.from_video' }) === null, '抽帧不受配置门约束')
  ok(configGateOp('canvas_set_state', {}) === null, '写配置本身不被门拦')
}

// ---- 1. R12：未建卡 ----
console.log('# R12 未建配置卡')
{
  const r = await gate(exec('comfy_generate_image', { prompt: 'x' }), next)
  ok(r.kind === 'deny' && r.reason.includes('配置卡'), '未配置 → deny 并提示建卡')
  const r2 = await gate(exec('canvas_set_state', { flow: 'story' }), next)
  ok(r2.kind === 'allow', 'canvas_set_state 不被拦（否则无法建卡）')
}

// 建卡
await applyProjectConfig(root, sid, { flow: 'story', aspectRatio: '9:16', mode: 'balanced' }, { source: 'agent' })
console.log('# 建卡后')
ok((await gate(exec('comfy_generate_image', { prompt: 'x' }), next)).kind === 'allow', '已配置 → 放行')

// ---- 2. R1：画幅 ----
console.log('# R1 画幅')
{
  const bad = await gate(exec('comfy_generate_image', { prompt: 'x', width: 1920, height: 1080 }), next)
  ok(bad.kind === 'deny' && bad.reason.includes('画幅'), '16:9 请求 ≠ 9:16 配置 → deny')
  const good = await gate(exec('comfy_generate_image', { prompt: 'x', width: 1080, height: 1920 }), next)
  ok(good.kind === 'allow', '9:16 请求 → 放行')
  const one = await gate(exec('comfy_generate_image', { prompt: 'x', width: 1080 }), next)
  ok(one.kind === 'allow', '只传一边 → 由工具按比例补齐，放行')
}

// ---- 3. R2：fast + 三视图 ----
console.log('# R2 fast + 三视图')
{
  await applyProjectConfig(root, sid, { mode: 'fast' }, { source: 'agent' })
  const r = await gate(exec('comfy_generate_video', { type: 'r2v', prompt: 'x', ref_variant: 'three' }), next)
  ok(r.kind === 'deny' && r.reason.includes('fast'), 'fast + three → deny')
  const okr = await gate(exec('comfy_generate_video', { type: 'r2v', prompt: 'x', ref_variant: 'single' }), next)
  ok(okr.kind === 'allow', 'fast + single → 放行')
}

// ---- 4. R3 / R4：single 配置与三视图 ----
console.log('# R3/R4 角色卡版本')
{
  await applyProjectConfig(root, sid, { mode: 'balanced' }, { source: 'agent' })
  const r = await gate(exec('comfy_generate_video', { type: 'r2v', prompt: 'x', ref_variant: 'three' }), next)
  ok(r.kind === 'deny' && r.reason.includes('单视图'), 'single 配置 + three 请求 → deny')
  const r4 = await gate(exec('comfy_generate_video', { type: 'r2v', prompt: 'x', ref_variant: 'single' }), next)
  ok(r4.kind === 'allow', 'three→single 回退方向放行')

  // 节点级识别：ref_nodes 指向三视图卡
  const project = JSON.parse(readFileSync(join(root, 'canvas', sid, 'project.json'), 'utf8'))
  project.nodes.push({ id: 'card-three', kind: 'image', title: '三视图卡', group: 'character cards', media: '', params: { character: 'a', cardVariant: 'three' }, status: 'ready', order: 99 })
  writeFileSync(join(root, 'canvas', sid, 'project.json'), JSON.stringify(project, null, 2))
  const rn = await gate(exec('comfy_generate_video', { type: 'r2v', prompt: 'x', ref_nodes: ['card-three'] }), next)
  ok(rn.kind === 'deny' && rn.reason.includes('三视图'), 'ref_nodes 指向三视图卡也拦')
}

// ---- 4b. 漂移：旧镜头表 / 旧片段 / 旧参考卡 ----
console.log('# 漂移（configRev < breakingRev）')
{
  const project = JSON.parse(readFileSync(join(root, 'canvas', sid, 'project.json'), 'utf8'))
  const table = '| 镜头编号 & 时长 | 连续性衔接 | 续接 | 参考锚点（空间+身份） | Hook 类型 | 镜头描述（每秒指令） | 音频与对白轨 |\n' +
    '|---|---|---|---|---|---|---|\n' +
    '| S01 / 5s | 开场 | 起链 | x | setup | 0–5s 推门 | 模式: silent；音效: 门轴 |'
  project.settings.rev = 9
  project.settings.breakingRev = 9
  project.nodes.push({ id: 'plan-old', kind: 'table', title: '七列镜头表', group: 'shot table', status: 'ready', order: 10, content: table, params: { configRev: 3 } })
  project.nodes.push({ id: 'clip-old', kind: 'video', title: 'S01 片段', group: 'shot clips', status: 'ready', order: 11, media: 'x.mp4', params: { configRev: 3, shot: true } })
  project.nodes.push({ id: 'card-old', kind: 'image', title: '角色卡', group: 'character cards', status: 'ready', order: 12, media: 'x.png', params: { configRev: 3, character: 'a', cardVariant: 'single' } })
  writeFileSync(join(root, 'canvas', sid, 'project.json'), JSON.stringify(project, null, 2))

  const planDeny = await gate(exec('comfy_generate_video', { type: 'r2v', prompt: 'x', title: 'S01 片段' }), next)
  ok(planDeny.kind === 'deny' && planDeny.reason.includes('镜头表'), '旧镜头表 → deny')
  const concatDeny = await gate(exec('video_concat', { nodes: ['clip-old'] }), next)
  ok(concatDeny.kind === 'deny' && concatDeny.reason.includes('片段'), '旧片段拼接 → deny')
  const refDeny = await gate(exec('comfy_generate_video', { type: 'r2v', prompt: 'x', ref_nodes: ['card-old'], ref_variant: 'single' }), next)
  ok(refDeny.kind === 'deny' && refDeny.reason.includes('参考卡'), '旧参考卡 → deny')
}

// ---- 5. 连续 deny 降级 ----
console.log('# 防死循环')
{
  const agentId = 'loop-agent'
  const badArgs = { prompt: 'x', width: 1920, height: 1080 }
  ok((await gate(exec('comfy_generate_image', badArgs, agentId), next)).kind === 'deny', '第 1 次 deny')
  ok((await gate(exec('comfy_generate_image', badArgs, agentId), next)).kind === 'deny', '第 2 次 deny')
  ok((await gate(exec('comfy_generate_image', badArgs, agentId), next)).kind === 'deny', '第 3 次 deny')
  ok((await gate(exec('comfy_generate_image', badArgs, agentId), next)).kind === 'allow', '第 4 次降级放行')
}

// ---- 6. 逃生阀 ----
console.log('# DSH_SVS_CONFIG_GATE=off')
{
  process.env.DSH_SVS_CONFIG_GATE = 'off'
  const r = await gate(exec('comfy_generate_image', { prompt: 'x', width: 1920, height: 1080 }), next)
  ok(r.kind === 'allow', 'off 时全放行')
  delete process.env.DSH_SVS_CONFIG_GATE
}

rmSync(root, { recursive: true, force: true })
console.log(`\n全部通过（${passed} 项）`)
