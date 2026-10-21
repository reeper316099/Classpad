#!/usr/bin/env node
// Runs the local API and the web UI together for development.
//   npm run dev        start both
//   npm run dev:stop   stop any dev servers left running (frees ports 4783 and 5173)
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 4783,
  UI_PORT = 5173;

const inUse = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });

if (process.argv.includes('--stop')) {
  for (const port of [API_PORT, UI_PORT]) {
    const r = spawnSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' });
    for (const pid of r.stdout.split('\n').filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGTERM');
        console.log(`stopped process ${pid} on port ${port}`);
      } catch {
        /* already gone */
      }
    }
  }
  process.exit(0);
}

const busy = [];
if (await inUse(API_PORT)) busy.push(`API port ${API_PORT}`);
if (await inUse(UI_PORT)) busy.push(`UI port ${UI_PORT}`);
if (busy.length) {
  console.error(
    `\n✖ ${busy.join(' and ')} already in use. Another Classpad dev server is probably still running.\n  Stop it with:  npm run dev:stop   (then run  npm run dev  again)\n`,
  );
  process.exit(1);
}

const env = {
  ...process.env,
  CLASSPAD_TOKEN: 'dev-token',
  PORT: String(API_PORT),
  CLASSPAD_DATA_DIR: process.env.CLASSPAD_DATA_DIR ?? path.join(root, '.dev-data'),
  VITE_API_URL: `http://127.0.0.1:${API_PORT}`,
  VITE_API_TOKEN: 'dev-token',
};

const build = spawnSync('npx', ['tsc', '-b'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const kids = [
  [
    'API server',
    spawn('node', ['packages/server/dist/dev.js'], { cwd: root, env, stdio: 'inherit' }),
  ],
  [
    'web UI',
    spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(UI_PORT), '--strictPort'], {
      cwd: path.join(root, 'apps/web'),
      env,
      stdio: 'inherit',
    }),
  ],
];
let stopping = false;
const stop = () => {
  stopping = true;
  for (const [, k] of kids) k.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const [name, k] of kids)
  k.on('exit', (code) => {
    if (!stopping)
      console.error(
        `\n✖ The ${name} stopped unexpectedly (exit code ${code}). Scroll up for the reason; stopping the other one too.\n`,
      );
    stop();
    setTimeout(() => process.exit(stopping && code === null ? 0 : (code ?? 0)), 300);
  });
console.log(
  `\nStarting…  UI: http://127.0.0.1:${UI_PORT}   data folder: ${env.CLASSPAD_DATA_DIR}\n`,
);
