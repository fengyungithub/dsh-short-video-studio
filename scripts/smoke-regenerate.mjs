/**
 * scripts/smoke-regenerate.mjs — 视频重生成（capability=video.regenerate）冒烟测试。**不跑 GPU、不连 ComfyUI。**
 *
 * 锁住的语义（与 video.upscale 的差异正是本能力的要害）：
 *  1) 清单契约：目标网格（graph/delivery）是**声明**的，尺寸不来自源片；不得声明 upscale / resolutionLock；
 *     护栏（24fps / 帧数区间 / 必须有提示词）也由清单声明
 *  2) 目标解析：横/竖版自动翻转；只有 **graph** 必须 32 对齐（delivery 是裁切后的 1080/2160）
 *  3) 源片护栏：低于/高于训练帧数区间、非 24fps、没有 prompt ⇒ 显式报错并给修法；读不出 fps ⇒ 告警不拦
 *  4) 图编译：源视频 / 提示词 / 图内尺寸 / 音频模式 / 种子 / 前缀都落到正确节点；无残留哨兵；
 *     帧数与音轨的接线（PrepareDraft.frame_count → Finish；源音轨 → Refine/Finish → CreateVideo）
 *  5) 校验器 fail-closed：缺 regenerate 块、graph 不对齐、delivery > graph、默认目标不存在、
 *     缺注入点、误声明 upscale/resolutionLock
 *  6) 注册表集成：能力进词汇表；quality 档解析到本清单；priority<0（不做隐式替代品）；工具已注册
 *
 * 用法：node scripts/smoke-regenerate.mjs
 */
import { _internals } from '../lib/index.js'
import { validateManifest, buildGraphFromManifest, CAPABILITIES } from '../lib/manifest.js'
import { planRegenerate, resolveRegenerateTarget, normalizeRegenerateTargets, decideRegenerateHandoff, REGENERATE_ALIGN } from '../lib/regenerate.js'

const I = _internals
let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, got === want, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
const throws = (name, fn, re) => {
  let err = null
  try { fn() } catch (e) { err = e }
  ok(name, !!err && (!re || re.test(String(err.message || err))), err ? String(err.message || err) : '没有抛错')
}
const clone = (x) => JSON.parse(JSON.stringify(x))

const reg = I.getRegistry()
const ID = 'open-h3-regenerate-2k'
const m = reg.byId[ID]

console.log('\n[1] 清单契约：目标网格是声明的，尺寸不来自源片；护栏也是声明的')
ok(`${ID} 已注册`, Boolean(m))
eq('capability=video.regenerate', m?.capability, 'video.regenerate')
eq('tier=quality', m?.tier, 'quality')
ok('priority<0（不做隐式默认）', Number(m?.priority) < 0, String(m?.priority))
ok('不声明 upscale（尺寸语义与超分相反）', m?.upscale === undefined)
ok('不声明 resolutionLock（尺寸由目标网格给）', m?.resolutionLock === undefined)
ok('regenerate.targets 有 1080p / 2k', ['1080p', '2k'].every((k) => m?.regenerate?.targets?.[k]))
eq('默认目标 = 2k', m?.regenerate?.default, '2k')
eq('训练帧率声明 = 24', m?.regenerate?.inputFps, 24)
ok('帧数区间 = 121–362', m?.regenerate?.minFrames === 121 && m?.regenerate?.maxFrames === 362,
  `${m?.regenerate?.minFrames}–${m?.regenerate?.maxFrames}`)
eq('requiresPrompt=true', m?.regenerate?.requiresPrompt, true)
ok('1080p 图内网格 1920×1088（32 对齐，比交付多 8 行）', JSON.stringify(m?.regenerate?.targets?.['1080p']?.graph) === '[1920,1088]')
ok('1080p 交付 1920×1080（裁回标准分辨率）', JSON.stringify(m?.regenerate?.targets?.['1080p']?.delivery) === '[1920,1080]')
for (const p of ['source_video', 'prompt', 'width', 'height', 'seed', 'prefix', 'audio_mode']) {
  ok(`声明注入点 params.${p}`, Boolean(m?.params?.[p]))
}
eq('source_video 走 video 注入（LoadVideo.file）', m?.params?.source_video?.inject, 'video')
const assetKeys = Object.keys(m?.assets || {})
for (const k of ['regenerate_lora', 'sharp_curves', 'curve_table', 'latent_upscaler', 'vae_decode', 'unet', 'audio_vae']) {
  ok(`资产槽 ${k}`, assetKeys.includes(k), assetKeys.join(','))
}
for (const n of ['OpenH3RegenLora', 'OpenH3RegenRefineLatent', 'OpenH3RegenFinish', 'OpenH3RegenPrepareDraft', 'OpenH3RegenSigmas']) {
  ok(`requiresNodes 含 ${n}`, m?.requiresNodes?.includes(n), JSON.stringify(m?.requiresNodes))
}

console.log('\n[2] 目标解析：方向翻转 + 只有图内网格要 32 对齐')
{
  const t = m.regenerate.targets
  const land = resolveRegenerateTarget({ targets: t, target: '2k' })
  eq('2k 横版 graph 宽', land.graph[0], 2560)
  eq('2k 横版 graph 高', land.graph[1], 1440)
  const port = planRegenerate({ srcW: 768, srcH: 1344, frames: 124, fps: 24, targets: t, target: '2k', guards: m.regenerate })
  ok('2k 竖版翻转 → 1440×2560', port.graph.w === 1440 && port.graph.h === 2560, JSON.stringify(port.graph))
  ok('竖版标记 portrait', port.portrait === true)
  const h = planRegenerate({ srcW: 1344, srcH: 768, frames: 124, fps: 24, targets: t, target: '1080p', guards: m.regenerate })
  ok('1080p 图内网格 1920×1088', h.graph.w === 1920 && h.graph.h === 1088, JSON.stringify(h.graph))
  ok('1080p 交付 1920×1080', h.delivery.w === 1920 && h.delivery.h === 1080, JSON.stringify(h.delivery))
  const hl = planRegenerate({ srcW: 768, srcH: 1344, frames: 124, fps: 24, targets: t, target: '1080p', guards: m.regenerate })
  ok('1080p 竖版：图 1088×1920 / 交付 1080×1920',
    hl.graph.w === 1088 && hl.graph.h === 1920 && hl.delivery.w === 1080 && hl.delivery.h === 1920,
    JSON.stringify({ graph: hl.graph, delivery: hl.delivery }))
  const def = planRegenerate({ srcW: 1344, srcH: 768, frames: 124, fps: 24, targets: t, guards: m.regenerate })
  eq('未指定 target → 用清单默认', def.target, '2k')
  throws('未知目标报错并列出可选项', () => resolveRegenerateTarget({ targets: t, target: '8k' }), /可选 1080p \/ 2k/)
  const norm = normalizeRegenerateTargets(t)
  ok('normalize 返回浅拷贝（改它不污染清单）', norm['2k'].graph !== t['2k'].graph)
}

console.log('\n[3] 源片护栏：跑在分布外必须报错，不静默降级')
{
  const t = m.regenerate.targets
  const base = { srcW: 1344, srcH: 768, targets: t, target: '2k', guards: m.regenerate, hasPrompt: true }
  throws('120 帧 < 121 → 报错并给修法', () => planRegenerate({ ...base, frames: 120, fps: 24 }), /低于重生成实现的训练区间[\s\S]*video_upscale/)
  throws('363 帧 > 362 → 报错并提示逐镜拆开', () => planRegenerate({ ...base, frames: 363, fps: 24 }), /超过重生成实现的上限[\s\S]*按分镜拆开/)
  throws('30fps → 报错并给补帧修法', () => planRegenerate({ ...base, frames: 124, fps: 30 }), /只训练过 24fps[\s\S]*video_interpolate/)
  throws('没有 prompt → 报错', () => planRegenerate({ ...base, frames: 124, fps: 24, hasPrompt: false }), /需要提示词/)
  const okPlan = planRegenerate({ ...base, frames: 124, fps: 24 })
  eq('124 帧 / 24fps 通过', okPlan.frames, 124)
  eq('121 帧（下边界）通过', planRegenerate({ ...base, frames: 121, fps: 24 }).frames, 121)
  eq('362 帧（上边界）通过', planRegenerate({ ...base, frames: 362, fps: 24 }).frames, 362)
  const noFps = planRegenerate({ ...base, frames: 124, fps: null })
  ok('读不出 fps → 告警但放行', noFps.warnings.some((w) => /读不出源片帧率/.test(w)), JSON.stringify(noFps.warnings))
  const big = planRegenerate({ ...base, srcW: 2688, srcH: 1536, frames: 124, fps: 24 })
  ok('源片 >768p → 告警「先降采样再重画」', big.warnings.some((w) => /高于 768p/.test(w)), JSON.stringify(big.warnings))
  const small = planRegenerate({ ...base, srcW: 832, srcH: 480, frames: 124, fps: 24 })
  ok('源片 <720p → 告警「草稿信息少」', small.warnings.some((w) => /低于 768p/.test(w)), JSON.stringify(small.warnings))
  ok('REGENERATE_ALIGN = 32', REGENERATE_ALIGN === 32)
}

console.log('\n[4] 图编译：注入点都落到正确节点，没有残留哨兵')
{
  const job = {
    mode: null, assetOverrides: {},
    source_video: 'draft.mp4',
    prompt: 'A fox trots through snow.',
    width: 2560, height: 1440,
    seed: 42,
    audio_mode: 'draft audio (AUDIO input)',
    steps: 3, start_sigma: 0.8,
    prefix: 'canvas/abc',
  }
  const g = buildGraphFromManifest(m, job)
  eq('节点数 23', Object.keys(g).length, 23)
  eq('LoadVideo.file = 上传后的源片', g['1'].inputs.file, 'draft.mp4')
  eq('提示词落到 CLIPTextEncode.text', g['11'].inputs.text, 'A fox trots through snow.')
  eq('图内目标宽 2560（不是交付尺寸推导）', g['6'].inputs.width, 2560)
  eq('图内目标高 1440', g['6'].inputs.height, 1440)
  eq('音频模式注入（源音轨 mask 在 σ=0）', g['7'].inputs.audio_mode, 'draft audio (AUDIO input)')
  eq('种子落到 RandomNoise', g['13'].inputs.noise_seed, 42)
  eq('start_sigma 注入重生成 sigma 节点', g['12'].inputs.start_sigma, 0.8)
  eq('步数 3', g['12'].inputs.steps, 3)
  eq('前缀落到 SaveVideo', g['21'].inputs.filename_prefix, 'canvas/abc')
  ok('LoRA 文件名已解析', /open_h3_regenerate_2k_lora\.safetensors$/.test(g['9'].inputs.lora_name), g['9'].inputs.lora_name)
  ok('曲线分支文件名已解析', /sharp_curve_branches\.safetensors$/.test(g['9'].inputs.curve_name), g['9'].inputs.curve_name)
  ok('曲线表来自 pruned checkpoint', /ref2va_pruned/.test(g['9'].inputs.curve_table), g['9'].inputs.curve_table)
  ok('放大器文件名已解析', /latent_upscaler_3d_conv_v1/.test(g['5'].inputs.model_name), g['5'].inputs.model_name)
  ok('快解码器走独立 VAELoader（不覆盖编码 VAE）', g['17'].inputs.vae_name === 'sol_h3_vae.safetensors' && g['22'].inputs.vae_name !== g['17'].inputs.vae_name,
    JSON.stringify({ decode: g['17'].inputs.vae_name, encode: g['22'].inputs.vae_name }))
  ok('REFINED latent 进 SamplerCustomAdvanced', JSON.stringify(g['16'].inputs.latent_image) === '["7",0]')
  ok('帧数接线 PrepareDraft.frame_count → Finish', JSON.stringify(g['19'].inputs.frame_count) === '["3",1]')
  ok('Finish 吃源音轨（按保留帧数裁剪）', JSON.stringify(g['19'].inputs.audio) === '["2",1]')
  ok('CreateVideo 用 Finish 裁好的音轨', JSON.stringify(g['20'].inputs.audio) === '["19",1]')
  ok('取景/裁剪尺寸来自图内网格（Finish 裁 1088→1080）', /1088 -> 1080/.test(g['19'].inputs.crop), g['19'].inputs.crop)
  // 无残留哨兵：$assets / ${} / null
  let sentinel = []
  const walk = (v, path) => {
    if (typeof v === 'string' && /\$assets\.|\$\{[^}]*\}/.test(v)) sentinel.push(path + '=' + v)
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, path + '[' + i + ']'))
    else if (v === null) sentinel.push(path + '=null')
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path + '.' + k)
  }
  for (const [id, n] of Object.entries(g)) walk(n.inputs, id)
  ok('图里没有残留哨兵 / 未注入的空值', sentinel.length === 0, sentinel.join('; '))
  const dangling = []
  for (const [id, n] of Object.entries(g)) {
    for (const [k, v] of Object.entries(n.inputs || {})) {
      if (Array.isArray(v) && !g[v[0]] && v[0] !== '$model') dangling.push(`${id}.${k}→${v[0]}`)
    }
  }
  ok('所有连线都指向存在的节点', dangling.length === 0, dangling.join('; '))
}

console.log('\n[5] 校验器 fail-closed')
{
  const bad = (mutate, re, label) => {
    const c = clone(m)
    mutate(c)
    const v = validateManifest(c, 'test')
    ok(label, !v.ok && v.errors.some((e) => re.test(e)), v.ok ? '校验通过（不应通过）' : v.errors.join(' | '))
  }
  bad((c) => { delete c.regenerate }, /必须声明 regenerate 块/, '缺 regenerate 块 → 拒绝')
  bad((c) => { c.regenerate.targets['2k'].graph = [2561, 1440] }, /graph 的宽高必须按 32 对齐/, '图内网格不对齐 32 → 拒绝')
  bad((c) => { c.regenerate.targets['2k'].delivery = [3000, 1440] }, /delivery 不能大于 graph/, '交付大于图内网格 → 拒绝')
  bad((c) => { c.regenerate.targets['2k'].delivery = [2560] }, /delivery 必须是 \[宽, 高\]/, '交付尺寸形状非法 → 拒绝')
  bad((c) => { c.regenerate.default = '8k' }, /default 必须是 targets 里的一个名字/, '默认目标不存在 → 拒绝')
  bad((c) => { c.regenerate.inputFps = 0 }, /inputFps 必须是正数/, 'inputFps 非正 → 拒绝')
  bad((c) => { c.regenerate.minFrames = 400 }, /minFrames 不能大于 maxFrames/, '帧数区间倒置 → 拒绝')
  bad((c) => { delete c.params.prompt }, /必须声明 params\.prompt/, '缺提示词注入点 → 拒绝')
  bad((c) => { c.upscale = { sizing: 'factor', factor: 2 } }, /不应声明 upscale 块/, '误声明 upscale → 拒绝')
  bad((c) => { c.resolutionLock = { scale: 2 } }, /不应声明 resolutionLock/, '误声明 resolutionLock → 拒绝')
  bad((c) => { c.capability = 'video.upscale' }, /capability=video\.upscale/, '能力改成 upscale 后按超分契约校验（缺 upscale 块）→ 拒绝')
  // latent 入口的清单：缺 latent_file 注入点 / input 写错都要拒绝
  const bl = reg.byId['open-h3-regenerate-2k-latent']
  {
    const c = clone(bl)
    delete c.params.latent_file
    const v = validateManifest(c, 'test')
    ok('latent 入口缺 params.latent_file → 拒绝', !v.ok && v.errors.some((e) => /must declare params\.latent_file|必须声明 params\.latent_file/.test(e)), v.ok ? '校验通过（不应通过）' : v.errors.join(' | '))
    const c2 = clone(bl)
    c2.regenerate.input = 'frames'
    const v2 = validateManifest(c2, 'test')
    ok('regenerate.input 非法 → 拒绝', !v2.ok && v2.errors.some((e) => /input 只能是 video \| latent/.test(e)), v2.ok ? '校验通过（不应通过）' : v2.errors.join(' | '))
  }
}

console.log('\n[6] 注册表/工具集成')
{
  ok('video.regenerate 进能力词汇表', CAPABILITIES.includes('video.regenerate'))
  const list = reg.byCapability['video.regenerate'] || []
  const visible = list.filter((m) => !m.internal)
  ok('非内部实现都是视频入口（声明 regenerate + params.source_video）',
    visible.length >= 1 && visible.every((m) => m.regenerate && m.params?.source_video),
    visible.map((m) => m.id).join(','))
  const resolved = await I.resolveTieredManifest('video.regenerate', 'quality', null, { registry: reg })
  eq('quality 档仍解析到 C（dense 是默认；B 实验清单 internal、sol 变体 priority 更低）', resolved.manifest.id, ID)
  // Sol-Attn 变体：非 internal、设置页可选，但 priority 低于 base ⇒ 不抢隐式默认
  const solVar = reg.byId['open-h3-regenerate-2k-solattn']
  ok('sol 变体已注册且非 internal', Boolean(solVar) && !solVar.internal)
  ok('sol 变体 priority 低于 base（不改隐式默认）',
    Number(solVar?.priority) < Number(reg.byId[ID]?.priority), `${solVar?.priority} vs ${reg.byId[ID]?.priority}`)
  ok('sol 变体带 BlockSparseAttention',
    Object.values(solVar?.graph || {}).some((n) => n.class_type === 'BlockSparseAttention'))
  // B 实验（latent 交接）：清单在、标记 internal、入口是 latent_file
  const bLatent = reg.byId['open-h3-regenerate-2k-latent']
  ok('B 实验清单已注册', Boolean(bLatent))
  ok('B 实验清单是 internal（不进档位矩阵）', bLatent?.internal === true)
  eq('B 实验清单入口 = latent', bLatent?.regenerate?.input, 'latent')
  ok('B 实验清单声明 params.latent_file', Boolean(bLatent?.params?.latent_file))
  ok('B 实验清单不声明 params.source_video（不是视频入口）', !bLatent?.params?.source_video)
  // 草稿段（§9.5 已产品化）：不再单开 `-latent` 克隆，balanced 清单本身带旁路存 latent 节点。
  const draft = reg.byId['minimax-h3-ref2v-ctx-balanced-pika-solattn-solvae']
  ok('草稿段 = balanced 清单本身（已产品化，不是 internal 克隆）', Boolean(draft) && !draft.internal)
  ok('草稿段带 OpenH3SaveRefinedLatent（节点 24）', draft?.graph?.['24']?.class_type === 'OpenH3SaveRefinedLatent')
  ok('草稿段声明 latent_prefix / latent_frame_count 注入点',
    Boolean(draft?.params?.latent_prefix && draft?.params?.latent_frame_count))
  ok('草稿段不把交接节点写进 requiresNodes（可选依赖，缺包不误伤 balanced）',
    !(draft?.requiresNodes || []).includes('OpenH3SaveRefinedLatent'))
  const tool = I.makeTools().find((t) => t.name === 'video_regenerate')
  ok('工具 video_regenerate 已注册', Boolean(tool))
  ok('工具必填 video_node', JSON.stringify(tool?.parameters?.required) === '["video_node"]')
  for (const p of ['prompt', 'target', 'start_sigma', 'steps', 'tier', 'seed']) {
    ok(`工具参数 ${p}`, Boolean(tool?.parameters?.properties?.[p]))
  }
  ok('工具 output 有 render（缺了整插件不加载）', typeof tool?.output?.render === 'function')
  const rendered = tool.output.render({}, {
    ok: true, nodeId: 'n1', media: 'canvas/x.mp4', target: '2k',
    delivery: { w: 2560, h: 1440 }, frames: 124, backend: 'comfyui-regenerate',
    warnings: ['重生成会重画内容'], error: '',
  })
  ok('render 返回非空结果', rendered !== undefined && rendered !== null && (typeof rendered !== 'string' || rendered.length > 0))
}

console.log('\n[7] handoff 决策：auto 有 latent 才走，退也要说原因；显式 latent 不静默退')
{
  const cfg = { minFrames: 121, maxFrames: 362 }
  const good = { file: 'a_00001.safetensors', frames: 124, width: 1344, height: 768 }
  const tg = { w: 2560, h: 1440 }
  const d1 = decideRegenerateHandoff({ requested: 'auto', latent: good, cfg, targetGraph: tg, availableLatentFiles: ['a_00001.safetensors'] })
  eq('auto + 合法 latent → latent', d1.mode, 'latent')
  ok('mode=latent 的原因含文件名', /a_00001\.safetensors/.test(d1.reason), d1.reason)
  const d2 = decideRegenerateHandoff({ requested: 'auto', latent: { frames: 124 }, cfg, targetGraph: tg })
  eq('auto + 没有 latentFile → video', d2.mode, 'video')
  ok('退回原因写明「没有登记 latent」', /没有登记 draft latent/.test(d2.reason), d2.reason)
  const d3 = decideRegenerateHandoff({ requested: 'auto', latent: { ...good, frames: 400 }, cfg, targetGraph: tg })
  eq('auto + 帧数超上限 → video', d3.mode, 'video')
  ok('原因含「超过」', /超过/.test(d3.reason), d3.reason)
  const d4 = decideRegenerateHandoff({ requested: 'auto', latent: { ...good, frames: 100 }, cfg, targetGraph: tg })
  ok('帧数低于下限 → video 且原因含「低于」', d4.mode === 'video' && /低于/.test(d4.reason), d4.reason)
  const d5 = decideRegenerateHandoff({ requested: 'auto', latent: good, cfg, targetGraph: tg, availableLatentFiles: ['other.safetensors'] })
  ok('文件不在服务端 → video 且原因含「不在服务端」', d5.mode === 'video' && /不在服务端/.test(d5.reason), d5.reason)
  const d6 = decideRegenerateHandoff({ requested: 'auto', latent: { ...good, width: 2688, height: 1536 }, cfg, targetGraph: tg })
  ok('latent 比目标大（要降采样）→ video 且原因含「只升不降」', d6.mode === 'video' && /只升不降/.test(d6.reason), d6.reason)
  const d7 = decideRegenerateHandoff({ requested: 'auto', latent: good, cfg, targetGraph: tg, availableLatentFiles: null })
  eq('查不到文件列表（离线/节点缺失）→ 不据此判死，仍可用 latent', d7.mode, 'latent')
  eq('显式 video → video', decideRegenerateHandoff({ requested: 'video', latent: good, cfg }).mode, 'video')
  throws('显式 latent 但不合法 → 报错（不静默退）',
    () => decideRegenerateHandoff({ requested: 'latent', latent: { file: 'x.safetensors', frames: 100 }, cfg, targetGraph: tg }), /handoff=latent/)
  throws('handoff 写错 → 报错', () => decideRegenerateHandoff({ requested: 'auto2' }), /handoff 只能是/)
}

console.log('\n[8] balanced 清单都带 B 交接节点（可选依赖，不写进 requiresNodes）')
{
  const bal = (reg.byCapability['video.reference2video'] || []).concat(reg.byCapability['video.image2video'] || [])
    .filter((m) => m.tier === 'balanced')
  ok(`balanced 视频清单 ${bal.length} 份`, bal.length >= 20, String(bal.length))
  const noSave = bal.filter((m) => !Object.values(m.graph).some((n) => n.class_type === 'OpenH3SaveRefinedLatent'))
  ok('每份 balanced 清单都有 OpenH3SaveRefinedLatent', noSave.length === 0, noSave.map((m) => m.id).join(','))
  const withReq = bal.filter((m) => (m.requiresNodes || []).includes('OpenH3SaveRefinedLatent'))
  ok('都不把 save 节点写进 requiresNodes（可选依赖，没装包也不能拖垮 balanced）', withReq.length === 0, withReq.map((m) => m.id).join(','))
  const badParams = bal.filter((m) => !(m.params?.latent_prefix && m.params?.latent_frame_count))
  ok('都声明 latent_prefix / latent_frame_count 注入点', badParams.length === 0, badParams.map((m) => m.id).join(','))
  const badWire = bal.filter((m) => {
    const entry = Object.entries(m.graph).find(([, n]) => n.class_type === 'OpenH3SaveRefinedLatent')
    const [sid, node] = entry || ['', null]
    const samplerId = Object.entries(m.graph).find(([, n]) => n.class_type === 'SamplerCustomAdvanced')?.[0]
    const referenced = Object.entries(m.graph).some(([k, n]) => k !== sid && Object.values(n.inputs || {}).some((v) => Array.isArray(v) && v[0] === sid))
    return !node || node.inputs?.samples?.[0] !== samplerId || referenced
  })
  ok('save 节点接采样器输出、且是旁路（没人消费）', badWire.length === 0, badWire.map((m) => m.id).join(','))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
