# ShoulderCut

Your video editor, standing over your shoulder: you talk, it cuts.

Meta Global AI Developer Hackathon — Indie Developer track.
Problem statement: Build for Your World.

Status: day 1 (Oct 27, 2026). Specification: [docs/SPEC.md](docs/SPEC.md).

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
  captions, 1080p / vertical / square presets). Finished generation
  jobs join the graph as clips automatically. Project panel in the UI
  with sequential preview playback across clips
- [x] Tested ComfyUI workflow repertoire for the supervisor:
  `server/comfy-workflows/` (SCAIL-2 character replacement, SCAIL-2
  animation, local VACE inpainting) with fixed tested settings, exposed
  via `list_comfy_workflows` and the `scail` / `scail-animate` /
  `vace-local` backends of `edit_segment`
- [ ] Muse Spark editing agent (Supervisor) and edit graph
- [ ] Voice loop on stimm with Muse Voice Transcribe

## Pre-existing dependencies

Declared dependencies that existed before the event. They are plumbing,
not hackathon work, and are never presented as built during the event.

- `stimm` (MIT, author's published package) — optimistic voice UI runtime
  on LiveKit, imported with `@stimm/protocol`. The editing Supervisor
  and tool bridge around it are built during the event.
- `mediabunny` (third-party) — media demuxing and `VideoDecoderConfig`
  extraction. Decoding, seeking, buffering, and rendering around it are
  built during the event.
- `@modelcontextprotocol/sdk`, `zod` (third-party) — MCP server plumbing
  for the shader tools.
- `@meta-sam/parser` (Meta, SAM License) — official SAM 3 segmentation
  stream parser and mask codec used server-side by the bridge. The SAM
  adapter, mask expansion, GPU upload, and `maskAt()` wiring around it
  are built during the event.
- Vite and TypeScript (third-party) — build tooling.

## Development

```powershell
npm install
npm run dev
```

Then open http://127.0.0.1:5173/ in Chrome or Edge, drag in a local
MP4/WebM file, and ask in chat for any effect (for example
"Rajoute-moi un effet d'explosion au milieu"). The local bridge starts
Muse (`muse exec`) with the `shouldercut-fx` MCP server; the agent
writes WGSL against `docs/fx-interface.md`, and the browser compiles it
live. Muse must be installed and logged in on this machine.

Secrets live in a local `.env` file (never committed):

```
MODEL_API_KEY=...
```

See [docs/SPEC.md](docs/SPEC.md) for architecture, scope, and the
day-by-day plan.
