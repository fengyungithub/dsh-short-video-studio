/**
 * scripts/smoke-skill-contract.mjs — 短剧三 skill 的契约冒烟测试。
 *
 * 校验：
 *  1) schemas/episode-package.schema.json 可解析，fixture 通过 schema 校验；
 *  2) fixture 的跨字段规则（集号/镜数/声线/续接/groupOrder）；
 *  3) 三个 SKILL.md 的关键路由词、groupOrder、PACK 自检项、过期断言；
 *  4) PROD 的 state 草案 JSON 可解析且含声线/时长例外字段。
 *
 * 用法：node scripts/smoke-skill-contract.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const readJson = (p) => JSON.parse(read(p))
const lib = read('lib/index.js')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)

// ── 1. schema + fixture ──────────────────────────────────────────────
const schema = readJson('schemas/episode-package.schema.json')
const fixture = readJson('scripts/fixtures/episode-package.example.json')

function typeOf(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}
function validate(node, s, path, errs) {
  if (s.const !== undefined) {
    if (node !== s.const) errs.push(`${path}: 应为 ${JSON.stringify(s.const)}`)
    return
  }
  if (s.enum && !s.enum.includes(node)) errs.push(`${path}: 不在枚举 ${JSON.stringify(s.enum)}`)
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type]
    const got = typeOf(node)
    const typeOk = types.some((t) => (t === 'integer' ? Number.isInteger(node) : t === got))
    if (!typeOk) { errs.push(`${path}: 类型应为 ${types.join('|')}，实际 ${got}`); return }
  }
  if (typeof node === 'string') {
    if (s.minLength !== undefined && node.length < s.minLength) errs.push(`${path}: 长度 < ${s.minLength}`)
    if (s.pattern && !new RegExp(s.pattern).test(node)) errs.push(`${path}: 不匹配 ${s.pattern}`)
  }
  if (typeof node === 'number') {
    if (s.minimum !== undefined && node < s.minimum) errs.push(`${path}: < ${s.minimum}`)
    if (s.maximum !== undefined && node > s.maximum) errs.push(`${path}: > ${s.maximum}`)
  }
  if (Array.isArray(node)) {
    if (s.minItems !== undefined && node.length < s.minItems) errs.push(`${path}: 项数 < ${s.minItems}`)
    if (s.maxItems !== undefined && node.length > s.maxItems) errs.push(`${path}: 项数 > ${s.maxItems}`)
    if (s.items) node.forEach((v, i) => validate(v, s.items, `${path}[${i}]`, errs))
  } else if (node && typeof node === 'object') {
    for (const k of s.required || []) if (!(k in node)) errs.push(`${path}: 缺必填 ${k}`)
    if (s.additionalProperties === false) {
      for (const k of Object.keys(node)) if (!(s.properties || {})[k]) errs.push(`${path}: 多余字段 ${k}`)
    }
    for (const [k, sub] of Object.entries(s.properties || {})) if (k in node) validate(node[k], sub, `${path}.${k}`, errs)
  }
}

const errs = []
validate(fixture, schema, '$', errs)
ok('schema 可解析', schema.title === 'Episode Package (contract v1)')
ok('fixture 通过 schema 校验', errs.length === 0, errs.slice(0, 3).join('；'))

// ── 2. fixture 跨字段规则 ────────────────────────────────────────────
eq('集号与 number 同构', fixture.episode.id, `EP${String(fixture.episode.number).padStart(3, '0')}`)
eq('shots 数 = shotBudget', fixture.shots.length, fixture.shotBudget)
eq('场景数 ≤2', fixture.scenes.length <= 2, true)
eq('镜数 = 对白句数 + 动作镜 + 转场镜（fixture）', fixture.shots.length, fixture.dialogue.length + 1 + 1)

const speakers = new Set(fixture.assets.characters.map((c) => c.name))
ok('对白说话人都在角色清单', fixture.dialogue.every((d) => speakers.has(d.speaker)))
const voiceIds = new Set(fixture.assets.voices.map((v) => v.voiceAssetId))
ok('对白 voiceRef 都能在 voices 台账找到', fixture.dialogue.every((d) => d.voiceRef === 'none' || voiceIds.has(d.voiceRef)))
ok('voicePlan=existing 时对白无 none', fixture.params.voicePlan !== 'existing' || fixture.dialogue.every((d) => d.voiceRef !== 'none'))

ok('首镜起链', fixture.shots[0].chainIntent === '起链')
for (let i = 1; i < fixture.shots.length; i++) {
  const s = fixture.shots[i]
  const prev = fixture.shots[i - 1]
  if (s.chainIntent !== '转场') ok(`S0${i + 1} 接相邻上一镜`, s.chainIntent === `接 ${prev.shotId}`, s.chainIntent)
}

const canonicalGroups = [
  'story planning', 'character cards', 'voice auditions', 'scene cards', 'prop cards',
  'shot table', 'text storyboards', 'shot prompts', 'shot clips', 'final delivery',
]
eq('fixture groupOrderVersion = 10 组', fixture.params.groupOrderVersion, canonicalGroups)

// ── 3. 三个 SKILL.md 的文本契约 ──────────────────────────────────────
const ssg = read('skills/story-short-generator/SKILL.md')
const prod = read('skills/short-drama-series-production/SKILL.md')
const wri = read('skills/short-drama-series-writer/SKILL.md')
const pack = read('skills/short-drama-series-production/references/episode-package.md')
const run = read('skills/short-drama-series-production/references/production-runbook.md')
const singleMode = read('skills/story-short-generator/references/single-film-mode.md')
const seriesMode = read('skills/story-short-generator/references/series-delegated-mode.md')
const voiceRef = read('skills/story-short-generator/references/voice-audition.md')
const h3map = read('skills/h3-prompt-writing/references/studio-mapping.md')

const descOf = (text) => {
  const m = text.match(/^description: \|\n([\s\S]*?)^whenToUse: \||^description: \|\n([\s\S]*?)^trigger-words:/m)
  return (m?.[1] ?? m?.[2] ?? '').slice(0, 500)
}
ok('SSG 前 500 字含「连续短剧」', descOf(ssg).includes('连续短剧'))
ok('PROD 前 500 字含「不拍片」', descOf(prod).includes('不拍片'))
ok('WRI 前 500 字含「只出文本」', descOf(wri).includes('只出文本'))

function quotedArrays(text) {
  return [...text.matchAll(/\[[^\]]*"story planning"[^\]]*\]/g)].map((m) =>
    [...m[0].matchAll(/"([^"]+)"/g)].map((x) => x[1])
  )
}
const lists = [...quotedArrays(ssg), ...quotedArrays(prod), ...quotedArrays(run)]
ok('三处 groupOrder 都等于 10 组', lists.length >= 3 && lists.every((l) => JSON.stringify(l) === JSON.stringify(canonicalGroups)), `找到 ${lists.length} 处`)

const checks = [...pack.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]))
ok('PACK 自检 12 项连续编号', JSON.stringify(checks.slice(-12)) === JSON.stringify([1,2,3,4,5,6,7,8,9,10,11,12]))
const six = [...pack.matchAll(/^\| (视觉风格|画面比例|总时长|音频模式|声线方案|字幕|生成档位（视频）|角色卡引用版本|图片档位|交付画质|片段审查节奏|分镜模式) \|/gm)]
eq('PACK ⑥ 预填 12 项', six.length, 12)

ok('WRI 不再写死 18–25 句', !wri.includes('18-25 句'))
ok('WRI 不再写死 12 镜', !wri.includes('12 个镜头'))
ok('WRI 不再要求生成制作包', !wri.includes('导出时必须生成') && wri.includes('episodes-production/` 已废弃'))
ok('SSG 无九个分组残留', !ssg.includes('九个分组'))
ok('PROD 无九个分组残留', !prod.includes('九个分组'))
ok('SSG 不再声称不能生成 BGM', !ssg.includes('不能生成 BGM'))
ok('SSG 转场不再强制 quality', !ssg.includes('一律用 `quality` 档重出'))

const stateBlock = prod.match(/```json\n([\s\S]*?)\n```/)?.[1]
let state = null
try { state = JSON.parse(stateBlock) } catch {}
ok('PROD state 草案是合法 JSON', !!state)
ok('state 含 voices 台账', Array.isArray(state?.assets?.voices))
ok('state 含 voicePlan / 时长区间 / 例外', state?.series?.voicePlan !== undefined && Array.isArray(state?.series?.episodeSecondsRange) && state?.series?.episodeSecondsException !== undefined)
ok('PROD 声明 contract v1', prod.includes('episode-package/v1') || pack.includes('episode-package/v1'))
ok('PACK 指向 schema', pack.includes('schemas/episode-package.schema.json'))
ok('SSG 指向单片模式参考', ssg.includes('references/single-film-mode.md'))
ok('SSG 指向剧集委托模式参考', ssg.includes('references/series-delegated-mode.md'))
ok('SSG 指向声线参考', ssg.includes('references/voice-audition.md'))
ok('单片参考含 13 张规格卡', singleMode.includes('13 张规格卡'))
ok('剧集参考含 assetMode=library 与 3 张卡', seriesMode.includes('assetMode=library') && seriesMode.includes('3 张卡'))
ok('声线参考含“不带风格锁 C”', voiceRef.includes('不带风格锁 C'))
ok('剧集参考含 E-STEP 0 预检', seriesMode.includes('E-STEP 0') && seriesMode.includes('规格偏差卡'))
ok('runbook 含本集规格卡', run.includes('本集规格'))
ok('SSG 连续短剧硬停', ssg.includes('立即停止本 skill 流程') && ssg.includes('不要静默降级'))
ok('系列参考含 story 立即停止', seriesMode.includes('立即停止'))
ok('PROD 缺失剧本时走完整 writer 流水', prod.includes('完整剧本流水') && prod.includes('不代写剧本'))
ok('WRI 声明被 production 调用时完整流水', wri.includes('被 `short-drama-series-production` 调用时'))
ok('PROD 资产总览 + 是否入库询问', prod.includes('资产总览') && prod.includes('是否入库'))
ok('PROD 不再说 AI 不调用入库', !prod.includes('AI 不调用入库'))
ok('systemPrompt 禁止 AI 不代劳提示', lib.includes('禁止提示「AI 不代劳'))
ok('PROD 含 S-STEP 0 系列规格卡', prod.includes('S-STEP 0') && prod.includes('系列规格卡'))
ok('系列参考指向 S-STEP 0', seriesMode.includes('S-STEP 0'))
ok('SSG 有 bgmMode 选项', singleMode.includes('bgmMode') && singleMode.includes('in-model'))
ok('SSG 镜头表有 BGM 子字段', ssg.includes('`BGM` —'))
ok('SSG 镜头表自检项数声明', ssg.includes('十四项必检'))
ok('SSG 第 12 项是剧本覆盖', ssg.includes('剧本覆盖与台词逐字'))
ok('SSG 镜头表要求剧本依据', ssg.includes('剧本依据'))
ok('SSG 门 3 记录结构化 checks', ssg.includes('checks={plan,character,lipsync,subtitle,contamination,audio,style}'))
ok('SSG 声明生成前镜头表一致性门', ssg.includes('镜头表一致性门'))
ok('single-film 大纲要求 beat 编号', singleMode.includes('B01') && singleMode.includes('剧本依据'))
ok('PROD 十四项自检', prod.includes('十四项'))
ok('lib 注册镜头表一致性门', lib.includes('makePlanGateListener') && lib.includes('parseShotTableContent'))
ok('PROD 有 bgmMode/in-model', prod.includes('bgmMode') && prod.includes('in-model'))
ok('h3 映射含 bgmMode', h3map.includes('bgmMode'))
ok('schema 含 bgmMode', !!readJson('schemas/episode-package.schema.json').properties?.params?.properties?.bgmMode)

console.log('')
if (fail) {
  console.log(`✗ smoke-skill-contract：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✓ smoke-skill-contract：${pass} 通过 / 0 失败`)
}
