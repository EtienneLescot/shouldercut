// Muse, the little editor sitting over your shoulder: Meta's Muse mascot,
// modelled after the plush — cream fur, hooded head, dot eyes, blushed
// cheeks — as the agent's on-screen presence.
//
// Built from Three.js primitives on purpose: no model file to ship, no
// loader, no asset pipeline. Everything it does is driven by one state
// string and one audio level, so the UI only has to say what is happening.
import {
  AmbientLight,
  CanvasTexture,
  CapsuleGeometry,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
  RepeatWrapping,
  Scene,
  SphereGeometry,
  TorusGeometry,
  WebGLRenderer,
} from 'three';

export type MascotState = 'idle' | 'listening' | 'thinking' | 'done' | 'error';

export interface Mascot {
  setState(state: MascotState): void;
  /** Live microphone level, 0..1, used while listening. */
  setLevel(level: number): void;
  dispose(): void;
}

/** The accent only ever touches the light around Muse — the fur stays cream. */
const ACCENT: Record<MascotState, number> = {
  idle: 0x6ee7b7,
  listening: 0xf87171,
  thinking: 0x818cf8,
  done: 0x4ade80,
  error: 0xf59e0b,
};

const FUR = 0xdfd0b8;
const FACE = 0xfdf6ea;
const BLUSH = 0xef9f96;

/** Fine noise, used as a bump map: enough to read as fur, not as plastic. */
function furTexture(): CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 140 + Math.random() * 115;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(c);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(7, 7);
  return tex;
}

export function createMascot(canvas: HTMLCanvasElement): Mascot {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  // Framed so the top of the hood and the feet both clear the canvas edges,
  // including the idle bob.
  const camera = new PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, -0.3, 7);
  camera.lookAt(0, -0.3, 0);

  const body = new Group();
  scene.add(body);

  const bump = furTexture();
  const fur = new MeshStandardMaterial({ color: FUR, roughness: 0.96, metalness: 0, bumpMap: bump, bumpScale: 0.035 });
  const faceMat = new MeshStandardMaterial({ color: FACE, roughness: 0.78, metalness: 0 });
  const inkMat = new MeshStandardMaterial({ color: 0x1a1613, roughness: 0.35, metalness: 0 });
  const blushMat = new MeshStandardMaterial({ color: BLUSH, roughness: 0.9, metalness: 0, transparent: true, opacity: 0.62 });

  // Torso: a heavy pear, wider at the bottom. Overlaps the hood so the
  // silhouette stays one continuous plush mass.
  const torso = new Mesh(new SphereGeometry(1.16, 40, 30), fur);
  torso.position.y = -0.98;
  torso.scale.set(1, 0.97, 0.9);
  body.add(torso);

  for (const side of [-1, 1]) {
    const arm = new Mesh(new CapsuleGeometry(0.23, 0.56, 6, 16), fur);
    arm.position.set(side * 1.02, -1.04, 0.1);
    arm.rotation.z = side * 0.15;
    arm.scale.set(1, 1, 0.85);
    body.add(arm);

    const leg = new Mesh(new CapsuleGeometry(0.27, 0.3, 6, 16), fur);
    leg.position.set(side * 0.38, -2.16, 0.04);
    leg.scale.set(1, 1, 0.9);
    body.add(leg);
  }

  // Head group: the hood and the face turn together.
  const head = new Group();
  head.position.y = 0.42;
  body.add(head);

  const hood = new Mesh(new SphereGeometry(0.97, 40, 30), fur);
  hood.scale.set(1, 1.04, 0.95);
  head.add(hood);

  // Face: a soft panel bulging out of the hood opening.
  const face = new Mesh(new SphereGeometry(0.82, 36, 28), faceMat);
  face.scale.set(0.72, 0.82, 0.5);
  face.position.set(0, 0.03, 0.52);
  head.add(face);

  // Hood rim. Without it the face/hood intersection is a ragged line that
  // slides around as the head turns; the ring covers that seam and is what
  // actually reads as a hood.
  const rim2 = new Mesh(new TorusGeometry(0.62, 0.13, 12, 44), fur);
  rim2.position.set(0, 0.03, 0.64);
  rim2.scale.set(0.96, 1.08, 1);
  head.add(rim2);

  const eyes: Mesh[] = [];
  for (const side of [-1, 1]) {
    const eye = new Mesh(new SphereGeometry(0.104, 22, 18), inkMat);
    eye.position.set(side * 0.27, 0.08, 0.93);
    eye.scale.set(1, 1.18, 0.55);
    head.add(eye);
    eyes.push(eye);

    const blush = new Mesh(new SphereGeometry(0.15, 20, 16), blushMat);
    blush.position.set(side * 0.48, -0.11, 0.85);
    blush.scale.set(1.1, 0.72, 0.22);
    head.add(blush);
  }

  // Mouth: a half-torus flipped into a smile.
  const mouth = new Mesh(new TorusGeometry(0.1, 0.021, 10, 24, Math.PI), inkMat);
  mouth.position.set(0, -0.1, 0.95);
  mouth.rotation.z = Math.PI;
  mouth.scale.set(1, 0.85, 0.6);
  head.add(mouth);

  scene.add(new AmbientLight(0xffffff, 1.05));
  const key = new DirectionalLight(0xfff6e8, 1.45);
  key.position.set(2.2, 3.2, 4);
  scene.add(key);
  const fill = new DirectionalLight(0xdfe6ff, 0.45);
  fill.position.set(-3, 0.5, 2);
  scene.add(fill);
  // The only coloured light: this is where the UI state shows on Muse.
  const rim = new PointLight(ACCENT.idle, 16, 15);
  rim.position.set(-2.3, 0.9, -1.8);
  scene.add(rim);

  let state: MascotState = 'idle';
  let level = 0;
  let smoothedLevel = 0;
  let yaw = 0;
  let pitch = 0;
  let targetYaw = 0;
  let targetPitch = 0;
  let nextGlance = 0;
  let stateEnteredAt = 0;
  let blinkUntil = 0;
  let nextBlink = 1.5;
  let raf = 0;
  const accent = new Color(ACCENT.idle);
  const clock = { start: performance.now() / 1000 };

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  function pickGlance(t: number): void {
    // Idle: look around the way someone waiting for an instruction does —
    // wide turns held for a beat, but never so far that the eyes leave the
    // frame and Muse reads as asleep.
    targetYaw = (Math.random() * 2 - 1) * 0.55;
    targetPitch = (Math.random() * 2 - 1) * 0.18;
    nextGlance = t + 1.1 + Math.random() * 1.9;
  }

  function frame(): void {
    raf = requestAnimationFrame(frame);
    resize();
    const t = performance.now() / 1000 - clock.start;
    const since = t - stateEnteredAt;

    smoothedLevel += (level - smoothedLevel) * 0.25;

    if (state === 'idle') {
      if (t > nextGlance) pickGlance(t);
    } else if (state === 'listening') {
      // Locked on whoever is talking, with a small attentive drift.
      targetYaw = Math.sin(t * 1.6) * 0.06;
      targetPitch = -0.06 + Math.sin(t * 2.3) * 0.03;
    } else if (state === 'thinking') {
      // Head down over the work, scanning left to right across the frame.
      targetYaw = Math.sin(t * 2.4) * 0.26;
      targetPitch = 0.3;
    } else {
      targetYaw = 0;
      targetPitch = state === 'done' ? -0.12 + Math.sin(since * 9) * 0.15 : 0.12;
    }

    yaw += (targetYaw - yaw) * 0.075;
    pitch += (targetPitch - pitch) * 0.075;
    head.rotation.y = yaw;
    head.rotation.x = pitch;
    head.rotation.z = yaw * -0.1;

    // Float, and breathe faster while working. A short hop on success.
    const bobRate = state === 'thinking' ? 3.1 : 1.5;
    const hop = state === 'done' ? Math.max(0, Math.sin(since * 7)) * 0.16 : 0;
    body.position.y = Math.sin(t * bobRate) * 0.05 + hop;
    body.rotation.y = Math.sin(t * 0.6) * 0.05;
    // Plush squash: the body gives a little at the bottom of each bob, and
    // spreads by the same amount so it keeps its volume.
    const give = Math.sin(t * bobRate) * 0.014;
    body.scale.set(1 + give, 1 - give, 1 + give);

    if (t > nextBlink && state !== 'thinking' && state !== 'done') {
      blinkUntil = t + 0.11;
      nextBlink = t + 2 + Math.random() * 3.5;
    }
    // Eyes: blink shut, narrow while concentrating, happy slits on success,
    // and widen a touch while listening.
    const openness = t < blinkUntil ? 0.1
      : state === 'thinking' ? 0.55
        : state === 'done' ? 0.3
          : state === 'listening' ? 1.14 + smoothedLevel * 0.1
            : 1;
    for (const eye of eyes) eye.scale.set(1, 1.18 * openness, 0.55);
    // The smile widens when Muse is pleased with itself.
    const grin = state === 'done' ? 1.45 : state === 'listening' ? 1.12 : 1;
    mouth.scale.set(grin, 0.85 * (state === 'thinking' ? 0.7 : 1), 0.6);

    accent.lerp(new Color(ACCENT[state]), 0.09);
    rim.color.copy(accent);
    rim.intensity = state === 'listening' ? 16 + smoothedLevel * 26 : 16;
    blushMat.opacity = 0.62 + (state === 'listening' ? smoothedLevel * 0.3 : 0)
      + (state === 'done' ? 0.22 : 0);

    renderer.render(scene, camera);
  }

  pickGlance(0);
  frame();

  return {
    setState(next: MascotState): void {
      if (next === state) return;
      state = next;
      stateEnteredAt = performance.now() / 1000 - clock.start;
      if (next === 'idle') nextGlance = 0;
    },
    setLevel(next: number): void {
      level = Math.min(1, Math.max(0, next));
    },
    dispose(): void {
      cancelAnimationFrame(raf);
      bump.dispose();
      renderer.dispose();
    },
  };
}
