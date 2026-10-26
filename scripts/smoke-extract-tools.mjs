/**
 * scripts/smoke-extract-tools.mjs — extract_frame / extract_audio 路由回归。
 *
 * 两个历史 bug：
 *  1) extract_audio 的 execute 丢了 exec → 不传 sessionId 时 sessionId required；
 *  2) extract_frame 走 runRender 时被通用 prompt 门禁拦截（image.from_video 不需要 prompt）。
 *
 * 这里用纯函数 + 代码形状检查（不提交 ComfyUI 任务）。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _internals } from '../lib/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'lib/index.js'), 'utf8')
const tools = readFileSync(join(root, 'scripts/smoke-tools.mjs'), 'utf8') // 仅为存在性
let pass = 0
let fail = 0
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}`) }
}

ok('image.from_video 不需要 prompt', _internals.isPromptFreeCapability('image.from_video') === true)
ok('video.reference2video 仍需要 prompt', _internals.isPromptFreeCapability('video.reference2video') === false)
ok('runRender 使用 prompt-free 判定', src.includes('const promptFree = isPromptFreeCapability(manifest.capability)'))
ok('prompt-free 时跳过缺少 prompt 抛错', src.includes('if (!effectivePrompt && !promptFree)'))

const audioStart = src.indexOf("name: 'extract_audio'")
const audioEnd = src.indexOf('const upscaleTool', audioStart)
const audioBlock = audioStart >= 0 ? src.slice(audioStart, audioEnd) : ''
ok('extract_audio.execute 接收 exec', /async execute\(args, exec\)/.test(audioBlock))
ok('extract_audio 把 exec 传给 runExtractAudio', audioBlock.includes('runExtractAudio(ctx, { ...args, exec })'))
ok('extract_frame 走 image.from_video 且带 exec', src.includes("capability: 'image.from_video'") && /runRender\(ctx, \{[\s\S]{0,400}?exec,/.test(src))
ok('smoke-tools.mjs 存在', tools.includes('asset_ingest') || tools.length > 0)

console.log('')
if (fail) {
  console.log(`✗ smoke-extract-tools：${pass} 通过 / ${fail} 失败`)
  process.exit(1)
} else {
  console.log(`✓ smoke-extract-tools：${pass} 通过 / 0 失败`)
}
