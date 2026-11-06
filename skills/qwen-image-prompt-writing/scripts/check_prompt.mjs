#!/usr/bin/env node
/**
 * check_prompt.mjs — Qwen-Image prompt 机械规则检查器。
 *
 * 只抓机械性错误（比例泄漏 / 质量词 / 指令语气 / 篇幅 / 位置覆盖 / 光照句 /
 * 收尾句 / 引号配对 / 卡类误带文字 / 改图违反单段与多图标签规范）。
 * 它不判内容好坏——创意部分得人眼过。
 *
 * 用法：
 *   node scripts/check_prompt.mjs <file|-> [--mode t2i|edit|card] [--json] [--strict]
 *   node scripts/check_prompt.mjs --self-test          # 用 references/examples.md 回归
 *
 * 退出码：0 = 无 error；1 = 有 error（--strict 下 warning 也算）；2 = 用法/IO 错误。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXAMPLES = join(HERE, '..', 'references', 'examples.md')

// ── 词表 ────────────────────────────────────────────────────────────────
const RATIOS =
  /\b(1:1|4:3|3:4|3:2|2:3|16:9|9:16|21:9|9:21|2:1|3:1|1:2|1:3|5:4|4:5|7:3|3:7|9:5|5:7|7:5|18:39|9:20|9:2)\b/
const PIXELS = /\b\d{2,5}\s*[x×]\s*\d{2,5}\b/
const RES_WORDS = /\b(720p|1080p|1440p|2160p|uhd|4k|8k|2k|hdr)\b/i

const QUALITY_BOOSTERS = [
  'masterpiece', 'best quality', 'high quality', 'highest quality', 'top quality',
  'ultra detailed', 'ultra-detailed', 'highly detailed', 'hyper detailed', 'hyper-detailed',
  'award winning', 'award-winning', 'trending on artstation', 'professional photography',
  'perfect anatomy', '超高清', '高清', '高质量', '高级感', '细节丰富', '细节拉满',
  '质感拉满', '大师作品', '顶级', '极品', '精致', '完美', '壁纸级', '大片',
  '高端大气', '上档次', '超清', '超精细', '电影级质感',
]
const INSTRUCTION_VERBS = [
  'create', 'creates', 'creating', 'generate', 'generates', 'generating',
  'produce', 'render', 'draw', 'make sure', 'ensure', 'please', 'the ai',
  'you should', '请生成', '请画', '生成一张', '帮我', '要求', '确保', '保证', '务必',
]
const NEGATIONS = [
  "don't", 'do not', 'does not', 'never', 'cannot', 'without', 'avoid',
  '不要', '禁止', '严禁', '不能', '别把', '无需',
]

const POSITIONAL = [
  'upper-left', 'upper left', 'lower-left', 'lower left', 'upper-right', 'upper right',
  'lower-right', 'lower right', 'top edge', 'bottom edge', 'left side', 'right side',
  'on the left', 'on the right', 'in the centre', 'in the center', 'centre of the frame',
  'center of the frame', 'foreground', 'background', 'corner', 'across the top',
  'across the bottom', 'in front of', 'behind', 'beside', 'along the',
  'on the far', 'tucked into', 'lower third', 'upper third', 'top of the frame',
  'bottom of the frame', 'middle band', 'left panel', 'centre panel', 'center panel',
  'right panel', 'upper left of the frame', 'lower edge', 'top of the',
]

const MEDIUM_NOUNS = [
  'photograph', 'photo', 'poster', 'illustration', 'scene', 'portrait', 'infographic',
  'close-up', 'graphic', 'page', 'card', 'sheet', 'logo', 'banner', 'map', 'diagram',
  'painting', 'render', 'frame', 'still',
]

// ── 工具 ────────────────────────────────────────────────────────────────
const stripQuoted = (s) => s.replace(/"[^"]*"/g, '""').replace(/“[^”]*”/g, '""')
const splitSentences = (s) => s.split(/(?<=[.!?。！？])\s+/).map((x) => x.trim()).filter(Boolean)
const countWords = (s) => (s.match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) || []).length
const countCJK = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** 词表命中：拉丁词按词边界匹配（避免 3D-rendered 命中 render），中文按子串。 */
const hasAny = (hay, needles) => {
  const hits = []
  for (const n of needles) {
    if (/[\u4e00-\u9fff]/.test(n)) {
      if (hay.includes(n)) hits.push(n)
    } else if (new RegExp(`\\b${escRe(n)}\\b`).test(hay)) hits.push(n)
  }
  return hits
}
const quotesIn = (s) => [...s.matchAll(/"([^"]*)"/g)].map((m) => m[1])

// ── 检查 ────────────────────────────────────────────────────────────────
function check(raw, mode) {
  const errors = []
  const warnings = []
  const E = (code, message, detail) => errors.push({ code, message, detail })
  const W = (code, message, detail) => warnings.push({ code, message, detail })

  const text = raw.trim()
  if (!text) {
    E('E_EMPTY', 'prompt 为空')
    return { errors, warnings, stats: {} }
  }

  const prose = stripQuoted(text)
  const sentences = splitSentences(text)
  const last = sentences[sentences.length - 1] || ''
  const words = countWords(prose)
  const cjk = countCJK(prose)
  const m = text.toLowerCase()

  // 通用：比例 / 分辨率泄漏
  const ratioHit = prose.match(RATIOS)
  if (ratioHit) E('E_RATIO_LEAK', '描述里出现了比例，比例只走 width/height', ratioHit[0])
  const pixelHit = prose.match(PIXELS)
  if (pixelHit) E('E_RATIO_LEAK', '描述里出现了像素尺寸，分辨率不进 prompt', pixelHit[0])
  const resHit = prose.match(RES_WORDS)
  if (resHit) E('E_RATIO_LEAK', '描述里出现了分辨率词（4K/8K/1080p 等）', resHit[0])

  // 通用：质量词
  const qHits = hasAny(m, QUALITY_BOOSTERS)
  if (qHits.length) E('E_QUALITY_BOOSTER', '官方规范禁止质量词，删掉换真实描述', qHits.join(', '))

  // 通用：引号配对
  if ((text.match(/"/g) || []).length % 2 !== 0) E('E_UNBALANCED_QUOTES', '双引号未配对（每条要渲染的文字都要成对）')
  if (/[“”]/.test(text)) W('W_CURLY_QUOTES', '使用了弯引号，规范要求直双引号 "…"')

  if (mode === 'edit') {
    // 改图：单段、无比例、多图标签
    if (/\n/.test(text)) E('E_NEWLINE', '改图指令必须单段连续，不含换行')
    if (/第一张图|图\s*1\b|\bthe first image\b|\bimage A\b/i.test(text)) {
      E('E_IMAGE_REF_STYLE', '多图改写必须用 <image1> <image2> 标注', '禁用「第一张图 / image A」')
    }
    const tags = [...text.matchAll(/<image(\d+)>/g)].map((x) => Number(x[1]))
    if (tags.length) {
      const uniq = [...new Set(tags)].sort((a, b) => a - b)
      if (uniq[0] !== 1 || uniq[uniq.length - 1] !== uniq.length) {
        E('E_IMAGE_TAGS', '<imageN> 编号必须从 1 连续', uniq.join(', '))
      }
    }
    const iHits = hasAny(m, INSTRUCTION_VERBS)
    if (iHits.length) W('W_INSTRUCTION', '改图指令以动作为导向，避免"请生成/帮我"类语气', iHits.join(', '))
    const nHits = hasAny(m, NEGATIONS)
    if (nHits.length) W('W_NEGATION', 'cfg=1 无负向通道，尽量改成肯定句（「保持 X 不变」）', nHits.join(', '))
    if (!/\bkeep\b|保持|保留|unchanged|exactly as it is/i.test(text)) {
      W('W_NO_PRESERVATION', '改图没写保留条款：未点名的部分会被顺手改掉')
    }
    if (words < 60) W('W_LENGTH', '改图指令偏短，保留范围与强度容易说不清', `${words} 词`)
    if (cjk && !/[A-Za-z]/.test(prose)) {
      W('W_PROSE_LANG', '中文指令的散文可用中文（跟随指令语言），但确保图内文字在引号内')
    }
  } else {
    // T2I / 卡类
    if (words < 350) W('W_LENGTH', '篇幅不足：官方约 400–500 词；短需求更该写足', `${words} 词`)
    if (words > 650) W('W_LENGTH', '篇幅偏长：官方约 400–500 词', `${words} 词`)
    if (sentences.length < 14) W('W_SENTENCES', '句子偏少：官方约 20 句', `${sentences.length} 句`)
    if (sentences.length > 28) W('W_SENTENCES', '句子偏多：官方约 20 句', `${sentences.length} 句`)

    const iHits = hasAny(m, INSTRUCTION_VERBS)
    if (iHits.length) E('E_INSTRUCTION', '描述只能陈述画面里有什么，不能下指令', iHits.join(', '))

    const nHits = hasAny(m, NEGATIONS)
    if (nHits.length) W('W_NEGATION', 'cfg=1 无负向通道：把否定改成正向陈述', nHits.join(', '))

    // 开篇
    const first = sentences[0] || ''
    if (!/^(this is (a|an)|the image is (a|an)|a |an )/i.test(first)) {
      W('W_OPENING', '开篇建议用 "This is a … / The image is a … / A <风格> <媒介> of …"')
    }
    if (!MEDIUM_NOUNS.some((n) => first.toLowerCase().includes(n))) {
      W('W_MEDIUM_NOUN', '开篇缺媒介名词（photograph / poster / illustration / sheet …）', first.slice(0, 60))
    }

    // 位置覆盖
    const posCount = POSITIONAL.filter((p) => m.includes(p)).length
    if (posCount < 8) W('W_POSITIONS', '位置短语不足 8 个：元素会扎堆中间', `${posCount} 个`)

    // 光照句
    if (!/\b(light|lighting|lit|illuminat|shadow|glow|sunlight|daylight|rim|backlit|光线|光照|逆光)\b/i.test(text)) {
      W('W_LIGHT', '缺光照描述：光是必须显式交代的一句')
    }

    // 收尾句
    if (!/overall|composition|palette|mood|design overall/i.test(last)) {
      W('W_CLOSING', '收尾缺 "The overall composition …" 式的一句总结', last.slice(0, 60))
    }

    // 英文散文（图内文字除外）
    if (cjk > 0 && cjk / (words + cjk) > 0.15) {
      W('W_PROSE_LANG', '描述正文应使用英文（图内文字除外）', `${cjk} 个中文字符`)
    }

    // 括号/省略号
    if (/\.\.\.|…/.test(text)) W('W_ELLIPSIS', '描述里出现省略号，规范要求写全不截断')

    if (mode === 'card') {
      const q = quotesIn(text)
      if (q.length) E('E_TEXT_IN_CARD', '角色/场景/道具卡必须零文字：任何引号文字都会被视频模型烙进画面', q.join(' / '))
      if (!/(three|three-view|3-?view|panels|reference sheet|三视图)/i.test(text)) {
        W('W_CARD_LAYOUT', '卡类未见版式描述（三格 / panels / reference sheet）')
      }
      if (!/(background)/i.test(text)) W('W_CARD_BG', '卡类需要交代单一纯净背景')
      if (!/(full body|full-body|全身|head to toe)/i.test(text)) W('W_CARD_FULLBODY', '卡类建议写明全身（full body）')
    }
  }

  return {
    errors,
    warnings,
    stats: { words, sentences: sentences.length, cjkChars: cjk, quotes: quotesIn(text).length },
  }
}

// ── 自检（用 references/examples.md 回归） ───────────────────────────────
function extractBlocks(md) {
  const lines = md.split('\n')
  const out = { good: [], bad: [] }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    let bucket = null
    if (/\*\*✅/.test(l)) bucket = 'good'
    else if (/\*\*❌/.test(l)) bucket = 'bad'
    if (!bucket) continue
    // 标记行可带机器可读的 mode 注解：**✅ 强（mode=edit）**
    const modeHint = (l.match(/mode=(t2i|edit|card)/) || [])[1] || null
    // 跳过标记行后的空行，收一个 blockquote 段落
    let j = i + 1
    while (j < lines.length && lines[j].trim() === '') j++
    const para = []
    while (j < lines.length && lines[j].startsWith('> ')) {
      para.push(lines[j].slice(2))
      j++
    }
    if (para.length) out[bucket].push({ text: para.join(' '), mode: modeHint })
  }
  return out
}

function selfTest() {
  const md = readFileSync(EXAMPLES, 'utf8')
  const { good, bad } = extractBlocks(md)
  let pass = 0
  let fail = 0
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
  }

  ok('examples.md 里找到完整长度样本', good.length >= 3, `${good.length} 个`)
  ok('examples.md 里找到弱样本', bad.length >= 2, `${bad.length} 个`)

  good.forEach((item, i) => {
    const mode = item.mode || (/reference sheet|三视图/i.test(item.text) ? 'card' : 't2i')
    const r = check(item.text, mode)
    const errs = r.errors.map((e) => e.code + ':' + e.detail).join('; ')
    ok(`✅ 样本 #${i + 1}（${mode}）无 error`, r.errors.length === 0, errs)
    if (r.warnings.length) {
      console.log(`      warning: ${r.warnings.map((w) => w.code).join(', ')}`)
    }
  })

  bad.forEach((item, i) => {
    const mode = item.mode || (/改|保持|保留/.test(item.text) ? 'edit' : 't2i')
    const r = check(item.text, mode)
    ok(`❌ 样本 #${i + 1}（${mode}）确实被判出问题`, r.errors.length + r.warnings.length > 0,
      '弱样本居然全绿，检查器可能失效')
  })

  console.log(`\n${fail === 0 ? '✓' : '✗'} check_prompt --self-test：${pass} 通过 / ${fail} 失败`)
  return fail === 0 ? 0 : 1
}

// ── CLI ────────────────────────────────────────────────────────────────
function main(argv) {
  const args = argv.slice(2)
  if (args.includes('--self-test')) return selfTest()

  const modeIdx = args.indexOf('--mode')
  const mode = modeIdx >= 0 ? args[modeIdx + 1] : 't2i'
  if (!['t2i', 'edit', 'card'].includes(mode)) {
    console.error(`未知 mode：${mode}（t2i | edit | card）`)
    return 2
  }
  const json = args.includes('--json')
  const strict = args.includes('--strict')
  const file = args.find((a) => !a.startsWith('--') && a !== mode)

  let raw
  try {
    raw = !file || file === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(file), 'utf8')
  } catch (e) {
    console.error(`读取失败：${e.message}`)
    return 2
  }

  const r = check(raw, mode)
  const failed = r.errors.length > 0 || (strict && r.warnings.length > 0)

  if (json) {
    console.log(JSON.stringify({ mode, ok: !failed, ...r }, null, 2))
  } else {
    const s = r.stats
    console.log(`check_prompt [${mode}] · ${s.words ?? 0} 词 / ${s.sentences ?? 0} 句 / ${s.quotes ?? 0} 条引号文字`)
    for (const e of r.errors) console.log(`  ✗ ${e.code}  ${e.message}${e.detail ? '  → ' + e.detail : ''}`)
    for (const w of r.warnings) console.log(`  ⚠ ${w.code}  ${w.message}${w.detail ? '  → ' + w.detail : ''}`)
    if (!r.errors.length && !r.warnings.length) console.log('  ✓ 机械规则全过（创意部分仍需人眼过）')
    console.log(
      `\n${failed ? '✗ 不通过' : '✓ 通过'}：${r.errors.length} error / ${r.warnings.length} warning` +
      (strict ? '（--strict：warning 也算失败）' : ''),
    )
  }
  return failed ? 1 : 0
}

process.exit(main(process.argv))
