/**
 * SHA-256 over text for the simulation (lock hashes, intake content hashes), through SubtleCrypto.
 * Browsers offer it only in secure contexts (https or localhost); a route that needs it answers
 * 503 elsewhere rather than inventing a hash.
 */
export function subtleCrypto(): SubtleCrypto | undefined {
  return (globalThis.crypto as Crypto | undefined)?.subtle;
}

export async function sha256Hex(text: string): Promise<string> {
  const subtle = subtleCrypto();
  if (subtle === undefined) throw new Error('SHA-256 is not available in this context');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
