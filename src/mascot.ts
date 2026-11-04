// Jolly at her editing desk, played from sprite sheets.
//
// She used to be drawn from paths at runtime, and before that she was a
// generated 3D mesh. Both could only suggest what she was doing by leaning.
// These are 51 drawn poses in three atlases, nine sequences at 12 fps, so
// she can actually turn round, wave, nod, and go back to typing.
//
// The asset ships its own small state machine: every sequence declares the
// pose it starts in and the pose it ends in, and the only two poses are
// `poste` (at the desk, back to us) and `ecoute` (turned round, facing us).
// A sequence may only follow one whose end pose matches its start pose, so
// switching is never a cut -- `se_retourner` and `reprendre` are the two
// transitions that carry her between the poses.
//
// That maps onto the app's axes without flattening them. Which way she
// faces answers to the conversation; what her hands do answers to the work.
// Talking to her while she works turns her round without stopping the work:
// when you are done she goes back to the desk and picks the typing up again.

export type MascotState =
  | "idle"
  | "listening"
  | "speaking"
  | "thinking"
  | "done"
  | "error";

export interface Mascot {
  setState(state: MascotState): void;
  setWorking(working: boolean): void;
  /** Live microphone or speech level, 0..1. */
  setLevel(level: number): void;
  dispose(): void;
}

const ASSETS = "/assets/jolly/";

interface Sheet {
  image: string;
}
interface Cell {
  atlas: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Sequence {
  fps: number;
  loop: boolean;
  next?: string | null;
  startPose: string;
  endPose: string;
  frames: string[];
}
interface Manifest {
  frameSize: { width: number; height: number };
  layers: { id: string; type: string; image?: string }[];
  atlases: Record<string, Sheet>;
  frames: Record<string, Cell>;
  animations: Record<string, Sequence>;
  stateMachine: {
    initialAnimation: string;
    transitions: { from: string; to: string; animation: string }[];
  };
}

/** While she works at the desk, break the typing up now and then. */
const DESK_VARIETY = 4;

export function createMascot(canvas: HTMLCanvasElement): Mascot {
  const ctx = canvas.getContext("2d")!;
  let state: MascotState = "idle";
  let working = false;
  let level = 0;
  let smoothLevel = 0;
  let disposed = false;
  let raf = 0;

  let manifest: Manifest | null = null;
  let desk: HTMLImageElement | null = null;
  const sheets = new Map<string, HTMLImageElement>();

  let current = "repos";
  let frame = 0;
  let lastStep = 0;
  let loops = 0;
  // A one-shot she owes us as soon as she is in the right pose: a wave when
  // she first turns round, a nod or a look at the montage when work lands.
  let owed: string | null = null;

  const reduced = globalThis.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  )?.matches;

  /** Facing us answers to the conversation, never to the work. */
  function facing(): boolean {
    return (
      state === "listening" ||
      state === "speaking" ||
      state === "done" ||
      state === "error"
    );
  }

  /** The loop she settles into, once she is in the right pose. */
  function settled(): string {
    if (facing()) return "ecouter";
    if (!working) return "repos";
    // thinking survives only as an alias for work on the state axis.
    return loops % DESK_VARIETY === DESK_VARIETY - 1
      ? "parcourir_timeline"
      : "taper";
  }

  /**
   * What to play once the running sequence reaches its end.
   *
   * A sequence can only follow one it joins cleanly, so this either plays
   * what we want, or the transition that puts her in the pose it needs.
   */
  function pick(): string {
    const here = manifest!.animations[current].endPose;
    if (owed && manifest!.animations[owed]?.startPose === here) {
      const next = owed;
      owed = null;
      return next;
    }
    const want = settled();
    if (manifest!.animations[want].startPose === here) return want;
    const bridge = manifest!.stateMachine.transitions.find(
      (t) => t.from === here && t.to === manifest!.animations[want].startPose,
    );
    return bridge ? bridge.animation : current;
  }

  function play(id: string): void {
    if (id === current) return;
    current = id;
    frame = 0;
    loops = 0;
  }

  function step(now: number): void {
    const sequence = manifest!.animations[current];
    if (now - lastStep < 1000 / sequence.fps) return;
    lastStep = now;

    // A loop can be left on any frame. Waiting for its last one is what the
    // asset notes suggest, but `repos` runs 21 frames: measured, she took
    // up to 2.5s to so much as begin turning round, which reads as being
    // ignored. Every loop here sits in a single pose, so leaving it early
    // costs at most a frame of snap against a visibly dead pause.
    if (sequence.loop) {
      const early = pick();
      if (early !== current) {
        play(early);
        return;
      }
    }

    frame += 1;
    if (frame < sequence.frames.length) return;
    frame = 0;
    loops += 1;
    // A one-shot always plays out -- cutting the wave or the nod in half is
    // what makes a character look broken -- and then hands over to whatever
    // it declares as next if nothing better is waiting.
    const next = pick();
    if (next !== current) play(next);
    else if (!sequence.loop && sequence.next) play(sequence.next);
  }

  function draw(): void {
    const size = Math.min(canvas.width, canvas.height);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!manifest || !desk) return;
    // A breath on her voice: the sheets have no mouth shapes, so the level
    // moves the whole figure a little rather than pretending to lip-sync.
    const bob = state === "speaking" ? smoothLevel * size * 0.015 : 0;
    const x = (canvas.width - size) / 2;
    const y = (canvas.height - size) / 2 - bob;
    ctx.drawImage(desk, x, y, size, size);
    const cell = manifest.frames[manifest.animations[current].frames[frame]];
    const sheet = sheets.get(cell.atlas);
    if (!sheet) return;
    ctx.drawImage(
      sheet,
      cell.x,
      cell.y,
      cell.width,
      cell.height,
      x,
      y,
      size,
      size,
    );
  }

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function tick(now: number): void {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    resize();
    smoothLevel += (level - smoothLevel) * 0.25;
    if (manifest && !reduced) step(now);
    draw();
  }

  async function load(): Promise<void> {
    const response = await fetch(ASSETS + "jolly-animations.json");
    if (!response.ok)
      throw new Error("Jolly did not load (HTTP " + response.status + ").");
    const loaded = (await response.json()) as Manifest;

    async function image(file: string): Promise<HTMLImageElement> {
      const element = new Image();
      element.src = ASSETS + file;
      await element.decode();
      return element;
    }

    const still = loaded.layers.find((layer) => layer.id === "poste");
    const [deskImage, atlases] = await Promise.all([
      image(still!.image!),
      Promise.all(
        Object.entries(loaded.atlases).map(
          async ([id, atlas]) => [id, await image(atlas.image)] as const,
        ),
      ),
    ]);
    if (disposed) return;
    desk = deskImage;
    for (const [id, element] of atlases) sheets.set(id, element);
    current = loaded.stateMachine.initialAnimation;
    manifest = loaded;
  }

  void load().catch((error: unknown) => {
    // She is decoration: never take the editor down with her.
    console.warn("Mascot disabled:", error);
  });
  raf = requestAnimationFrame(tick);

  return {
    setState(next) {
      if (next === state) return;
      const wasFacing = facing();
      state = next;
      // Turning round to you is worth a wave; a result she can show you is
      // worth a nod, or a look back at the montage if she never turned.
      if (!wasFacing && facing() && next !== "done") owed = "saluer";
      if (next === "done") owed = facing() ? "acquiescer" : "verifier_montage";
    },
    setWorking(next) {
      working = next;
    },
    setLevel(next) {
      level = Math.min(1, Math.max(0, next));
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
    },
  };
}
