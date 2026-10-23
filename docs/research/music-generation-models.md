# Open-source text-to-music / BGM models for a local ComfyUI pipeline

> Research target: `dsh-short-video-studio` (local ComfyUI at `localhost:8188`, single Ampere-class GPU, target 10–60 s instrumental background-music beds for short films).
> Date: 2026-10-23. Author: research sub-agent. **No code was modified**; this is the only file written.
> Scope: open-weight text-to-music / text-to-audio models usable locally, plus the three integration shapes for this repo.

---

## 0. TL;DR

1. **The premise “no music model installed” is no longer true on this box.** ComfyUI 0.42.1 already serves native music nodes for **ACE-Step 1.0 / 1.5, MiniMax Music 3, YuE2 and Stable Audio**, and the **MiniMax Music 3 weights are already on disk** (`minimax_music3_dit_fp16.safetensors`, `minimax_music3_text_encoder_pruned_int8_convrot.safetensors`, `minimax_music3_dav.safetensors`). What is missing is the **repo-side `audio.music` workflow manifest**, not a model. See §1.2–1.3.
2. **Best all-round for 10–60 s beds: ACE-Step 1.5 (MIT)** — 10 s–600 s, <4 GB VRAM claim for the 2B turbo path, BPM/key/time-signature metadata, native ComfyUI template, 13.9k-star repo.
3. **Best pure-instrumental 44.1 kHz beds: Stable Audio 3 (Small-Music / Medium)** — 120 s / 380 s, 44.1 kHz stereo, 2.4 GB / 6.5 GB peak VRAM, native ComfyUI template, commercial use under the Stability AI Community License below $1M revenue.
4. **Highest ceiling, already installed: MiniMax Music 3** — up to 300 s, 32 kHz stereo, commercial community license, but an 8B LLM + 13.4 GB of weights, official inference wants **two CUDA GPUs**; on 24 GB it fits with CPU offload/tiled decode but is the slowest option.
5. **Integration recommendation: shape (a), ComfyUI-native manifests behind the existing `audio.music` capability**, in this order: MiniMax Music 3 (already local) → Stable Audio 3 Small-Music → ACE-Step 1.5 turbo. Shape (b) sidecar is only worth it for DiffRhythm v1.2 / HeartMuLa; shape (c) is a delivery fallback, not a product feature.
6. **Explicitly NOT commercially usable as-is (free):** MusicGen incl. melody, MAGNeT, AudioLDM2, Tango / Tango 2, MusicLDM, TangoFlux. **YuE2 weights are CC BY-NC 4.0** (commercial licence required); **YuE v1 is Apache-2.0 and is commercially usable**. Details in §3.4 and §4.

---

## 1. How this was researched, and what the local box actually is

### 1.1 Evidence levels used below

| Tag | Meaning |
|---|---|
| `[OFFICIAL]` | Vendor repo / model card / licence text |
| `[COMFY]` | ComfyUI official template or node definition |
| `[LOCAL]` | Probed on this machine on 2026-10-23 (`/system_stats`, `/object_info`, `/models/*`) |
| `[REPO]` | This repository's code/docs (read-only) |
| `[VENDOR]` | Vendor benchmark/quality claim — not independently verified |
| `[INFERRED]` | My inference, explicitly marked |

No listening test was performed (no audio monitoring in this session), so **all quality statements are vendor/community claims**, not measured. Duration, VRAM, licence and ComfyUI-support facts are the parts I treat as hard.

### 1.2 Local probe (important discrepancy)

`[LOCAL]` `GET /system_stats` reports:

- ComfyUI `0.42.1`, PyTorch `2.15.0.dev`, Python 3.14
- GPU: **NVIDIA A800 80 GB**, not a 24 GB Ampere card. At probe time only **4.8 GB VRAM was free** (another workload was resident), so I deliberately did **not** run a music smoke test and risk OOM-ing a colleague's job.
- Therefore the 24 GB feasibility statements below are **vendor/card claims plus arithmetic**, not measurements on this box.

`[LOCAL]` Native music-related nodes already registered: `TextEncodeAceStepAudio`, `TextEncodeAceStepAudio1.5`, `EmptyAceStepLatentAudio`, `EmptyAceStep1.5LatentAudio`, `MiniMaxMusic3TextEncode`, `EmptyMiniMaxMusic3LatentAudio`, `YuE2GenerateMusic`, `EmptyYuE2LatentAudio`, `ConditioningStableAudio`, `VAEDecodeAudio`, `SaveAudioAdvanced`, `LoadAudio`, `AudioConcat`.

`[LOCAL]` Installed music weights (from `/models/diffusion_models`, `/models/text_encoders`, `/models/vae`):

| File | Folder | Size (per ComfyUI template) |
|---|---|---|
| `minimax_music3_dit_fp16.safetensors` | `diffusion_models` | 4.58 GB |
| `minimax_music3_text_encoder_pruned_int8_convrot.safetensors` | `text_encoders` | 8.57 GB |
| `minimax_music3_dav.safetensors` | `vae` | 0.21 GB |

This is the exact file set of the official ComfyUI MiniMax Music 3 template ([template note](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/audio_minimax_music_3.json)). **No ACE-Step / Stable Audio / YuE2 weights are installed.**

### 1.3 The repo-side gap

`[REPO]` `audio.music` is already in the capability vocabulary and manifest schema:

- [`lib/manifest.js:36`](../../lib/manifest.js#L36) — `'audio.music'` in `CAPABILITIES`
- [`schemas/workflow-manifest.schema.json:33`](../../schemas/workflow-manifest.schema.json#L33) — allowed capability
- [`docs/workflow-contract.md:57`](../workflow-contract.md#L57) — contract: `{ "mediaType": "audio", "inputs": ["prompt","duration"] }`

But there is no manifest JSON for it, which is why `comfy_list_workflows()` currently returns **no audio music capability at all**; the architecture doc says the same ([`docs/ARCHITECTURE.md:142`](../ARCHITECTURE.md#L142): “不产 BGM（注册表无 `audio.music` 工作流）”). The runner itself already knows how to collect audio outputs: [`lib/index.js:372`](../../lib/index.js#L372) iterates `['images','videos','gifs','audio']`.

---

## 2. Master comparison

Legend: **Comm.** = can I ship commercial short videos with the generated audio without paying for a licence? ✅ yes / ⚠️ conditional / ❌ no.
“Max” = documented maximum generation length; “SR” = sample rate stated by the project.

| Model (release) | Code licence | Weight licence | Comm. | Max / SR | Params / weights | Native ComfyUI? |
|---|---|---|---|---|---|---|
| **ACE-Step 1.5** (2026-01) | MIT | MIT | ✅ | 10–600 s; 48 kHz default | 2B DiT (4.46 GB turbo) + Qwen 0.6B/1.7B; XL 4B | ✅ template `audio_ace_step_1_5_*` |
| **Stable Audio 3** (2026) | MIT | Stability AI Community | ⚠️ <$1M rev. | 120 s (Small) / 380 s (Medium); 44.1 kHz stereo | 433M (Small) / 1.4B (Medium); peak 2.4 / 6.5 GB | ✅ template `audio_stable_audio_3_medium` |
| **MiniMax Music 3** (2026-08) | custom (weights licence) | MiniMax-Music3 Community | ⚠️ attribution, <$20M | 300 s; 32 kHz stereo | 8B global LLM + 0.6B local + 2.4B flow + 123M decoder | ✅ template `audio_minimax_music_3` |
| **ACE-Step v1** (2025-05) | Apache-2.0 | Apache-2.0 | ✅ | 240 s (4 min); 48 kHz ref pipeline | 3.5B; 8 GB VRAM claim | ✅ template `audio_ace_step_1_*` |
| **Stable Audio Open 1.0** (2024-06) | MIT (tools) | Stability AI Community | ⚠️ <$1M rev. | 47 s; 44.1 kHz stereo | 1.1B; 4.52 GB ckpt | ✅ template `audio_stable_audio_example` |
| **Stable Audio Open Small** (2025-05) | MIT (tools) | Stability AI Community | ⚠️ <$1M rev. | 11 s; 44.1 kHz | 341M; CPU-capable | ⚠️ likely same nodes, no dedicated template |
| **YuE2** (2026) | Apache-2.0 | CC BY-NC 4.0 + creator terms | ❌ (licence needed) | minutes-scale; 48 kHz stereo | 3B (3.69 GB int8) | ✅ template `audio_yue2_text2music` |
| **YuE v1** (2025-01) | Apache-2.0 | Apache-2.0 | ✅ | several minutes | 7B stage-1 + 1B stage-2 | ❌ community only |
| **HeartMuLa** (2026-01) | Apache-2.0 | Apache-2.0 | ✅ | 240 s default; 48 kHz stereo | 3B + 12.5 Hz codec | ⚠️ 435★ community node |
| **DiffRhythm v1.2** (2025-05) | Apache-2.0 | Apache-2.0 (DiT) | ✅ | 285 s; 44.1 kHz | 1.2B; 8 GB with `--chunked` | ❌ none found |
| **DiffRhythm 2** (2025-10) | Apache-2.0 | Apache-2.0 | ✅ | full-length (≈285 s class); 44.1 kHz | block-flow, ~1B class | ❌ none found |
| **MusicGen** (2023) | MIT | CC BY-NC 4.0 | ❌ | 30 s; 32 kHz mono | 300M / 1.5B / 3.3B + melody | ❌ 11★ HF node |
| **MAGNeT** (2024) | MIT | CC BY-NC 4.0 | ❌ | 10 s; 32 kHz | 300M / 1.5B | ❌ |
| **AudioLDM2** (2023) | CC BY-NC-SA 4.0 | CC BY-NC-SA 4.0 | ❌ | >10 s; 16 kHz (48 kHz variant) | ~700M | ❌ |
| **Tango 2** (2024) | CC BY-NC-ND 4.0 (repo) | CC BY-NC-SA 4.0 | ❌ | ≈10 s; 16 kHz | 866M | ❌ |
| **Mustango** (2024) | MIT | Apache-2.0 declared | ⚠️ derivative caveat | ≈10 s; 16 kHz | 866M class | ❌ |
| **MusicLDM** (2023) | CC BY-NC-SA 4.0 | CC BY-NC-SA 4.0 | ❌ | ≈10 s; 16 kHz | ~800M | ❌ |
| **Riffusion** (2022) | MIT | CreativeML OpenRAIL-M | ⚠️ use restrictions | short (~5 s) clips; spectrogram 44.1 kHz | SD-1.5 UNet | ❌ |
| **TangoFlux** (2025) | custom | Stability Community + academics-only | ❌ | 30 s; 44.1 kHz stereo | 515M | ❌ |
| **InspireMusic** (2024) | Apache-2.0 | Apache-2.0 | ✅ | short-form; 24 kHz | 1.5B | ❌ 6★ node |
| **Qwen2-Audio / Qwen3-Omni** | Apache-2.0 | Apache-2.0 | ✅ | n/a — **not a music generator** | 7B / omni | ❌ |

Sources for each table row are expanded in §3; the table is a navigation aid, not the citation source.

---

## 3. Per-model notes (licence · length/quality · VRAM · ComfyUI · control · maturity)

### 3.1 Native ComfyUI models (the practical shortlist)

#### ACE-Step 1.5 — **top pick for controllable BGM**

- **Licence.** Code and weights **MIT** ([repo licence section](https://github.com/ace-step/ACE-Step-1.5#-license--disclaimer)). No revenue threshold, no attribution requirement.
- **Length / quality.** 10 s to 10 min (600 s), 50+ languages, 1000+ instruments/styles ([features](https://github.com/ace-step/ACE-Step-1.5#-features)); the REST API defaults to `sample_rate: 48000` ([inference doc](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/INFERENCE.md)). Vendor claims quality “between Suno v4.5 and Suno v5” `[VENDOR]`; treat as marketing until A/B'd. Instrumental generation is explicitly supported ([v1 README](https://github.com/ace-step/ACE-Step#-features)); 1.5 adds vocal-to-BGM, stems, repaint, extend, cover.
- **VRAM / speed.** <4 GB VRAM claim for the 2B turbo path; <2 s per full song on A100, <10 s on 3090 `[VENDOR]` ([abstract](https://github.com/ace-step/ACE-Step-1.5#-abstract)). XL 4B needs ≥12 GB with offload, ≥20 GB recommended ([XL note](https://github.com/ace-step/ACE-Step-1.5#-news)).
- **ComfyUI.** Official templates: `audio_ace_step_1_5_split` (UNET + DualCLIP + `EmptyAceStep1.5LatentAudio`), `audio_ace_step_1_5_checkpoint`, `audio_ace_step_1_5_split_4b`, `audio_ace_step_1_5_split_llm`, plus v1 `audio_ace_step_1_t2a_instrumentals` / `_song` / `m2m_editing` ([templates dir](https://github.com/Comfy-Org/workflow_templates/tree/main/templates)). ComfyUI files: turbo 4.46 GB, Qwen encoders 1.11 + 3.45 GB, VAE 0.32 GB ([template note](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/audio_ace_step_1_5_split.json)).
- **Control.** The best of the open models for BGM: `TextEncodeAceStepAudio1.5` exposes **BPM (10–300), time signature (2/3/4/6), key/scale, language, duration**, plus lyrics/tags. ComfyUI node fields confirmed `[LOCAL]`. REST API available (`uv run acestep-api`, port 8001) ([API doc](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/API.md)).
- **Maturity / failures.** 13.9k★, pushed 2026-10-11. v1 card warns “longer than 5 minutes may lose structural coherence” ([v1 card](https://huggingface.co/ACE-Step/ACE-Step-v1-3.5B)); 1.5 mitigates with an LM planner but repetition at extreme lengths remains the usual diffusion failure mode. Instrumental beds are less exposed than vocal songs.

#### Stable Audio 3 — **best pure-instrumental 44.1 kHz beds**

- **Licence.** Code **MIT** ([LICENSE](https://github.com/Stability-AI/stable-audio-3/blob/main/LICENSE)); weights under the **Stability AI Community License**: free commercial use for organisations under **$1M annual revenue**, Enterprise licence above that; outputs are owned by the user `[OFFICIAL]` ([blog](https://stability.ai/news-updates/meet-stable-audio-3-the-model-family-built-for-artistic-experimentation-with-open-weight-models); the linked [licence text](https://huggingface.co/Comfy-Org/stable-audio-open-1.0_repackaged/blob/main/LICENSE.md) is the Open 1.0 copy of the same Community License family).
- **Length / quality.** Small-Music 433M, 120 s, CPU-capable; Medium 1.4B, **380 s**, CUDA; Large 2.7B is API-only. **44.1 kHz stereo**, new SAME autoencoder ([model table](https://github.com/Stability-AI/stable-audio-3#models)). Trained on fully licensed data `[VENDOR]`. No lyrics/vocals path — this is a music/SFX generator, which is exactly what a BGM bed needs.
- **VRAM / speed.** Peak allocated VRAM **2.40 GB** (Small, 120 s), **6.52 GB** (Medium, 380 s); 380 s Medium generates in **1.31 s on H200** unchunked ([performance table](https://github.com/Stability-AI/stable-audio-3#performance)). On a 24 GB Ampere card this is trivially resident; expect a few seconds per bed.
- **ComfyUI.** Official `audio_stable_audio_3_medium` template uses `stable_audio_3_medium.safetensors` (8.59 GB), `t5gemma_b_b_ul2` (1.11 GB), optional Qwen3.5 reprompt ([template note](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/audio_stable_audio_3_medium.json)). The older `audio_stable_audio_example` still demonstrates Stable Audio Open 1.0 ([template](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/audio_stable_audio_example.json)). Medium requires **FlashAttention 2** ([installation](https://github.com/Stability-AI/stable-audio-3#flash-attention)); prebuilt wheels exist, but this is the main install risk on an Ampere box. The Small-Music checkpoint is in the same Comfy-Org repo but has no dedicated official template in the list I inspected.
- **Control.** Text-to-audio, audio-to-audio editing, inpainting/continuation, variable length, LoRA fine-tuning ([features](https://github.com/Stability-AI/stable-audio-3#features)). No BPM/key metadata field like ACE-Step; control is prompt + duration + continuation.
- **Maturity / failures.** 821★, pushed 2026-10-11. New (2026), fewer community recipes than ACE-Step. Prompt-only length control can still produce abrupt endings; use continuation/inpainting for exact 10–60 s cuts.

#### MiniMax Music 3 — **highest ceiling, already installed**

- **Licence.** Custom **MiniMax-Music3 Community License**: commercial use allowed, must prominently display “MiniMax-Music3”, separate written authorisation above **$20M** annual revenue; acceptable-use policy applies ([licence text](https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE)).
- **Length / quality.** Complete songs up to **5 min**, **32 kHz 16-bit stereo**; 8B global LLM + 0.6B local LLM + 2.4B flow matching + 123M Flow-VAE decoder ([model card](https://github.com/MiniMax-AI/MiniMax-Music3)). Instrumental is requested through `[Instrumental]` section tags or an empty lyrics field (the ComfyUI template exposes a lyrics widget; verify behaviour on the build you ship) `[INFERRED]` ([ComfyUI template](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/audio_minimax_music_3.json)). Strongest long-range structure of the open models `[VENDOR]`.
- **VRAM / speed.** Full precision fits **under 24 GB**; ~22 GB with automatic CPU offload; layer-streaming the LM fits **8 GB** ([low-VRAM section](https://huggingface.co/MiniMaxAI/MiniMax-Music3#low-vram)). Official SGLang-Omni serving uses **two CUDA GPUs** (GPU0 LLM, GPU1 flow/decoder) ([how to use](https://github.com/MiniMax-AI/MiniMax-Music3#serve-with-sglang-omni)); ComfyUI runs it on one GPU with tiled VAE decode. The 8B autoregressive LLM makes it the slowest shortlist option; for 30–60 s it is likely tens of seconds, not seconds `[INFERRED]`.
- **ComfyUI.** Native template with `MiniMaxMusic3TextEncode`, `EmptyMiniMaxMusic3LatentAudio`, a KSampler (the converted API graph uses 30 steps, cfg 1.7, euler/simple — confirm against the template you ship) and tiled `VAEDecodeAudioTiled` ([template](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/audio_minimax_music_3.json)). **Weights already installed** `[LOCAL]`.
- **Control.** Structured caption (Global Metadata / Vocal Details / Arrangement), section tags `[Intro] [Verse] [Chorus] [Bridge] [Instrumental] [Outro]`, BPM/key in the caption text; “generative control rather than strict symbolic guarantees” per the card ([limitations](https://github.com/MiniMax-AI/MiniMax-Music3#limitations)).
- **Maturity / failures.** 983★, released 2026-08-14, very new. Known limits: non-streaming only, 5,000-token prompt, 9,000 acoustic frames; content can drift from requested BPM/key ([limitations](https://github.com/MiniMax-AI/MiniMax-Music3#limitations)). For BGM, its 32 kHz output is below the 44.1 kHz of Stable Audio 3 and the 48 kHz default of ACE-Step 1.5.

#### YuE2 — great songs, wrong licence for commercial BGM

- **Licence.** Code/skills/docs **Apache-2.0**; **weights CC BY-NC 4.0 with additional creator permission**, and companies must negotiate a commercial licence ([licence section](https://github.com/multimodal-art-projection/YuE#license)). ❌ for free commercial use.
- **Length / quality.** 48 kHz stereo, 3B, frontier song quality (vendor benchmark vs Suno v5/v6) `[VENDOR]`; supports instrumental via its agent skill ([news](https://github.com/multimodal-art-projection/YuE#news)).
- **VRAM.** Official requirement: NVIDIA GPU with BF16 and **24 GB VRAM** ([requirements](https://github.com/multimodal-art-projection/YuE#quick-start)).
- **ComfyUI.** Native template `audio_yue2_text2music` (3.69 GB int8 checkpoint) and `audio_yue2_music_cover` ([templates](https://github.com/Comfy-Org/workflow_templates/tree/main/templates)); also 220★ `ComfyUI-FL-YuE2` with a piano-roll editor ([repo](https://github.com/filliptm/ComfyUI-FL-YuE2)).
- **Control.** ABC symbolic planning (melody/chords), style + lyrics, section tags; instrumental mode moves vocal melody into the instrumental part ([README](https://github.com/multimodal-art-projection/YuE#agent-skill)).
- **Maturity / failures.** 12.6k★, active; v2 is new (2026). Lyrics-first design; BGM use is a workaround, and vocal leakage is an explicitly called-out listening risk ([README](https://github.com/multimodal-art-projection/YuE#agent-skill)).

#### ACE-Step v1 — still the safest fallback

- **Licence.** **Apache-2.0**, weights too ([repo](https://github.com/ace-step/ACE-Step#-license--disclaimer), [HF card](https://huggingface.co/ACE-Step/ACE-Step-v1-3.5B)).
- **Length / SR.** Up to **4 minutes**; 8 GB max VRAM after the 2025-05 optimisation; RTF 27.27× on A100, 12.76× on 3090 at 27 steps ([hardware table](https://github.com/ace-step/ACE-Step#-hardware-performance)). The reference pipeline sets `sample_rate=48000` at decode time ([pipeline code](https://github.com/ace-step/ACE-Step/blob/main/acestep/pipeline_ace_step.py)).
- **ComfyUI.** Native v1 templates and a community node `ComfyUI_ACE-Step` (253★, last push 2025-05-28) ([repo](https://github.com/billwuhao/ComfyUI_ACE-Step)).
- **Control.** Tags + lyrics + duration; instrumental styles supported; repaint/extend/retake in the reference app. No BPM/key fields in the ComfyUI v1 node.
- **Failures.** Long generations (>5 min) lose coherence ([HF card](https://huggingface.co/ACE-Step/ACE-Step-v1-3.5B)); superseded by 1.5 for quality/VRAM.

#### Stable Audio Open 1.0 / Small — legacy, still useful as a light baseline

- **Licence.** Weights under the **Stability AI Community License** (commercial <$1M revenue); the `stable-audio-tools` code is MIT ([LICENSE](https://github.com/Stability-AI/stable-audio-tools/blob/main/LICENSE), [Community License text](https://huggingface.co/Comfy-Org/stable-audio-open-1.0_repackaged/blob/main/LICENSE.md)).
- **Length / quality.** Open 1.0: **47 s**, **44.1 kHz stereo**, 1.1B params, trained on ~500k CC-0/CC-BY/CC-Sampling+ recordings ([research note](https://stability.ai/news-updates/stable-audio-open-research-paper)). Small: **341M**, **11 s**, runs on Arm CPU, <8 s on a smartphone ([announcement](https://stability.ai/news-updates/stability-ai-and-arm-release-stable-audio-open-small-enabling-real-world-deployment-for-on-device-audio-control)). Quality is dated (2024) and clearly below Stable Audio 3.
- **VRAM.** Open 1.0 checkpoint 4.52 GB in ComfyUI ([template note](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/audio_stable_audio_example.json)); Small is CPU/edge-oriented.
- **ComfyUI.** Native `audio_stable_audio_example` template; `ConditioningStableAudio` exposes `seconds_start` / `seconds_total`. Community sampler node `ComfyUI-StableAudioSampler` (274★, 2025-01-07) predates native support.
- **Control / failures.** Text only (plus audio-to-audio in tools); no BPM/key; 47 s cap; 2024-era mix quality, prone to mushy low end and abrupt endings `[INFERRED from model class]`.

### 3.2 Commercially usable, but no native ComfyUI path

#### YuE v1 — Apache-2.0 long songs, very slow

- **Licence.** Code **and weights Apache-2.0** since 2025-01-30; outputs may be monetised, attribution (“YuE by HKUST/M-A-P”) encouraged ([README](https://github.com/multimodal-art-projection/YuE/tree/YuE-v1#license-agreement--disclaimer)).
- **Length / quality.** Lyrics-to-full-song, several minutes, with vocals + accompaniment; 7B stage-1 + 1B stage-2. On an H800, 30 s takes 150 s; on a 4090, 30 s takes ~360 s ([GPU memory](https://github.com/multimodal-art-projection/YuE/tree/YuE-v1#gpu-memory)).
- **VRAM.** 24 GB cards are limited to **≤2 concurrent sessions**; full songs with many sessions want 80 GB or tensor-parallel 4090s ([README](https://github.com/multimodal-art-projection/YuE/tree/YuE-v1#gpu-memory)).
- **ComfyUI.** No native v1 template (the native templates are for YuE2). Community: `ComfyUI_YuE` 196★, pushed 2026-09-16 ([repo](https://github.com/smthemex/ComfyUI_YuE)).
- **Control.** Genre/style tags + lyrics + in-context learning; YuE-UI adds continuation and 8 GB quantised operation ([README](https://github.com/multimodal-art-projection/YuE/tree/YuE-v1#news)). No BPM/key fields.
- **Maturity / failures.** 12.6k★ but v1 is superseded; very slow (minutes per 30 s), OOM-prone on long songs, repetition/pronunciation artefacts. Not viable for iterative BGM work.

#### HeartMuLa — Apache-2.0 48 kHz songs, 3B

- **Licence.** Repo **and all related model weights Apache-2.0** since 2026-01-20 ([news](https://github.com/HeartMuLa/heartlib#news), [licence](https://github.com/HeartMuLa/heartlib#%EF%B8%8F-license)).
- **Length / quality.** 3B music LM + 12.5 Hz HeartCodec; **48 kHz stereo** reconstruction; default `--max_audio_length_ms 240000` (240 s); RTF ≈ 1.0 currently ([README](https://github.com/HeartMuLa/heartlib#-todos)).
- **VRAM.** Single GPU supported with `--lazy_load true`; multi-GPU split (`--mula_device`, `--codec_device`) recommended ([troubleshooting](https://github.com/HeartMuLa/heartlib#-local-deployment)).
- **ComfyUI.** No native node; community `HeartMuLa_ComfyUI` 435★, pushed 2026-03-23 ([repo](https://github.com/benjiyaya/HeartMuLa_ComfyUI)).
- **Control.** Lyrics + tags, multilingual, style/tag control; 7B not released. Instrumental control is not first-class — it is a song model.
- **Maturity / failures.** 3.8k★, active, but RTF ≈ 1.0 (a 60 s bed takes ~60 s) and no native integration; good sidecar candidate.

#### DiffRhythm v1.2 / DiffRhythm 2 — Apache-2.0 full songs

- **Licence.** v1.2: code and DiT weights **Apache-2.0** ([README](https://github.com/ASLP-lab/DiffRhythm#license--disclaimer)). DiffRhythm 2: code and weights **Apache-2.0** ([README](https://github.com/ASLP-lab/DiffRhythm2#-license--disclaimer)).
- **Length / quality.** v1.2 generates **285 s** full-length songs, has an explicit **instrumental mode**, and (per the project) fixed v1's repetition/omission issues ([news](https://github.com/ASLP-lab/DiffRhythm#news-and-updates)). Output is written at **44.1 kHz** ([inference code](https://github.com/ASLP-lab/DiffRhythm/blob/main/infer/infer.py)). DiffRhythm 2 improves fidelity/lyric alignment but **instrumental generation is still TODO** ([README](https://github.com/ASLP-lab/DiffRhythm2#-todos)).
- **VRAM.** **8 GB** with `--chunked` ([note](https://github.com/ASLP-lab/DiffRhythm#local-deployment)).
- **ComfyUI.** No official template and no maintained community node found (GitHub search, 2026-10-23). Sidecar/CLI only.
- **Control / failures.** Lyrics + text style prompt; instrumental flag; song editing/continuation in v1.2. It is a full-song model first; audition instrumental output for vocal leakage before delivery. Best licence/VRAM combo if you are willing to run a sidecar.

#### Riffusion — old but commercially permissive

- **Licence.** Code **MIT** ([repo](https://github.com/riffusion/riffusion)); weights **CreativeML OpenRAIL-M**, which explicitly allows commercial use and redistribution with use restrictions ([model card](https://huggingface.co/riffusion/riffusion-model-v1)).
- **Length / quality.** Stable-Diffusion-on-spectrogram, short clips (~5 s class `[INFERRED]` from the 512×512 spectrogram window), 44.1 kHz after Griffin-Lim/vocoder conversion; 2022 quality, spectrogram artifacts, no structural control.
- **VRAM / ComfyUI.** Small SD-1.5 UNet, <8 GB; no maintained ComfyUI node — sidecar only.
- **Verdict.** Commercially usable but musically obsolete; not a BGM solution in 2026.

#### Mustango — controllability research, unclear derivative licence

- **Licence.** Code **MIT** ([LICENSE](https://github.com/AMAAI-Lab/mustango/blob/main/LICENSE)); the HF card declares **Apache-2.0** ([model card](https://huggingface.co/declare-lab/mustango)). However it is built on Tango, whose weights are CC BY-NC-ND — the Apache declaration is the author's, not a clean-room grant `[INFERRED]`. Treat as **not safely commercial** without counsel.
- **Length / quality.** ≈10 s, 16 kHz; chord/tempo/beat control from text (MusicBench). Research-grade audio quality.
- **ComfyUI.** None. Not recommended.

#### InspireMusic — Apache-2.0, low adoption

- **Licence.** Apache-2.0 ([FunAudioLLM/InspireMusic](https://huggingface.co/FunAudioLLM/InspireMusic-Base)).
- **Length / quality.** 1.5B, 24 kHz, short-form music/song generation ([ModelScope card](https://www.modelscope.cn/models/iic/InspireMusic-1.5B-24kHz)); 2024-era.
- **ComfyUI.** Only a 6★ `ComfyUI-InspireMusic` node ([repo](https://github.com/fq393/ComfyUI-InspireMusic)). Sidecar only; not competitive.


### 3.3 Legacy research models — covered for completeness, not recommended

These are the models most “text-to-music” blog posts still mention. None has native ComfyUI support, most are non-commercial, and all are out-classed for 10–60 s BGM by §3.1. Included because the brief asked for them.

#### MusicGen (small / medium / large / melody)

- **Licence.** Code MIT; **weights CC BY-NC 4.0** — commercial use prohibited ([AudioCraft licence](https://github.com/facebookresearch/audiocraft#license)).
- **Length / quality.** 300M / 1.5B / 3.3B; **32 kHz mono**, trained on a 30 s window; melody variant is 1.5B and accepts an audio melody ([model card](https://huggingface.co/facebook/musicgen-large), [paper](https://arxiv.org/abs/2306.05284)). Musicality was strong for 2023 but structure collapses past ~30 s.
- **VRAM.** Large 3.3B is the heavy one (~12–16 GB class); medium ~8 GB; small ~4 GB `[INFERRED]`.
- **ComfyUI.** No native nodes. Community: `ComfyUI-MusicGen-HF` 11★, last push 2025-11-18 ([repo](https://github.com/ebrinz/ComfyUI-MusicGen-HF)); `comfyui-sound-lab` 144★, last push 2024-07-04 ([repo](https://github.com/MixLabPro/comfyui-sound-lab)). Sidecar is the realistic path.
- **Control.** Text only (+ melody audio); no BPM/key/time-signature, no continuation, no sections.
- **Maturity / failures.** AudioCraft itself is mature (23.7k★), but MusicGen is legacy: 30 s cap, mono, repetition and timbre drift on repeated generations.

#### MAGNeT

- **Licence.** Same AudioCraft **CC BY-NC 4.0** weights ([AudioCraft licence](https://github.com/facebookresearch/audiocraft#license)).
- **Length / quality.** `magnet-small-10secs` (300M) and `magnet-medium-10secs` (1.5B), **10 s**, 32 kHz ([MAGNeT docs](https://github.com/facebookresearch/audiocraft/blob/main/docs/MAGNET.md)). Non-autoregressive, fast; less musical than MusicGen at the same size `[INFERRED]`.
- **VRAM / ComfyUI.** ≤1.5B, 24 GB is ample; no native or maintained community node — sidecar only.
- **Control / failures.** Text only, fixed 10 s, no structure; not a BGM candidate.

#### AudioLDM2

- **Licence.** Repository **and** weights **CC BY-NC-SA 4.0** ([LICENSE](https://github.com/haoheliu/AudioLDM2/blob/main/LICENSE), [large card](https://huggingface.co/cvssp/audioldm2-large)).
- **Length / quality.** Default 10 s, longer audio supported (>10 s), **16 kHz** by default with a separate 48 kHz checkpoint; ~700M; audio/music/SFX mixed training, not music-first ([README](https://github.com/haoheliu/AudioLDM2)).
- **VRAM / ComfyUI.** Fits comfortably in 24 GB; no native node and no maintained ComfyUI repo found.
- **Control / failures.** Text only; 16 kHz output sounds muffled for music; weak musical structure.

#### Tango / Tango 2

- **Licence.** Tango repo **CC BY-NC-ND 4.0** (no derivatives) ([LICENSE.md](https://github.com/declare-lab/tango/blob/master/LICENSE.md)); Tango 2 weights **CC BY-NC-SA 4.0** ([card](https://huggingface.co/declare-lab/tango2)).
- **Length / quality.** 866M; **16 kHz**; short (~10 s) diffusion clips; Tango 2 adds DPO preference alignment for better prompt adherence ([Tango 2 paper](https://arxiv.org/abs/2404.09956)).
- **VRAM / ComfyUI.** Fits 24 GB easily; no native node, no maintained community node.
- **Control / failures.** Text only; short, 16 kHz, no continuation; NC-ND makes even derivative work risky.

#### MusicLDM

- **Licence.** **CC BY-NC-SA 4.0** for repo and weights ([LICENSE](https://github.com/RetroCirce/MusicLDM/blob/main/LICENSE)).
- **Length / quality.** **16 kHz**, ~10 s, beat-synchronous mixup training; 2023 quality ([README](https://github.com/RetroCirce/MusicLDM)).
- **VRAM / ComfyUI.** Small enough for any 24 GB card; no native/community ComfyUI path.
- **Control / failures.** Text only; 16 kHz, no structure, no BPM/key.

#### TangoFlux

- **Licence.** **Research-only** — Stability AI Community License plus WavCaps academic-only data terms; commercial use requires a separate licence ([LICENSE section](https://github.com/declare-lab/TangoFlux#license)).
- **Length / quality.** 515M; **44.1 kHz stereo, up to 30 s**, ~3 s on an A40 ([README](https://github.com/declare-lab/TangoFlux)). One of the fastest 44.1 kHz generators.
- **VRAM / ComfyUI.** Comfortable in 24 GB; no native node; sidecar only.
- **Control / failures.** Text + explicit duration; no BPM/key/sections; 30 s cap; licence blocks commercial use.

### 3.4 NOT commercially usable (free) — flag list

| Model | Licence that blocks commercial use | Source |
|---|---|---|
| **MusicGen** (all sizes, melody) | Weights **CC BY-NC 4.0** (code MIT) | [AudioCraft licence](https://github.com/facebookresearch/audiocraft#license) |
| **MAGNeT** | Same AudioCraft weights licence **CC BY-NC 4.0** | [AudioCraft licence](https://github.com/facebookresearch/audiocraft#license) |
| **AudioLDM2** | Repo and weights **CC BY-NC-SA 4.0** | [LICENSE](https://github.com/haoheliu/AudioLDM2/blob/main/LICENSE), [model card](https://huggingface.co/cvssp/audioldm2-large) |
| **Tango** | **CC BY-NC-ND 4.0** (no derivatives) | [LICENSE.md](https://github.com/declare-lab/tango/blob/master/LICENSE.md) |
| **Tango 2** | Weights **CC BY-NC-SA 4.0** | [model card](https://huggingface.co/declare-lab/tango2) |
| **MusicLDM** | **CC BY-NC-SA 4.0** | [LICENSE](https://github.com/RetroCirce/MusicLDM/blob/main/LICENSE) |
| **TangoFlux** | Research-only; Stability Community + WavCaps academic-only; commercial requires separate licence | [LICENSE section](https://github.com/declare-lab/TangoFlux#license) |
| **YuE2** | Weights **CC BY-NC 4.0**; companies need a commercial licence | [licence section](https://github.com/multimodal-art-projection/YuE#license) |
| **Mustango** | Declared Apache-2.0, but Tango-derived; legal risk | [card](https://huggingface.co/declare-lab/mustango) + [Tango licence](https://github.com/declare-lab/tango/blob/master/LICENSE.md) |

**Not a local option at all:** Stable Audio 3 Large (2.7B) is API-only ([model table](https://github.com/Stability-AI/stable-audio-3#models)); Stable Audio 2.x is likewise API/closed.

**Commercially usable:** ACE-Step v1 (Apache-2.0), ACE-Step 1.5 (MIT), Stable Audio 3 Small/Medium (Community, <$1M), Stable Audio Open 1.0/Small (Community, <$1M), MiniMax Music 3 (Community, attribution + <$20M), YuE v1 (Apache-2.0), HeartMuLa (Apache-2.0), DiffRhythm v1.2/2 (Apache-2.0), Riffusion (OpenRAIL-M), InspireMusic (Apache-2.0).

### 3.5 Not music generators — avoid category error

**Qwen2-Audio** is an audio *understanding* model (ASR, audio captioning, audio QA), not a music synthesizer ([repo](https://github.com/QwenLM/Qwen2-Audio)). **Qwen3-Omni** generates speech/audio in an omni setting ([repo](https://github.com/QwenLM/Qwen3-Omni)), not controllable 10–60 s BGM beds. There is no “Qwen-Music” open text-to-music model as of 2026-10-23 that I could verify.

---

### 3.6 Latency expectations on a 24 GB Ampere card

Published numbers use different hardware; the 24 GB column is my extrapolation unless the row says otherwise, and is marked `[INFERRED]`. “60 s bed” means one 60 s generation, not a full song.

| Model | Published latency | 60 s BGM estimate on 24 GB Ampere | Basis |
|---|---|---|---|
| ACE-Step 1.5 (2B turbo) | <2 s/song on A100; <10 s on 3090 | ~3–8 s | `[VENDOR]` ([abstract](https://github.com/ace-step/ACE-Step-1.5#-abstract)) |
| ACE-Step v1 (3.5B) | RTF 27.27× A100 / 12.76× 3090 at 27 steps | ~5–10 s | `[VENDOR]` ([table](https://github.com/ace-step/ACE-Step#-hardware-performance)) |
| Stable Audio 3 Medium | 380 s in 1.31 s on H200 (unchunked) | ~3–10 s | `[VENDOR]` ([table](https://github.com/Stability-AI/stable-audio-3#performance)) + scaling `[INFERRED]` |
| Stable Audio 3 Small | 120 s in 0.45 s on H200 | <5 s | same |
| MiniMax Music 3 | none published; 8B AR + flow, 30 steps | ~60–180 s `[INFERRED]` | model size + AR token rate |
| HeartMuLa 3B | RTF ≈ 1.0 | ~60 s | `[OFFICIAL]` ([TODO note](https://github.com/HeartMuLa/heartlib#-todos)) |
| YuE v1 | 30 s in 360 s on 4090 | ~12 min | `[OFFICIAL]` ([GPU memory](https://github.com/multimodal-art-projection/YuE/tree/YuE-v1#gpu-memory)) |
| YuE2 3B | none published; 24 GB required | minutes `[INFERRED]` | LLM-style generation |
| DiffRhythm v1.2 | none published; 285 s song on 8 GB | ~30–90 s `[INFERRED]` | 8 GB chunked decode |
| TangoFlux | 30 s in ~3 s on A40 | n/a (30 s cap) | `[OFFICIAL]` ([README](https://github.com/declare-lab/TangoFlux)) |

Practical reading: **ACE-Step 1.5 and Stable Audio 3 are the only options that feel interactive** (single-digit seconds per bed). MiniMax is a “hero cue” renderer. YuE v1 is not viable for iteration, only for final long songs.

## 4. Cross-cutting licence reading

1. **Code licence ≠ weight licence.** MusicGen/AudioCraft is the canonical trap: MIT code, CC BY-NC weights ([AudioCraft](https://github.com/facebookresearch/audiocraft#license)). YuE2 is the 2026 version of the same trap: Apache code, CC BY-NC weights ([YuE](https://github.com/multimodal-art-projection/YuE#license)).
2. **“Community License” is commercial-with-a-ceiling, not non-commercial.** Stability: free commercial use below **$1M/year**, then Enterprise ([licence §III](https://huggingface.co/Comfy-Org/stable-audio-open-1.0_repackaged/blob/main/LICENSE.md)). MiniMax: commercial with **attribution**, separate authorisation above **$20M/year** ([licence](https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE)).
3. **Model licence ≠ training-data clearance.** Stable Audio 3 explicitly claims fully licensed training data ([blog](https://stability.ai/news-updates/meet-stable-audio-3-the-model-family-built-for-artistic-experimentation-with-open-weight-models)); Stable Audio Open used CC-0/CC-BY/CC-Sampling+ only ([research note](https://stability.ai/news-updates/stable-audio-open-research-paper)). Most others do not make that claim; for client work, prefer the vendors that do.
4. **Output ownership vs. model licence.** Even where outputs are yours, the model licence can still impose attribution (MiniMax) or revenue thresholds (Stability). Put the chosen model + licence URL in the project brief.

---

## 5. Integration shapes for this repo

### (a) ComfyUI custom node / native audio latent nodes

**What it means here:** add one or more `audio.music` workflow manifests (JSON) and call them through the existing `comfy_render` path; no second server.

**Evidence it mostly fits:**

- `audio.music` is already a legal capability ([`manifest.js:36`](../../lib/manifest.js#L36), [schema](../../schemas/workflow-manifest.schema.json#L33)).
- The runner already collects ComfyUI `audio` outputs ([`lib/index.js:372`](../../lib/index.js#L372)) and persists them as canvas media.
- `comfy_render` already accepts `capability: "audio.music"` ([`lib/index.js:3899`](../../lib/index.js#L3899)).
- Concrete graphs exist: MiniMax Music 3, Stable Audio 3, ACE-Step 1.5, YuE2 ([templates](https://github.com/Comfy-Org/workflow_templates/tree/main/templates)).

**What still needs code (small, but not zero):**

1. **`duration` argument.** The contract says `inputs: ["prompt","duration"]` ([`docs/workflow-contract.md:57`](../workflow-contract.md#L57)), but `comfy_render`'s schema has no `duration` (only `length` in video frames). Add `duration` (seconds) to the tool schema and inject it into the manifest's duration field (ACE-Step `duration`, `Empty*LatentAudio.seconds`, MiniMax `max_duration`).
2. **Resolution guard.** `runRender` always calls `computeManifestSize` and records `resolution`; an audio manifest needs either a dummy `resolution` block or a `mediaType === 'audio'` branch to skip it ([`lib/index.js:2416`](../../lib/index.js#L2416)).
3. **Prompt bank.** `runRender` only auto-discovers prompt banks for `video.*` titles ([`lib/index.js:2444`](../../lib/index.js#L2444)); explicit `prompt_node` works, auto-reuse does not. Decide whether music prompts need the tiered bank (probably a single style prompt + section plan is enough).
4. **Tool alias and canvas UX.** A `comfy_generate_music(prompt, duration, tier, ...)` alias would match the existing image/video aliases; the generic `comfy_render` is usable but awkward for skills. The canvas already renders `audio` nodes from uploads ([`lib/index.js:823`](../../lib/index.js#L823)), so display is solved.
5. **Title fallback bug.** Non-video/non-image media falls back to “图片” in `runRender`'s title default ([`lib/index.js:2625`](../../lib/index.js#L2625)) — cosmetic, but should say “音乐”.

**Cost:** ~1–2 engineering days + QA for two models; no new process to operate. **Best fit for this repo**, because the whole product is already “registry + ComfyUI”.

### (b) Sidecar music server called by a plugin tool

**What it means:** run ACE-Step 1.5's REST API (`uv run acestep-api`, port 8001), MiniMax's SGLang-Omni (`sgl-omni serve`, port 8000), HeartMuLa, or DiffRhythm as a separate process; the plugin calls HTTP.

**Evidence against the current design:**

- The manifest contract only supports `runner: "comfyui"`; any other runner is rejected at validation time ([`lib/manifest.js:96`](../../lib/manifest.js#L96)).
- There is no generic HTTP-runner abstraction; `comfyFetch`/`comfySubmit` are hard-wired to ComfyUI ([`lib/index.js:330`](../../lib/index.js#L330) and surrounding functions).
- `concat.js` is the only non-ComfyUI execution path, and it is a special case, not a registry runner ([`lib/concat.js`](../../lib/concat.js)).

**So (b) requires:** a new runner type (`runner: "http"` or `"sidecar"`) + lifecycle/health checks + request/response mapping + media download + the same audio-node persistence. For ACE-Step 1.5 the HTTP surface already exists ([API doc](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/API.md)); for DiffRhythm/HeartMuLa you would write a thin FastAPI wrapper.

**When it is worth it:** if you need **DiffRhythm v1.2** (285 s, 8 GB, Apache-2.0) or **HeartMuLa** (48 kHz, Apache-2.0) and refuse to wait for native nodes; or if you want to run music on a **different GPU/host** than ComfyUI. Cost: ~3–5 days + ops (port, model cache, restart policy, logs). It also duplicates the canvas/media persistence logic unless carefully factored.

### (c) Post-processing / stock library fallback (non-generative)

**What exists:** ffmpeg concat with stream-copy and re-encode fallback ([`lib/concat.js:92`](../../lib/concat.js#L92)); the docs reserve `compose.concat` with a `bgm` input ([`docs/workflow-contract.md:58`](../workflow-contract.md#L58)), but **no BGM mixing/ducking is implemented**. There is no loudness normalisation or loop-crossfade helper.

**What a fallback would need:** a licensed stock-music library (Artlist/Epidemic/YouTube Audio Library etc. — per-track licence), an ffmpeg filter chain (`loudnorm`, `sidechaincompress` ducking under dialogue, `acrossfade` for loops), and a cue-sheet text node on the canvas. Cost: ~1 day of ffmpeg + a licensing spreadsheet. It is deterministic, instant, and zero-VRAM, but it is **not generative** and does not satisfy “text/style → bespoke bed”.

**Verdict:** keep (c) as a delivery fallback for deadlines and as an A/B baseline; do not present it as the product capability.

---

## 6. Scoring and recommendation

Weights: Licence 25%, Music quality 20%, Duration fit 20%, VRAM fit 15%, Integration effort 15%, Maturity 5%. Scores 1–5, author judgement; quality is **not** listening-tested.

| Model | Licence | Quality | Duration | VRAM | Integration | Maturity | **Weighted** |
|---|---:|---:|---:|---:|---:|---:|---:|
| **ACE-Step 1.5** | 5 | 4 | 5 | 5 | 5 | 5 | **4.80** |
| **Stable Audio 3 Medium** | 4 | 4.5 | 5 | 5 | 5 | 4 | **4.60** |
| **MiniMax Music 3** | 4 | 5 | 5 | 3 | 5 | 4 | **4.40** |
| ACE-Step v1 | 5 | 4 | 4 | 4 | 5 | 4 | 4.40 |
| DiffRhythm v1.2 | 5 | 3.5 | 5 | 5 | 2 | 3 | 4.15 |
| DiffRhythm 2 | 5 | 3.5 | 5 | 5 | 1 | 2 | 3.95 |
| HeartMuLa | 5 | 4 | 4 | 3 | 3 | 3 | 3.90 |
| YuE v1 | 5 | 4 | 5 | 2 | 2 | 3 | 3.80 |
| Stable Audio Open 1.0 | 4 | 3.5 | 2 | 4 | 5 | 5 | 3.70 |
| YuE2 | 1 | 5 | 4 | 3 | 3 | 4 | 3.15 |
| InspireMusic | 5 | 2.5 | 3 | 4 | 1 | 1 | 3.15 |
| Riffusion | 4 | 2 | 1 | 5 | 1 | 2 | 2.60 |
| Mustango | 3 | 3 | 1 | 5 | 1 | 2 | 2.55 |
| TangoFlux | 1 | 3.5 | 2 | 4 | 2 | 3 | 2.40 |
| MusicGen large | 1 | 3.5 | 2 | 3 | 2 | 4 | 2.30 |
| AudioLDM2 | 1 | 2.5 | 2 | 5 | 1 | 3 | 2.20 |
| Tango 2 | 1 | 3 | 1 | 5 | 1 | 3 | 2.10 |
| MAGNeT | 1 | 3 | 1 | 4 | 1 | 3 | 1.95 |
| MusicLDM | 1 | 2 | 1 | 5 | 1 | 2 | 1.85 |

### Top 3 (recommended order)

1. **ACE-Step 1.5 (MIT).** The only candidate that is simultaneously licence-clean, fast, low-VRAM, long-enough, natively supported and **controllable with BPM/key/time-signature** — the exact controls a BGM bed needs. Start with the 2B turbo split template; add XL only for hero cues.
2. **Stable Audio 3 Small-Music / Medium.** The best *pure instrumental* generator: 44.1 kHz stereo, 120 s (Small) or 380 s (Medium), 2.4–6.5 GB peak VRAM, native ComfyUI, fully licensed training data. Choose it when the cue must sound like a finished music bed rather than a song with vocals. Community licence is a paperwork condition, not a blocker at indie scale.
3. **MiniMax Music 3.** Highest musical ceiling and already installed; pick it for 60–300 s hero pieces where the 8B planner's structure matters. Accept 32 kHz, ~13.4 GB weights, ~22 GB with offload, and the two-GPU official serving path; run it on one GPU with tiled decode only if latency is acceptable.

**Runner-ups:** DiffRhythm v1.2 and HeartMuLa are the best Apache-2.0 sidecar options; YuE2 is technically excellent but its NC weights disqualify it for commercial short-video work.

### Recommended rollout

| Phase | Work | Effort |
|---|---|---|
| 0 | Smoke-test the **already installed** MiniMax Music 3 with a 30 s instrumental prompt on a free GPU; confirm the template graph and output SR. | 0.5 h |
| 1 | Add `audio.music` manifests + `duration` arg + audio-size guard; ship **MiniMax Music 3** (quality tier) and **Stable Audio 3 Small** (fast/balanced tier). | 1–2 d |
| 2 | Add **ACE-Step 1.5 turbo** manifest with BPM/key/duration injection; expose a `comfy_generate_music` alias; add canvas cue-sheet text node. | 1 d |
| 3 | Optional: sidecar runner for DiffRhythm v1.2 / HeartMuLa if native quality is insufficient. | 3–5 d |
| 4 | Delivery polish: `loudnorm -16 LUFS`, dialogue ducking, loop crossfade, licence metadata on the canvas node. | 1 d |

### Acceptance tests for whichever model ships

1. 60 s instrumental prompt produces **no vocals** (listen + optional vocal detector).
2. Output is stereo, ≥32 kHz, integrated loudness ≈ −16 LUFS, true peak ≤ −1 dBTP.
3. Two seeds differ audibly; same seed is reproducible.
4. 10 s / 30 s / 60 s requests return the requested duration ±1 s (or clamp with an explicit warning).
5. No clipping, no long silent tail, no obvious loop seam when the bed is looped.
6. Canvas node records `model`, `licence`, `duration`, `sampleRate`, `seed` — so delivery can prove provenance.

---

## 7. Known failure modes to watch

| Symptom | Likely cause | Mitigation |
|---|---|---|
| Muddy low end / no headroom | 16 kHz or 32 kHz models, over-compressed training data | prefer 44.1 kHz (Stable Audio 3 / ACE-Step), high-pass at 30 Hz, `loudnorm` |
| Abrupt ending at 30–60 s | model's max window or no structural plan | request 1.2× target then trim; use continuation/inpainting (Stable Audio 3, ACE-Step extend) |
| Repetition after 60 s | diffusion/AR context limit | section tags (MiniMax/ACE-Step), repaint/extend, or stitch 30 s cues |
| Vocals appear in a “BGM” cue | song-first model (YuE2, HeartMuLa, MiniMax) | explicit instrumental tags/empty lyrics; verify by listening; prefer Stable Audio 3 for pure beds |
| Clipping / inter-cue loudness jumps | no mastering stage | `loudnorm` + true-peak limiter; normalise every cue to the same target |
| Slow generation on 24 GB | 8B LLM (MiniMax) or 7B+1B (YuE v1) | use ACE-Step 1.5 2B / Stable Audio 3 for iteration; reserve heavy models for hero cues |
| ComfyUI OOM at long duration | VAE decode of long audio | tiled decode (`VAEDecodeAudioTiled`), chunked decode (DiffRhythm `--chunked`), or shorter renders + concat |

---

## 8. What I could not verify / open questions

1. **No listening test.** Quality scores are vendor claims + model class. Before committing, generate the same 3 prompts on ACE-Step 1.5, Stable Audio 3 and MiniMax Music 3 and blind-listen.
2. **Hugging Face and `stability.ai` direct connections timed out from this sandbox.** I used official GitHub repos, the Stability AI Squarespace mirror (same content), and `hf-mirror.com` metadata where possible; some model-card details (e.g. exact inference defaults) should be re-checked on the HF card from a networked machine.
3. **Local GPU is A800 80 GB**, not 24 GB. The 24 GB statements are vendor claims/arithmetic; the MiniMax smoke test is still pending because only 4.8 GB was free at probe time.
4. **ComfyUI 0.42.1 vs. templates.** The templates in `Comfy-Org/workflow_templates` are current; the local install's node set matches the MiniMax/ACE/YuE/Stable Audio nodes I checked, but the Stable Audio 3 checkpoint files are **not installed**.
5. **Licences change.** Re-check the exact licence file at integration time; this document is a snapshot dated 2026-10-23.
6. **Training-data provenance** is only explicitly clean for Stable Audio (Open and 3). ACE-Step / MiniMax / HeartMuLa / DiffRhythm do not make an equivalent public claim in their READMEs; for high-stakes commercial work, ask counsel.

---

## 9. Source index (primary)

**Repos / model cards**
- ACE-Step v1 — https://github.com/ace-step/ACE-Step · https://huggingface.co/ACE-Step/ACE-Step-v1-3.5B
- ACE-Step 1.5 — https://github.com/ace-step/ACE-Step-1.5
- Stable Audio 3 — https://github.com/Stability-AI/stable-audio-3 · https://arxiv.org/abs/2605.17991
- Stable Audio Open — https://github.com/Stability-AI/stable-audio-tools · https://stability.ai/news-updates/stable-audio-open-research-paper
- Stable Audio Open Small — https://stability.ai/news-updates/stability-ai-and-arm-release-stable-audio-open-small-enabling-real-world-deployment-for-on-device-audio-control
- MiniMax Music 3 — https://github.com/MiniMax-AI/MiniMax-Music3 · https://huggingface.co/MiniMaxAI/MiniMax-Music3
- YuE / YuE2 — https://github.com/multimodal-art-projection/YuE · https://github.com/multimodal-art-projection/YuE/tree/YuE-v1
- HeartMuLa — https://github.com/HeartMuLa/heartlib
- DiffRhythm — https://github.com/ASLP-lab/DiffRhythm · https://github.com/ASLP-lab/DiffRhythm2
- MusicGen / MAGNeT / AudioCraft — https://github.com/facebookresearch/audiocraft
- AudioLDM2 — https://github.com/haoheliu/AudioLDM2
- Tango / Tango 2 — https://github.com/declare-lab/tango · https://huggingface.co/declare-lab/tango2
- Mustango — https://github.com/AMAAI-Lab/mustango · https://huggingface.co/declare-lab/mustango
- MusicLDM — https://github.com/RetroCirce/MusicLDM
- Riffusion — https://github.com/riffusion/riffusion · https://huggingface.co/riffusion/riffusion-model-v1
- TangoFlux — https://github.com/declare-lab/TangoFlux
- InspireMusic — https://huggingface.co/FunAudioLLM/InspireMusic-Base
- Qwen2-Audio — https://github.com/QwenLM/Qwen2-Audio

**ComfyUI**
- Official templates — https://github.com/Comfy-Org/workflow_templates/tree/main/templates
- MiniMax Music 3 template — https://github.com/Comfy-Org/workflow_templates/blob/main/templates/audio_minimax_music_3.json
- ACE-Step 1.5 template — https://github.com/Comfy-Org/workflow_templates/blob/main/templates/audio_ace_step_1_5_split.json
- Stable Audio 3 template — https://github.com/Comfy-Org/workflow_templates/blob/main/templates/audio_stable_audio_3_medium.json
- Stable Audio Open template — https://github.com/Comfy-Org/workflow_templates/blob/main/templates/audio_stable_audio_example.json
- YuE2 template — https://github.com/Comfy-Org/workflow_templates/blob/main/templates/audio_yue2_text2music.json
- Community nodes — https://github.com/billwuhao/ComfyUI_ACE-Step · https://github.com/benjiyaya/HeartMuLa_ComfyUI · https://github.com/filliptm/ComfyUI-FL-YuE2 · https://github.com/lks-ai/ComfyUI-StableAudioSampler · https://github.com/ebrinz/ComfyUI-MusicGen-HF · https://github.com/fq393/ComfyUI-InspireMusic

**Repo (read-only evidence)**
- `lib/manifest.js:36`, `lib/manifest.js:96`
- `lib/index.js:372`, `lib/index.js:823`, `lib/index.js:2416`, `lib/index.js:2444`, `lib/index.js:2625`, `lib/index.js:3899`
- `docs/workflow-contract.md:57`, `docs/ARCHITECTURE.md:142`, `lib/concat.js:92`
