#!/usr/bin/env node
/** 纯逻辑冒烟：buildConcatGraph 的拓扑正确性（不碰 ComfyUI，可进 CI）。 */
import { buildConcatGraph } from '../lib/concat.js'

let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log('  ✓ ' + name)
  else { console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); failed++ }
}

console.log('== 1) 少于 2 段应拒绝 ==')
for (const bad of [[], ['a.mp4'], null]) {
  let threw = false
  try { buildConcatGraph(bad, 'p') } catch { threw = true }
  check(`拒绝 ${JSON.stringify(bad)}`, threw)
}

console.log('\n== 2) 2 段拓扑 ==')
const g2 = buildConcatGraph(['a.mp4', 'b.mp4'], 'out/x')
check('节点数 = 8', Object.keys(g2).length === 8, String(Object.keys(g2).length))
check('load0 指向 a.mp4', g2.load0.inputs.file === 'a.mp4')
check('comp1 接 load1', JSON.stringify(g2.comp1.inputs.video) === '["load1",0]')
check('batch1 = comp0.images + comp1.images',
  JSON.stringify(g2.batch1.inputs.image1) === '["comp0",0]' && JSON.stringify(g2.batch1.inputs.image2) === '["comp1",0]')
check('acat1 = comp0.audio + comp1.audio，after',
  JSON.stringify(g2.acat1.inputs.audio1) === '["comp0",1]'
  && JSON.stringify(g2.acat1.inputs.audio2) === '["comp1",1]'
  && g2.acat1.inputs.direction === 'after')
check('create 取首段 fps', JSON.stringify(g2.create.inputs.fps) === '["comp0",2]')
check('create 接折叠末端', JSON.stringify(g2.create.inputs.images) === '["batch1",0]' && JSON.stringify(g2.create.inputs.audio) === '["acat1",0]')
check('save 为 mp4/h264', g2.save.inputs.format === 'mp4' && g2.save.inputs.codec === 'h264')
check('save 前缀透传', g2.save.inputs.filename_prefix === 'out/x')

console.log('\n== 3) N 段左折叠 ==')
const n = 5
const gn = buildConcatGraph(Array.from({ length: n }, (_, i) => `c${i}.mp4`), 'p')
check(`节点数 = 2N + 2(N-1) + 2 = ${2 * n + 2 * (n - 1) + 2}`, Object.keys(gn).length === 2 * n + 2 * (n - 1) + 2, String(Object.keys(gn).length))
check('折叠链左结合', JSON.stringify(gn[`batch${n - 1}`].inputs.image1) === `["batch${n - 2}",0]`)
check('末端进 create', JSON.stringify(gn.create.inputs.images) === `["batch${n - 1}",0]`)

console.log('\n== 4) 所有连线引用都存在 ==')
let dangling = 0
for (const [id, node] of Object.entries(gn)) {
  for (const v of Object.values(node.inputs)) {
    if (Array.isArray(v) && typeof v[0] === 'string' && !gn[v[0]]) { console.log(`  悬空: ${id} → ${v[0]}`); dangling++ }
  }
}
check('无悬空引用', dangling === 0)

console.log(failed === 0 ? '\n✓ 全部通过：拼接图拓扑正确' : `\n✗ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
