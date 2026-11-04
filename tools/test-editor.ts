// Regression checks for the timeout and partial-result failure modes.
// Run: node --experimental-strip-types --test tools/test-editor.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MuseEvents, museArgs } from '../server/muse-runner.ts';
import { alignTracking, trackingRange } from '../server/track-range.ts';

test('Muse event frames may be split across arbitrary stdout chunks', () => {
  const progress: string[] = [];
  const events = new MuseEvents((p) => progress.push(p.phase));
  const output = [
    { payload: { kind: 'task_lifecycle', event: { kind: 'proposed', task_kind: 'tool.mcp__shouldercut_fx__trim_clip' } } },
    { payload: { kind: 'run_output_delta', text: 'Unconfirmed intermediate answer' } },
    { payload: { kind: 'run_terminal', terminal: 'completed', text: 'First second removed.' } },
  ].map((row) => JSON.stringify(row)).join('\n');
  for (let i = 0; i < output.length; i += 7) events.push(output.slice(i, i + 7));
  events.finish();
  assert.deepEqual(progress, ['Trimming the clip']);
  assert.equal(events.reply, 'First second removed.');
  assert.equal(events.terminal, 'completed');
});

test('partial output is never mistaken for a completed operation', () => {
  const events = new MuseEvents();
  events.push(JSON.stringify({ payload: { kind: 'run_output_delta', text: 'Done' } }) + '\n');
  assert.equal(events.reply, '');
  assert.equal(events.terminal, undefined);
});

test('editor has an explicit model and no personal skills or reminder agents', () => {
  const args = museArgs({ executable: 'muse', workspace: '.', mcpScript: 'mcp.mjs', prompt: 'hello' });
  for (const flag of ['--json', '--no-foreign-personal-context', '--disable-reminders', '--disable-shell', '--disable-write']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--preset') + 1], 'empty');
  assert.ok(args.includes('--model'));
  assert.ok(!args.includes('--yolo'));
});

test('a long video cannot silently become a full synchronous SAM request', () => {
  assert.throws(() => trackingRange(266.4), /at most 12 seconds/);
  assert.throws(() => trackingRange(266.4, 0, 266.4), /12 seconds/);
  assert.throws(() => trackingRange(6, 5, 9), /valid start and end/);
  assert.throws(() => trackingRange(6, NaN, 4), /valid start and end/);
  assert.deepEqual(trackingRange(266.4, 100, 105), { start: 100, end: 105 });
  assert.deepEqual(trackingRange(6), { start: 0, end: 6 });
});

test('excerpt masks align with source time and stop outside the passage', () => {
  const frame = { frame: 0, box: { x1: 0, y1: 0, x2: 2, y2: 1 }, maskWidth: 2, maskHeight: 1, dataB64: '//8=', ones: 2 };
  const track = alignTracking({ prompt: 'car', fileId: 'test', frameWidth: 2, frameHeight: 1, billedFrames: 2,
    frames: [frame, { ...frame, frame: 12 }] }, { start: 10, end: 12 }, 24);
  assert.deepEqual(track.frames.map((f) => f.frame), [0, 240, 264, 288]);
  assert.equal(track.frames[0].ones, 0);
  assert.equal(track.frames[3].ones, 0);
  assert.equal(track.frames[1].ones, 2);
  assert.equal(track.start, 10);
});
