# ShoulderCut — Product & Technical Specification

Meta Global AI Developer Hackathon, Indie Developer track.
Building period: Oct 27 – Nov 4, 2026. Submission deadline: Nov 4, 21:00 ET.
Problem statement: **Build for Your World**.

Working title: ShoulderCut. Rename allowed until Nov 2, no code depends on it.
This document is a planning artifact written on kickoff day (Oct 26). It is
kept outside the submitted repository until Oct 27, then committed as the
first document of the new public repo.

## 0. Compliance frame (non-negotiable)

- New public repository, created on or after Oct 27. All submitted code is
  written from scratch during the building period.
- No code is copied from the author's existing repositories. They are the
  knowledge base; every brick is rewritten from scratch during the event:

  | Repo | Knowledge reused | Rewritten here as |
  |---|---|---|
  | openscreen | Native GPU compositor (Rust, D3D11VA/Metal/wgpu), code-first renderer interfaces, decode/encode pipeline | WebGPU/WGSL render worker, free-form FX code interface, WebCodecs pipeline (§3, §5) |
  | muse-desktop | Coding-agent runtime, Muse Code integration, MCP hosting | Agent service and tool plumbing (§5, §7), MCP server |
  | stimm | Optimistic voice UI: fast voice agent + deep supervisor on LiveKit | Imported, see below; only the supervisor and adapters are written here |

  Reading those repos for concepts, interfaces, and known pitfalls is
  allowed; copying code out of them is not. Agents get this spec plus
  concept notes, and write new implementations.
- Organizer rulings obtained on Discord (#questions, Oct 26): rewriting
  from scratch while reusing know-how is compliant with "new work only";
  importing own previously published MIT packages is allowed if properly
  declared (confirmed by Cerebral Valley staff).
- **stimm is imported**, as that declared pre-existing MIT dependency:
  Python `stimm` (pin the version, current line 0.1.x) and TypeScript
  `@stimm/protocol`. It is listed under "Pre-existing dependencies" in
  the README and never presented or demoed as hackathon work. What is
  built during the event around it: the editing Supervisor and the
  stimm ↔ edit-graph tool bridge. No STT adapter is needed: LiveKit
  ships an official Meta plugin (`livekit-agents[meta]`,
  `meta.STT`, verified Oct 26, §13).
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
Voice later runs on stimm's dual-agent pattern (imported, §0): a fast
voice agent acknowledges and speaks immediately while the deep agent
reasons and issues edit/shader operations in parallel.

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
- Chat first (Muse native harness over MCP, POC done Oct 27),
  then voice through stimm with the same tool surface.

Demo prompts will showcase range, not features: an explosion at the
center, an object isolation using a SAM mask, and a parallax push are
things the agent writes on request, not entries shipped in a catalog.
Temporal history textures and compute passes extend this same contract
later; they are host capabilities, still not catalog effects.

P1: backdrop plates generated with Muse Image as shader inputs,
9:16 / 1:1 reframing expressed through the same code interface.
P2: music-bed ducking.

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

One screen: large preview canvas, clip strip with a minimal timeline
readout, live voice (browser microphone in a LiveKit room via stimm,
push-to-mute, spoken confirmations), transcript and agent reply line,
before/after hold-to-compare, undo/redo, export. Chat input mirrors voice
for noisy rooms and for the demo backup path. No settings pages, no
effect browser panels: effects are requested, not browsed.

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
Still to run live: the realtime stimm loop and Muse Spark tool-calling
validity (method below). Verified: `stimm` +
`livekit-agents[meta]` import cleanly together; the official LiveKit
Meta plugin exposes `meta.STT` (model `muse-voice-transcribe-1.0`,
realtime WebSocket, PCM16 24 kHz, cumulative interim transcripts,
server-side endpointing, `language_bias` including French, 60 min
session cap). No adapter to write. Remaining questions: caption
timestamp quality (file transcription path), and Muse Spark
tool-calling validity as stimm Supervisor.
Method (Oct 27): run imported stimm locally (LiveKit dev server,
uv-managed project-local `.venv`), transcribe a 60 s clip (caption
timing error vs. spoken words), speak 20 commands in French and English
through the stimm loop into Muse Spark with the tool schemas of §7,
score valid-op rate and perceived latency (fast voice agent
acknowledgement vs. effect actually applied).
Pass: effect applied under ~2 s perceived, ≥ 18/20 commands become valid
operations without repair.
Fallback: push-to-talk with post-stop transcription; chat input as the
primary demo path; stricter op validation with one repair round trip.

## 5. System architecture

Decision gate at end of Oct 27: if S1 passes, the product is a hosted web
app (compute runs on the visitor's GPU; hosting is static files plus the
proxy). The fallback ladder never changes the edit graph, tool schemas,
or UI — only the execution host of the renderer:

1. Hosted web app, Chrome/Edge desktop (primary).
2. Same web app at proxy preview resolution + offline 1080p export.
3. Same web app inside a thin local shell for filesystem access and a
   native encoder, renderer unchanged.

Components, all written during the event except the imported stimm
runtime (declared, §0):

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
- **Agent harness**. POC (Oct 27): the local bridge runs Muse Code
  CLI (`muse exec`) in an empty agent workspace with only the
  `shouldercut-fx` MCP tools instructed for shader work. The same MCP
  surface is the product contract; Muse Spark as stimm Supervisor can
  host it next without changing the shader interface. The agent emits
  WGSL and validated edit operations; it never touches pixels directly.
  Runtime/MCP hosting concepts come from muse-desktop know-how,
  rewritten here.
- **SAM adapter**. Hides the SAM 3.1 API behind `trackObject(clipRef,
  prompt, timeRange) → MaskTrack`. Mask tracks are cached client-side
  (OPFS/IndexedDB), keyed by clip hash + prompt + range.
- **Voice service (imported stimm)**. Python host app (new code,
  uv-managed project-local `.venv`) running the stimm `VoiceAgent` on
  LiveKit: VAD → STT via the official LiveKit Meta plugin
  (`livekit-agents[meta]`, `meta.STT`, Muse Voice Transcribe) → fast
  acknowledgement → TTS spoken confirmation; `@stimm/protocol` connects
  it to the Supervisor. The web app joins the LiveKit room for mic and
  audio out. Clip audio for captions and silence cross-check uses Muse
  Voice Transcribe file transcription via the proxy ($0.18 per audio
  hour, same price as streaming).
- **Proxy** (small Node service). Holds Meta API keys, enforces per-session
  budgets, logs credit spend, streams responses when supported.
- **MCP server (`shouldercut-fx`, P0)**. Node/stdio MCP server exposing
  video state, shader apply/list/remove/clear, seek, and play/pause to
  any coding-agent harness. Shader compilation is relayed to the
  connected browser and its result blocks the tool call, so the agent
  iterates on real WGSL errors. Edit-graph tools join the same server.

## 6. Edit graph and data model

A project is one JSON document, versioned, exportable, diffable:

```
Project   { version, clips: Clip[], settings }
Clip      { id, sourceRef, sourceHash, in, out, effects: Effect[], captionsRef }
Effect    { id, name, code: WGSL source, params: vec4, enabled, range, maskTrackId? }
MaskTrack { id, clipId, prompt, model: "sam-3.1", frames: MaskFrameRef[] }
MaskFrame = RLE-encoded single-channel mask + bounding box, in OPFS
```

Rules:
- Effects apply in list order. The renderer compiles the enabled list for
  the current frame into a pass chain; parameter changes recompile
  uniforms, not pipelines, wherever possible.
- Every user-visible change is an operation on this document and appends
  to an undo stack with a human label ("shader 'explosion' on clip 2").
- Masks are stored at analysis resolution (≤ 540p), upsampled in-shader
  with edge feather. A mask track may be keyframed (every N frames) with
  GPU-side interpolation if Spike S2 lands on the fallback.
- The document is the only thing the agent can change. Project file =
  edit graph JSON + mask cache index; sources are re-linked by hash.

## 7. Agent tools (MCP contract)

The agent sees exactly these tools. Names and fields are the contract;
validation rejects anything else and feeds the error back once.

| Tool | Inputs | Effect on graph |
|---|---|---|
| `apply_shader_effect` | id, name, WGSL code (`docs/fx-interface.md`), params, range | compile live; append/replace Effect only on success |
| `list_shader_effects` / `remove_shader_effect` / `clear_shader_effects` | effectId where relevant | inspect or delete shader Effects |
| `get_video_state`, `seek_video`, `set_playing` | time / boolean where relevant | observe and position the preview |
| `track_object` | clipId, text prompt or click point, range | create MaskTrack via SAM |
| `trim_clip` / `split_clip` / `move_clip` / `delete_clip` | clipId, times or index | timeline structure |
| `remove_silences` | clipId or project, threshold | cut ranges from analysis |
| `set_captions` | clipId, style, on/off | caption layer + SRT data |
| `undo` / `redo` | steps (default 1) | graph history |
| `export` | preset (`1080p`, `vertical-1080x1920`, `square`) | render + mux |
| `describe_frame` | clipId, time | read-only visual context for the agent |

Conversation state kept server-side per session: current clip, last
effect touched, last object tracked, so "more", "same on the other clip",
and "undo that" resolve without re-asking. The agent's spoken/text reply
is one short confirmation naming the operation it performed. If a command
is ambiguous between two visible objects, the agent asks one question
instead of guessing.

## 8. Meta tooling map (what the judges score)

| Meta tool | Role in product | Beyond-basic evidence |
|---|---|---|
| SAM 3.1 | Object masks + boxes behind `maskAt()` for agent shaders | Masks feed free-form shaders, not a viewer; the agent can invent tracked parallax, trails, isolation, or anything else from the same mask input |
| Muse Spark | Planned Supervisor host for the same MCP tool surface | Multimodal grounding: sampled frames resolve spoken references into SAM prompts; multi-step edits in one command |
| Muse Voice Transcribe | Voice commands (STT inside imported stimm) + captions + silence detection | One model serves control input and content analysis; stimm itself is pre-existing plumbing, declared and not scored |
| Muse Code | Builds the project and is the POC shader-agent harness (`muse exec` + MCP) | The Oct 27 explosion POC was written by Muse through `shouldercut-fx` |
| Muse Image (P1) | Generated plates as future shader inputs | Creative bonus angle |

Budgets (hard rules, enforced in the proxy): spend limit on the API
account set before day 1; mask tracks and transcripts cached so a clip is
analyzed at most once per (hash, prompt); frame thumbnails sent to Spark
capped per session; a worklog of credits spent per feature kept in
`docs/costs.md`. Official prices make credits a non-issue at demo scale
(SAM video $0.20/1,000 frames, Voice Transcribe $0.18/audio hour, Muse
Image $0.01/image); the spend limit guards against runaway loops, not
normal use. Bonus tracks targeted, in order: Best Agentic Use-Case,
Most Viral (X post of the demo), Best Creative Build (only if Muse Image
lands).

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

| Day | Build goal | Demoable at day end |
|---|---|---|
| Oct 27 | Spikes S1–S3, repo + this spec committed, proxy skeleton | Spike verdicts written in `docs/spikes.md`, architecture frozen |
| Oct 28 | Render worker + free-form FX interface hardened (done early Oct 27: decode/seek, dynamic WGSL chain, MCP chat POC) | Agent writes and compiles an unplanned shader live from chat |
| Oct 29 | SAM adapter + mask cache wired behind `maskAt()` | "Blur the background" works end-to-end: agent tracks, then writes its shader |
| Oct 30 | stimm voice service (import + LiveKit Meta STT plugin) + Supervisor host + tool validation; undo | Same commands by voice, spoken confirmations, corrections ("more", "undo") |
| Oct 31 | FX interface depth: temporal history input, pass-cost feedback, multi-clip effect placement; P0 checkpoint | **Shader layer complete or cut P1 (gate)** |
| Nov 1 | Editing P0: trim/split/move, silence removal, captions + SRT | A 3-clip project edited by voice alone |
| Nov 2 | Export pipeline hardened (HW encode, mux, presets); P1 if green (`reframe`, MCP server) | Exported MP4 matches preview; name frozen |
| Nov 3 | Feature freeze. Demo footage shot, demo script rehearsed, README "Built during the hackathon", live deployment | Full rehearsal recorded as dry run |
| Nov 4 | Record final 3-min video, submit by 15:00 ET, post demo on X (Most Viral), last office hours if blocked | **Submitted**, 6 h before deadline |

Standing rules: every day ends with the demo path run once end-to-end;
a red demo path stops new features until green. Workshops Oct 28 and
Oct 30 are watched only for content touching open questions (§13).

## 11. Cut order (when time runs out, cut in this order)

1. Muse Image shader inputs. 2. Temporal history/compute extensions to
the FX contract. 3. Filler-word removal, dissolve, caption variants.
4. Reframe presets beyond 16:9 export. Never cut: free-form shader
interface + MCP compile loop, SAM `maskAt()`, voice loop, undo, export,
captions.

## 12. Testing and demo

Tests:
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

Submission checklist: public repo link, live URL, video link, team =
solo (representative = author), README with "Built during the hackathon"
and "Pre-existing dependencies" (stimm pinned version first in that
list), LICENSE kept, Discord ruling screenshots archived with the
project notes, X post link added after submission.

## 13. Risks and open questions

Risks, ordered: SAM 3.1 video latency/cost makes live tracking sluggish
(mitigated by caching + keyframe fallback); hardware encode missing on a
judge machine (mitigated by startup probe + clear message); voice
round-trip too slow for the "over the shoulder" feel (chat parity path);
credits exhausted by per-frame SAM calls (proxy budgets, cache); scope
of "full editing" eating FX time (cut order §11).

Resolved by documentation (Oct 26): SAM 3.1 contract and pricing (§4
S2); official LiveKit Meta STT plugin exists, French supported (§4 S3).
To resolve at workshops / Discord office hours:
- Muse Voice Transcribe French quality on real footage (turn-level
  timestamps confirmed; word timestamps do not exist).
- LiveKit self-hosted vs. Cloud for the judge-facing deployment.
- Muse Spark tool-calling format and image input limits for frame
  thumbnails.

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

