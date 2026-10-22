/**
 * scripts/smoke-prompt-bank.mjs — 分档提示词库（prompt bank）与角色卡双版本元数据。
 *
 * 覆盖：
 *  1) 纯逻辑：解析 / 序列化 / 按 tier 取段（同档 → 最近较低档 → 较高档）/ 标题推导；
 *  2) 端到端（假 ComfyUI HTTP）：prompt_node 按 tier 取对应段；缺档回退并 warning；
 *     升档重渲读取 quality 段；只传 prompt 时自动持久化提示词库；同 nodeId 重渲免 prompt；
 *  3) 角色卡元数据：character / cardVariant / pairedNodeId 双向配对；显式 ref_variant 选版 + fast 只能单视图。
 *
 * 用法：node scripts/smoke-prompt-bank.mjs
 */

import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLibrary, registerAsset } from '../lib/assets.js'

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, String(got) === String(want), `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)

// ---------------------------------------------------------------- 假 ComfyUI
const requests = []
const uploads = []
let seq = 0
let imgSeq = 0
const png = Buffer.alloc(33)
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0)
png.write('IHDR', 12, 'latin1')
png.writeUInt32BE(2, 16)
png.writeUInt32BE(2, 20)

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => resolve(Buffer.concat(chunks)))
  req.on('error', reject)
})

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname.startsWith('/object_info/')) {
    const cls = decodeURIComponent(url.pathname.slice('/object_info/'.length))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ [cls]: {} }))
    return
  }
  if (url.pathname === '/upload/image' && req.method === 'POST') {
    const raw = await readBody(req)
    const m = /filename="([^"]+)"/.exec(raw.toString('latin1'))
    const filename = m ? m[1] : 'upload.png'
    uploads.push(filename)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name: filename, subfolder: '', type: 'input' }))
    return
  }
  if (url.pathname === '/prompt' && req.method === 'POST') {
    const raw = await readBody(req)
    const body = JSON.parse(raw.toString('utf8'))
    const graph = body.prompt || {}
    const isImage = Object.values(graph).some((n) => n.class_type === 'SaveImage')
    const id = 'p' + (++seq)
    requests.push({ id, isImage, graph, text: JSON.stringify(graph) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ prompt_id: id }))
    return
  }
  if (url.pathname.startsWith('/history/')) {
    const id = url.pathname.split('/').pop()
    const rec = requests.find((r) => r.id === id)
    const outputs = rec?.isImage
      ? { '9': { images: [{ filename: `img-${++imgSeq}.png`, subfolder: '', type: 'output' }] } }
      : { '9': { videos: [{ filename: `out-${id}.mp4`, subfolder: '', type: 'output' }] } }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ [id]: { status: { completed: true }, outputs } }))
    return
  }
  if (url.pathname === '/view') {
    const filename = url.searchParams.get('filename') || ''
    const buf = filename.endsWith('.png') ? png : Buffer.from('fake-mp4-bytes')
    res.writeHead(200, { 'content-type': filename.endsWith('.png') ? 'image/png' : 'video/mp4' })
    res.end(buf)
    return
  }
  res.writeHead(404)
  res.end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const HOME = mkdtempSync(join(tmpdir(), 'svs-prompt-bank-home-'))
process.env.HOME = HOME
process.env.DSH_SVS_CONFIG = join(HOME, 'config.json')
process.env.DSH_SVS_SKILL_REFRESH = 'off'
process.env.DSH_SVS_COMFY_URL = `http://127.0.0.1:${port}`
process.env.DSH_SVS_POLL_MS = '1'
process.env.DSH_SVS_TIMEOUT_MS = '5000'

const { apply, _internals } = await import('../lib/index.js')
const {
  parsePromptBank, serializePromptBank, resolvePromptForTier, promptBankTitleFor,
} = _internals

const root = mkdtempSync(join(tmpdir(), 'svs-prompt-bank-'))
const sessionId = 's-prompt'
const workspaceRegistry = {
  get: (id) => (String(id) === 'w' ? { id: 'w', path: root, sessionIds: [sessionId] } : undefined),
  list: () => [{ id: 'w', path: root, sessionIds: [sessionId] }],
  resolveByPath: async () => undefined,
}
const registered = []
const hostCtx = {
  webServer: { register: () => () => {} },
  tools: { register: (t) => { registered.push(t); return () => {} }, get: () => undefined },
  systemPrompt: { section: () => () => {} },
  workspaceRegistry,
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  on: () => () => {},
}
apply(hostCtx)

console.log('== 1) 纯逻辑：分档提示词库 ==')
eq('标题推导：S01 片段 → 提示词（分档）', promptBankTitleFor('S01 片段'), 'S01 提示词（分档）')
eq('标题推导：无后缀', promptBankTitleFor('S02'), 'S02 提示词（分档）')
eq('标题推导：升档后缀归一到同库', promptBankTitleFor('S01 片段·升档'), 'S01 提示词（分档）')
{
  const content = serializePromptBank({ title: 'S01 提示词（分档）', note: '同一镜头计划', tiers: { fast: 'FAST', quality: 'QUALITY' } })
  const bank = parsePromptBank(content)
  eq('roundtrip 标题', bank.title, 'S01 提示词（分档）')
  eq('roundtrip 段落顺序', Object.keys(bank.tiers).join(','), 'fast,quality')
  eq('roundtrip fast', bank.tiers.fast, 'FAST')
  eq('roundtrip quality', bank.tiers.quality, 'QUALITY')
  eq('roundtrip note', bank.note, '同一镜头计划')
}
{
  const bank = parsePromptBank('# 旧文本\n\n这是一段没有分档的提示词')
  eq('旧式单段文本 → raw', bank.raw, '# 旧文本\n\n这是一段没有分档的提示词')
  eq('旧式单段按原样使用', resolvePromptForTier(bank, 'quality').prompt.includes('没有分档'), true)
}
{
  const bank = parsePromptBank(serializePromptBank({ title: 't', tiers: { fast: 'F', quality: 'Q' } }))
  const q = resolvePromptForTier(bank, 'quality')
  eq('quality 精确命中', q.tierUsed, 'quality')
  eq('quality 不标记 fallback', q.fallback, false)
  const b = resolvePromptForTier(bank, 'balanced')
  eq('balanced 缺档 → 回退 fast', b.tierUsed, 'fast')
  eq('balanced 回退标记', b.fallback, true)
  eq('balanced 回退内容', b.prompt, 'F')
  const onlyHigh = resolvePromptForTier(parsePromptBank(serializePromptBank({ title: 't', tiers: { quality: 'Q' } })), 'fast')
  eq('fast 缺档且无低档 → 回退 quality', onlyHigh.tierUsed, 'quality')
  eq('fast 回退标记', onlyHigh.fallback, true)
}

console.log('== 2) 端到端：prompt_node 按 tier 读取 / 升档 / 自动持久化 ==')
const tools = Object.fromEntries(registered.map((t) => [t.name, t]))
const exec = { agent: { id: sessionId, session: { meta: { cwd: root } } } }
const base = { workspaceId: 'w', sessionId }
const project = () => JSON.parse(readFileSync(join(root, 'canvas', sessionId, 'project.json'), 'utf8'))

const bankWrite = await tools.canvas_write_prompt_bank.execute({
  ...base,
  title: 'S01 提示词（分档）',
  group: 'shot prompts',
  prompts: { fast: 'FAST_PROMPT', quality: 'QUALITY_PROMPT' },
}, exec)
eq('写入提示词库成功', Boolean(bankWrite.nodeId), true, bankWrite.error)
eq('写入的档位', bankWrite.tiers.join(','), 'fast,quality')

const mergeBank = await tools.canvas_write_prompt_bank.execute({
  ...base, title: 'Merge 提示词（分档）', group: 'shot prompts', prompts: { fast: 'MERGE_FAST' },
}, exec)
const mergeBank2 = await tools.canvas_write_prompt_bank.execute({
  ...base, title: 'Merge 提示词（分档）', group: 'shot prompts', nodeId: mergeBank.nodeId, prompts: { quality: 'MERGE_QUALITY' },
}, exec)
eq('单档更新：保留旧档', mergeBank2.tiers.join(','), 'fast,quality')
{
  const n = project().nodes.find((x) => x.id === mergeBank.nodeId)
  ok('单档更新：旧档正文未丢', String(n?.content || '').includes('MERGE_FAST'))
  ok('单档更新：新档正文已写', String(n?.content || '').includes('MERGE_QUALITY'))
}


const v1 = await tools.comfy_generate_video.execute({
  ...base, type: 'r2v', tier: 'fast', prompt_node: bankWrite.nodeId,
  title: 'S01 片段', group: 'shot clips', length: 124,
}, exec)
eq('fast 生成成功', v1.ok, true, v1.error)
eq('fast 使用 fast 段', requests.at(-1).text.includes('FAST_PROMPT'), true)
eq('fast 回写提示词库节点 id', v1.promptNodeId, bankWrite.nodeId)
{
  const n = project().nodes.find((x) => x.id === v1.nodeId)
  eq('视频节点记录 prompt_used_tier', n.params.prompt_used_tier, 'fast')
  eq('视频节点记录 prompt_tier', n.params.prompt_tier, 'fast')
}

const v2 = await tools.comfy_generate_video.execute({
  ...base, type: 'r2v', tier: 'quality', prompt_node: bankWrite.nodeId,
  title: 'S01 片段·升档', group: 'shot clips', length: 124,
}, exec)
eq('quality 升档生成成功', v2.ok, true, v2.error)
eq('升档后读取 quality 段', requests.at(-1).text.includes('QUALITY_PROMPT'), true)
eq('质量档不再回退', v2.promptFallback, '')

const v3 = await tools.comfy_generate_video.execute({
  ...base, type: 'r2v', tier: 'balanced', prompt_node: bankWrite.nodeId,
  title: 'S01 片段·balanced', group: 'shot clips', length: 124,
}, exec)
eq('balanced 缺档仍生成', v3.ok, true, v3.error)
eq('balanced 回退到 fast', v3.promptTier, 'fast')
eq('回退 warning 如实回报', (v3.warnings || []).some((w) => w.includes('没有 balanced 档')), true, JSON.stringify(v3.warnings))

const auto = await tools.comfy_generate_video.execute({
  ...base, type: 'r2v', tier: 'balanced', prompt: 'AUTO_PERSISTED_PROMPT',
  title: 'S02 片段', group: 'shot clips', length: 124,
}, exec)
eq('只传 prompt 也能生成', auto.ok, true, auto.error)
eq('自动创建提示词库并返回 id', Boolean(auto.promptNodeId), true)
{
  const n = project().nodes.find((x) => x.id === auto.promptNodeId)
  ok('自动提示词库是文本节点', n?.kind === 'text', n?.kind)
  eq('自动提示词库按实际档位落段', n?.params?.tiers?.join(','), 'balanced')
  ok('自动提示词库内容含本次 prompt', String(n?.content || '').includes('AUTO_PERSISTED_PROMPT'))
  const v = project().nodes.find((x) => x.id === auto.nodeId)
  eq('视频节点回指提示词库', v.params.prompt_node, auto.promptNodeId)
}

const rewrite = await tools.comfy_generate_video.execute({
  ...base, type: 'r2v', tier: 'quality', nodeId: auto.nodeId,
  title: 'S02 片段·升档', group: 'shot clips', length: 124,
}, exec)
eq('同 nodeId 升档：免 prompt 读回提示词库', rewrite.ok, true, rewrite.error)
eq('同 nodeId 升档回退 balanced 段', rewrite.promptTier, 'balanced')
eq('同 nodeId 升档仍用原 prompt', requests.at(-1).text.includes('AUTO_PERSISTED_PROMPT'), true)

const auto2 = await tools.comfy_generate_video.execute({
  ...base, type: 'r2v', tier: 'quality', prompt: 'AUTO_UPGRADE_PROMPT',
  title: 'S02 片段', group: 'shot clips', length: 124,
}, exec)
eq('同标题新 nodeId：生成成功', auto2.ok, true, auto2.error)
eq('同标题新 nodeId：复用同一提示词库', auto2.promptNodeId, auto.promptNodeId)
{
  const n = project().nodes.find((x) => x.id === auto.promptNodeId)
  ok('复用库已补 quality 段', String(n?.content || '').includes('AUTO_UPGRADE_PROMPT'))
  eq('复用库档位已扩展', n?.params?.tiers?.join(','), 'balanced,quality')
}

const upByTitle = await tools.comfy_generate_video.execute({
  ...base, type: 'r2v', tier: 'quality', title: 'S02 片段', group: 'shot clips', length: 124,
}, exec)
eq('新 nodeId 同标题：免 prompt 找回提示词库', upByTitle.ok, true, upByTitle.error)
eq('新 nodeId 同标题：复用同一库', upByTitle.promptNodeId, auto.promptNodeId)
eq('新 nodeId 同标题：读到 quality 段', requests.at(-1).text.includes('AUTO_UPGRADE_PROMPT'), true)

const readPrompt = await tools.canvas_get_prompt.execute({ ...base, nodeId: bankWrite.nodeId, tier: 'balanced' }, exec)
eq('canvas_get_prompt 回退档位', readPrompt.tierUsed, 'fast')
eq('canvas_get_prompt fallback 标记', readPrompt.fallback, true)
eq('canvas_get_prompt 返回 prompt', readPrompt.prompt, 'FAST_PROMPT')

console.log('== 2a) 角色卡双版本：按 STEP 0 选择显式传 ref_variant ==')
{
  const cardSingle = await tools.comfy_generate_image.execute({
    ...base, prompt: 'IMAGE_TEST ref single', tier: 'fast', title: 'Ref卡·单视图', group: 'character cards',
    character: 'Ref', card_variant: 'single', width: 672, height: 1024,
  }, exec)
  const cardThree = await tools.comfy_generate_image.execute({
    ...base, prompt: 'IMAGE_TEST ref three', tier: 'fast', title: 'Ref卡·三视图', group: 'character cards',
    character: 'Ref', card_variant: 'three', paired_node_id: cardSingle.nodeId, width: 1024, height: 576,
  }, exec)
  const singleName = cardSingle.media.split('/').pop()
  const threeName = cardThree.media.split('/').pop()

  uploads.length = 0
  const pickFast = await tools.comfy_generate_video.execute({
    ...base, type: 'r2v', tier: 'fast', prompt: 'REF_PICK_FAST', ref_nodes: [cardThree.nodeId], ref_variant: 'single',
    title: 'R01 片段', group: 'shot clips', length: 124,
  }, exec)
  eq('ref_variant=single + fast：生成成功', pickFast.ok, true, pickFast.error)
  eq('ref_variant=single + fast：三视图被换成单视图', uploads[0], singleName)
  {
    const n = project().nodes.find((x) => x.id === pickFast.nodeId)
    eq('视频节点记录实际 ref', n.params.ref_nodes[0], cardSingle.nodeId)
    eq('视频节点记录 ref_variant', n.params.ref_variant, 'single')
  }

  uploads.length = 0
  const pickQuality = await tools.comfy_generate_video.execute({
    ...base, type: 'r2v', tier: 'quality', prompt: 'REF_PICK_QUALITY', ref_nodes: [cardSingle.nodeId], ref_variant: 'three',
    title: 'R02 片段', group: 'shot clips', length: 124,
  }, exec)
  eq('ref_variant=three + quality：生成成功', pickQuality.ok, true, pickQuality.error)
  eq('ref_variant=three + quality：单视图被换成三视图', uploads[0], threeName)

  const fastThreeRejected = await tools.comfy_generate_video.execute({
    ...base, type: 'r2v', tier: 'fast', prompt: 'REF_FAST_THREE', ref_nodes: [cardThree.nodeId], ref_variant: 'three',
    title: 'R06 片段', group: 'shot clips', length: 124,
  }, exec)
  eq('fast + three：被拒绝', fastThreeRejected.ok, false)
  ok('  报错说明 fast 只能单视图', String(fastThreeRejected.error).includes('fast 档只支持单视图'), fastThreeRejected.error)

  // 跨会话资产：两版分别入库并带 character / cardVariant 元数据，资产 id 也能按显式 ref_variant 选版
  {
    const lib = loadLibrary(root)
    registerAsset(root, lib, {
      id: 'character:ref2', type: 'character', name: 'ref2',
      srcAbsPath: join(root, ...cardSingle.media.split('/')),
      meta: { character: 'Ref2', cardVariant: 'single' },
    })
    registerAsset(root, lib, {
      id: 'character:ref2/three', type: 'character', name: 'ref2', state: 'three',
      srcAbsPath: join(root, ...cardThree.media.split('/')),
      meta: { character: 'Ref2', cardVariant: 'three' },
    })
    uploads.length = 0
    const assetFast = await tools.comfy_generate_video.execute({
      ...base, type: 'r2v', tier: 'fast', prompt: 'REF_ASSET_FAST', ref_nodes: ['character:ref2/three'], ref_variant: 'single',
      title: 'R04 片段', group: 'shot clips', length: 124,
    }, exec)
    eq('资产 id + ref_variant=single + fast：生成成功', assetFast.ok, true, assetFast.error)
    ok('资产 id + ref_variant=single + fast：换成同角色单视图资产', uploads[0] === 'character-ref2.png', uploads.join(','))

    const mSingle = await tools.asset_to_canvas.execute({ ...base, id: 'character:ref2', group: 'character cards' }, exec)
    const mThree = await tools.asset_to_canvas.execute({ ...base, id: 'character:ref2/three', group: 'character cards' }, exec)
    eq('物化单视图带 cardVariant', project().nodes.find((n) => n.id === mSingle.nodeId)?.params?.cardVariant, 'single')
    eq('物化三视图带 cardVariant', project().nodes.find((n) => n.id === mThree.nodeId)?.params?.cardVariant, 'three')
    uploads.length = 0
    const materializedFast = await tools.comfy_generate_video.execute({
      ...base, type: 'r2v', tier: 'fast', prompt: 'REF_MATERIALIZED_FAST', ref_nodes: [mThree.nodeId], ref_variant: 'single',
      title: 'R05 片段', group: 'shot clips', length: 124,
    }, exec)
    eq('物化节点 + ref_variant=single + fast：生成成功', materializedFast.ok, true, materializedFast.error)
    ok('物化节点 + ref_variant=single + fast：按 character 找到单视图', uploads[0] === 'asset-character-ref2.png', uploads.join(','))
  }

  uploads.length = 0
  const forcedSingle = await tools.comfy_generate_video.execute({
    ...base, type: 'r2v', tier: 'quality', prompt: 'REF_FORCE_SINGLE', ref_nodes: [cardThree.nodeId], ref_variant: 'single',
    title: 'R03 片段', group: 'shot clips', length: 124,
  }, exec)
  eq('ref_variant=single 强制单视图：生成成功', forcedSingle.ok, true, forcedSingle.error)
  eq('ref_variant=single 强制单视图：上传的是单视图', uploads[0], singleName)
}

console.log('== 2c) 画布 state：characterCardVariant + fast 约束 ==')
{
  const setFast = await tools.canvas_set_state.execute({ ...base, mode: 'fast', characterCardVariant: 'three' }, exec)
  eq('state 写入成功', setFast.ok, true, setFast.error)
  ok('fast + three 被降级并告警', (setFast.warnings || []).some((w) => w.includes('fast')), JSON.stringify(setFast.warnings))
  const gotFast = await tools.canvas_get_state.execute({ ...base }, exec)
  eq('fast 档 state 强制 single', gotFast.settings.characterCardVariant, 'single')
  const setQuality = await tools.canvas_set_state.execute({ ...base, mode: 'quality', characterCardVariant: 'three' }, exec)
  eq('quality 档可写 three', setQuality.ok, true, setQuality.error)
  const gotQuality = await tools.canvas_get_state.execute({ ...base }, exec)
  eq('quality 档 state 保留 three', gotQuality.settings.characterCardVariant, 'three')
}

console.log('== 2b) H3 质检门从 prompt_node 取段校验 ==')
{
  const { makeH3PromptGateListener } = _internals
  const fullPrompt = `subject_definitions:
<Subject 1> is Mia.
summary:
[reference generation] Mia waves.
retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved.
detailed_description:
[Shot 1] Mia waves at the camera.
overall_soundscape:
Room tone.
non_diegetic_music:
N/A
`
  const gateBank = await tools.canvas_write_prompt_bank.execute({
    ...base,
    title: 'S09 提示词（分档）',
    group: 'shot prompts',
    prompts: { fast: '自由格式，没有结构化字段。', quality: fullPrompt },
  }, exec)
  const listener = makeH3PromptGateListener(hostCtx)
  const next = async () => ({ kind: 'allow' })
  const fastGate = await listener({ name: 'comfy_generate_video', arguments: { type: 'r2v', tier: 'fast', prompt_node: gateBank.nodeId }, agent: { id: sessionId } }, next)
  eq('fast 段缺 H3 字段 → deny', fastGate.kind, 'deny')
  ok('deny 原因列出缺失字段', String(fastGate.reason || '').includes('subject_definitions'))
  const qualityGate = await listener({ name: 'comfy_generate_video', arguments: { type: 'r2v', tier: 'quality', prompt_node: gateBank.nodeId }, agent: { id: sessionId + '-ok' } }, next)
  eq('quality 段结构完整 → allow', qualityGate.kind, 'allow')
}

console.log('== 3) 角色卡双版本元数据 ==')
const card1 = await tools.comfy_generate_image.execute({
  ...base, prompt: 'IMAGE_TEST single view', tier: 'fast', title: 'Mia 角色卡·单视图', group: 'character cards',
  character: 'Mia', card_variant: 'single', width: 672, height: 1024,
}, exec)
eq('单视图卡生成成功', card1.ok, true, card1.error)
const card2 = await tools.comfy_generate_image.execute({
  ...base, prompt: 'IMAGE_TEST three view', tier: 'fast', title: 'Mia 角色卡·三视图', group: 'character cards',
  character: 'Mia', card_variant: 'three', paired_node_id: card1.nodeId, width: 1024, height: 576,
}, exec)
eq('三视图卡生成成功', card2.ok, true, card2.error)
{
  const nodes = project().nodes
  const a = nodes.find((x) => x.id === card1.nodeId)
  const b = nodes.find((x) => x.id === card2.nodeId)
  eq('单视图卡 cardVariant', a.params.cardVariant, 'single')
  eq('三视图卡 cardVariant', b.params.cardVariant, 'three')
  eq('两卡同 character', `${a.params.character}/${b.params.character}`, 'Mia/Mia')
  eq('单视图卡回指三视图', a.params.pairedNodeId, card2.nodeId)
  eq('三视图卡回指单视图', b.params.pairedNodeId, card1.nodeId)
}

server.close()
rmSync(root, { recursive: true, force: true })
rmSync(HOME, { recursive: true, force: true })
console.log('')
if (fail) { console.error(`✗ 失败 ${fail} 项`); process.exit(1) }
else console.log('✓ 全部通过：分档提示词库与角色卡双版本元数据正确')
