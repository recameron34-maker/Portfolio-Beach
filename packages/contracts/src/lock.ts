/**
 * The text a valuation lock hash covers (docs/18 section 1, SEC-9.3): the version's identity,
 * its method, its method inputs and its value. The API hashes it with node:crypto and the static
 * preview with SubtleCrypto, both SHA-256 as lowercase hex, so a lock computed on one side
 * verifies on the other. The text is canonical JSON: keys sorted at every depth, no spaces,
 * values JSON-encoded, so the same content always gives the same bytes whatever built it and
 * whatever order a store (a jsonb column orders keys by length first) hands it back in.
 */

/**
 * JSON with sorted keys at every depth and no spaces, so the same content always hashes the
 * same. Keys sort by UTF-16 code unit (the default of Array.prototype.sort, the same in Node and
 * in a browser); a list keeps its order, since that is content. The value must be what JSON can
 * carry (text, a finite number, a boolean, null, a list, a plain record): anything else, an
 * undefined entry included, is a TypeError, so nothing ambiguous ever takes part in a hash.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: a number must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${(value as readonly unknown[]).map((item) => canonicalJson(item)).join(',')}]`;
  // A plain record from any realm (a parsed body, a jsonb column); a Date or a Map is not one.
  if (typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonicalJson: ${typeof value} is not a JSON value`);
}

/** What the lock hash covers: the version's identity, its method, its inputs and its value. */
export interface ValuationLockInputs {
  investmentId: string;
  periodEnd: string;
  version: number;
  method: string;
  fairValue: string;
  /**
   * The method inputs as stored (mon.valuation.inputs): any JSON value, a record of names to
   * numbers or text when the API wrote it. Absent or null means none, an empty record in the
   * text. A board row (ValuationRow) does not carry them, so a caller holding only the row
   * passes the version's inputs beside it; without them the text is that of a version with none.
   */
  inputs?: unknown;
}

/**
 * The exact text the lock hash is computed over. Only these six fields take part: a row with
 * more fields (a ValuationRow with its inputs beside it) can be passed as it is, and the rest is
 * ignored.
 */
export function valuationLockText(version: ValuationLockInputs): string {
  const { investmentId, periodEnd, method, fairValue } = version;
  return canonicalJson({
    investmentId,
    periodEnd,
    version: version.version,
    method,
    inputs: version.inputs ?? {},
    fairValue,
  });
}
