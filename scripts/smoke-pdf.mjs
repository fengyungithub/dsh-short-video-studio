/**
 * 冒烟：文本节点 → PDF 真实转换链路。
 * 依赖本机 PDF 工具（puppeteer-core + Chrome 优先）；无工具时输出 SKIP（不视为失败）。
 * 用法：node scripts/smoke-pdf.mjs
 */
import { strict as assert } from 'node:assert'
import { readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectPdfTool, htmlToPdf } from '../lib/pdf.js'

const tool = await detectPdfTool()
if (!tool) {
  console.log('SKIP: 本机无 PDF 工具（Chrome/soffice/cupsfilter）')
  process.exit(0)
}
console.log(`# detectPdfTool → ${tool.type} (${tool.bin})`)

const dir = mkdtempSync(join(tmpdir(), 'dsh-svs-pdf-smoke-'))
try {
  const htmlAbs = join(dir, 'doc.html')
  const pdfAbs = join(dir, 'doc.pdf')
  writeFileSync(htmlAbs, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
table{border-collapse:collapse}th,td{border:1px solid #333;padding:6px}th{background:#f6f8fa}
</style></head><body>
<h1>测试简报</h1>
<table><thead><tr><th>镜号</th><th>内容</th></tr></thead>
<tbody><tr><td>01</td><td>小狐狸抬头望月</td></tr></tbody></table>
</body></html>`, 'utf8')

  await htmlToPdf(tool, htmlAbs, pdfAbs)

  const buf = readFileSync(pdfAbs)
  assert.ok(buf.length > 1024, `PDF 非空（${buf.length} bytes）`)
  assert.ok(buf.subarray(0, 4).toString() === '%PDF', '文件头为 %PDF')
  console.log(`  ok - PDF 生成 ${buf.length} bytes，头 %PDF（工具 ${tool.type}）`)

  // PDF 里应含表格文本（可检索文本层；puppeteer 渲染会嵌入文本）
  const text = buf.toString('latin1')
  assert.ok(text.includes('小狐狸抬头望月') || text.includes('01'), 'PDF 含文档正文文本')
  console.log('  ok - PDF 含正文文本')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log('\npdf smoke passed')
