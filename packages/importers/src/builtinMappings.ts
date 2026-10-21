import { MappingPluginSchema, type MappingPlugin } from '@classpad/shared';

/** Built-in formats, written in the same declarative format users can write themselves. */
export const BUILTIN_MAPPINGS: MappingPlugin[] = [
  {
    pluginVersion: 1,
    id: 'gradebook-rows',
    name: 'Gradebook: one row per assignment',
    description:
      'Common LMS/gradebook export with columns like Assignment, Score and Points Possible.',
    kind: 'gradebook-csv',
    layout: 'long',
    columns: {
      title: ['Assignment', 'Assignment Name', 'Title', 'Name', 'Item'],
      class: ['Course', 'Class', 'Course Name'],
      due: ['Due', 'Due Date', 'Due At'],
      score: ['Score', 'Points', 'Points Earned', 'Earned', 'Current Score', 'Grade'],
      pointsPossible: [
        'Points Possible',
        'Out Of',
        'Max Points',
        'Total Points',
        'Possible',
        'Max',
      ],
      weight: ['Weight', 'Weight %', 'Group Weight', 'Percent of Grade'],
      status: ['Status'],
      type: ['Type', 'Category', 'Group', 'Assignment Group'],
      notes: ['Comments', 'Notes'],
    },
    wide: { skipColumns: [], pointsInHeader: true },
    scoreFormat: 'auto',
    skipRows: [],
  },
  {
    pluginVersion: 1,
    id: 'gradebook-columns',
    name: 'Gradebook: one column per assignment',
    description:
      'Wide export where each assignment is a column and your row holds the scores. Points possible may be in the header, e.g. "Essay 1 (50)".',
    kind: 'gradebook-csv',
    layout: 'wide',
    columns: {},
    wide: { skipColumns: [], pointsInHeader: true },
    scoreFormat: 'auto',
    skipRows: [],
  },
].map((p) => MappingPluginSchema.parse(p));
