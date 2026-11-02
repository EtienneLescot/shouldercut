# Spike results

## S1 — WebGPU preview bench (Oct 27, 2026)

Bench source: `tools/bench/` (written during the hackathon; assets and
run outputs are local and git-ignored). Run it with
`python tools/bench/run_bench.py` after generating the assets described
in `tools/bench/README.md`.

Environment: Windows, Google Chrome 155 headless, WebGPU adapter
`nvidia/lovelace` (`isFallbackAdapter: false`), NVIDIA GeForce RTX 4070 Ti.
Source clips are synthetic FFmpeg `testsrc2` H.264/yuv420p files, decoded
by the browser and imported with `importExternalTexture`.

Measured chain for every presented frame:

1. ingest + grade from `texture_external` to a GPU render target;
2. 25-tap weighted blur to a second GPU render target;
3. mask-aware compose (foreground sharp, outside blurred/tinted) with
   glow and vignette to the canvas.

Frame intervals and JS submission time are recorded after 30 warm-up
frames. GPU pass durations use WebGPU timestamp queries, sampled every
10th measured frame. The only `mapAsync` in the bench reads those 48
bytes of timestamps; a static scan found no pixel readback API
(`getImageData`, `copyTextureToBuffer`, `drawImage`, bitmap transfer).

| Scenario | fps | JS avg / p95 (ms) | GPU ingest p50 | GPU blur p50 | GPU compose p50 | GPU total p50 / max |
|---|---:|---:|---:|---:|---:|---:|
| 1080p30, video element | 29.99 | 0.30 / 0.40 | 0.048 | 0.371 | 0.072 | 0.499 / 1.676 |
| 1080p, `VideoFrame`, 2x | 59.97 | 0.34 / 0.50 | 0.014 | 0.093 | 0.015 | 0.126 / 0.306 |
| 1080p30, mask upload/frame | 29.96 | 0.35 / 0.50 | 0.042 | 0.304 | 0.044 | 0.397 / 1.524 |
| 2160p30, video element | 29.99 | 0.29 / 0.40 | 0.044 | 0.360 | 0.061 | 0.482 / 9.113 |

GPU sample counts: 15 per 30 fps scenario, 24 at 2x. All runs completed
with zero page faults and only the bench completion message in console.
Canvas screenshots were inspected: the procedural and uploaded masks
both keep the masked region sharp/brighter while the outside is blurred
and tinted.

### Reading

- The blur is the dominant measured pass in every scenario, as expected
  for a 25-tap full-frame filter. Even so, median total measured GPU
  pass time stays around 0.5 ms against a 33.3 ms frame budget at 30 fps
  on this GPU.
- Uploading a fresh 480x270 R8 mask every frame changed JS submission
  from 0.30 ms to 0.35 ms on average and did not reduce fps at 1080p30.
  That makes streamed SAM mask textures affordable at analysis
  resolution; production code will still upload only on new mask frames.
- The 2x `VideoFrame` run sustains essentially 60 fps, but its lower GPU
  pass times are not directly comparable to the 30 fps runs: GPU clock
  state and presentation pacing differ under sustained load. Treat it as
  headroom evidence, not a pass-cost estimate.
- One 4K sampled frame reached 9.11 ms total. That is an outlier against
  a 0.48 ms median, still below the frame interval, but it is why the
  product keeps a startup hardware probe and a proxy-preview fallback.

### Limits of this spike

- Synthetic flat-colour test footage caches unusually well. Real camera
  footage and the planned temporal/3D effects will cost more.
- Decode uses the browser media element (and `VideoFrame(video)` in one
  scenario), not the frame-accurate demux + `VideoDecoder` path planned
  for the render worker.
- Only Chrome on one discrete NVIDIA GPU was measured. Integrated GPUs
  and judge machines remain covered by the startup probe in the spec.

### Gate decision

S1 passes the budget in SPEC §9 for three shader passes on the
development machine. Architecture primary remains hosted Chrome/Edge
WebGPU. Next integration step: render worker with demux/decode and
frame-accurate seeking, re-running this bench against real footage.

## Live API checks (Oct 27, 2026)

- `GET /v1/models` returned `sam-3.1`, `muse-spark-1.3`,
  `muse-voice-transcribe-1.0`, and `muse-image-1.0` for this account.
- SAM image segmentation returned an exact test-object box and mask,
  first streamed delta at 1.13 s. SAM video through the Files API
  returned 25 frame lines for a 30-frame clip, first delta at 3.55 s
  after the request and 50 billed frames. Consequence: upload once per
  clip, cache the `file_id`, and show first-frame segmentation while a
  video track streams.
- Muse Voice Transcribe file transcription returned an exact 3.6 s test
  command in 1.62 s with turn-level `startMs`/`endMs`. Word timestamps
  are not available; caption cues are derived from turns.

## Render worker verification (Oct 27, 2026)

Implemented in `src/render/render-worker.ts`: Mediabunny demuxes the
selected file and supplies the track `VideoDecoderConfig`; project code
owns the `VideoDecoder`, packet feeding from the preceding verified key
packet, decoded-frame queue, playback clock, seek/step logic, and WebGPU
presentation of each `VideoFrame` through `importExternalTexture`.

Verified in headless Chrome on the RTX 4070 Ti with a synthetic
1920x1080, 30 fps, 12 s H.264 file, driven only through the page UI:

- load presents frame timestamp 0.000000 (index 0);
- play then pause lands on frame 1.400000 (index 42);
- Frame + lands on 1.433333 (exactly +0.033333), Frame - returns to
  1.400000;
- numeric Seek to 7.2 lands on frame timestamp 7.200000 (index 216),
  and Seek to 2 lands on 2.000000 (index 60);
- canvas screenshots independently show the source-burned timecode and
  frame counter at 7.200/216 and 2.000/60;
- decoder state reported `avc1.640028 1920x1080`, hardware acceleration
  `prefer-hardware`; no page errors or failed requests.

Two implementation lessons are baked into the worker: seek must close
decoded frames earlier than the current candidate as soon as a later
frame exists, and packet feeding must respect `decodeQueueSize`
backpressure. Retaining every frame from a keyframe or flooding the
decoder stalls output.

Current limits: primary video track only, no audio path yet, present
pass only (FX chain comes next), no rotation/pixel-aspect transform in
the presenter yet, and long-GOP seeks still decode forward from the
preceding key packet by design.

## Free-form shader POC (Oct 27, 2026)

Supersedes any catalog reading of this file: ShoulderCut ships no
built-in effects. The contract lives in `docs/fx-interface.md`.

- Render worker now compiles agent-supplied WGSL at runtime
  (`fn fx(ctx: FxContext) -> vec4f`), runs effects as ordered passes
  over GPU work textures, and returns real compiler errors to the
  caller. Explicit bind-group layouts keep unused helpers
  (`originalAt`, `maskAt`) addressable in every shader.
- `server/shouldercut-mcp.mjs` exposes that surface over MCP
  (`apply_shader_effect` blocks on the browser compile result). The
  Vite bridge (`server/bridge.ts`) relays between browser, MCP server,
  and a Muse native harness started as
  `muse exec -c mcpServers.shouldercut-fx=...` in an empty agent
  workspace. Config lessons: address one server per `-c` key, never
  the whole map; literal `env` values are refused as secret leaves, so
  the MCP server defaults to the local bridge URL.
- End-to-end UI test: drag/drop-equivalent file load, seek to 1.400 s,
  chat message "Rajoute-moi un effet d'explosion au milieu". Muse
  answered in French, created effect `explosion-center` (4,435 chars
  of WGSL, range 1.40–2.90 s), compilation succeeded, and a screenshot
  at 2.075 s shows the generated explosion composited at frame center
  over the source. No console errors.
- A direct bridge compile of a throwaway test shader also passed
  before the agent run, isolating interface correctness from agent
  behaviour.

Limits of the POC: single fragment pass per effect (no temporal history
or compute yet), `maskAt()` returns 1.0 until SAM tracks are wired,
chat runs one local Muse process per message in a dev-only bridge,
and expensive agent shaders are not yet cost-metered back to the agent.

## SAM masks behind `maskAt()` (Oct 27, 2026, resumed session)

Contract recovered live (the Oct 27 spike scripts were throwaway):

- Image: `POST /v1/responses`, `model=sam-3.1`, `stream:false`, one
  message with `input_text` + `input_image` (data URL). The prompt must
  be a short bare noun phrase (`red rectangle`); a `Segment: ...`
  sentence silently returns empty text on some inputs.
- Video: `POST /v1/files` with `purpose=user_data`, then `POST
  /v1/responses` with `stream:true` and `input_video {file_id}`. Output
  streams one line per frame: `<Nf>id<|box;...|><|mask;x=0;y=0;data=H,W,
  payload|>`. The payload is Meta's range-coded base85 mask format
  (`~` lossless, `!` one_bit); decoding uses the declared
  `@meta-sam/parser` package server-side. Synthetic static clips can
  return an empty track; real footage works.
- Wiring: bridge `POST /api/sam/track` (browser uploads its clip once;
  Meta `file_id` cached by content hash) and MCP `track_object` (bridge
  asks the browser to upload, blocks until masks land). Masks are
  expanded box-local → full-frame at ≤640 px wide, broadcast to the
  page, and uploaded per frame into an `r8unorm` texture sampled by
  `maskAt()` in the render worker.

Verified: `POST /api/sam/track` on the SAM example clip (`bedroom.mp4`,
prompt `pillow`) returns 200 mask frames at 960×540. Headless-Chrome
end-to-end: load clip → Track object → mask shader
(`mix(grayscale, colour, maskAt(uv))`) compiles → screenshot at 3.0 s
shows the tracked pillow in colour with the rest of the room
desaturated. `npm run build` green.

## True-3D layered shader space (Oct 27, 2026)

Note on prior art: openscreen's compositor projects the flat video
plane with perspective (tilted quads, 3D rotation presets for zoom
regions) — geometric projection of one plane, not a layered scene.
That know-how informed this design; the code below is written fresh
for the WebGPU worker.

- The FX contract gains a world: background frame on plane `z=0`,
  tracked foreground on an agent-chosen nearer plane. `layerUv(uv, z)`
  intersects the per-pixel camera ray with plane `z` (real perspective
  divide, not a 2D offset), `foreAt`/`backAt` sample the layers.
- Each effect may carry `camera {from, to, fov}`; the host eases the
  position across the effect range, aims at the origin, and fills
  `ctx.camOrigin/camRight/camUp/camForward/tanHalfFov/aspect` uniforms.
  No camera = identity camera, existing 2D shaders unaffected.
- Verified headless: `bedroom.mp4` + `pillow` track + parallax shader
  (foreground plane `z=0.35`, camera `[0,0,3] → [0.45,0.12,1.85]`,
  fov 38). Before/after screenshots at 3.0 s show the push-in and
  lateral shift with the pillow layer displaced against the room.
  `npm run build` green.

## Full demo path, end to end (Nov 2, 2026)

First run of the whole demo path in one session since export and voice
landed. Browser pane (Chromium, WebGPU on an NVIDIA Lovelace adapter),
`npm run dev`, Muse Code 1.4.14, real Meta Model API keys. Source:
`demo-a.mp4`, the stock hill/woman clip, 960×540, 24 fps, 6 s, no audio.

**PASS — load and decode.** Drag-drop → Mediabunny demux → WebCodecs
`avc1.64001f`, hardware decode, first frame presented, clip joins the
edit graph (`1 clip(s) - 6.00 s total`).

**PASS — free-form shader from chat.** "Rajoute-moi un effet
d'explosion au milieu" → the agent wrote and compiled WGSL with a
turbulent fireball, flash, shockwave and 3,500 GPU particles over
2.3–5.2 s, then seeked the preview to the peak on its own. ~60 s from
send to visible.

**PASS — SAM mask + shader, the demo cold open.** "Enleve l'explosion.
Floute l'arriere-plan et garde la femme nette." → the agent removed the
first effect, tracked `woman` (144 frames, the whole clip) and wrote a
masked blur. Subject sharp, background defocused. ~60 s. Mask edges
carry a visible soft halo around hair and trailing arm; acceptable at
demo scale, not a matte.

**PASS — push-to-talk voice.** No mic available in this session, so a
French command was synthesised locally (Windows SAPI, `fr-FR`
Hortense), encoded to webm/opus and posted to `/api/voice/command`, the
exact endpoint the Talk button hits. "Ajoute un flash lumineux à la fin
du clip" transcribed as *"Ajoute un un flash lumineux à la fin du
clip."* — one duplicated word, intent intact — and the supervisor
applied a white flash over 5.1–6.0 s, verified visually at the 5.35 s
peak. Round trip **37 s**, against the §9 budget of ≤ 2 s. The cost is
the agent turn, not transcription. Clean TTS speech is an easy case:
the §12 20-command FR/EN eval on real speech is still unrun.

**FIXED — `1080p` export preset letterboxed every sub-1080p source.**
`scale=min(1920\,iw):min(1080\,ih)` evaluates to the source size for
anything smaller than 1080p, so a 960×540 clip was padded into a
1920×1080 black frame as a centred postage stamp. Dropped the `min()`;
`force_original_aspect_ratio=decrease` already does the fit. All three
presets now fill the frame: 1920×1080, 1080×1920, 1080×1080, verified
by ffprobe and by eye on an extracted frame.

**OPEN, blocking the demo close — exports contain no shader effects.**
`EditGraph.exportMp4` runs ffmpeg straight over the stored source files
(`clipFilePath(clip.hash)`), applying trims, the scale/crop preset and
burned-in captions. The WGSL effects live in the render worker and are
never rendered into the file; there is no `VideoEncoder` anywhere in
the codebase. Verified: exported a frame at 2.75 s with the masked blur
active in the preview — the frame is raw source. The demo's closing
beat ("export vertical" → finished MP4) would therefore play back a
video with none of the effects the demo is about. Fixing it means
rendering the pass chain in the worker and encoding with
`VideoEncoder`, which is a real piece of work, not a patch.

**Noted, not fixed:**
- `describe_frame` returns the decoded *source* frame, deliberately
  (`render-worker.ts:1459`: swapchain readback races presentation), so
  the agent can never see its own effect. SPEC §7 calls it "read-only
  visual context", which hides this.
- The edit graph is in-memory only. The vite dev server restarts when
  `server/*.ts` changes and the whole project document is lost; clip
  bytes survive in `server/clip-store` because they are keyed by hash.
  No persistence, despite SPEC §6 calling the project "one JSON
  document, versioned, exportable, diffable".
- The chat panel renders agent replies as plain text, so the Muse
  `**Fait**` prefix shows its asterisks on screen.

## GPU export: shaders baked into the file (Nov 2, 2026)

Closes the blocking gap found earlier today. ffmpeg on the server only
ever had untouched source files, so exports carried none of the
agent's effects. The render worker now does the pixel work and the
server keeps doing what it already did well.

- **Worker** (`exportRange`): seeks to the clip's `in`, walks the decode
  queue frame by frame to `out`, presents each frame through the full
  effect chain, and feeds the canvas to Mediabunny's `CanvasSource`
  (`avc`, 12 Mbps) into an `Mp4OutputFormat` over a `BufferTarget`.
  Frame indices come from the same `displayFrame` path as playback, so
  SAM mask tracks line up exactly as they do in the preview.
- **Transport**: bridge broadcasts `export-render-request`, the page
  picks the range from its active clip (it alone knows which clip is
  loaded), and posts the MP4 back to `/api/export/render-result` as a
  raw body — megabytes are too much for base64 in JSON.
- **Server**: `exportMp4(preset, renders)` takes video from the render
  (already trimmed) and audio from the source clip, then runs the same
  scale/crop preset, concat and burned-in captions as before.
- Mediabunny was already the declared muxer in SPEC §5 and already a
  dependency; `VideoEncoder` is reached through it rather than by hand.

Verified end to end: an invert shader over the whole clip exports as an
inverted 1920×1080 MP4; the agent-written SAM-masked blur exports
vertical with the subject sharp and the background blurred, and the
sharp region **follows her** between 1.0 s and 5.0 s, so mask frame
alignment survives the offline path. 144 source frames render, encode,
mux and re-encode in **3 s**.

Limits, deliberate:
- Only the clip loaded in the editor is rendered. A multi-clip project
  exports its other clips straight from source, because the effect model
  has no clip ownership (SPEC §6) — effects carry a time range, not a
  clip id.
- The render is at source resolution; the preset scales afterwards, so
  a 960×540 source still upscales softly into vertical 1080×1920.

**First automated test in the repo**: `npm test`
(`tools/test-export.ts`, run with node's native type stripping, no
framework). It builds solid-colour clips with ffmpeg and samples one
pixel of the export. Both regressions were mutation-checked: restoring
the `min()` letterbox makes it fail with `corner was rgb(0,0,0)`, and
ignoring the renders map makes it fail with `centre was rgb(253,0,0)`.

## Interface pass and the Muse mascot (Nov 2, 2026)

The UI had been a stack of debug panels. It is now one screen with one
control, because the product's claim is that you talk and it cuts.

- **One state drives everything.** `document.body.dataset.ui` holds
  `idle | listening | thinking | done | error`. CSS reads it for the
  accent colour, the button, the frame treatment; the mascot reads it
  for behaviour. Nothing animates from JavaScript per frame except the
  mic meter, which writes a single `--level` custom property.
- **The Talk button is the product.** Breathing ring when idle; while
  listening, the ring and halo scale with the live microphone envelope
  from an `AnalyserNode` and two concentric pulses radiate; while Muse
  writes WGSL the ring becomes an orbiting arc; on success the core pops
  and a light sweep crosses the picture. A scrim under the dock keeps
  all of it legible over blown-out footage.
- **Everything else is behind one button.** Project, playback,
  transcript, tracking, shaders and export moved into a drawer, closed
  by default. Every element id the app already queried is still in the
  DOM, so none of the existing wiring changed.
- **Muse**, the mascot, is Three.js built from primitives — no model
  file, no loader, no asset to ship (`src/mascot.ts`). Rounded shell,
  sunk visor, two emissive eyes, an antenna bulb that carries the state
  at 90 px, and a work ring that only appears while editing. Idle: it
  picks a new place to look every 1–3 s and holds it, blinks on a random
  interval, floats. Listening: locks forward, eyes brighten, antenna
  pulses with the mic. Thinking: head down, eyes narrowed, ring
  orbiting, faster bob. Done: a nod.
- Agent replies surface on a single line over the video, with the
  `**Fait**` header stripped, rather than only in the transcript.

Verified in the browser pane at 1024 px and at 375 px: idle, listening
and thinking all read correctly, the drawer opens over the stage, and a
real agent command (`"ajoute un halo doré chaud autour de la femme"`)
runs through thinking → done with the shader landing in the preview.
`npm run build` green. Three.js adds ~540 kB to the main bundle, which
is a local demo app's problem to ignore.

Correction to this morning's entry: the push-to-talk path **does** speak
its reply — the browser's own `speechSynthesis` says the first sentence.
What was dropped with stimm is Meta TTS, not spoken confirmation.
