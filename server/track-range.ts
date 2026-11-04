import { execFile } from 'node:child_process';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SamTrackResult } from './sam.js';

const exec = promisify(execFile);
export const TRACK_FPS = 12;
export const MAX_TRACK_SECONDS = 12;

export async function sourceFrameRate(source: string): Promise<number> {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=avg_frame_rate', '-of', 'default=nw=1:nk=1', source], { windowsHide: true, timeout: 10_000 });
  const [n, d = 1] = stdout.trim().split('/').map(Number);
  const fps = n / d;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('Impossible de déterminer la cadence du clip pour aligner le suivi.');
  return fps;
}

export function trackingRange(duration: number, start?: unknown, end?: unknown): { start: number; end: number } {
  if (start == null && end == null && duration > MAX_TRACK_SECONDS) {
    throw new Error('Pour suivre cet objet, indiquez un passage de 12 secondes maximum (début et fin). La vidéo entière est trop longue pour un aperçu interactif.');
  }
  const a = Number(start ?? 0), b = Number(end ?? duration);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a || b > duration + .05) {
    throw new Error('Le passage à suivre doit avoir un début et une fin valides dans le clip.');
  }
  if (b - a > MAX_TRACK_SECONDS + .001) throw new Error('Choisissez un passage de 12 secondes maximum pour le suivi d’objet.');
  return { start: a, end: Math.min(b, duration) };
}

/** Bound SAM's workload before uploading, rather than sending a whole movie. */
export async function trackingInput(source: string, range: { start: number; end: number }): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'shouldercut-sam-'));
  const output = join(directory, 'excerpt.mp4');
  try {
    await exec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(range.start),
      '-i', source, '-t', String(range.end - range.start), '-an',
      '-vf', 'scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=' + TRACK_FPS,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', output], { windowsHide: true, timeout: 20_000 });
    return await readFile(output);
  } finally {
    // A freshly created, task-owned directory, never a user-derived path.
    await unlink(output).catch(() => {});
    await rmdir(directory);
  }
}

export function alignTracking(track: SamTrackResult, range: { start: number; end: number }, sourceFps: number): SamTrackResult {
  const fps = sourceFps > 0 ? sourceFps : 30;
  const frames = track.frames.map((f) => ({ ...f, frame: Math.round((range.start + f.frame / TRACK_FPS) * fps) }));
  const sample = frames[0];
  if (!sample) return track;
  const empty = { ...sample, box: null, ones: 0, dataB64: Buffer.alloc(sample.maskWidth * sample.maskHeight).toString('base64') };
  if (range.start > 0) frames.unshift({ ...empty, frame: 0 });
  // Do not freeze the final object's silhouette outside the tracked passage.
  frames.push({ ...empty, frame: Math.ceil(range.end * fps) });
  return { ...track, frames, start: range.start, end: range.end };
}
