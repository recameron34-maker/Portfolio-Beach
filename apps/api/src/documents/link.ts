import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { isNearMiss, linkInvestment, normalizeName } from '@pb/validation';
import type { InvestmentDirectoryEntry, MatchGuardPair } from '@pb/validation';
import { investmentDirectory, matchGuards } from '../intake/directory.js';

/*
 * How a document is linked to the book (docs/03 section 5, docs/04 M3): the investment by its
 * number when the classifier read one, else by the exact company name or alias the file name
 * carries, through the one linker every intake uses (@pb/validation linkInvestment: exact after
 * normalization, never fuzzy); the sponsor fund by its exact name, canonical name or alias
 * (core.fund_alias). Anything that nearly matches is offered as a candidate by reason only, so
 * the evidence stored on the document never names a position the reader may not see (SEC-5.3).
 * The directory is read as the system actor, so a walled position links rather than reading as
 * "no match" (decision 0009); the caller's own row-level security decides what they are shown.
 */

export interface FundDirectoryEntry {
  id: string;
  sponsorId: string;
  name: string;
  canonicalName: string;
  aliases: string[];
}

/** Every investment with its names and aliases, plus the sponsor and fund it belongs to, and every sponsor fund with its aliases. */
export interface DocumentDirectory {
  investments: InvestmentDirectoryEntry[];
  /** sponsorId and sponsorFundId by investment id (the intake directory carries neither). */
  parents: Map<string, { sponsorId: string; sponsorFundId: string | null }>;
  funds: FundDirectoryEntry[];
  guards: MatchGuardPair[];
}

export async function documentDirectory(tx: Tx): Promise<DocumentDirectory> {
  const investments = await investmentDirectory(tx);
  const guards = await matchGuards(tx);
  const parentRows = await tx
    .select({
      id: schema.investment.id,
      sponsorId: schema.investment.sponsorId,
      sponsorFundId: schema.investment.sponsorFundId,
    })
    .from(schema.investment);
  const parents = new Map(
    parentRows.map((r) => [r.id, { sponsorId: r.sponsorId, sponsorFundId: r.sponsorFundId }]),
  );
  const fundRows = await tx
    .select({
      id: schema.sponsorFund.id,
      sponsorId: schema.sponsorFund.sponsorId,
      name: schema.sponsorFund.name,
      canonicalName: schema.sponsorFund.canonicalName,
    })
    .from(schema.sponsorFund);
  const aliasRows = await tx
    .select({ sponsorFundId: schema.fundAlias.sponsorFundId, alias: schema.fundAlias.alias })
    .from(schema.fundAlias);
  const aliases = new Map<string, string[]>();
  for (const a of aliasRows) {
    const list = aliases.get(a.sponsorFundId) ?? [];
    list.push(a.alias);
    aliases.set(a.sponsorFundId, list);
  }
  return {
    investments,
    parents,
    funds: fundRows.map((f) => ({ ...f, aliases: aliases.get(f.id) ?? [] })),
    guards,
  };
}

/** What the classifier and the file name said about where a document belongs. */
export interface LinkHints {
  investmentNumber: string | null;
  companyName: string | null;
  sponsorFundName: string | null;
}

/** The links a classification sets on the document, and the candidates it offers by reason only. */
export interface DocumentLinks {
  investmentId: string | null;
  sponsorFundId: string | null;
  sponsorId: string | null;
  candidates: { reason: string }[];
}

/** The fund named, matched exactly (after normalization) on its name, canonical name or an alias. */
function linkFund(
  name: string | null,
  funds: readonly FundDirectoryEntry[],
): { fund: FundDirectoryEntry | null; candidates: { reason: string }[] } {
  const wanted = name === null ? '' : normalizeName(name);
  if (wanted === '') return { fund: null, candidates: [] };
  const exact = funds.filter(
    (f) =>
      normalizeName(f.name) === wanted ||
      normalizeName(f.canonicalName) === wanted ||
      f.aliases.some((a) => normalizeName(a) === wanted),
  );
  if (exact.length === 1) return { fund: exact[0] ?? null, candidates: [] };
  if (exact.length > 1)
    return {
      fund: null,
      candidates: exact.map(() => ({ reason: 'several sponsor funds carry the name given' })),
    };
  const near = funds.filter((f) =>
    [f.name, f.canonicalName, ...f.aliases].some((n) => isNearMiss(name ?? '', n)),
  );
  return {
    fund: null,
    candidates: near.map(() => ({
      reason: 'a sponsor fund on record nearly matches the name given',
    })),
  };
}

/**
 * Links a document from its hints. The investment decides the sponsor and the fund when it links
 * (the position on record is the fact); a fund named that differs from the position's own fund is
 * left as a candidate by reason. Without an investment, the fund named sets the fund and sponsor.
 */
export function linkDocument(hints: LinkHints, directory: DocumentDirectory): DocumentLinks {
  const link = linkInvestment(
    { investmentNumber: hints.investmentNumber, companyName: hints.companyName },
    directory.investments,
    directory.guards,
  );
  const candidates: { reason: string }[] = link.candidates.map((c) => ({
    reason: c.reason === 'match guard' ? 'a match guard blocks a name on record' : 'a near miss',
  }));
  const fund = linkFund(hints.sponsorFundName, directory.funds);
  candidates.push(...fund.candidates);
  if (link.investment !== null) {
    const parents = directory.parents.get(link.investment.id);
    const sponsorFundId = parents?.sponsorFundId ?? fund.fund?.id ?? null;
    if (
      fund.fund !== null &&
      parents?.sponsorFundId !== undefined &&
      parents.sponsorFundId !== null &&
      fund.fund.id !== parents.sponsorFundId
    )
      candidates.push({ reason: 'the fund named differs from the fund of the position on record' });
    return {
      investmentId: link.investment.id,
      sponsorFundId,
      sponsorId: parents?.sponsorId ?? fund.fund?.sponsorId ?? null,
      candidates,
    };
  }
  return {
    investmentId: null,
    sponsorFundId: fund.fund?.id ?? null,
    sponsorId: fund.fund?.sponsorId ?? null,
    candidates,
  };
}
