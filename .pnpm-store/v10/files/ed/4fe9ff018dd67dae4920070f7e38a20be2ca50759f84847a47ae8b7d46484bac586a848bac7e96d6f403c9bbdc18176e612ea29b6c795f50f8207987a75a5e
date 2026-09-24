#!/usr/bin/env node
/**
 * 探针：验证 ComfyUI 退化后端（不用 ffmpeg，纯节点拼接）能跑通。
 * 用的是 lib/concat.js 里的同一个 buildConcatGraph，避免探针与生产两份图。
 *
 * 用法：node scripts/probe-concat.mjs <本地mp4路径> <本地mp4路径> [...]
 * 脚本会先把片段上传到 ComfyUI input（LoadVideo 只认 input 目录）。
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { buildConcatGraph, detectFfmpeg } from '../lib/concat.js'

const BASE = process.env.COMFY_BASE_URL || 'http://localhost:8188'
const paths = process.argv.slice(2)
if (paths.length < 2) {
  console.error('用法: node scripts/probe-concat.mjs <clip1.mp4> <clip2.mp4> [...]')
  process.exit(1)
}

console.log('本机 ffmpeg:', (await detectFfmpeg()) ? '有（生产会走 ffmpeg 后端）' : '无（生产会走 ComfyUI 后端）')
console.log('本探针只测 ComfyUI 后端。')

const names = []
for (const p of paths) {
  const form = new FormData()
  form.append('image', new Blob([await readFile(p)]), basename(p))
  form.append('overwrite', 'true')
  const res = await fetch(`${BASE}/upload/image`, { method: 'POST', body: form })
  const body = await res.json()
  if (!res.ok || !body?.name) { console.error('上传失败:', p, body); process.exit(1) }
  names.push(body.subfolder ? body.subfolder + '/' + body.name : body.name)
  console.log('已上传:', body.name, '→', body.type)
}

const graph = buildConcatGraph(names, 'probe-concat')
console.log(`提交拼接图：${names.length} 段，${Object.keys(graph).length} 个节点`)

const res = await fetch(`${BASE}/prompt`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ prompt: graph }),
})
const submitted = await res.json()
if (!res.ok || submitted.error) {
  console.error('提交失败:', JSON.stringify(submitted, null, 2))
  process.exit(1)
}
console.log('prompt_id:', submitted.prompt_id)

const started = Date.now()
for (;;) {
  await new Promise((r) => setTimeout(r, 1500))
  const h = await (await fetch(`${BASE}/history/${submitted.prompt_id}`)).json()
  const entry = h[submitted.prompt_id]
  if (!entry) {
    if (Date.now() - started > 10 * 60 * 1000) { console.error('超时'); process.exit(1) }
    continue
  }
  if (entry.status?.status_str === 'error') {
    console.error('执行失败:', JSON.stringify(entry.status, null, 2))
    process.exit(1)
  }
  if (entry.status?.completed) {
    const outs = []
    for (const nodeOut of Object.values(entry.outputs || {})) {
      for (const key of ['videos', 'images', 'gifs']) for (const f of nodeOut[key] || []) outs.push(f)
    }
    console.log(`✓ 完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
    for (const f of outs) {
      const url = `${BASE}/view?filename=${encodeURIComponent(f.filename)}&type=${f.type}&subfolder=${encodeURIComponent(f.subfolder || '')}`
      const r = await fetch(url)
      console.log(`  ${f.filename} (${f.type}): ${r.status} ${r.headers.get('content-length')} bytes`)
    }
    process.exit(0)
  }
}
