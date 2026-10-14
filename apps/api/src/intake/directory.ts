import { eq } from 'drizzle-orm';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import type { InvestmentDirectoryEntry, MatchGuardPair } from '@pb/validation';

/*
 * The investment directory every intake links against (docs/03 section 5): each investment with
 * its company's name, canonical name and aliases (core.company_alias, migration 0010), and the
 * match guard pairs. Read as the system actor so the whole book is there (decision 0009); the
 * caller's own row-level security applies to what it is shown afterwards.
 */

/** Every investment with its company's names and aliases. */
export async function investmentDirectory(tx: Tx): Promise<InvestmentDirectoryEntry[]> {
  const rows = await tx
    .select({
      id: schema.investment.id,
      investmentNumber: schema.investment.investmentNumber,
      companyId: schema.portfolioCompany.id,
      companyName: schema.portfolioCompany.name,
      canonicalName: schema.portfolioCompany.canonicalName,
      dealType: schema.investment.dealType,
      entryDate: schema.investment.entryDate,
      exitDate: schema.investment.exitDate,
      isActive: schema.investment.isActive,
    })
    .from(schema.investment)
    .innerJoin(
      schema.portfolioCompany,
      eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
    );
  const aliasRows = await tx
    .select({
      portfolioCompanyId: schema.companyAlias.portfolioCompanyId,
      alias: schema.companyAlias.alias,
    })
    .from(schema.companyAlias);
  const aliases = new Map<string, string[]>();
  for (const a of aliasRows) {
    const list = aliases.get(a.portfolioCompanyId) ?? [];
    list.push(a.alias);
    aliases.set(a.portfolioCompanyId, list);
  }
  return rows.map(({ companyId, ...r }) => ({ ...r, aliases: aliases.get(companyId) ?? [] }));
}

/** The match guard pairs: names that must never link to each other automatically. */
export function matchGuards(tx: Tx): Promise<MatchGuardPair[]> {
  return tx
    .select({ nameA: schema.matchGuard.nameA, nameB: schema.matchGuard.nameB })
    .from(schema.matchGuard);
}
