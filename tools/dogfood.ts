// Dogfooding harness: run one editing instruction over a set of base videos
// on every backend, measure what actually came back, and fail on a silent
// no-op. See docs/dogfooding.md.
//
//   node --experimental-strip-types tools/dogfood.ts "replace the ship with an X-wing"
//
// Free by default: GEN_DRY_RUN=1 prepares every provider input for real and
// stops at the network edge. --paid spends money on the user's fal account.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GENERATE_SECONDS } from "../server/gen-video.ts";
import type { GenJob, GenJobManager, MaskVideoSource } from "../server/gen-video.ts";

const exec = promisify(execFile);

// --- measurement -----------------------------------------------------------

export interface Probe {
  width: number;
  height: number;
  seconds: number;
  frames: number;
  fps: number;
}

/** A result that differs from its source by less than this is not an edit.
 * 39.5 dB was measured on the squashed-portrait bug, where nothing happened. */
export const PSNR_NO_OP_DB = 35;

/** Relative aspect-ratio change that counts as a reshape. Working sizes are
 * quantised to a multiple of 16 for diffusion backends, which moves the ratio
 * by up to ~2.5% on small frames; the squash this catches moved it by 216%. */
export const ASPECT_TOLERANCE = 0.05;

/** Per generated second, from docs/costs.md. A backend with no entry here is
 * refused for a paid pass: an unpriced call is an unbounded call. */
export const USD_PER_SECOND: Record<string, number> = {
  vace: 0.04,
  "wan-animate": 0.04,
  "kling-o3": 0.168,
  recast: 0.3,
  "vace-local": 0,
  scail: 0,
  "scail-animate": 0,
};

export const EDIT_BACKENDS = [
  "vace",
  "kling-o3",
  "recast",
  "wan-animate",
  "vace-local",
  "scail",
  "scail-animate",
];

export const aspect = (p: Probe): number => p.width / p.height;
export const geometry = (p: Probe): string =>
  `${p.width}x${p.height} ${p.seconds.toFixed(2)}s ${p.frames}f`;

export interface Trial {
  kind: "edit" | "generate";
  clipLabel: string;
  backend: string;
  model: string;
  state: string;
  error?: string;
  requestedSeconds: number;
  /** The base video as it sits on disk. */
  clip: Probe | null;
  /** The range the pipeline cut out of it and works from. */
  segment: Probe | null;
  /** The picture the backend actually received — where the squash hid. */
  uploaded: Probe | null;
  uploadedName: string | null;
  /** Masks, control videos and references that went with it. */
  alsoSent: string[];
  /** Composited result if there is one, else the raw provider output. */
  output: Probe | null;
  outputName: string | null;
  psnrDb: number | null;
  billedSeconds: number | null;
  usd: number | null;
}

/** Every assertion, for every backend, in one place. A trial that returns an
 * empty list did something measurable to the right pixels for the right
 * length of time. */
export function checkTrial(trial: Trial, psnrMax = PSNR_NO_OP_DB): string[] {
  const bad: string[] = [];
  if (trial.state !== "done") {
    bad.push(`job ${trial.state}: ${trial.error ?? "no error reported"}`);
    return bad;
  }
  const reshaped = (from: Probe, to: Probe, where: string): void => {
    if (Math.abs(aspect(from) - aspect(to)) / aspect(from) > ASPECT_TOLERANCE)
      bad.push(
        `aspect ratio changed ${where}: ${from.width}x${from.height} (${aspect(from).toFixed(3)}) became ` +
          `${to.width}x${to.height} (${aspect(to).toFixed(3)}) — the model is being handed a squashed picture`,
      );
  };
  if (trial.clip && trial.segment) reshaped(trial.clip, trial.segment, "cutting the range out of the clip");
  if (trial.kind === "edit") {
    if (!trial.uploaded) {
      bad.push("nothing was handed to the backend: no provider input was recorded");
    } else if (trial.segment) {
      reshaped(trial.segment, trial.uploaded, "between the range and what the backend received");
      // The segment is padded up to the model's minimum frame count, so it is
      // longer than the range; what must not be cut is the range itself.
      if (trial.uploaded.seconds + 0.15 < trial.requestedSeconds)
        bad.push(
          `the backend only saw ${trial.uploaded.seconds.toFixed(2)}s of the ${trial.requestedSeconds.toFixed(2)}s range asked for`,
        );
    }
  }
  if (!trial.output) {
    bad.push("the job finished without an output video");
  } else {
    if (Math.abs(trial.output.seconds - trial.requestedSeconds) > 0.15)
      bad.push(
        `output runs ${trial.output.seconds.toFixed(2)}s, the edited range is ${trial.requestedSeconds.toFixed(2)}s`,
      );
    const expected = Math.round(trial.requestedSeconds * trial.output.fps);
    if (Math.abs(trial.output.frames - expected) > 2)
      bad.push(
        `output has ${trial.output.frames} frames, ${expected} expected for ${trial.requestedSeconds.toFixed(2)}s at ${trial.output.fps} fps`,
      );
    if (trial.segment) reshaped(trial.segment, trial.output, "between the range and the result");
  }
  if (trial.psnrDb !== null && trial.psnrDb >= psnrMax)
    bad.push(
      `the edit did nothing: ${Number.isFinite(trial.psnrDb) ? trial.psnrDb.toFixed(1) + " dB" : "pixel-identical"} ` +
        `against the source range (over ${psnrMax} dB is a no-op)`,
    );
  return bad;
}

// --- ffmpeg ----------------------------------------------------------------

async function run(cmd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await exec(cmd, args, {
    windowsHide: true,
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout + stderr;
}

export async function probe(path: string): Promise<Probe> {
  const out = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-of", "json",
    "-show_entries", "stream=width,height,nb_frames,avg_frame_rate:format=duration",
    path,
  ]);
  const parsed = JSON.parse(out) as {
    streams?: { width?: number; height?: number; nb_frames?: string; avg_frame_rate?: string }[];
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  if (!stream?.width || !stream.height) throw new Error("no video stream in " + path);
  const [num, den = "1"] = (stream.avg_frame_rate ?? "0/1").split("/");
  const fps = Number(den) ? Number(num) / Number(den) : 0;
  const seconds = Number(parsed.format?.duration ?? 0);
  return {
    width: stream.width,
    height: stream.height,
    seconds,
    fps: Math.round(fps * 100) / 100,
    frames: Number(stream.nb_frames) || Math.round(seconds * fps),
  };
}

/** ffmpeg PSNR of candidate against reference, both resampled to the
 * candidate's geometry and the pipeline's 16 fps. null when it cannot be
 * measured; Infinity when the two are pixel-identical. */
export async function psnr(reference: string, candidate: string, at: Probe): Promise<number | null> {
  const chain = (index: number, label: string): string =>
    `[${index}:v]scale=${at.width}:${at.height},fps=16,format=yuv420p,setpts=PTS-STARTPTS[${label}];`;
  try {
    const out = await run("ffmpeg", [
      "-hide_banner", "-i", reference, "-i", candidate,
      "-lavfi", chain(0, "a") + chain(1, "b") + "[a][b]psnr",
      "-f", "null", "-",
    ]);
    const match = /average:(inf|[0-9.]+)/i.exec(out);
    if (!match) return null;
    return match[1].toLowerCase() === "inf" ? Infinity : Number(match[1]);
  } catch {
    return null;
  }
}

// --- sample set ------------------------------------------------------------

const CLIP_STORE = resolve(process.cwd(), "server", "clip-store");
const MAX_CLIP_BYTES = 128 * 1024 * 1024;

/** Base videos already on disk: the ones the project references, newest
 * first, otherwise whatever is in the clip store. Oversized sources are
 * skipped — a pass is meant to be cheap enough to run on every change. */
async function sampleClips(limit: number): Promise<string[]> {
  const fromProject = await fetch("http://127.0.0.1:5173/api/project", {
    signal: AbortSignal.timeout(3000),
  })
    .then((r) => r.json() as Promise<{ project?: { clips?: { hash?: string }[] } }>)
    .then((body) => (body.project?.clips ?? []).map((c) => c.hash).filter(Boolean) as string[])
    .catch(() => []);
  const hashes = fromProject.length
    ? [...new Set(fromProject)].reverse()
    : readdirSync(CLIP_STORE)
        .filter((f) => f.endsWith(".mp4"))
        .map((f) => f.replace(/\.mp4$/, ""));
  const usable: { path: string; portrait: boolean }[] = [];
  for (const hash of hashes) {
    const path = join(CLIP_STORE, hash + ".mp4");
    if (!existsSync(path) || readFileSync(path).byteLength > MAX_CLIP_BYTES) continue;
    const size = await probe(path).catch(() => null);
    if (size) usable.push({ path, portrait: size.height > size.width });
  }
  // Both orientations first: portrait coverage is the whole point.
  const portrait = usable.filter((c) => c.portrait);
  const landscape = usable.filter((c) => !c.portrait);
  const picked: string[] = [];
  while (picked.length < limit && (portrait.length || landscape.length))
    for (const pool of [portrait, landscape])
      if (pool.length && picked.length < limit) picked.push(pool.shift()!.path);
  return picked;
}

/** A static centred rectangle, standing in for a SAM track. Kept at a small
 * proxy resolution, like a real mask: the pipeline scales it itself. */
function syntheticMask(clip: Probe, start: number, end: number): MaskVideoSource {
  const width = clip.width >= clip.height ? 256 : Math.round((256 * clip.width) / clip.height / 2) * 2;
  const height = clip.width >= clip.height ? Math.round((256 * clip.height) / clip.width / 2) * 2 : 256;
  const sourceFps = 16;
  const box = { x0: Math.round(width * 0.3), x1: Math.round(width * 0.7), y0: Math.round(height * 0.25), y1: Math.round(height * 0.75) };
  const plane = Buffer.alloc(width * height);
  for (let y = box.y0; y < box.y1; y += 1) plane.fill(255, y * width + box.x0, y * width + box.x1);
  const frames = [];
  for (let frame = Math.floor(start * sourceFps); frame <= Math.ceil(end * sourceFps); frame += 1)
    frames.push({ frame, data: plane });
  return { width, height, sourceFps, frames };
}

async function referenceDataUrl(scratch: string): Promise<string> {
  const png = join(scratch, "dogfood-reference.png");
  if (!existsSync(png))
    await run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x4a90d9:s=256x256",
      "-vf", "drawbox=x=64:y=32:w=128:h=192:color=0xf0d060:t=fill", "-frames:v", "1", png]);
  return "data:image/png;base64," + readFileSync(png).toString("base64");
}

// --- the pass --------------------------------------------------------------

function settle(job: GenJob, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((done, fail) => {
    const tick = (): void => {
      if (job.state === "done" || job.state === "failed") return done();
      if (Date.now() > deadline) return fail(new Error("job did not settle in time"));
      setTimeout(tick, 100);
    };
    tick();
  });
}

export interface Options {
  instruction: string;
  backends: string[];
  clips: string[];
  start: number;
  end: number;
  limit: number;
  paid: boolean;
  psnrMax: number;
  json: string;
}

async function trialForEdit(
  manager: GenJobManager,
  providerInputsFor: (id: string) => string[],
  clipPath: string,
  backend: string,
  reference: string,
  options: Options,
): Promise<Trial> {
  const clip = await probe(clipPath);
  const requestedSeconds = options.end - options.start;
  const trial: Trial = {
    kind: "edit",
    clipLabel: basename(clipPath),
    backend,
    model: backend,
    state: "preparing",
    requestedSeconds,
    clip,
    segment: null,
    uploaded: null,
    uploadedName: null,
    alsoSent: [],
    output: null,
    outputName: null,
    psnrDb: null,
    billedSeconds: null,
    usd: null,
  };
  const job = manager.createEditJob(
    options.instruction,
    reference,
    backend,
    { subjectLabel: "subject", refLabel: "character" },
    { clipHash: basename(clipPath) + backend, start: options.start, end: options.end },
  );
  trial.model = job.model;
  // Deliberately no target size: that is the headless path, and a browser
  // that has not reported its coded size must not reshape the picture either.
  await manager.prepareAndRunEdit(
    job,
    readFileSync(clipPath),
    options.start,
    options.end,
    syntheticMask(clip, options.start, options.end),
  );
  trial.state = job.state;
  trial.error = job.error;
  const outPath = (name?: string): string | null =>
    name ? resolve(process.cwd(), "server", "gen-output", name) : null;
  const segment = outPath(job.files.segment);
  if (segment && existsSync(segment)) trial.segment = await probe(segment).catch(() => null);
  const sent = providerInputsFor(job.id);
  if (sent.length) {
    trial.uploadedName = basename(sent[0]);
    trial.alsoSent = sent.slice(1).map((path) => basename(path));
    trial.uploaded = await probe(sent[0]).catch(() => null);
  }
  const result = outPath(job.files.composited ?? job.files.result);
  if (result && existsSync(result)) {
    trial.outputName = basename(result);
    trial.output = await probe(result).catch(() => null);
    if (segment && trial.output) trial.psnrDb = await psnr(segment, result, trial.output);
  }
  trial.billedSeconds = trial.uploaded?.seconds ?? null;
  const price = USD_PER_SECOND[backend];
  trial.usd = price === undefined || trial.billedSeconds === null ? null : price * trial.billedSeconds;
  return trial;
}

async function trialForGenerate(
  manager: GenJobManager,
  options: Options,
): Promise<Trial> {
  const job = manager.createGenerateShot(options.instruction);
  await settle(job, options.paid ? 25 * 60_000 : 60_000).catch(() => {});
  const result = job.files.result
    ? resolve(process.cwd(), "server", "gen-output", job.files.result)
    : null;
  const output = result && existsSync(result) ? await probe(result).catch(() => null) : null;
  return {
    kind: "generate",
    clipLabel: "(no source clip)",
    backend: "generate_shot",
    model: job.model,
    state: job.state,
    error: job.error,
    requestedSeconds: GENERATE_SECONDS,
    clip: null,
    segment: null,
    uploaded: null,
    uploadedName: null,
    alsoSent: [],
    output,
    outputName: job.files.result ?? null,
    psnrDb: null,
    billedSeconds: output?.seconds ?? null,
    usd: null,
  };
}

// --- report ----------------------------------------------------------------

const cell = (text: string, width: number): string =>
  (text.length > width ? text.slice(0, width - 1) + "…" : text).padEnd(width);

export function reportText(trials: Trial[], options: Options): string {
  const lines: string[] = [];
  const mode = options.paid ? "PAID — real generations on the fal account" : "dry run — nothing left this machine, $0";
  lines.push("ShoulderCut dogfooding pass (" + mode + ")");
  lines.push('instruction: "' + options.instruction + '"');
  lines.push(
    `range ${options.start.toFixed(2)}-${options.end.toFixed(2)}s · ${options.clips.length} clip(s) · ` +
      `${trials.length} trial(s) · no-op threshold ${options.psnrMax} dB`,
  );
  const failures: string[] = [];
  for (const clipLabel of [...new Set(trials.map((t) => t.clipLabel))]) {
    const group = trials.filter((t) => t.clipLabel === clipLabel);
    const clip = group.find((t) => t.clip)?.clip;
    lines.push("");
    lines.push(`--- ${clipLabel}${clip ? " · " + geometry(clip) + " · " + clip.fps + " fps" : ""} ---`);
    lines.push(
      cell("backend", 14) + cell("model", 34) + cell("range in", 20) +
        cell("backend received", 20) + cell("output", 20) + cell("psnr", 9) +
        cell("billed", 9) + cell("cost", 9) + "verdict",
    );
    for (const trial of group) {
      const problems = checkTrial(trial, options.psnrMax);
      for (const problem of problems) failures.push(`${trial.backend} · ${trial.clipLabel}: ${problem}`);
      lines.push(
        cell(trial.backend, 14) +
          cell(trial.model, 34) +
          cell(trial.segment ? geometry(trial.segment) : "—", 20) +
          cell(trial.uploaded ? geometry(trial.uploaded) : "—", 20) +
          cell(trial.output ? geometry(trial.output) : "—", 20) +
          cell(trial.psnrDb === null ? "—" : Number.isFinite(trial.psnrDb) ? trial.psnrDb.toFixed(1) + " dB" : "identical", 9) +
          cell(trial.billedSeconds === null ? "—" : trial.billedSeconds.toFixed(2) + "s", 9) +
          cell(trial.usd === null ? "unpriced" : "$" + trial.usd.toFixed(2), 9) +
          (problems.length ? "FAIL " + problems.length : "ok"),
      );
      if (trial.alsoSent.length) lines.push("  also sent: " + trial.alsoSent.join(", "));
    }
  }
  lines.push("");
  if (failures.length) {
    lines.push(`FAILURES (${failures.length})`);
    for (const failure of failures) lines.push("  " + failure);
  } else {
    lines.push("All assertions passed.");
  }
  lines.push("");
  lines.push("What one full pass over this sample set would cost, per backend:");
  for (const backend of [...new Set(trials.map((t) => t.backend))]) {
    const seconds = trials
      .filter((t) => t.backend === backend)
      .reduce((sum, t) => sum + (t.billedSeconds ?? 0), 0);
    const price = USD_PER_SECOND[backend];
    lines.push(
      "  " +
        cell(backend, 16) +
        (price === undefined
          ? "unpriced — refused for a paid pass"
          : price === 0
            ? `$0 (local GPU time only, ${seconds.toFixed(2)} s of video)`
            : `$${(price * seconds).toFixed(2)}  (${seconds.toFixed(2)} billed s @ $${price}/s)`),
    );
  }
  lines.push("  vace at $0.04/s is ~4x cheaper than kling-o3 at $0.168/s: iterate prompts there.");
  return lines.join("\n");
}

// --- CLI -------------------------------------------------------------------

const VALUE_FLAGS = ["backends", "clips", "range", "limit", "psnr-max", "json"];

export function parseArgs(argv: string[]): Options & { limit: number } {
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) positional.push(arg);
    else if (VALUE_FLAGS.includes(arg.slice(2))) values.set(arg.slice(2), argv[++i] ?? "");
  }
  const backends = values.get("backends");
  const range = (values.get("range") ?? "0:3").split(":").map(Number);
  const clips = values.get("clips");
  return {
    instruction:
      positional[0] ??
      "Replace the central subject with a chrome robot, keep the camera and timing",
    backends: !backends || backends === "all" ? EDIT_BACKENDS : backends.split(","),
    clips: clips ? clips.split(",") : [],
    start: Number.isFinite(range[0]) ? range[0] : 0,
    end: Number.isFinite(range[1]) ? range[1] : 3,
    limit: Number(values.get("limit") ?? 3),
    paid: argv.includes("--paid"),
    psnrMax: Number(values.get("psnr-max") ?? PSNR_NO_OP_DB),
    json: values.get("json") ?? resolve(process.cwd(), ".runtime", "dogfood-latest.json"),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options = parseArgs(argv);
  const withGenerate = !argv.includes("--no-generate-shot");
  if (!options.paid) {
    process.env.GEN_DRY_RUN = "1";
    // Dry run still has to walk the hosted code paths; it just never reaches
    // the network.
    process.env.GEN_PROVIDER = "fal";
  } else {
    const unpriced = options.backends.filter((b) => USD_PER_SECOND[b] === undefined);
    if (unpriced.length)
      throw new Error("--paid refused: no price in docs/costs.md for " + unpriced.join(", "));
    console.log("--paid: this spends real money on the fal account. Prices per generated second:");
    for (const backend of options.backends)
      console.log("  " + backend + "  $" + USD_PER_SECOND[backend] + "/s");
  }
  const { GenJobManager, providerInputsFor } = await import("../server/gen-video.ts");
  const manager = new GenJobManager();
  const scratch = resolve(process.cwd(), ".runtime");
  mkdirSync(scratch, { recursive: true });
  const reference = await referenceDataUrl(scratch);
  if (!options.clips.length) options.clips = await sampleClips(options.limit);
  if (!options.clips.length) throw new Error("no base videos found in server/clip-store");
  const trials: Trial[] = [];
  for (const clip of options.clips)
    for (const backend of options.backends) {
      process.stdout.write(`running ${backend} on ${basename(clip)}…\n`);
      trials.push(await trialForEdit(manager, providerInputsFor, clip, backend, reference, options));
    }
  if (withGenerate) {
    process.stdout.write("running generate_shot…\n");
    trials.push(await trialForGenerate(manager, options));
  }
  const text = reportText(trials, options);
  console.log("\n" + text);
  writeFileSync(options.json, JSON.stringify({ options, trials }, null, 2));
  console.log("\nper-trial measurements: " + options.json);
  const failing = trials.filter((t) => checkTrial(t, options.psnrMax).length).length;
  if (failing) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
