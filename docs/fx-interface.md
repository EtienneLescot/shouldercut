# Free-form shader FX interface v2 — the VFX bible

ShoulderCut has no built-in effects catalog. The product owns playback,
decode, texture lifetime, render targets, GPU buffers, compile checking
and effect ordering. The coding agent owns the effect itself: it writes
WGSL through MCP tools, receives compiler errors synchronously, and
iterates like a VFX artist with a live monitor.

Call `get_shader_interface` (MCP) to read this document inside a session.
Never guess a helper name: if it is not listed here, it does not exist.

## 1. Effect model

Effects run in creation order as passes over the decoded frame. Each
effect is one data record; there are no product features hidden behind
names.

```json
{
  "id": "sparks-1",
  "name": "orange sparks",
  "kind": "fragment | particles",
  "code": "fn fx(ctx: FxContext) -> vec4f { ... }",
  "particleCode": "fn particleInit(...) -> Particle { ... } ...",
  "params": [1, 0, 0, 0], "paramsB": [0,0,0,0],
  "paramsC": [0,0,0,0], "paramsD": [0,0,0,0],
  "history": false,
  "particles": { "count": 4000, "size": 0.04, "blending": "additive" },
  "seed": 0,
  "start": 2.0, "end": 5.0, "enabled": true,
  "camera": { "from": [0,0,3], "to": [0.4,0.1,1.8], "fov": 38,
              "target": [0,0,0], "roll": 0 }
}
```

- `start`/`end` may be null. Outside its range a pass is skipped.
- A failed compile never replaces the last working shader and never
  blanks the preview. Iterate freely with `validate_shader` (dry run,
  no visible change), then `apply_shader_effect` once.
- Updating an effect reuses its id; ordering is creation order.

## 2. Fragment contract

Agent `code` = optional helper functions/constants, then exactly one:

```wgsl
fn fx(ctx: FxContext) -> vec4f { return sourceAt(ctx.uv); }
```

The host prepends bindings + the stdlib (§4) and appends the real
`@fragment` entry point. Forbidden in `code` and `particleCode`:
`@group`, `@binding`, `@vertex`, `@fragment`, `@compute`,
`texture_external`, `fragmentMain`, `vertexMain`, and redefining any
host helper (§3) or stdlib function (§4).

### FxContext

| Field | Meaning |
|---|---|
| `ctx.uv` | Pixel in 0..1 video coordinates (y down) |
| `ctx.coord` | Pixel in pixel coordinates |
| `ctx.resolution` | Render target size in pixels |
| `ctx.mediaTime` | Source media timestamp, seconds |
| `ctx.duration` | Clip duration, seconds |
| `ctx.elapsed` | Seconds since range start (`mediaTime` if no start) |
| `ctx.progress` | 0..1 across start..end (0 if un-ranged) |
| `ctx.frame` | Presented frame counter |
| `ctx.deltaTime` | Seconds since previous presented frame (clamped; 1/60 after a seek) |
| `ctx.seed` | Free seed from the effect record |
| `ctx.params` `paramsB` `paramsC` `paramsD` | 16 free floats, yours to assign |
| `ctx.camOrigin/camRight/camUp/camForward` | Virtual camera basis (§7) |
| `ctx.tanHalfFov`, `ctx.aspect` | Projection factors |
| `ctx.historyMix` | 1 when `historyAt` holds a real previous frame, else 0 |

### Sampling helpers (fragment only)

| Helper | Meaning |
|---|---|
| `sourceAt(uv)` | Previous pass output (decoded frame for pass 1) |
| `originalAt(uv)` | Untouched decoded frame |
| `maskAt(uv)` | SAM mask: 1 = tracked object, 0 = background, 1 everywhere before any track |
| `historyAt(uv)` / `prevAt(uv)` | Previous output of **this** effect; black unless `history: true` |
| `foreAt(uv)` | `vec4(original.rgb, mask)` |
| `backAt(uv)` | Untouched frame (background layer) |
| `layerUv(uv, z)` | `(uv, valid)` of the pixel ray on world plane `z` (§6) |
| `rayDir(uv)` | Normalised world ray direction for a pixel |
| `worldToUv(p)` | `(uv, valid)` projecting a world point to screen |

All samplers clamp UV to 0..1. Sample at arbitrary UVs: warps, feedback,
chromatic offsets, blur, generation and compositing are all expressible.

## 3. Injected stdlib — do not redefine

Injected between the host prelude and your code, in fragment shaders
only. Constants: `SC_PI`, `SC_TAU`.

| Group | Functions |
|---|---|
| Hash/noise | `hash11(f32)`, `hash21(vec2f)`, `hash22(vec2f)->vec2f`, `hash31(vec3f)`, `noise2(vec2f)` value noise 0..1, `fbm2(p)` 5-octave, `fbm2r(p)` rotated fbm, `voronoiF1(p)->(F1, cellId)` |
| Math/anim | `rot2(angle)->mat2x2f`, `easeInQuad`, `easeOutQuad`, `easeInOut`, `easeOutCubic`, `easeOutBack`, `pulse(x, center, width)` |
| Colour | `luminance`, `hsv2rgb`, `rgb2hsv`, `satColor(c, amt)`, `contrastColor(c, amt)`, `hueShift(c, turns)`, `temperature(c, amt)`, `acesTonemap(c)`, `liftGammaGain(c, lift, gamma, gain)`, `vibrance(c, amt)` |
| SDF 2D | `sdCircle(p, r)`, `sdBox2(p, half)`, `sdSegment(p, a, b)`, `sdRing(p, r, w)` |
| SDF 3D | `sdSphere(p, r)`, `sdBox3(p, half)`, `sdTorus(p, (R, r))`, `smin(a, b, k)` smooth union |
| 3D/light | `intersectPlaneZ(ro, rd, z)->(pos, valid)`, `lightLambert(n, l)`, `lightSpec(n, view, l, shininess)`, `fresnelTerm(n, view, power)` |
| Image | `sourceBlur(uv, pxRadius)`, `originalBlur(uv, pxRadius)`, `maskBlur(uv, pxRadius)`, `sobelEdge(uv)`, `maskEdge(uv)` |
| Composite | `overBlend(fg, bg)` alpha-over, `blendScreen(a, b)`, `blendOverlay(base, blend)` |
| Sprites | `pointGlow(dist, radius)`, `starSprite(uv-1..1, spikes)` |

## 4. Writing 2D effects

Patterns that cover most requests:

- **Grade**: transform `sourceAt(ctx.uv).rgb` with `satColor`,
  `contrastColor`, `temperature`, `hueShift`, vignette via
  `length(ctx.uv - 0.5)`, grain via `hash21(ctx.coord + ctx.frame)`.
- **Warp/distort**: sample `sourceAt(ctx.uv + offset)` where offset comes
  from `noise2`/`fbm2` fields, mask edges, or SDF gradients.
- **Procedural overlay**: build shapes with 2D SDFs in aspect-corrected
  space `p = (uv - center) * vec2(aspect, 1)`, shade, then
  `overBlend(shape, base)` or additive `base.rgb + glow`.
- **Mask work**: after `track_object`, use `maskAt`, `maskBlur` for
  feathered isolation, `maskEdge` for outlines/glows around the object.
- **Formula particles** (cheap, static counts): grid/hash cells in the
  fragment shader animated by `ctx.elapsed`. Use real GPU particles
  (§5) whenever particles must move, collide, emit or persist.

Animate with `ctx.elapsed` for range-local motion and `ctx.progress`
for in/out envelopes (`easeOutCubic(progress)`, fades at both ends).

## 5. GPU particles — real simulation

`kind: "particles"` adds a host-owned GPU particle system rendered
**after** your `fx()` pass of the same effect, into the same frame:

- A compute shader simulates `particles.count` particles (1..200000)
  every presented frame in a storage buffer. No CPU readback.
- A billboard sprite pass draws them in world space (§6) with
  `particles.blending`: `"additive"` (fire, sparks, glow, magic) or
  `"normal"` (smoke, snow, confetti, debris).
- `particleCode` defines the behaviour. `fx()` still runs first: use it
  to prepare the background (often just `return sourceAt(ctx.uv);`).

```wgsl
fn particleInit(index: u32, ctx: ParticleContext) -> Particle
fn particleUpdate(p: Particle, ctx: ParticleContext) -> Particle
// optional; a soft round sprite is used when omitted:
fn particleSprite(uv: vec2f, p: Particle, ctx: ParticleContext) -> vec4f
```

`Particle` fields (world units, §6): `pos: vec3f`, `vel: vec3f`,
`color: vec3f`, `size: f32` (0 = `particles.size`), `alpha: f32`,
`seed: f32`, `age: f32`, `life: f32`, `id: f32` (= index).

`ParticleContext`: `mediaTime, elapsed, progress, deltaTime, frame,
seed, aspect, count, params..paramsD, resolution, camOrigin, camRight,
camUp, camForward, camTan`. Helpers in particle code: `phash(seed)`,
`phash3(seed) -> vec3f` (deterministic 0..1), and `maskAtParticle(uv)`
in compute only (emit from / kill outside the tracked mask).

Rules of the simulation:

- The host calls `particleInit` on creation and after any seek jump,
  and increments `p.age += deltaTime` **before** `particleUpdate`.
- Respawn yourself: `if (p.age >= p.life) { return particleInit(u32(p.id + 0.5), ctx); }`
  Stagger births in `particleInit` with `p.age = hash * p.life` so the
  system starts already alive instead of bursting on frame one. When
  staggering, also pre-roll the position (`p.pos += p.vel * p.age`),
  otherwise every particle still spawns at the emitter and only its
  death is staggered (verified on the prompt bench: a confetti system
  without pre-roll renders as a single band at the emitter).
- Integrate physics explicitly: gravity `vel.y -= g * dt`, drag
  `vel *= exp(-k*dt)` or `vel *= (1.0 - k*dt)`, curl-ish turbulence from
  sin/cos fields of `pos` and `mediaTime`. Fade with `age/life`.
- In `particleSprite`, `uv` is -1..1 across the quad. Return straight
  (non-premultiplied) RGBA; discard hard shapes by returning alpha 0.
  `p.pos` is reconstructed approximately there; rely on
  color/alpha/age/life/seed for shading.

Worked example — additive sparks with gravity:

```wgsl
fn particleInit(index: u32, ctx: ParticleContext) -> Particle {
  var p: Particle;
  let h = phash3(f32(index) * 1.37 + ctx.seed * 10.0);
  p.id = f32(index); p.seed = h.x * 100.0;
  p.pos = vec3f(0.0, -0.25, 0.3);
  p.vel = vec3f((h.x - 0.5) * 1.8, h.y * 2.0 + 0.5, (h.z - 0.5) * 0.5);
  p.life = 0.8 + h.y * 1.4; p.age = h.z * p.life;
  p.color = vec3f(1.0, 0.65, 0.25); p.alpha = 1.0; p.size = 0.0;
  return p;
}
fn particleUpdate(p: Particle, ctx: ParticleContext) -> Particle {
  if (p.age >= p.life) { return particleInit(u32(p.id + 0.5), ctx); }
  var q = p;
  q.vel.y -= 2.4 * ctx.deltaTime;
  q.pos += q.vel * ctx.deltaTime;
  let k = clamp(q.age / q.life, 0.0, 1.0);
  q.alpha = 1.0 - k;
  q.color = mix(vec3f(1.0, 0.8, 0.35), vec3f(0.85, 0.2, 0.04), k);
  return q;
}
```

Recipe map: fire = upward vel, short life, additive, colour ramp to
red, size grows; smoke = normal blending, long life, low alpha, size
grows, grey; rain/snow = respawn at top plane, constant fall, wrap in
`particleUpdate`; confetti = normal blending, tumbling colour by seed;
debris/explosion = radial vel from a centre, gravity, bounce optional
on `pos.y < floor`.

## 6. True 3D

World space: the video background lies on plane `z = 0` with
`x in [-aspect, aspect]`, `y in [-1, 1]` (y up). The camera looks
toward `camera.target` (default origin). Nearer planes have larger `z`
toward the default camera at `[0, 0, 3]`.

- **Layered parallax**: sample layers at different depths and composite:
  `overBlend(foreAt(layerUv(ctx.uv, 0.35).xy), backAt(layerUv(ctx.uv, 0.0).xy))`.
  Check `.z` (valid) before trusting a projected UV.
- **Raymarched 3D**: full creative freedom inside `fx()`:

```wgsl
fn map3(p: vec3f) -> f32 {
  return smin(sdSphere(p - vec3f(0.2, 0.0, 0.2), 0.5),
              sdBox3(p + vec3f(0.45, 0.1, -0.1), vec3f(0.28)), 0.25);
}
fn fx(ctx: FxContext) -> vec4f {
  var col = sourceAt(ctx.uv).rgb;
  let ro = ctx.camOrigin; let rd = rayDir(ctx.uv);
  var t = 0.0; var hit = false; var p = ro;
  for (var i = 0; i < 64; i++) {
    p = ro + rd * t; let d = map3(p);
    if (d < 0.002) { hit = true; break; }
    t += d; if (t > 12.0) { break; }
  }
  if (hit) {
    let e = 0.002;
    let n = normalize(vec3f(
      map3(p + vec3f(e, 0.0, 0.0)) - map3(p - vec3f(e, 0.0, 0.0)),
      map3(p + vec3f(0.0, e, 0.0)) - map3(p - vec3f(0.0, e, 0.0)),
      map3(p + vec3f(0.0, 0.0, e)) - map3(p - vec3f(0.0, 0.0, e))));
    let l = vec3f(0.5, 0.8, 0.6);
    let shade = 0.25 + lightLambert(n, l)
      + lightSpec(n, -rd, l, 48.0) * 0.8
      + fresnelTerm(n, -rd, 3.0) * 0.35;
    col = mix(col, vec3f(0.35, 0.55, 0.95) * shade, 0.92);
  }
  return vec4f(col, 1.0);
}
```

- **Particles + 3D share the same world**: particle `pos` is projected
  with the same camera, so emitters can sit on the foreground plane,
  fall through depth, or orbit a raymarched object.
- Keep raymarch loops bounded (<= 96 steps), early-out on `t`, and
  derive normals with 6 extra `map` calls only on hit.

## 7. Camera

`camera: { from, to, fov, target?, roll? }`. The host eases position
(smoothstep) across the effect range (or the whole clip when
un-ranged), aims at `target` (a single anchor for the whole move),
applies `roll` degrees, and fills every `ctx.cam*` field, `layerUv`,
`rayDir`, `worldToUv` and the particle projection. No camera = static
identity camera at `[0,0,3]`, so plain 2D shaders are unaffected.
Push-in: `from [0,0,3]` to `[0.3, 0.1, 1.7]`, fov 35-45. Orbit feel:
offset `from`/`to` laterally with a shared `target`.

## 8. Temporal history / feedback

Set `history: true` to feed the previous presented output of **this
effect** back through `historyAt(uv)`. The host resets history on seek
discontinuities; `ctx.historyMix` is 0 on the first valid frame —
guard with it. Uses: motion trails (`max(cur, prev * 0.92)`), echoes,
feedback tunnels (sample history at scaled/rotated UV), smearing and
fluid-like advection approximations. Without the flag, `historyAt` is
black and costs nothing.

## 9. Masks (SAM 3.1)

`track_object` with a short bare noun phrase (`"red car"`, never a
sentence) makes `maskAt` follow the object. Combine: feathered
isolation `mix(back, fore, maskBlur(uv, 6.0))`, background blur,
object glow from `maskEdge`, parallax (§6), particle emission gated by
`maskAtParticle` in compute. Before any track, `maskAt` is 1.0
everywhere — shaders must still look correct then.

## 10. MCP workflow for the agent

Tools: `get_shader_interface`, `get_editing_craft`, `get_video_state`,
`list_shader_effects`, `validate_shader`, `apply_shader_effect`,
`remove_shader_effect`, `clear_shader_effects`, `track_object`,
`seek_video`, `set_playing`.

Editing craft (grading order and numbers, camera-move amounts, beat
discipline, caption rules) lives in `docs/editing-craft.md`, distilled
and rewritten for this interface from vidmoat/skills (CC-BY-4.0 text).
Load it one topic at a time via `get_editing_craft(topic)`, only when
the request touches that craft; it is an efficiency budget, not a
default read.

Professional loop: read state -> (track if object work) -> decompose
the request into layers -> write the cheapest shader that reads well
-> `validate_shader` while iterating on anything non-trivial ->
`apply_shader_effect` -> seek into the range and pause so the user
sees it. Assign `params` semantically (intensity, size, speed, hue)
so later "more / less" requests are one re-apply away. Stack separate
concerns as separate effects instead of one giant shader.

## 11. Limits and performance

- Code limits: 128k chars per shader field. Effects: unbounded count,
  but every pass costs a full-screen pass — merge trivial grades.
- Particles: 200k max per effect; start at 2k-20k. Additive sprites
  overdraw quickly at large `size`.
- Raymarching and fbm are the expensive tools: prefer `fbm2` over
  hand loops, bound steps, and work at the effect's own resolution.
- All computation is GPU-side: zero CPU pixel copy in the frame path.
  Nothing you write can read pixels back or allocate per frame.
