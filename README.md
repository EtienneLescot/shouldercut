# ShoulderCut

Your video editor, standing over your shoulder: you talk, it cuts.

Meta Global AI Developer Hackathon — Indie Developer track.
Problem statement: Build for Your World.

Status: day 7 of 9 (Nov 2, 2026), feature-complete on the P0 scope.
Specification: [docs/SPEC.md](docs/SPEC.md), kept current with the build.

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
- [x] Voice commands by push-to-talk: hold Talk, speak, release; the
  browser records, Muse Voice Transcribe transcribes, and the transcript
  runs through the same supervisor path as a typed command, with full
  tool parity. Replaces the planned LiveKit dual-agent runtime
  (SPEC §13); the "something is happening" feedback is visual, through
  the optimistic working preview
- [x] Supervisor: Muse Code (`muse exec`) hosting the `shouldercut-fx`
  MCP server as its whole tool surface — 31 tools over shaders, masks,
  the edit graph, generation and the technique registry. One harness
  serves chat and voice

- [x] One-screen interface built around the Talk button: a single UI
  state (idle / listening / thinking / done) drives the accent colour,
  the button (breathing, then live microphone envelope, then an orbiting
  arc while Muse writes WGSL), a travelling hairline on the frame and a
  light sweep when a command lands. Everything else sits in a drawer,
  closed by default
- [x] Muse, the mascot: Meta's Muse character as the agent's on-screen
  presence, modelled in Three.js from primitives in `src/mascot.ts` —
  cream fur, hooded head, dot eyes, blushed cheeks, no model file to
  ship. It turns its head looking around while it waits, locks forward
  with its cheeks warming to the microphone while you speak, and works
  head-down with narrowed eyes while it edits. The character is Meta's;
  the model, its rig and its behaviour are written here

Not built, cut deliberately (SPEC §11): Muse Image plates as shader
inputs, dissolve transitions, caption style variants, filler-word
removal, reframing beyond the three export presets, music-bed ducking.

## Pre-existing dependencies

Declared dependencies that existed before the event. They are plumbing,
not hackathon work, and are never presented as built during the event.

**All third-party.** ShoulderCut imports no first-party package: the
author's own published `stimm` runtime was planned as a declared MIT
import for the voice loop and is not used in the shipped build
(SPEC §0, §13). Every line of ShoulderCut is event work.

- `mediabunny` (third-party) — media demuxing and `VideoDecoderConfig`
  extraction. Decoding, seeking, buffering, and rendering around it are
  built during the event.
- `@modelcontextprotocol/sdk`, `zod` (third-party) — MCP server plumbing
  for the shader tools.
- `@meta-sam/parser` (Meta, SAM License) — official SAM 3 segmentation
  stream parser and mask codec used server-side by the bridge. The SAM
  adapter, mask expansion, GPU upload, and `maskAt()` wiring around it
  are built during the event.
- `three` (third-party, MIT) — WebGL renderer for the Muse mascot. The
  model, its rig and its behaviour are built during the event.

The Muse mascot is Meta's character, used here as an homage in a Meta
hackathon entry. No Meta artwork or model file is copied: the figure is
rebuilt from Three.js primitives in `src/mascot.ts`. ShoulderCut is not
affiliated with or endorsed by Meta.
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

Checks: `npm run build` typechecks and builds, `npm test` runs the
export regression check (needs `ffmpeg` and `ffprobe` on PATH).

Then open http://127.0.0.1:5173/ in Chrome or Edge, drag in a local
MP4/WebM file, and ask in chat for any effect (for example
"Rajoute-moi un effet d'explosion au milieu"). The local bridge starts
Muse (`muse exec`) with the `shouldercut-fx` MCP server; the agent
writes WGSL against `docs/fx-interface.md`, and the browser compiles it
live. Muse must be installed and logged in on this machine.

Voice: hold the **Talk** button, speak a command, release.

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
