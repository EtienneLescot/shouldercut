// Local measurements only; use --since ISO_DATE to isolate one test/session.
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
const dir = resolve(process.cwd(), ".runtime");
const sinceArg = process.argv.indexOf("--since");
const since = sinceArg < 0 ? 0 : Date.parse(process.argv[sinceArg + 1]);
if (!Number.isFinite(since)) throw new Error("--since expects an ISO date");
const rows = [];
for (const file of await readdir(dir).catch(() => [])) {
  if (!/^ux-(server|voice)\.jsonl(?:\.1)?$/.test(file)) continue;
  for (const line of (await readFile(resolve(dir, file), "utf8")).split("\n")) {
    try {
      const row = JSON.parse(line);
      if (Date.parse(row.timestamp) >= since) rows.push(row);
    } catch {
      /* unfinished line */
    }
  }
}
const groups = new Map();
for (const row of rows) {
  for (const [field, value] of Object.entries(row)) {
    if (!field.endsWith("_ms") || typeof value !== "number" || value < 0)
      continue;
    const key = `${row.component} / ${row.stage}${row.route ? " " + row.route : ""} / ${field}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
}
const percentile = (values, p) =>
  values[Math.max(0, Math.ceil(values.length * p) - 1)];
const timings = [...groups].map(([stage, values]) => {
  values.sort((a, b) => a - b);
  return {
    stage,
    n: values.length,
    p50_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
    max_ms: values.at(-1),
  };
});
console.table(timings);
const errors = rows
  .filter((r) => r.status === "error")
  .map(({ timestamp, stage, traceId, code, route, http_status }) => ({
    timestamp,
    stage,
    traceId,
    code,
    route,
    http_status,
  }));
if (errors.length) console.table(errors);
console.log(
  JSON.stringify({
    events: rows.length,
    errors: errors.length,
    cacheHits: rows.filter((r) => r.cached === true).length,
    journal: dir,
  }),
);
