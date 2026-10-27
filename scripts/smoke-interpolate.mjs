/**
 * 冒烟：视频补帧（video.interpolate）
 * 覆盖：清单契约加载 / planInterpolate 帧数账 / concat 帧率守卫 / ffmpeg 向上搜索 /
 *       工具注册 / 参数错误路径。不连 ComfyUI（真机链路见 scripts/e2e-interpolate.mjs）。
 * 用法：node scripts/smoke-interpolate.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, _internals } from '../lib/index.js'

const { makeTools, loadBuiltinManifests, validateManifest, planInterpolate, concatFpsGuard, detectFfmpeg } = _internals

let passed = 0
function ok(cond, name) {
  assert.ok(cond, name)
  passed++
  console.log('  ok -', name)
}
function throws(fn, re, name) {
  let msg = ''
  try { fn() } catch (e) { msg = String(e.message) }
  assert.ok(re.test(msg), `${name}（实际: ${msg}）`)
  passed++
  console.log('  ok -', name)
}

// ---------- 1. 清单契约 ----------
console.log('# 清单契约')
{
  const report = loadBuiltinManifests('workflows')
  ok(report.errors.length === 0, `内置清单全部通过校验（${report.manifests.length} 个）`)
  const m = report.manifests.find((x) => x.id === 'video-interpolate-rife')
  ok(!!m, 'video-interpolate-rife 已加载')
  ok(m.capability === 'video.interpolate', 'capability = video.interpolate')
  ok(m.tier === 'quality', 'tier = quality')
  ok(m.interpolate.minMultiplier === 2 && m.interpolate.maxMultiplier === 16, '倍率范围 2–16')
  ok(m.interpolate.outRule === 'n-minus-1-times-m-plus-1', 'outRule 声明')
  ok(m.interpolate.audio === 'passthrough', 'audio = passthrough')
  for (const p of ['source_video', 'multiplier', 'out_fps', 'prefix']) ok(!!m.params[p], `params.${p} 已声明`)

  // 负例：缺 interpolate 块 / 倍率非法
  const bad1 = { ...m, interpolate: undefined }
  const r1 = validateManifest(bad1, 'bad1')
  ok(r1.errors.some((e) => e.includes('interpolate 块')), '缺 interpolate 块 → 校验失败')
  const bad2 = { ...m, interpolate: { ...m.interpolate, minMultiplier: 1 } }
  const r2 = validateManifest(bad2, 'bad2')
  ok(r2.errors.some((e) => e.includes('minMultiplier')), 'minMultiplier < 2 → 校验失败')
  const bad3 = { ...m, interpolate: { ...m.interpolate, mode: 'fixed' } }
  ok(validateManifest(bad3, 'bad3').errors.some((e) => e.includes('multiplier')), 'mode=fixed 缺 multiplier → 校验失败')
}

// ---------- 2. planInterpolate ----------
console.log('# planInterpolate')
{
  const p48 = planInterpolate({ srcFps: 24, frames: 124, targetFps: 48 })
  ok(p48.m === 2 && p48.outFps === 48 && p48.stage === 1, '24→48：×2、母版 48fps、无抽取')
  ok(p48.vfiFrames === 247 && p48.targetFrames === 248 && p48.padFrames === 1, '24→48：VFI 247 → 补齐 248（D2）')
  ok(p48.finalFrames === 248, '24→48：最终 248 帧')

  const p60 = planInterpolate({ srcFps: 24, frames: 124, targetFps: 60 })
  ok(p60.m === 5 && p60.outFps === 120 && p60.stage === 2, '24→60：×5、母版 120fps、每 2 帧取 1')
  ok(p60.vfiFrames === 616 && p60.padFrames === 4 && p60.finalFrames === 310, '24→60：616 → 补齐 620 → 抽到 310')

  const p30 = planInterpolate({ srcFps: 24, frames: 124, targetFps: 30 })
  ok(p30.m === 5 && p30.stage === 4 && p30.finalFrames === 155, '24→30：×5、每 4 帧取 1、155 帧')

  const p3024 = planInterpolate({ srcFps: 30, frames: 150, targetFps: 60 })
  ok(p3024.m === 2 && p3024.stage === 1, '30→60：×2 直出')

  throws(() => planInterpolate({ srcFps: 24, frames: 124, targetFps: 24 }), /无需补帧/, '目标=源 → 报错')
  throws(() => planInterpolate({ srcFps: 24, frames: 124, targetFps: 12 }), /降帧/, '降帧 → 报错')
  throws(() => planInterpolate({ srcFps: 24, frames: 124, targetFps: 50 }), /没有整数倍路径/, '24→50 不可达 → 报错')
  throws(() => planInterpolate({ srcFps: 24, frames: 124, targetFps: 48, multiplier: 5 }), /不是目标 48fps 的整数倍/, '显式倍率与目标不整除 → 报错')
  throws(() => planInterpolate({ srcFps: 24, frames: 124, targetFps: 48, multiplier: 1 }), /multiplier 必须是/, '倍率越界 → 报错')
  ok(planInterpolate({ srcFps: 24, frames: 124, targetFps: 60, multiplier: 5 }).stage === 2, '显式 ×5 + 目标 60 合法')
}

// ---------- 3. concat 帧率守卫 ----------
console.log('# concatFpsGuard')
{
  const same = concatFpsGuard([{ id: 'a', fps: 24 }, { id: 'b', fps: 24 }])
  ok(Math.abs(same.fps - 24) < 1e-6, '同帧率：通过并返回 fps')
  ok(same.warnings.length === 0, '同帧率：无告警')
  const strict = concatFpsGuard([{ id: 'a', fps: 48 }, { id: 'b', fps: 48 }])
  ok(strict.fps === 48, '48fps 全片：通过')

  let msg = ''
  try { concatFpsGuard([{ id: 'a', fps: 24 }, { id: 'b', fps: 48 }]) } catch (e) { msg = String(e.message) }
  ok(/concat-fps-mismatch/.test(msg), '混帧率 → 报错')
  ok(/video_interpolate\(video_node=…, target_fps=24\)/.test(msg), '报错给出统一帧率的下一步')

  const unknown = concatFpsGuard([{ id: 'a', fps: null }, { id: 'b', fps: null }])
  ok(unknown.fps === null && unknown.warnings.length === 1, '全读不出 fps：不误杀，只告警')
}

// ---------- 4. ffmpeg 探测（向上层目录搜索） ----------
console.log('# detectFfmpeg')
{
  const root = mkdtempSync(join(tmpdir(), 'dsh-svs-ffprobe-'))
  try {
    // tools/ffmpeg/ffmpeg 的假实现：-version 返回 0
    mkdirSync(join(root, 'tools', 'ffmpeg'), { recursive: true })
    const fake = join(root, 'tools', 'ffmpeg', 'ffmpeg')
    writeFileSync(fake, '#!/bin/sh\necho "ffmpeg version fake"\nexit 0\n', 'utf8')
    chmodSync(fake, 0o755)
    const found = await detectFfmpeg({ roots: [join(root, 'canvas', 'sid')], force: true })
    ok(found === fake, '从工作区逐级向上找到 tools/ffmpeg/ffmpeg')
    // extraPaths 优先
    const found2 = await detectFfmpeg({ roots: [], extraPaths: [fake], force: true })
    ok(found2 === fake, '显式 extraPaths（配置 ffmpegPath）生效')
  } finally {
    rmSync(root, { recursive: true, force: true })
    await detectFfmpeg({ roots: [], extraPaths: [], force: true }) // 复原缓存
  }
}

// ---------- 5. 工具注册 + 错误路径 ----------
console.log('# 工具与错误路径')
{
  const root = mkdtempSync(join(tmpdir(), 'dsh-svs-interp-smoke-'))
  try {
    const sid = 'sid-i'
    const canvasDir = join(root, 'canvas', sid)
    mkdirSync(canvasDir, { recursive: true })
    writeFileSync(join(canvasDir, 'project.json'), JSON.stringify({
      schemaVersion: 1, sessionId: sid,
      settings: { aspectRatio: '9:16', shotGate: 'verdict' },
      nodes: [{ id: 'txt', kind: 'text', title: 'T', content: 'x', status: 'ready', order: 0, params: {} }],
    }), 'utf8')

    const mockCtx = new Proxy({
      webServer: { register: () => () => {} },
      tools: { register: () => () => {}, get: () => undefined, execute: async () => ({}) },
      systemPrompt: { section: () => () => {} },
      workspaceRegistry: {
        get: (id) => (id === 'ws-i' ? { id: 'ws-i', path: root, sessionIds: [sid] } : undefined),
        list: () => [{ id: 'ws-i', path: root, sessionIds: [sid] }],
      },
      effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
    }, { get(target, prop) { return prop in target ? target[prop] : () => () => {} } })
    apply(mockCtx)

    const tools = makeTools()
    const tool = tools.find((t) => t.name === 'video_interpolate')
    ok(!!tool, 'video_interpolate 已注册')
    ok(tool.output?.schema && typeof tool.output.render === 'function', '工具 output 契约完整')
    ok(tool.parameters.required.includes('video_node'), 'video_node 必填')

    const exec = { agent: { id: sid, session: { id: sid, meta: { cwd: root } } } }
    let r = await tool.execute({ sessionId: sid }, exec)
    ok(r.ok === false && /必须给 video_node/.test(r.error), '缺 video_node → 报错')
    r = await tool.execute({ sessionId: sid, video_node: 'nope' }, exec)
    ok(r.ok === false && /画布无此节点/.test(r.error), '节点不存在 → 报错')
    r = await tool.execute({ sessionId: sid, video_node: 'txt' }, exec)
    ok(r.ok === false && /不是视频节点/.test(r.error), '非视频节点 → 报错')
    r = await tool.execute({ sessionId: sid, video_node: 'txt', tier: 'ultra' }, exec)
    ok(r.ok === false && /tier "ultra"/.test(r.error), '非法 tier → 报错')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log(`\n结果：${passed} passed`)
