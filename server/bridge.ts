import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type { ShaderEffectDefinition } from '../src/render/protocol.js';
import { trackVideo, type SamTrackResult } from './sam.js';
import { GenJobManager, genFilePath, workingPreviewCode, type GenJob } from './gen-video.js';
import { EditGraph, projectSrt, readExportFile } from './edit-graph.js';
import { readFileSync } from 'node:fs';

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
interface PendingTrack {
  prompt: string;
  resolve: (value: SamTrackResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingTracks = new Map<string, PendingTrack>();
const genManager = new GenJobManager();
const editGraph = new EditGraph();
const attachedGenJobs = new Set<string>();
interface PendingGenUpload { job: GenJob; start: number; end: number }
const pendingGenUploads = new Map<string, PendingGenUpload>();
let browserState: unknown = null;
let browserSeenAt = 0;
let chatRunning = false;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function broadcast(event: string, value: unknown): void {
  const line = 'event: ' + event + '\ndata: ' + JSON.stringify(value) + '\n\n';
  for (const client of clients) client.write(line);
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > 512_000) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost):5173$/.test(origin);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function vec4(raw: unknown, fallback: [number, number, number, number] = [0, 0, 0, 0]): [number, number, number, number] {
  const arr = Array.isArray(raw) ? raw : fallback;
  return [0, 1, 2, 3].map((i) => Number(arr[i] ?? fallback[i])) as [number, number, number, number];
}
function normaliseEffect(raw: unknown): ShaderEffectDefinition {
  if (!isRecord(raw)) throw new Error('effect must be an object');
  const params = vec4(raw.params);
  let camera: ShaderEffectDefinition['camera'] = null;
  if (isRecord(raw.camera)) {
    const triplet = (v: unknown, dz = 3): [number, number, number] => {
      const arr = Array.isArray(v) ? v : [];
      return [Number(arr[0] ?? 0), Number(arr[1] ?? 0), Number(arr[2] ?? dz)] as [number, number, number];
    };
    camera = {
      from: triplet(raw.camera.from), to: triplet(raw.camera.to), fov: Number(raw.camera.fov ?? 40),
      target: raw.camera.target === undefined || raw.camera.target === null ? undefined : triplet(raw.camera.target, 0),
      roll: raw.camera.roll === undefined || raw.camera.roll === null ? undefined : Number(raw.camera.roll),
    };
    if ([...camera.from, ...camera.to, camera.fov, ...(camera.target ?? []), camera.roll ?? 0].some((v) => !Number.isFinite(v))) throw new Error('camera values must be finite');
  }
  let particles: ShaderEffectDefinition['particles'] = null;
  if (isRecord(raw.particles)) {
    particles = {
      count: Number(raw.particles.count ?? 2000),
      size: Number(raw.particles.size ?? 0.05),
      blending: raw.particles.blending === 'additive' ? 'additive' : 'normal',
    };
  } else if (raw.kind === 'particles') {
    particles = { count: 2000, size: 0.05, blending: 'additive' };
  }
  const kind = raw.kind === 'particles' || particles ? 'particles' as const : 'fragment' as const;
  const effect: ShaderEffectDefinition = {
    id: String(raw.id || ''),
    name: String(raw.name || ''),
    code: String(raw.code || ''),
    particleCode: raw.particleCode === undefined || raw.particleCode === null ? undefined : String(raw.particleCode),
    kind,
    params,
    paramsB: raw.paramsB === undefined ? undefined : vec4(raw.paramsB),
    paramsC: raw.paramsC === undefined ? undefined : vec4(raw.paramsC),
    paramsD: raw.paramsD === undefined ? undefined : vec4(raw.paramsD),
    history: raw.history === true,
    particles,
    seed: raw.seed === undefined || raw.seed === null ? undefined : Number(raw.seed),
    start: raw.start === null || raw.start === undefined ? null : Number(raw.start),
    end: raw.end === null || raw.end === undefined ? null : Number(raw.end),
    enabled: raw.enabled !== false,
    camera,
  };
  if (!effect.id || !effect.name || !effect.code) throw new Error('effect id, name and code are required');
  if ([...effect.params, ...(effect.paramsB ?? []), ...(effect.paramsC ?? []), ...(effect.paramsD ?? [])].some((v) => !Number.isFinite(v))) throw new Error('effect params must be finite');
  if (effect.seed !== undefined && !Number.isFinite(effect.seed)) throw new Error('effect seed must be finite');
  return effect;
}
function trackSummary(track: SamTrackResult): Record<string, unknown> {
  return {
    prompt: track.prompt,
    frames: track.frames.length,
    frameWidth: track.frameWidth,
    frameHeight: track.frameHeight,
    billedFrames: track.billedFrames,
  };
}
function statePayload(): Record<string, unknown> {
  return {
    ok: true,
    browserConnected: clients.size > 0,
    browserSeenSecondsAgo: browserSeenAt ? (Date.now() - browserSeenAt) / 1000 : null,
    browser: browserState,
    effects: [...effects.values()],
    tracks: [...tracks.values()].map(trackSummary),
    genJobs: genManager.list(),
  };
}
function publishTrack(track: SamTrackResult): void {
  tracks.set(track.prompt, track);
  broadcast('mask-track', track);
}
async function runTrack(bytes: Uint8Array, filename: string, mime: string, prompt: string): Promise<SamTrackResult> {
  const track = await trackVideo(bytes, filename, mime, prompt);
  publishTrack(track);
  return track;
}
function requestTrackFromBrowser(prompt: string): Promise<SamTrackResult> {
  if (!clients.size) {
    return Promise.reject(new Error('No ShoulderCut browser editor is connected. Open http://127.0.0.1:5173/ first.'));
  }
  const requestId = 'track-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pendingTracks.delete(requestId);
      rejectPromise(new Error('Browser did not upload the clip for SAM tracking (timeout)'));
    }, 240_000);
    pendingTracks.set(requestId, { prompt, resolve: resolvePromise, reject: rejectPromise, timer });
    broadcast('track-request', { requestId, prompt });
  });
}
async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > limit) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
function waitForCompile(effect: ShaderEffectDefinition, dryRun = false): Promise<{ ok: boolean; message: string; errors: string[] }> {
  if (!clients.size) {
    return Promise.resolve({
      ok: false,
      message: 'No ShoulderCut browser editor is connected. Open http://127.0.0.1:5173/ first.',
      errors: ['browser not connected'],
    });
  }
  const requestId = 'compile-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolvePromise({ ok: false, message: 'Browser compile timed out', errors: ['compile timeout after 30s'] });
    }, 30_000);
    pending.set(requestId, { effect, dryRun, resolve: resolvePromise, timer });
    broadcast('effect-apply', { requestId, effect, dryRun });
  });
}

interface PendingFrame {
  resolve: (value: { ok: boolean; message: string; mediaTime: number; width: number; height: number; png: Buffer | null }) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pendingFrames = new Map<string, PendingFrame>();

function requestFrameFromBrowser(time?: number): Promise<{ ok: boolean; message: string; mediaTime: number; width: number; height: number; png: Buffer | null }> {
  if (!clients.size) {
    return Promise.resolve({ ok: false, message: 'No ShoulderCut browser editor is connected. Open http://127.0.0.1:5173/ first.', mediaTime: 0, width: 0, height: 0, png: null });
  }
  const requestId = 'frame-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      pendingFrames.delete(requestId);
      resolvePromise({ ok: false, message: 'Frame capture timed out', mediaTime: 0, width: 0, height: 0, png: null });
    }, 30_000);
    pendingFrames.set(requestId, { resolve: resolvePromise, timer });
    broadcast('frame-request', { requestId, time: typeof time === 'number' ? time : null });
  });
}

function findMuseExecutable(): string {
  const configured = process.env.MUSE_BIN;
  if (configured && existsSync(configured)) return configured;
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  const installDir = join(localAppData, 'Programs', 'muse');
  if (existsSync(installDir)) {
    const candidates = readdirSync(installDir)
      .filter((name) => /^muse-bin-.*\.exe$/i.test(name))
      .map((name) => join(installDir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (candidates.length) return candidates[0];
  }
  return 'muse';
}
function fxPrompt(message: string, history: ChatMessage[]): string {
  const stateJson = JSON.stringify(statePayload(), null, 2).slice(0, 6000);
  const historyText = history.slice(-8).map((m) => m.role + ': ' + m.text).join('\n');
  return [
    'You are the ShoulderCut VFX agent: a professional special-effects and video-editing shader artist. You work only by writing free-form WGSL through the shouldercut-fx MCP tools. There is no effects catalog: every effect is code you invent.',
    'Use ONLY these MCP tools: get_shader_interface, get_editing_craft, list_video_techniques, recommend_video_workflow, list_comfy_workflows, get_video_state, list_shader_effects, validate_shader, apply_shader_effect, remove_shader_effect, clear_shader_effects, seek_video, set_playing, track_object, generate_shot, edit_segment, get_generation_job, show_working_preview, clear_working_preview, get_project, trim_clip, split_clip, move_clip, delete_clip, remove_silences, set_captions, undo, redo, export_video, describe_frame.',
    'Editing (SPEC section 7): the edit graph is the source of truth for timeline structure. Call get_project first for clip ids, then trim_clip/split_clip/move_clip/delete_clip/remove_silences/set_captions; every op is validated and undoable (undo/redo). "undo that" = undo. "same on the other clip" = re-apply the same op/effect to the other clip id from get_project. Captions: set_captions with cues in source time; when transcribing speech, split long turns into cues proportionally to text length. export_video renders the graph (trims, order, burned captions) to MP4 and returns the download path; name it in your confirmation.',
    'Generative video (docs/generative-video-spec.md): before ANY generative job, call recommend_video_workflow once with the user request verbatim and follow the returned workflow: it picks the technique (character replacement, masked inpainting, instruction edit, motion transfer, generated insert...) and the backend in order, with economical test settings. Typical subject transformation: track_object, show_working_preview, then the planned generation call. Generation is asynchronous and takes minutes: submit, tell the user the job id and that it is running, and do not busy-poll in this turn unless the user explicitly waits. get_generation_job reports segment/control/result files when done. A stub provider result is a placeholder, never describe it as AI generation. Backends marked available/planned in the plan are not wired yet: say so and use the implemented fallback or ask. Clear the working preview when a draft lands or a job fails.',
    'Efficiency is a hard product constraint: the editor must stay fast. get_editing_craft(topic) loads one small distilled craft topic (colour, camera, beat, captions): call it only when the request touches that craft, at most one topic unless the request spans two, never during WGSL error iteration, and never reload a topic already read. For plain effects, load no craft at all. After applying, at most one verify-and-fix pass; prefer measured acceptance (no new clipping, natural faces) over repeated re-rendering.',
    'Do not use filesystem, shell, web, memory, workflow, subagent, browser, or user-input tools. Do not edit repository files.',
    'FIRST, if you have not seen the interface in this session, call get_shader_interface once and read it fully. It is the complete contract: context, helpers, injected stdlib, 2D, true-3D, GPU particles, temporal history, camera, recipes and limits. Never guess a helper name: use only what it lists.',
    'Fragment contract: helpers allowed, then exactly fn fx(ctx: FxContext) -> vec4f. ctx: uv, coord, resolution, mediaTime, duration, progress, elapsed, frame, deltaTime, seed, params/paramsB/paramsC/paramsD (16 free floats), camOrigin/camRight/camUp/camForward/tanHalfFov/aspect/historyMix. Sampling: sourceAt (previous pass), originalAt (untouched frame), maskAt (SAM mask), historyAt/prevAt (previous output of THIS effect, only meaningful with history=true), foreAt/backAt, layerUv(uv,z)->(uv,valid), rayDir(uv), worldToUv(p)->(uv,valid).',
    'Injected stdlib (never redefine): hash11/hash21/hash22/hash31, noise2, fbm2, fbm2r, voronoiF1, rot2, easeInQuad/easeOutQuad/easeInOut/easeOutCubic/easeOutBack, pulse, luminance, hsv2rgb/rgb2hsv, satColor, contrastColor, hueShift, temperature, acesTonemap, sdCircle/sdBox2/sdSegment/sdRing, sdSphere/sdBox3/sdTorus, smin, intersectPlaneZ, lightLambert/lightSpec/fresnelTerm, sourceBlur/originalBlur/maskBlur, sobelEdge/maskEdge, overBlend/blendScreen/blendOverlay, pointGlow/starSprite, SC_PI/SC_TAU.',
    'Forbidden in code and particleCode: @group, @binding, @vertex, @fragment, @compute, texture_external, fragmentMain, vertexMain, and redefining any host helper or stdlib function.',
    'Work like a VFX pro: decompose the request into layers (base treatment, procedural element, particles, camera, grade), pick the cheapest technique that reads well, use ctx.progress/elapsed for in/out animation, params for intensities the user may want tuned, and seed for variation. Prefer validate_shader while iterating on complex shaders, then apply_shader_effect once. On WGSL errors, fix and retry with the same id (maximum 4 attempts). A failed compile never breaks the preview.',
    'Object/background work: call track_object first with a short bare noun phrase (for example "red car", never a sentence), then use maskAt/foreAt/backAt/maskBlur/maskEdge. maskAt is 1.0 everywhere before any track.',
    'True 3D: video layers live on world planes (background z=0, x in [-aspect,aspect], y in [-1,1]; foreground 0.2..0.6). Parallax: overBlend(foreAt(layerUv(uv,0.35)), backAt(layerUv(uv,0.0))). For full 3D, write a raymarcher in fx(): ro=ctx.camOrigin, rd=rayDir(ctx.uv), your own map(p) with sdSphere/sdBox3/sdTorus/smin, normal by finite differences, light with lightLambert/lightSpec/fresnelTerm, composite over sourceAt. Camera: {from,to,fov,target?,roll?} is eased by the host across the range; target defaults to origin.',
    'GPU particles (real simulated particles, not formulas): set kind="particles", particles={count,size,blending:"additive"|"normal"} and particleCode defining fn particleInit(index: u32, ctx: ParticleContext) -> Particle and fn particleUpdate(p: Particle, ctx: ParticleContext) -> Particle, optionally fn particleSprite(uv: vec2f, p: Particle, ctx: ParticleContext) -> vec4f. Particle fields: pos (world), vel, color, size (0 = config size), alpha, seed, age, life, id. The host increments age by deltaTime before particleUpdate; respawn inside update with particleInit(u32(p.id+0.5), ctx) when age>life. Use particles for sparks, fire, smoke, rain, snow, confetti, debris, magic dust. Use fragment formula-particles only for cheap static fields.',
    'Temporal effects: set history=true for trails, echoes, feedback, motion trails, fluid-like smearing: mix(sourceAt(uv), historyAt(uv + drift), decay) with ctx.historyMix guarding the first frame. Without history=true, historyAt is black.',
    'Prefer a stable descriptive id. If the user asks for a timed effect and gives no range, anchor start at the current media time from state and choose a short sensible duration.',
    'When compilation succeeds, optionally seek to a representative moment inside the effect and pause there so the user sees it immediately.',
    'Finish with one very short confirmation in the user language. Do not paste the full shader in your final message.',
    '',
    'Current ShoulderCut state JSON:',
    stateJson,
    '',
    'Recent chat:',
    historyText || '(none)',
    '',
    'User request:',
    message,
  ].join('\n');
}
async function runClaude(message: string, history: ChatMessage[]): Promise<{ reply: string; stderrTail: string }> {
  if (chatRunning) throw new Error('An agent request is already running');
  chatRunning = true;
  const repoRoot = resolve(process.cwd());
  const workspace = join(repoRoot, 'server', 'agent-workspace');
  const mcpScript = join(repoRoot, 'server', 'shouldercut-mcp.mjs');
  const mcpConfig = {
    transport: 'stdio',
    command: 'node',
    args: [mcpScript],
    mode: 'required',
    enabled: true,
  };
  const executable = findMuseExecutable();
  const args = [
    'exec',
    '--approval-mode', 'never',
    '--disable-web-tools',
    '--disable-request-user-input',
    '--max-model-steps', '24',
    '--reasoning-effort', 'medium',
    '-c', 'mcpServers.shouldercut-fx=' + JSON.stringify(mcpConfig),
    fxPrompt(message, history),
  ];
  try {
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(executable, args, {
        cwd: workspace,
        env: { ...process.env },
        windowsHide: true,
        shell: false,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Muse timed out after 240s. stderr tail: ' + stderr.slice(-1200)));
      }, 240_000);
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolvePromise({ reply: stdout.trim() || 'Done.', stderrTail: stderr.slice(-1200) });
        } else {
          reject(new Error('Muse exited ' + code + '. ' + (stderr || stdout).slice(-2000)));
        }
      });
    });
  } finally {
    chatRunning = false;
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (!originAllowed(req)) {
    sendJson(res, 403, { ok: false, message: 'Origin not allowed for local ShoulderCut bridge' });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, service: 'shouldercut-bridge' });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, statePayload());
    return;
  }
  // --- Edit graph (SPEC §6-7): project document, operations, export ---
  if (req.method === 'GET' && pathname === '/api/project') {
    sendJson(res, 200, { ok: true, project: editGraph.get(), totalDuration: editGraph.totalDuration() });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/clips') {
    const bytes = await readRawBody(req, 2 * 1024 * 1024 * 1024);
    const name = String(req.headers['x-file-name'] || 'clip');
    const clip = await editGraph.addClip(bytes, name);
    broadcast('project', editGraph.get());
    sendJson(res, 200, { ok: true, clip, project: editGraph.get() });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/edit/op') {
    const body = await readJson(req);
    const op = String(body.op || '');
    const id = String(body.clipId || '');
    let label = op;
    if (op === 'trim') editGraph.trimClip(id, Number(body.start), Number(body.end));
    else if (op === 'split') editGraph.splitClip(id, Number(body.at));
    else if (op === 'move') editGraph.moveClip(id, Number(body.toIndex));
    else if (op === 'delete') editGraph.deleteClip(id);
    else if (op === 'captions') editGraph.setCaptions(id, Array.isArray(body.cues) ? body.cues as never[] : [], body.enabled !== false);
    else if (op === 'remove_silences') await editGraph.removeSilences(id, Number(body.thresholdDb ?? -35), Number(body.minSilence ?? 0.45));
    else if (op === 'undo') label = 'undo: ' + editGraph.undo().label;
    else if (op === 'redo') label = 'redo: ' + editGraph.redo().label;
    else throw new Error('Unknown edit op: ' + op);
    broadcast('project', editGraph.get());
    sendJson(res, 200, { ok: true, op: label, project: editGraph.get(), totalDuration: editGraph.totalDuration() });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/export') {
    const body = await readJson(req);
    const preset = body.preset === 'vertical-1080x1920' || body.preset === 'square' ? body.preset : '1080p';
    const result = await editGraph.exportMp4(preset);
    sendJson(res, 200, { ok: true, ...result, url: '/api/export/file?name=' + encodeURIComponent(result.file) });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/export/file') {
    const url = new URL(req.url || '', 'http://127.0.0.1');
    const name = url.searchParams.get('name') || '';
    const data = readExportFile(name);
    if (!data) { sendJson(res, 404, { ok: false, message: 'File not found' }); return; }
    res.writeHead(200, { 'Content-Type': name.endsWith('.srt') ? 'text/plain; charset=utf-8' : 'video/mp4', 'Content-Length': data.length });
    res.end(data);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/project/captions.srt') {
    const srt = projectSrt(editGraph.get());
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(srt);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: hello\ndata: ' + JSON.stringify(statePayload()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (req.method === 'POST' && pathname === '/api/browser/state') {
    const body = await readJson(req);
    browserState = body.state ?? body;
    browserSeenAt = Date.now();
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/effects/result') {
    const body = await readJson(req);
    const requestId = String(body.requestId || '');
    const entry = pending.get(requestId);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(requestId);
      const result = {
        ok: body.ok === true,
        message: String(body.message || ''),
        errors: Array.isArray(body.errors) ? body.errors.map(String) : [],
      };
      if (result.ok && !entry.dryRun) effects.set(entry.effect.id, entry.effect);
      entry.resolve(result);
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/effects/apply') {
    const body = await readJson(req);
    const effect = normaliseEffect(body.effect);
    const result = await waitForCompile(effect);
    sendJson(res, result.ok ? 200 : 422, { ...result, effect });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/effects/validate') {
    const body = await readJson(req);
    const effect = normaliseEffect(body.effect);
    const result = await waitForCompile(effect, true);
    sendJson(res, result.ok ? 200 : 422, { ...result, effect, dryRun: true });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/effects/remove') {
    const body = await readJson(req);
    const id = String(body.id || '');
    const existed = effects.delete(id);
    broadcast('effect-remove', { id });
    sendJson(res, 200, { ok: true, removed: existed, id });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/effects/clear') {
    effects.clear();
    broadcast('effect-clear', {});
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/playback') {
    const body = await readJson(req);
    if (!clients.size) {
      sendJson(res, 422, { ok: false, message: 'No ShoulderCut browser editor is connected' });
      return;
    }
    broadcast('playback', body);
    sendJson(res, 200, { ok: true, queued: body });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/sam/track') {
    const prompt = String(req.headers['x-prompt'] || '').trim();
    const filename = String(req.headers['x-file-name'] || 'clip.mp4');
    const requestId = String(req.headers['x-request-id'] || '');
    if (!prompt) throw new Error('x-prompt header is required');
    const bytes = await readRawBody(req, 256_000_000);
    if (!bytes.length) throw new Error('Empty clip upload');
    try {
      const track = await runTrack(bytes, filename, String(req.headers['content-type'] || 'video/mp4'), prompt);
      const entry = pendingTracks.get(requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pendingTracks.delete(requestId);
        entry.resolve(track);
      }
      sendJson(res, 200, { ok: true, track: trackSummary(track) });
    } catch (error) {
      const entry = pendingTracks.get(requestId);
      if (entry) {
        clearTimeout(entry.timer);
        pendingTracks.delete(requestId);
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
    return;
  }
  if (req.method === 'POST' && pathname === '/api/sam/track-object') {
    const body = await readJson(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw new Error('prompt is required');
    const track = await requestTrackFromBrowser(prompt);
    sendJson(res, 200, { ok: true, track: trackSummary(track) });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/gen/generate') {
    const body = await readJson(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw new Error('prompt is required');
    const job = genManager.createGenerateShot(prompt);
    sendJson(res, 200, { ok: true, job });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/gen/edit') {
    const body = await readJson(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw new Error('prompt is required');
    if (!clients.size) throw new Error('No ShoulderCut browser editor is connected. Open http://127.0.0.1:5173/ first.');
    const start = Number(body.start ?? 0);
    const end = Number(body.end ?? 0);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('start/end must be a valid range');
    const backend = body.backend === 'wan-animate' || body.backend === 'vace' || body.backend === 'kling-o3' || body.backend === 'recast' || body.backend === 'scail' || body.backend === 'scail-animate' || body.backend === 'vace-local' ? String(body.backend) : undefined;
    const job = genManager.createEditJob(prompt, typeof body.refImageUrl === 'string' ? body.refImageUrl : undefined, backend, {
      subjectLabel: typeof body.subjectLabel === 'string' ? body.subjectLabel : undefined,
      refLabel: typeof body.refLabel === 'string' ? body.refLabel : undefined,
    });
    const requestId = 'genup-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
    pendingGenUploads.set(requestId, { job, start, end });
    broadcast('gen-upload-request', { requestId, jobId: job.id });
    sendJson(res, 200, { ok: true, job, note: 'Preparing: waiting for the browser to upload its current clip.' });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/gen/upload') {
    const requestId = String(req.headers['x-request-id'] || '');
    const pending = pendingGenUploads.get(requestId);
    if (!pending) throw new Error('Unknown or expired gen upload request');
    pendingGenUploads.delete(requestId);
    const bytes = await readRawBody(req, 256_000_000);
    if (!bytes.length) throw new Error('Empty clip upload');
    const track = [...tracks.values()].sort((a, b) => b.frames.length - a.frames.length)[0];
    const bs = (browserState ?? {}) as { frameRate?: number | null; codedWidth?: number | null; codedHeight?: number | null };
    const mask = track && track.frames.length ? {
      width: track.frames[0].maskWidth,
      height: track.frames[0].maskHeight,
      sourceFps: bs.frameRate ?? 30,
      frames: track.frames.map((f) => ({ frame: f.frame, data: Buffer.from(f.dataB64, 'base64') })),
    } : null;
    void genManager.prepareAndRunEdit(
      pending.job, bytes, pending.start, pending.end, mask,
      bs.codedWidth ?? 960, bs.codedHeight ?? 540,
    );
    sendJson(res, 200, { ok: true, jobId: pending.job.id });
    return;
  }
  if (req.method === 'GET' && pathname.startsWith('/api/gen/jobs/')) {
    const id = decodeURIComponent(pathname.slice('/api/gen/jobs/'.length));
    const job = genManager.get(id);
    if (!job) { sendJson(res, 404, { ok: false, message: 'Unknown generation job ' + id }); return; }
    // Finished generations join the edit graph as clips (once), so the
    // result is part of the project: trimmable, movable, exportable.
    if (job.state === 'done' && job.files.result && !attachedGenJobs.has(job.id)) {
      attachedGenJobs.add(job.id);
      try {
        const name = 'generated: ' + job.prompt.slice(0, 48);
        await editGraph.addClip(readFileSync(genFilePath(job.files.result)), name);
        broadcast('project', editGraph.get());
      } catch { /* attachment is best-effort; the job file remains available */ }
    }
    sendJson(res, 200, { ok: true, job });
    return;
  }
  if (req.method === 'GET' && pathname.startsWith('/api/gen/files/')) {
    const name = decodeURIComponent(pathname.slice('/api/gen/files/'.length));
    if (name.includes('/') || name.includes('\\') || name.includes('..')) { sendJson(res, 400, { ok: false, message: 'Bad file name' }); return; }
    try {
      const data = readFileSync(genFilePath(name));
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      sendJson(res, 404, { ok: false, message: 'Unknown generated file ' + name });
    }
    return;
  }
  if (req.method === 'POST' && pathname === '/api/frame/describe') {
    const body = await readJson(req);
    const shot = await requestFrameFromBrowser(typeof body.time === 'number' ? body.time : undefined);
    sendJson(res, 200, {
      ok: shot.ok, message: shot.message, mediaTime: shot.mediaTime,
      width: shot.width, height: shot.height,
      pngB64: shot.png ? shot.png.toString('base64') : null,
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/frame/result') {
    // Frame PNGs exceed the JSON body cap: read raw with a frame-sized limit.
    const body = JSON.parse((await readRawBody(req, 16 * 1024 * 1024)).toString('utf8')) as Record<string, unknown>;
    const requestId = String(body.requestId || '');
    const entry = pendingFrames.get(requestId);
    if (entry) {
      pendingFrames.delete(requestId);
      clearTimeout(entry.timer);
      entry.resolve({
        ok: Boolean(body.ok),
        message: String(body.message || ''),
        mediaTime: Number(body.mediaTime || 0),
        width: Number(body.width || 0),
        height: Number(body.height || 0),
        png: typeof body.pngB64 === 'string' ? Buffer.from(body.pngB64, 'base64') : null,
      });
    }
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/preview/working') {
    const body = await readJson(req);
    const subject = String(body.subject || 'subject').trim() || 'subject';
    const color = String(body.color || '#8a8f98');
    const effect: ShaderEffectDefinition = {
      id: '__working-preview', name: 'Working: ' + subject,
      code: workingPreviewCode(color),
      params: [0, 0, 0, 0], start: null, end: null, enabled: true, camera: null, kind: 'fragment', history: false, particles: null,
    };
    const result = await waitForCompile(effect);
    sendJson(res, result.ok ? 200 : 422, { ...result, effect });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/preview/clear') {
    effects.delete('__working-preview');
    broadcast('effect-remove', { id: '__working-preview' });
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/chat') {
    const body = await readJson(req);
    const message = String(body.message || '').trim();
    if (!message) throw new Error('message is required');
    if (!clients.size || !browserState) throw new Error('Open the ShoulderCut page and load a video before chatting');
    const history = Array.isArray(body.history)
      ? body.history.filter(isRecord).map((m) => ({ role: String(m.role || 'user'), text: String(m.text || '') }))
      : [];
    const result = await runClaude(message, history);
    sendJson(res, 200, { ok: true, reply: result.reply, effects: [...effects.values()] });
    return;
  }
  sendJson(res, 404, { ok: false, message: 'Unknown bridge route ' + pathname });
}

export function shouldercutBridge(): Plugin {
  return {
    name: 'shouldercut-bridge',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url || '/', 'http://127.0.0.1:5173').pathname;
        if (!pathname.startsWith('/api/')) {
          next();
          return;
        }
        handleApi(req, res, pathname).catch((error) => {
          sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
        });
      });
    },
  };
}
