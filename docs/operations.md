# What is running, what it costs, and who pays

State of play as of 4 November 2026, 23:30 CET. Written from the code and
from live checks, not from memory.

## The one thing to fix before submitting

`main` is **15 commits behind** the working branch
`claude/specs-project-checkpoint-dc0eb8`. The submission form asks for a
public GitHub repository, and `EtienneLescot/shouldercut` is public — but a
judge who clones it gets `main`, which has none of this week's work: the
aspect-ratio fix, the transport rewrite, the shots popover, the dogfood
harness, the access gate, `AGENTS.md`. Merge before you submit.

## Services consumed

Nothing is bundled into the front-end — there is no `VITE_` variable
anywhere in the project — so **the browser holds no credential** beyond a
short-lived LiveKit token minted server-side. Every key lives in `.env` on
this machine, and every call below is made by a process here.

| Service | Called by | For | Billed to |
| --- | --- | --- | --- |
| **Meta Model API** (`api.meta.ai`) | `server/bridge.ts`, `voice/dialogue.py` | The editor's reasoning and the conversation | `META_API_KEY` / `MODEL_API_KEY` |
| **fal.ai** (`queue.fal.run`, `rest.fal.ai`) | `server/gen-video.ts` | Hosted generation: vace, kling-o3, recast, wan-animate, seedance | `FAL_KEY`, per second of video |
| **LiveKit** | `voice/agent.py`, `/api/voice/token` | Voice transport | `LIVEKIT_API_KEY` / `_SECRET`; currently the `--dev` server on this machine, so free |
| **ElevenLabs** | `voice/agent.py` | The mascot's voice | `ELEVEN_API_KEY` |
| **Google AI Studio** | `voice/tts_health.py` | TTS fallback when ElevenLabs is out of quota | `GOOGLE_API_KEY` |
| **Muse** | `server/muse-runner.ts` | Editing model | `MUSE_API_KEY` |
| **ComfyUI** (`127.0.0.1:8188`) | `server/gen-video.ts` | Local generation: vace-local, scail, scail-animate | Nothing. Your GPU. |

### What a generation actually costs

Measured by `tools/dogfood.ts` over three real clips, one full pass:

| Backend | Where | One pass | Per second |
| --- | --- | --- | --- |
| `vace-local`, `scail`, `scail-animate` | Your GPU | **$0** | — |
| `vace`, `wan-animate` | fal.ai | $0.61 | $0.04 |
| `kling-o3` | fal.ai | $2.55 | $0.168 |
| `recast` | fal.ai | $4.56 | $0.30 |

`vace` is about four times cheaper than `kling-o3` for comparable work.
Iterate prompts there.

## What has to be running

`npm run demo` starts the first three and tells you when they are up.

| Port | Process | Needed for | Must stay on |
| --- | --- | --- | --- |
| 5173 | Vite + the bridge (`server/bridge.ts`) | Everything. This is the app, the API and the ffmpeg host. | Yes |
| 7880 | `livekit-server --dev` | Voice only | Only for voice |
| 8081 | `voice/agent.py` | Voice only | Only for voice |
| 8188 | ComfyUI (`E:\ComfyUI`) | Free local generation | Only for local backends |

With ComfyUI down, generation silently falls through to paid fal.ai
backends — `recommend_video_workflow` drops the local ones from its
candidate list and nothing announces the switch. Keep it running, or expect
a bill.

Model weights are pinned off `C:` — `.env` sets `HF_HOME`, `HF_HUB_CACHE`,
`TORCH_HOME` and `UV_CACHE_DIR` under `E:\ai-cache`, and `COMFY_DIR` is
`E:\ComfyUI`.

## Remote access

Not part of how this project is delivered: the submission has no live-URL
field, and anyone running it stands it up themselves with Docker Compose.
The machinery is still here because it costs nothing to keep -- set
`SHOULDERCUT_ACCESS_KEY` and one key guards every route (`server/access.ts`),
point `SHOULDERCUT_TLS_CERT` at a certificate and the server speaks HTTPS,
which a remote browser needs or it loses WebCodecs, WebGPU and the
microphone. `docs/remote-access.md` has the detail.

No host name here names a real machine on purpose. A public repository is
the wrong place to point at someone’s computer, even by a name that a
certificate transparency log already carries.

## Is it enough for thousands of testers?

**No, and not close.** Be clear about what the gate is: a door lock, not a
bouncer. It answers "are you allowed in", and nothing else.

What is missing, all of it:

- **No rate limiting.** Nothing in `server/` throttles anything. Grep for
  `rate.?limit|throttle|quota|maxConcurrent` returns nothing.
- **No per-user anything.** One shared key. Everyone who has the link is the
  same person as far as the server is concerned, so you cannot attribute,
  meter or revoke one tester without revoking all of them.
- **No job cap.** Nothing limits how many generations run at once. Each one
  is ffmpeg plus a model, on one GPU.
- **One machine.** One Vite process, one GPU, one ComfyUI. Ten simultaneous
  testers would queue behind each other; a hundred would not get a response.
- **Unbounded spend.** Every hosted generation bills `FAL_KEY` with no
  ceiling. A tester who repeatedly asks for `recast` spends $0.30 a second
  of your money and nothing stops them.

So the honest scope: **the link is for a handful of people you know, one at
a time.** For anything wider, the minimum would be a per-tester key, a
request quota, a concurrency cap and a spend ceiling — none of which exist.

Before handing the link to anyone, put `GEN_PROVIDER` on a local backend or
set `GEN_DRY_RUN=1`. The access key is a wallet as much as a door.

## Submitting

The form is at
<https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit>,
and it closes **4 November, 9:00 PM ET — 3:00 AM Paris on the 5th**. The
event page states the same window.

There is **no field for a live URL**. The tunnel is useful for showing
someone the thing; it is not part of the submission.

Fields, in order:

1. Team Name
2. Team Members — `EtienneLescot` is already listed
3. Track (required) — **Indie Developer Track**
4. Problem statement (required) — Build for Your World, or Push the Frontier
5. X post link — only for the Most Viral Track, optional
6. Project Description — 3,000 characters
7. **Public GitHub Repository** — the repo is public; `main` is the problem
8. **3-Minute Demo Video** — a YouTube URL
9. Describe your use of Meta products — 3,000 characters
10. Why are Meta's models important to your solution? — 3,000 characters
11. Partner technology feedback — 150 characters, optional
12. How likely are you to build with Meta Model API? (required)
13. Overall opinion of Meta Model API? (required)

Two of those are real work and neither is code: **the video, and the three
long-form answers**. Questions 9 and 10 are where the Meta Model API use has
to be made explicit — it is a pass/fail gate before scoring.
