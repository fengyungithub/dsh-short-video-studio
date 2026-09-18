#!/usr/bin/env node
/**
 * 冒烟：资产库的三种载体（image / video / text）与删除链路。
 *
 * 为什么要对**真路由**发请求而不是只测纯函数：入库/删除的坑大多在边界上——
 * 「视频节点被登记成角色卡」「文本节点没有 content」「删了索引但文件还在」
 * 「视频资产的 /media 404」（后者是 resolveAssetImagePath 只认图片导致的）。
 * 这些只有走一遍 handleApi/handleMedia 才看得出来。
 *
 * 隔离：HOME / 插件配置 / skill 安装全部改指临时目录，绝不碰真实 ~/.dsh
 * （apply() 会调 installBundledSkills()，不隔离会写用户的 skills 目录）。
 *
 * 用法：node scripts/smoke-assets.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

const HOME = mkdtempSync(join(tmpdir(), 'svs-assets-home-'))
process.env.HOME = HOME
process.env.DSH_SVS_CONFIG = join(HOME, 'config.json')
process.env.DSH_SVS_SKILL_REFRESH = 'off'

const { apply, _internals } = await import('../lib/index.js')
const {
  loadLibrary, saveLibrary, registerAsset, removeAsset, assetKind, assetStoredFile,
  resolveAssetPath, resolveAssetImagePath, assetTypesForKind, normalizeAssetId,
  isAssetRef, assetFile,
} = await import('../lib/assets.js')

const { copyAssetToCanvas, ROUTE_ROOT, CANVAS_DIR } = _internals

let passed = 0
let failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}
const eq = (name, actual, expected) => ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)

// ---------------------------------------------------------------------------
// 与运行期同源的假宿主：只实现 handleApi/handleMedia 真正用到的那几件事
// ---------------------------------------------------------------------------
class FakeRes extends Writable {
  constructor() { super(); this.status = 0; this.headers = {}; this.chunks = []; this.headersSent = false }
  writeHead(status, headers) { this.status = status; this.headers = { ...(headers || {}) }; this.headersSent = true }
  _write(chunk, _enc, cb) { this.chunks.push(Buffer.from(chunk)); cb() }
  get body() { return Buffer.concat(this.chunks) }
  json() { return JSON.parse(this.body.toString('utf8')) }
}

function makeReq(method, url, body, headers = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { ...headers },
    async *[Symbol.asyncIterator]() { for (const c of payload) yield c },
  }
}

// realpathSync 是必需的：macOS 的 tmpdir 是 /var/...（软链到 /private/var/...），
// handleMedia 会对 realpath 结果做「是否在工作区内」校验，用软链路径建工作区会 403。
const WORKSPACE = mkdtempSync(join(realpathSync(tmpdir()), 'svs-assets-ws-'))
const SID = 'session-assets-a'
const SID2 = 'session-assets-b'

let handler = null
const mockCtx = new Proxy({
  webServer: { register: (route) => { if (route.handler) handler = route.handler; return () => {} } },
  tools: { register: () => () => {}, get: () => undefined, execute: async () => ({}) },
  systemPrompt: { section: () => () => {} },
  workspaceRegistry: {
    get: (id) => (String(id) === 'ws-assets' ? { id: 'ws-assets', path: WORKSPACE, sessionIds: [SID, SID2] } : undefined),
    list: () => [{ id: 'ws-assets', path: WORKSPACE, sessionIds: [SID, SID2] }],
    resolveByPath: async () => undefined,
  },
  effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
}, { get: (t, p) => (p in t ? t[p] : () => () => {}) })

// API 走 ROUTE_ROOT + '/api'；'/' 是静态 index.html（用来取 token）
async function call(method, path, { body, token } = {}) {
  const res = new FakeRes()
  const headers = token ? { 'x-dsh-svs-token': token } : {}
  // /media 不在 /api 前缀下（它的 token 也走 query，不走 header）
  const base = path === '/'
    ? ROUTE_ROOT + '/'
    : path.startsWith('/media') ? ROUTE_ROOT + path : ROUTE_ROOT + '/api' + path
  const url = base + (base.includes('?') ? '&' : '?') + 'sessionId=' + SID + '&workspaceId=ws-assets'
  await handler(makeReq(method, url, body, headers), res)
  // handleMedia 用 createReadStream().pipe(res)，是异步落盘的：不等 finish 就断言会读到半个
  // body（这个坑在本脚本里真实踩过一次）。加超时兜底，避免路径写错时整个脚本挂死。
  if (!res.writableEnded) {
    await Promise.race([
      new Promise((r) => res.once('finish', r)),
      new Promise((r) => setTimeout(r, 3000)),
    ])
  }
  return res
}

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_BUF = Buffer.from(PNG_B64, 'base64')
const MP4_BUF = Buffer.from('00000018667479706d703432', 'hex') // ftyp mp42 头，够当「存在的视频文件」

try {
  apply(mockCtx)
  ok('apply() 注册了 HTTP 路由', typeof handler === 'function')

  // 取 token：静态路由不带鉴权，index.html 里注入的就是运行期 token
  const page = await call('GET', '/')
  const token = (page.body.toString('utf8').match(/__DSH_SVS_TOKEN__ = "([^"]+)"/) || [])[1]
  ok('从 studio/index.html 取到 token（也顺带验证了 token 注入）', Boolean(token))

  // 无 token 必须被挡
  const noToken = await call('GET', '/assets')
  eq('GET /assets 无 token → 403', noToken.status, 403)

  // --- 造一份画布：图片 / 视频 / 文本 / 表格 / 无内容文本 / 未知类型 -----------
  const canvasDir = join(WORKSPACE, CANVAS_DIR, SID)
  mkdirSync(canvasDir, { recursive: true })
  const imgName = 'img-1.png'
  const vidName = 'vid-1.mp4'
  writeFileSync(join(canvasDir, imgName), PNG_BUF)
  writeFileSync(join(canvasDir, vidName), MP4_BUF)
  const node = (id, kind, extra = {}) => ({
    id, kind, title: extra.title || id, group: 'g', status: 'ready', order: 0, createdAt: 1, ...extra,
  })
  const project = {
    schemaVersion: 1,
    sessionId: SID,
    settings: { aspectRatio: '16:9', duration: '30 秒', audioMode: 'silent' },
    nodes: [
      node('n-img', 'image', { media: `${CANVAS_DIR}/${SID}/${imgName}`, params: { seed: 7, prompt: 'a fox' } }),
      node('n-vid', 'video', { media: `${CANVAS_DIR}/${SID}/${vidName}`, params: { length: 124 } }),
      node('n-text', 'text', { content: '# 分镜文档\n\n第一镜：狐狸抬头看星星。' }),
      node('n-table', 'table', { content: '| 镜号 | 内容 |\n|---|---|\n| S01 | 抬头 |' }),
      node('n-empty', 'text', {}),
      node('n-audio', 'audio', { media: 'x.mp3' }),
    ],
  }
  writeFileSync(join(canvasDir, 'project.json'), JSON.stringify(project, null, 2))

  // ---------------------------------------------------------------------------
  console.log('\n[1] 入库：三种载体')
  // ---------------------------------------------------------------------------
  const rImg = await call('POST', '/assets', { token, body: { nodeId: 'n-img', type: 'character', name: 'luna' } })
  eq('图片节点入库 → 200', rImg.status, 200)
  eq('  ……kind=image', rImg.json().kind, 'image')

  const rVid = await call('POST', '/assets', { token, body: { nodeId: 'n-vid', type: 'clip', name: 'shot01' } })
  eq('视频节点入库 → 200', rVid.status, 200)
  eq('  ……kind=video', rVid.json().kind, 'video')
  eq('  ……id', rVid.json().id, 'clip:shot01')

  const rTxt = await call('POST', '/assets', { token, body: { nodeId: 'n-text', type: 'text', name: 'storyboard' } })
  eq('文本节点入库 → 200', rTxt.status, 200)
  eq('  ……kind=text', rTxt.json().kind, 'text')

  const rTbl = await call('POST', '/assets', { token, body: { nodeId: 'n-table', type: 'text', name: 'shotlist' } })
  eq('表格节点入库 → 200（也算文本载体）', rTbl.status, 200)

  const lib = loadLibrary(WORKSPACE)
  eq('视频资产的 kind', assetKind(lib.assets['clip:shot01']), 'video')
  eq('视频资产的文件扩展名沿用源文件', assetStoredFile(lib.assets['clip:shot01']).endsWith('.mp4'), true)
  ok('视频资产记录里没有残留的 image 字段', !('image' in lib.assets['clip:shot01']))
  eq('文本资产存正文（不是文件）', typeof lib.assets['text:storyboard'].text, 'string')
  ok('文本资产正文与节点内容一致', lib.assets['text:storyboard'].text.includes('狐狸抬头看星星'))
  eq('文本资产没有文件字段', assetStoredFile(lib.assets['text:storyboard']), null)
  eq('表格节点的 nodeKind 保住了（取回画布仍是表格）', lib.assets['text:shotlist'].nodeKind, 'table')
  eq('图片资产的 seed 元数据仍被带上', lib.assets['character:luna'].seed, 7)

  // ---------------------------------------------------------------------------
  console.log('\n[2] 入库：拒绝非法组合（这些是 UI 之外的第二道闸）')
  // ---------------------------------------------------------------------------
  const bad1 = await call('POST', '/assets', { token, body: { nodeId: 'n-vid', type: 'character', name: 'oops' } })
  eq('视频节点 + type=character → 400', bad1.status, 400)
  ok('  错误信息点明允许的类型', bad1.json().message.includes('clip'), bad1.json().message)

  const bad2 = await call('POST', '/assets', { token, body: { nodeId: 'n-img', type: 'text', name: 'oops' } })
  eq('图片节点 + type=text → 400', bad2.status, 400)

  const bad3 = await call('POST', '/assets', { token, body: { nodeId: 'n-audio', type: 'clip', name: 'oops' } })
  eq('audio 节点 → 400（不支持该节点类型）', bad3.status, 400)

  const bad4 = await call('POST', '/assets', { token, body: { nodeId: 'n-empty', type: 'text', name: 'empty' } })
  eq('空文本节点 → 400（节点没有文本内容）', bad4.status, 400)

  const bad5 = await call('POST', '/assets', { token, body: { nodeId: 'nope', type: 'clip', name: 'x' } })
  eq('节点不存在 → 404', bad5.status, 404)

  const bad6 = await call('POST', '/assets', { token, body: { nodeId: 'n-vid', type: 'clip', name: '中文名' } })
  eq('非法资产名 → 400', bad6.status, 400)

  // ---------------------------------------------------------------------------
  console.log('\n[3] 媒体伺服：视频资产必须能放出来')
  // ---------------------------------------------------------------------------
  const vm = await call('GET', '/media?asset=' + encodeURIComponent('clip:shot01') + '&token=' + encodeURIComponent(token))
  eq('视频资产 /media → 200', vm.status, 200)
  eq('  ……content-type 是 video/mp4', vm.headers['content-type'], 'video/mp4')
  ok('  ……字节与入库源文件一致', vm.body.equals(MP4_BUF))

  const im = await call('GET', '/media?asset=' + encodeURIComponent('character:luna') + '&token=' + encodeURIComponent(token))
  eq('图片资产 /media → 200', im.status, 200)
  eq('  ……content-type 是 image/png', im.headers['content-type'], 'image/png')

  const noTok = await call('GET', '/media?asset=' + encodeURIComponent('clip:shot01'))
  eq('media 缺 token → 403', noTok.status, 403)

  // ---------------------------------------------------------------------------
  console.log('\n[4] 取回画布：三种载体产物化')
  // ---------------------------------------------------------------------------
  const toVid = await call('POST', '/assets/to-canvas', { token, body: { id: 'clip:shot01' } })
  eq('视频资产 → 画布 → 200', toVid.status, 200)
  let proj = JSON.parse(readFileSync(join(canvasDir, 'project.json'), 'utf8'))
  const vNode = proj.nodes.find((n) => n.id === toVid.json().nodeId)
  eq('  产物节点 kind=video', vNode.kind, 'video')
  eq('  产物绑定资产 id', vNode.params.assetId, 'clip:shot01')
  ok('  产物媒体文件已落到本会话画布目录', existsSync(join(WORKSPACE, ...vNode.media.split('/'))))

  const toTxt = await call('POST', '/assets/to-canvas', { token, body: { id: 'text:storyboard' } })
  proj = JSON.parse(readFileSync(join(canvasDir, 'project.json'), 'utf8'))
  const tNode = proj.nodes.find((n) => n.id === toTxt.json().nodeId)
  eq('文本资产 → 产物节点 kind=text', tNode.kind, 'text')
  ok('  正文被带回来', tNode.content.includes('狐狸抬头看星星'))
  ok('  文本产物不产生媒体文件', !tNode.media)

  const toTbl = await call('POST', '/assets/to-canvas', { token, body: { id: 'text:shotlist' } })
  proj = JSON.parse(readFileSync(join(canvasDir, 'project.json'), 'utf8'))
  eq('表格类文本资产 → 产物节点仍是 table', proj.nodes.find((n) => n.id === toTbl.json().nodeId).kind, 'table')

  // ---------------------------------------------------------------------------
  console.log('\n[5] 删除：索引 + 文件，且不误删共享文件')
  // ---------------------------------------------------------------------------
  const list0 = (await call('GET', '/assets', { token })).json().assets
  ok('GET /assets 返回 kind 字段（前端不必自己推导）', list0.every((a) => a.kind), JSON.stringify(list0.map((a) => [a.id, a.kind])))
  eq('  其中视频/文本都在', [list0.some((a) => a.kind === 'video'), list0.some((a) => a.kind === 'text')].join(','), 'true,true')

  const vidAbs = resolveAssetPath(WORKSPACE, lib, 'clip:shot01')
  ok('视频资产文件在磁盘上', existsSync(vidAbs))

  const del1 = await call('DELETE', '/assets?id=' + encodeURIComponent('clip:shot01'), { token })
  eq('删除视频资产 → 200', del1.status, 200)
  eq('  服务端报告文件已清理', del1.json().fileDeleted, true)
  ok('  文件真的没了', !existsSync(vidAbs))
  const after1 = (await call('GET', '/assets', { token })).json().assets
  ok('  列表里不再有它', !after1.some((a) => a.id === 'clip:shot01'))

  // 文本资产：没有文件，删除只动索引
  const del2 = await call('DELETE', '/assets?id=' + encodeURIComponent('text:storyboard'), { token })
  eq('删除文本资产 → 200', del2.status, 200)
  eq('  文本资产没有文件可删（fileDeleted=false）', del2.json().fileDeleted, false)

  // 共享文件：两条记录指向同一个文件时，删其中一条不能删文件
  {
    const l2 = loadLibrary(WORKSPACE)
    const shared = assetStoredFile(l2.assets['character:luna'])
    l2.assets['character:luna-copy'] = { ...l2.assets['character:luna'], id: 'character:luna-copy', name: 'luna-copy' }
    saveLibrary(WORKSPACE, l2)
    const sharedAbs = join(WORKSPACE, ...shared.split('/'))
    const del3 = await call('DELETE', '/assets?id=' + encodeURIComponent('character:luna'), { token })
    eq('删除共享文件的其中一条 → 200', del3.status, 200)
    eq('  文件被保留（还有别的记录在用）', del3.json().fileDeleted, false)
    ok('  文件确实还在', existsSync(sharedAbs))
    // 收尾：删掉最后一条引用它的记录，文件才随之下线
    const del4 = await call('DELETE', '/assets?id=' + encodeURIComponent('character:luna-copy'), { token })
    eq('删掉最后一条引用 → fileDeleted=true', del4.json().fileDeleted, true)
    ok('  这下文件才没了', !existsSync(sharedAbs))
  }

  // 文件已被外部删掉时，fileDeleted 必须是 false（不能报「删了」这种假账）
  {
    const l6 = loadLibrary(WORKSPACE)
    l6.assets['character:ghost'] = { id: 'character:ghost', type: 'character', kind: 'image', name: 'ghost', state: 'default', file: '.dsh-assets/images/never-existed.png' }
    saveLibrary(WORKSPACE, l6)
    const delGhost = await call('DELETE', '/assets?id=' + encodeURIComponent('character:ghost'), { token })
    eq('文件本就不存在时 fileDeleted=false（不报假账）', delGhost.json().fileDeleted, false)
    ok('  索引照样被移除', !(await call('GET', '/assets', { token })).json().assets.some((a) => a.id === 'character:ghost'))
  }

  const del5 = await call('DELETE', '/assets?id=' + encodeURIComponent('clip:nope'), { token })
  eq('删除不存在的资产 → 404', del5.status, 404)
  const del6 = await call('DELETE', '/assets', { token })
  eq('删除缺 id → 400', del6.status, 400)

  // ---------------------------------------------------------------------------
  console.log('\n[6] 兼容旧库（v1.4 之前的记录只有 {type, image}）')
  // ---------------------------------------------------------------------------
  {
    // 往现有库里塞一条**旧格式**记录（没有 kind/file，只有 type + image）。
    // 合并写入而不是覆盖整个文件——覆盖会把前面刚入库的资产一起冲掉。
    const cur = loadLibrary(WORKSPACE)
    cur.assets['scene:old-bridge'] = { id: 'scene:old-bridge', type: 'scene', name: 'old-bridge', state: 'default', image: '.dsh-assets/images/scene-old-bridge.png' }
    saveLibrary(WORKSPACE, cur)
    const legacyPng = join(WORKSPACE, '.dsh-assets', 'images', 'scene-old-bridge.png')
    mkdirSync(join(WORKSPACE, '.dsh-assets', 'images'), { recursive: true })
    writeFileSync(legacyPng, PNG_BUF)

    const l3 = loadLibrary(WORKSPACE)
    eq('旧记录的 kind 由 type 推导为 image', assetKind(l3.assets['scene:old-bridge']), 'image')
    eq('旧记录的 image 字段仍被当作文件字段', assetStoredFile(l3.assets['scene:old-bridge']), '.dsh-assets/images/scene-old-bridge.png')
    ok('旧记录仍能解析出图片路径', resolveAssetImagePath(WORKSPACE, l3, 'scene:old-bridge') === legacyPng)
    const listOld = (await call('GET', '/assets', { token })).json().assets
    eq('GET /assets 给旧记录补上了 kind', listOld.find((a) => a.id === 'scene:old-bridge').kind, 'image')
    const toOld = await call('POST', '/assets/to-canvas', { token, body: { id: 'scene:old-bridge' } })
    eq('旧记录仍能被取回画布', toOld.status, 200)
    // 覆盖登记同 id：新记录写 file，不能留下指向旧文件的 image 字段
    const p2 = JSON.parse(readFileSync(join(canvasDir, 'project.json'), 'utf8'))
    p2.nodes.push(node('n-img2', 'image', { media: `${CANVAS_DIR}/${SID}/${imgName}` }))
    writeFileSync(join(canvasDir, 'project.json'), JSON.stringify(p2, null, 2))
    await call('POST', '/assets', { token, body: { nodeId: 'n-img2', type: 'scene', name: 'old-bridge' } })
    const l4 = loadLibrary(WORKSPACE)
    ok('覆盖登记后不残留旧 image 字段', !('image' in l4.assets['scene:old-bridge']))
    ok('  文件字段指向新拷的库文件', String(assetStoredFile(l4.assets['scene:old-bridge'])).startsWith('.dsh-assets/images/scene-old-bridge'))
  }

  // ---------------------------------------------------------------------------
  console.log('\n[7] 纯函数层（type/kind 映射、id 规则、只认图片的 ref 闸门）')
  // ---------------------------------------------------------------------------
  eq('image 允许的角色类型', assetTypesForKind('image').join(','), 'character,scene,style')
  eq('video 只允许 clip', assetTypesForKind('video').join(','), 'clip')
  eq('text 只允许 text', assetTypesForKind('text').join(','), 'text')
  eq('normalizeAssetId(clip)', normalizeAssetId('clip', 'shot01'), 'clip:shot01')
  eq('normalizeAssetId(text, 带 state)', normalizeAssetId('text', 'shotlist', 'v2'), 'text:shotlist/v2')
  ok('isAssetRef 认 clip:/text: 前缀', isAssetRef('clip:x') && isAssetRef('text:y') && !isAssetRef('foo:z'))

  {
    const l5 = {
      assets: {
        'character:img': { id: 'character:img', type: 'character', kind: 'image', file: '.dsh-assets/images/x.png' },
        'clip:v': { id: 'clip:v', type: 'clip', kind: 'video', file: '.dsh-assets/images/x.mp4' },
      },
    }
    mkdirSync(join(WORKSPACE, '.dsh-assets', 'images'), { recursive: true })
    writeFileSync(join(WORKSPACE, '.dsh-assets', 'images', 'x.png'), PNG_BUF)
    writeFileSync(join(WORKSPACE, '.dsh-assets', 'images', 'x.mp4'), MP4_BUF)
    ok('resolveAssetPath 能取到视频', resolveAssetPath(WORKSPACE, l5, 'clip:v') !== null)
    eq('resolveAssetImagePath 对视频返回 null（ref_nodes 安全闸门）', resolveAssetImagePath(WORKSPACE, l5, 'clip:v'), null)
    ok('resolveAssetImagePath 对图片正常返回', resolveAssetImagePath(WORKSPACE, l5, 'character:img') !== null)
  }

  // copyAssetToCanvas 的同 id 复用路径（画布上已有该节点 → 原地更新而不是新增）
  {
    const n1 = await copyAssetToCanvas(WORKSPACE, SID2, 'text:shotlist', { nodeId: 'reuse-1' })
    const n2 = await copyAssetToCanvas(WORKSPACE, SID2, 'text:shotlist', { nodeId: 'reuse-1' })
    eq('同 nodeId 复用不报错', n2.id, 'reuse-1')
    const p3 = JSON.parse(readFileSync(join(WORKSPACE, CANVAS_DIR, SID2, 'project.json'), 'utf8'))
    eq('  也没有多出重复节点', p3.nodes.filter((n) => n.id === 'reuse-1').length, 1)
    eq('  跨会话可用（另一 sessionId）', n1.kind, 'table')
  }
} finally {
  rmSync(WORKSPACE, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed) process.exit(1)
console.log('assets smoke passed')
