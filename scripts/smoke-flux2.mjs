import { _internals } from '../lib/index.js'
const { comfySubmit, comfyWait, comfyOutputs, comfyDownload } = _internals

const COMFY = 'http://localhost:8188'

async function test(label, graph) {
  try {
    const id = await comfySubmit(graph)
    console.log('✓ submitted', label, id)
    const entry = await comfyWait(id, null)
    const outs = comfyOutputs(entry)
    console.log('✓ completed', label, 'outputs=', outs.map((f) => f.filename))
  } catch (e) {
    console.log('✗ FAILED', label, '→', e.message.slice(0, 400))
  }
}

// 候选 1：generic CLIPTextEncode + FluxGuidance
function fluxGenericEncode({ prompt, width, height, seed, steps, guidance, withGuidance }) {
  const g = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'flux2_dev_fp8mixed.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'mistral_3_small_flux2_bf16.safetensors', type: 'flux2' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } },
    '4': { class_type: 'ModelSamplingFlux', inputs: { model: ['1', 0], max_shift: 1.15, base_shift: 0.5, width, height } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    '6': { class_type: 'EmptyFlux2LatentImage', inputs: { width, height, batch_size: 1 } },
    '7': { class_type: 'Flux2Scheduler', inputs: { steps, width, height } },
    '8': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '10': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '12': { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['3', 0] } },
    '13': { class_type: 'SaveImage', inputs: { images: ['12', 0], filename_prefix: 'canvas/test/flux_generic' } },
  }
  if (withGuidance) {
    g['5b'] = { class_type: 'FluxGuidance', inputs: { conditioning: ['5', 0], guidance } }
    g['9'] = { class_type: 'BasicGuider', inputs: { model: ['4', 0], conditioning: ['5b', 0] } }
  } else {
    g['9'] = { class_type: 'BasicGuider', inputs: { model: ['4', 0], conditioning: ['5', 0] } }
  }
  g['11'] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['8', 0], guider: ['9', 0], sampler: ['10', 0], sigmas: ['7', 0], latent_image: ['6', 0] } }
  return g
}

await test('flux2 generic-encode + FluxGuidance', fluxGenericEncode({ prompt: 'a friendly orange fox astronaut', width: 512, height: 512, seed: 2, steps: 8, guidance: 3.5, withGuidance: true }))
