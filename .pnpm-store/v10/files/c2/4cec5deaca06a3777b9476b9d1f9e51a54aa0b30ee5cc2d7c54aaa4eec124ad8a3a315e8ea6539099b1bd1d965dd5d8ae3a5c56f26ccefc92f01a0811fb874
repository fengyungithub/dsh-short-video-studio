/**
 * scripts/make-upscale-manifests.mjs — 生成「视频超分」（capability=video.upscale）的清单。
 *
 * 与生成类清单的根本差别（决定了这里为什么直接写 workflows/ 而没有单独的模板层）：
 *
 *   · 生成类的图分辨率是**图结构的一部分**（resolutionLock / 画布比例推导），图长什么样就是交付什么样，
 *     所以模板（大 JSON）与清单元数据分两层维护；
 *   · 超分的图分辨率**跟着输入视频走**：LoadVideo → GetVideoComponents 拿到的就是源尺寸，
 *     清单声明的是**尺寸来源**（`upscale.sizing`，契约见 docs/video-upscale.md §3）：
 *       · `factor`      交付 = 源尺寸 × factor（像素空间逐帧 CNN；本文件生成的两份就是这一形态）
 *       · `short-side`  交付由实现的**目标短边**推导（扩散/恢复类模型，如 SeedVR2 的 resolution），
 *                       必须配 `params.out_short_side` 让 runner 把解析出的短边回注实现
 *     还要声明**分块归属** `upscale.chunking`：`caller`（逐帧独立，runner 可按像素-帧预算切）或
 *     `internal`（自带跨帧时间先验，显存由实现自己管，外层不切）。本文件的两份都是 `caller`。
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
 * `sizing` / `chunking` 显式写出来（虽然缺省就是这两个值）——清单是用户会直接打开看的产物，
 * 让它自己把契约讲清楚，比让人去翻 docs 更不容易误读。
 */
const SPECS = [
  {
    id: 'video-upscale-x2',
    displayName: '视频超分 · 学习式像素放大 ×2',
    graph: 'pixel',
    sizing: 'factor',
    chunking: 'caller',
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
    graph: 'pixel',
    sizing: 'factor',
    chunking: 'caller',
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
  {
    id: 'video-upscale-seedvr2-3b',
    displayName: '视频超分 · SeedVR2 3B（扩散式恢复 / 放大）',
    graph: 'seedvr2',
    // 尺寸语义仍是 factor：清单声明**默认**倍率 2；但图里是把交付尺寸直接喂给模型（节点 3），
    // 所以 target_width 会真正改变模型渲染的尺寸，而不是先渲染再降采样。
    sizing: 'factor',
    chunking: 'internal',
    factor: 2,
    // 比 x2 更贵更重 ⇒ 不做隐式默认（要显式 workflow= 或改档位映射）
    priority: -20,
    // 口径：**124 帧 · 输入 H3 原生 1344×768 · 交付 2688×1536 · 单卡 Ampere 80GB 实测 483.4s**
    // （同源同交付下 video-upscale-x2 是 69.0s ⇒ SeedVR2 是 7.0×）。代价随交付像素量上升。
    estSeconds: 483,
    note:
      'SeedVR2 = 一步扩散式视频恢复（ICLR 2026，字节 Seed），ComfyUI **原生支持**（PR #14424），' +
      '不需要任何自定义节点包；权重走资产槽 $assets.seedvr2_dit / $assets.seedvr2_vae。' +
      '与像素链路的三处关键差别：①**进采样器**（一步 KSampler，denoise=1 全量恢复）⇒ 工具口径不是「不经过模型」；' +
      '②**自带跨帧语义**（VAE temporal tiling + 多帧 restoration）⇒ 声明 chunking="internal"，外层不自动切；' +
      '③**target_width 真正驱动模型**——图里先把输入重采样到交付尺寸再恢复，不会「渲染大了再缩」。' +
      '音轨照旧不进模型（GetVideoComponents.audio → CreateVideo.audio）。' +
      '长片建议按分镜做；要更长可改用图内的 SeedVR2TemporalChunk/Merge（本清单未接，先跑通基线）。' +
      '**实测（124 帧 · 1344×768 → 2688×1536）**：483.4s；同源同交付下像素链路 video-upscale-x2 只要 69.0s（**7.0×**）。' +
      '画质（同一把自校准尺子）：有效宽 2654（×1.975）> U3 的 2218（×1.65），1:1 眼判也确实更实（砖墙/伞布/霓虹边缘）；' +
      '**但平坦区注入了可见细颗粒**（平坦区锐度 311 = 输入的 4.6×，与 4032 那格被判「过锐/振铃」的 362 同档），' +
      '平坦区闪烁比 1.045（U3 是 0.958）⇒ 是「细节更多但会加颗粒」的一档，不是无代价的升级。',
    description:
      '视频超分/恢复 · SeedVR2 3B（扩散式，一步推理）。输入是**画布上已存在的视频**：先把帧重采样到交付尺寸，' +
      '再由 SeedVR2 在该尺寸上做一步扩散恢复（比逐帧 CNN 更吃细节，但慢得多、显存也高）。' +
      '音轨原样带回（不经过模型）；交付尺寸 = 源尺寸 × 2（可用 target_width 改，且**会真正驱动模型**，按 32 对齐）。' +
      '显存由实现自己管（chunking=internal），`chunk_frames=` 会被警告。权重走资产槽可替换。' +
      '**比 video-upscale-x2 慢且重**，只在需要「恢复/重塑细节」时选它。',
    upscaleNote:
      '交付尺寸 = 源尺寸 × 2（缺省），可用 target_width 收敛到任意宽度（按 32 对齐）。' +
      '**与像素链路不同的关键点**：图里第 3 个节点先把帧重采样到交付尺寸，SeedVR2 在该尺寸上做恢复 ⇒ ' +
      'target_width 是**真驱动**（不会先渲染到某个倍率再降采样丢掉高频）；' +
      '但也因此**代价随交付像素量上升**（不像逐帧 CNN 那样近似线性——它是 DiT 前向 + VAE 编解码）。' +
      '`sizing="factor"` 在这里的含义是「默认倍率 2」，倍率不再写死在权重里（SeedVR2 接受任意尺寸）。' +
      '`chunking="internal"`：模型自带跨帧时间窗与 VAE temporal tiling ⇒ runner 不自动分块，显存交给它自己' +
      '（`tile_size` / `temporal_size` / `overlap` 在图里）。' +
      '**比例永远跟源片**（H3 族 1.75:1 ⇒ 4032 宽 = 4032×2304）。',
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

/**
 * SeedVR2 原生图（ComfyUI 内置支持，PR #14424；官方模板 `utility_seedvr2_3b_int8_upscale_video`）。
 *
 * 与像素链路的**结构性差别**（决定了它为什么用同一份契约但不同的图）：
 *   · 它先把输入重采样到**交付尺寸**（节点 3，Lanczos），再让 SeedVR2 在该尺寸上做一步 restoration
 *     （`KSampler steps=1 / cfg=1 / denoise=1`，euler+simple）⇒ **target_width 真正驱动模型**，
 *     而不是先渲染到某个倍率再降采样；不需要额外的倍率注入 —— runner 注入的 out_width/out_height
 *     就是精确交付尺寸（比倍率更准，不会因取整漂）。
 *   · **进采样器**：所以 `video_upscale` 的工具描述不能再写「不经过模型」（已改成中性口径）。
 *   · **自带跨帧语义**：VAE 编解码按 `temporal_size/temporal_overlap` 分块，restoration 也吃多帧 ⇒
 *     声明 `chunking="internal"`，外层不自动切（硬切会打断它的时间窗）。
 *   · **音轨照样不进模型**：`GetVideoComponents.audio → CreateVideo.audio` 直连（与像素链路同构）。
 *
 * 图（13 节点）：
 *   1 LoadVideo → 2 GetVideoComponents ─┬─────────────→ 12 CreateVideo(audio/fps)
 *                                       └→ 3 ImageScale(交付尺寸, lanczos) ─→ 4 SeedVR2Preprocess
 *   5 UNETLoader($assets.seedvr2_dit) ─┬→ 8 SeedVR2Conditioning ─→ 9 KSampler ─→ 10 VAEDecodeTiled
 *   6 VAELoader($assets.seedvr2_vae) ──┴→ 7 VAEEncodeTiled ────────┘                   │
 *   3 同时喂 11 SeedVR2PostProcessing(original_resized_images) ←──────────────────────┘
 *   11 → 12 CreateVideo → 13 SaveVideo
 */
function buildSeedVR2Graph() {
  return {
    1: { class_type: 'LoadVideo', inputs: { file: '${source_video}' } },
    2: { class_type: 'GetVideoComponents', inputs: { video: ['1', 0] } },
    3: {
      class_type: 'ImageScale',
      // 交付尺寸（runner 注入）＝模型要恢复的尺寸；初值 32×32 只是合法占位
      inputs: { image: ['2', 0], upscale_method: 'lanczos', width: 32, height: 32, crop: 'disabled' },
    },
    4: { class_type: 'SeedVR2Preprocess', inputs: { resized_images: ['3', 0] } },
    5: { class_type: 'UNETLoader', inputs: { unet_name: '$assets.seedvr2_dit', weight_dtype: 'default' } },
    6: { class_type: 'VAELoader', inputs: { vae_name: '$assets.seedvr2_vae' } },
    7: {
      class_type: 'VAEEncodeTiled',
      inputs: { pixels: ['4', 0], vae: ['6', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 },
    },
    8: { class_type: 'SeedVR2Conditioning', inputs: { model: ['5', 0], vae_conditioning: ['7', 0] } },
    9: {
      class_type: 'KSampler',
      inputs: {
        model: ['5', 0],
        // 固定种子：超分是确定性后处理，不给调用方一个「随机重画」的旋钮
        seed: 1,
        steps: 1,
        cfg: 1.0,
        sampler_name: 'euler',
        scheduler: 'simple',
        positive: ['8', 0],
        negative: ['8', 1],
        latent_image: ['7', 0],
        denoise: 1.0,
      },
    },
    10: {
      class_type: 'VAEDecodeTiled',
      inputs: { samples: ['9', 0], vae: ['6', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 },
    },
    11: {
      class_type: 'SeedVR2PostProcessing',
      inputs: { images: ['10', 0], original_resized_images: ['3', 0], color_correction_method: 'none' },
    },
    12: { class_type: 'CreateVideo', inputs: { images: ['11', 0], fps: ['2', 2], audio: ['2', 1] } },
    13: { class_type: 'SaveVideo', inputs: { video: ['12', 0], filename_prefix: '${prefix}', format: 'mp4', codec: 'h264' } },
  }
}

/** 每种图形态各自的接线、节点清单与资产槽（清单是它们的产物）。 */
const GRAPHS = {
  pixel: {
    build: buildGraph,
    requiresNodes: REQUIRES,
    params: {
      source_video: { inject: 'scalar', to: { node: '1', field: 'file' } },
      out_width: { inject: 'scalar', to: { node: '5', field: 'width' } },
      out_height: { inject: 'scalar', to: { node: '5', field: 'height' } },
      prefix: { inject: 'scalar', to: { node: '7', field: 'filename_prefix' } },
    },
    assets: (spec) => ({ [spec.assetKey]: { kind: 'other', ...spec.asset } }),
  },
  seedvr2: {
    build: buildSeedVR2Graph,
    requiresNodes: [
      'LoadVideo', 'GetVideoComponents', 'ImageScale', 'SeedVR2Preprocess',
      'UNETLoader', 'VAELoader', 'VAEEncodeTiled', 'SeedVR2Conditioning', 'KSampler',
      'VAEDecodeTiled', 'SeedVR2PostProcessing', 'CreateVideo', 'SaveVideo',
    ],
    params: {
      source_video: { inject: 'scalar', to: { node: '1', field: 'file' } },
      // 交付尺寸**直接喂模型**（节点 3 重采样 → SeedVR2 在该尺寸上恢复），所以 target_width 是真驱动
      out_width: { inject: 'scalar', to: { node: '3', field: 'width' } },
      out_height: { inject: 'scalar', to: { node: '3', field: 'height' } },
      prefix: { inject: 'scalar', to: { node: '13', field: 'filename_prefix' } },
    },
    assets: () => ({
      seedvr2_dit: {
        kind: 'other',
        default: 'seedvr2_3b_int8_convrot.safetensors',
        env: 'DSH_SVS_SEEDVR2_DIT',
        label: 'SeedVR2 DiT 权重（放 models/diffusion_models/；3B int8 起，7B int8 更强）',
      },
      seedvr2_vae: {
        kind: 'other',
        default: 'seedvr2_ema_vae_fp16.safetensors',
        env: 'DSH_SVS_SEEDVR2_VAE',
        label: 'SeedVR2 VAE 权重（放 models/vae/，各档共用）',
      },
    }),
  },
}

/** 像素型（factor）的说明文案由 factor/资产槽拼出来，避免两份长散文手工同步。 */
function withCopy(spec) {
  if (spec.graph !== 'pixel') return spec
  const f = spec.factor
  return {
    ...spec,
    description:
      `${spec.displayName}。输入是**画布上已存在的视频**（不是提示词）：源片上传到 ComfyUI input，` +
      `像素空间超分 ×${f}，音轨原样带回（从不经过模型）。` +
      `交付尺寸 = 源尺寸 × ${f}，可用 target_width 收敛到指定宽度（按 32 对齐）。` +
      '逐帧独立 ⇒ 代价线性、长片可分块（runner 按像素-帧预算自动分块并拼接）。' +
      `模型走资产槽 $assets.${spec.assetKey}，可在设置页/env 覆盖（必须换成同倍率的权重）。`,
    upscaleNote:
      `交付尺寸 = 源视频尺寸 × ${f}（可被 target_width 收敛，按 32 对齐）。` +
      `\`sizing="factor"\`：倍率写在权重里，模型只会给源 × ${f}，` +
      'target_width 大于自然尺寸时**只是插值**（runner 会告警）。' +
      '`chunking="caller"`：逐帧独立 ⇒ runner 可按像素-帧预算自由分块（切点不影响结果）。' +
      '**比例永远跟源片**：源片是 H3 族的 1.75:1，所以 4032 宽对应 4032×2304（不是 16:9 的 3840×2160）——' +
      '把 4032×2304 叫「4K 级」只是宽度口径。' +
      '调用方传的 width/height 与画布比例都不适用——超分的尺寸跟着输入视频走。',
  }
}

let n = 0
for (const rawSpec of SPECS) {
  const spec = withCopy(rawSpec)
  const G = GRAPHS[spec.graph]
  const shown = spec.factor ? '×' + spec.factor : '（模型自带）'
  const m = {
    id: spec.id,
    displayName: spec.displayName,
    capability: 'video.upscale',
    tier: 'quality',
    group: GROUP,
    priority: spec.priority,
    note: spec.note,
    description: spec.description,
    upscale: {
      sizing: spec.sizing,
      chunking: spec.chunking,
      ...(spec.factor ? { factor: spec.factor } : {}),
      align: 32,
      note: spec.upscaleNote,
    },
    assets: G.assets(spec),
    params: G.params,
    requiresNodes: G.requiresNodes,
    output: { mediaType: 'video' },
    graph: G.build(spec),
  }
  if (spec.estSeconds) m.estSeconds = spec.estSeconds
  writeFileSync(resolve(OUT, spec.id + '.json'), JSON.stringify(m, null, 2) + '\n', 'utf8')
  n++
  console.log(`✓ ${spec.id}.json（${spec.graph} 图 · ${shown} · priority ${spec.priority}${spec.estSeconds ? ' · est ' + spec.estSeconds + 's' : ' · est 待实测'}）`)
}
console.log(`\n共 ${n} 份超分清单。注意：清单是产物，改结构请改本脚本后重跑。`)
