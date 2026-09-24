/**
 * scripts/smoke-render.mjs — M2 冒烟测试。
 *
 * 覆盖通用渲染的纯逻辑部分（不触网）：
 *  1) resolveManifest：显式 workflow / preferred 顺序 / 能力不匹配报错；
 *  2) computeManifestSize：显式宽高 / aspect-ratio 推导 / default 回退；
 *  3) buildRenderGraph：mode 步数、分辨率、refs 注入、fast LoRA。
 *
 * 用法：node scripts/smoke-render.mjs
 */

// 测试隔离：不读本机 ~/.dsh 里的真实配置（里面可能有用户自建策略/档位选择，
// 会把「未指定档位」「档位列表」等断言前提改掉）。纯逻辑测试一律跑在空配置上。
process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || '/nonexistent/svs-smoke-config.json'

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileSync, rmSync } from 'node:fs'
import { loadBuiltinManifests } from '../lib/manifest.js'
import { _internals } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const workflowsDir = join(__dirname, '..', 'workflows')

let failures = 0
function ok(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg) }
  else { failures++; console.error('  ✗ ' + msg) }
}
function eq(a, b, msg) { ok(a === b, `${msg}（期望 ${b}，实际 ${a}）`) }

const { resolveManifest, computeManifestSize, buildRenderGraph, resolveMode } = _internals
const reg = loadBuiltinManifests(workflowsDir)

console.log('== 1) 实现解析：档位 / 家族序 / pin / 未分档兼容 ==')
const { resolveTieredManifest } = _internals
// selection 注入空对象：断言的是「无配置选择时的解析规则」，不继承本机已保存的策略
// cfg 也注入空对象：本机配置里若存了用户自建策略 / pins / preferred，会改变解析结果
const none = { registry: reg, probe: false, selection: {}, cfg: {} }

// 未分档能力仍走 resolveManifest（显式 id 查找 / preferred / 候选序）
eq(resolveManifest(reg, 'image.from_video').id, 'extract-frame', 'image.from_video 未分档 → 唯一实现')
let threw = false
try { resolveManifest(reg, 'image.text2image', 'minimax-h3-ref2v-quality') } catch { threw = true }
ok(threw, '能力不匹配抛错')
threw = false
try { resolveManifest(reg, 'image.text2image', 'nonexistent') } catch { threw = true }
ok(threw, '不存在 workflow 抛错')

// 视频：分档能力（缺省 quality 档）
eq((await resolveTieredManifest('video.reference2video', null, null, none)).manifest.id, 'minimax-h3-ref2v-quality', 'video.reference2video 缺省 → quality 档（STANDARD）')
eq((await resolveTieredManifest('video.reference2video', 'balanced', null, none)).manifest.id, 'minimax-h3-ref2v-balanced', 'balanced 档默认取无加速实现（加速件需显式选择）')
eq((await resolveTieredManifest('video.reference2video', 'balanced', null, { ...none, selection: { balanced: 'minimax-h3-ref2v-balanced-sol' } })).manifest.id, 'minimax-h3-ref2v-balanced-sol', '注入配置选择 → 用加速实现')
eq((await resolveTieredManifest('video.image2video', 'fast', null, { ...none })).manifest.id, 'minimax-h3-i2v-fast', 'video.image2video fast 档')
eq((await resolveTieredManifest('video.reference2video', 'quality', 'minimax-h3-ref2v-quality', { ...none })).manifest.id, 'minimax-h3-ref2v-quality', '显式 workflow 命中（脚本/内部通道）')

// 图片：已并入**同一套**档位体系（一档一清单，group = 家族）
eq((await resolveTieredManifest('image.text2image', null, null, none)).manifest.id, 'flux-text2image-quality', 'image.text2image 缺省 → quality 档（候选序首个）')
eq((await resolveTieredManifest('image.text2image', 'fast', null, none)).manifest.id, 'flux-text2image-fast', 'image.text2image fast 档')
eq((await resolveTieredManifest('image.image2image', 'balanced', null, none)).manifest.id, 'flux2-img2img-balanced', 'image.image2image balanced 档')

// preferred = **家族序**：写家族名即可命中该家族在**各档**的实现（旧配置无需改动）
const prefCfg = { cfg: { preferred: { 'image.text2image': ['qwen-image-21-t2i'] } } }
eq((await resolveTieredManifest('image.text2image', 'quality', null, { ...none, ...prefCfg })).manifest.id, 'qwen-image-21-t2i-quality', 'preferred 家族序 → 命中 qwen 家族（quality）')
eq((await resolveTieredManifest('image.text2image', 'fast', null, { ...none, ...prefCfg })).manifest.id, 'qwen-image-21-t2i-fast', 'preferred 家族序 → 同家族的另一档也生效（fast）')

// 配置面 pin：钉死实现（工具面已无 workflow=，这是留给排障 / 基准脚本的通道）
eq((await resolveTieredManifest('image.text2image', 'balanced', null, { ...none, cfg: { pins: { 'image.text2image': 'qwen-image-21-t2i' } } })).manifest.id, 'qwen-image-21-t2i-balanced', 'pins 写家族名 → 钉到该家族本档实现')
eq((await resolveTieredManifest('image.text2image', 'balanced', null, { ...none, cfg: { pins: { 'image.text2image': 'flux-text2image-balanced' } } })).manifest.id, 'flux-text2image-balanced', 'pins 写实现 id → 直接命中')
threw = false
try { await resolveTieredManifest('image.text2image', 'quality', null, { ...none, cfg: { pins: { 'image.text2image': 'flux-text2image-fast' } } }) } catch { threw = true }
ok(threw, 'pins 跨档冲突 → 报错（钉实现不跨档）')

// 未分档能力请求档位 → **忽略档位 + 明确告警**（不再按 mode 名隐式挑实现）
const legacyRes = await resolveTieredManifest('image.from_video', 'quality', null, none)
eq(legacyRes.manifest.id, 'extract-frame', '未分档能力忽略请求档位')
ok(legacyRes.warnings.some((w) => w.includes('尚未分档')), '未分档能力给出明确告警（不静默）')

console.log('== 2) computeManifestSize ==')
const flux = reg.byId['flux-text2image-balanced']
const ref2vQ = reg.byId['minimax-h3-ref2v-quality']
const ref2vF = reg.byId['minimax-h3-ref2v-fast']
{
  const s = computeManifestSize(flux, null, 1344, 768, undefined)
  eq(s.w, 1344, 'flux 显式宽'); eq(s.h, 768, 'flux 显式高')
  const s2 = computeManifestSize(flux, null, 1000, 1000, undefined)
  eq(s2.w, 992, 'flux snap32 宽'); eq(s2.h, 992, 'flux snap32 高')
  const s3 = computeManifestSize(flux, null, undefined, undefined, undefined)
  eq(s3.w, 1344, 'flux default 宽'); eq(s3.h, 768, 'flux default 高')
}
{
  const s = computeManifestSize(ref2vQ, 'quality', undefined, undefined, '9:16')
  eq(s.w, 768, 'ref2v quality 9:16 宽'); eq(s.h, 1344, 'ref2v quality 9:16 高')
  const sf = computeManifestSize(ref2vF, 'fast', undefined, undefined, '9:16')
  eq(sf.w, 480, 'ref2v fast 9:16 宽'); eq(sf.h, 832, 'ref2v fast 9:16 高')
  const s169 = computeManifestSize(ref2vQ, 'quality', undefined, undefined, '16:9')
  eq(s169.w, 1344, 'ref2v quality 16:9 宽'); eq(s169.h, 768, 'ref2v quality 16:9 高')
}

console.log('== 2b) 只传一边宽高 → 按画布比例推导（P3 尾）')
{
  const q = reg.byId['qwen-image-21-t2i-quality']
  const s = computeManifestSize(q, 'quality', 1080, undefined, '9:16')
  eq(s.w, 1088, '只给 width：宽度 snap32（1080→1088）'); eq(s.h, 1920, '只给 width：高度按 9:16 推出')
  const s2 = computeManifestSize(q, 'quality', undefined, 1080, '16:9')
  eq(s2.h, 1088, '只给 height：高度 snap32（1080→1088）'); eq(s2.w, 1920, '只给 height：宽度按 16:9 推出')
  const s3 = computeManifestSize(q, 'quality', 1080, undefined, undefined)
  eq(s3.h, 608, '无画布比例 → 用本档 default 比例（2048×1152 ⇒ 1080/1.777=607.5→608）')
}

console.log('== 2c) 交付尺寸如实记账：probeImageSize（P4）')
{
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.write('IHDR', 12, 'latin1'); buf.writeUInt32BE(1536, 16); buf.writeUInt32BE(2752, 20)
  const f = join(tmpdir(), 'svs-probe-test.png')
  writeFileSync(f, buf)
  const size = _internals.probeImageSize(f)
  eq(size.w, 1536, 'PNG 宽'); eq(size.h, 2752, 'PNG 高')
  eq(_internals.probeImageSize(join(tmpdir(), 'svs-nonexistent.png')), null, '读不出 → null（不猜）')
  rmSync(f, { force: true })
}

console.log('== 2d) 调用面契约：workflow= 在 runner 层必须报错（P2）')
{
  let threw2 = false
  try { _internals.explicitImplementationOf({ workflow: 'qwen-image-21-t2i-quality' }) } catch { threw2 = true }
  ok(threw2, '收到 workflow= → 报错（旧调用点不许静默生效）')
  eq(_internals.explicitImplementationOf({ implementation: ' video-upscale-x2 ' }), 'video-upscale-x2', '内部通道 implementation= 生效（去空格）')
  eq(_internals.explicitImplementationOf({}), null, '不传 → null（走配置解析）')
}

console.log('== 2e) 矩阵 effective == runner 解析（设置页显示的「实际生效」不得撒谎）')
{
  const cfg = { preferred: { 'image.text2image': ['qwen-image-21-t2i'] }, pins: { 'image.image2image': 'qwen-image-21-i2i' } }
  const matrix = await _internals.describeTierMatrix(reg, { probe: false, cfg })
  for (const tier of ['fast', 'balanced', 'quality']) {
    const r1 = await resolveTieredManifest('image.text2image', tier, null, { ...none, cfg })
    eq(matrix['image.text2image'].effective[tier], r1.manifest.id, `effective[${tier}] == runner（preferred 家族序）`)
    const r2 = await resolveTieredManifest('image.image2image', tier, null, { ...none, cfg })
    eq(matrix['image.image2image'].effective[tier], r2.manifest.id, `effective[${tier}] == runner（pins 钉实现）`)
  }
}

console.log('== 3) buildRenderGraph ==')
{
  const { mode, job, graph } = buildRenderGraph(ref2vQ, { prompt: 'p', mode: 'quality', refs: ['a.png'], prefix: 'x' }, '16:9')
  eq(mode, 'quality', 'mode=quality')
  eq(job.width, 1344, 'quality 宽'); eq(job.height, 768, 'quality 高')
  eq(job.steps, 20, 'quality 步数 20')
  ok(Array.isArray(graph['5'].inputs['ref_images.ref_image_0']), 'refs 注入为连线')
}
{
  const { mode, job, graph } = buildRenderGraph(ref2vF, { prompt: 'p', mode: 'fast', refs: ['a.png'], prefix: 'x' }, '16:9')
  eq(mode, 'fast', 'mode=fast')
  eq(job.width, 832, 'fast 宽'); eq(job.height, 480, 'fast 高')
  eq(job.steps, 4, 'fast 步数 4')
  ok(Object.values(graph).some((n) => n.class_type === 'LoraLoaderModelOnly'), 'fast 插入 LoRA')
}
{
  // 显式 steps 覆盖 mode 默认
  const { job } = buildRenderGraph(ref2vQ, { prompt: 'p', mode: 'quality', steps: 30, prefix: 'x' }, '16:9')
  eq(job.steps, 30, '显式 steps 覆盖 mode 默认')
}

console.log('')
if (failures) { console.error(`✗ 失败 ${failures} 项`); process.exit(1) }
else console.log('✓ 全部通过：M2 通用渲染纯逻辑正确')
