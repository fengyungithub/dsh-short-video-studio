/**
 * scripts/experiment/mock-comfy.mjs — 假 ComfyUI（零 GPU 干跑）
 *
 * 用途：三 skill 一致性实验的 L1/L3/L4 层。真工具链、真画布、真门禁，只把「采样」换成假产物，
 * 并把**每次 /prompt 的完整 graph** 记进 trace —— 这是唯一可信的「实际发出去什么」证据
 * （prompt / tier / steps / width / length / seed / ref 上传，全在 graph 里）。
 *
 * 用法：
 *   node scripts/experiment/mock-comfy.mjs                # 默认 http://127.0.0.1:8299
 *   MOCK_COMFY_PORT=8300 MOCK_COMFY_OUT=experiment-out/run1 node scripts/experiment/mock-comfy.mjs
 *
 * 产物：
 *   <out>/comfy-trace.jsonl   每行 {t, kind:'prompt'|'upload'|'view', id, mediaKind, graph?}
 *   <out>/media/              假产物文件（.png / .wav / .mp4）
 *
 * 已知局限（写进实验报告的「有效性威胁」）：
 *   - 媒体是占位物：.mp4 只有 ftyp 头，不可播放；L1 只验证流程与参数，不验证观感。
 *   - 本机无 ffmpeg 时插件本来就降级到 ComfyUI 链路，mock 对它同样透明。
 */
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'

const PORT = Number(process.env.MOCK_COMFY_PORT || 8299)
const OUT = resolve(process.env.MOCK_COMFY_OUT || join(process.cwd(), 'experiment-out'))
const MEDIA = join(OUT, 'media')
mkdirSync(MEDIA, { recursive: true })
const TRACE = join(OUT, 'comfy-trace.jsonl')
writeFileSync(TRACE, '')

// ── 假媒体 ────────────────────────────────────────────────
// 合法 PNG 生成器（纯色图，指定尺寸）——裁切/探尺寸都要真尺寸，1×1 会让 image_crop 退化成非法矩形
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function makePng(w = 1344, h = 768, rgb = [236, 236, 240]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const PNG = makePng()

/** 合法 WAV（44 字节头 + 静音），时长可控——音频时长校验会读 WAV 头。 */
function makeWav(seconds = 3, rate = 22050) {
  const n = Math.round(seconds * rate)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  return buf
}

/** 带 ftyp 头的占位 mp4（不可播放；只为让扩展名/嗅探不炸）。 */
function makeMp4() {
  const ftyp = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x32])
  const free = Buffer.from('mock-comfy placeholder video — 实验用，不可播放')
  const box = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('free'), free])
  box.writeUInt32BE(box.length, 0)
  return Buffer.concat([ftyp, box])
}

const FILES = {
  'mock.png': PNG,
  'mock.wav': makeWav(4),
  'mock.mp4': makeMp4(),
}

function mediaFor(graph) {
  const classes = Object.values(graph || {})
    .map((n) => String(n?.class_type || ''))
    .join(' ')
  if (/SaveVideo|SaveAnimatedWEBP|VHS_VideoCombine/i.test(classes)) return { kind: 'videos', file: 'mock.mp4' }
  if (/SaveAudio|PreviewAudio/i.test(classes)) return { kind: 'audio', file: 'mock.wav' }
  return { kind: 'images', file: 'mock.png' }
}

const jobs = new Map() // prompt_id -> {kind, file, at}
const filesByName = new Map() // 每次生成给唯一文件名，避免同一 session 内多节点共用一个路径
const uploads = []

/** 从 graph / 上传体里抠出画布会话 id（插件把产物写成 canvas/<sessionId>/…）。 */
function sessionOf(text) {
  const m = String(text || '').match(/canvas[\/\\]([A-Za-z0-9_-]{6,})[\/\\]/)
  return m ? m[1] : ''
}

const trace = (obj) => appendFileSync(TRACE, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n')

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length })
  res.end(buf)
}

function readBody(req) {
  return new Promise((ok) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => ok(Buffer.concat(chunks)))
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname

  // 提交工作流
  if (req.method === 'POST' && path === '/prompt') {
    const raw = await readBody(req)
    let graph = {}
    try { graph = JSON.parse(raw.toString('utf8')).prompt || {} } catch {}
    const id = randomUUID()
    const { kind, file } = mediaFor(graph)
    const ext = file.split('.').pop()
    const unique = `mock-${id.slice(0, 8)}.${ext}`
    const bytes = FILES[file] || FILES['mock.png']
    filesByName.set(unique, bytes)
    jobs.set(id, { kind, file: unique })
    const nodes = Object.keys(graph).length
    const graphText = JSON.stringify(graph)
    trace({ kind: 'prompt', id, session: sessionOf(graphText), mediaKind: kind, nodes, media: unique, graph })
    return json(res, 200, { prompt_id: id, number: jobs.size, node_errors: {} })
  }

  // 轮询历史
  if (req.method === 'GET' && path.startsWith('/history/')) {
    const id = decodeURIComponent(path.slice('/history/'.length))
    const job = jobs.get(id)
    if (!job) return json(res, 200, {})
    const outNode = '9'
    return json(res, 200, {
      [id]: {
        prompt: [],
        outputs: { [outNode]: { [job.kind]: [{ filename: job.file, subfolder: '', type: 'output' }] } },
        status: { status_str: 'success', completed: true, messages: [] },
      },
    })
  }

  // 取产物
  if (req.method === 'GET' && path === '/view') {
    const file = url.searchParams.get('filename') || 'mock.png'
    const buf = filesByName.get(file) || FILES[file] || PNG
    trace({ kind: 'view', file, bytes: buf.length })
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length })
    return res.end(buf)
  }

  // 上传参考图 / 音频 / 视频：只记大小，不落盘
  if (req.method === 'POST' && path === '/upload/image') {
    const raw = await readBody(req)
    const name = 'mock-upload-' + (uploads.length + 1) + (extname(Buffer.from(raw.toString('latin1')).toString()) || '.bin')
    uploads.push({ bytes: raw.length })
    trace({ kind: 'upload', session: sessionOf(raw.toString('latin1')), bytes: raw.length, n: uploads.length })
    return json(res, 200, { name: 'mock-input.bin', subfolder: '', type: 'input' })
  }

  // 可用性预检：ComfyUI 对未知节点返回 {}，对已注册节点返回该类名条目。
  // 实验里一律「已注册」——否则插件会按设置页的实现声明判不可用（那是另一层实验）。
  if (req.method === 'GET' && path.startsWith('/object_info')) {
    const cls = decodeURIComponent(path.slice('/object_info/'.length))
    return json(res, 200, cls ? { [cls]: { name: cls } } : {})
  }
  if (req.method === 'GET' && path === '/queue') return json(res, 200, { queue_running: [], queue_pending: [] })
  if (req.method === 'GET' && path === '/') return json(res, 200, { mock: true })

  return json(res, 404, { error: 'mock-comfy: 未实现 ' + req.method + ' ' + path })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-comfy] http://127.0.0.1:${PORT}  trace → ${TRACE}`)
})
