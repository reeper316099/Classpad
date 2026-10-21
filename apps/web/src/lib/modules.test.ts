import { describe, expect, it } from 'vitest';
import { MODULES, blankForm, isOn, summarize, toForm, toPayload } from './modules.js';

const budget = MODULES.find((m) => m.id === 'budget')!;
const adm = MODULES.find((m) => m.id === 'admissions')!;
const contacts = MODULES.find((m) => m.id === 'contacts')!;

describe('module registry', () => {
  it('only the reading tracker is on by default; the rest are opt-in', () => {
    expect(MODULES.filter((m) => m.defaultOn).map((m) => m.id)).toEqual(['reading']);
    expect(isOn({}, 'reading')).toBe(true);
    expect(isOn({}, 'journal')).toBe(false);
    expect(isOn({ reading: false, journal: true }, 'journal')).toBe(true);
    expect(isOn({ reading: false }, 'reading')).toBe(false);
  });
  it('every module has a unique id and path, and generic ones have a required title field', () => {
    expect(new Set(MODULES.map((m) => m.id)).size).toBe(MODULES.length);
    expect(new Set(MODULES.map((m) => m.path)).size).toBe(MODULES.length);
    for (const m of MODULES.filter((x) => !x.custom))
      expect(m.fields.find((f) => f.key === m.titleKey)?.required).toBe(true);
  });
});

describe('form <-> payload', () => {
  it('applies defaults, validates required fields and numbers, parses money', () => {
    const form = blankForm(budget.fields);
    expect(form.type).toBe('expense');
    expect(toPayload(budget.fields, form)).toEqual({ ok: false, error: 'What is required.' });
    Object.assign(form, { purchase: 'Notebook', cost: '$4.50', date: '2031-03-02' });
    const r = toPayload(budget.fields, form);
    expect(r.ok && r.body).toMatchObject({
      purchase: 'Notebook',
      cost: 4.5,
      type: 'expense',
      vendor: null,
    });
    expect(toPayload(budget.fields, { ...form, cost: 'abc' })).toEqual({
      ok: false,
      error: 'Amount must be a positive number.',
    });
    expect(toPayload(budget.fields, { ...form, cost: '-3' }).ok).toBe(false);
  });
  it('round-trips checklists and comma lists', () => {
    const f = toForm(adm.fields, {
      school: 'U',
      status: 'submitted',
      checklist: [{ text: 'Essay', done: true }],
    });
    expect(f.checklist).toEqual([{ text: 'Essay', done: true }]);
    const r = toPayload(adm.fields, {
      ...f,
      checklist: [
        ...(f.checklist as []),
        { text: '  ', done: false },
        { text: 'Transcript', done: false },
      ],
    });
    expect(r.ok && r.body.checklist).toEqual([
      { text: 'Essay', done: true },
      { text: 'Transcript', done: false },
    ]);
    const c = toForm(contacts.fields, { name: 'P', classIds: ['a', 'b'] });
    expect(c.classIds).toBe('a, b');
    const p = toPayload(contacts.fields, { ...c, classIds: 'x, y ,' });
    expect(p.ok && p.body.classIds).toEqual(['x', 'y']);
  });
});

describe('summaries', () => {
  const now = new Date('2031-03-15T12:00:00Z');
  it('budget: this month only, income vs expense', () => {
    const s = summarize(
      'budget',
      [
        { date: '2031-03-02', cost: 10, type: 'expense' },
        { date: '2031-03-09', cost: 25, type: 'income' },
        { date: '2031-02-20', cost: 99, type: 'expense' },
      ],
      now,
    );
    expect(s.map((x) => x.value)).toEqual(['$10.00', '$25.00', '$15.00']);
    expect(
      summarize('budget', [{ date: '2031-03-02', cost: 30, type: 'expense' }], now)[2]!.value,
    ).toBe('−$30.00');
  });
  it('admissions: next open deadline and checklist items left', () => {
    const s = summarize(
      'admissions',
      [
        {
          school: 'A',
          status: 'in_progress',
          deadline: '2031-04-01',
          checklist: [{ done: false }, { done: true }],
        },
        { school: 'B', status: 'submitted', deadline: '2031-03-20', checklist: [] },
        {
          school: 'C',
          status: 'researching',
          deadline: '2031-03-01',
          checklist: [{ done: false }],
        },
      ],
      now,
    );
    expect(s[0]!.value).toBe('1');
    expect(s[1]!.value).toBe('2');
    expect(s[2]!.value).toBe('A · 2031-04-01'); // past and submitted ones are not "next"
  });
  it('reading, jobs and activities headline numbers', () => {
    expect(
      summarize(
        'reading',
        [
          { status: 'reading', pagesRead: 40 },
          { status: 'complete', pagesRead: 90 },
        ],
        now,
      ).map((x) => x.value),
    ).toEqual(['1', '1', '130']);
    expect(
      summarize(
        'jobs',
        [
          { status: 'applied' },
          { status: 'interview' },
          { status: 'offer' },
          { status: 'accepted' },
        ],
        now,
      ).map((x) => x.value),
    ).toEqual(['1', '1', '2']);
    expect(
      summarize(
        'activities',
        [
          { status: 'active', hoursPerWeek: 3 },
          { status: 'past', hoursPerWeek: 9 },
        ],
        now,
      ).map((x) => x.value),
    ).toEqual(['1', '3']);
  });
});
