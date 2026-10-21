import type { GradingScheme } from '@classpad/shared';
import type { Context } from './context.js';

const REF = 'demo:';
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400_000);

type Id = string;
const lorem = (n: number) =>
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'
    .split(' ')
    .slice(0, n)
    .join(' ');

/** Whether demo data is currently present. */
export const hasDemo = (ctx: Context): boolean =>
  ctx.semesters.list().some((s) => s.importRef?.startsWith(REF));

/**
 * Creates a small, entirely invented semester: 5 classes using all three grading schemes,
 * ~40 assignments (past ones graded, upcoming ones pending), notes with math, tasks and readings.
 * Dates are relative to `now` so the dashboard always looks alive.
 */
export async function loadDemo(ctx: Context, now = new Date()) {
  if (hasDemo(ctx)) return { alreadyLoaded: true };
  const start = addDays(now, -63);
  const end = addDays(now, 56);
  const sem = await ctx.semesters.create({
    name: 'Demo Term',
    start: iso(start),
    end: iso(end),
    isCurrent: true,
    importRef: `${REF}semester`,
    goals: [
      'Keep a steady study rhythm',
      'Finish every reading before lectures',
      'Ask for help early',
    ],
  });

  const schemes: GradingScheme[] = [...ctx.config.schemes];
  const base = schemes.find((s) => s.id === 'default')!;
  if (!schemes.some((s) => s.id === 'demo-categories'))
    schemes.push({
      ...base,
      id: 'demo-categories',
      name: 'Demo: categories',
      mode: 'category_weights',
      categories: [
        { id: 'quiz', name: 'Quizzes', weight: 20, dropLowest: 1, countMode: 'mean' },
        { id: 'hw', name: 'Homework', weight: 30, countMode: 'pooled' },
        { id: 'exam', name: 'Exams', weight: 50, countMode: 'mean' },
      ],
    });
  await ctx.config.putSchemes(schemes);

  const mk = async (name: string, code: string, color: string, extra: Record<string, unknown>) =>
    ctx.classes.create({
      semesterId: sem.id,
      name,
      code,
      color,
      importRef: `${REF}class:${code}`,
      ...extra,
    });
  const c1 = await mk('Intro to Lorem Studies', 'LOR 101', '#6366f1', {
    credits: 4,
    type: 'core',
    delivery: 'in_person',
    location: 'Hall A-12',
    honorsLevel: 'ap',
    instructor: 'Prof. Placeholder',
    meetings: [
      { day: 'mon', start: '09:15', end: '10:30' },
      { day: 'wed', start: '09:15', end: '10:30' },
    ],
  });
  const c2 = await mk('Ipsum Methods', 'IPS 210', '#ec4899', {
    credits: 3,
    type: 'gen_ed',
    delivery: 'hybrid',
    gradingSchemeId: 'demo-categories',
    instructor: 'Dr. Sample',
    meetings: [
      { day: 'tue', start: '11:00', end: '12:15' },
      { day: 'thu', start: '11:00', end: '12:15' },
    ],
  });
  const c3 = await mk('Dolor Lab Practice', 'DOL 150', '#10b981', {
    credits: 3,
    type: 'elective',
    delivery: 'in_person',
    gradingSchemeId: 'points',
    location: 'Lab 3',
    meetings: [{ day: 'fri', start: '13:00', end: '15:50' }],
  });
  const c4 = await mk('Amet Writing Seminar', 'AME 220', '#f59e0b', {
    credits: 3,
    type: 'gen_ed',
    delivery: 'online',
    meetings: [{ day: 'tue', start: '15:30', end: '16:45' }],
  });
  const c5 = await mk('Sit Studio Hour', 'SIT 099', '#06b6d4', {
    credits: 1,
    passFail: true,
    includeInGpa: false,
    delivery: 'in_person',
    meetings: [{ day: 'thu', start: '17:00', end: '18:30' }],
  });

  const asg = async (
    classId: Id,
    title: string,
    dayOffset: number,
    extra: Record<string, unknown>,
  ) =>
    ctx.assignments.create({
      classId,
      title,
      due: iso(addDays(now, dayOffset)),
      importRef: `${REF}asg:${classId}:${title}`,
      status: extra.score ? 'complete' : 'not_started',
      ...extra,
    });
  const pct = (percent: number) => ({ percent });
  const pts = (earned: number, possible: number) => ({ earned, possible });

  // LOR 101: assignment weights, one extra-credit item
  const lor: [string, number, number, number | undefined, string[]?][] = [
    ['Reading response 1', -56, 8, 92, ['essay']],
    ['Reading response 2', -42, 8, 85, ['essay']],
    ['Midterm exam', -21, 25, 78, ['exam']],
    ['Group presentation', -7, 12, 90, ['presentation', 'group_project']],
    ['Reading response 3', 6, 8, undefined, ['essay']],
    ['Final project draft', 25, 12, undefined, ['project']],
    ['Final exam', 50, 21, undefined, ['exam']],
  ];
  const lorIds: Id[] = [];
  for (const [t, d, w, s, ty] of lor)
    lorIds.push(
      (
        await asg(c1.id, t, d, {
          weight: w,
          type: ty ?? [],
          priority: t.includes('exam') ? 'important' : 'mid',
          ...(s ? { score: pct(s) } : {}),
        })
      ).id,
    );
  await asg(c1.id, 'Bonus: attend colloquium', 30, {
    weight: 3,
    extraCredit: true,
    type: ['in_class'],
    priority: 'low',
  });

  // IPS 210: category weights with drop-lowest
  const quizzes: [number, number][] = [
    [-49, 70],
    [-35, 90],
    [-28, 100],
    [-14, 85],
  ];
  for (const [i, [d, s]] of quizzes.entries())
    await asg(c2.id, `Quiz ${i + 1}`, d, {
      categoryId: 'quiz',
      score: pct(s),
      type: ['quiz'],
      pointsPossible: 20,
    });
  await asg(c2.id, 'Quiz 5', 9, { categoryId: 'quiz', type: ['quiz'], pointsPossible: 20 });
  const hw: [number, number][] = [
    [-52, 46],
    [-38, 41],
    [-24, 48],
  ];
  for (const [i, [d, e]] of hw.entries())
    await asg(c2.id, `Homework ${i + 1}`, d, {
      categoryId: 'hw',
      score: pts(e, 50),
      pointsPossible: 50,
      type: ['homework'],
    });
  await asg(c2.id, 'Homework 4', 4, {
    categoryId: 'hw',
    pointsPossible: 50,
    type: ['homework'],
    priority: 'important',
  });
  await asg(c2.id, 'Midterm', -18, {
    categoryId: 'exam',
    score: pct(82),
    type: ['exam'],
    priority: 'important',
  });
  await asg(c2.id, 'Final', 52, { categoryId: 'exam', type: ['exam'], priority: 'important' });

  // DOL 150: total points
  for (const [i, [d, e, p]] of (
    [
      [-50, 18, 20],
      [-43, 22, 25],
      [-36, 27, 30],
      [-22, 36, 40],
      [-8, 19, 20],
    ] as [number, number, number][]
  ).entries())
    await asg(c3.id, `Lab ${i + 1}`, d, { score: pts(e, p), pointsPossible: p, type: ['lab'] });
  await asg(c3.id, 'Lab 6', 5, { pointsPossible: 30, type: ['lab'] });
  await asg(c3.id, 'Lab practical', 33, {
    pointsPossible: 100,
    type: ['exam'],
    priority: 'important',
  });

  // AME 220: assignment weights, mostly upcoming
  await asg(c4.id, 'Personal essay', -30, { weight: 25, score: pct(88), type: ['essay'] });
  await asg(c4.id, 'Peer review', 2, { weight: 15, type: ['in_class'] });
  await asg(c4.id, 'Research essay', 18, { weight: 30, type: ['essay'], priority: 'important' });
  await asg(c4.id, 'Portfolio', 54, { weight: 30, type: ['project'] });

  // a few more small items so the lists feel lived-in
  await asg(c1.id, 'Discussion post 1', -35, { weight: 2, score: pct(100), type: ['in_class'] });
  await asg(c1.id, 'Discussion post 2', -14, { weight: 2, score: pct(95), type: ['in_class'] });
  await asg(c1.id, 'Discussion post 3', 12, { weight: 2, type: ['in_class'] });
  await asg(c2.id, 'Quiz 6', 30, { categoryId: 'quiz', type: ['quiz'], pointsPossible: 20 });
  await asg(c2.id, 'Homework 5', 15, { categoryId: 'hw', pointsPossible: 50, type: ['homework'] });
  await asg(c2.id, 'Homework 6', 28, { categoryId: 'hw', pointsPossible: 50, type: ['homework'] });
  await asg(c3.id, 'Lab 7', 19, { pointsPossible: 30, type: ['lab'] });
  await asg(c3.id, 'Lab 8', 40, { pointsPossible: 30, type: ['lab'] });
  await asg(c4.id, 'Reading journal', -18, { weight: 0, type: ['homework'], status: 'complete' });
  await asg(c4.id, 'Annotated bibliography', 32, { weight: 0, type: ['homework'] });

  // SIT 099: pass/fail
  await asg(c5.id, 'Studio participation', -10, { weight: 100, score: pct(100) });

  // notes with math
  const note = (title: string, classId: Id, markdown: string, tags: string[], date: number) =>
    ctx.notes.create({
      title,
      classId,
      markdown,
      tags,
      date: iso(addDays(now, date)),
      importRef: `${REF}note:${title}`,
    });
  await note(
    'Lecture 3: Lorem foundations',
    c1.id,
    `# Lorem foundations\n\n${lorem(10)}.\n\n## Key equation\n\n$$ E = mc^2 $$\n\n- [ ] Review the proof\n- [x] Read chapter 2\n\nSee also [[Ipsum sampling notes]].\n`,
    ['lecture', 'exam1'],
    -20,
  );
  await note(
    'Ipsum sampling notes',
    c2.id,
    `# Sampling\n\nThe sample mean is $\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i$.\n\n| Term | Meaning |\n| --- | --- |\n| $n$ | sample size |\n| $\\bar{x}$ | sample mean |\n\n\`\`\`python\nmean = sum(xs) / len(xs)\n\`\`\`\n`,
    ['lecture'],
    -12,
  );
  await note(
    'Lab 5 write-up',
    c3.id,
    `# Lab 5\n\n${lorem(12)}.\n\n> **Remember:** label every axis.\n`,
    ['lab'],
    -8,
  );

  // tasks and readings
  const task = (
    title: string,
    classId: Id | undefined,
    date: number,
    extra: Record<string, unknown> = {},
  ) =>
    ctx.tasks.create({
      title,
      classId,
      date: iso(addDays(now, date)),
      importRef: `${REF}task:${title}`,
      ...extra,
    });
  await task('Outline final project', c1.id, 8, {
    priority: 'high',
    targetHours: 3,
    assignmentId: undefined,
  });
  await task('Review quiz errors', c2.id, 1, { priority: 'medium', targetHours: 1.5 });
  await task('Finish Lab 6 prep', c3.id, 3, {
    priority: 'medium',
    targetHours: 2,
    actualHours: 0.5,
  });
  await task('Email study group', undefined, 0, { priority: 'low', done: true });
  await task('Draft research essay intro', c4.id, 10, { priority: 'high', targetHours: 4 });
  await task('Midterm retrospective', c1.id, -20, {
    priority: 'medium',
    targetHours: 2,
    actualHours: 2.5,
    done: true,
  });
  await ctx.readings.create({
    title: 'Foundations of Lorem',
    classId: c1.id,
    status: 'reading',
    format: 'library',
    totalPages: 240,
    pagesRead: 96,
    importRef: `${REF}reading:1`,
  });
  await ctx.readings.create({
    title: 'A Short Ipsum Anthology',
    classId: c2.id,
    status: 'complete',
    format: 'digital',
    totalPages: 120,
    pagesRead: 120,
    importRef: `${REF}reading:2`,
  });
  void lorIds;
  return { alreadyLoaded: false, semesterId: sem.id };
}

/** Removes everything this module created (matched by importRef prefix); user-made data is untouched. */
export async function clearDemo(ctx: Context) {
  const mine = <T extends { importRef?: string; id: string }>(xs: T[]) =>
    xs.filter((x) => x.importRef?.startsWith(REF)).map((x) => x.id);
  await ctx.store.backup('pre-clear-demo');
  for (const id of mine(ctx.notes.list())) await ctx.notes.delete(id);
  await ctx.tasks.deleteMany(mine(ctx.tasks.list()));
  await ctx.readings.deleteMany(mine(ctx.readings.list()));
  await ctx.assignments.deleteMany(mine(ctx.assignments.list()));
  await ctx.classes.deleteMany(mine(ctx.classes.list()));
  await ctx.semesters.deleteMany(mine(ctx.semesters.list()));
  await ctx.config.putSchemes(ctx.config.schemes.filter((s) => s.id !== 'demo-categories'));
}
