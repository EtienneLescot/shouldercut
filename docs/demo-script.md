# The three-minute demo

What to show, in order, and why each beat earns its place.

Everything you type or say to the editor is in **English**: the product is
English and the voice agent is pinned to it, so a French instruction
transcribes worse.

**The clip.** `walk.mp4` — a woman in a red dress walking a grey London
street, Pexels, free to use. Shot 12 in the project. It was chosen for one
reason: the SAM cutout has to be legible on screen in a single glance, and a
strong colour against a neutral background is what makes the outline read.

**The narration** is already recorded in your own cloned voice at
`.runtime/demo/narration.mp3` (72 s, ElevenLabs `eleven_v4`). Lay it under
the screen capture rather than speaking live — it is cleaner, and it frees
you to concentrate on driving the editor.

---

## The idea the video has to land

A director does not touch the keyboard. They stand behind the editor and
say *cut there*, *no, go back*, *make it blue*. The editor does the work.

**You are the director. Muse is the editor.** Everything below exists to
show that one relationship.

---

## 0:00 – 0:20 · Open on the thing

The editor already open, `walk.mp4` loaded, nothing else on screen. No title
card.

The narration opens by itself. Let it. Do not touch anything for the first
twenty seconds — stillness here is the argument: nobody is clicking.

## 0:20 – 0:50 · The subject, not the frame

Type, or say:

> **Cut out the woman in the red dress and show me the preview.**

Let the cutout sit for a beat once it lands. The glowing outline is the
evidence, and it is the single most legible thing in the whole video.

**Why:** SAM 3.1 turning a plain noun phrase into a tracked mask, in one
instruction. No rotoscoping, no keyframes, no selection tool.

## 0:50 – 1:50 · The part no other editor does

Type, or say:

> **Now give the street behind her a cold blue night grade, and keep her warm.**

While it works, **do not wait in silence**. Send the next instruction on top
of it:

> **Add a slow push-in on her.**

**Why:** this is the whole product. The work is running, and you keep
directing over its shoulder. No form, no progress bar you stare at. And the
grade is a shader that Muse writes on the spot — there is no effects
catalogue in this app, which is worth saying out loud.

## 1:50 – 2:20 · Show it is a real timeline

> **Undo that. Actually, put it back.**

**Why:** thirty seconds that answer the question a judge is paid to ask —
is this a real editor or a video of a prompt? Generated results and shader
effects join the edit graph as ordinary clips, so they trim, move, undo and
export like anything else.

## 2:20 – 2:50 · Name the models

The narration already does this, so just let the editor sit on screen:

> Every mask is SAM 3.1. The editor itself is Muse Wonder — it reads the
> instruction, picks the tools and writes the code. The conversation is Muse
> Spark, which is why an answer comes back while a render is still running.
> Captions are Meta ASR. One API key, four services.

**Why:** "we used Meta models" is weaker than naming which model does which
job, and genuine Meta Model API use is a pass/fail gate before any scoring.

## 2:50 – 3:00 · Land it

> **Export.**

Close on the editor, not on your face.

---

## Before you hit record

```bash
npm run demo
```

Wait for the ready line. Then:

- **ComfyUI on `127.0.0.1:8188`** if you want generation to be free. Without
  it, every generative request bills fal.ai instead, silently.
- **Select shot 12 (`walk.mp4`)** before recording, so you open on the right
  footage.
- **Rehearse the 0:50 instruction once.** It is the one that costs money if
  you have to repeat it on a hosted backend.

## If something fails on camera

Do not re-record. Say what happened and carry on. The Indie track is judged
on *whether it works*, not on whether nothing ever goes wrong, and a
presenter who says "that one failed, here is why" reads as honest.

Two rough edges worth knowing:

- A local ComfyUI backend covers about four seconds per pass. Ask for a
  longer range and Muse now tells you it covered less than you asked rather
  than quietly returning a short result.
- A short range is padded up to the model's 81-frame minimum, so a
  three-second edit bills five seconds on a hosted provider.
