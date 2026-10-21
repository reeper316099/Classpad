import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from './app.js';
import { deadlines, loadLevel, stats, weekStartOf } from './planner.js';

let dir: string;
let app: App;
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.fastify.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    headers: { authorization: 'Bearer t' },
    payload: payload as never,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined };
};
let sem = '',
  cls = '',
  cls2 = '';

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'classpad-plan-'));
  app = await createApp({ dataDir: dir, token: 't' });
  sem = (await call('POST', '/semesters', { name: 'T', start: '2031-09-01', end: '2031-12-12' }))
    .body.id;
  cls = (
    await call('POST', '/classes', {
      semesterId: sem,
      name: 'Alpha',
      studyTargetHours: 2,
      meetings: [
        { day: 'mon', start: '09:00', end: '10:15' },
        { day: 'wed', start: '09:00', end: '10:15' },
      ],
    })
  ).body.id;
  cls2 = (
    await call('POST', '/classes', {
      semesterId: sem,
      name: 'Beta',
      location: 'Room 5',
      meetings: [{ day: 'wed', start: '13:00', end: '14:00' }],
    })
  ).body.id;
});
afterAll(async () => {
  await app.fastify.close();
  await rm(dir, { recursive: true, force: true });
});

describe('week helpers', () => {
  it('weekStartOf honors Monday or Sunday starts', () => {
    expect(weekStartOf('2031-10-15', 'mon')).toBe('2031-10-13'); // Wed -> Mon
    expect(weekStartOf('2031-10-15', 'sun')).toBe('2031-10-12');
    expect(weekStartOf('2031-10-12', 'mon')).toBe('2031-10-06'); // Sunday belongs to the previous Monday-week
    expect(weekStartOf('2031-10-13', 'mon')).toBe('2031-10-13');
  });
  it('load levels', () => {
    expect([loadLevel(0), loadLevel(2.9), loadLevel(3), loadLevel(5.9), loadLevel(6)]).toEqual([
      'light',
      'light',
      'normal',
      'normal',
      'heavy',
    ]);
  });
});

describe('agenda and timetable', () => {
  it('expands class meetings within semester bounds, and merges deadlines and tasks in order', async () => {
    await call('POST', '/assignments', {
      classId: cls,
      title: 'Essay',
      due: '2031-10-15',
      weight: 20,
    });
    await call('POST', '/assignments', { classId: cls, title: 'Quiz', due: '2031-10-15T08:30' });
    await call('POST', '/assignments', {
      classId: cls,
      title: 'Skipped',
      due: '2031-10-15',
      excused: true,
    });
    await call('POST', '/tasks', { title: 'Read ch 3', classId: cls, date: '2031-10-15' });
    const a = (await call('GET', '/agenda?from=2031-10-13&to=2031-10-15')).body;
    const titles = a.map(
      (x: { kind: string; title: string; start: string }) => `${x.kind}:${x.title}@${x.start}`,
    );
    expect(titles).toEqual([
      'class:Alpha@2031-10-13T09:00',
      'deadline:Essay@2031-10-15',
      'task:Read ch 3@2031-10-15', // all-day items first on their date
      'deadline:Quiz@2031-10-15T08:30',
      'class:Alpha@2031-10-15T09:00',
      'class:Beta@2031-10-15T13:00',
    ]);
    expect(a.find((x: { title: string }) => x.title === 'Beta').location).toBe('Room 5');
    // before the semester starts: no classes
    expect(
      (await call('GET', '/agenda?from=2031-08-25&to=2031-08-31')).body.filter(
        (x: { kind: string }) => x.kind === 'class',
      ),
    ).toHaveLength(0);
    // after it ends too
    expect((await call('GET', '/agenda?from=2031-12-15&to=2031-12-31')).body).toHaveLength(0);
  });
  it('validates ranges', async () => {
    expect((await call('GET', '/agenda?from=nope&to=2031-10-15')).status).toBe(422);
    expect((await call('GET', '/agenda?from=2031-10-15&to=2031-10-01')).status).toBe(422);
    expect((await call('GET', '/agenda?from=2031-01-01&to=2033-01-01')).status).toBe(422);
  });
  it('timetable returns 7 days from the chosen week start', async () => {
    const t = (await call('GET', '/timetable?week=2031-10-15&weekStart=mon')).body;
    expect(t.weekStart).toBe('2031-10-13');
    expect(t.days).toHaveLength(7);
    expect(t.days[0].items.map((i: { title: string }) => i.title)).toEqual(['Alpha']);
    expect(t.days[2].items.map((i: { title: string }) => i.title)).toEqual([
      'Essay',
      'Read ch 3',
      'Quiz',
      'Alpha',
      'Beta',
    ]);
    expect((await call('GET', '/timetable?week=2031-10-15&weekStart=sun')).body.weekStart).toBe(
      '2031-10-12',
    );
  });
});

describe('deadlines', () => {
  it('classifies urgency relative to now and skips done/excused', () => {
    const now = new Date(2031, 9, 15, 12, 0);
    const d = deadlines(app.ctx, now);
    expect(d.map((x) => [x.title, x.urgency])).toEqual([
      ['Essay', 'today'],
      ['Quiz', 'today'],
    ]);
    expect(deadlines(app.ctx, new Date(2031, 9, 16))[0]!.urgency).toBe('overdue');
    expect(deadlines(app.ctx, new Date(2031, 9, 10))[0]!.urgency).toBe('soon');
    expect(deadlines(app.ctx, new Date(2031, 8, 1))[0]!.urgency).toBe('later');
  });
});

describe('study sessions', () => {
  it('stores monthly JSONL, filters by date, and moves a session between months on edit', async () => {
    const s = (
      await call('POST', '/study-sessions', {
        start: '2031-10-14T14:00:00.000Z',
        end: '2031-10-14T15:30:00.000Z',
        classId: cls,
        kind: 'manual',
      })
    ).body;
    expect(s.minutes).toBe(90);
    await call('POST', '/study-sessions', {
      start: '2031-11-02T14:00:00.000Z',
      end: '2031-11-02T14:25:00.000Z',
      minutes: 25,
      kind: 'pomodoro',
    });
    const file = await readFile(path.join(dir, 'data/study/2031-10.jsonl'), 'utf8');
    expect(file.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(file).classId).toBe(cls);
    expect(
      (await call('GET', '/study-sessions?from=2031-11-01&to=2031-11-30')).body.items,
    ).toHaveLength(1);
    await call('PATCH', `/study-sessions/${s.id}`, {
      start: '2031-11-03T10:00:00.000Z',
      end: '2031-11-03T10:30:00.000Z',
      minutes: 30,
    });
    await expect(readFile(path.join(dir, 'data/study/2031-10.jsonl'))).rejects.toThrow();
    expect(
      (await readFile(path.join(dir, 'data/study/2031-11.jsonl'), 'utf8')).trim().split('\n'),
    ).toHaveLength(2);
    expect((await call('DELETE', `/study-sessions/${s.id}`)).status).toBe(204);
  });
  it('rejects impossible sessions', async () => {
    expect(
      (
        await call('POST', '/study-sessions', {
          start: '2031-10-14T15:00:00Z',
          end: '2031-10-14T14:00:00Z',
        })
      ).status,
    ).toBe(422);
    expect((await call('POST', '/study-sessions', { start: 'junk', end: 'junk' })).status).toBe(
      422,
    );
    expect(
      (
        await call('POST', '/study-sessions', {
          start: '2031-10-14T00:00:00Z',
          end: '2031-10-16T00:00:00Z',
          minutes: 5000,
        })
      ).status,
    ).toBe(422);
  });
  it('timer: start once, stop logs it, tiny runs are discarded, state errors are clear', async () => {
    expect((await call('POST', '/study-sessions/stop')).status).toBe(409);
    expect((await call('GET', '/study-sessions/active')).body).toBeNull();
    const a = await call('POST', '/study-sessions/start', { classId: cls });
    expect(a.status).toBe(200);
    expect((await call('POST', '/study-sessions/start', {})).status).toBe(409);
    expect((await call('GET', '/study-sessions/active')).body.classId).toBe(cls);
    const quick = (await call('POST', '/study-sessions/stop')).body;
    expect(quick.session).toBeNull(); // under 30 seconds
    // a longer one, using the repo directly with controlled clocks
    await app.ctx.study.startTimer(
      { kind: 'pomodoro', classId: cls },
      new Date(Date.now() - 25 * 60_000),
    );
    const s = await app.ctx.study.stopTimer(new Date());
    expect(s!.minutes).toBe(25);
    expect(s!.kind).toBe('pomodoro');
  });
});

describe('stats overview', () => {
  it('reports study vs targets, streak, workload forecast and grade trends', async () => {
    const now = new Date(2031, 9, 15, 12, 0);
    const local = (d: number, h: number) => new Date(2031, 9, d, h, 0).toISOString();
    for (const [d, mins] of [
      [15, 60],
      [14, 45],
      [13, 30],
    ] as const)
      await call('POST', '/study-sessions', {
        start: local(d, 10),
        end: new Date(new Date(local(d, 10)).getTime() + mins * 60000).toISOString(),
        minutes: mins,
        classId: cls,
      });
    await call('POST', '/study-sessions', {
      start: local(10, 10),
      end: local(10, 11),
      minutes: 60,
    });
    const s = stats(app.ctx, now, 'mon');
    expect(s.weekStart).toBe('2031-10-13');
    const a = s.study.perClass.find((p) => p.classId === cls)!;
    expect(a.targetMinutes).toBe(120);
    expect(a.minutes).toBe(135);
    expect(s.study.streakDays).toBe(3);
    expect(s.study.daily).toHaveLength(14);
    expect(s.study.daily.at(-1)).toEqual({ date: '2031-10-15', minutes: 60 });
    expect(s.workload).toHaveLength(8);
    expect(s.workload[0]!.deadlines).toBe(2);
    expect(s.workload[0]!.load).toBe('normal'); // essay 1+1=2 plus quiz 1 = 3
    expect(s.workload[7]!.load).toBe('light');
  });
  it('flags a heavy week and builds grade trends from graded work only', async () => {
    for (const [i, t] of ['exam', 'project', 'presentation'].entries())
      await call('POST', '/assignments', {
        classId: cls2,
        title: `Big ${i}`,
        due: '2031-10-22',
        weight: 20,
        type: [t],
        priority: 'important',
      });
    await call('POST', '/assignments', {
      classId: cls2,
      title: 'G1',
      due: '2031-09-10',
      weight: 50,
      score: { percent: 80 },
    });
    await call('POST', '/assignments', {
      classId: cls2,
      title: 'G2',
      due: '2031-09-20',
      weight: 50,
      score: { percent: 100 },
    });
    const s = stats(app.ctx, new Date(2031, 9, 15, 12, 0), 'mon');
    expect(s.workload[1]!.load).toBe('heavy');
    expect(s.trends[cls2]).toEqual([80, 90]);
    expect(s.trends[cls]).toEqual([]);
  });
});

describe('stopping with an explicit end time', () => {
  it('logs the true end when the client was away, and never a future end', async () => {
    const start = new Date(Date.now() - 60 * 60_000);
    await app.ctx.study.startTimer({ kind: 'pomodoro' }, start);
    const at = new Date(start.getTime() + 25 * 60_000).toISOString();
    const r = (await call('POST', '/study-sessions/stop', { at })).body;
    expect(r.session.minutes).toBe(25);
    await app.ctx.study.startTimer({ kind: 'pomodoro' }, new Date(Date.now() - 10 * 60_000));
    const future = (
      await call('POST', '/study-sessions/stop', {
        at: new Date(Date.now() + 3600_000).toISOString(),
      })
    ).body;
    expect(future.session.minutes).toBeLessThanOrEqual(10);
    expect((await call('POST', '/study-sessions/stop', { at: 'not a date' })).status).toBe(
      409 === 0 ? 0 : 422,
    );
  });
});
