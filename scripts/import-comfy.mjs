#!/usr/bin/env node
/**
 * scripts/import-comfy.mjs — CLI 包装：把 ComfyUI「导出 API」JSON 转成 workflow manifest 骨架。
 *
 * 核心转换逻辑在 lib/convert.js（与导入路由共用）。
 *
 * 用法：
 *   node scripts/import-comfy.mjs exported.json \
 *     --id sdxl-text2image --capability image.text2image --name "SDXL 文生图" \
 *     [--mediaType image] [--out out.json]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { convertComfyExport } from '../lib/convert.js'
import { validateManifest } from '../lib/manifest.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
function flag(name, dflt) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : dflt
}
const inputPath = args.find((a) => !a.startsWith('--'))
if (!inputPath) {
  console.error('用法: node scripts/import-comfy.mjs <exported.json> --id <id> --capability <cap> --name <显示名>')
  process.exit(1)
}
const id = flag('id', '')
const capability = flag('capability', '')
const name = flag('name', id || 'Imported Workflow')
const mediaType = flag('mediaType', 'image')
const outPath = flag('out', join(__dirname, '..', 'workflows', (id || 'imported') + '.json'))
if (!id || !capability) {
  console.error('缺少 --id 或 --capability（例如 image.text2image / video.text2video / video.image2video / video.reference2video）')
  process.exit(1)
}

const raw = JSON.parse(readFileSync(inputPath, 'utf8'))
const r = convertComfyExport(raw, { id, capability, displayName: name, mediaType })
if (!r.ok) { console.error('转换失败:', r.errors.join('; ')); process.exit(1) }

const v = validateManifest(r.manifest, id)
if (!v.ok) console.error('⚠️  生成的清单校验失败（仍会写出，请修复）:\n  - ' + v.errors.join('\n  - '))

writeFileSync(outPath, JSON.stringify(r.manifest, null, 2) + '\n', 'utf8')
console.log('✅ 已生成: ' + outPath)
console.log('')
if (r.todos.length) {
  console.log('=== 需手动补充（语义绑定，脚本无法推断） ===')
  r.todos.forEach((t) => console.log(' - ' + t))
  console.log('')
}
console.log('建议手动补：modes（fast/quality 档位）、resolution（分辨率策略）、constraints（时长/分辨率/角色上限）、output.hasAudio（视频音轨）。')
console.log('确认后复制到 ~/.dsh/dsh-short-video-studio/workflows/，或经设置页「导入工作流」粘贴导入。')
