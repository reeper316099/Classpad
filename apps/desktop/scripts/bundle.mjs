// Bundles the Electron main + preload into single CommonJS files (all JS dependencies inlined, so the
// packaged app needs no node_modules) and copies the built web UI next to them.
import { build } from 'esbuild';
import { cp, mkdir, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const root = path.join(desktop, '..', '..');
const dist = path.join(desktop, 'dist');

const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('npx', ['tsc', '-b']);
run('npm', ['run', 'build', '-w', '@classpad/web']);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  legalComments: 'none',
};
await build({
  ...common,
  entryPoints: [path.join(desktop, 'src/main.ts')],
  outfile: path.join(dist, 'main.cjs'),
  external: ['electron', 'fsevents'],
  minify: true,
  keepNames: true,
});
await build({
  ...common,
  entryPoints: [path.join(desktop, 'src/preload.ts')],
  outfile: path.join(dist, 'preload.cjs'),
  external: ['electron'],
});
await access(path.join(root, 'apps/web/dist/index.html'));
await cp(path.join(root, 'apps/web/dist'), path.join(dist, 'web'), { recursive: true });
console.log('Bundled to', dist);
