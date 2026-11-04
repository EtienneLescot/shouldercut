// The original textured Jolly mesh, with a small two-arm skin rig.
// The head, torso, legs and authored rear silhouette remain untouched.
import {
  ACESFilmicToneMapping,
  AmbientLight,
  Bone,
  Box3,
  BufferGeometry,
  CanvasTexture,
  DirectionalLight,
  Float32BufferAttribute,
  Group,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
  WebGLRenderer,
  type Material,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
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
  setLevel(level: number): void;
  dispose(): void;
}
export function createMascot(canvas: HTMLCanvasElement): Mascot {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0, 0);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new Scene(),
    camera = new PerspectiveCamera(32, 1, 0.1, 30);
  camera.position.set(0, 2.3, 8);
  camera.lookAt(0, 1.65, 0);
  scene.add(new AmbientLight(0xffffff, 1.5));
  for (const [color, power, x, y, z] of [
    [0xfff7e8, 2.6, -3, 5, 5],
    [0xd3e5ff, 1.2, 3, 2, 2],
    [0xffffff, 2, 1, 3, -4],
  ]) {
    const light = new DirectionalLight(color, power);
    light.position.set(x, y, z);
    scene.add(light);
  }
  const character = new Group();
  scene.add(character);
  const arms: Bone[] = [];
  let loaded = false,
    disposed = false;
  new GLTFLoader().load(
    "/mascot/jolly.glb",
    (gltf) => {
      if (disposed) return;
      gltf.scene.updateMatrixWorld(true);
      const box = new Box3().setFromObject(gltf.scene),
        center = box.getCenter(new Vector3()),
        size = box.getSize(new Vector3());
      const scale = 3.4 / Math.max(size.x, size.y, size.z);
      const normalization = new Matrix4()
        .makeRotationY(0.76)
        .multiply(new Matrix4().makeScale(scale, scale, scale))
        .multiply(
          new Matrix4().makeTranslation(-center.x, -box.min.y, -center.z),
        );
      gltf.scene.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        const geometry = node.geometry
          .clone()
          .applyMatrix4(
            new Matrix4().multiplyMatrices(normalization, node.matrixWorld),
          );
        const material = (
          Array.isArray(node.material) ? node.material[0] : node.material
        ).clone() as MeshStandardMaterial;
        material.roughness = 0.96;
        material.metalness = 0;
        const root = new Bone(),
          left = new Bone(),
          right = new Bone();
        left.position.set(-0.63, 1.83, 0);
        right.position.set(0.63, 1.83, 0);
        root.add(left, right);
        const position = geometry.getAttribute("position"),
          indices: number[] = [],
          weights: number[] = [];
        for (let i = 0; i < position.count; i++) {
          const x = position.getX(i),
            y = position.getY(i);
          // Only the outer arms get weights. Smooth shoulder falloff avoids a cut seam.
          const w =
            MathUtils.smoothstep(Math.abs(x), 0.56, 0.86) *
            (1 - MathUtils.smoothstep(y, 1.8, 2.02)) *
            MathUtils.smoothstep(y, 0.5, 0.8);
          indices.push(0, x < 0 ? 1 : 2, 0, 0);
          weights.push(1 - w, w, 0, 0);
        }
        geometry.setAttribute(
          "skinIndex",
          new Uint16BufferAttribute(indices, 4),
        );
        geometry.setAttribute(
          "skinWeight",
          new Float32BufferAttribute(weights, 4),
        );
        const mesh = new SkinnedMesh(geometry, material);
        mesh.add(root);
        mesh.bind(new Skeleton([root, left, right]));
        character.add(mesh);
        arms.push(left, right);
      });
      loaded = true;
      canvas.dataset.loaded = "true";
    },
    undefined,
    () => console.warn("Muse mascot could not be loaded."),
  );
  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = shadowCanvas.height = 128;
  const ctx = shadowCanvas.getContext("2d")!,
    gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  gradient.addColorStop(0, "rgba(0,0,0,.25)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const shadowTexture = new CanvasTexture(shadowCanvas),
    shadow = new Mesh(
      new PlaneGeometry(2.7, 2),
      new MeshBasicMaterial({
        map: shadowTexture,
        transparent: true,
        depthWrite: false,
      }),
    );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -0.025;
  scene.add(shadow);
  let state: MascotState = "idle",
    working = false,
    level = 0,
    previous = performance.now() / 1000,
    raf = 0;
  const start = previous,
    reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const damp = (a: number, b: number, dt: number, speed = 4): number =>
    MathUtils.lerp(a, b, 1 - Math.exp(-speed * dt));
  function frame(ms: number): void {
    raf = requestAnimationFrame(frame);
    const now = ms / 1000,
      dt = Math.min(now - previous, 0.05),
      t = now - start;
    previous = now;
    const rect = canvas.getBoundingClientRect(),
      dpr = Math.min(devicePixelRatio || 1, 2),
      w = Math.max(1, Math.round(rect.width)),
      h = Math.max(1, Math.round(rect.height));
    if (
      canvas.width !== Math.round(w * dpr) ||
      canvas.height !== Math.round(h * dpr)
    ) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    const busy = working || state === "thinking",
      motion = reduced.matches ? 0 : 1;
    // Face the viewer while waiting; turn completely to the video for accepted work.
    const target = busy ? 2.0 : 0.12;
    character.rotation.y = damp(character.rotation.y, target, dt, 3.4);
    const settled = Math.abs(character.rotation.y - target) < 0.25;
    character.rotation.z = damp(
      character.rotation.z,
      busy && settled
        ? Math.sin(t * 2.4) * 0.012 * motion
        : state === "listening"
          ? -0.02
          : 0,
      dt,
    );
    character.position.y =
      (busy ? Math.sin(t * 4) * 0.006 : Math.sin(t * 1.7) * 0.008) * motion;
    arms.forEach((arm, i) => {
      const side = i % 2 ? 1 : -1;
      arm.rotation.x = damp(
        arm.rotation.x,
        busy
          ? -0.27 + Math.sin(t * 6.5 + i * 2.3) * 0.07 * motion
          : state === "speaking"
            ? -level * 0.07 * motion
            : 0,
        dt,
      );
      arm.rotation.z = damp(
        arm.rotation.z,
        busy ? side * (0.08 + Math.sin(t * 4.5 + i) * 0.025 * motion) : 0,
        dt,
      );
    });
    canvas.dataset.facing = busy ? "video" : "viewer";
    if (loaded) renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);
  return {
    setState(next) {
      state = next;
    },
    setWorking(next) {
      working = next;
    },
    setLevel(next) {
      level = MathUtils.clamp(next, 0, 1);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      const geometries = new Set<BufferGeometry>(),
        materials = new Set<Material>();
      scene.traverse((node) => {
        if (node instanceof Mesh) {
          geometries.add(node.geometry);
          for (const material of Array.isArray(node.material)
            ? node.material
            : [node.material])
            materials.add(material);
        }
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      shadowTexture.dispose();
      renderer.dispose();
    },
  };
}
