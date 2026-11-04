// How the transport bar maps a shot onto the player's media time.
//
// Three things on screen show the position -- the bar, the clock, the total --
// and they used to measure from different origins: the bar spanned the shot's
// in..out, the clock showed absolute media time, the total showed the whole
// source file. A shot cut from 8s to 32s opened at 0:08 with 0:32 beside it.
//
// They all speak shot time now, and this is the mapping. It lives apart from
// main.ts because main.ts touches the DOM as it loads, which would drag a
// browser into the test run.

/** The stretch of media the transport speaks in: the shot you are watching,
 *  or the whole file when no shot is registered. */
export interface TransportWindow {
  start: number;
  length: number;
}

export function transportWindow(
  duration: number | null,
  clip: { in: number; out: number } | null,
): TransportWindow {
  const media =
    duration !== null && Number.isFinite(duration) ? Math.max(0, duration) : 0;
  if (!clip) return { start: 0, length: media };
  // A project outlives the file it points at, so a clip can claim time the
  // media does not have. Clamp to what there is, and never invert.
  const out = Math.max(0, clip.out);
  const end = media > 0 ? Math.min(out, media) : out;
  const start = Math.min(Math.max(0, clip.in), end);
  return { start, length: end - start };
}

/** Media time as the bar shows it. Clamped: a state message can still carry
 *  the previous shot's time while the next one loads. */
export function toShotTime(mediaTime: number, shot: TransportWindow): number {
  return Math.min(shot.length, Math.max(0, mediaTime - shot.start));
}

/** The bar's value back as media time. Clamped: a drag lands on either edge. */
export function toMediaTime(value: number, shot: TransportWindow): number {
  return shot.start + Math.min(shot.length, Math.max(0, value));
}
