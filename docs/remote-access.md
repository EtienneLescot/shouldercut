# Letting someone else drive this editor

ShoulderCut is one local server. The browser only ever calls `/api/...` on
its own origin; behind that origin sit ffmpeg, the clip store, the project
file, a ComfyUI that answers without asking who you are, and the keys for
every hosted provider we bill to. **Nothing is bundled into the front-end** —
there is no `VITE_`-prefixed variable anywhere, and the browser's only
credential is a short-lived LiveKit token minted server-side.

Two consequences, and they are the whole design:

- **A tester enters no keys.** They get a link. Every provider key stays in
  the `.env` on the machine running the server.
- **A tunnel does not expose a page, it exposes all of the above.** So the
  check sits ahead of the entire server, not on the generation routes.

## Running it open (the default)

With `SHOULDERCUT_ACCESS_KEY` unset there is no gate and no behaviour change:
`npm run dev`, `npm run demo`, the tests and every local tool work exactly as
before, and Vite keeps its own `Host` guard. This is the right setting for
localhost.

## Running it reachable

Set one key:

```bash
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

Put it in `.env` as `SHOULDERCUT_ACCESS_KEY=...`, restart the dev server, then
put the port on your tailnet:

```bash
tailscale serve --bg 5173
```

`tailscale serve` is reachable by devices on your tailnet; `tailscale funnel
--bg 5173` publishes it to the whole internet. Either way the key is what
stands in front of it. Send the tester one URL:

```
https://<your-machine>.<your-tailnet>.ts.net/?key=<the key>
```

That request is answered with a cookie and a redirect to `/`, so the key
leaves the address bar, the history and the referrer on first load. The cookie
is `HttpOnly`, `SameSite=Lax`, and lasts 12 hours.

## How a caller presents the key

Three shapes, because we have three kinds of caller:

| Caller | Presents |
| --- | --- |
| A browser handed a link | `?key=` on the URL, once |
| That browser afterwards | the `sc_access` cookie |
| The MCP server, the voice agent, the dogfood harness | `X-ShoulderCut-Key` header |

The local processes have no browser and no cookie, so they read the same env
var and send the header. A key on the URL decides on its own, right or wrong:
otherwise a stale cookie would quietly outrank the link someone was just
given, with no way to correct it but clearing the browser.

`/api/health` answers ahead of the gate. It returns `{ok, service}` and
nothing else, and every supervisor polls it — `npm run demo` decides from it
whether to start Vite at all, so gating it would have had the demo start a
second server on a port already taken.

## Two things the tunnel also needed

Both were found by trying it, not by reading it:

- **The origin allow-list** was the literal `http://127.0.0.1:5173`, which is
  the one origin a tunnelled editor never has. It now compares `Origin`
  against the `Host` the request arrived on, which says the same thing for
  localhost and keeps saying it for any tunnel, name or port.
- **Vite 8 refuses an unrecognised `Host`** with "This host is not allowed"
  *before* any middleware runs, so no amount of auth behind it helps.
  `allowedHosts` is now tied to the key: that check is a DNS-rebinding guard
  for an *unauthenticated* dev server, and once every route demands a real
  credential a rebound request arrives without one, because cookies do not
  cross origins. With no key set, Vite's default stays.

## HTTPS is not optional for a remote tester

Found by loading the editor from the tailnet address rather than by reading
the code: over plain `http://` on any origin that is not localhost, the page
is not a secure context, and three things the editor is built on are gated on
one -- WebCodecs (`VideoDecoder is not defined`, which is what showed up),
WebGPU, and `getUserMedia`. That is decoding, rendering and the microphone:
the whole editor. localhost is exempt by spec, which is exactly why none of
it appears until the first remote load.

`vite.config.ts` picks up a certificate from `.certs/cert.pem` and
`.certs/key.pem` (override with `SHOULDERCUT_TLS_CERT` / `SHOULDERCUT_TLS_KEY`)
and serves HTTPS when both exist, HTTP when they do not. Two ways to get one:

- **A real certificate.** `tailscale cert <machine>.<tailnet>.ts.net` mints a
  Let’s Encrypt one, no browser warning anywhere. It needs **HTTPS
  Certificates** enabled for the tailnet first, at
  <https://login.tailscale.com/admin/dns> -- without it the CLI answers
  "your Tailscale account does not support getting TLS certs".
- **A tunnel that terminates TLS for you** (ngrok, cloudflared). Then leave
  `.certs/` absent so Vite stays on HTTP and the tunnel presents the real
  certificate. This publishes to the whole internet, so the access key is
  doing real work.

A self-signed certificate is a dead end for anyone but you: it gives a secure
context, but some browsers refuse it outright with no click-through, so a
tester can be stopped at the door.

With TLS on, the local callers have to follow. `.env` sets
`SHOULDERCUT_BRIDGE=https://127.0.0.1:5173` and points `NODE_EXTRA_CA_CERTS`
and `SSL_CERT_FILE` at the certificate, which Node and Python both honour and
which trusts that one certificate and nothing else.

## Known gaps

- **Vite's HMR websocket is not gated.** It upgrades on the HTTP server rather
  than passing through the middleware stack, so over a public Funnel it would
  serve module source to someone who never presented the key. On a tailnet
  that is nothing; for a public URL, build and serve instead of exposing dev.
- **`npm run preview` has no API at all.** The bridge installs itself in
  `configureServer`, which only runs in dev, so the preview server serves the
  front-end and 404s every `/api/` call. Expose the dev server.
- **Every generation the tester runs is billed to the keys in your `.env`.**
  The access key is not only a security boundary, it is the wallet. Point
  `GEN_PROVIDER` at a local ComfyUI backend, or set `GEN_DRY_RUN=1`, before
  handing the link to anyone.
