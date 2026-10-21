import { z } from 'zod';
export const PrioritySchema = z.enum(['important', 'mid', 'low']);
export const TaskPrioritySchema = z.enum(['low', 'medium', 'high']);
export const StatusSchema = z.enum(['not_started', 'in_progress', 'complete']);
export const ReadingStatusSchema = z.enum(['to_read', 'reading', 'complete']);
export const DeliverySchema = z.enum(['in_person', 'online', 'hybrid']);
export const GradingModeSchema = z.enum(['assignment_weights', 'category_weights', 'points']);
export const HonorsLevelSchema = z.union([
  z.enum(['regular', 'honors', 'ap', 'ib', 'dual']),
  z.string().min(1),
]);
export const WeekdaySchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
