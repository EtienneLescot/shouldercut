import { createHash, createHmac, randomUUID } from "node:crypto";
import { measure, record, traceId, withTrace } from "./diagnostics.ts";
import { loadSession, saveSession } from "./session-store.ts";
import { AgentDispatchClient, RoomServiceClient } from "livekit-server-sdk";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadEnv, type Plugin } from "vite";
import type { ShaderEffectDefinition } from "../src/render/protocol.js";
import { trackVideo, type SamTrackResult } from "./sam.js";
import {
  GenJobManager,
  GenerationInputError,
  validateEditInputs,
  falKey,
  genFilePath,
  workingPreviewCode,
  type GenJob,
} from "./gen-video.js";
import { EditGraph, projectSrt, readExportFile } from "./edit-graph.js";
import { transcribeClipAudio, transcribeCommandAudio } from "./transcribe.js";
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import {
  findMoment,
  planConversation,
  validateAction,
  type FastAction,
} from "./conversation.js";
import { runMuse } from "./muse-runner.js";
import {
  alignTracking,
  sourceFrameRate,
  trackingInput,
  trackingRange,
} from "./track-range.js";

interface PendingCompile {
  effect: ShaderEffectDefinition;
  dryRun: boolean;
  resolve: (value: { ok: boolean; message: string; errors: string[] }) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface ChatMessage {
  role: string;
  text: string;
}

const clients = new Set<ServerResponse>();
const pending = new Map<string, PendingCompile>();
const effects = new Map<string, ShaderEffectDefinition>();
const tracks = new Map<string, SamTrackResult>();
const genManager = new GenJobManager();
const editGraph = new EditGraph();
const genImports = new Map<string, Promise<string>>();
const savedSession = loadSession<{
  graph: ReturnType<EditGraph["checkpoint"]>;
  effects: ShaderEffectDefinition[];
  tracks: SamTrackResult[];
}>();
if (savedSession) {
  try {
    editGraph.restore(savedSession.graph);
    for (const effect of savedSession.effects || [])
      if (effect.id !== "__working-preview") effects.set(effect.id, effect);
    for (const track of savedSession.tracks || [])
      tracks.set(track.prompt, track);
    record("session.restore", { status: "ok" });
  } catch {
    record("session.restore", { status: "error", code: "missing_clip" });
  }
}
function checkpoint() {
  saveSession(() => ({
    graph: editGraph.checkpoint(),
    effects: [...effects.values()],
    tracks: [...tracks.values()],
  }));
}
function clearWorkingPreviewIfIdle(): void {
  if (genManager.list().some((j) => !["done", "failed"].includes(j.state)))
    return;
  if (effects.delete("__working-preview"))
    broadcast("effect-remove", { id: "__working-preview" });
}
genManager.onSettled = (job) => {
  clearWorkingPreviewIfIdle();
  broadcast("generation", { id: job.id, state: job.state });
};
function matchingTrack(
  hash: string,
  start: number,
  end: number,
  subject?: string,
) {
  const phrase = (value: string) =>
    value
      .toLowerCase()
      .trim()
      .replace(/^(the|a|an)\s+/, "");
  return [...tracks.values()]
    .reverse()
    .find(
      (t) =>
        t.clipHash === hash &&
        (t.start ?? 0) <= start + 0.01 &&
        (t.end ?? 0) >= end - 0.01 &&
        (!subject || phrase(t.prompt) === phrase(subject)),
    );
}
interface PendingGenUpload {
  job: GenJob;
  start: number;
  end: number;
  timer: ReturnType<typeof setTimeout>;
}
const pendingGenUploads = new Map<string, PendingGenUpload>();
let browserState: unknown = null;
let browserSeenAt = 0;
let chatRunning = false;
let selection: {
  subject: string;
  clipId: string;
  start: number;
  end: number;
} | null = null;
let editorQueue: Promise<unknown> = Promise.resolve();
let queuedEdits = 0;
let fastWorking = 0;
let previewVersion = 0;
const previewCache = new Map<string, SamTrackResult>();
const pendingPlayback = new Map<
  string,
  {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}
function broadcast(event: string, value: unknown): void {
  if (
    ["project", "effect-remove", "effect-clear", "mask-track"].includes(event)
  )
    checkpoint();
  const line = "event: " + event + "\ndata: " + JSON.stringify(value) + "\n\n";
  for (const client of clients) client.write(line);
}
async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > 512_000) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost):5173$/.test(origin);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function vec4(
  raw: unknown,
  fallback: [number, number, number, number] = [0, 0, 0, 0],
): [number, number, number, number] {
  const arr = Array.isArray(raw) ? raw : fallback;
  return [0, 1, 2, 3].map((i) => Number(arr[i] ?? fallback[i])) as [
    number,
    number,
    number,
    number,
  ];
}
function normaliseEffect(raw: unknown): ShaderEffectDefinition {
  if (!isRecord(raw)) throw new Error("effect must be an object");
  const params = vec4(raw.params);
  let camera: ShaderEffectDefinition["camera"] = null;
  if (isRecord(raw.camera)) {
    const triplet = (v: unknown, dz = 3): [number, number, number] => {
      const arr = Array.isArray(v) ? v : [];
      return [
        Number(arr[0] ?? 0),
        Number(arr[1] ?? 0),
        Number(arr[2] ?? dz),
      ] as [number, number, number];
    };
    camera = {
      from: triplet(raw.camera.from),
      to: triplet(raw.camera.to),
      fov: Number(raw.camera.fov ?? 40),
      target:
        raw.camera.target === undefined || raw.camera.target === null
          ? undefined
          : triplet(raw.camera.target, 0),
      roll:
        raw.camera.roll === undefined || raw.camera.roll === null
          ? undefined
          : Number(raw.camera.roll),
    };
    if (
      [
        ...camera.from,
        ...camera.to,
        camera.fov,
        ...(camera.target ?? []),
        camera.roll ?? 0,
      ].some((v) => !Number.isFinite(v))
    )
      throw new Error("camera values must be finite");
  }
  let particles: ShaderEffectDefinition["particles"] = null;
  if (isRecord(raw.particles)) {
    particles = {
      count: Number(raw.particles.count ?? 2000),
      size: Number(raw.particles.size ?? 0.05),
      blending: raw.particles.blending === "additive" ? "additive" : "normal",
    };
  } else if (raw.kind === "particles") {
    particles = { count: 2000, size: 0.05, blending: "additive" };
  }
  const kind =
    raw.kind === "particles" || particles
      ? ("particles" as const)
      : ("fragment" as const);
  const effect: ShaderEffectDefinition = {
    id: String(raw.id || ""),
    name: String(raw.name || ""),
    code: String(raw.code || ""),
    particleCode:
      raw.particleCode === undefined || raw.particleCode === null
        ? undefined
        : String(raw.particleCode),
    kind,
    params,
    paramsB: raw.paramsB === undefined ? undefined : vec4(raw.paramsB),
    paramsC: raw.paramsC === undefined ? undefined : vec4(raw.paramsC),
    paramsD: raw.paramsD === undefined ? undefined : vec4(raw.paramsD),
    history: raw.history === true,
    particles,
    seed:
      raw.seed === undefined || raw.seed === null
        ? undefined
        : Number(raw.seed),
    start:
      raw.start === null || raw.start === undefined ? null : Number(raw.start),
    end: raw.end === null || raw.end === undefined ? null : Number(raw.end),
    enabled: raw.enabled !== false,
    camera,
  };
  if (!effect.id || !effect.name || !effect.code)
    throw new Error("effect id, name and code are required");
  if (
    [
      ...effect.params,
      ...(effect.paramsB ?? []),
      ...(effect.paramsC ?? []),
      ...(effect.paramsD ?? []),
    ].some((v) => !Number.isFinite(v))
  )
    throw new Error("effect params must be finite");
  if (effect.seed !== undefined && !Number.isFinite(effect.seed))
    throw new Error("effect seed must be finite");
  return effect;
}
function trackSummary(track: SamTrackResult): Record<string, unknown> {
  return {
    prompt: track.prompt,
    frames: track.frames.length,
    frameWidth: track.frameWidth,
    frameHeight: track.frameHeight,
    billedFrames: track.billedFrames,
    start: track.start,
    end: track.end,
  };
}
function statePayload(): Record<string, unknown> {
  return {
    ok: true,
    browserConnected: clients.size > 0,
    supervisorWorking: chatRunning,
    browserSeenSecondsAgo: browserSeenAt
      ? (Date.now() - browserSeenAt) / 1000
      : null,
    browser: browserState,
    selection,
    fastWorking: fastWorking > 0,
    queuedEdits,
    effects: [...effects.values()],
    tracks: [...tracks.values()].map(trackSummary),
    genJobs: genManager.list(),
  };
}
function publishTrack(track: SamTrackResult): void {
  tracks.delete(track.prompt);
  tracks.set(track.prompt, track);
  broadcast("mask-track", track);
}
async function readRawBody(
  req: IncomingMessage,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > limit) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
function waitForCompile(
  effect: ShaderEffectDefinition,
  dryRun = false,
): Promise<{ ok: boolean; message: string; errors: string[] }> {
  if (!clients.size) {
    return Promise.resolve({
      ok: false,
      message:
        "No ShoulderCut browser editor is connected. Open http://127.0.0.1:5173/ first.",
      errors: ["browser not connected"],
    });
  }
  const requestId =
    "compile-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 9);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolvePromise({
        ok: false,
        message: "Browser compile timed out",
        errors: ["compile timeout after 30s"],
      });
    }, 30_000);
    pending.set(requestId, { effect, dryRun, resolve: resolvePromise, timer });
    broadcast("effect-apply", { requestId, effect, dryRun });
  });
}

interface PendingFrame {
  resolve: (value: {
    ok: boolean;
    message: string;
    mediaTime: number;
    width: number;
    height: number;
    png: Buffer | null;
  }) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingFrames = new Map<string, PendingFrame>();

interface RenderedClip {
  ok: boolean;
  message: string;
  clipId: string;
  frames: number;
  mp4: Buffer | null;
}
interface PendingRender {
  resolve: (value: RenderedClip) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingRenders = new Map<string, PendingRender>();

/**
 * Ask the browser to render [start, end) of the loaded clip through the
 * shader chain and hand back an MP4. ffmpeg only ever sees untouched source
 * files, so this is the only way effects reach an exported file.
 */
function requestRenderFromBrowser(): Promise<RenderedClip> {
  if (!clients.size || !browserState) {
    return Promise.resolve({
      ok: false,
      message: "No ShoulderCut browser editor is connected",
      clipId: "",
      frames: 0,
      mp4: null,
    });
  }
  const requestId =
    "render-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 9);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      pendingRenders.delete(requestId);
      resolvePromise({
        ok: false,
        message: "Effect render timed out",
        clipId: "",
        frames: 0,
        mp4: null,
      });
    }, 300_000);
    pendingRenders.set(requestId, { resolve: resolvePromise, timer });
    // The browser picks the range: it alone knows which clip is loaded.
    broadcast("export-render-request", { requestId, bitrate: 12_000_000 });
  });
}

function requestFrameFromBrowser(time?: number): Promise<{
  ok: boolean;
  message: string;
  mediaTime: number;
  width: number;
  height: number;
  png: Buffer | null;
}> {
  if (!clients.size) {
    return Promise.resolve({
      ok: false,
      message:
        "No ShoulderCut browser editor is connected. Open http://127.0.0.1:5173/ first.",
      mediaTime: 0,
      width: 0,
      height: 0,
      png: null,
    });
  }
  const requestId =
    "frame-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 9);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      pendingFrames.delete(requestId);
      resolvePromise({
        ok: false,
        message: "Frame capture timed out",
        mediaTime: 0,
        width: 0,
        height: 0,
        png: null,
      });
    }, 30_000);
    pendingFrames.set(requestId, { resolve: resolvePromise, timer });
    broadcast("frame-request", {
      requestId,
      time: typeof time === "number" ? time : null,
    });
  });
}

function findMuseExecutable(): string {
  const configured = process.env.MUSE_BIN;
  if (configured && existsSync(configured)) return configured;
  const localAppData =
    process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const installDir = join(localAppData, "Programs", "muse");
  if (existsSync(installDir)) {
    const candidates = readdirSync(installDir)
      .filter((name) => /^muse-bin-.*\.exe$/i.test(name))
      .map((name) => join(installDir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  }
  return "muse";
}
function fxPrompt(message: string, history: ChatMessage[]): string {
  const stateJson = JSON.stringify(statePayload(), null, 2).slice(0, 6000);
  const historyText = history
    .slice(-8)
    .map((m) => m.role + ": " + m.text)
    .join("\n");
  return [
    "You are the ShoulderCut editor: control timeline edits with edit-graph tools, and create visual effects with free-form WGSL through shouldercut-fx MCP tools. Use the simplest tool that fulfills the request. There is no shader effects catalog: each visual effect is code you author.",
    "Use ONLY these MCP tools: get_shader_interface, get_editing_craft, list_video_techniques, recommend_video_workflow, list_comfy_workflows, get_video_state, list_shader_effects, validate_shader, apply_shader_effect, remove_shader_effect, clear_shader_effects, seek_video, set_playing, track_object, generate_shot, edit_segment, get_generation_job, show_working_preview, clear_working_preview, get_project, trim_clip, split_clip, move_clip, delete_clip, remove_silences, set_captions, undo, redo, export_video, describe_frame, transcribe_captions.",
    'Editing (SPEC section 7): the edit graph is the source of truth for timeline structure. Call get_project first for clip ids, then trim_clip/split_clip/move_clip/delete_clip/remove_silences/set_captions; every op is validated and undoable (undo/redo). "undo that" = undo. "same on the other clip" = re-apply the same op/effect to the other clip id from get_project. Captions: set_captions with cues in source time; when transcribing speech, split long turns into cues proportionally to text length. export_video renders the graph (trims, order, burned captions) to MP4 and returns the download path; name it in your confirmation.',
    "Generative video (docs/generative-video-spec.md): before ANY generative job, call recommend_video_workflow once with the user request verbatim and follow the returned workflow: it picks the technique (character replacement, masked inpainting, instruction edit, motion transfer, generated insert...) and the backend in order, with economical test settings. Typical subject transformation: track_object, show_working_preview, then the planned generation call. Generation is asynchronous and takes minutes: submit, tell the user the job id and that it is running, and do not busy-poll in this turn unless the user explicitly waits. get_generation_job reports segment/control/result files when done. A stub provider result is a placeholder, never describe it as AI generation. Backends marked available/planned in the plan are not wired yet: say so and use the implemented fallback or ask. Clear the working preview when a draft lands or a job fails.",
    "Efficiency is a hard product constraint: the editor must stay fast. get_editing_craft(topic) loads one small distilled craft topic (colour, camera, beat, captions): call it only when the request touches that craft, at most one topic unless the request spans two, never during WGSL error iteration, and never reload a topic already read. For plain effects, load no craft at all. After applying, at most one verify-and-fix pass; prefer measured acceptance (no new clipping, natural faces) over repeated re-rendering.",
    "Do not use filesystem, shell, web, memory, workflow, subagent, browser, or user-input tools. Do not edit repository files.",
    "For shader authoring only, call get_shader_interface once before writing WGSL. Skip this tool for trims, reordering, captions, undo, playback, and other edits without shader code. The interface is the complete shader contract: never guess a helper name.",
    "Fragment contract: helpers allowed, then exactly fn fx(ctx: FxContext) -> vec4f. ctx: uv, coord, resolution, mediaTime, duration, progress, elapsed, frame, deltaTime, seed, params/paramsB/paramsC/paramsD (16 free floats), camOrigin/camRight/camUp/camForward/tanHalfFov/aspect/historyMix. Sampling: sourceAt (previous pass), originalAt (untouched frame), maskAt (SAM mask), historyAt/prevAt (previous output of THIS effect, only meaningful with history=true), foreAt/backAt, layerUv(uv,z)->(uv,valid), rayDir(uv), worldToUv(p)->(uv,valid).",
    "Injected stdlib (never redefine): hash11/hash21/hash22/hash31, noise2, fbm2, fbm2r, voronoiF1, rot2, easeInQuad/easeOutQuad/easeInOut/easeOutCubic/easeOutBack, pulse, luminance, hsv2rgb/rgb2hsv, satColor, contrastColor, hueShift, temperature, acesTonemap, sdCircle/sdBox2/sdSegment/sdRing, sdSphere/sdBox3/sdTorus, smin, intersectPlaneZ, lightLambert/lightSpec/fresnelTerm, sourceBlur/originalBlur/maskBlur, sobelEdge/maskEdge, overBlend/blendScreen/blendOverlay, pointGlow/starSprite, SC_PI/SC_TAU.",
    "Forbidden in code and particleCode: @group, @binding, @vertex, @fragment, @compute, texture_external, fragmentMain, vertexMain, and redefining any host helper or stdlib function.",
    "Work like a VFX pro: decompose the request into layers (base treatment, procedural element, particles, camera, grade), pick the cheapest technique that reads well, use ctx.progress/elapsed for in/out animation, params for intensities the user may want tuned, and seed for variation. Prefer validate_shader while iterating on complex shaders, then apply_shader_effect once. On WGSL errors, fix and retry with the same id (maximum 4 attempts). A failed compile never breaks the preview.",
    'Object/background work: call track_object first with a short bare noun phrase (for example "red car", never a sentence), then use maskAt/foreAt/backAt/maskBlur/maskEdge. maskAt is 1.0 everywhere before any track.',
    "True 3D: video layers live on world planes (background z=0, x in [-aspect,aspect], y in [-1,1]; foreground 0.2..0.6). Parallax: overBlend(foreAt(layerUv(uv,0.35)), backAt(layerUv(uv,0.0))). For full 3D, write a raymarcher in fx(): ro=ctx.camOrigin, rd=rayDir(ctx.uv), your own map(p) with sdSphere/sdBox3/sdTorus/smin, normal by finite differences, light with lightLambert/lightSpec/fresnelTerm, composite over sourceAt. Camera: {from,to,fov,target?,roll?} is eased by the host across the range; target defaults to origin.",
    'GPU particles (real simulated particles, not formulas): set kind="particles", particles={count,size,blending:"additive"|"normal"} and particleCode defining fn particleInit(index: u32, ctx: ParticleContext) -> Particle and fn particleUpdate(p: Particle, ctx: ParticleContext) -> Particle, optionally fn particleSprite(uv: vec2f, p: Particle, ctx: ParticleContext) -> vec4f. Particle fields: pos (world), vel, color, size (0 = config size), alpha, seed, age, life, id. The host increments age by deltaTime before particleUpdate; respawn inside update with particleInit(u32(p.id+0.5), ctx) when age>life. Use particles for sparks, fire, smoke, rain, snow, confetti, debris, magic dust. Use fragment formula-particles only for cheap static fields.',
    "Temporal effects: set history=true for trails, echoes, feedback, motion trails, fluid-like smearing: mix(sourceAt(uv), historyAt(uv + drift), decay) with ctx.historyMix guarding the first frame. Without history=true, historyAt is black.",
    "Prefer a stable descriptive id. If the user asks for a timed effect and gives no range, anchor start at the current media time from state and choose a short sensible duration.",
    "Inspect at most two frames per request, sequentially, never scan an entire video for an unspecified subject. If the object is not visible at the playhead, ask the user for its time range. Tracking accepts at most 12 seconds: get_video_state, choose the explicit requested start/end, or ask for the passage when the video is longer. Never send a full long clip to SAM. Restrict any masked effect to the successfully tracked range.",
    "The mascot and app controls are UI, not subjects inside the video. Requests about the mascot, voice, app layout or code are not video edits: explain that they belong to the app developer. Do not track them in the footage.",
    "Tool results are the only proof of success. If a tool fails, explain the concrete missing input or limitation; never say done. Never silently substitute a generative transformation with a colour shader or a placeholder.",
    "When compilation succeeds, optionally seek to a representative moment inside the effect and pause there so the user sees it immediately.",
    "Finish with one very short confirmation in the user language. Do not paste the full shader in your final message.",
    "",
    "A selection preview is ONLY the 0.25s displayed sample. For a replacement or moving effect, track the requested full range again before generate_video. Never treat the preview as a full track.",
    "Current ShoulderCut state JSON:",
    stateJson,
    "",
    "Recent chat:",
    historyText || "(none)",
    "",
    "User request:",
    message,
  ].join("\n");
}
async function runEditorNow(
  message: string,
  history: ChatMessage[],
): Promise<{ reply: string; stderrTail: string }> {
  if (chatRunning) throw new Error("An agent request is already running");
  chatRunning = true;
  const repoRoot = resolve(process.cwd());
  const workspace = join(repoRoot, "server", "agent-workspace");
  const mcpScript = join(repoRoot, "server", "shouldercut-mcp.mjs");
  try {
    broadcast("supervisor", { working: true, phase: "Préparation du montage" });
    return await measure("editor.run", () =>
      runMuse({
        executable: findMuseExecutable(),
        workspace,
        mcpScript,
        prompt: fxPrompt(message, history),
        onProgress: (progress) => {
          record("editor.tool", { tool: progress.tool });
          broadcast("supervisor", { working: true, ...progress });
        },
      }),
    );
  } finally {
    chatRunning = false;
    clearWorkingPreviewIfIdle();
    broadcast("supervisor", { working: false });
  }
}

function runEditor(
  message: string,
  history: ChatMessage[],
): Promise<{ reply: string; stderrTail: string }> {
  const queuedAt = performance.now();
  queuedEdits++;
  const task = editorQueue.then(() => {
    queuedEdits--;
    record("editor.queue", {
      queue_ms: Math.round(performance.now() - queuedAt),
    });
    return runEditorNow(message, history);
  });
  editorQueue = task.catch(() => undefined);
  return task;
}
function dialogueContext(): Record<string, unknown> {
  return {
    player: browserState,
    selection,
    montage_en_cours:
      chatRunning ||
      genManager.list().some((j) => !["done", "failed"].includes(j.state)),
    transformations: genManager
      .list()
      .slice(-4)
      .map((j) => ({
        id: j.id,
        state: j.state,
        error: j.error,
        errorCode: j.errorCode,
      })),
    commandes_en_attente: queuedEdits,
    clips: editGraph
      .get()
      .clips.map((c) => ({ id: c.id, name: c.name, in: c.in, out: c.out })),
  };
}
function currentClip() {
  const state = browserState as {
    activeClipId?: string;
    fileName?: string;
    mediaTime?: number;
  } | null;
  const clips = editGraph.get().clips;
  const clip =
    clips.find((c) => c.id === state?.activeClipId) ||
    clips.find((c) => c.name === state?.fileName);
  if (!clients.size || !clip)
    throw new Error("Importez une vidéo pour commencer.");
  return clip;
}
function playback(
  action: "play" | "pause" | "seek",
  time?: number,
): Promise<void> {
  const clip = currentClip();
  if (
    action === "seek" &&
    (time === undefined || time < clip.in || time >= clip.out)
  )
    throw new Error("Cette position est hors du passage monté.");
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPlayback.delete(requestId);
      reject(new Error("Le lecteur n’a pas confirmé le déplacement."));
    }, 5000);
    pendingPlayback.set(requestId, { resolve, reject, timer });
    broadcast("playback", { action, time, requestId, clipId: clip.id });
  });
}
async function executeAction(action: FastAction): Promise<{ reply: string }> {
  return measure("action." + action.name, () => executeActionInner(action));
}
async function executeActionInner(
  action: FastAction,
): Promise<{ reply: string }> {
  if (action.name === "clear_preview") {
    previewVersion++;
    selection = null;
    broadcast("selection-clear", {});
    return { reply: "L’aperçu du détourage est masqué." };
  }
  const clip = currentClip();
  if (action.name === "control_video") {
    if (action.action !== "pause") {
      previewVersion++;
      broadcast("selection-clear", {});
    }
    await playback(action.action!, action.time ?? undefined);
    return {
      reply:
        action.action === "play"
          ? "Lecture lancée."
          : action.action === "pause"
            ? "La vidéo est en pause."
            : "Voici le passage à " + action.time!.toFixed(1) + " secondes.",
    };
  }
  const version = ++previewVersion;
  fastWorking++;
  broadcast("assistant-action", {
    working: true,
    phase:
      action.name === "preview_subject"
        ? "Détourage du sujet"
        : "Recherche du passage",
  });
  try {
    if (action.name === "find_moment") {
      const result = await findMoment(
        editGraph.clipPath(clip.id),
        action.query!,
        clip.in,
        clip.out,
      );
      if (version !== previewVersion || currentClip().id !== clip.id)
        throw new Error(
          "La recherche a été interrompue par votre nouvelle action.",
        );
      if (result.time === null)
        return {
          reply:
            "Je ne repère pas clairement ce moment dans les images de ce clip. Précisez un indice visuel.",
        };
      broadcast("selection-clear", {});
      await playback("seek", result.time);
      return { reply: result.reply + " · " + result.time.toFixed(1) + " s" };
    }
    await playback("pause");
    const state = browserState as { mediaTime?: number };
    const start = Math.max(
        clip.in,
        Math.min(state.mediaTime || clip.in, clip.out - 0.25),
      ),
      end = Math.min(clip.out, start + 0.25);
    const key =
      clip.hash + ":" + start.toFixed(3) + ":" + action.subject!.toLowerCase();
    let track =
      previewCache.get(key) ||
      matchingTrack(clip.hash, start, end, action.subject);
    record("sam.preview.cache", { cached: !!track });
    if (!track) {
      const source = editGraph.clipPath(clip.id),
        fps = await sourceFrameRate(source);
      const result = await trackVideo(
        await trackingInput(source, { start, end }),
        "preview.mp4",
        "video/mp4",
        action.subject!,
      );
      if (!result.frames.some((f) => f.ones > 0))
        return {
          reply:
            "Je ne repère pas ce sujet à cet instant. Indiquez-le plus précisément ou changez de passage.",
        };
      track = {
        ...alignTracking(result, { start, end }, fps),
        clipHash: clip.hash,
        sourceFps: fps,
      };
      previewCache.set(key, track);
      if (previewCache.size > 12)
        previewCache.delete(previewCache.keys().next().value!);
    }
    if (version !== previewVersion || currentClip().id !== clip.id)
      throw new Error("L’aperçu a été interrompu par votre nouvelle action.");
    // Return to the exact masked frame if playback moved while SAM worked.
    await playback("seek", start);
    selection = { subject: action.subject!, clipId: clip.id, start, end };
    // The preview is UI-only: do not replace an active effect's worker mask.
    // An existing full-length mask can contain megabytes of frames. Send only
    // the few frames around this preview instead of blocking the UI with it.
    const atFrame = Math.floor(start * (track.sourceFps || 30));
    const untilFrame = Math.ceil(end * (track.sourceFps || 30));
    const preceding = [...track.frames]
      .reverse()
      .find((f) => f.frame <= atFrame);
    const previewFrames = track.frames.filter(
      (f) => f.frame > atFrame && f.frame <= untilFrame,
    );
    if (preceding) previewFrames.unshift(preceding);
    broadcast("selection-preview", {
      ...track,
      start,
      end,
      frames: previewFrames,
    });
    return { reply: "Voici le détourage. Qu’est-ce qu’on fait de ce sujet ?" };
  } finally {
    fastWorking--;
    broadcast("assistant-action", { working: fastWorking > 0 });
  }
}
async function converse(
  message: string,
  history: ChatMessage[],
): Promise<{ reply: string; editing?: boolean }> {
  const decision = await measure("dialogue.plan", () =>
    planConversation(message, history, dialogueContext()),
  );
  if (decision.edit) {
    // Acknowledge immediately; keep the conversation available during the edit.
    void runEditor(message, history).then(
      (result) => broadcast("assistant-result", { reply: result.reply }),
      (error) =>
        broadcast("assistant-result", {
          error: true,
          reply: error instanceof Error ? error.message : String(error),
        }),
    );
    return { reply: decision.reply, editing: true };
  }
  if (decision.action) {
    broadcast("assistant-ack", { reply: decision.reply });
    return executeAction(decision.action);
  }
  return { reply: decision.reply };
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  if (!originAllowed(req)) {
    sendJson(res, 403, {
      ok: false,
      message: "Origin not allowed for local ShoulderCut bridge",
    });
    return;
  }
  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, service: "shouldercut-bridge" });
    return;
  }
  if (req.method === "GET" && pathname === "/api/state") {
    sendJson(res, 200, statePayload());
    return;
  }
  if (req.method === "GET" && pathname === "/api/assistant/context") {
    sendJson(res, 200, { ok: true, ...dialogueContext() });
    return;
  }
  if (req.method === "POST" && pathname === "/api/assistant/action") {
    const body = await readJson(req);
    const result = await executeAction(validateAction(body));
    sendJson(res, 200, { ok: true, ...result });
    return;
  }
  if (req.method === "POST" && pathname === "/api/playback/result") {
    const body = await readJson(req),
      id = String(body.requestId || ""),
      item = pendingPlayback.get(id);
    if (item) {
      clearTimeout(item.timer);
      pendingPlayback.delete(id);
      if (body.ok === true) item.resolve();
      else
        item.reject(
          new Error(String(body.message || "Le lecteur ne répond pas.")),
        );
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (
    req.method === "GET" &&
    pathname.startsWith("/api/clips/") &&
    pathname.endsWith("/mask")
  ) {
    const id = decodeURIComponent(
      pathname.slice("/api/clips/".length, -"/mask".length),
    );
    const clip = editGraph.getClip(id);
    sendJson(res, 200, {
      ok: true,
      track:
        [...tracks.values()]
          .filter((track) => track.clipHash === clip.hash)
          .at(-1) || null,
    });
    return;
  }
  // --- Edit graph (SPEC §6-7): project document, operations, export ---
  if (req.method === "GET" && pathname === "/api/project") {
    sendJson(res, 200, {
      ok: true,
      project: editGraph.get(),
      totalDuration: editGraph.totalDuration(),
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/clips") {
    const bytes = await readRawBody(req, 2 * 1024 * 1024 * 1024);
    const name = String(req.headers["x-file-name"] || "clip");
    const clip = await editGraph.addClip(bytes, name);
    broadcast("project", editGraph.get());
    sendJson(res, 200, { ok: true, clip, project: editGraph.get() });
    return;
  }
  if (
    req.method === "GET" &&
    pathname.startsWith("/api/clips/") &&
    pathname.endsWith("/source")
  ) {
    const id = decodeURIComponent(
      pathname.slice("/api/clips/".length, -"/source".length),
    );
    // Resolve only a registered clip id, never a caller-provided file path.
    const bytes = readFileSync(editGraph.clipPath(id));
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": bytes.length,
      "Cache-Control": "private, max-age=3600",
    });
    res.end(bytes);
    return;
  }
  if (req.method === "POST" && pathname === "/api/edit/op") {
    const body = await readJson(req);
    const op = String(body.op || "");
    const id = String(body.clipId || "");
    let label = op;
    if (op === "trim")
      editGraph.trimClip(id, Number(body.start), Number(body.end));
    else if (op === "split") editGraph.splitClip(id, Number(body.at));
    else if (op === "move") editGraph.moveClip(id, Number(body.toIndex));
    else if (op === "delete") editGraph.deleteClip(id);
    else if (op === "captions")
      editGraph.setCaptions(
        id,
        Array.isArray(body.cues) ? (body.cues as never[]) : [],
        body.enabled !== false,
      );
    else if (op === "remove_silences")
      await editGraph.removeSilences(
        id,
        Number(body.thresholdDb ?? -35),
        Number(body.minSilence ?? 0.45),
      );
    else if (op === "undo") label = "undo: " + editGraph.undo().label;
    else if (op === "redo") label = "redo: " + editGraph.redo().label;
    else throw new Error("Unknown edit op: " + op);
    broadcast("project", editGraph.get());
    sendJson(res, 200, {
      ok: true,
      op: label,
      project: editGraph.get(),
      totalDuration: editGraph.totalDuration(),
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/captions/transcribe") {
    const body = await readJson(req);
    const clipId = String(body.clipId || "");
    const clip = editGraph.getClip(clipId);
    const result = await transcribeClipAudio(
      editGraph.clipPath(clipId),
      resolve(process.cwd(), "server", "gen-output"),
      clip.duration,
    );
    if (!result.cues.length) {
      sendJson(res, 200, {
        ok: true,
        cues: [],
        transcript: result.transcript,
        note: "No speech turns returned; captions left unchanged.",
      });
      return;
    }
    // Transcription covers the full source; keep only cues in the trim range.
    const cues = result.cues.filter(
      (c) => c.end > clip.in && c.start < clip.out,
    );
    editGraph.setCaptions(clipId, cues, true);
    broadcast("project", editGraph.get());
    sendJson(res, 200, {
      ok: true,
      cues,
      transcript: result.transcript,
      project: editGraph.get(),
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/export") {
    const body = await readJson(req);
    const preset =
      body.preset === "vertical-1080x1920" || body.preset === "square"
        ? body.preset
        : "1080p";
    // Bake the agent's shaders in first: ffmpeg only has untouched sources.
    // Only the clip loaded in the editor can be rendered, so a multi-clip
    // project exports its other clips straight from source.
    const renders = new Map<string, Buffer>();
    const live = [...effects.values()].filter(
      (e) => e.enabled !== false && e.id !== "__working-preview",
    );
    if (live.length) {
      const rendered = await requestRenderFromBrowser();
      if (!rendered.ok || !rendered.mp4 || !rendered.clipId) {
        throw new Error(
          "Could not render effects for the export: " + rendered.message,
        );
      }
      renders.set(rendered.clipId, rendered.mp4);
    }
    const result = await editGraph.exportMp4(preset, renders);
    sendJson(res, 200, {
      ok: true,
      ...result,
      renderedClips: renders.size,
      url: "/api/export/file?name=" + encodeURIComponent(result.file),
    });
    return;
  }
  if (req.method === "GET" && pathname === "/api/export/file") {
    const url = new URL(req.url || "", "http://127.0.0.1");
    const name = url.searchParams.get("name") || "";
    const data = readExportFile(name);
    if (!data) {
      sendJson(res, 404, { ok: false, message: "File not found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": name.endsWith(".srt")
        ? "text/plain; charset=utf-8"
        : "video/mp4",
      "Content-Length": data.length,
    });
    res.end(data);
    return;
  }
  if (req.method === "GET" && pathname === "/api/project/captions.srt") {
    const srt = projectSrt(editGraph.get());
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(srt);
    return;
  }
  if (req.method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("event: hello\ndata: " + JSON.stringify(statePayload()) + "\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.method === "POST" && pathname === "/api/browser/state") {
    const body = await readJson(req);
    browserState = body.state ?? body;
    browserSeenAt = Date.now();
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && pathname === "/api/effects/result") {
    const body = await readJson(req);
    const requestId = String(body.requestId || "");
    const entry = pending.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(requestId);
      const result = {
        ok: body.ok === true,
        message: String(body.message || ""),
        errors: Array.isArray(body.errors) ? body.errors.map(String) : [],
      };
      if (result.ok && !entry.dryRun) {
        effects.set(entry.effect.id, entry.effect);
        checkpoint();
      }
      entry.resolve(result);
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && pathname === "/api/effects/apply") {
    const body = await readJson(req);
    const effect = normaliseEffect(body.effect);
    const result = await waitForCompile(effect);
    sendJson(res, result.ok ? 200 : 422, { ...result, effect });
    return;
  }
  if (req.method === "POST" && pathname === "/api/effects/validate") {
    const body = await readJson(req);
    const effect = normaliseEffect(body.effect);
    const result = await waitForCompile(effect, true);
    sendJson(res, result.ok ? 200 : 422, { ...result, effect, dryRun: true });
    return;
  }
  if (req.method === "POST" && pathname === "/api/effects/remove") {
    const body = await readJson(req);
    const id = String(body.id || "");
    const existed = effects.delete(id);
    broadcast("effect-remove", { id });
    sendJson(res, 200, { ok: true, removed: existed, id });
    return;
  }
  if (req.method === "POST" && pathname === "/api/effects/clear") {
    effects.clear();
    broadcast("effect-clear", {});
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && pathname === "/api/playback") {
    const body = await readJson(req);
    if (!clients.size) {
      sendJson(res, 422, {
        ok: false,
        message: "No ShoulderCut browser editor is connected",
      });
      return;
    }
    broadcast("playback", body);
    sendJson(res, 200, { ok: true, queued: body });
    return;
  }
  if (req.method === "POST" && pathname === "/api/sam/track-object") {
    const body = await readJson(req);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) throw new Error("prompt is required");
    const bs = browserState as { fileName?: string; frameRate?: number } | null;
    const project = editGraph.get();
    const clip =
      typeof body.clipId === "string"
        ? editGraph.getClip(body.clipId)
        : project.clips.find((c) => c.name === bs?.fileName) ||
          (project.clips.length === 1 ? project.clips[0] : null);
    if (!clip)
      throw new Error("Chargez un clip et précisez lequel doit être suivi.");
    const range = trackingRange(clip.duration, body.start, body.end);
    const cached = matchingTrack(clip.hash, range.start, range.end, prompt);
    record("sam.track.cache", { cached: !!cached });
    if (cached) {
      const current = browserState as {
        maskPrompt?: string;
        clipHash?: string;
      } | null;
      if (
        current?.maskPrompt !== cached.prompt ||
        current?.clipHash !== clip.hash
      )
        publishTrack(cached);
      sendJson(res, 200, {
        ok: true,
        track: trackSummary(cached),
        cached: true,
      });
      return;
    }
    const source = editGraph.clipPath(clip.id);
    const fps = await sourceFrameRate(source);
    const bytes = await trackingInput(source, range);
    const result = await trackVideo(bytes, "excerpt.mp4", "video/mp4", prompt);
    const track = {
      ...alignTracking(result, range, fps),
      clipHash: clip.hash,
      sourceFps: fps,
    };
    publishTrack(track);
    sendJson(res, 200, { ok: true, track: trackSummary(track) });
    return;
  }
  if (req.method === "GET" && pathname === "/api/gen/capabilities") {
    const local = await fetch(
      (process.env.COMFY_URL || "http://127.0.0.1:8188") + "/system_stats",
      { signal: AbortSignal.timeout(700) },
    ).then(
      (r) => r.ok,
      () => false,
    );
    sendJson(res, 200, { ok: true, cloud: !!falKey(), local });
    return;
  }
  if (req.method === "POST" && pathname === "/api/gen/generate") {
    const body = await readJson(req);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) throw new Error("prompt is required");
    const job = genManager.createGenerateShot(prompt);
    sendJson(res, 200, { ok: true, job });
    return;
  }
  if (req.method === "POST" && pathname === "/api/gen/edit") {
    const body = await readJson(req);
    const prompt = String(body.prompt || "").trim();
    if (!prompt) throw new Error("prompt is required");
    if (!clients.size)
      throw new Error(
        "No ShoulderCut browser editor is connected. Open http://127.0.0.1:5173/ first.",
      );
    const start = Number(body.start ?? 0);
    const end = Number(body.end ?? 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      throw new Error("start/end must be a valid range");
    const sourceDuration =
      (browserState as { duration?: number } | null)?.duration || 0;
    if (!sourceDuration)
      throw new Error(
        "Chargez le clip dans le lecteur avant de lancer une transformation.",
      );
    if (
      start < 0 ||
      end > sourceDuration + 0.01 ||
      end - start > 81 / 16 + 0.001
    ) {
      throw new Error(
        "Choisissez un passage valide de 5 secondes maximum dans le clip chargé.",
      );
    }
    const backend =
      body.backend === "wan-animate" ||
      body.backend === "vace" ||
      body.backend === "kling-o3" ||
      body.backend === "recast" ||
      body.backend === "scail" ||
      body.backend === "scail-animate" ||
      body.backend === "vace-local"
        ? String(body.backend)
        : undefined;
    const clip = currentClip();
    const track = matchingTrack(
      clip.hash,
      start,
      end,
      typeof body.subjectLabel === "string" ? body.subjectLabel : undefined,
    );
    const reference =
      typeof body.refImageUrl === "string"
        ? body.refImageUrl.trim() || undefined
        : undefined;
    validateEditInputs(backend, reference, !!track?.frames.length);
    if (backend && ["scail", "scail-animate", "vace-local"].includes(backend)) {
      const online = await fetch(
        (process.env.COMFY_URL || "http://127.0.0.1:8188") + "/system_stats",
        { signal: AbortSignal.timeout(1000) },
      ).then(
        (r) => r.ok,
        () => false,
      );
      if (!online)
        throw new GenerationInputError(
          "backend_offline",
          "Le moteur local est arrêté. Choisissez un modèle hébergé disponible.",
        );
    }
    const previous = new Set(genManager.list().map((j) => j.id));
    const job = genManager.createEditJob(
      prompt,
      reference,
      backend,
      {
        subjectLabel:
          typeof body.subjectLabel === "string" ? body.subjectLabel : undefined,
        refLabel: typeof body.refLabel === "string" ? body.refLabel : undefined,
      },
      { clipHash: clip.hash, start, end },
    );
    if (previous.has(job.id)) {
      sendJson(res, 200, { ok: true, job, reused: true });
      return;
    }
    const bs = browserState as {
      codedWidth?: number;
      codedHeight?: number;
      frameRate?: number;
    };
    const mask = track?.frames.length
      ? {
          width: track.frames[0].maskWidth,
          height: track.frames[0].maskHeight,
          sourceFps: track.sourceFps ?? bs.frameRate ?? 30,
          frames: track.frames.map((f) => ({
            frame: f.frame,
            data: Buffer.from(f.dataB64, "base64"),
          })),
        }
      : null;
    // Imported footage already exists in clip-store; no second browser upload.
    try {
      const bytes = readFileSync(editGraph.clipPath(clip.id));
      void genManager.prepareAndRunEdit(
        job,
        bytes,
        start,
        end,
        mask,
        bs.codedWidth ?? 960,
        bs.codedHeight ?? 540,
      );
    } catch (error) {
      genManager.fail(job, error);
    }
    broadcast("generation", { id: job.id, state: job.state });
    sendJson(res, 200, { ok: true, job });
    return;
  }
  if (req.method === "POST" && pathname === "/api/gen/upload") {
    const requestId = String(req.headers["x-request-id"] || "");
    const pending = pendingGenUploads.get(requestId);
    if (!pending) throw new Error("Unknown or expired gen upload request");
    pendingGenUploads.delete(requestId);
    clearTimeout(pending.timer);
    const bytes = await readRawBody(req, 256_000_000).catch((error) => {
      pending.job.state = "failed";
      pending.job.error = "Le transfert du clip a échoué : " + String(error);
      throw error;
    });
    if (!bytes.length) {
      pending.job.state = "failed";
      pending.job.error = "Le clip reçu est vide.";
      throw new Error(pending.job.error);
    }
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const track = [...tracks.values()]
      .reverse()
      .find(
        (candidate) =>
          candidate.clipHash === hash &&
          (candidate.start ?? 0) <= pending.start + 0.01 &&
          (candidate.end ?? 0) >= pending.end - 0.01,
      );
    const bs = (browserState ?? {}) as {
      frameRate?: number | null;
      codedWidth?: number | null;
      codedHeight?: number | null;
    };
    const mask =
      track && track.frames.length
        ? {
            width: track.frames[0].maskWidth,
            height: track.frames[0].maskHeight,
            sourceFps: track.sourceFps ?? bs.frameRate ?? 30,
            frames: track.frames.map((f) => ({
              frame: f.frame,
              data: Buffer.from(f.dataB64, "base64"),
            })),
          }
        : null;
    void genManager.prepareAndRunEdit(
      pending.job,
      bytes,
      pending.start,
      pending.end,
      mask,
      bs.codedWidth ?? 960,
      bs.codedHeight ?? 540,
    );
    sendJson(res, 200, { ok: true, jobId: pending.job.id });
    return;
  }
  if (req.method === "GET" && pathname.startsWith("/api/gen/jobs/")) {
    const id = decodeURIComponent(pathname.slice("/api/gen/jobs/".length));
    const job = genManager.get(id);
    if (!job) {
      sendJson(res, 404, {
        ok: false,
        message: "Unknown generation job " + id,
      });
      return;
    }
    // Finished generations join the edit graph as clips (once), so the
    // result is part of the project: trimmable, movable, exportable.
    let clipId: string | undefined;
    if (job.state === "done" && job.files.result) {
      let importing = genImports.get(job.id);
      if (!importing) {
        const name = "generated: " + job.prompt.slice(0, 48);
        importing = editGraph
          .addClip(
            readFileSync(genFilePath(job.files.composited || job.files.result)),
            name,
          )
          .then((clip) => {
            broadcast("project", editGraph.get());
            return clip.id;
          })
          .catch((error) => {
            genImports.delete(job.id);
            throw new Error(
              "La vidéo est générée mais son import a échoué : " +
                String(error),
            );
          });
        genImports.set(job.id, importing);
      }
      clipId = await importing;
    }
    sendJson(res, 200, { ok: true, job, clipId });
    return;
  }
  if (req.method === "GET" && pathname.startsWith("/api/gen/files/")) {
    const name = decodeURIComponent(pathname.slice("/api/gen/files/".length));
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
      sendJson(res, 400, { ok: false, message: "Bad file name" });
      return;
    }
    try {
      const data = readFileSync(genFilePath(name));
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": data.length,
        "Cache-Control": "no-store",
      });
      res.end(data);
    } catch {
      sendJson(res, 404, {
        ok: false,
        message: "Unknown generated file " + name,
      });
    }
    return;
  }
  if (req.method === "POST" && pathname === "/api/frame/describe") {
    const body = await readJson(req);
    const shot = await requestFrameFromBrowser(
      typeof body.time === "number" ? body.time : undefined,
    );
    sendJson(res, 200, {
      ok: shot.ok,
      message: shot.message,
      mediaTime: shot.mediaTime,
      width: shot.width,
      height: shot.height,
      pngB64: shot.png ? shot.png.toString("base64") : null,
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/frame/result") {
    // Frame PNGs exceed the JSON body cap: read raw with a frame-sized limit.
    const body = JSON.parse(
      (await readRawBody(req, 16 * 1024 * 1024)).toString("utf8"),
    ) as Record<string, unknown>;
    const requestId = String(body.requestId || "");
    const entry = pendingFrames.get(requestId);
    if (entry) {
      pendingFrames.delete(requestId);
      clearTimeout(entry.timer);
      entry.resolve({
        ok: Boolean(body.ok),
        message: String(body.message || ""),
        mediaTime: Number(body.mediaTime || 0),
        width: Number(body.width || 0),
        height: Number(body.height || 0),
        png:
          typeof body.pngB64 === "string"
            ? Buffer.from(body.pngB64, "base64")
            : null,
      });
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && pathname === "/api/export/render-result") {
    const bytes = await readRawBody(req, 512 * 1024 * 1024);
    const requestId = String(req.headers["x-request-id"] || "");
    const entry = pendingRenders.get(requestId);
    if (entry) {
      pendingRenders.delete(requestId);
      clearTimeout(entry.timer);
      entry.resolve({
        ok: req.headers["x-ok"] === "1",
        message: decodeURIComponent(String(req.headers["x-message"] || "")),
        clipId: String(req.headers["x-clip-id"] || ""),
        frames: Number(req.headers["x-frames"] || 0),
        mp4: bytes.length ? Buffer.from(bytes) : null,
      });
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && pathname === "/api/preview/working") {
    const body = await readJson(req);
    const subject = String(body.subject || "subject").trim() || "subject";
    const color = String(body.color || "#8a8f98");
    const effect: ShaderEffectDefinition = {
      id: "__working-preview",
      name: "Working: " + subject,
      code: workingPreviewCode(color),
      params: [0, 0, 0, 0],
      start: null,
      end: null,
      enabled: true,
      camera: null,
      kind: "fragment",
      history: false,
      particles: null,
    };
    const result = await waitForCompile(effect);
    sendJson(res, result.ok ? 200 : 422, { ...result, effect });
    return;
  }
  if (req.method === "POST" && pathname === "/api/preview/clear") {
    effects.delete("__working-preview");
    broadcast("effect-remove", { id: "__working-preview" });
    sendJson(res, 200, { ok: true });
    return;
  }
  if (
    req.method === "GET" &&
    (pathname === "/api/voice/token" || pathname === "/api/voice/status")
  ) {
    const worker = await fetch("http://127.0.0.1:8081/", {
      signal: AbortSignal.timeout(2000),
    })
      .then((response) => response.ok)
      .catch(() => false);
    const configured = Boolean(
      process.env.ELEVEN_API_KEY ||
        process.env.ELEVENLABS_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        process.env.GEMINI_API_KEY,
    );
    if (pathname.endsWith("/status")) {
      sendJson(res, 200, { ok: true, worker, configured });
      return;
    }
    if (!worker) {
      sendJson(res, 503, {
        ok: false,
        message: configured
          ? "Le service vocal démarre ou est arrêté. Relancez npm run demo."
          : "La voix nécessite une clé ElevenLabs ou Gemini. Configurez le fichier .env.",
      });
      return;
    }
    const room = "shouldercut-" + randomUUID();
    const identity = "editor-" + randomUUID();
    const livekitUrl = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!livekitUrl || !apiKey || !apiSecret)
      throw new Error("Configurez le projet LiveKit Cloud dans .env.");
    // The shared Cloud project can disable automatic room creation. Create
    // only our ephemeral room and explicitly dispatch the named editor agent.
    const rooms = new RoomServiceClient(livekitUrl, apiKey, apiSecret);
    await rooms.createRoom({
      name: room,
      emptyTimeout: 60,
      maxParticipants: 2,
    });
    const dispatch = new AgentDispatchClient(livekitUrl, apiKey, apiSecret);
    await dispatch.createDispatch(room, "shouldercut");
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: apiKey,
        sub: identity,
        iat: now,
        nbf: now,
        exp: now + 3600,
        video: {
          roomJoin: true,
          room,
          canPublish: true,
          canSubscribe: true,
          canPublishData: true,
        },
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", apiSecret)
      .update(header + "." + payload)
      .digest("base64url");
    sendJson(res, 200, {
      ok: true,
      token: header + "." + payload + "." + signature,
      url: livekitUrl,
      room,
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/voice/supervise") {
    const body = await readJson(req);
    const message = String(body.message || "").trim();
    if (!message) throw new Error("message is required");
    if (!clients.size || !browserState)
      throw new Error("Chargez une vidéo avant de demander un montage.");
    const history = Array.isArray(body.history)
      ? body.history.filter(isRecord).map((m) => ({
          role: String(m.role || "user"),
          text: String(m.text || ""),
        }))
      : [];
    const result = await runEditor(message, history);
    sendJson(res, 200, {
      ok: true,
      reply: result.reply,
      effects: [...effects.values()],
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/voice/command") {
    // Push-to-talk fallback (SPEC §4): record -> transcribe -> same
    // supervisor chat path as typed commands (full tool parity).
    const body = JSON.parse(
      (await readRawBody(req, 32 * 1024 * 1024)).toString("utf8"),
    ) as Record<string, unknown>;
    const audioB64 = String(body.audioB64 || "");
    if (!audioB64) throw new Error("audioB64 is required");
    if (!clients.size || !browserState)
      throw new Error(
        "Open the ShoulderCut page and load a video before using voice commands",
      );
    const workDir = resolve(process.cwd(), "server", "gen-output");
    const inputPath = join(
      workDir,
      "command-in-" + Date.now().toString(36) + ".webm",
    );
    writeFileSync(inputPath, Buffer.from(audioB64, "base64"));
    const transcript = await transcribeCommandAudio(inputPath, workDir);
    const history = Array.isArray(body.history)
      ? body.history.filter(isRecord).map((m) => ({
          role: String(m.role || "user"),
          text: String(m.text || ""),
        }))
      : [];
    const result = await converse(transcript, history);
    sendJson(res, 200, {
      ok: true,
      transcript,
      reply: result.reply,
      effects: [...effects.values()],
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/chat") {
    const body = await readJson(req);
    const message = String(body.message || "").trim();
    if (!message) throw new Error("message is required");
    const history = Array.isArray(body.history)
      ? body.history.filter(isRecord).map((m) => ({
          role: String(m.role || "user"),
          text: String(m.text || ""),
        }))
      : [];
    const result = await converse(message, history);
    sendJson(res, 200, { ok: true, ...result, effects: [...effects.values()] });
    return;
  }
  sendJson(res, 404, {
    ok: false,
    message: "Unknown bridge route " + pathname,
  });
}

export function shouldercutBridge(): Plugin {
  return {
    name: "shouldercut-bridge",
    configureServer(server) {
      for (const [key, value] of Object.entries(
        loadEnv(server.config.mode, process.cwd(), ""),
      )) {
        process.env[key] ??= value;
      }
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url || "/", "http://127.0.0.1:5173")
          .pathname;
        if (!pathname.startsWith("/api/")) {
          next();
          return;
        }
        const measured =
          req.method === "POST" &&
          ![
            "/api/browser/state",
            "/api/playback/result",
            "/api/effects/result",
          ].includes(pathname);
        withTrace(req.headers["x-shouldercut-trace"], () => {
          const started = performance.now();
          const id = traceId();
          res.setHeader("X-ShoulderCut-Trace", id!);
          if (measured)
            res.once("finish", () =>
              withTrace(id, () =>
                record("http.request", {
                  route: pathname,
                  method: req.method,
                  http_status: res.statusCode,
                  status: res.statusCode < 400 ? "ok" : "error",
                  elapsed_ms: Math.round(performance.now() - started),
                }),
              ),
            );
          handleApi(req, res, pathname).catch((error) => {
            if (pathname === "/api/gen/edit") clearWorkingPreviewIfIdle();
            sendJson(res, error instanceof GenerationInputError ? 422 : 500, {
              ok: false,
              message: error instanceof Error ? error.message : String(error),
              ...(error instanceof GenerationInputError
                ? { code: error.code, retryable: false }
                : {}),
            });
          });
        });
      });
    },
  };
}
