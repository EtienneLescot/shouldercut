# Running a dogfooding pass

One editing instruction, every backend, every base video on disk, measured.
A pass is free and takes about 90 seconds.

```bash
node --experimental-strip-types tools/dogfood.ts "Replace the central spaceship with an X-wing style fighter"
```

Exit code 1 means at least one assertion failed. The report goes to stdout and
the per-trial measurements to `.runtime/dogfood-latest.json`.

## Why it exists

A generation can come back having done nothing at all, with no error anywhere:
the provider returns a video, the composite pastes it in, and the requested
edit is simply absent. That happened for every portrait clip while
`server/gen-video.ts` prepared the Kling input with `scale=1280:720`. Measured
after the fact: source 1080x1920, uploaded 1280x720, 39.5 dB between source
and result — nothing happened. Nothing in the product would have caught it.

## Options

| Flag | Default | What it does |
|---|---|---|
| *(first argument)* | a chrome-robot replacement | The editing instruction. |
| `--backends` | all seven edit backends | Comma-separated, or `all`. |
| `--clips` | picked from the project | Explicit paths, comma-separated. |
| `--limit` | `3` | How many base videos to pick, orientations alternating. |
| `--range` | `0:3` | Seconds of the clip to edit. `0:5` is the pipeline maximum. |
| `--psnr-max` | `35` | Above this, a result counts as a no-op. |
| `--no-generate-shot` | off | Skip the text-to-video trial. |
| `--paid` | off | **Spends real money.** See below. |

Base videos come from `server/clip-store/`, filtered to the hashes
`/api/project` references when the dev server is up. Sources over 128 MB are
skipped. Nothing is generated: use the footage that is already there.

## Reading the report

One row per (clip, backend). The four geometry columns are the whole point —
read them left to right and the shape should never change:

- **range in** — the segment the pipeline cut out of the clip. Longer than the
  range asked for, because short ranges are padded up to the model's minimum
  frame count.
- **backend received** — what was actually handed to the provider. This is
  where the squash hid.
- **output** — the composited result, or the raw provider output for backends
  that do their own tracking (`recast`).
- **psnr** — the composited result against the source range. Low is good: it
  means pixels moved. Over 35 dB means the edit did nothing.

Then **billed** (seconds the provider would charge for, measured off the file
that was sent) and **cost** at the prices in `docs/costs.md`.

Every file named in the JSON is still on disk under `server/gen-output/`, keyed
by job id: open the one in the column that looks wrong and watch it. A pass
leaves these behind on purpose — the point is to look at what came back.

## What the assertions catch

All of them live in one function, `checkTrial` in `tools/dogfood.ts`, and run
for every backend:

- the aspect ratio changing between the clip, the range, what the backend
  received, and the result — the class of bug that started this;
- a backend that saw less of the range than was asked for;
- an output whose duration or frame count has drifted off the range;
- a result indistinguishable from its source;
- a backend that was handed nothing, or returned nothing, or failed.

`npm test` covers the detector itself (`tools/test-dogfood.ts`): it asserts
that each of those fires on a broken trial and stays quiet on a good one.

## What a free pass does and does not prove

By default the harness sets `GEN_DRY_RUN=1`. Every provider input is prepared
for real — the Kling 720p upscale, the VACE grey control video, the SCAIL
reference reframing, the mask video — and the run then stops at the network
(or GPU) edge. The stand-in result is that prepared input put through the
local placeholder transform, so the trim and the composite still run on real
geometry.

So a free pass proves the geometry, the durations, the frame counts, the
composite and the cost arithmetic. It does **not** prove anything about model
quality: the no-op check is measuring the harness's own stand-in edit, which
exercises the detector and the composite, not the model. Only `--paid`
measures whether a model did what was asked.

The mask is a synthetic centred rectangle standing in for a SAM track, and the
reference image is a generated `data:` URL. Neither needs a network or a GPU.

## Paid passes

`--paid` runs real generations on the user's fal account. It prints the
per-second price of every backend first, and refuses outright for a backend
with no price in `docs/costs.md` — an unpriced call is an unbounded call.

One pass over three clips at a 3-second range, as measured:

| Backend | Billed | Cost |
|---|---|---|
| `vace` | 15.19 s | **$0.61** |
| `wan-animate` | 15.19 s | $0.61 |
| `kling-o3` | 15.20 s | $2.55 |
| `recast` | 15.19 s | $4.56 |
| `vace-local`, `scail`, `scail-animate` | 12.19 s | $0 (local GPU) |
| `generate_shot` | — | unpriced, refused |

Iterate prompts on `vace`: at $0.04/s it is roughly 4x cheaper than `kling-o3`
at $0.168/s for the same range. Note that one trial bills for the padded
segment (5.06 s), not the 3 seconds asked for.
