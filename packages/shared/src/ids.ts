import { monotonicFactory } from 'ulid';

// Monotonic: ids made in the same millisecond still sort in the order they were made, so lists (sorted
// by id) keep creation order.
const next = monotonicFactory();
export const newId = (): string => next();
