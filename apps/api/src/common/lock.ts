import { createHash } from 'node:crypto';
import { valuationLockText } from '@pb/contracts';
import type { ValuationLockInputs } from '@pb/contracts';

/*
 * The valuation lock hash (docs/18 section 1, SEC-9.3): SHA-256, lowercase hex, over the exact
 * text @pb/contracts fixes (valuationLockText: the version's identity, its method, its method
 * inputs and its value as canonical JSON, keys sorted at every depth). The static preview hashes
 * the same text with SubtleCrypto, so a lock computed on either side verifies on the other; the
 * digests, with and without inputs, are pinned in packages/contracts/src/controls.test.ts and
 * reproduced in apps/api/src/test/valuations.test.ts. The synthetic generator seeds every Locked
 * and Reopened version with this hash too (tools/synthetic), so a seeded lock verifies as well.
 */

/**
 * The lock hash of a version: sha256(valuationLockText(version)) as 64 lowercase hex characters.
 * The version is passed with its stored inputs (mon.valuation.inputs); a board row does not
 * carry them.
 */
export function valuationLockHash(version: ValuationLockInputs): string {
  return createHash('sha256').update(valuationLockText(version), 'utf8').digest('hex');
}
