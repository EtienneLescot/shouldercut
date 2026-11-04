// Start the existing editor, local LiveKit transport, and voice worker together.
// Reuse services already running; only terminate processes owned by this launcher.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
if (existsSync('.env')) process.loadEnvFile('.env');
if (process.env.SHOULDERCUT_VOICE_ENV) process.loadEnvFile(process.env.SHOULDERCUT_VOICE_ENV);
const children = [];
let stopping = false;
function start(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, env: process.env, windowsHide: true, stdio: 'inherit' });
  children.push(child);
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => { if (!stopping) stop(code || 0); });
  return child;
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 600);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
async function responds(url) {
  return fetch(url, { signal: AbortSignal.timeout(1200) }).then((r) => r.ok).catch(() => false);
}
async function waitFor(url, seconds = 45) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline && !stopping) {
    if (await responds(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Service did not become ready: ' + url);
}
try {
  if (!process.env.LIVEKIT_URL) throw new Error('Configure LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in .env.');
  const lk = new URL(process.env.LIVEKIT_URL);
  if (['localhost', '127.0.0.1'].includes(lk.hostname)) {
    const health = `http://${lk.host}/`;
    if (!await responds(health)) {
      const binary = process.env.LIVEKIT_SERVER || (process.platform === 'win32' ? 'E:\\livekit\\livekit-server.exe' : 'livekit-server');
      start(binary, ['--dev', '--bind', '127.0.0.1']);
      await waitFor(health);
    }
  }
  if (!await responds('http://127.0.0.1:5173/api/health')) {
    start(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort']);
    await waitFor('http://127.0.0.1:5173/api/health');
  }
  if (!await responds('http://127.0.0.1:8081/')) {
    start('uv', ['run', 'python', 'agent.py', 'start'], resolve('voice'));
    await waitFor('http://127.0.0.1:8081/', 90);
  }
  console.log('ShoulderCut ready: http://127.0.0.1:5173 — click Talk, then speak freely.');
} catch (error) {
  console.error(error.message);
  stop(1);
}
