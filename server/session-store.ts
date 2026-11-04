import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { record } from "./diagnostics.ts";

const folder = resolve(process.cwd(), ".runtime");
const file = resolve(folder, "session.json");
export function loadSession<T>(): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    record("session.restore", { status: "error", code: "invalid_snapshot" });
    return null;
  }
}
let writes = Promise.resolve();
let timer: ReturnType<typeof setTimeout> | undefined;
export function saveSession(snapshot: () => unknown): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const json = JSON.stringify(snapshot());
    writes = writes
      .then(async () => {
        await mkdir(folder, { recursive: true });
        await writeFile(file + ".tmp", json, "utf8");
        await rename(file + ".tmp", file);
      })
      .catch(() =>
        record("session.save", { status: "error", code: "write_failed" }),
      );
  }, 250);
}
