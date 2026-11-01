import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Edit graph (docs/SPEC.md §6): the single source of truth for the edit.
// Every user-visible change is an operation here and lands on the undo
// stack with a human label. Clip bytes live on disk keyed by content
// hash; the project document references them by clip id.

export interface CaptionCue { start: number; end: number; text: string }

export interface ProjectClip {
  id: string;
  name: string;
  hash: string;
  duration: number;
  in: number;
  out: number;
  captions: CaptionCue[];
  captionsEnabled: boolean;
}

export interface Project {
  version: 1;
  clips: ProjectClip[];
}

const STORE_DIR = resolve(process.cwd(), 'server', 'clip-store');
const OUTPUT_DIR = resolve(process.cwd(), 'server', 'gen-output');

function storeDir(): string {
  mkdirSync(STORE_DIR, { recursive: true });
  return STORE_DIR;
}
export function clipFilePath(hash: string): string {
  return join(storeDir(), hash + '.mp4');
}
function outPath(name: string): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  return join(OUTPUT_DIR, name);
}

function run(cmd: string, args: string[], timeout = 600_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(cmd + ' failed: ' + (stderr || error.message).slice(-1500)));
        resolvePromise(stdout + '\n' + stderr);
      });
  });
}

async function probeDuration(path: string): Promise<number> {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], 30_000);
  const value = Number(out.trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error('Could not probe duration of ' + path);
  return value;
}

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const pad = (v: number, n = 2) => String(v).padStart(n, '0');
  return pad(h) + ':' + pad(m) + ':' + pad(s) + ',' + pad(r, 3);
}

export function projectSrt(project: Project): string {
  const blocks: string[] = [];
  let offset = 0;
  let index = 1;
  for (const clip of project.clips) {
    if (clip.captionsEnabled) {
      for (const cue of clip.captions) {
        const start = offset + Math.max(0, cue.start - clip.in);
        const end = offset + Math.max(0, cue.end - clip.in);
        if (end > offset && cue.text.trim()) {
          blocks.push(index + '\n' + srtTime(start) + ' --> ' + srtTime(end) + '\n' + cue.text.trim());
          index += 1;
        }
      }
    }
    offset += clip.out - clip.in;
  }
  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}

export class EditGraph {
  private project: Project = { version: 1, clips: [] };
  private undoStack: { label: string; snapshot: string }[] = [];
  private redoStack: { label: string; snapshot: string }[] = [];
  private seq = 0;

  get(): Project {
    return JSON.parse(JSON.stringify(this.project)) as Project;
  }
  totalDuration(): number {
    return this.project.clips.reduce((sum, c) => sum + (c.out - c.in), 0);
  }
  private snapshot(): string {
    return JSON.stringify(this.project);
  }
  private commit(label: string): void {
    this.undoStack.push({ label, snapshot: this.snapshot() });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }
  private find(id: string): ProjectClip {
    const clip = this.project.clips.find((c) => c.id === id);
    if (!clip) throw new Error('Unknown clip id: ' + id);
    return clip;
  }

  async addClip(bytes: Buffer, name: string): Promise<ProjectClip> {
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const path = clipFilePath(hash);
    if (!existsSync(path)) writeFileSync(path, bytes);
    const duration = await probeDuration(path);
    this.commit('add clip ' + name);
    this.seq += 1;
    const clip: ProjectClip = {
      id: 'clip-' + Date.now().toString(36) + '-' + this.seq,
      name: name || 'clip',
      hash, duration,
      in: 0, out: duration,
      captions: [], captionsEnabled: true,
    };
    this.project.clips.push(clip);
    return clip;
  }

  trimClip(id: string, start: number, end: number): ProjectClip {
    const clip = this.find(id);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > clip.duration || end - start < 0.1) {
      throw new Error('Invalid trim range ' + start + '..' + end + ' for clip of ' + clip.duration.toFixed(2) + 's');
    }
    this.commit('trim ' + clip.name);
    clip.in = start;
    clip.out = end;
    return clip;
  }

  splitClip(id: string, at: number): ProjectClip[] {
    const clip = this.find(id);
    if (!Number.isFinite(at) || at <= clip.in + 0.05 || at >= clip.out - 0.05) {
      throw new Error('Split point ' + at + ' is outside the clip range ' + clip.in + '..' + clip.out);
    }
    this.commit('split ' + clip.name);
    this.seq += 1;
    const second: ProjectClip = {
      ...clip,
      id: 'clip-' + Date.now().toString(36) + '-' + this.seq,
      name: clip.name + ' (2)',
      in: at,
      captions: clip.captions.filter((c) => c.end > at).map((c) => ({ ...c })),
    };
    clip.out = at;
    clip.captions = clip.captions.filter((c) => c.start < at);
    const index = this.project.clips.indexOf(clip);
    this.project.clips.splice(index + 1, 0, second);
    return [clip, second];
  }

  moveClip(id: string, toIndex: number): Project {
    const clip = this.find(id);
    if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= this.project.clips.length) {
      throw new Error('Invalid target index ' + toIndex);
    }
    this.commit('move ' + clip.name);
    this.project.clips.splice(this.project.clips.indexOf(clip), 1);
    this.project.clips.splice(toIndex, 0, clip);
    return this.get();
  }

  deleteClip(id: string): Project {
    const clip = this.find(id);
    this.commit('delete ' + clip.name);
    this.project.clips.splice(this.project.clips.indexOf(clip), 1);
    return this.get();
  }

  setCaptions(id: string, cues: CaptionCue[], enabled = true): ProjectClip {
    const clip = this.find(id);
    const clean = (cues || [])
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && typeof c.text === 'string' && c.text.trim())
      .map((c) => ({ start: Math.max(0, c.start), end: Math.min(clip.duration, c.end), text: c.text.trim() }))
      .sort((a, b) => a.start - b.start);
    this.commit('captions on ' + clip.name);
    clip.captions = clean;
    clip.captionsEnabled = enabled;
    return clip;
  }

  async removeSilences(id: string, thresholdDb = -35, minSilence = 0.45): Promise<Project> {
    const clip = this.find(id);
    const path = clipFilePath(clip.hash);
    let stderr = '';
    try {
      stderr = await run('ffmpeg', ['-hide_banner', '-i', path, '-af',
        'silencedetect=noise=' + thresholdDb + 'dB:d=' + minSilence, '-f', 'null', '-'], 300_000);
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
      // A failure here usually means no audio stream: treat as no silences.
      if (!/silence_(start|end)/.test(stderr)) return this.get();
    }
    if (!/Audio:/.test(stderr)) return this.get();
    const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
    const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
    const silences: { start: number; end: number }[] = [];
    for (let i = 0; i < starts.length; i += 1) {
      silences.push({ start: starts[i], end: ends[i] ?? clip.duration });
    }
    const kept: { start: number; end: number }[] = [];
    let cursor = clip.in;
    for (const s of silences) {
      if (s.end <= clip.in || s.start >= clip.out) continue;
      const cutStart = Math.max(clip.in, s.start);
      const cutEnd = Math.min(clip.out, s.end);
      if (cutStart - cursor >= 0.15) kept.push({ start: cursor, end: cutStart });
      cursor = Math.max(cursor, cutEnd);
    }
    if (cursor < clip.out && clip.out - cursor >= 0.15) kept.push({ start: cursor, end: clip.out });
    if (!kept.length) throw new Error('remove_silences would delete the whole clip');
    if (kept.length === 1 && kept[0].start === clip.in && kept[0].end === clip.out) return this.get();
    this.commit('remove silences from ' + clip.name);
    const index = this.project.clips.indexOf(clip);
    const pieces: ProjectClip[] = kept.map((range, i) => {
      this.seq += 1;
      return {
        ...clip,
        id: i === 0 ? clip.id : 'clip-' + Date.now().toString(36) + '-' + this.seq,
        name: clip.name + (kept.length > 1 ? ' ·' + (i + 1) : ''),
        in: range.start, out: range.end,
        captions: clip.captions.filter((c) => c.end > range.start && c.start < range.end),
      };
    });
    this.project.clips.splice(index, 1, ...pieces);
    return this.get();
  }

  undo(): { label: string; project: Project } {
    // commit() stores the PRE-op snapshot, so undo restores it directly.
    const entry = this.undoStack.pop();
    if (!entry) throw new Error('Nothing to undo');
    this.redoStack.push({ label: entry.label, snapshot: this.snapshot() });
    this.project = JSON.parse(entry.snapshot) as Project;
    return { label: entry.label, project: this.get() };
  }

  redo(): { label: string; project: Project } {
    const entry = this.redoStack.pop();
    if (!entry) throw new Error('Nothing to redo');
    this.undoStack.push({ label: entry.label, snapshot: this.snapshot() });
    this.project = JSON.parse(entry.snapshot) as Project;
    return { label: entry.label, project: this.get() };
  }

  async exportMp4(preset: '1080p' | 'vertical-1080x1920' | 'square' = '1080p'): Promise<{ file: string; srtFile: string }> {
    if (!this.project.clips.length) throw new Error('Project has no clips to export');
    const scale = preset === 'vertical-1080x1920'
      ? 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'
      : preset === 'square'
        ? 'scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080'
        : 'scale=min(1920\\,iw):min(1080\\,ih):force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2';
    const stamp = 'export-' + Date.now().toString(36);
    const segmentFiles: string[] = [];
    for (let i = 0; i < this.project.clips.length; i += 1) {
      const clip = this.project.clips[i];
      const segName = stamp + '-part' + i + '.mp4';
      await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-ss', String(clip.in), '-i', clipFilePath(clip.hash), '-t', String(clip.out - clip.in),
        '-vf', scale + ',format=yuv420p', '-r', '30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
        outPath(segName)]);
      segmentFiles.push(segName);
    }
    const listName = stamp + '-list.txt';
    writeFileSync(outPath(listName), segmentFiles.map((f) => "file '" + f + "'").join('\n'));
    const srt = projectSrt(this.project);
    const srtName = stamp + '.srt';
    if (srt) writeFileSync(outPath(srtName), srt);
    const outName = stamp + '.mp4';
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', outPath(listName)];
    if (srt) {
      args.push('-vf', "subtitles='" + outPath(srtName).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'") + "'");
    }
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', outPath(outName));
    await run('ffmpeg', args);
    return { file: outName, srtFile: srt ? srtName : '' };
  }
}

export function readExportFile(name: string): Buffer | null {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '');
  const path = outPath(safe);
  return existsSync(path) ? readFileSync(path) : null;
}
