export interface CameraMove {
  /** World position at range start; world units: background plane is z=0, x in [-aspect, aspect], y in [-1, 1]. */
  from: [number, number, number];
  /** World position at range end. */
  to: [number, number, number];
  /** Vertical field of view in degrees. */
  fov: number;
  /** Look-at target at range start/end interpolation anchor. Defaults to the world origin [0,0,0]. */
  target?: [number, number, number];
  /** Camera roll in degrees around the forward axis. Defaults to 0. */
  roll?: number;
}

export type ShaderEffectKind = 'fragment' | 'particles';

export interface ParticleConfig {
  /** GPU particle count, 1..200000. */
  count: number;
  /** Default world-space sprite size (agent code can override per particle). */
  size: number;
  blending: 'normal' | 'additive';
}

export interface ShaderEffectDefinition {
  id: string;
  name: string;
  /** Fragment contract: fn fx(ctx: FxContext) -> vec4f */
  code: string;
  /**
   * Compute/sprite contract for kind='particles'. Defines
   * fn particleInit(index: u32, ctx: ParticleContext) -> Particle and
   * fn particleUpdate(p: Particle, ctx: ParticleContext) -> Particle,
   * plus optionally fn particleSprite(uv: vec2f, p: Particle, ctx: ParticleContext) -> vec4f.
   */
  particleCode?: string;
  kind?: ShaderEffectKind;
  params: [number, number, number, number];
  paramsB?: [number, number, number, number];
  paramsC?: [number, number, number, number];
  paramsD?: [number, number, number, number];
  /** Enable historyAt()/prevAt(): previous output of this same effect fed back as input. */
  history?: boolean;
  /** GPU particle layer rendered after the fragment pass of this effect. Null/absent = none. */
  particles?: ParticleConfig | null;
  seed?: number;
  start: number | null;
  end: number | null;
  enabled: boolean;
  camera: CameraMove | null;
}

export interface MaskTrackFrameData {
  frame: number;
  data: ArrayBuffer;
}

export interface MaskTrackData {
  prompt: string;
  maskWidth: number;
  maskHeight: number;
  frames: MaskTrackFrameData[];
}

export type WorkerCommand =
  | { type: 'init'; canvas: OffscreenCanvas }
  | { type: 'load'; file: File }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; time: number }
  | { type: 'step'; delta: 1 | -1 }
  | { type: 'upsertEffect'; requestId: string; effect: ShaderEffectDefinition; dryRun?: boolean }
  | { type: 'removeEffect'; effectId: string }
  | { type: 'clearEffects' }
  | { type: 'setMaskTrack'; track: MaskTrackData }
  | { type: 'clearMaskTrack' }
  | { type: 'captureFrame'; requestId: string };

export type PlayerPhase =
  | 'starting'
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'seeking'
  | 'ended'
  | 'error';

export interface PlayerState {
  phase: PlayerPhase;
  message: string;
  fileName: string;
  duration: number;
  mediaTime: number;
  frameTimestamp: number | null;
  frameDuration: number | null;
  frameIndex: number | null;
  codedWidth: number | null;
  codedHeight: number | null;
  displayWidth: number | null;
  displayHeight: number | null;
  codec: string | null;
  decoderConfig: string | null;
  hardwareAcceleration: string | null;
  frameRate: number | null;
  bufferedFrames: number;
  decodedFrames: number;
  maskPrompt: string | null;
  maskFrames: number;
}

export interface EffectCompileResult {
  requestId: string;
  effectId: string;
  ok: boolean;
  dryRun?: boolean;
  message: string;
  errors: string[];
}

export interface FrameCaptureResult {
  requestId: string;
  ok: boolean;
  message: string;
  mediaTime: number;
  width: number;
  height: number;
  png: ArrayBuffer | null;
}

export type WorkerEvent =
  | { type: 'state'; state: PlayerState }
  | { type: 'error'; message: string }
  | { type: 'effectResult'; result: EffectCompileResult }
  | { type: 'frameResult'; result: FrameCaptureResult };
