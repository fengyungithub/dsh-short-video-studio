/**
 * scripts/e2e-hires.mjs — 两阶段潜空间放大（hires）真机端到端验证。
 *
 * 用插件**真实的** manifest + getAssetOverrides（含用户 assetOverrides / models.* 兜底）
 * 编译图，直接提交给 ComfyUI，跑完对比耗时与画质。这是「清单能不能真出片」的验收入口。
 *
 * 用法：
 *   node scripts/e2e-hires.mjs --workflow minimax-h3-ref2v-hires [--length 124] [--steps 20] [--prompt "..."]
 *   node scripts/e2e-hires.mjs --compare        # 同时跑标准 quality 档做对照组
 */

process.env.DSH_SVS_CONFIG = process.env.DSH_SVS_CONFIG || `${process.env.HOME}/.dsh/dsh-short-video-studio.json`

import { _internals } from '../lib/index.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.DSH_SVS_COMFY_URL || 'http://localhost:8188'

const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const has = (k) => argv.includes('--' + k)

const WORKFLOW = arg('workflow', 'minimax-h3-ref2v-hires')
const LENGTH = Number(arg('length', '124'))
const STEPS = Number(arg('steps', '20'))
const COMPARE = has('compare')
// 参数扫描用：二遍 denoise / 步数（不传则用清单里的值）
const numArg = (k) => { const v = arg(k, undefined); return v === undefined || v === '' ? undefined : Number(v) }
const DENOISE = numArg('denoise')
const STEPS2 = numArg('steps2')
const PROMPT = arg('prompt',
  'A narrow rain-soaked alley at dusk. A woman in a red coat walks toward the camera, umbrella tilted forward, ' +
  'neon signage reflecting in the puddles. She stops, looks up, rain streaks across the frame. ' +
  'Handheld camera pushes in slowly. Ambient rain and distant traffic. No subtitles.')

const { buildGraphFromManifest, getRegistry, computeManifestSize, manifestDeliverySize, getAssetOverrides } = _internals

const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`)
  return r.json()
}

async function submit(name, manifestId) {
  const m = getRegistry().byId[manifestId]
  if (!m) throw new Error(`清单不存在: ${manifestId}`)
  const mode = m.tier || Object.keys(m.modes)[0]
  const size = computeManifestSize(m, mode, undefined, undefined, '16:9')
  const delivery = manifestDeliverySize(m, size)
  const tag = arg('tag', name)
  const prefix = `hires-e2e/${tag}`
  const graph = buildGraphFromManifest(m, {
    prompt: PROMPT, width: size.w, height: size.h, length: LENGTH, seed: 20260918,
    steps: STEPS, prefix, refs: [], first_frame: null, last_frame: null,
    assetOverrides: getAssetOverrides(m.id),
  })
  // 参数扫描：运行时覆盖二遍 denoise / 步数，**不改模板与清单**（扫完再决定固化哪个值）。
  // 定位方式：图里唯一 denoise<1 的 BasicScheduler 就是二遍调度器。
  if (DENOISE !== undefined || STEPS2 !== undefined) {
    let hit = 0
    for (const node of Object.values(graph)) {
      if (node.class_type === 'BasicScheduler' && Number(node.inputs.denoise) < 1) {
        if (DENOISE !== undefined) node.inputs.denoise = DENOISE
        if (STEPS2 !== undefined) node.inputs.steps = STEPS2
        hit++
      }
    }
    if (hit !== 1) throw new Error(`预期图里恰好一个二遍调度器，实际 ${hit} 个`)
    console.log(`  ⚙ 覆盖二遍参数：denoise=${DENOISE ?? '(默认)'} steps2=${STEPS2 ?? '(默认)'}`)
  }
  const t0 = Date.now()
  const { prompt_id } = await post('/prompt', { prompt: graph, client_id: 'hires-e2e' })
  console.log(`  ▸ 已提交 ${manifestId}（首遍 ${size.w}×${size.h} → 交付 ${delivery.w}×${delivery.h}，${LENGTH} 帧）prompt_id=${prompt_id.slice(0, 8)}`)
  // 轮询直到完成
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000))
    const h = await (await fetch(`${BASE}/history/${prompt_id}`)).json()
    const entry = h[prompt_id]
    if (!entry) continue
    const st = entry.status?.status_str
    if (st === 'error') {
      const msg = (entry.status?.messages || []).filter((m) => m[0] === 'execution_error').map((m) => JSON.stringify(m[1]).slice(0, 400))
      throw new Error(`执行失败：${msg.join(' | ')}`)
    }
    const secs = (Date.now() - t0) / 1000
    const files = Object.values(entry.outputs || {}).flatMap((o) => o.videos || o.images || []).map((f) => f.filename)
    console.log(`  ✓ ${manifestId} 完成：${secs.toFixed(1)}s，产物 ${JSON.stringify(files)}`)
    // 下载产物
    mkdirSync(resolve(ROOT, 'e2e-out/hires'), { recursive: true })
    for (const f of files) {
      const q = new URLSearchParams({ filename: f, subfolder: 'hires-e2e', type: 'output' })
      const buf = Buffer.from(await (await fetch(`${BASE}/view?${q}`)).arrayBuffer())
      const out = resolve(ROOT, `e2e-out/hires/${tag}-${f.replace(/^.*\//, '')}`)
      writeFileSync(out, buf)
      console.log(`    已存 ${out}（${(buf.length / 2 ** 20).toFixed(1)} MiB）`)
    }
    return { secs, files }
  }
}

const runs = COMPARE
  ? [['hires', 'minimax-h3-ref2v-hires'], ['quality', 'minimax-h3-ref2v-quality']]
  : [[WORKFLOW === 'minimax-h3-i2v-hires' ? 'hires-i2v' : 'hires', WORKFLOW]]

console.log(`ComfyUI ${BASE} · 帧数 ${LENGTH} · steps ${STEPS}${COMPARE ? ' · 对照组 quality' : ''}`)
try {
  const results = []
  for (const [name, id] of runs) results.push([id, await submit(name, id)])
  console.log('\n对比：')
  for (const [id, r] of results) console.log(`  ${id.padEnd(28)} ${r.secs.toFixed(1)}s`)
} catch (e) {
  console.error('✗ ' + e.message)
  process.exit(1)
}
