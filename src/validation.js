import { z } from 'zod';
import { badRequest } from './errors.js';

/** Trim + collapse whitespace so "  Hot   Yoga " is stored as "Hot Yoga". */
const text = (label, min, max) =>
  z.string({ required_error: `${label} is required.`, invalid_type_error: `${label} must be text.` })
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(min, `${label} is required.`).max(max, `${label} must be at most ${max} characters.`));

const id = (label) =>
  z.coerce.number({ invalid_type_error: `${label} must be a number.`, required_error: `${label} is required.` })
    .int(`${label} must be a whole number.`).positive(`${label} must be positive.`);

const isoInstant = z
  .string({ required_error: 'Start time is required.' })
  .refine((s) => !Number.isNaN(Date.parse(s)) && /T/.test(s), 'Start time must be a valid date and time.')
  .transform((s) => new Date(s).toISOString());

const email = z
  .string({ required_error: 'Email is required.' })
  .trim().toLowerCase()
  .max(254, 'Email is too long.')
  .email('Enter a valid email address.');

export const schemas = {
  login: z.object({
    email,
    password: z.string({ required_error: 'Password is required.' }).min(1, 'Password is required.').max(200),
  }),

  register: z.object({
    name: text('Name', 2, 80),
    email,
    password: z.string({ required_error: 'Password is required.' })
      .min(8, 'Password must be at least 8 characters.')
      .max(200, 'Password is too long.')
      .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Password needs at least one letter and one number.'),
  }),

  classCreate: z.object({
    title: text('Title', 2, 80),
    category: text('Category', 2, 40),
    description: text('Description', 0, 500).optional(),
    trainerId: id('Trainer'),
    startsAt: isoInstant,
    durationMin: z.coerce.number({ invalid_type_error: 'Duration must be a number.' })
      .int('Duration must be a whole number of minutes.')
      .min(15, 'Duration must be at least 15 minutes.')
      .max(240, 'Duration must be at most 240 minutes.'),
    capacity: z.coerce.number({ invalid_type_error: 'Capacity must be a number.', required_error: 'Capacity is required.' })
      .int('Capacity must be a whole number.')
      .min(1, 'Capacity must be at least 1.')
      .max(200, 'Capacity must be at most 200.'),
  }).strict(),

  membershipCreate: z.object({
    planId: id('Plan'),
  }).strict(),

  membershipAdmin: z.object({
    userId: id('Member'),
    planId: id('Plan'),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').optional(),
  }).strict(),

  attendance: z.object({
    records: z.array(z.object({
      userId: id('Member'),
      status: z.enum(['attended', 'absent'], { errorMap: () => ({ message: 'Status must be attended or absent.' }) }),
    })).min(1, 'Select at least one member.').max(500),
  }).strict(),

  dateRange: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
  }),
};

schemas.classUpdate = schemas.classCreate.partial().strict()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to update.');

/** Parse or throw a 400 whose `fields` map each bad field to a human message. */
export function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  const fields = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  const first = Object.values(fields)[0];
  throw badRequest(first, fields);
}
