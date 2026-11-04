# The three-minute demo

What to say, in order, and why each line is there. Everything you speak to
the editor is in **English** — the product is English and the voice agent is
pinned to it, so a French instruction will get a worse transcription.

Clip: `Balade sur la cote.mp4`, already imported, 11 shots, 1:13. Portrait,
which is worth showing: it proves the editor does not reshape your footage.

Record with OpenScreen. Keep the mouse still while Muse talks — the point is
that you are not clicking.

---

## 0:00 – 0:15 · Open on the thing, not on a title card

Have the editor already open with the clip loaded and Muse at her desk.
Say to camera, or in voice-over:

> "This is ShoulderCut. It is a video editor you talk to. I am not going to
> touch a menu for the next three minutes."

**Why:** the single claim the whole demo has to land. Say it once, up front,
then prove it.

---

## 0:15 – 0:45 · The subject, not the frame

Click **Talk** once. Then say:

> "Cut out the woman and show me the preview."

Wait for the mask. Let the cutout sit on screen for a beat — the glowing
outline is the evidence.

> "Nice. Now take me to the moment she turns towards the camera."

**Why:** two Meta models in thirty seconds. SAM 3.1 turns a plain noun
phrase into a tracked mask, and `find_moment` searches the footage for a
described event rather than a timestamp. The second instruction also shows
she holds context — "she" refers back.

---

## 0:45 – 1:45 · The edit that costs money, and the one that does not

> "Replace her white dress with a red leather jacket."

She will tell you the job is running and give you a job id. **Do not wait in
silence.** While it generates, talk over her shoulder — that is the whole
name of the product:

> "While that runs — add a slow push-in on her, and cool down the
> background."

**Why:** this is the part no other editor does. The generation is
asynchronous, she keeps working, and the mascot keeps working with her —
she does not stop and stare at you. The second instruction lands a shader
that Muse Wonder *writes*: there is no effects catalogue, so say so:

> "There is no effects library here. She just wrote that shader."

---

## 1:45 – 2:20 · Show the receipt

When the generation lands, let it drop into the timeline, then:

> "Undo that. Actually, put it back."

**Why:** thirty seconds that quietly answer "is this real or a video of a
prompt". Generated results join the edit graph as ordinary clips, so they
trim, move and undo like anything else. Nothing else in the demo proves the
work is in a real timeline.

---

## 2:20 – 2:50 · The thing a judge is paid to be suspicious about

Say, to camera:

> "Every mask here is SAM 3.1. The editor itself is Muse Wonder — it reads
> the instruction, picks the tools and writes the WGSL. The conversation is
> Muse Spark, which is why she can answer while a render is still going.
> Captions are Meta ASR. One API key, four services."

Then:

> "Generation runs on my own GPU through ComfyUI, for nothing. No GPU? The
> same request routes to a hosted provider. The editor cannot tell the
> difference."

**Why:** the Meta Model API use is a pass/fail gate before anything is
scored, and "we used Meta models" is weaker than naming which model does
which job. The second part answers the obvious objection, that this only
works on your machine.

---

## 2:50 – 3:00 · Land it

> "Export."

Let the file land. Close on the editor, not on your face.

> "Your idea, your voice, your cut."

---

## If something fails on camera

Do not re-record. Say what happened and carry on — a demo where the presenter
says "that one failed, here is why" reads as honest, and the Indie track is
judged on *whether it works*, not on whether it is flawless. The two known
rough edges:

- A local backend covers about four seconds per pass. Ask for a longer range
  and she will now tell you she covered less than you asked. That is a
  feature of this build, not a crash — say so.
- A short range is padded to the model's 81-frame minimum, so a three-second
  edit bills five seconds on a hosted provider.

## Before you hit record

- `npm run demo`, and wait for the ready line.
- ComfyUI on `127.0.0.1:8188` if you want the free path, or accept the bill.
- Check the mic in **Audio and export options** — the same device serves the
  realtime session and the recorded fallback.
- One rehearsal of the 0:45 instruction, because it is the one that costs
  money if you have to repeat it.
