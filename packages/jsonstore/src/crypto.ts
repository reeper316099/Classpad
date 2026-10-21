import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { StoreError } from './errors.js';

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export interface Crypto {
  key: Buffer;
  /** Which relative paths are stored encrypted. */
  shouldEncrypt: (rel: string) => boolean;
}

const MAGIC = '{"classpad":"enc1"';
export const isEnvelope = (text: string): boolean => text.startsWith(MAGIC);

/** Derive a 32-byte key from a passphrase (scrypt, N=32768). Different salts give independent keys. */
export const deriveKey = (passphrase: string, salt: Buffer): Promise<Buffer> =>
  scrypt(passphrase.normalize('NFKC'), salt, 32, SCRYPT);
export const newSalt = (): Buffer => randomBytes(16);

/** Constant-time check of a passphrase against a stored derived hash. */
export async function verifyHash(
  passphrase: string,
  salt: Buffer,
  expected: Buffer,
): Promise<boolean> {
  const got = await deriveKey(passphrase, salt);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** AES-256-GCM; the file's relative path is authenticated, so a ciphertext cannot be moved to another file. */
export function encryptText(key: Buffer, rel: string, text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(rel));
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return (
    JSON.stringify({
      classpad: 'enc1',
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    }) + '\n'
  );
}

export function decryptText(key: Buffer, rel: string, envelope: string): string {
  try {
    const e = JSON.parse(envelope) as { iv: string; tag: string; data: string };
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
    d.setAAD(Buffer.from(rel));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new StoreError(
      `cannot decrypt ${rel} (wrong passphrase, or the file was changed)`,
      'DECRYPT',
      rel,
    );
  }
}
