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

/*
 * Lists sorted newest first page on (at, id): a timestamp and the row's id, so two rows stamped
 * in the same microsecond still have an order and nothing is skipped or repeated across pages.
 * The time comes first because a row is stamped with its transaction's start time, so a slower
 * transaction can write a higher id with an earlier time. The cursor carries the time exactly as
 * the database holds it (to the microsecond, EXACT_AT_FORMAT), never as the response shows it.
 */

/** The `at` part of such a cursor: a date and a time to the microsecond, as two groups. */
const EXACT_AT = String.raw`(\d{4}-\d{2}-\d{2})T((?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{6})Z`;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** "at|id" of a row keyed by a UUID (an intake file, a data exception): groups date, time, id. */
export const AT_ID_CURSOR = new RegExp(`^${EXACT_AT}\\|(${UUID})$`);
/** "at|id" of a row keyed by a bigint (an audit event): groups date, time, id as digits that fit a bigint. */
export const AT_BIGINT_CURSOR = new RegExp(`^${EXACT_AT}\\|(\\d{1,18})$`);
/** The to_char format that writes a timestamp to the microsecond, the exact value the cursor carries. */
export const EXACT_AT_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/** The key an (at, id) cursor names: the time as timestamptz text and the id, the date checked. */
export function decodeAtIdCursor(cursor: string, pattern: RegExp): { at: string; id: string } {
  const [date = '', time = '', id = ''] = decodeCursor(cursor, pattern, [1]);
  return { at: `${date}T${time}Z`, id };
}
