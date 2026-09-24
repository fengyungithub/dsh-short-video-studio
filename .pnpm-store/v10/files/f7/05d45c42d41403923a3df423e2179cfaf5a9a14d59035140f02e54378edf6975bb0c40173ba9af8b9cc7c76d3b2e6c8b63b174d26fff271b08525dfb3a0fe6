#!/usr/bin/env node
/**
 * scripts/e2e-comfy.mjs — 端到端验收：清单 → 编译图 → 提交 ComfyUI → 轮询 → 下载产物。
 *
 * 用法：
 *   node scripts/e2e-comfy.mjs <manifest.json> \
 *     --prompt "a cute orange cat" --width 1024 --height 1024 --seed 42 --steps 8 \
 *     [--baseUrl http://localhost:8188] [--prefix e2e] [--outDir /tmp]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildGraphFromManifest, validateManifest } from '../lib/manifest.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
function flag(name, dflt) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : dflt
}
const manifestPath = args.find((a) => !a.startsWith('--'))
if (!manifestPath) {
  console.error('用法: node scripts/e2e-comfy.mjs <manifest.json> --prompt <词> [--width] [--height] [--seed] [--steps]')
  process.exit(1)
}
const baseUrl = flag('baseUrl', 'http://localhost:8188').replace(/\/+$/, '')
const outDir = flag('outDir', join(__dirname, '..', 'e2e-out'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 清单 → 图 ----------
const m = JSON.parse(readFileSync(manifestPath, 'utf8'))
const v = validateManifest(m, m.id || 'manifest')
if (!v.ok) { console.error('清单校验失败:', v.errors.join('; ')); process.exit(1) }

const job = {
  prompt: flag('prompt', 'a test image'),
  width: parseInt(flag('width', '0'), 10) || undefined,
  height: parseInt(flag('height', '0'), 10) || undefined,
  seed: parseInt(flag('seed', '0'), 10) || undefined,
  steps: parseInt(flag('steps', '0'), 10) || undefined,
  guidance: parseFloat(flag('guidance', '0')) || undefined,
  prefix: flag('prefix', m.id || 'e2e'),
}
Object.keys(job).forEach((k) => job[k] === undefined && delete job[k])

const graph = buildGraphFromManifest(m, job)
console.log(`[1/4] 清单 ${m.id}（${m.capability}）已编译：${Object.keys(graph).length} 节点`)
console.log('      job =', JSON.stringify(job))

// ---------- 提交 ----------
const clientId = 'dsh-svs-e2e-' + Math.random().toString(36).slice(2)
const resp = await fetch(baseUrl + '/prompt', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: graph, client_id: clientId }),
})
if (!resp.ok) { console.error('[提交失败]', resp.status, await resp.text()); process.exit(1) }
const { prompt_id, error } = await resp.json()
if (error) { console.error('[ComfyUI 报错]', JSON.stringify(error)); process.exit(1) }
console.log('[2/4] 已提交 prompt_id =', prompt_id)

// ---------- 轮询 ----------
let entry = null
let waited = 0
while (waited < 600000) {
  await sleep(2000)
  waited += 2000
  const h = await fetch(baseUrl + '/history/' + prompt_id).then((r) => r.json())
  entry = h && h[prompt_id]
  if (!entry) continue
  const st = entry.status || {}
  if (st.status_str === 'error') {
    console.error('[3/4] 生成报错:', JSON.stringify(st, null, 2))
    // 打印关键节点报错信息
    for (const [nid, n] of Object.entries(entry.outputs || {})) console.error(`      节点 ${nid}:`, JSON.stringify(n))
    process.exit(1)
  }
  if (st.completed) break
  if (waited % 10000 === 0) console.log('      轮询中…', (waited / 1000) + 's')
}
if (!entry || !(entry.status || {}).completed) { console.error('[3/4] 超时'); process.exit(1) }
console.log('[3/4] 生成完成')

// ---------- 下载 ----------
const images = []
for (const [nid, out] of Object.entries(entry.outputs || {})) {
  for (const img of out.images || []) images.push({ nid, ...img })
}
if (!images.length) { console.error('[4/4] 无输出图像。outputs =', JSON.stringify(entry.outputs)); process.exit(1) }

mkdirSync(outDir, { recursive: true })
let saved = []
for (const img of images) {
  const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' })
  const bin = await fetch(baseUrl + '/view?' + q.toString()).then((r) => r.arrayBuffer())
  const out = join(outDir, img.filename)
  writeFileSync(out, Buffer.from(bin))
  saved.push(out)
}
console.log('[4/4] 已保存产物:')
saved.forEach((p) => console.log('      ' + p))
console.log('✅ 端到端通过：', m.id, '→', m.capability)
