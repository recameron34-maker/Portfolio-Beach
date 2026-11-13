import { asc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { underwritingKindOf } from '@pb/contracts';
import type { UnderwritingCaseVersion, UnderwritingPoint } from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';

/*
 * The versions of a position's underwritten base case as they are read (docs/04 M9, decision
 * 0022). Row-level security decides what the transaction sees: a case follows its position, so a
 * caller who cannot open the position finds no version of it. The source document is joined under
 * the same security, so it is named only to a reader who can open it.
 */

const kase = schema.underwritingCase;
const point = schema.underwritingCasePoint;
const enterer = alias(schema.appUser, 'underwriting_enterer');
const confirmer = alias(schema.appUser, 'underwriting_confirmer');

/** Every version of a position's base case, oldest first, each with its plan points in date order. */
export async function loadVersions(
  tx: Tx,
  investmentId: string,
): Promise<UnderwritingCaseVersion[]> {
  const rows = await tx
    .select({
      record: kase,
      enteredByName: enterer.displayName,
      confirmedByName: confirmer.displayName,
      documentId: schema.document.id,
      documentTitle: schema.document.title,
    })
    .from(kase)
    .innerJoin(enterer, eq(enterer.id, kase.enteredBy))
    .leftJoin(confirmer, eq(confirmer.id, kase.confirmedBy))
    .leftJoin(schema.document, eq(schema.document.id, kase.sourceDocumentId))
    .where(eq(kase.investmentId, investmentId))
    .orderBy(asc(kase.version));
  if (rows.length === 0) return [];

  const points = new Map<string, UnderwritingPoint[]>();
  const pointRows = await tx
    .select({
      caseId: point.caseId,
      periodEnd: point.periodEnd,
      revenueLtm: point.revenueLtm,
      ebitdaLtm: point.ebitdaLtm,
      netDebt: point.netDebt,
    })
    .from(point)
    .where(
      inArray(
        point.caseId,
        rows.map((r) => r.record.id),
      ),
    )
    .orderBy(asc(point.periodEnd));
  for (const { caseId, ...figures } of pointRows) {
    const list = points.get(caseId);
    if (list === undefined) points.set(caseId, [figures]);
    else list.push(figures);
  }

  const refs = rows.map(({ record }) => ({
    version: record.version,
    state: record.state,
    caseDate: record.caseDate,
  }));
  return rows.map(({ record, enteredByName, confirmedByName, documentId, documentTitle }, i) => ({
    id: record.id,
    investmentId: record.investmentId,
    version: record.version,
    // The column holds 'equity' or 'credit' and nothing else (a check constraint of migration 0021).
    form: record.form === 'credit' ? 'credit' : 'equity',
    state: record.state,
    kind: underwritingKindOf(refs[i]!, refs),
    caseDate: record.caseDate,
    plannedExitDate: record.plannedExitDate,
    exitMultiple: record.exitMultiple,
    grossMoic: record.grossMoic,
    grossIrr: record.grossIrr,
    underwrittenYield: record.underwrittenYield,
    annualLossRate: record.annualLossRate,
    currency: record.currency,
    note: record.note,
    revisionReason: record.revisionReason,
    withdrawnReason: record.withdrawnReason,
    source: {
      document:
        documentId === null || documentTitle === null
          ? null
          : { id: documentId, name: documentTitle },
      page: record.sourcePage,
      locator: record.sourceLocator,
      note: record.sourceNote,
    },
    enteredBy: { id: record.enteredBy, name: enteredByName },
    enteredAt: record.enteredAt.toISOString(),
    confirmedBy:
      record.confirmedBy === null ? null : { id: record.confirmedBy, name: confirmedByName ?? '' },
    confirmedAt: record.confirmedAt === null ? null : record.confirmedAt.toISOString(),
    points: points.get(record.id) ?? [],
    rowVersion: record.rowVersion,
  }));
}
