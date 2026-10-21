import {
  D,
  computeGpa,
  computeGrade,
  gpaReport,
  neededScore,
  planGpa,
  project,
  sensitivity,
  whatIf,
  type GpaCourse,
  type GradeItem,
  type Scheme,
  type ScoreInput,
} from '@classpad/grades';
import type { Assignment, ClassEntity, GradingScheme, Semester } from '@classpad/shared';
import type { ConfigService } from './config.js';
import { ApiError } from './errors.js';

export function toEngineScheme(s: GradingScheme, cls?: ClassEntity): Scheme {
  return {
    mode: s.mode,
    categories: s.categories,
    scale: { cutoffs: s.scale.cutoffs },
    rounding: {
      mode: s.scale.roundingMode,
      decimals: s.scale.decimals,
      letterOn: s.scale.letterOn,
    },
    normalizeOverGradedOnly: s.normalizeOverGradedOnly,
    extraCreditAllowed: s.extraCreditAllowed,
    extraCreditCapPercent: s.extraCreditCapPercent,
    latePolicy: s.latePolicy,
    curve: s.curve,
    maxScore: s.maxScore,
    passFail: cls?.passFail ? { threshold: 60 } : undefined,
  };
}

export function toGradeItem(a: Assignment): GradeItem {
  let score: ScoreInput | null = null;
  if (a.score)
    score =
      'percent' in a.score
        ? { kind: 'percent', percent: a.score.percent }
        : { kind: 'points', earned: a.score.earned, possible: a.score.possible };
  return {
    id: a.id,
    title: a.title,
    categoryId: a.categoryId,
    weight: a.weight,
    pointsPossible: a.pointsPossible,
    score,
    extraCredit: a.extraCredit,
    excused: a.excused,
    dropped: a.dropped,
    latePenalty: a.latePenalty,
  };
}

export interface GradingDeps {
  config: ConfigService;
  classes: () => ClassEntity[];
  semesters: () => Semester[];
  assignments: () => Assignment[];
}

export class GradingService {
  constructor(private d: GradingDeps) {}

  private cls(id: string): ClassEntity {
    const c = this.d.classes().find((x) => x.id === id);
    if (!c) throw new ApiError(404, 'NOT_FOUND', `class "${id}" not found`);
    return c;
  }
  private ctx(id: string) {
    const c = this.cls(id);
    return {
      cls: c,
      scheme: toEngineScheme(this.d.config.scheme(c.gradingSchemeId), c),
      items: this.d
        .assignments()
        .filter((a) => a.classId === id)
        .map(toGradeItem),
    };
  }

  classGrade(id: string) {
    const { cls, scheme, items } = this.ctx(id);
    return {
      classId: id,
      name: cls.name,
      grade: computeGrade(scheme, items),
      sensitivity: sensitivity(scheme, items),
      projection: project(scheme, items),
    };
  }

  whatIf(id: string, overrides: Record<string, ScoreInput | null>) {
    const { scheme, items } = this.ctx(id);
    return whatIf(scheme, items, overrides);
  }

  needed(id: string, opts: Parameters<typeof neededScore>[2]) {
    const { scheme, items } = this.ctx(id);
    return neededScore(scheme, items, opts);
  }

  private courses(semesterId?: string): GpaCourse[] {
    const order = new Map(
      [...this.d.semesters()]
        .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
        .map((s, i) => [s.id, i]),
    );
    return this.d
      .classes()
      .filter((c) => !c.archived && (!semesterId || c.semesterId === semesterId))
      .map((c) => {
        const { scheme, items } = this.ctx(c.id);
        const g = computeGrade(scheme, items);
        return {
          id: c.id,
          name: c.name,
          semesterId: c.semesterId,
          credits: c.credits ?? null,
          letter: g.letter,
          honorsLevel: String(c.honorsLevel),
          passFail: c.passFail,
          includeInGpa: c.includeInGpa,
          courseKey: c.code,
          termIndex: order.get(c.semesterId) ?? 0,
        };
      });
  }

  semester(id: string) {
    const sem = this.d.semesters().find((s) => s.id === id);
    if (!sem) throw new ApiError(404, 'NOT_FOUND', `semester "${id}" not found`);
    const classes = this.d.classes().filter((c) => c.semesterId === id && !c.archived);
    const results = classes.map((c) => ({
      classId: c.id,
      name: c.name,
      credits: c.credits ?? null,
      grade: computeGrade(this.ctx(c.id).scheme, this.ctx(c.id).items),
    }));
    const graded = results.filter((r) => r.grade.percentRaw);
    const sum = graded.reduce((a, r) => a.plus(r.grade.percentRaw!), new D(0));
    const average = graded.length ? sum.div(graded.length) : null;
    const scale = this.d.config.scale(sem.gpaScaleId);
    const gpa = computeGpa(this.courses(id), scale, { weighted: false });
    return {
      semesterId: id,
      name: sem.name,
      classes: results,
      averageGrade: average,
      averageNote: 'Plain average of class percents (graded classes only)',
      gpa,
    };
  }

  gpa(opts: { scaleId?: string; semesterId?: string } = {}) {
    const scale = this.d.config.scale(opts.scaleId);
    const courses = this.courses(opts.semesterId);
    const ordered = [...this.d.semesters()].sort((a, b) =>
      (a.start ?? a.createdAt).localeCompare(b.start ?? b.createdAt),
    );
    // cumulative GPA as of the end of each semester, for the trend chart
    const progress = ordered.map((s, i) => {
      const upTo = new Set(ordered.slice(0, i + 1).map((x) => x.id));
      const subset = courses.filter((c) => c.semesterId && upTo.has(c.semesterId));
      return {
        semesterId: s.id,
        name: s.name,
        unweighted: computeGpa(subset, scale, { weighted: false }).gpa,
        weighted: computeGpa(subset, scale, { weighted: true }).gpa,
      };
    });
    return { scaleId: scale.id, ...gpaReport(courses, scale), courses, progress };
  }

  plan(opts: { targetGpa: number; plannedCredits: number; weighted?: boolean; scaleId?: string }) {
    const scale = this.d.config.scale(opts.scaleId);
    const cur = computeGpa(this.courses(), scale, { weighted: !!opts.weighted });
    const maxBase = Math.max(...scale.points.map((p) => p.gpa));
    const maxBonus = opts.weighted ? Math.max(0, ...Object.values(scale.weightedBonus)) : 0;
    return {
      current: cur,
      plan: planGpa({
        currentQualityPoints: cur.qualityPoints,
        currentCredits: cur.credits,
        plannedCredits: opts.plannedCredits,
        targetGpa: opts.targetGpa,
        maxGpa: maxBase + maxBonus,
      }),
    };
  }
}
