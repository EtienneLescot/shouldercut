# Character replacement: workflow research (2026-10-29)

Question: replace a person in real footage with a reference character
("the children become robots"), keeping motion, scene, lighting.

Conclusion up front: mask-inpainting (VACE) is the wrong workflow for
this job. It repaints inside the source silhouette and, at hosted
defaults, either reconstructs the original person or melts the
replacement. The workflows the ComfyUI ecosystem actually uses for
this job are purpose-built replacement models. Settings matter, but
they live inside those workflows — no guidance value fixes a
wrong-workflow choice.

## The three reference workflows (official ComfyUI templates)

### 1. SCAIL-2 character replacement — the current reference

- Official template: `video_wan21_scail2_character_replacement`
  (ComfyUI core nodes, no custom nodes). Model: zai-org SCAIL-2,
  a Wan2.1 14B fine-tune built for end-to-end character replacement.
- Pipeline: SAM3 video tracking of the driving subject + of the
  reference, `SCAIL2ColoredMask` paints each identity a fixed colour
  (motion binding is by mask colour, no pose skeleton),
  `WanSCAILToVideo` with `replacement_mode: true`,
  `pose_strength 1.0`, chunks of 81 frames with overlap for long clips.
- Template settings (read from the official JSON): `lightx2v` distill
  LoRA 0.8, SCAIL DPO LoRA 1.0, `ModelSamplingSD3` shift 5, euler /
  simple scheduler, 6 steps, CFG 1. Raise LoRA/shift back toward
  1.0 / 8 if driving-subject details bleed onto the replacement.
- The rule that costs a render if missed: **in replacement mode the
  reference image's framing controls the output character's size.**
  Measured: full-bleed portrait reference against a subject at ~30%
  of frame height rendered the character 1.71x oversized; reframing
  the reference so the character occupies the same frame-height
  fraction as the driving subject gave 1.003x. Pad/reframe the
  reference before generating.
- Prompt: describe the finished result, not an instruction.
- Do not post-composite the raw output through the mask: the model
  resolves colour, edges, contact and occlusion jointly; compositing
  measures better and looks worse (halo, severed grips).
- Not hosted on fal. Runs in local ComfyUI or on a rented GPU pod
  (community RunPod templates exist).

### 2. Wan 2.2 Animate, Mix mode — the older official route

- Official template `video_wan2_2_14B_animate`: DWPose skeleton +
  SAM2 mask prep, `WanAnimateToVideo`, relight LoRA 1.0 + lightx2v
  LoRA 1.0, shift 8, 6 steps, CFG 1, euler/simple.
- The Kijai wrapper exposes `pose_strength` / `face_strength` in
  `WanVideoAnimateEmbeds`. The hosted fal endpoint exposes none of
  this, which plausibly explains our ghostly hosted test: same model
  family, none of the workflow around it.

### 3. VACE inpainting — keep for localised edits only

- Official template settings: `WanVaceToVideo` strength 1,
  **GrowMask 20 px**, shift 5, CFG 6 / 20 steps undistilled
  (or CausVid LoRA 0.3, 4 steps, CFG 1 distilled).
- Right job: garment change, prop swap, removal, localised repaint.
- Wrong job: full character replacement.

## Hosted option with the existing key: fal Recast

- `minimax/h3-max/recast` on fal (same `FAL_KEY`): one call, source
  video 5-30 s (single shot <= 15 s) + one reference photo per person
  (up to 4, matched left-to-right), optional who-becomes-whom prompt,
  `enhance_realism` for photographic people. Preserves motion,
  camera, cuts and audio. $0.30/s at 768P, $0.45/s at 1080P.
- This is the cheapest honest next test of the actual demo sentence:
  same stock clip, same robot reference, ~5 s at 768P.

## Test result (2026-10-29): Recast passes the bar

Same easy stock clip, same robot reference, backend `recast` wired
behind `edit_segment` (`backend: "recast"`, 768P, seed 42, ~2 min,
~$1.50): the robot is recognisable and stable across the full 5 s —
grey metal body, orange joints, cyan eyes, antenna — integrated into
the hill scene with plausible ground contact. One caveat: it
re-performs the walk facing the camera instead of keeping the exact
side profile of the source. This is the first backend to produce a
real replacement instead of a reconstruction or a ghost.

## What changes in ShoulderCut

- `server/video-techniques.json`: `character_replace_motion` now
  ranks SCAIL-2 (reference workflow) and fal Recast first, marks the
  hosted Wan Animate test as weak, and records the
  reference-reframing rule and the no-recomposite rule.
- Next wiring step, in order: (1) Recast backend behind
  `edit_segment` for a one-shot hosted test; (2) SCAIL-2 as a local
  ComfyUI backend when a GPU path is wanted.

## Sources

- ComfyUI SCAIL-2 tutorial: https://docs.comfy.org/tutorials/video/zai/scail2
- Official templates (settings read from the JSON):
  https://github.com/Comfy-Org/workflow_templates
  (`video_wan21_scail2_character_replacement`,
  `video_wan2_2_14B_animate`, `video_wan_vace_inpainting`)
- SCAIL-2 model: https://huggingface.co/zai-org/SCAIL-2
- Wan2.2 Animate tutorial: https://docs.comfy.org/tutorials/video/wan/wan2-2-animate
- fal Recast: https://fal.ai/models/minimax/h3-max/recast
