import type { SyntheticDataset } from '@pb/db';
import { isNearMiss, normalizeName } from '@pb/validation';
import type { Rng } from './prng.js';

/** A name a portfolio company is also known by (core.company_alias, docs/03 section 5). */
export interface CompanyAlias {
  id: string;
  portfolioCompanyId: string;
  alias: string;
}

/**
 * A dataset that may carry company aliases: the generator's output always does, and a dataset
 * parsed by a seed schema from before the alias table still reads (the array is simply absent).
 */
export type AliasedDataset = SyntheticDataset & { companyAliases?: readonly CompanyAlias[] };

export interface AliasSource {
  id: string;
  name: string;
}

export interface AliasGuard {
  nameA: string;
  nameB: string;
}

/** The share of companies that get an alias, and the most one company gets. */
export const ALIAS_SHARE = 1 / 3;
export const ALIASES_PER_COMPANY_MAX = 2;

/** The name without its last word ("Meridian Data Partners" reads "Meridian Data"). */
export function shortenedForm(name: string): string | null {
  const words = name.trim().split(/\s+/);
  return words.length < 2 ? null : words.slice(0, -1).join(' ');
}

/** The initials of every word, upper case ("Meridian Data Partners" reads "MDP"). */
export function abbreviatedForm(name: string): string | null {
  const words = name.trim().split(/\s+/);
  if (words.length < 2) return null;
  return words.map((w) => (w[0] ?? '').toUpperCase()).join('');
}

/**
 * Aliases for about a third of the companies, one or two each, as the names an outside file is
 * likely to use: a shortened form or an abbreviation. An alias links by exact match only
 * (docs/03 section 5), so no alias may equal another name on record, and no alias may be a near
 * miss of one by the validation library's own rule, or a row carrying it would read as a
 * candidate for a person instead of a link; a company on the match guard list gets none at all.
 * Ids and choices come from the rng given, so a caller with its own stream moves no other value.
 * `always` names companies that get an alias whatever the draw, when a valid form exists.
 */
export function companyAliasesFor(
  companies: readonly AliasSource[],
  guards: readonly AliasGuard[],
  rng: Rng,
  always: ReadonlySet<string> = new Set(),
): CompanyAlias[] {
  const guarded = new Set(guards.flatMap((g) => [normalizeName(g.nameA), normalizeName(g.nameB)]));
  // Every name an alias must stay clear of: company names, guard names and the aliases so far.
  const taken: string[] = [
    ...companies.map((c) => c.name),
    ...guards.flatMap((g) => [g.nameA, g.nameB]),
  ];
  const clear = (candidate: string): boolean => {
    const wanted = normalizeName(candidate);
    if (wanted === '') return false;
    return taken.every((t) => normalizeName(t) !== wanted && !isNearMiss(candidate, t));
  };
  const out: CompanyAlias[] = [];
  for (const company of companies) {
    const chosen = always.has(company.id) || rng.chance(ALIAS_SHARE);
    if (!chosen || guarded.has(normalizeName(company.name))) continue;
    const count = rng.int(1, ALIASES_PER_COMPANY_MAX);
    const forms = [shortenedForm(company.name), abbreviatedForm(company.name)];
    let added = 0;
    for (const form of forms) {
      if (added === count || form === null || !clear(form)) continue;
      out.push({ id: rng.uuid(), portfolioCompanyId: company.id, alias: form });
      taken.push(form);
      added++;
    }
  }
  return out;
}

/** The aliases of one company in dataset order, none when the dataset carries no alias table. */
export function aliasesOf(dataset: AliasedDataset, portfolioCompanyId: string): string[] {
  return (dataset.companyAliases ?? [])
    .filter((a) => a.portfolioCompanyId === portfolioCompanyId)
    .map((a) => a.alias);
}
