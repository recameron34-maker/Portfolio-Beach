/**
 * Linking a staged row to an investment (docs/03 section 5): by investment number first, then an
 * exact canonical name or alias, never a fuzzy match. A near miss is reported with its candidates
 * for a person; a pair on the match guard list is never linked, whatever the similarity.
 */
export interface InvestmentDirectoryEntry {
  id: string;
  investmentNumber: string;
  companyName: string;
  canonicalName: string;
  aliases: readonly string[];
  dealType: string;
  entryDate: string;
  exitDate: string | null;
  isActive: boolean;
}

export interface MatchGuardPair {
  nameA: string;
  nameB: string;
}

export type LinkStatus = 'matched' | 'unmatched' | 'guarded' | 'ambiguous';

export interface LinkCandidate {
  investmentNumber: string;
  companyName: string;
  /** Why it is offered: 'near miss' or 'match guard'. */
  reason: 'near miss' | 'match guard';
}

export interface LinkResult {
  status: LinkStatus;
  /** How the link was made: 'number', 'name' or null when there is none. */
  by: 'number' | 'name' | null;
  investment: InvestmentDirectoryEntry | null;
  candidates: LinkCandidate[];
}

/** Lower case letters and digits only, so punctuation, case and spacing never decide a match. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Levenshtein distance, for near-miss candidates only (never for linking). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(
        Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Near miss: within two edits, or within 15% of the longer name, after normalization. */
export function isNearMiss(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (x === '' || y === '' || x === y) return false;
  const allowed = Math.max(2, Math.floor(Math.max(x.length, y.length) * 0.15));
  return editDistance(x, y) <= allowed;
}

function guarded(name: string, other: string, guards: readonly MatchGuardPair[]): boolean {
  const a = normalizeName(name);
  const b = normalizeName(other);
  return guards.some(
    (g) =>
      (normalizeName(g.nameA) === a && normalizeName(g.nameB) === b) ||
      (normalizeName(g.nameB) === a && normalizeName(g.nameA) === b),
  );
}

export function linkInvestment(
  row: { investmentNumber: string | null; companyName: string | null },
  directory: readonly InvestmentDirectoryEntry[],
  guards: readonly MatchGuardPair[],
): LinkResult {
  const number = row.investmentNumber?.trim().toUpperCase() ?? '';
  if (number !== '') {
    const byNumber = directory.find((d) => d.investmentNumber.toUpperCase() === number);
    if (byNumber !== undefined)
      return { status: 'matched', by: 'number', investment: byNumber, candidates: [] };
  }
  const name = row.companyName?.trim() ?? '';
  if (name === '') return { status: 'unmatched', by: null, investment: null, candidates: [] };
  const wanted = normalizeName(name);
  const exact = directory.filter(
    (d) =>
      normalizeName(d.canonicalName) === wanted ||
      normalizeName(d.companyName) === wanted ||
      d.aliases.some((a) => normalizeName(a) === wanted),
  );
  if (exact.length === 1) {
    const [investment] = exact;
    return { status: 'matched', by: 'name', investment: investment ?? null, candidates: [] };
  }
  if (exact.length > 1)
    return {
      status: 'ambiguous',
      by: null,
      investment: null,
      candidates: exact.map((d) => ({
        investmentNumber: d.investmentNumber,
        companyName: d.companyName,
        reason: 'near miss',
      })),
    };
  const candidates: LinkCandidate[] = [];
  let anyGuarded = false;
  for (const d of directory) {
    const names = [d.companyName, d.canonicalName, ...d.aliases];
    if (names.some((n) => guarded(name, n, guards))) {
      anyGuarded = true;
      candidates.push({
        investmentNumber: d.investmentNumber,
        companyName: d.companyName,
        reason: 'match guard',
      });
    } else if (names.some((n) => isNearMiss(name, n))) {
      candidates.push({
        investmentNumber: d.investmentNumber,
        companyName: d.companyName,
        reason: 'near miss',
      });
    }
  }
  return { status: anyGuarded ? 'guarded' : 'unmatched', by: null, investment: null, candidates };
}
