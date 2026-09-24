#!/usr/bin/env node
/**
 * 探针：验证 extract-frame 清单（image.from_video）能真的从视频抽出帧。
 * 用的是 lib/manifest.js 的 buildGraphFromManifest，和生产同一条编译路径。
 *
 * 用法：node scripts/probe-extract-frame.mjs <本地mp4路径> [frame_index，默认 -1]
 */
import { readFile } from 'node:fs/promises'
import { basename, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBuiltinManifests, buildGraphFromManifest } from '../lib/manifest.js'

const BASE = process.env.COMFY_BASE_URL || 'http://localhost:8188'
const [clip, idxArg] = process.argv.slice(2)
if (!clip) {
  console.error('用法: node scripts/probe-extract-frame.mjs <clip.mp4> [frame_index]')
  process.exit(1)
}
const frameIndex = idxArg === undefined ? -1 : Number(idxArg)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const report = loadBuiltinManifests(resolve(root, 'workflows'))
if (report.errors.length) { console.error('清单校验失败:', report.errors); process.exit(1) }
const manifest = report.byId['extract-frame']
if (!manifest) { console.error('未找到 extract-frame 清单'); process.exit(1) }

// 上传（LoadVideo 只认 input 目录；/upload/image 同时接受 mp4）
const form = new FormData()
form.append('image', new Blob([await readFile(clip)]), basename(clip))
form.append('overwrite', 'true')
const up = await (await fetch(`${BASE}/upload/image`, { method: 'POST', body: form })).json()
if (!up?.name) { console.error('上传失败:', up); process.exit(1) }
console.log('已上传:', up.name, '→', up.type)

const graph = buildGraphFromManifest(manifest, {
  source_video: up.subfolder ? up.subfolder + '/' + up.name : up.name,
  frame_index: frameIndex,
  prefix: 'probe-extract',
})
console.log(`编译图：${Object.keys(graph).length} 节点，frame_index=${frameIndex}`)
console.log(JSON.stringify(graph, null, 1))

const res = await fetch(`${BASE}/prompt`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: graph }),
})
const submitted = await res.json()
if (!res.ok || submitted.error) { console.error('提交失败:', JSON.stringify(submitted, null, 2)); process.exit(1) }

const started = Date.now()
for (;;) {
  await new Promise((r) => setTimeout(r, 1000))
  const h = await (await fetch(`${BASE}/history/${submitted.prompt_id}`)).json()
  const entry = h[submitted.prompt_id]
  if (!entry) {
    if (Date.now() - started > 5 * 60 * 1000) { console.error('超时'); process.exit(1) }
    continue
  }
  if (entry.status?.status_str === 'error') { console.error('执行失败:', JSON.stringify(entry.status, null, 2)); process.exit(1) }
  if (entry.status?.completed) {
    console.log(`✓ 完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
    for (const nodeOut of Object.values(entry.outputs || {})) {
      for (const f of nodeOut.images || []) {
        const url = `${BASE}/view?filename=${encodeURIComponent(f.filename)}&type=${f.type}&subfolder=${encodeURIComponent(f.subfolder || '')}`
        const r = await fetch(url)
        console.log(`  ${f.filename} (${f.type}): ${r.status} ${r.headers.get('content-length')} bytes`)
      }
    }
    process.exit(0)
  }
}
