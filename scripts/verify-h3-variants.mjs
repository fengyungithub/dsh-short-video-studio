/**
 * scripts/verify-h3-variants.mjs — P2 验证：生成的单档清单必须与「已实测的模板图」逐字段等价。
 *
 * 拆分只允许改这些：id / version / description / group / tier / accel / displayName /
 * estSeconds / note / priority / requiresNodes / modes（只剩本档）。
 * graph / assets / params / output / resolution / constraints / modelNode 必须与模板一致——
 * 否则就是"拆分引入了新变量"，benchmark 数据不再适用。
 *
 * 另验证：档位参数（步数/长边/LoRA）、Sol 节点接线（7/9 → 2a）、解析链（tier → 实现 → 尺寸）。
 *
 * 用法：node scripts/verify-h3-variants.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { _internals } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const TPL = join(__dirname, 'h3-templates')
const WF = join(ROOT, 'workflows')

const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
const { resolveTieredManifest, computeManifestSize, buildRenderGraph, getRegistry } = _internals

/** out → { template, mode }（与 make-h3-variants.mjs 的变体表一致） */
const MAP = {
  'minimax-h3-ref2v-fast': ['minimax-h3-ref2v.json', 'fast'],
  'minimax-h3-ref2v-balanced': ['minimax-h3-ref2v-8step.json', 'balanced'],
  'minimax-h3-ref2v-balanced-sol': ['minimax-h3-ref2v-8step-sol.json', 'balanced'],
  'minimax-h3-ref2v-quality': ['minimax-h3-ref2v.json', 'quality'],
  'minimax-h3-ref2v-quality-sol': ['minimax-h3-ref2v-sol.json', 'quality'],
  'minimax-h3-i2v-fast': ['minimax-h3-i2v.json', 'fast'],
  'minimax-h3-i2v-quality': ['minimax-h3-i2v.json', 'quality'],
  'minimax-h3-i2v-quality-sol': ['minimax-h3-i2v-sol.json', 'quality'],
  // PDD：模板由 scripts/make-pdd-template.mjs 从同族 base 生成
  'minimax-h3-ref2v-balanced-pdd': ['minimax-h3-pdd-ref2v.json', 'balanced'],
  'minimax-h3-i2v-balanced-pdd': ['minimax-h3-pdd-i2v.json', 'balanced'],
}
const ALLOW_DIFF = new Set(['id', 'version', 'description', 'group', 'tier', 'accel', 'displayName', 'estSeconds', 'note', 'priority', 'requiresNodes', 'modes'])

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('\n[1] 生成物 vs 模板：仅允许白名单字段不同')
for (const [id, [tpl, mode]] of Object.entries(MAP)) {
  const gen = read(join(WF, id + '.json'))
  const src = read(join(TPL, tpl))
  const keys = new Set([...Object.keys(gen), ...Object.keys(src)])
  const unexpected = [...keys].filter((k) => !ALLOW_DIFF.has(k) && !deepEq(gen[k], src[k]))
  ok(`${id} 非白名单字段与模板一致`, unexpected.length === 0, `差异字段：${unexpected.join(', ')}`)
  ok(`${id} 只剩本档 mode`, deepEq(Object.keys(gen.modes || {}), [gen.tier]), JSON.stringify(Object.keys(gen.modes || {})))
  ok(`${id} mode 参数与模板对应档一致`, deepEq(gen.modes[gen.tier], (src.modes || {})[mode]), `期望 ${JSON.stringify((src.modes || {})[mode])}`)
  ok(`${id} capability 与模板一致`, gen.capability === src.capability)
}

console.log('\n[2] 档位参数：步数 / 长边 / LoRA 配对')
{
  const expect = {
    'minimax-h3-ref2v-fast': { steps: 4, longSide: 832, lora: 'fast_lora', sampler: 'res_multistep', shift: 12 },
    'minimax-h3-ref2v-balanced': { steps: 8, longSide: 1344, lora: 'lora_8step', sampler: 'euler', shift: 6 },
    'minimax-h3-ref2v-balanced-sol': { steps: 8, longSide: 1344, lora: 'lora_8step', sampler: 'euler', shift: 6, sol: true },
    'minimax-h3-ref2v-quality': { steps: 20, longSide: 1344, lora: null, sampler: 'res_multistep', shift: 12 },
    'minimax-h3-ref2v-quality-sol': { steps: 20, longSide: 1344, lora: null, sampler: 'res_multistep', shift: 12, sol: true },
    'minimax-h3-i2v-fast': { steps: 4, longSide: 832, lora: 'fast_lora', sampler: 'res_multistep', shift: 12 },
    'minimax-h3-i2v-quality': { steps: 20, longSide: 1344, lora: null, sampler: 'res_multistep', shift: 12 },
    'minimax-h3-i2v-quality-sol': { steps: 20, longSide: 1344, lora: null, sampler: 'res_multistep', shift: 12, sol: true },
    // PDD：无蒸馏 LoRA（PDD 自带 trunk + head bank）、shift 必须 12/3、采样器必须 euler
    'minimax-h3-ref2v-balanced-pdd': { steps: 8, longSide: 1344, lora: null, sampler: 'euler', shift: 12, pdd: true },
    'minimax-h3-i2v-balanced-pdd': { steps: 8, longSide: 1344, lora: null, sampler: 'euler', shift: 12, pdd: true },
  }
  for (const [id, e] of Object.entries(expect)) {
    const m = read(join(WF, id + '.json'))
    const mc = m.modes[m.tier]
    const loras = (mc.loras || []).map((l) => l.asset)
    ok(`${id} 步数=${e.steps}`, mc.steps === e.steps, `实际 ${mc.steps}`)
    ok(`${id} 长边=${e.longSide}`, mc.longSide === e.longSide, `实际 ${mc.longSide}`)
    ok(`${id} LoRA=${e.lora || '无'}`, e.lora ? deepEq(loras, [e.lora]) : loras.length === 0, `实际 ${loras.join('+') || '无'}`)
    ok(`${id} 采样器=${e.sampler}`, m.graph['8'].inputs.sampler_name === e.sampler)
    ok(`${id} shift=${e.shift}/3`, m.graph['2'].inputs.shift_video === e.shift)
    const hasClass = (c) => Object.values(m.graph).some((n) => n.class_type === c)
    ok(`${id} Sol 节点${e.sol ? '存在' : '不存在'}`, hasClass('SolAttnMiniMaxH3') === Boolean(e.sol))
    ok(`${id} PDD 节点${e.pdd ? '存在' : '不存在'}`, hasClass('MiniMaxH3PDDAccApply') === Boolean(e.pdd))
    if (e.sol) {
      ok(`${id} Sol 关键参数（dense_first_percent=0 / tau 生效）`,
        m.graph['2a'].inputs.dense_first_percent === 0 && m.graph['2a'].inputs.tau > 0,
        JSON.stringify({ tau: m.graph['2a'].inputs.tau, dense: m.graph['2a'].inputs.dense_first_percent }))
      ok(`${id} Sol 接线：BasicGuider/BasicScheduler → 2a`,
        m.graph['7'].inputs.model[0] === '2a' && m.graph['9'].inputs.model[0] === '2a')
      ok(`${id} requiresNodes=SolAttnMiniMaxH3`, deepEq(m.requiresNodes, ['SolAttnMiniMaxH3']))
    }
    if (e.pdd) {
      // PDD 的不变量：任何一条被破掉都会退化成"普通 8 步无 LoRA"（画质掉档却查不出原因）
      const apply = Object.entries(m.graph).find(([, n]) => n.class_type === 'MiniMaxH3PDDAccApply')
      const [applyId, applyNode] = apply || ['?', { inputs: {} }]
      ok(`${id} nfe 与档位步数一致（防两处漂移）`, applyNode.inputs.nfe === String(mc.steps),
        `nfe=${applyNode.inputs.nfe} steps=${mc.steps}`)
      ok(`${id} on_off_grid/partition_check 都是 fail-closed`,
        applyNode.inputs.on_off_grid === 'error' && applyNode.inputs.partition_check === 'error')
      ok(`${id} 已删除 BasicScheduler（sigmas 必须来自 PDD 训练网格）`,
        !hasClass('BasicScheduler'))
      ok(`${id} sigmas 取自 Apply 节点`, m.graph['10'].inputs.sigmas?.[0] === applyId && m.graph['10'].inputs.sigmas?.[1] === 1)
      ok(`${id} guider 走 PDD 打过的 model`, m.graph['7'].inputs.model?.[0] === applyId)
      ok(`${id} 图里没有任何蒸馏 LoRA（PDD 不叠加）`, !hasClass('LoraLoaderModelOnly'))
      ok(`${id} requiresNodes=MiniMaxH3PDDAccApply`, deepEq(m.requiresNodes, ['MiniMaxH3PDDAccApply']))
      ok(`${id} base 与 PDD 权重同族（ref2va↔ref2va / fl2va↔fl2va）`,
        String(m.assets.unet?.default || '').includes(id.includes('-i2v') ? 'fl2va' : 'ref2va') &&
        String(m.assets.pdd?.default || '').includes(id.includes('-i2v') ? 'fl2va' : 'ref2va'))
    }
  }
}

console.log('\n[3] 解析链：tier → 实现 → 尺寸（含 9:16）')
{
  const reg = getRegistry()
  const cases = [
    ['video.reference2video', 'fast', 'minimax-h3-ref2v-fast', [832, 480]],
    ['video.reference2video', 'balanced', 'minimax-h3-ref2v-balanced', [1344, 768]],
    ['video.reference2video', 'quality', 'minimax-h3-ref2v-quality', [1344, 768]],
    ['video.image2video', 'fast', 'minimax-h3-i2v-fast', [832, 480]],
    ['video.image2video', 'quality', 'minimax-h3-i2v-quality', [1344, 768]],
  ]
  for (const [cap, tier, wantId, wh] of cases) {
    // selection 注入空：断言「默认解析到的实现」，不继承本机配置里已保存的策略
    const r = await resolveTieredManifest(cap, tier, null, { registry: reg, probe: false, selection: {} })
    ok(`${cap} ${tier} → ${wantId}`, r.manifest.id === wantId, `实际 ${r.manifest.id}`)
    const mode = r.tier
    const size = computeManifestSize(r.manifest, mode, undefined, undefined, '16:9')
    ok(`${cap} ${tier} 16:9 尺寸 ${wh.join('×')}`, size.w === wh[0] && size.h === wh[1], `实际 ${size.w}×${size.h}`)
    const v = computeManifestSize(r.manifest, mode, undefined, undefined, '9:16')
    ok(`${cap} ${tier} 9:16 尺寸 ${wh[1]}×${wh[0]}`, v.w === wh[1] && v.h === wh[0], `实际 ${v.w}×${v.h}`)
  }
  // 编译一次，确认图能落地（无残留哨兵/连线完整由 buildGraphFromManifest 自身保证）
  const r = await resolveTieredManifest('video.reference2video', 'quality', null, { registry: reg, probe: false, selection: {} })
  const { graph } = buildRenderGraph(r.manifest, { prompt: 'verify', width: 1344, height: 768, length: 124, seed: 7, refs: [], prefix: 'verify/x', first_frame: null, last_frame: null }, '16:9')
  ok('quality 清单可编译（含音频/视频 VAE 解码）',
    Boolean(graph['11'] && graph['11a'] && graph['5'].inputs.width === 1344 && graph['9'].inputs.steps === 20))
}

console.log('\n[4] 诊断清单不进产品面')
{
  const reg = getRegistry()
  const stats = read(join(WF, 'minimax-h3-ref2v-sol-stats.json'))
  ok('stats 清单 internal=true', stats.internal === true)
  const mx = await _internals.describeTierMatrix(reg, { probe: false })
  ok('stats 不出现在档位矩阵里', !JSON.stringify(mx).includes('sol-stats'))
  const all = Object.values(reg.byCapability).flat().filter((m) => !m.internal)
  ok('stats 不参与任何隐式解析候选', !all.some((m) => m.id === 'minimax-h3-ref2v-sol-stats'))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
