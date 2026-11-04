import { measure, record } from "./diagnostics.ts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

let cachedFalKey: string | null | undefined;
export function falKey(): string | null {
  if (cachedFalKey !== undefined) return cachedFalKey;
  if (process.env.FAL_KEY) {
    cachedFalKey = process.env.FAL_KEY;
    return cachedFalKey;
  }
  const envPath = join(resolve(process.cwd()), ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const at = line.indexOf("=");
      if (at < 1) continue;
      if (line.slice(0, at).trim() === "FAL_KEY") {
        cachedFalKey =
          line
            .slice(at + 1)
            .trim()
            .replace(/^["']|["']$/g, "") || null;
        return cachedFalKey;
      }
    }
  }
  cachedFalKey = null;
  return cachedFalKey;
}

// POC implementation of docs/generative-video-spec.md §3-4.
// Providers are server-side only; keys never reach the browser.

export type GenJobKind = "generate_shot" | "edit_segment";
export type GenJobState =
  | "preparing"
  | "queued"
  | "running"
  | "done"
  | "failed";

export interface GenJob {
  id: string;
  kind: GenJobKind;
  state: GenJobState;
  prompt: string;
  provider: string;
  model: string;
  createdAt: number;
  error?: string;
  errorCode?: string;
  finishedAt?: number;
  inputKey?: string;
  providerRef?: string;
  providerStatusUrl?: string;
  providerResponseUrl?: string;
  files: {
    segment?: string;
    maskVideo?: string;
    controlVideo?: string;
    result?: string;
    composited?: string;
  };
  estimate: string;
  refImageUrl?: string;
  backend?: string;
  subjectLabel?: string;
  refLabel?: string;
}

export class GenerationInputError extends Error {
  readonly retryable = false;
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "GenerationInputError";
  }
}

export function validateEditInputs(
  backend = "vace",
  reference?: string,
  hasMask?: boolean,
): void {
  if (
    ["recast", "wan-animate", "scail", "scail-animate"].includes(backend) &&
    !reference?.trim()
  ) {
    throw new GenerationInputError(
      "missing_reference",
      "This model needs a reference image. Without one, use kling-o3 (description only) or vace (with a cutout). Do not run this model again with the same parameters.",
    );
  }
  if (["vace", "vace-local"].includes(backend) && hasMask === false) {
    throw new GenerationInputError(
      "missing_mask",
      "Cut out the subject on the same range first, then start the transformation.",
    );
  }
}

/** Fit a clip's own shape into a pixel budget, with both sides a multiple of
 * `multiple`. Never an upscale, beyond that rounding.
 *
 * Every working size in this pipeline goes through here. Pinning both sides of
 * a scale= expression is how a portrait clip gets handed to a model as a
 * smeared 16:9 picture: the model returns a 16:9 near-copy, the composite
 * pastes it back, and the edit the user asked for silently never happens. A
 * budget says how many pixels we are willing to spend; the clip says what
 * shape they go in. `multiple` is 16 for diffusion backends (latent stride)
 * and 2 for anything that only needs yuv420p. */
export function fitToBudget(
  source: { width: number; height: number },
  budgetWidth: number,
  budgetHeight: number,
  multiple = 2,
): { width: number; height: number } {
  const scale = Math.min(
    1,
    Math.sqrt((budgetWidth * budgetHeight) / (source.width * source.height)),
  );
  const quantise = (value: number): number =>
    Math.max(multiple, Math.round((value * scale) / multiple) * multiple);
  return { width: quantise(source.width), height: quantise(source.height) };
}

export function klingEditInput(
  prompt: string,
  videoUrl: string,
  reference?: string,
): Record<string, unknown> {
  return {
    prompt:
      prompt +
      " The source footage is @Video1." +
      (reference ? " The reference design is @Image1." : "") +
      " Preserve the unedited surroundings, camera and timing.",
    video_url: videoUrl,
    ...(reference ? { image_urls: [reference] } : {}),
    keep_audio: false,
  };
}

const OUTPUT_DIR = resolve(process.cwd(), "server", "gen-output");

export function genOutputDir(): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  return OUTPUT_DIR;
}
export function genFilePath(name: string): string {
  return join(genOutputDir(), name);
}

function runFfmpeg(args: string[]): Promise<void> {
  return measure(
    "video.ffmpeg",
    () =>
      new Promise<void>((resolvePromise, reject) => {
        execFile(
          "ffmpeg",
          ["-y", "-hide_banner", "-loglevel", "error", ...args],
          { timeout: 120_000, windowsHide: true },
          (error) =>
            error
              ? reject(new Error("ffmpeg failed: " + error.message.slice(-400)))
              : resolvePromise(),
        );
      }),
  );
}

/** VACE expects missing pixels to be neutral gray, not the old subject.
 * https://github.com/ali-vilab/VACE/blob/main/UserGuide.md#31-vace-recognizable-inputs
 */
export async function prepareInpaintingControl(
  source: string,
  mask: string,
  output: string,
  width: number,
  height: number,
  frames: number,
): Promise<void> {
  await runFfmpeg([
    "-i",
    source,
    "-f",
    "lavfi",
    "-i",
    `color=0x7f7f7f:s=${width}x${height}:r=16`,
    "-i",
    mask,
    "-filter_complex",
    `[0:v]scale=${width}:${height},fps=16,format=gbrp,setpts=PTS-STARTPTS[s];` +
      "[1:v]fps=16,format=gbrp,setpts=PTS-STARTPTS[g];" +
      `[2:v]scale=${width}:${height},fps=16,format=gbrp,setpts=PTS-STARTPTS[m];` +
      "[s][g][m]maskedmerge,format=yuv420p[out]",
    "-map",
    "[out]",
    "-frames:v",
    String(frames),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-an",
    output,
  ]);
}

/** How long a generated shot is asked to be. One constant, so the stub cannot
 * stand in for a different contract than the one the provider is given. */
export const GENERATE_SECONDS = 4;

async function stubGenerateShot(job: GenJob): Promise<string> {
  const name = job.id + "-stub-result.mp4";
  // Animated procedural clip: moving gradient + noise. Clearly a placeholder.
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "gradients=s=640x360:c0=0x1a2a6b:c1=0xb03a5b:c2=0x0e7a7a:speed=0.02:d=" +
      GENERATE_SECONDS +
      ":r=30",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    genFilePath(name),
  ]);
  return name;
}

async function stubEditSegment(
  job: GenJob,
  segmentName: string,
): Promise<string> {
  const name = job.id + "-stub-result.mp4";
  // Placeholder transform, deliberately unmistakable: a photo negative reads
  // as "not a real result" at a glance, and it moves enough pixels that the
  // dogfooding no-op check (tools/dogfood.ts) measures a real difference even
  // when only the masked part of the frame survives into the composite.
  await runFfmpeg([
    "-i",
    genFilePath(segmentName),
    "-vf",
    "negate,hue=h=40:s=1.4",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-an",
    genFilePath(name),
  ]);
  return name;
}

// --- What the backend actually received (tools/dogfood.ts) ---
// Every file this server hands to a generation backend goes through
// falUploadFile or stageComfyInput, whichever backend is in play. Recording
// it in those two places, once, is what lets a dogfooding pass measure the
// picture the model actually saw rather than the one we meant to send: a flat
// scale=1280:720 squashed every portrait clip into 16:9 and nothing, anywhere,
// reported it.
const providerInputs: string[] = [];

function recordProviderInput(localPath: string): void {
  providerInputs.push(localPath);
  if (providerInputs.length > 500) providerInputs.splice(0, 250);
}

/** Files handed to the backend for this job, in preparation order. The first
 * is the picture the model works from; later ones are masks, control videos
 * or references. */
export function providerInputsFor(jobId: string): string[] {
  return providerInputs.filter((path) => basename(path).startsWith(jobId + "-"));
}

/** GEN_DRY_RUN=1: prepare every provider input for real, then stop at the
 * network (or GPU) edge, so a dogfooding pass over the sample set costs
 * nothing. The stand-in result is the prepared input put through the local
 * stub transform, so the trim and composite stages still run on real
 * geometry. */
function dryRun(): boolean {
  return process.env.GEN_DRY_RUN === "1";
}

function dryRunResult(job: GenJob): Promise<string> {
  const prepared = providerInputsFor(job.id);
  return prepared.length
    ? stubEditSegment(job, basename(prepared[0]))
    : stubGenerateShot(job);
}

export interface MaskVideoSource {
  width: number;
  height: number;
  sourceFps: number;
  frames: { frame: number; data: Buffer }[];
}

interface FalQueueResponse {
  request_id?: string;
  status_url?: string;
  response_url?: string;
}

export async function falUploadFile(
  localPath: string,
  fileName: string,
  contentType = "video/mp4",
): Promise<string> {
  recordProviderInput(localPath);
  if (dryRun()) return "dry-run:" + fileName;
  return measure("generation.upload", () =>
    falUploadFileRaw(localPath, fileName, contentType),
  );
}

async function falUploadFileRaw(
  localPath: string,
  fileName: string,
  contentType = "video/mp4",
): Promise<string> {
  const key = falKey();
  if (!key)
    throw new Error(
      "FAL_KEY is not configured (set it in the environment or the repo .env file, then restart the dev server)",
    );
  const bytes = readFileSync(localPath);
  let lastError: unknown = null;
  for (const host of ["https://rest.fal.ai", "https://rest.alpha.fal.ai"]) {
    try {
      const initiate = await fetch(
        host + "/storage/upload/initiate?storage_type=fal-cdn-v3",
        {
          method: "POST",
          signal: AbortSignal.timeout(20_000),
          headers: {
            "Content-Type": "application/json",
            Authorization: "Key " + key,
          },
          body: JSON.stringify({
            file_name: fileName,
            content_type: contentType,
          }),
        },
      );
      if (!initiate.ok)
        throw new Error(
          "fal upload initiate failed: HTTP " +
            initiate.status +
            " " +
            (await initiate.text()).slice(0, 200),
        );
      const urls = (await initiate.json()) as {
        upload_url?: string;
        file_url?: string;
      };
      if (!urls.upload_url || !urls.file_url)
        throw new Error("fal upload initiate returned no urls");
      const put = await fetch(urls.upload_url, {
        method: "PUT",
        signal: AbortSignal.timeout(120_000),
        headers: { "Content-Type": contentType },
        body: new Uint8Array(bytes),
      });
      if (!put.ok) throw new Error("fal upload PUT failed: HTTP " + put.status);
      return urls.file_url;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("fal file upload failed: " + describeError(lastError));
}

async function falSubmit(
  model: string,
  body: Record<string, unknown>,
): Promise<FalQueueResponse> {
  if (dryRun()) return { request_id: "dry-run" };
  return measure("generation.submit", () => falSubmitRaw(model, body));
}

async function falSubmitRaw(
  model: string,
  body: Record<string, unknown>,
): Promise<FalQueueResponse> {
  const key = falKey();
  if (!key)
    throw new Error(
      "FAL_KEY is not configured (set it in the environment or the repo .env file, then restart the dev server)",
    );
  const response = await fetch("https://queue.fal.run/" + model, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/json",
      Authorization: "Key " + key,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      "fal submit failed: HTTP " +
        response.status +
        " " +
        (await response.text()).slice(0, 300),
    );
  return (await response.json()) as FalQueueResponse;
}

function findVideoUrl(value: unknown): string | null {
  if (typeof value === "string") return value.includes(".mp4") ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
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
    const causeText =
      cause instanceof Error ? " (cause: " + cause.message + ")" : "";
    return error.message + causeText;
  }
  return String(error);
}

async function falPollAndDownload(
  model: string,
  queued: FalQueueResponse,
  job: GenJob,
): Promise<string> {
  if (dryRun()) return dryRunResult(job);
  return measure("generation.provider", () =>
    falPollAndDownloadRaw(model, queued, job),
  );
}

async function falPollAndDownloadRaw(
  model: string,
  queued: FalQueueResponse,
  job: GenJob,
): Promise<string> {
  const key = falKey();
  if (!key)
    throw new Error(
      "FAL_KEY is not configured (set it in the environment or the repo .env file, then restart the dev server)",
    );
  job.providerRef = queued.request_id;
  const statusUrl =
    queued.status_url ??
    "https://queue.fal.run/" +
      model +
      "/requests/" +
      queued.request_id +
      "/status";
  const responseUrl =
    queued.response_url ??
    "https://queue.fal.run/" + model + "/requests/" + queued.request_id;
  job.providerStatusUrl = statusUrl;
  job.providerResponseUrl = responseUrl;
  let consecutiveFailures = 0;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (attempt === 0) job.state = "queued";
    try {
      const statusResponse = await fetch(statusUrl, {
        signal: AbortSignal.timeout(20_000),
        headers: { Authorization: "Key " + key },
      });
      if (!statusResponse.ok) {
        if (
          statusResponse.status >= 400 &&
          statusResponse.status < 500 &&
          statusResponse.status !== 429
        ) {
          throw new Error(
            "fal job status rejected: HTTP " + statusResponse.status,
          );
        }
        throw new Error(
          "fal status temporarily unavailable: HTTP " + statusResponse.status,
        );
      }
      const status = (await statusResponse.json().catch(() => ({}))) as {
        status?: string;
      };
      consecutiveFailures = 0;
      if (status.status === "COMPLETED") break;
      const next = status.status === "IN_QUEUE" ? "queued" : "running";
      if (job.state !== next)
        record("generation.state", {
          jobId: job.id,
          status: next,
          elapsed_ms: Date.now() - job.createdAt,
        });
      job.state = next;
      if (status.status === "FAILED" || status.status === "ERROR")
        throw new Error(
          "fal job failed: " + JSON.stringify(status).slice(0, 300),
        );
      if (attempt === 239)
        throw new Error(
          "fal job timed out after 20 min of polling (request " +
            queued.request_id +
            ")",
        );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("fal job"))
        throw error;
      consecutiveFailures += 1;
      if (consecutiveFailures > 12) {
        throw new Error(
          "fal status polling failed repeatedly for request " +
            queued.request_id +
            ": " +
            describeError(error),
        );
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const resultResponse = await fetch(responseUrl, {
        signal: AbortSignal.timeout(20_000),
        headers: { Authorization: "Key " + key },
      });
      const bodyText = await resultResponse.text();
      if (!resultResponse.ok) {
        // fal reports in-model validation failures here (e.g. fps range),
        // with the actionable detail in the body. Surface it verbatim.
        const message =
          "fal result endpoint HTTP " +
          resultResponse.status +
          ": " +
          bodyText.slice(0, 400);
        if (
          resultResponse.status >= 400 &&
          resultResponse.status < 500 &&
          resultResponse.status !== 429
        ) {
          throw new GenerationInputError("provider_rejected", message);
        }
        throw new Error(message);
      }
      const result = JSON.parse(bodyText) as unknown;
      const url = findVideoUrl(result);
      if (!url)
        throw new Error(
          "fal result has no video URL: " + bodyText.slice(0, 300),
        );
      const media = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!media.ok)
        throw new Error("Could not download fal result: HTTP " + media.status);
      const name = job.id + "-fal-result.mp4";
      writeFileSync(genFilePath(name), Buffer.from(await media.arrayBuffer()));
      return name;
    } catch (error) {
      if (error instanceof GenerationInputError) throw error;
      lastError = error;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(
    "fal result download failed for request " +
      queued.request_id +
      ": " +
      describeError(lastError),
  );
}

// --- Local ComfyUI workflow repertoire (server/comfy-workflows/) ---
// Tested graphs with fixed internal settings; only declared parameters
// are substituted. The LLM must never improvise sampler settings.

function comfyUrl(): string {
  return process.env.COMFY_URL || "http://127.0.0.1:8188";
}
function comfyDir(): string {
  return process.env.COMFY_DIR || "E:\\ComfyUI";
}

/** The one hand-off point into local ComfyUI: stage a prepared file under the
 * name its workflow template expects, and record what the graph will read. */
function stageComfyInput(localPath: string, name: string): string {
  recordProviderInput(localPath);
  if (dryRun()) return name;
  const inputDir = join(comfyDir(), "input");
  if (!existsSync(inputDir))
    throw new Error(
      "ComfyUI input dir not found: " + inputDir + " (set COMFY_DIR)",
    );
  copyFileSync(localPath, join(inputDir, name));
  return name;
}

function probeSize(path: string): Promise<{ width: number; height: number }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        path,
      ],
      { timeout: 30_000, windowsHide: true },
      (error, stdout) => {
        if (error)
          return reject(
            new Error("ffprobe failed: " + error.message.slice(-200)),
          );
        const [w, h] = stdout.trim().split(",").map(Number);
        if (!w || !h) return reject(new Error("ffprobe: no size for " + path));
        resolvePromise({ width: w, height: h });
      },
    );
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
  params: Record<string, string | number | boolean>,
  job: GenJob,
): Promise<string> {
  if (dryRun()) return dryRunResult(job);
  const base = comfyUrl();
  let health: Response;
  try {
    health = await fetch(base + "/system_stats");
  } catch {
    throw new Error(
      "Local ComfyUI is not reachable at " +
        base +
        " (start it in " +
        comfyDir() +
        ": .venv\\Scripts\\python.exe main.py --listen 127.0.0.1 --port 8188 --disable-pinned-memory --reserve-vram 1.5)",
    );
  }
  if (!health.ok)
    throw new Error("Local ComfyUI health check failed: HTTP " + health.status);
  const templatePath = resolve(
    process.cwd(),
    "server",
    "comfy-workflows",
    workflowId + ".api.json",
  );
  let text = readFileSync(templatePath, "utf8");
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "number" || typeof value === "boolean") {
      text = text.split('"{{' + key + '}}"').join(String(value));
      text = text.split("{{" + key + "}}").join(String(value));
    } else {
      text = text
        .split("{{" + key + "}}")
        .join(value.replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
    }
  }
  const graph = JSON.parse(text) as Record<string, unknown>;
  const submit = await fetch(base + "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph }),
  });
  if (!submit.ok)
    throw new Error(
      "ComfyUI submit failed: HTTP " +
        submit.status +
        " " +
        (await submit.text()).slice(0, 300),
    );
  const queued = (await submit.json()) as {
    prompt_id?: string;
    node_errors?: unknown;
  };
  if (!queued.prompt_id)
    throw new Error(
      "ComfyUI returned no prompt_id: " + JSON.stringify(queued).slice(0, 300),
    );
  if (queued.node_errors && Object.keys(queued.node_errors as object).length) {
    throw new Error(
      "ComfyUI node errors: " +
        JSON.stringify(queued.node_errors).slice(0, 400),
    );
  }
  job.providerRef = queued.prompt_id;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if (attempt === 0) job.state = "queued";
    const histResponse = await fetch(base + "/history/" + queued.prompt_id);
    const hist = (await histResponse.json()) as Record<
      string,
      {
        status?: {
          status_str?: string;
          messages?: [string, { exception_message?: string }][];
        };
        outputs?: Record<
          string,
          {
            videos?: { filename: string; subfolder: string }[];
            gifs?: { filename: string; subfolder: string }[];
            images?: { filename: string; subfolder: string }[];
          }
        >;
      }
    >;
    const entry = hist[queued.prompt_id];
    if (entry?.status?.status_str === "error") {
      const message = entry.status.messages?.find(
        (m) => m[0] === "execution_error",
      )?.[1]?.exception_message;
      throw new Error(
        "ComfyUI workflow " +
          workflowId +
          " failed: " +
          (message || "unknown error").slice(0, 400),
      );
    }
    if (entry?.status?.status_str === "success" || entry?.outputs) {
      // History lists outputs per node, including input-side video nodes;
      // try every mp4 candidate until one actually downloads as an output.
      const candidates = Object.values(entry.outputs ?? {})
        .flatMap((out) => [
          ...(out.videos ?? []),
          ...(out.gifs ?? []),
          ...(out.images ?? []),
        ])
        .filter(
          (item) =>
            item.filename.endsWith(".mp4") &&
            !item.filename.includes(job.id + "-driving"),
        );
      for (const item of candidates) {
        const view = await fetch(
          base +
            "/view?filename=" +
            encodeURIComponent(item.filename) +
            "&subfolder=" +
            encodeURIComponent(item.subfolder) +
            "&type=output",
        );
        if (!view.ok) continue;
        const name = job.id + "-comfy-result.mp4";
        writeFileSync(genFilePath(name), Buffer.from(await view.arrayBuffer()));
        return name;
      }
      if (entry?.status?.status_str === "success")
        throw new Error(
          "ComfyUI workflow finished without a downloadable mp4 output",
        );
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(
    "ComfyUI workflow timed out after 30 min (prompt " + queued.prompt_id + ")",
  );
}

export class GenJobManager {
  private jobs = new Map<string, GenJob>();
  private cache = new Map<string, string>();
  readonly providerName: string;
  onSettled?: (job: GenJob) => void;

  fail(job: GenJob, error: unknown): void {
    job.state = "failed";
    job.finishedAt = Date.now();
    job.error = describeError(error);
    job.errorCode =
      error instanceof GenerationInputError ? error.code : "generation_failed";
    record("generation.total", {
      jobId: job.id,
      backend: job.backend,
      status: "error",
      code: job.errorCode,
      elapsed_ms: job.finishedAt - job.createdAt,
    });
    this.onSettled?.(job);
  }
  private finish(job: GenJob): void {
    job.state = "done";
    job.finishedAt = Date.now();
    record("generation.total", {
      jobId: job.id,
      backend: job.backend,
      status: "ok",
      elapsed_ms: job.finishedAt - job.createdAt,
    });
    this.onSettled?.(job);
  }

  constructor() {
    this.providerName = (
      process.env.GEN_PROVIDER || (falKey() ? "fal" : "stub")
    ).toLowerCase();
  }

  private newJob(kind: GenJobKind, prompt: string): GenJob {
    const id =
      "gen-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8);
    const job: GenJob = {
      id,
      kind,
      state: "preparing",
      prompt,
      provider: this.providerName,
      model:
        this.providerName === "fal"
          ? "fal-ai/bytedance/seedance-2.0 (generate) / wan-vace-14b (edit)"
          : "local ffmpeg stub",
      createdAt: Date.now(),
      files: {},
      estimate:
        this.providerName === "fal"
          ? "Hosted generation: typically 1-5 min; billed per generated second by the provider."
          : "Local stub: seconds; no cost, placeholder result (not AI generation).",
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
    const cacheKey = createHash("sha256")
      .update("generate_shot|" + prompt)
      .digest("hex")
      .slice(0, 16);
    const existingId = this.cache.get(cacheKey);
    const existing = existingId ? this.jobs.get(existingId) : undefined;
    // Reuse only live or finished jobs; a failed job must be retryable.
    if (existing && existing.state !== "failed") return existing;
    const job = this.newJob("generate_shot", prompt);
    this.cache.set(cacheKey, job.id);
    void this.runGenerate(job).catch((error: unknown) => {
      this.fail(job, error);
    });
    return job;
  }

  private async runGenerate(job: GenJob): Promise<void> {
    if (this.providerName === "fal") {
      // Validation-phase economy: fastest tier, shortest duration, lowest
      // resolution, no audio. Raise only after a draft is accepted.
      const model = "bytedance/seedance-2.0/fast/text-to-video";
      const queued = await falSubmit(model, {
        prompt: job.prompt,
        resolution: "480p",
        duration: String(GENERATE_SECONDS),
        aspect_ratio: "16:9",
        generate_audio: false,
      });
      job.files.result = await falPollAndDownload(model, queued, job);
    } else if (this.providerName === "stub") {
      job.state = "running";
      job.files.result = await stubGenerateShot(job);
    } else {
      throw new Error(
        'Unknown GEN_PROVIDER "' +
          this.providerName +
          '" (expected fal or stub)',
      );
    }
    this.finish(job);
  }

  /** The last mile, for every backend: cut the provider's output back to the
   * range that was asked for, and put the untouched surroundings back.
   * The local ComfyUI backends used to return before both steps, so their
   * results ran as long as the model's frame budget and replaced the whole
   * frame instead of the masked subject. */
  private async finishEdit(
    job: GenJob,
    generatedName: string,
    cut: {
      segmentName: string;
      maskName?: string;
      duration: number;
      frames: number;
      width: number;
      height: number;
    },
  ): Promise<void> {
    const rangedName = job.id + "-result-range.mp4";
    await runFfmpeg([
      "-i",
      genFilePath(generatedName),
      "-t",
      String(cut.duration),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      genFilePath(rangedName),
    ]);
    job.files.result = rangedName;
    // recast tracks people itself and returns a finished frame; everything
    // else gets the surroundings restored outside the mask.
    if (cut.maskName && job.backend !== "recast") {
      const compositedName = job.id + "-composited.mp4";
      const at = (index: number, label: string): string =>
        `[${index}:v]scale=${cut.width}:${cut.height},fps=16,format=gbrp,setpts=PTS-STARTPTS[${label}];`;
      await runFfmpeg([
        "-i",
        genFilePath(cut.segmentName),
        "-i",
        genFilePath(rangedName),
        "-i",
        genFilePath(cut.maskName),
        // maskedmerge needs all three inputs at one size; scale the source
        // too, so they match by construction instead of by luck.
        "-filter_complex",
        at(0, "s") + at(1, "g") + at(2, "m") +
          "[s][g][m]maskedmerge,format=yuv420p[out]",
        "-map",
        "[out]",
        "-t",
        String(cut.duration),
        "-frames:v",
        String(cut.frames),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-an",
        genFilePath(compositedName),
      ]);
      job.files.composited = compositedName;
    }
    this.finish(job);
  }

  /** Bridge calls this once the browser clip upload for the job has landed. */
  async prepareAndRunEdit(
    job: GenJob,
    clipBytes: Buffer,
    start: number,
    end: number,
    mask: MaskVideoSource | null,
    targetWidth = 960,
    targetHeight = 540,
  ): Promise<void> {
    try {
      validateEditInputs(job.backend, job.refImageUrl, !!mask?.frames.length);
      const duration = end - start;
      if (
        !Number.isFinite(start) ||
        start < 0 ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > 81 / 16 + 0.001
      ) {
        throw new Error(
          "The transformation needs a range of at most 5 seconds.",
        );
      }
      const sourceName = job.id + "-source.mp4";
      writeFileSync(genFilePath(sourceName), clipBytes);
      // Economy + model contract: VACE is billed per 16 fps video second.
      // VACE needs at least 81 frames. Pad short ranges, then trim the result
      // back to the requested duration instead of silently ignoring `end`.
      const frames = 81;
      const segmentName = job.id + "-segment.mp4";
      await runFfmpeg([
        "-ss",
        String(start),
        "-t",
        String(duration),
        "-i",
        genFilePath(sourceName),
        "-vf",
        "fps=16,tpad=stop_mode=clone:stop_duration=5.1,format=yuv420p",
        "-frames:v",
        String(frames),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-an",
        genFilePath(segmentName),
      ]);
      job.files.segment = segmentName;
      // The working geometry comes from the segment ffmpeg actually produced,
      // never from the size the caller passed: a browser that has not reported
      // its coded size defaults to 16:9, and a rotated phone clip reports
      // 1920x1080 while decoding to 1080x1920. Either way, pinning both sides
      // squashed the picture for every non-16:9 clip, on every backend, and
      // made the mask composite fail outright.
      const probed = await probeSize(genFilePath(segmentName));
      const { width: workWidth, height: workHeight } = fitToBudget(
        probed,
        targetWidth,
        targetHeight,
      );
      let maskName: string | undefined;
      if (mask && mask.frames.length) {
        const byFrame = new Map(mask.frames.map((f) => [f.frame, f.data]));
        const sorted = [...mask.frames].sort((a, b) => a.frame - b.frame);
        const raw: Buffer[] = [];
        for (let i = 0; i < frames; i += 1) {
          const sourceFrame = Math.floor(
            Math.min(start + i / 16, end - 1 / mask.sourceFps) * mask.sourceFps,
          );
          let best = sorted[0];
          for (const candidate of sorted) {
            if (
              Math.abs(candidate.frame - sourceFrame) <
              Math.abs(best.frame - sourceFrame)
            )
              best = candidate;
          }
          raw.push(byFrame.get(best.frame)!);
        }
        const rawName = job.id + "-mask.raw";
        writeFileSync(genFilePath(rawName), Buffer.concat(raw));
        maskName = job.id + "-mask-video.mp4";
        await runFfmpeg([
          "-f",
          "rawvideo",
          "-pix_fmt",
          "gray",
          "-s",
          mask.width + "x" + mask.height,
          "-r",
          "16",
          "-i",
          genFilePath(rawName),
          // Dilate the mask a few pixels: community VACE practice and our own
          // tests show exact SAM edges leak and starve differently-proportioned
          // replacements of room.
          "-vf",
          "scale=" +
            workWidth +
            ":" +
            workHeight +
            ",dilation,dilation,dilation,format=yuv420p",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-an",
          genFilePath(maskName),
        ]);
        job.files.maskVideo = maskName;
      }
      const lastMile = {
        segmentName,
        maskName,
        duration,
        frames,
        width: workWidth,
        height: workHeight,
      };
      if (job.backend === "vace-local") {
        // Local ComfyUI repertoire workflow: vace-inpainting-local.
        // Official-template settings (shift 5, CFG 6, 20 steps, uni_pc,
        // GrowMask inside the graph); the server prepares the grey-127
        // control video and the mask video from the SAM track.
        if (!maskName)
          throw new Error(
            "vace-local backend requires a SAM mask (track the subject first)",
          );
        job.state = "running";
        // Draft tier on a 12 GB GPU: undistilled 1.3B at full size/steps
        // measured ~160 s/step (impractical). 832x480-worth of pixels in the
        // clip's own shape, 65 frames, 8 steps.
        const { width, height } = fitToBudget(probed, 832, 480, 16);
        const length = 65;
        const controlName2 = job.id + "-vace-control.mp4";
        await prepareInpaintingControl(
          genFilePath(segmentName),
          genFilePath(maskName),
          genFilePath(controlName2),
          width,
          height,
          length,
        );
        const maskScaledName = job.id + "-vace-mask.mp4";
        await runFfmpeg([
          "-i",
          genFilePath(maskName),
          "-vf",
          "scale=" + width + ":" + height + ",fps=16,format=yuv420p",
          "-frames:v",
          String(length),
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-an",
          genFilePath(maskScaledName),
        ]);
        let refLocalName: string;
        if (job.refImageUrl) {
          const refResponse = await fetch(job.refImageUrl);
          if (!refResponse.ok)
            throw new Error(
              "Could not download reference image: HTTP " + refResponse.status,
            );
          refLocalName = job.id + "-vace-ref.png";
          writeFileSync(
            genFilePath(refLocalName),
            Buffer.from(await refResponse.arrayBuffer()),
          );
        } else {
          // No reference design: anchor on the segment's own first frame.
          refLocalName = job.id + "-vace-ref.png";
          await runFfmpeg([
            "-i",
            genFilePath(segmentName),
            "-frames:v",
            "1",
            genFilePath(refLocalName),
          ]);
        }
        const controlFile = stageComfyInput(
          genFilePath(controlName2),
          "shouldercut-vace-control.mp4",
        );
        const maskFile = stageComfyInput(
          genFilePath(maskScaledName),
          "shouldercut-vace-mask.mp4",
        );
        const vaceRefFile = stageComfyInput(
          genFilePath(refLocalName),
          "shouldercut-vace-ref.png",
        );
        const localResult = await runComfyWorkflow(
          "vace-inpainting-local",
          {
            CONTROL_FILE: controlFile,
            MASK_FILE: maskFile,
            REF_FILE: vaceRefFile,
            POSITIVE: job.prompt,
            NEGATIVE:
              "human woman, human child, girl, boy, human skin, hair, dress, clothes, realistic human, person, worst quality, low quality, blurred details, deformed, malformed limbs, extra fingers",
            MASK_EXPAND: 12,
            WIDTH: width,
            HEIGHT: height,
            LENGTH: length,
            SEED: 42,
            PREFIX: job.id,
          },
          job,
        );
        await this.finishEdit(job, localResult, lastMile);
        return;
      }
      if (job.backend === "scail" || job.backend === "scail-animate") {
        // Local ComfyUI repertoire workflow: scail2-character-replacement.
        // Fixed tested settings live in the template; here we only prepare
        // its declared parameters (driving clip, reframed reference, labels).
        // scail-animate is the same graph in Animation Mode: the reference
        // character performs the driving motion on the reference background.
        const animateMode = job.backend === "scail-animate";
        if (!job.refImageUrl)
          throw new Error(
            "scail backend requires refImageUrl (the replacement character image)",
          );
        job.state = "running";
        const { width, height } = fitToBudget(probed, 960, 544, 16);
        const length = 65;
        const drivingName = job.id + "-scail-driving.mp4";
        await runFfmpeg([
          "-i",
          genFilePath(segmentName),
          "-vf",
          "scale=" + width + ":" + height + ",fps=16,format=yuv420p",
          "-frames:v",
          String(length),
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-an",
          genFilePath(drivingName),
        ]);
        const refResponse = await fetch(job.refImageUrl);
        if (!refResponse.ok)
          throw new Error(
            "Could not download reference image: HTTP " + refResponse.status,
          );
        const refRawName = job.id + "-scail-ref-src.png";
        writeFileSync(
          genFilePath(refRawName),
          Buffer.from(await refResponse.arrayBuffer()),
        );
        // SCAIL-2 rule: reference framing controls output scale. Reframe so
        // the character occupies the same frame-height fraction as the SAM
        // subject (reference subjects are assumed to fill ~80% of their own
        // frame, as in our tested reference).
        const refFramedName = job.id + "-scail-ref.png";
        if (animateMode) {
          // Animation Mode: the reference image IS the scene; fill the frame.
          await runFfmpeg([
            "-i",
            genFilePath(refRawName),
            "-vf",
            "scale=" +
              width +
              ":" +
              height +
              ":force_original_aspect_ratio=increase,crop=" +
              width +
              ":" +
              height +
              ",format=rgb24",
            "-frames:v",
            "1",
            genFilePath(refFramedName),
          ]);
        } else {
          const fraction = subjectHeightFraction(mask);
          const refSize = await probeSize(genFilePath(refRawName));
          // One scale factor for both sides, capped by the canvas: a subject
          // filling most of the frame used to ask for a reference taller than
          // the canvas, and pad= refuses to shrink its input.
          const factor = Math.min(
            (fraction * height) / 0.8 / refSize.height,
            width / refSize.width,
            height / refSize.height,
          );
          const even = (value: number): number =>
            Math.max(64, Math.round((value * factor) / 2) * 2);
          const scaledWidth = even(refSize.width);
          const scaledHeight = even(refSize.height);
          await runFfmpeg([
            "-i",
            genFilePath(refRawName),
            "-vf",
            "scale=" +
              scaledWidth +
              ":" +
              scaledHeight +
              ",pad=" +
              width +
              ":" +
              height +
              ":(" +
              width +
              "-iw)/2:(" +
              height +
              "-ih)/2:color=0xd8d5cc,format=rgb24",
            "-frames:v",
            "1",
            genFilePath(refFramedName),
          ]);
        }
        // Stable input names: identical content re-runs hit the ComfyUI node
        // cache instead of re-rendering (jobs are sequential in practice).
        const drivingFile = stageComfyInput(
          genFilePath(drivingName),
          "shouldercut-driving.mp4",
        );
        const refFile = stageComfyInput(
          genFilePath(refFramedName),
          "shouldercut-ref.png",
        );
        const scailResult = await runComfyWorkflow(
          "scail2-character-replacement",
          {
            DRIVING_FILE: drivingFile,
            REF_FILE: refFile,
            DETECT_SUBJECT: job.subjectLabel || "person",
            DETECT_REF: job.refLabel || "character",
            POSITIVE: job.prompt,
            REPLACEMENT_MODE: !animateMode,
            WIDTH: width,
            HEIGHT: height,
            LENGTH: length,
            SEED: 42,
            PREFIX: job.id,
          },
          job,
        );
        await this.finishEdit(job, scailResult, lastMile);
        return;
      }
      if (this.providerName === "fal") {
        job.state = "running";
        const videoUrl =
          job.backend === "recast" || job.backend === "wan-animate"
            ? await falUploadFile(genFilePath(segmentName), segmentName)
            : undefined;
        let generatedName: string;
        if (job.backend === "kling-o3") {
          // Kling O3 edit wants 720p-class input. A flat scale=1280:720
          // squashed a 1080x1920 phone clip into 16:9: the model was handed a
          // smeared picture, returned a 16:9 near-copy of it, and the asked-for
          // replacement never appeared. 1280x720 is a pixel budget, like every
          // other working size here, never a shape.
          const klingInputName = job.id + "-kling-input.mp4";
          const klingSize = fitToBudget(
            await probeSize(genFilePath(segmentName)),
            1280,
            720,
          );
          await runFfmpeg([
            "-i",
            genFilePath(segmentName),
            "-vf",
            "scale=" +
              klingSize.width +
              ":" +
              klingSize.height +
              ",fps=30,format=yuv420p",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-an",
            genFilePath(klingInputName),
          ]);
          const klingUrl = await falUploadFile(
            genFilePath(klingInputName),
            klingInputName,
          );
          const model = "fal-ai/kling-video/o3/pro/video-to-video/edit";
          const queued = await falSubmit(
            model,
            klingEditInput(job.prompt, klingUrl, job.refImageUrl),
          );
          generatedName = await falPollAndDownload(model, queued, job);
        } else if (job.backend === "recast") {
          if (!job.refImageUrl)
            throw new Error(
              "recast backend requires refImageUrl (one reference photo per replaced person)",
            );
          // Purpose-built character replacement: the model tracks people
          // itself, so no mask/control video is sent and its raw output is
          // kept as-is (no masked recomposition, per SCAIL-2 practice).
          const model = "minimax/h3-max/recast";
          const queued = await falSubmit(model, {
            video_url: videoUrl,
            reference_image_urls: [job.refImageUrl],
            prompt: job.prompt,
            resolution: "768P",
            seed: 42,
          });
          generatedName = await falPollAndDownload(model, queued, job);
        } else if (job.backend === "wan-animate") {
          if (!job.refImageUrl)
            throw new Error(
              "wan-animate backend requires refImageUrl (the replacement character image)",
            );
          const model = "fal-ai/wan/v2.2-14b/animate/replace";
          const queued = await falSubmit(model, {
            video_url: videoUrl,
            image_url: job.refImageUrl,
            resolution: "480p",
            seed: 42,
          });
          generatedName = await falPollAndDownload(model, queued, job);
        } else {
          if (!maskName)
            throw new Error(
              "VACE replacement needs a SAM mask. Track the subject on this range first.",
            );
          const control = job.id + "-vace-control.mp4";
          await prepareInpaintingControl(
            genFilePath(segmentName),
            genFilePath(maskName),
            genFilePath(control),
            workWidth,
            workHeight,
            frames,
          );
          job.files.controlVideo = control;
          const controlUrl = await falUploadFile(genFilePath(control), control);
          const maskUrl = await falUploadFile(genFilePath(maskName), maskName);
          const model = "fal-ai/wan-vace-14b/inpainting";
          const queued = await falSubmit(model, {
            prompt: job.prompt,
            // Keep the provider's quality negatives; do not forbid people
            // unconditionally when the user may be editing a person's outfit.
            video_url: controlUrl,
            mask_video_url: maskUrl,
            preprocess: false,
            ...(job.refImageUrl ? { ref_image_urls: [job.refImageUrl] } : {}),
            // Tuned away from fal defaults (guidance 5, steps 30): stronger
            // prompt adherence is the main transformation lever this endpoint
            // exposes; denoise/strength exist only in local ComfyUI workflows.
            guidance_scale: 8,
            num_inference_steps: 40,
            resolution: "480p",
            num_frames: frames,
            frames_per_second: 16,
            seed: 42,
          });
          generatedName = await falPollAndDownload(model, queued, job);
        }
        await this.finishEdit(job, generatedName, lastMile);
        return;
      }
      if (this.providerName !== "stub")
        throw new Error('Unknown GEN_PROVIDER "' + this.providerName + '"');
      job.state = "running";
      await this.finishEdit(
        job,
        await stubEditSegment(job, segmentName),
        lastMile,
      );
    } catch (error) {
      this.fail(job, error);
    }
  }

  createEditJob(
    prompt: string,
    refImageUrl?: string,
    backend?: string,
    labels?: { subjectLabel?: string; refLabel?: string },
    identity?: { clipHash: string; start: number; end: number },
  ): GenJob {
    validateEditInputs(backend, refImageUrl);
    const inputKey = identity
      ? createHash("sha256")
          .update(
            JSON.stringify({
              prompt,
              refImageUrl,
              backend: backend || "vace",
              labels,
              ...identity,
            }),
          )
          .digest("hex")
      : undefined;
    const existing = inputKey
      ? [...this.jobs.values()].find(
          (j) => j.inputKey === inputKey && j.state !== "failed",
        )
      : undefined;
    if (existing) {
      record("generation.reuse", { jobId: existing.id, cached: true });
      return existing;
    }
    const job = this.newJob("edit_segment", prompt);
    job.inputKey = inputKey;
    job.refImageUrl = refImageUrl;
    job.backend = backend;
    job.subjectLabel = labels?.subjectLabel;
    job.refLabel = labels?.refLabel;
    if (!backend || backend === "vace")
      job.model = "fal-ai/wan-vace-14b/inpainting";
    if (backend === "wan-animate")
      job.model = "fal-ai/wan/v2.2-14b/animate/replace";
    if (backend === "kling-o3")
      job.model = "fal-ai/kling-video/o3/pro/video-to-video/edit";
    if (backend === "recast") job.model = "minimax/h3-max/recast";
    if (backend === "scail")
      job.model = "local-comfyui/scail2-character-replacement";
    if (backend === "scail-animate")
      job.model = "local-comfyui/scail2-character-replacement (animation mode)";
    if (backend === "vace-local")
      job.model = "local-comfyui/vace-inpainting-local";
    return job;
  }
}

export function workingPreviewCode(colorHex: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(colorHex.trim());
  const hex = match ? match[1] : "8a8f98";
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return [
    "fn fx(ctx: FxContext) -> vec4f {",
    "  let base = sourceAt(ctx.uv);",
    "  let m = maskBlur(ctx.uv, 2.0);",
    "  let flat = vec3f(" +
      r.toFixed(3) +
      ", " +
      g.toFixed(3) +
      ", " +
      b.toFixed(3) +
      ");",
    "  let shade = 0.75 + 0.45 * luminance(base.rgb);",
    "  var col = mix(base.rgb, flat * shade, clamp(m, 0.0, 1.0));",
    "  col += vec3f(1.0, 0.55, 0.15) * maskEdge(ctx.uv) * 0.6;",
    "  return vec4f(col, 1.0);",
    "}",
  ].join("\n");
}

export function outputDirExists(): boolean {
  return existsSync(OUTPUT_DIR);
}
