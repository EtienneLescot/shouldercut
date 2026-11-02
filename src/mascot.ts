// Muse, the little editor sitting over your shoulder.
//
// Built from Three.js primitives on purpose: no model file to ship, no
// loader, no asset pipeline. Everything it does is driven by one state
// string and one audio level, so the UI only has to say what is happening.
import {
  AmbientLight,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PointLight,
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

const ACCENT: Record<MascotState, number> = {
  idle: 0x6ee7b7,
  listening: 0xf87171,
  thinking: 0x818cf8,
  done: 0x4ade80,
  error: 0xf59e0b,
};

export function createMascot(canvas: HTMLCanvasElement): Mascot {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  // Framed so the antenna tip and the base of the torso both clear the
  // canvas edges, including the idle bob.
  const camera = new PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, -0.18, 7.4);
  camera.lookAt(0, -0.18, 0);

  const body = new Group();
  scene.add(body);

  const shell = new MeshStandardMaterial({ color: 0xe7ebf2, roughness: 0.42, metalness: 0.12 });
  const visorMat = new MeshStandardMaterial({ color: 0x1b2030, roughness: 0.18, metalness: 0.55 });
  const eyeMat = new MeshStandardMaterial({ color: 0x0b0f16, emissive: new Color(ACCENT.idle), emissiveIntensity: 2.4 });
  const antennaMat = new MeshStandardMaterial({ color: 0x9aa4b5, roughness: 0.5, metalness: 0.6 });
  const bulbMat = new MeshStandardMaterial({ color: 0x0b0f16, emissive: new Color(ACCENT.idle), emissiveIntensity: 3 });

  // Torso: a squat capsule, deliberately smaller than the head.
  const torso = new Mesh(new CapsuleGeometry(0.52, 0.34, 6, 18), shell);
  torso.position.y = -1.08;
  torso.scale.set(1, 0.92, 0.88);
  body.add(torso);

  // Head group: everything that turns.
  const head = new Group();
  head.position.y = 0.12;
  body.add(head);

  const skull = new Mesh(new SphereGeometry(0.98, 36, 28), shell);
  skull.scale.set(1, 0.94, 0.92);
  head.add(skull);

  // Visor: a flattened sphere sunk into the face, so the eyes read as one unit.
  const visor = new Mesh(new SphereGeometry(0.92, 32, 24), visorMat);
  visor.scale.set(0.84, 0.56, 0.5);
  visor.position.set(0, 0.04, 0.56);
  head.add(visor);

  const eyes: Mesh[] = [];
  for (const x of [-0.3, 0.3]) {
    const eye = new Mesh(new SphereGeometry(0.12, 20, 16), eyeMat);
    eye.position.set(x, 0.06, 0.92);
    head.add(eye);
    eyes.push(eye);
  }

  // Antenna: the state read at a glance, even at 160 px.
  const stalk = new Mesh(new CylinderGeometry(0.035, 0.045, 0.52, 10), antennaMat);
  stalk.position.set(0, 1.08, -0.04);
  head.add(stalk);
  const bulb = new Mesh(new IcosahedronGeometry(0.15, 1), bulbMat);
  bulb.position.set(0, 1.4, -0.04);
  head.add(bulb);

  // Work ring: only spins while Muse is actually editing.
  const ring = new Mesh(new TorusGeometry(1.34, 0.035, 10, 60), new MeshStandardMaterial({
    color: 0x0b0f16, emissive: new Color(ACCENT.thinking), emissiveIntensity: 2, transparent: true, opacity: 0,
  }));
  ring.rotation.x = Math.PI / 2.3;
  body.add(ring);

  scene.add(new AmbientLight(0xffffff, 0.75));
  const key = new DirectionalLight(0xffffff, 1.5);
  key.position.set(2.4, 3, 4);
  scene.add(key);
  const rim = new PointLight(ACCENT.idle, 14, 14);
  rim.position.set(-2.4, 0.6, -1.6);
  scene.add(rim);

  let state: MascotState = 'idle';
  let level = 0;
  let smoothedLevel = 0;
  // Where the head is looking, and where it wants to look.
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
    // Idle: scan the room the way someone waiting for an instruction does —
    // wide turns, held for a beat, never centred for long.
    // Wide enough to read as "looking around", not so wide that the eyes
    // leave the frame and Muse looks asleep.
    targetYaw = (Math.random() * 2 - 1) * 0.58;
    targetPitch = (Math.random() * 2 - 1) * 0.2;
    nextGlance = t + 1.1 + Math.random() * 1.9;
  }

  const clock = { start: performance.now() / 1000 };

  function frame(): void {
    raf = requestAnimationFrame(frame);
    resize();
    const t = performance.now() / 1000 - clock.start;
    const since = t - stateEnteredAt;

    smoothedLevel += (level - smoothedLevel) * 0.25;

    if (state === 'idle') {
      if (t > nextGlance) pickGlance(t);
    } else if (state === 'listening') {
      // Locked on the person talking, with a small attentive drift.
      targetYaw = Math.sin(t * 1.6) * 0.06;
      targetPitch = -0.05 + Math.sin(t * 2.3) * 0.03;
    } else if (state === 'thinking') {
      // Head down on the work, scanning left to right across the frame.
      targetYaw = Math.sin(t * 2.4) * 0.3;
      targetPitch = 0.34;
    } else {
      targetYaw = 0;
      targetPitch = state === 'done' ? -0.1 + Math.sin(since * 9) * 0.16 : 0.1;
    }

    yaw += (targetYaw - yaw) * 0.075;
    pitch += (targetPitch - pitch) * 0.075;
    head.rotation.y = yaw;
    head.rotation.x = pitch;
    head.rotation.z = yaw * -0.12;

    // Float, and breathe faster while working.
    const bobRate = state === 'thinking' ? 3.1 : 1.5;
    body.position.y = Math.sin(t * bobRate) * 0.055;
    body.rotation.y = Math.sin(t * 0.6) * 0.05;

    if (t > nextBlink && state !== 'thinking') {
      blinkUntil = t + 0.11;
      nextBlink = t + 2 + Math.random() * 3.5;
    }
    const blinking = t < blinkUntil;
    const squint = state === 'thinking' ? 0.45 : 1;
    const eyeScale = blinking ? 0.12 : squint;
    for (const eye of eyes) eye.scale.set(1, eyeScale, 1);

    accent.lerp(new Color(ACCENT[state]), 0.09);
    eyeMat.emissive.copy(accent);
    bulbMat.emissive.copy(accent);
    rim.color.copy(accent);

    const pulse = state === 'listening'
      ? 2.5 + smoothedLevel * 9
      : state === 'thinking'
        ? 2.6 + Math.sin(t * 7) * 1.4
        : 2.2 + Math.sin(t * 1.7) * 0.6;
    bulbMat.emissiveIntensity = pulse;
    eyeMat.emissiveIntensity = state === 'listening' ? 2.6 + smoothedLevel * 4 : 2.4;
    bulb.scale.setScalar(state === 'listening' ? 1 + smoothedLevel * 0.55 : 1);
    bulb.rotation.y += state === 'thinking' ? 0.09 : 0.012;

    const ringMat = ring.material as MeshStandardMaterial;
    const wantRing = state === 'thinking' ? 0.9 : 0;
    ringMat.opacity += (wantRing - ringMat.opacity) * 0.1;
    ring.rotation.z += state === 'thinking' ? 0.035 : 0.004;

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
      renderer.dispose();
    },
  };
}
