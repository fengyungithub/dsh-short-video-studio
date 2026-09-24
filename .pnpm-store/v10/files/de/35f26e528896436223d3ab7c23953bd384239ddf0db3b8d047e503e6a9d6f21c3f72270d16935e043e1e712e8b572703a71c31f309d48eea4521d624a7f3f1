#!/usr/bin/env node
/**
 * 冒烟：画布「自己添加资产」链路（纯逻辑，不碰 ComfyUI / HTTP）。
 * 覆盖：
 *   parseDataUrlImage   — dataURL 解析 / 非法输入拒绝
 *   importManualImage   — 上传图片 → 画布 image 节点 + 媒体落盘（不写资产库）
 *   copyAssetToCanvas   — 资产库 → 画布节点（含 char: 别名），跨会话（另一 sessionId）可用
 * 用法：node scripts/smoke-upload-assets.mjs
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _internals } from '../lib/index.js'
import { loadLibrary, registerAsset, assetFile } from '../lib/assets.js'

const { parseDataUrlImage, importManualImage, copyAssetToCanvas, replaceNodeImage } = _internals

// 1x1 PNG（跨工具可识别的最小合法 PNG）
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_BUF = Buffer.from(PNG_B64, 'base64')
const JPG_BUF = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

let passed = 0
function ok(cond, name) {
  assert.ok(cond, name)
  passed++
  console.log('  ok -', name)
}

console.log('# parseDataUrlImage')
{
  const png = parseDataUrlImage('data:image/png;base64,' + PNG_B64)
  ok(png.buffer.equals(PNG_BUF) && png.ext === '.png', 'png dataURL 解码得到原始字节 + .png')
  const jpg = parseDataUrlImage('data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8]).toString('base64'))
  ok(jpg.ext === '.jpg', 'jpeg → .jpg')
  const webp = parseDataUrlImage('data:image/webp;base64,AAAA')
  ok(webp.ext === '.webp', 'webp → .webp')
  for (const bad of ['', 'data:text/plain;base64,aGk=', 'data:image/svg+xml;base64,PHN2Zz4=', 'abc', 'data:image/png;base64,!@#$%']) {
    let threw = false
    try { parseDataUrlImage(bad) } catch { threw = true }
    ok(threw, '拒绝非法输入 ' + JSON.stringify(String(bad).slice(0, 32)))
  }
}

const dir = mkdtempSync(join(tmpdir(), 'svs-upload-'))
const S_A = 'session-upload-a'
const S_B = 'session-upload-b'
try {
  console.log('# importManualImage（上传 → 画布资产卡，不入库）')
  let node
  {
    node = await importManualImage(dir, S_A, { filename: '主角卡.png', dataUrl: 'data:image/png;base64,' + PNG_B64 }, 'character cards')
    ok(node.kind === 'image', '节点 kind=image')
    ok(node.title === '主角卡', '标题取文件名（去扩展名）')
    ok(node.group === 'character cards', '分组透传')
    ok(node.params && node.params.source === 'manual-upload', 'params.source=manual-upload')
    ok(node.params && !node.params.assetId, '上传不自动入库（assetId 缺省）')
    const abs = join(dir, ...node.media.split('/'))
    ok(existsSync(abs) && readFileSync(abs).equals(PNG_BUF), '媒体文件已落盘且字节一致')
    const project = JSON.parse(readFileSync(join(dir, 'canvas', S_A, 'project.json'), 'utf8'))
    ok(project.nodes.some((n) => n.id === node.id), '节点已写入 project.json')
    const uploaded = project.nodes.find((n) => n.id === node.id)
    ok(uploaded && uploaded.media.startsWith('canvas/' + S_A + '/upload-'), '媒体路径位于画布目录 upload- 前缀')
  }
  {
    const noName = await importManualImage(dir, S_A, { dataUrl: 'data:image/png;base64,' + PNG_B64 }, '')
    ok(noName.title === '图片', '无文件名时回退标题')
    ok(noName.group === 'ungrouped', '空分组回退 ungrouped')
  }
  {
    let threw = false
    try { await importManualImage(dir, S_A, { filename: 'x.png', dataUrl: 'data:text/plain;base64,aGk=' }, '') } catch { threw = true }
    ok(threw, '非图片 dataURL 拒绝且不落节点')
  }

  console.log('# copyAssetToCanvas（资产库 → 画布，跨会话）')
  let nodeB
  {
    // 从 S_A 上传的节点图登记为资产（模拟用户点「入库」）
    const lib = loadLibrary(dir)
    const abs = join(dir, ...node.media.split('/'))
    const rec = registerAsset(dir, lib, { id: 'character:hero', type: 'character', name: 'hero', srcAbsPath: abs, meta: { sourceNode: node.id } })
    ok(rec.id === 'character:hero', '登记资产 character:hero')
    assert.ok(existsSync(assetFile(dir)), 'library.json 已写入')

    // 另一会话 S_B 从资产库物化
    nodeB = await copyAssetToCanvas(dir, S_B, 'character:hero', { title: '主角' })
    ok(nodeB.kind === 'image' && nodeB.title === '主角', '物化节点为 image 且标题覆盖')
    ok(nodeB.params && nodeB.params.assetId === 'character:hero', 'params.assetId 绑定资产 id')
    ok(nodeB.media.startsWith('canvas/' + S_B + '/asset-character-hero'), '库图拷贝进 S_B 画布目录')
    const absB = join(dir, ...nodeB.media.split('/'))
    ok(existsSync(absB) && readFileSync(absB).equals(PNG_BUF), '拷贝内容与资产图一致')
    const projectB = JSON.parse(readFileSync(join(dir, 'canvas', S_B, 'project.json'), 'utf8'))
    ok(projectB.nodes.some((n) => n.id === nodeB.id), 'S_B project.json 含物化节点')

    // char: 别名（工具契约支持）
    const alias = await copyAssetToCanvas(dir, S_B, 'char:hero', {})
    ok(alias.params && alias.params.assetId === 'character:hero', 'char:hero 别名解析为 character:hero')
    ok(alias.id !== nodeB.id, '重复取用生成新节点')

    // 不存在的资产拒绝
    let threw = false
    try { await copyAssetToCanvas(dir, S_B, 'character:nobody', {}) } catch { threw = true }
    ok(threw, '不存在资产报错')

    // 从资产库取用的卡支持「编辑 → 本地上传替换」：解绑 assetId、换媒体
    let replaced
    {
      const before = JSON.parse(readFileSync(join(dir, 'canvas', S_B, 'project.json'), 'utf8')).nodes.find((x) => x.id === nodeB.id)
      ok(before.params.deliveredAt === undefined, '替换前无送达标记（干净起点）')
      replaced = await replaceNodeImage(dir, S_B, nodeB.id, { filename: '自定义.png', dataUrl: 'data:image/png;base64,' + PNG_B64 })
      ok(replaced.assetIdCleared && replaced.prevAssetId === 'character:hero', '替换已入库的卡 → 解绑并回传 prevAssetId')
      const after = JSON.parse(readFileSync(join(dir, 'canvas', S_B, 'project.json'), 'utf8')).nodes.find((x) => x.id === nodeB.id)
      ok(after.id === nodeB.id && after.title === '主角', '节点 id/标题保留')
      ok(after.params.assetId === undefined, 'params.assetId 已清除')
      ok(after.params.source === 'manual-upload' && after.params.replacedAt > 0, 'params.source=manual-upload + replacedAt')
      ok(after.params.model === undefined && after.params.prompt === undefined, '生成类元数据已清（不再暗示按旧参数生成）')
      const absAfter = join(dir, ...after.media.split('/'))
      ok(existsSync(absAfter) && readFileSync(absAfter).equals(PNG_BUF), '新媒体已落盘且字节为新图')
      ok(!after.media.startsWith('canvas/' + S_B + '/asset-character-hero'), 'media 不再指向库拷贝文件')
    }
    {
      const r2 = await replaceNodeImage(dir, S_B, nodeB.id, { dataUrl: 'data:image/jpeg;base64,' + JPG_BUF.toString('base64') })
      const p2 = JSON.parse(readFileSync(join(dir, 'canvas', S_B, 'project.json'), 'utf8')).nodes.find((x) => x.id === nodeB.id)
      ok(r2.assetIdCleared === false && p2.media.endsWith('.jpg'), '未入库卡二次替换不回 assetId 逻辑，jpg 扩展名正确')
      ok(readFileSync(join(dir, ...p2.media.split('/'))).equals(JPG_BUF), '二次替换字节为 jpg')
      ok(p2.params.deliveredAt === undefined && p2.params.deliveryError === undefined, '替换后送达标记被清（下次 ask 重新送达）')
    }
    {
      // 模拟送达标记后替换 → 应被清除（飞书重发新图）
      const projectB = JSON.parse(readFileSync(join(dir, 'canvas', S_B, 'project.json'), 'utf8'))
      const nn = projectB.nodes.find((x) => x.id === nodeB.id)
      nn.params.deliveredAt = 1234567890
      writeFileSync(join(dir, 'canvas', S_B, 'project.json'), JSON.stringify(projectB, null, 2), 'utf8')
      await replaceNodeImage(dir, S_B, nodeB.id, { dataUrl: 'data:image/png;base64,' + PNG_B64 })
      const p3 = JSON.parse(readFileSync(join(dir, 'canvas', S_B, 'project.json'), 'utf8')).nodes.find((x) => x.id === nodeB.id)
      ok(p3.params.deliveredAt === undefined, '替换清除旧 deliveredAt（新图会重新送达）')
    }
    {
      let threw = false
      try { await replaceNodeImage(dir, S_A, 'no-such-node', { dataUrl: 'data:image/png;base64,' + PNG_B64 }) } catch { threw = true }
      ok(threw, '替换不存在的节点报错')
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log('\npassed ' + passed + ' checks')
console.log('upload/assets smoke passed')
