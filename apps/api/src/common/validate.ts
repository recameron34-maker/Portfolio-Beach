import type { z } from 'zod';
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
