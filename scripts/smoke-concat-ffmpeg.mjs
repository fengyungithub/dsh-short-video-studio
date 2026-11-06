/**
 * scripts/smoke-concat-ffmpeg.mjs — 回归：ffmpegConcat 必须复用调用方探测到的 bin
 *
 * 背景（实验 L1-b 抓到）：runConcat 用 detectFfmpeg({roots:[root,packageRoot]}) 能向上层目录
 * 找到 ffmpeg，于是选 ffmpeg 后端；但 ffmpegConcat 内部又调了一次**无参** detectFfmpeg()（只看
 * PATH），拿不到同一个 bin 就抛 `concat-no-ffmpeg` —— ComfyUI 纯节点兜底永远不可达。
 *
 * 本测试用 stub ffmpeg（不在 PATH 上）证明：只要把 bin 传进去，拼接就能跑完。
 * 用法：node scripts/smoke-concat-ffmpeg.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ffmpegConcat } from '../lib/concat.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
let passed = 0
const ok = (cond, name) => { assert.ok(cond, name); passed++; console.log('  ok -', name) }

const dir = mkdtempSync(join(tmpdir(), 'dsh-svs-concat-smoke-'))
try {
  // stub ffmpeg：-version 返回 0；否则把最后一个参数当输出文件写出来
  const stub = join(dir, 'fake-ffmpeg')
  writeFileSync(stub, `#!/bin/sh
if [ "$1" = "-version" ]; then echo "ffmpeg version stub"; exit 0; fi
for last; do :; done
printf 'stub-output' > "$last"
exit 0
`)
  chmodSync(stub, 0o755)

  const a = join(dir, 'a.mp4')
  const b = join(dir, 'b.mp4')
  const out = join(dir, 'out.mp4')
  writeFileSync(a, 'a')
  writeFileSync(b, 'b')

  const r = await ffmpegConcat([a, b], out, stub)
  ok(r && r.reencoded === false, '显式传 bin 时走 stream copy 路径')
  ok(existsSync(out) && readFileSync(out, 'utf8') === 'stub-output', '产物由传入的 bin 生成')

  // 调用点文本断言：runConcat 必须把探测到的 bin 传下去
  const lib = readFileSync(join(root, 'lib/index.js'), 'utf8')
  ok(/ffmpegConcat\([^\n]*ffmpegBin\)/.test(lib), 'runConcat 把 ffmpegBin 传给 ffmpegConcat')
  ok(/export async function ffmpegConcat\(absPaths, outAbsPath, binArg\)/.test(readFileSync(join(root, 'lib/concat.js'), 'utf8')), 'ffmpegConcat 接受外部 bin')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(`\n✓ smoke-concat-ffmpeg：${passed} 项通过`)
