/**
 * scripts/e2e-crop.mjs — 图片裁切（image_crop / capability=image.crop）端到端验证。**真跑 ComfyUI**。
 *
 * 走插件这一层的完整链路（不是裸 ComfyUI 图）：
 *   画布图片节点 → 读真实像素尺寸 → 算裁切矩形 → 上传 → 按注册表取清单编译图 → 提交/等待/取回
 *   → 落画布节点（记裁切矩形 / 溯源 / 角色卡双版本配对）
 *
 * 验证点：
 *  ① 三视图定妆图（1×3）→ 裁第 0 格（正面）→ 产物**实际**是 宽/3 × 高（以文件为准）
 *  ② 角色卡配对：card_variant=single + paired_node_id ⇒ 两个节点互记 pairedNodeId
 *  ③ 参数校验：缺 image_node / 节点不存在 / 非图片节点 ⇒ 显式报错
 *  ④ 复用同一 nodeId 重裁（不会在画布上堆节点）
 *
 * 用法：
 *   node scripts/e2e-crop.mjs                                  # 用内置三视图资产
 *   node scripts/e2e-crop.mjs --src=<png> --panel=0 --tag=myrun
 * 产物落 e2e-out/crop/（画布写在临时工作区，不动用户会话）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'
import { _internals } from '../lib/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'e2e-out', 'crop')
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + k + '='))
  return hit ? hit.slice(k.length + 3) : d
}

const SRC = arg('src', '.dsh-assets/images/character-7ac72cfe2cbdc53e.png') // 绛珠 三视图 v1（2048×1152）
const TAG = arg('tag', 'e2e')
const PANEL = Number(arg('panel', '0'))

const srcAbs = join(ROOT, SRC)
if (!existsSync(srcAbs)) {
  console.error(`✗ 源图不存在：${srcAbs}`)
  process.exit(1)
}

const workspace = join(OUT, 'workspace-' + TAG)
const sessionId = 'crop-smoke'
const projectPath = join(workspace, 'canvas', sessionId, 'project.json')
mkdirSync(dirname(projectPath), { recursive: true })

const mediaName = 'src-' + basename(srcAbs)
const mediaRel = 'canvas-files/' + sessionId + '/' + mediaName
const mediaAbs = join(workspace, mediaRel)
mkdirSync(dirname(mediaAbs), { recursive: true })
copyFileSync(srcAbs, mediaAbs)

const threeNode = {
  id: 'three-1',
  kind: 'image',
  title: '绛珠 角色卡·三视图',
  media: mediaRel,
  group: 'character cards',
  // 故意**不记** width/height —— 逼 runCrop 走 probeImageSize 读真实像素这条路径
  params: { cardVariant: 'three', character: '绛珠' },
  status: 'ready',
  createdAt: Date.now(),
  order: 1,
}
writeFileSync(projectPath, JSON.stringify({
  schemaVersion: 1, sessionId,
  settings: { aspectRatio: '16:9', duration: '', audioMode: 'silent', mode: 'quality' },
  nodes: [threeNode],
}, null, 2), 'utf8')

const ctx = {
  workspaceRegistry: {
    get: (id) => (id === 'smoke' ? { id, path: workspace } : undefined),
    list: () => [{ id: 'smoke', path: workspace, sessionIds: [sessionId] }],
  },
}
let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}
const readNodes = () => JSON.parse(readFileSync(projectPath, 'utf8')).nodes

// ── ③ 参数校验（不花 GPU）────────────────────────────────────────────────
console.log('\n[3] 参数校验：坏输入必须显式报错')
for (const [name, opts, want] of [
  ['缺 image_node', { image_node: '' }, '必须给 image_node'],
  ['节点不存在', { image_node: 'nope' }, '画布无此节点'],
]) {
  let msg = ''
  try { await _internals.runCrop(ctx, { workspaceId: 'smoke', sessionId, ...opts }) } catch (e) { msg = e.message }
  check(name, msg.includes(want), msg || '(没报错)')
}
{
  const p = JSON.parse(readFileSync(projectPath, 'utf8'))
  p.nodes.push({ id: 'vid-1', kind: 'video', title: '片', media: 'x.mp4', params: {}, status: 'ready', createdAt: Date.now(), order: 2 })
  writeFileSync(projectPath, JSON.stringify(p, null, 2))
  let msg = ''
  try { await _internals.runCrop(ctx, { workspaceId: 'smoke', sessionId, image_node: 'vid-1' }) } catch (e) { msg = e.message }
  check('非图片节点被拒', msg.includes('不是图片节点'), msg || '(没报错)')
  const q = JSON.parse(readFileSync(projectPath, 'utf8'))
  q.nodes = q.nodes.filter((n) => n.id !== 'vid-1')
  writeFileSync(projectPath, JSON.stringify(q, null, 2))
}

// ── ①② 真跑 ─────────────────────────────────────────────────────────────
console.log(`\n[1/2] 真跑 · 面板 ${PANEL}/3 · ${SRC}`)
const nodesBefore = readNodes().length
const t0 = Date.now()
const res = await _internals.runCrop(ctx, {
  workspaceId: 'smoke', sessionId,
  image_node: threeNode.id,
  panel: PANEL,
  panels: 3,
  character: '绛珠',
  card_variant: 'single',
  paired_node_id: threeNode.id,
  title: '绛珠 角色卡·单视图（裁）',
  group: 'character cards',
})
const ms = Date.now() - t0
const size = _internals.probeImageSize(res.absPath) || _internals.probeImageSize(join(workspace, ...String(res.node.media).split('/')))
check('产物落盘', Boolean(size) && res.bytes > 0, `bytes=${res.bytes} size=${size ? size.w + '×' + size.h : '?'}`)
check('产物尺寸 = 宽/3 × 高', Boolean(size) && size.w === Math.floor(2048 / 3) && size.h === 1152, size ? `${size.w}×${size.h}` : '?')
check('画布节点记账 = 产物尺寸', res.node.params.width === size.w && res.node.params.height === size.h)
check('记录裁切矩形与溯源', res.node.params.crop?.x === PANEL * Math.floor(2048 / 3) && res.node.params.cropFrom === threeNode.id)
check('card_variant 写入', res.node.params.cardVariant === 'single')
check('配对双向：裁切卡记三视图', res.node.params.pairedNodeId === 'three-1')
const threeAfter = readNodes().find((n) => n.id === 'three-1')
check('配对双向：三视图记裁切卡', threeAfter?.params?.pairedNodeId === res.node.id, JSON.stringify(threeAfter?.params?.pairedNodeId))
check('画布只多一个节点', readNodes().length === nodesBefore + 1)

// ── ④ 复用 nodeId 重裁 ──────────────────────────────────────────────────
const again = await _internals.runCrop(ctx, {
  workspaceId: 'smoke', sessionId,
  image_node: threeNode.id,
  panel: 1,
  panels: 3,
  nodeId: res.node.id,
  title: '绛珠 角色卡·单视图（裁·改）',
  group: 'character cards',
})
check('复用 nodeId → 画布节点数不变', readNodes().length === nodesBefore + 1)
check('复用 nodeId → 内容被替换（侧面格）', again.node.params.crop?.x === Math.floor(2048 / 3))

console.log(`\n耗时 ${(ms / 1000).toFixed(1)}s · 产物 ${res.absPath}`)
console.log(failures ? `\n✗ ${failures} 项未通过` : '\n✓ 全部通过')
process.exit(failures ? 1 : 0)
