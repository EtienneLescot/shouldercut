# Editing craft — distilled for the ShoulderCut shader agent

This document is a rewrite, not a copy. It extracts decision rules from
the vidmoat/skills repository (text CC-BY-4.0, scripts Apache-2.0;
`colour-grade`, `colourist`, `camera-motion`, `beat-sync`,
`caption-styling`) and restates them in ShoulderCut vocabulary: WGSL
helpers, `camera` moves, `ctx` fields and effect ranges. Tool-specific
operations from the source (its editor ops, ffmpeg recipes) are dropped.

Served on demand by the MCP tool `get_editing_craft(topic)`. Load one
topic only when the request touches it. Never load it for shader
compile iteration, and never load more than one topic per request
unless the request genuinely spans two crafts.

## colour

Order of operations, always: balance, then match, then look, then
finishing. A look applied before balance is why cinematic presets look
wrong on real footage. Clipped highlights and crushed blacks are lost
information: say so instead of trying to grade them back.

1. **Balance first, per shot.** White balance with `temperature(c, x)`
   (small x; it shifts ±12% red/blue), then exposure and contrast.
   When shots differ, match each one to the best-exposed shot, never
   to the average. A single global grade cannot fix opposite errors.
2. **One restrained look, shared.** Split the tint: shadows through
   lift, highlights through gain, so midtone skin stays mostly alone.
   Use the WGSL helper `liftGammaGain(c, lift, gamma, gain)`:
   - lift is an offset on the blacks. A few hundredths are visible:
     0.02 to 0.045. Teal shadows: `lift = vec3f(0.0, 0.02, 0.045)`.
   - gain is a multiplier on the highlights. Warm highlights:
     `gain = vec3f(1.05, 1.0, 0.97)`.
   - gamma is a per-channel power on the mids, neutral at 1.0.
   - Matte look: lift 0.05 to 0.08 on all channels. Bleach bypass:
     more contrast, less saturation. Filmic: less saturation, more
     contrast. Teal-and-orange is lift cyan + gain warm, never a
     global hue rotation.
3. **Protect skin.** Prefer `vibrance(c, amt)` over
   `satColor(c, amt)` when a shot is dull but faces already read well:
   vibrance boosts muted colours more than saturated ones, skin
   included in the protection. Never chase a tint by dragging skin
   with it. Finish with `acesTonemap` only when the look pushes
   values above 1.
4. **Acceptance, measured not vibes.** No new clipped or crushed areas
   versus the source; faces should read in a natural luma band
   (roughly 0.18 to 0.88 in our 0..1 space, as a sanity band, not a
   target to force); check the result at three points in the range,
   including across any cut. One verification pass, then stop.

Param discipline for grades: assign `params.x` intensity of the look,
`params.y` saturation trim, `params.z` vignette, so "stronger / softer"
is a re-apply with one number changed, not a rewrite.

## camera

One move per shot, chosen for a reason. Repeated zooms read as cheap.
Never stack zoom, pan and shake on the same effect.

- **Punch-in** (emphasis, or to hide a jump cut): total scale 1.10 to
  1.15, eased. In ShoulderCut terms that is a camera dolly from
  `[0,0,3]` toward about `[0,0,2.65]`, or a `layerUv` scale of the
  same ratio. One per moment, then hold or release.
- **Slow drift on stills or locked shots**: 3 to 8% size change across
  the whole hold, about 1 to 3% per second; faster reads as a
  screensaver. Alternate direction between successive shots.
- **Shake** only on hits and impacts: it starts at the impact, decays,
  moves on both axes and ends exactly at zero. Small knock: camera
  offsets around 0.01 world units; explosion: up to about 0.05, with
  `ctx.elapsed`-driven damped oscillation. Never ambient shake.
- **Rack focus**: blur radius high to 0 (or reverse) over about 0.4 s
  to move attention between subjects: mix `sourceBlur(uv, r)` with
  `sourceAt(uv)` weighted by a mask or a depth plane.
- **Whip pan**: 0.15 to 0.3 s, only when the shot already moves that
  way; a fast lateral camera move with motion blur (mix in
  `sourceBlur`) sells it.
- **Depth feel**: keep virtual rotation small. Our `roll` and lateral
  `target` offsets of a few degrees read as considered 3D; large
  values read as a gimmick.
- **Easing**: the host eases camera moves with smoothstep. Keep one
  motion character per composition: confident and mechanical, or soft
  and playful; do not mix per effect. Fast moves strobe without blur:
  blend a blurred sample on the fastest segment.

## beat

Speed, cuts and transitions land on the same instants, and the
instants come from measurement, not invention.

- If no beat evidence exists (no BPM given by the user or analysis),
  do not claim beat sync and do not invent a grid. Cut on the action:
  range boundaries on movement peaks, effect envelopes on gestures.
- With a BPM: carry it in `paramsC.x` = BPM, `paramsC.y` = beat
  offset in seconds. Beat phase in WGSL:
  `fract((ctx.mediaTime - ctx.paramsC.y) * ctx.paramsC.x / 60.0)`.
  Frames per beat = (60 / BPM) x fps; that is why hand-tapped
  markers drift and calculated ones do not.
- Emphasis on downbeats, not every beat. Respect 4, 8 and 16 bar
  phrases. Cutting on literally every beat for a minute is a
  metronome.
- Place cuts and effect starts 1 to 2 frames early; exactly on the
  transient reads as late.
- One transition style, repeated, 0.15 to 0.3 s, landing on the beat.
  A different transition each time reads as a template demo.
- Punctuate only the biggest hit (one shake or punch-in). Land the
  last cut or effect end on the final beat; trailing off feels
  unfinished.

## captions

Captions are read in about two seconds, on a phone, sound off, over
moving footage. These rules govern any caption the agent specifies
for the host caption layer; they are not a shader concern.

- At most 2 lines per cue; about 42 characters per line in 16:9,
  about 32 in 9:16. Reading speed at most 17 characters per second.
- Cue duration 1 to 6 seconds; gap 0 or at least 2 frames, never 1.
- Bottom centre inside the safe zone. On 1080x1920 keep text above
  the bottom 22% of height (app buttons). Move to the top when the
  lower third holds a face or burned-in text.
- Sentence subtitles: 4.5 to 5% of frame height. Short punchy
  captions of 1 to 3 words are graphic elements: much larger, at
  most about 14 characters per line.
- Off-white `#F2F2F2` on a 70 to 80% opaque dark plate, or a 3 to
  5 px dark outline. One heavy sans-serif per video, never two
  families. Word highlight: one accent colour on the active word
  only, also at 4.5:1 contrast or better.
- Start from a real transcript with timings. No transcript, no
  captions: say so instead of inventing wording.

## efficiency

Craft knowledge must never tax ordinary editing.

- Load one craft topic only when the request names its domain
  (grade, camera move, beat, captions). Default cost: zero.
- Prefer measured acceptance numbers over image judgement, and run
  at most one verify-and-fix pass after applying an effect.
- Do not reload craft topics during WGSL error iteration; compile
  errors are a syntax matter, not a taste matter.
