/**
 * The limits one read works to. They stop a hostile file from running the parser forever or
 * filling memory; a caller passes its own from configuration (rule 9).
 */
export interface ReadLimits {
  /** The most bytes a file may hold; checked before anything is parsed. */
  maxBytes: number;
  /** The most objects a file may declare (cross-reference entries, objects found by the fallback scan, objects parsed). */
  maxObjects: number;
  /** The most pages the page tree may hold. */
  maxPages: number;
  /** The most bytes one stream may hold once decoded (the inflater is capped there too). */
  maxStreamBytes: number;
  /** The most bytes every stream one read decodes may hold together. */
  maxTotalStreamBytes: number;
  /** The most content stream operators one read interprets, across every page and form. */
  maxOperators: number;
  /** The deepest nesting accepted: arrays and dictionaries, the page tree, and forms inside forms. */
  maxDepth: number;
}

/** The defaults (decision 0012). */
export const READ_LIMITS: Readonly<ReadLimits> = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxObjects: 100_000,
  maxPages: 500,
  maxStreamBytes: 16 * 1024 * 1024,
  maxTotalStreamBytes: 64 * 1024 * 1024,
  maxOperators: 2_000_000,
  maxDepth: 64,
});

export function resolveLimits(given: Partial<ReadLimits> | undefined): ReadLimits {
  return {
    maxBytes: given?.maxBytes ?? READ_LIMITS.maxBytes,
    maxObjects: given?.maxObjects ?? READ_LIMITS.maxObjects,
    maxPages: given?.maxPages ?? READ_LIMITS.maxPages,
    maxStreamBytes: given?.maxStreamBytes ?? READ_LIMITS.maxStreamBytes,
    maxTotalStreamBytes: given?.maxTotalStreamBytes ?? READ_LIMITS.maxTotalStreamBytes,
    maxOperators: given?.maxOperators ?? READ_LIMITS.maxOperators,
    maxDepth: given?.maxDepth ?? READ_LIMITS.maxDepth,
  };
}
