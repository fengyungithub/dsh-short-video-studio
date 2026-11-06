/**
 * scripts/smoke-crop.mjs — 图片裁切（capability=image.crop）冒烟测试。
 *
 * 覆盖（不触网、不提交 ComfyUI 任务）：
 *  1) computeCropRect：面板均分 / 显式矩形 / 越界收敛 / 非法尺寸报错；
 *  2) 清单：image-crop 通过校验、能力在词汇表里、buildGraphFromManifest 把裁切矩形注入到 ImageCrop；
 *  3) 工具面：image_crop 已注册、必填 image_node、走 runCrop（不是 runRender）；
 *  4) 通用入口：comfy_render 的 image.crop 分支存在（后处理能力不落到生成图逻辑）；
 *  5) 三视图定妆图口径：2048×1152 三格 → 每格 682×1152（对应 quality 档的角色卡单视图）。
 *
 * 用法：node scripts/smoke-crop.mjs
 */

// 测试隔离：不读本机 ~/.dsh 里的真实配置
process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || '/nonexistent/svs-smoke-config.json'

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBuiltinManifests, buildGraphFromManifest, validateManifest } from '../lib/manifest.js'
import { _internals } from '../lib/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'lib/index.js'), 'utf8')
let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
const throws = (name, fn, match) => {
  try { fn(); ok(name, false, '没有抛错') } catch (e) { ok(name, !match || String(e.message).includes(match), String(e.message)) }
}

const { computeCropRect, makeTools, resolveTieredManifest } = _internals

console.log('== 1) computeCropRect：面板均分 ==')
eq('2048×1152 三格 → 第 0 格（正面）', computeCropRect({ srcW: 2048, srcH: 1152 }), { x: 0, y: 0, w: 682, h: 1152 })
eq('panel=1（侧面）', computeCropRect({ srcW: 2048, srcH: 1152, panel: 1 }), { x: 682, y: 0, w: 682, h: 1152 })
eq('panel=2（背面）', computeCropRect({ srcW: 2048, srcH: 1152, panel: 2 }), { x: 1364, y: 0, w: 682, h: 1152 })
eq('1344×768 三格 → 448×768', computeCropRect({ srcW: 1344, srcH: 768 }), { x: 0, y: 0, w: 448, h: 768 })
eq('1024×576 三格 → 341×576', computeCropRect({ srcW: 1024, srcH: 576 }), { x: 0, y: 0, w: 341, h: 576 })
eq('panel 越界 → 夹到最后一格', computeCropRect({ srcW: 1344, srcH: 768, panel: 99 }), { x: 896, y: 0, w: 448, h: 768 })
eq('panel 负数 → 夹到第 0 格', computeCropRect({ srcW: 1344, srcH: 768, panel: -5 }), { x: 0, y: 0, w: 448, h: 768 })
eq('panels=2 竖切一半', computeCropRect({ srcW: 1000, srcH: 800, panels: 2, panel: 1 }), { x: 500, y: 0, w: 500, h: 800 })

console.log('== 2) computeCropRect：显式矩形与越界收敛 ==')
eq('显式矩形原样通过', computeCropRect({ srcW: 2048, srcH: 1152, x: 10, y: 20, width: 300, height: 400 }), { x: 10, y: 20, w: 300, h: 400 })
eq('只给 width → 高取满', computeCropRect({ srcW: 2048, srcH: 1152, width: 700 }), { x: 0, y: 0, w: 700, h: 1152 })
eq('x 越界 → 贴边', computeCropRect({ srcW: 2048, srcH: 1152, x: 2000, width: 300 }), { x: 1748, y: 0, w: 300, h: 1152 })
eq('width 超过源图 → 收敛到源图宽', computeCropRect({ srcW: 2048, srcH: 1152, width: 9999 }), { x: 0, y: 0, w: 2048, h: 1152 })
eq('y 越界 → 贴边', computeCropRect({ srcW: 800, srcH: 600, y: 900, height: 100 }), { x: 0, y: 500, w: 266, h: 100 })
throws('源尺寸缺失 → 报错（带修法）', () => computeCropRect({}), '源图尺寸非法')
throws('裁切宽为 0 → 报错', () => computeCropRect({ srcW: 800, srcH: 600, width: 0, height: 0 }), '裁切尺寸非法')

console.log('== 3) 清单：image.crop → image-crop ==')
const reg = loadBuiltinManifests(join(root, 'workflows'))
const m = reg.byId['image-crop']
ok('清单已加载', Boolean(m))
eq('能力', m.capability, 'image.crop')
eq('输出媒体类型', m.output.mediaType, 'image')
ok('未分档（无 tier 声明）', m.tier === undefined)
ok('校验通过', validateManifest(m, 'image-crop').ok, JSON.stringify(validateManifest(m, 'image-crop').errors))
const graph = buildGraphFromManifest(m, { source_image: 'canvas/x/ref.png', crop_x: 682, crop_y: 0, crop_width: 682, crop_height: 1152, prefix: 'canvas/s/out' })
eq('LoadImage 拿到上传文件名', graph['1'].inputs.image, 'canvas/x/ref.png')
eq('ImageCrop 矩形注入完整', [graph['2'].inputs.x, graph['2'].inputs.y, graph['2'].inputs.width, graph['2'].inputs.height], [682, 0, 682, 1152])
eq('ImageCrop 输入是连线', graph['2'].inputs.image, ['1', 0])
eq('SaveImage 前缀注入', graph['3'].inputs.filename_prefix, 'canvas/s/out')

console.log('== 4) 档位解析：未分档能力按唯一实现 ==')
const pick = await resolveTieredManifest('image.crop', null, null, { registry: reg })
eq('解析到 image-crop', pick.manifest.id, 'image-crop')
eq('tier 为 null（不编一个档位出来）', pick.tier, null)

console.log('== 5) 工具面：image_crop 注册与路由 ==')
const tools = makeTools()
const crop = tools.find((t) => t.name === 'image_crop')
ok('image_crop 已注册', Boolean(crop))
eq('必填 image_node', crop.parameters.required, ['image_node'])
ok('支持面板参数', ['panel', 'panels'].every((k) => Boolean(crop.parameters.properties[k])))
ok('支持角色卡配对参数', ['character', 'card_variant', 'paired_node_id'].every((k) => Boolean(crop.parameters.properties[k])))
ok('execute 走 runCrop', /runCrop\(ctx/.test(String(crop.execute)))
ok('image.crop 免提示词', _internals.isPromptFreeCapability('image.crop') === true)
ok('comfy_render 有 image.crop 分支', /args\.capability === 'image\.crop'/.test(src) && /runCrop\(ctx, \{ \.\.\.args, exec \}\)/.test(src))
ok('apply() 注册顺序未被打乱（工具里含 image_crop）', /cropTool, recordCheckTool/.test(src))

console.log('== 6) 三视图定妆图口径（角色卡单视图 = 正面格）==')
const qualitySheet = computeCropRect({ srcW: 2048, srcH: 1152 })
eq('quality 单视图 = 682×1152', `${qualitySheet.w}×${qualitySheet.h}`, '682×1152')
ok('quality 单视图比例 ≈ 0.59（比 2:3 略窄）', Math.abs(qualitySheet.w / qualitySheet.h - 0.592) < 0.01)
const balancedSheet = computeCropRect({ srcW: 1344, srcH: 768 })
eq('balanced 单视图 = 448×768', `${balancedSheet.w}×${balancedSheet.h}`, '448×768')
const fastSheet = computeCropRect({ srcW: 1024, srcH: 576 })
eq('fast 单视图 = 341×576', `${fastSheet.w}×${fastSheet.h}`, '341×576')
ok('裁切不改变像素网格（宽高都是整数、不出 32 对齐要求）', Number.isInteger(fastSheet.w) && Number.isInteger(fastSheet.h))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
