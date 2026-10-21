import { StoreError } from './errors.js';

/** A versioned document: `{ schemaVersion, ...rest }`. */
export interface Versioned {
  schemaVersion: number;
  [k: string]: unknown;
}

/** migrations[n] upgrades a version-n document to version n+1. */
export type Migrations = Record<number, (doc: Versioned) => Versioned>;

export function migrate(doc: Versioned, target: number, migrations: Migrations): Versioned {
  let cur = doc;
  const start = typeof cur.schemaVersion === 'number' ? cur.schemaVersion : 0;
  if (start > target)
    throw new StoreError(`file is from a newer version (${start} > ${target})`, 'INVALID');
  for (let v = start; v < target; v++) {
    const step = migrations[v];
    if (!step) throw new StoreError(`no migration from schemaVersion ${v}`, 'INVALID');
    cur = { ...step(cur), schemaVersion: v + 1 };
  }
  return cur;
}
