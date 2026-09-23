/**
 * scripts/probe-2k-aspect.mjs — 「只锁倍率」两阶段放大（>2K 族）的**画幅比例**出片探针。
 *
 * 为什么需要它（而不是直接调插件工具）：
 *   插件进程是长驻的，`lib/*.js` 的校验/推导代码在**启动时**载入。改了 `resolutionLock` 契约之后，
 *   正在运行的进程仍在用旧模块——新的 2K 清单会被旧校验判非法并**从注册表里静默跳过**
 *   （症状：comfy_list_workflows 里整个 -2k 族消失）。而**任何新开的 node 进程**都立刻用新代码。
 *   所以本探针在独立进程里直接编译并提交图：既能立刻验证出片现实（分辨率/显存/音轨），
 *   又不依赖「重载插件」这个人工动作。
 *
 * 验什么：
 *   ① 首遍尺寸按画布比例推导（不再被锁在 16:9）
 *   ② 图内 RefineHandoff 的目标尺寸 = 首遍 × 2（算术模板算出来的，不是字面量）
 *   ③ 交付产物的**真实像素尺寸**（从 mp4 box 直读，不看工具自报）
 *   ④ 音轨还在
 *   ⑤ 显存/耗时是否可接受（1:1 的像素量是 16:9 的 1.78×，OOM 风险最高）
 *
 * 用法：
 *   node scripts/probe-2k-aspect.mjs --dry                      # 只打印尺寸推导与图的关键字段
 *   node scripts/probe-2k-aspect.mjs --ratio 9:16 --frames 56
 *   node scripts/probe-2k-aspect.mjs --ratio 1:1  --frames 24
 *   node scripts/probe-2k-aspect.mjs --workflow minimax-h3-i2v-ctx-fast-2k --ratio 9:16
 *
 * 注意：`--frames` 会按清单声明的 lengthGrid 向上取整（H3 = 17k+5）。
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
const num = (k, d) => { const v = arg(k, undefined); return v === undefined ? d : Number(v) }

const WF = arg('workflow', 'minimax-h3-ref2v-ctx-fast-2k')
const RATIO = arg('ratio', '9:16')
const FRAMES = num('frames', 124)
const SEED = num('seed', 20261001)
const DRY = has('dry')
const TAG = arg('tag', `${WF.replace(/^minimax-h3-/, '')}-${RATIO.replace(':', 'x')}-f${FRAMES}`)

const PROMPT = arg('prompt', `subject_definitions:
<Subject 1> is a young woman with shoulder-length dark hair, wearing a light beige trench coat, defined from this prompt's text description only (no reference asset is supplied in this probe).
<Subject 2> is the rooftop environment: a high-rise rooftop at night, low parapet wall, wet concrete, and distant neon signage.

summary:
A text-only reference-mode generation of one continuous shot: <Subject 1> stands at the edge of <Subject 2>, wind moving her hair, camera slowly pushing in.

retention_analysis:
<Subject 1> is fully preserved across the whole shot: hair length, coat, and facial structure stay consistent. <Subject 2> is fully preserved as the surrounding environment; the magenta and cyan neon palette and the wet concrete remain visible behind the subject for the entire shot.

detailed_description:
[Shot 1] Night. <Subject 1> stands centered at the edge of <Subject 2>, her back to a wall of out-of-focus neon signage in magenta and cyan, her face turned three-quarters toward camera. Wind lifts strands of her hair across her cheek and the hem of her coat flutters. The camera pushes in slowly and steadily from a medium shot to a medium close-up over about 5 seconds. Her lips stay closed and she does not speak.

overall_soundscape:
Steady low wind moving across the rooftop, a thin whistle around the parapet edge, and a distant city traffic hum with an occasional far-off car horn. No footsteps, no voices.

non_diegetic_music:
N/A`)

const { getRegistry, computeManifestSize, manifestDeliverySize, resolutionLockWarning, buildGraphFromManifest, getAssetOverrides, snapLengthToGrid } = _internals

const m = getRegistry().byId[WF]
if (!m) throw new Error(`注册表里找不到 ${WF}（可用 -2k 清单：${Object.keys(getRegistry().byId).filter((k) => k.endsWith('-2k')).join(', ')}）`)
if (!m.resolutionLock) throw new Error(`${WF} 没声明 resolutionLock，本探针不适用`)

// 帧数按声明的网格向上取整（真实渲染也是这么做的），否则 ComfyUI 侧参数校验会挡
const FRAMES_SNAPPED = m.chain ? snapLengthToGrid(FRAMES, m.chain.lengthGrid) : FRAMES
if (FRAMES_SNAPPED !== FRAMES) console.log(`\n  帧数 ${FRAMES} 不在网格上 → 向上取整为 ${FRAMES_SNAPPED}`)

// ── 尺寸推导（真实渲染走的就是这条）────────────────────────────────────────────
const mode = m.tier
const first = computeManifestSize(m, mode, undefined, undefined, RATIO)
const delivery = manifestDeliverySize(m, first)
const warn = resolutionLockWarning(m, first)
const locked = Array.isArray(m.resolutionLock.graph)

console.log(`\n清单 ${WF}`)
console.log(`  档位 ${m.tier} · 长边 ${m.modes?.[mode]?.longSide} · resolutionLock = ${JSON.stringify(m.resolutionLock).slice(0, 80)}…`)
console.log(`  形态 ${locked ? '图锁定（首遍被钉死）' : '只锁倍率（首遍不锁）'}`)
console.log(`  画幅 ${RATIO} → 首遍 ${first.w}×${first.h} → 交付 ${delivery.w}×${delivery.h}`)
console.log(`  声明比例 ${JSON.stringify(m.constraints?.aspectRatios)} · maxDurationFrames ${m.constraints?.maxDurationFrames}`)
if (warn) console.log(`  警告 ${warn}`)

// ── 编译图 ────────────────────────────────────────────────────────────────────
const prefix = `probe-2k-aspect/${TAG}`
// ctx 族声明了 chain ⇒ 图里有 Load/Save 两个链序号必须注入（真实渲染由 allocateChainIndex 分配）。
// 本探针跑的是**起链**（不接上一镜）：Load=0（没有上文），Save 取一个本会话外的一次性序号。
const chainSaveIdx = 900000 + (Number(process.env.DSH_PROBE_CLIP_IDX) || Math.floor(Math.random() * 90000))
const graph = buildGraphFromManifest(m, {
  prompt: PROMPT, width: first.w, height: first.h, length: FRAMES_SNAPPED, seed: SEED,
  steps: m.modes?.[mode]?.steps ?? 20, prefix, refs: [], first_frame: null, last_frame: null,
  assetOverrides: getAssetOverrides(m.id),
  ...(m.chain ? { context_clip_index: 0, save_clip_index: chainSaveIdx } : {}),
})

const rh = Object.values(graph).find((n) => n.class_type === 'MinimaxH3LatentUpscaler3DRefineHandoff')
const injected = { w: graph['5']?.inputs.width, h: graph['5']?.inputs.height }
console.log(`  图内首遍注入 ${injected.w}×${injected.h} · RefineHandoff 目标 ${rh?.inputs.width}×${rh?.inputs.height}`)
if (injected.w !== first.w || injected.h !== first.h) throw new Error('首遍注入值与推导不一致')
if (rh?.inputs.width !== delivery.w || rh?.inputs.height !== delivery.h) {
  throw new Error(`RefineHandoff 目标 ${rh?.inputs.width}×${rh?.inputs.height} != 推导交付 ${delivery.w}×${delivery.h}`)
}
if (graph['22'] && JSON.stringify(graph['22'].inputs.latent) !== JSON.stringify(['10', 0])) {
  throw new Error('链式存档没有读首遍 latent（node 22 ← node 10）——续接契约被破坏')
}

if (DRY) { console.log('\n(--dry：未提交)\n'); process.exit(0) }

// ── 提交 / 轮询 ───────────────────────────────────────────────────────────────
const post = async (path, body) => {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`)
  return r.json()
}

/** 从 mp4 box 树直读视频轨尺寸（不依赖 ffprobe）。 */
function mp4Dims(buf) {
  const CONT = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta'])
  let video = null, audio = null, dur = null
  const walk = (off, end) => {
    while (off < end - 8) {
      let size = buf.readUInt32BE(off)
      const typ = buf.toString('latin1', off + 4, off + 8)
      let hdr = 8
      if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); hdr = 16 }
      if (size < hdr) break
      if (CONT.has(typ)) walk(off + hdr, off + size)
      else if (typ === 'stsd') {
        const n = buf.readUInt32BE(off + 12)
        let e = off + 16
        for (let i = 0; i < n; i++) {
          const esz = buf.readUInt32BE(e)
          const etyp = buf.toString('latin1', e + 4, e + 8)
          if (etyp === 'avc1' || etyp === 'hvc1' || etyp === 'hev1') {
            video = { w: buf.readUInt16BE(e + 8 + 24), h: buf.readUInt16BE(e + 8 + 26), codec: etyp }
          } else if (etyp === 'mp4a') {
            audio = { codec: etyp, channels: buf.readUInt16BE(e + 8 + 16), rate: buf.readUInt32BE(e + 8 + 24) >> 16 }
          }
          e += esz
        }
      } else if (typ === 'mdhd') {
        const v = buf[off + 8]
        const ts = v === 1 ? off + 8 + 4 + 16 : off + 8 + 4 + 8
        const scale = buf.readUInt32BE(ts)
        const d = v === 1 ? Number(buf.readBigUInt64BE(ts + 4)) : buf.readUInt32BE(ts + 4)
        if (scale > 0 && !dur) dur = d / scale
      }
      off += size
    }
  }
  walk(0, buf.length)
  return { video, audio, dur }
}

console.log(`\n  ▸ 提交 ${BASE} …`)
const t0 = Date.now()
const { prompt_id } = await post('/prompt', { prompt: graph, client_id: 'probe-2k-aspect' })
console.log(`  prompt_id=${prompt_id.slice(0, 8)}`)

let files = []
for (;;) {
  await new Promise((r) => setTimeout(r, 5000))
  const h = await (await fetch(`${BASE}/history/${prompt_id}`)).json()
  const entry = h[prompt_id]
  if (!entry) {
    const q = await (await fetch(`${BASE}/queue`)).json()
    const running = (q.queue_running || []).length
    process.stdout.write(`\r  运行中… ${((Date.now() - t0) / 1000).toFixed(0)}s（队列 ${running}）   `)
    continue
  }
  const st = entry.status?.status_str
  if (st === 'error') {
    const msgs = (entry.status?.messages || []).filter((x) => x[0] === 'execution_error').map((x) => JSON.stringify(x[1]).slice(0, 900))
    throw new Error(`执行失败：${msgs.join(' | ')}`)
  }
  files = Object.values(entry.outputs || {}).flatMap((o) => o.videos || o.images || [])
  break
}

const secs = (Date.now() - t0) / 1000
console.log(`\n  ✓ 完成 ${secs.toFixed(1)}s · ${files.map((f) => f.filename).join(', ')}`)

mkdirSync(resolve(ROOT, 'e2e-out/2k-aspect'), { recursive: true })
let fail = 0
for (const f of files) {
  const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' })
  const buf = Buffer.from(await (await fetch(`${BASE}/view?${q}`)).arrayBuffer())
  const out = resolve(ROOT, `e2e-out/2k-aspect/${TAG}.mp4`)
  writeFileSync(out, buf)
  const d = mp4Dims(buf)
  const [rw, rh2] = RATIO.split(':').map(Number)
  const okW = d.video?.w === delivery.w, okH = d.video?.h === delivery.h
  const ratioOk = d.video && Math.abs((d.video.w / d.video.h) - (rw / rh2)) < 0.02
  console.log(`\n  ── 产物核验 ${f.filename}`)
  console.log(`     视频轨   ${d.video ? `${d.video.w}×${d.video.h} (${d.video.codec})` : '缺失'}`)
  console.log(`     期望     ${delivery.w}×${delivery.h}`)
  console.log(`     音轨     ${d.audio ? `${d.audio.codec} ${d.audio.channels}ch ${d.audio.rate}Hz` : '缺失'}`)
  console.log(`     时长     ${d.dur ? d.dur.toFixed(2) + 's' : '?'}（请求 ${FRAMES_SNAPPED} 帧 @24fps ≈ ${(FRAMES_SNAPPED / 24).toFixed(2)}s）`)
  console.log(`     文件     ${out}（${(buf.length / 2 ** 20).toFixed(1)} MiB）`)
  const checks = [
    ['视频尺寸 == 推导交付', okW && okH],
    ['画幅比例 == 请求比例', Boolean(ratioOk)],
    ['音轨存在（AV 模型自带声音）', Boolean(d.audio)],
  ]
  for (const [name, pass] of checks) {
    console.log(`     ${pass ? '✓' : '✗'} ${name}`)
    if (!pass) fail++
  }
}
console.log('')
if (fail) { console.error(`✗ ${fail} 项核验失败`); process.exit(1) }
console.log('✓ 全部核验通过')
