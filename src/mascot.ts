// Muse, drawn rather than modelled.
//
// She used to be a generated 3D mesh of Meta's Jolly. Photoreal plush fur
// next to a video editor reads as a product shot dropped into the UI: the
// eye treats it as a thing, not as a presence. Flat shapes and motion carry
// the same character at a tenth of the weight, and they can say what she is
// doing -- turning to you, waving, head down and typing -- which a static
// mesh could only hint at by leaning. Dropping it also drops three.js and
// a 4 MB asset from the page.
//
// Everything is drawn from paths at runtime: no sprite sheet, no model, no
// file to ship.

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

const SHELL = "#ece1cf";
const SHELL_SHADE = "#d8c9b0";
const FACE = "#fdf7ec";
const INK = "#20242c";
const BLUSH = "rgba(238, 150, 140, 0.55)";

const ACCENT: Record<MascotState, string> = {
  idle: "#6ee7b7",
  listening: "#f87171",
  speaking: "#287bff",
  thinking: "#818cf8",
  done: "#3ddc97",
  error: "#f59e0b",
};

/** Design space; the canvas scales to fit whatever box the layout gives. */
const W = 120;
const H = 132;

function ease(from: number, to: number, rate: number): number {
  return from + (to - from) * rate;
}

export function createMascot(canvas: HTMLCanvasElement): Mascot {
  const ctx = canvas.getContext("2d")!;
  let state: MascotState = "idle";
  let working = false;
  let level = 0;
  let smoothLevel = 0;

  // Pose, all eased towards their targets so nothing snaps.
  let turn = 0; // -1 looking left, +1 right
  let lean = 0; // forward lean, 0..1
  let armL = 0; // 0 resting, 1 raised
  let armR = 0;
  let targetTurn = 0;
  let nextGlance = 0;
  let waveUntil = 0;
  let blinkUntil = 0;
  let nextBlink = 1.6;
  let enteredAt = 0;
  let raf = 0;
  const start = performance.now() / 1000;

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

  /** A rounded hood: one dome over a wider body, drawn as a single path. */
  function silhouette(): void {
    ctx.beginPath();
    ctx.moveTo(18, 120);
    ctx.bezierCurveTo(10, 86, 14, 44, 44, 30);
    ctx.bezierCurveTo(56, 24, 70, 24, 82, 31);
    ctx.bezierCurveTo(110, 46, 113, 87, 105, 120);
    ctx.bezierCurveTo(88, 127, 36, 127, 18, 120);
    ctx.closePath();
  }

  function draw(t: number): void {
    const since = t - enteredAt;
    resize();
    const dpr = canvas.width / W;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    smoothLevel = ease(smoothLevel, level, 0.25);

    // --- what the pose should be ------------------------------------
    let wantLean = 0;
    if (state === "listening") {
      targetTurn = Math.sin(t * 1.5) * 0.06;
      wantLean = 0.5 + smoothLevel * 0.3;
    } else if (state === "speaking") {
      targetTurn = Math.sin(t * 1.1) * 0.08;
      wantLean = 0.25;
    } else if (state === "thinking" || working) {
      // Head down over the work, turned a little away: busy, not watching.
      targetTurn = -0.45 + Math.sin(t * 2.2) * 0.08;
      wantLean = 1;
    } else if (state === "done") {
      targetTurn = 0;
      wantLean = 0.1;
    } else {
      // Idle: look around, and wave now and then.
      if (t > nextGlance) {
        targetTurn = (Math.random() * 2 - 1) * 0.7;
        nextGlance = t + 1.4 + Math.random() * 2.4;
        if (Math.random() < 0.3) waveUntil = t + 1.6;
      }
      wantLean = 0;
    }
    turn = ease(turn, targetTurn, 0.08);
    lean = ease(lean, wantLean, 0.09);

    const busy = state === "thinking" || working;
    const waving = t < waveUntil && !busy;
    // While working the two hands alternate, so the tapping reads as hands
    // rather than as one shape moving.
    armL = ease(armL, busy ? 0.5 + Math.sin(t * 11) * 0.5 : 0, 0.3);
    armR = ease(
      armR,
      busy ? 0.5 + Math.sin(t * 11 + Math.PI) * 0.5 : waving ? 1 : 0,
      0.3,
    );

    const hop = state === "done" ? Math.max(0, Math.sin(since * 7)) * 7 : 0;
    const bob = Math.sin(t * (busy ? 3.2 : 1.6)) * 1.8;

    ctx.save();
    ctx.translate(0, -bob - hop);
    // Lean tips the whole figure forward from its feet.
    ctx.translate(W / 2, H);
    ctx.rotate(lean * 0.1 + turn * 0.04);
    ctx.translate(-W / 2, -H);

    // --- shadow ------------------------------------------------------
    ctx.globalAlpha = 0.18 - lean * 0.04;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(62, 126 + bob * 0.6, 30 - hop * 0.6, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Waving reaches up and out and passes behind the body; the working
    // hands stay low and close, and must be drawn IN FRONT or the body
    // hides them -- which is why "working" used to look like "idle".
    const arms = (): void => {
      ctx.strokeStyle = SHELL_SHADE;
      ctx.lineWidth = 13;
      ctx.lineCap = "round";
      for (const [side, raise] of [
        [-1, armL],
        [1, armR],
      ] as const) {
        const shoulderX = 62 + side * 24;
        // The tapping hands sit on the body's bottom edge: anywhere higher
        // and they are the same cream on cream, invisible against it.
        const [x, y] = busy
          ? [62 + side * 17, 119 + raise * 7]
          : [shoulderX + side * (3 + raise * 18), 97 - raise * 46];
        ctx.beginPath();
        ctx.moveTo(shoulderX, 92);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    };
    if (!busy) arms();

    // --- body --------------------------------------------------------
    silhouette();
    ctx.fillStyle = SHELL;
    ctx.fill();
    if (busy) arms();

    // --- face plate ---------------------------------------------------
    const faceX = 62 + turn * 15;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(faceX, 62 - lean * 5, 27 - Math.abs(turn) * 6, 29, 0, 0, Math.PI * 2);
    ctx.fillStyle = FACE;
    ctx.fill();
    ctx.clip();

    // eyes
    const blinking = t < blinkUntil;
    const squint = busy ? 0.42 : state === "done" ? 0.3 : 1;
    const open = blinking ? 0.08 : squint;
    ctx.fillStyle = INK;
    for (const side of [-1, 1] as const) {
      const ex = faceX + side * (9 - Math.abs(turn) * 2) + turn * 4;
      const ey = 58 - lean * 5 + (busy ? 4 : 0);
      ctx.beginPath();
      ctx.ellipse(ex, ey, 3.6, 4.4 * open, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // blush
    ctx.fillStyle = BLUSH;
    for (const side of [-1, 1] as const) {
      ctx.beginPath();
      ctx.ellipse(faceX + side * 18 + turn * 4, 69 - lean * 5, 5.5, 3.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // mouth: a small arc, opening with the voice while speaking
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.9;
    ctx.beginPath();
    const mouthY = 71 - lean * 5;
    if (state === "speaking" && smoothLevel > 0.05) {
      ctx.ellipse(faceX + turn * 4, mouthY, 3.4, 1.6 + smoothLevel * 3.4, 0, 0, Math.PI * 2);
    } else {
      ctx.arc(faceX + turn * 4, mouthY - 2.4, 4, 0.25 * Math.PI, 0.75 * Math.PI);
    }
    ctx.stroke();
    ctx.restore();

    // --- hood rim, drawn over the face so the opening reads ----------
    ctx.save();
    silhouette();
    ctx.clip();
    ctx.strokeStyle = SHELL;
    ctx.lineWidth = 13;
    ctx.beginPath();
    ctx.ellipse(faceX, 62 - lean * 5, 33 - Math.abs(turn) * 6, 35, 0, 0, Math.PI * 2);
    ctx.stroke();
    // A shaded inner edge is what separates hood from face at 120 px; the
    // two creams are too close to tell apart on their own.
    ctx.strokeStyle = SHELL_SHADE;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.ellipse(faceX, 62 - lean * 5, 27 - Math.abs(turn) * 6, 29, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();

    // --- what she is doing -------------------------------------------
    ctx.fillStyle = ACCENT[state];
    if (busy) {
      // Three ticks rising off the work: the visual of being mid-task.
      for (let i = 0; i < 3; i += 1) {
        const phase = (t * 1.5 + i * 0.33) % 1;
        ctx.globalAlpha = Math.sin(phase * Math.PI) * 0.75;
        ctx.beginPath();
        ctx.arc(96 + i * 7, 44 - phase * 22, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (state === "listening") {
      // A ring that breathes with the microphone.
      ctx.strokeStyle = ACCENT.listening;
      ctx.globalAlpha = 0.25 + smoothLevel * 0.55;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(62, 76, 48 + smoothLevel * 10, 54 + smoothLevel * 10, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    if (t > nextBlink && !busy) {
      blinkUntil = t + 0.12;
      nextBlink = t + 2.2 + Math.random() * 3.5;
    }
  }

  function frame(): void {
    raf = requestAnimationFrame(frame);
    draw(performance.now() / 1000 - start);
  }
  frame();

  return {
    setState(next) {
      if (next === state) return;
      state = next;
      enteredAt = performance.now() / 1000 - start;
      if (next === "idle") nextGlance = 0;
      // Greet whoever just turned up.
      if (next === "listening") waveUntil = 0;
      if (next === "done") waveUntil = enteredAt + 1.2;
    },
    setWorking(next) {
      working = next;
    },
    setLevel(next) {
      level = Math.min(1, Math.max(0, next));
    },
    dispose() {
      cancelAnimationFrame(raf);
    },
  };
}
