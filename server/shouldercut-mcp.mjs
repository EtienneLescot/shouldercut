import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE = (process.env.SHOULDERCUT_BRIDGE || 'http://127.0.0.1:5173').replace(/\/$/, '');

async function bridge(path, options = {}) {
  const response = await fetch(BRIDGE + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    return { ok: false, httpStatus: response.status, ...data };
  }
  return data;
}
function asToolResult(data) {
  return {
    content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
    isError: typeof data === 'object' && data !== null && data?.ok === false,
  };
}

const server = new McpServer({ name: 'shouldercut-fx', version: '0.5.0' });

server.registerTool('get_shader_interface', {
  description: 'Read the complete ShoulderCut shader/VFX interface (v2): FxContext, sampling helpers, injected WGSL stdlib catalogue, true-3D raymarching and layered planes, GPU compute particles, temporal history feedback, virtual camera, compositing, recipes and hard limits. Call this once before writing your first shader in a session, and again whenever you are unsure of a helper name or signature. Never guess helper names.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const doc = readFileSync(join(here, '..', 'docs', 'fx-interface.md'), 'utf8');
    return asToolResult(doc);
  } catch (error) {
    return asToolResult({ ok: false, message: 'Could not read docs/fx-interface.md: ' + (error instanceof Error ? error.message : String(error)) });
  }
});

server.registerTool('get_editing_craft', {
  description: [
    'Read one distilled editing-craft topic, rewritten for ShoulderCut shaders from professional editing practice: colour (balance/match/look order, lift-gamma-gain numbers, skin protection, measured acceptance), camera (punch-in, drift, shake, rack focus, whip amounts), beat (measured grids, downbeat emphasis, transition timing), captions (line length, reading speed, safe zones).',
    'Efficiency rule: call this ONLY when the user request touches that craft (grading, a camera move, beat sync, captions). Never call it during WGSL compile iteration, never load more than one topic unless the request spans two, and never reload a topic already read this session. Each topic is small by design.',
  ].join(' '),
  inputSchema: {
    topic: z.enum(['colour', 'camera', 'beat', 'captions']).describe('The single craft topic to load.'),
  },
  annotations: { readOnlyHint: true },
}, async (args) => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const doc = readFileSync(join(here, '..', 'docs', 'editing-craft.md'), 'utf8');
    const marker = '\n## ' + args.topic + '\n';
    const start = doc.indexOf(marker);
    if (start < 0) return asToolResult({ ok: false, message: 'Unknown craft topic: ' + args.topic });
    const rest = doc.slice(start + marker.length);
    const next = rest.indexOf('\n## ');
    const section = (next < 0 ? rest : rest.slice(0, next)).trim();
    return asToolResult('# Editing craft: ' + args.topic + '\n\n' + section);
  } catch (error) {
    return asToolResult({ ok: false, message: 'Could not read docs/editing-craft.md: ' + (error instanceof Error ? error.message : String(error)) });
  }
});

server.registerTool('get_video_state', {
  description: 'Get the currently loaded ShoulderCut video state: file, duration, dimensions, current media/frame time, playback phase, active mask track, and whether the browser editor is connected.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => asToolResult(await bridge('/api/state')));

server.registerTool('list_shader_effects', {
  description: 'List current free-form WGSL shader effects in execution order, including code, particleCode, params (x16), ranges, history/particle config and camera.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  const state = await bridge('/api/state');
  return asToolResult({ ok: state.ok !== false, effects: state.effects || [] });
});

const vec4Schema = z.array(z.number()).length(4);
const cameraSchema = z.object({
  from: z.array(z.number()).length(3),
  to: z.array(z.number()).length(3),
  fov: z.number().min(10).max(120),
  target: z.array(z.number()).length(3).optional().describe('Look-at target, defaults to [0,0,0].'),
  roll: z.number().optional().describe('Roll in degrees around the forward axis, defaults to 0.'),
}).nullable().optional();
const particleConfigSchema = z.object({
  count: z.number().int().min(1).max(200000),
  size: z.number().positive().max(4).describe('Default world-space sprite size; per-particle size overrides it when > 0.'),
  blending: z.enum(['normal', 'additive']),
}).nullable().optional();

const effectInputSchema = {
  id: z.string().min(1).describe('Stable effect id. Reuse it to replace your previous version while iterating.'),
  name: z.string().min(1).describe('Short human-readable effect name.'),
  code: z.string().min(1).describe('WGSL helper code plus exactly one fn fx(ctx: FxContext) -> vec4f. See get_shader_interface.'),
  particleCode: z.string().optional().describe('For kind="particles": WGSL defining particleInit/particleUpdate and optionally particleSprite. See get_shader_interface.'),
  kind: z.enum(['fragment', 'particles']).optional().describe('"fragment" (default) or "particles" for a GPU compute particle layer rendered after fx().'),
  params: vec4Schema.optional().describe('Free parameters exposed as ctx.params (vec4f).'),
  paramsB: vec4Schema.optional().describe('Free parameters exposed as ctx.paramsB.'),
  paramsC: vec4Schema.optional().describe('Free parameters exposed as ctx.paramsC.'),
  paramsD: vec4Schema.optional().describe('Free parameters exposed as ctx.paramsD.'),
  history: z.boolean().optional().describe('Enable historyAt()/prevAt() temporal feedback (previous output of this effect). Use for trails, echoes, feedback.'),
  particles: particleConfigSchema.describe('GPU particle layer config. Required when kind="particles".'),
  seed: z.number().optional().describe('Free seed exposed as ctx.seed / ParticleContext.seed.'),
  start: z.number().nonnegative().nullable().optional().describe('Effect range start in seconds, or null.'),
  end: z.number().positive().nullable().optional().describe('Effect range end in seconds, or null.'),
  camera: cameraSchema.describe('Virtual camera move: positions eased across the range, aimed at target (default origin), optional roll. Null keeps the static identity camera.'),
};

function effectBody(args) {
  return {
    effect: {
      id: args.id,
      name: args.name,
      code: args.code,
      particleCode: args.particleCode,
      kind: args.kind,
      params: args.params || [0, 0, 0, 0],
      paramsB: args.paramsB,
      paramsC: args.paramsC,
      paramsD: args.paramsD,
      history: args.history ?? false,
      particles: args.particles ?? (args.kind === 'particles' ? { count: 2000, size: 0.05, blending: 'additive' } : null),
      seed: args.seed,
      start: args.start ?? null,
      end: args.end ?? null,
      camera: args.camera ?? null,
      enabled: true,
    },
  };
}

server.registerTool('validate_shader', {
  description: [
    'Dry-run compile a shader (fragment + particle modules) in the live browser WITHOUT changing the preview or the effect list.',
    'Use this while iterating on complex WGSL, raymarchers or particle code; fix returned errors, then call apply_shader_effect once.',
    'Same contract as apply_shader_effect; see get_shader_interface for the full spec.',
  ].join(' '),
  inputSchema: effectInputSchema,
  annotations: { readOnlyHint: true },
}, async (args) => asToolResult(await bridge('/api/effects/validate', {
  method: 'POST',
  body: JSON.stringify(effectBody(args)),
})));

server.registerTool('apply_shader_effect', {
  description: [
    'Create or replace a free-form WGSL video effect and compile it in the live browser. There is no effects catalog: you write the shader like a VFX artist.',
    'Call get_shader_interface first if you have not read it this session: it lists every ctx field, sampling helper, injected stdlib function, the true-3D and GPU-particle contracts, and recipes.',
    'Fragment: fn fx(ctx: FxContext) -> vec4f over sourceAt/originalAt/maskAt/historyAt, layer planes, rayDir/worldToUv, stdlib noise/SDF/lighting/blur/compositing.',
    'GPU particles: kind="particles" + particles={count,size,blending} + particleCode with particleInit/particleUpdate/(particleSprite); particles live in world space and are simulated on GPU every frame.',
    'Temporal: history=true feeds the previous output of this effect back via historyAt(). Camera: {from,to,fov,target?,roll?} eased across the range.',
    'The tool blocks until WebGPU accepts or rejects the shader. On errors, fix the WGSL and call again with the same id.',
  ].join(' '),
  inputSchema: effectInputSchema,
  annotations: { readOnlyHint: false },
}, async (args) => asToolResult(await bridge('/api/effects/apply', {
  method: 'POST',
  body: JSON.stringify(effectBody(args)),
})));

server.registerTool('remove_shader_effect', {
  description: 'Remove one free-form shader effect by id.',
  inputSchema: { id: z.string().min(1) },
  annotations: { readOnlyHint: false },
}, async (args) => asToolResult(await bridge('/api/effects/remove', {
  method: 'POST',
  body: JSON.stringify({ id: args.id }),
})));

server.registerTool('clear_shader_effects', {
  description: 'Remove every free-form shader effect and return to the untouched video.',
  inputSchema: {},
  annotations: { readOnlyHint: false },
}, async () => asToolResult(await bridge('/api/effects/clear', { method: 'POST', body: '{}' })));

server.registerTool('track_object', {
  description: 'Track one object through the loaded clip with SAM 3.1 and make its mask available to shaders via maskAt(uv) (and maskAtParticle in particle compute). The prompt must be a short bare noun phrase (for example "red car"), never a sentence. The browser uploads its clip once; tracking takes seconds and masks then follow the object frame by frame. Call this before apply_shader_effect whenever the request mentions an object, person, or background.',
  inputSchema: {
    prompt: z.string().min(1).describe('Short bare noun phrase naming the object to track.'),
  },
  annotations: { readOnlyHint: false },
}, async (args) => asToolResult(await bridge('/api/sam/track-object', {
  method: 'POST',
  body: JSON.stringify({ prompt: args.prompt }),
})));

server.registerTool('generate_shot', {
  description: 'Create an asynchronous text-to-video generation job (docs/generative-video-spec.md). Returns a job id immediately; generation takes minutes on a hosted provider. The local stub provider completes in seconds with a clearly labelled placeholder clip, which must never be described to the user as AI generation. Poll with get_generation_job.',
  inputSchema: {
    prompt: z.string().min(1).describe('Text prompt describing the shot to generate.'),
  },
  annotations: { readOnlyHint: false },
}, async (args) => asToolResult(await bridge('/api/gen/generate', {
  method: 'POST',
  body: JSON.stringify({ prompt: args.prompt }),
})));

server.registerTool('edit_segment', {
  description: 'Create an asynchronous video-editing generation job over the browser current clip range: the bridge extracts the source segment and a ControlNet-style edge control video, then submits to the configured provider. For subject transformations, call track_object and show_working_preview first. Returns the job in preparing state; poll with get_generation_job.',
  inputSchema: {
    prompt: z.string().min(1).describe('Edit instruction, for example "the two children become friendly toy robots, same jumps and timing".'),
    refImageUrl: z.string().url().optional().describe('Optional public URL of a reference image (identity/design) for the replacement. Strongly recommended for character replacement.'),
    backend: z.enum(['vace', 'wan-animate', 'kling-o3', 'recast', 'scail', 'scail-animate', 'vace-local']).optional().describe('Editing backend from recommend_video_workflow. recast: hosted full character replacement (tracks people itself, no mask). scail / scail-animate: local ComfyUI repertoire workflow scail2-character-replacement, Replacement / Animation mode (frame-tracked, fixed tested settings, ~6 min, needs the local ComfyUI server). vace-local: local ComfyUI repertoire workflow vace-inpainting-local for localised masked edits (garment, prop, removal). vace (hosted) only as fallback for localised masked edits. Default: vace.'),
    subjectLabel: z.string().min(1).optional().describe('For backend scail: SAM3 detection noun for the source subject, e.g. "woman".'),
    refLabel: z.string().min(1).optional().describe('For backend scail: SAM3 detection noun for the reference character, e.g. "toy robot".'),
    start: z.number().nonnegative().describe('Segment start in seconds on the current clip.'),
    end: z.number().positive().describe('Segment end in seconds on the current clip.'),
  },
  annotations: { readOnlyHint: false },
}, async (args) => asToolResult(await bridge('/api/gen/edit', {
  method: 'POST',
  body: JSON.stringify({ prompt: args.prompt, refImageUrl: args.refImageUrl, backend: args.backend, subjectLabel: args.subjectLabel, refLabel: args.refLabel, start: args.start, end: args.end }),
})));

server.registerTool('get_generation_job', {
  description: 'Poll one generation job by id. On done, file names under files can be fetched from the bridge at /api/gen/files/<name>. States: preparing, queued, running, done, failed.',
  inputSchema: { id: z.string().min(1) },
  annotations: { readOnlyHint: true },
}, async (args) => asToolResult(await bridge('/api/gen/jobs/' + encodeURIComponent(args.id))));

server.registerTool('show_working_preview', {
  description: 'Show the optimistic working preview: the currently SAM-tracked subject under a flat local colour treatment, so the user sees the edit immediately while generation runs (design rule: optimistic preview first). Requires a prior track_object. This is a host UI state, not a finished effect; clear it with clear_working_preview when a draft lands or the job fails.',
  inputSchema: {
    subject: z.string().min(1).describe('Subject label shown in the effect list, for example "enfants".'),
    color: z.string().optional().describe('Flat treatment colour as #RRGGBB, evoking the target (for example #8a8f98 metallic grey for robots).'),
  },
  annotations: { readOnlyHint: false },
}, async (args) => asToolResult(await bridge('/api/preview/working', {
  method: 'POST',
  body: JSON.stringify({ subject: args.subject, color: args.color || '#8a8f98' }),
})));

server.registerTool('clear_working_preview', {
  description: 'Remove the optimistic working preview treatment.',
  inputSchema: {},
  annotations: { readOnlyHint: false },
}, async () => asToolResult(await bridge('/api/preview/clear', { method: 'POST', body: '{}' })));

function loadTechniqueRegistry() {
  const here = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(readFileSync(join(here, 'video-techniques.json'), 'utf8'));
}
function normaliseText(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

server.registerTool('list_video_techniques', {
  description: 'List the researched video-generation/editing technique registry (server/video-techniques.json): each technique, the user phrasings that cue it, required inputs, guidance channels (mask video, ControlNet-style control videos, edited keyframes, elements, motion drivers, first/last frames), candidate backends with implementation status, prices, rankings and risks. Call this to learn what workflows exist before planning a generative request you have not handled yet; prefer recommend_video_workflow for a concrete user request.',
  inputSchema: {
    id: z.string().optional().describe('Optional technique id to return in full; omit to list all techniques compactly.'),
  },
  annotations: { readOnlyHint: true },
}, async (args) => {
  try {
    const registry = loadTechniqueRegistry();
    if (args.id) {
      const found = registry.techniques.find((t) => t.id === args.id);
      return asToolResult(found ? JSON.stringify(found, null, 2) : { ok: false, message: 'Unknown technique id: ' + args.id });
    }
    const compact = registry.techniques.map((t) => ({
      id: t.id, name: t.name, task: t.task,
      backends: t.backends.map((b) => b.provider + '/' + b.model + ' [' + b.status + ']'),
    }));
    return asToolResult(JSON.stringify({ version: registry.version, researched: registry.researched, techniques: compact }, null, 2));
  } catch (error) {
    return asToolResult({ ok: false, message: 'Could not read video-techniques.json: ' + (error instanceof Error ? error.message : String(error)) });
  }
});

server.registerTool('list_comfy_workflows', {
  description: 'List the tested local ComfyUI workflow repertoire (server/comfy-workflows/manifest.json): proven graphs with fixed internal settings, when to pick each, the parameters the supervisor may fill, tested results and known limits. Pick from this repertoire instead of inventing a graph or sampler settings; run a picked workflow via edit_segment with backend scail.',
  inputSchema: {
    id: z.string().optional().describe('Optional workflow id to return in full; omit to list all workflows compactly.'),
  },
  annotations: { readOnlyHint: true },
}, async (args) => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, 'comfy-workflows', 'manifest.json'), 'utf8'));
    if (args.id) {
      const found = manifest.workflows.find((w) => w.id === args.id);
      return asToolResult(found ? JSON.stringify(found, null, 2) : { ok: false, message: 'Unknown workflow id: ' + args.id });
    }
    const compact = manifest.workflows.map((w) => ({ id: w.id, purpose: w.purpose, pickWhen: w.pickWhen, cost: w.cost }));
    return asToolResult(JSON.stringify({ version: manifest.version, runtime: manifest.runtime, workflows: compact }, null, 2));
  } catch (error) {
    return asToolResult({ ok: false, message: 'Could not read comfy-workflows/manifest.json: ' + (error instanceof Error ? error.message : String(error)) });
  }
});

server.registerTool('recommend_video_workflow', {
  description: [
    'Translate a literal user request into the right video workflow: returns the primary technique from the researched registry, the ordered tool steps, the backend to use first (with status and price), alternatives, economical test settings and risks. Call this ONCE before any generative-video job (generate_shot, edit_segment, character replacement, motion transfer) with the user request verbatim, then follow its steps. Do not call it for pure shader effects or during WGSL iteration.',
  ].join(' '),
  inputSchema: {
    request: z.string().min(1).describe('The user request, verbatim if possible.'),
    hasSourceVideo: z.boolean().optional().describe('Whether a source clip is loaded (default true).'),
  },
  annotations: { readOnlyHint: true },
}, async (args) => {
  try {
    const registry = loadTechniqueRegistry();
    const text = normaliseText(args.request);
    const priority = ['character_replace_motion', 'masked_inpaint_edit', 'motion_transfer', 'first_last_frame', 'outpaint_reframe', 'keyframe_guided_replacement', 'instruction_video_edit', 'reference_identity_generation', 'text_to_video_insert', 'deterministic_shader_effect'];
    const scored = registry.techniques.map((t) => {
      const hits = t.userCues.filter((cue) => text.includes(normaliseText(cue)));
      return { technique: t, score: hits.length, hits };
    }).sort((a, b) => (b.score - a.score) || (priority.indexOf(a.technique.id) - priority.indexOf(b.technique.id)));
    const best = scored[0];
    const primary = best && best.score > 0 ? best.technique
      : registry.techniques.find((t) => t.id === (args.hasSourceVideo === false ? 'text_to_video_insert' : 'instruction_video_edit'));
    const alternatives = scored.filter((s) => s.technique.id !== primary.id && s.score > 0).slice(0, 2).map((s) => s.technique.id);
    if (!alternatives.length && primary.id !== 'masked_inpaint_edit') alternatives.push('masked_inpaint_edit');
    const plan = {
      request: args.request,
      primaryTechnique: primary.id,
      name: primary.name,
      why: best && best.score > 0 ? 'Matched cues: ' + best.hits.join(', ') : 'No strong cue match; default routing for ' + (args.hasSourceVideo === false ? 'generation without source footage' : 'editing loaded footage'),
      steps: primary.workflow,
      backendsInOrder: primary.backends.map((b) => ({ provider: b.provider, model: b.model, status: b.status, price: b.price, ranking: b.ranking })),
      guidance: primary.guidance,
      economicalTest: primary.economicalTest,
      risks: primary.risks,
      alternatives,
      registryVersion: registry.version,
    };
    return asToolResult(JSON.stringify(plan, null, 2));
  } catch (error) {
    return asToolResult({ ok: false, message: 'Could not plan from video-techniques.json: ' + (error instanceof Error ? error.message : String(error)) });
  }
});

server.registerTool('seek_video', {
  description: 'Seek the ShoulderCut preview to an exact media time in seconds.',
  inputSchema: { time: z.number().nonnegative() },
  annotations: { readOnlyHint: false },
}, async (args) => asToolResult(await bridge('/api/playback', {
  method: 'POST',
  body: JSON.stringify({ action: 'seek', time: args.time }),
})));

server.registerTool('set_playing', {
  description: 'Play or pause the ShoulderCut preview.',
  inputSchema: { playing: z.boolean() },
  annotations: { readOnlyHint: false },
}, async (args) => asToolResult(await bridge('/api/playback', {
  method: 'POST',
  body: JSON.stringify({ action: args.playing ? 'play' : 'pause' }),
})));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('shouldercut-fx MCP server v0.5.0 connected via stdio; bridge=' + BRIDGE);
