/**
 * scripts/e2e-upscale-shortside.mjs — 短边形态（`upscale.sizing="short-side"`）的**真机**契约验证。
 *
 * 为什么需要它：短边分支（尺寸由目标短边推导 + `params.out_short_side` 回注 + `chunking="internal"`）
 * 在 `smoke-upscale.mjs` 里只有 GPU-free 单测；「注入真落到图上、产物容器尺寸与预测一致」只能在真机验。
 *
 * 载体是 `scripts/fixtures/upscale-shortside-probe.json`——一份 `internal: true` 的**几何探针**
 * （图里只有一个等比 ImageScale，没有模型、不产细节）。**它验证的是契约与 runner，不是画质。**
 *
 * 清单目录用 `DSH_SVS_USER_WORKFLOWS` 指到临时目录（测试接缝），不碰用户真实配置。
 *
 * 用法：
 *   node scripts/e2e-upscale-shortside.mjs
 *   node scripts/e2e-upscale-shortside.mjs --src=e2e-out/2k-aspect/ref2v-ctx-fast-2k-9x16-f124.mp4
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'e2e-out', 'upscale-shortside')
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}

// 竖版源片（H3 fast-2k 的 9:16 交付 960×1664）：竖版时**短边就是宽**，
// 所以探针把 out_short_side 注入 ImageScale.width 是语义忠实的映射（见 fixture 的 note）。
const SRC = arg('src', 'e2e-out/2k-aspect/ref2v-ctx-fast-2k-9x16-f124.mp4')
const TAG = arg('tag', 'shortside')
const srcAbs = join(ROOT, SRC)
if (!existsSync(srcAbs)) {
  console.error(`✗ 源片不存在：${srcAbs}`)
  process.exit(1)
}

// ① 隔离的「用户清单目录」——必须在 import 插件之前设好（模块级常量在 import 时求值）
const userDir = join(OUT, 'user-workflows-' + TAG)
rmSync(userDir, { recursive: true, force: true })
mkdirSync(userDir, { recursive: true })
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'upscale-shortside-probe.json'), 'utf8'))
writeFileSync(join(userDir, fixture.id + '.json'), JSON.stringify(fixture, null, 2), 'utf8')
process.env.DSH_SVS_USER_WORKFLOWS = userDir

const { _internals } = await import('../lib/index.js')
const { probeMp4, planUpscale } = await import('../lib/upscale.js')

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const reg = _internals.getRegistry()
check('探针清单已被注册表加载（用户目录）', Boolean(reg.byId[fixture.id]))
check('探针是 internal（不进档位解析、不会被隐式选中）', reg.byId[fixture.id]?.internal === true)
check('探针不会成为 video.upscale 的隐式默认',
  _internals.sortTierCandidates((reg.byCapability['video.upscale'] || []).filter((m) => m.tier === 'quality' && !m.internal))[0]?.id !== fixture.id)

const srcProbe = probeMp4(srcAbs)
console.log(`\n源片 ${basename(srcAbs)} · ${srcProbe.w}×${srcProbe.h} · ${srcProbe.frames} 帧 · 音轨 ${srcProbe.hasAudio} · ${Number(srcProbe.duration).toFixed(2)}s`)
check('源片是竖版（短边 = 宽）', srcProbe.h > srcProbe.w, `${srcProbe.w}×${srcProbe.h}`)

// ② 临时工作区 + 画布（与 e2e-upscale.mjs 同构；源节点**不记** params，逼容器解析回退）
const workspace = join(OUT, 'workspace-' + TAG)
const sessionId = 'upscale-shortside'
const projectPath = join(workspace, 'canvas', sessionId, 'project.json')
mkdirSync(dirname(projectPath), { recursive: true })
const mediaRel = 'canvas-files/' + sessionId + '/' + 'src-' + basename(srcAbs)
const mediaAbs = join(workspace, mediaRel)
mkdirSync(dirname(mediaAbs), { recursive: true })
copyFileSync(srcAbs, mediaAbs)
writeFileSync(projectPath, JSON.stringify({
  schemaVersion: 1,
  sessionId,
  settings: { aspectRatio: '9:16', duration: '', audioMode: 'dialogue-led', mode: 'quality' },
  nodes: [{
    id: 'src-portrait-1', kind: 'video', title: '源镜（竖版 2K）', media: mediaRel,
    group: '片段', params: {}, status: 'ready', createdAt: Date.now(), order: 1,
  }],
}, null, 2), 'utf8')

const ctx = {
  workspaceRegistry: {
    get: (id) => (id === 'smoke' ? { id, path: workspace } : undefined),
    list: () => [{ id: 'smoke', path: workspace, sessionIds: [sessionId] }],
  },
}
const readNodes = () => JSON.parse(readFileSync(projectPath, 'utf8')).nodes

/** 跑一臂：真机调用 runUpscale，然后按**容器**核对交付尺寸（不信 params）。 */
async function arm(label, opts, expect) {
  console.log(`\n[真跑] ${label}`)
  const before = readNodes().length
  const t0 = Date.now()
  // 故意**不传** title：要验的是 runner 自己按形态生成的标题（短边形态写「短边 N」，不写 ×N）
  const res = await _internals.runUpscale(ctx, { workspaceId: 'smoke', sessionId, video_node: 'src-portrait-1', ...opts })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`  ▸ ${res.node.params.workflow} · ${secs}s · backend=${res.backend} · chunks=${res.chunks}`)
  for (const w of res.warnings || []) console.log('  ! %s', w)
  const p = probeMp4(join(workspace, res.node.media))
  console.log(`  ▸ 产物 ${basename(res.node.media)} · ${p.w}×${p.h} · ${p.frames} 帧 · 音轨 ${p.hasAudio}`)

  check(`${label}：产物容器尺寸 = 预测 ${expect.w}×${expect.h}`, p.w === expect.w && p.h === expect.h, `${p.w}×${p.h}`)
  check(`${label}：画布 params 也记同一尺寸`, res.node.params.width === expect.w && res.node.params.height === expect.h,
    `${res.node.params.width}×${res.node.params.height}`)
  check(`${label}：sizing 如实记 short-side`, res.node.params.sizing === 'short-side', String(res.node.params.sizing))
  check(`${label}：factor 如实记 null（倍率是推导的，不编数）`, res.node.params.factor === null, String(res.node.params.factor))
  check(`${label}：shortSide 记的是对齐后的实际短边 ${expect.shortSide}`, res.node.params.shortSide === expect.shortSide, String(res.node.params.shortSide))
  check(`${label}：标题用短边口径（不写 ×N）`, res.node.title.includes('短边') && !res.node.title.includes('×'), res.node.title)
  check(`${label}：帧数守恒 + 音轨原样带回`, p.frames === srcProbe.frames && p.hasAudio === srcProbe.hasAudio,
    `${p.frames}/${p.hasAudio}`)
  check(`${label}：只新增 1 个画布节点`, readNodes().length === before + 1, `${before} → ${readNodes().length}`)
  return res
}

// ── 臂 A：默认短边（清单声明的 shortSide=1080）─────────────────────────────
const planA = planUpscale({ srcW: srcProbe.w, srcH: srcProbe.h, sizing: 'short-side', shortSide: 1080, align: 32 })
console.log(`\n预测（短边 1080）：${planA.delivery.w}×${planA.delivery.h}，回注短边 ${planA.shortSide}`)
const a = await arm('A · 默认短边', { implementation: fixture.id }, { ...planA.delivery, shortSide: planA.shortSide })
check('A：没有「自动分块」告警（chunking=internal 不自动切）',
  !(a.warnings || []).some((w) => w.includes('自动分') && !w.includes('chunk_frames')), JSON.stringify(a.warnings))
check('A：未超像素-帧安全线 ⇒ 也不该发 internal 那条告警',
  !(a.warnings || []).some((w) => w.includes('chunking="internal"')), JSON.stringify(a.warnings))

// ── 臂 B：target_width 反解短边（不是先渲染再降采样）────────────────────────
const TW = 1504
const planB = planUpscale({ srcW: srcProbe.w, srcH: srcProbe.h, sizing: 'short-side', shortSide: 1080, align: 32, targetWidth: TW })
console.log(`\n预测（target_width=${TW}）：${planB.delivery.w}×${planB.delivery.h}，回注短边 ${planB.shortSide}`)
check('B：反解出的短边 ≠ 清单默认短边（证明确实回注了目标，而不是用完默认再缩放）',
  planB.shortSide !== planA.shortSide, `${planB.shortSide} vs ${planA.shortSide}`)
await arm(`B · target_width=${TW}`, { implementation: fixture.id, target_width: TW }, { ...planB.delivery, shortSide: planB.shortSide })

// ── 臂 C：internal 下显式 chunk_frames（照办 + 告警点名接缝）───────────────
const CHUNK = 60
const c = await arm(`C · chunk_frames=${CHUNK}`, { implementation: fixture.id, chunk_frames: CHUNK },
  { ...planA.delivery, shortSide: planA.shortSide })
check(`C：分块数 = ${Math.ceil(srcProbe.frames / CHUNK)}（显式意图优先，仍照办）`,
  c.chunks === Math.ceil(srcProbe.frames / CHUNK), String(c.chunks))
check('C：告警点名 chunk_frames 与「会在它的时间窗上再加一道硬切」',
  (c.warnings || []).some((w) => w.includes('chunk_frames') && w.includes('接缝')), JSON.stringify(c.warnings))

console.log('\n产物目录：%s', OUT)
console.log(failures ? `\n✗ ${failures} 项失败` : '\n✓ 全部通过')
process.exit(failures ? 1 : 0)
