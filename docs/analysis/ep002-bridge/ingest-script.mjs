import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join, basename } from 'node:path'
import { loadLibrary, findAssetByLabel, newAssetId, registerAsset } from '../../../lib/assets.js'

const root = resolve('.')
const sid = process.env.DSH_SESSION_ID || 'session-002884e3-29ba-44ca-b79f-b739766b87ed'
const project = JSON.parse(readFileSync(join(root, 'canvas', sid, 'project.json'), 'utf8'))
const approvalNodeId = 'f750738a-a1c7-4f9e-983a-815519f9bc16'
const approval = project.nodes.find((n) => n.id === approvalNodeId)
if (!approval || !String(approval.content || '').includes('asset-ingest-approved')) {
  throw new Error('缺少已批准的入库清单节点')
}
const knownSession = 'session-98991598-ea18-4d46-a903-0ca99dc9be1e'
const items = [
  { type: 'character', name: '绛珠-常服-单视图-v1', state: '常服-白衣仙裙', character: '绛珠', cardVariant: 'single', srcPath: `canvas/${knownSession}/03a631e8-4808-47c5-a94b-d71f51c3e250_00001_.png` },
  { type: 'character', name: '绛珠-常服-三视图-v1', state: '常服-白衣仙裙', character: '绛珠', cardVariant: 'three', srcPath: `canvas/${knownSession}/c83c0a93-1813-4198-b778-215c4a21e040_00001_.png` },
  { type: 'character', name: '神瑛-常服-单视图-v1', state: '常服-白衣仙侍', character: '神瑛', cardVariant: 'single', srcPath: `canvas/${knownSession}/fbc7e9fb-d45d-4878-b44d-db6c00b29c29_00001_.png` },
  { type: 'character', name: '神瑛-常服-三视图-v1', state: '常服-白衣仙侍', character: '神瑛', cardVariant: 'three', srcPath: `canvas/${knownSession}/2448af68-0ce1-40d0-b2be-296dbf1fa6ce_00001_.png` },
  { type: 'scene', name: '灵河岸-晨昏-v1', state: '晨 / 夜星河', srcPath: `canvas/${knownSession}/e5ad4eb1-e87b-4046-8deb-471e80562e7f_00001_.png` },
  { type: 'scene', name: '露瓶-白玉-v1', state: '白玉', srcPath: `canvas/${knownSession}/89294279-1081-4f68-b2d6-c27c4754d3da_00001_.png` },
  { type: 'voice', name: '绛珠-声线-v2', state: 'default', character: '绛珠', source: 'audition', nodeId: '1c642566-26e0-4d5b-a8ba-f3706d79a2b6' },
  { type: 'voice', name: '神瑛-声线-v2', state: 'default', character: '神瑛', source: 'audition', nodeId: 'e22f2c25-7154-4922-bf66-768d46945a45' },
]
const lib = loadLibrary(root)
const out = []
for (const item of items) {
  const prev = findAssetByLabel(lib, item.type, item.name)
  if (prev) { out.push({ name: item.name, error: '同名已存在: ' + prev }); continue }
  let srcAbs; let sourceNode = ''; let sourceSession = knownSession
  if (item.srcPath) {
    srcAbs = resolve(root, item.srcPath)
    if (!existsSync(srcAbs)) throw new Error('文件不存在: ' + item.srcPath)
    sourceNode = basename(item.srcPath)
  } else {
    const n = project.nodes.find((x) => x.id === item.nodeId)
    if (!n) throw new Error('节点不存在: ' + item.nodeId)
    srcAbs = join(root, ...String(n.media).split('/'))
    if (!existsSync(srcAbs)) throw new Error('节点媒体不存在: ' + n.media)
    sourceNode = n.id; sourceSession = sid
  }
  const fileHash = createHash('sha256').update(readFileSync(srcAbs)).digest('hex')
  const id = newAssetId(lib, item.type)
  const meta = {
    sourceSession, sourceNode, ingestedBy: 'agent', approvedAt: Date.now(), approvalNodeId,
    version: 1, fileHash,
    ...(item.character ? { character: item.character } : {}),
    ...(item.cardVariant ? { cardVariant: item.cardVariant } : {}),
    ...(item.source ? { source: item.source } : {}),
  }
  const rec = registerAsset(root, lib, {
    id, type: item.type, name: item.name, state: item.state,
    srcAbsPath: srcAbs, meta,
  })
  out.push({ name: item.name, assetId: rec.id, type: rec.type, state: rec.state, version: rec.version })
}
console.log(JSON.stringify(out, null, 2))
