/**
 * scripts/smoke-skill-install.mjs — 自带 skill 的「版本戳刷新」策略冒烟测试。
 *
 * 策略（lib/index.js syncBundledSkills）：内容没被用户改过就随插件升级自动刷新；
 * 一旦内容哈希与安装记录不符（= 用户改过）就只提示、不覆盖；非本插件安装的同名目录永不覆盖。
 *
 * 全程在临时目录里跑（自建 bundle + 目标目录），不碰真实的 ~/.dsh/skills。
 *
 * 用法：node scripts/smoke-skill-install.mjs
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { _internals } from '../lib/index.js'

const { syncBundledSkills, hashSkillDir, readSkillStamp, STUDIO_SKILL_MARK } = _internals

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)

const root = join(tmpdir(), 'svs-skill-install-smoke')
rmSync(root, { recursive: true, force: true })
const bundle = join(root, 'bundle')
const dest = join(root, 'home', '.dsh', 'skills')

const MARK = '# dsh-short-video-studio 安装标记\n# 来源：bundled\nname: alpha\nsource: bundled\n'
const mkBundleSkill = (name, body, withMark = true) => {
  const d = join(bundle, name)
  mkdirSync(join(d, 'references'), { recursive: true })
  writeFileSync(join(d, 'SKILL.md'), body)
  writeFileSync(join(d, 'meta.yaml'), `name: ${name}\nversion: 1.0.0\n`)
  writeFileSync(join(d, 'references', 'note.md'), 'ref\n')
  if (withMark) writeFileSync(join(d, STUDIO_SKILL_MARK), MARK.replace('name: alpha', `name: ${name}`))
}
const sync = (opts = {}) => syncBundledSkills({ srcRoot: bundle, dstRoot: dest, pluginVersion: '1.0.0', ...opts })
const read = (p) => readFileSync(p, 'utf8')

console.log('\n[1] 首次安装：复制 + 落版本戳')
mkBundleSkill('alpha', 'v1 body\n')
mkBundleSkill('beta', 'v1 body\n', false)   // 无标记：同样分发，但安装时补戳（标记只用于「来源/冲突」判定）
let r = sync()
eq('安装 bundle 里的全部 skill', r.installed.join(','), 'alpha,beta')
ok('目标目录已建立', existsSync(join(dest, 'alpha', 'SKILL.md')))
const stamp1 = readSkillStamp(join(dest, 'alpha'))
eq('版本戳：插件版本', stamp1.pluginVersion, '1.0.0')
eq('版本戳：内容哈希 = 源哈希', stamp1.contentHash, hashSkillDir(join(bundle, 'alpha')))
ok('版本戳含安装时间', /^\d{4}-/.test(stamp1.installedAt || ''), stamp1.installedAt)
eq('无标记的 skill 也落戳（安装即声明来源）', readSkillStamp(join(dest, 'beta'))?.contentHash, hashSkillDir(join(bundle, 'beta')))

console.log('\n[2] 重复同步（内容未变）：不重写、不刷新')
r = sync()
eq('无需安装', r.installed.length, 0)
eq('无需刷新', r.refreshed.length, 0)
eq('记为已最新', r.upToDate.join(','), 'alpha,beta')
eq('内容未变', read(join(dest, 'alpha', 'SKILL.md')), 'v1 body\n')

console.log('\n[3] 插件侧变更（源改了）：自动刷新 + 更新版本戳')
writeFileSync(join(bundle, 'alpha', 'SKILL.md'), 'v2 body\n')
r = sync({ pluginVersion: '1.1.0' })
eq('刷新 1 个', r.refreshed.join(','), 'alpha')
eq('目标内容已更新', read(join(dest, 'alpha', 'SKILL.md')), 'v2 body\n')
const stamp2 = readSkillStamp(join(dest, 'alpha'))
eq('版本戳已更新到新插件版本', stamp2.pluginVersion, '1.1.0')
eq('版本戳哈希 = 新源哈希', stamp2.contentHash, hashSkillDir(join(bundle, 'alpha')))

console.log('\n[4] 用户改过已安装副本：不覆盖，只提示')
writeFileSync(join(dest, 'alpha', 'SKILL.md'), 'v2 body + 用户本地改动\n')
writeFileSync(join(bundle, 'alpha', 'SKILL.md'), 'v3 body\n')
r = sync({ pluginVersion: '1.2.0' })
eq('刷新 0 个', r.refreshed.length, 0)
eq('记为「用户改过，保留」', r.keptUserEdited.join(','), 'alpha')
eq('用户内容原样保留', read(join(dest, 'alpha', 'SKILL.md')), 'v2 body + 用户本地改动\n')
eq('版本戳未被改写', readSkillStamp(join(dest, 'alpha')).pluginVersion, '1.1.0')

console.log('\n[5] force 模式：连用户改过的也覆盖（显式越权开关）')
r = sync({ pluginVersion: '1.2.0', refresh: 'force' })
eq('强制刷新 1 个', r.refreshed.join(','), 'alpha')
eq('内容已切成新版', read(join(dest, 'alpha', 'SKILL.md')), 'v3 body\n')
eq('版本戳已更新', readSkillStamp(join(dest, 'alpha')).pluginVersion, '1.2.0')

console.log('\n[6] off 模式：完全不碰已有目录')
writeFileSync(join(bundle, 'alpha', 'SKILL.md'), 'v4 body\n')
r = sync({ pluginVersion: '1.3.0', refresh: 'off' })
eq('刷新 0 个', r.refreshed.length + r.stamped.length, 0)
eq('内容保持 v3', read(join(dest, 'alpha', 'SKILL.md')), 'v3 body\n')

console.log('\n[7] 旧版安装（有标记但没有内容哈希）')
const legacy = join(dest, 'legacy')
mkdirSync(legacy, { recursive: true })
writeFileSync(join(legacy, STUDIO_SKILL_MARK), MARK.replace('name: alpha', 'name: legacy'))
mkBundleSkill('legacy', 'same body\n')
writeFileSync(join(legacy, 'SKILL.md'), 'same body\n')
writeFileSync(join(legacy, 'meta.yaml'), 'name: legacy\nversion: 1.0.0\n')
mkdirSync(join(legacy, 'references'), { recursive: true })
writeFileSync(join(legacy, 'references', 'note.md'), 'ref\n')
r = sync({ pluginVersion: '1.4.0', refresh: '' })
ok('内容与源一致 → 只补戳不复制', r.stamped.includes('legacy') || r.upToDate.includes('legacy'), JSON.stringify(r))
eq('补戳后记下版本', readSkillStamp(legacy).pluginVersion, '1.4.0')
writeFileSync(join(legacy, 'SKILL.md'), 'legacy 用户改过\n')
writeFileSync(join(bundle, 'legacy', 'SKILL.md'), 'legacy 新版\n')
r = sync({ pluginVersion: '1.4.0', refresh: '' })
eq('旧版且内容与源不一致 → 按用户改过处理', r.keptUserEdited.includes('legacy'), true)
eq('用户内容保留', read(join(legacy, 'SKILL.md')), 'legacy 用户改过\n')

console.log('\n[8] 无标记但内容与源一致（插件早期安装）：收编补戳，不动内容')
mkBundleSkill('adopted', 'adopt me\n')
const adopted = join(dest, 'adopted')
cpSync(join(bundle, 'adopted'), adopted, { recursive: true })   // 内容与源一致…
rmSync(join(adopted, STUDIO_SKILL_MARK), { force: true })       // …但没有安装标记（模拟插件早期安装）
r = sync()
ok('记为收编', r.adopted.includes('adopted'), JSON.stringify(r.adopted))
eq('未记为冲突', r.conflicts.includes('adopted'), false)
eq('内容未被改动（仍是原文件）', read(join(adopted, 'SKILL.md')), 'adopt me\n')
eq('已补版本戳', readSkillStamp(adopted).contentHash, hashSkillDir(join(bundle, 'adopted')))
r = sync()
eq('收编后不再重复动作', r.upToDate.includes('adopted') || r.stamped.includes('adopted'), true)

console.log('\n[8b] 非本插件安装的同名目录（内容不同）：永不覆盖 + 冲突提示')
const foreign = join(dest, 'foreign')
mkdirSync(foreign, { recursive: true })
writeFileSync(join(foreign, 'SKILL.md'), '第三方内容\n')
mkBundleSkill('foreign', 'bundled 内容\n')
r = sync()
ok('记为冲突', r.conflicts.includes('foreign'), JSON.stringify(r.conflicts))
eq('未误判为收编', r.adopted.includes('foreign'), false)
eq('第三方内容未被覆盖', read(join(foreign, 'SKILL.md')), '第三方内容\n')

console.log('\n[9] 哈希无关 mtime：内容相同即视为已最新')
const before = hashSkillDir(join(dest, 'alpha'))
const later = new Date(Date.now() + 60000)
writeFileSync(join(dest, 'alpha', 'SKILL.md'), read(join(dest, 'alpha', 'SKILL.md')))
ok('哈希稳定', hashSkillDir(join(dest, 'alpha')) === before, `${before} vs ${hashSkillDir(join(dest, 'alpha'))}`)
ok('标记文件不参与哈希', (() => {
  const h1 = hashSkillDir(join(dest, 'alpha'))
  writeFileSync(join(dest, 'alpha', STUDIO_SKILL_MARK), read(join(dest, 'alpha', STUDIO_SKILL_MARK)) + '\n# 注释\n')
  return hashSkillDir(join(dest, 'alpha')) === h1
})())

rmSync(root, { recursive: true, force: true })
console.log(`\n${fail ? '✗' : '✓'} smoke-skill-install：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
