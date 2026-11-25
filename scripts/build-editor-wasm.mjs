#!/usr/bin/env node
// Builds the note editor's Go core (cmd/editorwasm) to WebAssembly for the web UI, and copies Go's
// wasm_exec.js loader next to it. Output: apps/web/public/editor/{editor.wasm,wasm_exec.js}.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'apps/web/public/editor');
mkdirSync(out, { recursive: true });

const go = (args, env = {}) =>
  spawnSync('go', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });

const goroot = go(['env', 'GOROOT']);
if (goroot.status !== 0) {
  console.error(
    'Go is required to build the note editor (https://go.dev/dl/, version 1.24 or newer).',
  );
  process.exit(1);
}
const build = go(
  ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(out, 'editor.wasm'), './cmd/editorwasm'],
  { GOOS: 'js', GOARCH: 'wasm' },
);
if (build.status !== 0) {
  process.stderr.write(build.stderr);
  process.exit(build.status ?? 1);
}
// Go 1.24+ keeps the loader in lib/wasm (older versions used misc/wasm)
const dir = goroot.stdout.trim();
const loader = [
  path.join(dir, 'lib/wasm/wasm_exec.js'),
  path.join(dir, 'misc/wasm/wasm_exec.js'),
].find((p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
});
if (!loader) {
  console.error('wasm_exec.js not found in GOROOT');
  process.exit(1);
}
copyFileSync(loader, path.join(out, 'wasm_exec.js'));
const kb = (statSync(path.join(out, 'editor.wasm')).size / 1024).toFixed(0);
console.log(`editor core built: apps/web/public/editor/editor.wasm (${kb} KB)`);
