/**
 * scripts/experiment-quality-prompt-ab.mjs — 实验：各档专用 prompt vs 全用 quality prompt。
 *
 * 1 seed pilot，统一「宝钗单视图」参考卡（避免 fast 不能用三视图、也避免参考图版本混淆）。
 * 5 条唯一片段（quality 档的两种条件相同，只跑一条基线）：
 *   fast     + fast prompt
 *   fast     + quality prompt
 *   balanced + balanced prompt
 *   balanced + quality prompt
 *   quality  + quality prompt
 *
 * 固定：同一组 refs、seed=424242、length=124、16:9、各自档位解析出的实现。
 * 产物：当前会话画布的「实验片段」视频节点 + 对比联系表 + 指标报告。
 *
 * 用法：node scripts/experiment-quality-prompt-ab.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { _internals } from '../lib/index.js'

const ROOT = process.cwd()
const SESSION = process.env.DSH_SESSION_ID || 'session-4a030c9a-9e9b-4795-aa2e-0ae20099d4b2'
const SOURCE_ROOT = '/Users/seiue/Workspace/my-video'
const SOURCE_SESSION = 'session-ce2ad6e6-be2a-4634-b954-ad3e58020ad4'
const SOURCE_PROJECT = join(SOURCE_ROOT, 'canvas', SOURCE_SESSION, 'project.json')
const OUT_DIR = join(ROOT, 'e2e-out', 'ab-quality-prompt')
const SEED = 424242
const LENGTH = 124
const RESUME = process.argv.includes('--resume')

function sourceProject() {
  return JSON.parse(readFileSync(SOURCE_PROJECT, 'utf8'))
}
function sourceMedia(node) {
  return join(SOURCE_ROOT, ...String(node.media).split('/'))
}
function readProject() {
  const f = join(ROOT, 'canvas', SESSION, 'project.json')
  return JSON.parse(readFileSync(f, 'utf8'))
}
function saveProject(p) {
  const dir = join(ROOT, 'canvas', SESSION)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'project.json'), JSON.stringify(p, null, 2), 'utf8')
}
function nextOrder(nodes) {
  return nodes.reduce((m, n) => Math.max(m, Number(n.order) || 0), -1) + 1
}

/** 把三视图参考描述改成单视图；只改参考图描述，不改镜头计划。 */
function adaptSingleReference(prompt) {
  return String(prompt)
    .replace(' <Picture 1> is a three-view sheet of the same person; use only the person, not the sheet layout.', ' <Picture 1> is a single-view full-body reference of the same person.')
    .replace(' <Picture 1> is a three-view reference sheet of the same woman in front, side and back full-body views; only the person is used, not the sheet layout.', ' <Picture 1> is a single-view full-body reference of the same woman.')
    .replace(' <Picture 1> is a three-view reference sheet of the same woman in front, side and back full-body views; only the person is used, the sheet layout is not part of the scene.', ' <Picture 1> is a single-view full-body reference of the same woman; only the person is used.')
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const src = sourceProject()
  const bank = src.nodes.find((n) => n.id === '96ebcef0-3ecc-4913-9351-be4e1ffb4a3d')
  if (!bank) throw new Error('源项目里未找到 S01 提示词库')
  const parsed = _internals.parsePromptBank(bank.content)
  if (!parsed.tiers.fast || !parsed.tiers.balanced || !parsed.tiers.quality) throw new Error('S01 提示词库缺档')
  const prompts = {
    fast: adaptSingleReference(parsed.tiers.fast),
    balanced: adaptSingleReference(parsed.tiers.balanced),
    quality: adaptSingleReference(parsed.tiers.quality),
  }

  const srcRefs = {
    baochai: src.nodes.find((n) => n.id === 'e3e9fb75-a690-4c4b-ad2e-a4f28c0855a4'),
    scene: src.nodes.find((n) => n.id === '0d32162d-9da4-49bc-b41e-9fc4414f3c9f'),
    fan: src.nodes.find((n) => n.id === '5dbab849-a444-4ab3-bba6-b0c8a608a395'),
  }
  for (const [k, n] of Object.entries(srcRefs)) if (!n) throw new Error('源项目缺参考节点: ' + k)

  const sidDir = join(ROOT, 'canvas', SESSION)
  mkdirSync(sidDir, { recursive: true })
  const dest = {
    baochai: join(sidDir, 'ab-ref-baochai-single.png'),
    scene: join(sidDir, 'ab-ref-qinfang.png'),
    fan: join(sidDir, 'ab-ref-fan.png'),
  }
  for (const k of Object.keys(dest)) copyFileSync(sourceMedia(srcRefs[k]), dest[k])

  const project = readProject()
  const setupIds = new Set(['ab-ref-baochai', 'ab-ref-scene', 'ab-ref-fan', 'ab-prompt-bank', 'ab-design', 'ab-contact-sheet', 'ab-report'])
  project.nodes = (project.nodes || []).filter((n) => {
    if (setupIds.has(n.id)) return false
    return RESUME ? true : !String(n.id || '').startsWith('ab-')
  })
  project.nodes.push(
    {
      id: 'ab-ref-baochai', kind: 'image', title: '实验参考·宝钗单视图', group: '实验参考',
      media: `canvas/${SESSION}/ab-ref-baochai-single.png`,
      params: { character: 'Baochai', cardVariant: 'single', experimentRef: true },
      status: 'ready', createdAt: Date.now(), order: nextOrder(project.nodes),
    },
    {
      id: 'ab-ref-scene', kind: 'image', title: '实验参考·沁芳桥场景', group: '实验参考',
      media: `canvas/${SESSION}/ab-ref-qinfang.png`, params: { experimentRef: true },
      status: 'ready', createdAt: Date.now(), order: nextOrder(project.nodes) + 1,
    },
    {
      id: 'ab-ref-fan', kind: 'image', title: '实验参考·团扇', group: '实验参考',
      media: `canvas/${SESSION}/ab-ref-fan.png`, params: { experimentRef: true },
      status: 'ready', createdAt: Date.now(), order: nextOrder(project.nodes) + 2,
    },
    {
      id: 'ab-prompt-bank', kind: 'text', title: 'S01 实验提示词（统一单视图）', group: '实验提示词',
      content: _internals.serializePromptBank({
        title: 'S01 实验提示词（统一单视图）',
        note: '实验控制：三档统一使用宝钗单视图参考；只把原提示词里的三视图参考描述改成单视图，镜头计划不变。',
        tiers: prompts,
      }),
      params: { promptBank: true, promptBankVersion: 1, tiers: ['fast', 'balanced', 'quality'] },
      status: 'ready', createdAt: Date.now(), order: nextOrder(project.nodes) + 3,
    },
    {
      id: 'ab-design', kind: 'text', title: 'AB 实验设计', group: '实验结果',
      content: [
        '# AB 实验：各档专用 prompt vs 全用 quality prompt',
        '',
        `- seed: ${SEED} · length: ${LENGTH} 帧 · 16:9`,
        '- 参考图：宝钗单视图 + 沁芳桥场景 + 团扇（三档统一）',
        '- 唯一变量：tier 与 prompt 来源',
        '',
        '| 条件 | 档位 | prompt |',
        '|---|---|---|',
        '| A-fast | fast | fast 专用 |',
        '| B-fast | fast | quality |',
        '| A-balanced | balanced | balanced 专用 |',
        '| B-balanced | balanced | quality |',
        '| Q | quality | quality（基线） |',
        '',
        '评价：动作节拍是否兑现、构图、角色一致性、材质细节、字幕/口型、伪影；对比图见「实验结果」分组。',
      ].join('\n'),
      params: { experiment: 'ab-quality-prompt' }, status: 'ready', createdAt: Date.now(), order: nextOrder(project.nodes) + 4,
    },
  )
  project.settings = { ...(project.settings || {}), aspectRatio: '16:9', mode: 'quality', characterCardVariant: 'single', reviewMode: 'per-shot' }
  saveProject(project)

  const ctx = {
    workspaceRegistry: {
      get: (id) => (String(id) === 'ab' ? { id: 'ab', path: ROOT, sessionIds: [SESSION] } : undefined),
      list: () => [{ id: 'ab', path: ROOT, sessionIds: [SESSION] }],
    },
  }
  const exec = { agent: { id: SESSION, session: { meta: { cwd: ROOT } } } }
  const conditions = [
    { key: 'A-fast', tier: 'fast', promptTier: 'fast', title: 'AB-A fast·fast prompt' },
    { key: 'B-fast', tier: 'fast', promptTier: 'quality', title: 'AB-B fast·quality prompt' },
    { key: 'A-balanced', tier: 'balanced', promptTier: 'balanced', title: 'AB-A balanced·balanced prompt' },
    { key: 'B-balanced', tier: 'balanced', promptTier: 'quality', title: 'AB-B balanced·quality prompt' },
    { key: 'Q-quality', tier: 'quality', promptTier: 'quality', title: 'AB-Q quality·quality prompt' },
  ]
  const resultsPath = join(OUT_DIR, 'results.json')
  const results = RESUME && existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : []
  for (const c of conditions) {
    const prior = results.find((r) => r.key === c.key)
    if (prior) { console.log(`\n=== ${c.key} · 已完成，跳过（--resume） ===`); continue }
    const started = Date.now()
    console.log(`\n=== ${c.key} · ${c.tier} · ${c.promptTier} prompt ===`)
    const r = await _internals.runRender(ctx, {
      sessionId: SESSION, workspaceId: 'ab', exec,
      capability: 'video.reference2video', type: 'r2v', tier: c.tier,
      prompt: prompts[c.promptTier],
      ref_nodes: ['ab-ref-baochai', 'ab-ref-scene', 'ab-ref-fan'],
      ref_variant: 'single', seed: SEED, length: LENGTH,
      title: c.title, group: '实验片段', persist_prompt: false,
    })
    const sec = Math.round((Date.now() - started) / 100) / 10
    const item = {
      ...c, nodeId: r.node.id, media: r.node.media, absPath: r.absPath,
      implementation: r.implementation, resolution: `${r.node.params.width}×${r.node.params.height}`,
      seconds: sec, warnings: r.warnings || [],
    }
    results.push(item)
    writeFileSync(resultsPath, JSON.stringify(results, null, 2), 'utf8')
    console.log(`✓ ${c.key}: ${r.node.id} · ${item.resolution} · ${sec}s`)
  }

  // 抽帧、联系表、指标（cv2 可用；不可用则不阻塞交付）
  const py = spawnSync('python3', [join(ROOT, 'scripts', 'ab-quality-prompt-analyze.py'), ROOT, SESSION, join(OUT_DIR, 'results.json'), OUT_DIR], { encoding: 'utf8' })
  if (py.stdout) console.log(py.stdout)
  if (py.stderr) console.error(py.stderr)
  if (py.status !== 0) console.warn('分析脚本失败（片段仍已生成）：', py.status)

  // 把对比图与报告写回画布
  const contact = join(OUT_DIR, 'contact-sheet.png')
  if (existsSync(contact)) {
    copyFileSync(contact, join(sidDir, 'ab-contact-sheet.png'))
    const metrics = existsSync(join(OUT_DIR, 'metrics.json')) ? JSON.parse(readFileSync(join(OUT_DIR, 'metrics.json'), 'utf8')) : []
    const proj = readProject()
    proj.nodes = (proj.nodes || []).filter((n) => n.id !== 'ab-contact-sheet' && n.id !== 'ab-report')
    proj.nodes.push({
      id: 'ab-contact-sheet', kind: 'image', title: 'AB 对比图：quality prompt vs 各档 prompt', group: '实验结果',
      media: `canvas/${SESSION}/ab-contact-sheet.png`, params: { experiment: 'ab-quality-prompt' },
      status: 'ready', createdAt: Date.now(), order: nextOrder(proj.nodes),
    })
    const rows = metrics.map((m) => `| ${m.key} | ${m.tier} | ${m.promptTier} | ${m.resolution} | ${m.sharpness_mean.toFixed(1)} | ${m.colorfulness.toFixed(1)} | ${m.frame_diff_mean.toFixed(2)} |`).join('\n')
    proj.nodes.push({
      id: 'ab-report', kind: 'text', title: 'AB 实验报告', group: '实验结果',
      content: [
        '# AB 实验报告：各档专用 prompt vs 全用 quality prompt',
        '',
        `seed ${SEED} · length ${LENGTH} · 三档统一单视图参考`,
        '',
        '| 条件 | tier | prompt | 交付尺寸 | 锐度(Laplacian var) | 色彩度 | 相邻帧差 |',
        '|---|---|---|---|---|---|---|',
        rows,
        '',
        '> 锐度只在同档位内可比（fast 832 vs balanced/quality 1344）；相邻帧差受运动量影响，仅作稳定性参考。最终以「AB 对比图」的人工审看为准：动作节拍、构图、身份、材质细节、字幕/口型、伪影。',
      ].join('\n'),
      params: { experiment: 'ab-quality-prompt' }, status: 'ready', createdAt: Date.now(), order: nextOrder(proj.nodes) + 1,
    })
    saveProject(proj)
    console.log('✓ 对比图与报告已写回画布')
  } else {
    console.warn('未生成对比图；检查 cv2 是否可用')
  }
  console.log(`\n完成。产物目录: ${OUT_DIR}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
