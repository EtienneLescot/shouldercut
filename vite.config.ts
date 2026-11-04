import { defineConfig, loadEnv } from 'vite';
import { shouldercutBridge } from './server/bridge.js';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const gated = Boolean((env.SHOULDERCUT_ACCESS_KEY || '').trim());
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
    },
  };
});
