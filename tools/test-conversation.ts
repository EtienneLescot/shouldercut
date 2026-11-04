import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAction, quickPlayback } from "../server/conversation.ts";

test("only unambiguous complete playback commands skip the model", () => {
  assert.equal(quickPlayback("Go to one second.")?.action?.time, 1);
  assert.equal(quickPlayback("Jump to 2.5 seconds")?.action?.time, 2.5);
  assert.equal(quickPlayback("Pause")?.action?.action, "pause");
  for (const text of [
    "Do not pause",
    "Pause then cut",
    "If I say pause",
    "Go to one second and add a blur",
  ]) {
    assert.equal(quickPlayback(text), null);
  }
});
test("invalid or non-finite seek positions never reach the player", () => {
  for (const time of [-1, NaN, Infinity, "2", null, undefined])
    assert.throws(() =>
      validateAction({ name: "control_video", action: "seek", time }),
    );
  assert.equal(
    validateAction({ name: "control_video", action: "seek", time: 2.5 }).time,
    2.5,
  );
});
test("fast route cannot execute unknown tools or empty subjects", () => {
  assert.throws(() => validateAction({ name: "shell", command: "anything" }));
  assert.throws(() =>
    validateAction({ name: "preview_subject", subject: "  " }),
  );
  assert.throws(() => validateAction({ name: "find_moment", query: "" }));
  assert.equal(
    validateAction({ name: "control_video", action: "pause", time: null })
      .action,
    "pause",
  );
});
