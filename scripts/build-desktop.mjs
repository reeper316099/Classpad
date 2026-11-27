#!/usr/bin/env node
// Builds the Wails desktop app (cmd/classpad): the web interface, copied into cmd/classpad/web so the
// binary embeds it, then the Go program.
//
//   node scripts/build-desktop.mjs [--out build/classpad] [--skip-web] [--version 1.2.3] [--run]
// --run opens the app afterwards (on your usual data folder, or CLASSPAD_DATA_DIR).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const exe = process.platform === 'win32' ? '.exe' : '';
const out = path.resolve(root, arg('out', path.join('build', `classpad${exe}`)));
const version = arg('version', 'dev');

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32' && cmd !== 'go',
    ...opts,
  });
  if (r.error || r.status !== 0) {
    console.error(`✖ ${cmd} ${args.join(' ')} failed`);
    process.exit(r.status ?? 1);
  }
};

// the interface imports the workspace packages, which build first
if (!process.argv.includes('--skip-web')) {
  run('npx', ['tsc', '-b']);
  run('npm', ['run', 'build', '-w', '@classpad/web']);
}
const dist = path.join(root, 'apps/web/dist');
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('✖ apps/web/dist is missing; build the web interface first');
  process.exit(1);
}
const web = path.join(root, 'cmd/classpad/web');
mkdirSync(web, { recursive: true });
for (const f of readdirSync(web))
  if (f !== 'README.txt') rmSync(path.join(web, f), { recursive: true, force: true });
// release builds leave out source maps (12 MB); dev builds keep them for the web inspector
cpSync(dist, web, {
  recursive: true,
  filter: (src) => version === 'dev' || !src.endsWith('.map'),
});

const ldflags = `-X main.version=${version}${version === 'dev' ? '' : ' -s -w'}`;
// Windows: a GUI program (no console window) once it is a release
const flags = process.platform === 'win32' && version !== 'dev' ? ' -H windowsgui' : '';
// macOS: the Objective-C parts target the same minimum macOS as Go itself (13)
const env =
  process.platform === 'darwin'
    ? {
        ...process.env,
        CGO_CFLAGS: '-mmacosx-version-min=13.0',
        CGO_LDFLAGS: '-mmacosx-version-min=13.0',
      }
    : process.env;
run('go', ['build', '-trimpath', `-ldflags=${ldflags}${flags}`, '-o', out, './cmd/classpad'], {
  env,
});
console.log('Built', out);
if (process.argv.includes('--run')) run(out, [], { shell: false });
