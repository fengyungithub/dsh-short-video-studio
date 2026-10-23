/**
 * scripts/smoke-music.mjs — BGM（audio.music / MiniMax Music 3）冒烟测试（不跑 GPU）。
 *
 * 覆盖：
 *  1) 清单可加载、能力/产物类型正确、未分档；
 *  2) 图注入：prompt → caption、duration → max_duration、seed/steps/cfg 落到正确节点；
 *  3) 音频清单不含 width/height 注入点（runner 会跳过分辨率）；
 *  4) duration 边界校验在**提交前**报错，且不产生画布节点。
 *
 * 用法：node scripts/smoke-music.mjs
 */
process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || '/nonexistent/svs-smoke-config.json'

import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBuiltinManifests, buildGraphFromManifest } from '../lib/manifest.js'
import { _internals } from '../lib/index.js'

let failures = 0
function ok(cond, msg) {
  if (cond) console.log('  ✓ ' + msg)
  else { failures++; console.error('  ✗ ' + msg) }
}

const root = join(process.cwd(), 'workflows')
const reg = loadBuiltinManifests(root)
const m = reg.byId['minimax-music3']

console.log('== 1) 清单 ==')
ok(!!m, 'minimax-music3 已加载')
ok(m?.capability === 'audio.music', 'capability = audio.music')
ok(m?.output?.mediaType === 'audio', 'output.mediaType = audio')
ok(m?.output?.sampleRate === 44100, 'output.sampleRate = 44100')
ok(m?.tier === undefined, '未分档（untiered）')
ok(reg.errors.length === 0, `清单库 0 错误（实际 ${reg.errors.length}）`)

console.log('== 2) 图注入 ==')
const g = buildGraphFromManifest(m, {
  prompt: 'cinematic ambient, instrumental',
  duration: 10, seed: 12345, steps: 30, cfg: 1.7, prefix: 'canvas/s1/n1',
})
ok(g['4'].inputs.caption === 'cinematic ambient, instrumental', 'prompt → node4.caption')
ok(g['4'].inputs.max_duration === 10, 'duration → node4.max_duration')
ok(g['4'].inputs.seed === 12345 && g['7'].inputs.seed === 12345, 'seed → node4 + node7')
ok(g['7'].inputs.steps === 30, 'steps → node7.steps')
ok(g['7'].inputs.cfg === 1.7 && g['4'].inputs.cfg_scale === 1.7, 'cfg → node7.cfg + node4.cfg_scale')
ok(g['9'].inputs.filename_prefix === 'canvas/s1/n1', 'prefix → node9.filename_prefix')
ok(g['9'].inputs.format === 'mp3', '默认输出 mp3')
ok(g['6'].inputs.seconds[0] === '4' && g['6'].inputs.seconds[1] === 1, 'latent 秒数取自 TextEncode 的 seconds 槽')
const gDefault = buildGraphFromManifest(m, { prompt: 'x', seed: 1, prefix: 'p' })
ok(gDefault['4'].inputs.max_duration === 30, '不传 duration → 用清单默认 30s')
const picked = await _internals.resolveTieredManifest('audio.music', null, null, { registry: reg, probe: false, selection: {}, cfg: {} })
ok(picked.manifest.id === 'minimax-music3', 'audio.music 档位解析 → minimax-music3')

console.log('== 3) 音频清单不含画面尺寸注入点 ==')
ok(!m.params.width && !m.params.height && !m.params.length, '无 width/height/length 注入点')

console.log('== 4) duration 边界（提交前报错） ==')
const workspace = join(tmpdir(), 'svs-music-smoke')
rmSync(workspace, { recursive: true, force: true })
mkdirSync(join(workspace, 'canvas', 's1'), { recursive: true })
const projectPath = join(workspace, 'canvas', 's1', 'project.json')
writeFileSync(projectPath, JSON.stringify({ schemaVersion: 1, sessionId: 's1', settings: {}, nodes: [] }))
const ctx = { workspaceRegistry: { get: () => ({ id: 'smoke', path: workspace }), list: () => [{ id: 'smoke', path: workspace, sessionIds: ['s1'] }] } }
const err = async (duration) => {
  try {
    await _internals.runRender(ctx, { workspaceId: 'smoke', sessionId: 's1', capability: 'audio.music', prompt: 'x', duration })
    return ''
  } catch (e) { return String(e.message) }
}
ok(/duration 太大/.test(await err(9999)), 'duration > 上限 → 报 duration 太大')
ok(/duration 非法/.test(await err(-1)), 'duration ≤ 0 → 报 duration 非法')
const nodesAfter = JSON.parse(readFileSync(projectPath, 'utf8')).nodes
ok(nodesAfter.length === 0, '被拒的请求没有在画布上留下节点')

console.log(failures ? `\n✗ ${failures} 项失败` : '\n✓ 全部通过')
process.exit(failures ? 1 : 0)
