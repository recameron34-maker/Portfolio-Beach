import type { Response } from 'express';
import {
  IF_MATCH_ISSUE,
  INVALID_IF_MATCH_DETAIL,
  STALE_ROW_VERSION_CODE,
  isFreshRow,
  parseIfMatch,
  rowVersionEtag,
  staleRowVersionDetail,
} from '@pb/contracts';
import { ProblemError } from './problem.js';

/*
 * Optimistic concurrency on the command routes (docs/17 section 3: the ETag of a record is its
 * row version, a command may carry it back as If-Match, a mismatch is 412). This is the one copy
 * for the API (CLAUDE.md rule 7): every module that tags a record or checks a row version imports
 * it from here. The header's own rules (what a tag may look like, the texts of the two refusals)
 * are the contracts' (packages/contracts/src/row-version.ts), which the static preview reads
 * too, so the two cannot answer differently; what is here is how the API raises them.
 *
 * A controller parses the header at the boundary with ifMatchVersions, so a malformed header is
 * 400 before a transaction opens; the service checks the versions parsed against the row version
 * it read under lock with requireFreshRow, before it changes anything; a controller that answers
 * with a record tags the answer with withEtag, so a later If-Match can name it. The header is
 * optional: without it, or with "*", the command runs on the record as it stands (the row is
 * locked and the write is guarded on the state and row version read either way). It may carry
 * one or more entity tags, each a quoted or bare row version, weak ones (W/"3") included;
 * anything else is 400, so a malformed header never reads as "no header". A route that reads the
 * header says so in the contract (`ifMatch` on its route).
 */

/** The row versions an If-Match header names; undefined without the header or with "*"; 400 for anything else. */
export function ifMatchVersions(header: string | string[] | undefined): number[] | undefined {
  const parsed = parseIfMatch(header);
  if (!parsed.ok)
    throw new ProblemError(400, 'validation', INVALID_IF_MATCH_DETAIL, [{ ...IF_MATCH_ISSUE }]);
  return parsed.versions === undefined ? undefined : [...parsed.versions];
}

/** 412 (problem code stale-row-version) when the caller named row versions and none is the one read under lock; `what` names the record kind. */
export function requireFreshRow(
  versions: readonly number[] | undefined,
  rowVersion: number,
  what: string,
): void {
  if (isFreshRow(versions, rowVersion)) return;
  throw new ProblemError(412, STALE_ROW_VERSION_CODE, staleRowVersionDetail(what, rowVersion));
}

/** Sets the record's row version as the response ETag and hands the record back. */
export function withEtag<T extends { rowVersion: number }>(res: Response, row: T): T {
  res.setHeader('ETag', rowVersionEtag(row.rowVersion));
  return row;
}
