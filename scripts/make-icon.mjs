#!/usr/bin/env node
// Generates the app icon (an original design: gradient tile with a four-point spark) as PNGs.
// Pure JS, no dependencies. Usage: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop', 'build');
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, c]);
};
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const A = [99, 102, 241],
  B = [236, 72, 153];
// signed distance to a rounded square (iOS-style ~22% corner), and a four-point star
const sdRound = (x, y, r) => {
  const qx = Math.abs(x - 0.5) - (0.5 - r),
    qy = Math.abs(y - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const star = (x, y) => {
  const dx = Math.abs(x - 0.5),
    dy = Math.abs(y - 0.5);
  return Math.pow(dx, 0.55) + Math.pow(dy, 0.55) - Math.pow(0.27, 0.55);
};

const pixel = (u, v) => {
  const edge = sdRound(u, v, 0.22);
  const cover = Math.min(1, Math.max(0, 0.5 - edge * 1024)); // ~1px antialiasing at 1024
  if (cover <= 0) return [0, 0, 0, 0];
  const t = Math.min(1, Math.max(0, (u + v) / 2 + (v - u) * 0.1));
  let [r, g, b] = mix(A, B, t);
  const glow = Math.max(0, 1 - Math.hypot(u - 0.3, v - 0.25) * 2.2) * 38;
  r += glow;
  g += glow;
  b += glow;
  const s = star(u, v);
  const sc = Math.min(1, Math.max(0, 0.5 - s * 60));
  r = r + (255 - r) * sc;
  g = g + (255 - g) * sc;
  b = b + (255 - b) * sc;
  return [Math.min(255, r), Math.min(255, g), Math.min(255, b), Math.round(255 * cover)].map(
    Math.round,
  );
};

writeFileSync(join(out, 'icon.png'), png(1024, pixel)); // electron-builder derives .icns/.ico from this
writeFileSync(join(out, 'icon-256.png'), png(256, pixel));
console.log('icons written to', out);
