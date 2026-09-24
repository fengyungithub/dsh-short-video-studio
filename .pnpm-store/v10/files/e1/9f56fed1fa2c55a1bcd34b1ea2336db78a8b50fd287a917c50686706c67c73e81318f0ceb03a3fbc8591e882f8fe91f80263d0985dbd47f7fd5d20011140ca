/**
 * scripts/smoke-upscale.mjs — 视频超分（capability=video.upscale）冒烟测试。**不跑 GPU、不连 ComfyUI。**
 *
 * 锁住的语义：
 *  1) 清单契约：尺寸来源（upscale.sizing / factor / shortSide）、分块归属（chunking）、资产槽、字号尺寸不参与
 *  2) 校验：超分能力必须声明尺寸来源，且不得声明 resolutionLock；factor 必须正数；
 *     short-side 不得再声明 factor、必须留 out_short_side 注入点；两个枚举都 fail-closed
 *  3) 尺寸规划（factor）：自然尺寸 = 源 × factor；target_width 事后收敛并对齐 32；超倍率目标给出插值告警
 *  4) 尺寸规划（short-side）：短边 → 交付（横竖版都测）；target_width **反解短边回注**（不是先渲染再降采样）；
 *     maxEdge 如实预测并告警；倍率记为 null（不编数）
 *  5) 分块决策：caller 按预算切；internal 不自动切（并点名为什么）；显式 chunk_frames 仍照办但要告警
 *  6) 切口：ImageFromBatch 切帧 + TrimAudioDuration 切音轨（不切音轨会导致每块都配整条音轨）
 *  7) 容器解析：自造最小 mp4（moov/trak/tkhd/hdlr/stsz/mvhd）应读出宽高/帧数/时长/音轨
 *  8) 注册表集成：能力进入清单；quality 隐式首选 x2；x4 priority<0 只能显式选中
 *
 * 用法：node scripts/smoke-upscale.mjs
 */
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _internals } from '../lib/index.js'
import { validateManifest, buildGraphFromManifest, UPSCALE_SIZINGS, UPSCALE_CHUNKINGS } from '../lib/manifest.js'
import {
  probeMp4, snapToAlign, planUpscale, planUpscaleChunks, chunkRanges, sliceUpscaleGraph,
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

console.log('\n[1] 清单契约：尺寸来源是声明的，尺寸跟着输入走；分块归属也是声明的')
for (const [id, factor] of [[X2, 2], [X4, 4]]) {
  const m = reg.byId[id]
  ok(`${id} 已注册`, Boolean(m))
  if (!m) continue
  eq(`${id} capability=video.upscale`, m.capability, 'video.upscale')
  eq(`${id} tier=quality`, m.tier, 'quality')
  eq(`${id} 尺寸来源 = factor`, m.upscale.sizing, 'factor')
  eq(`${id} 倍率 = ${factor}`, m.upscale.factor, factor)
  eq(`${id} 分块归属 = caller（逐帧独立 ⇒ 可被 runner 切）`, m.upscale.chunking, 'caller')
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

console.log('\n[2] 校验：超分清单必须声明尺寸来源，不得混用 resolutionLock；两个枚举 fail-closed')
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

  // 两个枚举：写错必须被拒（静默忽略 ⇒ 交付尺寸与预期不符，正是这套契约最在意的错）
  eq('sizing 词汇表只有两种形态', UPSCALE_SIZINGS.join(','), 'factor,short-side')
  eq('chunking 词汇表只有两种归属', UPSCALE_CHUNKINGS.join(','), 'caller,internal')
  const badSizing = JSON.parse(JSON.stringify(base)); badSizing.upscale.sizing = 'shortside'
  ok('sizing 拼错被判非法', validateManifest(badSizing, 't').ok === false)
  ok('…错误信息点名词汇表',
    validateManifest(badSizing, 't').errors.some((e) => e.includes('upscale.sizing') && e.includes('short-side')))
  const badChunking = JSON.parse(JSON.stringify(base)); badChunking.upscale.chunking = 'model'
  ok('chunking 拼错被判非法', validateManifest(badChunking, 't').ok === false)
  ok('…错误信息点名词汇表',
    validateManifest(badChunking, 't').errors.some((e) => e.includes('upscale.chunking') && e.includes('caller')))
  ok('显式写 sizing="factor" + chunking="caller" 仍然合法（自文档化的产物清单）',
    validateManifest(base, 't').ok === true, validateManifest(base, 't').errors.join('; '))

  // short-side 形态的四条硬约束
  const shortSide = JSON.parse(JSON.stringify(base))
  delete shortSide.upscale.factor
  shortSide.upscale = { sizing: 'short-side', shortSide: 1080, align: 32, note: '扩散恢复类：目标短边驱动' }
  shortSide.params.out_short_side = { inject: 'scalar', to: { node: '3', field: 'resolution' } }
  ok('short-side + out_short_side 注入点 ⇒ 合法',
    validateManifest(shortSide, 't').ok === true, validateManifest(shortSide, 't').errors.join('; '))

  const noInject = JSON.parse(JSON.stringify(shortSide)); delete noInject.params.out_short_side
  ok('short-side 缺 out_short_side ⇒ 非法（尺寸落不到模型上）',
    validateManifest(noInject, 't').ok === false)
  ok('…错误信息点名 out_short_side',
    validateManifest(noInject, 't').errors.some((e) => e.includes('out_short_side')))

  const withFactor = JSON.parse(JSON.stringify(shortSide)); withFactor.upscale.factor = 2
  ok('short-side 又声明 factor ⇒ 非法（倍率是推导的，写死会与实际交付不符）',
    validateManifest(withFactor, 't').ok === false)
  ok('…错误信息点名 factor',
    validateManifest(withFactor, 't').errors.some((e) => e.includes('factor')))

  const noShort = JSON.parse(JSON.stringify(shortSide)); delete noShort.upscale.shortSide
  ok('short-side 缺 shortSide ⇒ 非法', validateManifest(noShort, 't').ok === false)
  const zeroShort = JSON.parse(JSON.stringify(shortSide)); zeroShort.upscale.shortSide = 0
  ok('shortSide=0 ⇒ 非法', validateManifest(zeroShort, 't').ok === false)
  const badCap = JSON.parse(JSON.stringify(shortSide)); badCap.upscale.maxEdge = -1
  ok('maxEdge=-1 ⇒ 非法（0 才表示不限）', validateManifest(badCap, 't').ok === false)
  const goodCap = JSON.parse(JSON.stringify(shortSide)); goodCap.upscale.maxEdge = 2048
  ok('maxEdge=2048 ⇒ 合法', validateManifest(goodCap, 't').ok === true, validateManifest(goodCap, 't').errors.join('; '))
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

console.log('\n[4] 尺寸规划（short-side）：交付由目标短边推出，倍率记为 null，target_width 反解回注')
{
  // 横版 1344×768（1.75:1）· 短边 1080 ⇒ 1080 先对齐到 1088，长边按比例 1904→1920
  const land = planUpscale({ srcW: 1344, srcH: 768, sizing: 'short-side', shortSide: 1080 })
  eq('横版 短边1080 → 1920×1088', `${land.delivery.w}×${land.delivery.h}`, '1920×1088')
  eq('short-side 形态的「自然尺寸」= 交付尺寸（没有二次缩放）',
    `${land.natural.w}×${land.natural.h}`, `${land.delivery.w}×${land.delivery.h}`)
  eq('倍率记为 null（不编一个数出来）', land.factor, null)
  eq('回注实现的短边 = 对齐后的实际短边 1088', land.shortSide, 1088)
  eq('无 target 时无告警', land.warning, '')

  // 竖版 768×1344：短边是宽
  const port = planUpscale({ srcW: 768, srcH: 1344, sizing: 'short-side', shortSide: 1080 })
  eq('竖版 短边1080 → 1088×1920', `${port.delivery.w}×${port.delivery.h}`, '1088×1920')
  eq('竖版回注短边 = 宽 1088', port.shortSide, 1088)

  // target_width：横版时它是**长边** ⇒ 反解短边（4032/1.75 = 2304），让模型按目标渲染
  const tw = planUpscale({ srcW: 2688, srcH: 1536, sizing: 'short-side', shortSide: 1080, targetWidth: 4032 })
  eq('横版 target_width=4032 ⇒ 交付 4032×2304', `${tw.delivery.w}×${tw.delivery.h}`, '4032×2304')
  eq('…且把短边 2304 回注给模型（不是先渲染再降采样）', tw.shortSide, 2304)
  // 竖版时 target_width 本身就是短边
  const twp = planUpscale({ srcW: 768, srcH: 1344, sizing: 'short-side', shortSide: 1080, targetWidth: 1088 })
  eq('竖版 target_width 就是短边（1088 → 1088×1920）', `${twp.delivery.w}×${twp.delivery.h}`, '1088×1920')

  // maxEdge：实现自己的长边上限，如实预测并告警（不是静默裁掉）
  const capped = planUpscale({ srcW: 1344, srcH: 768, sizing: 'short-side', shortSide: 2160, maxEdge: 2048 })
  eq('超 maxEdge ⇒ 压回 2048×1184', `${capped.delivery.w}×${capped.delivery.h}`, '2048×1184')
  ok('…并且告警点名 maxEdge', capped.warning.includes('maxEdge=2048'), capped.warning)

  let threw = ''
  try { planUpscale({ srcW: 1344, srcH: 768, sizing: 'short-side', shortSide: 0 }) } catch (err) { threw = err.message }
  ok('short-side 缺 shortSide ⇒ 抛错', threw.includes('shortSide'), threw)
  let threw2 = ''
  try { planUpscale({ srcW: 1344, srcH: 768, sizing: 'factor' }) } catch (err) { threw2 = err.message }
  ok('factor 形态缺 factor ⇒ 抛错（不静默当 1×）', threw2.includes('factor'), threw2)
  let threw3 = ''
  try { planUpscale({ srcW: 1344, srcH: 768, sizing: 'caller', factor: 2 }) } catch (err) { threw3 = err.message }
  ok('未知 sizing ⇒ 抛错（不静默按 factor 算错尺寸）', threw3.includes('未知 sizing'), threw3)
  eq('factor 形态下 shortSide 如实记 null（不编数）',
    planUpscale({ srcW: 1344, srcH: 768, factor: 2 }).shortSide, null)

  // 短边最终要靠 params.out_short_side 落到模型上 —— 这里直接验那条注入链。
  // （图结构与短边无关，借用 x2 的图只为拿一个可注入的数字字段；真实现该字段是 SeedVR2 的 resolution。）
  const synth = JSON.parse(JSON.stringify(reg.byId[X2]))
  delete synth.upscale.factor
  synth.upscale = { sizing: 'short-side', shortSide: 1080, align: 32 }
  synth.params.out_short_side = { inject: 'scalar', to: { node: '5', field: 'width' } }
  ok('合成短边清单合法（校验器口径）',
    validateManifest(synth, 't').ok === true, validateManifest(synth, 't').errors.join('; '))
  const sg = buildGraphFromManifest(synth, {
    mode: null, source_video: 'in.mp4', out_width: 1920, out_height: 1088, out_short_side: 1088, prefix: 'x/y',
  })
  eq('out_short_side 注入到实现声明的字段', sg['5'].inputs.width, 1088)

  const fg = buildGraphFromManifest(reg.byId[X2], {
    mode: null, source_video: 'in.mp4', out_width: 2688, out_height: 1536, out_short_side: 1088, prefix: 'x/y',
  })
  eq('factor 形态收到未声明的 out_short_side ⇒ 静默忽略（不报错、不污染图）', fg['5'].inputs.width, 2688)

  // 真机短边探针的夹具（scripts/fixtures/upscale-shortside-probe.json）也要一直是合法的：
  // 它是 e2e-upscale-shortside.mjs 的载体，而那个脚本要 GPU ⇒ 夹具坏了 CI 发现不了。
  const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'upscale-shortside-probe.json')
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  ok('探针夹具通过校验', validateManifest(fx, 'fixture').ok === true, validateManifest(fx, 'fixture').errors.join('; '))
  eq('探针夹具是 short-side + internal', `${fx.upscale.sizing}/${fx.upscale.chunking}`, 'short-side/internal')
  ok('探针夹具是 internal（不进档位解析）', fx.internal === true)
  ok('探针夹具声明了 out_short_side（短边才落得到图上）', Boolean(fx.params.out_short_side))
  const fxg = buildGraphFromManifest(fx, { mode: null, source_video: 'in.mp4', out_width: 999, out_short_side: 1088, out_height: 1888, prefix: 'x/y' })
  eq('探针图：短边注入到 width', fxg['3'].inputs.width, 1088)
  eq('探针图：out_width 未声明 ⇒ 不生效（这正是「只吃短边」的形态）', fxg['3'].inputs.width !== 999, true)
  const fxSlice = sliceUpscaleGraph(fxg, { start: 60, frames: 60, fps: 24 })
  eq('探针图能被切片（异质节点 ImageScale）', JSON.stringify(fxSlice['3'].inputs.image), JSON.stringify(['900', 0]))
}

console.log('\n[5] 分块：逐帧独立 ⇒ 任意切点安全；预算换算')
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

console.log('\n[6] 分块决策：caller 按预算切；internal 不自动切（显存归实现自己管）')
{
  const over = { frames: 400, deliveryW: 4032, deliveryH: 2304 }   // 400×9.29M = 3.7e9 > 3.0e9
  const caller = planUpscaleChunks({ ...over, chunking: 'caller' })
  eq('caller + 超预算 ⇒ reason=budget', caller.reason, 'budget')
  ok('…且算出每块帧数（预算内）',
    caller.frameLimit > 0 && caller.frameLimit * over.deliveryW * over.deliveryH <= PIXEL_FRAME_CHUNK,
    String(caller.frameLimit))
  eq('caller + 超预算不额外告警（分块本身由 runner 说明）', caller.warnings.length, 0)

  const under = planUpscaleChunks({ frames: 124, deliveryW: 2688, deliveryH: 1536, chunking: 'caller' })
  eq('caller + 未超预算 ⇒ 不分块', under.frameLimit, 0)
  eq('…reason 为空', under.reason, '')

  const internal = planUpscaleChunks({ ...over, chunking: 'internal' })
  eq('internal + 超预算 ⇒ 仍然不分块', internal.frameLimit, 0)
  ok('…但如实告警（点名 internal 与「不自动分块」）',
    internal.warnings.some((w) => w.includes('internal') && w.includes('不') && w.includes('时间窗')),
    JSON.stringify(internal.warnings))

  const internalManual = planUpscaleChunks({ ...over, chunking: 'internal', explicitChunkFrames: 100 })
  eq('internal + 调用方显式 chunk_frames ⇒ 照办（显式意图优先）', internalManual.frameLimit, 100)
  eq('…reason=manual', internalManual.reason, 'manual')
  ok('…但告警说明会切断它的时间窗',
    internalManual.warnings.some((w) => w.includes('chunk_frames') && w.includes('接缝')),
    JSON.stringify(internalManual.warnings))

  const manual = planUpscaleChunks({ frames: 124, deliveryW: 2688, deliveryH: 1536, chunking: 'caller', explicitChunkFrames: 40 })
  eq('caller + 显式 chunk_frames ⇒ 照办', manual.frameLimit, 40)
  eq('…reason=manual', manual.reason, 'manual')

  eq('帧数未知（0）时不做任何分块决策', planUpscaleChunks({ frames: 0, deliveryW: 4032, deliveryH: 2304 }).frameLimit, 0)
  eq('像素-帧总量如实回报',
    planUpscaleChunks({ frames: 124, deliveryW: 2688, deliveryH: 1536 }).pixelFrames, 124 * 2688 * 1536)
}

console.log('\n[7] 切口：切帧（ImageFromBatch）+ 切音轨（TrimAudioDuration）')
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

  // 接线按**引用**找，不按类名猜：异质实现（逐帧那一段不叫 ImageUpscaleWithModel）也必须接得上。
  // 真机事故（2026-09-24，短边探针用 ImageScale）：只认类名 ⇒ 切口接不上，每块仍吐整片，372 帧 = 124×3 静默重复。
  {
    const hetero = JSON.parse(JSON.stringify(base))
    hetero['4'] = { class_type: 'ImageScale', inputs: { image: ['2', 0], upscale_method: 'area', width: 32, height: 32, crop: 'disabled' } }
    const hg = sliceUpscaleGraph(hetero, { start: 60, frames: 60, fps: 24 })
    eq('异质实现也能接上切口（ImageScale 而非 ImageUpscaleWithModel）',
      JSON.stringify(hg['4'].inputs.image), JSON.stringify(['900', 0]))
    eq('…音轨照样改到切过的音轨上', JSON.stringify(hg['6'].inputs.audio), JSON.stringify(['901', 0]))
    // 切开后每一块只吃自己那段：帧数守恒的前提
    eq('切口只吃一个片段（batch_index/length）', `${hg['900'].inputs.batch_index}/${hg['900'].inputs.length}`, '60/60')
  }
  {
    // 接不上必须**显式抛错**：静默产出「每块都吐整片」的成片是这套契约最不能接受的错
    const orphan = JSON.parse(JSON.stringify(base))
    orphan['4'] = { class_type: 'ImageScale', inputs: { image: ['3', 0], width: 32, height: 32 } }   // 不消费源帧
    let msg = ''
    try { sliceUpscaleGraph(orphan, { start: 0, frames: 60, fps: 24 }) } catch (err) { msg = err.message }
    ok('没有节点消费源帧 ⇒ 抛错（不静默出重复帧）', msg.includes('切口接不上'), msg || '(没报错)')
    ok('…错误信息给出两条出路（保头 / 改声明 internal）',
      msg.includes('GetVideoComponents') && msg.includes('internal'), msg)
  }

  // 单块调用不应该为了「切全片」插入无意义的节点
  const whole = buildGraphFromManifest(m, { mode: null, source_video: 'in.mp4', out_width: 4032, out_height: 2304, prefix: 'x/y' })
  const sliced = sliceUpscaleGraph(whole, { start: 0, frames: 124, fps: 24 })
  ok('单块整片也走切口（语义统一为「这块是 0–124 帧」）', sliced['900'] !== undefined)
  ok('但源图仍未被改', whole['900'] === undefined)
}

console.log('\n[8] 容器解析：自造最小 mp4 读出宽高/帧数/时长/音轨')
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

console.log('\n[9] 注册表集成：能力可见、隐式默认仍是 x2、贵的实现必须显式选')
{
  const cands = reg.byCapability['video.upscale'] || []
  eq('能力下有 3 份实现（x2 / x4 / SeedVR2）', cands.length, 3)
  const quality = cands.filter((m) => m.tier === 'quality' && !m.internal)
  const first = I.sortTierCandidates(quality)[0]
  eq('quality 隐式首选 x2（priority 最高）', first.id, X2)
  ok('x4 priority<0（不会被隐式选中）', reg.byId[X4].priority < 0, String(reg.byId[X4].priority))
  ok('x2 priority≥0', reg.byId[X2].priority >= 0, String(reg.byId[X2].priority))
  // 显式指定 x4 必须能解析出来，并且档位一致时不报错
  const explicit = quality.find((m) => m.id === X4)
  ok('x4 显式可选（同档位）', Boolean(explicit) && explicit.tier === 'quality')

  // SeedVR2：扩散式恢复 —— 同为视频超分能力，但形态和像素链路完全不同
  const sv = reg.byId['video-upscale-seedvr2-3b']
  ok('SeedVR2 清单已注册', Boolean(sv))
  if (sv) {
    eq('SeedVR2 capability 相同（同一个工具、同一个能力）', sv.capability, 'video.upscale')
    eq('SeedVR2 tier=quality', sv.tier, 'quality')
    eq('SeedVR2 尺寸来源仍是 factor', sv.upscale.sizing, 'factor')
    eq('SeedVR2 默认倍率 2', sv.upscale.factor, 2)
    eq('SeedVR2 分块归属 = internal（自带跨帧时间窗）', sv.upscale.chunking, 'internal')
    ok('SeedVR2 priority<0（比像素链路贵，不做隐式默认）', sv.priority < 0, String(sv.priority))
    ok('SeedVR2 仍然不声明 resolutionLock', sv.resolutionLock === undefined)
    // 三个资产槽之外还要看**图**：它必须**进采样器**（这是与 U3 的本质差别）
    const sg = sv.graph
    ok('SeedVR2 图里有 KSampler（进采样器，不是纯像素链路）',
      Object.values(sg).some((n) => n.class_type === 'KSampler'))
    eq('SeedVR2 一步推理（steps=1 / denoise=1）',
      `${sg['9'].inputs.steps}/${sg['9'].inputs.denoise}`, '1/1')
    eq('SeedVR2 交付尺寸直接喂模型（ImageScale = out_width/out_height）',
      JSON.stringify(sv.params.out_width.to) + JSON.stringify(sv.params.out_height.to),
      JSON.stringify({ node: '3', field: 'width' }) + JSON.stringify({ node: '3', field: 'height' }))
    eq('SeedVR2 音轨不进模型（源 → CreateVideo 直连）',
      JSON.stringify(sg['12'].inputs.audio), JSON.stringify(['2', 1]))
    eq('SeedVR2 两个资产槽（DiT + VAE）', Object.keys(sv.assets).sort().join(','), 'seedvr2_dit,seedvr2_vae')
    ok('SeedVR2 requiresNodes 覆盖原生链路',
      ['UNETLoader', 'VAELoader', 'SeedVR2Preprocess', 'SeedVR2Conditioning', 'KSampler', 'VAEDecodeTiled', 'SeedVR2PostProcessing']
        .every((n) => sv.requiresNodes.includes(n)), JSON.stringify(sv.requiresNodes))
    // chunking=internal 的真实效果：像素-帧超线也不自动切（只告警）
    const bigChunk = planUpscaleChunks({ frames: 400, deliveryW: 4032, deliveryH: 2304, chunking: sv.upscale.chunking })
    eq('SeedVR2 超像素-帧线也不自动分块', bigChunk.frameLimit, 0)
    ok('…但会如实告警', bigChunk.warnings.length > 0, JSON.stringify(bigChunk.warnings))
    // 编译出来的图：交付尺寸注入到节点 3，且通用切口接得上
    const cg = buildGraphFromManifest(sv, { mode: null, source_video: 'in.mp4', out_width: 2688, out_height: 1536, prefix: 'x/y' })
    eq('编译图 13 节点', Object.keys(cg).length, 13)
    eq('交付尺寸注入节点 3', `${cg['3'].inputs.width}×${cg['3'].inputs.height}`, '2688×1536')
    const cs = sliceUpscaleGraph(cg, { start: 0, frames: 56, fps: 24 })
    eq('种 SeedVR2 图也能被切片（帧入口是 ImageScale）',
      JSON.stringify(cs['3'].inputs.image), JSON.stringify(['900', 0]))
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
