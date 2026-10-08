import type { z } from 'zod';
import { asOfQuery } from '@pb/contracts';
import { ProblemError, zodIssues } from './problem.js';

/** Validates at the boundary with zod; unknown fields are rejected by the strict contracts. */
export function parseOrProblem<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  what: string,
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ProblemError(400, 'validation', `Invalid ${what}`, zodIssues(result.error));
  return result.data;
}

/** The as-of date of a read: the ?asOf query (a real calendar date, else 400), or today by the clock adapter. */
export function asOfOrToday(query: unknown, clock: { today(): string }): string {
  return parseOrProblem(asOfQuery, query, 'query').asOf ?? clock.today();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id that is not a UUID is simply not found: existence is never revealed, and the database never sees garbage. */
export function requireUuid(id: string, notFound: string): void {
  if (!UUID.test(id)) throw new ProblemError(404, 'not-found', notFound);
}
