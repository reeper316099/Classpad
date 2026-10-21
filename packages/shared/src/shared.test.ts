import { describe, expect, it } from 'vitest';
import { APP_NAME, AssignmentSchema, newId } from './index.js';

describe('shared', () => {
  it('exposes APP_NAME', () => expect(APP_NAME).toBe('Classpad'));
  it('generates unique sortable ids', () => {
    expect(newId()).not.toBe(newId());
  });
  it('applies assignment defaults', () => {
    const a = AssignmentSchema.parse({
      id: newId(),
      classId: 'c',
      title: 'HW',
      createdAt: 'x',
      updatedAt: 'x',
    });
    expect(a.priority).toBe('mid');
    expect(a.status).toBe('not_started');
  });
});
