// Export regression check. Run from the repo root: npm test
//
// Covers the two things that were wrong on Nov 2 and are easy to break again:
//   1. a sub-1080p source must FILL the 1080p preset, not sit letterboxed
//      in the middle of a black 1920x1080 frame;
//   2. when the browser hands back a clip rendered through the shader chain,
//      the exported video must come from that render, with the audio still
//      taken from the source.
//
// No framework: solid-colour clips in, one sampled pixel out.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EditGraph } from '../server/edit-graph.ts';

const exec = promisify(execFile);
const tmp = mkdtempSync(join(tmpdir(), 'shouldercut-test-'));

/** A one-second 640x360 clip of one flat colour, with silent audio. */
async function solidClip(name: string, colour: string, withAudio: boolean): Promise<string> {
  const path = join(tmp, name);
  const args = ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=${colour}:s=640x360:d=1:r=30`];
  if (withAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '1', '-c:a', 'aac');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path);
  await exec('ffmpeg', args);
  return path;
}

/** RGB at one point of the exported frame, via ffmpeg's rawvideo output.
 *  Crops 2x2 rather than 1x1: yuv420p chroma needs even dimensions. */
async function pixelAt(video: string, x: number, y: number): Promise<[number, number, number]> {
  const raw = join(tmp, 'probe.rgb');
  await exec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-ss', '0.5', '-i', video, '-frames:v', '1',
    '-vf', `crop=2:2:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
  const b = readFileSync(raw);
  return [b[0], b[1], b[2]];
}

async function streamCount(video: string, kind: 'v' | 'a'): Promise<number> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', kind,
    '-show_entries', 'stream=index', '-of', 'csv=p=0', video]);
  return stdout.trim() ? stdout.trim().split('\n').length : 0;
}

async function dimensions(video: string): Promise<string> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video]);
  return stdout.trim();
}

function isRed([r, g, b]: [number, number, number]): boolean { return r > 150 && g < 90 && b < 90; }
function isGreen([r, g, b]: [number, number, number]): boolean { return g > 110 && r < 90 && b < 90; }

try {
  const sourcePath = await solidClip('source.mp4', 'red', true);
  const renderPath = await solidClip('render.mp4', 'green', false);

  const graph = new EditGraph();
  const clip = await graph.addClip(new Uint8Array(readFileSync(sourcePath)), 'source.mp4');

  // 1. Plain export: the preset must scale the source up to fill 1920x1080.
  const plain = await graph.exportMp4('1080p');
  const plainFile = join(process.cwd(), 'server', 'gen-output', plain.file);
  assert.equal(await dimensions(plainFile), '1920,1080', '1080p preset must output 1920x1080');
  const corner = await pixelAt(plainFile, 8, 8);
  assert.ok(isRed(corner),
    `a 16:9 source must fill the 1080p frame, corner was rgb(${corner}) — letterbox regression`);

  // 2. Rendered export: video from the render, audio still from the source.
  const baked = await graph.exportMp4('1080p', new Map([[clip.id, readFileSync(renderPath)]]));
  const bakedFile = join(process.cwd(), 'server', 'gen-output', baked.file);
  const centre = await pixelAt(bakedFile, 960, 540);
  assert.ok(isGreen(centre),
    `exported video must come from the render, centre was rgb(${centre}) — effects are not being baked in`);
  assert.equal(await streamCount(bakedFile, 'a'), 1, 'audio must survive from the source clip');
  assert.equal(await streamCount(bakedFile, 'v'), 1, 'exactly one video stream');

  console.log('export checks passed');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
