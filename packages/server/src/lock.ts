import { deriveKey, newSalt, verifyHash } from '@classpad/jsonstore';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Context } from './context.js';
import { ApiError } from './errors.js';

const FILE = 'config/privacy.json';

/** Which on-disk paths each encryptable collection covers. Attachment files (images, PDFs) are not encrypted. */
export const ENCRYPTABLE: Record<string, string[]> = {
  notes: ['data/notes/'],
  journal: ['data/journal/'],
  contacts: ['data/contacts/'],
  flashcards: ['data/flashcards/'],
  budget: ['data/modules/budget/'],
  jobs: ['data/modules/jobs/'],
  admissions: ['data/modules/admissions/'],
  activities: ['data/modules/activities/'],
  grades: ['data/assignments/'],
  study: ['data/study/'],
};

interface PrivacyConfig {
  version: 1;
  auth?: { salt: string; hash: string };
  enc?: { salt: string; collections: string[] };
  autoLockMinutes?: number;
  lockOnHide?: boolean;
}

/** Read before the data directory is opened, to decide whether data must stay unloaded until unlock. */
export function readPrivacySync(dataDir: string): PrivacyConfig | null {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, FILE), 'utf8')) as PrivacyConfig;
  } catch {
    return null;
  }
}

const b64 = (b: Buffer) => b.toString('base64');
const MIN_LEN = 4;
const pathsFor = (collections: string[]) => collections.flatMap((c) => ENCRYPTABLE[c] ?? []);

export class LockService {
  locked: boolean;
  private failed = 0;
  private retryAt = 0;
  private key: Buffer | null = null;

  constructor(
    private ctx: Context,
    private cfg: PrivacyConfig | null,
  ) {
    this.locked = !!cfg?.auth;
  }

  private get collections(): string[] {
    return this.cfg?.enc?.collections ?? [];
  }
  private policy(key: Buffer, collections = this.collections) {
    const prefixes = pathsFor(collections);
    return { key, shouldEncrypt: (rel: string) => prefixes.some((p) => rel.startsWith(p)) };
  }
  private async save(cfg: PrivacyConfig | null) {
    this.cfg = cfg;
    if (cfg) await this.ctx.store.writeJson(FILE, cfg);
    else await this.ctx.store.remove(FILE);
  }

  status() {
    return {
      enabled: !!this.cfg?.auth,
      locked: this.locked,
      encryptedCollections: this.collections,
      available: Object.keys(ENCRYPTABLE),
      autoLockMinutes: this.cfg?.autoLockMinutes ?? 0,
      lockOnHide: !!this.cfg?.lockOnHide,
      retryAfterMs: Math.max(0, this.retryAt - Date.now()),
    };
  }

  private async verify(passphrase: string): Promise<void> {
    const a = this.cfg?.auth;
    if (!a) throw new ApiError(409, 'NO_LOCK', 'No passphrase is set');
    const wait = this.retryAt - Date.now();
    if (wait > 0)
      throw new ApiError(
        429,
        'TOO_MANY_ATTEMPTS',
        `Too many attempts. Try again in ${Math.ceil(wait / 1000)} seconds.`,
        { retryAfterMs: wait },
      );
    if (
      !(await verifyHash(passphrase, Buffer.from(a.salt, 'base64'), Buffer.from(a.hash, 'base64')))
    ) {
      this.failed++;
      if (this.failed >= 5)
        this.retryAt = Date.now() + Math.min(300_000, 5_000 * 2 ** (this.failed - 5));
      throw new ApiError(403, 'BAD_PASSPHRASE', 'That passphrase is not correct');
    }
    this.failed = 0;
    this.retryAt = 0;
  }

  async unlock(passphrase: string) {
    await this.verify(passphrase);
    if (this.cfg?.enc && this.collections.length) {
      this.key = await deriveKey(passphrase, Buffer.from(this.cfg.enc.salt, 'base64'));
      this.ctx.store.setCrypto(this.policy(this.key));
    }
    if (!this.ctx.loaded) {
      try {
        await this.ctx.loadAll();
      } catch (e) {
        this.ctx.store.setCrypto(null);
        this.key = null;
        throw new ApiError(
          500,
          'UNLOCK_FAILED',
          `Could not read your encrypted data: ${(e as Error).message}`,
        );
      }
    }
    this.locked = false;
    return this.status();
  }

  lock() {
    if (!this.cfg?.auth) throw new ApiError(409, 'NO_LOCK', 'Set a passphrase first');
    this.locked = true;
    this.key = null;
    this.ctx.store.setCrypto(null); // the key leaves memory; encrypted files can't be read until the next unlock
    return this.status();
  }

  /** Older backups (including the safety copy taken just before migrating) hold the data unencrypted. */
  private async dropPlaintextBackups() {
    await this.ctx.store.purgeBackups();
    await this.ctx.store.backup('post-encryption');
  }

  private checkNew(passphrase: string) {
    if (passphrase.length < MIN_LEN)
      throw new ApiError(422, 'WEAK_PASSPHRASE', `Use at least ${MIN_LEN} characters`);
  }

  /** First-time setup, or changing the passphrase (then `current` is required). Optionally chooses encrypted collections. */
  async setup(o: {
    passphrase: string;
    current?: string;
    collections?: string[];
    autoLockMinutes?: number;
    lockOnHide?: boolean;
  }) {
    this.checkNew(o.passphrase);
    if (this.cfg?.auth) await this.verify(o.current ?? '');
    if (this.cfg?.auth && this.locked) throw new ApiError(423, 'LOCKED', 'Unlock first');
    const collections = [...new Set(o.collections ?? this.collections)].filter(
      (c) => c in ENCRYPTABLE,
    );
    const authSalt = newSalt(),
      encSalt = newSalt();
    const next: PrivacyConfig = {
      version: 1,
      auth: { salt: b64(authSalt), hash: b64(await deriveKey(o.passphrase, authSalt)) },
      ...(collections.length ? { enc: { salt: b64(encSalt), collections } } : {}),
      autoLockMinutes: o.autoLockMinutes ?? this.cfg?.autoLockMinutes ?? 0,
      lockOnHide: o.lockOnHide ?? this.cfg?.lockOnHide ?? false,
    };
    // rewrite data under the new key (or plain, when no collection is chosen) before recording the new config
    if (collections.length) {
      const key = await deriveKey(o.passphrase, encSalt);
      await this.ctx.store.reencryptAll(this.policy(key, collections));
      await this.dropPlaintextBackups();
      this.key = key;
    } else if (this.collections.length) {
      await this.ctx.store.reencryptAll(null);
      this.key = null;
    }
    await this.save(next);
    this.locked = false;
    this.failed = 0;
    return this.status();
  }

  /** Choose which collections are encrypted at rest. Enabling from none needs the passphrase to derive a key. */
  async setCollections(collections: string[], passphrase?: string) {
    if (!this.cfg?.auth) throw new ApiError(409, 'NO_LOCK', 'Set a passphrase first');
    const chosen = [...new Set(collections)].filter((c) => c in ENCRYPTABLE);
    let enc = this.cfg.enc;
    let key = this.key;
    if (chosen.length && !key) {
      await this.verify(passphrase ?? '');
      enc = { salt: b64(newSalt()), collections: chosen };
      key = await deriveKey(passphrase!, Buffer.from(enc.salt, 'base64'));
    }
    if (chosen.length) {
      await this.ctx.store.reencryptAll(this.policy(key!, chosen));
      await this.dropPlaintextBackups();
      this.key = key;
      await this.save({ ...this.cfg, enc: { salt: enc!.salt, collections: chosen } });
    } else {
      await this.ctx.store.reencryptAll(null);
      this.key = null;
      const { enc: _drop, ...rest } = this.cfg;
      void _drop;
      await this.save(rest);
    }
    return this.status();
  }

  async updateSettings(o: { autoLockMinutes?: number; lockOnHide?: boolean }) {
    if (!this.cfg?.auth) throw new ApiError(409, 'NO_LOCK', 'Set a passphrase first');
    await this.save({
      ...this.cfg,
      autoLockMinutes: o.autoLockMinutes ?? this.cfg.autoLockMinutes,
      lockOnHide: o.lockOnHide ?? this.cfg.lockOnHide,
    });
    return this.status();
  }

  /** Remove the lock entirely. Encrypted collections are decrypted back to plain files first. */
  async disable(passphrase: string) {
    await this.verify(passphrase);
    if (this.collections.length) {
      if (!this.key)
        this.ctx.store.setCrypto(
          this.policy(await deriveKey(passphrase, Buffer.from(this.cfg!.enc!.salt, 'base64'))),
        );
      await this.ctx.store.reencryptAll(null);
    }
    this.key = null;
    await this.save(null);
    this.locked = false;
    return this.status();
  }
}
