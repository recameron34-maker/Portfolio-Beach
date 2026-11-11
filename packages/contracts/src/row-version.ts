/*
 * Optimistic concurrency over HTTP (docs/17 section 3): the ETag of a record is its row version,
 * a command may carry it back as If-Match, and a mismatch is 412. This is the one copy of the
 * header's rules (CLAUDE.md rule 7): the API (apps/api/src/common/row-version.ts) and the static
 * preview (apps/web/src/preview/routes/common.ts) both read the header through parseIfMatch and
 * word their refusals from the texts below, so the two cannot answer differently.
 *
 * The header is optional. Without it, or with "*", the command runs on the record as it stands.
 * It may carry one or more entity tags, each a quoted or bare row version, weak ones (W/"3")
 * included. Anything else is malformed and refused with 400, so a malformed header never reads
 * as "no header".
 */

/** The header as fetch and Node report it. */
export const IF_MATCH_HEADER = 'if-match';

/** The detail of the 400 `validation` problem a malformed header is refused with. */
export const INVALID_IF_MATCH_DETAIL = 'Invalid If-Match';

/** The one entry of that problem's `errors` list. */
export const IF_MATCH_ISSUE: { readonly path: string; readonly message: string } = {
  path: 'If-Match',
  message: 'Expected the row version as an entity tag',
};

/** The problem code of the 412 a stale row version is refused with. */
export const STALE_ROW_VERSION_CODE = 'stale-row-version';

/** A row version as text: one to nine digits, so it always fits the integer column. */
const ROW_VERSION = /^\d{1,9}$/;

/**
 * What an If-Match header asks for: no check (`versions` undefined: no header, or "*"), a check
 * against the row versions named, or nothing readable (`ok` false: the caller answers 400).
 */
export type IfMatch = { ok: true; versions: readonly number[] | undefined } | { ok: false };

/**
 * Reads an If-Match header: absent (undefined, or null as `Headers.get` reports it), one value,
 * or the values of a repeated header, which read as one comma-separated list.
 */
export function parseIfMatch(header: string | readonly string[] | null | undefined): IfMatch {
  if (header === undefined || header === null) return { ok: true, versions: undefined };
  const tags = (typeof header === 'string' ? header : header.join(','))
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (tags.includes('*')) return { ok: true, versions: undefined };
  const versions = tags.map((tag) => tag.replace(/^W\//i, '').replace(/^"(.*)"$/, '$1'));
  if (versions.length === 0 || versions.some((v) => !ROW_VERSION.test(v))) return { ok: false };
  return { ok: true, versions: versions.map(Number) };
}

/** Whether a command may run on the row: the caller named no versions, or one of them is the row's. */
export function isFreshRow(versions: readonly number[] | undefined, rowVersion: number): boolean {
  return versions === undefined || versions.includes(rowVersion);
}

/** The detail of the 412: `what` names the record kind ("valuation"), as the workflow tables do. */
export function staleRowVersionDetail(what: string, rowVersion: number): string {
  return `${what}: the record changed since it was read (it is now at row version ${rowVersion}); open it again`;
}

/** A row version as the entity tag an answer carries: the number in double quotes. */
export function rowVersionEtag(rowVersion: number): string {
  return `"${rowVersion}"`;
}

/** One line of the conformance table below. */
export interface IfMatchCase {
  /** What the case shows. */
  name: string;
  /** The header as received: absent, one value, or the values of a repeated header. */
  header: string | readonly string[] | undefined;
  /** The row versions named; 'any' when no check applies; 'invalid' when the answer is 400. */
  expected: readonly number[] | 'any' | 'invalid';
}

/**
 * The conformance table of the header: what every reader of If-Match must answer. It pins the
 * API's behaviour as it stood when the parser moved here, and three tests run it: this package's
 * (parseIfMatch), the API's (ifMatchVersions) and the preview's (staleIfMatch).
 */
export const IF_MATCH_CASES: readonly IfMatchCase[] = [
  { name: 'no header', header: undefined, expected: 'any' },
  { name: 'the wildcard', header: '*', expected: 'any' },
  { name: 'the wildcard beside a tag', header: '"1", *', expected: 'any' },
  { name: 'the wildcard beside a malformed tag', header: 'abc, *', expected: 'any' },
  { name: 'the wildcard in a repeated header', header: ['"1"', '*'], expected: 'any' },
  { name: 'a quoted row version', header: '"3"', expected: [3] },
  { name: 'a bare row version', header: '3', expected: [3] },
  { name: 'a weak tag', header: 'W/"3"', expected: [3] },
  { name: 'a weak tag in lower case', header: 'w/"3"', expected: [3] },
  { name: 'a weak bare row version', header: 'W/3', expected: [3] },
  { name: 'a list', header: '"1", "2"', expected: [1, 2] },
  { name: 'a list of mixed forms', header: '"1",W/"2" , 3', expected: [1, 2, 3] },
  { name: 'a list with an empty member', header: '"1",,"2"', expected: [1, 2] },
  { name: 'a list separated with tabs', header: '"1"\t,\t"2"', expected: [1, 2] },
  { name: 'a repeated header', header: ['"1"', '"2"'], expected: [1, 2] },
  { name: 'leading zeros', header: '"007"', expected: [7] },
  { name: 'zero', header: '"0"', expected: [0] },
  { name: 'nine digits', header: '"999999999"', expected: [999999999] },
  { name: 'ten digits', header: '"1234567890"', expected: 'invalid' },
  { name: 'an empty header', header: '', expected: 'invalid' },
  { name: 'only a comma', header: ',', expected: 'invalid' },
  { name: 'a word', header: 'abc', expected: 'invalid' },
  { name: 'a quoted word', header: '"abc"', expected: 'invalid' },
  { name: 'one malformed tag in a list', header: '"1", "abc"', expected: 'invalid' },
  { name: 'a decimal', header: '"1.0"', expected: 'invalid' },
  { name: 'a negative number', header: '"-1"', expected: 'invalid' },
  { name: 'a signed number', header: '"+1"', expected: 'invalid' },
  { name: 'an exponent', header: '1e3', expected: 'invalid' },
  { name: 'an unbalanced quote', header: '"1', expected: 'invalid' },
  { name: 'an empty tag', header: '""', expected: 'invalid' },
  { name: 'a space inside the quotes', header: '" 1 "', expected: 'invalid' },
  { name: 'single quotes', header: "'1'", expected: 'invalid' },
  { name: 'two tags without a comma', header: '"1" "2"', expected: 'invalid' },
  { name: 'a weak prefix alone', header: 'W/', expected: 'invalid' },
  { name: 'a quoted wildcard', header: '"*"', expected: 'invalid' },
  { name: 'a weak wildcard', header: 'W/*', expected: 'invalid' },
];
