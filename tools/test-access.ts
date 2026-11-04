import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCESS_COOKIE,
  accessVerdict,
  readCookie,
  sameOrigin,
  ungated,
} from "../server/access.ts";

// What these guard: the editor is one local server with ffmpeg, the project
// files, an unauthenticated ComfyUI and every provider key behind it. Putting
// it on a tunnel exposes all of that, so the gate has to hold for every shape
// of caller -- not just the browser that happened to be in front of us.

const KEY = "s3cret-demo-key";

test("no key configured leaves the server open", () => {
  // Localhost, the tests and `npm run demo` all run without a key and must
  // not notice this code exists.
  assert.equal(accessVerdict(undefined, {}), "open");
  assert.equal(accessVerdict("", {}), "open");
  assert.equal(accessVerdict("   ", { query: "anything" }), "open");
});

test("the right key on the URL is traded for a cookie", () => {
  assert.equal(accessVerdict(KEY, { query: KEY }), "grant");
  // Surrounding whitespace in .env is the user's, not the tester's.
  assert.equal(accessVerdict(`  ${KEY}  `, { query: KEY }), "grant");
});

test("a key already carried just passes", () => {
  assert.equal(accessVerdict(KEY, { cookie: KEY }), "pass");
  assert.equal(accessVerdict(KEY, { header: KEY }), "pass");
});

test("the local processes get in by header, having no cookie", () => {
  // The MCP server, the voice agent and the dogfood harness call the same
  // API with no browser anywhere. They were the regression risk here.
  assert.equal(accessVerdict(KEY, { header: KEY, cookie: null }), "pass");
});

test("a wrong key is refused in every position", () => {
  assert.equal(accessVerdict(KEY, { query: "nope" }), "deny");
  assert.equal(accessVerdict(KEY, { cookie: "nope" }), "deny");
  assert.equal(accessVerdict(KEY, { header: "nope" }), "deny");
  assert.equal(accessVerdict(KEY, {}), "deny");
  assert.equal(accessVerdict(KEY, { query: null, cookie: null }), "deny");
});

test("a key on the URL decides on its own, right or wrong", () => {
  // Otherwise a stale cookie would quietly win over the link someone was
  // just given, and there would be no way to correct it but clearing the
  // browser. A wrong one in the URL is an answer too.
  assert.equal(accessVerdict(KEY, { query: KEY, cookie: "stale" }), "grant");
  assert.equal(accessVerdict(KEY, { query: "nope", cookie: KEY }), "deny");
});

test("near-misses are not close enough", () => {
  assert.equal(accessVerdict(KEY, { query: KEY + " " }), "deny");
  assert.equal(accessVerdict(KEY, { query: KEY.toUpperCase() }), "deny");
  assert.equal(accessVerdict(KEY, { query: KEY.slice(0, -1) }), "deny");
  assert.equal(accessVerdict(KEY, { query: "" }), "deny");
});

test("the cookie is read out of a real Cookie header", () => {
  assert.equal(
    readCookie(`other=1; ${ACCESS_COOKIE}=${KEY}; last=2`, ACCESS_COOKIE),
    KEY,
  );
  assert.equal(readCookie(`${ACCESS_COOKIE}=${KEY}`, ACCESS_COOKIE), KEY);
  assert.equal(readCookie(undefined, ACCESS_COOKIE), undefined);
  assert.equal(readCookie("unrelated=1", ACCESS_COOKIE), undefined);
  // A name that merely ends in ours is not ours.
  assert.equal(readCookie(`not_${ACCESS_COOKIE}=x`, ACCESS_COOKIE), undefined);
  // Percent-encoding survives the round trip, and a malformed escape does
  // not throw the whole request away.
  assert.equal(readCookie(`${ACCESS_COOKIE}=a%20b`, ACCESS_COOKIE), "a b");
  assert.equal(readCookie(`${ACCESS_COOKIE}=100%`, ACCESS_COOKIE), "100%");
});

test("same origin is whatever host the request arrived on", () => {
  // The literal this replaced was `http://127.0.0.1:5173`, the one origin a
  // tunnelled editor never has.
  assert.ok(sameOrigin("http://127.0.0.1:5173", "127.0.0.1:5173"));
  assert.ok(sameOrigin("http://localhost:5173", "localhost:5173"));
  assert.ok(sameOrigin("https://box.tail1234.ts.net", "box.tail1234.ts.net"));
  assert.ok(sameOrigin("http://127.0.0.1:4173", "127.0.0.1:4173"));
  assert.ok(sameOrigin("https://BOX.ts.net", "box.ts.net"));
});

test("a different origin is still refused", () => {
  assert.equal(sameOrigin("http://evil.example", "127.0.0.1:5173"), false);
  // A different port is a different origin, which is the point of the check.
  assert.equal(sameOrigin("http://127.0.0.1:5174", "127.0.0.1:5173"), false);
  assert.equal(sameOrigin("not a url", "127.0.0.1:5173"), false);
  assert.equal(sameOrigin("http://127.0.0.1:5173", undefined), false);
});

test("a caller sending no Origin is left to the access gate", () => {
  // curl, the MCP server and the voice agent send none; refusing them here
  // would break every local tool while protecting nothing.
  assert.ok(sameOrigin(undefined, "127.0.0.1:5173"));
  assert.ok(sameOrigin(null, undefined));
});

test("the liveness probe answers without a key, and nothing else does", () => {
  // npm run demo decides from /api/health whether to start Vite at all. Gate
  // it and the demo starts a second server on a port already taken.
  assert.ok(ungated("/api/health"));
  for (const route of [
    "/api/project",
    "/api/state",
    "/api/gen/edit",
    "/api/voice/token",
    "/api/assistant/context",
    "/api/export",
    "/",
    "/index.html",
    "/src/main.ts",
    "/api/health/../project",
  ])
    assert.equal(ungated(route), false, route + " must stay behind the gate");
});
