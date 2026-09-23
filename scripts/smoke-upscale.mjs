/**
 * scripts/smoke-upscale.mjs — 视频超分（capability=video.upscale）冒烟测试。**不跑 GPU、不连 ComfyUI。**
 *
 * 锁住的语义：
 *  1) 清单契约：倍率声明（upscale.factor）、资产槽、字号尺寸不参与（超分尺寸跟着输入走）
 *  2) 校验：超分能力必须声明 upscale，且不得声明 resolutionLock；factor 必须正数
 *  3) 尺寸规划：自然尺寸 = 源 × factor；target_width 收敛并对齐 32；超倍率目标给出插值告警
 *  4) 分块：逐帧独立 ⇒ 任意切点安全；预算帧数换算
 *  5) 切口：ImageFromBatch 切帧 + TrimAudioDuration 切音轨（不切音轨会导致每块都配整条音轨）
 *  6) 容器解析：自造最小 mp4（moov/trak/tkhd/hdlr/stsz/mvhd）应读出宽高/帧数/时长/音轨
 *  7) 注册表集成：能力进入清单；quality 隐式首选 x2；x4 priority<0 只能显式选中
 *
 * 用法：node scripts/smoke-upscale.mjs
 */
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _internals } from '../lib/index.js'
import { validateManifest, buildGraphFromManifest } from '../lib/manifest.js'
import {
  probeMp4, snapToAlign, planUpscale, chunkRanges, sliceUpscaleGraph,
  chunkFramesForBudget, PIXEL_FRAME_WARN, PIXEL_FRAME_CHUNK,
} from '../lib/upscale.js'

const I = _internals
let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `期望 ${want}，实际 ${got}`)
const reg = I.getRegistry()
const X2 = 'video-upscale-x2'
const X4 = 'video-upscale-x4'

console.log('\n[1] 清单契约：倍率是声明的，尺寸跟着输入走')
for (const [id, factor] of [[X2, 2], [X4, 4]]) {
  const m = reg.byId[id]
  ok(`${id} 已注册`, Boolean(m))
  if (!m) continue
  eq(`${id} capability=video.upscale`, m.capability, 'video.upscale')
  eq(`${id} tier=quality`, m.tier, 'quality')
  eq(`${id} 倍率 = ${factor}`, m.upscale.factor, factor)
  ok(`${id} 不声明 resolutionLock（尺寸不属于图结构）`, m.resolutionLock === undefined)
  ok(`${id} 无 modes（没有采样器/档位参数，不该假装有）`, m.modes === undefined, JSON.stringify(m.modes))
  ok(`${id} estSeconds 是实测正数`, Number.isFinite(m.estSeconds) && m.estSeconds > 0, String(m.estSeconds))
  eq(`${id} 资产槽 1 个（只能换同倍率权重）`, Object.keys(m.assets).length, 1)
  const slot = Object.keys(m.assets)[0]
  ok(`${id} 资产槽名带倍率（防换错权重）`, slot.endsWith('x' + factor), slot)
  ok(`${id} requiresNodes 覆盖像素链路`,
    ['LoadVideo', 'GetVideoComponents', 'UpscaleModelLoader', 'ImageUpscaleWithModel', 'ImageScale', 'CreateVideo', 'SaveVideo']
      .every((n) => m.requiresNodes.includes(n)), JSON.stringify(m.requiresNodes))
  // 图结构：7 节点、无采样器、音轨从 GetVideoComponents 直达 CreateVideo（从不经过模型）
  const g = m.graph
  eq(`${id} 图 7 个节点`, Object.keys(g).length, 7)
  ok(`${id} 不含任何采样器/潜空间节点`,
    !Object.values(g).some((n) => /Sampler|Latent|Guider|Sigma|Noise/i.test(n.class_type)),
    Object.values(g).map((n) => n.class_type).join(','))
  eq(`${id} 放大链 2→4→5→6→7`,
    JSON.stringify([g['4'].inputs.image, g['5'].inputs.image, g['6'].inputs.images, g['7'].inputs.video]),
    JSON.stringify([['2', 0], ['4', 0], ['5', 0], ['6', 0]]))
  eq(`${id} 音轨直连（源 → CreateVideo，不经过放大）`,
    JSON.stringify(g['6'].inputs.audio), JSON.stringify(['2', 1]))
  eq(`${id} fps 取源片`, JSON.stringify(g['6'].inputs.fps), JSON.stringify(['2', 2]))
  eq(`${id} 输出 mp4`, g['7'].inputs.format, 'mp4')
}

console.log('\n[2] 校验：超分清单必须声明倍率，不得混用 resolutionLock')
{
  const base = JSON.parse(JSON.stringify(reg.byId[X2]))
  const dropFactor = JSON.parse(JSON.stringify(base)); delete dropFactor.upscale
  ok('缺 upscale 的超分清单被判非法', validateManifest(dropFactor, 't').ok === false)
  ok('…错误信息点名 upscale.factor',
    validateManifest(dropFactor, 't').errors.some((e) => e.includes('upscale.factor')))

  const badFactor = JSON.parse(JSON.stringify(base)); badFactor.upscale.factor = 0
  ok('factor=0 被判非法', validateManifest(badFactor, 't').ok === false)

  const badAlign = JSON.parse(JSON.stringify(base)); badAlign.upscale.align = 0
  ok('align=0 被判非法', validateManifest(badAlign, 't').ok === false)

  const mixed = JSON.parse(JSON.stringify(base))
  mixed.resolutionLock = { graph: [1344, 768], scale: 2 }
  ok('超分清单带 resolutionLock 被判非法', validateManifest(mixed, 't').ok === false)
  ok('…错误信息说明尺寸跟着输入走',
    validateManifest(mixed, 't').errors.some((e) => e.includes('跟着输入视频走')))

  ok('自造清单 capability 不在词汇表 ⇒ 非法',
    validateManifest({ ...base, id: 'x', capability: 'video.magic' }, 't').ok === false)
}

console.log('\n[3] 尺寸规划：自然尺寸 = 源 × factor；target_width 收敛并对齐 32')
{
  eq('对齐函数 4032→4032', snapToAlign(4032, 32), 4032)
  eq('对齐函数 4000→4000（32×125）', snapToAlign(4000, 32), 4000)
  eq('对齐函数 4010→4000', snapToAlign(4010, 32), 4000)
  eq('对齐函数 17→32（不小于 align）', snapToAlign(17, 32), 32)

  const a = planUpscale({ srcW: 2688, srcH: 1536, factor: 2 })
  eq('2K(2688×1536) ×2 → 5376×3072', `${a.natural.w}×${a.natural.h}`, '5376×3072')
  eq('不给 target 时交付=自然', `${a.delivery.w}×${a.delivery.h}`, '5376×3072')
  eq('不给 target 时无告警', a.warning, '')

  const b = planUpscale({ srcW: 2688, srcH: 1536, factor: 2, targetWidth: 4032 })
  eq('2K ×2 收敛到 4032×2304', `${b.delivery.w}×${b.delivery.h}`, '4032×2304')
  // 注意：4032×2304 是 **1.75:1**（H3 族 1344×768 的比例），不是 16:9。
  // 超分从不改比例——「4K 级」只是宽度口径，比例永远跟源片走。
  ok('收敛不改比例（2688×1536 的 1.75:1 保持）',
    Math.abs(b.delivery.w / b.delivery.h - 2688 / 1536) < 0.001, String(b.delivery.w / b.delivery.h))
  ok('4032×2304 是 1.75:1 而非 16:9（口径要诚实）',
    Math.abs(4032 / 2304 - 1.75) < 0.001 && Math.abs(4032 / 2304 - 16 / 9) > 0.02, String(4032 / 2304))

  const c = planUpscale({ srcW: 1344, srcH: 768, factor: 4, targetWidth: 4032 })
  eq('原生 ×4 收敛到 4032×2304', `${c.delivery.w}×${c.delivery.h}`, '4032×2304')

  const d = planUpscale({ srcW: 832, srcH: 480, factor: 2 })
  eq('竖版/窄源照原样放大（832×480 → 1664×960）', `${d.delivery.w}×${d.delivery.h}`, '1664×960')

  const e = planUpscale({ srcW: 1344, srcH: 768, factor: 2, targetWidth: 4032 })
  eq('要求超过倍率能给的尺寸仍算出尺寸', `${e.delivery.w}×${e.delivery.h}`, '4032×2304')
  ok('…但会告警：超出部分是插值', e.warning.includes('插值'), e.warning)

  let threw = ''
  try { planUpscale({ srcW: 0, srcH: 0, factor: 2 }) } catch (err) { threw = err.message }
  ok('源尺寸未知 ⇒ 抛错（不能瞎猜）', threw.includes('源尺寸未知'), threw)
}

console.log('\n[4] 分块：逐帧独立 ⇒ 任意切点安全；预算换算')
{
  eq('不分块（chunk 0）', JSON.stringify(chunkRanges(124, 0)), JSON.stringify([{ start: 0, frames: 124 }]))
  eq('chunk ≥ 帧数 ⇒ 单块', JSON.stringify(chunkRanges(124, 300)), JSON.stringify([{ start: 0, frames: 124 }]))
  const r = chunkRanges(744, 181)
  eq('744 帧 / 181 ⇒ 5 块（末块 20 帧）', r.length, 5)
  eq('块首尾相接、无缝隙', r.map((x) => x.start).join(','), '0,181,362,543,724')
  eq('帧数总和守恒', r.reduce((s, x) => s + x.frames, 0), 744)
  eq('块内帧数合法', r[r.length - 1].frames, 20)
  eq('帧数 0 也返回单块（不空转）', JSON.stringify(chunkRanges(0, 100)), JSON.stringify([{ start: 0, frames: 0 }]))

  // 预算：5.4K 每帧 16.5M 像素 ⇒ 2.0e9/16.5M ≈ 121 帧；4K 每帧 9.3M ⇒ ≈215 帧
  const f54 = chunkFramesForBudget(5376, 3072)
  const f4k = chunkFramesForBudget(4032, 2304)
  ok('5.4K 预算帧数在 100–140 之间', f54 > 100 && f54 < 140, String(f54))
  ok('4K 预算帧数在 190–240 之间', f4k > 190 && f4k < 240, String(f4k))
  ok('预算线在实测包线以内（248 帧 5.4K = 4.09e9 已通过）',
    PIXEL_FRAME_WARN < 4.09e9 && PIXEL_FRAME_CHUNK < PIXEL_FRAME_WARN,
    `${PIXEL_FRAME_WARN} / ${PIXEL_FRAME_CHUNK}`)
  ok('预算内单块不超过告警线',
    chunkFramesForBudget(5376, 3072) * 5376 * 3072 <= PIXEL_FRAME_CHUNK, String(f54 * 5376 * 3072))
}

console.log('\n[5] 切口：切帧（ImageFromBatch）+ 切音轨（TrimAudioDuration）')
{
  const m = reg.byId[X2]
  const base = buildGraphFromManifest(m, {
    mode: null, source_video: 'in.mp4', out_width: 4032, out_height: 2304, prefix: 'x/y',
  })
  const g = sliceUpscaleGraph(base, { start: 181, frames: 181, fps: 24 })
  ok('插入 ImageFromBatch', g['900'].class_type === 'ImageFromBatch')
  eq('切口起点=181', g['900'].inputs.batch_index, 181)
  eq('切口长度=181', g['900'].inputs.length, 181)
  ok('插入 TrimAudioDuration', g['901'].class_type === 'TrimAudioDuration')
  eq('音轨起点 = 181/24 秒', g['901'].inputs.start_index, Number((181 / 24).toFixed(6)))
  eq('音轨时长 = 181/24 秒', g['901'].inputs.duration, Number((181 / 24).toFixed(6)))
  eq('放大节点改吃切口', JSON.stringify(g['4'].inputs.image), JSON.stringify(['900', 0]))
  eq('CreateVideo 改吃切过的音轨', JSON.stringify(g['6'].inputs.audio), JSON.stringify(['901', 0]))
  eq('fps 仍取源片', JSON.stringify(g['6'].inputs.fps), JSON.stringify(['2', 2]))
  eq('源图（GetVideoComponents → 切口）不变', JSON.stringify(g['900'].inputs.image), JSON.stringify(['2', 0]))
  ok('原图未被改动（纯函数）', JSON.stringify(base).includes('"batch_index"') === false)
  ok('源节点 id 可换（不自作聪明写死 2）',
    sliceUpscaleGraph(base, { start: 0, frames: 5, fps: 24, sourceNode: '2', idBase: 800 })['800'].inputs.image[0] === '2')

  let threw = ''
  try { sliceUpscaleGraph({ ...base, 900: { class_type: 'X', inputs: {} } }, { start: 0, frames: 5, fps: 24 }) }
  catch (err) { threw = err.message }
  ok('节点 id 冲突 ⇒ 显式抛错', threw.includes('已被占用'), threw)

  // 单块调用不应该为了「切全片」插入无意义的节点
  const whole = buildGraphFromManifest(m, { mode: null, source_video: 'in.mp4', out_width: 4032, out_height: 2304, prefix: 'x/y' })
  const sliced = sliceUpscaleGraph(whole, { start: 0, frames: 124, fps: 24 })
  ok('单块整片也走切口（语义统一为「这块是 0–124 帧」）', sliced['900'] !== undefined)
  ok('但源图仍未被改', whole['900'] === undefined)
}

console.log('\n[6] 容器解析：自造最小 mp4 读出宽高/帧数/时长/音轨')
{
  // 夹具严格按 ISO BMFF 的字段偏移摆放：
  //   盒子 = size(4) + type(4) + payload；`full` 再前置 4 字节 version/flags。
  //   tkhd v0：width/height 在 payload 偏移 76/80（= body 偏移 72/76，因为 full 已吃掉 4 字节）。
  //   mvhd v0：timescale/duration 在 payload 偏移 12/16（= body 偏移 8/12）。
  const box = (type, payload) => {
    const b = Buffer.alloc(8 + payload.length)
    b.writeUInt32BE(8 + payload.length, 0)
    b.write(type, 4, 'latin1')
    payload.copy(b, 8)
    return b
  }
  const full = (type, body) => box(type, Buffer.concat([Buffer.alloc(4), body]))
  const hdlr = (handler) => full('hdlr', Buffer.concat([Buffer.alloc(4), Buffer.from(handler, 'latin1'), Buffer.alloc(12)]))
  const tkhd = (w, h) => {
    const p = Buffer.alloc(80)
    p.writeUInt32BE(w * 65536, 72)   // width（16.16）
    p.writeUInt32BE(h * 65536, 76)   // height（16.16）
    return full('tkhd', p)
  }
  const stsz = (n) => {
    const p = Buffer.alloc(8)        // sample_size(4, 0=变长) + sample_count(4)
    p.writeUInt32BE(n, 4)
    return full('stsz', p)
  }
  const trak = (handler, w, h, n) => box('trak', Buffer.concat([
    tkhd(w, h), hdlr(handler), box('mdia', box('minf', box('stbl', stsz(n)))),
  ]))
  const mvhd = (() => {
    const p = Buffer.alloc(16)
    p.writeUInt32BE(1000, 8)         // timescale
    p.writeUInt32BE(5167, 12)        // duration ⇒ 5.167s
    return full('mvhd', p)
  })()
  const moov = box('moov', Buffer.concat([mvhd, trak('vide', 2688, 1536, 124), trak('soun', 0, 0, 0)]))
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'))
  const dir = mkdtempSync(join(tmpdir(), 'svs-upscale-'))
  const file = join(dir, 'fake.mp4')
  writeFileSync(file, Buffer.concat([ftyp, moov]))

  const p = probeMp4(file)
  eq('读出宽 2688', p.w, 2688)
  eq('读出高 1536', p.h, 1536)
  eq('读出帧数 124', p.frames, 124)
  eq('读出时长 5.167s', Number(p.duration.toFixed(3)), 5.167)
  eq('识别出音轨', p.hasAudio, true)
  const none = probeMp4(join(dir, 'nope.mp4'))
  ok('文件不存在 ⇒ 字段为 null（不抛错）', none.w === null && none.frames === null && none.hasAudio === false)
}

console.log('\n[7] 注册表集成：能力可见、隐式默认只用 x2、x4 必须显式选')
{
  const cands = reg.byCapability['video.upscale'] || []
  eq('能力下有 2 份实现', cands.length, 2)
  const quality = cands.filter((m) => m.tier === 'quality' && !m.internal)
  const first = I.sortTierCandidates(quality)[0]
  eq('quality 隐式首选 x2', first.id, X2)
  ok('x4 priority<0（不会被隐式选中）', reg.byId[X4].priority < 0, String(reg.byId[X4].priority))
  ok('x2 priority≥0', reg.byId[X2].priority >= 0, String(reg.byId[X2].priority))
  // 显式指定 x4 必须能解析出来，并且档位一致时不报错
  const explicit = quality.find((m) => m.id === X4)
  ok('x4 显式可选（同档位）', Boolean(explicit) && explicit.tier === 'quality')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
