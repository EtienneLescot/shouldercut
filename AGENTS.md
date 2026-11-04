# Working on ShoulderCut

## Fix the class, never the case

**Every change must hold for any editing request a user can make, not only the
one in front of you.** This is the standing rule here and it outranks the
convenience of a quick patch.

A report always arrives as one case: this clip, this prompt, this backend, this
aspect ratio. The case is evidence, not the scope. Before you write the fix, ask
what class of request it belongs to, and fix it there.

Three questions on every change, and the answer has to be yes:

1. **Does it hold for the inputs you were not given?** Portrait *and* landscape,
   3 seconds *and* 30, one clip *and* a timeline of them, a mask *and* no mask,
   hosted *and* local backends.
2. **Is it at the chokepoint every caller goes through?** If a sibling path can
   still hit the same failure, you fixed a symptom. Grep the callers.
3. **Would it still be right for an instruction nobody has typed yet?** "Replace
   the ship" and "remove the sign" and "swap the jacket" are one class. Special
   cases for the words in the ticket are how this codebase rots.

Worked example, from a real bug: a portrait clip came back from the provider
unedited. The case was one video. The class was `scale=1280:720` reshaping every
input to 16:9, which silently handed the model a squashed picture for any clip
that was not already landscape. The fix went to the scale expression, not to
that clip.

**Why it matters.** We improve this editor by dogfooding it: run real requests,
watch what comes back, fix what broke. That loop only compounds if each fix
raises the floor for everything. Local patches do the opposite — they pile up
special cases, each one a new edge for the next request to catch on, and the
tenth fix undoes the third.

So: when you are tempted to branch on the specific thing that failed, stop. Find
what it is an instance of.

## Checks before you call it done

```bash
npx tsc --noEmit      # must be clean
npm test              # node tests (tools/test-*.ts)
npm run test:voice    # python tests (voice/)
npm run build         # must be green
```

Non-trivial logic leaves one runnable check behind. Put front-end decisions that
can be tested without a browser in a pure function and test it.

## House rules

- **English everywhere**: UI text, comments, docs, commit messages, test
  fixtures. No French default anywhere, including language hints sent to models.
- Prefer the shortest change that actually fixes the class. Reuse what is here
  before adding; stdlib and native platform features before a dependency.
- Measure before you conclude. The browser pane parks `requestAnimationFrame`
  when it is not on screen, so a frozen canvas is not evidence of a bug.
