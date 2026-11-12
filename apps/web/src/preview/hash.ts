/**
 * SHA-256 over text or bytes for the simulation (lock hashes, intake content hashes, workbook
 * template signatures), through SubtleCrypto. Browsers offer it only in secure contexts (https or
 * localhost); a route that needs it answers 503 elsewhere rather than inventing a hash.
 */
export function subtleCrypto(): SubtleCrypto | undefined {
  return (globalThis.crypto as Crypto | undefined)?.subtle;
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const subtle = subtleCrypto();
  if (subtle === undefined) throw new Error('SHA-256 is not available in this context');
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
