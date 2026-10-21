export { JsonStore, type Op, type ReadOptions, type VersionedOptions } from './store.js';
export { StoreError } from './errors.js';
export { KeyedMutex } from './mutex.js';
export { stableStringify, jsonErrorLine } from './stable.js';
export { migrate, type Migrations, type Versioned } from './migrate.js';
export { createBackup, listBackups } from './backup.js';
export const JSONSTORE_API_VERSION = 1;
