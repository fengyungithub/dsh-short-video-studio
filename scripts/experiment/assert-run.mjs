/**
 * scripts/experiment/assert-run.mjs — 一次运行的机器判分器（P0 硬约束 / P1 预期行为）
 *
 * 读一次实验运行留下的四类证据：
 *   1. <workspace>/canvas/<session>/project.json   画布（节点/参数/设置）
 *   2. <workspace>/series/**                       包 + state + 交付
 *   3. <out>/comfy-trace.jsonl                     每次 /prompt 的完整 graph（实际发出去什么）
 *   4. 控制台                                       人工卡与顺序只能从 transcript 读 → 不在本脚本（P2 评审）
 *
 * 用法：
 *   node scripts/experiment/assert-run.mjs --workspace experiment/runs/L1-a --session <sid> \
 *        --trace experiment-out/L1-a/comfy-trace.jsonl [--tier fast] [--json]
 *
 * 退出码：P0 有失败 → 1；只有 P1 失败 → 0（P1 记入报告供评审）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { _internals } from '../../lib/index.js'

const { parseShotTableContent, parsePromptBank, shotIdFromText } = _internals

const argv = process.argv.slice(2)
const argOf = (name, dflt = '') => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const flag = (name) => argv.includes('--' + name)

const ws = resolve(argOf('workspace'))
// 画布根与项目根可能不同（agent 会话 cwd = 画布根，臂目录 = 项目根）
const canvasRoot = resolve(argOf('canvas-root', ws))
const sid = argOf('session')
const tracePath = argOf('trace') ? resolve(argOf('trace')) : ''
const expectTier = argOf('tier', 'fast')
const asJson = flag('json')
// 环境/插件缺陷导致的已知阻塞：允许 concat 与交付两步缺失（仍要求其余 20 条 P0 全过）
const allowMissingConcat = flag('allow-missing-concat')

const CANONICAL_GROUPS = [
  'story planning', 'character cards', 'voice auditions', 'scene cards', 'prop cards',
  'shot table', 'text storyboards', 'shot prompts', 'shot clips', 'final delivery',
]

const results = []
const add = (level, id, ok, detail = '') => results.push({ level, id, ok, detail })

function readJson(p, dflt = null) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return dflt }
}
function mdJsonBlock(md) {
  const m = md.match(/```json\n([\s\S]*?)\n```/)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}

/** 从镜头表原文取「续接」列（parseShotTableContent 不导出该列）。 */
function parseContinuity(content) {
  const lines = String(content || '').split('\n')
  const hi = lines.findIndex((l) => l.includes('|') && /镜头编号/.test(l))
  if (hi < 0) return new Map()
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim())
  const idx = cells(lines[hi]).findIndex((h) => /^续接/.test(h))
  const map = new Map()
  for (let i = hi + 1; i < lines.length; i++) {
    if (!lines[i].includes('|')) continue
    const c = cells(lines[i])
    const id = shotIdFromText(c[0])
    if (id) map.set(id, c[idx] || '')
  }
  return map
}

const norm = (s) => String(s || '').replace(/[\s，。！？、,.!?；;：:""''（）()]/g, '')
const hasLine = (row) => !!row?.dialogue && !/^(无|—|-|none)$/i.test(String(row.dialogue).trim())

// ── 证据装载 ────────────────────────────────────────────────
const projectPath = join(canvasRoot, 'canvas', sid, 'project.json')
const project = readJson(projectPath)
const nodes = project?.nodes || []
const settings = project?.settings || {}
const byGroup = (g) => nodes.filter((n) => n.group === g)
const clips = () => byGroup('shot clips').filter((n) => n.kind === 'video')

const pkgPath = join(ws, 'series/episodes/ep001/package.md')
const pkg = existsSync(pkgPath) ? mdJsonBlock(readFileSync(pkgPath, 'utf8')) : null
const state = readJson(join(ws, 'series/production-state.json'), {})

const traceAll = tracePath && existsSync(tracePath)
  ? readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  : []
// 多臂共用同一个 mock 时按 session 过滤（trace 里没 session 的旧格式照旧计入）
const trace = traceAll.filter((t) => !t.session || t.session === sid)
const traceSkipped = traceAll.length - trace.length
const promptCalls = trace.filter((t) => t.kind === 'prompt')
const videoCalls = promptCalls.filter((t) => t.mediaKind === 'videos')
const hasCalls = promptCalls.length > 0
// 真机臂没有 mock 的 trace：照片段自身参数做代理检查，并在报告里标明「代理」
const hasTrace = hasCalls
const uploads = trace.filter((t) => t.kind === 'upload')

// ── P0：硬约束（违反即不合格）────────────────────────────────
add('P0', '01 画布存在且 9:16', settings.aspectRatio === '9:16', `aspectRatio=${settings.aspectRatio}`)
add('P0', '02 审查节奏 batch', settings.reviewMode === 'batch', `reviewMode=${settings.reviewMode}`)
add('P0', '03 角色卡引用 single', settings.characterCardVariant === 'single', `characterCardVariant=${settings.characterCardVariant}`)
add('P0', '04 分组 = 十个标准组', JSON.stringify(settings.groupOrder) === JSON.stringify(CANONICAL_GROUPS), `groupOrder=${JSON.stringify(settings.groupOrder || [])}`)

// 角色卡双版本成对
const chars = byGroup('character cards').filter((n) => n.kind === 'image')
const pairOk = chars.length >= 2 && chars.some((n) => {
  const other = chars.find((m) => m.id === n.params?.pairedNodeId)
  return other && other.params?.pairedNodeId === n.id &&
    n.params?.cardVariant === 'single' && other.params?.cardVariant === 'three'
})
add('P0', '05 角色卡 single/three 双向配对', !!pairOk, `character cards=${chars.length}`)

// 镜头表
const tableNode = nodes.find((n) => n.group === 'shot table' && (n.kind === 'table' || n.kind === 'text'))
const table = tableNode ? parseShotTableContent(tableNode.content || '') : null
const hasTable = !!table && (table.shots || []).length > 0
add('P0', '06 七列镜头表可解析', !!table && table.shots.length >= 8, table ? `shots=${table.shots.length}` : '无镜头表节点')

const beats = new Set((pkg?.beats || []).map((b) => b.id))
const tableBeats = (table?.shots || []).map((s) => (s.beats || [])[0]).filter(Boolean)
add('P0', '07 每镜有 剧本依据 beatId', hasTable && tableBeats.length === (table?.shots.length || 0) && tableBeats.every((b) => /^B\d{2}$/.test(b)), `beats=${[...new Set(tableBeats)].join(',')}`)
add('P0', '08 beat 编号都在包里（无自创）', hasTable && tableBeats.every((b) => beats.has(b)), `包 beats=${[...beats].join(',')}`)
const covered = new Set(tableBeats)
add('P0', '09 每个 beat 至少 1 镜覆盖', hasTable && beats.size > 0 && [...beats].every((b) => covered.has(b)), `未覆盖=${[...beats].filter((b) => !covered.has(b)).join(',') || '无'}`)

// 提示词库：三档同文
const banks = byGroup('shot prompts').filter((n) => n.kind === 'text')
const bankParsed = banks.map((n) => ({ node: n, bank: parsePromptBank(n.content || '') }))
const sameText = bankParsed.every(({ bank }) => bank.tiers.fast && bank.tiers.balanced && bank.tiers.quality &&
  bank.tiers.fast === bank.tiers.balanced && bank.tiers.balanced === bank.tiers.quality)
add('P0', '10 每镜提示词库三档同文', bankParsed.length >= Math.max(1, (table?.shots?.length || 8) - 1) && sameText, `banks=${bankParsed.length}`)

// 片段参数
const allClips = clips()
const transitionClips = allClips.filter((c) => /转场/.test(c.title || ''))
const shotClips = allClips.filter((c) => !/转场/.test(c.title || ''))
const byShot = new Map()
for (const c of shotClips) {
  const id = shotIdFromText(c.title || '')
  if (id) byShot.set(id, c)
}
// 续接列（从表格原文读；插件解析器不导出这一列）
const cont = parseContinuity(tableNode?.content)
const isTransRow = (row) => /锚定|转场/.test(cont.get(row?.shotId) || '')
const clipFor = (row) => (isTransRow(row) ? transitionClips[0] : byShot.get(row?.shotId))
add('P0', '11 每镜都有片段', hasTable && shotClips.length > 0 && (table?.shots || []).every((s) => !!clipFor(s)), `缺=${(table?.shots || []).filter((s) => !clipFor(s)).map((s) => s.shotId).join(',') || '无'}（转场镜 ${transitionClips.length} 个）`)

const tierBad = allClips.filter((c) => (c.params?.tier || c.params?.mode) !== expectTier)
add('P0', `12 片段档位 = ${expectTier}`, byShot.size > 0 && tierBad.length === 0, tierBad.map((c) => c.title + ':' + (c.params?.tier || c.params?.mode)).join(','))

const refClips = allClips.filter((c) => (c.params?.ref_nodes || []).length > 0)
const variantBad = refClips.filter((c) => expectTier === 'fast' ? c.params?.ref_variant !== 'single' : false)
add('P0', '13 fast 档必须 ref_variant=single（仅带参考图的镜）', refClips.length > 0 && variantBad.length === 0, variantBad.map((c) => c.title).join(','))

const durBad = (table?.shots || []).filter((s) => {
  const c = clipFor(s)
  const frames = Number(c?.params?.length)
  return !frames || Math.abs(frames / 24 - s.durationSec) > 1.0
})
add('P0', '14 length/24 ≈ 表时长（±1s）', hasTable && byShot.size > 0 && durBad.length === 0, durBad.map((s) => s.shotId).join(','))

let chainBad = []
for (let i = 0; i < (table?.shots || []).length; i++) {
  const s = table.shots[i]
  const c = clipFor(s)
  if (!c) continue
  const intent = cont.get(s.shotId) || ''
  if (isTransRow(s)) continue
  const prev = i > 0 ? byShot.get(table.shots[i - 1].shotId) : null
  if (/^接 /.test(intent)) {
    if (!prev || c.params?.continuityFrom !== prev.id) chainBad.push(s.shotId)
  } else if (intent === '起链') {
    if (c.params?.continuityFrom) chainBad.push(s.shotId + '(不该续接)')
  } else if (intent.includes('转场')) {
    // 转场镜走 i2v：允许首/末帧锚定，不要求 continuityFrom
  }
}
add('P0', '15 续接链与表一致', hasTable && byShot.size > 0 && chainBad.length === 0, chainBad.join(','))

const checkBad = allClips.filter((c) => (c.params?.selfCheck?.status || '') !== 'pass' || !(c.params?.selfCheck?.frames || []).length)
add('P0', '16 每镜自检 pass 且有抽帧证据', byShot.size > 0 && checkBad.length === 0, checkBad.map((c) => `${c.title}:${c.params?.selfCheck?.status}/${(c.params?.selfCheck?.frames || []).length}帧`).join(','))

// 拼接
const concat = byGroup('final delivery').find((n) => n.kind === 'video')
const expectOrder = (table?.shots || []).map((s) => clipFor(s)?.id).filter(Boolean)
if (allowMissingConcat && !concat) {
  add('SKIP', '17 拼接节点（已知阻塞）', true, 'concat 未产出：按 --allow-missing-concat 记跳过')
} else {
  add('P0', '17 拼接节点存在且顺序 = 镜头表', !!concat && JSON.stringify(concat.params?.sources) === JSON.stringify(expectOrder), concat ? `sources=${(concat.params?.sources || []).length}` : '无拼接节点')
}

// state
if (allowMissingConcat && ['clips', 'final'].includes(state?.episodes?.ep001?.stage)) {
  add('SKIP', '18 state=delivered（已知阻塞）', true, `stage=${state?.episodes?.ep001?.stage}（concat 阻塞，停在交付前）`)
} else {
  add('P0', '18 state 推进到 delivered', state?.episodes?.ep001?.stage === 'delivered', `stage=${state?.episodes?.ep001?.stage}`)
}
add('P0', '19 doneShots 覆盖全部镜', (state?.episodes?.ep001?.doneShots || []).length > 0 && JSON.stringify((state?.episodes?.ep001?.doneShots || []).slice().sort()) === JSON.stringify(expectOrder.length ? table.shots.map((s) => s.shotId).sort() : []), `doneShots=${(state?.episodes?.ep001?.doneShots || []).join(',')}`)
add('P0', '20 成本已记账', Number(state?.episodes?.ep001?.costMinutes) > 0, `costMinutes=${state?.episodes?.ep001?.costMinutes}`)

// trace：调用次数（允许 ≤1.5× 重渲）
const minCalls = expectOrder.length
if (!hasTrace) {
  add('SKIP', '21 无重复提交（真机无 trace）', true, '真机臂没有 /prompt 记录；重渲次数看 state/交付清单')
} else {
  add('P0', '21 无重复提交（视频调用数 ≤ 1.5×镜数）', videoCalls.length >= minCalls && videoCalls.length <= Math.ceil(minCalls * 1.5), `videoCalls=${videoCalls.length} / shots=${minCalls}（总 /prompt ${promptCalls.length}）`)
}
if (!hasTrace) {
  const expectRef = (table?.shots || []).filter((row) => !isTransRow(row)).length || minCalls
  add('P0', '22 参考绑定存在（无 trace 代理检查）', refClips.length === expectRef && refClips.every((c) => (c.params?.ref_nodes || []).length > 0), `带 ref_nodes 的镜 ${refClips.length}/${expectRef}（转场镜本来就没有参考图）`)
} else {
  add('P0', '22 参考图确实上传过', uploads.length >= minCalls, `uploads=${uploads.length}`)
}

// ── P1：预期行为 ────────────────────────────────────────────
if (pkg) {
  const pkgLines = (pkg.dialogue || []).map((d) => norm(d.text))
  const tableLines = (table?.shots || []).filter(hasLine).map((s) => norm(s.dialogue))
  add('P1', '01 表台词与包逐字一致', JSON.stringify(pkgLines.slice().sort()) === JSON.stringify(tableLines.slice().sort()), `包=${pkgLines.length} 表=${tableLines.length}`)
}

const dialogueClips = [...byShot.entries()].filter(([id]) => {
  const row = (table?.shots || []).find((s) => s.shotId === id)
  return hasLine(row)
})
const stripCanvas = (v) => String(v || '').replace(/^canvas:/, '')
const audioBad = dialogueClips.filter(([id, c]) => {
  const row = table.shots.find((s) => s.shotId === id)
  const refs = (c.params?.audio_ref_nodes || []).map(stripCanvas)
  return !refs.length || !refs.includes(stripCanvas(row.voiceRef))
})
add('P1', '02 对白镜 audio_ref_nodes 与表声线参考一致', dialogueClips.length > 0 && audioBad.length === 0, audioBad.map(([id]) => id).join(','))

const subtitleBad = dialogueClips.filter(([, c]) => !/no subtitle/i.test(String(c.params?.prompt || '')))
add('P1', '03 字幕 none 时 prompt 带 no subtitle 负向尾句', dialogueClips.length > 0 && subtitleBad.length === 0, `${subtitleBad.length}/${dialogueClips.length} 缺`)

const lineBad = dialogueClips.filter(([id, c]) => {
  const row = table.shots.find((s) => s.shotId === id)
  return !norm(c.params?.prompt || '').includes(norm(row.dialogue))
})
add('P1', '04 每句台词出现在该镜 prompt 里', dialogueClips.length > 0 && lineBad.length === 0, lineBad.map(([id]) => id).join(','))

if (pkg?.params?.subtitleMode === 'none') {
  const burned = promptCalls.filter((t) => /burned-in subtitle|subtitle text:/i.test(JSON.stringify(t.graph || {})))
  if (!hasTrace) {
  const bad = allClips.filter((c) => /burned-in subtitle|subtitle text:/i.test(String(c.params?.prompt || '')))
  add('P1', '05 没有多余的字幕声明（无 trace 代理检查）', allClips.length > 0 && bad.length === 0, `命中 ${bad.length} 个片段`)
} else {
  add('P1', '05 没有多余的字幕声明', hasCalls && burned.length === 0, `命中 ${burned.length} 次`)
}
}

add('P1', '06 场景卡 ≥ 1 且绑定资产 id', byGroup('scene cards').filter((n) => n.kind === 'image').length >= 1, `scene cards=${byGroup('scene cards').length}`)
if (!hasTrace) {
  add('P1', '07 每条生成都有完整 prompt（无 trace 代理检查）', allClips.length > 0 && allClips.every((c) => String(c.params?.prompt || '').length > 200), `片段 ${allClips.length}`)
} else {
  add('P1', '07 每条生成都有提示词库来源', hasCalls && promptCalls.every((t) => JSON.stringify(t.graph || {}).length > 200), '')
}

// ── 报告 ────────────────────────────────────────────────────
const skips = results.filter((r) => r.level === 'SKIP')
const p0 = results.filter((r) => r.level === 'P0')
const p1 = results.filter((r) => r.level === 'P1')
const p0Bad = p0.filter((r) => !r.ok)
const p1Bad = p1.filter((r) => !r.ok)

if (asJson) {
  console.log(JSON.stringify({ workspace: basename(ws), session: sid, tier: expectTier, p0, p1, skips, promptCalls: promptCalls.length, uploads: uploads.length }, null, 2))
} else {
  console.log(`\n实验判定：${basename(ws)} / ${sid}（期望档位 ${expectTier}）`)
  console.log(`  画布根：${canvasRoot}`)
  console.log(`  证据：project.json ${project ? '✓' : '✗'} ｜ 包 ${pkg ? '✓' : '✗'} ｜ trace ${trace.length} 条（prompt ${promptCalls.length} / upload ${uploads.length}）${traceSkipped ? ` ｜ 已过滤其他会话 ${traceSkipped} 条` : ''}`)
  for (const r of [...p0, ...p1, ...skips]) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.level} ${r.id}${r.ok ? '' : '  ← ' + r.detail}`)
  }
  console.log(`\n  P0 ${p0.length - p0Bad.length}/${p0.length} ｜ P1 ${p1.length - p1Bad.length}/${p1.length}` + (skips.length ? ` ｜ 跳过 ${skips.length}（已知阻塞）` : ''))
}
process.exitCode = p0Bad.length ? 1 : 0
