/**
 * 冒烟：多 skill 门组（flow profile）基础
 * P0 范围：flow 字段持久化 / 结构推断 / 未知 flow 警告 / 配置门与 flow 解耦（契约门仍生效）。
 * 完整 profile × gate 矩阵在 P1 接入现有流程门后扩展。
 * 用法：node scripts/smoke-config-profile.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _internals } from '../lib/index.js'

const { applyProjectConfig, inferFlow, makeConfigGateListener, makeShotGateListener, gateOn, FLOW_VALUES } = _internals

let passed = 0
function ok(cond, name) {
  assert.ok(cond, name)
  passed++
  console.log('  ok -', name)
}

const root = mkdtempSync(join(tmpdir(), 'svs-config-profile-'))
const sid = 's-profile'
mkdirSync(join(root, 'canvas', sid), { recursive: true })

// ---- 1. 结构推断：系列状态文件 ----
console.log('# inferFlow')
{
  ok(inferFlow({ nodes: [] }, root) === 'free', '无结构 → free')
  mkdirSync(join(root, 'series'), { recursive: true })
  writeFileSync(join(root, 'series', 'production-state.json'), JSON.stringify({ series: { id: 'x' } }), 'utf8')
  ok(inferFlow({ nodes: [] }, root) === 'series', '有 series/production-state.json → series')
  ok(inferFlow({ nodes: [], settings: { series: { id: 'y' } } }, '') === 'series', 'settings.series → series')
}

// ---- 1b. 门组矩阵（gateOn） ----
console.log('# gateOn（契约门不在矩阵里）')
{
  ok(gateOn({ flow: 'story' }, 'plan') && gateOn({ flow: 'story' }, 'shot'), 'story 开 plan/shot')
  ok(gateOn({ flow: 'series' }, 'production'), 'series 开 production')
  ok(gateOn({ flow: 'free' }, 'plan') === false, 'free 不开 plan')
  ok(gateOn({ flow: 'ecommerce' }, 'shot') && gateOn({ flow: 'ecommerce' }, 'plan') === false, 'ecommerce 开 shot / 不开 plan')
  ok(gateOn({ flow: 'not-a-flow' }, 'plan') === false, '未知 flow 按 free（只契约门）')
}

// ---- 1c. shot 门按 flow 跳过（free 项目不被逐镜自检卡住） ----
console.log('# shot gate × flow')
{
  const freeRoot = mkdtempSync(join(tmpdir(), 'svs-config-free-'))
  const freeSid = 's-free'
  mkdirSync(join(freeRoot, 'canvas', freeSid), { recursive: true })
  writeFileSync(join(freeRoot, 'canvas', freeSid, 'project.json'), JSON.stringify({
    schemaVersion: 1, sessionId: freeSid,
    settings: { flow: 'free', configured: true, shotGate: 'verdict', aspectRatio: '16:9' },
    nodes: [{ id: 's1', kind: 'video', title: 'S01 片段', group: 'x', media: 'x.mp4', status: 'ready', order: 1, params: { shot: true, selfCheck: { status: 'pending' } } }],
  }), 'utf8')
  const shotGate = makeShotGateListener({ workspaceRegistry: { get: () => undefined, list: () => [{ id: 'w', path: freeRoot, sessionIds: [freeSid] }] } })
  const r = await shotGate({ name: 'comfy_generate_video', arguments: { sessionId: freeSid, type: 'r2v', prompt: 'x' }, agent: { id: 'x' } }, async () => ({ kind: 'allow' }))
  ok(r.kind === 'allow', 'free flow：shot 门跳过（上一镜 pending 也放行）')
  rmSync(freeRoot, { recursive: true, force: true })
}

// ---- 2. 显式 flow 持久化 ----
console.log('# flow 持久化')
{
  const r = await applyProjectConfig(root, sid, { flow: 'ecommerce', aspectRatio: '9:16', mode: 'balanced' }, { source: 'agent' })
  ok(r.ok && r.rev === 1, '首次写入 rev=1')
  const gate = makeConfigGateListener({
    workspaceRegistry: { get: () => undefined, list: () => [{ id: 'w', path: root, sessionIds: [sid] }] },
  })
  // 配置门是契约门：不看 flow，ecommerce 下仍检查画幅
  const bad = await gate({ name: 'comfy_generate_image', arguments: { sessionId: sid, prompt: 'x', width: 1920, height: 1080 }, agent: { id: 'p1' } }, async () => ({ kind: 'allow' }))
  ok(bad.kind === 'deny', 'ecommerce flow 下契约门（画幅）仍生效')
}

// ---- 3. 未知 flow → 警告 + 结构推断 ----
console.log('# 未知 flow')
{
  const r = await applyProjectConfig(root, sid, { flow: 'not-a-flow' }, { source: 'user' })
  ok(r.warnings.some((w) => w.includes('未知片型')), '未知 flow 给 warning')
  ok(FLOW_VALUES.includes('ecommerce') && FLOW_VALUES.length === 5, 'flow 词汇表固定 5 项')
}

// ---- 4. 切 flow 是破坏性变更 ----
console.log('# 切 flow')
{
  const r = await applyProjectConfig(root, sid, { flow: 'story' }, { source: 'user' })
  ok(r.changed.includes('flow'), 'flow 变化进 changed')
  const project = JSON.parse(readFileSync(join(root, 'canvas', sid, 'project.json'), 'utf8'))
  ok(project.settings.breakingRev === project.settings.rev, '切 flow 提升 breakingRev')
}

rmSync(root, { recursive: true, force: true })
console.log(`\n全部通过（${passed} 项）`)
