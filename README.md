<div align="center">

<img src="docs/media/mascot.gif" width="160" alt="Muse, the editor, at her desk" />

# ShoulderCut

### Your video editor, standing over your shoulder. You talk, it cuts.

**Meta Global AI Developer Hackathon** · Indie Developer track · *Build for Your World*

![The editor with a SAM 3.1 cutout applied to the subject](docs/media/editor.jpg)

</div>

---

Most editors make you learn where everything is. This one you just talk to.

Say *"cut out the subject and put a red jacket on her"* and Muse — the small
figure up there, who turns round when you speak and keeps working when you
don't — tracks the subject with **SAM 3.1**, writes the shader herself, and
hands the segment to whichever generation backend is reachable. There is no
effects catalogue: **every effect is WGSL the model authors on the spot**,
compiled live in your browser.

| | |
| --- | --- |
| **Talk, don't hunt for menus** | A realtime voice session, or type in the same box. She answers while an edit is still running. |
| **The subject, not the frame** | SAM 3.1 masks drive every effect and every replacement, so the rest of the picture is untouched. |
| **Effects written, not chosen** | No catalogue. Muse Wonder writes WGSL against a documented interface, and a failed compile never breaks the preview. |
| **Free on your GPU, or hosted** | Local ComfyUI costs nothing. No GPU? The same request routes to fal.ai. Measured: $0.00 to $4.56 a pass. |
| **Your footage stays yours** | Local-first by design. No hosted instance, and no API key ever reaches the browser. |

## The Meta models, and what each one does

One `MODEL_API_KEY`, four services, each doing a distinct job:

| Model | What it does here | Where |
| --- | --- | --- |
| **SAM 3.1** | Segments and tracks a subject from a plain noun phrase. The mask is what makes "her jacket" mean her jacket. | [`server/sam.ts`](server/sam.ts) |
| **Muse Wonder** | The editor itself: reads the instruction, picks the tools, writes the WGSL. | [`server/muse-runner.ts`](server/muse-runner.ts) |
| **Muse Spark** | The conversation. Small and fast, so she can talk over a long render. | [`server/conversation.ts`](server/conversation.ts) |
| **Meta ASR** | Speech to text, for captions and for the recorded-instruction fallback. | [`server/transcribe.ts`](server/transcribe.ts) |

## Where to read more

| | |
| --- | --- |
| [docs/SPEC.md](docs/SPEC.md) | The specification, kept current with the build |
| [docs/fx-interface.md](docs/fx-interface.md) | The WGSL contract Muse writes against |
| [docs/operations.md](docs/operations.md) | What runs, what it costs, who pays |
| [docs/remote-access.md](docs/remote-access.md) | Letting someone else drive your editor |
| [docs/dogfooding.md](docs/dogfooding.md) | The harness that measures every backend |
| [docs/demo-script.md](docs/demo-script.md) | The three-minute demo, line by line |
| [AGENTS.md](AGENTS.md) | How changes get made here: fix the class, never the case |

Status: submitted 4 November 2026, feature-complete on the P0 scope, every
check green — 47 node tests, 19 python tests, a clean typecheck and a green
build.

## Run it

ShoulderCut is a local-first desktop tool, on purpose: it holds your footage
on your machine, runs ffmpeg there, and can drive a ComfyUI on your own GPU
so that generation costs nothing. There is no hosted instance to sign into,
and no API key ever reaches the browser.

**You need:** Node 22+, `ffmpeg` and `ffprobe` on PATH, and — for voice
only — [uv](https://docs.astral.sh/uv/). An NVIDIA GPU with
[ComfyUI](https://github.com/comfyanonymous/ComfyUI) is optional: without
one, generation runs on hosted providers instead.

```bash
git clone https://github.com/EtienneLescot/shouldercut && cd shouldercut
npm install
cp .env.example .env     # then fill in the keys below
npm run demo
```

`npm run demo` starts the editor on 5173 and, if configured, the LiveKit
server and the voice worker, then prints the URL. `npm run dev` starts the
editor alone.

### Which keys, and which you can skip

Every key goes in `.env`, which is gitignored. `.env.example` lists them all
with a comment each.

| Key | Needed for | Where |
| --- | --- | --- |
| `MODEL_API_KEY` | **Required.** SAM 3.1 masks, voice commands, captions | Meta Model API |
| `MUSE_API_KEY` | **Required** unless the Muse CLI is already logged in | Muse |
| `FAL_KEY` | Hosted generation. Skip it if you run ComfyUI locally | [fal.ai](https://fal.ai) |
| `ELEVEN_API_KEY` | The mascot's voice | [elevenlabs.io](https://elevenlabs.io) |
| `GOOGLE_API_KEY` | TTS fallback when ElevenLabs is out of quota | [AI Studio](https://aistudio.google.com) |
| `LIVEKIT_*` | Voice transport | LiveKit Cloud, or the local `--dev` server |
| `COMFY_URL` | A ComfyUI that is not on `127.0.0.1:8188` | — |

Typing to the editor needs the first two. Everything else is additive:
no `ELEVEN_API_KEY` means no voice, not a broken app.

### What it costs

Generation is the only thing that bills. Measured by `tools/dogfood.ts` over
one full pass of three clips:

| Backend | Where | One pass |
| --- | --- | --- |
| `vace-local`, `scail`, `scail-animate` | your GPU | **free** |
| `vace`, `wan-animate` | fal.ai | $0.61 |
| `kling-o3` | fal.ai | $2.55 |
| `recast` | fal.ai | $4.56 |

`GEN_DRY_RUN=1` prepares every provider input for real and submits nothing,
which is how the harness stays free.

### Checks

```bash
npx tsc --noEmit      # typecheck
npm test              # 42 node tests
npm run test:voice    # 19 python tests
npm run build
```

## Built during the hackathon

Everything in this repository is written from scratch during the event
(Oct 27 – Nov 4, 2026), except the declared dependencies below. This
section will list each shipped feature as it lands.

- [x] Render worker: Mediabunny demux, direct WebCodecs `VideoDecoder`,
  frame-accurate seek/step, WebGPU presentation from `VideoFrame`
- [x] Free-form FX code interface v2: agent-written WGSL compiled live
  via MCP (`docs/fx-interface.md`); no built-in effects catalog. Injected
  WGSL stdlib (noise/SDF/lighting/blur/compositing), 16 free params,
  temporal history feedback, and `validate_shader` dry-run compiles
- [x] SAM 3.1 mask tracks driving object effects: `track_object` (MCP)
  uploads the clip once via the bridge, SAM 3.1 tracks the prompt, masks
  are decoded server-side and stream into the render worker behind
  `maskAt()`
- [x] True-3D layered space for agent shaders: background/foreground
  world planes (`layerUv`, `foreAt`, `backAt`) with a host-animated
  virtual camera (`camera` move per effect) for real parallax push-ins
- [x] Video technique registry for the agent: 10 researched
  techniques with guidance channels, backends, prices and rankings
  in `server/video-techniques.json`, exposed as `list_video_techniques`
  and `recommend_video_workflow` MCP tools; the supervisor plans
  every generative request through it before spending
- [x] Generative-video POC (spec: `docs/generative-video-spec.md`):
  async `GenVideoProvider` jobs (`generate_shot`, `edit_segment`,
  `get_generation_job`) with a local stub backend and a fal backend,
  segment + ControlNet-style edge-control extraction via ffmpeg, and
  the optimistic working preview (`show_working_preview`): the SAM
  subject in a flat treatment while generation runs
- [x] Distilled editing craft for the agent: `get_editing_craft` MCP
  tool serves one small topic at a time (colour, camera, beat,
  captions), rewritten for WGSL from vidmoat/skills (CC-BY-4.0) in
  `docs/editing-craft.md`; loaded only when a request touches it, so
  taste never taxes ordinary editing
- [x] Full 3D + GPU particles for agent shaders: raymarching helpers
  (`rayDir`, `worldToUv`, SDF/lighting stdlib, camera `target`/`roll`)
  and host-simulated GPU particles (compute `particleInit`/
  `particleUpdate` + billboard sprites in the same world space)
- [x] Edit graph and editing operations (SPEC §6-7): server-side project
  document (clips, in/out trims, captions), agent operations over MCP
  (`get_project`, `trim_clip`, `split_clip`, `move_clip`, `delete_clip`,
  `remove_silences` via ffmpeg silencedetect, `set_captions`, `undo`,
  `redo`), caption cues in the preview overlay, project SRT export, and
  MP4 export (`export_video`: graph order + trims, H.264/AAC, burned-in
  captions, 1080p / vertical / square presets), with the agent's shaders
  **rendered into the file**: the worker replays the clip through the
  same WGSL pass chain as the preview and muxes it with Mediabunny, then
  the server adds the source audio, the preset and the captions.
  Finished generation
  jobs join the graph as clips automatically. Project panel in the UI
  with sequential preview playback across clips
- [x] Tested ComfyUI workflow repertoire for the supervisor:
  `server/comfy-workflows/` (SCAIL-2 character replacement, SCAIL-2
  animation, local VACE inpainting) with fixed tested settings, exposed
  via `list_comfy_workflows` and the `scail` / `scail-animate` /
  `vace-local` backends of `edit_segment`
- [x] Realtime voice integration: LiveKit Cloud transports the selected
  microphone and neural speech output; Meta Muse Voice streams partial
  transcripts into the imported Stimm runtime. A separate editing
  supervisor uses the same MCP tool surface as chat; interrupting speech
  does not cancel its work. ElevenLabs is the preferred voice provider,
  with Gemini as configured fallback or standalone voice. Recorded
  single commands remain available as a fallback
- [x] Supervisor: Muse Code (`muse exec`) hosting the `shouldercut-fx`
  MCP server as its whole tool surface — 31 tools over shaders, masks,
  the edit graph, generation and the technique registry. One harness
  serves chat and voice

- [x] Conversation-first interface: a large video preview, inline play/scrub/time,
  import/export and optional audio settings. Technical readouts and manual tracking
  controls are absent. Anthracite, white and restrained blue take inspiration from
  Meta's Muse Code product page.
- [x] Fast conversation actions share one schema and instruction set between voice
  and text (`shared/conversation.json`). Playback waits for a browser acknowledgement;
  cutout previews run SAM on a 0.25-second sample and display a separate canvas overlay
  that never reaches the export or changes an existing effect's mask. Visual moment
  search inspects 12 chronological samples of the open clip and refines long-clip matches.
  Short events between samples can be missed; a failed search leaves playback unchanged.
  Replacement and other real edits remain queued with the editing specialist, and
  require a full-range track instead of reusing the preview as a complete mask.
- [x] Jolly, the mascot: drawn rather than modelled. `src/mascot.ts` paints
  her on a 2D canvas from paths at runtime -- no sprite sheet, no model, no
  asset to ship. She turns toward you while waiting, waves now and then,
  and works head-down while Muse edits. The generated mesh came first and
  was dropped: photoreal plush fur beside a video editor reads as a product
  shot pasted into the UI, and flat shapes carry the same character while
  saying more about what she is doing. It also removes three.js and a 4 MB
  asset from the page. The character is Meta's; the drawing is ours.
- [x] Two ComfyUI tools written along the way: `comfy-frontend-to-api.py`
  converts an editor-format template into the API format `/prompt`
  accepts, resolving reroutes and bypassed nodes and pruning to the
  outputs you keep; `make-mascot.py` runs the image-to-3D graph end to
  end so the mascot asset is reproducible rather than an opaque binary

Not built, cut deliberately (SPEC §11): Muse Image plates as shader
inputs, dissolve transitions, caption style variants, filler-word
removal, reframing beyond the three export presets, music-bed ducking.

## Pre-existing dependencies

Declared dependencies that existed before the event. They are plumbing,
not hackathon work, and are never presented as built during the event.

- `stimm` (MIT, author's pre-existing published package), pinned to
  commit `5d7316b3513848b1121429a767add183f04f6036` (Oct 10, the same
  revision as the digital-twin example on etiennelescot.fr) —
  LiveKit VoiceAgent/Supervisor orchestration. Imported as infrastructure,
  not presented as hackathon work. The ShoulderCut editing adapter,
  command queue, browser integration, and voice provider wiring are new.
- LiveKit client/server SDKs and Agents plugins (third-party) — WebRTC,
  room dispatch, streaming Meta STT, ElevenLabs and Gemini TTS.

- `mediabunny` (third-party) — media demuxing and `VideoDecoderConfig`
  extraction. Decoding, seeking, buffering, and rendering around it are
  built during the event.
- `@modelcontextprotocol/sdk`, `zod` (third-party) — MCP server plumbing
  for the shader tools.
- `@meta-sam/parser` (Meta, SAM License) — official SAM 3 segmentation
  stream parser and mask codec used server-side by the bridge. The SAM
  adapter, mask expansion, GPU upload, and `maskAt()` wiring around it
  are built during the event.

Jolly, the Muse mascot, is Meta's character, used here as an homage in a
Meta hackathon entry. No Meta artwork is redistributed: she is drawn from
paths at runtime in `src/mascot.ts`. The image-to-3D tooling that produced
the earlier mesh is still in `tools/` and still works; the shipped mascot
simply no longer uses it. ShoulderCut is not affiliated with or endorsed
by Meta.
- Vite and TypeScript (third-party) — build tooling.

External tools invoked, not bundled: `ffmpeg` (segment extraction, edge
control, silence detection, export mux), Muse Code CLI (`muse exec`, the
supervisor), and optionally a local ComfyUI server with the SCAIL-2 and
VACE open-weight models for the local `edit_segment` backends.

## Development

```powershell
npm install
npm run dev
```

See **Run it → Checks** above. The node tests need `ffmpeg` and `ffprobe`
on PATH.

Then open http://127.0.0.1:5173/ in Chrome or Edge, drag in a local
MP4/WebM file, and ask in chat for any effect (for example
"Add an explosion effect in the middle"). The local bridge starts
Muse (`muse exec`) with the `shouldercut-fx` MCP server; the agent
writes WGSL against `docs/fx-interface.md`, and the browser compiles it
live. Muse must be installed and logged in on this machine.

Voice: click **Talk** once, then speak freely. Click the microphone again
to end the call. The selected microphone is shared by realtime voice and
the recorded-command fallback in audio options. Change the microphone between calls.

### Realtime demo

Copy the needed values from `.env.example` into the local `.env`. Meta's
`MODEL_API_KEY` handles realtime Muse Voice transcription; the existing
Muse Code supervisor executes the same MCP editing tools as typed chat.
For speech output, set `ELEVEN_API_KEY` and optionally `TTS_VOICE_FR` to
the cloned voice used on etiennelescot.fr. `GOOGLE_API_KEY` enables Gemini
TTS as a fallback on provider failure/quota exhaustion, or as the primary
voice when ElevenLabs isn't configured. Without a cloned voice id,
ElevenLabs uses a stock voice. No API key is sent to the browser.

```powershell
npm install
npm run demo
```

This starts (or reuses) the editor on 5173 and the Python worker on 8081,
connected to the LiveKit Cloud project configured by `LIVEKIT_URL`,
`LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`. The worker runs locally so
the editing supervisor can control the local browser. It registers as
`shouldercut`; the bridge creates an ephemeral room and explicitly
dispatches that agent, without changing the shared project's room
settings or using its digital-twin agent. `uv` manages the voice
dependencies in `voice/.venv`. For an offline transport test only, set
`LIVEKIT_URL=ws://127.0.0.1:7880`, the dev keys, and `LIVEKIT_SERVER` to
the local LiveKit binary path. The worker's
health endpoint must be ready before a browser room can be allocated.
Stop the launcher with Ctrl+C; it stops only processes it started.

The audio pipeline uses the imported Stimm VoiceAgent and
Supervisor, the official LiveKit Meta streaming STT plugin, and neural
TTS over LiveKit audio tracks. There is no recording upload, ffmpeg
conversion, or one-second jitter buffer in the realtime path. The voice
uses a small Meta Muse Spark conversation call to answer ordinary speech
without launching Muse Code. Only an explicit `enqueue_edit` tool call
enters the sequential editing queue. Status questions and discussion stay
responsive while editing continues. Interrupting playback or replacing a
pending conversational reply does not cancel edits already accepted.
`VOICE_DIALOGUE_MODEL` defaults to `muse-spark-1.2` with minimal reasoning.
Stable partial transcripts can prepare a reply speculatively; speech and
editing wait for the final transcript. A changed transcript discards the
prepared reply, and only the final words reach the editor.
Partial transcripts, errors, voice provider changes, and measured dialogue
and editing durations are sent to the page. The pinned Stimm revision
also fixes completion of streamed speech for both LiveKit readers.

Muse shares the central conversation area below the footage, drawn on a 2D
canvas by `src/mascot.ts`. She turns toward the viewer while waiting, waves
now and then, and works head-down while Muse edits. There is no desk or
laptop. Reduced-motion preferences retain the poses with less motion.

The editing process explicitly uses `MUSE_EDITOR_MODEL=muse-wonder-1.0`,
an empty Muse preset and only the ShoulderCut MCP tools. It reports actual
tool progress, without loading personal skill catalogs or reminder agents.
Object tracking extracts a maximum 12-second, 640-pixel, 12-fps excerpt
before upload; long clips require an explicit range. Masks are remapped
to source time and cleared outside the excerpt. Failed or incomplete SAM
streams are rejected. This prevents a whole-movie SAM request from consuming
the editor's entire timeout. The overall 240-second safety limit remains.
Project clip buttons also reload their registered source after a browser
refresh, without importing duplicate clips.

Hosted VACE edits prepare a neutral-gray subject area before inference,
as required by the [VACE input guide](https://github.com/ali-vilab/VACE/blob/main/UserGuide.md#31-vace-recognizable-inputs).
The SAM mask must match the source clip and cover the requested range.
Draft edits are limited to 5 seconds; shorter VACE inputs are padded for
the model, then the result is trimmed to the requested duration. The
composited result, preserving the original background, joins the project.
Generation progress keeps the mascot working after the LLM turn finishes,
and upload/provider failures are shown instead of leaving a silent wait.

Voice regression checks (no paid API requests):

```powershell
cd voice
uv run python -m unittest test_agent test_dialogue test_tts_health -v
```

Editor, conversation and generation regressions:
`node --experimental-strip-types --test tools/test-editor.ts tools/test-conversation.ts tools/test-generation.ts`.
Inpainting input regression: `node --experimental-strip-types tools/test-inpainting.ts`.
Real checks on Nov 3 also exercised an isolated Muse trim (22 s), a compiled
black-and-white shader, SAM tracking over 2 seconds (5.5 s), invalid-shader
rejection preserving the active effect, and a 6-second 1080p MP4 export whose
decoded pixels were verified grayscale. Direct Spark 1.2 routing checks
took 0.5–1.7 seconds on the tested prompts; this is not an end-to-end audio
latency guarantee. The VACE hosted path is checked separately below;
local ComfyUI and the other hosted generation backends are not covered by that run.

The Nov 3 UX checks also completed a text-only Kling O3 character replacement:
the 3-second result took 205 seconds, including 200 seconds waiting for and
retrieving the provider result. References are optional for Kling O3; models
that require them reject missing inputs before preprocessing. Equivalent live
jobs are reused, temporary previews clear on completion/failure, and existing
SAM tracks are reused for matching subjects and ranges. Reopening the server
restores the project, effects and masks from the ignored `.runtime/session.json`.

Simple, unambiguous playback phrases share conservative local shortcuts between
voice and text. Compound requests and negations still go through Spark. A real
Cloud check measured 1.47 seconds from synthesized speech ending to the first
received response audio, with a 187 ms player action. These are individual test
results, not a latency guarantee. Gemini Flash TTS is configured as a fallback
for Flash Lite; a daily-quota failure respects the provider's retry delay and
does not repeatedly call the exhausted model. Replies remain visible when TTS fails.

Run `npm run diagnostics` to summarize the local latency journals, or
`npm run diagnostics -- --since 2026-11-03T17:35:00Z` to restrict the time range.
The bounded `.runtime/ux-server.jsonl` and `.runtime/ux-voice.jsonl` journals contain
stage durations, trace ids, status and model names, without prompts, transcripts,
media or credentials. `.runtime/` is not committed.

VACE acceptance check, Nov 3: on the same test footage, the original
unprepared input barely changed the subject. With the corrected gray
control video, the subject became an orange astronaut in the inspected
frames at 1.0 and 1.75 seconds. The composited MP4 was exactly 2.000 s at
960×540; the project imported that composited file (verified by content
hash). Outside the mask, mean RGB difference from the source at 1 second
was under 1/255 after encoding. This validates that example, not every
prompt or every frame's artistic quality. The hosted queue added several
minutes, so generation remains asynchronous and visible in the UI.

Cloud acceptance check, Nov 3: `voice/smoke.py` published a synthesized
French command as a real LiveKit microphone, received streaming Meta
transcripts, triggered the Muse/MCP `trim_clip` operation (6-second test
clip: in-point 0 → 1 second), and received audible Gemini confirmation
through the Cloud audio track. The synthetic command was transcribed in
3.88 seconds from its start in the initial acceptance run. That cold Muse
editing harness took 59.9 seconds to finish; ordinary conversation now
bypasses it. Editing itself remains a background operation. The shader
interface is loaded only for requests that actually author WGSL, not for
simple trims or playback. The test clip was removed afterwards.
`smoke.py` executes its spoken command for real; run it only against a
test project with an editor open.
For a speech-only Cloud check, run `uv run python smoke.py "Salut, tu peux
faire quoi ?" --conversation` from `voice/`.

After restarting with Spark 1.2, Cloud checks confirmed the active model
in the session's `ready` event. The greeting/capabilities check started
audio 0.47 s after the final transcript; the pause command took 1.86 s and
successfully reached the editing tools. Total delay after the synthesized
user speech ended was 4.23 s and 2.51 s respectively: Meta's final-turn
transcription delay remains variable. These are observed runs, not an SLA.

Secrets live in a local `.env` file (never committed):

```
MODEL_API_KEY=...        # Meta Model API: SAM 3.1 + Muse Voice Transcribe
MUSE_API_KEY=...         # Muse Code CLI, if not already logged in
FAL_KEY=...              # optional: hosted generative-video backends
COMFY_URL=...            # optional: local ComfyUI (default 127.0.0.1:8188)
GEN_PROVIDER=stub|fal|comfy
```

Credit spend per feature is logged in [docs/costs.md](docs/costs.md).

See [docs/SPEC.md](docs/SPEC.md) for architecture, scope, the
day-by-day plan, and the recorded deviations from it.

MIT licensed, see [LICENSE](LICENSE).
