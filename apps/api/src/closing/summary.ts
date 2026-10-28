import { asc, eq } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { closingItemStatus, closingState, legalTermStatus, legalTermValue } from '@pb/contracts';
import type {
  AllocationRow,
  ClosingChecklist,
  ClosingItem,
  ClosingState,
  ClosingSummary,
  LegalTerm,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { ProblemError } from '../common/problem.js';
import { allocationsOf, loadAllocationRows, tieOut } from '../pipeline/allocations.js';
import { person } from '../pipeline/rows.js';

/*
 * The closing record as the API reads it (docs/04 M8, docs/18 section 12, migration 0013): the
 * close date (the single source of every close date), the commitment, the checklist in the order
 * config/closing_checklist.json lists it, the allocation lines and their tie-out, and the legal
 * terms (M22). The pipeline's opportunity detail and the closing detail share these readers so
 * the gates both show are computed from the same rows the machine sees. Every read runs under
 * the caller's row-level security: the closing follows its opportunity's wall.
 */

export const CLOSING_NOT_FOUND = 'Closing not found';
export const CLOSING_ENTITY = 'deal.closing';

const closing = schema.closing;
const item = schema.closingItem;
const term = schema.legalTerm;
const confirmer = alias(schema.appUser, 'confirmer');
const termConfirmer = alias(schema.appUser, 'term_confirmer');

export interface LoadedClosing {
  id: string;
  opportunityId: string | null;
  investmentId: string | null;
  closeDate: string;
  commitmentAmount: string;
  currency: string;
  state: string;
  opsConfirmedById: string | null;
  opsConfirmedByName: string | null;
  opsConfirmedAt: Date | null;
  reopenReason: string | null;
  rowVersion: number;
}

/** The closing with its items, lines, terms and the summary the opportunity shows. */
export interface ClosingView {
  closing: LoadedClosing;
  items: ClosingItem[];
  allocations: AllocationRow[];
  legalTerms: LegalTerm[];
  summary: ClosingSummary;
}

/** The stored state as the machine knows it; anything else is a record the API cannot work. */
export function closingStateOf(value: string): ClosingState {
  const parsed = closingState.safeParse(value);
  if (!parsed.success)
    throw new ProblemError(500, 'internal', 'closing: the stored state is not one the API knows');
  return parsed.data;
}

export async function loadClosing(tx: Tx, where: SQL): Promise<LoadedClosing | null> {
  const row = (
    await tx
      .select({
        id: closing.id,
        opportunityId: closing.opportunityId,
        investmentId: closing.investmentId,
        closeDate: closing.closeDate,
        commitmentAmount: closing.commitmentAmount,
        currency: closing.currency,
        state: closing.state,
        opsConfirmedById: closing.opsConfirmedBy,
        opsConfirmedByName: confirmer.displayName,
        opsConfirmedAt: closing.opsConfirmedAt,
        reopenReason: closing.reopenReason,
        rowVersion: closing.rowVersion,
      })
      .from(closing)
      .leftJoin(confirmer, eq(confirmer.id, closing.opsConfirmedBy))
      .where(where)
      .limit(1)
  )[0];
  return row ?? null;
}

/** The checklist items in config order (codes the config no longer lists come last, by code). */
export async function loadClosingItems(
  tx: Tx,
  closingId: string,
  checklist: ClosingChecklist,
): Promise<ClosingItem[]> {
  const order = new Map(checklist.items.map((i, index) => [i.code, index]));
  const rows = await tx
    .select({
      id: item.id,
      itemCode: item.itemCode,
      label: item.label,
      required: item.required,
      documentId: item.documentId,
      status: item.status,
      waivedReason: item.waivedReason,
    })
    .from(item)
    .where(eq(item.closingId, closingId))
    .orderBy(asc(item.itemCode));
  const rank = (code: string): number => order.get(code) ?? checklist.items.length;
  return rows
    .sort((a, b) => rank(a.itemCode) - rank(b.itemCode) || (a.itemCode < b.itemCode ? -1 : 1))
    .map((r) => ({
      id: r.id,
      itemCode: r.itemCode,
      label: r.label,
      required: r.required,
      documentId: r.documentId,
      status: closingItemStatus.parse(r.status),
      waivedReason: r.waivedReason,
    }));
}

export async function loadLegalTerms(tx: Tx, closingId: string): Promise<LegalTerm[]> {
  const rows = await tx
    .select({
      id: term.id,
      termType: term.termType,
      value: term.value,
      sourceDocumentId: term.sourceDocumentId,
      status: term.status,
      confirmedById: term.confirmedBy,
      confirmedByName: termConfirmer.displayName,
    })
    .from(term)
    .leftJoin(termConfirmer, eq(termConfirmer.id, term.confirmedBy))
    .where(eq(term.closingId, closingId))
    .orderBy(asc(term.createdAt), asc(term.id));
  return rows.map((r) => ({
    id: r.id,
    termType: r.termType,
    value: legalTermValue.parse(r.value),
    sourceDocumentId: r.sourceDocumentId,
    status: legalTermStatus.parse(r.status),
    confirmedBy: person(r.confirmedById, r.confirmedByName),
  }));
}

/** The M8 gate: every required item received or waived. */
export const requiredItemsComplete = (items: readonly ClosingItem[]): boolean =>
  items.every((i) => !i.required || i.status !== 'open');

export function closingSummaryOf(
  row: LoadedClosing,
  items: readonly ClosingItem[],
  allocations: readonly AllocationRow[],
): ClosingSummary {
  return {
    id: row.id,
    closeDate: row.closeDate,
    commitmentAmount: row.commitmentAmount,
    currency: row.currency,
    state: closingStateOf(row.state),
    opsConfirmedBy: person(row.opsConfirmedById, row.opsConfirmedByName),
    opsConfirmedAt: row.opsConfirmedAt === null ? null : row.opsConfirmedAt.toISOString(),
    itemsOpen: items.filter((i) => i.status === 'open').length,
    itemsRequiredOpen: items.filter((i) => i.required && i.status === 'open').length,
    allocationTieOut: tieOut(row.commitmentAmount, allocations),
  };
}

/** The closing and everything the detail and the gates read, or null when the caller cannot see it. */
export async function loadClosingView(
  tx: Tx,
  where: SQL,
  checklist: ClosingChecklist,
): Promise<ClosingView | null> {
  const row = await loadClosing(tx, where);
  if (row === null) return null;
  // One statement at a time on the transaction's connection, as every service does.
  const items = await loadClosingItems(tx, row.id, checklist);
  const allocations = await loadAllocationRows(
    tx,
    allocationsOf(row.opportunityId, row.investmentId),
  );
  const legalTerms = await loadLegalTerms(tx, row.id);
  return {
    closing: row,
    items,
    allocations,
    legalTerms,
    summary: closingSummaryOf(row, items, allocations),
  };
}
