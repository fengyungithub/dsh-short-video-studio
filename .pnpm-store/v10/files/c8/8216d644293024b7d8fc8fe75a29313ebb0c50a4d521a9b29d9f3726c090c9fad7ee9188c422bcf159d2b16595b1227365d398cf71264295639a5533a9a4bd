/**
 * scripts/smoke-manifest.mjs — M1 冒烟测试。
 *
 * 验证三件事：
 *  1) 内置清单可加载且通过校验；
 *  2) buildGraphFromManifest 编译出的图「无残留哨兵 / 连线完整 / 注入值落到正确字段」；
 *  3) 编译图与旧 builder（buildFluxImageWorkflow / buildH3VideoWorkflow /
 *     buildH3ImageToVideoWorkflow）的节点类别多重集等价（翻译保真）。
 *
 * 纯图编译，不触网、不调 ComfyUI。
 * 用法：node scripts/smoke-manifest.mjs
 */

// 测试隔离：不读本机 ~/.dsh 里的真实配置（里面可能有用户自建策略/档位选择，
// 会把「未指定档位」「档位列表」等断言前提改掉）。纯逻辑测试一律跑在空配置上。
process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || '/nonexistent/svs-smoke-config.json'

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadBuiltinManifests, buildGraphFromManifest, validateManifest } from '../lib/manifest.js'
import { _internals } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const workflowsDir = join(__dirname, '..', 'workflows')

let failures = 0
function ok(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg) }
  else { failures++; console.error('  ✗ ' + msg) }
}

function classTypes(graph) {
  return Object.values(graph).map((n) => n.class_type).sort()
}
function sameMultiset(a, b) {
  if (a.length !== b.length) return false
  const m = new Map()
  for (const x of a) m.set(x, (m.get(x) || 0) + 1)
  for (const x of b) { const c = m.get(x) || 0; if (c === 0) return false; m.set(x, c - 1) }
  return true
}

// 检查无残留哨兵 + 连线完整
function assertCleanGraph(graph, label) {
  const ids = new Set(Object.keys(graph))
  let sentinel = null
  const walk = (v) => {
    if (sentinel) return
    if (typeof v === 'string' && (v.includes('$assets.') || v === '$model')) sentinel = v
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  for (const node of Object.values(graph)) {
    for (const v of Object.values(node.inputs || {})) {
      walk(v)
      if (Array.isArray(v) && v.length >= 1 && typeof v[0] === 'string' && !ids.has(v[0])) {
        sentinel = `dangling wire ${JSON.stringify(v)}`
      }
    }
  }
  ok(!sentinel, `${label}: 无残留哨兵/悬空连线${sentinel ? '（发现: ' + sentinel + '）' : ''}`)
}

console.log('== 1) 加载 + 校验内置清单 ==')
const report = loadBuiltinManifests(workflowsDir)
ok(report.errors.length === 0, `无校验错误${report.errors.length ? '\n    ' + report.errors.join('\n    ') : ''}`)
// 图片与视频现在是**同一套档位契约**：一档一文件（<家族>-<档位>），group=家族
// （见 docs/unified-tier-tool-design.md §3）
const IMAGE_FAMILIES = ['flux-text2image', 'flux2-img2img', 'qwen-image-21-t2i', 'qwen-image-21-i2i']
const BUILTIN_IDS = [
  'extract-frame',
  ...IMAGE_FAMILIES.flatMap((f) => [`${f}-fast`, `${f}-balanced`, `${f}-quality`]),
  'minimax-h3-ref2v-fast', 'minimax-h3-ref2v-balanced', 'minimax-h3-ref2v-balanced-sol',
  'minimax-h3-ref2v-quality', 'minimax-h3-ref2v-quality-sol',
  'minimax-h3-i2v-fast', 'minimax-h3-i2v-quality', 'minimax-h3-i2v-quality-sol',
]
for (const id of BUILTIN_IDS) {
  ok(Boolean(report.byId[id]), `内置清单含 ${id}`)
}
// 档位契约：每份**分档**清单必须声明 tier/group，且 modes 只剩本档（图片与视频同一把尺子）
for (const id of BUILTIN_IDS.filter((x) => x.startsWith('minimax-h3') || IMAGE_FAMILIES.some((f) => x.startsWith(f)))) {
  const m = report.byId[id]
  if (!m) continue
  ok(Boolean(m.tier && m.group), `${id} 声明 tier/group（tier=${m.tier} group=${m.group}）`)
  ok(Object.keys(m.modes || {}).join(',') === m.tier, `${id} 只有一个 mode 且名称＝档位`)
  if (id.endsWith('-sol')) ok(Array.isArray(m.requiresNodes) && m.requiresNodes.length > 0, `${id} 声明 requiresNodes（${(m.requiresNodes || []).join(',')}）`)
}
// 图片清单的分辨率契约：t2i 声明 32 对齐的 longSide；i2i 声明参考图预算并带注入点
for (const f of ['flux-text2image', 'qwen-image-21-t2i']) {
  for (const tier of ['fast', 'balanced', 'quality']) {
    const m = report.byId[`${f}-${tier}`]
    if (!m) continue
    ok(m.resolution?.policy === 'aspect-ratio', `${f}-${tier} resolution.policy=aspect-ratio（跟随画布比例）`)
    ok(Number.isInteger(m.resolution?.longSide) && m.resolution.longSide % 32 === 0, `${f}-${tier} longSide=${m.resolution?.longSide}（32 对齐）`)
  }
}
for (const f of ['flux2-img2img', 'qwen-image-21-i2i']) {
  for (const tier of ['fast', 'balanced', 'quality']) {
    const m = report.byId[`${f}-${tier}`]
    if (!m) continue
    ok(Number.isInteger(m.modes?.[tier]?.referencePixels), `${f}-${tier} modes.${tier}.referencePixels=${m.modes?.[tier]?.referencePixels}`)
    ok(Object.values(m.params || {}).some((p) => p.default !== undefined && /megapixel|resolution$/.test(p.to?.field || '')),
      `${f}-${tier} 参考图预算有注入点（field 指向参考图尺寸/预算字段）`)
  }
}
// quality 档必须比 fast 档大（预算/长边单调递增）——防止生成器写反
for (const f of IMAGE_FAMILIES) {
  const fast = report.byId[`${f}-fast`]
  const quality = report.byId[`${f}-quality`]
  if (!fast || !quality) continue
  const sizeOf = (m) => m.resolution?.longSide ?? m.modes[m.tier].referencePixels
  ok(sizeOf(quality) > sizeOf(fast), `${f}: quality 档预算 > fast 档（${sizeOf(fast)} → ${sizeOf(quality)}）`)
}

console.log('== 2) FLUX 文生图 vs buildFluxImageWorkflow ==')
{
  const m = report.byId['flux-text2image-balanced']
  const job = { prompt: '一只狐狸', width: 1344, height: 768, seed: 7, steps: 20, guidance: 3.5, prefix: 'canvas/s/x' }
  const g = buildGraphFromManifest(m, job)
  assertCleanGraph(g, 'flux')
  ok(g['5'].inputs.text === job.prompt, 'prompt 注入到 CLIPTextEncode.text')
  ok(g['8'].inputs.noise_seed === job.seed, 'seed 注入到 RandomNoise')
  ok(g['5b'].inputs.guidance === job.guidance, 'guidance 注入到 FluxGuidance')
  ok(g['7'].inputs.steps === job.steps, 'steps 注入到 Flux2Scheduler')
  ok(g['4'].inputs.width === job.width && g['6'].inputs.width === job.width && g['7'].inputs.width === job.width, 'width 多目标注入（3 处）')
  ok(g['13'].inputs.filename_prefix === job.prefix, 'prefix 注入到 SaveImage')
  const ref = _internals.buildFluxImageWorkflow({ ...job, filenamePrefix: job.prefix })
  ok(sameMultiset(classTypes(g), classTypes(ref)), `节点类别多重集与旧 builder 一致（${classTypes(g).length} 节点）`)
}

console.log('== 2b) Qwen-Image 2.1 文生图 / 图生图（官方模板图结构）==')
{
  // 文生图：官方模板 image_qwen_image_2_1_t2i 的形状（Latent 由 EmptyLatentImage 给，尺寸可注入）
  const m = report.byId['qwen-image-21-t2i-quality']
  ok(m.capability === 'image.text2image', 't2i 能力=image.text2image')
  ok(Array.isArray(m.requiresNodes) && m.requiresNodes.includes('TextEncodeQwenImage21'), 't2i 声明 requiresNodes=TextEncodeQwenImage21')
  const g = buildGraphFromManifest(m, { prompt: '一只狐狸', width: 1344, height: 768, seed: 11, steps: 40, prefix: 'canvas/s/q' })
  assertCleanGraph(g, 'qwen t2i')
  ok(g['4'].class_type === 'TextEncodeQwenImage21' && g['4'].inputs.prompt === '一只狐狸', 'prompt 注入 TextEncodeQwenImage21')
  ok(g['2'].inputs.type === 'qwen_image', 'CLIPLoader type=qwen_image')
  ok(g['5'].inputs.width === 1344 && g['5'].inputs.height === 768, 'width/height 注入 EmptyLatentImage（任意画幅）')
  ok(g['6'].inputs.steps === 40 && g['6'].inputs.seed === 11, 'steps/seed 注入 KSampler')
  ok(g['6'].inputs.model[0] === '1' && g['1'].class_type === 'UNETLoader', '$model 哨兵解析到 UNETLoader')
  ok(g['6'].inputs.cfg === 1 && g['6'].inputs.sampler_name === 'euler', 'cfg=1 + euler（官方路径，shift 由模型内部固定）')
  ok(g['6'].inputs.latent_image[0] === '5' && g['7'].inputs.samples[0] === '6', '采样/解码连线完整')
  ok(!Object.keys(g['4'].inputs).some((k) => k.startsWith('images.')), 't2i 不挂参考图槽位（Latent 由 EmptyLatentImage 给）')

  // 图生图：官方模板 image_qwen_image_2_1_image_edit 的形状（Latent 由 text encode 节点给 = 跟随 image_1 尺寸）
  const m2 = report.byId['qwen-image-21-i2i-quality']
  ok(m2.capability === 'image.image2image', 'i2i 能力=image.image2image')
  ok((m2.requiresNodes || []).includes('QwenImage21Cache'), 'i2i 声明 requiresNodes 含 QwenImage21Cache')
  const g2 = buildGraphFromManifest(m2, { prompt: '换衣服', seed: 5, prefix: 'canvas/s/q', refs: ['a.png', 'b.png', 'c.png'] })
  assertCleanGraph(g2, 'qwen i2i')
  for (const [i, name] of ['a.png', 'b.png', 'c.png'].entries()) {
    const wire = g2['5'].inputs[`images.image_${i + 1}`]
    ok(Array.isArray(wire) && g2[wire[0]] && g2[wire[0]].class_type === 'LoadImage' && g2[wire[0]].inputs.image === name,
      `refs[${i}] 落到 images.image_${i + 1}（内嵌算术 ${'${i+1}'}，节点槽位 1 起）`)
  }
  ok(g2['5'].inputs['images.image_0'] === undefined, '不产生越界的 images.image_0（节点槽位从 1 开始）')
  ok(g2['5'].inputs.vae[0] === '3', 'TextEncodeQwenImage21 接 VAE（参考图要进 reference_latents）')
  ok(g2['6'].inputs.latent_image[0] === '5' && g2['6'].inputs.latent_image[1] === 2, 'KSampler.latent 取该节点的 latent 输出（输出尺寸跟随 image_1）')
  ok(g2['6'].inputs.model[0] === '4' && g2['4'].class_type === 'QwenImage21Cache', 'model 经 QwenImage21Cache 进采样器')
  ok(g2['4'].inputs.model[0] === '1' && g2['4'].inputs.dtype === 'int8', 'cache 吃 $model 哨兵，dtype=int8')
  // 档位级参考图预算：quality 档把 2048 注进 TextEncodeQwenImage21.resolution（⇒ i2i 首次具备 2K）
  ok(g2['5'].inputs.resolution === 2048, `quality 档参考图预算注入 resolution=${g2['5'].inputs.resolution}（2K 改绘）`)
  const gFast = buildGraphFromManifest(report.byId['qwen-image-21-i2i-fast'], { prompt: 'x', seed: 1, prefix: 'p', refs: ['a.png'] })
  ok(gFast['5'].inputs.resolution === 768, `fast 档参考图预算注入 resolution=${gFast['5'].inputs.resolution}`)
  const g3 = buildGraphFromManifest(m2, { prompt: 'x', seed: 1, prefix: 'p' })
  ok(!Object.keys(g3['5'].inputs).some((k) => k.startsWith('images.')), '无 refs 时不留 null 槽位（ComfyUI 会拒 null 输入）')
  // i2i 的档位不注入 width/height（尺寸跟随参考图）——调用方传了也不该出现在图里
  const gW = buildGraphFromManifest(m2, { prompt: 'x', width: 2048, height: 2048, seed: 1, prefix: 'p', refs: ['a.png'] })
  ok(!Object.values(gW).some((n) => n.inputs && n.inputs.width === 2048), 'i2i 不把 width/height 注入图（尺寸跟随参考图）')
}

console.log('== 3) H3 参考绑定视频 vs buildH3VideoWorkflow ==')
for (const mode of ['quality', 'fast']) {
  const m = report.byId[mode === 'fast' ? 'minimax-h3-ref2v-fast' : 'minimax-h3-ref2v-quality']
  const job = { prompt: '狐狸说话', width: mode === 'fast' ? 832 : 1344, height: mode === 'fast' ? 480 : 768, length: 124, seed: 3, steps: mode === 'fast' ? 4 : 20, fps: 24, refs: ['a.png', 'b.png'], prefix: 'canvas/s/s01', mode }
  const g = buildGraphFromManifest(m, job)
  assertCleanGraph(g, `ref2v-${mode}`)
  ok(g['5'].inputs.prompt === job.prompt, `[${mode}] prompt 注入`)
  ok(g['5'].inputs.width === job.width && g['5'].inputs.height === job.height, `[${mode}] width/height 注入`)
  ok(Array.isArray(g['5'].inputs['ref_images.ref_image_0']) && Array.isArray(g['5'].inputs['ref_images.ref_image_1']), `[${mode}] refs 展开为两条连线`)
  ok(g['9'].inputs.steps === job.steps, `[${mode}] steps 注入（${job.steps}）`)
  ok(g['12'].inputs.fps === 24, `[${mode}] fps 注入`)
  const ref = _internals.buildH3VideoWorkflow({ ...job, filenamePrefix: job.prefix, refComfyNames: job.refs })
  ok(sameMultiset(classTypes(g), classTypes(ref)), `[${mode}] 节点类别多重集与旧 builder 一致（${classTypes(g).length} 节点）`)
}

console.log('== 4) H3 首/末帧串联 vs buildH3ImageToVideoWorkflow ==')
for (const mode of ['quality', 'fast']) {
  const m = report.byId[mode === 'fast' ? 'minimax-h3-i2v-fast' : 'minimax-h3-i2v-quality']
  const job = { prompt: '续接镜头', width: mode === 'fast' ? 832 : 1344, height: mode === 'fast' ? 480 : 768, length: 124, seed: 5, steps: mode === 'fast' ? 4 : 20, fps: 24, first_frame: 'f.png', last_frame: 'l.png', prefix: 'canvas/s/s02', mode }
  const g = buildGraphFromManifest(m, job)
  assertCleanGraph(g, `i2v-${mode}`)
  ok(Array.isArray(g['5'].inputs.first_frame), `[${mode}] first_frame 注入为连线`)
  ok(Array.isArray(g['5'].inputs.last_frame), `[${mode}] last_frame 注入为连线`)
  // first_frame 链：LoadImage → ImageScale(宽高=${width}/${height}) → 5.first_frame
  const ffId = g['5'].inputs.first_frame[0]
  ok(g[ffId] && g[ffId].class_type === 'ImageScale', `[${mode}] first_frame 末端是 ImageScale`)
  ok(g[ffId].inputs.width === job.width && g[ffId].inputs.height === job.height, `[${mode}] ImageScale 宽高来自 ${job.width}/${job.height} 模板`)
  const ref = _internals.buildH3ImageToVideoWorkflow({ ...job, filenamePrefix: job.prefix, firstFrameComfyName: job.first_frame, lastFrameComfyName: job.last_frame })
  ok(sameMultiset(classTypes(g), classTypes(ref)), `[${mode}] 节点类别多重集与旧 builder 一致（${classTypes(g).length} 节点）`)
}

console.log('== 5) 校验器拒绝坏清单 ==')
{
  const bad = validateManifest({ id: 'x', capability: 'video.reference2video', graph: { "1": { class_type: "Foo", inputs: { a: "$assets.missing" } } }, params: {} }, 'bad')
  ok(!bad.ok, '拒绝引用未声明资产的清单')
  const bad2 = validateManifest({ id: 'x', capability: 'not.a.capability', graph: {}, params: {} }, 'bad2')
  ok(!bad2.ok, '拒绝未知 capability')
}

console.log('')
if (failures) {
  console.error(`✗ 失败 ${failures} 项`)
  process.exit(1)
} else {
  console.log(`✓ 全部通过：${report.manifests.length} 份清单校验通过，编译图与旧 builder 等价`)
}
