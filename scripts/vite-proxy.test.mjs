import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('dev proxy', () => {
  // The API rejects unexpected Host headers (DNS-rebinding guard). The proxy should send the API's own host,
  // otherwise requests can be refused and the app looks empty.
  it('rewrites the Host header to the API target', () => {
    const cfg = readFileSync(new URL('../apps/web/vite.config.ts', import.meta.url), 'utf8');
    expect(cfg).toMatch(/changeOrigin:\s*true/);
  });
});
