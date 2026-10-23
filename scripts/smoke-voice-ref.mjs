/**
 * scripts/smoke-voice-ref.mjs — 参考音频（H3 Ref2VA <Audio N>）冒烟测试（不触网 / 不跑 GPU）。
 *
 * 覆盖三件事：
 *  1) 清单层：哪些 ref2v 实现接了 params.ref_audios、i2v / 2K / hires 必须没有；
 *  2) 图编译：传 ref_audios → LoadAudio + ref_audios.ref_audio_i；不传 → 图里零 LoadAudio
 *     （「缺省零影响」的硬保证）；
 *  3) 形状真值表：i2v 传音频 / 超 3 段 / 缺伴随图 都要在**上传前**报错。
 *
 * 用法：node scripts/smoke-voice-ref.mjs
 */
process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || '/nonexistent/svs-smoke-config.json'

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadBuiltinManifests, buildGraphFromManifest } from '../lib/manifest.js'
import { _internals } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const workflowsDir = join(__dirname, '..', 'workflows')

let failures = 0
function ok(cond, msg) {
  if (cond) console.log('  ✓ ' + msg)
  else { failures++; console.error('  ✗ ' + msg) }
}

const reg = loadBuiltinManifests(workflowsDir)
const byId = reg.byId
const all = Object.values(byId).filter((m) => m.id.startsWith('minimax-h3-'))

console.log('== 1) 清单声明面 ==')
const ref2v = all.filter((m) => m.capability === 'video.reference2video')
const i2v = all.filter((m) => m.capability === 'video.image2video')
const withAudio = ref2v.filter((m) => m.params && m.params.ref_audios)
const withoutAudio = ref2v.filter((m) => !(m.params && m.params.ref_audios))
ok(ref2v.length === 20, `ref2v 清单 20 份（实际 ${ref2v.length}）`)
ok(withAudio.length === 14, `14 份 ref2v 声明了 ref_audios（实际 ${withAudio.length}）`)
ok(withoutAudio.length === 6, `6 份未声明（2K×5 + hires×1，实际 ${withoutAudio.length}: ${withoutAudio.map((m) => m.id).join(',')}）`)
ok(withoutAudio.every((m) => /-2k$|-hires$/.test(m.id)), '未声明集恰好是 2K / hires 家族')
ok(i2v.every((m) => !(m.params && m.params.ref_audios)), 'i2v 19 份全部没有 ref_audios（节点没有音频输入槽）')
for (const m of withAudio) {
  const p = m.params.ref_audios
  if (!p || p.inject !== 'audio' || p.node !== 'LoadAudio' || p.input !== 'audio' || p.max !== 3) {
    ok(false, `${m.id} 的 ref_audios 声明不完整：${JSON.stringify(p)}`)
  }
}
ok(true, '14 份声明字段完整（inject=audio / node=LoadAudio / input=audio / max=3）')

console.log('== 2) 图编译：缺省零影响 + 注入正确 ==')
const base = byId['minimax-h3-ref2v-quality']
ok(!!base, '基准实现存在')
const mkJob = (extra = {}) => ({
  prompt: 'test', width: 1344, height: 768, length: 124, seed: 1, steps: 20, prefix: 't', mode: 'quality',
  refs: ['card.png'], ...extra,
})
const g0 = buildGraphFromManifest(base, mkJob())
const audioNodes0 = Object.values(g0).filter((n) => n.class_type === 'LoadAudio')
ok(audioNodes0.length === 0, '不传 ref_audios → 图里没有 LoadAudio')
ok(!Object.keys(g0['5'].inputs).some((k) => k.startsWith('ref_audios.')), '不传 ref_audios → node 5 没有 ref_audios.* 键')
ok(JSON.stringify(g0['5'].inputs).includes('audio_vae'), 'node 5 仍然接着 audio_vae（参考音频能进 latent 的前提）')

const g1 = buildGraphFromManifest(base, mkJob({ ref_audios: ['v1.wav', 'v2.mp4'] }))
const audioNodes1 = Object.entries(g1).filter(([, n]) => n.class_type === 'LoadAudio')
ok(audioNodes1.length === 2, `传 2 段 → 2 个 LoadAudio（实际 ${audioNodes1.length}）`)
ok(audioNodes1.every(([, n]) => typeof n.inputs.audio === 'string'), 'LoadAudio 用的是 audio 输入字段（不是 image）')
const p0 = g1['5'].inputs['ref_audios.ref_audio_0']
const p1 = g1['5'].inputs['ref_audios.ref_audio_1']
ok(Array.isArray(p0) && Array.isArray(p1), 'node 5 上写了 ref_audios.ref_audio_0 / _1')
const loaderNames = new Map(audioNodes1.map(([id, n]) => [id, n.inputs.audio]))
ok(loaderNames.get(p0[0]) === 'v1.wav' && loaderNames.get(p1[0]) === 'v2.mp4', '指针指向正确的文件')

console.log('== 3) 形状真值表（必须在任何上传/建节点之前失败） ==')
const { validateVideoArgs } = _internals
const err = (fn) => { try { fn(); return '' } catch (e) { return String(e.message) } }

const e1 = err(() => validateVideoArgs('video.image2video', { type: 'i2v', first_frame_node: 'n1', audio_ref_nodes: ['a.wav'] }))
ok(/audio-ref-shape/.test(e1) && /i2v/.test(e1), 'i2v + 参考音频 → audio-ref-shape')

const e2 = err(() => validateVideoArgs('video.reference2video', { type: 'r2v', ref_nodes: ['c'], audio_ref_nodes: ['1', '2', '3', '4'] }))
ok(/audio-ref-limit/.test(e2), '4 段参考音频 → audio-ref-limit')

const e3 = err(() => validateVideoArgs('video.reference2video', { type: 'r2v', audio_ref_nodes: ['a.wav'] }))
ok(/audio-ref-companion/.test(e3), '没有 ref_nodes（音频成唯一输入）→ audio-ref-companion')

const e4 = err(() => validateVideoArgs('video.reference2video', { type: 'r2v', ref_nodes: ['c'], audio_ref_nodes: ['a.wav', 'b.wav', 'c.wav'] }))
ok(e4 === '', 'r2v + 3 段 + 有 ref_nodes → 通过')

const e5 = err(() => validateVideoArgs('image.text2image', { audio_ref_nodes: ['a.wav'] }))
ok(e5 === '', '图片能力不在形状表里（由 runRender 的 capability 守卫兜底）')

const e6 = err(() => validateVideoArgs('video.reference2video', { type: 'r2v', ref_nodes: ['c'], first_frame_node: 'f' }))
ok(/不接受 first_frame_node/.test(e6), '既有规则未被破坏（r2v 仍拒首帧）')

console.log(failures ? `\n✗ ${failures} 项失败` : '\n✓ 全部通过')
process.exit(failures ? 1 : 0)
