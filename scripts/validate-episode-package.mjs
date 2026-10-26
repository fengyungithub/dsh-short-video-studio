/**
 * scripts/validate-episode-package.mjs <package.md>
 *
 * 校验一份真实集制作包：机读块（contract v1）+ 六节 markdown 的一致性。
 * 用法：node scripts/validate-episode-package.mjs docs/analysis/ep001-bridge/package.md
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const schema = JSON.parse(readFileSync(join(root, 'schemas/episode-package.schema.json'), 'utf8'))
const canonicalGroups = [
  'story planning', 'character cards', 'voice auditions', 'scene cards', 'prop cards',
  'shot table', 'text storyboards', 'shot prompts', 'shot clips', 'final delivery',
]

const file = process.argv[2]
if (!file) { console.error('用法：node scripts/validate-episode-package.mjs <package.md>'); process.exit(2) }
const md = readFileSync(resolve(file), 'utf8')
const errors = []
const warnings = []

function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v }
function check(node, s, path) {
  if (s.const !== undefined) { if (node !== s.const) errors.push(`${path}: 应为 ${JSON.stringify(s.const)}`); return }
  if (s.enum && !s.enum.includes(node)) errors.push(`${path}: 不在枚举 ${JSON.stringify(s.enum)}`)
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type]
    const got = typeOf(node)
    const okType = types.some((t) => (t === 'integer' ? Number.isInteger(node) : t === got))
    if (!okType) { errors.push(`${path}: 类型应为 ${types.join('|')}，实际 ${got}`); return }
  }
  if (typeof node === 'string') {
    if (s.minLength !== undefined && node.length < s.minLength) errors.push(`${path}: 长度 < ${s.minLength}`)
    if (s.pattern && !new RegExp(s.pattern).test(node)) errors.push(`${path}: 不匹配 ${s.pattern}`)
  }
  if (typeof node === 'number') {
    if (s.minimum !== undefined && node < s.minimum) errors.push(`${path}: < ${s.minimum}`)
    if (s.maximum !== undefined && node > s.maximum) errors.push(`${path}: > ${s.maximum}`)
  }
  if (Array.isArray(node)) {
    if (s.minItems !== undefined && node.length < s.minItems) errors.push(`${path}: 项数 < ${s.minItems}`)
    if (s.maxItems !== undefined && node.length > s.maxItems) errors.push(`${path}: 项数 > ${s.maxItems}`)
    if (s.items) node.forEach((v, i) => check(v, s.items, `${path}[${i}]`))
  } else if (node && typeof node === 'object') {
    for (const k of s.required || []) if (!(k in node)) errors.push(`${path}: 缺必填 ${k}`)
    if (s.additionalProperties === false) for (const k of Object.keys(node)) if (!(s.properties || {})[k]) errors.push(`${path}: 多余字段 ${k}`)
    for (const [k, sub] of Object.entries(s.properties || {})) if (k in node) check(node[k], sub, `${path}.${k}`)
  }
}

const jsonBlock = md.match(/```json\n([\s\S]*?)\n```/)?.[1]
if (!jsonBlock) { console.error('✗ 未找到 fenced json 机读块'); process.exit(1) }
let data
try { data = JSON.parse(jsonBlock) } catch (e) { console.error(`✗ 机读块不是合法 JSON：${e.message}`); process.exit(1) }
check(data, schema, '$')

// ── 跨字段 ─────────────────────────────────────────
const idOk = data.episode && data.episode.id === `EP${String(data.episode.number).padStart(3, '0')}`
if (!idOk) errors.push('episode.id 与 number 不同构（应 EP%03d）')
if (data.shots?.length !== data.shotBudget) errors.push(`shots 数 ${data.shots?.length} ≠ shotBudget ${data.shotBudget}`)
if (data.budget && data.dialogue?.length !== data.budget.dialogueCount) errors.push(`dialogue 数 ${data.dialogue?.length} ≠ budget.dialogueCount ${data.budget.dialogueCount}`)
if (data.episode?.sourceDialogueCount != null && data.episode.sourceDialogueCount < (data.dialogue?.length || 0)) errors.push('sourceDialogueCount 小于 dialogue 行数')
if (data.episode?.sourceDialogueCount > (data.dialogue?.length || 0)) warnings.push(`源剧本 ${data.episode.sourceDialogueCount} 句，机读块 ${data.dialogue.length} 行（同说话人合并，需确认逐字无删改）`)
if (data.budget && data.shots?.length !== data.budget.shotCount) errors.push(`shots 数 ${data.shots?.length} ≠ budget.shotCount ${data.budget.shotCount}`)

const charNames = new Set(data.assets?.characters?.map((c) => c.name) || [])
if (data.dialogue) for (const d of data.dialogue) if (!charNames.has(d.speaker)) errors.push(`对白说话人「${d.speaker}」不在 assets.characters`)
const voiceRefs = new Set()
for (const v of data.assets?.voices || []) {
  if (v.voiceAssetId && v.voiceAssetId !== 'none') voiceRefs.add(v.voiceAssetId)
  if (v.canvasNodeId) voiceRefs.add(`canvas:${v.canvasNodeId}`)
}
for (const d of data.dialogue || []) {
  if (d.voiceRef !== 'none' && !voiceRefs.has(d.voiceRef)) errors.push(`对白 voiceRef ${d.voiceRef} 不在 voices 台账`)
  if (data.params?.voicePlan === 'existing' && d.voiceRef === 'none') errors.push(`voicePlan=existing 但对白 ${d.no} 的 voiceRef=none`)
}
if (data.params?.voicePlan === 'text-only' && (data.assets?.voices || []).length) warnings.push('voicePlan=text-only 但 voices 台账非空，确认是否应改 existing')

const shots = data.shots || []
if (shots[0] && shots[0].chainIntent !== '起链') errors.push('首镜必须是起链')
let transitions = 0
for (let i = 1; i < shots.length; i++) {
  const s = shots[i]
  const prev = shots[i - 1]
  if (s.sceneId === 'TRANSITION') transitions++
  if (s.chainIntent.startsWith('接 ')) {
    if (s.chainIntent !== `接 ${prev.shotId}`) errors.push(`${s.shotId}: 接的不是相邻上一镜（${s.chainIntent}）`)
  } else if (s.chainIntent === '起链' && s.sceneId !== 'TRANSITION' && prev.sceneId === s.sceneId) {
    warnings.push(`${s.shotId}: 同场景紧随 ${prev.shotId} 却标起链（新契约要求同场景后续接上一镜）`)
  }
}
const distinctLocations = new Set((data.scenes || []).map((s) => s.location))
if (distinctLocations.size >= 2 && transitions === 0) warnings.push('两个以上物理地点但没有 TRANSITION 转场镜')
if (transitions > 1) warnings.push(`TRANSITION 镜有 ${transitions} 个（本片型建议 ≤1）`)
if (data.targetSeconds < 80 || data.targetSeconds > 110) warnings.push(`targetSeconds=${data.targetSeconds} 不在 80–110s 目标区间`)
if (shots.length < 17 || shots.length > 26) warnings.push(`镜数 ${shots.length} 不在 17–26 典型区间（对白密集例外需在方案卡说明）`)
if ((data.assets?.toBuild || []).length > 8) errors.push('toBuild > 8，超出建卡集预算')
else if ((data.assets?.toBuild || []).length > 2) warnings.push(`toBuild=${data.assets.toBuild.length}（量产期应 ≤2；建卡集需在方案卡列明）`)
if (data.params && JSON.stringify(data.params.groupOrderVersion) !== JSON.stringify(canonicalGroups)) errors.push('groupOrderVersion 不等于 canonical 10 组')
for (const s of data.scenes || []) if (!s.lightBaseline) errors.push(`${s.id}: 缺 lightBaseline`)

// ── markdown 一致性 ─────────────────────────────────
const sections = ['①', '②', '③', '④', '⑤', '⑥']
for (const n of sections) if (!new RegExp(`^## ${n} `, 'm').test(md)) errors.push(`缺第 ${n} 节`)
const countRows = (startRe, endRe) => {
  const start = md.search(startRe)
  const rest = start >= 0 ? md.slice(start) : ''
  const end = rest.search(endRe)
  const body = end >= 0 ? rest.slice(0, end) : rest
  return body.split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*-{3,}/.test(l)).length
}
const shotRows = md.split('\n').filter((l) => /^\| S\d{2,3} \//.test(l)).length
if (shotRows !== shots.length) errors.push(`④ 表 ${shotRows} 行 ≠ shots ${shots.length}`)
const sceneRows = countRows(/^## ② /m, /^## ③ /m) - 1 // 表头
if (sceneRows !== data.scenes.length) errors.push(`② 表 ${sceneRows} 行 ≠ scenes ${data.scenes.length}`)
const dialogueRows = md.split('\n').filter((l) => /^\| \d+ \|/.test(l)).length
if (dialogueRows !== data.dialogue.length) errors.push(`③ 表 ${dialogueRows} 行 ≠ dialogue ${data.dialogue.length}`)
if (!md.includes(String(data.targetSeconds))) warnings.push(`① 未出现 targetSeconds=${data.targetSeconds}（仅提示）`)

console.log(`\n集制作包校验：${file}`)
for (const w of warnings) console.log(`  ⚠ ${w}`)
for (const e of errors) console.log(`  ✗ ${e}`)
if (errors.length) { console.log(`\n✗ 失败：${errors.length} 个错误 / ${warnings.length} 个警告`); process.exit(1) }
console.log(`\n✓ 通过：0 个错误 / ${warnings.length} 个警告`)
