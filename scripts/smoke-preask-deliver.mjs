/**
 * 冒烟：pre-ask 自动送达（方案 A）
 * 覆盖 collectUndelivered 收集规则 + deliverPending 标记/错误 + listener 四条路径。
 * 用法：node scripts/smoke-preask-deliver.mjs
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _internals } from '../lib/index.js'

const { collectUndelivered, deliverPending, makePreAskDeliverListener, markdownToHtml, renderNodeHtml, exportTextNode, deliveryFilename, TEXT_NODE_EXPORT_PDF } = _internals

let passed = 0
function ok(cond, name) {
  assert.ok(cond, name)
  passed++
  console.log('  ok -', name)
}

// ---------- 0.0. deliveryFilename：友好文件名 ----------
console.log('# deliveryFilename')
{
  ok(deliveryFilename({ id: 'x', title: '主角卡', kind: 'image' }, 'canvas/s/x.png') === '主角卡.png', '媒体：<title>.<ext>')
  ok(deliveryFilename({ id: 'y', title: '简报', kind: 'text' }, 'canvas/s/y.pdf') === '简报.pdf', '文本：<title>.pdf')
  ok(deliveryFilename({ id: 'z', title: '镜头表', kind: 'table' }, 'canvas/s/z.html') === '镜头表.html', '扩展名保留（html 兜底）')
  ok(deliveryFilename({ id: 'w', title: 'S01 片段' }, 'canvas/s/w.mp4') === 'S01 片段.mp4', '保留空格与数字')
  ok(deliveryFilename({ id: 'v', title: 'a/b\\c:d*e?f"g<h>i|j' }, 'canvas/s/v.png') === 'a b c d e f g h i j.png', '非法字符清理为空格')
  ok(deliveryFilename({ id: 'u', title: '  ' }, 'canvas/s/u.mp4') === 'file-u.mp4', '空标题回退 kind-id')
  ok(deliveryFilename({ id: 't', title: '视频'.repeat(30) }, 'canvas/s/t.mp4') === '视频'.repeat(30).slice(0, 60) + '.mp4', '超长标题截断 60 字符')
}

// ---------- 0.5. exportTextNode：PDF 优先、无工具/失败兜底 .html ----------
console.log('# exportTextNode')
{
  const root = mkdtempSync(join(tmpdir(), 'dsh-svs-export-'))
  try {
    const sid = 'sid-x'
    // 无 PDF 工具 → 兜底 .html
    const out1 = await exportTextNode(root, sid, 'n1', '简报', 'text', 'story planning', '# 标题\n\n正文', null)
    ok(out1.ext === 'html' && out1.rel === 'canvas/' + sid + '/n1.html', '无 PDF 工具 → 导出 .html 兜底')
    ok(existsSync(join(root, 'canvas', sid, 'n1.html')), '.html 文件已落盘')
    // PDF 工具转失败（bin 不存在 → puppeteer/CLI 均失败）→ 兜底 .html
    const out2 = await exportTextNode(root, sid, 'n2', '镜头表', 'table', 'shot table', '| 镜号 | 内容 |', { type: 'chrome', bin: '/nonexistent/chrome' })
    ok(out2.ext === 'html' && out2.rel === 'canvas/' + sid + '/n2.html', 'PDF 转换失败 → 兜底 .html')
    ok(existsSync(join(root, 'canvas', sid, 'n2.html')), '失败兜底 .html 文件已落盘')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------- 0. markdownToHtml 转换 ----------
console.log('# markdownToHtml')
{
  const md = [
    '# 简报标题',
    '',
    '> 一句话 premise',
    '',
    '**主角** Want：飞上太空。',
    '',
    '| 镜号 | 景别 | 内容 |',
    '| --- | --- | --- |',
    '| 01 | 全景 | 小狐狸抬头望月 |',
    '| 02 | 特写 | 眼神坚定 |',
    '',
    '- 锚点 A',
    '- 锚点 B',
    '',
    '1. 第一步',
    '2. 第二步',
    '',
    '```',
    'code block',
    '```',
  ].join('\n')
  const html = markdownToHtml(md)
  ok(html.includes('<h1>简报标题</h1>'), '标题 → h1')
  ok(html.includes('<blockquote>'), '引用 → blockquote')
  ok(html.includes('<strong>主角</strong>'), '粗体 → strong')
  ok(html.includes('<table') && html.includes('class="node-table"') && html.includes('<th>镜号</th>') && html.includes('<td>01</td>'), '表格 → table.node-table（含表头与行）')
  ok(html.includes('<ul>') && html.includes('<li>锚点 A</li>'), '无序列表 → ul')
  ok(html.includes('<ol>') && html.includes('<li>第一步</li>'), '有序列表 → ol')
  ok(html.includes('<pre><code>code block</code></pre>'), '代码块 → pre/code')
  ok(!html.includes('| 镜号'), '分隔行被剔除')
  // 转义与注入防护
  const esc = markdownToHtml('<script>alert(1)</script>')
  ok(!esc.includes('<script>'), '原始 HTML 被转义（防注入）')
  ok(esc.includes('&lt;script&gt;'), '尖括号转义为实体')
  // renderNodeHtml 完整文档
  const doc = renderNodeHtml('镜头表', 'table', 'shot table', md)
  ok(doc.startsWith('<!DOCTYPE html>') && doc.includes('shot table') && doc.includes('<body>'), 'renderNodeHtml 输出完整 HTML 文档')
}

// ---------- 1. collectUndelivered ----------
console.log('# collectUndelivered')
{
  const project = {
    nodes: [
      { id: 'a', kind: 'image', media: 'canvas/s/a.png', status: 'ready', order: 2 },
      { id: 'b', kind: 'video', media: 'canvas/s/b.mp4', status: 'ready', params: { deliveredAt: 1 }, order: 3 },
      { id: 'c', kind: 'image', media: '', status: 'ready', order: 4 },
      { id: 'd', kind: 'text', title: '简报', content: 'x', file: 'canvas/s/d.pdf', status: 'ready', order: 1 },
      { id: 'e', kind: 'table', content: 'y', file: 'canvas/s/e.pdf', status: 'ready', params: { deliveredAt: 1 }, order: 5 },
      { id: 'f', kind: 'image', media: 'canvas/s/f.png', status: 'pending', order: 6 },
      { id: 'g', kind: 'audio', media: 'canvas/s/g.mp3', status: 'ready', order: 7 },
    ],
  }
  const pending = collectUndelivered(project)
  const paths = pending.map((p) => p.path)
  ok(paths.includes('canvas/s/a.png'), 'image 未送达 → 收集')
  ok(!paths.includes('canvas/s/b.mp4'), 'video 已送达 → 跳过')
  ok(!paths.includes(''), '无 media → 跳过')
  ok(paths.includes('canvas/s/d.pdf'), `text 有 file 未送达 → 收集 (TEXT_NODE_EXPORT_PDF=${TEXT_NODE_EXPORT_PDF})`)
  ok(!paths.includes('canvas/s/e.pdf'), 'table 已送达 → 跳过')
  ok(!paths.includes('canvas/s/f.png'), '非 ready → 跳过')
  ok(paths.includes('canvas/s/g.mp3'), 'audio 未送达 → 收集')
  ok(pending[0].node.id === 'd', '按 order 升序（d 先于 a）')
}

// ---------- 2. deliverPending 成功/失败标记 + 友好文件名 ----------
console.log('# deliverPending')
{
  const root = mkdtempSync(join(tmpdir(), 'dsh-svs-deliver-'))
  try {
    const sid = 'sid1'
    const canvasDir = join(root, 'canvas', sid)
    mkdirSync(canvasDir, { recursive: true })
    writeFileSync(join(canvasDir, 'ok.png'), 'png-bytes')
    writeFileSync(join(canvasDir, 'bad.mp4'), 'mp4-bytes')
    const project = {
      nodes: [
        { id: 'ok', kind: 'image', title: '主角卡', media: 'canvas/' + sid + '/ok.png', status: 'ready', order: 0, params: {} },
        { id: 'bad', kind: 'video', title: 'S01片段', media: 'canvas/' + sid + '/bad.mp4', status: 'ready', order: 1, params: {} },
      ],
    }
    const calls = []
    const ctx = {
      tools: {
        execute: async (exec) => {
          calls.push(exec.arguments.path)
          if (calls.length === 2) throw new Error('too_large: 超过 20 MiB')
          return { sent: true }
        },
      },
    }
    const exec = { agent: { id: sid }, signal: undefined }
    const pending = collectUndelivered(project)
    const { sent, errored } = await deliverPending(ctx, exec, root, sid, project, pending)
    ok(sent === 1 && errored === 1, `sent=1 errored=1 (got ${sent}/${errored})`)
    ok(calls.length === 2, 'send_file 被调 2 次')
    ok(calls[0] === '.delivery/' + sid + '/主角卡.png', '媒体以节点标题命名（.delivery/<sid>/主角卡.png）')
    ok(calls[1] === '.delivery/' + sid + '/S01片段.mp4', '失败项同样走友好名副本')
    ok(!existsSync(join(root, '.delivery', sid, '主角卡.png')), '发送成功后副本已清理')
    ok(!existsSync(join(root, '.delivery', sid, 'S01片段.mp4')), '发送失败后副本也已清理')
    ok(existsSync(join(canvasDir, 'ok.png')), '画布原文件不受影响')
    ok(project.nodes[0].params.deliveredAt > 0, '成功节点打 deliveredAt')
    ok(!project.nodes[1].params.deliveredAt, '失败节点不打 deliveredAt')
    ok(String(project.nodes[1].params.deliveryError).includes('too_large'), '失败节点记 deliveryError')
    // 二次收集：已送达跳过、失败项重试
    const again = collectUndelivered(project)
    ok(again.length === 1 && again[0].node.id === 'bad', '失败项下次重试，成功项不再发')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------- 3. listener 四条路径 ----------
console.log('# makePreAskDeliverListener')
{
  const root = mkdtempSync(join(tmpdir(), 'dsh-svs-listener-'))
  try {
    const sessionId = 'sid-l'
    const canvasDir = join(root, 'canvas', sessionId)
    mkdirSync(canvasDir, { recursive: true })
    writeFileSync(join(canvasDir, 'project.json'), JSON.stringify({
      schemaVersion: 1,
      sessionId,
      settings: { aspectRatio: '16:9', duration: '', audioMode: 'silent' },
      nodes: [
        { id: 'n1', kind: 'image', title: '角色卡A', media: 'canvas/' + sessionId + '/n1.png', status: 'ready', order: 0, params: {} },
        { id: 'n2', kind: 'text', title: 'T', content: 'c', file: 'canvas/' + sessionId + '/n2.pdf', status: 'ready', order: 1, params: {} },
      ],
    }), 'utf8')
    writeFileSync(join(canvasDir, 'n1.png'), 'png-bytes')
    writeFileSync(join(canvasDir, 'n2.pdf'), 'pdf-bytes')

    let sendVisible = true
    let failNext = false
    const executeCalls = []
    const ctx = {
      workspaceRegistry: { get: () => undefined, list: () => [] },
      tools: {
        get: (name) => (name === 'send_file' && sendVisible ? {} : undefined),
        execute: async (exec) => {
          executeCalls.push(exec.arguments.path)
          if (failNext) { failNext = false; throw new Error('upload failed') }
          return { sent: true }
        },
      },
    }
    const agent = { id: sessionId, session: { id: sessionId, meta: { cwd: root } } }
    const listener = makePreAskDeliverListener(ctx)

    let nextCount = 0
    const next = () => { nextCount++; return 'gate' }

    // 路径 1：非 ask 工具 → 放行，不送达
    await listener({ name: 'comfy_generate_image', agent, signal: undefined }, next)
    ok(nextCount === 1 && executeCalls.length === 0, '非 ask 工具：放行且不送达')

    // 路径 2：ask 但无 send_file（Web/TUI）→ 放行，不送达
    sendVisible = false
    await listener({ name: 'ask_user_question', agent, signal: undefined }, next)
    ok(nextCount === 2 && executeCalls.length === 0, '无 send_file：放行且不送达')

    // 路径 3：ask 且 send_file 可见 → 送达全部未送达产物（友好文件名）并放行
    sendVisible = true
    await listener({ name: 'ask_user_question', agent, signal: undefined }, next)
    ok(nextCount === 3, 'ask：放行')
    ok(executeCalls.length === 2, 'ask：送达 2 个产物')
    ok(executeCalls[0] === '.delivery/' + sessionId + '/角色卡A.png', '媒体副本：角色卡A.png')
    ok(executeCalls[1] === '.delivery/' + sessionId + '/T.pdf', '文本副本：T.pdf')
    ok(!existsSync(join(root, '.delivery', sessionId, '角色卡A.png')), '发送后媒体副本已清理')
    ok(!existsSync(join(root, '.delivery', sessionId, 'T.pdf')), '发送后文本副本已清理')
    const saved = JSON.parse(readFileSync(join(canvasDir, 'project.json'), 'utf8'))
    ok(saved.nodes.every((n) => n.params.deliveredAt > 0), '送达后节点持久化 deliveredAt')

    // 路径 4：ask 且产物发送失败 → 不阻塞、记 deliveryError，仍放行
    saved.nodes[0].params = { deliveredAt: undefined }
    writeFileSync(join(canvasDir, 'project.json'), JSON.stringify(saved), 'utf8')
    failNext = true
    await listener({ name: 'ask_user_question', agent, signal: undefined }, next)
    ok(nextCount === 4, '失败场景 ask 仍放行')
    const saved2 = JSON.parse(readFileSync(join(canvasDir, 'project.json'), 'utf8'))
    ok(String(saved2.nodes[0].params.deliveryError).length > 0, '失败节点记 deliveryError')
    ok(!existsSync(join(root, '.delivery', sessionId, '角色卡A.png')), '发送失败后副本也已清理')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log(`\npre-ask deliver smoke: ${passed} checks passed`)
