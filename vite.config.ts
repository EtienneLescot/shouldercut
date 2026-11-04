import { existsSync, readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import { shouldercutBridge } from './server/bridge.js';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const gated = Boolean((env.SHOULDERCUT_ACCESS_KEY || '').trim());

  // TLS, because a remote tester on plain HTTP is not merely insecure, the
  // app does not run: WebCodecs, WebGPU and getUserMedia are all gated on a
  // secure context, so over http:// they lose decoding, rendering and the
  // microphone -- which is the whole editor. localhost is exempt by spec,
  // which is why none of this shows up until the first remote load.
  //
  // Either cert works and nothing here knows the difference: a real
  // Let's Encrypt one from `tailscale cert` (no browser warning, needs
  // HTTPS Certificates enabled on the tailnet), or the self-signed pair in
  // .certs (one click-through). Absent both, we stay on HTTP, which is
  // right for localhost.
  const certFile = env.SHOULDERCUT_TLS_CERT || '.certs/cert.pem';
  const keyFile = env.SHOULDERCUT_TLS_KEY || '.certs/key.pem';
  const tls =
    existsSync(certFile) && existsSync(keyFile)
      ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
      : undefined;
  return {
    plugins: [shouldercutBridge()],
    worker: {
      format: 'es',
    },
    server: {
      // Vite refuses any Host it does not recognise, which is every tunnel:
      // the request is answered with "This host is not allowed" before our
      // own middleware runs, so no amount of auth behind it helps. That
      // check is a DNS-rebinding guard for an *unauthenticated* dev server.
      // Once SHOULDERCUT_ACCESS_KEY is set, every route demands a real
      // credential and a rebound request arrives without one -- cookies do
      // not cross origins -- so the host name is no longer what protects us.
      // With no key set we keep Vite's default, which is right for
      // localhost. Nothing here names a tunnel, a tailnet or a port, so it
      // holds for whatever we put in front of it next.
      allowedHosts: gated ? true : undefined,
      // And which interface we answer on. Loopback is right while the editor
      // is only for this machine; once a key is set it is meant to be
      // reached, and a server bound to 127.0.0.1 cannot be -- not by a
      // tunnel, not by anything.
      //
      // Answering everywhere rather than on one pinned address is deliberate.
      // Vite takes a single host, so pinning the tunnel address drops
      // loopback, and loopback is how every local caller reaches us: the MCP
      // server, the voice agent, the dogfood harness, npm run demo. They all
      // broke the first time this was tried. What keeps the editor safe is
      // the key on every route, not which interface it listens on --
      // SHOULDERCUT_HOST stays available for anyone who wants to narrow it
      // and can live without the local tools.
      //
      // This is the only place that decides: the npm scripts no longer pass
      // --host, so they inherit it.
      host: gated ? env.SHOULDERCUT_HOST || true : '127.0.0.1',
      https: tls,
    },
  };
});
