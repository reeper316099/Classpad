#!/usr/bin/env node
// Measures the TypeScript API (packages/server on Node.js) and the Go API (cmd/classpad-server), each as
// its own process on a fresh data folder with the invented demo data: time to ready, memory, and the
// time per request for a few routes.
//
//   npx tsc -b packages/server && go build -ldflags="-s -w" -o /tmp/classpad-server ./cmd/classpad-server
//   node scripts/api-bench.mjs --go /tmp/classpad-server [--runs 10] [--requests 300]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const GO = arg('go');
if (!GO) throw new Error('--go <path to classpad-server> is required');
const RUNS = Number(arg('runs', 10));
const REQUESTS = Number(arg('requests', 300));
const TOKEN = 'bench-token';
const root = mkdtempSync(path.join(tmpdir(), 'classpad-api-bench-'));

// a launcher for the TypeScript server that prints the same ready line as the Go one
const launcher = path.join(root, 'ts-server.mjs');
const serverDist = new URL('../packages/server/dist/index.js', import.meta.url).href;
writeFileSync(
  launcher,
  `const { startServer } = await import(${JSON.stringify(serverDist)});
const s = await startServer({ dataDir: process.argv[2], token: process.env.CLASSPAD_TOKEN, watch: false, port: 0 });
console.log(JSON.stringify({ ready: true, url: s.url }));
process.stdin.resume();
process.stdin.on('end', () => s.close().then(() => process.exit(0)));`,
);

const kinds = {
  typescript: (dir) => [process.execPath, [launcher, dir]],
  go: (dir) => [GO, ['--data-dir', dir, '--watch=false', '--exit-with-stdin']],
};

async function start(kind, dir) {
  const [cmd, args] = kinds[kind](dir);
  const t0 = process.hrtime.bigint();
  const child = spawn(cmd, args, {
    env: { ...process.env, CLASSPAD_TOKEN: TOKEN },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const line = await new Promise((resolve, reject) => {
    child.once('exit', (c) => reject(new Error(`${kind} server exited (${c})`)));
    createInterface({ input: child.stdout }).once('line', resolve);
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const { url } = JSON.parse(line);
  return {
    url,
    ms,
    pid: child.pid,
    stop: () =>
      new Promise((resolve) => {
        child.removeAllListeners('exit');
        child.once('exit', resolve);
        child.stdin.end();
      }),
  };
}

const call = (base, method, url) =>
  new Promise((resolve, reject) => {
    const req = request(
      base + url,
      { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } },
      (r) => {
        r.resume();
        r.on('end', () => resolve(r.statusCode));
      },
    );
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : '{}');
  });

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const rssMB = (pid) =>
  Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString()) / 1024;

const ROUTES = [
  '/api/v1/health',
  '/api/v1/assignments?limit=100&sort=due',
  '/api/v1/gpa',
  '/api/v1/stats/overview',
  '/api/v1/search?q=lorem',
  '/api/v1/export/report',
];

const results = {};
for (const kind of Object.keys(kinds)) {
  const starts = [];
  for (let i = 0; i < RUNS; i++) {
    const s = await start(kind, path.join(root, `${kind}-start-${i}`));
    starts.push(s.ms);
    await s.stop();
  }
  const s = await start(kind, path.join(root, `${kind}-load`));
  const idle = rssMB(s.pid);
  if ((await call(s.url, 'POST', '/api/v1/demo/load')) !== 200) throw new Error('demo load failed');
  const perRoute = {};
  for (const r of ROUTES) {
    for (let i = 0; i < 20; i++) await call(s.url, 'GET', r); // warm-up
    const times = [];
    for (let i = 0; i < REQUESTS; i++) {
      const t0 = process.hrtime.bigint();
      const status = await call(s.url, 'GET', r);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (status !== 200) throw new Error(`${kind} ${r}: ${status}`);
    }
    perRoute[r] = median(times);
  }
  const loaded = rssMB(s.pid);
  await s.stop();
  results[kind] = { startMs: median(starts), idleRssMB: idle, loadedRssMB: loaded, perRoute };
}

const f = (n, d = 2) => n.toFixed(d);
console.log(
  `start-up to ready (median of ${RUNS}): TS ${f(results.typescript.startMs, 0)} ms, Go ${f(results.go.startMs, 0)} ms`,
);
console.log(
  `memory idle: TS ${f(results.typescript.idleRssMB, 1)} MB, Go ${f(results.go.idleRssMB, 1)} MB`,
);
console.log(
  `memory after demo + requests: TS ${f(results.typescript.loadedRssMB, 1)} MB, Go ${f(results.go.loadedRssMB, 1)} MB`,
);
for (const r of ROUTES)
  console.log(
    `${r}: TS ${f(results.typescript.perRoute[r], 3)} ms, Go ${f(results.go.perRoute[r], 3)} ms (median of ${REQUESTS})`,
  );
rmSync(root, { recursive: true, force: true });
