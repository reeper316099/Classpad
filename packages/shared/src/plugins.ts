import { z } from 'zod';

/**
 * Classpad plugins are declarative: a JSON file that describes how to read someone else's CSV.
 * They never run code, so installing one cannot do anything a plain data file cannot.
 * Plugins live in `<data folder>/plugins/*.json`.
 */
const Header = z
  .union([z.string().min(1).max(100), z.array(z.string().min(1).max(100)).min(1).max(8)])
  .transform((v) => (Array.isArray(v) ? v : [v]));

const RowFilter = z
  .object({
    column: z.string().min(1).max(100),
    equals: z.string().max(200).optional(),
    contains: z.string().min(1).max(200).optional(),
  })
  .refine((f) => f.equals !== undefined || f.contains !== undefined, {
    message: 'a row filter needs "equals" or "contains"',
  });

export const MappingPluginSchema = z.object({
  pluginVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}$/, 'id: lowercase letters, digits and dashes'),
  name: z.string().min(1).max(80),
  description: z.string().max(400).optional(),
  author: z.string().max(80).optional(),
  kind: z.literal('gradebook-csv'),
  /** `long`: one row per assignment. `wide`: one column per assignment (one row per student). */
  layout: z.enum(['long', 'wide']).default('long'),
  /** Long layout: source headers (case-insensitive, first match wins) for each Classpad field. */
  columns: z
    .object({
      title: Header.optional(),
      class: Header.optional(),
      due: Header.optional(),
      score: Header.optional(),
      pointsPossible: Header.optional(),
      weight: Header.optional(),
      status: Header.optional(),
      type: Header.optional(),
      notes: Header.optional(),
    })
    .default({}),
  /** Wide layout options. */
  wide: z
    .object({
      /** Choose the student's row when the file has several. */
      studentColumn: z.string().max(100).optional(),
      studentValue: z.string().max(200).optional(),
      /** Columns that are not assignments (id, section, totals…). */
      skipColumns: z.array(z.string().max(100)).max(40).default([]),
      /** A row holding points possible per column (some exports include one). */
      pointsRow: RowFilter.optional(),
      /** Read points possible from the header, e.g. "Essay 1 (50)" or "Quiz [20 pts]". */
      pointsInHeader: z.boolean().default(true),
    })
    .default({}),
  /** How bare numbers in the score column are read. `auto`: points when points possible is known, else percent. */
  scoreFormat: z.enum(['auto', 'percent', 'points']).default('auto'),
  /** Used when the file has no class column. The user can override it at import time. */
  className: z.string().max(200).optional(),
  skipRows: z.array(RowFilter).max(20).default([]),
});
export type MappingPlugin = z.infer<typeof MappingPluginSchema>;
