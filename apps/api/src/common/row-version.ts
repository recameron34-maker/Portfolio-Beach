import type { Response } from 'express';
import { ProblemError } from './problem.js';

/*
 * Optimistic concurrency on the command routes (docs/17 section 3: the ETag of a record is its
 * row version, a command may carry it back as If-Match, a mismatch is 412). This is the one copy
 * for the API (CLAUDE.md rule 7): every module that tags a record or checks a row version imports
 * it from here.
 *
 * A controller parses the header at the boundary with ifMatchVersions, so a malformed header is
 * 400 before a transaction opens; the service checks the versions parsed against the row version
 * it read under lock with requireFreshRow, before it changes anything; a controller that answers
 * with a record tags the answer with withEtag, so a later If-Match can name it. The header is
 * optional: without it, or with "*", the command runs on the record as it stands (the row is
 * locked and the write is guarded on the state and row version read either way). It may carry
 * one or more entity tags, each a quoted or bare row version, weak ones (W/"3") included;
 * anything else is 400, so a malformed header never reads as "no header".
 */

const ROW_VERSION = /^\d{1,9}$/;

/** The row versions an If-Match header names; undefined without the header or with "*"; 400 for anything else. */
export function ifMatchVersions(header: string | string[] | undefined): number[] | undefined {
  if (header === undefined) return undefined;
  const tags = (Array.isArray(header) ? header.join(',') : header)
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (tags.includes('*')) return undefined;
  const versions = tags.map((tag) => tag.replace(/^W\//i, '').replace(/^"(.*)"$/, '$1'));
  if (versions.length === 0 || versions.some((v) => !ROW_VERSION.test(v)))
    throw new ProblemError(400, 'validation', 'Invalid If-Match', [
      { path: 'If-Match', message: 'Expected the row version as an entity tag' },
    ]);
  return versions.map(Number);
}

/** 412 (problem code stale-row-version) when the caller named row versions and none is the one read under lock; `what` names the record kind. */
export function requireFreshRow(
  versions: readonly number[] | undefined,
  rowVersion: number,
  what: string,
): void {
  if (versions === undefined || versions.includes(rowVersion)) return;
  throw new ProblemError(
    412,
    'stale-row-version',
    `${what}: the record changed since it was read (it is now at row version ${rowVersion}); open it again`,
  );
}

/** Sets the record's row version as the response ETag and hands the record back. */
export function withEtag<T extends { rowVersion: number }>(res: Response, row: T): T {
  res.setHeader('ETag', `"${row.rowVersion}"`);
  return row;
}
