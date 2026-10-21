import { describe, expect, it } from 'vitest';
import { parseQuickDate } from './quickDate.js';

// Wednesday 2031-01-15, local time
const now = new Date(2031, 0, 15, 10, 0);
const p = (s: string) => parseQuickDate(s, now);

describe('quick-add date parsing', () => {
  it('weekday + time', () =>
    expect(p('Essay 2 fri 11:59pm')).toEqual({ title: 'Essay 2', due: '2031-01-17T23:59' }));
  it('same weekday means next week', () =>
    expect(p('Quiz wed')).toEqual({ title: 'Quiz', due: '2031-01-22' }));
  it('today / tomorrow', () => {
    expect(p('Read ch 3 tomorrow')).toEqual({ title: 'Read ch 3', due: '2031-01-16' });
    expect(p('Call tutor today 9am')).toEqual({ title: 'Call tutor', due: '2031-01-15T09:00' });
  });
  it('relative days and weeks', () => {
    expect(p('Lab report in 3 days')).toEqual({ title: 'Lab report', due: '2031-01-18' });
    expect(p('Project in 2 weeks')).toEqual({ title: 'Project', due: '2031-01-29' });
  });
  it('month names roll to next year when passed', () => {
    expect(p('Project mar 5 9am')).toEqual({ title: 'Project', due: '2031-03-05T09:00' });
    expect(p('Old thing jan 2')).toEqual({ title: 'Old thing', due: '2032-01-02' });
  });
  it('numeric and ISO dates', () => {
    expect(p('Quiz 5/3')).toEqual({ title: 'Quiz', due: '2031-05-03' });
    expect(p('Final 2031-12-09 noon')).toEqual({ title: 'Final', due: '2031-12-09T12:00' });
  });
  it('plain titles and bare numbers are left alone', () => {
    expect(p('Chapter 12 problems')).toEqual({ title: 'Chapter 12 problems' });
    expect(p('Read 30 pages')).toEqual({ title: 'Read 30 pages' });
    expect(p('Essay 11')).toEqual({ title: 'Essay 11' });
    expect(p('Meet at 5pm')).toEqual({ title: 'Meet at 5pm' });
  });
  it('does not eat the whole title', () => expect(p('friday')).toEqual({ title: 'friday' }));
});
