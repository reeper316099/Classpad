import type { JsonStore } from '@classpad/jsonstore';
import {
  GpaScaleSchema,
  GradingSchemeSchema,
  type GpaScale,
  type GradingScheme,
} from '@classpad/shared';
import { DEFAULT_LETTER_SCALE, GPA_SCALES } from '@classpad/grades';
import { z } from 'zod';

const SCHEMES = 'config/grading-schemes.json';
const SCALES = 'config/gpa-scales.json';
const schemesDoc = z.object({ schemaVersion: z.number(), items: z.array(GradingSchemeSchema) });
const scalesDoc = z.object({ schemaVersion: z.number(), items: z.array(GpaScaleSchema) });

const scale = {
  cutoffs: DEFAULT_LETTER_SCALE.cutoffs.map((c) => ({
    letter: c.letter,
    min: Number(c.min),
    gpa: Number(c.gpa),
  })),
  roundingMode: 'half_up' as const,
  decimals: 2,
  letterOn: 'raw' as const,
};

export const DEFAULT_SCHEMES: GradingScheme[] = [
  {
    id: 'default',
    name: 'Assignment weights',
    mode: 'assignment_weights',
    scale,
    normalizeOverGradedOnly: true,
    extraCreditAllowed: true,
  },
  {
    id: 'categories',
    name: 'Category weights',
    mode: 'category_weights',
    categories: [],
    scale,
    normalizeOverGradedOnly: true,
    extraCreditAllowed: true,
  },
  {
    id: 'points',
    name: 'Total points',
    mode: 'points',
    scale,
    normalizeOverGradedOnly: true,
    extraCreditAllowed: true,
  },
];

export const DEFAULT_SCALES: GpaScale[] = Object.entries(GPA_SCALES).map(([id, s]) => ({
  id,
  name: s.name,
  points: s.points.map((p) => ({ letter: p.letter, gpa: Number(p.gpa) })),
  weightedBonus: Object.fromEntries(
    Object.entries(s.weightedBonus).map(([k, v]) => [k, Number(v)]),
  ),
}));

export class ConfigService {
  schemes: GradingScheme[] = [];
  scales: GpaScale[] = [];
  constructor(private store: JsonStore) {}

  async load(): Promise<void> {
    this.schemes = (
      await this.store.readJson(SCHEMES, {
        schema: schemesDoc,
        fallback: () => ({ schemaVersion: 1, items: DEFAULT_SCHEMES }),
      })
    ).items;
    this.scales = (
      await this.store.readJson(SCALES, {
        schema: scalesDoc,
        fallback: () => ({ schemaVersion: 1, items: DEFAULT_SCALES }),
      })
    ).items;
    await this.store.writeJson(
      SCHEMES,
      { schemaVersion: 1, items: this.schemes },
      { schema: schemesDoc },
    );
    await this.store.writeJson(
      SCALES,
      { schemaVersion: 1, items: this.scales },
      { schema: scalesDoc },
    );
  }

  async putSchemes(items: GradingScheme[]): Promise<GradingScheme[]> {
    const parsed = z.array(GradingSchemeSchema).min(1).parse(items);
    await this.store.writeJson(
      SCHEMES,
      { schemaVersion: 1, items: parsed },
      { schema: schemesDoc },
    );
    this.schemes = parsed;
    return parsed;
  }

  async putScales(items: GpaScale[]): Promise<GpaScale[]> {
    const parsed = z.array(GpaScaleSchema).min(1).parse(items);
    await this.store.writeJson(SCALES, { schemaVersion: 1, items: parsed }, { schema: scalesDoc });
    this.scales = parsed;
    return parsed;
  }

  scheme(id: string | undefined): GradingScheme {
    return (
      this.schemes.find((s) => s.id === id) ??
      this.schemes.find((s) => s.id === 'default') ??
      DEFAULT_SCHEMES[0]!
    );
  }
  scale(id: string | undefined): GpaScale {
    return this.scales.find((s) => s.id === id) ?? this.scales[0] ?? DEFAULT_SCALES[0]!;
  }
}

export const settingsPath = 'config/settings.json';
