// extract-frame 回归单测：验证 buildRenderGraph 的 manifest params 自动注入。
// 背景：HEAD 版 buildRenderGraph 未把 source_video/frame_index 放进 job，
// 导致 LoadVideo.file 保持 null → ComfyUI prompt_outputs_failed_validation。
// 运行：node scripts/extract-frame-check.mjs（无需 ComfyUI）
import { _internals } from '../lib/index.js'
const { getRegistry, resolveManifest, buildRenderGraph } = _internals

let pass = 0, fail = 0
const assert = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name) }
  else { fail++; console.log('  ✗', name, extra) }
}

const registry = getRegistry()
const manifest = resolveManifest(registry, 'image.from_video', 'extract-frame')
if (!manifest) { console.error('✗ extract-frame manifest 未找到'); process.exit(1) }

// 1) source_video + frame_index 注入
const { graph } = buildRenderGraph(manifest, { source_video: 'demo.mp4', frame_index: 62, prefix: 'p' }, null)
assert('LoadVideo.file 注入文件名', graph['1'].inputs.file === 'demo.mp4', JSON.stringify(graph['1']))
assert('ImageFromBatch.batch_index 注入', graph['3'].inputs.batch_index === 62, JSON.stringify(graph['3']))
assert('SaveImage.filename_prefix 注入', graph['4'].inputs.filename_prefix === 'p')

// 2) 缺省值：frame_index 用 manifest default -1
const { graph: g2 } = buildRenderGraph(manifest, { source_video: 'demo.mp4', prefix: 'p' }, null)
assert('缺省 frame_index 用 manifest default -1', g2['3'].inputs.batch_index === -1, JSON.stringify(g2['3']))

// 3) 无 source_video → 不注入（file 保持 manifest 原始值 null，属调用方责任）
const { graph: g3 } = buildRenderGraph(manifest, { frame_index: 0, prefix: 'p' }, null)
assert('无 source_video 时不注入 file', g3['1'].inputs.file === null)

console.log(`\n结果: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
