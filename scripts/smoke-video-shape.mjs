/**
 * scripts/smoke-video-shape.mjs — 视频「形状」(type) 契约冒烟测试。
 *
 * 不触网、不调 ComfyUI（非法请求在解析阶段就报错，早于任何上传）。
 * 验证的是这张真值表 —— 形状必须**显式声明**，形状与参数冲突直接报错并给修法：
 *
 *   type=r2v（video.reference2video）：用 ref_nodes；禁止 first_frame_node / last_frame_node
 *   type=i2v（video.image2video）     ：必须 first_frame_node（last_frame_node 可选）；禁止 ref_nodes
 *   续接（continuity_from）与形状正交：r2v 已支持；i2v 尚未落地（显式报错，不静默降级）
 *
 * 用法：node scripts/smoke-video-shape.mjs
 */

process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || '/nonexistent/svs-smoke-config.json'

import { _internals, apply } from '../lib/index.js'

const { validateVideoArgs, VIDEO_SHAPES } = _internals

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
const throwsWith = (name, fn, needle) => {
  try { fn(); ok(name, false, '未抛错') }
  catch (e) { ok(name, String(e.message).includes(needle), `报错里没有「${needle}」：${e.message}`) }
}

console.log('\n[1] 真值表本身')
eq('r2v → video.reference2video', VIDEO_SHAPES.r2v.capability, 'video.reference2video')
eq('i2v → video.image2video', VIDEO_SHAPES.i2v.capability, 'video.image2video')
eq('r2v 禁止首/末帧', VIDEO_SHAPES.r2v.forbid.join(','), 'first_frame_node,last_frame_node')
eq('i2v 禁止参考图', VIDEO_SHAPES.i2v.forbid.join(','), 'ref_nodes')
eq('i2v 必须首帧', VIDEO_SHAPES.i2v.require.join(','), 'first_frame_node')

console.log('\n[2] 合法组合放行')
eq('r2v + ref_nodes', validateVideoArgs('video.reference2video', { type: 'r2v', ref_nodes: ['a.png'] }).shape, 'r2v')
eq('r2v + ref_nodes 无警告', validateVideoArgs('video.reference2video', { type: 'r2v', ref_nodes: ['a.png'] }).warnings.length, 0)
eq('i2v + first_frame_node', validateVideoArgs('video.image2video', { type: 'i2v', first_frame_node: 'n1' }).shape, 'i2v')
eq('i2v + 首帧 + 末帧', validateVideoArgs('video.image2video', { type: 'i2v', first_frame_node: 'n1', last_frame_node: 'n2' }).warnings.length, 0)
eq('r2v + continuity_from（续接与形状正交）', validateVideoArgs('video.reference2video', { type: 'r2v', ref_nodes: ['a.png'], continuity_from: 'v1' }).shape, 'r2v')
eq('非视频能力直接放行', validateVideoArgs('image.text2image', { ref_nodes: ['a.png'] }).shape, null)
eq('image.image2image 用 ref_nodes 不受影响', validateVideoArgs('image.image2image', { ref_nodes: ['a.png'], first_frame_node: 'x' }).shape, null)

console.log('\n[3] 冲突 → 报错（带修法）')
throwsWith('r2v + first_frame_node 被拒', () => validateVideoArgs('video.reference2video', { type: 'r2v', first_frame_node: 'n1' }), '不接受 first_frame_node')
throwsWith('r2v + last_frame_node 被拒', () => validateVideoArgs('video.reference2video', { type: 'r2v', last_frame_node: 'n2' }), '不接受 last_frame_node')
throwsWith('r2v 的报错给出修法', () => validateVideoArgs('video.reference2video', { first_frame_node: 'n1' }), 'continuity_from=上一镜节点 id')
throwsWith('i2v + ref_nodes 被拒', () => validateVideoArgs('video.image2video', { type: 'i2v', first_frame_node: 'n1', ref_nodes: ['a.png'] }), 'i2v 不接受 ref_nodes')
throwsWith('i2v 缺首帧被拒', () => validateVideoArgs('video.image2video', { type: 'i2v' }), '必须传 first_frame_node')
// i2v 现已支持链式续接（i2v 版 ctx 模板已落地）→ 只校验"形状不禁止续接"，不再抛错
const i2vChain = validateVideoArgs('video.image2video', { type: 'i2v', first_frame_node: 'n1', continuity_from: 'v1' })
ok('i2v + continuity_from 合法（i2v ctx 已落地）', i2vChain.shape === 'i2v', JSON.stringify(i2vChain))
throwsWith('type 与 capability 不一致被拒', () => validateVideoArgs('video.image2video', { type: 'r2v', first_frame_node: 'n1' }), '不一致')

console.log('\n[4] r2v 无参考图 → 警告而非报错（纯文本生成仍合法）')
const noRefs = validateVideoArgs('video.reference2video', { type: 'r2v' })
eq('无警告条数 = 1', noRefs.warnings.length, 1)
ok('警告说明一致性无从保证', String(noRefs.warnings[0]).includes('未传 ref_nodes'), noRefs.warnings[0])

console.log('\n[5] 工具面：type 必填 + 缺/错 type 的报错文案（不触网，提前返回）')
const registered = []
const workspace = { id: 'ws-shape', path: '/nonexistent/ws-shape', sessionIds: ['shape-sid'] }
// 宿主 ctx：只实现本测试需要的 API；**未知 API 一律 no-op**（宿主演进时不至于让冒烟测试变脆）。
const noop = () => () => {}
const mockCtx = new Proxy({
  webServer: { register: () => () => {} },
  tools: { register: (t) => { registered.push(t); return () => {} }, get: () => undefined, execute: async () => ({}) },
  systemPrompt: { section: () => () => {} },
  workspaceRegistry: { get: (id) => (id === 'ws-shape' ? workspace : undefined), list: () => [workspace], resolveByPath: async () => undefined },
  effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
}, {
  get(target, prop) { return prop in target ? target[prop] : noop },
})
apply(mockCtx)
const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
const videoTool = byName['comfy_generate_video']
ok('comfy_generate_video 已注册', Boolean(videoTool))
const schema = videoTool.parameters
ok('type 在 required 里（必填）', (schema.required || []).includes('type'), JSON.stringify(schema.required))
eq('type 枚举 = r2v/i2v', (schema.properties.type.enum || []).join(','), 'r2v,i2v')
ok('comfy_render 也接受 type（可选）', Boolean(byName['comfy_render']?.parameters?.properties?.type))
const exec = { agent: { id: 'shape-sid', session: { meta: { cwd: '/nonexistent/ws-shape' } } } }
const call = (args) => videoTool.execute({ prompt: 'p', sessionId: 'shape-sid', workspaceId: 'ws-shape', ...args }, exec)
const missing = await call({})
eq('缺 type → 失败', missing.ok, false)
ok('缺 type 的报错点名 type 并给两条路', String(missing.error).includes('缺少或非法的 type') && String(missing.error).includes('type=r2v') && String(missing.error).includes('type=i2v'), missing.error)
const bogus = await call({ type: 't2v' })
eq('非法 type=t2v → 失败', bogus.ok, false)
ok('非法 type 的报错列出合法值', String(bogus.error).includes('r2v') && String(bogus.error).includes('i2v'), bogus.error)
const both = await call({ type: 'i2v', first_frame_node: 'n1', ref_nodes: ['a.png'] })
eq('i2v + ref_nodes → 失败', both.ok, false)
ok('报错提示二选一', String(both.error).includes('i2v 不接受 ref_nodes'), both.error)

console.log(`\n${fail ? '✗' : '✓'} smoke-video-shape：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
