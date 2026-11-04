import "./style.css";
import { setupRealtimeVoice } from "./voice";
import { createMascot, type MascotState } from "./mascot";
import { createWorkTrail } from "./worktrail";
import type {
  PlayerState,
  ShaderEffectDefinition,
  WorkerCommand,
  WorkerEvent,
} from "./render/protocol";

const canvas = document.querySelector<HTMLCanvasElement>("#preview");
const fileInput = document.querySelector<HTMLInputElement>("#fileInput");
const playPauseBtn = document.querySelector<HTMLButtonElement>("#playPauseBtn");
const timeline = document.querySelector<HTMLInputElement>("#timeline");
const errorText = document.querySelector<HTMLElement>("#errorText");
const emptyState = document.querySelector<HTMLElement>("#emptyState");
const stage = document.querySelector<HTMLElement>("#stage");
const dropHint = document.querySelector<HTMLElement>("#dropHint");
const agentStatus = document.querySelector<HTMLElement>("#agentStatus");
const chatLog = document.querySelector<HTMLElement>("#chatLog");
const chatForm = document.querySelector<HTMLFormElement>("#chatForm");
const chatInput = document.querySelector<HTMLInputElement>("#chatInput");
const chatSendBtn = document.querySelector<HTMLButtonElement>("#chatSendBtn");
const voiceBtn = document.querySelector<HTMLButtonElement>("#voiceBtn");
const pttBtn = document.querySelector<HTMLButtonElement>("#pttBtn");
const voiceStatus = document.querySelector<HTMLElement>("#voiceStatus");
const captionOverlay = document.querySelector<HTMLElement>("#captionOverlay");
const clipList = document.querySelector<HTMLElement>("#clipList");
const projectStatus = document.querySelector<HTMLElement>("#projectStatus");
const undoBtn = document.querySelector<HTMLButtonElement>("#undoBtn");
const redoBtn = document.querySelector<HTMLButtonElement>("#redoBtn");
const exportPreset = document.querySelector<HTMLSelectElement>("#exportPreset");
const exportBtn = document.querySelector<HTMLButtonElement>("#exportBtn");
const exportStatus = document.querySelector<HTMLElement>("#exportStatus");
const museCanvas = document.querySelector<HTMLCanvasElement>("#museCanvas");
const replyLine = document.querySelector<HTMLElement>("#replyLine");
const micSelect = document.querySelector<HTMLSelectElement>("#micSelect");

if (
  !canvas ||
  !fileInput ||
  !playPauseBtn ||
  !timeline ||
  !errorText ||
  !emptyState ||
  !stage ||
  !dropHint ||
  !agentStatus ||
  !chatLog ||
  !chatForm ||
  !chatInput ||
  !chatSendBtn ||
  !voiceBtn ||
  !voiceStatus ||
  !captionOverlay ||
  !clipList ||
  !projectStatus ||
  !undoBtn ||
  !redoBtn ||
  !exportPreset ||
  !exportBtn ||
  !exportStatus ||
  !museCanvas ||
  !replyLine ||
  !micSelect ||
  !pttBtn
)
  throw new Error("Missing application controls");
const currentTime = document.querySelector<HTMLElement>("#currentTime")!;
const durationTime = document.querySelector<HTMLElement>("#durationTime")!;
const playIcon = document.querySelector<SVGPathElement>("#playIcon")!;
const clipTitle = document.querySelector<HTMLElement>("#clipTitle")!;
const selectionCanvas =
  document.querySelector<HTMLCanvasElement>("#selectionCanvas")!;
const selectionBadge = document.querySelector<HTMLElement>("#selectionBadge")!;
const selectionLabel = document.querySelector<HTMLElement>("#selectionLabel")!;
document
  .querySelector("#emptyImport")!
  .addEventListener("click", () => fileInput!.click());

let currentFile: File | null = null;

// --- UI state: one string drives the button, the stage and the mascot ---
const muse = createMascot(museCanvas);
const trail = createWorkTrail(
  document.querySelector<HTMLElement>("#workTrail")!,
);

// The interface gets out of the way when nobody is pointing at it, and
// comes back on the first sign of a hand. Typing counts as attention, so
// the chrome never vanishes mid-instruction.
const QUIET_AFTER_MS = 3200;
let quietTimer: ReturnType<typeof setTimeout> | null = null;
function stirChrome(): void {
  document.body.dataset.chrome = "awake";
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    const typing =
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement;
    if (!typing) document.body.dataset.chrome = "quiet";
  }, QUIET_AFTER_MS);
}
for (const event of ["pointermove", "pointerdown", "keydown", "wheel"]) {
  window.addEventListener(event, stirChrome, { passive: true });
}
stirChrome();
// Speaking is permanent, and the statuses are independent: you talk to Muse
// while she works, and you interrupt her with a new instruction. So work is
// an axis of its own -- body[data-working], the mascot's hands, the trail --
// and it never writes to data-ui, which carries only what is being said.
// Folding work into the ui state is what used to drop her listening pose the
// moment an edit began, and what made the two look like separate phases.
let chatWorking = false,
  voiceWorking = false,
  supervisorWorking = false,
  generationWorking = false,
  actionWorking = false,
  trailOpen = false;
function updateWorking(): void {
  const working =
    chatWorking ||
    voiceWorking ||
    supervisorWorking ||
    generationWorking ||
    actionWorking;
  // One owner for the trail's lifetime, so no path can leave it counting.
  if (working !== trailOpen) {
    if (working) trail.begin("Muse takes the request");
    else trail.end();
    trailOpen = working;
  }
  muse.setWorking(working);
  document.body.dataset.working = String(working);
}
let doneTimer: ReturnType<typeof setTimeout> | null = null;

function setUiState(next: MascotState): void {
  if (document.body.dataset.ui === next) return;
  document.body.dataset.ui = next;
  muse.setState(next);
  if (doneTimer) {
    clearTimeout(doneTimer);
    doneTimer = null;
  }
  if (next === "done" || next === "error") {
    // Back to resting attention, whether or not she is still working:
    // the work shows on its own axis.
    doneTimer = setTimeout(() => setUiState("idle"), 1600);
  }
}

function setMicLevel(level: number): void {
  document.documentElement.style.setProperty("--level", level.toFixed(3));
  if (document.body.dataset.ui !== "speaking") muse.setLevel(level);
}

// --- Edit graph project (SPEC §6): server is the source of truth ---
interface CaptionCuePayload {
  start: number;
  end: number;
  text: string;
}
interface ProjectClipPayload {
  id: string;
  name: string;
  hash: string;
  duration: number;
  in: number;
  out: number;
  captions: CaptionCuePayload[];
  captionsEnabled: boolean;
}
interface ProjectPayload {
  version: number;
  clips: ProjectClipPayload[];
}
let project: ProjectPayload | null = null;
let activeClipId: string | null = null;
let advancing = false;
const filesByHash = new Map<string, File>();
const registeredFiles = new Set<string>();

async function registerClip(file: File): Promise<void> {
  const key = file.name + ":" + file.size + ":" + file.lastModified;
  if (registeredFiles.has(key)) return;
  registeredFiles.add(key);
  try {
    const response = await fetch("/api/clips", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "video/mp4",
        "x-file-name": file.name,
      },
      body: file,
    });
    const payload = (await response.json()) as {
      ok?: boolean;
      clip?: ProjectClipPayload;
      project?: ProjectPayload;
    };
    if (payload.clip && payload.project) {
      filesByHash.set(payload.clip.hash, file);
      activeClipId = payload.clip.id;
      renderProject(payload.project);
    }
  } catch {
    /* project registration is best-effort for preview */
  }
}

function activeClip(): ProjectClipPayload | null {
  return project?.clips.find((c) => c.id === activeClipId) ?? null;
}

let renderingClipId: string | null = null;

/** Raw body: a rendered clip is megabytes, too big to base64 into JSON. */
function postRenderResult(
  requestId: string,
  ok: boolean,
  message: string,
  clipId: string,
  frames: number,
  mp4: ArrayBuffer | null,
): Promise<unknown> {
  return fetch("/api/export/render-result", {
    method: "POST",
    headers: {
      "Content-Type": "video/mp4",
      "x-request-id": requestId,
      "x-ok": ok ? "1" : "0",
      "x-message": encodeURIComponent(message),
      "x-clip-id": clipId,
      "x-frames": String(frames),
    },
    body: mp4 ?? new ArrayBuffer(0),
  }).catch(() => undefined);
}

function renderProject(next: ProjectPayload): void {
  project = next;
  const total = next.clips.reduce((sum, c) => sum + (c.out - c.in), 0);
  projectStatus!.textContent = next.clips.length
    ? next.clips.length +
      (next.clips.length > 1 ? " plans" : " plan") +
      " · " +
      formatTime(total)
    : "";
  document.body.dataset.projectClips = String(next.clips.length);
  clipList!.replaceChildren();
  exportBtn!.disabled = !next.clips.length;
  if (next.clips.length < 2) return;
  for (const clip of next.clips) {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "clip-item" + (clip.id === activeClipId ? " active" : "");
    // The strip is a ribbon of shots, each as wide as it is long. Equal
    // chips read as tabs and say nothing about the shape of the montage.
    // The floor keeps a one-second shot from collapsing to a sliver.
    button.style.setProperty(
      "--span",
      String(Math.max(0.35, clip.out - clip.in)),
    );
    button.textContent =
      next.clips.indexOf(clip) +
      1 +
      " · " +
      (clip.name.startsWith("generated:") ? "Nouvelle version" : clip.name);
    button.title = clip.name;
    button.addEventListener("click", () => previewClip(clip.id, false));
    clipList!.append(button);
  }
}

function previewClip(clipId: string, autoplay: boolean): void {
  void loadProjectClip(clipId, autoplay).catch((error) => {
    errorText!.textContent =
      error instanceof Error ? error.message : String(error);
  });
}

async function loadProjectClip(
  clipId: string,
  autoplay: boolean,
): Promise<void> {
  const clip = project?.clips.find((c) => c.id === clipId);
  if (!clip) return;
  clearSelection();
  activeClipId = clip.id;
  if (project) renderProject(project);
  let file = filesByHash.get(clip.hash);
  if (!file) {
    const response = await fetch(
      "/api/clips/" + encodeURIComponent(clip.id) + "/source",
    );
    if (!response.ok) throw new Error("Impossible de recharger ce clip.");
    file = new File([await response.blob()], clip.name, { type: "video/mp4" });
    filesByHash.set(clip.hash, file);
  }
  if (activeClipId !== clip.id) return;
  if (currentFile !== file) {
    const ready = waitForPlayer(
      (state) =>
        state.fileName === clip.name &&
        ["paused", "ready"].includes(state.phase),
    );
    currentFile = file;
    send({ type: "load", file }); // already registered: do not add a duplicate
    await ready;
  }
  if (activeClipId !== clip.id) return;
  const sought = waitForPlayer(
    (state) =>
      state.phase === "paused" && Math.abs(state.mediaTime - clip.in) < 0.1,
  );
  send({ type: "seek", time: clip.in });
  await sought;
  const masks = await fetch(
    "/api/clips/" + encodeURIComponent(clip.id) + "/mask",
  );
  if (!masks.ok)
    throw new Error("Could not restore the cutout for this clip.");
  const stored = (await masks.json()) as { track?: SamTrackPayload | null };
  if (activeClipId !== clip.id) return;
  send({ type: "clearMaskTrack" });
  if (stored.track) forwardMaskTrack(stored.track);
  if (currentState) publishBrowserState(currentState);
  if (autoplay && activeClipId === clip.id) send({ type: "play" });
}

function waitForPlayer(accept: (state: PlayerState) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      worker.removeEventListener("message", onState);
    };
    const onState = (event: MessageEvent<WorkerEvent>): void => {
      if (event.data.type !== "state") return;
      if (event.data.state.phase === "error") {
        cleanup();
        reject(new Error(event.data.state.message));
      } else if (accept(event.data.state)) {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("The video is not responding. Reload the clip."));
    }, 15_000);
    worker.addEventListener("message", onState);
  });
}

function updateCaptionOverlay(mediaTime: number): void {
  const clip = activeClip();
  const cue = clip?.captionsEnabled
    ? clip.captions.find((c) => mediaTime >= c.start && mediaTime <= c.end)
    : undefined;
  captionOverlay!.textContent = cue?.text ?? "";
  captionOverlay!.classList.toggle("hidden", !cue);
}

function advanceIfNeeded(state: PlayerState): void {
  const clip = activeClip();
  if (!clip || !project) return;
  const pastOut = state.mediaTime >= clip.out - 0.02;
  if (!pastOut && state.phase !== "ended") return;
  if (state.phase !== "playing" && state.phase !== "ended") return;
  if (advancing) return;
  const index = project.clips.findIndex((c) => c.id === clip.id);
  const next = project.clips[index + 1];
  advancing = true;
  setTimeout(() => {
    advancing = false;
  }, 1200);
  if (next) previewClip(next.id, true);
  else if (state.phase === "playing") send({ type: "pause" });
}

async function editOp(
  op: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const response = await fetch("/api/edit/op", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, ...extra }),
  });
  const payload = (await response.json()) as {
    ok?: boolean;
    project?: ProjectPayload;
    message?: string;
  };
  if (!response.ok || !payload.ok)
    throw new Error(payload.message || "Edit op failed: " + op);
  if (payload.project) renderProject(payload.project);
}

interface SamTrackPayload {
  prompt: string;
  frameWidth: number;
  frameHeight: number;
  clipHash?: string;
  start?: number;
  end?: number;
  sourceFps?: number;
  frames: {
    frame: number;
    maskWidth: number;
    maskHeight: number;
    dataB64: string;
  }[];
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function forwardMaskTrack(track: SamTrackPayload): void {
  if (!track.frames.length) return;
  if (track.clipHash && track.clipHash !== activeClip()?.hash) return;
  const frames = track.frames.map((f) => ({
    frame: f.frame,
    data: base64ToArrayBuffer(f.dataB64),
  }));
  send(
    {
      type: "setMaskTrack",
      track: {
        prompt: track.prompt,
        maskWidth: track.frames[0].maskWidth,
        maskHeight: track.frames[0].maskHeight,
        frames,
      },
    },
    frames.map((f) => f.data),
  );
  document.body.dataset.maskPrompt = track.prompt;
  document.body.dataset.maskFrames = String(track.frames.length);
}

// UI-only selection: never enters the shader stack or exported pixels.
let selectionPreview: {
  track: SamTrackPayload;
  frames: { frame: number; bytes: Uint8Array }[];
  drawn: number;
} | null = null;
function clearSelection(): void {
  selectionPreview = null;
  selectionCanvas.classList.add("hidden");
  selectionBadge.classList.add("hidden");
}
function cancelSelection(): void {
  clearSelection();
  void fetch("/api/assistant/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "clear_preview" }),
  });
}
document
  .querySelector("#dismissSelection")!
  .addEventListener("click", cancelSelection);
function showSelection(track: SamTrackPayload): void {
  if (track.clipHash && track.clipHash !== activeClip()?.hash) return;
  selectionPreview = {
    track,
    frames: track.frames.map((f) => ({
      frame: f.frame,
      bytes: new Uint8Array(base64ToArrayBuffer(f.dataB64)),
    })),
    drawn: -1,
  };
  selectionLabel.textContent = "Cutout preview";
  if (currentState) drawSelection(currentState);
}
function drawSelection(state: PlayerState): void {
  if (!selectionPreview) return;
  const { track, frames } = selectionPreview;
  if (
    track.clipHash !== activeClip()?.hash ||
    state.mediaTime < (track.start || 0) - 0.05 ||
    state.mediaTime >= (track.end || Infinity)
  ) {
    selectionCanvas.classList.add("hidden");
    selectionBadge.classList.add("hidden");
    return;
  }
  const index = Math.round(
    state.mediaTime * (track.sourceFps || state.frameRate || 24),
  );
  const frame = frames.filter((f) => f.frame <= index).at(-1);
  if (!frame) return;
  selectionCanvas.classList.remove("hidden");
  selectionBadge.classList.remove("hidden");
  if (selectionPreview.drawn === frame.frame) return;
  selectionPreview.drawn = frame.frame;
  const w = track.frames[0].maskWidth,
    h = track.frames[0].maskHeight;
  selectionCanvas.width = w;
  selectionCanvas.height = h;
  const ctx = selectionCanvas.getContext("2d")!,
    pixels = ctx.createImageData(w, h),
    m = frame.bytes;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x,
        j = i * 4,
        inside = m[i] > 127;
      const edge =
        inside &&
        (x === 0 ||
          x === w - 1 ||
          y === 0 ||
          y === h - 1 ||
          m[i - 1] < 128 ||
          m[i + 1] < 128 ||
          m[i - w] < 128 ||
          m[i + w] < 128);
      pixels.data[j] = edge ? 125 : inside ? 62 : 10;
      pixels.data[j + 1] = edge ? 185 : inside ? 127 : 19;
      pixels.data[j + 2] = edge ? 255 : inside ? 238 : 33;
      pixels.data[j + 3] = edge ? 255 : inside ? 30 : 150;
    }
  ctx.putImageData(pixels, 0, 0);
}

let currentState: PlayerState | null = null;
let scrubbing = false;
let lastBridgeStateAt = 0;
const chatHistory: { role: string; text: string }[] = [];
const activeEffects = new Map<string, ShaderEffectDefinition>();
const pendingEffects = new Map<string, ShaderEffectDefinition>();

const worker = new Worker(
  new URL("./render/render-worker.ts", import.meta.url),
  { type: "module" },
);
function send(command: WorkerCommand, transfer: Transferable[] = []): void {
  worker.postMessage(command, transfer);
}

const offscreen = canvas.transferControlToOffscreen();
send({ type: "init", canvas: offscreen }, [offscreen]);

function formatTime(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "0:00";
  const seconds = Math.max(0, Math.floor(value));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}
function setControlsEnabled(enabled: boolean): void {
  playPauseBtn!.disabled = !enabled;
  timeline!.disabled = !enabled;
}
function publishBrowserState(state: PlayerState): void {
  const now = performance.now();
  if (now - lastBridgeStateAt < 250 && state.phase === "playing") return;
  lastBridgeStateAt = now;
  void fetch("/api/browser/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state: { ...state, activeClipId, clipHash: activeClip()?.hash },
    }),
  }).catch(() => undefined);
}
function addChatMessage(role: "user" | "agent", text: string): void {
  chatHistory.push({ role, text });
  const node = document.createElement("div");
  node.className = "message " + role;
  node.textContent = text;
  chatLog!.append(node);
  chatLog!.scrollTop = chatLog!.scrollHeight;
  if (role === "agent") {
    // Muse's answer belongs over the video, not buried in a transcript.
    // Muse opens with a bold "Done" header: useful in a
    // transcript, noise on one line over the frame.
    const line = text
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(done|ok|all set)\s*[.:–-]?\s*/i, "");
    replyLine!.textContent = line;
    replyLine!.classList.toggle("show", line.length > 0);
  }
}
function renderEffects(): void {
  document.body.dataset.effectCount = String(activeEffects.size);
  document.body.dataset.effectNames = [...activeEffects.values()]
    .map((e) => e.name)
    .join("|");
}
function loadFile(file: File): void {
  clearSelection();
  send({ type: "clearMaskTrack" });
  exportStatus!.textContent = "";
  errorText!.textContent = "";
  currentFile = file;
  send({ type: "load", file });
  void registerClip(file);
}
function connectBridge(): void {
  const events = new EventSource("/api/events");
  events.addEventListener("hello", (event) => {
    if (currentState) publishBrowserState(currentState);
    agentStatus!.textContent = "Listening";
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        effects?: ShaderEffectDefinition[];
        supervisorWorking?: boolean;
      };
      supervisorWorking = Boolean(payload.supervisorWorking);
      updateWorking();
      for (const effect of payload.effects || []) {
        const requestId = "restore-" + effect.id;
        pendingEffects.set(requestId, effect);
        send({ type: "upsertEffect", requestId, effect });
      }
    } catch {
      /* hello is informational */
    }
  });
  events.addEventListener("supervisor", (event) => {
    const progress = JSON.parse((event as MessageEvent<string>).data) as {
      working: boolean;
      phase?: string;
    };
    supervisorWorking = Boolean(progress.working);
    updateWorking();
    agentStatus!.textContent = supervisorWorking
      ? (progress.phase || "Muse is working on the video") + "…"
      : "Listening";
    // Every tool the agent calls reaches us here. Lay them out as they
    // arrive instead of overwriting one line, so the wait has a shape.
    // updateWorking opens and closes the trail; this only adds to it.
    if (supervisorWorking)
      trail.step(progress.phase || "Muse is working on the video");
  });
  events.addEventListener("assistant-action", (event) => {
    const p = JSON.parse((event as MessageEvent<string>).data);
    actionWorking = Boolean(p.working);
    updateWorking();
    agentStatus!.textContent = p.working ? p.phase + "…" : "Listening";
  });
  events.addEventListener("assistant-ack", (event) => {
    replyLine!.textContent = JSON.parse(
      (event as MessageEvent<string>).data,
    ).reply;
  });
  events.addEventListener("generation", () => {
    void refreshGenerations();
  });
  events.addEventListener("assistant-result", (event) => {
    const p = JSON.parse((event as MessageEvent<string>).data);
    addChatMessage("agent", p.reply);
    if (p.error) errorText!.textContent = p.reply;
    setUiState(p.error ? "error" : "done");
  });
  events.addEventListener("selection-preview", (event) =>
    showSelection(JSON.parse((event as MessageEvent<string>).data)),
  );
  events.addEventListener("selection-clear", clearSelection);
  events.addEventListener("effect-apply", (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as {
      requestId: string;
      effect: ShaderEffectDefinition;
      dryRun?: boolean;
    };
    pendingEffects.set(payload.requestId, payload.effect);
    agentStatus!.textContent = "Preparing the effect…";
    // The shader Muse just wrote, shown for a beat as it lands.
    if (!payload.dryRun && payload.effect.code) trail.code(payload.effect.code);
    send({
      type: "upsertEffect",
      requestId: payload.requestId,
      effect: payload.effect,
      dryRun: payload.dryRun ?? false,
    });
  });
  events.addEventListener("effect-remove", (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as {
      id: string;
    };
    activeEffects.delete(payload.id);
    exportStatus!.textContent = "";
    send({ type: "removeEffect", effectId: payload.id });
    renderEffects();
  });
  events.addEventListener("effect-clear", () => {
    activeEffects.clear();
    exportStatus!.textContent = "";
    send({ type: "clearEffects" });
    renderEffects();
  });
  events.addEventListener("gen-upload-request", (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as {
      requestId: string;
      jobId: string;
    };
    if (!currentFile) return;
    void fetch("/api/gen/upload", {
      method: "POST",
      headers: {
        "Content-Type": currentFile.type || "video/mp4",
        "x-request-id": payload.requestId,
        "x-file-name": currentFile.name,
      },
      body: currentFile,
    }).catch(() => undefined);
  });
  events.addEventListener("mask-track", (event) => {
    const track = JSON.parse(
      (event as MessageEvent<string>).data,
    ) as SamTrackPayload;
    forwardMaskTrack(track);
  });
  events.addEventListener("project", (event) => {
    try {
      exportStatus!.textContent = "";
      const next = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as ProjectPayload;
      renderProject(next);
      const clip = activeClip();
      if (
        clip &&
        currentState &&
        (currentState.mediaTime < clip.in || currentState.mediaTime >= clip.out)
      )
        send({ type: "seek", time: clip.in });
      else if (activeClipId && !clip && next.clips.length)
        previewClip(next.clips[0].id, false);
    } catch {
      /* project events are informational */
    }
  });
  events.addEventListener("frame-request", (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as {
      requestId: string;
      time?: number | null;
    };
    if (typeof payload.time === "number")
      send({ type: "seek", time: payload.time });
    setTimeout(
      () => send({ type: "captureFrame", requestId: payload.requestId }),
      typeof payload.time === "number" ? 500 : 0,
    );
  });
  events.addEventListener("export-render-request", (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as {
      requestId: string;
      bitrate: number;
    };
    const clip = activeClip();
    if (!clip) {
      void postRenderResult(
        payload.requestId,
        false,
        "No clip is loaded in the editor",
        "",
        0,
        null,
      );
      return;
    }
    renderingClipId = clip.id;
    exportStatus!.textContent = "Preparing the export…";
    send({
      type: "exportRange",
      requestId: payload.requestId,
      start: clip.in,
      end: clip.out,
      bitrate: payload.bitrate,
    });
  });
  events.addEventListener("playback", (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as {
      action?: string;
      time?: number;
      requestId?: string;
      clipId?: string;
    };
    void (async () => {
      let ok = true,
        message = "";
      try {
        if (payload.clipId && payload.clipId !== activeClipId)
          throw new Error("The open clip has changed.");
        if (!currentState?.fileName) throw new Error("No video is open.");
        if (payload.action === "play" || payload.action === "pause") {
          const action = payload.action;
          const already =
            action === "play"
              ? currentState.phase === "playing"
              : currentState.phase === "paused";
          const ready = already
            ? Promise.resolve()
            : waitForPlayer((s) =>
                action === "play"
                  ? s.phase === "playing"
                  : s.phase === "paused",
              );
          send({ type: action });
          await ready;
        } else if (
          payload.action === "seek" &&
          typeof payload.time === "number"
        ) {
          const time = payload.time;
          const ready = waitForPlayer(
            (s) =>
              s.phase === "paused" &&
              Math.abs(s.mediaTime - time) <
                Math.max(0.1, 1 / (s.frameRate || 24)),
          );
          send({ type: "seek", time });
          await ready;
        } else throw new Error("Commande de lecture invalide.");
      } catch (error) {
        ok = false;
        message = error instanceof Error ? error.message : String(error);
      }
      if (payload.requestId)
        await fetch("/api/playback/result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: payload.requestId, ok, message }),
        });
    })();
  });
  events.addEventListener("error", () => {
    agentStatus!.textContent = "Reconnecting…";
  });
}
function renderState(state: PlayerState): void {
  currentState = state;
  updateCaptionOverlay(state.mediaTime);
  advanceIfNeeded(state);
  publishBrowserState(state);
  document.body.dataset.phase = state.phase;
  document.body.dataset.frameTimestamp =
    state.frameTimestamp === null ? "" : String(state.frameTimestamp);
  document.body.dataset.mediaTime = String(state.mediaTime);
  emptyState!.classList.toggle("hidden", Boolean(state.fileName));
  const ready = ["ready", "playing", "paused", "ended"].includes(state.phase);
  setControlsEnabled(ready);
  const playing = state.phase === "playing";
  playPauseBtn!.setAttribute("aria-label", playing ? "Pause" : "Lire");
  playPauseBtn!.title = playing ? "Pause" : "Lire";
  playIcon.setAttribute(
    "d",
    playing ? "M7 5h4v14H7Zm7 0h4v14h-4Z" : "m9 5 11 7-11 7Z",
  );
  clipTitle.textContent = state.fileName?.startsWith("generated:")
    ? "Nouvelle version"
    : state.fileName || "Your video";
  currentTime.textContent = formatTime(state.mediaTime);
  durationTime.textContent = formatTime(state.duration);
  const clip = activeClip();
  timeline!.min = String(clip?.in || 0);
  timeline!.max = String(clip?.out || state.duration);
  if (!scrubbing) timeline!.value = String(state.mediaTime);
  const min = Number(timeline!.min),
    max = Number(timeline!.max);
  timeline!.style.setProperty(
    "--progress",
    Math.min(
      100,
      Math.max(0, ((state.mediaTime - min) / Math.max(0.01, max - min)) * 100),
    ) + "%",
  );
  drawSelection(state);
  // Keep action/provider errors visible until the next explicit request.
}

worker.addEventListener("message", (event: MessageEvent<WorkerEvent>) => {
  const data = event.data;
  if (data.type === "state") renderState(data.state);
  if (data.type === "effectResult") {
    const effect = pendingEffects.get(data.result.requestId);
    pendingEffects.delete(data.result.requestId);
    if (data.result.ok && data.result.dryRun) {
      agentStatus!.textContent = "Effect verified";
    } else if (data.result.ok && effect) {
      clearSelection();
      exportStatus!.textContent = "";
      activeEffects.set(effect.id, effect);
      renderEffects();
      agentStatus!.textContent = "Effect applied";
    } else if (!data.result.ok) {
      agentStatus!.textContent = "Muse is adjusting the effect…";
      console.warn("Shader rejected", data.result.errors);
    }
    void fetch("/api/effects/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data.result),
    }).catch(() => undefined);
  }
  if (data.type === "frameResult") {
    const r = data.result;
    let pngB64: string | null = null;
    if (r.png) {
      const bytes = new Uint8Array(r.png);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      pngB64 = btoa(binary);
    }
    void fetch("/api/frame/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: r.requestId,
        ok: r.ok,
        message: r.message,
        mediaTime: r.mediaTime,
        width: r.width,
        height: r.height,
        pngB64,
      }),
    }).catch(() => undefined);
  }
  if (data.type === "exportResult") {
    const r = data.result;
    void postRenderResult(
      r.requestId,
      r.ok,
      r.message,
      renderingClipId ?? "",
      r.frames,
      r.mp4,
    );
    renderingClipId = null;
  }
  if (data.type === "error") {
    errorText!.textContent = data.message;
  }
});
connectBridge();

// Hosted transformations outlive the editing LLM turn. Keep the mascot busy until the actual job finishes, and surface provider failures.
const watchedGenerations = new Map<string, string>();
let checkingGenerations = false;
async function refreshGenerations(): Promise<void> {
  if (checkingGenerations) return;
  checkingGenerations = true;
  try {
    const response = await fetch("/api/state", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return;
    const data = (await response.json()) as {
      genJobs?: { id: string; state: string; error?: string }[];
    };
    const jobs = data.genJobs || [];
    const wasWorking = generationWorking;
    generationWorking = jobs.some((job) =>
      ["preparing", "queued", "running"].includes(job.state),
    );
    updateWorking();
    if (generationWorking && !supervisorWorking && !voiceWorking)
      agentStatus!.textContent = "Transforming the video…";
    else if (
      wasWorking &&
      !generationWorking &&
      !supervisorWorking &&
      !voiceWorking
    )
      agentStatus!.textContent = "Listening";
    for (const job of jobs) {
      const previous = watchedGenerations.get(job.id);
      watchedGenerations.set(job.id, job.state);
      if (
        previous === job.state ||
        (previous && ["done", "failed"].includes(previous))
      )
        continue;
      if (job.state === "done") {
        // The result endpoint registers the generated clip in the project.
        const result = await fetch(
          "/api/gen/jobs/" + encodeURIComponent(job.id),
        );
        if (result.ok) {
          const ready = (await result.json()) as { clipId?: string };
          if (previous && ready.clipId) {
            // Import may race the project SSE. Refresh before opening the result.
            const latest = (await (await fetch("/api/project")).json()) as {
              project: ProjectPayload;
            };
            renderProject(latest.project);
            await loadProjectClip(ready.clipId, false);
            const clip = activeClip();
            if (clip)
              send({
                type: "seek",
                time: Math.min(clip.out - 0.05, clip.in + 0.5),
              });
          }
          addChatMessage("agent", "Here is the new version.");
        } else watchedGenerations.delete(job.id); // retry a temporary import failure
      } else if (job.state === "failed") {
        errorText!.textContent = job.error || "The transformation failed.";
        addChatMessage(
          "agent",
          "The transformation failed. Ask me to try again.",
        );
      }
    }
  } catch {
    /* The SSE connection owns connection-error messages. */
  } finally {
    checkingGenerations = false;
  }
}
void refreshGenerations();
const generationTimer = setInterval(() => {
  void refreshGenerations();
}, 2000);
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) {
    clearInterval(generationTimer);
    muse.dispose();
  }
});
renderEffects();
worker.addEventListener("error", (event) => {
  errorText.textContent = event.message || "Render worker failed";
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
});
for (const eventName of ["dragenter", "dragover"]) {
  stage.addEventListener(eventName, (event) => {
    event.preventDefault();
    stage.classList.add("drag-over");
    dropHint.classList.remove("hidden");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  stage.addEventListener(eventName, (event) => {
    event.preventDefault();
    stage.classList.remove("drag-over");
    dropHint.classList.add("hidden");
  });
}
stage.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) loadFile(file);
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());
playPauseBtn.addEventListener("click", () => {
  cancelSelection();
  send({ type: currentState?.phase === "playing" ? "pause" : "play" });
});
function seekFromInputs(value: number): void {
  if (!Number.isFinite(value)) return;
  cancelSelection();
  send({ type: "seek", time: Math.max(0, value) });
}
timeline.addEventListener("pointerdown", () => {
  scrubbing = true;
});
timeline.addEventListener("pointerup", () => {
  scrubbing = false;
});
timeline.addEventListener("change", () => {
  scrubbing = false;
  seekFromInputs(Number(timeline.value));
});
undoBtn.addEventListener("click", () => {
  void editOp("undo").catch((error: unknown) => {
    errorText!.textContent =
      error instanceof Error ? error.message : String(error);
  });
});
redoBtn.addEventListener("click", () => {
  void editOp("redo").catch((error: unknown) => {
    errorText!.textContent =
      error instanceof Error ? error.message : String(error);
  });
});
exportBtn.addEventListener("click", () => {
  exportBtn.disabled = true;
  exportStatus.textContent = "Exporting…";
  void fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preset: exportPreset.value }),
  })
    .then(async (response) => {
      const payload = (await response.json()) as {
        ok?: boolean;
        url?: string;
        srtFile?: string;
        message?: string;
      };
      if (!response.ok || !payload.ok || !payload.url)
        throw new Error(payload.message || "Export failed");
      const link = document.createElement("a");
      link.href = payload.url;
      link.textContent = "Download the MP4";
      exportStatus.replaceChildren(link);
      if (payload.srtFile) {
        const srtLink = document.createElement("a");
        srtLink.href =
          "/api/export/file?name=" + encodeURIComponent(payload.srtFile);
        srtLink.textContent = "SRT";
        exportStatus.append(" · ", srtLink);
      }
    })
    .catch((error: unknown) => {
      exportStatus.textContent =
        error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      exportBtn.disabled = false;
    });
});
void fetch("/api/project")
  .then(async (response) => {
    const payload = (await response.json()) as { project?: ProjectPayload };
    if (payload.project) {
      renderProject(payload.project);
      if (!currentFile && payload.project.clips.length)
        previewClip(payload.project.clips[0].id, false);
    }
  })
  .catch(() => undefined);
// Push-to-talk fallback (SPEC §4): hold Talk, speak, release. The preview
// pauses while recording; the transcript and the agent reply appear as
// lines under the video and the confirmation is spoken back.
let mediaRecorder: MediaRecorder | null = null;
let voiceChunks: Blob[] = [];
const talkLabel = pttBtn;

/** Raw sample deviation below which a recording is silence, not quiet
 *  speech. A live but dead input (a wireless headset that is switched off
 *  enumerates and opens fine) reads 0; a quiet room still reads several. */
const SILENCE_PEAK = 3;

/** Feeds the mic envelope to the button rings and the mascot, and remembers
 *  the loudest sample so the caller can tell silence from speech. */
function meterStream(
  stream: MediaStream,
  onLevel: (level: number) => void = setMicLevel,
): { stop: () => void; peak: () => number } {
  const audio = new AudioContext();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 512;
  audio.createMediaStreamSource(stream).connect(analyser);
  const bins = new Uint8Array(analyser.frequencyBinCount);
  let raf = 0;
  let loudest = 0;
  const tick = (): void => {
    raf = requestAnimationFrame(tick);
    analyser.getByteTimeDomainData(bins);
    let peak = 0;
    for (const v of bins) peak = Math.max(peak, Math.abs(v - 128));
    if (peak > loudest) loudest = peak;
    onLevel(Math.min(1, (peak / 128) * 2.2));
  };
  tick();
  return {
    stop: () => {
      cancelAnimationFrame(raf);
      void audio.close();
      onLevel(0);
    },
    peak: () => loudest,
  };
}

// Which microphone to record from. Browsers keep their own ranking of
// inputs and do not necessarily follow the system default -- Edge will
// hand every page a headset it ranks above "default", even one that is
// switched off and streams silence. So let the choice be explicit.
const MIC_KEY = "shouldercut.micDeviceId";

async function refreshMics(): Promise<void> {
  let devices: MediaDeviceInfo[] = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }
  const inputs = devices.filter(
    (d) => d.kind === "audioinput" && d.deviceId !== "communications",
  );
  if (inputs.length < 2) {
    micSelect!.classList.add("hidden");
    return;
  }
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(MIC_KEY);
  } catch {
    saved = null;
  }
  micSelect!.replaceChildren();
  for (const input of inputs) {
    const option = document.createElement("option");
    option.value = input.deviceId;
    // Labels stay empty until the page has been granted the microphone once.
    option.textContent =
      input.label || "Microphone " + input.deviceId.slice(0, 6);
    if (input.deviceId === saved) option.selected = true;
    micSelect!.append(option);
  }
  micSelect!.classList.remove("hidden");
}

micSelect.addEventListener("change", () => {
  try {
    localStorage.setItem(MIC_KEY, micSelect!.value);
  } catch {
    /* private window */
  }
  voiceStatus!.textContent =
    "Micro : " + (micSelect!.selectedOptions[0]?.textContent || "");
});
void refreshMics();
navigator.mediaDevices.addEventListener?.(
  "devicechange",
  () => void refreshMics(),
);

function micConstraint(): MediaStreamConstraints {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(MIC_KEY);
  } catch {
    saved = null;
  }
  return saved ? { audio: { deviceId: { exact: saved } } } : { audio: true };
}

pttBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  pttBtn.disabled = true;
  voiceBtn.disabled = true;
  micSelect.disabled = true;
  const unlock = (): void => {
    pttBtn.disabled = false;
    voiceBtn.disabled = false;
    micSelect.disabled = false;
  };
  void navigator.mediaDevices
    .getUserMedia(micConstraint())
    .then((stream) => {
      // Labels only become readable once permission has been granted.
      void refreshMics();
      voiceChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      const meter = meterStream(stream);
      // Name the input. A machine with several microphones hands
      // getUserMedia the system default, which is not always the one the
      // person is talking into.
      const device = stream.getAudioTracks()[0]?.label || "microphone";
      send({ type: "pause" });
      setUiState("listening");
      mediaRecorder.addEventListener("stop", () => meter.stop(), {
        once: true,
      });
      mediaRecorder.addEventListener("dataavailable", (e) => {
        if (e.data.size) voiceChunks.push(e.data);
      });
      mediaRecorder.addEventListener("stop", () => {
        stream.getTracks().forEach((t) => t.stop());
        if (talkLabel)
          talkLabel.textContent = "Enregistrer une seule instruction";
        pttBtn.disabled = true;
        // Never pay for transcribing silence, and say which input was dead:
        // a switched-off wireless headset still opens and streams zeros.
        if (meter.peak() < SILENCE_PEAK) {
          voiceStatus.textContent =
            "Nothing heard on " +
            device +
            ". Check that microphone, or change the Windows default input.";
          setUiState("error");
          unlock();
          return;
        }
        setUiState("thinking");
        const blob = new Blob(voiceChunks, {
          type: mediaRecorder?.mimeType || "audio/webm",
        });
        voiceStatus.textContent = "Transcribing…";
        void blob
          .arrayBuffer()
          .then((buffer) => {
            const bytes = new Uint8Array(buffer);
            let binary = "";
            for (let i = 0; i < bytes.length; i += 0x8000)
              binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return fetch("/api/voice/command", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                audioB64: btoa(binary),
                history: chatHistory.slice(),
              }),
            });
          })
          .then(async (response) => {
            const payload = (await response.json()) as {
              ok?: boolean;
              transcript?: string;
              reply?: string;
              editing?: boolean;
              message?: string;
              effects?: ShaderEffectDefinition[];
            };
            if (!response.ok || !payload.ok)
              throw new Error(payload.message || "Voice command failed");
            addChatMessage("user", payload.transcript || "(voice)");
            if (Array.isArray(payload.effects)) {
              activeEffects.clear();
              for (const effect of payload.effects)
                activeEffects.set(effect.id, effect);
              renderEffects();
            }
            const reply = payload.reply || "Done.";
            addChatMessage("agent", reply);
            voiceStatus.textContent = "Vous : " + (payload.transcript || "");
            setUiState("done");
            const spoken = reply.split(/(?<=[.!?])\s/)[0].slice(0, 180);
            if (spoken && "speechSynthesis" in window) {
              window.speechSynthesis.cancel();
              window.speechSynthesis.speak(
                new SpeechSynthesisUtterance(spoken),
              );
            }
          })
          .catch((error: unknown) => {
            voiceStatus.textContent =
              error instanceof Error ? error.message : String(error);
            setUiState("error");
          })
          .finally(unlock);
      });
      mediaRecorder.start();
      pttBtn.disabled = false;
      if (talkLabel) talkLabel.textContent = "Stop recording";
      voiceStatus.textContent =
        "Listening on " + device + "… click to stop.";
    })
    .catch((error: unknown) => {
      voiceStatus.textContent =
        "Microphone indisponible : " +
        (error instanceof Error ? error.message : String(error));
      setUiState("error");
      unlock();
    });
});
setupRealtimeVoice({
  button: voiceBtn,
  fallback: pttBtn,
  selector: micSelect,
  status: voiceStatus,
  history: () => chatHistory.slice(),
  mic: micConstraint,
  meter: meterStream,
  outputMeter: (stream) =>
    meterStream(stream, (level) => {
      if (document.body.dataset.ui === "speaking") muse.setLevel(level);
    }),
  working: (working) => {
    voiceWorking = working;
    updateWorking();
  },
  refreshMics,
  state: setUiState,
  message: addChatMessage,
  pause: () => send({ type: "pause" }),
});
// You can always say the next thing, including over an instruction that is
// still running: Muse is interruptible, so nothing waits on the previous
// round trip. Clearing the field is what stops a double Enter from sending
// twice; the button used to stay dead for the whole wait, which could be
// seventeen seconds of being unable to correct yourself.
let chatPending = 0;
chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  chatInput.value = "";
  addChatMessage("user", message);
  chatPending += 1;
  chatWorking = true;
  updateWorking();
  errorText.textContent = "";
  agentStatus.textContent = "Listening…";
  void fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history: chatHistory.slice(0, -1) }),
  })
    .then(async (response) => {
      const payload = (await response.json()) as {
        ok?: boolean;
        reply?: string;
        editing?: boolean;
        message?: string;
        effects?: ShaderEffectDefinition[];
      };
      if (!response.ok || !payload.ok)
        throw new Error(payload.message || "Agent request failed");
      if (Array.isArray(payload.effects)) {
        activeEffects.clear();
        for (const effect of payload.effects)
          activeEffects.set(effect.id, effect);
        renderEffects();
      }
      addChatMessage("agent", payload.reply || "Done.");
      agentStatus.textContent = payload.editing
        ? "Editing…"
        : "Listening";
      setUiState("done");
    })
    .catch((error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      addChatMessage("agent", text);
      agentStatus.textContent = "Le montage demande votre attention";
      errorText.textContent = text;
      setUiState("error");
    })
    .finally(() => {
      chatPending -= 1;
      chatWorking = chatPending > 0;
      updateWorking();
      chatInput.focus();
    });
});
