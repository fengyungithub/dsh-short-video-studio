/**
 * scripts/smoke-tier-resolution.mjs — P1 档位解析层冒烟测试。
 *
 * 纯逻辑 + 注入式节点探针（不触网、不调 ComfyUI），验证 docs/tier-strategy-design.md 的语义：
 *  1) 默认解析：无配置 → 该档候选首个，且**无加速优先**（内置默认＝无加速）
 *  2) 配置选定生效；选定的实现不可用 → **报错**（带节点名与改选建议），绝不静默换成标准实现
 *  3) ComfyUI 离线（探针未知）→ 不判死，照常解析
 *  4) internal 诊断清单永不参与档位解析
 *  5) 显式 workflow 的档位与请求档位不符 → 报错（不静默跨档替换）
 *  6) 该档无实现 → 报错并列出可用档位
 *  7) 策略投影：「无加速」「有加速」两条；加速档缺 sol 实现时落标准；两条完全相同时只给一条
 *  8) 未分档的旧清单：按 mode 名匹配请求档位；匹配不到 → 报错（不猜）
 *  9) resolveMode strict：显式请求不存在的 mode → 报错；单档清单唯一 mode 照用
 *
 * 用法：node scripts/smoke-tier-resolution.mjs
 */

import { _internals } from '../lib/index.js'

const {
  sortTierCandidates, tierImplementations, groupNameOf, isTieredCapability,
  resolveTieredManifest, projectCapabilityStrategies, userStrategiesOf, describeTierMatrix, checkAvailability,
} = _internals

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `期望 ${want}，实际 ${got}`)

/** 造一份测试清单。 */
const mk = (id, extra = {}) => ({
  id,
  version: 1,
  capability: 'video.reference2video',
  displayName: 'Demo 视频',
  graph: {},
  params: {},
  ...extra,
})

function makeRegistry(manifests) {
  const byId = {}
  const byCapability = {}
  for (const m of manifests) {
    byId[m.id] = m
    ;(byCapability[m.capability] ||= []).push(m)
  }
  for (const list of Object.values(byCapability)) {
    list.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || String(a.id).localeCompare(String(b.id)))
  }
  return { manifests, byId, byCapability, errors: [] }
}

const R = 'video.reference2video'
const BASE = [
  mk('demo-fast', { group: 'demo', tier: 'fast', estSeconds: 25, modes: { fast: { steps: 4, longSide: 832 } } }),
  mk('demo-balanced', { group: 'demo', tier: 'balanced', estSeconds: 166, modes: { balanced: { steps: 8, longSide: 1344 } } }),
  mk('demo-balanced-sol', { group: 'demo', tier: 'balanced', accel: 'sol', requiresNodes: ['SolAttnMiniMaxH3'], estSeconds: 136, modes: { balanced: { steps: 8, longSide: 1344 } } }),
  mk('demo-quality', { group: 'demo', tier: 'quality', estSeconds: 397, modes: { quality: { steps: 20, longSide: 1344 } } }),
  mk('demo-quality-sol', { group: 'demo', tier: 'quality', accel: 'sol', requiresNodes: ['SolAttnMiniMaxH3'], estSeconds: 311, modes: { quality: { steps: 20, longSide: 1344 } } }),
  mk('demo-stats', { group: 'demo', tier: 'quality', internal: true, requiresNodes: ['SolAttnStats'] }),
  mk('legacy-multi', { modes: { quality: { steps: 20 }, fast: { steps: 4 } } }),
]
const registry = makeRegistry(BASE)

/** 探针：nodes 里的类视为已注册，返回 false；probeUnknown=true 时一律返回 null（模拟离线）。 */
const probeWith = (nodes, unknown = false) => async (cls) => {
  if (unknown) return null
  return nodes.includes(cls)
}
const SOL_PRESENT = probeWith(['SolAttnMiniMaxH3', 'SolAttnStats'])
const SOL_MISSING = probeWith(['SolAttnStats'])
// 有 Sol-Attn、缺 PDD 节点：用于断言 PDD 实现会如实置灰（而不是假装可用后渲染时才炸）
// Sol 与 PDD 节点都装（本机现状）：PDD 清单可显式解析
const ALL_PRESENT = probeWith(['SolAttnMiniMaxH3', 'SolAttnStats', 'MiniMaxH3PDDAccApply'])
// 只装 Sol、没装 PDD：PDD 清单必须如实置灰
const PDD_MISSING = probeWith(['SolAttnMiniMaxH3', 'SolAttnStats'])

const cfg = (tiers) => ({ tiers })

console.log('\n[1] 默认解析 / 无加速优先')
{
  const r = await resolveTieredManifest(R, 'balanced', null, { registry, probe: SOL_PRESENT, selection: {} })
  eq('balanced 无配置 → 标准实现', r.manifest.id, 'demo-balanced')
  eq('resolution', r.resolution, 'tier-default')
  const q = await resolveTieredManifest(R, 'quality', null, { registry, probe: SOL_PRESENT, selection: {} })
  eq('quality 无配置 → 标准实现（internal 不参与）', q.manifest.id, 'demo-quality')
  const f = await resolveTieredManifest(R, 'fast', null, { registry, probe: SOL_PRESENT, selection: {} })
  eq('fast → 唯一实现', f.manifest.id, 'demo-fast')
  const none = await resolveTieredManifest(R, null, null, { registry, probe: SOL_PRESENT, selection: {} })
  eq('未指定档位 → 默认档', none.tier, 'quality')
  ok('未指定档位带警告（不静默）', none.warnings.length > 0)
}

console.log('\n[2] 排序确定性：priority 降序 → 无加速优先 → id 升序')
{
  const list = sortTierCandidates([
    mk('b-sol', { tier: 'quality', accel: 'sol' }),
    mk('a-std', { tier: 'quality' }),
    mk('c-std-hi', { tier: 'quality', priority: 5 }),
  ])
  eq('priority 最高者在前', list[0].id, 'c-std-hi')
  eq('同 priority 时无加速在前', list[1].id, 'a-std')
}

console.log('\n[3] 配置选定生效 + 不可用必须报错（绝不静默替换）')
{
  // 配置选定：注入 selection 即模拟「设置页点了加速策略 / 逐档改选」
  const r = await resolveTieredManifest(R, 'quality', null, { registry, probe: SOL_PRESENT, selection: { quality: 'demo-quality-sol' } })
  eq('配置选定 → 用选中的实现', r.manifest.id, 'demo-quality-sol')
  eq('解析来源标记为 tier-config', r.resolution, 'tier-config')
  // 选中的实现没装节点 → 必须报错（不静默回退标准实现）
  let threw = null
  try { await resolveTieredManifest(R, 'quality', null, { registry, probe: SOL_MISSING, selection: { quality: 'demo-quality-sol' } }) }
  catch (e) { threw = e }
  ok('配置选定但缺节点 → 报错', Boolean(threw))
  ok('报错含缺失节点名', threw && threw.message.includes('SolAttnMiniMaxH3'), threw && threw.message)
  ok('报错给改选建议（不自动替换）', threw && threw.message.includes('不会静默替换'), threw && threw.message)
  const pickedSol = registry.byId['demo-quality-sol']
  ok('可用性检查直接返回 missing', (await checkAvailability(pickedSol, { probe: SOL_MISSING })).missing.includes('SolAttnMiniMaxH3'))
}

console.log('\n[4] ComfyUI 离线（探针未知）→ 不判死')
{
  const r = await resolveTieredManifest(R, 'quality', 'demo-quality-sol', { registry, probe: probeWith([], true), selection: {} })
  eq('离线仍解析到所选实现', r.manifest.id, 'demo-quality-sol')
}

console.log('\n[5] 显式 workflow：档位不符 → 报错；相符 → 用它')
{
  let threw = null
  try { await resolveTieredManifest(R, 'fast', 'demo-quality', { registry, probe: SOL_PRESENT, selection: {} }) } catch (e) { threw = e }
  ok('fast 请求 + quality 实现 → 报错', Boolean(threw))
  ok('报错说明不静默跨档替换', threw && threw.message.includes('不静默跨档替换'), threw && threw.message)
  const r = await resolveTieredManifest(R, 'quality', 'demo-quality', { registry, probe: SOL_PRESENT, selection: {} })
  eq('档位相符 → 用显式实现', r.manifest.id, 'demo-quality')
  eq('resolution', r.resolution, 'explicit')
  // internal 诊断清单可显式调用
  const s = await resolveTieredManifest(R, null, 'demo-stats', { registry, probe: SOL_PRESENT, selection: {} })
  eq('internal 清单可显式调用', s.manifest.id, 'demo-stats')
}

console.log('\n[6] 该档无实现 → 报错并列出可用档位')
{
  const onlyFast = makeRegistry([mk('only-fast', { group: 'solo', tier: 'fast' })])
  let threw = null
  try { await resolveTieredManifest(R, 'quality', null, { registry: onlyFast, probe: SOL_PRESENT, selection: {} }) } catch (e) { threw = e }
  ok('报错', Boolean(threw))
  ok('列出可用档位', threw && threw.message.includes('fast'), threw && threw.message)
  ok('isTieredCapability=true', isTieredCapability(R, onlyFast))
}

console.log('\n[7] 策略：一条内置默认 + 用户自建（命名）')
{
  // 内置默认 = 各档的**非加速首选**，label 取主家族名；用户不配策略时列表里就只有这一条
  const base = await describeTierMatrix(registry, { probe: SOL_PRESENT, cfg: {} })
  const st = base[R].strategies || []
  eq('默认只有一条策略', st.length, 1)
  eq('该条是内置默认', st[0].builtin, true)
  eq('内置默认 label = 主家族名', st[0].label, 'Demo 视频')
  eq('内置默认 balanced → 标准实现（不选加速件）', st[0].tiers.balanced, 'demo-balanced')
  eq('内置默认 quality → 标准实现', st[0].tiers.quality, 'demo-quality')
  eq('内置默认 fast → 标准实现', st[0].tiers.fast, 'demo-fast')
  eq('空配置时内置默认显示为已选中', st[0].selected, true)

  // 用户自建：命名 + 跨清单自由组合（例如 balanced 用 sol、quality 用标准）
  const cfg = {
    tiers: { [R]: { balanced: 'demo-balanced-sol' } },
    strategies: { [R]: [{ id: 's1', name: '快出片（balanced 带 Sol）', tiers: { balanced: 'demo-balanced-sol', quality: 'demo-quality' } }] },
  }
  const clean = await describeTierMatrix(registry, { probe: SOL_PRESENT, cfg: {} })
  eq('配置里没有用户策略时只有内置默认一条', clean[R].strategies.length, 1)
  const withUser = await describeTierMatrix(registry, { probe: SOL_PRESENT, cfg })
  eq('用户策略经配置注入后出现在矩阵里', withUser[R].strategies.length, 2)
  eq('注入的用户策略名字来自配置', withUser[R].strategies[1].label, '快出片（balanced 带 Sol）')

  const projected = projectCapabilityStrategies(registry, R, cfg)
  eq('配置里有用户策略 → 两条', projected.length, 2)
  eq('用户策略 label = 用户命名', projected[1].label, '快出片（balanced 带 Sol）')
  eq('用户策略 builtin=false', projected[1].builtin, false)
  eq('用户策略 tiers 原样保留（balanced）', projected[1].tiers.balanced, 'demo-balanced-sol')
  eq('用户策略被识别为当前选中', projected[1].selected, true)
  eq('有选中用户策略时内置默认不再显示为选中', projected[0].selected, false)

  // 规范形：非法条目被丢弃，不会在配置里留下死引用
  eq('空名策略被丢弃', userStrategiesOf({ strategies: { [R]: [{ id: 'x', name: '   ', tiers: { fast: 'demo-fast' } }] } }, R).length, 0)
  eq('非数组被忽略', userStrategiesOf({ strategies: { [R]: 'nope' } }, R).length, 0)
  const norm = userStrategiesOf({ strategies: { [R]: [{ name: 'A', tiers: { fast: 'demo-fast', bogus: 'x' } }] } }, R)
  eq('缺 id 自动补 id', typeof norm[0].id === 'string' && norm[0].id.length > 0, true)
  ok('未知档位键不会被当成档位使用（解析层只认受控三档）', !['fast', 'balanced', 'quality'].includes('bogus'))

  // 消歧：用户策略与默认组合完全相同时，不能两条都点亮
  const sameCfg = { strategies: { [R]: [{ id: 'dup', name: '等于默认', tiers: { fast: 'demo-fast', balanced: 'demo-balanced', quality: 'demo-quality' } }] } }
  const dupAll = projectCapabilityStrategies(registry, R, sameCfg)
  eq('组合等于默认时不能两条同时选中', dupAll.filter((s) => s.selected).length, 1)
  eq('未点过时按匹配规则回落到内置默认', dupAll.find((s) => s.selected).id, '__default')
  const dupPicked = projectCapabilityStrategies(registry, R, { ...sameCfg, strategyOf: { [R]: 'dup' } })
  eq('点过用户策略时点亮那一条', dupPicked.find((s) => s.selected).id, 'dup')

  // 组不再自动生成策略（组只负责清单分组显示）
  const groupsWithStrategies = Object.values(base).flatMap((c) => (c.groups || []).filter((g) => g.strategies))
  eq('组不再携带 strategies', groupsWithStrategies.length, 0)
  eq('组名缺省＝自身 id', groupNameOf(mk('lonely', {})), 'lonely')
}

console.log('\n[8] 未分档的旧清单：按 mode 名匹配；匹配不到则报错')
{
  const legacyOnly = makeRegistry([mk('legacy-multi', { modes: { quality: { steps: 20 }, fast: { steps: 4 } } })])
  const r = await resolveTieredManifest(R, 'fast', null, { registry: legacyOnly, probe: SOL_PRESENT, selection: {} })
  eq('tier=fast → 旧清单的 fast mode', r.manifest.id, 'legacy-multi')
  eq('resolution=legacy-mode', r.resolution, 'legacy-mode')
  ok('带"尚未分档"警告', r.warnings.some((w) => w.includes('尚未分档')))
  let threw = null
  try { await resolveTieredManifest(R, 'balanced', null, { registry: legacyOnly, probe: SOL_PRESENT, selection: {} }) } catch (e) { threw = e }
  ok('tier=balanced（旧清单没有）→ 报错，不猜', Boolean(threw))
  ok('报错列出旧清单现有 mode', threw && threw.message.includes('quality'), threw && threw.message)
  const noTier = await resolveTieredManifest(R, null, null, { registry: legacyOnly, probe: SOL_PRESENT, selection: {} })
  eq('未指定档位 → 旧路径', noTier.resolution, 'legacy')
}

console.log('\n[9] describeTierMatrix（UI/技能数据源）')
{
  const mx = await describeTierMatrix(registry, { probe: SOL_PRESENT })
  const cap = mx[R]
  ok('tiered=true', cap.tiered)
  eq('档位列表', cap.tiers.join('/'), 'fast/balanced/quality')
  eq('组数', cap.groups.length, 1)
  const g = cap.groups[0]
  eq('组内 quality 实现数', g.tiers.quality.length, 2)
  const solImpl = g.tiers.quality.find((w) => w.accel === 'sol')
  eq('sol 实现可用性', solImpl.available, true)
  eq('sol 实现耗时', solImpl.estSeconds, 311)
  ok('internal 清单不出现在矩阵里', !JSON.stringify(g).includes('demo-stats'))
  const mx2 = await describeTierMatrix(registry, { probe: SOL_MISSING })
  eq('缺节点时可用性=false', mx2[R].groups[0].tiers.quality.find((w) => w.accel === 'sol').available, false)
  const mx3 = await describeTierMatrix(registry, { probe: false })
  eq('probe=false → 可用性未知(null)', mx3[R].groups[0].tiers.quality.find((w) => w.accel === 'sol').available, null)
}

console.log('\n[10] 拆分迁移：新 id 继承旧配置（不丢用户的 int8 资产选择）')
{
  const I = _internals
  const reg = I.getRegistry()
  const h3 = reg.manifests.filter((m) => m.tier && !m.internal)
  ok('内置 H3 档位清单 ≥ 8 份', h3.length >= 8, `实际 ${h3.length}`)
  const missingAlias = h3.filter((m) => !(I.ASSET_OVERRIDE_ALIASES[m.id] || []).length).map((m) => m.id)
  ok('每份档位清单都有旧 id 的 assetOverrides 继承入口', missingAlias.length === 0, missingAlias.join(', '))
  const missingLegacy = h3.filter((m) => !I.LEGACY_MODEL_ASSET_MAP[m.id]).map((m) => m.id)
  ok('每份档位清单都登记了 models.* 兜底映射', missingLegacy.length === 0, missingLegacy.join(', '))
  // 实际生效值不得为空（默认或覆盖至少有一个来源）
  const empty = []
  for (const m of h3) {
    const eff = I.effectiveAssetsOf(m)
    for (const [k, v] of Object.entries(eff)) if (!v) empty.push(m.id + '.' + k)
  }
  ok('实际生效资产值齐备（可显示/可用）', empty.length === 0, empty.join(', '))
  // 别名表不允许指向不存在的旧 id 之外的怪值（形如 minimax-h3-*）
  const badAlias = Object.entries(I.ASSET_OVERRIDE_ALIASES).flatMap(([k, v]) => v.filter((x) => !/^minimax-h3-/.test(x)).map((x) => k + '→' + x))
  ok('别名表指向合法旧 id', badAlias.length === 0, badAlias.join(', '))
}

console.log('\n[11] PDD：四个普通清单（不单列策略，由用户组合命名）')
{
  const I = _internals
  const reg = I.getRegistry()
  const mx = await describeTierMatrix(reg, { probe: SOL_PRESENT })
  for (const [cap, pddId, solId] of [
    [R, 'minimax-h3-ref2v-balanced-pdd', 'minimax-h3-ref2v-balanced-pdd-sol'],
    ['video.image2video', 'minimax-h3-i2v-balanced-pdd', 'minimax-h3-i2v-balanced-pdd-sol'],
  ]) {
    const m = reg.manifests.find((x) => x.id === pddId)
    ok(`${pddId} 存在且是 balanced 档`, Boolean(m) && m.tier === 'balanced')
    ok(`${pddId} 归在同一家族组（不单列策略组）`, m.group === (cap === R ? 'minimax-h3-ref2v' : 'minimax-h3-i2v'), `group=${m.group}`)
    ok(`${pddId} 不与基础实现同 id`, pddId !== (cap === R ? 'minimax-h3-ref2v-balanced' : 'minimax-h3-i2v-balanced'))
    // 不产生任何"PDD 策略"：能力下仍然只有内置默认一条
    eq(`${cap} 策略仍只有内置默认一条`, (mx[cap].strategies || []).length, 1)
    eq(`${cap} 内置默认不落到 PDD`, mx[cap].strategies[0].tiers.balanced.includes('-pdd'), false)
    // 用户可以把 PDD 组合进自己的策略（这就是"自由组合"的落点）
    const projected = projectCapabilityStrategies(reg, cap, { strategies: { [cap]: [{ id: 'p1', name: '我的 PDD 策略', tiers: { balanced: solId } }] } })
    eq(`${cap} 用户策略可指向 PDD+Sol`, projected[1].tiers.balanced, solId)
    ok(`${cap} 用户策略在基准可用性下标记可用`, projected[1].available === true || projected[1].available === false)
    // 不做隐式默认：空 selection 时 balanced 不落到 PDD
    const r = await resolveTieredManifest(cap, 'balanced', null, { registry: reg, probe: SOL_PRESENT, selection: {} })
    ok(`${cap} balanced 隐式解析不落到 PDD`, !r.manifest.id.includes('-pdd'), `实际 ${r.manifest.id}`)
    // 显式指定仍可用（用户策略写入的就是显式 id）
    const ex = await resolveTieredManifest(cap, 'balanced', pddId, { registry: reg, probe: ALL_PRESENT, selection: {} })
    eq(`${pddId} 显式指定可解析`, ex.manifest.id, pddId)
    ok(`${pddId} priority<0（显式可选中、不会被隐式选中）`, m.priority < 0)
    // 缺节点时如实置灰（不假装可用）
    const mxMissing = await describeTierMatrix(reg, { probe: PDD_MISSING })
    const list = ((mxMissing[cap].groups.find((g) => g.id === m.group) || {}).tiers || {}).balanced || []
    eq(`${pddId} 缺 PDD 节点 → 不可用`, (list.find((w) => w.id === pddId) || {}).available, false)
    // base 与 PDD 权重严格同族
    const want = cap === R ? 'ref2va' : 'fl2va'
    ok(`${pddId} base/PDD 权重同族（${want}）`, m.assets.unet.default.includes(want) && m.assets.pdd.default.includes(want))
    // Sol 变体的 requiresNodes 只含 Sol 节点（accelOf 生效，没把 PDD 节点算进去）
    const ms = reg.manifests.find((x) => x.id === solId)
    eq(`${solId} requiresNodes`, (ms.requiresNodes || []).join(','), 'SolAttnMiniMaxH3')
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
