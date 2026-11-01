import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CaptionCue } from './edit-graph.js';

// Muse Voice Transcribe (SPEC §2.2/§4): file transcription via
// POST https://api.meta.ai/v1/asr/transcribe (multipart: JSON `request`
// part + `audio` part), per Meta's official cookbook client. The API
// returns turn-level timestamps only; caption cues are estimated by
// splitting long turns proportionally to text length.

const API_URL = 'https://api.meta.ai/v1/asr/transcribe';
const MODEL = 'muse-voice-transcribe-1.0';

function apiKey(): string {
  if (process.env.MODEL_API_KEY) return process.env.MODEL_API_KEY;
  if (process.env.MUSE_API_KEY) return process.env.MUSE_API_KEY;
  try {
    const env = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of env.split(/\r?\n/)) {
      const match = line.match(/^(MODEL_API_KEY|MUSE_API_KEY)=(.*)$/);
      if (match && match[2].trim()) return match[2].trim();
    }
  } catch { /* fall through */ }
  throw new Error('MODEL_API_KEY (or MUSE_API_KEY) is not configured');
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { timeout: 300_000, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) return reject(new Error(cmd + ' failed: ' + (stderr || error.message).slice(-400)));
        resolvePromise();
      });
  });
}

interface AsrTurn { transcript?: string; startMs?: number; endMs?: number; speaker?: string }
interface AsrResult { transcript?: string; audioDurationMs?: number; turns?: AsrTurn[] }

export function turnsToCues(turns: AsrTurn[], clipDuration: number): CaptionCue[] {
  const cues: CaptionCue[] = [];
  const maxChars = 72;
  for (const turn of turns) {
    const text = (turn.transcript || '').trim();
    if (!text) continue;
    const start = Math.max(0, (turn.startMs ?? 0) / 1000);
    const end = Math.min(clipDuration, (turn.endMs ?? (turn.startMs ?? 0) + 2000) / 1000);
    if (end <= start) continue;
    if (text.length <= maxChars) {
      cues.push({ start, end, text });
      continue;
    }
    // Split long turns at word boundaries, timing proportional to length.
    const words = text.split(/\s+/);
    const chunks: string[] = [];
    let current = '';
    for (const word of words) {
      if (current && current.length + 1 + word.length > maxChars) {
        chunks.push(current);
        current = word;
      } else {
        current = current ? current + ' ' + word : word;
      }
    }
    if (current) chunks.push(current);
    const total = chunks.reduce((sum, c) => sum + c.length, 0) || 1;
    let cursor = start;
    for (const chunk of chunks) {
      const span = (end - start) * (chunk.length / total);
      cues.push({ start: cursor, end: Math.min(end, cursor + Math.max(0.6, span)), text: chunk });
      cursor += span;
    }
  }
  return cues;
}

async function transcribeWavBytes(audio: Buffer, mode: 'ENDPOINTING' | 'PUSH_TO_TALK'): Promise<AsrResult> {
  if (audio.length > 32 * 1024 * 1024) throw new Error('Audio exceeds the 32 MB transcription cap; trim the clip first');
  const form = new FormData();
  form.append('request', new Blob(
    [JSON.stringify({ mode, model: MODEL, audioEncoding: 'WAV' })],
    { type: 'application/json' },
  ));
  form.append('audio', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'audio.wav');
  const response = await fetch(API_URL + '?sessionId=shouldercut-' + Date.now().toString(36), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey() },
    body: form,
  });
  if (!response.ok) {
    throw new Error('Muse Voice Transcribe failed: HTTP ' + response.status + ' ' + (await response.text()).slice(0, 300));
  }
  return (await response.json()) as AsrResult;
}

export async function transcribeClipAudio(
  clipPath: string,
  workDir: string,
  clipDuration: number,
): Promise<{ cues: CaptionCue[]; transcript: string; audioDurationMs: number }> {
  const wavPath = join(workDir, 'transcribe-' + Date.now().toString(36) + '.wav');
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-i', clipPath, '-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', wavPath]);
  const result = await transcribeWavBytes(readFileSync(wavPath), 'ENDPOINTING');
  const turns = result.turns ?? [];
  const cues = turnsToCues(turns, clipDuration);
  return {
    cues,
    transcript: result.transcript ?? turns.map((t) => t.transcript || '').join(' ').trim(),
    audioDurationMs: result.audioDurationMs ?? 0,
  };
}

// Push-to-talk fallback (SPEC §4/§8): one recorded command in, transcript out.
export async function transcribeCommandAudio(inputPath: string, workDir: string): Promise<string> {
  const wavPath = join(workDir, 'command-' + Date.now().toString(36) + '.wav');
  await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', wavPath]);
  const result = await transcribeWavBytes(readFileSync(wavPath), 'PUSH_TO_TALK');
  const text = (result.transcript ?? (result.turns ?? []).map((t) => t.transcript || '').join(' ')).trim();
  if (!text) throw new Error('No speech recognized in the recording');
  return text;
}
