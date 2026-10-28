/**
 * 冒烟：镜头表一致性门（plan gate）
 * 覆盖：镜头表解析（时长 / 台词 / 字幕 / 声线参考 / 剧本依据）
 *      + prompt↔表台词字幕逐字 + 时长 + 声线参考 + 画幅比例 + fast 档参考图形态
 *      + 转场 / 锚点 / 非镜头标题跳过 + 防死循环 + prompt_node 读取。
 * 用法：node scripts/smoke-plan-gate.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, _internals } from '../lib/index.js'

const {
  makePlanGateListener, parseShotTableContent, shotIdFromText, parseAspectRatio,
} = _internals

let passed = 0
function ok(cond, name) {
  assert.ok(cond, name)
  passed++
  console.log('  ok -', name)
}

// ---------- 0. 纯函数 ----------
console.log('# 镜头表解析')
const SHOT_TABLE = [
  '| 镜头编号 & 时长 | 连续性衔接 | 续接 | 参考锚点（空间+身份） | Hook 类型 | 镜头描述（每秒指令） | 音频与对白轨 |',
  '|---|---|---|---|---|---|---|',
  '| S01 / 5s | 开场 | 起链 | door-frame: 右侧 1/3 | setup | 剧本依据: B01 — 0–1s Mia 推门；1–5s 停下 | 模式: dialogue；对白: Mia（0–2s）：“我不去。”；口型: mouth-open；声线参考: voice:mia-01；音效: 门轴；BGM: N/A；字幕: 我不去。 |',
  '| S02 / 3s | 接 S01 | 接 S01 | 同上 | reveal | 剧本依据: B02, B03 — 0–3s 转身离开 | 模式: silent；对白: 无；口型: mouth-closed；声线参考: none；音效: 风；BGM: N/A；字幕: none |',
].join('\n')

{
  const parsed = parseShotTableContent(SHOT_TABLE)
  ok(parsed && parsed.shots.length === 2, '解析出两镜')
  const s1 = parsed.shots[0]
  ok(s1.shotId === 'S01' && s1.durationSec === 5, 'S01 镜头号 / 时长')
  ok(s1.mode === 'dialogue' && s1.dialogue === '我不去。', 'S01 对白（引号内、去时间备注）')
  ok(s1.subtitle === '我不去。', 'S01 字幕')
  ok(s1.voiceRef === 'voice:mia-01', 'S01 声线参考')
  ok(s1.beats.join(',') === 'B01', 'S01 剧本依据')
  const s2 = parsed.shots[1]
  ok(s2.mode === 'silent' && s2.subtitle === 'none' && s2.voiceRef === 'none', 'S02 静默 / 无字幕 / 无声线')
  ok(s2.beats.join(',') === 'B02,B03', 'S02 多 beat')

  ok(shotIdFromText('S03 片段') === 'S03', '标题取镜头号')
  ok(shotIdFromText('S03a 片段') === 'S03A', '带字母后缀的镜头号')
  ok(shotIdFromText('Mia 试镜') === '', '无镜头号标题返回空')
  ok(parseAspectRatio('9:16') === 9 / 16 && parseAspectRatio('16:9') === 16 / 9, '画幅比解析')
  ok(parseShotTableContent('| 镜号 | 内容 |\n|---|---|\n| S01 | x |') === null, '非七列表格返回 null')
}

// ---------- 1. 准备临时工作区 ----------
const root = mkdtempSync(join(tmpdir(), 'dsh-svs-plangate-'))
const sid = 'sid-plan'
const canvasDir = join(root, 'canvas', sid)
mkdirSync(canvasDir, { recursive: true })

function writeProject(nodes, settings = {}) {
  writeFileSync(join(canvasDir, 'project.json'), JSON.stringify({
    schemaVersion: 1,
    sessionId: sid,
    settings: { aspectRatio: '9:16', reviewMode: 'batch', shotGate: 'verdict', mode: 'balanced', ...settings },
    nodes,
  }), 'utf8')
}
function tableNode(id, order, content = SHOT_TABLE) {
  return { id, kind: 'table', title: '镜头表', group: 'shot table', content, status: 'ready', order }
}
function cardNode(id, order, variant) {
  return { id, kind: 'image', title: variant === 'three' ? 'Mia 三视图' : 'Mia 单视图', group: 'character cards', status: 'ready', order, params: { cardVariant: variant } }
}
function bankNode(id, order, body) {
  return { id, kind: 'text', title: 'S01 提示词（分档）', group: 'shot prompts', content: `# S01 提示词（分档）\n\n<!-- dsh-svs-prompt-bank v3 -->\n\n## quality\n\n${body}\n`, status: 'ready', order, params: { promptBank: true } }
}

// mock 宿主（apply 需要）：workspaceRegistry 指向临时 root，其余 no-op
const mockCtx = new Proxy({
  webServer: { register: () => () => {} },
  tools: { register: () => () => {}, get: () => undefined, execute: async () => ({}) },
  systemPrompt: { section: () => () => {} },
  workspaceRegistry: {
    get: (id) => (id === 'ws-plan' ? { id: 'ws-plan', path: root, sessionIds: [sid] } : undefined),
    list: () => [{ id: 'ws-plan', path: root, sessionIds: [sid] }],
  },
  effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
}, { get(target, prop) { return prop in target ? target[prop] : () => () => {} } })
apply(mockCtx)

const gate = makePlanGateListener({ workspaceRegistry: mockCtx.workspaceRegistry })
const next = () => ({ kind: 'allow' })
const agent = { id: `${sid}-other`, session: { id: sid, meta: { cwd: root } } }
const GOOD_PROMPT = '0–1s Mia 推门，说：“我不去。” 字幕：我不去。 <Audio 1>: reference - Mia 的声线。'
// 字幕与台词同文时，逐字检查由台词项覆盖；这里造一份「字幕文本与台词不同」的表，专门测字幕 diff。
const SUB_TABLE = SHOT_TABLE.replace('字幕: 我不去。', '字幕: 我不去了。')
let agentSeq = 0
/** 每次调用用独立 agent id，避免上一段的连续 deny 计数影响本段断言。 */
function gen(extra = {}) {
  const { __agent, ...rest } = extra
  const agentId = __agent || `${sid}-call-${++agentSeq}`
  return {
    name: 'comfy_generate_video',
    arguments: {
      type: 'r2v', tier: 'balanced', title: 'S01 片段', prompt: GOOD_PROMPT,
      length: 120, width: 768, height: 1344, ref_variant: 'single', audio_ref_nodes: ['a1'],
      ref_nodes: ['c1'], sessionId: sid, ...rest,
    },
    agent: { id: agentId, session: { id: sid, meta: { cwd: root } } },
  }
}

try {
  // ---------- 2. 放行路径 ----------
  console.log('# 放行路径')
  writeProject([tableNode('t1', 1), cardNode('c1', 2, 'single')])
  ok((await gate(gen(), next)).kind === 'allow', '完全对齐：放行')

  writeProject([tableNode('t1', 1)])
  ok((await gate(gen({ title: 'Mia 试镜', prompt: '试镜' }), next)).kind === 'allow', '无 Sxx 标题（试镜片段）跳过')
  ok((await gate(gen({ title: 'S03→S04 转场', type: 'i2v', first_frame_node: 'f1' }), next)).kind === 'allow', '转场镜跳过')
  ok((await gate(gen({ title: 'S01 锚点式重渲', type: 'i2v', first_frame_node: 'f1' }), next)).kind === 'allow', '锚点式重渲跳过')
  ok((await gate({
    name: 'comfy_render',
    arguments: { capability: 'video.reference2video', tier: 'balanced', prompt: 'x', sessionId: sid },
    agent: { id: `${sid}-render`, session: { id: sid, meta: { cwd: root } } },
  }, next)).kind === 'allow', 'comfy_render 无 title 跳过')

  writeProject([], {})
  ok((await gate(gen(), next)).kind === 'allow', '画布无镜头表：放行（老项目）')

  // prompt_node 路径
  writeProject([tableNode('t1', 1), bankNode('b1', 2, GOOD_PROMPT)])
  ok((await gate(gen({ prompt: '', prompt_node: 'b1' }), next)).kind === 'allow', '从 prompt_node 读台词：放行')

  // 静默镜不要求 prompt 含台词/字幕
  writeProject([tableNode('t1', 1)])
  ok((await gate(gen({
    title: 'S02 片段', prompt: '0–3s Mia 转身离开，风声。', length: 72,
    audio_ref_nodes: [], ref_nodes: [],
  }), next)).kind === 'allow', 'silent 镜：不查台词/字幕/声线')

  // fast 原生 16:9 是 832×480（比例 1.733，与 16:9 差 2.5%）——不能被画幅门误杀
  writeProject([tableNode('t1', 1)], { aspectRatio: '16:9' })
  ok((await gate(gen({ width: 832, height: 480 }), next)).kind === 'allow', 'fast 原生尺寸（snap 2.5%）不误杀')

  // ---------- 3. 拦截路径 ----------
  console.log('# 拦截路径')
  let r = await gate(gen({ prompt: '0–1s Mia 推门，沉默。' }), next)
  ok(r.kind === 'deny' && String(r.reason).includes('台词'), 'prompt 缺台词：拒绝')

  writeProject([tableNode('t1', 1, SUB_TABLE)])
  r = await gate(gen({ prompt: '0–1s Mia 推门，说：“我不去。” <Audio 1>: reference - Mia。' }), next)
  ok(r.kind === 'deny' && String(r.reason).includes('字幕'), 'prompt 缺字幕（字幕文本与台词不同）：拒绝')

  writeProject([tableNode('t1', 1)])
  r = await gate(gen({ audio_ref_nodes: [] }), next)
  ok(r.kind === 'deny' && String(r.reason).includes('声线参考'), '对白镜缺 audio_ref_nodes：拒绝')

  r = await gate(gen({ length: 72 }), next)
  ok(r.kind === 'deny' && String(r.reason).includes('时长'), '时长与表不符：拒绝')

  r = await gate(gen({ width: 1344, height: 1344 }), next)
  ok(r.kind === 'deny' && String(r.reason).includes('画幅比例'), '画幅比例不符：拒绝')

  writeProject([tableNode('t1', 1), cardNode('c1', 2, 'three')])
  r = await gate(gen({ tier: 'fast', ref_variant: 'three', ref_nodes: ['c1'] }), next)
  ok(r.kind === 'deny' && String(r.reason).includes('three'), 'fast + ref_variant=three：拒绝')

  writeProject([tableNode('t1', 1), cardNode('c1', 2, 'three')])
  r = await gate(gen({ tier: 'fast', ref_variant: undefined, ref_nodes: ['c1'] }), next)
  ok(r.kind === 'deny' && String(r.reason).includes('三视图卡'), 'fast + 直接传三视图卡：拒绝')

  writeProject([tableNode('t1', 1), cardNode('c1', 2, 'three')])
  ok((await gate(gen({ tier: 'fast', ref_variant: 'single', ref_nodes: ['c1'] }), next)).kind === 'allow', 'fast + single 换版：放行')

  writeProject([tableNode('t1', 1)])
  r = await gate(gen({ title: 'S09 片段' }), next)
  ok(r.kind === 'deny' && String(r.reason).includes('S09'), '镜头表没有该镜：拒绝')

  // ---------- 4. 防死循环（同一 agent） ----------
  console.log('# 防死循环')
  writeProject([tableNode('t1', 1)])
  const loopExec = gen({ prompt: '缺台词', __agent: `${sid}-loop` })
  ok((await gate(loopExec, next)).kind === 'deny', '第 1 次 deny')
  ok((await gate(loopExec, next)).kind === 'deny', '第 2 次 deny')
  ok((await gate(loopExec, next)).kind === 'allow', '第 3 次降级放行')

  // ---------- 5. 其他能力不受门控 ----------
  console.log('# 其他能力')
  writeProject([tableNode('t1', 1)])
  ok((await gate({ name: 'comfy_generate_image', arguments: { prompt: 'x', sessionId: sid }, agent }, next)).kind === 'allow', '图片生成不受门控')
  ok((await gate({ name: 'video_upscale', arguments: { video_node: 'v1', sessionId: sid }, agent }, next)).kind === 'allow', 'video_upscale 不受门控')
  ok((await gate({ name: 'video_interpolate', arguments: { video_node: 'v1', sessionId: sid }, agent }, next)).kind === 'allow', 'video_interpolate 不受门控')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n结果：${passed} passed`)
