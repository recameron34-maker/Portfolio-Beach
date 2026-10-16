import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { AdapterSet, Principal } from '@pb/adapters';
import { latestQuarterEndOnOrBefore } from '@pb/calc';
import { extractionRunState } from '@pb/contracts';
import type {
  MonitoringBoard,
  MonitoringBoardRow,
  RealizationOutlookBody,
  RealizationOutlookDetail,
  monitoringBoardQuery,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import type { z } from 'zod';
import { ProblemError } from '../common/problem.js';
import { ADAPTERS, DEFINITIONS } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import { EXPECTED_DOC_TYPES } from '../documents/expected.js';
import { documentSettingsOf } from '../documents/settings.js';
import { heldOn, loadInvestmentRows } from '../portfolio/loaders.js';
import type { InvestmentBaseRow } from '../portfolio/loaders.js';
import { boardCounts, boardCsv, boardRowOf, reportsQuarterly } from './board.js';
import type { BoardExpected, BoardRecord, BoardRun } from './board.js';
import {
  OUTLOOK_GUARD_KEY,
  outlookCodeOf,
  outlookEditableByHandOf,
  outlookTermOf,
} from './settings.js';

/*
 * Portfolio monitoring (docs/04 M9, decision 0012): the board of a quarter and the realization
 * outlook. Everything a caller reads runs under their own row-level security, so a walled
 * investment, its expected row, its runs and its values are not there at all for a non-member
 * (SEC-5.3); the board never writes. The outlook changes only by the explicit edit here, with a
 * reason and an audit event carrying before and after (SEC-11.1), and only while
 * config/definitions.json keeps realizationFlagEditableOnlyManually on: that key is the guard
 * against any automated write, and the route refuses when it is off. The extraction module writes
 * doc.extraction_run and stg.extracted_value; this module only reads them through the schema.
 */

export type MonitoringBoardQuery = z.infer<typeof monitoringBoardQuery>;

export const INVESTMENT_NOT_FOUND = 'Investment not found';
/** The problem code when config switches the manual outlook edit off. */
export const OUTLOOK_GUARD_PROBLEM = 'realization-outlook-guard';
/** The default every investment carries until somebody sets an outlook. */
export const DEFAULT_OUTLOOK = { outlook: 'none', horizonMonths: 18, note: null } as const;
const APPROVED = 'record_status.approved';
const OUTLOOK_ENTITY = 'mon.realization_outlook';

const x = schema.expectedDocument;
const d = schema.document;
const run = schema.extractionRun;
const v = schema.extractedValue;
const qp = schema.quarterlyPerformance;
const o = schema.realizationOutlook;

/** An outlook row as the module reads it, with the display name of the person who set it. */
interface LoadedOutlook {
  id: string;
  outlook: string;
  horizonMonths: number;
  note: string | null;
  setBy: string | null;
  setAt: Date;
  rowVersion: number;
}

/** The problem when an edit finds the row changed by another edit first. */
const conflict = (): ProblemError =>
  new ProblemError(
    409,
    'conflict',
    'realization outlook: another edit changed it first; open it again',
  );

@Injectable()
export class MonitoringService {
  constructor(
    private readonly db: DbService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DEFINITIONS) private readonly definitions: unknown,
  ) {}

  /**
   * The board of a quarter (the latest quarter end on or before the as-of day when none is
   * named): one row per investment held at the period end that the caller may see, judged on
   * the as-of day. The open is audited with the period and the row count only.
   */
  board(
    principal: Principal,
    requestId: string,
    query: MonitoringBoardQuery,
  ): Promise<MonitoringBoard> {
    return this.db.run(principal, requestId, async (tx, audit) => {
      const board = await this.loadBoard(tx, query);
      await audit({
        action: 'monitoring.board.read',
        entity: 'core.investment',
        details: { periodEnd: board.periodEnd, asOf: board.asOf, rows: board.rows.length },
      });
      return board;
    });
  }

  /** The same rows as the board shows the caller, as CSV text with a header line. */
  async export(
    principal: Principal,
    requestId: string,
    query: MonitoringBoardQuery,
  ): Promise<{ periodEnd: string; csv: string }> {
    return this.db.run(principal, requestId, async (tx, audit) => {
      const board = await this.loadBoard(tx, query);
      await audit({
        action: 'monitoring.board.export',
        entity: 'core.investment',
        details: { periodEnd: board.periodEnd, asOf: board.asOf, rows: board.rows.length },
      });
      return { periodEnd: board.periodEnd, csv: boardCsv(board.rows) };
    });
  }

  private async loadBoard(tx: Tx, query: MonitoringBoardQuery): Promise<MonitoringBoard> {
    const settings = documentSettingsOf(this.definitions);
    const asOf = query.asOf ?? this.adapters.clock.today();
    const periodEnd = query.periodEnd ?? latestQuarterEndOnOrBefore(asOf);
    const investments = await loadInvestmentRows(tx, { where: heldOn(periodEnd) });
    const ids = investments.map((i) => i.id);
    const expected = await this.loadExpected(tx, investments, periodEnd);
    const runs = await this.loadRuns(tx, ids, periodEnd);
    const records = await this.loadRecords(tx, ids, periodEnd);
    const rows: MonitoringBoardRow[] = investments.map((investment) =>
      boardRowOf(investment, periodEnd, asOf, settings, {
        expected: expected.get(investment.id) ?? null,
        run: runs.get(investment.id) ?? null,
        record: records.get(investment.id) ?? null,
      }),
    );
    return { asOf, periodEnd, rows, counts: boardCounts(rows) };
  }

  /**
   * The expected row that answers for each investment this quarter: the quarterly report of an
   * investment whose deal type reports quarterly figures, else the capital account statement of
   * its sponsor fund (a private credit or primary fund position), when either row exists.
   */
  private async loadExpected(
    tx: Tx,
    investments: readonly InvestmentBaseRow[],
    periodEnd: string,
  ): Promise<Map<string, BoardExpected>> {
    const out = new Map<string, BoardExpected>();
    const reporting = investments.filter((i) => reportsQuarterly(i.dealType)).map((i) => i.id);
    const fundIds = [
      ...new Set(
        investments
          .filter((i) => !reportsQuarterly(i.dealType))
          .map((i) => i.sponsorFundId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const branches: SQL[] = [];
    if (reporting.length > 0)
      branches.push(
        and(
          eq(x.docType, EXPECTED_DOC_TYPES.quarterlyFinancials),
          inArray(x.investmentId, reporting),
        )!,
      );
    if (fundIds.length > 0)
      branches.push(
        and(
          eq(x.docType, EXPECTED_DOC_TYPES.capitalAccountStatement),
          inArray(x.sponsorFundId, fundIds),
        )!,
      );
    if (branches.length === 0) return out;
    const rows = await tx
      .select({
        id: x.id,
        investmentId: x.investmentId,
        sponsorFundId: x.sponsorFundId,
        docType: x.docType,
        dueDate: x.dueDate,
        receivedDocumentId: x.receivedDocumentId,
        receivedOn: sql<string | null>`to_char(${d.receivedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
      })
      .from(x)
      .leftJoin(d, eq(d.id, x.receivedDocumentId))
      .where(and(eq(x.periodEnd, periodEnd), or(...branches)));
    const byInvestment = new Map<string, BoardExpected>();
    const byFund = new Map<string, BoardExpected>();
    for (const r of rows) {
      const row = {
        id: r.id,
        dueDate: r.dueDate,
        receivedDocumentId: r.receivedDocumentId,
        receivedOn: r.receivedOn,
      };
      if (r.docType === EXPECTED_DOC_TYPES.quarterlyFinancials && r.investmentId !== null)
        byInvestment.set(r.investmentId, row);
      if (r.docType === EXPECTED_DOC_TYPES.capitalAccountStatement && r.sponsorFundId !== null)
        byFund.set(r.sponsorFundId, row);
    }
    for (const i of investments) {
      const row = reportsQuarterly(i.dealType)
        ? byInvestment.get(i.id)
        : i.sponsorFundId === null
          ? undefined
          : byFund.get(i.sponsorFundId);
      if (row !== undefined) out.set(i.id, row);
    }
    return out;
  }

  /** The newest run of each investment for the period, by (created_at, id), with its undecided flags counted. */
  private async loadRuns(
    tx: Tx,
    ids: readonly string[],
    periodEnd: string,
  ): Promise<Map<string, BoardRun>> {
    const out = new Map<string, BoardRun>();
    if (ids.length === 0) return out;
    const rows = await tx
      .selectDistinctOn([run.investmentId], {
        id: run.id,
        investmentId: run.investmentId,
        documentId: run.documentId,
        state: run.state,
        approvedAt: run.approvedAt,
      })
      .from(run)
      .where(and(inArray(run.investmentId, [...ids]), eq(run.periodEnd, periodEnd)))
      .orderBy(run.investmentId, desc(run.createdAt), desc(run.id));
    if (rows.length === 0) return out;
    const flags = await tx
      .select({ runId: v.runId, n: sql<number>`count(*)::int` })
      .from(v)
      .where(
        and(
          inArray(
            v.runId,
            rows.map((r) => r.id),
          ),
          isNull(v.decision),
          inArray(v.validationState, ['flagged', 'invalid']),
        ),
      )
      .groupBy(v.runId);
    const flagsByRun = new Map(flags.map((f) => [f.runId, f.n]));
    for (const r of rows) {
      if (r.investmentId === null) continue;
      out.set(r.investmentId, {
        id: r.id,
        documentId: r.documentId,
        state: extractionRunState.parse(r.state),
        approvedAt: r.approvedAt === null ? null : r.approvedAt.toISOString(),
        flagsCount: flagsByRun.get(r.id) ?? 0,
      });
    }
    return out;
  }

  /** The approved quarterly record of each investment for the period, when one exists. */
  private async loadRecords(
    tx: Tx,
    ids: readonly string[],
    periodEnd: string,
  ): Promise<Map<string, BoardRecord>> {
    const out = new Map<string, BoardRecord>();
    if (ids.length === 0) return out;
    const rows = await tx
      .select({ investmentId: qp.investmentId, approvedAt: qp.approvedAt })
      .from(qp)
      .where(
        and(
          inArray(qp.investmentId, [...ids]),
          eq(qp.periodEnd, periodEnd),
          eq(qp.status, APPROVED),
        ),
      )
      .orderBy(desc(qp.approvedAt));
    for (const r of rows)
      if (!out.has(r.investmentId))
        out.set(r.investmentId, {
          approvedAt: r.approvedAt === null ? null : r.approvedAt.toISOString(),
        });
    return out;
  }

  /** The outlook of an investment the caller may see (404 otherwise), or the default when nobody set one. */
  outlook(
    principal: Principal,
    requestId: string,
    investmentId: string,
  ): Promise<RealizationOutlookDetail> {
    requireUuid(investmentId, INVESTMENT_NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const investment = await this.visibleInvestment(tx, investmentId);
      const row = await this.loadOutlook(tx, investmentId);
      await audit({
        action: 'realization_outlook.read',
        entity: 'core.investment',
        entityId: investmentId,
      });
      return this.toDetail(investment, row);
    });
  }

  /**
   * Set the outlook by hand (deal team; a wall member for a walled investment): one row per
   * investment, created or replaced, with the person and the time it was set; audited with
   * before, after and the reason. Refused while config switches the manual edit off.
   */
  setOutlook(
    principal: Principal,
    requestId: string,
    investmentId: string,
    body: RealizationOutlookBody,
  ): Promise<RealizationOutlookDetail> {
    requireUuid(investmentId, INVESTMENT_NOT_FOUND);
    if (!outlookEditableByHandOf(this.definitions))
      throw new ProblemError(
        409,
        OUTLOOK_GUARD_PROBLEM,
        `The realization outlook is changed only by an explicit edit, and definitions.${OUTLOOK_GUARD_KEY} is off`,
      );
    return this.db.run(principal, requestId, async (tx, audit) => {
      const investment = await this.visibleInvestment(tx, investmentId);
      const before = (
        await tx
          .select({
            id: o.id,
            outlook: o.outlook,
            horizonMonths: o.horizonMonths,
            note: o.note,
            rowVersion: o.rowVersion,
          })
          .from(o)
          .where(eq(o.investmentId, investmentId))
          .for('update')
      )[0];
      const after = {
        outlook: outlookTermOf(body.outlook),
        horizonMonths: body.horizonMonths,
        note: body.note,
      };
      const stamp = { setBy: principal.userId, setAt: new Date(this.adapters.clock.now()) };
      let id: string;
      if (before === undefined) {
        const inserted = (
          await tx
            .insert(o)
            .values({ investmentId, ...after, ...stamp })
            .returning()
        )[0];
        if (inserted === undefined) throw conflict();
        id = inserted.id;
      } else {
        const updated = (
          await tx
            .update(o)
            .set({ ...after, ...stamp })
            .where(and(eq(o.id, before.id), eq(o.rowVersion, before.rowVersion)))
            .returning()
        )[0];
        if (updated === undefined) throw conflict();
        id = updated.id;
      }
      await audit({
        action: 'realization_outlook.set',
        entity: OUTLOOK_ENTITY,
        entityId: id,
        reason: body.reason,
        details: {
          investmentId,
          investmentNumber: investment.investmentNumber,
          before:
            before === undefined
              ? null
              : {
                  outlook: outlookCodeOf(before.outlook),
                  horizonMonths: before.horizonMonths,
                  note: before.note,
                },
          after: { outlook: body.outlook, horizonMonths: body.horizonMonths, note: body.note },
        },
      });
      const row = await this.loadOutlook(tx, investmentId);
      return this.toDetail(investment, row);
    });
  }

  /** The investment as the caller sees it; one past their walls, or none at all, is not found. */
  private async visibleInvestment(tx: Tx, investmentId: string): Promise<InvestmentBaseRow> {
    const row = (
      await loadInvestmentRows(tx, { where: eq(schema.investment.id, investmentId), limit: 1 })
    )[0];
    if (row === undefined) throw new ProblemError(404, 'not-found', INVESTMENT_NOT_FOUND);
    return row;
  }

  private async loadOutlook(tx: Tx, investmentId: string): Promise<LoadedOutlook | null> {
    const row = (
      await tx
        .select({
          id: o.id,
          outlook: o.outlook,
          horizonMonths: o.horizonMonths,
          note: o.note,
          setBy: schema.appUser.displayName,
          setAt: o.setAt,
          rowVersion: o.rowVersion,
        })
        .from(o)
        .leftJoin(schema.appUser, eq(schema.appUser.id, o.setBy))
        .where(eq(o.investmentId, investmentId))
        .limit(1)
    )[0];
    return row ?? null;
  }

  private toDetail(
    investment: InvestmentBaseRow,
    row: LoadedOutlook | null,
  ): RealizationOutlookDetail {
    const names = {
      investmentId: investment.id,
      investmentNumber: investment.investmentNumber,
      companyName: investment.companyName,
    };
    if (row === null) return { ...names, ...DEFAULT_OUTLOOK, setBy: null, setAt: null };
    return {
      ...names,
      outlook: outlookCodeOf(row.outlook),
      horizonMonths: row.horizonMonths,
      note: row.note,
      setBy: row.setBy,
      setAt: row.setAt.toISOString(),
    };
  }
}
