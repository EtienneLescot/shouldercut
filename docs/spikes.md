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
