# ShoulderCut

Your video editor, standing over your shoulder: you talk, it cuts.

Meta Global AI Developer Hackathon — Indie Developer track.
Problem statement: Build for Your World.

Status: day 1 (Oct 27, 2026). Specification: [docs/SPEC.md](docs/SPEC.md).

## Built during the hackathon

Everything in this repository is written from scratch during the event
(Oct 27 – Nov 4, 2026), except the declared dependencies below. This
section will list each shipped feature as it lands.

- [ ] WebGPU render pipeline and FX shader library
- [ ] SAM 3.1 mask tracks driving object effects
- [ ] Muse Spark editing agent (Supervisor) and edit graph
- [ ] Voice loop on stimm with Muse Voice Transcribe
- [ ] Editing operations, captions, MP4 export

## Pre-existing dependencies

Declared dependencies that existed before the event. They are plumbing,
not hackathon work, and are never presented as built during the event.

- `stimm` (MIT, author's published package) — optimistic voice UI runtime
  on LiveKit, imported with `@stimm/protocol`. The editing Supervisor
  and tool bridge around it are built during the event.
- Third-party libraries will be listed here as they are added.

## Development

Secrets live in a local `.env` file (never committed):

```
MODEL_API_KEY=...
```

See [docs/SPEC.md](docs/SPEC.md) for architecture, scope, and the
day-by-day plan.
