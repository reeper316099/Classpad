#!/usr/bin/env node
// Runs the local API and the web UI together for development.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = {
  ...process.env,
  CLASSPAD_TOKEN: 'dev-token',
  PORT: '4783',
  CLASSPAD_DATA_DIR: process.env.CLASSPAD_DATA_DIR ?? path.join(root, '.dev-data'),
  VITE_API_URL: 'http://127.0.0.1:4783',
  VITE_API_TOKEN: 'dev-token',
};

const build = spawnSync('npx', ['tsc', '-b'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const kids = [
  spawn('node', ['packages/server/dist/dev.js'], { cwd: root, env, stdio: 'inherit' }),
  spawn('npx', ['vite', '--host', '127.0.0.1'], {
    cwd: path.join(root, 'apps/web'),
    env,
    stdio: 'inherit',
  }),
];
const stop = () => {
  for (const k of kids) k.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const k of kids)
  k.on('exit', () => {
    stop();
    process.exit(0);
  });
console.log(`\nData directory: ${env.CLASSPAD_DATA_DIR}\n`);
