import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from './app.js';
import { readStatic } from './static.js';

let dir: string, web: string;
let srv: Awaited<ReturnType<typeof startServer>>;
const TOKEN = 'tok';

function req(
  p: string,
  opts: { host?: string; method?: string; auth?: boolean } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port: srv.port,
        path: p,
        method: opts.method ?? 'GET',
        headers: {
          ...(opts.host ? { host: opts.host } : {}),
          ...(opts.auth ? { authorization: `Bearer ${TOKEN}` } : {}),
        },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
      },
    );
    r.on('error', reject);
    r.end();
  });
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'classpad-static-'));
  web = path.join(dir, 'web');
  await mkdir(path.join(web, 'assets'), { recursive: true });
  await writeFile(path.join(web, 'index.html'), '<!doctype html><title>app</title>');
  await writeFile(path.join(web, 'assets', 'index-AbCd1234.js'), 'console.log(1)');
  await writeFile(path.join(dir, 'secret.txt'), 'TOP SECRET');
  srv = await startServer({ dataDir: path.join(dir, 'data'), token: TOKEN, staticDir: web });
});
afterAll(async () => {
  await srv.close();
  await rm(dir, { recursive: true, force: true });
});

describe('serving the built UI', () => {
  it('serves index.html at / and unknown client routes, without a token', async () => {
    for (const p of ['/', '/classes', '/notes/abc123']) {
      const r = await req(p);
      expect(r.status).toBe(200);
      expect(r.body).toContain('<title>app</title>');
    }
  });
  it('sets strict headers and immutable caching for hashed assets', async () => {
    const r = await req('/assets/index-AbCd1234.js');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('javascript');
    expect(r.headers['cache-control']).toContain('immutable');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect((await req('/')).headers['cache-control']).toBe('no-cache');
  });
  it('missing assets 404 instead of returning the app shell', async () => {
    expect((await req('/assets/missing.js')).status).toBe(404);
    expect((await req('/favicon.ico')).status).toBe(404);
  });
  it('cannot be tricked into reading files outside the web root', async () => {
    for (const p of [
      '/../secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e/secret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/%00',
      '/..%5csecret.txt',
    ]) {
      const r = await req(p);
      expect(r.body).not.toContain('TOP SECRET');
    }
    expect(await readStatic(web, '/../secret.txt')).toBeNull();
    expect((await readStatic(web, '/..%2fsecret.txt'))?.body.toString() ?? '').not.toContain(
      'TOP SECRET',
    );
    expect(await readStatic(web, '/a%00b.js')).toBeNull();
  });
});

describe('API stays protected', () => {
  it('requires the token under /api even when the UI is public', async () => {
    expect((await req('/api/v1/health')).status).toBe(401);
    expect((await req('/api/v1/health', { auth: true })).status).toBe(200);
    expect((await req('/api/v1/nope')).status).toBe(401);
  });
  it('non-GET requests outside /api need the token too', async () => {
    expect((await req('/', { method: 'POST' })).status).toBe(401);
  });
  it('rejects unexpected Host headers (DNS rebinding)', async () => {
    const r = await req('/api/v1/health', { host: 'evil.example:80', auth: true });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error.code).toBe('BAD_HOST');
    expect((await req('/', { host: 'attacker.test' })).status).toBe(403);
    expect(
      (await req('/api/v1/health', { host: `localhost:${srv.port}`, auth: true })).status,
    ).toBe(200);
  });
  it('binds to loopback only', () => {
    expect(srv.host).toBe('127.0.0.1');
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('dev server behind a proxy on another loopback port', () => {
  it('accepts loopback hosts on any port in dev (so a Vite proxy works) but never other names', async () => {
    const dev = await startServer({ dataDir: path.join(dir, 'data-dev'), token: TOKEN, dev: true });
    const call = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const r = http.request(
          {
            host: '127.0.0.1',
            port: dev.port,
            path: '/api/v1/health',
            headers: { host, authorization: `Bearer ${TOKEN}` },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        r.on('error', reject);
        r.end();
      });
    expect(await call('127.0.0.1:5173')).toBe(200);
    expect(await call('localhost:5173')).toBe(200);
    expect(await call('evil.example:5173')).toBe(403);
    expect(await call('127.0.0.1.evil.example')).toBe(403);
    await dev.close();
    // production stays strict: other ports are refused
    expect(
      await new Promise<number>((resolve) => {
        const r = http.request(
          {
            host: '127.0.0.1',
            port: srv.port,
            path: '/api/v1/health',
            headers: { host: '127.0.0.1:5173', authorization: `Bearer ${TOKEN}` },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        r.end();
      }),
    ).toBe(403);
  });
});

describe('shutdown', () => {
  it('closes promptly even with an open live-update (SSE) connection', async () => {
    const s = await startServer({ dataDir: path.join(dir, 'data-sse'), token: TOKEN });
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get(
          { host: '127.0.0.1', port: s.port, path: `/api/v1/events?access_token=${TOKEN}` },
          resolve,
        )
        .on('error', reject);
    });
    expect(res.statusCode).toBe(200);
    res.on('error', () => undefined);
    const t0 = Date.now();
    await s.close();
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
