/**
 * scripts/make-upscale-manifests.mjs — 生成「视频超分」（capability=video.upscale）的清单。
 *
 * 与生成类清单的根本差别（决定了这里为什么直接写 workflows/ 而没有单独的模板层）：
 *
 *   · 生成类的图分辨率是**图结构的一部分**（resolutionLock / 画布比例推导），图长什么样就是交付什么样，
 *     所以模板（大 JSON）与清单元数据分两层维护；
 *   · 超分的图分辨率**跟着输入视频走**：LoadVideo → GetVideoComponents 拿到的就是源尺寸，
 *     清单只能声明**倍率** `upscale.factor`（交付尺寸 = 源尺寸 × factor，可再收敛到目标宽度）。
 *     图一共 7 个节点、结构固定，写在代码里比维护一份模板 JSON 更不容易失同步。
 *
 * 图（两档只差 factor 与模型资产槽）：
 *
 *   1 LoadVideo(file=${source_video})                 ← 源片先上传到 ComfyUI input 目录
 *   2 GetVideoComponents                              → images(0) / audio(1) / fps(2)
 *   3 UpscaleModelLoader($assets.upscale_xN)
 *   4 ImageUpscaleWithModel(model=3, image=2.images)   ← 唯一干活的节点：像素空间 ×N
 *   5 ImageScale(width=${out_width}, height=${out_height}, area)   ← 收敛到目标尺寸（缺省=自然尺寸）
 *   6 CreateVideo(images=5, fps=2.fps, audio=2.audio)   ← 音轨原样带回（从不经过任何模型）
 *   7 SaveVideo(mp4/h264)
 *
 * 为什么没有采样器/时间维节点：这是**逐帧** CNN 超分 ⇒ 代价线性、天然可分块
 * （分块与拼接由 runner 负责，见 lib/upscale.js）。实测数据与判据见 docs/video-upscale.md。
 *
 * 用法：node scripts/make-upscale-manifests.mjs
 */
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'workflows')

const GROUP = 'video-upscale'
const REQUIRES = [
  'LoadVideo', 'GetVideoComponents', 'UpscaleModelLoader',
  'ImageUpscaleWithModel', 'ImageScale', 'CreateVideo', 'SaveVideo',
]

/**
 * 一份清单 = 一个倍率配方。
 * estSeconds 口径：**124 帧**、输入为 H3 原生 1344×768 或 U1 的 2688×1536、收敛到 4032×2304（A800 实测）。
 */
const SPECS = [
  {
    id: 'video-upscale-x2',
    displayName: '视频超分 · 学习式像素放大 ×2',
    factor: 2,
    assetKey: 'upscale_x2',
    asset: {
      default: 'RealESRGAN_x2.pth',
      env: 'DSH_SVS_UPSCALE_X2',
      label: '像素空间超分权重（×2，放 models/upscale_models/）',
    },
    priority: 0,
    estSeconds: 261.6,
    note:
      '输入 2688×1536（U1 交付）→ 自然 5376×3072；给 target_width=4032 时收敛到 4032×2304。' +
      '实测 124 帧：261.6s（4032）、317.5s（5376 原样）；248 帧 5376 压测 551.4s 无 OOM。' +
      '有效分辨率（自校准尺子，同一会话六臂对齐）：U1 的 2K →×2 的 5376 读到 ×1.667（2352px）、' +
      '缩到 4032 后 ×1.667（2268px）；原生 →×2 的 2K 交付读到 ×1.65（2218px）。' +
      '**别只看有效宽**：这把尺子偏好高频能量、不偏好干净，且降采样会削掉合成高频——' +
      '这一格的判断请配合 `scripts/compare-crops.py` 生成的 1:1 眼判图。' +
      '常见用法：原生 1344×768 → 2688×1536（实测 155.7s，124 帧）或 U1 的 2K → 4K。' +
      '（×2 后再缩到 2016×1152 只要 65.2s —— 交付像素少一半多。）',
  },
  {
    id: 'video-upscale-x4',
    displayName: '视频超分 · 学习式像素放大 ×4',
    factor: 4,
    assetKey: 'upscale_x4',
    asset: {
      default: 'RealESRGAN_x4.pth',
      env: 'DSH_SVS_UPSCALE_X4',
      label: '像素空间超分权重（×4，放 models/upscale_models/）',
    },
    // priority<0 ⇒ 不做隐式默认（与同能力的 x2 区分：用户要显式选 workflow=video-upscale-x4）
    priority: -10,
    estSeconds: 241.3,
    note:
      '输入 1344×768（H3 原生）→ 自然 5376×3072；给 target_width=4032 时收敛到 4032×2304。' +
      '实测 124 帧 241.3s —— **一趟从原生到 4K**，比「U1 到 2K 再 ×2」链路（1671.2+261.6s）便宜一个数量级。' +
      '**但别凭指标说"细节更多"**：有效宽读到 ×1.963（2671px）高于混合路线的 ×1.667，' +
      '可它的平坦区锐度 362（输入 68.3，5.3×）提示过锐/振铃——这一格必须眼判（`scripts/compare-crops.py`）。' +
      '倍率写死在权重里：换权重必须换同倍率的文件（否则交付尺寸与 factor 声明不符）。',
  },
]

/** 固定 7 节点图；倍率只体现在 UpscaleModelLoader 的资产槽与 factor 声明上。 */
function buildGraph(spec) {
  return {
    1: { class_type: 'LoadVideo', inputs: { file: '${source_video}' } },
    2: { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
    3: { class_type: 'UpscaleModelLoader', inputs: { model_name: '$assets.' + spec.assetKey } },
    4: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['3', 0], image: ['2', 0] } },
    5: {
      class_type: 'ImageScale',
      // 交付尺寸由 runner 按「源尺寸 × factor（→ 目标宽度）」算出后注入；
      // 图里的初值是 32×32（合法最小值），任何真实调用都会被覆盖。
      inputs: { image: ['4', 0], upscale_method: 'area', width: 32, height: 32, crop: 'disabled' },
    },
    6: { class_type: 'CreateVideo', inputs: { images: ['5', 0], fps: ['2', 2], audio: ['2', 1] } },
    7: { class_type: 'SaveVideo', inputs: { video: ['6', 0], filename_prefix: '${prefix}', format: 'mp4', codec: 'h264' } },
  }
}

let n = 0
for (const spec of SPECS) {
  const m = {
    id: spec.id,
    displayName: spec.displayName,
    capability: 'video.upscale',
    tier: 'quality',
    group: GROUP,
    priority: spec.priority,
    estSeconds: spec.estSeconds,
    note: spec.note,
    description:
      spec.displayName + '。输入是**画布上已存在的视频**（不是提示词）：源片上传到 ComfyUI input，' +
      '像素空间超分 ×' + spec.factor + '，音轨原样带回（从不经过模型）。' +
      '交付尺寸 = 源尺寸 × ' + spec.factor + '，可用 target_width 收敛到指定宽度（按 32 对齐）。' +
      '逐帧独立 ⇒ 代价线性、长片可分块（runner 按像素-帧预算自动分块并拼接）。' +
      '模型走资产槽 $assets.' + spec.assetKey + '，可在设置页/env 覆盖（必须换成同倍率的权重）。',
    upscale: {
      factor: spec.factor,
      align: 32,
      note:
        '交付尺寸 = 源视频尺寸 × ' + spec.factor + '（可被 target_width 收敛，按 32 对齐）。' +
        '**比例永远跟源片**：源片是 H3 族的 1.75:1，所以 4032 宽对应 4032×2304（不是 16:9 的 3840×2160）——' +
        '把 4032×2304 叫「4K 级」只是宽度口径。' +
        '调用方传的 width/height 与画布比例都不适用——超分的尺寸跟着输入视频走。',
    },
    assets: {
      [spec.assetKey]: { kind: 'other', ...spec.asset },
    },
    params: {
      source_video: { inject: 'scalar', to: { node: '1', field: 'file' } },
      out_width: { inject: 'scalar', to: { node: '5', field: 'width' } },
      out_height: { inject: 'scalar', to: { node: '5', field: 'height' } },
      prefix: { inject: 'scalar', to: { node: '7', field: 'filename_prefix' } },
    },
    requiresNodes: REQUIRES,
    output: { mediaType: 'video' },
    graph: buildGraph(spec),
  }
  writeFileSync(resolve(OUT, spec.id + '.json'), JSON.stringify(m, null, 2) + '\n', 'utf8')
  n++
  console.log(`✓ ${spec.id}.json（×${spec.factor} · 资产槽 ${spec.assetKey} = ${spec.asset.default} · priority ${spec.priority}）`)
}
console.log(`\n共 ${n} 份超分清单。注意：清单是产物，改结构请改本脚本后重跑。`)
