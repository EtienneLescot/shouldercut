# Generative video architecture — voice-controlled studio

Status: design document, October 2026. Not yet implemented.
Product frame: `docs/SPEC.md`. Shader contract: `docs/fx-interface.md`.
Distilled editing craft: `docs/editing-craft.md`.

## 1. Decision in one paragraph

ShoulderCut becomes a complete generation + editing + VFX studio with
**no node-graph interface**. The user speaks or types; a Meta-model
supervisor plans; SAM 3.1 shows *where*; third-party video models
generate or transform footage behind a provider interface; the WGSL
shader host finishes and recomposites in real time. Meta supplies the
brain (Muse Spark as supervisor, planned), the ears and voice (Muse
Voice Transcribe STT, Meta TTS through the imported stimm runtime),
the segmentation (SAM 3.1) and still images (Muse Image). Video
generation is consumed through APIs, because frontier video models
will not be reachable at demo quality or speed on a local GPU; the
provider slot is designed so Meta's Muse Video replaces the
third-party backend the day its API opens. ComfyUI is our workflow
research bench and an optional local backend, never the product UI.

## 2. Why APIs, and why not only APIs

- Local generation on the author's machine (RTX 4070 Ti) is useful
  for prototyping control workflows, but iteration speed and model
  quality cap out far below hosted frontier models. The demo cannot
  wait on a local Wan render per idea.
- A raw API call alone gives no precise control: a video-to-video model
  regenerates the whole frame, drifts outside the requested zone,
  and offers no frame-accurate undo.
- Our contribution is the control layer around the call: SAM masks
  bound the edit, the source segment bounds the duration, the shader
  host recomposites only the masked zone back into pixels that stay
  byte-identical outside it, and every result lands as a versioned
  node in the edit graph (SPEC §6) with undo.

## 3. What the best controlled workflows do (research summary)

The reference ComfyUI workflows for controlled video generation
converge on five control signals. Our opinionated workflows expose
exactly these, as tool parameters, never as graph wiring:

1. **Mask video** — where generation may happen. Wan VACE
   (video + mask + reference + prompt) is the reference open model;
   on fal it ships as task endpoints (inpainting, outpainting,
   reframe, depth) at $0.04–0.08 per video second.
2. **First / last frames** — where the shot starts and ends. Veo 3.1
   (Gemini API) takes a start image, an optional last frame and up
   to 3 reference images, 4/6/8 s clips with native audio.
3. **Reference media** — who/what must persist. Seedance 2.0
   reference-to-video (fal) accepts up to 9 images + 3 videos +
   3 audio references addressed in the prompt; Kling 3.0 uses
   elements for identity binding.
4. **Motion / camera guide** — how things move. Kling 3.0 Motion
   Control (fal, $0.168/s) transfers movement from a reference video
   onto a character image; ComfyUI adds Uni3C / WanMove /
   CameraCtrl-style guide videos for camera paths.
5. **ControlNet-style structural conditioning** — the geometry the
   generation must respect, extracted from the source segment as
   control videos: depth, human pose, edges (canny/lineart). In
   image generation this is ControlNet proper; in current video
   stacks the same signals enter through VACE control videos, Wan
   control LoRAs (depth/pose/canny/tile) or a provider's control
   inputs. This is distinct from the SAM mask: the mask says
   *where* pixels may change, the structural control says *what
   shape and motion the new pixels must follow* inside it. For the
   children→robots demo it is what keeps two jumping bodies, their
   timing and the camera framing from drifting while their
   appearance is fully replaced. Control videos are computed
   server-side from the segment (depth/pose estimators; our shader
   host can render cheap edge guides), cached with the segment,
   and routed only to backends that accept them — models without
   a structural input fall back to mask recomposite alone (§7.3),
   which bounds damage but cannot steer the inside of the zone.
6. **Prompt + seed + strength** — what changes, reproducibly, and
   how hard the control signals bind.

### The mask as a production intermediate, not only a model input

Only one shortlisted model consumes a mask video natively. That
does not make SAM masks useless with the others: in production the
mask is an intermediate from which stronger guides are derived:

- **Edited keyframe.** SAM cuts the subject on one frame; an image
  inpainting model (Muse Image edits, or a mask-native still model
  such as FLUX Fill) replaces it there, under full human-readable
  control. That finished frame then guides video models as a
  first frame, a reference image, or a Kling element. This is the
  keyframe-guided propagation pattern used by recent video
  inpainting research: generate the appearance once, still, then
  let a video model propagate it in time.
- **Character replacement / motion transfer.** Wan Animate
  (fal: `wan-motion`, `wan/v2.2-14b/animate/replace`) and Kling
  Motion Control take a character image plus the source video as
  a motion driver and re-perform it. SAM's role moves upstream:
  isolate the original subject, build the replacement character
  (edited keyframe), and define what the result must re-occupy.
  For children→robots this family is a first-class candidate,
  arguably better matched than inpainting: appearance comes from
  the character, motion from the footage.
- **Single mask image + tracking.** VACE also accepts one mask
  image and tracks the salient region itself, when a full mask
  video is unavailable or too costly to ship.
- **Derived guides.** The same SAM track yields the bounding box
  (region prompts, crops), the pose/depth/edge control videos
  (§3.5), and the final recomposite. One user gesture — naming
  the subject — produces every control signal the ecosystem
  accepts; each backend consumes the subset it understands.

Research-scope honesty: this survey covers the fal catalog, the
Runway Dev catalog (which itself hosts Aleph 2.0, Kling, Veo and
Seedance variants behind one key) and the Artificial Analysis
leaderboards. It is not an exhaustive census of direct vendor
APIs (BytePlus, Kling direct, Google direct, Luma, MiniMax,
Viggle…), which change weekly; the model router (§6) therefore
stays configuration, re-benchmarked per checkpoint, never
hard-coded product truth.

Two hard-won lessons from that ecosystem are baked into §5: control
workflows are frozen, versioned templates whose parameters are
filled by name (never hand-edited graphs), and a draft tier always
precedes the expensive final tier.

## 4. Existing MCP servers for ComfyUI (research summary)

MCP control planes for ComfyUI already exist; we do not need to
write one, and we should not expose a raw one to end users:

| Server | Surface | Verdict for us |
|---|---|---|
| artokun/comfyui-mcp | 38 tools, live graph authoring/editing, model + node management, agent panel | R&D bench: the richest way to prototype workflows with an agent |
| halbert04/comfyui-mcp | 40+ tools: one-call generation, `run_api_node` over 200+ hosted API nodes (Kling, Runway, Veo…), workflow builder/validator | Candidate execution bridge if we run hosted nodes through ComfyUI |
| joenorton/comfyui-mcp-server (forks) | Lightweight generate / view / regenerate / job tools over HTTP | Minimal fallback; image-centric |

Product rule: **the shipped agent never authors graphs.** In R&D we
use an MCP above to explore; what ships is the exported, frozen
workflow (API-format JSON) plus an opinionated tool that fills its
named parameters. Graph authoring by the production agent would
reintroduce exactly the fragility (node versions, wiring errors,
VRAM state) that the opinionated layer exists to remove.

## 5. Target architecture

```
 voice/text ──► Supervisor (Muse Spark, Meta STT/TTS via stimm)
                    │ plans, asks at most one question, confirms cost
                    ▼
              MCP tool surface (shouldercut-fx, extended)
   ┌────────────────┬──────────────────┬────────────────────┐
   │ track_object   │ edit_segment     │ generate_shot      │  + existing
   │ (SAM 3.1)      │ (masked v2v)     │ (t2v / i2v / FLF)  │    shader tools
   └───────┬────────┴────────┬─────────┴─────────┬──────────┘
           ▼                 ▼                   ▼
   MaskTrack store    GenVideoProvider     GenVideoProvider
   (per-frame masks)  (async job queue)    (async job queue)
                             │
        ┌────────────────────┼─────────────────────────┐
        ▼                    ▼                         ▼
  Runway Aleph API     fal (VACE, Seedance,      ComfyUI server (local,
  (hosted v2v edit)    Kling, Veo, Wan…)         frozen workflows only)
                             │
                             ▼
                    result clip on disk/URL
                             │
                             ▼
        Shader host: masked recomposite, grade match, grain,
        captions, real-time preview ──► Edit graph ──► Export
```

Components:

- **Supervisor.** Muse Spark (Meta Model API) as the planning
  model, stimm fast-agent pattern for immediate spoken
  acknowledgement, Muse Voice Transcribe for STT. It decomposes a
  command into tool calls, states derived numbers (segment, subject,
  estimated cost) before spending, and asks at most one question
  when the target is ambiguous between two visible subjects.
- **Provider interface `GenVideoProvider`.** One server-side
  interface, three backends, keys never in the browser:
  `submit(job) -> jobId`, `status(jobId)`, `result(jobId) -> clip`.
  Job kinds: `edit_segment` (source segment + optional mask video +
  optional control videos (depth/pose/edges, §3.5) + optional
  reference image + prompt), `generate_shot` (prompt +
  optional first/last frame + optional references + duration),
  `motion_transfer` (character image + motion reference video).
  Backends are selected per job kind by the routing table in §6,
  not by the user.
- **ComfyUI backend (optional, local).** A headless ComfyUI on the
  user's machine (default port 8188) executing only frozen workflow
  JSONs stored in this repo. The bridge submits through its HTTP
  queue API with named parameters. Used for control experiments,
  offline work and zero-marginal-cost drafts; never required for
  the demo path.
- **Mask and segment store.** Existing SAM 3.1 wiring, extended:
  mask tracks become downloadable mask *videos* (the control signal
  every masked workflow consumes), and segments become first-class
  ranges on clips in the edit graph.
- **Finishing host.** The existing WGSL engine: masked recomposite
  of generated zones, colour matching to the source shot
  (distilled rules in `docs/editing-craft.md`), grain, captions,
  preview and, at export, the same chain rendered offline.
- **Asset and job cache.** Every submission is hashed from
  (source segment hash, mask hash, prompt, model, seed, tier);
  identical jobs return the cached clip. Spent credits are logged
  per feature, extending the SPEC §8 budget rules.

## 6. Model routing (initial, to be benchmarked)

Quality evidence (October 2026, Artificial Analysis human
preference Elo): in **video editing**, Wan 3.0 leads (1198),
followed by Dreamina Seedance 2.5, Gemini Omni Flash 1.1 and
MiniMax H3; Runway Aleph 2.0 ranks 9th (1012). In **text-to-video**,
Wan 3.0 also leads (1174) with Seedance 2.5 and MiniMax H3 in the
top group, while Veo 3.1 sits near 21st (961) despite its superior
control surface. Conclusion for routing: because our host supplies
the bounding control (SAM mask + recomposite, §7.3), we route by
*editing quality first* and use control-specialised models only
where the control signal itself is the product (mask inpainting,
first/last frame, motion transfer).

| Job | Primary candidate | Why | Fallback |
|---|---|---|---|
| Transform a tracked subject in real footage (demo) | Top-ranked instruction-edit model reachable by API (Wan 3.0 / Seedance 2.5 class; exact endpoint benchmarked at integration) | Highest editing Elo; our SAM recomposite restores everything outside the subject, so whole-frame regeneration is safe | Runway Aleph (`video_to_video`), purpose-built for in-context edits |
| Remove / replace a bounded zone | Wan VACE 14B inpainting (fal) | True mask-video control; outside zone recomposited by us anyway; $0.08/s at 720p | Aleph |
| Generated insert / from-scratch shot | Wan 3.0 / Seedance 2.x class via fal | Top text-to-video Elo; Seedance adds multi-reference control, up to 15 s, native audio | MiniMax H3 tier for cheaper drafts |
| First/last-frame transition shot | Veo 3.1 (Gemini API) | Documented start + last frame + references; chosen for control, not Elo | Seedance FLF variants |
| Motion transfer onto a character | Kling 3.0 Motion Control (fal) | Reference-video motion onto a character image, $0.168/s | ComfyUI WanMove workflow, local |
| Replace a character, motion from footage | Wan Animate Replace / Wan Motion (fal) | Character image re-performs the source video; SAM supplies subject, keyframe and recomposite | Kling Motion Control |

Prices above are October 2026 list indications from provider
pages, to be re-verified at integration time; the router hides
them behind draft/final tiers (§7), not user-facing model names.
Leaderboard positions are a snapshot, re-checked at each model
benchmark (step 3 of §9), never hard-coded in product copy.

## 7. Opinionated workflow rules

1. **Three workflows ship.** `edit_segment`, `generate_shot`,
   `motion_transfer`. Nothing else is exposed until a demo need
   proves a fourth.
2. **Draft before final, always.** Draft = short, low resolution
   or fast tier, shown in preview; final = full tier, only after
   the user (or the agent's own critique pass) accepts the draft.
   One critique-and-retry pass maximum per request.
3. **The outside of the mask is sacred.** Generated results are
   recomposited through the SAM mask by our host; a provider that
   re-renders the whole frame never gets the last word on pixels
   outside the requested zone.
4. **Controls are sentences, then numbers.** The user says "les
   enfants, en robots, plus métal"; the supervisor derives subject
   (SAM prompt), segment (current clip range), strength and tier,
   and states them in its one-sentence confirmation.
5. **Every generation is a graph node.** Result clips enter the
   edit graph with provenance (provider, model, prompt, seed,
   cost); undo removes the node, never the source.
6. **Latency is designed, not endured.** Voice acknowledgement is
   immediate; generation is an async job with spoken progress only
   on completion or failure; the real-time shader loop stays fully
   usable while a job runs.
7. **Optimistic preview in under a second (hard demo rule).** The
   user must *see* the edit before the provider returns anything.
   The instant a generation job is accepted, the preview switches
   to an optimistic state built from what we already have locally:
   - **Immediately (<300 ms):** voice confirmation, a visible
     working state on the preview, and — when a mask track for the
     subject already exists — the treatment below. The perceived
     latency budget is spent on acknowledgement, not silence.
   - **At first mask (≈1 s target):** a first-frame SAM segmentation
     (the SPEC S2 image path measured 1.13 s to first mask) cuts
     the subject out under a flat, bold treatment by a local
     shader — solid colour fill or posterised silhouette in the
     accent colour of the target ("robots" → flat metallic
     grey-orange), with the rest of the frame untouched. As the
     video track streams in, the treatment follows the subject
     frame by frame. No generation has happened yet; the frame
     already says *these pixels, this change*, and nothing is
     presented as the final result.
   - Draft ready: the optimistic treatment crossfades into the
     real generated draft over ~300 ms, in place, same framing.
   - Final ready: same crossfade, then the treatment is gone.
   - Failure or cancel: the treatment fades out and the original
     pixels return untouched; the voice says why in one sentence.
   This state is cheap (one mask, one shader, both already ours),
   costs no credit, and is never counted as a generation result in
   the edit graph: the graph records `job pending → draft → final`
   on the same node, so undo during a job cancels cleanly.

## 8. The target demo, end to end

Footage: `tools/bench/assets/bedroom.mp4` — two children bouncing
on a bed, 6.7 s, 960×540. Command, spoken: « Transforme les enfants
en robots. »

1. Supervisor parses the intent: transform, subjects = children,
   whole clip. It speaks its one-sentence confirmation and, the
   moment the job is accepted, the **optimistic preview rule (§7.7)**
   fires: voice and working state immediately, then, at first SAM
   mask (≈1 s), the two children appear cut out in a flat metallic
   grey-orange treatment that follows them as the track streams
   in. The audience sees the edit before any generation exists.
   SAM 3.1 tracks `children` (two mask tracks or one combined
   track; see open question Q2) underneath it.
2. The agent extracts the segment (0–6.7 s) and builds the job:
   source segment + mask video + prompt ("the two children become
   friendly toy robots, same jumps, same timing, brushed metal and
   orange joints") + a Muse Image reference frame of the robot
   design, generated once for identity.
3. Draft tier renders (top instruction-edit model at draft
   settings, or VACE 720p when the mask must drive generation).
   Cost indication: ≈ $0.50 (VACE) to ≈ $1.90 (Aleph) for 6.7 s;
   final tier re-priced from the benchmarked endpoint.
4. The result is recomposited through the mask, grade-matched and
   crossfaded in over the optimistic treatment (300 ms, §7.7).
   The user says « plus métal » or « valide »; at most one retry,
   then the final tier, which replaces the draft the same way.
5. Captions, a shader grade and export close the demo exactly as
   SPEC §12 already scripts it.

This demo exercises every Meta brick (Spark planning, Voice,
SAM, Muse Image reference) plus exactly one third-party generation
call, and it fails gracefully: if generation is down, the shader
robot overlay from our earlier bench is the rehearsed fallback,
clearly a lesser result, never a silent substitution.

## 9. Implementation order

1. `GenVideoProvider` + fal backend, `generate_shot` MCP tool,
   job queue and cache in the bridge; generated clips land in the
   edit graph as new clips. *(Proves the async loop cheaply.)*
2. Optimistic preview treatment (local shader over the SAM mask,
   §7.7) + mask-video export from SAM tracks + control-video
   extraction from segments (depth/pose/edges, §3.5) +
   `edit_segment` tool with the VACE inpainting backend; masked
   recomposite in the shader host (mask already available
   per frame).
3. Benchmark three arms on the demo segment — Kling O3 edit
   (instruction), Wan Animate Replace (character replacement),
   VACE (masked baseline) — against the criteria of §6 plus
   edited-keyframe guidance where a backend accepts it; wire the
   winner behind the same tool; the demo of §8 rehearsed end
   to end.
4. Draft/final tiers, cost log, one critique pass (frame grabs
   compared by the supervisor before showing the user).
5. Optional: local ComfyUI backend executing the frozen VACE
   workflow for offline drafts; MCP ComfyUI servers stay in R&D.

Non-goals: no graph UI, no workflow authoring by the shipped
agent, no per-frame image generation, no local generation on the
judge path, no new provider beyond fal + Runway until the demo
is green.

## 10. Risks and open questions

- **R1 — Provider drift.** Model ids, prices and endpoints move
  monthly (Veo 3.1 preview ids already churn). Mitigation: the
  router table is config, benchmarked at each checkpoint; fal
  aggregates several models behind one key.
- **R2 — Two subjects, one prompt.** SAM tracks one concept per
  request; "children" may return one or two tracks. Mitigation:
  union of mask tracks per subject group in the mask store (Q2).
- **R3 — VACE round-trip.** Even retained zones pass through the
  model's VAE and come back altered; our masked recomposite (§7.3)
  is therefore mandatory, not optional polish.
- **R4 — Spend.** A rehearsed demo day can burn tens of dollars in
  retries. Mitigation: draft-first rule, job cache, hard session
  budget in the proxy (SPEC §8).
- **R5 — Judge path.** Hosted generation needs network + keys on
  the demo machine; the local-ComfyUI and shader fallbacks keep a
  degraded but real demo alive offline.

Open questions: Q1 — fal account and Runway account provisioning
and spend limits (owner action). Q2 — multi-subject mask union
semantics in the SAM adapter. Q3 — whether Muse Spark is wired
as supervisor before the demo freeze or the current Muse
harness keeps the role (interface is identical either way).

## 11. Technique registry: the supervisor's added value

The research above is not prose for humans only. It is compiled
into `server/video-techniques.json` (version 1, October 2026):
ten techniques with the user phrasings that cue them, required
inputs, guidance channels, ordered workflow steps, candidate
backends with implementation status, prices, rankings,
economical test settings and risks. Two MCP tools expose it:

- `list_video_techniques` — the inventory, for learning.
- `recommend_video_workflow` — the planner: one literal user
  request in, the primary technique, ordered tool steps, the
  backend to use first and the cheap test settings out.

The supervisor must call the planner once before any generative
job and follow its steps. This is the layer that turns "transforme
les enfants en robots" into tracked subjects, an optimistic
preview, a character-replacement call and a masked recomposite
instead of a hopeful prompt: the literal request is translated
into the right technique, the right workflow and the most
appropriate available model, with spend bounded by the registry's
economical settings. Statuses in the registry are honest:
`available` backends (Kling O3 edit, Wan Animate Replace, Kling
Motion Control, HappyHorse) are callable with the configured fal
key and are wired one benchmark at a time (§9 step 3).

## Sources (inspected October 2026)

- fal Wan VACE 14B inpainting, model page and pricing:
  https://fal.ai/models/fal-ai/wan-vace-14b/inpainting/llms.txt
- fal Kling 3.0 Motion Control, inputs and pricing:
  https://fal.ai/models/fal-ai/kling-video/v3/pro/motion-control/llms.txt
- fal Wan-2.2 Animate Replace, inputs and pricing:
  https://fal.ai/models/fal-ai/wan/v2.2-14b/animate/replace/llms.txt
- fal Kling O3 Pro video-to-video edit, inputs and pricing:
  https://fal.ai/models/fal-ai/kling-video/o3/pro/video-to-video/edit/llms.txt
- fal Happy Horse video edit, inputs and pricing:
  https://fal.ai/models/alibaba/happy-horse/video-edit/llms.txt
- Veo 3.1 in the Gemini API, first/last frame and references:
  https://ai.google.dev/gemini-api/docs/video
- Runway developer API, guides and models:
  https://docs.dev.runwayml.com/guides/using-the-api/
  https://docs.dev.runwayml.com/guides/models/
- ComfyUI MCP servers surveyed:
  https://github.com/artokun/comfyui-mcp
  https://github.com/halbert04/comfyui-mcp
  https://github.com/TheRealChickenlegs/comfyui-mcp-server
- Artificial Analysis leaderboards (quality snapshot, Oct 2026):
  https://artificialanalysis.ai/video/leaderboard/text-to-video
  https://artificialanalysis.ai/video/leaderboard/video-editing
