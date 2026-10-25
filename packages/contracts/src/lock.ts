/**
 * The text a valuation lock hash covers (docs/18 section 1, SEC-9.3). The API hashes it with
 * node:crypto and the static preview with SubtleCrypto, both SHA-256 as lowercase hex, so a lock
 * computed on one side verifies on the other. The text is canonical JSON: keys sorted, no spaces,
 * values JSON-encoded, so the same inputs always give the same bytes whatever built them.
 */

/** A flat record of the primitive values a canonical text is built from. */
export type CanonicalRecord = Readonly<Record<string, string | number>>;

/** JSON with sorted keys and no spaces, so the same inputs always hash the same. */
export function canonicalJson(value: CanonicalRecord): string {
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(value[k])}`)
    .join(',')}}`;
}

/** What the lock hash covers: the version's identity, its inputs and its value. */
export interface ValuationLockInputs {
  investmentId: string;
  periodEnd: string;
  version: number;
  method: string;
  fairValue: string;
}

/**
 * The exact text the lock hash is computed over. Only these five fields take part: a row with
 * more fields (a ValuationRow) can be passed as it is, and the rest is ignored.
 */
export function valuationLockText(inputs: ValuationLockInputs): string {
  const { investmentId, periodEnd, version, method, fairValue } = inputs;
  return canonicalJson({ investmentId, periodEnd, version, method, fairValue });
}
