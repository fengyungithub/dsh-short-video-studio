// 由既有 base 模板生成 PDD 模板（图手术固定，避免两个能力各手改一遍发散）。
//
// PDD 与现有模板的**结构性差异只有 6 处**：
//   1) node 2 的 model 直连 UNETLoader（不再走 $model 哨兵）：PDD 自己打 trunk LoRA，
//      且必须**不叠**其它蒸馏 LoRA（lightx2v 不叠加）；
//   2) 新增 node 2a = MiniMaxH3PDDAccApply（吃 SigmaShift 输出，吐 MODEL + SIGMAS）；
//   3) node 7 BasicGuider 改用 2a 的 model（CFG 1.0，PDD 把 guidance 蒸馏进去了）；
//   4) 删除 node 9 BasicScheduler（sigmas 改由 Apply 节点给出 = 训练网格）；
//   5) node 10 SamplerCustomAdvanced.sigmas 接 2a 的第 1 个输出；
//   6) sampler 必须 euler（多段采样器会评估到网格外，节点会 fail-closed 拒绝）。
// 另外 shift 固定 12/3（节点校验严格相等），nfe 只允许 4 / 6 / 8。
//
// 用法：node scripts/make-pdd-template.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = resolve(ROOT, 'scripts/h3-templates')

const SPECS = [
  {
    base: 'minimax-h3-ref2v',
    out: 'minimax-h3-pdd-ref2v',
    capability: 'video.reference2video',
    group: 'minimax-h3-ref2v-pdd',
    displayName: 'MiniMax H3 参考生成视频 · PDD 蒸馏',
    unetHint: 'ref2va（必须与 Ref2VA 的 PDD 权重配对，节点有指纹守卫）',
    asset: {
      kind: 'other',
      default: 'minimax_h3_ref2va_pdd_acc_8step_comfyui.safetensors',
      env: 'DSH_SVS_H3_PDD_REF2V',
      label: 'MiniMax-H3 Ref2VA PDD Acc 8 步（放 models/pdd_acc/）',
    },
    dropAssets: ['fast_lora'],
  },
  {
    base: 'minimax-h3-i2v',
    out: 'minimax-h3-pdd-i2v',
    capability: 'video.image2video',
    group: 'minimax-h3-i2v-pdd',
    displayName: 'MiniMax H3 首末帧生成视频 · PDD 蒸馏',
    unetHint: 'fl2va（必须与 FL2VA 的 PDD 权重配对，节点有指纹守卫）',
    asset: {
      kind: 'other',
      default: 'minimax_h3_fl2va_pdd_acc_8step_comfyui.safetensors',
      env: 'DSH_SVS_H3_PDD_FL2VA',
      label: 'MiniMax-H3 FL2VA PDD Acc 8 步（放 models/pdd_acc/）',
    },
    dropAssets: ['fast_lora'],
  },
]

const NFE = '8'          // 训练块长 = 4，nfe 8 是官方默认；4 / 6 亦合法（见节点 COMBO）
const LONG_SIDE = 1344   // 与成片/平衡档同分辨率，实测 184.7s（ref2v）

let failed = 0
for (const spec of SPECS) {
  const src = JSON.parse(readFileSync(resolve(DIR, spec.base + '.json'), 'utf8'))
  const m = JSON.parse(JSON.stringify(src))
  const g = m.graph

  m.id = spec.out
  m.displayName = spec.displayName
  m.capability = spec.capability
  m.group = spec.group
  m.description =
    `PDD（Parallel Decoding Distillation）${NFE} 步：PDD 权重自带 trunk LoRA + head bank，` +
    `shift 必须 12/3、采样器必须 euler、sigmas 取自 Apply 节点的训练网格；base 用 ${spec.unetHint}。` +
    `**必须移除其它蒸馏 LoRA**（不叠加）。由 scripts/make-pdd-template.mjs 生成，请勿手改。`
  m.tier = 'balanced'
  m.modes = { balanced: { steps: Number(NFE), longSide: LONG_SIDE } }
  m.resolution = { policy: 'aspect-ratio', snap: 32, default: { balanced: [1344, 768] } }
  m.requiresNodes = ['MiniMaxH3PDDAccApply']
  m.priority = -30          // 不做隐式默认：PDD 依赖第三方节点，必须由用户显式选择
  m.note = `PDD ${NFE} 步 · shift 12/3 · euler · CFG 1.0`

  for (const k of spec.dropAssets) delete m.assets[k]
  m.assets.pdd = spec.asset

  // 1) 不再走 $model 哨兵；shift 固定 12/3
  g['2'].inputs.model = ['1', 0]
  g['2'].inputs.shift_video = 12
  g['2'].inputs.shift_audio = 3
  // 2) PDD Apply 节点
  g['2a'] = {
    class_type: 'MiniMaxH3PDDAccApply',
    inputs: {
      model: ['2', 0],
      pdd_file: '$assets.pdd',
      nfe: NFE,                    // COMBO 是字符串枚举（["8","4","6"]），节点内部 int()
      lora_strength: 1.0,
      head_strength: 1.0,
      on_off_grid: 'error',        // 踩到网格外就报错，不静默降级
      partition: '',               // 空 = 用 nfe 的默认分块
      enabled: true,
      partition_check: 'error',    // trunk 指纹守卫：跨变体错配直接报错
    },
  }
  // 3) guider 走 PDD 打过的 model
  g['7'].inputs.model = ['2a', 0]
  // 4) 去掉调度器
  delete g['9']
  // 5) sigmas 接 Apply 节点
  g['10'].inputs.sigmas = ['2a', 1]
  // 6) euler
  g['8'].inputs.sampler_name = 'euler'

  // params：去掉 steps（没有调度器可填），nfe 用独立字段名（值必须是字符串）
  const params = JSON.parse(JSON.stringify(m.params))
  delete params.steps
  params.nfe = { inject: 'scalar', to: { node: '2a', field: 'nfe' }, default: NFE }
  m.params = params

  // 自检：PDD 生效的必要条件全部成立
  const errs = []
  if (g['2'].inputs.model[0] !== '1') errs.push('node 2 未直连 UNETLoader')
  if (g['7'].inputs.model[0] !== '2a') errs.push('guider 未走 PDD model')
  if (g['10'].inputs.sigmas[0] !== '2a' || g['10'].inputs.sigmas[1] !== 1) errs.push('sigmas 未接 Apply 节点')
  if (g['8'].inputs.sampler_name !== 'euler') errs.push('sampler 不是 euler')
  if (g['2'].inputs.shift_video !== 12 || g['2'].inputs.shift_audio !== 3) errs.push('shift 不是 12/3')
  if (g['9']) errs.push('BasicScheduler 未删除')
  if (Object.values(g).some((n) => n.class_type === 'LoraLoaderModelOnly')) errs.push('图里仍挂着蒸馏 LoRA')
  if (Object.values(g).some((n) => n.class_type === 'BasicScheduler')) errs.push('图里仍有 BasicScheduler')
  if (errs.length) { console.error(`✗ ${spec.out}: ${errs.join('；')}`); failed++; continue }

  const text = JSON.stringify(m, null, 2) + '\n'
  const old = (() => { try { return readFileSync(resolve(DIR, spec.out + '.json'), 'utf8') } catch { return null } })()
  const changed = old !== text
  writeFileSync(resolve(DIR, spec.out + '.json'), text)
  console.log(`✓ ${spec.base} → ${spec.out}  (${Object.keys(g).length} 节点, nfe=${NFE}, shift 12/3, euler, longSide ${LONG_SIDE})${changed ? '' : ' [无变化]'}`)
}
process.exit(failed ? 1 : 0)
