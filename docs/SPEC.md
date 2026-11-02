# ShoulderCut — Product & Technical Specification

Meta Global AI Developer Hackathon, Indie Developer track.
Building period: Oct 27 – Nov 4, 2026. Submission deadline: Nov 4, 21:00 ET.
Problem statement: **Build for Your World**.

Name frozen Nov 2: ShoulderCut.

This document started as a planning artifact written on kickoff day (Oct 26)
and is now kept current with what is actually built. Revised Nov 2, 2026:
sections 0, 2, 5, 7, 8, 10 and 13 describe the shipped system, not the plan.
Where the build diverged from the plan, the divergence is recorded in §13
rather than quietly overwritten. `docs/spikes.md` holds the dated
verification notes, the README holds the feature list shown in the demo.

## 0. Compliance frame (non-negotiable)

- New public repository, created on or after Oct 27. All submitted code is
  written from scratch during the building period.
- No code is copied from the author's existing repositories. They are the
  knowledge base; every brick is rewritten from scratch during the event:

  | Repo | Knowledge reused | Rewritten here as |
  |---|---|---|
  | openscreen | Native GPU compositor (Rust, D3D11VA/Metal/wgpu), code-first renderer interfaces, decode/encode pipeline | WebGPU/WGSL render worker, free-form FX code interface, WebCodecs pipeline (§3, §5) |
  | muse-desktop | Coding-agent runtime, Muse Code integration, MCP hosting | Agent service and tool plumbing (§5, §7), MCP server |
  | stimm | Optimistic voice UI: fast voice agent + deep supervisor on LiveKit | Not imported in the end (see below). The know-how shaped the push-to-talk path and the optimistic working preview; no code and no package from it ships |

  Reading those repos for concepts, interfaces, and known pitfalls is
  allowed; copying code out of them is not. Agents get this spec plus
  concept notes, and write new implementations.
- Organizer rulings obtained on Discord (#questions, Oct 26): rewriting
  from scratch while reusing know-how is compliant with "new work only";
  importing own previously published MIT packages is allowed if properly
  declared (confirmed by Cerebral Valley staff).
- **stimm is not imported after all** (decided Oct 31, §13). The voice
  loop ships as browser push-to-talk straight into the existing
  supervisor path, so the product carries no first-party pre-existing
  dependency at all: every line of ShoulderCut is event work, and the
  README's "Pre-existing dependencies" list is third-party only. The
  plan of record until Oct 31 was to import the author's published MIT
  `stimm` package for a LiveKit dual-agent voice runtime; that option
  was declared compliant by the organizers and is simply unused.
- Third-party open-source libraries are allowed and listed in the README
  under "Pre-existing dependencies" with name, purpose, and license.
- README gets a "Built during the hackathon" section listing every feature
  shown in the demo. The 3-minute demo video shows only hackathon work.
- Git history is the proof: small dated commits from Oct 27 onward, no
  history rewrite, no squashing before submission.
- Meta Model API: $150 credits already claimed (author confirmed Oct 26).
  Remaining admin: verify the credits show on the Billing page and that a
  hard spend limit is set before the first API call.
- API keys never ship to the browser. All Meta API calls go through a thin
  server-side proxy.

## 1. Product

**Pitch.** Your video editor, standing over your shoulder: you talk, it
cuts. A conversational editing agent that performs full edits and
object-aware 3D shader effects in real time, driven by voice.

**Concept.** The user speaks to the editor the way a director speaks to a
human editor sitting next to them: "blur the background", "make the car
glow, more", "same effect on the next clip", "undo that". The effect
appears immediately in the preview, the user corrects it live, and the
editor answers out loud in one short sentence. The short speak → see →
correct loop is the product. There is no effects catalog for it to pick
from: the agent writes free-form WGSL through MCP shader tools, the host
compiles it live and returns compiler errors for iteration (contract in
`docs/fx-interface.md`, POC verified Oct 27 with a Muse harness).
Voice runs as push-to-talk into the same agent (§2.3, §13): hold the
button, speak, release, and the transcript enters the supervisor exactly
as a typed command would. What the planned dual-agent voice runtime was
there to provide — "something is happening" while the deep agent works —
is provided visually instead, by the optimistic working preview.

**Users.** Solo creators, streamers, and indie filmmakers who know the
result they want but lose hours in a traditional NLE timeline. They have
footage, a story, and no desire to learn keyframing.

**Orientation.** Full editing capability (multi-clip, trim, silence
removal, captions, export) with a strong center of gravity on special
effects: SAM 3.1 object masks feeding agent-written real-time WGSL
shaders. The product supplies the shader code interface and execution
host only — the agent invents each effect as code. When scope must be
cut, editing features are cut before the shader layer (see priorities
in §2 and cut order in §11).

## 2. Scope

### 2.1 Effects (the core)

There is **no predefined effects catalog**. An effect is a free-form
WGSL fragment function written by the coding agent at request time and
executed as one pass in an ordered chain over the decoded frame. The
host owns only the code interface in `docs/fx-interface.md`: standard
context (uv, resolution, media time, progress, free `vec4` params),
sampling helpers for the previous pass and the original frame, a
`maskAt()` seam for SAM masks, live compilation with errors returned to
the agent, and per-effect time ranges. Anything expressible in that
fragment space is allowed: warps, procedural explosions and particles
by formula, color work, SDF shapes, glitch, virtual-camera/parallax
moves once masks land, or effects nobody planned.

P0 is therefore the interface quality, not a list of effects:
- `apply_shader_effect` compiles synchronously in the browser and
  returns actionable WGSL errors to the agent for iteration.
- Effects stack, replace by id, remove, and clear live without reload.
- A failed compile never replaces the last working shader or blanks
  the preview.
- `maskAt()` is driven by SAM 3.1 mask tracks (next integration after
  the Oct 27 POC, where it returns 1.0).
- Chat first (Muse Code harness over MCP, POC done Oct 27), then voice
  on the same tool surface (push-to-talk, §2.3).

Demo prompts will showcase range, not features: an explosion at the
center, an object isolation using a SAM mask, and a parallax push are
things the agent writes on request, not entries shipped in a catalog.
Temporal history textures and compute passes extend this same contract
later; they are host capabilities, still not catalog effects.

Three host capabilities extend this same contract and shipped on top of
it. None of them is a catalog of effects either; each is a wider space the
agent writes code or parameters into:

- **True 3D and GPU particles.** Background/foreground world planes
  (`layerUv`, `foreAt`, `backAt`), a host-animated virtual camera
  (`camera` move, `target`, `roll`), raymarching helpers (`rayDir`,
  `worldToUv`, SDF/lighting stdlib), and host-simulated compute
  particles (`particleInit`/`particleUpdate` plus billboard sprites in
  the same world space). Parallax push-ins, volumetrics and sparks are
  written per request, not selected.
- **Generative video** (`docs/generative-video-spec.md`,
  `docs/generative-video-architecture.md`). Where a shader cannot reach
  — replacing a character, repainting a garment, inventing a shot — the
  agent spends a generation job instead: `generate_shot`, `edit_segment`,
  `get_generation_job`, async with an optimistic working preview
  (`show_working_preview`). Backends: a local stub, hosted fal
  (`vace`, `wan-animate`, `kling-o3`, `recast`), and a local ComfyUI
  repertoire of tested workflows (`scail`, `scail-animate`, `vace-local`)
  in `server/comfy-workflows/`. Plans go through the technique registry
  (`server/video-techniques.json`, 10 researched techniques) via
  `list_video_techniques`, `list_comfy_workflows` and
  `recommend_video_workflow` before any spend.
- **Editing craft on demand.** `get_editing_craft` serves one small
  topic at a time (colour, camera, beat, captions) from
  `docs/editing-craft.md`, loaded only when a request touches taste, so
  craft never taxes ordinary editing.

P1 (not built): backdrop plates generated with Muse Image as shader
inputs, 9:16 / 1:1 reframing expressed through the code interface rather
than export presets.
P2 (not built): music-bed ducking.

### 2.2 Editing (full, but agent-first)

P0:
- Import several clips (MP4/WebM, H.264/VP9), ordered clip list.
- Trim head/tail and split at playhead, reorder, delete — all as agent
  operations; the UI timeline is a readout, not the primary control.
- Silence removal from audio analysis cross-checked with transcript gaps.
- Captions from Muse Voice Transcribe. The API returns turn-level
  `startMs`/`endMs` only (no word timestamps, verified Oct 27); long
  turns are split into caption cues proportionally to text length.
  Burned-in captions with one clean style, plus SRT export.
- Undo/redo over every operation, conversational references ("undo that",
  "same on the other clip").
- Export MP4 (H.264 + AAC), 1080p max, source frame rate.

P1: dissolve transition, audio normalize and fade-out, caption styling
variants, filler-word removal from transcript.
P2: beat-cut on music, multi-track audio.

### 2.3 Interface (thin by design)

One screen: large preview canvas, project panel with the clip list and a
minimal timeline readout, caption overlay, chat transcript and agent reply
line, undo/redo, export, and a push-to-talk Talk button.

Voice is push-to-talk, not an always-open room (§13): hold Talk, speak,
release; the browser records with `MediaRecorder`, the bridge transcribes
with Muse Voice Transcribe and feeds the text into the same supervisor
path as a typed command, with full tool parity. The agent answers in the
reply line; replies are written, not spoken. Chat input mirrors voice for
noisy rooms and as the demo backup path. No settings pages, no effect
browser panels: effects are requested, not browsed.

## 3. Rendering architecture: copy budget

Target: real-time 3D shader effects in the browser, with no CPU copy of
video pixels anywhere in the preview or export path. What the platform
actually guarantees, segment by segment:

| Segment | CPU copy | GPU copy |
|---|---|---|
| Hardware decode → shader | None | None expected |
| Shader multi-pass chain | None | Render targets only |
| Shader → display | None | Compositor only |
| Shader → encoder (export) | None if HW encode | Snapshot/conversion possible |
| SAM mask → shader | Upload per new mask | n/a |
| Encoded chunks → muxer | Compressed bytes only | n/a |

Facts behind the table:

- `GPUDevice.importExternalTexture({ source })` accepts an
  `HTMLVideoElement` or a WebCodecs `VideoFrame`. Chrome documents this as
  sampling "potentially in a 0-copy way directly from the source YUV data":
  the decoder's GPU planes are wrapped, YUV→RGB conversion happens in the
  sampler. "Potentially" matters: zero-copy is the design intent and the
  normal hardware path, not an API guarantee on every OS/codec/format.
- External textures are constrained: valid only until the end of the
  current JS task (re-imported every frame, new bind group every frame),
  sampled only via `texture_external` and `textureSampleBaseClampToEdge`,
  no mipmaps, no repeat addressing, not usable as storage.
- Consequence: the first pass (ingest) samples the external texture and
  writes a regular `GPUTexture`. That is a GPU→GPU pass, identical in
  spirit to a native render target. No pixel ever transits through JS or
  system RAM. Single-pass effects may write the swapchain directly.
- Export has no API to hand a `GPUTexture` to `VideoEncoder`. The path is:
  render to a WebGPU `OffscreenCanvas`, then `new VideoFrame(canvas, …)`,
  then the hardware encoder. With an accelerated canvas and a hardware
  encoder configuration there is no CPU readback; the `VideoFrame`
  snapshot of a reused canvas may cost one GPU copy or an RGB→NV12
  conversion. The spec does not guarantee zero GPU copies here.
- Forbidden in the render path (they force CPU copies): `getImageData`,
  2D-canvas pixel manipulation of video, `readPixels`-style readback,
  software encoder configurations. Encoder/decoder support is probed
  with `isConfigSupported({ hardwareAcceleration: "prefer-hardware" })`
  and the app refuses to start the FX pipeline on a software path.

Honest summary: **zero CPU copy is achievable end-to-end in Chrome/Edge
on a hardware decode/encode path. Zero copies tout court is not
guaranteed by any browser API, mainly at the canvas→encoder seam.** The
native OpenScreen compositor (Rust, D3D11VA/Metal/wgpu) controls
decoder-texture sharing and encoder handoff directly; that control is
what the browser gives up, and it is the reason the fallback ladder in
§5 exists.

**Measured on the author's machine (Oct 26 pre-checks, RTX 4070 Ti,
Chrome 155, adapter `nvidia/lovelace`, not a fallback adapter).**
Pipeline: hardware decode → `importExternalTexture` → ingest+grade →
10-tap blur → glow+vignette → present, with zero readback APIs in the
frame path (statically scanned). Results: 1080p30 at 29.98 fps and
4K30 at 29.98 fps (source-paced), JS submit ≈0.28 ms/frame flat with
resolution, 57.9 fps at 2× playback in 1080p. `VideoFrame(video)` as
import source: same numbers. Export seam: 90 frames at 1080p rendered
and H.264 hardware-encoded in 0.62 s (145 fps, 4.83× realtime).
Hardware codec probes: AVC encode/decode at 1080p and 4K, AV1 at 1080p;
VP9 encode unavailable. Verdict: the hosted-browser primary (§5) is
validated on this machine; the in-repo bench (rewritten during the
event) re-runs these numbers and adds GPU timestamp queries per pass.
Judge machines remain unknown, hence the startup probe and fallback
ladder. The bench was rewritten in this repository on Oct 27 with
per-pass GPU timestamp queries; full in-repo results are in
[spikes.md](spikes.md).

## 4. Day-1 spikes (Oct 27, decision gates)

Spikes are throwaway measurement code in a `spikes/` folder, never shipped
files. Results are recorded in `docs/spikes.md` (question, method, numbers,
decision). Each gate is evaluated the same evening.

**S1 — WebGPU copy path and frame budget. Status: PASS in Oct 26
pre-checks (§3); on Oct 27 the bench is rewritten in-repo and re-run as
the regression gate.** Question: does this machine stay hardware
end-to-end, and at what resolution?
Method: decode a 1080p and a 4K clip via WebCodecs, import as external
texture, run ingest + 3 effect passes (grade, blur, glow), present; then
run the export path into `VideoEncoder`. Measure fps, per-pass GPU time
(timestamp queries where available), main-thread CPU time, and whether
decoder/encoder report hardware configurations.
Pass: 1080p30 preview sustained with 3 passes and export at ≥ 0.5×
realtime, no software codec configuration.
Partial pass: run preview on a 720p proxy, export offline at 1080p.
Fail: pivot per §5 (local shell), same edit graph and agent tools.

**S2 — SAM 3.1 via Meta Model API. Status: LIVE PASS Oct 27.** Image:
first mask delta at 1.13 s, total 1.27 s, exact box on the test object.
Video (30-frame 640×360 clip via Files API): upload 2.17 s, first mask
delta 3.55 s after the SAM request, full track in 3.92 s, 25 frame
lines with box+mask, `video_frames_processed: 50` (billing minimum).
Implication: upload each clip once and cache its `file_id`; show a
first-frame image segmentation immediately while the video track
streams in, so the first effect does not wait ~4 s. Documented contract: Responses API
(`POST https://api.meta.ai/v1/responses`, `model="sam-3.1"`), one
concept text prompt (or box/point prompts) + `input_image`/`input_video`
(`video_url`, or `file_id` via the Files API for local clips), streamed
output of one line per frame (`<Nf>` marker, object ordinal, box, then
mask payload). Official pricing: video $0.20 per 1,000 frames, 50-frame
minimum per request — a 60 s clip at 30 fps costs $0.36 per tracked
concept, so credits are not the constraint; latency is.
Method (Oct 27, once the key is exported): segment one referred object
("the red car") in a 10 s clip; measure time-to-first-frame, full-track
latency, mask stability after feathering, billed frames.
Pass: track usable live (first masks in seconds, rest streamed/cached).
Fallback: segment keyframes every N frames, interpolate masks on GPU,
let the user re-prompt a lost track by clicking the object.

**S3 — Voice and agent loop (stimm). Status: stack verified Oct 26;
live file transcription PASS Oct 27** (`POST /v1/asr/transcribe`,
3.6 s command transcribed exactly in 1.62 s, one turn with
`startMs`/`endMs`; word-level timestamps do not exist in this API).
**Closed Oct 31 on the fallback, deliberately** (§13). The realtime
stimm/LiveKit loop and Muse Spark tool-calling were never run live,
because the spike's own fallback — "push-to-talk with post-stop
transcription; chat input as the primary demo path" — was chosen on its
merits rather than after a failure. The file-transcription leg it needs
is the leg that passed. What was verified and is now unused: `stimm` +
`livekit-agents[meta]` import cleanly together, and the official LiveKit
Meta plugin exposes `meta.STT` (model `muse-voice-transcribe-1.0`,
realtime WebSocket, PCM16 24 kHz, cumulative interim transcripts,
server-side endpointing, `language_bias` including French, 60 min
session cap).

Still unmeasured, and the one number worth having before the demo: the
valid-op rate of spoken commands. The 20-command FR/EN set of §12 has
not been run as a scored eval against the shipped push-to-talk path.
Original pass bar, kept as the bar: effect applied under ~2 s perceived,
≥ 18/20 commands become valid operations without repair.

## 5. System architecture

Decision gate at end of Oct 27: if S1 passes, the product is a hosted web
app (compute runs on the visitor's GPU; hosting is static files plus the
proxy). The fallback ladder never changes the edit graph, tool schemas,
or UI — only the execution host of the renderer:

1. Hosted web app, Chrome/Edge desktop (primary).
2. Same web app at proxy preview resolution + offline 1080p export.
3. Same web app inside a thin local shell for filesystem access and a
   native encoder, renderer unchanged.

Components, all written during the event (no first-party import, §0):

- **Web app** (Vite). UI shell, preview canvas, mic capture, chat.
- **Render worker**. Owns the `OffscreenCanvas`, WebGPU device, the
  free-form FX code interface (`docs/fx-interface.md`), dynamic shader
  compilation, ping-pong textures, mask textures, and later temporal
  history buffers as host capabilities. Demux/decode with WebCodecs;
  MP4 mux on export. Third-party demux/mux helpers allowed if declared
  (Mediabunny, in use).
- **Edit graph** (§6). Single source of truth; the renderer and the agent
  both consume it. Undo is graph history, rendering is a pure function of
  (graph, time).
- **Agent harness (the Supervisor)**. The local bridge runs Muse Code
  CLI (`muse exec`, resolved from the local install) in an empty agent
  workspace, with the `shouldercut-fx` MCP server as its whole tool
  surface and a system instruction covering the shader contract, the
  craft loader and the generation budget rules. One harness serves chat,
  push-to-talk voice and the generation planner: the MCP surface is the
  product contract, so nothing above it changes when the input changes.
  The agent emits WGSL and validated edit operations; it never touches
  pixels directly. Muse Spark was the planned Supervisor host (§13);
  Muse Code fills that role in the shipped build. Runtime/MCP hosting
  concepts come from muse-desktop know-how, rewritten here.
- **SAM adapter**. Hides the SAM 3.1 API behind `trackObject(clipRef,
  prompt, timeRange) → MaskTrack`. Mask tracks are cached client-side
  (OPFS/IndexedDB), keyed by clip hash + prompt + range.
- **Voice path (push-to-talk)**. No separate service and no LiveKit
  room (§13). The web app records the held Talk button with
  `MediaRecorder` and posts the clip to `/api/voice/command`; the bridge
  transcribes it with Muse Voice Transcribe
  (`muse-voice-transcribe-1.0`) and runs the transcript through the same
  supervisor call as a typed command, returning both the transcript and
  the agent's reply. Clip audio for captions and the silence
  cross-check uses the same file-transcription endpoint via the proxy
  ($0.18 per audio hour).
- **Generation service**. Async job manager for generative video
  (`server/gen-video.ts`): segment extraction and ControlNet-style edge
  control via ffmpeg, a stub backend for offline work, a hosted fal
  backend, and a local ComfyUI backend driving the tested workflow
  repertoire. Finished jobs join the edit graph as clips automatically.
- **Proxy** (small Node service). Holds Meta API keys, enforces per-session
  budgets, logs credit spend, streams responses when supported.
- **MCP server (`shouldercut-fx`, P0)**. Node/stdio MCP server exposing
  video state, shader apply/list/remove/clear, seek, and play/pause to
  any coding-agent harness. Shader compilation is relayed to the
  connected browser and its result blocks the tool call, so the agent
  iterates on real WGSL errors. Edit-graph tools join the same server.

## 6. Edit graph and data model

As built (`server/edit-graph.ts`), the project is one versioned JSON
document holding the *cut*, while the *look* lives in the render worker:

```
Project    { version: 1, clips: ProjectClip[] }
ProjectClip{ id, name, hash, duration, in, out, captions: CaptionCue[], captionsEnabled }
CaptionCue { start, end, text }
```

Clip bytes are stored on disk keyed by content hash (`server/clip-store`),
generation output in `server/gen-output`; the document references them by
hash, so a project re-links its sources.

Shader state is held separately, in the render worker and addressed by
effect id over the MCP surface:

```
ShaderEffectDefinition { id, name, kind: 'fragment'|'particles', code, params[16],
                         enabled, range, camera?, particles?, particleCode? }
MaskTrackData          { frames: MaskTrackFrameData[] }  // SAM 3.1, decoded server-side
```

Rules:
- Effects apply in list order as one pass chain over the decoded frame.
  Parameter changes update uniforms, not pipelines.
- Masks are decoded server-side from the SAM 3.1 stream and streamed into
  the worker behind `maskAt()`; a clip is tracked at most once per
  (hash, prompt).
- Every edit-graph change commits a pre-op snapshot to an undo stack with
  a human label, capped at 100 entries. `undo`/`redo` restore snapshots
  of the whole document.
- **Known divergence from the plan:** effects are *not* in the document,
  so `undo` does not cover shader changes. "Undo that" after an effect
  resolves to `remove_shader_effect` instead, which the supervisor knows;
  the two histories are separate. Unifying them would mean moving effect
  state into the document and is not worth doing before the submission.
- The agent can only change the document and the effect list. It never
  touches pixels.

## 7. Agent tools (MCP contract)

The agent sees exactly these tools, served by the `shouldercut-fx` MCP
server (`server/shouldercut-mcp.mjs`). Names and fields are the contract;
validation rejects anything else and feeds the error back once. 31 tools
in six groups:

**Reference (pulled on demand, never preloaded)**

| Tool | Inputs | Purpose |
|---|---|---|
| `get_shader_interface` | — | serves `docs/fx-interface.md`, the WGSL contract |
| `get_editing_craft` | topic (`colour`, `camera`, `beat`, `captions`) | one craft topic from `docs/editing-craft.md` |

**Shaders**

| Tool | Inputs | Effect on graph |
|---|---|---|
| `validate_shader` | code, kind | dry-run compile; no graph change |
| `apply_shader_effect` | id, name, WGSL code, params (16 free), range, kind (`fragment`/`particles`), camera, particles config, particleCode | compile live; append/replace Effect only on success |
| `list_shader_effects` / `remove_shader_effect` / `clear_shader_effects` | effectId where relevant | inspect or delete shader Effects |

**Preview and observation**

| Tool | Inputs | Purpose |
|---|---|---|
| `get_video_state`, `seek_video`, `set_playing` | time / boolean where relevant | observe and position the preview |
| `describe_frame` | time | returns the current frame as a PNG image to the agent |
| `track_object` | text prompt, range | create a MaskTrack via SAM 3.1 behind `maskAt()` |

**Edit graph**

| Tool | Inputs | Effect on graph |
|---|---|---|
| `get_project` | — | read the whole document |
| `trim_clip` / `split_clip` / `move_clip` / `delete_clip` | clipId, times or index | timeline structure |
| `remove_silences` | clipId or project, threshold | cut ranges from ffmpeg `silencedetect` |
| `set_captions` | clipId, cues, on/off | caption layer + SRT data |
| `transcribe_captions` | clipId | Muse Voice Transcribe → caption cues split by text length |
| `undo` / `redo` | steps (default 1) | graph history |
| `export_video` | preset (`1080p`, `vertical`, `square`) | render + mux, burned-in captions |

**Generative video** (spec: `docs/generative-video-spec.md`)

| Tool | Inputs | Effect on graph |
|---|---|---|
| `generate_shot` | prompt, duration | async job; finished shot joins the graph as a clip |
| `edit_segment` | prompt, range, backend (`vace`, `wan-animate`, `kling-o3`, `recast`, `scail`, `scail-animate`, `vace-local`), refImageUrl | async segment edit; same |
| `get_generation_job` | jobId | poll status, cost and output |
| `show_working_preview` / `clear_working_preview` | treatment | optimistic SAM-subject preview while a job runs |

**Planning before spend**

| Tool | Inputs | Purpose |
|---|---|---|
| `list_video_techniques` | filter | the 10 researched techniques, with guidance channels, backends and prices |
| `list_comfy_workflows` | — | the tested local ComfyUI repertoire with its fixed settings |
| `recommend_video_workflow` | intent description | ranked technique + backend for the request |

The supervisor must plan every generative request through the last group
before spending: shader first, then the cheapest technique that can do the
job. `recommend_video_workflow` refuses to improvise a graph that the
repertoire does not cover; it says so instead.

Conversation state kept server-side per session: current clip, last
effect touched, last object tracked, so "more", "same on the other clip",
and "undo that" resolve without re-asking. The agent's spoken/text reply
is one short confirmation naming the operation it performed. If a command
is ambiguous between two visible objects, the agent asks one question
instead of guessing.

## 8. Meta tooling map (what the judges score)

| Meta tool | Role in product | Beyond-basic evidence |
|---|---|---|
| SAM 3.1 | Object masks + boxes behind `maskAt()` for agent shaders; subject isolation for the optimistic working preview; subject detection inside the local SCAIL-2 workflows | Masks feed free-form shaders, not a viewer; the agent invents tracked parallax, trails and isolation from the same mask input, and the mask also sizes the reference character for generation |
| Muse Code | The shipped Supervisor: `muse exec` hosting the `shouldercut-fx` MCP server, writing WGSL and issuing edit operations live — and the agent that built the project | Not a code-completion demo: the agent is the product's runtime brain, iterating on real compiler errors through MCP |
| Muse Voice Transcribe | Push-to-talk voice commands, captions, and the silence-removal cross-check | One model serves control input and content analysis on the same endpoint |
| SCAIL-2 / open weights (local) | Character replacement and animation, and VACE masked inpainting, run locally in ComfyUI as `edit_segment` backends | Open-weight models driven from the same agent tool surface as the hosted ones, with a tested-settings repertoire instead of improvised graphs — the Best Open-Weight Build angle |
| Muse Spark | Not used (§13). Muse Code fills the Supervisor role | — |
| Muse Image | Not built: generated plates as shader inputs stay P1 | — |

Budgets (hard rules, enforced in the proxy): spend limit on the API
account set before day 1; mask tracks and transcripts cached so a clip is
analyzed at most once per (hash, prompt); frame thumbnails sent to Spark
capped per session; a worklog of credits spent per feature kept in
`docs/costs.md`. Official prices make credits a non-issue at demo scale
(SAM video $0.20/1,000 frames, Voice Transcribe $0.18/audio hour, Muse
Image $0.01/image); the spend limit guards against runaway loops, not
normal use. Bonus tracks targeted, in order: Best Agentic Use-Case, Best
Open-Weight Build (local SCAIL-2 / VACE behind `edit_segment`), Most
Viral (X post of the demo). Best Creative Build is out: it was tied to
Muse Image, which is not built.

## 9. Performance budgets

- Preview: sustained source frame rate at 1080p with up to 3 stacked
  free-form shader passes (gate S1), else 720p proxy preview with
  full-res export. Arbitrarily expensive agent shaders can still exceed
  budget; the bench must report pass cost back to the agent over time.
- Command latency: effect visible ≤ 2 s after end of speech for cached
  masks; first `track_object` on a clip may take longer and says so.
- GPU memory: ring buffers and ping-pong textures pooled and reused; no
  per-frame texture allocation; bind group per frame only because
  external textures require it.
- Project ceiling for the demo path: clips ≤ 5 min total, ≤ 4K source.
  Larger inputs are accepted but preview drops to proxy automatically.

## 10. Day-by-day plan (Oct 27 – Nov 4)

Admin in parallel on Oct 27: credits already claimed — verify they show
on Billing and that the spend limit is set; join Discord channels,
attend Agents 101 (12:00 ET), request partner credits (Baseten/Modal)
only if a spike shows a use for them.

Revised Nov 2 with what actually landed. The plan held for the shader
core and slipped on voice, which moved to the last build day once the
generative-video detour proved worth the time (§13).

| Day | Planned | Actual |
|---|---|---|
| Oct 27 | Spikes S1–S3, repo + spec, proxy skeleton | **Done, and more**: spikes green in `docs/spikes.md`, render worker (Mediabunny demux, WebCodecs decode, frame-accurate seek, WebGPU present), free-form FX interface, MCP chat POC, SAM masks behind `maskAt()`, true-3D layered space — four planned days in one |
| Oct 28 | Render worker + FX interface hardened | **Done**: FX interface v2, `validate_shader`, injected WGSL stdlib, 16 free params, temporal history feedback |
| Oct 29 | SAM adapter + mask cache | **Done Oct 27**; day spent on the video technique registry and the generative-video POC spec instead |
| Oct 30 | stimm voice service + Supervisor + undo | **Diverged**: Supervisor was already running since Oct 27. Day spent on generative video (async jobs, fal backend, segment + edge control, optimistic working preview) and the first tested ComfyUI workflow (SCAIL-2 character replacement). Voice deferred |
| Oct 31 | FX depth, P0 checkpoint gate | **Done**: raymarching helpers, GPU compute particles, `get_editing_craft`. Gate call: keep the shader layer, drop the stimm/LiveKit voice runtime for push-to-talk (§13) |
| Nov 1 | Editing P0: trim/split/move, silences, captions + SRT | **Done, plus export**: edit graph and all operations, caption cues in the preview, SRT, MP4 export with presets, `describe_frame`, `transcribe_captions`, SCAIL-2 Animation mode and local VACE |
| Nov 2 | Export hardened; name frozen | Export landed Nov 1. Today: name frozen (ShoulderCut), this spec brought current, README made accurate, LICENSE + `docs/costs.md` added, demo path run end-to-end |
| Nov 3 | Feature freeze, demo footage, rehearsal, deployment | Pending |
| Nov 4 | Record 3-min video, submit by 15:00 ET, X post | Pending |

Standing rules: every day ends with the demo path run once end-to-end;
a red demo path stops new features until green.

## 11. Cut order (when time runs out, cut in this order)

1. Muse Image shader inputs. 2. Temporal history/compute extensions to
the FX contract. 3. Filler-word removal, dissolve, caption variants.
4. Reframe presets beyond 16:9 export. Never cut: free-form shader
interface + MCP compile loop, SAM `maskAt()`, voice loop, undo, export,
captions.

Actually cut as of Nov 2: Muse Image plates (1), filler-word removal,
dissolve and caption variants (3), reframe beyond the three export
presets (4), and P2 music-bed ducking. Item 2 was *not* cut — temporal
history and compute particles both shipped. Nothing on the never-cut list
was cut, though the voice loop ships as push-to-talk rather than an open
room (§13).

## 12. Testing and demo

Test status as of Nov 2: **no automated tests are written.** The perf
harness (`tools/bench`) and the dated manual verifications in
`docs/spikes.md` are what exists; every feature was accepted by running
the demo path by hand. This is the largest known gap against the plan
below, and the honest reason is that the build days went to features. If
time remains after the demo is safe, the edit-graph tests are the first
to write, being the cheapest and the ones a judge is most likely to break
live.

Tests (planned):
- Edit-graph operations: unit tests per tool in §7, including invalid-op
  rejection and undo round-trips.
- Shader interface tests: test-authored WGSL snippets (never shipped as
  product effects) covering compile success/failure, stacking, ranges,
  params, and golden-frame output in headless Chrome.
- Perf harness page (from Spike S1) kept in `tools/bench`, run at every
  checkpoint; budgets of §9 are the pass criteria.
- Browser matrix: Chrome and Edge on Windows and macOS. Safari/Firefox
  are best-effort and show a clear "use Chrome/Edge" message if WebGPU
  external textures or hardware WebCodecs are missing.
- Agent eval: the 20-command set from Spike S3 (FR + EN) re-run after
  every prompt/schema change.

Demo (3 minutes, shows only hackathon-built features):
1. Cold open (20 s): raw street clip; spoke command "keep the dancer,
   blur everything else" — effect lands live.
2. The loop (60 s): an unplanned shader prompt ("explosion in the
   middle"), "more", a second stacked shader, "same on the next clip",
   one deliberate "undo that".
3. Full edit (60 s): three clips, silence removal, captions on, one
   agent-written punch-in zoom on a spoken word.
4. Close (40 s): "export vertical" → finished MP4 playing; one sentence
   on the architecture (agents write WGSL live over SAM masks through
   MCP; zero CPU pixel copy).

Submission checklist: public repo link, live URL (or the local-run
decision of §13), video link, team = solo (representative = author),
README with "Built during the hackathon" and a third-party-only
"Pre-existing dependencies" list (no first-party import, §0), LICENSE,
`docs/costs.md` credit worklog, Discord ruling screenshots archived with
the project notes, X post link added after submission.

## 13. Risks and open questions

Risks, ordered: SAM 3.1 video latency/cost makes live tracking sluggish
(mitigated by caching + keyframe fallback); hardware encode missing on a
judge machine (mitigated by startup probe + clear message); voice
round-trip too slow for the "over the shoulder" feel (chat parity path);
credits exhausted by per-frame SAM calls (proxy budgets, cache); scope
of "full editing" eating FX time (cut order §11).

Resolved by documentation (Oct 26): SAM 3.1 contract and pricing (§4
S2); official LiveKit Meta STT plugin exists, French supported (§4 S3).

### Deviations from the plan, and why

- **No stimm, no LiveKit room: voice is push-to-talk** (decided Oct 31).
  The dual-agent pattern buys a spoken acknowledgement while the deep
  agent works. By Oct 31 the Supervisor had been answering chat commands
  for four days and the optimistic *visual* preview
  (`show_working_preview`) already covered the "something is happening"
  job that the fast voice agent was there to do — and it covers it
  better, since the user is looking at the preview, not listening. A
  LiveKit room plus a Python voice host plus a TTS leg was the largest
  remaining piece of plumbing in the plan and the one furthest from the
  product's point. Push-to-talk reaches the same supervisor with the same
  tool parity in roughly thirty lines. Cost: no spoken replies, and a
  held button instead of an open mic. Benefit beyond the time: the
  submission carries no first-party pre-existing dependency at all
  (§0). Reversible — nothing above the tool surface assumes the input
  channel.
- **Muse Code is the Supervisor, not Muse Spark.** The Muse Code harness
  built for the Oct 27 shader POC already hosted MCP, iterated on real
  WGSL compiler errors, and reads frames through `describe_frame`.
  Swapping it for Spark would have re-solved a solved problem; the
  multimodal grounding Spark was wanted for arrived as a tool instead.
- **Generative video was not in the plan at all.** It took most of Oct
  29–30 and two further days of workflow work, on the argument that
  "make this person a robot" is the request a shader can never satisfy
  and a judge is likely to ask for. It is the riskiest part of the demo
  (local 6-minute renders) and is kept behind the optimistic preview and
  the technique registry so it never blocks the live loop.

### Open questions

- Muse Voice Transcribe French quality on real footage (turn-level
  timestamps confirmed; word timestamps do not exist).
- Judge-facing deployment: the app needs the local bridge for `muse
  exec`, ffmpeg and ComfyUI, so a purely static deployment cannot show
  the agent loop. Decide Nov 3 between a hosted preview-only build plus
  the video, and a local-run instruction in the README.
- Whether to show a local ComfyUI generation live in the 3-minute video
  or play a pre-rendered result and say so on screen.

## Appendix A. Sources for §3

- Chrome Developers, "What's New in WebGPU (Chrome 116)": external
  textures from `HTMLVideoElement`/`VideoFrame`, "potentially in a
  0-copy way directly from the source YUV data".
- WebGPU Fundamentals, "Using Video Efficiently": external texture
  lifetime (current JS task), `texture_external`,
  `textureSampleBaseClampToEdge`, no mipmaps.
- Toji.dev, "WebGPU img, canvas, and video textures" (updated 2026):
  import without creating a copy of the video frame; lifetime rules.

## Appendix B. Recovered hackathon facts (from the participant guide)

Two problem statements (Build for Your World / Push the Frontier);
project must incorporate Meta models (Muse Spark series, Muse Wonder,
Muse Image, Muse Voice Transcribe, SAM 3.1 via Meta Model API; Muse
Glimmer / Muse Spark Open as open weights; Muse Code as coding agent).
Repos must be public; teams ≤ 4; demo must highlight only work built
during the event, clearly identified, under penalty of disqualification.
Judging: stage 1 pass/fail on theme fit and real use of Meta tooling;
stage 2 scores Impact, Use of Meta AI Tooling, Technical Depth &
Execution, and Demo on 0–10, equally weighted; top 5 per track to live
finals Nov 9. Indie prizes: $150K/$100K/$75K/$50K/$25K. Bonuses: Most
Viral $20K, Best Open-Weight Build $10K, Community Vote $10K, Best
Agentic Use-Case $5K, Best Creative Build $5K.

