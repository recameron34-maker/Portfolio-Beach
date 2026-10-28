import { createHash } from 'node:crypto';
import { valuationLockText } from '@pb/contracts';
import type { ValuationLockInputs } from '@pb/contracts';

/*
 * The valuation lock hash (docs/18 section 1, SEC-9.3): SHA-256, lowercase hex, over the exact
 * text @pb/contracts fixes (valuationLockText: the version's identity, its method and its value
 * as canonical JSON). The static preview hashes the same text with SubtleCrypto, so a lock
 * computed on either side verifies on the other; the digest is pinned in
 * packages/contracts/src/controls.test.ts and reproduced in apps/api/src/test/valuations.test.ts.
 */

/** The lock hash of a version: sha256(valuationLockText(inputs)) as 64 lowercase hex characters. */
export function valuationLockHash(inputs: ValuationLockInputs): string {
  return createHash('sha256').update(valuationLockText(inputs), 'utf8').digest('hex');
}
