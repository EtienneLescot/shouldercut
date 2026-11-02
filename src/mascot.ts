// Muse, the little editor sitting over your shoulder: Meta's Jolly mascot,
// generated as a mesh from a reference photo (Trellis/Pixal3D in ComfyUI,
// see docs/spikes.md) and loaded here as a GLB.
//
// The mesh is one piece, so there is no head to turn independently of the
// body -- the whole figure turns instead, which reads correctly at the size
// the UI gives it. Everything it does is driven by one state string and one
// audio level, so the UI only has to say what is happening.
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Group,
  PerspectiveCamera,
  PointLight,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type MascotState = 'idle' | 'listening' | 'thinking' | 'done' | 'error';

export interface Mascot {
  setState(state: MascotState): void;
  /** Live microphone level, 0..1, used while listening. */
  setLevel(level: number): void;
  dispose(): void;
}

/** The accent only ever touches the light around Muse -- the fur stays cream. */
const ACCENT: Record<MascotState, number> = {
  idle: 0x6ee7b7,
  listening: 0xf87171,
  thinking: 0x818cf8,
  done: 0x4ade80,
  error: 0xf59e0b,
};

const MODEL_URL = '/mascot/jolly.glb';
/** World height the mesh is normalised to, whatever scale it was authored at. */
const HEIGHT = 3.4;

export function createMascot(canvas: HTMLCanvasElement): Mascot {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  // The figure stands on y=0, so frame on its waist rather than the origin.
  const camera = new PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, HEIGHT / 2, 7.4);
  camera.lookAt(0, HEIGHT / 2, 0);

  // body turns and bobs; figure holds the model at a normalised size so the
  // generated mesh's own scale and pivot do not leak into the animation.
  const body = new Group();
  const figure = new Group();
  body.add(figure);
  scene.add(body);

  scene.add(new AmbientLight(0xffffff, 1.1));
  const key = new DirectionalLight(0xfff6e8, 1.5);
  key.position.set(2.2, 3.2, 4);
  scene.add(key);
  const fill = new DirectionalLight(0xdfe6ff, 0.5);
  fill.position.set(-3, 0.5, 2);
  scene.add(fill);
  // The only coloured light: this is where the UI state shows on Muse.
  const rim = new PointLight(ACCENT.idle, 18, 16);
  rim.position.set(-2.4, 0.9, -1.8);
  scene.add(rim);

  let loaded = false;
  new GLTFLoader().load(
    MODEL_URL,
    (gltf) => {
      const model = gltf.scene;
      // Normalise the generated mesh: scale the tallest axis to a known
      // height and stand it on y=0, so the body group rotates about its
      // FEET. Pivoting about the centre instead makes every lean read as
      // the character tipping over in mid-air.
      const box = new Box3().setFromObject(model);
      const size = box.getSize(new Vector3());
      const centre = box.getCenter(new Vector3());
      const scale = HEIGHT / Math.max(size.x, size.y, size.z, 0.0001);
      model.position.set(-centre.x, -box.min.y, -centre.z).multiplyScalar(scale);
      model.scale.setScalar(scale);
      figure.add(model);
      loaded = true;
    },
    undefined,
    () => {
      // No mesh: the dock and its ground glow still carry the state, so the
      // UI degrades to an empty corner rather than a broken one.
      console.warn('Muse mascot mesh not found at ' + MODEL_URL);
    },
  );

  let state: MascotState = 'idle';
  let level = 0;
  let smoothedLevel = 0;
  let yaw = 0;
  let pitch = 0;
  let targetYaw = 0;
  let targetPitch = 0;
  let nextGlance = 0;
  let stateEnteredAt = 0;
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
    // Idle: look around the way someone waiting for an instruction does --
    // wide turns held for a beat, but never far enough to show only its back.
    targetYaw = (Math.random() * 2 - 1) * 0.62;
    targetPitch = (Math.random() * 2 - 1) * 0.07;
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
      // Turned to whoever is talking, leaning in, with an attentive drift.
      targetYaw = Math.sin(t * 1.6) * 0.07;
      targetPitch = -0.06 + Math.sin(t * 2.3) * 0.02;
    } else if (state === 'thinking') {
      // Head down over the work, scanning left to right across the frame.
      targetYaw = Math.sin(t * 2.4) * 0.28;
      targetPitch = 0.16;
    } else {
      targetYaw = 0;
      targetPitch = state === 'done' ? -0.08 + Math.sin(since * 9) * 0.09 : 0.08;
    }

    yaw += (targetYaw - yaw) * 0.075;
    pitch += (targetPitch - pitch) * 0.075;
    body.rotation.y = yaw;
    body.rotation.x = pitch;
    body.rotation.z = yaw * -0.08;

    // Float, breathe faster while working, and hop once on success.
    const bobRate = state === 'thinking' ? 3.1 : 1.5;
    const hop = state === 'done' ? Math.max(0, Math.sin(since * 7)) * 0.2 : 0;
    const bob = Math.sin(t * bobRate) * 0.06;
    body.position.y = bob + hop;
    // Plush squash: it gives a little at the bottom of each bob and spreads
    // by the same amount, so it keeps its volume.
    const give = bob * 0.22;
    figure.scale.set(1 - give, 1 + give, 1 - give);
    // Listening leans the whole figure very slightly toward the viewer.
    figure.position.z = state === 'listening' ? 0.18 + smoothedLevel * 0.1 : 0;

    accent.lerp(new Color(ACCENT[state]), 0.09);
    rim.color.copy(accent);
    rim.intensity = state === 'listening' ? 18 + smoothedLevel * 30 : 18;

    if (loaded) renderer.render(scene, camera);
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
