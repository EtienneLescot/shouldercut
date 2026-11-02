# Credit and spend worklog

Required by SPEC §8. What spends money, at what unit price, and which
feature causes it. Written Nov 2, 2026.

**Totals are not reconciled.** The per-feature amounts below are the unit
prices and the call shapes, not measured invoices. Before submission,
read the actual figures off the Meta Model API Billing page and the fal
dashboard and fill the "spent" column. Do not quote estimates as spend.

## Meta Model API ($150 credits claimed Oct 26)

| Feature | Model | Unit price | Call shape | Spent |
|---|---|---|---|---|
| `track_object` (SAM masks behind `maskAt()`) | SAM 3.1 video | $0.20 / 1,000 frames | once per (clip hash, prompt), cached | — |
| `transcribe_captions`, silence cross-check | Muse Voice Transcribe (`muse-voice-transcribe-1.0`) | $0.18 / audio hour | once per clip, file transcription | — |
| Push-to-talk voice commands | same | $0.18 / audio hour | per held Talk press, a few seconds each | — |
| Supervisor reasoning | Muse Code CLI | covered by the Muse plan, not credits | per command | n/a |
| Muse Image plates | — | $0.01 / image | **not built** (cut, SPEC §11) | $0 |

Hard rules in force:
- Spend limit set on the API account before the first call.
- Mask tracks and transcripts cached by (hash, prompt): a clip is
  analysed at most once.
- Frame thumbnails to the agent (`describe_frame`) are on-demand only,
  never a polling loop.

At demo scale these prices make credits a non-issue. The spend limit
guards against a runaway agent loop, not against normal use.

## Generative video

Two kinds of backend, and the supervisor is required to prefer the
cheaper one that can do the job (`recommend_video_workflow`).

**Local, $0 in credits** — GPU time only, RTX 4070 Ti 12 GB:

| Backend | Workflow | Cost |
|---|---|---|
| `scail` | SCAIL-2 character replacement | ~6 min / 65 frames @ 960×544 |
| `scail-animate` | SCAIL-2 animation mode | ~10 min |
| `vace-local` | VACE inpainting (1.3B draft tier) | minutes, draft quality |

**Hosted (fal), real money** — only when the local repertoire cannot do
the job or quality demands it:

| Backend | Model | Unit price | Spent |
|---|---|---|---|
| `recast` | `minimax/h3-max/recast` | $0.30/s @ 768p, $0.45/s @ 1080p | — |
| `vace` | `fal-ai/wan-vace-14b/inpainting` | $0.04/s @ 480p | — |
| `wan-animate` | `fal-ai/wan/v2.2-14b/animate/replace` | $0.04/s @ 480p | — |
| `kling-o3` | `fal-ai/kling-video/o3/pro/video-to-video/edit` | $0.168/s | — |
| `generate_shot` | `bytedance/seedance-2.0/fast/text-to-video` | per-second, fast tier | — |

Full price and ranking detail per technique, including the backends that
are available or planned but unused, lives in
`server/video-techniques.json`.

Rules in force:
- Every generative request is planned through the technique registry
  before spending, and the shader host is tried first: a deterministic
  WGSL effect costs $0.
- The agent states the estimated cost before launching a job.
- `GEN_PROVIDER=stub` runs the whole generative path offline at $0, which
  is how the plumbing was developed and how the demo degrades if the
  network or the GPU is unavailable.

## Not spending

- Runway (`aleph2`) and Google (Veo 3.1, Gemini Omni Flash edit) are in
  the registry as `planned`. No account, no key, no spend.
- Muse Spark: not wired (SPEC §13). No tokens spent.
- LiveKit: no room, no cloud account (SPEC §13).
