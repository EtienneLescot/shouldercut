import { defineConfig } from 'vite';
import { shouldercutBridge } from './server/bridge.js';

export default defineConfig({
  plugins: [shouldercutBridge()],
  worker: {
    format: 'es',
  },
});
