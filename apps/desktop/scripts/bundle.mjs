// Bundles the Electron main + preload into single CommonJS files (all JS dependencies inlined, so the
// packaged app needs no node_modules), copies the built web UI next to them and builds the Go API
// server (cmd/classpad-server) into dist/bin. On macOS the server is universal (arm64 + x64), like
// the app.
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

// the API server, in Go
const bin = path.join(dist, 'bin');
await mkdir(bin, { recursive: true });
const exe = process.platform === 'win32' ? 'classpad-server.exe' : 'classpad-server';
const goBuild = (out, env = {}) => {
  const r = spawnSync(
    'go',
    ['build', '-trimpath', '-ldflags=-s -w', '-o', out, './cmd/classpad-server'],
    { cwd: root, stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0', ...env } },
  );
  if (r.error || r.status !== 0) {
    console.error(
      'Building the Go server failed. Go 1.26 or newer is needed (https://go.dev/dl/).',
    );
    process.exit(r.status ?? 1);
  }
};
if (process.platform === 'darwin') {
  const arm = path.join(bin, 'classpad-server-arm64');
  const x64 = path.join(bin, 'classpad-server-amd64');
  goBuild(arm, { GOOS: 'darwin', GOARCH: 'arm64' });
  goBuild(x64, { GOOS: 'darwin', GOARCH: 'amd64' });
  run('lipo', ['-create', '-output', path.join(bin, exe), arm, x64]);
  await rm(arm);
  await rm(x64);
} else {
  goBuild(path.join(bin, exe));
}
await cp(path.join(root, 'apps/web/dist'), path.join(dist, 'web'), { recursive: true });
console.log('Bundled to', dist);
