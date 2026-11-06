/**
 * scripts/experiment/make-golden-run.mjs — 生成一份「应当全过」的合成运行（判分器的正例）
 *
 * 它不调用 ComfyUI，只按契约写出运行后的四类证据：
 *   <out>/canvas/<sid>/project.json、<out>/series/**、<out>/comfy-trace.jsonl
 * 用途：
 *   1) 正例控制组 —— 证明 assert-run 的阈值是可达的（不是永远判错的死规则）；
 *   2) 契约样例 —— 团队可以照这份 JSON 看「一次合格运行长什么样」。
 *
 * 用法：node scripts/experiment/make-golden-run.mjs [--out experiment/golden] [--session golden-session]
 */
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const argv = process.argv.slice(2)
const argOf = (n, d) => (argv.indexOf('--' + n) >= 0 ? argv[argv.indexOf('--' + n) + 1] : d)
const out = resolve(argOf('out', join(root, 'experiment/golden')))
const sid = argOf('session', 'golden-session')

const pkgMd = readFileSync(join(root, 'experiment/seed/series/episodes/ep001/package.md'), 'utf8')
const pkg = JSON.parse(pkgMd.match(/```json\n([\s\S]*?)\n```/)[1])
const groups = pkg.params.groupOrderVersion

// ── 画布节点 ────────────────────────────────────────────────
let seq = 0
const nid = (p) => `${p}-${String(++seq).padStart(3, '0')}`
const nodes = []

// 角色卡：single / three 双向配对
for (const c of pkg.assets.characters) {
  const three = { id: nid('img'), kind: 'image', title: `${c.name} 角色卡·三视图`, group: 'character cards', media: `canvas/${sid}/mock.png`, params: { cardVariant: 'three', character: c.name, width: 1344, height: 768 } }
  const single = { id: nid('img'), kind: 'image', title: `${c.name} 角色卡·单视图`, group: 'character cards', media: `canvas/${sid}/mock.png`, params: { cardVariant: 'single', character: c.name, width: 448, height: 768, pairedNodeId: three.id } }
  three.params.pairedNodeId = single.id
  nodes.push(three, single)
}
// 场景卡
for (const s of pkg.assets.scenes) {
  nodes.push({ id: nid('img'), kind: 'image', title: `${s.name} 场景卡`, group: 'scene cards', media: `canvas/${sid}/mock.png`, params: { assetId: s.assetId, width: 768, height: 1344 } })
}

// 镜头表（七列，格式与插件解析器一致）
const voiceRefOf = (s) => {
  const d = pkg.dialogue.find((x) => norm(x.text) === norm(s.line || ''))
  return d ? d.voiceRef : 'none'
}
function norm(v) { return String(v || '').replace(/[\s，。！？、,.!?；;：:""''（）()]/g, '') }
const tableRows = pkg.shots.map((s) => {
  const dialogue = s.line
    ? `模式: dialogue；对白: ${s.speaker}（0–3s）："${s.line}"；口型: mouth-open；声线参考: ${voiceRefOf(s)}；音效: 纸张；BGM: N/A；字幕: none`
    : `模式: silent；对白: 无；口型: mouth-closed；声线参考: none；音效: 门轴；BGM: N/A；字幕: none`
  return `| ${s.shotId} / ${s.seconds}s | ${s.performance} | ${s.chainIntent} | desk:画面中 | reveal | 剧本依据: ${s.beatId} — 0–${s.seconds}s ${s.performance} | ${dialogue} |`
})
const tableContent = [
  '# EP001 七列镜头表',
  '',
  '| 镜头编号 & 时长 | 连续性衔接 | 续接 | 参考锚点（空间+身份） | Hook 类型 | 镜头描述（每秒指令） | 音频与对白轨 |',
  '|---|---|---|---|---|---|---|',
  ...tableRows,
].join('\n')
nodes.push({ id: nid('tbl'), kind: 'table', title: 'EP001 七列镜头表', group: 'shot table', content: tableContent, params: {} })

// 提示词库（三档同文）
const promptFor = (s) => {
  const line = s.line ? `对白：「${s.line}」。` : ''
  return [
    'subject_definitions:', `<Subject 1> is ${s.speaker || 'the frame'} in a cold modern office.`,
    'summary:', `${s.shotId} ${s.performance}。`,
    'retention_analysis:', 'keep the same character identity and the same room landmarks.',
    'detailed_description:', `0–${s.seconds}s ${s.performance}；景别 ${s.shotSizeCamera}；位置 ${s.screenPositions}。${line}`,
    'overall_soundscape:', 'room tone, paper rustle, no music.',
    'non_diegetic_music: N/A',
    'no subtitle, no burned-in dialogue text',
  ].join('\n')
}
for (const s of pkg.shots) {
  const p = promptFor(s)
  const content = ['# ' + s.shotId + ' 提示词（分档）', '', '<!-- dsh-svs-prompt-bank v1 -->',
    '## fast', p, '', '## balanced', p, '', '## quality', p].join('\n')
  nodes.push({ id: nid('txt'), kind: 'text', title: `${s.shotId} 提示词（分档）`, group: 'shot prompts', content, params: {} })
}

// 片段 + 自检 + 拼接
const clipIdByShot = new Map()
for (const s of pkg.shots) {
  const frames = Math.round(s.seconds * 24)
  const params = {
    type: 'r2v', tier: 'fast', mode: 'fast', length: frames, fps: 24,
    ref_variant: 'single',
    ref_nodes: nodes.filter((n) => n.group === 'character cards' && n.params.cardVariant === 'single').map((n) => n.id),
    audio_ref_nodes: s.line ? [voiceRefOf(s)] : [],
    continuityFrom: null,
    prompt: promptFor(s),
    seed: 1000 + seq,
    selfCheck: { status: 'pass', at: Date.now(), frames: [nid('img')], checks: { plan: 'pass', character: 'pass', lipsync: s.line ? 'pass' : 'na', subtitle: 'na', contamination: 'pass', audio: 'na', style: 'pass' }, notes: 'golden run' },
  }
  const c = { id: nid('vid'), kind: 'video', title: s.chainIntent === '转场' ? `${s.shotId} 转场` : `${s.shotId} 片段`, group: 'shot clips', media: `canvas/${sid}/mock.mp4`, params }
  clipIdByShot.set(s.shotId, c)
  const prev = pkg.shots[pkg.shots.indexOf(s) - 1]
  if (prev && /^接 /.test(s.chainIntent)) params.continuityFrom = clipIdByShot.get(prev.shotId).id
  nodes.push(c)
}
const order = pkg.shots.map((s) => clipIdByShot.get(s.shotId).id)
nodes.push({ id: nid('vid'), kind: 'video', title: 'EP001 拼接成片', group: 'final delivery', media: `canvas/${sid}/mock.mp4`, params: { sources: order, backend: 'mock' } })

const project = {
  schemaVersion: 1,
  sessionId: sid,
  settings: {
    aspectRatio: '9:16', duration: '45 秒', audioMode: 'dialogue-led', mode: 'balanced',
    characterCardVariant: 'single', reviewMode: 'batch', shotGate: 'verdict', groupOrder: groups,
  },
  nodes,
}
mkdirSync(join(out, 'canvas', sid), { recursive: true })
writeFileSync(join(out, 'canvas', sid, 'project.json'), JSON.stringify(project, null, 2))

// ── 文件：包 + state ────────────────────────────────────────
const pkgDir = join(out, 'series/episodes/ep001')
mkdirSync(pkgDir, { recursive: true })
copyFileSync(join(root, 'experiment/seed/series/episodes/ep001/package.md'), join(pkgDir, 'package.md'))
const state = {
  series: { title: '三十天', episodes: 1, episodeSeconds: 45, episodeSecondsRange: [40, 50], episodeSecondsException: { ep001: 45 }, mode: 'domestic', aspectRatio: '9:16', style: 'cinematic-live-action', audioMode: 'dialogue-led', tier: 'balanced', imageTier: 'balanced', subtitles: 'none', delivery: 'native', characterCardVariant: 'single', reviewMode: 'batch', shotGate: 'verdict', voicePlan: 'existing', bgmMode: 'none', packageContract: 'episode-package/v1', assetMode: 'draft' },
  assets: { characters: [], scenes: [], props: [], voices: [] },
  episodes: {
    ep001: {
      stage: 'delivered', package: 'series/episodes/ep001/package.md', shots: 8,
      scriptVersion: 1, packageVersion: 1, episodeVersion: 1, changeRequest: null,
      doneShots: pkg.shots.map((s) => s.shotId), clipNodeIds: order, finalNodeId: nodes.at(-1).id,
      costMinutes: 31,
      gate: { package: { status: 'approved', at: '' }, clips: { status: 'approved', at: '' }, delivery: { status: 'approved', at: '' } },
      delivery: 'series/delivery/ep001/',
    },
  },
  next: 'ep002/package',
}
writeFileSync(join(out, 'series/production-state.json'), JSON.stringify(state, null, 2))

// ── trace：8 次生成 + 8 次上传 ──────────────────────────────
const lines = []
for (const s of pkg.shots) {
  lines.push({ t: new Date().toISOString(), kind: 'upload', bytes: 1024, n: lines.length })
  lines.push({ t: new Date().toISOString(), kind: 'prompt', id: `golden-${s.shotId}`, mediaKind: 'videos', nodes: 12, media: 'mock.mp4', graph: { '5': { class_type: 'KSampler', inputs: { seed: 1, steps: 4, width: 832, height: 480, positive: ['4', 0] } }, '4': { class_type: 'TextEncodeQwenImage21', inputs: { prompt: promptFor(s) } } } })
}
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'comfy-trace.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

console.log(`golden run → ${out}`)
console.log(`  节点 ${nodes.length} ｜ 镜 ${pkg.shots.length} ｜ trace ${lines.length} 条`)
