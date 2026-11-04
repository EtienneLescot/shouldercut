import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GenJobManager,
  GenerationInputError,
  klingEditInput,
  validateEditInputs,
} from "../server/gen-video.ts";

test("missing reference fails before a job or expensive preprocessing exists", () => {
  const manager = new GenJobManager();
  for (const backend of ["recast", "wan-animate", "scail", "scail-animate"]) {
    assert.throws(
      () => manager.createEditJob("robot", undefined, backend),
      (error) =>
        error instanceof GenerationInputError &&
        error.code === "missing_reference" &&
        !error.retryable,
    );
  }
  assert.equal(manager.list().length, 0);
  assert.throws(() => validateEditInputs("vace", undefined, false), /Détourez/);
});

test("Kling text-only edits never reference an imaginary image", () => {
  validateEditInputs("kling-o3", undefined, false);
  const input = klingEditInput("A grey robot", "https://example.test/clip.mp4");
  assert.equal(input.image_urls, undefined);
  assert.ok(!String(input.prompt).includes("@Image1"));
  assert.deepEqual(
    klingEditInput("A robot", "clip", "https://example.test/ref.png")
      .image_urls,
    ["https://example.test/ref.png"],
  );
});

test("duplicate edits share one job, but another clip or range does not", () => {
  const manager = new GenJobManager();
  const request = { clipHash: "a", start: 0, end: 3 };
  const first = manager.createEditJob(
    "robot",
    undefined,
    "kling-o3",
    undefined,
    request,
  );
  assert.equal(
    manager.createEditJob("robot", undefined, "kling-o3", undefined, request)
      .id,
    first.id,
  );
  assert.notEqual(
    manager.createEditJob("robot", undefined, "kling-o3", undefined, {
      ...request,
      start: 1,
    }).id,
    first.id,
  );
  assert.notEqual(
    manager.createEditJob("robot", undefined, "kling-o3", undefined, {
      ...request,
      clipHash: "b",
    }).id,
    first.id,
  );
});

test("late preflight failures settle the job and notify preview cleanup without touching media", async () => {
  const manager = new GenJobManager();
  const settled: string[] = [];
  manager.onSettled = (job) => settled.push(job.state);
  const job = manager.createEditJob("robot", undefined, "vace");
  await manager.prepareAndRunEdit(job, Buffer.alloc(0), 0, 3, null);
  assert.equal(job.state, "failed");
  assert.equal(job.errorCode, "missing_mask");
  assert.deepEqual(job.files, {});
  assert.deepEqual(settled, ["failed"]);
  assert.ok(job.finishedAt);
});
