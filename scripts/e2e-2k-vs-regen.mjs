/**
 * scripts/e2e-2k-vs-regen.mjs — 实验：**balanced Pika 草稿 → 两条 2K 路线对比**
 *
 *   臂 P：像素空间超分（video.upscale ×2，2688×1536）
 *   臂 R：Open-H3 重生成（video.regenerate，2560×1440；handoff=auto ⇒ 走 balanced 清单顺手存下的 draft latent）
 *
 * 两条臂共享同一份草稿（同 seed / 同 prompt / 同帧数），只换「怎么到 2K」。
 * 走的是插件这一层的完整链路（runRender → runUpscale → runRegenerate），画布写在临时工作区，
 * 不动用户会话；产物与 result.json 落在 e2e-out/2k-vs-regen/。
 *
 * 用法：
 *   node scripts/e2e-2k-vs-regen.mjs                 # 默认新写的「雨巷」场景 prompt
 *   node scripts/e2e-2k-vs-regen.mjs --tag=xxx --seed=123
 *   node scripts/e2e-2k-vs-regen.mjs --prompt-file=my-prompt.txt
 */
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _internals } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'e2e-out', '2k-vs-regen')
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}
const TAG = arg('tag', 'rain-alley')
const SEED = Number(arg('seed', '20261107'))
const DRAFT_IMPL = arg('draft-impl', 'minimax-h3-ref2v-ctx-balanced-pika-solattn-solvae')
const PROMPT_FILE = arg('prompt-file', '')

const DEFAULT_PROMPT = `integrated_multimodal_description:
[Shot 1] From 0.0 s to 5.2 s, a slow right-to-left lateral dolly at low eye level through a narrow rain-wet stone alley of an old Chinese town at blue hour. Wet flagstones mirror warm lantern light in long vertical streaks; moss grows in the joints between stones; a carved stone lion stands half in shadow, its surface pitted and streaked with age; red wooden lattice windows and a faded indigo cloth banner hang above; steam rises from a bamboo steamer on a wooden stool in the foreground and drifts across the frame; a tabby cat walks away down the alley with its tail up; shallow depth of field, anamorphic bokeh on the lanterns; fine drizzle beads on the stone and on the banner fabric; the camera movement is smooth and steady, no cuts.
overall_soundscape: steady rain on tiles and stone, distant dripping from the eaves, soft steam hiss from the bamboo steamer, the cat's soft footfalls on wet stone, a faint wooden door creak in the distance, no music, no speech.
non_diegetic_music: none
style: photorealistic cinematic, weathered stone and wet lacquer textures, warm lantern against cool blue-hour ambient, natural contrast, no stylization.
Negative: no text of any kind, no watermark, no subtitles, no storyboard panels, no sketch lines, no duplicate bodies, no modern objects, no lens flare, no oversharpening halos, no plastic skin.`

const prompt = PROMPT_FILE ? readFileSync(join(ROOT, PROMPT_FILE), 'utf8') : DEFAULT_PROMPT

const workspace = join(OUT, 'workspace-' + TAG)
const sessionId = 'exp-2k-' + TAG
const projectPath = join(workspace, 'canvas', sessionId, 'project.json')
mkdirSync(dirname(projectPath), { recursive: true })
writeFileSync(projectPath, JSON.stringify({
  schemaVersion: 1,
  sessionId,
  settings: { aspectRatio: '16:9', duration: '', audioMode: 'dialogue-led', mode: 'balanced', reviewMode: 'batch', shotGate: 'off' },
  nodes: [],
}, null, 2), 'utf8')

const ctx = {
  workspaceRegistry: {
    get: (id) => (id === 'exp' ? { id, path: workspace } : undefined),
    list: () => [{ id: 'exp', path: workspace, sessionIds: [sessionId] }],
  },
}
const W = { workspaceId: 'exp', sessionId }
const result = { tag: TAG, seed: SEED, draftImpl: DRAFT_IMPL, startedAt: new Date().toISOString() }

const t = () => Date.now()
const secs = (from) => +((Date.now() - from) / 1000).toFixed(1)

// ---- 1) balanced Pika 草稿（manifest 里已带 save 节点：顺手存 draft latent）----
console.log('[1/3] 生成草稿（balanced Pika）…')
const t1 = t()
const draft = await _internals.runRender(ctx, {
  ...W,
  capability: 'video.reference2video',
  type: 'r2v',
  implementation: DRAFT_IMPL,
  tier: 'balanced',
  prompt,
  length: 124,
  seed: SEED,
  title: `实验草稿·${TAG}`,
  group: '实验',
})
result.draft = {
  secs: secs(t1),
  nodeId: draft.node.id,
  media: draft.node.media,
  width: draft.node.params?.width,
  height: draft.node.params?.height,
  length: draft.node.params?.length,
  latentFile: draft.node.params?.latentFile || null,
  latentFrames: draft.node.params?.latentFrames || null,
}
console.log('[1/3] 草稿完成', JSON.stringify(result.draft))

// ---- 2) 臂 P：像素空间 ×2（2688×1536）----
console.log('[2/3] 像素超分 ×2 …')
const t2 = t()
const up = await _internals.runUpscale(ctx, {
  ...W,
  video_node: draft.node.id,
  implementation: 'video-upscale-x2',
  tier: 'quality',
  title: `实验·像素2K·${TAG}`,
  group: '实验',
})
result.pixel = {
  secs: secs(t2),
  nodeId: up.node.id,
  media: up.node.media,
  width: up.node.params?.width,
  height: up.node.params?.height,
  length: up.node.params?.length,
}
console.log('[2/3] 像素臂完成', JSON.stringify(result.pixel))

// ---- 3) 臂 R：重生成 2K（handoff=auto）----
console.log('[3/3] 重生成 2K（handoff=auto）…')
const t3 = t()
const regen = await _internals.runRegenerate(ctx, {
  ...W,
  video_node: draft.node.id,
  target: '2k',
  handoff: 'auto',
  seed: 42,
  title: `实验·重生成2K·${TAG}`,
  group: '实验',
})
result.regen = {
  secs: secs(t3),
  nodeId: regen.node.id,
  media: regen.node.media,
  width: regen.node.params?.width,
  height: regen.node.params?.height,
  length: regen.node.params?.length,
  handoff: regen.handoff,
  handoffReason: regen.handoffReason,
  latentFile: regen.node.params?.latentFile || null,
}
console.log('[3/3] 重生成臂完成', JSON.stringify(result.regen))

// ---- 归档 ----
mkdirSync(OUT, { recursive: true })
const files = {
  draft: join(workspace, draft.node.media),
  pixel2k: join(workspace, up.node.media),
  regen2k: join(workspace, regen.node.media),
}
for (const [k, p] of Object.entries(files)) {
  if (existsSync(p)) {
    const dst = join(OUT, `${TAG}-${k}.mp4`)
    copyFileSync(p, dst)
    result.files = { ...(result.files || {}), [k]: dst }
  }
}
result.finishedAt = new Date().toISOString()
writeFileSync(join(OUT, `${TAG}-result.json`), JSON.stringify(result, null, 2))
console.log('\nRESULT\n' + JSON.stringify(result, null, 2))
console.log('\n对比建议：两臂交付尺寸不同（像素臂 2688×1536 · 重生成 2560×1440），')
console.log('指标与 1:1 裁切请在共同区域（居中 2560×1440）上做；上一轮 B/C 实验的 ffmpeg/numpy 方法可直接复用。')
