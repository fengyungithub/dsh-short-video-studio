/**
 * lib/convert.js — 把 ComfyUI「导出 API」JSON 转成 workflow manifest（纯逻辑）。
 * 供 CLI（scripts/import-comfy.mjs）与导入路由（POST /api/workflows）共用。
 *
 * 原理：ComfyUI 导出的 API 格式本身就是我们的 graph 格式（{nodeId:{class_type,inputs}}）。
 * 只做机械转换：抽模型资产 → $assets.*；可变标量置 null + 声明 params 注入点；
 * LoadImage / LoRA 等语义绑定打印 todos 交人工。
 */

export const ASSET_LOADERS = {
  CheckpointLoaderSimple: { field: 'ckpt_name', key: 'checkpoint', kind: 'checkpoint' },
  UNETLoader: { field: 'unet_name', key: 'unet', kind: 'checkpoint' },
  DiffusionModelLoader: { field: 'model_name', key: 'unet', kind: 'checkpoint' },
  CLIPLoader: { field: 'clip_name', key: 'clip', kind: 'clip' },
  DualCLIPLoader: { field: 'clip_name1', key: 'clip', kind: 'clip' },
  VAELoader: { field: 'vae_name', key: 'vae', kind: 'vae' },
  LoraLoader: { field: 'lora_name', key: 'lora', kind: 'lora' },
  LoraLoaderModelOnly: { field: 'lora_name', key: 'lora', kind: 'lora' },
}

export const SCALAR_MAP = {
  RandomNoise: { noise_seed: 'seed' },
  KSampler: { seed: 'seed', steps: 'steps' },
  BasicScheduler: { steps: 'steps' },
  Flux2Scheduler: { steps: 'steps' },
  FluxGuidance: { guidance: 'guidance' },
  SaveImage: { filename_prefix: 'prefix' },
  SaveVideo: { filename_prefix: 'prefix' },
  EmptyLatentImage: { width: 'width', height: 'height' },
  EmptySD3LatentImage: { width: 'width', height: 'height' },
  EmptyFlux2LatentImage: { width: 'width', height: 'height' },
  ModelSamplingFlux: { width: 'width', height: 'height' },
}

/** 判断是否 ComfyUI 原始导出（有 {nodeId:{class_type,...}}，但无 id/capability/graph）。 */
export function isRawComfyExport(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false
  if (obj.id !== undefined || obj.capability !== undefined || obj.graph !== undefined) return false
  const nodes = Object.values(obj)
  return nodes.length > 0 && nodes.every((n) => n && typeof n.class_type === 'string')
}

/** 判断是否旧版 ComfyUI「Save workflow」格式（nodes/links 数组，非 API 格式）。 */
export function isLegacyWorkflowFormat(obj) {
  return typeof obj === 'object' && obj !== null && !Array.isArray(obj)
    && Array.isArray(obj.nodes) && Array.isArray(obj.links)
    && obj.nodes.length > 0 && obj.nodes[0] && typeof obj.nodes[0].type === 'string'
}

/**
 * 转换 ComfyUI 原始导出为 manifest。
 * @param raw 导出的 JSON 对象
 * @param opts { id, capability, displayName?, mediaType? }
 * @returns { ok:true, manifest, todos } | { ok:false, errors }
 */
export function convertComfyExport(raw, opts = {}) {
  const { id, capability, displayName = id || 'Imported Workflow', mediaType = 'image' } = opts
  if (!id || !capability) return { ok: false, errors: ['缺少 id 或 capability'] }

  // 归一化为纯 API 格式：只保留 class_type + inputs，剥掉 _meta 等 UI 字段
  const graph = {}
  for (const [nid, node] of Object.entries(raw)) {
    if (node && typeof node.class_type === 'string') {
      graph[nid] = { class_type: node.class_type, inputs: JSON.parse(JSON.stringify(node.inputs || {})) }
    }
  }
  const assets = {}
  const params = {}
  const todos = []
  const usedKey = {}

  const allocKey = (base) => {
    if (!usedKey[base]) { usedKey[base] = true; return base }
    let i = 2
    while (usedKey[base + i]) i++
    usedKey[base + i] = true
    return base + i
  }
  const addTarget = (name, nid, field) => {
    params[name] = params[name] || { inject: 'scalar', to: [] }
    if (!params[name].to.some((t) => t.node === nid && t.field === field)) params[name].to.push({ node: nid, field })
  }

  let positiveNode = null
  let negativeNode = null
  for (const [nid, node] of Object.entries(raw)) {
    if (Array.isArray(node?.inputs?.positive)) positiveNode = String(node.inputs.positive[0])
    if (Array.isArray(node?.inputs?.negative)) negativeNode = String(node.inputs.negative[0])
  }

  for (const [nid, node] of Object.entries(graph)) {
    const ct = node.class_type
    if (ASSET_LOADERS[ct]) {
      const spec = ASSET_LOADERS[ct]
      const fname = node.inputs?.[spec.field]
      if (typeof fname === 'string' && fname) {
        const key = allocKey(spec.key)
        assets[key] = { kind: spec.kind, default: fname, label: spec.field }
        node.inputs[spec.field] = '$assets.' + key
      }
    }
    if (SCALAR_MAP[ct]) {
      for (const [field, pname] of Object.entries(SCALAR_MAP[ct])) {
        if (node.inputs?.[field] !== undefined && node.inputs[field] !== null) {
          const orig = node.inputs[field]
          addTarget(pname, nid, field)
          if (pname === 'prefix' && params[pname].default === undefined) params[pname].default = orig
          node.inputs[field] = null
        }
      }
    }
    if (ct === 'CLIPTextEncode') {
      if (nid === positiveNode) { addTarget('prompt', nid, 'text'); node.inputs.text = null }
      else if (nid === negativeNode) todos.push(`负向提示词保留在节点 ${nid}（当前 runner 不注入 negative）`)
      else todos.push(`CLIPTextEncode 节点 ${nid} 未识别为正/负向，已保留原 text，请确认`)
    } else if (node.inputs && typeof node.inputs.prompt === 'string') {
      addTarget('prompt', nid, 'prompt')
      node.inputs.prompt = null
    }
    if (ct === 'LoadImage') todos.push(`LoadImage 节点 ${nid} 需手动改为 image 参数（refs / first_frame / last_frame，inject:"image" via:"node"）`)
    if (ct === 'LoraLoader' || ct === 'LoraLoaderModelOnly') todos.push(`LoRA 节点 ${nid} 若用于 fast/quality 档切换，请移入 modes.<mode>.loras 并配合 $model 哨兵`)
  }

  for (const [pname, p] of Object.entries(params)) {
    if (p.to.length === 1) p.to = p.to[0]
  }

  const manifest = {
    id,
    version: 1,
    capability,
    runner: 'comfyui',
    displayName,
    output: { mediaType },
    assets,
    graph,
    params,
  }
  if (mediaType === 'video') manifest.output.hasAudio = false

  return { ok: true, manifest, todos }
}
