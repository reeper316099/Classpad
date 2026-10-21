import { describe, expect, it } from 'vitest';
import {
  normalizeAssignmentStatus,
  normalizePriority,
  normalizeReadingStatus,
  normalizeTaskPriority,
  parseDays,
  parseNotionDate,
  parsePercent,
  parseRelation,
  parseTimes,
  parseTimeRange,
  slugOption,
  splitName,
} from './parse.js';

describe('percent', () => {
  it.each([
    ['20%', 20],
    ['20', 20],
    [' 12.5 % ', 12.5],
    ['0', 0],
    ['1,000', 1000],
  ])('%s', (s, n) => expect(parsePercent(s)).toBe(n));
  it.each(['', 'abc', undefined])('blank/garbage %s -> null', (s) =>
    expect(parsePercent(s as string)).toBeNull(),
  );
});

describe('dates', () => {
  it('long form, ISO, US numeric', () => {
    expect(parseNotionDate('March 3, 2031')).toMatchObject({ start: '2031-03-03', hasTime: false });
    expect(parseNotionDate('2031-03-03')?.start).toBe('2031-03-03');
    expect(parseNotionDate('03/04/2031')?.start).toBe('2031-03-04');
    expect(parseNotionDate('Sept 9, 2031')?.start).toBe('2031-09-09');
  });
  it('times and tz labels', () => {
    expect(parseNotionDate('March 3, 2031 3:05 PM (PST)')).toMatchObject({
      start: '2031-03-03T15:05',
      hasTime: true,
      timezoneLabel: 'PST',
    });
    expect(parseNotionDate('March 3, 2031 12:00 AM')?.start).toBe('2031-03-03T00:00');
    expect(parseNotionDate('March 3, 2031 12:30 PM')?.start).toBe('2031-03-03T12:30');
  });
  it('ranges', () => {
    expect(parseNotionDate('May 1, 2031 → June 2, 2031')).toMatchObject({
      start: '2031-05-01',
      end: '2031-06-02',
    });
    expect(parseNotionDate('May 1, 2031 9:00 AM → May 1, 2031 10:30 AM')).toMatchObject({
      start: '2031-05-01T09:00',
      end: '2031-05-01T10:30',
      hasTime: true,
    });
  });
  it('garbage -> null', () => {
    expect(parseNotionDate('someday')).toBeNull();
    expect(parseNotionDate('')).toBeNull();
    expect(parseNotionDate('Foo 40, 2031')).toBeNull();
  });
});

describe('times', () => {
  it('compact and spaced single ranges', () => {
    expect(parseTimeRange('11:50a-1:10p')).toEqual({ start: '11:50', end: '13:10' });
    expect(parseTimeRange('4p-5:20p')).toEqual({ start: '16:00', end: '17:20' });
    expect(parseTimeRange('10:00 AM - 11:15 AM')).toEqual({ start: '10:00', end: '11:15' });
    expect(parseTimeRange('11-1p')).toEqual({ start: '11:00', end: '13:00' });
    expect(parseTimeRange('13:00-14:30')).toEqual({ start: '13:00', end: '14:30' });
    expect(parseTimeRange('12p-1p')).toEqual({ start: '12:00', end: '13:00' });
    expect(parseTimeRange('lunch')).toBeNull();
  });
  it('one range applies to all days (days are sorted)', () => {
    const days = parseDays('Thursday, Tuesday');
    expect(days).toEqual(['tue', 'thu']);
    const r = parseTimes('3:40p-5p', days);
    expect(r.meetings.map((m) => `${m.day} ${m.start}-${m.end}`)).toEqual([
      'tue 15:40-17:00',
      'thu 15:40-17:00',
    ]);
  });
  it('day-prefixed multi-line form', () => {
    const r = parseTimes('Mon 10:00 AM - 11:15 AM\nWednesday: 1:00 PM - 2:15 PM', []);
    expect(r.meetings).toEqual([
      { day: 'mon', start: '10:00', end: '11:15' },
      { day: 'wed', start: '13:00', end: '14:15' },
    ]);
  });
  it('unprefixed multi-line pairs by weekday order with a warning', () => {
    const r = parseTimes('10:00 AM - 11:15 AM\n1:00 PM - 2:15 PM', ['mon', 'wed']);
    expect(r.meetings).toHaveLength(2);
    expect(r.warnings.join()).toMatch(/paired/);
  });
  it('warns on unreadable text or mismatched counts', () => {
    expect(parseTimes('whenever', ['mon']).warnings.length).toBe(1);
    expect(parseTimes('9-10a\n11-12a\n1-2p', ['mon']).warnings.join()).toMatch(/could not pair/);
  });
});

describe('priority normalization', () => {
  it('strips emoji, direction marks and odd spaces', () => {
    expect(normalizePriority('‎🔥 Important‏')).toEqual({
      value: 'important',
      label: '🔥 Important',
    });
    expect(normalizePriority('⚡ Mid')?.value).toBe('mid');
    expect(normalizePriority('‪ Low ‬')?.value).toBe('low');
    expect(normalizePriority('')).toBeNull();
    expect(normalizePriority('weird')).toBeNull();
  });
  it('task priorities', () => {
    expect(normalizeTaskPriority('High')).toBe('high');
    expect(normalizeTaskPriority('Medium')).toBe('medium');
    expect(normalizeTaskPriority('Low')).toBe('low');
  });
  it('option slugs', () => {
    expect(slugOption('In-Class')).toBe('in_class');
    expect(slugOption(' Group Project ')).toBe('group_project');
  });
});

describe('relations and names', () => {
  it('parses titles with encoded paths and ids', () => {
    const id = 'a'.repeat(32);
    const r = parseRelation(
      `Alpha, Beta (Hub/Classes/Alpha%20Beta%20${id}.md), Gamma (x/Gamma.md)`,
    );
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ title: 'Alpha, Beta', id });
    expect(r[1]).toMatchObject({ title: 'Gamma', path: 'x/Gamma.md' });
  });
  it('url-only relations (pages outside the export) keep the id and no path', () => {
    const id = 'c'.repeat(32);
    const r = parseRelation(
      `Untitled (https://example.invalid/p/${id}?pvs=21), Other (x/Other.md)`,
    );
    expect(r[0]).toMatchObject({
      title: 'Untitled',
      id,
      url: `https://example.invalid/p/${id}?pvs=21`,
    });
    expect(r[0]!.path).toBeUndefined();
    expect(r[1]!.path).toBe('x/Other.md');
  });
  it('plain comma lists and blanks', () => {
    expect(parseRelation('One, Two').map((x) => x.title)).toEqual(['One', 'Two']);
    expect(parseRelation('')).toEqual([]);
  });
  it('splits id-suffixed names', () => {
    const id = 'b'.repeat(32);
    expect(splitName(`Things ${id}_all.csv`)).toEqual({ base: 'Things', id, suffix: '_all.csv' });
    expect(splitName('plain.md')).toEqual({ base: 'plain.md', suffix: '' });
  });
});

describe('status wordings', () => {
  it('maps common Notion status options', () => {
    const a = (s: string) => normalizeAssignmentStatus(s);
    expect(a('Done')).toEqual({ value: 'complete', known: true });
    expect(a('Submitted').value).toBe('complete');
    expect(a('In progress').value).toBe('in_progress');
    expect(a('🔥 Doing').value).toBe('in_progress');
    expect(a('Not started').value).toBe('not_started');
    expect(a('To-do').value).toBe('not_started');
    expect(a('Late').value).toBe('not_started');
    expect(a('')).toEqual({ value: 'not_started', known: true });
    expect(a('Waiting on professor')).toEqual({ value: 'not_started', known: false });
  });
  it('maps reading statuses', () => {
    expect(normalizeReadingStatus('Finished').value).toBe('complete');
    expect(normalizeReadingStatus('Currently reading').value).toBe('reading');
    expect(normalizeReadingStatus('Want to read').value).toBe('to_read');
    expect(normalizeReadingStatus('Lost it').known).toBe(false);
  });
});
