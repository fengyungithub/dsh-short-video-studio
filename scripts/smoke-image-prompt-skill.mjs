/**
 * scripts/smoke-image-prompt-skill.mjs — qwen-image-prompt-writing skill 契约冒烟。
 *
 * 校验：
 *  1) SKILL.md 存在且 frontmatter 合规（name=目录名、description ≤1024 且无尖括号、只含白名单键）；
 *  2) meta.yaml 必备字段齐全、version 是三段版本号、source 有出处；
 *  3) references 与 scripts 里的文件真实存在且非空；
 *  4) SKILL.md 引用表里列的路径都存在（防止文档指向已改名/删掉的文件）；
 *  5) check_prompt.mjs --self-test 通过（示例回归，0 error）。
 *
 * 用法：node scripts/smoke-image-prompt-skill.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILL = 'qwen-image-prompt-writing'
const dir = join(root, 'skills', SKILL)
const read = (p) => readFileSync(join(dir, p), 'utf8')
const exists = (p) => existsSync(join(dir, p))

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

// ── 1. 文件骨架 ────────────────────────────────────────────────────────
console.log('[1] 文件骨架')
ok('skill 目录存在', existsSync(dir))
for (const f of [
  'SKILL.md',
  'meta.yaml',
  'references/t2i-spec.md',
  'references/edit-spec.md',
  'references/examples.md',
  'references/studio-mapping.md',
  'scripts/check_prompt.mjs',
]) {
  const full = join(dir, f)
  ok(`${f} 存在且非空`, existsSync(full) && statSync(full).size > 200, existsSync(full) ? '内容过短' : '缺失')
}

// ── 2. frontmatter ────────────────────────────────────────────────────
console.log('\n[2] SKILL.md frontmatter')
const skillMd = read('SKILL.md')
const fm = (skillMd.match(/^---\n([\s\S]*?)\n---\n/) || [])[1] || ''
ok('有 frontmatter', !!fm)
const meta = Object.fromEntries(
  fm.split('\n')
    .filter((l) => /^[a-zA-Z-]+:/.test(l))
    .map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]),
)
const ALLOWED = new Set(['name', 'description', 'license', 'metadata', 'compatibility', 'whenToUse'])
ok('name 等于目录名', meta.name === SKILL, `实际 ${meta.name}`)
ok('description 存在', !!meta.description)
ok('description ≤ 1024 字符', (meta.description || '').length <= 1024, `${(meta.description || '').length} 字符`)
ok('description 无尖括号', !/[<>]/.test(meta.description || ''))
ok('description 含触发词', /提示词增强|提示词优化|扩写/.test(meta.description || ''))
const oddKeys = Object.keys(meta).filter((k) => !ALLOWED.has(k))
ok('frontmatter 只用白名单键', oddKeys.length === 0, oddKeys.join(', '))

// ── 3. meta.yaml ──────────────────────────────────────────────────────
console.log('\n[3] meta.yaml')
const metaYaml = read('meta.yaml')
const need = ['display-name-zh', 'version', 'tag-en', 'tag-cn', 'summary-en', 'summary-cn', 'desc-en', 'desc-cn', 'source']
for (const k of need) ok(`有 ${k}`, new RegExp(`^${k}:`, 'm').test(metaYaml))
ok('version 是三段版本号', /^version:\s*\d+\.\d+\.\d+\s*$/m.test(metaYaml), (metaYaml.match(/^version:.*$/m) || [])[0])
ok('source 标了官方出处', /^source:\s*official-adapted\s*$/m.test(metaYaml) && /^source-original:\s*https?:\/\//m.test(metaYaml))

// ── 4. 文档引用的路径都存在 ────────────────────────────────────────────
console.log('\n[4] SKILL.md 引用表路径')
const cited = [...skillMd.matchAll(/`((?:references|scripts)\/[^`]+)`/g)].map((m) => m[1])
const uniqCited = [...new Set(cited)]
ok('引用表非空', uniqCited.length >= 4, `${uniqCited.length} 条`)
for (const p of uniqCited) ok(`引用存在：${p}`, exists(p))

// ── 5. 检查器自检 ─────────────────────────────────────────────────────
console.log('\n[5] check_prompt.mjs --self-test')
const res = spawnSync(process.execPath, [join(dir, 'scripts', 'check_prompt.mjs'), '--self-test'], { encoding: 'utf8' })
ok('self-test 退出码 0', res.status === 0, `status=${res.status}`)
ok('self-test 无失败项', !/✗/.test(res.stdout || ''), (res.stdout || '').trim().split('\n').slice(-1)[0])
const m = (res.stdout || '').match(/(\d+) 通过 \/ (\d+) 失败/)
ok('self-test 至少 6 项通过', m && Number(m[1]) >= 6, m ? `${m[1]} 通过` : '未解析到统计行')

console.log(`\n${fail === 0 ? '✓' : '✗'} smoke-image-prompt-skill：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
