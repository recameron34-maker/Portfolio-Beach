import { parseIso } from '@pb/calc';
import { ProblemError } from './problem.js';

/*
 * Page cursors for composite sort keys: the last row's key parts joined with '|' and carried as
 * base64url (docs/17 section 3). Opaque to clients; validated on the way back in.
 */

function isCalendarDate(iso: string): boolean {
  try {
    parseIso(iso);
    return true;
  } catch {
    return false;
  }
}

export const encodeCursor = (parts: readonly (string | number)[]): string =>
  Buffer.from(parts.join('|'), 'utf8').toString('base64url');

/**
 * The capture groups of a cursor made by encodeCursor, in pattern order. The decoded text must
 * match the pattern in full, and the groups listed in `dateGroups` (numbered as in the pattern,
 * from 1) must be real calendar dates. Anything else is a 400 'validation' problem, so a forged
 * cursor never reaches Postgres as a cast error.
 */
export function decodeCursor(
  cursor: string,
  pattern: RegExp,
  dateGroups: readonly number[] = [],
): string[] {
  const match = pattern.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (match === null || dateGroups.some((group) => !isCalendarDate(match[group] ?? '')))
    throw new ProblemError(400, 'validation', 'Invalid cursor');
  return match.slice(1);
}
