// Pixel-level regression: VACE must receive missing subject pixels, not
// the original subject. Run: node --experimental-strip-types tools/test-inpainting.ts
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prepareInpaintingControl } from '../server/gen-video.ts';

const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'shouldercut-inpaint-test-'));
const source = join(directory, 'source.mp4'), mask = join(directory, 'mask.mp4');
const control = join(directory, 'control.mp4'), pixels = join(directory, 'frame.rgb');
try {
  await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=64x64:r=16:d=1', '-pix_fmt', 'yuv420p', source]);
  await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:r=16:d=1',
    '-vf', 'drawbox=x=0:y=0:w=32:h=64:color=white:t=fill', '-pix_fmt', 'yuv420p', mask]);
  await prepareInpaintingControl(source, mask, control, 64, 64, 16);
  await exec('ffmpeg', ['-y', '-v', 'error', '-i', control, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', pixels]);
  const rgb = await readFile(pixels);
  const gray = [...rgb.subarray((8 * 64 + 8) * 3, (8 * 64 + 8) * 3 + 3)];
  const red = [...rgb.subarray((8 * 64 + 48) * 3, (8 * 64 + 48) * 3 + 3)];
  assert.ok(gray.every((v) => Math.abs(v - 127) < 5), 'the masked subject must be neutral gray: ' + gray);
  assert.ok(red[0] > 230 && red[1] < 15 && red[2] < 15, 'unmasked source pixels must be preserved');
  console.log('inpainting preparation checks passed');
} finally {
  for (const file of [source, mask, control, pixels]) await unlink(file).catch(() => {});
  await rmdir(directory);
}
