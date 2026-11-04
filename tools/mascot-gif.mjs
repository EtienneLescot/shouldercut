/**
 * Build the README's mascot loop from the same atlas the app animates.
 *
 * Not a hand-assembled GIF: it reads jolly-animations.json, walks the
 * `demo` sequence the atlas itself declares, and composites each frame the
 * way mascot.ts does -- the static desk layer underneath, the animated
 * character on top. So the GIF cannot drift from what the app shows; if a
 * sequence changes, re-running this picks it up.
 *
 *   node tools/mascot-gif.mjs [out.gif]
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SEP = String.fromCharCode(92); // concat lists want forward slashes
const ASSETS = resolve("public/assets/jolly");
const atlas = JSON.parse(
  readFileSync(join(ASSETS, "jolly-animations.json"), "utf8"),
);
const out = resolve(process.argv[2] || "docs/media/mascot.gif");
// A README image, not a sprite sheet: small enough that the page loads.
const SIZE = Number(process.argv[3] || 200);

/** Every frame of the declared demo, in order, as atlas coordinates. */
function timeline() {
  const frames = [];
  for (const step of atlas.demo) {
    const anim = atlas.animations[step.animation];
    if (!anim) throw new Error("unknown animation " + step.animation);
    for (let cycle = 0; cycle < (step.cycles || 1); cycle++)
      for (const name of anim.frames) {
        const frame = atlas.frames[name];
        if (!frame) throw new Error("unknown frame " + name);
        frames.push({ ...frame, fps: anim.fps });
      }
  }
  return frames;
}

const scratch = mkdtempSync(join(tmpdir(), "mascot-"));
try {
  const frames = timeline();
  const fps = frames[0].fps;
  const { width, height } = atlas.frameSize;
  // The desk is a static layer behind her; mascot.ts draws it first.
  const base = join(ASSETS, atlas.layers.find((l) => l.type === "static").image);

  console.log(`${frames.length} frames at ${fps} fps from ${atlas.demo.length} sequences`);

  for (const [i, frame] of frames.entries()) {
    const sheet = join(ASSETS, atlas.atlases[frame.atlas].image);
    await run("ffmpeg", [
      "-v", "error", "-y",
      "-i", base,
      "-i", sheet,
      "-filter_complex",
      `[1:v]crop=${frame.width}:${frame.height}:${frame.x}:${frame.y}[c];` +
        `[0:v][c]overlay=0:0:format=auto,scale=${SIZE}:${SIZE}:flags=lanczos[v]`,
      "-map", "[v]", "-frames:v", "1",
      join(scratch, String(i).padStart(4, "0") + ".png"),
    ]);
  }

  // One shared palette, or the GIF flickers between frames.
  const palette = join(scratch, "palette.png");
  const list = join(scratch, "frames.txt");
  writeFileSync(
    list,
    frames
      .map((_, i) => `file '${join(scratch, String(i).padStart(4, "0") + ".png").split(SEP).join("/")}'\nduration ${(1 / fps).toFixed(4)}`)
      .join("\n") + "\n",
  );
  const input = ["-f", "concat", "-safe", "0", "-i", list];
  await run("ffmpeg", ["-v", "error", "-y", ...input, "-vf", "palettegen=max_colors=64:stats_mode=diff", palette]);
  await run("ffmpeg", [
    "-v", "error", "-y", ...input, "-i", palette,
    "-lavfi", "paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
    "-loop", "0", out,
  ]);

  const { size } = await import("node:fs").then((fs) => fs.statSync(out));
  console.log(`wrote ${out} (${Math.round(size / 1024)} kB)`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
