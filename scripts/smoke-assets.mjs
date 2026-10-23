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
  loadLibrary, saveLibrary, registerAsset, removeAsset, renameAsset, assetKind, assetStoredFile,
  resolveAssetPath, resolveAssetImagePath, assetTypesForKind, normalizeAssetId, slugifyName,
  isAssetRef, assetFile, newAssetId, normalizeDisplayName, assetDisplayName, assetDisplayState,
  findAssetByLabel,
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
      node('n-zh-img', 'image', { title: '小狐狸·穿宇航服', media: `${CANVAS_DIR}/${SID}/${imgName}` }),
      node('n-notitle', 'image', { title: '', media: `${CANVAS_DIR}/${SID}/${imgName}` }),
    ],
  }
  writeFileSync(join(canvasDir, 'project.json'), JSON.stringify(project, null, 2))

  // ---------------------------------------------------------------------------
  console.log('\n[1] 入库：三种载体 + 不透明 id')
  // ---------------------------------------------------------------------------
  const rImg = await call('POST', '/assets', { token, body: { nodeId: 'n-img', type: 'character', name: 'luna' } })
  eq('图片节点入库 → 200', rImg.status, 200)
  eq('  ……kind=image', rImg.json().kind, 'image')
  const idImg = rImg.json().id
  ok('  ……id 是入库时生成的随机 id（不含显示名）', /^character:[0-9a-f]{16}$/.test(idImg), idImg)
  eq('  ……显示名单独保存（与 id 解耦）', loadLibrary(WORKSPACE).assets[idImg].name, 'luna')

  const rZh = await call('POST', '/assets', { token, body: { nodeId: 'n-img', type: 'character', name: '小狐狸' } })
  eq('中文显示名入库 → 200', rZh.status, 200)
  const idZh = rZh.json().id
  ok('  ……id 仍是随机 id，不因中文名变形', /^character:[0-9a-f]{16}$/.test(idZh) && idZh !== idImg, idZh)
  eq('  ……显示名保留中文', loadLibrary(WORKSPACE).assets[idZh].name, '小狐狸')
  {
    const zhLib = loadLibrary(WORKSPACE)
    ok('  ……库文件名按 id 生成（与显示名无关）', assetStoredFile(zhLib.assets[idZh]).includes(idZh.split(':')[1]))
    const zhMedia = await call('GET', '/media?asset=' + encodeURIComponent(idZh) + '&token=' + encodeURIComponent(token))
    eq('  ……随机 id 的 /media → 200', zhMedia.status, 200)
  }

  const rZhDefault = await call('POST', '/assets', { token, body: { nodeId: 'n-zh-img', type: 'character' } })
  eq('中文标题 + 不填显示名：自动 slug 兜底 → 200', rZhDefault.status, 200)
  const idZhDefault = rZhDefault.json().id
  eq('  ……兜底显示名来自标题', loadLibrary(WORKSPACE).assets[idZhDefault].name, '小狐狸-穿宇航服')

  const rVid = await call('POST', '/assets', { token, body: { nodeId: 'n-vid', type: 'clip', name: 'shot01' } })
  eq('视频节点入库 → 200', rVid.status, 200)
  eq('  ……kind=video', rVid.json().kind, 'video')
  const idVid = rVid.json().id
  ok('  ……id 是 clip: 前缀的随机 id', /^clip:[0-9a-f]{16}$/.test(idVid), idVid)

  const rTxt = await call('POST', '/assets', { token, body: { nodeId: 'n-text', type: 'text', name: 'storyboard' } })
  eq('文本节点入库 → 200', rTxt.status, 200)
  eq('  ……kind=text', rTxt.json().kind, 'text')
  const idTxt = rTxt.json().id

  const rTbl = await call('POST', '/assets', { token, body: { nodeId: 'n-table', type: 'text', name: 'shotlist' } })
  eq('表格节点入库 → 200（也算文本载体）', rTbl.status, 200)
  const idTbl = rTbl.json().id

  // 显示名是自由文本：空格 / 中文标点 / 大小写都保留
  const rFree = await call('POST', '/assets', { token, body: { nodeId: 'n-img', type: 'scene', name: '月球 基地·夜景' } })
  eq('显示名允许空格与中文标点', loadLibrary(WORKSPACE).assets[rFree.json().id].name, '月球 基地·夜景')

  const lib = loadLibrary(WORKSPACE)
  eq('视频资产的 kind', assetKind(lib.assets[idVid]), 'video')
  eq('视频资产的文件扩展名沿用源文件', assetStoredFile(lib.assets[idVid]).endsWith('.mp4'), true)
  ok('视频资产记录里没有残留的 image 字段', !('image' in lib.assets[idVid]))
  eq('文本资产存正文（不是文件）', typeof lib.assets[idTxt].text, 'string')
  ok('文本资产正文与节点内容一致', lib.assets[idTxt].text.includes('狐狸抬头看星星'))
  eq('文本资产没有文件字段', assetStoredFile(lib.assets[idTxt]), null)
  eq('表格节点的 nodeKind 保住了（取回画布仍是表格）', lib.assets[idTbl].nodeKind, 'table')
  eq('图片资产的 seed 元数据仍被带上', lib.assets[idImg].seed, 7)

  // 同类型 + 同显示名 + 同状态再次入库 = 更新同一资产（沿用随机 id、保留 createdAt）
  const beforeUpdate = loadLibrary(WORKSPACE).assets[idImg].createdAt
  const rImg2 = await call('POST', '/assets', { token, body: { nodeId: 'n-img', type: 'character', name: 'luna' } })
  eq('同名再次入库 → 200', rImg2.status, 200)
  eq('  ……沿用同一个随机 id', rImg2.json().id, idImg)
  eq('  ……createdAt 保留', loadLibrary(WORKSPACE).assets[idImg].createdAt, beforeUpdate)

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

  const bad6 = await call('POST', '/assets', { token, body: { nodeId: 'n-notitle', type: 'character', name: '   ' } })
  eq('显示名为空且无标题兜底 → 400', bad6.status, 400)
  ok('  错误信息说明要填显示名', bad6.json().message.includes('显示名'), bad6.json().message)

  // ---------------------------------------------------------------------------
  console.log('\n[3] 媒体伺服：视频资产必须能放出来')
  // ---------------------------------------------------------------------------
  const vm = await call('GET', '/media?asset=' + encodeURIComponent(idVid) + '&token=' + encodeURIComponent(token))
  eq('视频资产 /media → 200', vm.status, 200)
  eq('  ……content-type 是 video/mp4', vm.headers['content-type'], 'video/mp4')
  ok('  ……字节与入库源文件一致', vm.body.equals(MP4_BUF))

  const im = await call('GET', '/media?asset=' + encodeURIComponent(idImg) + '&token=' + encodeURIComponent(token))
  eq('图片资产 /media → 200', im.status, 200)
  eq('  ……content-type 是 image/png', im.headers['content-type'], 'image/png')

  const noTok = await call('GET', '/media?asset=' + encodeURIComponent(idVid))
  eq('media 缺 token → 403', noTok.status, 403)

  // ---------------------------------------------------------------------------
  console.log('\n[4] 取回画布：三种载体产物化')
  // ---------------------------------------------------------------------------
  const toVid = await call('POST', '/assets/to-canvas', { token, body: { id: idVid } })
  eq('视频资产 → 画布 → 200', toVid.status, 200)
  let proj = JSON.parse(readFileSync(join(canvasDir, 'project.json'), 'utf8'))
  const vNode = proj.nodes.find((n) => n.id === toVid.json().nodeId)
  eq('  产物节点 kind=video', vNode.kind, 'video')
  eq('  产物绑定资产 id', vNode.params.assetId, idVid)
  ok('  产物媒体文件已落到本会话画布目录', existsSync(join(WORKSPACE, ...vNode.media.split('/'))))

  const toTxt = await call('POST', '/assets/to-canvas', { token, body: { id: idTxt } })
  proj = JSON.parse(readFileSync(join(canvasDir, 'project.json'), 'utf8'))
  const tNode = proj.nodes.find((n) => n.id === toTxt.json().nodeId)
  eq('文本资产 → 产物节点 kind=text', tNode.kind, 'text')
  ok('  正文被带回来', tNode.content.includes('狐狸抬头看星星'))
  ok('  文本产物不产生媒体文件', !tNode.media)

  const toTbl = await call('POST', '/assets/to-canvas', { token, body: { id: idTbl } })
  proj = JSON.parse(readFileSync(join(canvasDir, 'project.json'), 'utf8'))
  eq('表格类文本资产 → 产物节点仍是 table', proj.nodes.find((n) => n.id === toTbl.json().nodeId).kind, 'table')

  // ---------------------------------------------------------------------------
  console.log('\n[5] 删除：索引 + 文件，且不误删共享文件')
  // ---------------------------------------------------------------------------
  const list0 = (await call('GET', '/assets', { token })).json().assets
  ok('GET /assets 返回 kind 字段（前端不必自己推导）', list0.every((a) => a.kind), JSON.stringify(list0.map((a) => [a.id, a.kind])))
  eq('  其中视频/文本都在', [list0.some((a) => a.kind === 'video'), list0.some((a) => a.kind === 'text')].join(','), 'true,true')

  const vidAbs = resolveAssetPath(WORKSPACE, lib, idVid)
  ok('视频资产文件在磁盘上', existsSync(vidAbs))

  const del1 = await call('DELETE', '/assets?id=' + encodeURIComponent(idVid), { token })
  eq('删除视频资产 → 200', del1.status, 200)
  eq('  服务端报告文件已清理', del1.json().fileDeleted, true)
  ok('  文件真的没了', !existsSync(vidAbs))
  const after1 = (await call('GET', '/assets', { token })).json().assets
  ok('  列表里不再有它', !after1.some((a) => a.id === idVid))

  // 文本资产：没有文件，删除只动索引
  const del2 = await call('DELETE', '/assets?id=' + encodeURIComponent(idTxt), { token })
  eq('删除文本资产 → 200', del2.status, 200)
  eq('  文本资产没有文件可删（fileDeleted=false）', del2.json().fileDeleted, false)

  // 共享文件：两条记录指向同一个文件时，删其中一条不能删文件
  {
    const l2 = loadLibrary(WORKSPACE)
    const sharedRel = '.dsh-assets/images/shared-file.png'
    mkdirSync(join(WORKSPACE, '.dsh-assets', 'images'), { recursive: true })
    writeFileSync(join(WORKSPACE, ...sharedRel.split('/')), PNG_BUF)
    const shA = newAssetId(l2, 'character')
    l2.assets[shA] = { id: shA, type: 'character', kind: 'image', name: 'shared-a', state: 'default', file: sharedRel }
    const shB = newAssetId(l2, 'character')
    l2.assets[shB] = { ...l2.assets[shA], id: shB, name: 'shared-b' }
    saveLibrary(WORKSPACE, l2)
    const sharedAbs = join(WORKSPACE, ...sharedRel.split('/'))
    const del3 = await call('DELETE', '/assets?id=' + encodeURIComponent(shA), { token })
    eq('删除共享文件的其中一条 → 200', del3.status, 200)
    eq('  文件被保留（还有别的记录在用）', del3.json().fileDeleted, false)
    ok('  文件确实还在', existsSync(sharedAbs))
    // 收尾：删掉最后一条引用它的记录，文件才随之下线
    const del4 = await call('DELETE', '/assets?id=' + encodeURIComponent(shB), { token })
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
    // 更老的记录连 name/state 都没有 → 显示名/状态从 id 解析
    cur.assets['scene:old-anon'] = { id: 'scene:old-anon', type: 'scene', image: '.dsh-assets/images/scene-old-anon.png' }
    saveLibrary(WORKSPACE, cur)
    const legacyPng = join(WORKSPACE, '.dsh-assets', 'images', 'scene-old-bridge.png')
    mkdirSync(join(WORKSPACE, '.dsh-assets', 'images'), { recursive: true })
    writeFileSync(legacyPng, PNG_BUF)
    writeFileSync(join(WORKSPACE, '.dsh-assets', 'images', 'scene-old-anon.png'), PNG_BUF)

    const l3 = loadLibrary(WORKSPACE)
    eq('旧记录的 kind 由 type 推导为 image', assetKind(l3.assets['scene:old-bridge']), 'image')
    eq('旧记录的 image 字段仍被当作文件字段', assetStoredFile(l3.assets['scene:old-bridge']), '.dsh-assets/images/scene-old-bridge.png')
    ok('旧记录仍能解析出图片路径', resolveAssetImagePath(WORKSPACE, l3, 'scene:old-bridge') === legacyPng)
    eq('没有 name 字段的旧记录：显示名从 id 兜底', assetDisplayName(l3.assets['scene:old-anon']), 'old-anon')
    eq('没有 state 字段的旧记录：状态兜底为 default', assetDisplayState(l3.assets['scene:old-anon']), 'default')
    const listOld = (await call('GET', '/assets', { token })).json().assets
    eq('GET /assets 给旧记录补上了 kind', listOld.find((a) => a.id === 'scene:old-bridge').kind, 'image')
    {
      const anon = listOld.find((a) => a.id === 'scene:old-anon')
      eq('GET /assets 给旧记录补上 displayName/displayState', [anon.displayName, anon.displayState].join(','), 'old-anon,default')
    }
    const toOld = await call('POST', '/assets/to-canvas', { token, body: { id: 'scene:old-bridge' } })
    eq('旧记录仍能被取回画布', toOld.status, 200)
    // 覆盖登记：按「类型 + 显示名 + 状态」匹配到旧记录 → 沿用旧 id，不新建随机 id
    const p2 = JSON.parse(readFileSync(join(canvasDir, 'project.json'), 'utf8'))
    p2.nodes.push(node('n-img2', 'image', { media: `${CANVAS_DIR}/${SID}/${imgName}` }))
    writeFileSync(join(canvasDir, 'project.json'), JSON.stringify(p2, null, 2))
    const regOld = await call('POST', '/assets', { token, body: { nodeId: 'n-img2', type: 'scene', name: 'old-bridge' } })
    eq('按显示名匹配到旧记录：沿用旧 id', regOld.json().id, 'scene:old-bridge')
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
  eq('slugifyName 保留中文', slugifyName('小狐狸·穿宇航服'), '小狐狸-穿宇航服')
  eq('normalizeAssetId 支持中文', normalizeAssetId('character', '小狐狸', '穿宇航服'), 'character:小狐狸/穿宇航服')
  eq('normalizeAssetId 中文标题分隔符归一', normalizeAssetId('character', '小狐狸·穿宇航服'), 'character:小狐狸-穿宇航服')
  ok('isAssetRef 认 clip:/text: 前缀', isAssetRef('clip:x') && isAssetRef('text:y') && !isAssetRef('foo:z'))
  ok('newAssetId 生成 <type>:<16 位 hex>', /^character:[0-9a-f]{16}$/.test(newAssetId({ assets: {} }, 'character')))
  eq('normalizeDisplayName 保留大小写与中文标点、折叠空白', normalizeDisplayName('  Mia   月球·夜景 '), 'Mia 月球·夜景')
  eq('normalizeDisplayName 把控制字符折成空格', normalizeDisplayName('a\nb\tc'), 'a b c')
  eq('normalizeDisplayName 截到 80 字', [...normalizeDisplayName('字'.repeat(100))].length, 80)
  {
    const libLabels = {
      assets: {
        'character:aaa': { id: 'character:aaa', type: 'character', name: 'Mia', state: 'default' },
        'character:bbb': { id: 'character:bbb', type: 'character', name: 'mia', state: 'space' },
        'scene:ccc': { id: 'scene:ccc', type: 'scene', name: 'Mia', state: 'default' },
      },
    }
    eq('findAssetByLabel 忽略大小写', findAssetByLabel(libLabels, 'character', 'MIA'), 'character:aaa')
    eq('findAssetByLabel 忽略 state（同名不同状态仍算同一个）', findAssetByLabel(libLabels, 'character', 'Mia'), 'character:aaa')
    eq('findAssetByLabel 按类型隔离（不同类型可以同名）', findAssetByLabel(libLabels, 'scene', 'Mia'), 'scene:ccc')
    eq('findAssetByLabel 找不到返回 null', findAssetByLabel(libLabels, 'character', 'nobody'), null)
  }

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
    const n1 = await copyAssetToCanvas(WORKSPACE, SID2, idTbl, { nodeId: 'reuse-1' })
    const n2 = await copyAssetToCanvas(WORKSPACE, SID2, idTbl, { nodeId: 'reuse-1' })
    eq('同 nodeId 复用不报错', n2.id, 'reuse-1')
    const p3 = JSON.parse(readFileSync(join(WORKSPACE, CANVAS_DIR, SID2, 'project.json'), 'utf8'))
    eq('  也没有多出重复节点', p3.nodes.filter((n) => n.id === 'reuse-1').length, 1)
    eq('  跨会话可用（另一 sessionId）', n1.kind, 'table')
  }

  // ---------------------------------------------------------------------------
  console.log('\n[8] 重命名：只改显示名 / 状态，id 与所有引用不变')
  // ---------------------------------------------------------------------------
  {
    // 画布上先取一张卡（绑定 idImg），改名后它的绑定必须原样保留
    const toChar = await call('POST', '/assets/to-canvas', { token, body: { id: idImg } })
    eq('角色资产取到画布', toChar.status, 200)
    // 补一条 character 配对元数据（模拟入库时带上的）
    const l7 = loadLibrary(WORKSPACE)
    l7.assets[idImg].character = 'luna'
    saveLibrary(WORKSPACE, l7)
    const fileBefore = assetStoredFile(loadLibrary(WORKSPACE).assets[idImg])
    const absBefore = resolveAssetPath(WORKSPACE, loadLibrary(WORKSPACE), idImg)
    ok('  改名之前的库文件存在', Boolean(absBefore))

    const rn = await call('POST', '/assets/rename', { token, body: { id: idImg, name: 'fox', state: 'space' } })
    eq('重命名 → 200', rn.status, 200)
    eq('  ……返回的仍是原 id', rn.json().id, idImg)
    const l8 = loadLibrary(WORKSPACE)
    eq('  ……显示名已改', l8.assets[idImg].name, 'fox')
    eq('  ……状态已改', l8.assets[idImg].state, 'space')
    eq('  ……库文件路径不变', assetStoredFile(l8.assets[idImg]), fileBefore)
    ok('  ……库文件仍在原路径', existsSync(absBefore))
    eq('  ……character 配对元数据不动（配对靠它，不靠显示名）', l8.assets[idImg].character, 'luna')
    const p4 = JSON.parse(readFileSync(join(canvasDir, 'project.json'), 'utf8'))
    const charNode = p4.nodes.find((n) => n.id === toChar.json().nodeId)
    eq('  ……画布绑定仍是原 id（零迁移）', charNode.params.assetId, idImg)
    eq('  ……params.model 仍是原 id', charNode.params.model, 'asset:' + idImg)
    const mediaAfter = await call('GET', '/media?asset=' + encodeURIComponent(idImg) + '&token=' + encodeURIComponent(token))
    eq('  ……原 id 的 /media 仍可用', mediaAfter.status, 200)

    // 同名入库（不传 state）→ 同一 id，且不要被默认值冲掉原状态
    const reRegKeep = await call('POST', '/assets', { token, body: { nodeId: 'n-img', type: 'character', name: 'fox' } })
    eq('同名入库（不传 state）→ 同一 id', reRegKeep.json().id, idImg)
    eq('  ……保留原状态 space', loadLibrary(WORKSPACE).assets[idImg].state, 'space')

    // state 传空串 = 清回 default；不传 state = 保持；只改 state 不触发查重
    const rnKeep = await call('POST', '/assets/rename', { token, body: { id: idImg, name: 'fox' } })
    eq('不传 state → 保持原状态', rnKeep.json().state, 'space')
    const rnState = await call('POST', '/assets/rename', { token, body: { id: idImg, name: 'fox', state: 'single' } })
    eq('只改 state → 200（唯一性不含 state）', rnState.status, 200)
    eq('  ……state=single', loadLibrary(WORKSPACE).assets[idImg].state, 'single')
    const rn2 = await call('POST', '/assets/rename', { token, body: { id: idImg, name: 'fox', state: '' } })
    eq('state 传空串 → 回到 default', loadLibrary(WORKSPACE).assets[idImg].state, 'default')

    // 名字没变 → renamed=false
    const same = await call('POST', '/assets/rename', { token, body: { id: idImg, name: 'fox' } })
    eq('无改动 → 200 且 renamed=false', [same.status, same.json().renamed].join(','), '200,false')

    // 撞名 / 空名 / 不存在 / 缺 id
    const conflict = await call('POST', '/assets/rename', { token, body: { id: idImg, name: '小狐狸' } })
    eq('撞上同类型同名 → 409', conflict.status, 409)
    ok('  ……错误信息点明撞名', conflict.json().message.includes('小狐狸'), conflict.json().message)
    // 唯一性只看「类型 + 显示名」：状态不同也算撞名
    const l9 = loadLibrary(WORKSPACE)
    l9.assets[idZh].state = '三视图'
    saveLibrary(WORKSPACE, l9)
    const conflict2 = await call('POST', '/assets/rename', { token, body: { id: idImg, name: '小狐狸', state: '单视图' } })
    eq('同名但状态不同 → 仍算撞名（409）', conflict2.status, 409)
    // 老库里可能本来就有同类型同显示名的记录（旧 id 带 state 时代）——只改 state 不该被查重挡住
    {
      const l10 = loadLibrary(WORKSPACE)
      l10.assets['character:dup-a'] = { id: 'character:dup-a', type: 'character', kind: 'text', name: 'Dup', state: 'default', text: 't' }
      l10.assets['character:dup-b'] = { id: 'character:dup-b', type: 'character', kind: 'text', name: 'Dup', state: 'space', text: 't' }
      saveLibrary(WORKSPACE, l10)
      const rnDup = await call('POST', '/assets/rename', { token, body: { id: 'character:dup-b', state: 'single' } })
      eq('老库同名重复时只改 state → 200', rnDup.status, 200)
      eq('  ……state 已改', loadLibrary(WORKSPACE).assets['character:dup-b'].state, 'single')
    }
    const badName = await call('POST', '/assets/rename', { token, body: { id: idImg, name: '   ' } })
    eq('空显示名 → 400', badName.status, 400)
    const missing = await call('POST', '/assets/rename', { token, body: { id: 'character:nope', name: 'x' } })
    eq('资产不存在 → 404', missing.status, 404)
    const noId = await call('POST', '/assets/rename', { token, body: { name: 'x' } })
    eq('缺 id → 400', noId.status, 400)

    // 改名后再按显示名入库：仍命中同一资产（id 不变）
    const reReg = await call('POST', '/assets', { token, body: { nodeId: 'n-img', type: 'character', name: 'fox' } })
    eq('改名后再入库同名 → 仍是同一个 id', reReg.json().id, idImg)

    // 文本资产：改显示名不动正文、也不动另一会话的绑定
    const rnTbl = await call('POST', '/assets/rename', { token, body: { id: idTbl, name: '镜头表' } })
    eq('文本资产重命名 → 200', rnTbl.status, 200)
    eq('  ……显示名已改', loadLibrary(WORKSPACE).assets[idTbl].name, '镜头表')
    ok('  ……正文原样保留', loadLibrary(WORKSPACE).assets[idTbl].text.includes('S01'))
    const p5 = JSON.parse(readFileSync(join(WORKSPACE, CANVAS_DIR, SID2, 'project.json'), 'utf8'))
    eq('  ……另一会话（SID2）的绑定仍是原 id', p5.nodes.find((n) => n.id === 'reuse-1').params.assetId, idTbl)

    // 老式可读 id 也能改名：id 照样不变
    const legacyRn = await call('POST', '/assets/rename', { token, body: { id: 'scene:old-bridge', name: '旧桥' } })
    eq('老 id 改名 → 200', legacyRn.status, 200)
    eq('  ……老 id 不变', legacyRn.json().id, 'scene:old-bridge')
    eq('  ……显示名已改', loadLibrary(WORKSPACE).assets['scene:old-bridge'].name, '旧桥')
    ok('  ……文件仍在', resolveAssetPath(WORKSPACE, loadLibrary(WORKSPACE), 'scene:old-bridge') !== null)

    // 纯函数层
    {
      const l11 = loadLibrary(WORKSPACE)
      const r = renameAsset(WORKSPACE, l11, idImg, { name: 'direct' })
      eq('renameAsset 纯函数返回同一 id', r.id, idImg)
      eq('  ……显示名已落库', loadLibrary(WORKSPACE).assets[idImg].name, 'direct')
      // 老记录把整个 id 塞进 name（带冒号）时也能改，id 不变
      const l12 = loadLibrary(WORKSPACE)
      l12.assets['character:legacy'] = { id: 'character:legacy', type: 'character', kind: 'text', name: 'character:legacy', state: 'default', text: 't' }
      const rl = renameAsset(WORKSPACE, l12, 'character:legacy', { name: 'legacy2' })
      eq('老记录 name 带冒号也能改名（id 不变）', [rl.id, loadLibrary(WORKSPACE).assets['character:legacy'].name].join(','), 'character:legacy,legacy2')
    }
  }
} finally {
  rmSync(WORKSPACE, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed) process.exit(1)
console.log('assets smoke passed')
