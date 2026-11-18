import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AdapterSet, Principal } from '@pb/adapters';
import { isQuarterEnd } from '@pb/calc';
import { canonicalJson, reportPackageContent } from '@pb/contracts';
import type {
  QaFindingRow,
  ReportPackageCommandBody,
  ReportPackageCreateBody,
  ReportPackageDetail,
  ReportPackageList,
  ReportPackageRow,
  ReportPackageState,
} from '@pb/contracts';
import { asSystemActor, schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { buildPackageSnapshot, qaPassed, runReportQa, snapshotRequestOf } from '@pb/report-engine';
import type { QaFinding } from '@pb/report-engine';
import { attempt, reportingPackageMachine } from '@pb/workflows';
import { configDecimal, configInteger } from '../common/definitions.js';
import { ProblemError, workflowProblem } from '../common/problem.js';
import { requireFreshRow } from '../common/row-version.js';
import { ADAPTERS, DEFINITIONS } from '../common/tokens.js';
import { requireUuid } from '../common/validate.js';
import { DbService } from '../db/db.service.js';
import { loadInvestmentsWithMetrics } from '../portfolio/loaders.js';

/*
 * Reporting packages (docs/04 M14, docs/18 section 5, docs/08 section 7). A package is one client
 * report for a quarter and a basis. Generating it builds its lines from Locked marks and approved
 * cash flows, as the caller may read them, stores that snapshot on the package and runs the report
 * QA rules over it; the findings are written by the system step, never by a person, and decide
 * whether the package is QAPassed or QAFailed. A failed package is regenerated once the data is
 * fixed, or an approver overrides the failed findings with a reason. The reviewer is never the
 * preparer (SEC-5.6); approval locks the content with a hash (SEC-9.3); a Released package never
 * changes, and a correction is a new version with a reason. Every command runs through
 * reportingPackageMachine and is audited. A package of a client the caller does not read is 404.
 */

const pkg = schema.reportingPackage;
const finding = schema.qaResult;
const preparer = alias(schema.appUser, 'pkg_preparer');
const reviewer = alias(schema.appUser, 'pkg_reviewer');
const releaser = alias(schema.appUser, 'pkg_releaser');
const overrider = alias(schema.appUser, 'qa_overrider');

const ENTITY = 'rpt.package';
const NOT_FOUND = 'Reporting package not found';
const CLIENT_NOT_FOUND = 'Client not found';

interface Definitions {
  rollForwardToleranceUsd?: unknown;
  reporting?: { weeklyMoversCount?: unknown };
  [key: string]: unknown;
}

type PackageRecord = typeof pkg.$inferSelect;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());
const person = (id: string | null, name: string | null): { id: string; name: string } | null =>
  id === null ? null : { id, name: name ?? '' };

@Injectable()
export class PackagesService {
  constructor(
    private readonly db: DbService,
    @Inject(ADAPTERS) private readonly adapters: AdapterSet,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

  async list(principal: Principal, requestId: string): Promise<ReportPackageList> {
    return this.db.run(principal, requestId, async (tx) => ({ items: await this.rows(tx) }));
  }

  async detail(principal: Principal, requestId: string, id: string): Promise<ReportPackageDetail> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, (tx) => this.loadDetail(tx, id));
  }

  async create(
    principal: Principal,
    requestId: string,
    body: ReportPackageCreateBody,
  ): Promise<ReportPackageDetail> {
    const asOf = body.asOf ?? this.adapters.clock.today();
    if (!isQuarterEnd(body.periodEnd))
      throw new ProblemError(400, 'validation', 'Invalid body', [
        { path: 'periodEnd', message: 'A package period is a calendar quarter end' },
      ]);
    if (asOf < body.periodEnd)
      throw new ProblemError(400, 'validation', 'Invalid body', [
        { path: 'asOf', message: 'The as-of date is on or after the period end' },
      ]);
    return this.db.run(principal, requestId, async (tx, audit) => {
      // A client the caller is not entitled to does not exist for it (SEC-5.2).
      const client = (
        await tx
          .select({ id: schema.client.id })
          .from(schema.client)
          .where(eq(schema.client.id, body.clientId))
      )[0];
      if (client === undefined) throw new ProblemError(404, 'not-found', CLIENT_NOT_FOUND);

      const latest = (
        await tx
          .select({ version: pkg.version, state: pkg.state })
          .from(pkg)
          .where(
            and(
              eq(pkg.clientId, body.clientId),
              eq(pkg.periodEnd, body.periodEnd),
              eq(pkg.basis, body.basis),
            ),
          )
          .orderBy(desc(pkg.version))
          .limit(1)
      )[0];
      if (latest !== undefined && latest.state !== 'Released')
        throw new ProblemError(
          409,
          'workflow-transition',
          'A package for this client, period and basis is already in progress',
        );
      if (latest !== undefined && body.correctionReason === undefined)
        throw new ProblemError(
          422,
          'workflow-precondition',
          'A package for this client, period and basis was released; a new version needs a reason',
        );
      const version = latest === undefined ? 1 : latest.version + 1;
      const inserted = (
        await tx
          .insert(pkg)
          .values({
            clientId: body.clientId,
            periodEnd: body.periodEnd,
            asOf,
            basis: body.basis,
            label: body.label,
            version,
            preparedBy: principal.userId,
            correctionReason: version === 1 ? null : (body.correctionReason ?? null),
          })
          .returning()
      )[0];
      if (inserted === undefined) throw new Error('the package insert returned no row');
      await audit({
        action: 'report_package.create',
        entity: ENTITY,
        entityId: inserted.id,
        ...(version === 1 || body.correctionReason === undefined
          ? {}
          : { reason: body.correctionReason }),
        details: { state: { before: null, after: 'Draft' }, version },
      });
      return this.loadDetail(tx, inserted.id);
    });
  }

  async command(
    principal: Principal,
    requestId: string,
    id: string,
    body: ReportPackageCommandBody,
    ifMatch: readonly number[] | undefined,
  ): Promise<ReportPackageDetail> {
    requireUuid(id, NOT_FOUND);
    return this.db.run(principal, requestId, async (tx, audit) => {
      const locked = (await tx.select().from(pkg).where(eq(pkg.id, id)).for('update'))[0];
      if (locked === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
      requireFreshRow(ifMatch, locked.rowVersion, 'reporting_package');
      const from = locked.state;

      const result = attempt(reportingPackageMachine, from, body.command, {
        actorId: principal.userId,
        actorRoles: principal.roles,
        ...(body.command === 'overrideQa' ? { reason: body.reason } : {}),
        record: { preparedBy: locked.preparedBy },
      });
      if (!result.ok) throw workflowProblem(result);

      if (body.command === 'generate' || body.command === 'regenerate') {
        const outcome = await this.generate(tx, principal, locked, body.explanations ?? {});
        await audit({
          action: `report_package.${body.command}`,
          entity: ENTITY,
          entityId: id,
          details: {
            state: { before: from, after: outcome.state },
            runNo: outcome.runNo,
            findings: outcome.findings,
            failed: outcome.failed,
          },
        });
        return this.loadDetail(tx, id);
      }

      if (body.command === 'overrideQa') {
        const runNo = await this.latestRun(tx, id);
        const now = new Date(this.adapters.clock.now());
        const overridden = await tx
          .update(finding)
          .set({ overrideReason: body.reason, approverId: principal.userId, overriddenAt: now })
          .where(
            and(
              eq(finding.packageId, id),
              eq(finding.runNo, runNo ?? 0),
              eq(finding.passed, false),
              sql`${finding.overrideReason} is null`,
            ),
          )
          .returning();
        await this.claim(tx, locked, { state: result.to });
        await audit({
          action: 'report_package.overrideQa',
          entity: ENTITY,
          entityId: id,
          reason: body.reason,
          details: { state: { before: from, after: result.to }, overridden: overridden.length },
        });
        return this.loadDetail(tx, id);
      }

      if (body.command === 'approve') {
        // The canonical JSON of @pb/contracts (sorted keys, no spaces): the same text the static
        // preview hashes, so a hash taken on one side verifies on the other.
        const contentHash = createHash('sha256')
          .update(canonicalJson(locked.content))
          .digest('hex');
        await this.claim(tx, locked, {
          state: result.to,
          reviewerId: principal.userId,
          approvedAt: new Date(this.adapters.clock.now()),
          contentHash,
        });
        await audit({
          action: 'report_package.approve',
          entity: ENTITY,
          entityId: id,
          details: { state: { before: from, after: result.to }, contentHash },
        });
        return this.loadDetail(tx, id);
      }

      if (body.command === 'release') {
        await this.claim(tx, locked, {
          state: result.to,
          releasedAt: new Date(this.adapters.clock.now()),
          releasedBy: principal.userId,
        });
      } else {
        await this.claim(tx, locked, { state: result.to });
      }
      await audit({
        action: `report_package.${body.command}`,
        entity: ENTITY,
        entityId: id,
        details: { state: { before: from, after: result.to } },
      });
      return this.loadDetail(tx, id);
    });
  }

  /**
   * Builds the snapshot as the caller reads the book, stores it and runs the QA rules. The
   * findings and the QA outcome are the system step's (docs/18 section 5: qaPass and qaFail are
   * the service's commands), so no person states whether a package passed.
   */
  private async generate(
    tx: Tx,
    principal: Principal,
    locked: PackageRecord,
    explanations: Record<string, string>,
  ): Promise<{ state: ReportPackageState; runNo: number; findings: number; failed: number }> {
    const tolerance = configDecimal(
      this.definitions.rollForwardToleranceUsd,
      'rollForwardToleranceUsd',
    );
    const moversCount = configInteger(
      this.definitions.reporting?.weeklyMoversCount,
      'reporting.weeklyMoversCount',
    );
    const kept = { ...(locked.tieOutExplanations as Record<string, string>), ...explanations };

    // The client's share of each vehicle it is committed to, and the positions of those vehicles.
    const commitments = await tx
      .select({
        vehicleId: schema.lpCommitment.vehicleId,
        ownershipPct: schema.lpCommitment.ownershipPct,
      })
      .from(schema.lpCommitment)
      .where(eq(schema.lpCommitment.clientId, locked.clientId))
      .orderBy(asc(schema.lpCommitment.vehicleId));
    const vehicleIds = [...new Set(commitments.map((c) => c.vehicleId))];
    const loaded =
      vehicleIds.length === 0
        ? []
        : await loadInvestmentsWithMetrics(
            tx,
            locked.asOf,
            inArray(schema.investment.vehicleId, vehicleIds),
          );

    // Every package released to this client on this basis: the tie-out reads the last one before
    // this quarter, and snapshotRequestOf picks it.
    const released = await tx
      .select({ periodEnd: pkg.periodEnd, version: pkg.version, content: pkg.content })
      .from(pkg)
      .where(
        and(
          eq(pkg.clientId, locked.clientId),
          eq(pkg.basis, locked.basis),
          eq(pkg.state, 'Released'),
        ),
      );

    // What the record says becomes the request by the one rule the static preview also runs
    // (@pb/report-engine): Locked marks only, flows to the as-of date, the shares on record.
    const snapshot = buildPackageSnapshot(
      snapshotRequestOf({
        clientRef: locked.clientId,
        periodEnd: locked.periodEnd,
        asOf: locked.asOf,
        label: locked.label,
        basis: locked.basis,
        commitments: commitments.map((c) => ({
          vehicleRef: c.vehicleId,
          ownershipPct: c.ownershipPct,
        })),
        positions: loaded.map((p) => ({
          ref: p.row.investmentNumber,
          vehicleRef: p.row.vehicleId,
          entryDate: p.row.entryDate,
          exitDate: p.row.exitDate,
          valuations: p.valuations,
          flows: p.flows.map((f) => ({ date: f.flowDate, flowType: f.flowType, amount: f.amount })),
        })),
        released: released.map((r) => {
          const content = reportPackageContent.safeParse(r.content);
          return {
            periodEnd: r.periodEnd,
            version: r.version,
            lines: content.success ? content.data.lines : null,
          };
        }),
        explanations: kept,
        moversCount,
      }),
    );
    const findings = runReportQa(snapshot, { toleranceUsd: tolerance, moversCount });
    const passed = qaPassed(findings);
    const failed = findings.filter((f) => !f.passed).length;
    const runNo = ((await this.latestRun(tx, locked.id)) ?? 0) + 1;

    const log = [
      ...(Array.isArray(locked.changeLog) ? (locked.changeLog as unknown[]) : []),
      {
        at: this.adapters.clock.now(),
        by: principal.userId,
        runNo,
        lines: snapshot.lines.length,
        findings: findings.length,
        failed,
      },
    ];
    await this.claim(tx, locked, {
      state: 'Generated',
      content: snapshot,
      tieOutExplanations: kept,
      changeLog: log,
    });

    // The QA step: the system records what the rules found and states the outcome.
    const step = attempt(reportingPackageMachine, 'Generated', passed ? 'qaPass' : 'qaFail', {
      actorId: principal.userId,
      actorRoles: ['service'],
      record: {},
    });
    if (!step.ok) throw workflowProblem(step);
    await asSystemActor(tx, async (stx) => {
      await stx.insert(finding).values(findings.map((f) => this.findingRow(locked.id, runNo, f)));
      await stx.update(pkg).set({ state: step.to }).where(eq(pkg.id, locked.id));
    });
    return { state: step.to, runNo, findings: findings.length, failed };
  }

  private findingRow(packageId: string, runNo: number, f: QaFinding): typeof finding.$inferInsert {
    return {
      packageId,
      runNo,
      rule: f.rule,
      entityRef: f.entityRef,
      expected: f.expected,
      actual: f.actual,
      passed: f.passed,
      detail: f.detail,
    };
  }

  /** Writes with a guard on the state and row version read under the lock. */
  private async claim(
    tx: Tx,
    locked: PackageRecord,
    values: Partial<typeof pkg.$inferInsert>,
  ): Promise<void> {
    const updated = await tx
      .update(pkg)
      .set(values)
      .where(
        and(
          eq(pkg.id, locked.id),
          eq(pkg.state, locked.state),
          eq(pkg.rowVersion, locked.rowVersion),
        ),
      )
      .returning();
    if (updated.length === 0)
      throw new ProblemError(409, 'workflow-transition', 'The package changed while this ran');
  }

  private async latestRun(tx: Tx, packageId: string): Promise<number | null> {
    const row = (
      await tx
        .select({ runNo: sql<number | null>`max(${finding.runNo})` })
        .from(finding)
        .where(eq(finding.packageId, packageId))
    )[0];
    return row?.runNo ?? null;
  }

  /** The packages the caller reads, newest period first, each with the counts of its latest QA run. */
  private async rows(
    tx: Tx,
    id?: string,
  ): Promise<(ReportPackageRow & { record: PackageRecord })[]> {
    const rows = await tx
      .select({
        record: pkg,
        clientName: schema.client.name,
        preparerName: preparer.displayName,
        reviewerName: reviewer.displayName,
      })
      .from(pkg)
      .innerJoin(schema.client, eq(schema.client.id, pkg.clientId))
      .innerJoin(preparer, eq(preparer.id, pkg.preparedBy))
      .leftJoin(reviewer, eq(reviewer.id, pkg.reviewerId))
      .where(id === undefined ? undefined : eq(pkg.id, id))
      .orderBy(desc(pkg.periodEnd), asc(schema.client.name), asc(pkg.basis), desc(pkg.version));
    if (rows.length === 0) return [];
    const counts = await tx
      .select({
        packageId: finding.packageId,
        runNo: finding.runNo,
        findings: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where not ${finding.passed})::int`,
        overridden: sql<number>`count(*) filter (where ${finding.overrideReason} is not null)::int`,
      })
      .from(finding)
      .where(
        inArray(
          finding.packageId,
          rows.map((r) => r.record.id),
        ),
      )
      .groupBy(finding.packageId, finding.runNo);
    const latest = new Map<string, (typeof counts)[number]>();
    for (const c of counts) {
      const seen = latest.get(c.packageId);
      if (seen === undefined || c.runNo > seen.runNo) latest.set(c.packageId, c);
    }
    return rows.map(({ record, clientName, preparerName, reviewerName }) => {
      const qa = latest.get(record.id);
      return {
        record,
        id: record.id,
        client: { id: record.clientId, name: clientName },
        periodEnd: record.periodEnd,
        asOf: record.asOf,
        basis: record.basis,
        label: record.label,
        version: record.version,
        state: record.state,
        preparedBy: { id: record.preparedBy, name: preparerName },
        reviewer: person(record.reviewerId, reviewerName),
        approvedAt: iso(record.approvedAt),
        releasedAt: iso(record.releasedAt),
        qa: {
          runNo: qa?.runNo ?? null,
          findings: qa?.findings ?? 0,
          failed: qa?.failed ?? 0,
          overridden: qa?.overridden ?? 0,
        },
        rowVersion: record.rowVersion,
      };
    });
  }

  private async loadDetail(tx: Tx, id: string): Promise<ReportPackageDetail> {
    const found = (await this.rows(tx, id))[0];
    if (found === undefined) throw new ProblemError(404, 'not-found', NOT_FOUND);
    const { record, ...row } = found;
    const releasedBy =
      record.releasedBy === null
        ? null
        : ((
            await tx
              .select({ id: releaser.id, name: releaser.displayName })
              .from(releaser)
              .where(eq(releaser.id, record.releasedBy))
          )[0] ?? null);
    const findingRows =
      row.qa.runNo === null
        ? []
        : await tx
            .select({ row: finding, approverName: overrider.displayName })
            .from(finding)
            .leftJoin(overrider, eq(overrider.id, finding.approverId))
            .where(and(eq(finding.packageId, id), eq(finding.runNo, row.qa.runNo)))
            .orderBy(asc(finding.passed), asc(finding.rule), asc(finding.entityRef));
    const findings: QaFindingRow[] = findingRows.map(({ row: f, approverName }) => ({
      id: f.id,
      runNo: f.runNo,
      rule: f.rule,
      entityRef: f.entityRef,
      expected: f.expected,
      actual: f.actual,
      passed: f.passed,
      detail: f.detail,
      override:
        f.overrideReason === null || f.approverId === null || f.overriddenAt === null
          ? null
          : {
              reason: f.overrideReason,
              approver: { id: f.approverId, name: approverName ?? '' },
              at: f.overriddenAt.toISOString(),
            },
    }));
    const content = record.content === null ? null : reportPackageContent.parse(record.content);
    return {
      ...row,
      correctionReason: record.correctionReason,
      contentHash: record.contentHash,
      releasedBy,
      content,
      findings,
      tieOutExplanations: record.tieOutExplanations as Record<string, string>,
    };
  }
}
