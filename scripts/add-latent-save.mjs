/**
 * scripts/add-latent-save.mjs — 给**所有 balanced 档视频清单**加一个 `OpenH3SaveRefinedLatent` 节点，
 * 让每次 balanced 渲染顺手存下一份 draft latent，供 `video_regenerate(handoff='auto')` 走 latent 交接。
 *
 * 规则（幂等，可反复跑）：
 *   · 只处理 capability 以 `video.` 开头、`tier === 'balanced'`、含 `SamplerCustomAdvanced` 与 `VAEDecodeAudio` 的清单；
 *   · 节点 id 从 24 起找第一个空位；`samples` 接**采样器输出**，`audio` 接**同一采样的音频解码**；
 *   · 2K 清单的采样器是第一遍（768p）⇒ 存下来的正是能当 draft 用的 latent（放大在它之后）；
 *   · 注入点：`latent_prefix`（前缀，runner 会传 `<canvas>/<sid>/<nodeId>_latent`）与
 *     `latent_frame_count`（**交付**帧数，runner 传 deliveredLength——链式续接镜不是多采 22 帧后的采样长度）；
 *   · **不**把 `OpenH3SaveRefinedLatent` 写进 `requiresNodes`：它是**可选依赖**（runner 在节点包缺失时会把该节点
 *     剔除并告警，balanced 照常出片；`handoff='auto'` 自然退回视频入口）。写进去会让没装 Open-H3 的环境
 *     整个 balanced 档变「缺节点」——那是误伤。
 *
 * ⚠️ 生成器（make-h3-variants.mjs / make-2k-template.mjs / make-pdd-template.mjs 等）重跑会覆盖这些文件，
 *    之后需要再执行本脚本一次。已加过的清单会自动跳过。
 *
 * 用法：node scripts/add-latent-save.mjs [--dry]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WF = join(__dirname, '..', 'workflows')
const DRY = process.argv.includes('--dry')
const SAVE_CLASS = 'OpenH3SaveRefinedLatent'

let changed = 0
const touched = []
for (const file of readdirSync(WF).filter((f) => f.endsWith('.json'))) {
  const p = join(WF, file)
  let m
  try { m = JSON.parse(readFileSync(p, 'utf8')) } catch { continue }
  if (!String(m.capability || '').startsWith('video.')) continue
  if (m.tier !== 'balanced') continue
  const nodes = m.graph || {}
  const hasSave = Object.values(nodes).some((n) => n.class_type === SAVE_CLASS)
  if (hasSave) {
    // 清理历史：不把交接节点写进 requiresNodes（可选依赖，见文件头）
    const req = Array.isArray(m.requiresNodes) ? m.requiresNodes.filter((x) => x !== SAVE_CLASS) : m.requiresNodes
    const reqChanged = JSON.stringify(req) !== JSON.stringify(m.requiresNodes)
    if (reqChanged) {
      if (req === undefined || req.length === 0) delete m.requiresNodes
      else m.requiresNodes = req
      changed++
      touched.push(`${m.id} (清理 requiresNodes 里的 ${SAVE_CLASS})`)
      if (!DRY) writeFileSync(p, JSON.stringify(m, null, 2) + '\n')
    }
    continue
  }
  const samplerEntry = Object.entries(nodes).find(([, n]) => n.class_type === 'SamplerCustomAdvanced')
  if (!samplerEntry) continue
  const [samplerId] = samplerEntry
  const audioEntry = Object.entries(nodes).find(([, n]) => n.class_type === 'VAEDecodeAudio' && n.inputs?.samples?.[0] === samplerId)
    || Object.entries(nodes).find(([, n]) => n.class_type === 'VAEDecodeAudio')
  if (!audioEntry) continue
  const [audioId] = audioEntry

  // 找第一个空闲的整数节点 id（从 24 起）
  let id = 24
  while (nodes[String(id)]) id++

  nodes[String(id)] = {
    class_type: SAVE_CLASS,
    inputs: {
      samples: [samplerId, 0],
      frame_count: null,
      filename_prefix: null,
      audio: [audioId, 0],
    },
  }
  m.params = m.params || {}
  m.params.latent_prefix = { inject: 'scalar', to: { node: String(id), field: 'filename_prefix' }, default: 'h3_handoff' }
  m.params.latent_frame_count = { inject: 'scalar', to: { node: String(id), field: 'frame_count' }, default: 0 }
  changed++
  touched.push(`${m.id} (node ${id}, samples←${samplerId}, audio←${audioId})`)
  if (!DRY) writeFileSync(p, JSON.stringify(m, null, 2) + '\n')
}

console.log(`${DRY ? '[dry] ' : ''}已处理 ${changed} 份 balanced 视频清单：`)
for (const t of touched) console.log('  ·', t)
if (!changed) console.log('  （没有需要处理的清单）')
