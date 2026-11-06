/**
 * 真机验证：video_interpolate（补帧）
 *   A. 24→48（纯 ComfyUI：RIFE ×2 + D2 尾部补齐）
 *   B. 24→60（RIFE ×5 出 120fps 母版 + ffmpeg 每 2 帧取 1）
 * 用法：node scripts/e2e-interpolate.mjs [源 mp4]
 *   缺省源：canvas 里第一个 768×1344 的片段（没有就用 e2e-out/fps-test/fast-124f-24fps.mp4）
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { apply, _internals } from '../lib/index.js'
import { probeMp4 } from '../lib/upscale.js'

const { makeTools } = _internals

function pickSource() {
  const arg = process.argv[2]
  if (arg) return arg
  const dirs = readdirSync('canvas', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join('canvas', e.name))
  for (const d of dirs) {
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.mp4')) continue
      const p = join(d, f)
      const i = probeMp4(p)
      if (i && i.w === 768 && i.h === 1344 && i.hasAudio) return p
    }
  }
  const fallback = 'e2e-out/fps-test/fast-124f-24fps.mp4'
  if (existsSync(fallback)) return fallback
  throw new Error('找不到可用源片段')
}

const srcPath = pickSource()
const srcInfo = probeMp4(srcPath)
console.log(`源片：${srcPath} → ${srcInfo.w}×${srcInfo.h} ${srcInfo.frames}f ${srcInfo.duration}s audio=${srcInfo.hasAudio}`)

const root = mkdtempSync(join(tmpdir(), 'dsh-svs-interp-'))
const sid = 'sid-interp'
const canvasDir = join(root, 'canvas', sid)
mkdirSync(canvasDir, { recursive: true })
const mediaRel = `canvas/${sid}/src.mp4`
writeFileSync(join(root, ...mediaRel.split('/')), readFileSync(srcPath))
writeFileSync(join(canvasDir, 'project.json'), JSON.stringify({
  schemaVersion: 1,
  sessionId: sid,
  settings: { aspectRatio: '9:16', reviewMode: 'batch', shotGate: 'verdict' },
  nodes: [{
    id: 'src', kind: 'video', title: 'S01 片段', media: mediaRel, group: 'shots', status: 'ready', order: 0,
    params: { fps: 24, length: srcInfo.frames, width: srcInfo.w, height: srcInfo.h, shot: true, selfCheck: { status: 'pass' } },
  }],
}), 'utf8')

// mock 宿主（apply 需要）+ workspaceRegistry 指向临时 root
const mockCtx = new Proxy({
  webServer: { register: () => () => {} },
  tools: { register: () => () => {}, get: () => undefined, execute: async () => ({}) },
  systemPrompt: { section: () => () => {} },
  workspaceRegistry: {
    get: (id) => (id === 'ws-interp' ? { id: 'ws-interp', path: root, sessionIds: [sid] } : undefined),
    list: () => [{ id: 'ws-interp', path: root, sessionIds: [sid] }],
  },
  effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
}, { get(target, prop) { return prop in target ? target[prop] : () => () => {} } })
apply(mockCtx)

const tool = makeTools().find((t) => t.name === 'video_interpolate')
if (!tool) throw new Error('video_interpolate 未注册')
const exec = { agent: { id: sid, session: { id: sid, meta: { cwd: root } } } }

let failed = 0
async function runCase(label, args) {
  const t0 = Date.now()
  const r = await tool.execute({ video_node: 'src', sessionId: sid, ...args }, exec)
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  if (!r.ok) {
    failed++
    console.log(`  ✗ ${label}（${secs}s）: ${r.error}`)
    return null
  }
  const abs = join(root, ...String(r.media).split('/'))
  const info = probeMp4(abs)
  const realFps = info ? info.frames / info.duration : 0
  const okFrames = r.plan && Math.abs(info.frames - r.plan.finalFrames) <= 1
  const okFps = Math.abs(realFps - r.targetFps) < 0.05
  const okDur = Math.abs(info.duration - srcInfo.duration) < 0.05
  console.log(`  ${okFrames && okFps && okDur ? '✓' : '✗'} ${label}（${secs}s）→ ${info.frames}f/${info.duration}s/${realFps.toFixed(2)}fps` +
    ` · 计划 ${r.plan.finalFrames}f ${r.targetFps}fps · pad=${r.plan.padFrames} · retimed=${r.retimed}`)
  if (!(okFrames && okFps && okDur)) failed++
  for (const w of r.warnings || []) console.log('     ⚠', w)
  return { r, info }
}

try {
  console.log('\nA. 24 → 48fps（纯 ComfyUI）')
  const a = await runCase('24→48', { target_fps: 48 })
  if (a) console.log(`     文件：${a.r.media}（${(a.r.bytes / 1024 / 1024).toFixed(2)} MB）`)

  console.log('\nB. 24 → 60fps（RIFE ×5 母版 + ffmpeg 抽取）')
  const b = await runCase('24→60', { target_fps: 60 })
  if (b) console.log(`     文件：${b.r.media}（${(b.r.bytes / 1024 / 1024).toFixed(2)} MB）`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过（帧数 / 帧率 / 时长与计划一致）')
process.exit(failed ? 1 : 0)
