import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AdapterSet, ExposureRow, Principal } from '@pb/adapters';
import { intakeFinding, intakeLink, intakeSource, lookthroughDifference } from '@pb/contracts';
import type {
  IntakeCounts,
  IntakeFile,
  LookthroughMapping,
  LookthroughReconcileBody,
  LookthroughReconcileResult,
  LookthroughRow,
  LookthroughRunDetail,
  StagingState,
} from '@pb/contracts';
import { asSystemActor, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import {
  IntakeSettingsError,
  countsOf,
  emptyCounts,
  fileStatusOf,
  linkLookthroughRows,
  linkOf,
  lookthroughExceptionsOpenedBy,
  lookthroughNaturalKey,
  lookthroughRuleConfigFrom,
  prepareLookthroughRows,
} from '@pb/validation';
import type {
  Finding,
  LookthroughRecord,
  LookthroughRuleConfig,
  PreparedLookthroughRow,
} from '@pb/validation';
import { z } from 'zod';
import { configError } from '../../common/definitions.js';
import { ProblemError } from '../../common/problem.js';
import { ADAPTERS, DEFINITIONS, LOOKTHROUGH_MAPPING } from '../../common/tokens.js';
import { requireUuid } from '../../common/validate.js';
import { DbService } from '../../db/db.service.js';
import { loadFlowsAndValuations } from '../../portfolio/loaders.js';
import { positionMetrics } from '../../portfolio/metrics.js';
import { investmentDirectory, matchGuards } from '../directory.js';

/*
 * The look-through reconcile (docs/04 M2 lookthrough-reconcile, decision 0010): the provider's
 * extract for one as-of date is read through the look-through adapter, every row is linked to
 * the book (docs/03 section 5), its labels are mapped onto the taxonomy through
 * config/lookthrough_mapping.json and its exposures are compared with the approved values: the
 * invested cost and the latest Locked mark as the portfolio pages compute them (positionMetrics,
 * never a second derivation). The run is an stg.intake_file of source lookthrough whose rows
 * carry the comparison; every difference, unmapped label and unresolved link opens an
 * ops.data_exception; nothing on record changes (docs/04 M1: outside sources are mapped to the
 * taxonomy and never override it). The rules and the exceptions are the shared
 * @pb/validation module (rules/lookthrough.ts). Linking and the record read run as the system
 * actor so a walled position links rather than reading as "no match" (decision 0009); the caller's
 * own row-level security decides what they are shown.
 */

const SOURCE = 'lookthrough';
const EXCEPTION_SOURCE = 'lookthrough_reconcile';
/** The staged row compares with the position on record and writes nothing; the target names what was compared. */
const TARGET_ENTITY = 'core.investment';
const NOT_FOUND = 'Reconcile run not found';
const INSERT_CHUNK = 500;

/** The file-level finding of a run for a date the provider's folder holds no extract for. */
const NO_EXTRACT_RULE = 'LT-FILE-01';

/**
 * What stg.intake_row.payload holds for a reconciled row, written by reconcile() and read back by
 * the run detail: the provider's row as sent, what the mapping made of its labels, the record it
 * was compared with, the differences and the link.
 */
const rowPayload = z.object({
  provider: z.object({
    investmentNumber: z.string().nullable(),
    companyName: z.string(),
    sector: z.string(),
    geography: z.string(),
    exposureAtCost: z.string(),
    exposureAtNav: z.string(),
    asOf: z.string(),
  }),
  mapped: z.object({ sector: z.string().nullable(), geography: z.string().nullable() }),
  record: z
    .object({
      sector: z.string().nullable(),
      geography: z.string().nullable(),
      exposureAtCost: z.string().nullable(),
      exposureAtNav: z.string().nullable(),
    })
    .nullable(),
  differences: z.array(lookthroughDifference),
  link: intakeLink,
});
type RowPayload = z.infer<typeof rowPayload>;
const findingList = z.array(intakeFinding);

/** One staged row as the database holds it, with its jsonb columns parsed. */
interface StagedRow {
  id: string;
  rowNo: number;
  status: StagingState;
  payload: RowPayload;
  findings: Finding[];
}

const file = schema.intakeFile;
const row = schema.intakeRow;
const receiver = alias(schema.appUser, 'receiver');

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The content hash of a run: the as-of date, then the rows as JSON. The date is part of the hash
 * so two runs for different dates never collide even when the provider sends the same rows for
 * both (decision 0010): what was compared differs, since the record is read as of each date.
 */
export function reconcileContentHash(asOf: string, rows: readonly ExposureRow[]): string {
  return createHash('sha256')
    .update(`${asOf}\n${JSON.stringify(rows)}`)
    .digest('hex');
}

@Injectable()
export class LookthroughService {
  constructor(
    private readonly db: DbService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DEFINITIONS) private readonly definitions: unknown,
    @Inject(LOOKTHROUGH_MAPPING) private readonly mapping: LookthroughMapping,
  ) {}

  /** The two tolerances through the rule module's strict reader (CLAUDE.md rules 9 and 10): a missing key is a 500 naming it. */
  private config(): LookthroughRuleConfig {
    try {
      return lookthroughRuleConfigFrom(this.definitions);
    } catch (error) {
      if (error instanceof IntakeSettingsError) throw configError(error.key);
      throw error;
    }
  }

  /**
   * Reconcile the provider's extract for an as-of date. Idempotent by content: the same date and
   * rows answer the run they created before with `duplicate` true and stage nothing; the answer
   * is a read of that run and is audited as one. Otherwise the run, its rows and the data
   * exceptions land in one transaction with one audit event that carries counts only. A date the
   * folder holds no extract for stages a run with no rows and a file finding, so the attempt is
   * on record; the extract, once it arrives, is new content and a new run.
   */
  async reconcile(
    principal: Principal,
    requestId: string,
    body: LookthroughReconcileBody,
  ): Promise<LookthroughReconcileResult> {
    const config = this.config();
    const asOf = body.asOf;
    // The record is read as of the run's date; for a date after today there is nothing on record
    // to compare with, and a reconcile for it would tie against marks that do not exist yet.
    if (asOf > this.adapters.clock.today())
      throw new ProblemError(400, 'validation', 'Invalid reconcile', [
        { path: 'asOf', message: 'The as-of date must be today or earlier' },
      ]);
    let rows: ExposureRow[];
    try {
      rows = await this.adapters.lookThrough.fetchExposures(asOf);
    } catch {
      // The folder holds something for the date that is not an extract: nothing is read in part.
      throw new ProblemError(
        503,
        'upstream',
        'The look-through extract for this date could not be read',
      );
    }
    const contentHash = reconcileContentHash(asOf, rows);

    const existing = await this.db.run(principal, requestId, async (tx, audit) => {
      const found = await this.findByHash(tx, contentHash);
      if (found !== null)
        await audit({ action: 'intake_file.read', entity: 'stg.intake_file', entityId: found.id });
      return found;
    });
    if (existing !== null) return { ...existing, duplicate: true };

    // The system actor links against the whole book and reads the record (see the module comment).
    const prepared = await this.db.runAsSystem((tx) => this.prepare(tx, rows, asOf, config));

    return this.db.run(principal, requestId, async (tx, audit) => {
      const counts = countsOf(prepared.map((p) => p.status));
      const fileName = `lookthrough-${asOf}.json`;
      const fileFindings: Finding[] =
        rows.length === 0
          ? [
              {
                ruleId: NO_EXTRACT_RULE,
                severity: 'error',
                message: `No extract for ${asOf}: the look-through folder holds no rows for this date`,
                field: null,
                expected: `${asOf}.json`,
                actual: null,
              },
            ]
          : [];
      const inserted = await tx
        .insert(file)
        .values({
          source: SOURCE,
          fileName,
          contentHash,
          asOf,
          receivedBy: principal.userId,
          rowCount: prepared.length,
          status: fileStatusOf(counts),
          findings: fileFindings,
        })
        .onConflictDoNothing({ target: [file.source, file.contentHash] })
        .returning();
      const fileId = inserted[0]?.id;
      if (fileId === undefined) {
        // The same content landed from another request meanwhile: answer that run.
        const found = await this.findByHash(tx, contentHash);
        if (found === null)
          throw new ProblemError(409, 'conflict', 'The reconcile did not complete');
        return { ...found, duplicate: true };
      }
      const exceptions = await this.insertRows(tx, fileId, prepared);
      await audit({
        action: 'intake.reconcile',
        entity: 'stg.intake_file',
        entityId: fileId,
        details: {
          asOf,
          fileName,
          rowCount: prepared.length,
          counts,
          differences: prepared.reduce((n, p) => n + p.differences.length, 0),
          exceptions,
        },
      });
      const loaded = await this.load(tx, fileId);
      if (loaded === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      return { ...loaded, duplicate: false };
    });
  }

  private async findByHash(tx: Tx, contentHash: string): Promise<LookthroughRunDetail | null> {
    const found = await tx
      .select({ id: file.id })
      .from(file)
      .where(and(eq(file.source, SOURCE), eq(file.contentHash, contentHash)));
    const id = found[0]?.id;
    return id === undefined ? null : this.load(tx, id);
  }

  /**
   * Links every row against the investment directory (number, names, aliases) and the match
   * guards, then maps and checks it against the record of the position it links to, through the
   * shared preparation of @pb/validation.
   */
  private async prepare(
    tx: Tx,
    rows: readonly ExposureRow[],
    asOf: string,
    config: LookthroughRuleConfig,
  ): Promise<PreparedLookthroughRow[]> {
    const directory = await investmentDirectory(tx);
    const guards = await matchGuards(tx);
    const linked = linkLookthroughRows(
      rows.map((r, i) => ({ ...r, rowNo: i + 1 })),
      directory,
      guards,
    );
    const investmentIds = [
      ...new Set(linked.flatMap((l) => (l.link.investment === null ? [] : [l.link.investment.id]))),
    ];
    const records = await this.records(tx, investmentIds, asOf);
    return prepareLookthroughRows(
      linked,
      { mapping: this.mapping, recordOf: (id) => records.get(id) ?? null },
      asOf,
      config,
    );
  }

  /**
   * What is on record for each linked position as of the run's date: the company's taxonomy
   * codes, and the invested cost and NAV exactly as the portfolio grid and the deal pages compute
   * them (positionMetrics over the approved flows and the Locked marks: the one derivation of
   * both figures, CLAUDE.md rule 7). A position with no Locked mark by the date has no NAV to
   * compare, never 0 (rule 10).
   */
  private async records(
    tx: Tx,
    investmentIds: readonly string[],
    asOf: string,
  ): Promise<Map<string, LookthroughRecord>> {
    const out = new Map<string, LookthroughRecord>();
    if (investmentIds.length === 0) return out;
    const companies = await tx
      .select({
        id: schema.investment.id,
        exitDate: schema.investment.exitDate,
        sector: schema.portfolioCompany.sector,
        geography: schema.portfolioCompany.geography,
      })
      .from(schema.investment)
      .innerJoin(
        schema.portfolioCompany,
        eq(schema.portfolioCompany.id, schema.investment.portfolioCompanyId),
      )
      .where(inArray(schema.investment.id, [...investmentIds]));
    const { flows, valuations } = await loadFlowsAndValuations(tx, investmentIds);
    for (const c of companies) {
      // Held on the as-of date: not exited by it (portfolio/loaders.ts asOfStatus).
      const heldOnAsOf = c.exitDate === null || c.exitDate > asOf;
      const metrics = positionMetrics(
        flows.get(c.id) ?? [],
        valuations.get(c.id) ?? [],
        asOf,
        heldOnAsOf,
        c.exitDate,
      );
      out.set(c.id, {
        sector: c.sector,
        geography: c.geography,
        exposureAtCost: metrics.invested,
        exposureAtNav: metrics.nav,
      });
    }
    return out;
  }

  /** Writes the staged rows and the data exceptions they open; answers how many exceptions were opened. */
  private async insertRows(
    tx: Tx,
    fileId: string,
    prepared: readonly PreparedLookthroughRow[],
  ): Promise<number> {
    const ids = new Map<number, string>();
    for (const batch of chunk(prepared, INSERT_CHUNK)) {
      // Ids are given here, not returned: a RETURNING clause reads the new rows through the select
      // policy, and a reconciler outside a wall may write the walled position's row but not read it.
      const values = batch.map((p) => {
        const { rowNo: _rowNo, ...provider } = p.row;
        return {
          id: randomUUID(),
          intakeFileId: fileId,
          rowNo: p.row.rowNo,
          naturalKey: lookthroughNaturalKey(p.row),
          targetEntity: TARGET_ENTITY,
          targetId: p.link.investment?.id ?? null,
          payload: {
            provider,
            mapped: p.mapped,
            record: p.record,
            differences: p.differences,
            link: linkOf(p.link),
          } satisfies RowPayload,
          // Nothing is written from a provider file, so no row ever changes the record.
          diff: { kind: 'unchanged', changes: [] },
          validation: p.findings,
          status: p.status,
        };
      });
      await tx.insert(row).values(values);
      for (const r of values) ids.set(r.rowNo, r.id);
    }
    // Which exceptions a row opens, their tier and what they carry is the shared rule in @pb/validation.
    const exceptions: (typeof schema.dataException.$inferInsert)[] = prepared.flatMap((p) => {
      const rowId = ids.get(p.row.rowNo);
      if (rowId === undefined) return [];
      return lookthroughExceptionsOpenedBy(p).map(({ tier, ...opened }) => ({
        source: EXCEPTION_SOURCE,
        entity: 'stg.intake_row',
        entityId: rowId,
        severity: `exception_severity.${tier}`,
        state: 'open',
        ...opened,
      }));
    });
    for (const batch of chunk(exceptions, INSERT_CHUNK))
      await tx.insert(schema.dataException).values(batch);
    return exceptions.length;
  }

  /** The run with every row the caller may see; a run the caller cannot see is 404. The open is audited. */
  async detail(
    principal: Principal,
    requestId: string,
    runId: string,
  ): Promise<LookthroughRunDetail> {
    requireUuid(runId, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const loaded = await this.load(tx, runId);
      if (loaded === null) throw new ProblemError(404, 'not-found', NOT_FOUND);
      await audit({ action: 'intake_file.read', entity: 'stg.intake_file', entityId: runId });
      return loaded;
    });
  }

  /**
   * Row counts per status and exceptions per row, counted as the system actor inside the caller's
   * transaction so they cover every row, walled ones included: a run's status, counts and
   * exception total are facts of the run, the same for every reader, and a number reveals
   * nothing of a hidden row.
   */
  private async countsOfRun(
    tx: Tx,
    fileId: string,
  ): Promise<{ counts: IntakeCounts; exceptionsByRow: Map<string, number> }> {
    const counts = emptyCounts();
    const exceptionsByRow = new Map<string, number>();
    await asSystemActor(tx, async (stx) => {
      const byStatus = await stx
        .select({ status: row.status, n: sql<number>`count(*)::int` })
        .from(row)
        .where(eq(row.intakeFileId, fileId))
        .groupBy(row.status);
      for (const r of byStatus) counts[r.status] += r.n;
      const opened = await stx
        .select({ rowId: row.id, n: sql<number>`count(*)::int` })
        .from(schema.dataException)
        .innerJoin(row, eq(row.id, schema.dataException.entityId))
        .where(
          and(
            eq(schema.dataException.source, EXCEPTION_SOURCE),
            eq(schema.dataException.entity, 'stg.intake_row'),
            eq(row.intakeFileId, fileId),
          ),
        )
        .groupBy(row.id);
      for (const r of opened) exceptionsByRow.set(r.rowId, r.n);
    });
    return { counts, exceptionsByRow };
  }

  /**
   * The run with its rows in file order, as the caller may see them. A row linked to a position
   * the caller cannot open is hidden by its row policy (migration 0009) and, should a policy ever
   * let one through, by the filter below; it is counted as hidden. A candidate the caller cannot
   * open is dropped from the link, so nothing here reveals a walled position exists (SEC-5.3).
   */
  private async load(tx: Tx, fileId: string): Promise<LookthroughRunDetail | null> {
    const found = await tx
      .select({
        id: file.id,
        source: file.source,
        fileName: file.fileName,
        contentHash: file.contentHash,
        templateSignature: file.templateSignature,
        asOf: file.asOf,
        receivedAt: file.receivedAt,
        receivedBy: receiver.displayName,
        rowCount: file.rowCount,
        status: file.status,
        findings: file.findings,
        rowVersion: file.rowVersion,
      })
      .from(file)
      .leftJoin(receiver, eq(receiver.id, file.receivedBy))
      .where(and(eq(file.id, fileId), eq(file.source, SOURCE)));
    const header = found[0];
    if (header === undefined) return null;
    // A look-through run always carries its as-of date; a row without one is not a run.
    if (header.asOf === null) return null;
    const { counts, exceptionsByRow } = await this.countsOfRun(tx, fileId);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const stored = await tx
      .select({
        id: row.id,
        rowNo: row.rowNo,
        status: row.status,
        payload: row.payload,
        validation: row.validation,
      })
      .from(row)
      .where(eq(row.intakeFileId, fileId))
      .orderBy(asc(row.rowNo));
    const rows: StagedRow[] = stored.map(({ payload, validation, ...rest }) => ({
      ...rest,
      payload: rowPayload.parse(payload),
      findings: findingList.parse(validation),
    }));
    const linked = [
      ...new Set(
        rows.flatMap((r) =>
          r.payload.link.investmentId === null ? [] : [r.payload.link.investmentId],
        ),
      ),
    ];
    const named = [
      ...new Set(rows.flatMap((r) => r.payload.link.candidates.map((c) => c.investmentNumber))),
    ];
    const seen =
      linked.length + named.length === 0
        ? []
        : await tx
            .select({
              id: schema.investment.id,
              investmentNumber: schema.investment.investmentNumber,
            })
            .from(schema.investment)
            .where(
              or(
                ...(linked.length > 0 ? [inArray(schema.investment.id, linked)] : []),
                ...(named.length > 0 ? [inArray(schema.investment.investmentNumber, named)] : []),
              ),
            );
    const visibleIds = new Set(seen.map((r) => r.id));
    const visibleNumbers = new Set(seen.map((r) => r.investmentNumber));
    const visible = rows.filter(
      (r) => r.payload.link.investmentId === null || visibleIds.has(r.payload.link.investmentId),
    );
    let exceptions = 0;
    for (const n of exceptionsByRow.values()) exceptions += n;
    const base: IntakeFile = {
      id: header.id,
      source: intakeSource.parse(header.source),
      fileName: header.fileName,
      contentHash: header.contentHash,
      templateSignature: header.templateSignature,
      receivedAt: header.receivedAt.toISOString(),
      receivedBy: header.receivedBy,
      rowCount: header.rowCount,
      status: header.status,
      counts,
      fileFindings: findingList.parse(header.findings),
      exceptions,
      rowVersion: header.rowVersion,
    };
    return {
      ...base,
      asOf: header.asOf,
      rows: visible.map((r) => this.toRow(r, visibleNumbers, exceptionsByRow.get(r.id) ?? 0)),
      hiddenRows: total - visible.length,
    };
  }

  /** A reconciled row for the caller, with only the candidates among the positions they may see. */
  private toRow(
    r: StagedRow,
    visibleNumbers: ReadonlySet<string>,
    exceptions: number,
  ): LookthroughRow {
    const { provider, mapped, record, differences, link } = r.payload;
    return {
      id: r.id,
      rowNo: r.rowNo,
      investmentNumber: provider.investmentNumber,
      companyName: provider.companyName,
      asOf: provider.asOf,
      provider: {
        sector: provider.sector,
        geography: provider.geography,
        exposureAtCost: provider.exposureAtCost,
        exposureAtNav: provider.exposureAtNav,
      },
      mapped,
      approved: {
        exposureAtCost: record?.exposureAtCost ?? null,
        exposureAtNav: record?.exposureAtNav ?? null,
      },
      differences,
      link: {
        ...link,
        candidates: link.candidates.filter((c) => visibleNumbers.has(c.investmentNumber)),
      },
      findings: r.findings,
      status: r.status,
      exceptions,
    };
  }
}
