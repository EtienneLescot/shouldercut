# WebGPU bench

Measures the preview pipeline that the product is built on: hardware
decode → `importExternalTexture` → ingest/grade pass → blur pass →
mask-aware compose pass → canvas. Per-pass GPU time comes from WebGPU
timestamp queries (sampled every 10th measured frame); frame intervals
and JS submission time are measured every frame after a 30-frame warm-up.

This bench is development tooling written during the hackathon. It is
not product code and is never shown as a feature in the demo.

## Generate test assets (git-ignored)

```powershell
ffmpeg -y -f lavfi -i "testsrc2=duration=12:size=1920x1080:rate=30" -c:v libx264 -preset veryfast -pix_fmt yuv420p -movflags +faststart tools/bench/assets/test-1080p.mp4
ffmpeg -y -f lavfi -i "testsrc2=duration=8:size=3840x2160:rate=30" -c:v libx264 -preset veryfast -pix_fmt yuv420p -movflags +faststart tools/bench/assets/test-2160p.mp4
```

## Run

Requires Python Playwright and an installed Chrome/Chromium.

```powershell
python tools/bench/run_bench.py
python tools/bench/run_bench.py --only 1080p,2160p
```

Scenarios: `1080p`, `1080p-vf-rate2` (`VideoFrame` import at 2x),
`1080p-mask-upload` (adds a 480x270 R8 mask upload every frame),
`2160p`. Results land in `tools/bench/runs/<scenario>/result.json`
with `console.txt` and a canvas screenshot.

Page parameters: `src`, `seconds`, `rate`, `vf=1`, `maskUpload=1`.
