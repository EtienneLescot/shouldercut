import './style.css';
import type { PlayerState, ShaderEffectDefinition, WorkerCommand, WorkerEvent } from './render/protocol';

const canvas = document.querySelector<HTMLCanvasElement>('#preview');
const fileInput = document.querySelector<HTMLInputElement>('#fileInput');
const playPauseBtn = document.querySelector<HTMLButtonElement>('#playPauseBtn');
const stepBackBtn = document.querySelector<HTMLButtonElement>('#stepBackBtn');
const stepForwardBtn = document.querySelector<HTMLButtonElement>('#stepForwardBtn');
const seekBtn = document.querySelector<HTMLButtonElement>('#seekBtn');
const seekSeconds = document.querySelector<HTMLInputElement>('#seekSeconds');
const timeline = document.querySelector<HTMLInputElement>('#timeline');
const statusText = document.querySelector<HTMLElement>('#statusText');
const frameText = document.querySelector<HTMLElement>('#frameText');
const mediaText = document.querySelector<HTMLElement>('#mediaText');
const decoderText = document.querySelector<HTMLElement>('#decoderText');
const errorText = document.querySelector<HTMLElement>('#errorText');
const emptyState = document.querySelector<HTMLElement>('#emptyState');
const stage = document.querySelector<HTMLElement>('#stage');
const dropHint = document.querySelector<HTMLElement>('#dropHint');
const agentStatus = document.querySelector<HTMLElement>('#agentStatus');
const chatLog = document.querySelector<HTMLElement>('#chatLog');
const chatForm = document.querySelector<HTMLFormElement>('#chatForm');
const chatInput = document.querySelector<HTMLTextAreaElement>('#chatInput');
const chatSendBtn = document.querySelector<HTMLButtonElement>('#chatSendBtn');
const clearEffectsBtn = document.querySelector<HTMLButtonElement>('#clearEffectsBtn');
const effectsList = document.querySelector<HTMLElement>('#effectsList');
const trackForm = document.querySelector<HTMLFormElement>('#trackForm');
const trackPrompt = document.querySelector<HTMLInputElement>('#trackPrompt');
const trackBtn = document.querySelector<HTMLButtonElement>('#trackBtn');
const trackStatus = document.querySelector<HTMLElement>('#trackStatus');
const captionOverlay = document.querySelector<HTMLElement>('#captionOverlay');
const clipList = document.querySelector<HTMLElement>('#clipList');
const projectStatus = document.querySelector<HTMLElement>('#projectStatus');
const undoBtn = document.querySelector<HTMLButtonElement>('#undoBtn');
const redoBtn = document.querySelector<HTMLButtonElement>('#redoBtn');
const exportPreset = document.querySelector<HTMLSelectElement>('#exportPreset');
const exportBtn = document.querySelector<HTMLButtonElement>('#exportBtn');
const exportStatus = document.querySelector<HTMLElement>('#exportStatus');

if (!canvas || !fileInput || !playPauseBtn || !stepBackBtn || !stepForwardBtn || !seekBtn
  || !seekSeconds || !timeline || !statusText || !frameText || !mediaText || !decoderText
  || !errorText || !emptyState || !stage || !dropHint || !agentStatus || !chatLog || !chatForm
  || !chatInput || !chatSendBtn || !clearEffectsBtn || !effectsList || !trackForm || !trackPrompt
  || !trackBtn || !trackStatus || !captionOverlay || !clipList || !projectStatus || !undoBtn
  || !redoBtn || !exportPreset || !exportBtn || !exportStatus) {
  throw new Error('Missing application controls');
}

let currentFile: File | null = null;

// --- Edit graph project (SPEC §6): server is the source of truth ---
interface CaptionCuePayload { start: number; end: number; text: string }
interface ProjectClipPayload {
  id: string; name: string; hash: string; duration: number;
  in: number; out: number; captions: CaptionCuePayload[]; captionsEnabled: boolean;
}
interface ProjectPayload { version: number; clips: ProjectClipPayload[] }
let project: ProjectPayload | null = null;
let activeClipId: string | null = null;
let advancing = false;
const filesByHash = new Map<string, File>();
const registeredFiles = new Set<string>();

async function registerClip(file: File): Promise<void> {
  const key = file.name + ':' + file.size + ':' + file.lastModified;
  if (registeredFiles.has(key)) return;
  registeredFiles.add(key);
  try {
    const response = await fetch('/api/clips', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'video/mp4', 'x-file-name': file.name },
      body: file,
    });
    const payload = await response.json() as { ok?: boolean; clip?: ProjectClipPayload; project?: ProjectPayload };
    if (payload.clip && payload.project) {
      filesByHash.set(payload.clip.hash, file);
      activeClipId = payload.clip.id;
      renderProject(payload.project);
    }
  } catch { /* project registration is best-effort for preview */ }
}

function activeClip(): ProjectClipPayload | null {
  return project?.clips.find((c) => c.id === activeClipId) ?? null;
}

function renderProject(next: ProjectPayload): void {
  project = next;
  const total = next.clips.reduce((sum, c) => sum + (c.out - c.in), 0);
  projectStatus!.textContent = next.clips.length
    ? next.clips.length + ' clip(s) - ' + total.toFixed(2) + ' s total'
    : 'No clips yet';
  document.body.dataset.projectClips = String(next.clips.length);
  clipList!.replaceChildren();
  if (!next.clips.length) {
    clipList!.textContent = 'Open a video: it joins the edit graph.';
    return;
  }
  for (const clip of next.clips) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'clip-item' + (clip.id === activeClipId ? ' active' : '');
    const cues = clip.captionsEnabled && clip.captions.length ? ' - ' + clip.captions.length + ' captions' : '';
    button.textContent = clip.name + ' [' + clip.in.toFixed(2) + 's-' + clip.out.toFixed(2) + 's]' + cues;
    button.addEventListener('click', () => previewClip(clip.id, false));
    clipList!.append(button);
  }
}

function previewClip(clipId: string, autoplay: boolean): void {
  const clip = project?.clips.find((c) => c.id === clipId);
  if (!clip) return;
  const file = filesByHash.get(clip.hash);
  activeClipId = clip.id;
  if (project) renderProject(project);
  if (!file) return;
  if (currentFile !== file) loadFile(file);
  // Wait for the worker to be ready before seeking into the segment.
  setTimeout(() => {
    send({ type: 'seek', time: clip.in });
    if (autoplay) send({ type: 'play' });
  }, currentFile === file ? 60 : 900);
}

function updateCaptionOverlay(mediaTime: number): void {
  const clip = activeClip();
  const cue = clip?.captionsEnabled
    ? clip.captions.find((c) => mediaTime >= c.start && mediaTime <= c.end)
    : undefined;
  captionOverlay!.textContent = cue?.text ?? '';
  captionOverlay!.classList.toggle('hidden', !cue);
}

function advanceIfNeeded(state: PlayerState): void {
  const clip = activeClip();
  if (!clip || !project) return;
  const pastOut = state.mediaTime >= clip.out - 0.02;
  if (!pastOut && state.phase !== 'ended') return;
  if (state.phase !== 'playing' && state.phase !== 'ended') return;
  if (advancing) return;
  const index = project.clips.findIndex((c) => c.id === clip.id);
  const next = project.clips[index + 1];
  advancing = true;
  setTimeout(() => { advancing = false; }, 1200);
  if (next) previewClip(next.id, true);
  else if (state.phase === 'playing') send({ type: 'pause' });
}

async function editOp(op: string, extra: Record<string, unknown> = {}): Promise<void> {
  const response = await fetch('/api/edit/op', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, ...extra }),
  });
  const payload = await response.json() as { ok?: boolean; project?: ProjectPayload; message?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.message || ('Edit op failed: ' + op));
  if (payload.project) renderProject(payload.project);
}

interface SamTrackPayload {
  prompt: string;
  frameWidth: number;
  frameHeight: number;
  frames: { frame: number; maskWidth: number; maskHeight: number; dataB64: string }[];
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function forwardMaskTrack(track: SamTrackPayload): void {
  if (!track.frames.length) return;
  const frames = track.frames.map((f) => ({ frame: f.frame, data: base64ToArrayBuffer(f.dataB64) }));
  send({
    type: 'setMaskTrack',
    track: {
      prompt: track.prompt,
      maskWidth: track.frames[0].maskWidth,
      maskHeight: track.frames[0].maskHeight,
      frames,
    },
  }, frames.map((f) => f.data));
  trackStatus!.textContent = 'Mask: ' + track.prompt + ' (' + track.frames.length + ' frames)';
  document.body.dataset.maskPrompt = track.prompt;
  document.body.dataset.maskFrames = String(track.frames.length);
}

let currentState: PlayerState | null = null;
let scrubbing = false;
let lastBridgeStateAt = 0;
const chatHistory: { role: string; text: string }[] = [];
const activeEffects = new Map<string, ShaderEffectDefinition>();
const pendingEffects = new Map<string, ShaderEffectDefinition>();

const worker = new Worker(new URL('./render/render-worker.ts', import.meta.url), { type: 'module' });
function send(command: WorkerCommand, transfer: Transferable[] = []): void {
  worker.postMessage(command, transfer);
}

const offscreen = canvas.transferControlToOffscreen();
send({ type: 'init', canvas: offscreen }, [offscreen]);

function formatTime(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '-' : value.toFixed(6) + ' s';
}
function setControlsEnabled(enabled: boolean): void {
  playPauseBtn!.disabled = !enabled;
  stepBackBtn!.disabled = !enabled;
  stepForwardBtn!.disabled = !enabled;
  seekBtn!.disabled = !enabled;
  timeline!.disabled = !enabled;
  seekSeconds!.disabled = !enabled;
}
function publishBrowserState(state: PlayerState): void {
  const now = performance.now();
  if (now - lastBridgeStateAt < 250 && state.phase === 'playing') return;
  lastBridgeStateAt = now;
  void fetch('/api/browser/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  }).catch(() => undefined);
}
function addChatMessage(role: 'user' | 'agent', text: string): void {
  chatHistory.push({ role, text });
  const node = document.createElement('div');
  node.className = 'message ' + role;
  node.textContent = text;
  chatLog!.append(node);
  chatLog!.scrollTop = chatLog!.scrollHeight;
}
function renderEffects(): void {
  document.body.dataset.effectCount = String(activeEffects.size);
  document.body.dataset.effectNames = [...activeEffects.values()].map((e) => e.name).join('|');
  effectsList!.replaceChildren();
  if (!activeEffects.size) {
    effectsList!.textContent = 'No agent-written shader yet.';
    return;
  }
  for (const effect of activeEffects.values()) {
    const details = document.createElement('details');
    details.className = 'effect-item';
    const summary = document.createElement('summary');
    const range = effect.start === null && effect.end === null
      ? 'whole clip'
      : String(effect.start ?? 0) + 's to ' + String(effect.end ?? 'end') + 's';
    summary.textContent = effect.name + ' (' + range + ')';
    const code = document.createElement('pre');
    code.textContent = effect.code;
    const meta = document.createElement('div');
    meta.className = 'effect-meta';
    const params = document.createElement('span');
    params.textContent = 'params ' + effect.params.join(', ');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      void fetch('/api/effects/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: effect.id }),
      });
    });
    meta.append(params, remove);
    details.append(summary, code, meta);
    effectsList!.append(details);
  }
}
function loadFile(file: File): void {
  errorText!.textContent = '';
  currentFile = file;
  send({ type: 'load', file });
  void registerClip(file);
}
async function uploadClipForTrack(prompt: string, requestId: string): Promise<void> {
  if (!currentFile) throw new Error('Load a video before tracking an object');
  trackStatus!.textContent = 'SAM tracking "' + prompt + '"...';
  const response = await fetch('/api/sam/track', {
    method: 'POST',
    headers: {
      'Content-Type': currentFile.type || 'video/mp4',
      'x-prompt': prompt,
      'x-file-name': currentFile.name,
      'x-request-id': requestId,
    },
    body: currentFile,
  });
  const payload = await response.json() as { ok?: boolean; message?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.message || 'SAM tracking failed');
}
function connectBridge(): void {
  const events = new EventSource('/api/events');
  events.addEventListener('hello', (event) => {
    agentStatus!.textContent = 'MCP bridge connected';
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { effects?: ShaderEffectDefinition[] };
      for (const effect of payload.effects || []) {
        const requestId = 'restore-' + effect.id;
        pendingEffects.set(requestId, effect);
        send({ type: 'upsertEffect', requestId, effect });
      }
    } catch { /* hello is informational */ }
  });
  events.addEventListener('effect-apply', (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as {
      requestId: string;
      effect: ShaderEffectDefinition;
      dryRun?: boolean;
    };
    pendingEffects.set(payload.requestId, payload.effect);
    agentStatus!.textContent = (payload.dryRun ? 'Validating shader: ' : 'Compiling shader: ') + payload.effect.name;
    send({ type: 'upsertEffect', requestId: payload.requestId, effect: payload.effect, dryRun: payload.dryRun ?? false });
  });
  events.addEventListener('effect-remove', (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as { id: string };
    activeEffects.delete(payload.id);
    send({ type: 'removeEffect', effectId: payload.id });
    renderEffects();
  });
  events.addEventListener('effect-clear', () => {
    activeEffects.clear();
    send({ type: 'clearEffects' });
    renderEffects();
  });
  events.addEventListener('gen-upload-request', (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as { requestId: string; jobId: string };
    if (!currentFile) return;
    void fetch('/api/gen/upload', {
      method: 'POST',
      headers: {
        'Content-Type': currentFile.type || 'video/mp4',
        'x-request-id': payload.requestId,
        'x-file-name': currentFile.name,
      },
      body: currentFile,
    }).catch(() => undefined);
  });
  events.addEventListener('track-request', (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as { requestId: string; prompt: string };
    void uploadClipForTrack(payload.prompt, payload.requestId).catch((error: unknown) => {
      trackStatus!.textContent = 'SAM tracking failed';
      errorText!.textContent = error instanceof Error ? error.message : String(error);
    });
  });
  events.addEventListener('mask-track', (event) => {
    const track = JSON.parse((event as MessageEvent<string>).data) as SamTrackPayload;
    forwardMaskTrack(track);
  });
  events.addEventListener('project', (event) => {
    try {
      renderProject(JSON.parse((event as MessageEvent<string>).data) as ProjectPayload);
    } catch { /* project events are informational */ }
  });
  events.addEventListener('frame-request', (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as { requestId: string; time?: number | null };
    if (typeof payload.time === 'number') send({ type: 'seek', time: payload.time });
    setTimeout(() => send({ type: 'captureFrame', requestId: payload.requestId }), typeof payload.time === 'number' ? 500 : 0);
  });
  events.addEventListener('playback', (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as { action?: string; time?: number };
    if (payload.action === 'play') send({ type: 'play' });
    if (payload.action === 'pause') send({ type: 'pause' });
    if (payload.action === 'seek' && typeof payload.time === 'number') send({ type: 'seek', time: payload.time });
  });
  events.addEventListener('error', () => {
    agentStatus!.textContent = 'MCP bridge reconnecting...';
  });
}
function renderState(state: PlayerState): void {
  currentState = state;
  updateCaptionOverlay(state.mediaTime);
  advanceIfNeeded(state);
  publishBrowserState(state);
  statusText!.textContent = state.phase + ' - ' + state.message;
  const frameBits = [
    'media ' + formatTime(state.mediaTime),
    'frame ts ' + formatTime(state.frameTimestamp),
    'index ' + (state.frameIndex ?? '-'),
    'dur ' + formatTime(state.frameDuration),
  ];
  frameText!.textContent = frameBits.join(' | ');
  const mediaBits = [
    state.fileName || '-',
    state.displayWidth && state.displayHeight ? state.displayWidth + 'x' + state.displayHeight : '-',
    'duration ' + formatTime(state.duration),
    'fps ' + (state.frameRate ? state.frameRate.toFixed(3) : '-'),
  ];
  mediaText!.textContent = mediaBits.join(' | ');
  decoderText!.textContent = [
    state.decoderConfig || '-',
    'hw ' + (state.hardwareAcceleration || '-'),
    'buffered ' + state.bufferedFrames,
    'decoded ' + state.decodedFrames,
  ].join(' | ');
  document.body.dataset.phase = state.phase;
  document.body.dataset.frameTimestamp = state.frameTimestamp === null ? '' : String(state.frameTimestamp);
  document.body.dataset.mediaTime = String(state.mediaTime);
  emptyState!.classList.toggle('hidden', Boolean(state.fileName));
  const ready = ['ready', 'playing', 'paused', 'ended'].includes(state.phase);
  setControlsEnabled(ready);
  playPauseBtn!.textContent = state.phase === 'playing' ? 'Pause' : 'Play';
  if (state.duration > 0) {
    timeline!.max = String(state.duration);
    seekSeconds!.max = String(state.duration);
  }
  if (!scrubbing) {
    timeline!.value = String(state.mediaTime);
    if (document.activeElement !== seekSeconds) seekSeconds!.value = state.mediaTime.toFixed(3);
  }
  if (state.phase !== 'error') errorText!.textContent = '';
}

worker.addEventListener('message', (event: MessageEvent<WorkerEvent>) => {
  const data = event.data;
  if (data.type === 'state') renderState(data.state);
  if (data.type === 'effectResult') {
    const effect = pendingEffects.get(data.result.requestId);
    pendingEffects.delete(data.result.requestId);
    if (data.result.ok && data.result.dryRun) {
      agentStatus!.textContent = 'Shader valid (dry run): ' + (effect?.name ?? data.result.effectId);
    } else if (data.result.ok && effect) {
      activeEffects.set(effect.id, effect);
      renderEffects();
      agentStatus!.textContent = 'Shader active: ' + effect.name;
    } else if (!data.result.ok) {
      agentStatus!.textContent = 'Shader compile failed';
      errorText!.textContent = data.result.errors.join('\n');
    }
    void fetch('/api/effects/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data.result),
    }).catch(() => undefined);
  }
  if (data.type === 'frameResult') {
    const r = data.result;
    let pngB64: string | null = null;
    if (r.png) {
      const bytes = new Uint8Array(r.png);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      pngB64 = btoa(binary);
    }
    void fetch('/api/frame/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: r.requestId, ok: r.ok, message: r.message,
        mediaTime: r.mediaTime, width: r.width, height: r.height, pngB64,
      }),
    }).catch(() => undefined);
  }
  if (data.type === 'error') {
    errorText!.textContent = data.message;
    statusText!.textContent = 'error';
  }
});
connectBridge();
renderEffects();
worker.addEventListener('error', (event) => {
  errorText.textContent = event.message || 'Render worker failed';
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
});
for (const eventName of ['dragenter', 'dragover']) {
  stage.addEventListener(eventName, (event) => {
    event.preventDefault();
    stage.classList.add('drag-over');
    dropHint.classList.remove('hidden');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  stage.addEventListener(eventName, (event) => {
    event.preventDefault();
    stage.classList.remove('drag-over');
    dropHint.classList.add('hidden');
  });
}
stage.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
playPauseBtn.addEventListener('click', () => {
  send({ type: currentState?.phase === 'playing' ? 'pause' : 'play' });
});
stepBackBtn.addEventListener('click', () => send({ type: 'step', delta: -1 }));
stepForwardBtn.addEventListener('click', () => send({ type: 'step', delta: 1 }));
function seekFromInputs(value: number): void {
  if (!Number.isFinite(value)) return;
  send({ type: 'seek', time: Math.max(0, value) });
}
seekBtn.addEventListener('click', () => seekFromInputs(Number(seekSeconds.value)));
seekSeconds.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') seekFromInputs(Number(seekSeconds.value));
});
timeline.addEventListener('pointerdown', () => { scrubbing = true; });
timeline.addEventListener('pointerup', () => { scrubbing = false; });
timeline.addEventListener('change', () => {
  scrubbing = false;
  seekFromInputs(Number(timeline.value));
});
undoBtn.addEventListener('click', () => {
  void editOp('undo').catch((error: unknown) => { errorText!.textContent = error instanceof Error ? error.message : String(error); });
});
redoBtn.addEventListener('click', () => {
  void editOp('redo').catch((error: unknown) => { errorText!.textContent = error instanceof Error ? error.message : String(error); });
});
exportBtn.addEventListener('click', () => {
  exportBtn.disabled = true;
  exportStatus.textContent = 'Exporting...';
  void fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset: exportPreset.value }),
  }).then(async (response) => {
    const payload = await response.json() as { ok?: boolean; url?: string; srtFile?: string; message?: string };
    if (!response.ok || !payload.ok || !payload.url) throw new Error(payload.message || 'Export failed');
    const link = document.createElement('a');
    link.href = payload.url;
    link.textContent = 'Download MP4';
    exportStatus.replaceChildren(link);
    if (payload.srtFile) {
      const srtLink = document.createElement('a');
      srtLink.href = '/api/export/file?name=' + encodeURIComponent(payload.srtFile);
      srtLink.textContent = 'SRT';
      exportStatus.append(' · ', srtLink);
    }
  }).catch((error: unknown) => {
    exportStatus.textContent = error instanceof Error ? error.message : String(error);
  }).finally(() => { exportBtn.disabled = false; });
});
void fetch('/api/project').then(async (response) => {
  const payload = await response.json() as { project?: ProjectPayload };
  if (payload.project) renderProject(payload.project);
}).catch(() => undefined);
clearEffectsBtn.addEventListener('click', () => {
  void fetch('/api/effects/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
});
trackForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const prompt = trackPrompt.value.trim();
  if (!prompt || trackBtn.disabled) return;
  trackBtn.disabled = true;
  void uploadClipForTrack(prompt, '').catch((error: unknown) => {
    trackStatus.textContent = 'SAM tracking failed';
    errorText.textContent = error instanceof Error ? error.message : String(error);
  }).finally(() => {
    trackBtn.disabled = false;
  });
});
chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message || chatSendBtn.disabled) return;
  chatInput.value = '';
  addChatMessage('user', message);
  chatSendBtn.disabled = true;
  agentStatus.textContent = 'Muse is writing WGSL...';
  void fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history: chatHistory.slice(0, -1) }),
  }).then(async (response) => {
    const payload = await response.json() as { ok?: boolean; reply?: string; message?: string; effects?: ShaderEffectDefinition[] };
    if (!response.ok || !payload.ok) throw new Error(payload.message || 'Agent request failed');
    if (Array.isArray(payload.effects)) {
      activeEffects.clear();
      for (const effect of payload.effects) activeEffects.set(effect.id, effect);
      renderEffects();
    }
    addChatMessage('agent', payload.reply || 'Done.');
    agentStatus.textContent = 'Muse harness idle';
  }).catch((error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    addChatMessage('agent', 'Error: ' + text);
    agentStatus.textContent = 'Muse harness error';
    errorText.textContent = text;
  }).finally(() => {
    chatSendBtn.disabled = false;
    chatInput.focus();
  });
});
