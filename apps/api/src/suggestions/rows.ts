import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  suggestionBasis,
  suggestionReason,
  suggestionSupersededReason,
  valuationState,
  valuationSuggestionState,
} from '@pb/contracts';
import type { ValuationSuggestionRow } from '@pb/contracts';
import { SYSTEM_USER_ID, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { SUGGESTION_SOURCE_KINDS, suggestionReading } from '@pb/workflows';
import type {
  PriorSuggestion,
  StoredSuggestion,
  SuggestionSettings,
  ValuationState,
  WorkingInput,
} from '@pb/workflows';
import { z } from 'zod';
import { EXACT_AT_FORMAT } from '../common/cursor.js';
import { ProblemError } from '../common/problem.js';
import { gatherSources, quarterVersions } from './sources.js';
import type { Gathered } from './sources.js';
import type { SuggestionSchemas } from './settings.js';

/*
 * How a valuation suggestion is read (docs/04 M10, docs/18 section 14, decision 0023): one
 * select with the names its ids carry, under the caller's own row-level security (migration
 * 0023: a suggestion carries its position's wall, and only the roles that work on valuations
 * read one), and the row a reader is shown, with everything that is derived when read: the mark
 * on record, the comparison, the checks of its statement, the other sources and the badges
 * (suggestionReading of @pb/workflows, the function the static preview uses too).
 */

export const SUGGESTION_NOT_FOUND = 'Valuation suggestion not found';
export const SUGGESTION_ENTITY = 'mon.valuation_suggestion';

export const suggestion = schema.valuationSuggestion;
const decider = alias(schema.appUser, 'suggestion_decider');
const sourceDocument = alias(schema.document, 'suggestion_source_document');

/** The valuation states in which a version is still on its way to Locked: one chain per position and quarter. */
const IN_FLIGHT: readonly string[] = ['Draft', 'OpsPrepared', 'DealTeamApproved'];

/** A suggestion as the select reads it, before anything is derived. */
export interface LoadedSuggestion {
  id: string;
  investmentId: string;
  investmentNumber: string;
  companyName: string;
  vehicleName: string;
  dealType: string;
  periodEnd: string;
  basis: string;
  method: string;
  suggestedValue: string | null;
  reasonCode: string | null;
  workings: unknown;
  sourceDocumentId: string;
  sourceFileName: string | null;
  extractionRunId: string;
  sourcePage: number | null;
  sourceLocator: string | null;
  sourceReviewerIds: string[];
  promptVersion: string | null;
  modelId: string | null;
  calcVersion: string;
  state: string;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  valuationId: string | null;
  supersededReason: string | null;
  supersededById: string | null;
  createdAt: Date;
  rowVersion: number;
  /** created_at to the microsecond, the exact value a page cursor carries (common/cursor.ts). */
  exactAt: string;
}

/** The select every read shares; the readers add their where, order and limit. */
function selectSuggestions(tx: Tx) {
  return tx
    .select({
      id: suggestion.id,
      investmentId: suggestion.investmentId,
      investmentNumber: schema.investment.investmentNumber,
      companyName: schema.portfolioCompany.name,
      vehicleName: schema.vehicle.name,
      dealType: schema.investment.dealType,
      periodEnd: suggestion.periodEnd,
      basis: suggestion.basis,
      method: suggestion.method,
      suggestedValue: suggestion.suggestedValue,
      reasonCode: suggestion.reasonCode,
      workings: suggestion.workings,
      sourceDocumentId: suggestion.sourceDocumentId,
      sourceFileName: sourceDocument.fileName,
      extractionRunId: suggestion.extractionRunId,
      sourcePage: suggestion.sourcePage,
      sourceLocator: suggestion.sourceLocator,
      sourceReviewerIds: suggestion.sourceReviewerIds,
      promptVersion: suggestion.promptVersion,
      modelId: suggestion.modelId,
      calcVersion: suggestion.calcVersion,
      state: suggestion.state,
      decidedBy: suggestion.decidedBy,
      decidedByName: decider.displayName,
      decidedAt: suggestion.decidedAt,
      decisionReason: suggestion.decisionReason,
      valuationId: suggestion.valuationId,
      supersededReason: suggestion.supersededReason,
      supersededById: suggestion.supersededById,
      createdAt: suggestion.createdAt,
      rowVersion: suggestion.rowVersion,
      exactAt: sql<string>`to_char(${suggestion.createdAt} at time zone 'UTC', ${EXACT_AT_FORMAT})`,
    })
    .from(suggestion)
    .innerJoin(schema.investment, eq(schema.investment.id, suggestion.investmentId))
    .innerJoin(
      schema.portfolioCompany,
      eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
    )
    .innerJoin(schema.vehicle, eq(schema.vehicle.id, schema.investment.vehicleId))
    .leftJoin(decider, eq(decider.id, suggestion.decidedBy))
    .leftJoin(sourceDocument, eq(sourceDocument.id, suggestion.sourceDocumentId))
    .$dynamic();
}

/** One page, newest first on (createdAt, id); the caller asks for one row more than its page. */
export function pageSuggestions(
  tx: Tx,
  conditions: readonly (SQL | undefined)[],
  limit: number,
): Promise<LoadedSuggestion[]> {
  return selectSuggestions(tx)
    .where(and(...conditions))
    .orderBy(desc(suggestion.createdAt), desc(suggestion.id))
    .limit(limit);
}

/** One suggestion the transaction's identity can see, or null. */
export async function loadSuggestion(tx: Tx, id: string): Promise<LoadedSuggestion | null> {
  const [row] = await selectSuggestions(tx).where(eq(suggestion.id, id));
  return row ?? null;
}

const storedWorkings = z.object({
  inputs: z.array(
    z.object({
      key: z.string().min(1),
      value: z.string().min(1),
      periodEnd: z.string().min(1),
      source: z.object({
        kind: z.enum(SUGGESTION_SOURCE_KINDS),
        id: z.string().min(1),
        page: z.number().int().nullable(),
      }),
      edited: z.boolean(),
    }),
  ),
});

/** A stored row the API cannot read back is said so, never passed on half read. */
const unreadable = (what: string): ProblemError =>
  new ProblemError(500, 'internal', `valuation_suggestion: the stored ${what} cannot be read`);

/** The inputs a suggestion's rule read, as stored. */
export function inputsOf(workings: unknown): WorkingInput[] {
  const parsed = storedWorkings.safeParse(workings);
  if (!parsed.success) throw unreadable('workings');
  return parsed.data.inputs;
}

/** What a stored suggestion says: its basis, its value or the reason for none, and its inputs. */
export function storedOf(
  row: Pick<LoadedSuggestion, 'basis' | 'suggestedValue' | 'reasonCode' | 'workings'>,
): StoredSuggestion {
  const basis = suggestionBasis.safeParse(row.basis);
  const reason = suggestionReason.nullable().safeParse(row.reasonCode);
  if (!basis.success) throw unreadable('basis');
  if (!reason.success) throw unreadable('reason');
  return {
    basis: basis.data,
    value: row.suggestedValue,
    reason: reason.data,
    inputs: inputsOf(row.workings),
  };
}

/** The suggestions written before for a position and quarter, as the derivation reads them. */
export async function priorSuggestions(
  tx: Tx,
  investmentId: string,
  periodEnd: string,
): Promise<{
  open: (PriorSuggestion & { extractionRunId: string }) | null;
  decided: PriorSuggestion[];
}> {
  const rows = await tx
    .select({
      id: suggestion.id,
      state: suggestion.state,
      basis: suggestion.basis,
      suggestedValue: suggestion.suggestedValue,
      reasonCode: suggestion.reasonCode,
      workings: suggestion.workings,
      extractionRunId: suggestion.extractionRunId,
      valuationState: schema.valuation.state,
    })
    .from(suggestion)
    .leftJoin(schema.valuation, eq(schema.valuation.id, suggestion.valuationId))
    .where(and(eq(suggestion.investmentId, investmentId), eq(suggestion.periodEnd, periodEnd)));
  let open: (PriorSuggestion & { extractionRunId: string }) | null = null;
  const decided: PriorSuggestion[] = [];
  for (const row of rows) {
    const state = valuationSuggestionState.parse(row.state);
    if (state === 'Superseded') continue;
    const on = valuationState.nullable().safeParse(row.valuationState ?? null);
    const prior: PriorSuggestion & { extractionRunId: string } = {
      ...storedOf(row),
      id: row.id,
      state,
      valuationState: on.success ? (on.data satisfies ValuationState | null) : null,
      extractionRunId: row.extractionRunId,
    };
    if (state === 'Open') open = prior;
    else decided.push(prior);
  }
  return { open, decided };
}

/** The file names of the documents the inputs of some suggestions were read from, by document id. */
export async function inputFileNames(
  tx: Tx,
  rows: readonly Pick<LoadedSuggestion, 'workings'>[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      rows.flatMap((row) =>
        inputsOf(row.workings)
          .filter((input) => input.source.kind === 'document')
          .map((input) => input.source.id),
      ),
    ),
  ];
  if (ids.length === 0) return new Map();
  const found = await tx
    .select({ id: schema.document.id, fileName: schema.document.fileName })
    .from(schema.document)
    .where(inArray(schema.document.id, ids));
  return new Map(found.map((doc) => [doc.id, doc.fileName]));
}

/** What a read of one suggestion gathers: the sources of its quarter, with its own statement for a statement-based one. */
export function gatherFor(
  tx: Tx,
  row: Pick<LoadedSuggestion, 'investmentId' | 'periodEnd' | 'basis' | 'extractionRunId'>,
  settings: SuggestionSettings,
  schemas: SuggestionSchemas,
): Promise<Gathered> {
  return gatherSources(
    tx,
    {
      investmentId: row.investmentId,
      periodEnd: row.periodEnd,
      // A statement-based suggestion names the run its statement was read by.
      ...(row.basis === 'capital_account_balance' ? { statementRunId: row.extractionRunId } : {}),
    },
    settings,
    schemas,
  );
}

/** The contract row: the stored columns checked on the way out, and what is derived when read. */
export function toSuggestionRow(
  row: LoadedSuggestion,
  gathered: Gathered,
  settings: SuggestionSettings,
  fileNames: ReadonlyMap<string, string>,
): ValuationSuggestionRow {
  const stored = storedOf(row);
  const view = suggestionReading(stored, gathered.sources, settings);
  const inFlight = quarterVersions(
    gathered.versions,
    row.periodEnd,
    settings.periodEndToleranceDays,
  ).find((version) => IN_FLIGHT.includes(version.state));
  return {
    id: row.id,
    investmentId: row.investmentId,
    investmentNumber: row.investmentNumber,
    companyName: row.companyName,
    vehicleName: row.vehicleName,
    dealType: row.dealType,
    periodEnd: row.periodEnd,
    basis: stored.basis,
    method: row.method,
    suggestedValue: row.suggestedValue,
    reasonCode: stored.reason,
    workings: {
      inputs: stored.inputs.map((input) => ({
        ...input,
        source: {
          ...input.source,
          fileName:
            input.source.kind === 'document' ? (fileNames.get(input.source.id) ?? null) : null,
        },
      })),
    },
    source: {
      documentId: row.sourceDocumentId,
      fileName: row.sourceFileName,
      extractionRunId: row.extractionRunId,
      page: row.sourcePage,
      locator: row.sourceLocator,
    },
    sourceReviewerIds: row.sourceReviewerIds,
    promptVersion: row.promptVersion,
    modelId: row.modelId,
    calcVersion: row.calcVersion,
    state: valuationSuggestionState.parse(row.state),
    // A person accepted or dismissed it. The system actor superseded it: nobody to name.
    decidedBy:
      row.decidedBy === null || row.decidedByName === null || row.decidedBy === SYSTEM_USER_ID
        ? null
        : { id: row.decidedBy, name: row.decidedByName },
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
    decisionReason: row.decisionReason,
    valuationId: row.valuationId,
    supersededReason: suggestionSupersededReason.nullable().parse(row.supersededReason),
    supersededById: row.supersededById,
    createdAt: row.createdAt.toISOString(),
    rowVersion: row.rowVersion,
    currentMark: view.currentMark,
    comparison: view.comparison,
    checks: view.checks,
    crossChecks: view.crossChecks,
    inProgress:
      inFlight === undefined
        ? null
        : {
            valuationId: inFlight.id,
            periodEnd: inFlight.periodEnd,
            version: inFlight.version,
            state: valuationState.parse(inFlight.state),
            method: inFlight.method,
            fairValue: inFlight.fairValue,
            rowVersion: inFlight.rowVersion,
          },
    flags: view.flags,
  };
}
