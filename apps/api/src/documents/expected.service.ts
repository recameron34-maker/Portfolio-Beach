import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import { docTypeCode } from '@pb/contracts';
import type {
  ExpectedDocument,
  ExpectedDocumentGenerateBody,
  ExpectedDocumentGenerateResult,
  ExpectedDocumentPage,
  expectedDocumentListQuery,
} from '@pb/contracts';
import { asSystemActor, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import type { z } from 'zod';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { ADAPTERS, DEFINITIONS } from '../common/tokens.js';
import { DbService } from '../db/db.service.js';
import { heldOn, loadInvestmentRows } from '../portfolio/loaders.js';
import {
  EXPECTED_DOC_TYPES,
  QUARTERLY_REPORTING_DEAL_TYPES,
  deriveExpected,
  dueDateFor,
} from './expected.js';
import { documentSettingsOf } from './settings.js';

/*
 * The expected-document tracker (docs/04 M3, decision 0012): for a quarter end, one
 * quarterly_financials row per investment held on that day whose deal type reports quarterly
 * figures, and one capital_account_statement row per sponsor fund the firm has a commitment to,
 * each due the configured days after the quarter end. Generation is idempotent (the rows a
 * quarter already has are kept and counted) and runs as the system actor inside the caller's
 * transaction so walled positions get their rows (migration 0011); a document indexed and
 * classified before its row existed is matched at generation, as the index matches a document
 * classified after. The status (expected, received, late, missing) and the age are derived when
 * read (expected.ts), never stored, under the caller's own row-level security.
 */

export type ExpectedListOptions = z.infer<typeof expectedDocumentListQuery>;

const x = schema.expectedDocument;
const d = schema.document;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** "dueDate|id" of the last row of a page: newest period first is newest due date first. */
const DUE_ID_CURSOR = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})\\|(${UUID})$`);
/** How many rows a status-filtered page reads at a time before judging them. */
const SCAN_BATCH = 200;
const INSERT_CHUNK = 500;

/** What matching reads of a classified document. */
export interface MatchableDocument {
  id: string;
  docType: string | null;
  periodEnd: string | null;
  investmentId: string | null;
  sponsorFundId: string | null;
}

/**
 * Sets received_document_id on the expected row a classified document answers (the same parent,
 * period end and type), when that row exists and is still empty. A report matches by its
 * investment, a statement by its sponsor fund. Runs in whatever identity the caller holds; the
 * index and the classify command call it as the system actor. Answers whether a row was matched.
 */
export async function matchExpectedDocument(tx: Tx, doc: MatchableDocument): Promise<boolean> {
  if (doc.docType === null || doc.periodEnd === null) return false;
  if (
    doc.docType !== EXPECTED_DOC_TYPES.quarterlyFinancials &&
    doc.docType !== EXPECTED_DOC_TYPES.capitalAccountStatement
  )
    return false;
  const parent =
    doc.docType === EXPECTED_DOC_TYPES.quarterlyFinancials
      ? doc.investmentId === null
        ? null
        : eq(x.investmentId, doc.investmentId)
      : doc.sponsorFundId === null
        ? null
        : eq(x.sponsorFundId, doc.sponsorFundId);
  if (parent === null) return false;
  const updated = await tx
    .update(x)
    .set({ receivedDocumentId: doc.id })
    .where(
      and(
        parent,
        eq(x.periodEnd, doc.periodEnd),
        eq(x.docType, doc.docType),
        isNull(x.receivedDocumentId),
      ),
    )
    .returning();
  return updated.length > 0;
}

/** An expected row as the list reads it, with the names of its parent and the day its document arrived. */
interface LoadedExpected {
  id: string;
  investmentId: string | null;
  investmentNumber: string | null;
  companyName: string | null;
  sponsorFundId: string | null;
  sponsorFundName: string | null;
  periodEnd: string;
  docType: string;
  dueDate: string;
  receivedDocumentId: string | null;
  receivedOn: string | null;
}

@Injectable()
export class ExpectedDocumentsService {
  constructor(
    private readonly db: DbService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DEFINITIONS) private readonly definitions: unknown,
  ) {}

  /**
   * Generate the rows of a quarter (operations). Idempotent: rows the quarter already has are
   * counted as existing and left as they were. Audited with the counts only.
   */
  async generate(
    principal: Principal,
    requestId: string,
    body: ExpectedDocumentGenerateBody,
  ): Promise<ExpectedDocumentGenerateResult> {
    const settings = documentSettingsOf(this.definitions);
    const periodEnd = body.periodEnd;
    const dueDate = dueDateFor(periodEnd, settings);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const outcome = await asSystemActor(tx, async (stx) => {
        const investments = await loadInvestmentRows(stx, {
          where: and(
            heldOn(periodEnd),
            inArray(schema.investment.dealType, [...QUARTERLY_REPORTING_DEAL_TYPES]),
          ),
        });
        const funds = await stx
          .selectDistinct({ id: schema.commitment.sponsorFundId })
          .from(schema.commitment)
          .where(lte(schema.commitment.commitmentDate, periodEnd));
        const wanted = [
          ...investments.map((i) => ({
            investmentId: i.id,
            sponsorFundId: null,
            docType: EXPECTED_DOC_TYPES.quarterlyFinancials,
          })),
          ...funds.map((f) => ({
            investmentId: null,
            sponsorFundId: f.id,
            docType: EXPECTED_DOC_TYPES.capitalAccountStatement,
          })),
        ];
        const existing = await stx
          .select({
            investmentId: x.investmentId,
            sponsorFundId: x.sponsorFundId,
            docType: x.docType,
          })
          .from(x)
          .where(eq(x.periodEnd, periodEnd));
        const key = (r: {
          investmentId: string | null;
          sponsorFundId: string | null;
          docType: string;
        }) => `${r.investmentId ?? ''}|${r.sponsorFundId ?? ''}|${r.docType}`;
        const have = new Set(existing.map(key));
        const missing = wanted.filter((w) => !have.has(key(w)));
        for (let i = 0; i < missing.length; i += INSERT_CHUNK)
          await stx
            .insert(x)
            .values(missing.slice(i, i + INSERT_CHUNK).map((m) => ({ ...m, periodEnd, dueDate })));
        const matched = await this.matchIndexed(stx, periodEnd);
        return { created: missing.length, existing: wanted.length - missing.length, matched };
      });
      await audit({
        action: 'expected_documents.generate',
        entity: 'doc.expected_document',
        details: { periodEnd, dueDate, ...outcome },
      });
      return { periodEnd, created: outcome.created, existing: outcome.existing };
    });
  }

  /**
   * Matches the empty rows of a quarter with documents already classified for it: the earliest
   * indexed Classified document of the same parent, period and type. The index does the same
   * for a document classified after its row existed.
   */
  private async matchIndexed(stx: Tx, periodEnd: string): Promise<number> {
    const result = await stx.execute(sql`
      update doc.expected_document x
      set received_document_id = (
        select d.id from doc.document d
        where d.review_status = 'Classified'
          and d.doc_type = x.doc_type
          and d.period_end = x.period_end
          and ((x.investment_id is not null and d.investment_id = x.investment_id)
            or (x.investment_id is null and d.sponsor_fund_id = x.sponsor_fund_id))
        order by d.indexed_at asc, d.id asc
        limit 1)
      where x.period_end = ${periodEnd}
        and x.received_document_id is null
        and exists (
          select 1 from doc.document d
          where d.review_status = 'Classified'
            and d.doc_type = x.doc_type
            and d.period_end = x.period_end
            and ((x.investment_id is not null and d.investment_id = x.investment_id)
              or (x.investment_id is null and d.sponsor_fund_id = x.sponsor_fund_id)))
      returning x.id`);
    return result.rows.length;
  }

  /**
   * Expected rows newest period first, paged on (dueDate, id), each with its status and age as
   * of the day asked (the clock's today otherwise). A status filter is applied after derivation,
   * reading on until a page is full. Row-level security decides which rows the caller sees.
   */
  async list(
    principal: Principal,
    requestId: string,
    opts: ExpectedListOptions,
  ): Promise<ExpectedDocumentPage> {
    const settings = documentSettingsOf(this.definitions);
    const asOf = opts.asOf ?? this.adapters.clock.today();
    const fixed: (SQL | undefined)[] = [];
    if (opts.periodEnd !== undefined) fixed.push(eq(x.periodEnd, opts.periodEnd));
    if (opts.investmentId !== undefined) fixed.push(eq(x.investmentId, opts.investmentId));
    if (opts.sponsorFundId !== undefined) fixed.push(eq(x.sponsorFundId, opts.sponsorFundId));
    let after: { dueDate: string; id: string } | null = null;
    if (opts.cursor !== undefined) {
      const [dueDate = '', id = ''] = decodeCursor(opts.cursor, DUE_ID_CURSOR, [1]);
      after = { dueDate, id };
    }
    return this.db.run(principal, requestId, async (tx) => {
      const items: ExpectedDocument[] = [];
      let more = false;
      // Without a status filter one read answers the page; with one, rows are judged as they are
      // read and the scan continues until the page is full or the rows run out.
      const batchSize = opts.status === undefined ? opts.limit + 1 : SCAN_BATCH;
      for (;;) {
        const rows = await this.select(tx, fixed, after, batchSize);
        for (const row of rows) {
          const judged = this.toExpected(row, asOf, settings);
          if (opts.status !== undefined && judged.status !== opts.status) continue;
          if (items.length === opts.limit) {
            more = true;
            break;
          }
          items.push(judged);
        }
        const last = rows[rows.length - 1];
        if (more || rows.length < batchSize || last === undefined) break;
        after = { dueDate: last.dueDate, id: last.id };
      }
      const last = items[items.length - 1];
      return {
        items,
        nextCursor: more && last !== undefined ? encodeCursor([last.dueDate, last.id]) : null,
      };
    });
  }

  private select(
    tx: Tx,
    fixed: readonly (SQL | undefined)[],
    after: { dueDate: string; id: string } | null,
    limit: number,
  ): Promise<LoadedExpected[]> {
    const conditions = [...fixed];
    if (after !== null)
      conditions.push(
        or(
          lt(x.dueDate, after.dueDate),
          and(eq(x.dueDate, after.dueDate), lt(x.id, sql`${after.id}::uuid`)),
        ),
      );
    return tx
      .select({
        id: x.id,
        investmentId: x.investmentId,
        investmentNumber: schema.investment.investmentNumber,
        companyName: schema.portfolioCompany.name,
        sponsorFundId: x.sponsorFundId,
        sponsorFundName: schema.sponsorFund.name,
        periodEnd: x.periodEnd,
        docType: x.docType,
        dueDate: x.dueDate,
        receivedDocumentId: x.receivedDocumentId,
        receivedOn: sql<string | null>`to_char(${d.receivedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
      })
      .from(x)
      .leftJoin(schema.investment, eq(schema.investment.id, x.investmentId))
      .leftJoin(
        schema.portfolioCompany,
        eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
      )
      .leftJoin(schema.sponsorFund, eq(schema.sponsorFund.id, x.sponsorFundId))
      .leftJoin(d, eq(d.id, x.receivedDocumentId))
      .where(and(...conditions))
      .orderBy(desc(x.dueDate), desc(x.id))
      .limit(limit);
  }

  private toExpected(
    r: LoadedExpected,
    asOf: string,
    settings: ReturnType<typeof documentSettingsOf>,
  ): ExpectedDocument {
    const timing = {
      dueDate: r.dueDate,
      receivedDocumentId: r.receivedDocumentId,
      receivedOn: r.receivedOn,
    };
    return {
      id: r.id,
      investmentId: r.investmentId,
      investmentNumber: r.investmentNumber,
      companyName: r.companyName,
      sponsorFundId: r.sponsorFundId,
      sponsorFundName: r.sponsorFundName,
      periodEnd: r.periodEnd,
      docType: docTypeCode.parse(r.docType),
      dueDate: r.dueDate,
      receivedDocumentId: r.receivedDocumentId,
      ...deriveExpected(timing, asOf, settings),
    };
  }
}
