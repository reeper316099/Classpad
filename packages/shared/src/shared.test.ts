import { describe, expect, it } from 'vitest';
import { APP_NAME, AssignmentSchema, newId } from './index.js';

describe('shared', () => {
  it('exposes APP_NAME', () => expect(APP_NAME).toBe('Classpad'));
  it('generates unique sortable ids', () => {
    expect(newId()).not.toBe(newId());
  });
  it('applies assignment defaults', () => {
    const a = AssignmentSchema.parse({
      id: newId(),
      classId: 'c',
      title: 'HW',
      createdAt: 'x',
      updatedAt: 'x',
    });
    expect(a.priority).toBe('mid');
    expect(a.status).toBe('not_started');
  });
});

import { extractWikiLinks, normalizeTitle } from './wikilinks.js';
describe('wiki links', () => {
  it('parses plain, aliased and heading links', () => {
    const l = extractWikiLinks('See [[Alpha]], [[Beta|the beta]] and [[Gamma#Part 2]].');
    expect(l.map((x) => [x.target, x.alias, x.heading])).toEqual([
      ['Alpha', undefined, undefined],
      ['Beta', 'the beta', undefined],
      ['Gamma', undefined, 'Part 2'],
    ]);
  });
  it('ignores links in inline code and fenced code, keeps indices', () => {
    const md = 'a `[[Nope]]` b\n```\n[[Also nope]]\n```\n[[Yes]]';
    const l = extractWikiLinks(md);
    expect(l).toHaveLength(1);
    expect(md.slice(l[0]!.index, l[0]!.index + 7)).toBe('[[Yes]]');
  });
  it('normalizes titles', () => expect(normalizeTitle('  Café   Notes ')).toBe('cafe notes'));
});
