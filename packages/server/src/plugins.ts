import { BUILTIN_MAPPINGS } from '@classpad/importers';
import { MappingPluginSchema, type MappingPlugin } from '@classpad/shared';
import type { JsonStore } from '@classpad/jsonstore';

const DIR = 'plugins';
const MAX_FILES = 50;
const MAX_BYTES = 64 * 1024;

export interface PluginListing {
  builtin: MappingPlugin[];
  user: (MappingPlugin & { file: string })[];
  errors: { file: string; message: string }[];
}

/** Plugins are plain JSON in `<data folder>/plugins/`. They are validated, never executed. */
export async function listPlugins(store: JsonStore): Promise<PluginListing> {
  const out: PluginListing = { builtin: BUILTIN_MAPPINGS, user: [], errors: [] };
  const files = (await store.list(DIR, { ext: '.json', recursive: true })).slice(0, MAX_FILES);
  const taken = new Set(BUILTIN_MAPPINGS.map((p) => p.id));
  for (const file of files) {
    try {
      const text = await store.readText(file);
      if (text === null) continue;
      if (text.length > MAX_BYTES) throw new Error('file is larger than 64 KB');
      const p = MappingPluginSchema.parse(JSON.parse(text));
      if (taken.has(p.id)) throw new Error(`id "${p.id}" is already used`);
      taken.add(p.id);
      out.user.push({ ...p, file });
    } catch (e) {
      const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
      out.errors.push({
        file,
        message: issues
          ? issues.map((i) => `${i.path.join('.') || 'file'}: ${i.message}`).join('; ')
          : (e as Error).message,
      });
    }
  }
  return out;
}

export async function findPlugin(store: JsonStore, id: string): Promise<MappingPlugin | undefined> {
  const l = await listPlugins(store);
  return [...l.builtin, ...l.user].find((p) => p.id === id);
}
