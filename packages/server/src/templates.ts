import type { JsonStore } from '@classpad/jsonstore';
import { parseFrontmatter, stringifyFrontmatter } from '@classpad/shared';
import { ApiError } from './errors.js';
import { slugify } from './slug.js';

const DIR = 'config/templates/notes';
export interface NoteTemplate {
  id: string;
  name: string;
  markdown: string;
}

/** Placeholders: {{title}}, {{date}}, {{class}} are filled in by the app when a note is created. */
const DEFAULTS: Record<string, [string, string]> = {
  lecture: [
    'Lecture notes',
    '# {{title}}\n\n**Class:** {{class}} · **Date:** {{date}}\n\n## Key ideas\n\n- \n\n## Details\n\n\n## Questions\n\n- [ ] \n\n## Summary\n\n',
  ],
  cornell: [
    'Cornell notes',
    '# {{title}}\n\n**Class:** {{class}} · **Date:** {{date}}\n\n## Cues / questions\n\n- \n\n## Notes\n\n\n## Summary\n\n> Write a two-sentence summary in your own words.\n',
  ],
  'lab-report': [
    'Lab report',
    '# {{title}}\n\n**Class:** {{class}} · **Date:** {{date}}\n\n## Purpose\n\n\n## Hypothesis\n\n\n## Method\n\n1. \n\n## Data\n\n| Trial | Measurement | Notes |\n| --- | --- | --- |\n|  |  |  |\n\n## Analysis\n\nUse math like $v = \\frac{d}{t}$ where needed.\n\n## Conclusion\n\n',
  ],
  'reading-notes': [
    'Reading notes',
    '# {{title}}\n\n**Class:** {{class}} · **Date:** {{date}}\n\n## Source\n\n\n## Main argument\n\n\n## Quotes & page numbers\n\n> \n\n## My reaction\n\n',
  ],
  'problem-set': [
    'Problem set',
    '# {{title}}\n\n**Class:** {{class}} · **Date:** {{date}}\n\n## Problem 1\n\n**Approach:**\n\n**Work:**\n\n$$\n\n$$\n\n**Answer:**\n\n## Problem 2\n\n',
  ],
};

export class TemplateService {
  constructor(private store: JsonStore) {}

  /** Writes the built-in templates the first time (never overwrites yours). */
  async seed(): Promise<void> {
    if ((await this.store.list(DIR, { ext: '.md' })).length) return;
    for (const [id, [name, md]] of Object.entries(DEFAULTS)) await this.write(id, name, md);
  }

  private async write(id: string, name: string, markdown: string) {
    await this.store.writeText(`${DIR}/${id}.md`, stringifyFrontmatter(markdown, { name }));
  }

  async list(): Promise<NoteTemplate[]> {
    const out: NoteTemplate[] = [];
    for (const rel of await this.store.list(DIR, { ext: '.md' })) {
      const text = await this.store.readText(rel);
      if (text === null) continue;
      const id = rel.split('/').pop()!.replace(/\.md$/, '');
      try {
        const fm = parseFrontmatter(text);
        out.push({ id, name: String(fm.data.name ?? id.replace(/-/g, ' ')), markdown: fm.content });
      } catch {
        out.push({ id, name: id.replace(/-/g, ' '), markdown: text });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(name: string, markdown: string, id?: string): Promise<NoteTemplate> {
    const slug = id ?? slugify(name);
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug))
      throw new ApiError(400, 'BAD_ID', 'invalid template id');
    await this.write(slug, name, markdown);
    return { id: slug, name, markdown };
  }

  async remove(id: string): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(id))
      throw new ApiError(400, 'BAD_ID', 'invalid template id');
    await this.store.remove(`${DIR}/${id}.md`);
  }
}
