import { isCalendarDate } from '@pb/contracts';
import { ProblemError } from './problem.js';

/*
 * Page cursors for composite sort keys: the last row's key parts joined with '|' and carried as
 * base64url (docs/17 section 3). Opaque to clients; validated on the way back in, dates by the
 * same calendar check as every date the contracts accept.
 */

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
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  // No key holds a control character, and Postgres refuses a NUL byte in a parameter outright.
  const match = CONTROL.test(text) ? null : pattern.exec(text);
  if (match === null || dateGroups.some((group) => !isCalendarDate(match[group] ?? '')))
    throw new ProblemError(400, 'validation', 'Invalid cursor');
  return match.slice(1);
}

const CONTROL = /\p{Cc}/u;
