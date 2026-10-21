import { describe, expect, it } from 'vitest';
import { checkPath, checkText, run } from './guard-private.mjs';

describe('guard-private', () => {
  it('blocks private fixtures and zips', () => {
    expect(checkPath('private-fixtures/a.txt')).toBeTruthy();
    expect(checkPath('docs/export.zip')).toBeTruthy();
  });
  it('blocks id-suffixed export names but not in synthetic fixtures', () => {
    const id = 'a'.repeat(32);
    expect(checkPath(`data/Classes ${id}.csv`)).toBeTruthy();
    expect(checkPath(`fixtures/synthetic/Classes ${id}.csv`)).toBeNull();
    expect(checkPath('packages/shared/src/index.ts')).toBeNull();
  });
  it('blocks denied tokens by hash', () => {
    expect(checkText('x.md', 'made with ' + 'grid' + 'fiti template')).toBeTruthy();
    expect(checkText('x.md', 'plain text')).toBeNull();
  });
  it('run aggregates problems', () => {
    expect(run(['ok.ts'], () => 'fine')).toEqual([]);
    expect(run(['private-fixtures/x'], () => '')).toHaveLength(1);
  });
});
