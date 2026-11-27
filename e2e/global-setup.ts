import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { serverBinary, webDir } from './harness';

/** Builds the Go API server once for the run; the interface must already be built. */
export default function globalSetup() {
  if (!existsSync(path.join(webDir, 'index.html')))
    throw new Error('Build the interface first: npm run build -w @classpad/web');
  const root = path.join(webDir, '../../..');
  const r = spawnSync('go', ['build', '-o', serverBinary, './cmd/classpad-server'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.error || r.status !== 0) throw new Error('building the Go server failed');
}
