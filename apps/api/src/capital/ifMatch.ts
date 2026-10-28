import { ProblemError } from '../common/problem.js';

/*
 * Optimistic concurrency on the capital commands (docs/17 section 3): a caller may send the row
 * version it read as `If-Match: "<n>"` (a weak validator `W/"<n>"` is accepted too). A command
 * on a row that has moved on since answers 412 with the problem code `stale`, so two people
 * acting on the same notice or instruction never overwrite each other unknowingly. Without the
 * header the command runs against the row as it is now (the row lock and the state guard still
 * apply). The capital module's own helper until the modules share one (rule 7 follow-up).
 */

const IF_MATCH = /^(?:W\/)?"?(\d{1,9})"?$/;

/** The problem code of a stale If-Match. */
export const STALE = 'stale';

/** The row version an If-Match header names; undefined without the header; 400 for anything else. */
export function rowVersionFromIfMatch(header: string | undefined): number | undefined {
  if (header === undefined || header.trim() === '') return undefined;
  const match = IF_MATCH.exec(header.trim());
  if (match === null) throw new ProblemError(400, 'validation', 'Invalid If-Match');
  return Number(match[1]);
}

/** 412 when the caller named a row version and the row has moved on since. */
export function requireFreshRow(expected: number | undefined, actual: number, what: string): void {
  if (expected !== undefined && expected !== actual)
    throw new ProblemError(
      412,
      STALE,
      `${what}: the record changed since it was read (row version ${actual}); open it again`,
    );
}
