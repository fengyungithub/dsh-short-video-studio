/**
 * 冒烟：项目配置卡（settings v2 + applyProjectConfig）
 * 覆盖：建卡 / rev / configured / flow / groupOrder / 卡内容同步 / 乐观并发 /
 * fast+three 收敛 / canvas_set_state + canvas_get_state / 配置卡写保护。
 * 用法：node scripts/smoke-config-card.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'svs-config-home-'))
process.env.HOME = HOME
process.env.DSH_SVS_CONFIG = join(HOME, 'config.json')
process.env.DSH_SVS_SKILL_REFRESH = 'off'
process.env.DSH_SVS_CONFIG_GATE = 'off'

const { apply, _internals } = await import('../lib/index.js')
const { applyProjectConfig, normalizeSettings, inferFlow, renderConfigMarkdown, configCardId, findConfigCard } = _internals

let passed = 0
function ok(cond, name) {
  assert.ok(cond, name)
  passed++
  console.log('  ok -', name)
}

const root = mkdtempSync(join(tmpdir(), 'svs-config-card-'))
const sid = 's-config'
const canvasDir = join(root, 'canvas', sid)
mkdirSync(canvasDir, { recursive: true })
const projectPath = join(canvasDir, 'project.json')
const readProject = () => JSON.parse(readFileSync(projectPath, 'utf8'))

// ---- 0. 纯函数：规范化 / 推断 ----
console.log('# normalizeSettings / inferFlow')
{
  const s = normalizeSettings({})
  ok(s.configured === false, '缺省未配置')
  ok(s.flow === 'free', '空项目推断 free')
  ok(s.shotGate === 'verdict', 'shotGate 缺省 verdict')
  ok(s.imageTier === 'balanced', 'imageTier 缺省 balanced')
  const s2 = normalizeSettings({ mode: 'fast', characterCardVariant: 'three' })
  ok(s2.characterCardVariant === 'single', 'fast + three 收敛为 single')
  ok(inferFlow({ nodes: [], settings: { series: { id: 'x' } } }) === 'series', '有 series 元数据 → series')
  const md = renderConfigMarkdown(normalizeSettings({ flow: 'story', aspectRatio: '9:16', configured: true, rev: 2 }))
  ok(md.includes('画幅') && md.includes('9:16') && md.includes('rev 2'), '配置卡正文含关键字段')
}

// ---- 1. 写入口：建卡 + rev ----
console.log('# applyProjectConfig')
{
  const r = await applyProjectConfig(root, sid, { flow: 'story', aspectRatio: '9:16', mode: 'balanced', subtitles: 'none' }, { source: 'agent' })
  ok(r.ok && r.rev === 1, '首次写入 rev=1')
  ok(r.cardNodeId === configCardId(sid), '返回稳定配置卡 id')
  const p = readProject()
  ok(p.settings.configured === true, 'settings.configured=true')
  ok(p.settings.flow === 'story', 'flow=story')
  ok(p.settings.aspectRatio === '9:16', 'aspectRatio 写入')
  ok(Array.isArray(p.settings.groupOrder) && p.settings.groupOrder[0] === '项目配置', 'groupOrder 首位是项目配置')
  const card = findConfigCard(p)
  ok(card && card.kind === 'text', '配置卡是文本节点')
  ok(card.id === configCardId(sid), '配置卡 id 稳定')
  ok(card.params.configCard === true && card.params.configRev === 1, '卡上记录 configCard/configRev')
  ok(String(card.content).includes('| 画幅 | 9:16 |'), '卡正文与 settings 同步')
  ok(card.group === '项目配置', '卡分组=项目配置')
}

// ---- 2. 乐观并发 + rev/breakingRev ----
console.log('# 乐观并发 / rev')
{
  const r = await applyProjectConfig(root, sid, { aspectRatio: '16:9' }, { source: 'user', expectedRev: 1 })
  ok(r.rev === 2, '第二次写入 rev=2')
  ok(r.changed.includes('aspectRatio'), 'changed 含 aspectRatio')
  const p = readProject()
  ok(p.settings.breakingRev === 2, '破坏性字段变更提升 breakingRev')
  let conflict = null
  try {
    await applyProjectConfig(root, sid, { mode: 'fast' }, { source: 'user', expectedRev: 1 })
  } catch (e) { conflict = e }
  ok(conflict && conflict.code === 'CONFIG_REV_CONFLICT', 'expectedRev 不一致 → CONFIG_REV_CONFLICT')
}

// ---- 3. fast + three 自动收敛 ----
console.log('# fast + three')
{
  const r = await applyProjectConfig(root, sid, { mode: 'fast', characterCardVariant: 'three' }, { source: 'agent' })
  const p = readProject()
  ok(p.settings.mode === 'fast' && p.settings.characterCardVariant === 'single', 'fast 档强制单视图')
  ok(r.warnings.some((w) => w.includes('fast')), '给出自动收敛 warning')
}

// ---- 4. 工具面：canvas_set_state / canvas_get_state / 写保护 ----
console.log('# 工具面')
{
  const workspaceRegistry = {
    get: (id) => (String(id) === 'w' ? { id: 'w', path: root, sessionIds: [sid] } : undefined),
    list: () => [{ id: 'w', path: root, sessionIds: [sid] }],
    resolveByPath: async () => undefined,
  }
  const registered = []
  const hostCtx = {
    webServer: { register: () => () => {} },
    tools: { register: (t) => { registered.push(t); return () => {} }, get: () => undefined },
    systemPrompt: { section: () => () => {} },
    workspaceRegistry,
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on: () => () => {},
  }
  apply(hostCtx)
  const byName = Object.fromEntries(registered.map((t) => [t.name, t]))
  const exec = { agent: { id: sid } }

  const st = await byName.canvas_set_state.execute({ sessionId: sid, flow: 'story', imageTier: 'quality' }, exec)
  ok(st.ok && st.rev >= 4, 'canvas_set_state 返回 rev')
  ok(st.cardNodeId === configCardId(sid), 'canvas_set_state 返回卡 id')

  const got = await byName.canvas_get_state.execute({ sessionId: sid }, exec)
  ok(got.configured === true && got.settings.imageTier === 'quality', 'canvas_get_state 读回新字段')
  ok(got.rev === st.rev && got.cardNodeId === configCardId(sid), 'canvas_get_state 返回 rev/卡 id')

  const blocked = await byName.canvas_write_node.execute({ sessionId: sid, nodeId: configCardId(sid), kind: 'text', title: 'x', content: 'x' }, exec)
  ok(Boolean(blocked.error), 'canvas_write_node 拒绝直接写配置卡')
}

rmSync(root, { recursive: true, force: true })
rmSync(HOME, { recursive: true, force: true })
console.log(`\n全部通过（${passed} 项）`)
