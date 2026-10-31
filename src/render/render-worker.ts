import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  Input,
  type EncodedPacket,
  type InputVideoTrack,
} from 'mediabunny';
import type {
  EffectCompileResult,
  MaskTrackData,
  PlayerPhase,
  PlayerState,
  ShaderEffectDefinition,
  WorkerCommand,
  WorkerEvent,
} from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

const VERTEX_WGSL = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> VertexOutput {
  var points = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let xy = points[index];
  var out: VertexOutput;
  out.position = vec4f(xy, 0.0, 1.0);
  out.uv = vec2f((xy.x + 1.0) * 0.5, 1.0 - (xy.y + 1.0) * 0.5);
  return out;
}
`;
const EXTERNAL_WGSL = VERTEX_WGSL + `
@group(0) @binding(0) var frameSampler: sampler;
@group(0) @binding(1) var frameTexture: texture_external;
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let colour = textureSampleBaseClampToEdge(frameTexture, frameSampler, input.uv);
  return vec4f(colour.rgb, 1.0);
}
`;
const BLIT_WGSL = VERTEX_WGSL + `
@group(0) @binding(0) var frameSampler: sampler;
@group(0) @binding(1) var frameTexture: texture_2d<f32>;
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  return textureSampleLevel(frameTexture, frameSampler, input.uv, 0.0);
}
`;
const FX_UNIFORM_FLOATS = 40; // 160 bytes, layout documented in docs/fx-interface.md
const FX_PRELUDE = VERTEX_WGSL + `
struct FxUniform {
  resolution: vec2f,
  mediaTime: f32,
  duration: f32,
  progress: f32,
  elapsed: f32,
  frame: f32,
  deltaTime: f32,
  params: vec4f,
  paramsB: vec4f,
  paramsC: vec4f,
  paramsD: vec4f,
  camOrigin: vec3f,
  tanHalfFov: f32,
  camRight: vec3f,
  aspect: f32,
  camUp: vec3f,
  seed: f32,
  camForward: vec3f,
  historyMix: f32,
};
struct FxContext {
  uv: vec2f,
  coord: vec2f,
  resolution: vec2f,
  mediaTime: f32,
  duration: f32,
  progress: f32,
  elapsed: f32,
  frame: f32,
  deltaTime: f32,
  seed: f32,
  params: vec4f,
  paramsB: vec4f,
  paramsC: vec4f,
  paramsD: vec4f,
  camOrigin: vec3f,
  camRight: vec3f,
  camUp: vec3f,
  camForward: vec3f,
  tanHalfFov: f32,
  aspect: f32,
  historyMix: f32,
};
@group(0) @binding(0) var fxSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var originalTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> fxUniform: FxUniform;
@group(0) @binding(4) var maskTexture: texture_2d<f32>;
@group(0) @binding(5) var historyTexture: texture_2d<f32>;
fn sourceAt(uv: vec2f) -> vec4f {
  return textureSampleLevel(inputTexture, fxSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
}
fn originalAt(uv: vec2f) -> vec4f {
  return textureSampleLevel(originalTexture, fxSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
}
fn maskAt(uv: vec2f) -> f32 {
  return textureSampleLevel(maskTexture, fxSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).r;
}
fn historyAt(uv: vec2f) -> vec4f {
  return textureSampleLevel(historyTexture, fxSampler, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0);
}
fn prevAt(uv: vec2f) -> vec4f { return historyAt(uv); }
fn foreAt(uv: vec2f) -> vec4f {
  return vec4f(originalAt(uv).rgb, maskAt(uv));
}
fn backAt(uv: vec2f) -> vec4f {
  return originalAt(uv);
}
fn rayDir(uv: vec2f) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return normalize(fxUniform.camForward
    + fxUniform.camRight * (ndc.x * fxUniform.tanHalfFov * fxUniform.aspect)
    + fxUniform.camUp * (ndc.y * fxUniform.tanHalfFov));
}
fn layerUv(uv: vec2f, z: f32) -> vec3f {
  let rd = rayDir(uv);
  if (abs(rd.z) < 1e-6) { return vec3f(uv, 0.0); }
  let t = (z - fxUniform.camOrigin.z) / rd.z;
  if (t <= 0.0) { return vec3f(uv, 0.0); }
  let p = fxUniform.camOrigin + rd * t;
  let mapped = vec2f(p.x / (2.0 * fxUniform.aspect) + 0.5, 0.5 - p.y * 0.5);
  let inside = step(0.0, mapped.x) * step(mapped.x, 1.0) * step(0.0, mapped.y) * step(mapped.y, 1.0);
  return vec3f(mapped, inside);
}
fn worldToUv(p: vec3f) -> vec3f {
  let rel = p - fxUniform.camOrigin;
  let vz = dot(rel, fxUniform.camForward);
  if (vz <= 1e-5) { return vec3f(0.5, 0.5, 0.0); }
  let vx = dot(rel, fxUniform.camRight) / (vz * fxUniform.tanHalfFov * fxUniform.aspect);
  let vy = dot(rel, fxUniform.camUp) / (vz * fxUniform.tanHalfFov);
  let uv = vec2f(vx * 0.5 + 0.5, 0.5 - vy * 0.5);
  let inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  return vec3f(uv, inside);
}
`;
// ---------------------------------------------------------------------------
// FX_STDLIB: host-owned WGSL library injected between prelude and agent code.
// Agent code must not redefine any of these names (validated in the worker).
// Full catalogue with signatures: docs/fx-interface.md
// ---------------------------------------------------------------------------
const FX_STDLIB = /* wgsl */`
const SC_PI: f32 = 3.14159265358979;
const SC_TAU: f32 = 6.28318530717959;
fn hash11(p: f32) -> f32 { var x = fract(p * 0.1031); x *= x + 33.33; x *= x + x; return fract(x); }
fn hash21(p: vec2f) -> f32 { var p3 = fract(vec3f(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
fn hash22(p: vec2f) -> vec2f { var p3 = fract(vec3f(p.xyx) * vec3f(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
fn hash31(p: vec3f) -> f32 { var p3 = fract(p * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
fn noise2(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm2(p0: vec2f) -> f32 {
  var p = p0; var v = 0.0; var a = 0.5;
  for (var i = 0; i < 5; i++) { v += a * noise2(p); p = p * 2.03 + vec2f(17.3, 9.1); a *= 0.5; }
  return v;
}
fn fbm2r(p0: vec2f) -> f32 {
  var p = p0; var v = 0.0; var a = 0.5; let r = mat2x2f(0.8, 0.6, -0.6, 0.8);
  for (var i = 0; i < 5; i++) { v += a * noise2(p); p = r * p * 2.02 + vec2f(11.7, 5.3); a *= 0.5; }
  return v;
}
fn voronoiF1(p: vec2f) -> vec2f {
  let i = floor(p); let f = fract(p); var f1 = 8.0; var f2 = 8.0; var id = 0.0;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let g = vec2f(f32(x), f32(y)); let o = hash22(i + g); let r = g + o - f; let d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; id = hash21(i + g); } else if (d < f2) { f2 = d; }
  } }
  return vec2f(sqrt(f1), id);
}
fn rot2(a: f32) -> mat2x2f { let c = cos(a); let s = sin(a); return mat2x2f(c, s, -s, c); }
fn easeInQuad(x: f32) -> f32 { return x * x; }
fn easeOutQuad(x: f32) -> f32 { return 1.0 - (1.0 - x) * (1.0 - x); }
fn easeInOut(x: f32) -> f32 { return x * x * (3.0 - 2.0 * x); }
fn easeOutCubic(x: f32) -> f32 { let y = 1.0 - x; return 1.0 - y * y * y; }
fn easeOutBack(x: f32) -> f32 { let c = 1.70158; let y = x - 1.0; return 1.0 + (c + 1.0) * y * y * y + c * y * y; }
fn pulse(x: f32, center: f32, width: f32) -> f32 { return smoothstep(center - width, center, x) * (1.0 - smoothstep(center, center + width, x)); }
fn luminance(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn hsv2rgb(c: vec3f) -> vec3f {
  let p = abs(fract(c.xxx + vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3f(1.0), clamp(p - 1.0, vec3f(0.0), vec3f(1.0)), c.y);
}
fn rgb2hsv(c: vec3f) -> vec3f {
  let k = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4f(c.bg, k.wz), vec4f(c.gb, k.xy), step(c.b, c.g));
  let q = mix(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), step(p.x, c.r));
  let d = q.x - min(q.w, q.y); let e = 1e-10;
  return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
fn satColor(c: vec3f, amount: f32) -> vec3f { return mix(vec3f(luminance(c)), c, amount); }
fn contrastColor(c: vec3f, amount: f32) -> vec3f { return (c - 0.5) * amount + 0.5; }
fn hueShift(c: vec3f, shift: f32) -> vec3f { var h = rgb2hsv(c); h.x = fract(h.x + shift); return hsv2rgb(h); }
fn temperature(c: vec3f, amount: f32) -> vec3f { return clamp(c + vec3f(amount * 0.12, 0.0, -amount * 0.12), vec3f(0.0), vec3f(1.0)); }
fn liftGammaGain(c: vec3f, lift: vec3f, gamma: vec3f, gain: vec3f) -> vec3f {
  let lifted = clamp(c + lift * (1.0 - c), vec3f(0.0), vec3f(1.0));
  let g = max(gamma, vec3f(0.05));
  return clamp(pow(lifted, vec3f(1.0) / g) * gain, vec3f(0.0), vec3f(1.0));
}
fn vibrance(c: vec3f, amount: f32) -> vec3f {
  let mx = max(c.r, max(c.g, c.b)); let mn = min(c.r, min(c.g, c.b));
  let sat = mx - mn; let l = luminance(c);
  return clamp(mix(vec3f(l), c, 1.0 + amount * (1.0 - sat)), vec3f(0.0), vec3f(1.0));
}
fn acesTonemap(x: vec3f) -> vec3f { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0)); }
fn sdCircle(p: vec2f, r: f32) -> f32 { return length(p) - r; }
fn sdBox2(p: vec2f, b: vec2f) -> f32 { let d = abs(p) - b; return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0); }
fn sdSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a; let ba = b - a; let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}
fn sdRing(p: vec2f, r: f32, w: f32) -> f32 { return abs(length(p) - r) - w; }
fn sdSphere(p: vec3f, r: f32) -> f32 { return length(p) - r; }
fn sdBox3(p: vec3f, b: vec3f) -> f32 { let q = abs(p) - b; return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0); }
fn sdTorus(p: vec3f, t: vec2f) -> f32 { let q = vec2f(length(p.xz) - t.x, p.y); return length(q) - t.y; }
fn smin(a: f32, b: f32, k: f32) -> f32 { let h = clamp(0.5 + 0.5 * (b - a) / max(k, 1e-5), 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
fn intersectPlaneZ(ro: vec3f, rd: vec3f, z: f32) -> vec4f {
  if (abs(rd.z) < 1e-6) { return vec4f(ro, 0.0); }
  let t = (z - ro.z) / rd.z; if (t <= 0.0) { return vec4f(ro, 0.0); }
  return vec4f(ro + rd * t, 1.0);
}
fn lightLambert(n: vec3f, l: vec3f) -> f32 { return max(dot(n, normalize(l)), 0.0); }
fn lightSpec(n: vec3f, v: vec3f, l: vec3f, shininess: f32) -> f32 {
  let h = normalize(normalize(v) + normalize(l)); return pow(max(dot(n, h), 0.0), shininess);
}
fn fresnelTerm(n: vec3f, v: vec3f, power: f32) -> f32 { return pow(1.0 - max(dot(normalize(n), normalize(v)), 0.0), power); }
fn sourceBlur(uv: vec2f, radius: f32) -> vec4f {
  let px = radius / max(fxUniform.resolution, vec2f(1.0)); var acc = sourceAt(uv) * 4.0; var w = 4.0;
  let offs = array<vec2f, 8>(vec2f(1.0, 0.0), vec2f(-1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, -1.0),
    vec2f(1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(-1.0, -1.0));
  for (var i = 0; i < 8; i++) { acc += sourceAt(uv + offs[i] * px); w += 1.0; }
  return acc / w;
}
fn originalBlur(uv: vec2f, radius: f32) -> vec4f {
  let px = radius / max(fxUniform.resolution, vec2f(1.0)); var acc = originalAt(uv) * 4.0; var w = 4.0;
  let offs = array<vec2f, 8>(vec2f(1.0, 0.0), vec2f(-1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, -1.0),
    vec2f(1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(-1.0, -1.0));
  for (var i = 0; i < 8; i++) { acc += originalAt(uv + offs[i] * px); w += 1.0; }
  return acc / w;
}
fn maskBlur(uv: vec2f, radius: f32) -> f32 {
  let px = radius / max(fxUniform.resolution, vec2f(1.0)); var acc = maskAt(uv) * 4.0; var w = 4.0;
  let offs = array<vec2f, 8>(vec2f(1.0, 0.0), vec2f(-1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, -1.0),
    vec2f(1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(-1.0, -1.0));
  for (var i = 0; i < 8; i++) { acc += maskAt(uv + offs[i] * px); w += 1.0; }
  return acc / w;
}
fn sobelEdge(uv: vec2f) -> f32 {
  let px = 1.0 / max(fxUniform.resolution, vec2f(1.0));
  let tl = luminance(sourceAt(uv + vec2f(-px.x, -px.y)).rgb); let tm = luminance(sourceAt(uv + vec2f(0.0, -px.y)).rgb);
  let tr = luminance(sourceAt(uv + vec2f(px.x, -px.y)).rgb); let ml = luminance(sourceAt(uv + vec2f(-px.x, 0.0)).rgb);
  let mr = luminance(sourceAt(uv + vec2f(px.x, 0.0)).rgb); let bl = luminance(sourceAt(uv + vec2f(-px.x, px.y)).rgb);
  let bm = luminance(sourceAt(uv + vec2f(0.0, px.y)).rgb); let br = luminance(sourceAt(uv + vec2f(px.x, px.y)).rgb);
  let gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br; let gy = -tl - 2.0 * tm - tr + bl + 2.0 * bm + br;
  return clamp(length(vec2f(gx, gy)), 0.0, 1.0);
}
fn maskEdge(uv: vec2f) -> f32 {
  let px = 1.0 / max(fxUniform.resolution, vec2f(1.0));
  let gx = maskAt(uv + vec2f(px.x, 0.0)) - maskAt(uv - vec2f(px.x, 0.0));
  let gy = maskAt(uv + vec2f(0.0, px.y)) - maskAt(uv - vec2f(0.0, px.y));
  return clamp(length(vec2f(gx, gy)) * 2.0, 0.0, 1.0);
}
fn overBlend(fg: vec4f, bg: vec4f) -> vec4f {
  let a = fg.a + bg.a * (1.0 - fg.a);
  if (a <= 1e-6) { return vec4f(0.0); }
  return vec4f((fg.rgb * fg.a + bg.rgb * bg.a * (1.0 - fg.a)) / a, a);
}
fn blendScreen(a: vec3f, b: vec3f) -> vec3f { return 1.0 - (1.0 - clamp(a, vec3f(0.0), vec3f(1.0))) * (1.0 - clamp(b, vec3f(0.0), vec3f(1.0))); }
fn blendOverlay(base: vec3f, blend: vec3f) -> vec3f {
  let lo = 2.0 * base * blend; let hi = 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
  return mix(lo, hi, step(vec3f(0.5), base));
}
fn pointGlow(dist: f32, radius: f32) -> f32 { let x = clamp(1.0 - dist / max(radius, 1e-5), 0.0, 1.0); return x * x; }
fn starSprite(uv: vec2f, spikes: f32) -> f32 {
  let a = atan2(uv.y, uv.x); let r = length(uv);
  let star = 0.75 + 0.25 * cos(a * spikes); return pointGlow(r / max(star, 1e-4), 1.0);
}
`;
const STDLIB_NAMES = [
  'hash11', 'hash21', 'hash22', 'hash31', 'noise2', 'fbm2', 'fbm2r', 'voronoiF1', 'rot2',
  'easeInQuad', 'easeOutQuad', 'easeInOut', 'easeOutCubic', 'easeOutBack', 'pulse', 'luminance',
  'hsv2rgb', 'rgb2hsv', 'satColor', 'contrastColor', 'hueShift', 'temperature', 'acesTonemap', 'liftGammaGain', 'vibrance',
  'sdCircle', 'sdBox2', 'sdSegment', 'sdRing', 'sdSphere', 'sdBox3', 'sdTorus', 'smin',
  'intersectPlaneZ', 'lightLambert', 'lightSpec', 'fresnelTerm', 'sourceBlur', 'originalBlur',
  'maskBlur', 'sobelEdge', 'maskEdge', 'overBlend', 'blendScreen', 'blendOverlay', 'pointGlow', 'starSprite',
];
// ---------------------------------------------------------------------------
// GPU particles: host-owned storage buffer + compute simulation + billboard
// sprite render. Agent supplies particleInit/particleUpdate/(particleSprite)
// in effect.particleCode. See docs/fx-interface.md for the contract.
// ---------------------------------------------------------------------------
const PARTICLE_COMMON = /* wgsl */`
struct Particle {
  pos: vec3f, size: f32,
  vel: vec3f, alpha: f32,
  color: vec3f, seed: f32,
  age: f32, life: f32, id: f32, _pad: f32,
};
struct ParticleContext {
  mediaTime: f32, elapsed: f32, progress: f32, deltaTime: f32,
  frame: f32, seed: f32, aspect: f32, count: f32,
  params: vec4f, paramsB: vec4f, paramsC: vec4f, paramsD: vec4f,
  resolution: vec2f, camTan: f32, _r0: f32,
  camOrigin: vec3f, _c0: f32,
  camRight: vec3f, _c1: f32,
  camUp: vec3f, _c2: f32,
  camForward: vec3f, _c3: f32,
};
struct ParticleUniform {
  resolution: vec2f, mediaTime: f32, duration: f32,
  progress: f32, elapsed: f32, frame: f32, deltaTime: f32,
  params: vec4f, paramsB: vec4f, paramsC: vec4f, paramsD: vec4f,
  camOrigin: vec3f, tanHalfFov: f32,
  camRight: vec3f, aspect: f32,
  camUp: vec3f, seed: f32,
  camForward: vec3f, historyMix: f32,
  count: f32, pointSize: f32, reset: f32, _p0: f32,
};
fn makeParticleCtx(pu: ParticleUniform) -> ParticleContext {
  var ctx: ParticleContext;
  ctx.mediaTime = pu.mediaTime; ctx.elapsed = pu.elapsed; ctx.progress = pu.progress;
  ctx.deltaTime = pu.deltaTime; ctx.frame = pu.frame; ctx.seed = pu.seed;
  ctx.aspect = pu.aspect; ctx.count = pu.count;
  ctx.params = pu.params; ctx.paramsB = pu.paramsB; ctx.paramsC = pu.paramsC; ctx.paramsD = pu.paramsD;
  ctx.resolution = pu.resolution; ctx.camTan = pu.tanHalfFov;
  ctx.camOrigin = pu.camOrigin; ctx.camRight = pu.camRight; ctx.camUp = pu.camUp; ctx.camForward = pu.camForward;
  return ctx;
}
fn phash(seed: f32) -> f32 { var x = fract(seed * 0.1031); x *= x + 33.33; x *= x + x; return fract(x); }
fn phash3(seed: f32) -> vec3f { return vec3f(phash(seed), phash(seed + 17.17), phash(seed + 43.43)); }
`;
const PARTICLE_DEFAULT_SPRITE = /* wgsl */`
fn particleSprite(uv: vec2f, p: Particle, ctx: ParticleContext) -> vec4f {
  let d = length(uv); let a = clamp(1.0 - d, 0.0, 1.0);
  return vec4f(p.color, p.alpha * a * a);
}
`;
const FX_FOOTER = `
@fragment fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  var ctx: FxContext;
  ctx.uv = input.uv;
  ctx.coord = input.position.xy;
  ctx.resolution = fxUniform.resolution;
  ctx.mediaTime = fxUniform.mediaTime;
  ctx.duration = fxUniform.duration;
  ctx.progress = fxUniform.progress;
  ctx.elapsed = fxUniform.elapsed;
  ctx.frame = fxUniform.frame;
  ctx.deltaTime = fxUniform.deltaTime;
  ctx.seed = fxUniform.seed;
  ctx.params = fxUniform.params;
  ctx.paramsB = fxUniform.paramsB;
  ctx.paramsC = fxUniform.paramsC;
  ctx.paramsD = fxUniform.paramsD;
  ctx.camOrigin = fxUniform.camOrigin;
  ctx.camRight = fxUniform.camRight;
  ctx.camUp = fxUniform.camUp;
  ctx.camForward = fxUniform.camForward;
  ctx.tanHalfFov = fxUniform.tanHalfFov;
  ctx.aspect = fxUniform.aspect;
  ctx.historyMix = fxUniform.historyMix;
  return fx(ctx);
}
`;
interface CompiledEffect {
  definition: ShaderEffectDefinition;
  pipeline: GPURenderPipeline;
  uniform: GPUBuffer;
  historyTexture: GPUTexture | null;
  historyView: GPUTextureView | null;
  historyValid: boolean;
  historyWidth: number;
  historyHeight: number;
  particleBuffer: GPUBuffer | null;
  particleUniform: GPUBuffer | null;
  particleComputePipeline: GPUComputePipeline | null;
  particleRenderPipeline: GPURenderPipeline | null;
  particleComputeLayout: GPUBindGroupLayout | null;
  particleRenderLayout: GPUBindGroupLayout | null;
  particleCount: number;
  particleNeedsInit: boolean;
  lastMediaTime: number;
}
function destroyEffectResources(effect: CompiledEffect): void {
  effect.uniform.destroy();
  effect.historyTexture?.destroy();
  effect.particleBuffer?.destroy();
  effect.particleUniform?.destroy();
}
function particleAgentCode(definition: ShaderEffectDefinition): string {
  const code = definition.particleCode ?? '';
  return /\bfn\s+particleSprite\s*\(/.test(code) ? code : PARTICLE_DEFAULT_SPRITE + '\n' + code;
}
function buildParticleComputeWGSL(definition: ShaderEffectDefinition): string {
  return PARTICLE_COMMON + '\n' + particleAgentCode(definition) + /* wgsl */`
@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> pu: ParticleUniform;
@group(0) @binding(2) var pMaskTexture: texture_2d<f32>;
fn maskAtParticle(uv: vec2f) -> f32 {
  let dims = vec2f(textureDimensions(pMaskTexture));
  let xy = vec2u(clamp(uv, vec2f(0.0), vec2f(0.999)) * dims);
  return textureLoad(pMaskTexture, xy, 0).r;
}
@compute @workgroup_size(256) fn particleMain(@builtin(global_invocation_id) gid: vec3u) {
  let count = u32(pu.count);
  if (gid.x >= count) { return; }
  let ctx = makeParticleCtx(pu);
  if (pu.reset > 0.5) {
    particles[gid.x] = particleInit(gid.x, ctx);
  } else {
    var p = particles[gid.x];
    p.age += pu.deltaTime;
    particles[gid.x] = particleUpdate(p, ctx);
  }
}
`;
}
function buildParticleRenderWGSL(definition: ShaderEffectDefinition): string {
  return PARTICLE_COMMON + '\n' + particleAgentCode(definition) + /* wgsl */`
@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> pu: ParticleUniform;
@group(0) @binding(2) var pMaskTexture: texture_2d<f32>;
fn maskAtParticle(uv: vec2f) -> f32 {
  let dims = vec2f(textureDimensions(pMaskTexture));
  let xy = vec2u(clamp(uv, vec2f(0.0), vec2f(0.999)) * dims);
  return textureLoad(pMaskTexture, xy, 0).r;
}
struct ParticleVOut {
  @builtin(position) position: vec4f,
  @location(0) spriteUv: vec2f,
  @location(1) color: vec3f,
  @location(2) misc: vec4f,
  @location(3) pPos: vec3f,
  @location(4) pVel: vec3f,
};
@vertex fn particleVertex(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> ParticleVOut {
  let p = particles[ii];
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let corner = corners[vi];
  let size = select(pu.pointSize, p.size, p.size > 0.0);
  let world = p.pos + (pu.camRight * corner.x + pu.camUp * corner.y) * size * 0.5;
  let rel = world - pu.camOrigin;
  let vz = dot(rel, pu.camForward);
  var out: ParticleVOut;
  out.spriteUv = corner;
  out.color = p.color;
  out.misc = vec4f(p.alpha, p.seed, p.age, p.life);
  out.pPos = p.pos;
  out.pVel = p.vel;
  if (vz <= 0.05 || p.alpha <= 0.0 || (p.life > 0.0 && p.age > p.life)) {
    out.position = vec4f(2.0, 2.0, 2.0, 1.0);
    return out;
  }
  let vx = dot(rel, pu.camRight) / (pu.tanHalfFov * pu.aspect);
  let vy = dot(rel, pu.camUp) / pu.tanHalfFov;
  out.position = vec4f(vx, vy, 0.0, vz);
  return out;
}
@fragment fn particleFragment(input: ParticleVOut) -> @location(0) vec4f {
  var p: Particle;
  p.pos = input.pPos; p.vel = input.pVel; p.color = input.color;
  p.alpha = input.misc.x; p.seed = input.misc.y; p.age = input.misc.z; p.life = input.misc.w;
  p.size = pu.pointSize; p.id = 0.0;
  let ctx = makeParticleCtx(pu);
  return particleSprite(input.spriteUv, p, ctx);
}
`;
}

const state: PlayerState = {
  phase: 'starting',
  message: 'Initialising WebGPU',
  fileName: '',
  duration: 0,
  mediaTime: 0,
  frameTimestamp: null,
  frameDuration: null,
  frameIndex: null,
  codedWidth: null,
  codedHeight: null,
  displayWidth: null,
  displayHeight: null,
  codec: null,
  decoderConfig: null,
  hardwareAcceleration: null,
  frameRate: null,
  bufferedFrames: 0,
  decodedFrames: 0,
  maskPrompt: null,
  maskFrames: 0,
};

function postState(phase?: PlayerPhase, message?: string): void {
  if (phase) state.phase = phase;
  if (message) state.message = message;
  scope.postMessage({ type: 'state', state: { ...state } } satisfies WorkerEvent);
}
function postError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  state.phase = 'error';
  state.message = message;
  scope.postMessage({ type: 'error', message } satisfies WorkerEvent);
  postState();
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function frameSeconds(frame: VideoFrame): number {
  return frame.timestamp / 1_000_000;
}
function frameEndSeconds(frame: VideoFrame): number {
  return frameSeconds(frame) + (frame.duration ?? 0) / 1_000_000;
}

class GpuPresenter {
  private canvas: OffscreenCanvas | null = null;
  private context: GPUCanvasContext | null = null;
  private device: GPUDevice | null = null;
  private directPipeline: GPURenderPipeline | null = null;
  private ingestPipeline: GPURenderPipeline | null = null;
  private blitPipeline: GPURenderPipeline | null = null;
  private sampler: GPUSampler | null = null;
  private format: GPUTextureFormat = 'bgra8unorm';
  private workFormat: GPUTextureFormat = 'rgba8unorm';
  private workTextures: GPUTexture[] = [];
  private workWidth = 0;
  private workHeight = 0;
  private effects: CompiledEffect[] = [];
  private fxLayout: GPUBindGroupLayout | null = null;
  private fxPipelineLayout: GPUPipelineLayout | null = null;
  private frameCounter = 0;
  private clipDuration = 0;
  private maskTexture: GPUTexture | null = null;
  private maskView: GPUTextureView | null = null;
  private maskWidth = 1;
  private maskHeight = 1;
  private maskFrames = new Map<number, Uint8Array>();
  private maskFrameNumbers: number[] = [];
  private uploadedMaskFrame = -2;
  private dummyHistoryTexture: GPUTexture | null = null;
  private dummyHistoryView: GPUTextureView | null = null;
  private lastPresentTime = -1;

  setDuration(duration: number): void {
    this.clipDuration = duration;
  }
  private async compileModule(label: string, code: string): Promise<{ shaderModule: GPUShaderModule; errors: string[] }> {
    if (!this.device) throw new Error('GPU presenter is not initialised');
    const shaderModule = this.device.createShaderModule({ label, code });
    const compilation = await shaderModule.getCompilationInfo();
    const errors = compilation.messages
      .filter((m) => m.type === 'error')
      .map((m) => m.lineNum + ':' + m.linePos + ' ' + m.message);
    return { shaderModule, errors };
  }
  private createPipeline(label: string, shaderModule: GPUShaderModule, format: GPUTextureFormat): GPURenderPipeline {
    if (!this.device) throw new Error('GPU presenter is not initialised');
    return this.device.createRenderPipeline({
      label,
      layout: 'auto',
      vertex: { module: shaderModule, entryPoint: 'vertexMain' },
      fragment: { module: shaderModule, entryPoint: 'fragmentMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  async init(canvas: OffscreenCanvas): Promise<void> {
    this.canvas = canvas;
    if (!navigator.gpu) throw new Error('WebGPU is unavailable in this browser');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter available');
    this.device = await adapter.requestDevice();
    this.device.addEventListener('uncapturederror', (event) => {
      postError('WebGPU: ' + event.error.message);
    });
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) throw new Error('Could not create WebGPU canvas context');
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
    const external = await this.compileModule('present-external-frame', EXTERNAL_WGSL);
    if (external.errors.length) throw new Error(external.errors.join(' | '));
    const blit = await this.compileModule('blit-work-texture', BLIT_WGSL);
    if (blit.errors.length) throw new Error(blit.errors.join(' | '));
    this.directPipeline = this.createPipeline('present-external-frame', external.shaderModule, this.format);
    this.ingestPipeline = this.createPipeline('ingest-external-frame', external.shaderModule, this.workFormat);
    this.blitPipeline = this.createPipeline('blit-work-texture', blit.shaderModule, this.format);
    this.sampler = this.device.createSampler({ label: 'frame-linear', magFilter: 'linear', minFilter: 'linear' });
    this.fxLayout = this.device.createBindGroupLayout({
      label: 'fx-bindings',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
      ],
    });
    this.dummyHistoryTexture = this.device.createTexture({
      label: 'fx-history-dummy', size: { width: 1, height: 1 }, format: this.workFormat,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.dummyHistoryView = this.dummyHistoryTexture.createView();
    this.fxPipelineLayout = this.device.createPipelineLayout({
      label: 'fx-pipeline-layout',
      bindGroupLayouts: [this.fxLayout],
    });
    this.ensureMaskTexture(1, 1);
    this.device.queue.writeTexture(
      { texture: this.maskTexture! },
      new Uint8Array([255]),
      { bytesPerRow: 1 },
      { width: 1, height: 1 },
    );
  }

  private ensureMaskTexture(width: number, height: number): void {
    if (!this.device) return;
    if (this.maskTexture && this.maskWidth === width && this.maskHeight === height) return;
    this.maskTexture?.destroy();
    this.maskTexture = this.device.createTexture({
      label: 'sam-mask',
      size: { width, height },
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.maskView = this.maskTexture.createView();
    this.maskWidth = width;
    this.maskHeight = height;
    this.uploadedMaskFrame = -2;
  }

  setMaskTrack(track: MaskTrackData): void {
    this.maskFrames = new Map(track.frames.map((f) => [f.frame, new Uint8Array(f.data)]));
    this.maskFrameNumbers = [...this.maskFrames.keys()].sort((a, b) => a - b);
    this.ensureMaskTexture(track.maskWidth, track.maskHeight);
    this.uploadedMaskFrame = -2;
  }

  clearMaskTrack(): void {
    this.maskFrames.clear();
    this.maskFrameNumbers = [];
    this.ensureMaskTexture(1, 1);
    if (this.device && this.maskTexture) {
      this.device.queue.writeTexture(
        { texture: this.maskTexture },
        new Uint8Array([255]),
        { bytesPerRow: 1 },
        { width: 1, height: 1 },
      );
    }
    this.uploadedMaskFrame = -2;
  }

  private uploadMaskForFrame(frameIndex: number | null): void {
    if (!this.device || !this.maskTexture || !this.maskFrameNumbers.length) return;
    let chosen = this.maskFrameNumbers[0];
    if (frameIndex !== null) {
      for (const candidate of this.maskFrameNumbers) {
        if (candidate <= frameIndex) chosen = candidate;
        else break;
      }
    }
    if (chosen === this.uploadedMaskFrame) return;
    const data = this.maskFrames.get(chosen);
    if (!data) return;
    this.device.queue.writeTexture(
      { texture: this.maskTexture },
      data,
      { bytesPerRow: this.maskWidth },
      { width: this.maskWidth, height: this.maskHeight },
    );
    this.uploadedMaskFrame = chosen;
  }

  private ensureHistory(effect: CompiledEffect, width: number, height: number): GPUTextureView {
    if (!this.device) return this.dummyHistoryView!;
    if (!effect.definition.history) return this.dummyHistoryView!;
    if (effect.historyTexture && effect.historyWidth === width && effect.historyHeight === height && effect.historyView) {
      return effect.historyView;
    }
    effect.historyTexture?.destroy();
    effect.historyTexture = this.device.createTexture({
      label: 'fx-history-' + effect.definition.id, size: { width, height }, format: this.workFormat,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    effect.historyView = effect.historyTexture.createView();
    effect.historyWidth = width; effect.historyHeight = height; effect.historyValid = false;
    return effect.historyView;
  }

  async upsertEffect(definition: ShaderEffectDefinition, dryRun = false): Promise<{ ok: boolean; message: string; errors: string[] }> {
    if (!this.device) return { ok: false, message: 'GPU presenter is not initialised', errors: [] };
    const errors: string[] = [];
    const kind = definition.kind ?? 'fragment';
    const hasParticles = kind === 'particles' || (definition.particles != null && (definition.particles?.count ?? 0) > 0);
    if (!definition.id || !definition.name) errors.push('Effect id and name are required');
    if (definition.code.length > 131072) errors.push('Shader code exceeds 131072 characters');
    if ((definition.particleCode?.length ?? 0) > 131072) errors.push('Particle code exceeds 131072 characters');
    if (!/\bfn\s+fx\s*\(\s*ctx\s*:\s*FxContext\s*\)\s*->\s*vec4f\b/.test(definition.code)) {
      errors.push('Shader must define fn fx(ctx: FxContext) -> vec4f');
    }
    const banned = ['@group', '@binding', '@vertex', '@fragment', '@compute', 'texture_external', 'fn fragmentMain', 'fn vertexMain', 'fn sourceAt', 'fn originalAt', 'fn maskAt', 'fn historyAt', 'fn prevAt', 'fn foreAt', 'fn backAt', 'fn layerUv', 'fn rayDir', 'fn worldToUv'];
    for (const b of banned) {
      if (definition.code.includes(b)) errors.push('Shader must not contain ' + b + '; the host owns bindings, entry points and helpers');
      if (definition.particleCode?.includes(b)) errors.push('Particle code must not contain ' + b + '; the host owns bindings and entry points');
    }
    for (const name of STDLIB_NAMES) {
      if (new RegExp('\\bfn\\s+' + name + '\\s*\\(').test(definition.code)) {
        errors.push('Shader must not redefine stdlib fn ' + name + '(); it is injected by the host (see get_shader_interface)');
      }
    }
    const allParams = [...definition.params, ...(definition.paramsB ?? []), ...(definition.paramsC ?? []), ...(definition.paramsD ?? [])];
    if (allParams.some((v) => !Number.isFinite(v))) errors.push('Effect params must be finite numbers');
    if (hasParticles) {
      const pc = definition.particleCode ?? '';
      if (!/\bfn\s+particleInit\s*\(\s*index\s*:\s*u32\s*,\s*ctx\s*:\s*ParticleContext\s*\)\s*->\s*Particle\b/.test(pc)) {
        errors.push('Particle code must define fn particleInit(index: u32, ctx: ParticleContext) -> Particle');
      }
      if (!/\bfn\s+particleUpdate\s*\(\s*p\s*:\s*Particle\s*,\s*ctx\s*:\s*ParticleContext\s*\)\s*->\s*Particle\b/.test(pc)) {
        errors.push('Particle code must define fn particleUpdate(p: Particle, ctx: ParticleContext) -> Particle');
      }
      const count = definition.particles?.count ?? 2000;
      if (!Number.isFinite(count) || count < 1 || count > 200000) errors.push('particles.count must be between 1 and 200000');
      const size = definition.particles?.size ?? 0.05;
      if (!Number.isFinite(size) || size <= 0 || size > 4) errors.push('particles.size must be in (0, 4]');
    }
    if (definition.camera !== null && definition.camera !== undefined) {
      const cam = definition.camera;
      const triplet = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
      if (!triplet(cam.from) || !triplet(cam.to)) errors.push('Camera from/to must be finite [x, y, z] triplets');
      if (cam.target !== undefined && !triplet(cam.target)) errors.push('Camera target must be a finite [x, y, z] triplet');
      if (cam.roll !== undefined && !Number.isFinite(cam.roll)) errors.push('Camera roll must be finite degrees');
      if (typeof cam.fov !== 'number' || !Number.isFinite(cam.fov) || cam.fov < 10 || cam.fov > 120) {
        errors.push('Camera fov must be between 10 and 120 degrees');
      }
    }
    if (definition.start !== null && definition.end !== null && definition.end <= definition.start) {
      errors.push('Effect end must be greater than start');
    }
    if (errors.length) return { ok: false, message: 'Shader rejected before compile', errors };
    const fullCode = FX_PRELUDE + '\n' + FX_STDLIB + '\n' + definition.code + '\n' + FX_FOOTER;
    const compiled = await this.compileModule('fx-' + definition.id, fullCode);
    if (compiled.errors.length) {
      const offset = (FX_PRELUDE + '\n' + FX_STDLIB).split('\n').length;
      const adjusted = compiled.errors.map((line) => line.replace(/^(\d+):/, (_, n) => String(Math.max(1, Number(n) - offset)) + ':'));
      return { ok: false, message: 'WGSL compile failed', errors: adjusted };
    }
    // Particle modules compile-check even on dry runs so the agent iterates on real errors.
    let particleComputeModule: GPUShaderModule | null = null;
    let particleRenderModule: GPUShaderModule | null = null;
    if (hasParticles) {
      const pOffset = PARTICLE_COMMON.split('\n').length + 8;
      const adjustP = (errs: string[]) => errs.map((line) => line.replace(/^(\d+):/, (_, n) => String(Math.max(1, Number(n) - pOffset)) + ':'));
      const cc = await this.compileModule('fx-particles-compute-' + definition.id, buildParticleComputeWGSL(definition));
      if (cc.errors.length) return { ok: false, message: 'Particle compute WGSL compile failed', errors: adjustP(cc.errors) };
      particleComputeModule = cc.shaderModule;
      const rc = await this.compileModule('fx-particles-render-' + definition.id, buildParticleRenderWGSL(definition));
      if (rc.errors.length) return { ok: false, message: 'Particle render WGSL compile failed', errors: adjustP(rc.errors) };
      particleRenderModule = rc.shaderModule;
    }
    if (dryRun) return { ok: true, message: 'Dry-run compile OK: ' + definition.name + (hasParticles ? ' (fragment + particles)' : ''), errors: [] };
    if (!this.fxPipelineLayout) return { ok: false, message: 'FX pipeline layout is not initialised', errors: [] };
    const pipeline = this.device.createRenderPipeline({
      label: 'fx-' + definition.id,
      layout: this.fxPipelineLayout,
      vertex: { module: compiled.shaderModule, entryPoint: 'vertexMain' },
      fragment: { module: compiled.shaderModule, entryPoint: 'fragmentMain', targets: [{ format: this.workFormat }] },
      primitive: { topology: 'triangle-list' },
    });
    const at = this.effects.findIndex((e) => e.definition.id === definition.id);
    const existing = at >= 0 ? this.effects[at] : null;
    if (existing) destroyEffectResources(existing);
    const uniform = this.device.createBuffer({
      label: 'fx-uniform-' + definition.id, size: FX_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const next: CompiledEffect = {
      definition: {
        ...definition, kind, params: [...definition.params],
        paramsB: definition.paramsB ? [...definition.paramsB] : undefined,
        paramsC: definition.paramsC ? [...definition.paramsC] : undefined,
        paramsD: definition.paramsD ? [...definition.paramsD] : undefined,
      },
      pipeline, uniform,
      historyTexture: null, historyView: null, historyValid: false, historyWidth: 0, historyHeight: 0,
      particleBuffer: null, particleUniform: null, particleComputePipeline: null, particleRenderPipeline: null,
      particleComputeLayout: null, particleRenderLayout: null,
      particleCount: 0, particleNeedsInit: true, lastMediaTime: -1,
    };
    if (hasParticles && particleComputeModule && particleRenderModule && this.device) {
      const count = Math.floor(definition.particles?.count ?? 2000);
      next.particleCount = count;
      next.particleBuffer = this.device.createBuffer({
        label: 'fx-particles-' + definition.id, size: count * 64,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      next.particleUniform = this.device.createBuffer({
        label: 'fx-particle-uniform-' + definition.id, size: 176,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      next.particleComputeLayout = this.device.createBindGroupLayout({
        label: 'fx-particle-compute-layout',
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d' } },
        ],
      });
      next.particleRenderLayout = this.device.createBindGroupLayout({
        label: 'fx-particle-render-layout',
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        ],
      });
      next.particleComputePipeline = this.device.createComputePipeline({
        label: 'fx-particles-compute-' + definition.id,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [next.particleComputeLayout] }),
        compute: { module: particleComputeModule, entryPoint: 'particleMain' },
      });
      const blending: GPUBlendState = (definition.particles?.blending ?? 'normal') === 'additive'
        ? { color: { srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } }
        : { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };
      next.particleRenderPipeline = this.device.createRenderPipeline({
        label: 'fx-particles-render-' + definition.id,
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [next.particleRenderLayout] }),
        vertex: { module: particleRenderModule, entryPoint: 'particleVertex' },
        fragment: { module: particleRenderModule, entryPoint: 'particleFragment', targets: [{ format: this.workFormat, blend: blending }] },
        primitive: { topology: 'triangle-list' },
      });
    }
    if (at >= 0) this.effects[at] = next;
    else this.effects.push(next);
    return { ok: true, message: 'Compiled and active: ' + definition.name + (hasParticles ? ' + GPU particles x' + next.particleCount : '') + (definition.history ? ' + history feedback' : ''), errors: [] };
  }
  removeEffect(effectId: string): boolean {
    const at = this.effects.findIndex((e) => e.definition.id === effectId);
    if (at < 0) return false;
    destroyEffectResources(this.effects[at]);
    this.effects.splice(at, 1);
    return true;
  }
  clearEffects(): void {
    for (const effect of this.effects) destroyEffectResources(effect);
    this.effects = [];
  }
  listEffects(): ShaderEffectDefinition[] {
    return this.effects.map((e) => ({ ...e.definition, params: [...e.definition.params] }));
  }
  private ensureWorkTextures(width: number, height: number): void {
    if (!this.device || (this.workWidth === width && this.workHeight === height && this.workTextures.length === 3)) return;
    for (const texture of this.workTextures) texture.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    this.workTextures = [0, 1, 2].map((i) => this.device!.createTexture({
      label: 'fx-work-' + i,
      size: { width, height },
      format: this.workFormat,
      usage,
    }));
    this.workWidth = width;
    this.workHeight = height;
  }
  private drawPass(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    entries: GPUBindGroupEntry[],
    destination: GPUTextureView,
  ): void {
    if (!this.device) return;
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: destination, loadOp: 'clear', storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
    pass.draw(3);
    pass.end();
  }

  present(frame: VideoFrame, frameIndex: number | null = null): void {
    if (!this.canvas || !this.context || !this.device || !this.directPipeline || !this.ingestPipeline
      || !this.blitPipeline || !this.sampler) {
      throw new Error('GPU presenter is not initialised');
    }
    this.frameCounter += 1;
    this.uploadMaskForFrame(frameIndex);
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
      this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
    }
    const mediaTime = frameSeconds(frame);
    const active = this.effects.filter((effect) => {
      const d = effect.definition;
      if (!d.enabled) return false;
      if (d.start !== null && mediaTime < d.start) return false;
      if (d.end !== null && mediaTime >= d.end) return false;
      return true;
    });
    const external = this.device.importExternalTexture({ label: 'decoded-frame', source: frame });
    const encoder = this.device.createCommandEncoder({ label: 'present-decoded-frame' });
    const canvasView = this.context.getCurrentTexture().createView();
    if (!active.length) {
      this.drawPass(encoder, this.directPipeline, [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: external },
      ], canvasView);
      this.device.queue.submit([encoder.finish()]);
      return;
    }
    this.ensureWorkTextures(frame.displayWidth, frame.displayHeight);
    const originalView = this.workTextures[0].createView();
    this.drawPass(encoder, this.ingestPipeline, [
      { binding: 0, resource: this.sampler },
      { binding: 1, resource: external },
    ], originalView);
    let sourceView = originalView;
    let destinationIndex = 1;
    for (const effect of active) {
      const d = effect.definition;
      const elapsed = d.start === null ? mediaTime : Math.max(0, mediaTime - d.start);
      const progress = d.start !== null && d.end !== null && d.end > d.start
        ? Math.max(0, Math.min(1, (mediaTime - d.start) / (d.end - d.start)))
        : 0;
      const camProgress = d.start !== null && d.end !== null && d.end > d.start
        ? progress
        : (this.clipDuration > 0 ? Math.max(0, Math.min(1, mediaTime / this.clipDuration)) : 0);
      const eased = camProgress * camProgress * (3 - 2 * camProgress);
      const camFrom: [number, number, number] = d.camera?.from ?? [0, 0, 3];
      const camTo: [number, number, number] = d.camera?.to ?? [0, 0, 3];
      const camPos: [number, number, number] = [
        camFrom[0] + (camTo[0] - camFrom[0]) * eased,
        camFrom[1] + (camTo[1] - camFrom[1]) * eased,
        camFrom[2] + (camTo[2] - camFrom[2]) * eased,
      ];
      const tanHalfFov = d.camera
        ? Math.tan((d.camera.fov * Math.PI / 180) / 2)
        : 1 / Math.max(camPos[2], 0.001);
      const target: [number, number, number] = d.camera?.target ?? [0, 0, 0];
      let forward: [number, number, number] = [target[0] - camPos[0], target[1] - camPos[1], target[2] - camPos[2]];
      const fLen = Math.hypot(forward[0], forward[1], forward[2]);
      if (fLen < 1e-6) forward = [0, 0, -1];
      else forward = [forward[0] / fLen, forward[1] / fLen, forward[2] / fLen];
      // right = normalize(cross(forward, worldUp(0,1,0))); up = cross(right, forward)
      let right: [number, number, number] = [-forward[2], 0, forward[0]];
      const rLen = Math.hypot(right[0], right[1], right[2]);
      if (rLen < 1e-6) right = [1, 0, 0];
      else { right = [right[0] / rLen, right[1] / rLen, right[2] / rLen]; }
      let up: [number, number, number] = [
        right[1] * forward[2] - right[2] * forward[1],
        right[2] * forward[0] - right[0] * forward[2],
        right[0] * forward[1] - right[1] * forward[0],
      ];
      const rollRad = ((d.camera?.roll ?? 0) * Math.PI) / 180;
      if (rollRad !== 0) {
        const c = Math.cos(rollRad); const s = Math.sin(rollRad);
        const nr: [number, number, number] = [
          right[0] * c + up[0] * s, right[1] * c + up[1] * s, right[2] * c + up[2] * s,
        ];
        up = [-right[0] * s + up[0] * c, -right[1] * s + up[1] * c, -right[2] * s + up[2] * c];
        right = nr;
      }
      const aspect = frame.displayWidth / Math.max(frame.displayHeight, 1);
      // Temporal state: delta clamps seek jumps; discontinuity resets history + particles.
      const rawDelta = effect.lastMediaTime >= 0 ? mediaTime - effect.lastMediaTime : 1 / 60;
      const discontinuity = rawDelta < -0.001 || rawDelta > 0.25;
      const deltaTime = discontinuity ? 1 / 60 : Math.min(Math.max(rawDelta, 0), 0.1);
      if (discontinuity) { effect.historyValid = false; effect.particleNeedsInit = true; }
      effect.lastMediaTime = mediaTime;
      const seed = d.seed ?? 0;
      const pb = d.paramsB ?? [0, 0, 0, 0]; const pc2 = d.paramsC ?? [0, 0, 0, 0]; const pd = d.paramsD ?? [0, 0, 0, 0];
      const historyView = this.ensureHistory(effect, frame.displayWidth, frame.displayHeight);
      const uniformData = new Float32Array([
        frame.displayWidth, frame.displayHeight, mediaTime, this.clipDuration,
        progress, elapsed, this.frameCounter, deltaTime,
        d.params[0], d.params[1], d.params[2], d.params[3],
        pb[0], pb[1], pb[2], pb[3], pc2[0], pc2[1], pc2[2], pc2[3], pd[0], pd[1], pd[2], pd[3],
        camPos[0], camPos[1], camPos[2], tanHalfFov,
        right[0], right[1], right[2], aspect,
        up[0], up[1], up[2], seed,
        forward[0], forward[1], forward[2], effect.historyValid ? 1 : 0,
      ]);
      this.device.queue.writeBuffer(effect.uniform, 0, uniformData);
      const destinationTexture = this.workTextures[destinationIndex];
      const destination = destinationTexture.createView();
      this.drawPass(encoder, effect.pipeline, [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: sourceView },
        { binding: 2, resource: originalView },
        { binding: 3, resource: { buffer: effect.uniform } },
        { binding: 4, resource: this.maskView! },
        { binding: 5, resource: d.history ? historyView : this.dummyHistoryView! },
      ], destination);
      if (d.history && effect.historyTexture) {
        encoder.copyTextureToTexture({ texture: destinationTexture }, { texture: effect.historyTexture },
          { width: frame.displayWidth, height: frame.displayHeight });
        effect.historyValid = true;
      }
      // GPU particles: compute simulation then billboard sprites into the same destination.
      if (effect.particleBuffer && effect.particleUniform && effect.particleComputePipeline
        && effect.particleRenderPipeline && effect.particleComputeLayout && effect.particleRenderLayout) {
        const pCount = effect.particleCount;
        const pData = new Float32Array(44);
        pData.set(uniformData.subarray(0, FX_UNIFORM_FLOATS), 0);
        pData[40] = pCount; pData[41] = d.particles?.size ?? 0.05; pData[42] = effect.particleNeedsInit ? 1 : 0; pData[43] = 0;
        this.device.queue.writeBuffer(effect.particleUniform, 0, pData);
        const computePass = encoder.beginComputePass({ label: 'fx-particles-compute' });
        computePass.setPipeline(effect.particleComputePipeline);
        computePass.setBindGroup(0, this.device.createBindGroup({
          layout: effect.particleComputeLayout,
          entries: [
            { binding: 0, resource: { buffer: effect.particleBuffer } },
            { binding: 1, resource: { buffer: effect.particleUniform } },
            { binding: 2, resource: this.maskView! },
          ],
        }));
        computePass.dispatchWorkgroups(Math.ceil(pCount / 256));
        computePass.end();
        effect.particleNeedsInit = false;
        const renderPass = encoder.beginRenderPass({
          colorAttachments: [{ view: destination, loadOp: 'load', storeOp: 'store' }],
        });
        renderPass.setPipeline(effect.particleRenderPipeline);
        renderPass.setBindGroup(0, this.device.createBindGroup({
          layout: effect.particleRenderLayout,
          entries: [
            { binding: 0, resource: { buffer: effect.particleBuffer } },
            { binding: 1, resource: { buffer: effect.particleUniform } },
            { binding: 2, resource: this.maskView! },
          ],
        }));
        renderPass.draw(6, pCount);
        renderPass.end();
      }
      sourceView = destination;
      destinationIndex = destinationIndex === 1 ? 2 : 1;
    }
    this.drawPass(encoder, this.blitPipeline, [
      { binding: 0, resource: this.sampler },
      { binding: 1, resource: sourceView },
    ], canvasView);
    this.device.queue.submit([encoder.finish()]);
  }
}

class FramePlayer {
  private presenter = new GpuPresenter();
  private input: Input | null = null;
  private track: InputVideoTrack | null = null;
  private sink: EncodedPacketSink | null = null;
  private decoder: VideoDecoder | null = null;
  private decoderConfig: VideoDecoderConfig | null = null;
  private nextPacket: EncodedPacket | null = null;
  private packetsDone = false;
  private flushStarted = false;
  private queue: VideoFrame[] = [];
  private generation = 0;
  private feeding = false;
  private playing = false;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private playStartedAt = 0;
  private playStartedMedia = 0;
  private firstTimestamp = 0;
  private lastStatePost = 0;
  private lastPresented: VideoFrame | null = null;

  async init(canvas: OffscreenCanvas): Promise<void> {
    await this.presenter.init(canvas);
    postState('idle', 'Choose a video file');
  }

  private clearQueue(): void {
    for (const frame of this.queue) frame.close();
    this.queue = [];
    state.bufferedFrames = 0;
  }
  private closeMedia(): void {
    this.generation += 1;
    this.stopClock();
    this.playing = false;
    this.lastPresented?.close();
    this.lastPresented = null;
    this.clearQueue();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.input?.dispose();
    this.input = null;
    this.track = null;
    this.sink = null;
    this.nextPacket = null;
    this.packetsDone = false;
    this.flushStarted = false;
  }
  private makeDecoder(): VideoDecoder {
    const decoder = new VideoDecoder({
      output: (frame) => {
        state.decodedFrames += 1;
        const timestamp = frameSeconds(frame);
        let at = this.queue.length;
        while (at > 0 && frameSeconds(this.queue[at - 1]) > timestamp) at -= 1;
        this.queue.splice(at, 0, frame);
        state.bufferedFrames = this.queue.length;
      },
      error: (error) => postError(error),
    });
    return decoder;
  }
  private async configureDecoder(): Promise<void> {
    if (!this.track) throw new Error('No video track loaded');
    const base = await this.track.getDecoderConfig();
    if (!base) throw new Error('Mediabunny could not produce a VideoDecoderConfig for this track');
    const candidates: VideoDecoderConfig[] = [
      { ...base, hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true },
      { ...base, optimizeForLatency: true },
      { ...base },
    ];
    let chosen: VideoDecoderConfig | null = null;
    for (const candidate of candidates) {
      const support = await VideoDecoder.isConfigSupported(candidate);
      if (support.supported && support.config) {
        chosen = support.config;
        break;
      }
    }
    if (!chosen) throw new Error('This browser cannot decode codec ' + base.codec);
    this.decoderConfig = chosen;
    this.decoder?.configure(chosen);
    state.decoderConfig = chosen.codec + ' ' + chosen.codedWidth + 'x' + chosen.codedHeight;
    state.hardwareAcceleration = chosen.hardwareAcceleration ?? 'browser default';
  }

  async load(file: File): Promise<void> {
    this.closeMedia();
    const generation = ++this.generation;
    state.fileName = file.name;
    state.duration = 0;
    state.mediaTime = 0;
    state.frameTimestamp = null;
    state.frameDuration = null;
    state.frameIndex = null;
    state.decodedFrames = 0;
    postState('loading', 'Demuxing ' + file.name);
    this.input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    if (!(await this.input.canRead())) throw new Error('Mediabunny cannot read this file');
    const track = await this.input.getPrimaryVideoTrack();
    if (!track) throw new Error('No primary video track found');
    if (generation !== this.generation) return;
    this.track = track;
    this.sink = new EncodedPacketSink(track);
    this.decoder = this.makeDecoder();
    const [duration, firstTimestamp, codec, codedWidth, codedHeight, displayWidth, displayHeight, metrics] =
      await Promise.all([
        this.input.computeDuration(),
        track.getFirstTimestamp(),
        track.getCodec(),
        track.getCodedWidth(),
        track.getCodedHeight(),
        track.getDisplayWidth(),
        track.getDisplayHeight(),
        track.computeFrameRateMetrics({ targetPacketCount: 256 }),
      ]);
    if (generation !== this.generation) return;
    this.firstTimestamp = firstTimestamp;
    this.presenter.setDuration(duration);
    state.duration = duration;
    state.codedWidth = codedWidth;
    state.codedHeight = codedHeight;
    state.displayWidth = displayWidth;
    state.displayHeight = displayHeight;
    state.codec = codec;
    state.frameRate = metrics.bestGuessFrameRate;
    await this.configureDecoder();
    await this.seekInternal(firstTimestamp, generation);
    if (generation === this.generation) postState('paused', 'Loaded. First frame presented.');
  }

  private async feedOnePacket(generation: number): Promise<boolean> {
    if (generation !== this.generation || !this.decoder || !this.sink || !this.nextPacket) return false;
    const packet = this.nextPacket;
    this.decoder.decode(packet.toEncodedVideoChunk());
    const nextPacket = await this.sink.getNextPacket(packet);
    if (generation !== this.generation) return false;
    this.nextPacket = nextPacket;
    if (!this.nextPacket) this.packetsDone = true;
    return true;
  }
  private async ensureBuffered(targetFrames: number, generation: number): Promise<void> {
    if (this.feeding) return;
    this.feeding = true;
    try {
      while (generation === this.generation && this.decoder) {
        const inFlight = this.queue.length + this.decoder.decodeQueueSize;
        if (inFlight >= targetFrames) break;
        if (this.nextPacket) {
          await this.feedOnePacket(generation);
          continue;
        }
        if (this.packetsDone && !this.flushStarted && this.decoder.state === 'configured') {
          this.flushStarted = true;
          await this.decoder.flush();
        }
        break;
      }
    } finally {
      this.feeding = false;
      state.bufferedFrames = this.queue.length;
    }
  }

  private displayFrame(frame: VideoFrame, mediaTime: number): void {
    const timestamp = frameSeconds(frame);
    const duration = frame.duration === null ? null : frame.duration / 1_000_000;
    const frameIndex = state.frameRate
      ? Math.round((timestamp - this.firstTimestamp) * state.frameRate)
      : null;
    let retained: VideoFrame | null = null;
    try { retained = frame.clone(); } catch { retained = null; }
    try {
      this.presenter.present(frame, frameIndex);
    } finally {
      frame.close();
    }
    this.lastPresented?.close();
    this.lastPresented = retained;
    state.frameTimestamp = timestamp;
    state.frameDuration = duration;
    state.frameIndex = frameIndex;
    state.mediaTime = mediaTime;
    state.bufferedFrames = this.queue.length;
  }

  private async seekInternal(target: number, generation: number): Promise<void> {
    if (!this.decoder || !this.decoderConfig || !this.sink) return;
    if (this.feeding) postState('seeking', 'Seeking: waiting for buffer feed to stop');
    while (this.feeding && generation === this.generation) await sleep(1);
    if (generation !== this.generation || !this.decoder || !this.decoderConfig || !this.sink) return;
    const clamped = Math.max(this.firstTimestamp, Math.min(target, Math.max(this.firstTimestamp, state.duration)));
    this.stopClock();
    this.playing = false;
    this.clearQueue();
    this.decoder.reset();
    this.decoder.configure(this.decoderConfig);
    this.flushStarted = false;
    this.packetsDone = false;
    this.nextPacket = await this.sink.getKeyPacket(clamped, { verifyKeyPackets: true })
      ?? await this.sink.getFirstKeyPacket({ verifyKeyPackets: true });
    if (!this.nextPacket) throw new Error('No key packet found for seek');
    postState('seeking', 'Seeking from key ' + this.nextPacket.timestamp.toFixed(3) + ' to ' + clamped.toFixed(3));
    let candidateIndex = -1;
    let fedPackets = 0;
    while (generation === this.generation) {
      while (this.queue.length > 1 && frameSeconds(this.queue[1]) <= clamped + 0.0000001) {
        this.queue.shift()?.close();
      }
      candidateIndex = -1;
      for (let i = 0; i < this.queue.length; i += 1) {
        if (frameSeconds(this.queue[i]) <= clamped + 0.0000001) candidateIndex = i;
      }
      if (candidateIndex >= 0) {
        const candidate = this.queue[candidateIndex];
        const hasNext = candidateIndex + 1 < this.queue.length;
        const drainedAtEnd = this.packetsDone && this.flushStarted && this.decoder.decodeQueueSize === 0;
        if (frameEndSeconds(candidate) > clamped + 0.0000001 || hasNext || drainedAtEnd) break;
      }
      if (this.decoder.decodeQueueSize >= 8) {
        await sleep(2);
        continue;
      }
      if (this.nextPacket) {
        await this.feedOnePacket(generation);
        fedPackets += 1;
        if (fedPackets % 20 === 0) {
          postState('seeking', 'Seeking: fed ' + fedPackets + ', buffered ' + this.queue.length
            + ', decoder queue ' + this.decoder.decodeQueueSize);
        }
        await sleep(0);
        continue;
      }
      if (this.packetsDone && !this.flushStarted && this.decoder.state === 'configured') {
        this.flushStarted = true;
        await this.decoder.flush();
        continue;
      }
      break;
    }
    if (generation !== this.generation) return;
    if (candidateIndex < 0 && this.queue.length) candidateIndex = this.queue.length - 1;
    if (candidateIndex < 0) throw new Error('Decoder produced no frame for seek target ' + clamped.toFixed(3));
    for (let i = 0; i < candidateIndex; i += 1) this.queue.shift()?.close();
    const frame = this.queue.shift();
    if (!frame) throw new Error('Seek frame disappeared from decode queue');
    const start = frameSeconds(frame);
    const end = frameEndSeconds(frame);
    const mediaTime = end > start ? Math.max(start, Math.min(clamped, end)) : start;
    this.displayFrame(frame, mediaTime);
  }
  async seek(time: number): Promise<void> {
    if (!this.decoder) return;
    const generation = ++this.generation;
    postState('seeking', 'Seeking to ' + time.toFixed(3) + ' s');
    await this.seekInternal(time, generation);
    if (generation === this.generation) postState('paused', 'Seek complete');
  }

  private stopClock(): void {
    if (this.clockTimer !== null) clearInterval(this.clockTimer);
    this.clockTimer = null;
  }
  private currentClockTime(): number {
    if (!this.playing) return state.mediaTime;
    return this.playStartedMedia + (performance.now() - this.playStartedAt) / 1000;
  }
  async play(): Promise<void> {
    if (!this.decoder || this.playing) return;
    if (state.phase === 'ended') await this.seek(this.firstTimestamp);
    this.playing = true;
    this.playStartedAt = performance.now();
    this.playStartedMedia = state.mediaTime;
    const generation = this.generation;
    void this.ensureBuffered(8, generation);
    this.stopClock();
    this.clockTimer = setInterval(() => this.tick(), 4);
    postState('playing', 'Playing');
  }
  pause(): void {
    if (this.playing) state.mediaTime = Math.min(this.currentClockTime(), state.duration || this.currentClockTime());
    this.playing = false;
    this.stopClock();
    if (state.phase !== 'ended') postState('paused', 'Paused');
    else postState();
  }
  private tick(): void {
    if (!this.playing) return;
    const generation = this.generation;
    const mediaTime = Math.min(this.currentClockTime(), state.duration || this.currentClockTime());
    state.mediaTime = mediaTime;
    void this.ensureBuffered(8, generation);
    let changed = false;
    while (this.queue.length && frameSeconds(this.queue[0]) <= mediaTime + 0.000001) {
      const frame = this.queue.shift();
      if (!frame) break;
      if (this.queue.length && frameSeconds(this.queue[0]) <= mediaTime + 0.000001) {
        frame.close();
        continue;
      }
      this.displayFrame(frame, mediaTime);
      changed = true;
      break;
    }
    const atEnd = state.duration > 0 && mediaTime >= state.duration - 0.000001;
    if (atEnd && this.packetsDone && this.queue.length === 0) {
      this.playing = false;
      this.stopClock();
      postState('ended', 'End of media');
      return;
    }
    const now = performance.now();
    if (changed || now - this.lastStatePost > 100) {
      this.lastStatePost = now;
      postState('playing', 'Playing');
    }
  }
  async step(delta: 1 | -1): Promise<void> {
    if (!this.decoder) return;
    this.pause();
    if (delta < 0) {
      const base = state.frameTimestamp ?? state.mediaTime;
      await this.seek(Math.max(this.firstTimestamp, base - 0.000001));
      return;
    }
    const generation = this.generation;
    while (generation === this.generation && this.queue.length === 0) {
      await this.ensureBuffered(4, generation);
      await sleep(1);
      if (this.packetsDone && this.flushStarted && this.decoder.decodeQueueSize === 0) break;
    }
    const frame = this.queue.shift();
    if (!frame) {
      postState('ended', 'No next frame');
      return;
    }
    this.displayFrame(frame, frameSeconds(frame));
    postState('paused', 'Stepped one frame');
  }

  private replayLastFrame(): void {
    if (!this.lastPresented || this.playing) return;
    let copy: VideoFrame | null = null;
    try {
      copy = this.lastPresented.clone();
      this.presenter.present(copy, state.frameIndex);
    } catch (error) {
      postError(error);
    } finally {
      copy?.close();
    }
  }
  setMaskTrack(track: MaskTrackData): void {
    this.presenter.setMaskTrack(track);
    state.maskPrompt = track.prompt;
    state.maskFrames = track.frames.length;
    this.replayLastFrame();
    postState(undefined, 'SAM mask track active: ' + track.prompt + ' (' + track.frames.length + ' frames)');
  }
  clearMaskTrack(): void {
    this.presenter.clearMaskTrack();
    state.maskPrompt = null;
    state.maskFrames = 0;
    this.replayLastFrame();
    postState(undefined, 'SAM mask track cleared');
  }
  async upsertEffect(requestId: string, definition: ShaderEffectDefinition, dryRun = false): Promise<void> {
    const compiled = await this.presenter.upsertEffect(definition, dryRun);
    const result: EffectCompileResult = {
      requestId,
      effectId: definition.id,
      ok: compiled.ok,
      dryRun,
      message: compiled.message,
      errors: compiled.errors,
    };
    scope.postMessage({ type: 'effectResult', result } satisfies WorkerEvent);
    if (compiled.ok && !dryRun) {
      this.replayLastFrame();
      postState(state.phase === 'error' ? 'paused' : undefined, compiled.message);
    }
  }
  removeEffect(effectId: string): void {
    if (this.presenter.removeEffect(effectId)) {
      this.replayLastFrame();
      postState(undefined, 'Effect removed');
    }
  }
  clearEffects(): void {
    this.presenter.clearEffects();
    this.replayLastFrame();
    postState(undefined, 'All effects cleared');
  }
  listEffects(): ShaderEffectDefinition[] {
    return this.presenter.listEffects();
  }
}

const player = new FramePlayer();
let commandChain = Promise.resolve();
scope.addEventListener('message', (event: MessageEvent<WorkerCommand>) => {
  const command = event.data;
  commandChain = commandChain.then(async () => {
    try {
      switch (command.type) {
        case 'init': await player.init(command.canvas); break;
        case 'load': await player.load(command.file); break;
        case 'play': await player.play(); break;
        case 'pause': player.pause(); break;
        case 'seek': await player.seek(command.time); break;
        case 'step': await player.step(command.delta); break;
        case 'upsertEffect': await player.upsertEffect(command.requestId, command.effect, command.dryRun ?? false); break;
        case 'removeEffect': player.removeEffect(command.effectId); break;
        case 'clearEffects': player.clearEffects(); break;
        case 'setMaskTrack': player.setMaskTrack(command.track); break;
        case 'clearMaskTrack': player.clearMaskTrack(); break;
      }
    } catch (error) {
      postError(error);
    }
  });
});
