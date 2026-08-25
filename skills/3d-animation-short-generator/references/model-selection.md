# Video Model Selection and Prompt Shaping (Audio-Mode Aware)

## STEP 7: Default Model and Capability Check

Before rendering the first clip, use **MiniMax-H3 as the default video model**. Do not preselect, advertise, or suggest a named alternative model. If the user explicitly specifies another model, first check that model's support for the requested duration, aspect ratio, resolution, references, audio, and motion; follow the user's selection only when the capability check passes. If it does not pass, explain the limitation and offer a compatible route.

Show a model choice card only when the user asks to change the model, when a capability check requires a decision, or when the user asks to compare options. Keep the default option as MiniMax-H3 and describe any other option generically as “用户明确指定的其他模型”. Preserve normal pricing information when available, but do not recommend a particular low-cost tier or a named substitute.

## Resolution and parameter choice

After the model is known, confirm a supported resolution and duration. MiniMax-H3 commonly supports 768P and 2K; for another explicitly selected model, use only the resolutions and durations returned by its capability check. The resolution is a technical parameter, not a model recommendation. Keep aspect ratio, frame rate, audio mode, and reference-image requirements aligned with the selected model.

## Single-shot clip rendering

For each approved table row, call the selected video model to generate the corresponding independent clip. Each clip must use the matching text-storyboard section, character card(s), and scene card. Keep these rules common to every model:

- The text storyboard is authoritative for narrative, composition, camera movement, action, timing, mouth state, and shot number.
- Character cards are authoritative for identity; scene cards are authoritative for environment.
- Strip storyboard-only labels such as `[char:…]`, `[scene:…]`, `[shot:…]`, `[dur:…]`, `[hook:…]`, `[audio_mode:…]`, and `[speaker:…]` before rendering.
- Preserve the approved ratio and resolution. Do not add storyboard traces, labels, watermarks, or unrequested subtitles.

## Audio-mode-aware prompt shaping

Build a compact context block from the shot table and prepend it to the selected model's prompt:

```
[AUDIO_MODE] <narration|dialogue|mixed|silent>
[SPEAKER] <exact character name, off-screen narrator, or n/a>
[NON_SPEAKERS_MOUTH] <exact names, or all>
[SHOT_DURATION] <N>s
```

For narration, every on-screen mouth stays closed while expression changes carry the voiceover. For dialogue, only the named speaker may move their mouth during the marked seconds; all other mouths stay closed. For mixed rows, follow the per-second map. For silent rows, keep all mouths closed and use body, gaze, and gesture for emotion.

Use the same visual baseline for MiniMax-H3 and any explicitly selected other model: clear subject identity, stable references, readable camera path, per-second action, sound cues, and negative constraints. Preserve necessary resolution, prompt-structure, and face-anchor methods, but express them as capability-checked execution details rather than model-specific promotion.

## Speaker-binding reference selection

For dialogue rows, use the speaker's character-card reference as the primary face anchor when the selected model supports reference binding. For narration, anchor the on-screen character; for silent rows, anchor the most prominent subject. If the selected model lacks face binding, tighten the prompt and simplify the shot instead of claiming stronger identity control.

## After rendering

Place clips on canvas in shot order and show an approval card:

- Approve clips and assemble the film
- Re-render a selected clip with the same model
- Re-check capability and follow the user's explicitly selected other model
- Fix character, scene, continuity, speaker-binding, or mouth-state issues
- Skip the clip and mark a placeholder for review
