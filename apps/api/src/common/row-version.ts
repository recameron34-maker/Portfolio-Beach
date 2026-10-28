import { ProblemError } from './problem.js';

/*
 * Optimistic concurrency on the command routes (docs/17 section 3: the ETag is the row version, a
 * mismatch is 412). A caller that read a record may send its row version back as If-Match; the
 * command then refuses when the record changed since that read, before it changes anything.
 * Without the header the command runs against the record as it is now: the row is locked and the
 * write is guarded on the state and the row version it read either way.
 */

/** The If-Match header against the row version read under lock: absent passes, the same version (or *) passes, anything else is 412. */
export function requireIfMatch(header: string | string[] | undefined, rowVersion: number): void {
  if (header === undefined) return;
  const raw = Array.isArray(header) ? (header[0] ?? '') : header;
  const value = raw
    .trim()
    .replace(/^W\//i, '')
    .replace(/^"(.*)"$/, '$1');
  if (value === '*' || value === String(rowVersion)) return;
  throw new ProblemError(
    412,
    'stale-row-version',
    `The record changed since it was read (it is now at row version ${rowVersion})`,
  );
}
