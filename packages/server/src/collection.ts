import type { Base } from './repo.js';

/** What the generic CRUD routes need from a repository. */
export interface Collection<T extends Base> {
  readonly name: string;
  list(): T[];
  get(id: string): T | undefined;
  create(input: Record<string, unknown>): Promise<T>;
  update(id: string, patch: Record<string, unknown>): Promise<T>;
  delete(id: string): Promise<void>;
}
