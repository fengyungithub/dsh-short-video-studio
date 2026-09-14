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

console.log('== 1) resolveManifest ==')
eq(resolveManifest(reg, 'image.text2image').id, 'flux-text2image', 'image.text2image 默认')
// P2 之后视频能力已分档：隐式默认改由 resolveTieredManifest 解析（缺省 quality 档），
// resolveManifest 只服务「未分档能力」与显式 id 查找。
const { resolveTieredManifest } = _internals
// selection 注入空对象：断言的是「无配置选择时的解析规则」，不继承本机已保存的策略
// cfg 也注入空对象：本机配置里若存了用户自建策略（如只提供 balanced），会改变"未指定档位"的解析结果
const none = { registry: reg, probe: false, selection: {}, cfg: {} }
eq((await resolveTieredManifest('video.reference2video', null, null, none)).manifest.id, 'minimax-h3-ref2v-quality', 'video.reference2video 缺省 → quality 档（STANDARD）')
eq((await resolveTieredManifest('video.reference2video', 'balanced', null, none)).manifest.id, 'minimax-h3-ref2v-balanced', 'balanced 档默认取无加速实现（加速件需显式选择）')
eq((await resolveTieredManifest('video.reference2video', 'balanced', null, { ...none, selection: { balanced: 'minimax-h3-ref2v-balanced-sol' } })).manifest.id, 'minimax-h3-ref2v-balanced-sol', '注入配置选择 → 用加速实现')
eq((await resolveTieredManifest('video.image2video', 'fast', null, { ...none })).manifest.id, 'minimax-h3-i2v-fast', 'video.image2video fast 档')
eq((await resolveTieredManifest('video.reference2video', 'quality', 'minimax-h3-ref2v-quality', { ...none })).manifest.id, 'minimax-h3-ref2v-quality', '显式 workflow 命中')
let threw = false
try { resolveManifest(reg, 'image.text2image', 'minimax-h3-ref2v-quality') } catch { threw = true }
ok(threw, '能力不匹配抛错')
threw = false
try { resolveManifest(reg, 'image.text2image', 'nonexistent') } catch { threw = true }
ok(threw, '不存在 workflow 抛错')

console.log('== 2) computeManifestSize ==')
const flux = reg.byId['flux-text2image']
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
