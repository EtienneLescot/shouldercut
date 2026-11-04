// The dogfooding harness exists to make a silent no-op impossible to miss.
// These checks are the ones that fail if the detector itself goes quiet.
// No ffmpeg: both pieces under test are pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  rangeShortfall, fitToBudget } from "../server/gen-video.ts";
import { ASPECT_TOLERANCE, PSNR_NO_OP_DB, checkTrial, type Probe, type Trial } from "./dogfood.ts";

const probe = (width: number, height: number, seconds = 5.06, fps = 16): Probe => ({
  width,
  height,
  seconds,
  fps,
  frames: Math.round(seconds * fps),
});

/** A trial where everything went right, as a baseline to break. */
function goodTrial(overrides: Partial<Trial> = {}): Trial {
  return {
    kind: "edit",
    clipLabel: "portrait.mp4",
    backend: "vace",
    model: "fal-ai/wan-vace-14b/inpainting",
    state: "done",
    requestedSeconds: 3,
    clip: probe(1080, 1920, 32),
    segment: probe(1080, 1920),
    uploaded: probe(540, 960),
    uploadedName: "job-vace-control.mp4",
    alsoSent: [],
    output: probe(540, 960, 3),
    outputName: "job-composited.mp4",
    psnrDb: 22.1,
    billedSeconds: 5.06,
    usd: 0.2,
    ...overrides,
  };
}

test("a working edit raises nothing", () => {
  assert.deepEqual(checkTrial(goodTrial()), []);
});

test("the squash that started this is caught, whatever backend does it", () => {
  // The real bug: a 1080x1920 range handed to the model as 16:9.
  const problems = checkTrial(goodTrial({ uploaded: probe(1280, 720) }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /aspect ratio changed.*what the backend received/s);
  // Also when it happens one step earlier, cutting the range out of the clip.
  assert.match(
    checkTrial(goodTrial({ segment: probe(1280, 720), uploaded: probe(1280, 720), output: probe(1280, 720, 3) }))[0],
    /aspect ratio changed cutting the range/,
  );
});

test("quantising a working size to a multiple of 16 is not a reshape", () => {
  for (const [width, height] of [[1080, 1920], [1226, 720], [960, 540], [640, 360], [1840, 1080]]) {
    const fitted = fitToBudget({ width, height }, 960, 540, 16);
    assert.equal(fitted.width % 16, 0, `${width}x${height} -> ${fitted.width}`);
    assert.equal(fitted.height % 16, 0, `${width}x${height} -> ${fitted.height}`);
    const drift = Math.abs(fitted.width / fitted.height - width / height) / (width / height);
    assert.ok(drift < ASPECT_TOLERANCE, `${width}x${height} became ${fitted.width}x${fitted.height} (${(drift * 100).toFixed(1)}% off)`);
    // Never an upscale, beyond rounding up to the next multiple of 16.
    assert.ok(fitted.width <= width + 16 && fitted.height <= height + 16, "a budget must never upscale");
    assert.ok(fitted.width * fitted.height <= 960 * 540 * 1.1, "a budget must be respected");
  }
  // The pinned-both-sides expression this replaced, for contrast.
  assert.ok(Math.abs(1280 / 720 - 1080 / 1920) / (1080 / 1920) > ASPECT_TOLERANCE);
});

test("a result indistinguishable from the source is a failure, not a pass", () => {
  // 39.5 dB was measured on the bug where nothing happened at all.
  assert.match(checkTrial(goodTrial({ psnrDb: 39.5 }))[0], /the edit did nothing/);
  assert.match(checkTrial(goodTrial({ psnrDb: Infinity }))[0], /pixel-identical/);
  assert.deepEqual(checkTrial(goodTrial({ psnrDb: PSNR_NO_OP_DB - 0.1 })), []);
  // Unmeasurable is not the same as unchanged: say nothing rather than lie.
  assert.deepEqual(checkTrial(goodTrial({ psnrDb: null })), []);
});

test("output drifting off the edited range is caught", () => {
  assert.match(checkTrial(goodTrial({ output: probe(540, 960, 5.06) }))[0], /output runs 5.06s/);
  assert.match(
    checkTrial(goodTrial({ output: { ...probe(540, 960, 3), frames: 65 } }))[0],
    /output has 65 frames, 48 expected/,
  );
});

test("a range the backend never saw in full is caught", () => {
  assert.match(
    checkTrial(goodTrial({ requestedSeconds: 5, uploaded: probe(540, 960, 4.06), output: probe(540, 960, 5) }))[0],
    /only saw 4.06s of the 5.00s range/,
  );
});

test("a backend that was handed nothing, or returned nothing, is not a pass", () => {
  assert.match(checkTrial(goodTrial({ uploaded: null }))[0], /nothing was handed to the backend/);
  assert.match(checkTrial(goodTrial({ output: null, psnrDb: null }))[0], /without an output video/);
  assert.match(checkTrial(goodTrial({ state: "failed", error: "ffmpeg blew up" }))[0], /job failed: ffmpeg blew up/);
  // Text-to-video uploads nothing by design; that must not read as a failure.
  assert.deepEqual(
    checkTrial({ ...goodTrial(), kind: "generate", segment: null, clip: null, uploaded: null, psnrDb: null, requestedSeconds: 3 }),
    [],
  );
});

// The bug these guard: finishEdit cuts the backend's output back to the
// requested range with `ffmpeg -t <asked>`. Handed less footage than that,
// ffmpeg writes a shorter file and exits 0, so a five-second replacement
// came back as four seconds and nothing said so. The local ComfyUI
// workflows run a fixed 65 frames, which is 4.06s at 16 fps, so every
// request longer than that was silently short.

test("a backend that covers the range reports nothing", () => {
  assert.equal(rangeShortfall(5.06, 5.06), null);
  assert.equal(rangeShortfall(3, 3.2), null, "more than asked is not a shortfall");
  assert.equal(rangeShortfall(5.06, 5.0), null, "under one frame is rounding");
});

test("the 65-frame local budget against a longer range is caught", () => {
  // The exact case the harness measures: 81 frames asked, 65 delivered.
  const short = rangeShortfall(81 / 16, 65 / 16);
  assert.ok(short, "4.06s against 5.06s must be reported");
  assert.equal(Math.round(short!.missing * 100) / 100, 1);
  assert.equal(Math.round(short!.got * 100) / 100, 4.06);
});

test("it judges the gap, not the backend", () => {
  // Nothing here knows a frame budget, so a new backend, an edited
  // workflow or a provider changing its step are all covered already.
  assert.ok(rangeShortfall(30, 4.06), "a long range against any budget");
  assert.ok(rangeShortfall(0.5, 0.1), "a short range too");
  assert.equal(rangeShortfall(4.06, 4.06), null);
});

test("a probe that failed never invents a shortfall", () => {
  // probeDuration resolves NaN rather than rejecting: losing the warning
  // is acceptable, failing a finished edit is not.
  assert.equal(rangeShortfall(5, Number.NaN), null);
  assert.equal(rangeShortfall(Number.NaN, 5), null);
  assert.equal(rangeShortfall(0, 0), null);
  assert.equal(rangeShortfall(-1, 5), null);
});

test("a backend that returned nothing at all is a full shortfall", () => {
  const none = rangeShortfall(5.06, 0);
  assert.ok(none);
  assert.equal(none!.got, 0);
  assert.equal(none!.missing, 5.06);
});
