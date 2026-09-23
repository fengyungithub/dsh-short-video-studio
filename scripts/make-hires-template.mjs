/**
 * scripts/make-hires-template.mjs — 由既有 base 模板生成「两阶段潜空间放大」模板。
 *
 * 为什么用生成器而不是手抄：i2v 与 ref2v 的两阶段尾段必须**逐字节一致**，
 * 否则两个能力会各自漂移（PDD 模板当初也是这么处理的，见 make-pdd-template.mjs）。
 *
 * 两阶段的结构性差异只有 5 处（其余照抄 base）：
 *   1) 分辨率锁定：resolutionLock 把首遍钉在 896×512（= 模型原生 1344×768 的 1/1.5），
 *      显式 width/height 与画布比例都不得覆盖；
 *   2) 新增 node 14 = MiniMaxH3AVLatentUpscaleBy（scale_by 1.5，bislerp）——只放大视频那一半，
 *      音频 latent 原样穿过（这是该节点的语义，也是音轨/口型不被破坏的原因）；
 *   3) 新增 node 6b/9b/10b = 二遍采样：新噪声 + BasicScheduler(denoise 0.35) + 同一个 guider；
 *      二遍在放大后的 latent 上以低噪声重建细节，而不是重画表演；
 *   4) 解码改读二遍（11b/11c），node 12 CreateVideo 从 11→11b、11a→11c；
 *   5) 只提供 quality 档：两阶段本身很贵，做 fast 档没有意义（fast 的存在价值是便宜地验构图）。
 *
 * 用法：node scripts/make-hires-template.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = resolve(ROOT, 'scripts/h3-templates')

// 首遍 = 模型原生 1344×768 ÷ 1.5 = 896×512；放大 1.5× 正好回到模型原生分辨率。
// 这样二遍是在模型最擅长重建的尺寸上细化，而不是在它没见过的尺寸上重画。
const GRAPH = [896, 512]
const SCALE = 1.5
const PASS2_DENOISE = 0.35   // 起手值，非调优值：过高会改人物/姿态，过低则几乎无增益
const PASS2_STEPS = 6

const SPECS = [
  {
    base: 'minimax-h3-ref2v.json',
    out: 'minimax-h3-ref2v-hires',
    capability: 'video.reference2video',
    conditionNode: 'MiniMaxH3ReferenceToVideo',
    keepRefParams: true,
  },
  {
    base: 'minimax-h3-i2v.json',
    out: 'minimax-h3-i2v-hires',
    capability: 'video.image2video',
    conditionNode: 'MiniMaxH3ImageToVideo',
    keepRefParams: false,
  },
]

const NOTE =
  '首遍 ' + GRAPH.join('×') + ' 是模型原生 1344×768 的 1/1.5，放大 1.5× 正好落在原生分辨率上——' +
  '二遍在模型最擅长重建的尺寸上细化，而不是在它没见过的尺寸上重画'

const DESCRIPTION =
  'MiniMax H3 两阶段潜空间放大：首遍在模型原生 768p 上解运动/构图/声音，再把视频 latent 放大 1.5×，' +
  '二遍以低噪声（denoise ' + PASS2_DENOISE + '）在同一模型上重建细节。开源版 H3 原生上限即 768p（1344×768），' +
  '超过该尺寸直接采样会出复制/克隆伪影，所以「提分辨率」只能靠二遍。音频 latent 全程不被放大、二遍噪声为 0，' +
  '音轨与口型沿用首遍。注意：图分辨率被 resolutionLock 锁死，显式 width/height 与画布比例均不生效。'

let failed = 0
for (const spec of SPECS) {
  const src = JSON.parse(readFileSync(resolve(DIR, spec.base), 'utf8'))
  const m = JSON.parse(JSON.stringify(src))
  const g = m.graph

  // 守住前提：base 的第 5 节点必须是我们预期的条件节点，否则说明 base 换过了，不能盲改
  if (g['5']?.class_type !== spec.conditionNode) {
    console.error(`✗ ${spec.base} 的 node 5 是 ${g['5']?.class_type}，期望 ${spec.conditionNode}——base 已变更，请先核对`)
    failed++
    continue
  }

  m.id = spec.out
  m.capability = spec.capability
  m.description = DESCRIPTION
  // 只留 quality：两阶段很贵，fast 档（便宜验构图）交给普通清单，不要在这里伪装便宜
  m.modes = { quality: (src.modes && src.modes.quality) || { steps: 20, longSide: 1344, loras: [] } }
  m.resolution = { policy: 'aspect-ratio', snap: 32, default: { quality: GRAPH } }
  m.resolutionLock = { graph: GRAPH, scale: SCALE, note: NOTE }
  m.requiresNodes = ['MiniMaxH3AVLatentUpscaleBy']
  // 16:9 only：放大倍率写死在图里，换比例会让「原生分辨率」这个前提失效
  m.constraints = { ...(src.constraints || {}), aspectRatios: ['16:9'] }

  // 1) 视频 latent 放大 1.5×（音频那一半不动）
  g['14'] = {
    class_type: 'MiniMaxH3AVLatentUpscaleBy',
    inputs: { samples: ['10', 0], upscale_method: 'bislerp', scale_by: SCALE },
  }
  // 2) 二遍：新噪声 + 低噪声调度 + 同一个 guider（同 prompt/参考，只是从放大后的 latent 起步）
  g['6b'] = { class_type: 'RandomNoise', inputs: { noise_seed: null } }
  g['9b'] = {
    class_type: 'BasicScheduler',
    inputs: { model: ['2', 0], scheduler: 'simple', steps: null, denoise: PASS2_DENOISE },
  }
  g['10b'] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: { noise: ['6b', 0], guider: ['7', 0], sampler: ['8', 0], sigmas: ['9b', 0], latent_image: ['14', 0] },
  }
  // 3) 解码改读二遍
  g['11b'] = { class_type: 'VAEDecode', inputs: { samples: ['10b', 0], vae: ['4', 0] } }
  g['11c'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['10b', 0], vae: ['4a', 0] } }
  g['12'].inputs.images = ['11b', 0]
  g['12'].inputs.audio = ['11c', 0]

  // 4) steps 注入点指向首遍调度器；二遍步数是结构参数（写死在图里）
  m.params.steps.to = { node: '9', field: 'steps' }
  m.params['steps2'] = { inject: 'scalar', to: { node: '9b', field: 'steps' }, default: PASS2_STEPS }
  // 二遍必须有自己的噪声：同 seed 会把二遍退化成「重放首遍的高噪声步」，二遍就白跑了。
  // 用算术模板从首遍 seed 派生（+1e6）：不需要 params 条目——模板里直接引用 job.seed，
  // 保证可复现且与首遍不同。
  g['6b'].inputs.noise_seed = '${seed + 1000000}'

  writeFileSync(resolve(DIR, spec.out + '.json'), JSON.stringify(m, null, 2) + '\n', 'utf8')
  console.log(`✓ ${spec.out}.json（首遍 ${GRAPH.join('×')} → 交付 ${GRAPH[0] * SCALE}×${GRAPH[1] * SCALE}，二遍 denoise ${PASS2_DENOISE} / ${PASS2_STEPS} 步）`)
}

if (failed) process.exit(1)
console.log('\n注意：模板是产物，改结构请改本脚本后重跑；生成 workflows/ 清单请再跑 make-h3-variants.mjs。')
