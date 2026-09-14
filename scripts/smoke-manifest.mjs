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
// P2 之后内置 H3 清单是「一档一文件」（组名-档位[-sol]）
const BUILTIN_IDS = [
  'flux-text2image', 'extract-frame',
  'minimax-h3-ref2v-fast', 'minimax-h3-ref2v-balanced', 'minimax-h3-ref2v-balanced-sol',
  'minimax-h3-ref2v-quality', 'minimax-h3-ref2v-quality-sol',
  'minimax-h3-i2v-fast', 'minimax-h3-i2v-quality', 'minimax-h3-i2v-quality-sol',
]
for (const id of BUILTIN_IDS) {
  ok(Boolean(report.byId[id]), `内置清单含 ${id}`)
}
// 档位契约：每份 H3 清单必须声明 tier/group，且 modes 只剩本档
for (const id of BUILTIN_IDS.filter((x) => x.startsWith('minimax-h3'))) {
  const m = report.byId[id]
  if (!m) continue
  ok(Boolean(m.tier && m.group), `${id} 声明 tier/group（tier=${m.tier} group=${m.group}）`)
  ok(Object.keys(m.modes || {}).join(',') === m.tier, `${id} 只有一个 mode 且名称＝档位`)
  if (id.endsWith('-sol')) ok(Array.isArray(m.requiresNodes) && m.requiresNodes.length > 0, `${id} 声明 requiresNodes（${(m.requiresNodes || []).join(',')}）`)
}

console.log('== 2) FLUX 文生图 vs buildFluxImageWorkflow ==')
{
  const m = report.byId['flux-text2image']
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
