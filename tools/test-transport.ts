import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transportWindow,
  toShotTime,
  toMediaTime,
} from "../src/transport.ts";

// The bug these guard: the bar, the clock and the total each measured from a
// different origin, so a shot cut out of the middle of a file opened at 0:08
// with the whole file's 0:32 beside it. They all speak shot time now.

test("a shot cut from the middle starts at zero and lasts its own length", () => {
  const shot = transportWindow(32, { in: 8, out: 32 });
  assert.deepEqual(shot, { start: 8, length: 24 });
  assert.equal(toShotTime(8, shot), 0);
  assert.equal(toShotTime(16, shot), 8);
  assert.equal(toMediaTime(0, shot), 8);
  assert.equal(toMediaTime(24, shot), 32);
});

test("a shot that starts at zero is its own window", () => {
  const shot = transportWindow(6, { in: 0, out: 3 });
  assert.deepEqual(shot, { start: 0, length: 3 });
  assert.equal(toShotTime(1.5, shot), 1.5);
  assert.equal(toMediaTime(1.5, shot), 1.5);
});

test("with no shot registered the window is the whole file", () => {
  assert.deepEqual(transportWindow(12, null), { start: 0, length: 12 });
});

test("with nothing loaded the window is empty rather than negative", () => {
  assert.deepEqual(transportWindow(null, null), { start: 0, length: 0 });
  const shot = transportWindow(null, { in: 2, out: 5 });
  assert.deepEqual(shot, { start: 2, length: 3 });
});

test("a shot claiming time the media does not have is clamped, not inverted", () => {
  // The project outlives the file it points at.
  const shot = transportWindow(10, { in: 4, out: 40 });
  assert.deepEqual(shot, { start: 4, length: 6 });
  const past = transportWindow(10, { in: 20, out: 40 });
  assert.equal(past.length, 0);
  assert.ok(past.start <= 10);
});

test("an out before the in never yields a negative length", () => {
  const shot = transportWindow(30, { in: 20, out: 5 });
  assert.ok(shot.length >= 0, "length " + shot.length);
  assert.equal(toShotTime(25, shot), 0);
});

test("times outside the shot clamp to its edges both ways", () => {
  const shot = transportWindow(32, { in: 8, out: 32 });
  assert.equal(toShotTime(0, shot), 0, "before the shot");
  assert.equal(toShotTime(99, shot), 24, "after the shot");
  assert.equal(toMediaTime(-5, shot), 8, "dragged below zero");
  assert.equal(toMediaTime(99, shot), 32, "dragged past the end");
});

test("the mapping round-trips inside the shot", () => {
  const shot = transportWindow(32, { in: 8, out: 32 });
  for (const media of [8, 11.3, 20, 31.999]) {
    assert.ok(
      Math.abs(toMediaTime(toShotTime(media, shot), shot) - media) < 1e-9,
      "round trip at " + media,
    );
  }
});

test("a negative in is treated as the start of the file", () => {
  const shot = transportWindow(10, { in: -3, out: 4 });
  assert.deepEqual(shot, { start: 0, length: 4 });
});
