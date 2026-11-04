/**
 * Who is allowed to reach this editor, when this machine is reachable from
 * outside itself.
 *
 * ShoulderCut runs as one local server: the browser only ever calls
 * `/api/...` on the same origin, and everything expensive sits behind that
 * origin -- ffmpeg, the project files, a ComfyUI that answers
 * unauthenticated, and the keys for every hosted provider we bill to. So a
 * tunnel (Tailscale, or anything like it) does not expose a page, it
 * exposes all of that.
 *
 * Which is why the check cannot live on the generation routes, or even on
 * `/api/`: the page itself is the way in, and whoever loads it can call
 * every route the app can call. It belongs ahead of the whole server, and
 * it has to let through the three shapes of caller we actually have --
 * a browser that was handed a link, a browser coming back with a cookie,
 * and the local processes (the MCP server, the voice agent, the dogfood
 * harness) that talk to the same API without one.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const ACCESS_COOKIE = "sc_access";
export const ACCESS_HEADER = "x-shouldercut-key";

/** How a request presented itself, in the order we trust it. */
export interface Presented {
  /** `?key=` on the URL: a link someone was given. Grants the cookie. */
  query?: string | null;
  /** The header a local, non-browser caller sends. */
  header?: string | null;
  /** The cookie a browser got on its first allowed load. */
  cookie?: string | null;
}

export type AccessVerdict =
  /** No key configured: this is localhost, nothing to gate. */
  | "open"
  /** Correct key on the URL: set the cookie and drop the key from it. */
  | "grant"
  /** Already carrying the key. Let it through untouched. */
  | "pass"
  | "deny";

/**
 * Constant-time compare that tolerates different lengths, which
 * `timingSafeEqual` on its own does not: hashing first makes both sides the
 * same width without telling the caller how wide the real key is.
 */
function secretEqual(a: string, b: string): boolean {
  const digest = (value: string): Buffer =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function accessVerdict(
  expected: string | undefined | null,
  presented: Presented,
): AccessVerdict {
  // An unset or blank key means the gate is not in use. Localhost, the
  // tests and `npm run demo` all land here and must behave as before.
  if (!expected || !expected.trim()) return "open";
  const key = expected.trim();
  // The URL comes first: it is how a tester arrives, and it is also how
  // someone fixes a stale or wrong cookie without clearing their browser.
  if (typeof presented.query === "string")
    return secretEqual(presented.query, key) ? "grant" : "deny";
  for (const carried of [presented.header, presented.cookie])
    if (typeof carried === "string" && secretEqual(carried, key)) return "pass";
  return "deny";
}

/**
 * Routes that answer before the gate.
 *
 * `/api/health` says "this server is up" and nothing else -- no state, no
 * paths, no keys. Every supervisor we have polls it: `npm run demo` decides
 * from it whether to start Vite at all, so gating it would have had the demo
 * launch a second server on a port already taken. A liveness probe that
 * needs a credential is a liveness probe nobody can use.
 */
export function ungated(pathname: string): boolean {
  return pathname === "/api/health";
}

/** Read one cookie out of a `Cookie:` header. */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/**
 * Whether a browser request came from the page we served.
 *
 * This used to be a literal `http://127.0.0.1:5173`, which is the one
 * origin a tunnelled editor never has. Comparing the `Origin` against the
 * `Host` the request actually arrived on says the same thing for localhost
 * and keeps saying it behind a tailnet name, a Funnel URL, a different
 * port, or whatever we put in front of it next.
 */
export function sameOrigin(
  origin: string | undefined | null,
  host: string | undefined | null,
): boolean {
  // Non-browser callers send no Origin at all; the access gate is what
  // stands between them and the API, not this.
  if (!origin) return true;
  if (!host) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return parsed.host.toLowerCase() === host.toLowerCase();
}
