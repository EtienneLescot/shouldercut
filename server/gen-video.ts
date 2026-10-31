import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

let cachedFalKey: string | null | undefined;
export function falKey(): string | null {
  if (cachedFalKey !== undefined) return cachedFalKey;
  if (process.env.FAL_KEY) {
    cachedFalKey = process.env.FAL_KEY;
    return cachedFalKey;
  }
  const envPath = join(resolve(process.cwd()), '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const at = line.indexOf('=');
      if (at < 1) continue;
      if (line.slice(0, at).trim() === 'FAL_KEY') {
        cachedFalKey = line.slice(at + 1).trim().replace(/^["']|["']$/g, '') || null;
        return cachedFalKey;
      }
    }
  }
  cachedFalKey = null;
  return cachedFalKey;
}

// POC implementation of docs/generative-video-spec.md §3-4.
// Providers are server-side only; keys never reach the browser.

export type GenJobKind = 'generate_shot' | 'edit_segment';
export type GenJobState = 'preparing' | 'queued' | 'running' | 'done' | 'failed';

export interface GenJob {
  id: string;
  kind: GenJobKind;
  state: GenJobState;
  prompt: string;
  provider: string;
  model: string;
  createdAt: number;
  error?: string;
  providerRef?: string;
  providerStatusUrl?: string;
  providerResponseUrl?: string;
  files: { segment?: string; maskVideo?: string; controlVideo?: string; result?: string; composited?: string };
  estimate: string;
  refImageUrl?: string;
  backend?: string;
  subjectLabel?: string;
  refLabel?: string;
}

const OUTPUT_DIR = resolve(process.cwd(), 'server', 'gen-output');

export function genOutputDir(): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}
export function genFilePath(name: string): string {
  return join(genOutputDir(), name);
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args],
      { timeout: 120_000, windowsHide: true },
      (error) => (error ? reject(new Error('ffmpeg failed: ' + error.message.slice(-400))) : resolvePromise()));
  });
}

async function stubGenerateShot(job: GenJob): Promise<string> {
  const name = job.id + '-stub-result.mp4';
  // Animated procedural clip: moving gradient + noise. Clearly a placeholder.
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'gradients=s=640x360:c0=0x1a2a6b:c1=0xb03a5b:c2=0x0e7a7a:speed=0.02:d=5:r=30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', genFilePath(name),
  ]);
  return name;
}

async function stubEditSegment(job: GenJob, segmentName: string): Promise<string> {
  const name = job.id + '-stub-result.mp4';
  // Labelled placeholder transform: hue rotation + posterise steps via eq/curves.
  await runFfmpeg([
    '-i', genFilePath(segmentName),
    '-vf', 'hue=h=40:s=1.4,eq=saturation=1.3:contrast=1.1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', genFilePath(name),
  ]);
  return name;
}

export interface MaskVideoSource {
  width: number;
  height: number;
  sourceFps: number;
  frames: { frame: number; data: Buffer }[];
}

interface FalQueueResponse { request_id?: string; status_url?: string; response_url?: string }

export async function falUploadFile(localPath: string, fileName: string, contentType = 'video/mp4'): Promise<string> {
  const key = falKey();
  if (!key) throw new Error('FAL_KEY is not configured (set it in the environment or the repo .env file, then restart the dev server)');
  const bytes = readFileSync(localPath);
  let lastError: unknown = null;
  for (const host of ['https://rest.fal.ai', 'https://rest.alpha.fal.ai']) {
    try {
      const initiate = await fetch(host + '/storage/upload/initiate?storage_type=fal-cdn-v3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Key ' + key },
        body: JSON.stringify({ file_name: fileName, content_type: contentType }),
      });
      if (!initiate.ok) throw new Error('fal upload initiate failed: HTTP ' + initiate.status + ' ' + (await initiate.text()).slice(0, 200));
      const urls = (await initiate.json()) as { upload_url?: string; file_url?: string };
      if (!urls.upload_url || !urls.file_url) throw new Error('fal upload initiate returned no urls');
      const put = await fetch(urls.upload_url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: new Uint8Array(bytes) });
      if (!put.ok) throw new Error('fal upload PUT failed: HTTP ' + put.status);
      return urls.file_url;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('fal file upload failed: ' + describeError(lastError));
}

async function falSubmit(model: string, body: Record<string, unknown>): Promise<FalQueueResponse> {
  const key = falKey();
  if (!key) throw new Error('FAL_KEY is not configured (set it in the environment or the repo .env file, then restart the dev server)');
  const response = await fetch('https://queue.fal.run/' + model, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Key ' + key },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('fal submit failed: HTTP ' + response.status + ' ' + (await response.text()).slice(0, 300));
  return (await response.json()) as FalQueueResponse;
}

function findVideoUrl(value: unknown): string | null {
  if (typeof value === 'string') return value.includes('.mp4') ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findVideoUrl(item); if (found) return found; }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const found = findVideoUrl(item);
      if (found) return found;
    }
  }
  return null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? ' (cause: ' + cause.message + ')' : '';
    return error.message + causeText;
  }
  return String(error);
}

async function falPollAndDownload(model: string, queued: FalQueueResponse, job: GenJob): Promise<string> {
  const key = falKey();
  if (!key) throw new Error('FAL_KEY is not configured (set it in the environment or the repo .env file, then restart the dev server)');
  job.providerRef = queued.request_id;
  const statusUrl = queued.status_url ?? ('https://queue.fal.run/' + model + '/requests/' + queued.request_id + '/status');
  const responseUrl = queued.response_url ?? ('https://queue.fal.run/' + model + '/requests/' + queued.request_id);
  job.providerStatusUrl = statusUrl;
  job.providerResponseUrl = responseUrl;
  let consecutiveFailures = 0;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    job.state = attempt === 0 ? 'queued' : 'running';
    try {
      const statusResponse = await fetch(statusUrl, { headers: { Authorization: 'Key ' + key } });
      const status = (await statusResponse.json().catch(() => ({}))) as { status?: string };
      consecutiveFailures = 0;
      if (status.status === 'COMPLETED') break;
      if (status.status === 'FAILED' || status.status === 'ERROR') throw new Error('fal job failed: ' + JSON.stringify(status).slice(0, 300));
      if (attempt === 239) throw new Error('fal job timed out after 20 min of polling (request ' + queued.request_id + ')');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('fal job')) throw error;
      consecutiveFailures += 1;
      if (consecutiveFailures > 12) {
        throw new Error('fal status polling failed repeatedly for request ' + queued.request_id + ': ' + describeError(error));
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const resultResponse = await fetch(responseUrl, { headers: { Authorization: 'Key ' + key } });
      const bodyText = await resultResponse.text();
      if (!resultResponse.ok) {
        // fal reports in-model validation failures here (e.g. fps range),
        // with the actionable detail in the body. Surface it verbatim.
        throw new Error('fal result endpoint HTTP ' + resultResponse.status + ': ' + bodyText.slice(0, 400));
      }
      const result = JSON.parse(bodyText) as unknown;
      const url = findVideoUrl(result);
      if (!url) throw new Error('fal result has no video URL: ' + bodyText.slice(0, 300));
      const media = await fetch(url);
      if (!media.ok) throw new Error('Could not download fal result: HTTP ' + media.status);
      const name = job.id + '-fal-result.mp4';
      writeFileSync(genFilePath(name), Buffer.from(await media.arrayBuffer()));
      return name;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error('fal result download failed for request ' + queued.request_id + ': ' + describeError(lastError));
}

// --- Local ComfyUI workflow repertoire (server/comfy-workflows/) ---
// Tested graphs with fixed internal settings; only declared parameters
// are substituted. The LLM must never improvise sampler settings.

function comfyUrl(): string {
  return process.env.COMFY_URL || 'http://127.0.0.1:8188';
}
function comfyDir(): string {
  return process.env.COMFY_DIR || 'C:\\tmp\\ComfyUI';
}

function probeSize(path: string): Promise<{ width: number; height: number }> {
  return new Promise((resolvePromise, reject) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
      { timeout: 30_000, windowsHide: true },
      (error, stdout) => {
        if (error) return reject(new Error('ffprobe failed: ' + error.message.slice(-200)));
        const [w, h] = stdout.trim().split(',').map(Number);
        if (!w || !h) return reject(new Error('ffprobe: no size for ' + path));
        resolvePromise({ width: w, height: h });
      });
  });
}

function subjectHeightFraction(mask: MaskVideoSource | null): number {
  if (!mask || !mask.frames.length) return 0.7;
  const frame = [...mask.frames].sort((a, b) => a.frame - b.frame)[0];
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < mask.height; y += 1) {
    const row = frame.data.subarray(y * mask.width, (y + 1) * mask.width);
    if (row.some((v) => v > 0)) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) return 0.7;
  return Math.min(0.95, Math.max(0.2, (bottom - top + 1) / mask.height));
}

async function runComfyWorkflow(
  workflowId: string,
  params: Record<string, string | number>,
  job: GenJob,
): Promise<string> {
  const base = comfyUrl();
  let health: Response;
  try {
    health = await fetch(base + '/system_stats');
  } catch {
    throw new Error('Local ComfyUI is not reachable at ' + base + ' (start it in ' + comfyDir() + ': .venv\\Scripts\\python.exe main.py --listen 127.0.0.1 --port 8188 --disable-pinned-memory --reserve-vram 1.5)');
  }
  if (!health.ok) throw new Error('Local ComfyUI health check failed: HTTP ' + health.status);
  const templatePath = resolve(process.cwd(), 'server', 'comfy-workflows', workflowId + '.api.json');
  let text = readFileSync(templatePath, 'utf8');
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'number') {
      text = text.split('"{{' + key + '}}"').join(String(value));
    } else {
      text = text.split('{{' + key + '}}').join(value.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
    }
  }
  const graph = JSON.parse(text) as Record<string, unknown>;
  const submit = await fetch(base + '/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph }),
  });
  if (!submit.ok) throw new Error('ComfyUI submit failed: HTTP ' + submit.status + ' ' + (await submit.text()).slice(0, 300));
  const queued = (await submit.json()) as { prompt_id?: string; node_errors?: unknown };
  if (!queued.prompt_id) throw new Error('ComfyUI returned no prompt_id: ' + JSON.stringify(queued).slice(0, 300));
  if (queued.node_errors && Object.keys(queued.node_errors as object).length) {
    throw new Error('ComfyUI node errors: ' + JSON.stringify(queued.node_errors).slice(0, 400));
  }
  job.providerRef = queued.prompt_id;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    job.state = attempt === 0 ? 'queued' : 'running';
    const histResponse = await fetch(base + '/history/' + queued.prompt_id);
    const hist = (await histResponse.json()) as Record<string, {
      status?: { status_str?: string; messages?: [string, { exception_message?: string }][] };
      outputs?: Record<string, { videos?: { filename: string; subfolder: string }[]; gifs?: { filename: string; subfolder: string }[]; images?: { filename: string; subfolder: string }[] }>;
    }>;
    const entry = hist[queued.prompt_id];
    if (entry?.status?.status_str === 'error') {
      const message = entry.status.messages?.find((m) => m[0] === 'execution_error')?.[1]?.exception_message;
      throw new Error('ComfyUI workflow ' + workflowId + ' failed: ' + (message || 'unknown error').slice(0, 400));
    }
    if (entry?.status?.status_str === 'success' || entry?.outputs) {
      // History lists outputs per node, including input-side video nodes;
      // try every mp4 candidate until one actually downloads as an output.
      const candidates = Object.values(entry.outputs ?? {})
        .flatMap((out) => [...(out.videos ?? []), ...(out.gifs ?? []), ...(out.images ?? [])])
        .filter((item) => item.filename.endsWith('.mp4') && !item.filename.includes(job.id + '-driving'));
      for (const item of candidates) {
        const view = await fetch(base + '/view?filename=' + encodeURIComponent(item.filename) + '&subfolder=' + encodeURIComponent(item.subfolder) + '&type=output');
        if (!view.ok) continue;
        const name = job.id + '-scail-result.mp4';
        writeFileSync(genFilePath(name), Buffer.from(await view.arrayBuffer()));
        return name;
      }
      if (entry?.status?.status_str === 'success') throw new Error('ComfyUI workflow finished without a downloadable mp4 output');
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error('ComfyUI workflow timed out after 30 min (prompt ' + queued.prompt_id + ')');
}

export class GenJobManager {
  private jobs = new Map<string, GenJob>();
  private cache = new Map<string, string>();
  readonly providerName: string;

  constructor() {
    this.providerName = (process.env.GEN_PROVIDER || (falKey() ? 'fal' : 'stub')).toLowerCase();
  }

  private newJob(kind: GenJobKind, prompt: string): GenJob {
    const id = 'gen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const job: GenJob = {
      id, kind, state: 'preparing', prompt,
      provider: this.providerName,
      model: this.providerName === 'fal' ? 'fal-ai/bytedance/seedance-2.0 (generate) / wan-vace-14b (edit)' : 'local ffmpeg stub',
      createdAt: Date.now(), files: {},
      estimate: this.providerName === 'fal'
        ? 'Hosted generation: typically 1-5 min; billed per generated second by the provider.'
        : 'Local stub: seconds; no cost, placeholder result (not AI generation).',
    };
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): GenJob | undefined {
    return this.jobs.get(id);
  }
  list(): GenJob[] {
    return [...this.jobs.values()];
  }

  createGenerateShot(prompt: string): GenJob {
    const cacheKey = createHash('sha256').update('generate_shot|' + prompt).digest('hex').slice(0, 16);
    const existingId = this.cache.get(cacheKey);
    const existing = existingId ? this.jobs.get(existingId) : undefined;
    // Reuse only live or finished jobs; a failed job must be retryable.
    if (existing && existing.state !== 'failed') return existing;
    const job = this.newJob('generate_shot', prompt);
    this.cache.set(cacheKey, job.id);
    void this.runGenerate(job).catch((error: unknown) => {
      job.state = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
    });
    return job;
  }

  private async runGenerate(job: GenJob): Promise<void> {
    if (this.providerName === 'fal') {
      // Validation-phase economy: fastest tier, shortest duration, lowest
      // resolution, no audio. Raise only after a draft is accepted.
      const model = 'bytedance/seedance-2.0/fast/text-to-video';
      const queued = await falSubmit(model, {
        prompt: job.prompt, resolution: '480p', duration: '4',
        aspect_ratio: '16:9', generate_audio: false,
      });
      job.files.result = await falPollAndDownload(model, queued, job);
    } else if (this.providerName === 'stub') {
      job.state = 'running';
      job.files.result = await stubGenerateShot(job);
    } else {
      throw new Error('Unknown GEN_PROVIDER "' + this.providerName + '" (expected fal or stub)');
    }
    job.state = 'done';
  }

  /** Bridge calls this once the browser clip upload for the job has landed. */
  async prepareAndRunEdit(
    job: GenJob, clipBytes: Buffer, start: number, end: number,
    mask: MaskVideoSource | null, targetWidth = 960, targetHeight = 540,
  ): Promise<void> {
    try {
      const sourceName = job.id + '-source.mp4';
      writeFileSync(genFilePath(sourceName), clipBytes);
      // Economy + model contract: VACE is billed per 16 fps video second.
      // Prepare 81 frames at 16 fps (5.06 s window from `start`).
      const frames = 81;
      const segmentName = job.id + '-segment.mp4';
      await runFfmpeg([
        '-ss', String(Math.max(0, start)), '-i', genFilePath(sourceName),
        '-vf', 'fps=16,format=yuv420p', '-frames:v', String(frames),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', genFilePath(segmentName),
      ]);
      job.files.segment = segmentName;
      const controlName = job.id + '-control-edge.mp4';
      await runFfmpeg([
        '-ss', String(Math.max(0, start)), '-i', genFilePath(sourceName),
        '-vf', 'fps=16,edgedetect=low=0.08:high=0.35,format=yuv420p', '-frames:v', String(frames),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', genFilePath(controlName),
      ]);
      job.files.controlVideo = controlName;
      let maskName: string | undefined;
      if (mask && mask.frames.length) {
        const byFrame = new Map(mask.frames.map((f) => [f.frame, f.data]));
        const sorted = [...mask.frames].sort((a, b) => a.frame - b.frame);
        const raw: Buffer[] = [];
        for (let i = 0; i < frames; i += 1) {
          const sourceFrame = Math.round((start + i / 16) * mask.sourceFps);
          let best = sorted[0];
          for (const candidate of sorted) {
            if (Math.abs(candidate.frame - sourceFrame) < Math.abs(best.frame - sourceFrame)) best = candidate;
          }
          raw.push(byFrame.get(best.frame)!);
        }
        const rawName = job.id + '-mask.raw';
        writeFileSync(genFilePath(rawName), Buffer.concat(raw));
        maskName = job.id + '-mask-video.mp4';
        await runFfmpeg([
          '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', mask.width + 'x' + mask.height, '-r', '16',
          '-i', genFilePath(rawName),
          // Dilate the mask a few pixels: community VACE practice and our own
          // tests show exact SAM edges leak and starve differently-proportioned
          // replacements of room.
          '-vf', 'scale=' + targetWidth + ':' + targetHeight + ',dilation,dilation,dilation,format=yuv420p',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', genFilePath(maskName),
        ]);
        job.files.maskVideo = maskName;
      }
      if (job.backend === 'scail') {
        // Local ComfyUI repertoire workflow: scail2-character-replacement.
        // Fixed tested settings live in the template; here we only prepare
        // its declared parameters (driving clip, reframed reference, labels).
        if (!job.refImageUrl) throw new Error('scail backend requires refImageUrl (the replacement character image)');
        job.state = 'running';
        const width = 960;
        const height = 544;
        const length = 65;
        const drivingName = job.id + '-scail-driving.mp4';
        await runFfmpeg([
          '-i', genFilePath(segmentName),
          '-vf', 'scale=' + width + ':' + height + ',fps=16,format=yuv420p', '-frames:v', String(length),
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', genFilePath(drivingName),
        ]);
        const refResponse = await fetch(job.refImageUrl);
        if (!refResponse.ok) throw new Error('Could not download reference image: HTTP ' + refResponse.status);
        const refRawName = job.id + '-scail-ref-src.png';
        writeFileSync(genFilePath(refRawName), Buffer.from(await refResponse.arrayBuffer()));
        // SCAIL-2 rule: reference framing controls output scale. Reframe so
        // the character occupies the same frame-height fraction as the SAM
        // subject (reference subjects are assumed to fill ~80% of their own
        // frame, as in our tested reference).
        const fraction = subjectHeightFraction(mask);
        const refSize = await probeSize(genFilePath(refRawName));
        const scaledHeight = Math.max(64, Math.round(((fraction * height) / 0.8) / 2) * 2);
        const scaledWidth = Math.max(64, Math.round((refSize.width * (scaledHeight / refSize.height)) / 2) * 2);
        const refFramedName = job.id + '-scail-ref.png';
        await runFfmpeg([
          '-i', genFilePath(refRawName),
          '-vf', 'scale=' + scaledWidth + ':' + scaledHeight + ',pad=' + width + ':' + height + ':(' + width + '-iw)/2:(' + height + '-ih)/2:color=0xd8d5cc,format=rgb24',
          '-frames:v', '1', genFilePath(refFramedName),
        ]);
        const inputDir = join(comfyDir(), 'input');
        if (!existsSync(inputDir)) throw new Error('ComfyUI input dir not found: ' + inputDir + ' (set COMFY_DIR)');
        // Stable input names: identical content re-runs hit the ComfyUI node
        // cache instead of re-rendering (jobs are sequential in practice).
        const drivingFile = 'shouldercut-driving.mp4';
        const refFile = 'shouldercut-ref.png';
        copyFileSync(genFilePath(drivingName), join(inputDir, drivingFile));
        copyFileSync(genFilePath(refFramedName), join(inputDir, refFile));
        job.files.result = await runComfyWorkflow('scail2-character-replacement', {
          DRIVING_FILE: drivingFile,
          REF_FILE: refFile,
          DETECT_SUBJECT: job.subjectLabel || 'person',
          DETECT_REF: job.refLabel || 'character',
          POSITIVE: job.prompt,
          WIDTH: width,
          HEIGHT: height,
          LENGTH: length,
          SEED: 42,
          PREFIX: job.id,
        }, job);
        job.state = 'done';
        return;
      }
      if (this.providerName === 'fal') {
        job.state = 'running';
        const videoUrl = await falUploadFile(genFilePath(segmentName), segmentName);
        let generatedName: string;
        if (job.backend === 'kling-o3') {
          if (!job.refImageUrl) throw new Error('kling-o3 backend works best with refImageUrl (the replacement design as @Image1)');
          // Kling O3 edit wants 720p-class input; upscale the prepared segment.
          const klingInputName = job.id + '-kling-input.mp4';
          await runFfmpeg([
            '-i', genFilePath(segmentName), '-vf', 'scale=1280:720,fps=30,format=yuv420p',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', genFilePath(klingInputName),
          ]);
          const klingUrl = await falUploadFile(genFilePath(klingInputName), klingInputName);
          const model = 'fal-ai/kling-video/o3/pro/video-to-video/edit';
          const queued = await falSubmit(model, {
            prompt: job.prompt + ' The source footage is @Video1 and the robot design is @Image1. Replace only the main child in the foreground; keep the room, the bed, the camera and the timing unchanged.',
            video_url: klingUrl,
            image_urls: [job.refImageUrl],
            keep_audio: false,
          });
          generatedName = await falPollAndDownload(model, queued, job);
        } else if (job.backend === 'recast') {
          if (!job.refImageUrl) throw new Error('recast backend requires refImageUrl (one reference photo per replaced person)');
          // Purpose-built character replacement: the model tracks people
          // itself, so no mask/control video is sent and its raw output is
          // kept as-is (no masked recomposition, per SCAIL-2 practice).
          const model = 'minimax/h3-max/recast';
          const queued = await falSubmit(model, {
            video_url: videoUrl,
            reference_image_urls: [job.refImageUrl],
            prompt: job.prompt,
            resolution: '768P', seed: 42,
          });
          generatedName = await falPollAndDownload(model, queued, job);
        } else if (job.backend === 'wan-animate') {
          if (!job.refImageUrl) throw new Error('wan-animate backend requires refImageUrl (the replacement character image)');
          const model = 'fal-ai/wan/v2.2-14b/animate/replace';
          const queued = await falSubmit(model, {
            video_url: videoUrl,
            image_url: job.refImageUrl,
            resolution: '480p', seed: 42,
          });
          generatedName = await falPollAndDownload(model, queued, job);
        } else {
          const maskUrl = maskName ? await falUploadFile(genFilePath(maskName), maskName) : undefined;
          const model = 'fal-ai/wan-vace-14b/inpainting';
          const queued = await falSubmit(model, {
            prompt: job.prompt,
            // Keep the provider quality defaults and append subject negatives;
            // replacing the whole default list (our first tests) weakened it.
            negative_prompt: 'letterboxing, borders, black bars, bright colors, overexposed, static, blurred details, subtitles, style, artwork, painting, picture, still, overall gray, worst quality, low quality, JPEG compression residue, ugly, incomplete, extra fingers, poorly drawn hands, poorly drawn faces, deformed, disfigured, malformed limbs, fused fingers, still picture, cluttered background, three legs, many people in the background, walking backwards, human woman, human child, girl, boy, human skin, hair, dress, clothes, realistic human, person',
            video_url: videoUrl,
            ...(maskUrl ? { mask_video_url: maskUrl } : {}),
            ...(job.refImageUrl ? { ref_image_urls: [job.refImageUrl] } : {}),
            // Tuned away from fal defaults (guidance 5, steps 30): stronger
            // prompt adherence is the main transformation lever this endpoint
            // exposes; denoise/strength exist only in local ComfyUI workflows.
            guidance_scale: 8, num_inference_steps: 40,
            resolution: '480p', num_frames: frames, frames_per_second: 16, seed: 42,
          });
          generatedName = await falPollAndDownload(model, queued, job);
        }
        job.files.result = generatedName;
        if (maskName && job.backend !== 'recast') {
          const compositedName = job.id + '-composited.mp4';
          // Outside the SAM mask, pixels come from the original segment.
          await runFfmpeg([
            '-i', genFilePath(segmentName), '-i', genFilePath(generatedName), '-i', genFilePath(maskName),
            '-filter_complex',
            '[1:v]scale=' + targetWidth + ':' + targetHeight + ',fps=16,setpts=PTS-STARTPTS[g];' +
            '[2:v]scale=' + targetWidth + ':' + targetHeight + ',fps=16,format=gray,setpts=PTS-STARTPTS[m];' +
            '[0:v][g][m]maskedmerge,format=yuv420p[out]',
            '-map', '[out]', '-frames:v', String(frames),
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', genFilePath(compositedName),
          ]);
          job.files.composited = compositedName;
        }
        job.state = 'done';
        return;
      }
      if (this.providerName !== 'stub') throw new Error('Unknown GEN_PROVIDER "' + this.providerName + '"');
      job.state = 'running';
      job.files.result = await stubEditSegment(job, segmentName);
      job.state = 'done';
    } catch (error) {
      job.state = 'failed';
      job.error = error instanceof Error ? describeError(error) : String(error);
    }
  }

  createEditJob(prompt: string, refImageUrl?: string, backend?: string, labels?: { subjectLabel?: string; refLabel?: string }): GenJob {
    const job = this.newJob('edit_segment', prompt);
    job.refImageUrl = refImageUrl;
    job.backend = backend;
    job.subjectLabel = labels?.subjectLabel;
    job.refLabel = labels?.refLabel;
    if (backend === 'wan-animate') job.model = 'fal-ai/wan/v2.2-14b/animate/replace';
    if (backend === 'kling-o3') job.model = 'fal-ai/kling-video/o3/pro/video-to-video/edit';
    if (backend === 'recast') job.model = 'minimax/h3-max/recast';
    if (backend === 'scail') job.model = 'local-comfyui/scail2-character-replacement';
    return job;
  }
}

export function workingPreviewCode(colorHex: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(colorHex.trim());
  const hex = match ? match[1] : '8a8f98';
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return [
    'fn fx(ctx: FxContext) -> vec4f {',
    '  let base = sourceAt(ctx.uv);',
    '  let m = maskBlur(ctx.uv, 2.0);',
    '  let flat = vec3f(' + r.toFixed(3) + ', ' + g.toFixed(3) + ', ' + b.toFixed(3) + ');',
    '  let shade = 0.75 + 0.45 * luminance(base.rgb);',
    '  var col = mix(base.rgb, flat * shade, clamp(m, 0.0, 1.0));',
    '  col += vec3f(1.0, 0.55, 0.15) * maskEdge(ctx.uv) * 0.6;',
    '  return vec4f(col, 1.0);',
    '}',
  ].join('\n');
}

export function outputDirExists(): boolean {
  return existsSync(OUTPUT_DIR);
}
