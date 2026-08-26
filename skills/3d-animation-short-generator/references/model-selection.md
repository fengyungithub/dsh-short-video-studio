# Video Workflow Selection and Prompt Shaping (Audio-Mode Aware)

## STEP 7: Default Workflow and Capability Check

Before rendering the first clip, use the **default video workflow from the capability registry**（当前 `video.reference2video` → `minimax-h3-ref2v`，`video.image2video` → `minimax-h3-i2v`）. Do not preselect, advertise, or suggest a named alternative workflow. If the user explicitly specifies another model or workflow, first check its support for the requested duration, aspect ratio, resolution, references, audio, and motion via `comfy_list_workflows`; follow the user's selection only when the capability check passes. If it does not pass, explain the limitation and offer a compatible route.

Show a workflow choice card only when the user asks to change the model, when a capability check requires a decision, or when the user asks to compare options. Keep the default option as the registry default and describe any other option generically. Do not preconfigure a named alternative or add one to option cards.

## Resolution and parameter choice

After the workflow is known, confirm a supported resolution and duration. The default H3 workflow commonly supports 768P and 2K; for another explicitly selected workflow, use only the resolutions and durations returned by its capability check (`comfy_list_workflows` → `constraints`). The resolution is a technical parameter, not a model recommendation. Keep aspect ratio, frame rate, audio mode, and reference-image requirements aligned with the selected workflow.

## Single-shot clip rendering

For each approved table row, call the selected workflow (`comfy_generate_video`，或 `comfy_render` 显式 `workflow`) to generate the corresponding independent clip. Each clip must use the matching text-storyboard section, character card(s), and scene card. Keep these rules common to every workflow:

- The text storyboard is authoritative for narrative, composition, camera movement, action, timing, mouth state, and shot number.
- Character cards are authoritative for identity; scene cards are authoritative for environment.
- Strip storyboard-only labels such as `[char:…]`, `[scene:…]`, `[shot:…]`, `[dur:…]`, `[hook:…]`, `[audio_mode:…]`, and `[speaker:…]` before rendering.
- Preserve the approved ratio and resolution. Do not add storyboard traces, labels, watermarks, or unrequested subtitles.

## Audio-mode-aware prompt shaping

Build a compact context block from the shot table and prepend it to the selected workflow's prompt:

```
[AUDIO_MODE] <narration|dialogue|mixed|silent>
[SPEAKER] <exact character name, off-screen narrator, or n/a>
[NON_SPEAKERS_MOUTH] <exact names, or all>
[SHOT_DURATION] <N>s
```

For narration, every on-screen mouth stays closed while expression changes carry the voiceover. For dialogue, only the named speaker may move their mouth during the marked seconds; all other mouths stay closed. For mixed rows, follow the per-second map. For silent rows, keep all mouths closed and use body, gaze, and gesture for emotion.

Use the same visual baseline for the default workflow and any explicitly selected other workflow: clear subject identity, stable references, readable camera path, per-second action, sound cues, and negative constraints. Preserve necessary resolution, prompt-structure, and face-anchor methods, but express them as capability-checked execution details rather than workflow-specific promotion.

## Speaker-binding reference selection

For dialogue rows, use the speaker's character-card reference as the primary face anchor when the selected workflow supports reference binding (`video.reference2video`). For narration, anchor the on-screen character; for silent rows, anchor the most prominent subject. If the selected workflow lacks face binding, tighten the prompt and simplify the shot instead of claiming stronger identity control.

## After rendering

Place clips on canvas in shot order and show an approval card:

- Approve clips and assemble the film
- Re-render a selected clip with the same workflow
- Re-check capability (`comfy_list_workflows`) and follow the user's explicitly selected other workflow
- Fix character, scene, continuity, speaker-binding, or mouth-state issues
- Skip the clip and mark a placeholder for review
