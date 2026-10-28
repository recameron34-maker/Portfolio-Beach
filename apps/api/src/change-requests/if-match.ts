import { ProblemError } from '../common/problem.js';

/*
 * Optimistic concurrency on a command (docs/17 section 3): the ETag of a record is its row
 * version, a command may carry it back as If-Match, and a version that no longer matches the row
 * is 412. The header is optional: a command without it works on the row as it stands, locked for
 * the transaction. Accepted forms are the bare number, a quoted entity tag and a weak one
 * (W/"3"); anything else is a 400 so a malformed header never reads as "no header". One copy
 * for the API (CLAUDE.md rule 7): a module that needs it imports it from here.
 */

const IF_MATCH = /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/;

/** The ETag header value of a record: its row version as a quoted entity tag. */
export const etagOf = (rowVersion: number): string => `"${rowVersion}"`;

/** Throws 412 when If-Match names a row version other than the one read; 400 when it is not a version at all. */
export function requireFreshIfMatch(ifMatch: string | undefined, rowVersion: number): void {
  if (ifMatch === undefined) return;
  const match = IF_MATCH.exec(ifMatch);
  if (match === null) throw new ProblemError(400, 'validation', 'Invalid If-Match');
  if (Number(match[1]) !== rowVersion)
    throw new ProblemError(
      412,
      'stale-if-match',
      `The record changed since it was read: it is now version ${rowVersion}`,
    );
}
