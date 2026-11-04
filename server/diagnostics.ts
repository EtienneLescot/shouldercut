import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";

// Timing only: never persist prompts, transcripts, media, URLs or credentials.
type Fields = {
  jobId?: string;
  model?: string;
  backend?: string;
  tool?: string;
  status?: string;
  code?: string;
  route?: string;
  method?: string;
  elapsed_ms?: number;
  queue_ms?: number;
  cached?: boolean;
  frames?: number;
  http_status?: number;
};
const context = new AsyncLocalStorage<{ traceId: string }>();
const dir = resolve(process.cwd(), ".runtime");
const file = resolve(dir, "ux-server.jsonl");
let writes = Promise.resolve();
export const traceId = () => context.getStore()?.traceId;
export function withTrace<T>(id: unknown, action: () => T): T {
  return context.run(
    {
      traceId:
        typeof id === "string" && /^[a-zA-Z0-9_-]{8,80}$/.test(id)
          ? id
          : randomUUID(),
    },
    action,
  );
}
export function record(stage: string, fields: Fields = {}): void {
  if (
    process.env.NODE_TEST_CONTEXT ||
    process.env.SHOULDERCUT_DIAGNOSTICS_DISABLED
  )
    return;
  const row =
    JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "server",
      traceId: traceId(),
      stage,
      ...fields,
    }) + "\n";
  writes = writes
    .then(async () => {
      await mkdir(dir, { recursive: true });
      if ((await stat(file).catch(() => null))?.size! > 10_000_000) {
        await rename(file, file + ".1");
      }
      await appendFile(file, row, "utf8");
    })
    .catch(() => {
      /* Diagnostics must never break an edit. */
    });
}
export async function measure<T>(
  stage: string,
  action: () => Promise<T>,
  fields: Fields = {},
): Promise<T> {
  const start = performance.now();
  try {
    const result = await action();
    record(stage, {
      ...fields,
      status: "ok",
      elapsed_ms: Math.round(performance.now() - start),
    });
    return result;
  } catch (error) {
    record(stage, {
      ...fields,
      status: "error",
      elapsed_ms: Math.round(performance.now() - start),
      code: error instanceof Error ? error.name : "Error",
    });
    throw error;
  }
}
export const flushDiagnostics = () => writes;
