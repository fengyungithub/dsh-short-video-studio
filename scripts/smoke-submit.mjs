import { _internals } from '../lib/index.js'

const { buildFluxImageWorkflow, buildH3VideoWorkflow, comfySubmit, comfyOutputs } = _internals

async function submitOnly(label, graph) {
  try {
    const id = await comfySubmit(graph)
    console.log('✓', label, '→ prompt_id', id)
    return id
  } catch (e) {
    console.log('✗', label, '→', e.message)
    return null
  }
}

const flux = buildFluxImageWorkflow({
  prompt: 'a friendly orange fox astronaut, stylized 3d animation, warm lighting',
  width: 512, height: 512, seed: 1, steps: 4, guidance: 3.5,
  filenamePrefix: 'canvas/test/flux_smoke',
})

const h3 = buildH3VideoWorkflow({
  prompt: 'a small fox waves hello, warm 3d animation, locked camera',
  width: 512, height: 512, length: 5, seed: 1, steps: 4,
  filenamePrefix: 'canvas/test/h3_smoke',
})

const h3ff = buildH3VideoWorkflow({
  prompt: 'a small fox waves hello, warm 3d animation',
  width: 512, height: 512, length: 5, seed: 1, steps: 4,
  filenamePrefix: 'canvas/test/h3_smoke_ff',
  firstFrameComfyName: 'dummy.png',
})

await submitOnly('FLUX image workflow', flux)
await submitOnly('H3 video workflow', h3)
await submitOnly('H3 video workflow (first-frame)', h3ff)
