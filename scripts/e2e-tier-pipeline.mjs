#!/usr/bin/env node
/**
 * scripts/e2e-tier-pipeline.mjs — 统一档位体系的**真机端到端**验证（图片 + 视频）。
 *
 * 验证目标（docs/unified-tier-tool-design.md 的 P1–P4 验收）：
 *   ① 实现由**配置**解析（preferred 家族序 / tiers / pins），调用方只传 capability + tier；
 *   ② 分辨率 = 画布 aspectRatio × 该档长边（图片与视频同一套）；
 *   ③ i2i 的参考图预算按档注入（quality 档可出 2K 改绘）；
 *   ④ 画布节点记的宽高 == 产物**真实像素**（交付尺寸如实记账）；
 *   ⑤ 无注入点的参数（i2i 传 width）→ 明确 warning，不静默丢弃。
 *
 * 用法：node scripts/e2e-tier-pipeline.mjs [--skip-video]
 * 产物落在 e2e-out/tier-e2e/（画布 JSON + 图片/视频文件）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { _internals } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const workspace = join(__dirname, '..', 'e2e-out', 'tier-e2e')
const sessionId = 'e2e-tier'
const projectPath = join(workspace, 'canvas', sessionId, 'project.json')
const SKIP_VIDEO = process.argv.includes('--skip-video')

let failures = 0
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) failures++ }

mkdirSync(dirname(projectPath), { recursive: true })
if (!existsSync(projectPath)) {
  writeFileSync(projectPath, JSON.stringify({
    schemaVersion: 1, sessionId,
    // 9:16 画布：用来验证「画布比例真正驱动图片尺寸」（旧行为：图片是 explicit，比例不生效）
    settings: { aspectRatio: '9:16', duration: '', audioMode: 'silent', mode: 'quality' },
    nodes: [],
  }, null, 2), 'utf8')
}
const ctx = { workspaceRegistry: { get: (id) => (id === 'tier-e2e' ? { id, path: workspace } : undefined), list: () => [{ id: 'tier-e2e', path: workspace, sessionIds: [sessionId] }] } }
const common = { workspaceId: 'tier-e2e', sessionId }
const readNodes = () => JSON.parse(readFileSync(projectPath, 'utf8')).nodes
const absOf = (media) => join(workspace, ...String(media).split('/'))

console.log('== ① t2i（tier=fast，9:16 画布，不给宽高 → 应推导 576×1024）==')
const t0 = Date.now()
const img = await _internals.runRender(ctx, {
  ...common, capability: 'image.text2image', tier: 'fast',
  prompt: '一只橙色小狐狸站在雪地里，围着红色围巾，浅景深，画面中不出现任何文字',
  title: 'e2e · t2i fast（9:16）', group: 'e2e',
})
const imgNode = img.node
const imgSize = _internals.probeImageSize(absOf(imgNode.media))
console.log(`  · 解析=${img.resolution} tier=${imgNode.params.tier} 实现=${imgNode.params.workflow} ${Math.round((Date.now() - t0) / 1000)}s`)
ok(imgNode.params.workflow.startsWith('qwen-image-21-t2i-'), `实现由配置的 preferred 家族解析到 qwen（${imgNode.params.workflow}）`)
ok(imgNode.params.tier === 'fast', 'tier 记在节点上')
ok(imgNode.params.width === 576 && imgNode.params.height === 1024, `9:16 × fast 长边 1024 → 节点记 ${imgNode.params.width}×${imgNode.params.height}`)
ok(imgSize && imgNode.params.width === imgSize.w && imgNode.params.height === imgSize.h, `节点宽高 == 产物真实像素（${imgSize?.w}×${imgSize?.h}）`)

console.log('== ② i2i（tier=quality → 参考图预算 2048；刻意传 width 验证告警）==')
const t1 = Date.now()
const i2i = await _internals.runRender(ctx, {
  ...common, capability: 'image.image2image', tier: 'quality',
  prompt: '保持 <image1> 中狐狸的脸型、毛色与围巾完全不变，把背景换成冷色调的夜间森林，画面中不出现任何文字',
  ref_nodes: [imgNode.id], width: 1024,
  title: 'e2e · i2i quality（2K 预算）', group: 'e2e',
})
const i2iNode = i2i.node
const i2iSize = _internals.probeImageSize(absOf(i2iNode.media))
console.log(`  · 解析=${i2i.resolution} tier=${i2iNode.params.tier} 实现=${i2iNode.params.workflow} ${Math.round((Date.now() - t1) / 1000)}s`)
console.log(`  · warnings: ${JSON.stringify(i2i.warnings || [])}`)
ok(i2iNode.params.workflow.startsWith('qwen-image-21-i2i-'), `i2i 实现由配置解析（${i2iNode.params.workflow}）`)
ok(i2iNode.params.width === i2iSize?.w && i2iNode.params.height === i2iSize?.h, `节点宽高 == 产物真实像素（${i2iSize?.w}×${i2iSize?.h}）`)
ok(i2iSize && Math.max(i2iSize.w, i2iSize.h) > 1500, `quality 档出 2K 级改绘（长边 ${Math.max(i2iSize?.w || 0, i2iSize?.h || 0)}）`)
ok((i2i.warnings || []).some((w) => w.includes('width') && w.includes('未生效')), 'i2i 传 width → 明确告警「该参数未生效」')
ok(Boolean(i2iNode.params.warnings && i2iNode.params.warnings.length), 'warnings 也记在画布节点上')

if (!SKIP_VIDEO) {
  console.log('== ③ 视频（tier=fast，9:16 → 长边 832）==')
  const t2 = Date.now()
  const vid = await _internals.runRender(ctx, {
    ...common, capability: 'video.reference2video', tier: 'fast',
    prompt: '小狐狸在雪地里抬头看雪花落下，镜头缓慢推近',
    ref_nodes: [imgNode.id], length: 56,
    title: 'e2e · video fast（9:16）', group: 'e2e',
  })
  const vNode = vid.node
  console.log(`  · 解析=${vid.resolution} tier=${vNode.params.tier} 实现=${vNode.params.workflow} ${Math.round((Date.now() - t2) / 1000)}s`)
  ok(vNode.kind === 'video', '产物是视频节点')
  ok(vNode.params.workflow.startsWith('minimax-h3-'), `视频实现由配置解析（${vNode.params.workflow}）`)
  ok(vNode.params.width > 0 && vNode.params.height > 0 && vNode.params.width < vNode.params.height, `9:16 竖版交付记账：${vNode.params.width}×${vNode.params.height}（两阶段实现的交付尺寸）`)
}

console.log('')
const nodes = readNodes()
console.log(`画布节点（${projectPath}）：`)
for (const n of nodes) console.log(`  ${n.kind.padEnd(5)} ${String(n.title).padEnd(28)} ${n.params.width}×${n.params.height} tier=${n.params.tier} 实现=${n.params.workflow}${n.params.graphWidth ? ` 首遍 ${n.params.graphWidth}×${n.params.graphHeight}` : ''}`)
console.log(failures ? `\n✗ 失败 ${failures} 项` : '\n✓ 全部通过：统一档位体系真机链路正确')
process.exit(failures ? 1 : 0)
