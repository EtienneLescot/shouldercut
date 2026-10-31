import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeMaskToRaster, type SegmentationMask } from '@meta-sam/parser';

const API_BASE = 'https://api.meta.ai/v1';
const MAX_MASK_WIDTH = 640;

export interface SamMaskFrame {
  frame: number;
  box: { x1: number; y1: number; x2: number; y2: number } | null;
  maskWidth: number;
  maskHeight: number;
  /** Full-frame single-channel mask, 0 or 255 per pixel, base64. */
  dataB64: string;
  ones: number;
}

export interface SamTrackResult {
  prompt: string;
  fileId: string;
  frameWidth: number;
  frameHeight: number;
  frames: SamMaskFrame[];
  billedFrames: number | null;
}

let cachedKey: string | null = null;
function apiKey(): string {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.MODEL_API_KEY || process.env.MUSE_API_KEY;
  if (fromEnv) {
    cachedKey = fromEnv;
    return cachedKey;
  }
  const envPath = join(resolve(process.cwd()), '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const at = line.indexOf('=');
      if (at < 1) continue;
      const name = line.slice(0, at).trim();
      if (name === 'MODEL_API_KEY' || name === 'MUSE_API_KEY') {
        cachedKey = line.slice(at + 1).trim();
        return cachedKey;
      }
    }
  }
  throw new Error('MODEL_API_KEY is not configured (set it in the repo .env file)');
}

const uploadCache = new Map<string, string>();

export async function uploadVideo(bytes: Uint8Array, filename: string, mime: string): Promise<string> {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const hit = uploadCache.get(hash);
  if (hit) return hit;
  const form = new FormData();
  form.append('purpose', 'user_data');
  form.append('file', new Blob([bytes.buffer as ArrayBuffer], { type: mime || 'video/mp4' }), filename || 'clip.mp4');
  const response = await fetch(API_BASE + '/files', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey() },
    body: form,
  });
  const text = await response.text();
  if (!response.ok) throw new Error('SAM file upload failed (' + response.status + '): ' + text.slice(0, 300));
  const id = String((JSON.parse(text) as { id?: unknown }).id || '');
  if (!id) throw new Error('SAM file upload returned no file id');
  uploadCache.set(hash, id);
  return id;
}

const RECORD_PATTERN = /(\d+)<\|box;x1=(-?\d+);y1=(-?\d+);x2=(-?\d+);y2=(-?\d+);w=(\d+);h=(\d+)\|><\|mask;x=0;y=0;data=(\d+),(\d+),([!~][^|]+)\|>/g;

export function parseSamText(text: string): SamTrackResult['frames'] & { frameWidth: number; frameHeight: number } {
  let frameWidth = 0;
  let frameHeight = 0;
  const byFrame = new Map<number, { full: Uint8Array; box: SamMaskFrame['box']; ones: number }>();
  for (const line of text.split('\n')) {
    const header = /^<(\d+)f>(.*)$/.exec(line.trim());
    if (!header) continue;
    const frameIndex = Number(header[1]);
    RECORD_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RECORD_PATTERN.exec(header[2])) !== null) {
      const [, , x1s, y1s, x2s, y2s, ws, hs, mh, mw, payload] = match;
      const box = { x1: Number(x1s), y1: Number(y1s), x2: Number(x2s), y2: Number(y2s) };
      frameWidth = Number(ws);
      frameHeight = Number(hs);
      const mask: SegmentationMask = {
        encoding: payload.startsWith('~') ? 'lossless' : 'one_bit',
        payload,
        width: Number(mw),
        height: Number(mh),
      };
      const raster = decodeMaskToRaster(mask);
      let entry = byFrame.get(frameIndex);
      if (!entry) {
        entry = { full: new Uint8Array(frameWidth * frameHeight), box, ones: 0 };
        byFrame.set(frameIndex, entry);
      }
      for (let y = 0; y < mask.height; y += 1) {
        const fy = box.y1 + y;
        if (fy < 0 || fy >= frameHeight) continue;
        for (let x = 0; x < mask.width; x += 1) {
          if (!raster[y * mask.width + x]) continue;
          const fx = box.x1 + x;
          if (fx < 0 || fx >= frameWidth) continue;
          const at = fy * frameWidth + fx;
          if (entry.full[at] === 0) entry.ones += 1;
          entry.full[at] = 255;
        }
      }
    }
  }
  const frames: SamMaskFrame[] = [...byFrame.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([frame, entry]) => {
      let data = entry.full;
      let width = frameWidth;
      let height = frameHeight;
      if (width > MAX_MASK_WIDTH) {
        const scale = MAX_MASK_WIDTH / width;
        width = MAX_MASK_WIDTH;
        height = Math.max(1, Math.round(frameHeight * scale));
        const small = new Uint8Array(width * height);
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            small[y * width + x] = data[Math.floor(y / scale) * frameWidth + Math.floor(x / scale)];
          }
        }
        data = small;
      }
      return {
        frame,
        box: entry.box,
        maskWidth: width,
        maskHeight: height,
        dataB64: Buffer.from(data).toString('base64'),
        ones: entry.ones,
      };
    });
  return Object.assign(frames, { frameWidth, frameHeight });
}

async function segmentVideo(fileId: string, prompt: string): Promise<{ text: string; billedFrames: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 240_000);
  try {
    const response = await fetch(API_BASE + '/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: 'Bearer ' + apiKey(),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: 'sam-3.1',
        stream: true,
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_video', file_id: fileId },
          ],
        }],
      }),
    });
    if (!response.ok || !response.body) {
      throw new Error('SAM video request failed (' + response.status + '): ' + (await response.text()).slice(0, 300));
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let billedFrames: number | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const event of events) {
        const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const payload = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
          if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') text += payload.delta;
          if (payload.type === 'response.output_text.done' && typeof payload.text === 'string' && payload.text.length > text.length) text = payload.text;
          if (payload.type === 'response.completed') {
            const usage = (payload.response as { usage?: { video_frames_processed?: number } } | undefined)?.usage;
            if (typeof usage?.video_frames_processed === 'number') billedFrames = usage.video_frames_processed;
          }
        } catch { /* keep streaming */ }
      }
    }
    return { text, billedFrames };
  } finally {
    clearTimeout(timer);
  }
}

export async function trackVideo(bytes: Uint8Array, filename: string, mime: string, prompt: string): Promise<SamTrackResult> {
  const phrase = prompt.trim();
  if (!phrase) throw new Error('A SAM prompt (short noun phrase) is required');
  const fileId = await uploadVideo(bytes, filename, mime);
  const { text, billedFrames } = await segmentVideo(fileId, phrase);
  if (!text.trim()) throw new Error('SAM found no object for "' + phrase + '" in this clip');
  const frames = parseSamText(text);
  if (!frames.length) throw new Error('SAM returned no masks for "' + phrase + '"');
  return { prompt: phrase, fileId, frameWidth: frames.frameWidth, frameHeight: frames.frameHeight, frames, billedFrames };
}
