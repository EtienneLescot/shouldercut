# Generative video — implementation spec (POC v1)

Status: POC spec, October 2026. Design rationale:
`docs/generative-video-architecture.md`. This document is the
buildable contract: interfaces, states, files and acceptance tests.
Anything not listed here is out of POC scope.

## 1. Goal and demo acceptance

One spoken-style command — « Transforme les enfants en robots » on
`tools/bench/assets/bedroom.mp4` — must produce, in order:

1. Immediate acknowledgement and a visible working state (<300 ms).
2. An optimistic preview: SAM-masked subjects under a flat local
   treatment, at first mask (≈1 s target; SPEC S2 measured 1.13 s).
3. A prepared edit package on the server: source segment, SAM mask
   video, ControlNet-style edge control video.
4. An asynchronous generation job through `GenVideoProvider` whose
   result clip is retrievable over HTTP and probeable by ffprobe.
5. Clear degraded behaviour when no generation key is configured:
   the local stub provider runs the full job loop with a clearly
   labelled placeholder transform, never presented as AI output.

## 2. Non-goals (POC)

- No multi-clip edit graph yet: a generated result is a file plus a
  job record, not yet a timeline clip (SPEC §6 remains the target).
- No final-tier render, no critique pass, no cost billing beyond an
  estimate string and a per-job log line.
- No ComfyUI execution in the product path (R&D only, per design).
- No provider other than `fal` (hosted) and `stub` (local).

## 3. Provider interface (server-side only)

Implemented in `server/gen-video.ts`. Keys never reach the browser.

```ts
interface GenJobInput {
  kind: 'generate_shot' | 'edit_segment';
  prompt: string;
  // edit_segment only, absolute paths prepared by the bridge:
  segmentPath?: string; maskVideoPath?: string; controlVideoPath?: string;
  durationSec?: number;
}
interface GenJobResult { clipPath?: string; remoteUrl?: string; provider: string; model: string; }
interface GenVideoProvider {
  name: string;
  submit(input: GenJobInput): Promise<{ remoteId: string }>;
  poll(remoteId: string): Promise<'queued' | 'running' | 'done' | 'failed'>;
  result(remoteId: string): Promise<GenJobResult>;
}
```

Backends:

- **`stub` (default when no `FAL_KEY`)**: runs locally with ffmpeg.
  `generate_shot` renders a procedural clip (animated gradient +
  prompt burned as text is *not* attempted; the clip is a moving
  test pattern). `edit_segment` applies a labelled placeholder
  transform (hue/posterise) to the segment. Every stub result
  carries `provider: "stub"` in its job record and file name.
- **`fal` (when `FAL_KEY` is set)**: `generate_shot` submits the
  Seedance 2.0 fast text-to-video endpoint (economy settings:
  480p, 4 s, no audio) through the fal queue API and downloads
  the result. `edit_segment` uploads segment + SAM mask video
  through fal storage, submits Wan VACE 14B inpainting (480p,
  81 frames at 16 fps, fixed seed by default) with an optional
  reference image URL and an anti-human negative prompt for
  character replacement, downloads the result, and recomposites
  it locally through the SAM mask (`maskedmerge`), so pixels
  outside the mask come from the original segment.

## 4. Job model

Bridge-owned, in-memory (POC), one job:

```ts
type GenJobState = 'preparing' | 'queued' | 'running' | 'done' | 'failed';
interface GenJob {
  id: string; kind: GenJobInput['kind']; state: GenJobState;
  prompt: string; provider: string; model: string;
  createdAt: number; error?: string;
  files: { segment?: string; maskVideo?: string; controlVideo?: string; result?: string };
  estimate: string; // human-readable cost/time indication
}
```

Rules: job ids are unguessable; identical (kind, prompt, segment
hash) submissions within the session return the existing job;
failures keep their error text; a job never mutates the source
clip, the effect list, or the SAM track.

HTTP surface (bridge, same origin rules as existing `/api/*`):

- `POST /api/gen/generate` `{prompt}` → creates a `generate_shot`
  job, returns it immediately (202-style body, `ok: true`).
- `POST /api/gen/edit` `{prompt, start, end}` → asks the connected
  browser to upload its current clip (SSE `gen-upload-request`,
  same pattern as SAM `track-request`), prepares segment + control
  videos, then submits. Returns the job in `preparing`.
- `POST /api/gen/upload` (raw clip bytes, `x-request-id` header) →
  fulfils a pending edit preparation.
- `GET /api/gen/jobs/:id` → current job record.
- `GET /api/gen/files/:name` → serves prepared/result files from
  the POC output directory (`server/gen-output/`, git-ignored by
  the existing rules for generated media; files are named by job).

Preparation artefacts for `edit_segment`, all by ffmpeg:

- `segment.mp4`: `-ss start -to end`, re-encoded H.264/yuv420p so
  frame counts are exact.
- `control-edge.mp4`: same range through `edgedetect` +
  format conversion — the cheap ControlNet-style structural guide
  (§3.5 of the design). Depth/pose extractors join later behind
  the same file slot.
- `mask-video.mp4`: only when a SAM track exists for the session;
  otherwise the slot stays empty and the job record says so.

## 5. Optimistic preview (product rule, design §7.7)

Implemented as a host UI state, not a catalog effect:

- MCP tool `show_working_preview({subject, color})` → bridge
  `POST /api/preview/working {subject, color}` builds the flat
  treatment WGSL (masked fill + slight posterise, using `maskAt`)
  and applies it through the existing compile path under the
  reserved id `__working-preview`.
- `clear_working_preview()` removes it. Applying any real effect
  does not remove it implicitly; the supervisor clears it when a
  draft lands or a job fails (agent discipline, stated in the tool
  description).
- The WGSL is generated by the bridge from a fixed template with a
  validated `#RRGGBB` colour; no agent code is involved, so this
  state can never break the preview compile of user effects.

## 6. MCP tools (additions to `shouldercut-fx`)

| Tool | Behaviour |
|---|---|
| `generate_shot` | Create a text-to-video job; return job id + estimate immediately. Never blocks on generation. |
| `edit_segment` | Create an edit job for `{prompt, start, end}` over the browser's current clip; returns the preparing job. |
| `get_generation_job` | Poll one job; on `done`, returns file URLs for segment/control/result. |
| `show_working_preview` | Show the optimistic flat treatment over the current SAM mask. |
| `clear_working_preview` | Remove that treatment. |

Supervisor prompt gains one paragraph: after `track_object` and
before submitting a generation job, call `show_working_preview`;
poll sparingly (generation takes minutes; do not busy-wait in the
chat turn — report the job id and let the user ask, or poll a few
times with pauses when the user explicitly waits).

## 6b. VACE tuning (learned 2026-10-29, sources: fal endpoint docs, Wan2GP VACE guide, ComfyUI community practice)

The fal endpoint exposes no denoise/strength: guidance is the main
transformation lever. These rules are now the server defaults.

| Setting | Was | Now | Why |
|---|---|---|---|
| `guidance_scale` | 5 (default) | 8 | At 5 VACE reconstructs the masked subject almost identically; 8 forces the described replacement but oversaturates orange/red palettes — drop toward 6-6.5 and add the bad colours to the negative when saturation appears |
| `num_inference_steps` | 30 (default) | 40 | Detail/stability inside the mask |
| `prompt` form | imperative ("Replace the woman with...") | descriptive final-scene | VACE generates the described finished video inside the mask; imperative edit wording anchors it to the source subject. Describe the finished scene, reference image included |
| `negative_prompt` | custom short anti-human list | fal default quality list + anti-human appended | Overriding the whole default removed quality guardrails |
| mask video | exact SAM mask | + 3x dilation | Community practice and tests: exact edges leak the original silhouette and starve differently-proportioned replacements |
| `ref_image_urls` | robot photo | unchanged | Name the reference explicitly in the prompt ("see reference image") |

Not exposed by fal (needs a local ComfyUI/Wan2GP backend): denoise,
VACE control strength, grey-127 control-video authoring, pose/depth
control videos as first-class inputs.

## 7. Acceptance tests (POC gate)

1. `npm run build` green; MCP server lists 16 tools.
2. With no `FAL_KEY`: `generate_shot` job reaches `done` via stub;
   result file passes ffprobe (H.264, >0 s).
3. `edit_segment` on bedroom.mp4: segment (6.7 s) and edge control
   video exist and pass ffprobe; stub result exists.
4. Optimistic preview: SAM track `children` (or `pillow` fallback)
   on bedroom.mp4 + `show_working_preview` → screenshot shows the
   masked subject in flat colour, rest of frame untouched.
5. No-key fal path: forcing `GEN_PROVIDER=fal` without a key
   fails the job with an explicit configuration error, UI intact.
