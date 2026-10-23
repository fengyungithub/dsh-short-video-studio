/**
 * scripts/e2e-voice-ref.mjs — 参考音频（H3 Ref2VA <Audio N>）端到端验证（**真跑 GPU，fast 档**）。
 *
 * 验证插件这一层的链路，不是裸 ComfyUI 图：
 *  ① 画布音频节点（真实 wav 上传）→ audio_ref_nodes → 图里 LoadAudio + ref_audios.ref_audio_0
 *  ② 产物记账：audio_ref_nodes / audioRefMeta / audio_ref_declared 落到画布节点
 *  ③ 产物确实带音轨（mp4 里有 soun handler）
 *  ④ i2v + 音频 → 上传前显式拒跑（audio-ref-shape）
 *  ⑤ extract_audio 从本镜视频抽声线 → 画布 audio 节点（本机无 ffmpeg 时走 ComfyUI）
 *
 * 用法：
 *   node scripts/e2e-voice-ref.mjs --audio=/tmp/voice_sample.wav [--ref=e2e-out/ctx-test/refA.png]
 * 产物落 e2e-out/voice-ref/（画布写在临时工作区，不动用户会话）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { _internals } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'e2e-out', 'voice-ref')
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}
const AUDIO = arg('audio', '/tmp/voice_sample.wav')
const REF = arg('ref', 'e2e-out/ctx-test/refA.png')
const TIER = arg('tier', 'fast')
const IMPL = arg('implementation', `minimax-h3-ref2v-${TIER}`)
const LENGTH = Number(arg('length', '124'))
const SEED = Number(arg('seed', '20261023'))

if (!existsSync(AUDIO)) { console.error('✗ 找不到音频样本：' + AUDIO + '\n  先用 --audio= 指定一个 2–15s 的 wav/mp3'); process.exit(1) }
if (!existsSync(join(ROOT, REF))) { console.error('✗ 找不到参考图：' + REF); process.exit(1) }

rmSync(OUT, { recursive: true, force: true })
const workspace = join(OUT, 'workspace')
const sessionId = 'voice-ref'
const projectPath = join(workspace, 'canvas', sessionId, 'project.json')
mkdirSync(dirname(projectPath), { recursive: true })
writeFileSync(projectPath, JSON.stringify({
  schemaVersion: 1, sessionId,
  settings: { aspectRatio: '16:9', duration: '', audioMode: 'dialogue-led', mode: TIER },
  nodes: [],
}, null, 2), 'utf8')

const ctx = {
  workspaceRegistry: {
    get: (id) => (id === 'smoke' ? { id, path: workspace } : undefined),
    list: () => [{ id: 'smoke', path: workspace, sessionIds: [sessionId] }],
  },
}
const fail = (msg) => { console.error('✗ ' + msg); process.exit(1) }
const nodes = () => JSON.parse(readFileSync(projectPath, 'utf8')).nodes
const dataUrl = (abs, mime) => `data:${mime};base64,${readFileSync(abs).toString('base64')}`

// ---- ① 画布素材：参考图 + 参考音频（都走真实的 manual-upload 路径） ----
const imgNode = await _internals.importManualImage(workspace, sessionId, {
  filename: basename(REF), dataUrl: dataUrl(join(ROOT, REF), 'image/png'),
}, '参考')
const audNode = await _internals.importManualImage(workspace, sessionId, {
  filename: basename(AUDIO), dataUrl: dataUrl(AUDIO, 'audio/wav'),
}, '参考')
if (imgNode.kind !== 'image') fail('参考图节点 kind 应为 image：' + imgNode.kind)
if (audNode.kind !== 'audio') fail('参考音频节点 kind 应为 audio：' + audNode.kind)
console.log('✓ ① 画布素材：图片 %s / 音频 %s（%s）', imgNode.id.slice(0, 8), audNode.id.slice(0, 8), audNode.media)

const PROMPT = `subject_definitions:
<Subject 1> is the young woman with long dark hair and a light-blue blouse in <Picture 1>.
<Audio 1> is the voice-timbre reference for <Subject 1> (S1), containing a spoken female voice.

summary:
[reference generation + audio reference] <Subject 1> stands in a quiet room and speaks one short line while keeping the same voice.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - identity, hair and clothing retained.
<Audio 1>: reference - the target speaker follows <Audio 1>'s voice timbre and measured delivery without copying the original signal.

detailed_description:
[Shot 1] A medium close-up of <Subject 1>, the young woman with long dark hair, in a softly lit room with a plain wall behind her. The camera holds a static shot. <Subject 1> (S1) looks toward the lens and says: <d>[Chinese] 这是我自己的声音。</d> Her lips close after the line and she holds a calm expression.

overall_soundscape: Quiet indoor room tone continues throughout the video.
non_diegetic_music: N/A`

const t0 = Date.now()
const r = await _internals.runRender(ctx, {
  workspaceId: 'smoke', sessionId,
  capability: 'video.reference2video',
  type: 'r2v',
  implementation: IMPL,
  ref_nodes: [imgNode.id],
  audio_ref_nodes: [audNode.id],
  prompt: PROMPT,
  width: 832, height: 480, length: LENGTH, seed: SEED, group: '片段',
  title: 'S01 片段（参考音频）',
})
const node = r.node
console.log('✓ ② 生成 %s · %ss · 交付 %d 帧', IMPL, ((Date.now() - t0) / 1000).toFixed(1), node.params.length)

if (!Array.isArray(node.params.audio_ref_nodes) || node.params.audio_ref_nodes[0] !== audNode.id) fail('画布节点没记 audio_ref_nodes')
const meta = node.params.audioRefMeta?.[0]
if (!meta) fail('画布节点没记 audioRefMeta')
if (!(meta.durationSec > 4.5 && meta.durationSec < 5.5)) fail(`audioRefMeta 时长不对：${meta.durationSec}`)
if (node.params.audio_ref_declared !== true) fail('audio_ref_declared 应为 true（prompt 里有 <Audio 1>）')
if (!r.audioRefs || r.audioRefs.length !== 1) fail('返回值缺 audioRefs')
console.log('✓ ③ 记账：audioRefMeta=%s duration=%ss declared=%s', meta.file, meta.durationSec.toFixed(2), node.params.audio_ref_declared)

const absVideo = join(workspace, ...String(node.media).split('/'))
if (!existsSync(absVideo)) fail('产物文件不存在：' + absVideo)
const buf = readFileSync(absVideo)
const hasAudio = buf.includes(Buffer.from('soun')) || buf.includes(Buffer.from('mp4a'))
if (!hasAudio) fail('产物里没检出音轨（soun/mp4a）')
console.log('✓ ④ 产物 %s · %s · 含音轨', basename(absVideo), (buf.length / 1048576).toFixed(2) + 'MB')

// ---- ⑤ 负向：i2v + 参考音频必须在“上传/建节点”之前失败 ----
let rejected = ''
try {
  await _internals.runRender(ctx, {
    workspaceId: 'smoke', sessionId,
    capability: 'video.image2video', type: 'i2v', implementation: `minimax-h3-i2v-${TIER}`,
    first_frame_node: imgNode.id, audio_ref_nodes: [audNode.id], prompt: PROMPT,
    width: 832, height: 480, length: LENGTH, seed: SEED, title: '不该成功',
  })
} catch (e) { rejected = String(e.message) }
if (!/audio-ref-shape/.test(rejected)) fail('i2v + 音频没有按 audio-ref-shape 拒跑：' + (rejected || '(没报错)'))
console.log('✓ ⑤ i2v + 参考音频 → 显式拒跑（audio-ref-shape）')

// ---- ⑥ 从本镜抽声线 → 画布音频节点（无 ffmpeg 时走 ComfyUI） ----
const t1 = Date.now()
const ex = await _internals.runExtractAudio(ctx, {
  workspaceId: 'smoke', sessionId, video_node: node.id, title: 'S01 声线参考', group: '参考',
})
if (ex.node.kind !== 'audio') fail('extract_audio 的产物不是 audio 节点')
if (!existsSync(join(workspace, ...String(ex.node.media).split('/')))) fail('extract_audio 产物文件不存在')
console.log('✓ ⑥ extract_audio 后端=%s · %ss · %s', ex.backend, ((Date.now() - t1) / 1000).toFixed(1), basename(ex.node.media))

const report = {
  implementation: IMPL, tier: TIER, audioSource: basename(AUDIO),
  videoNode: node.id, videoMedia: node.media, videoBytes: buf.length,
  audioRefMeta: meta, audioRefs: r.audioRefs,
  extractedAudio: { node: ex.node.id, media: ex.node.media, backend: ex.backend },
  elapsedSec: Math.round((Date.now() - t0) / 100) / 10,
}
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
console.log('\n✓ e2e 全部通过 → %s', join(OUT, 'report.json'))
