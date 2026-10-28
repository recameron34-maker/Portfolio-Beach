import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { loadSyntheticDataset, withUserContext } from '@pb/db';
import { createTestDb } from '@pb/db/testing';
import { D, addMonths, daysBetween, isQuarterEnd, xirr } from '@pb/calc';
import {
  BANK_NAMES,
  CONTROL_SCENARIOS,
  PIPELINE_STAGE_COUNTS,
  WIRE_COUNTERPARTY_CAP,
  controlsConfig,
  diligenceTemplateFor,
} from './controls.js';
import { generateDataset } from './generate.js';
import { DATA_SCENARIOS } from './profiles.js';
import { verifyDataset } from './verify.js';

describe('synthetic generator', () => {
  const small = generateDataset({ profile: 'small', seed: 42 });

  it('is deterministic: the same seed produces byte-identical output', () => {
    const again = generateDataset({ profile: 'small', seed: 42 });
    expect(JSON.stringify(again)).toBe(JSON.stringify(small));
    const other = generateDataset({ profile: 'small', seed: 43 });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(small));
  });

  it('passes its own consistency checks and carries every data-level scenario', () => {
    const report = verifyDataset(small);
    expect(report.problems).toEqual([]);
    for (const s of DATA_SCENARIOS) expect(small.scenarios[s]?.length ?? 0, s).toBeGreaterThan(0);
  });

  it('produces the small profile volumes with credit, CV and co-invest positions', () => {
    expect(small.investments.length).toBe(20);
    expect(
      small.investments.filter((i) => i.dealType === 'deal_type.private_credit').length,
    ).toBeGreaterThan(0);
    expect(
      small.investments.filter((i) => i.dealType.startsWith('deal_type.cv_')).length,
    ).toBeGreaterThan(0);
    expect(small.vehicles.length).toBe(7);
    expect(small.clients.length).toBe(3);
    expect(small.creditTerms.length).toBe(
      small.investments.filter((i) => i.dealType === 'deal_type.private_credit').length,
    );
  });

  it('builds the multiple_irr scenario so XIRR reports two roots', () => {
    const [invId] = small.scenarios.multiple_irr ?? [];
    const flows = small.cashFlows
      .filter((f) => f.investmentId === invId)
      .map((f) => ({ date: f.flowDate, amount: f.amount }));
    const r = xirr(flows);
    expect(r.value).toBeNull();
    expect(r.reason).toBe('multiple_irr');
  });

  it('stamps realization outlooks from the dataset dates, never the wall clock', () => {
    // The last quarter end before the as-of date, at noon UTC.
    expect(small.realizationOutlooks.length).toBeGreaterThan(0);
    for (const o of small.realizationOutlooks) expect(o.setAt).toBe('2025-03-31T12:00:00Z');
    const earlier = generateDataset({ profile: 'small', seed: 42, asOf: '2024-12-31' });
    expect(earlier.realizationOutlooks.length).toBeGreaterThan(0);
    for (const o of earlier.realizationOutlooks) expect(o.setAt).toBe('2024-09-30T12:00:00Z');
  });

  it('keeps a nearer quarter but not the exact prior-year quarter for missing_prior_year', () => {
    const [invId] = small.scenarios.missing_prior_year ?? [];
    const rows = small.quarterlyPerformance
      .filter((q) => q.investmentId === invId && !q.isEntrySnapshot)
      .map((q) => q.periodEnd)
      .sort();
    const latest = rows[rows.length - 1]!;
    const wanted = `${Number(latest.slice(0, 4)) - 1}${latest.slice(4)}`;
    expect(rows).not.toContain(wanted);
    expect(rows.length).toBeGreaterThan(2);
  });

  it('loads into the database, resolves every link, and hides the walled deal from non-members', async () => {
    const handle = await createTestDb();
    try {
      const counts = await loadSyntheticDataset(handle, small);
      expect(counts.investments).toBe(20);
      // Re-seeding is a no-op.
      const again = await loadSyntheticDataset(handle, small);
      expect(again.investments).toBe(20);
      const total = await handle.query<{ n: number }>(
        'select count(*)::int as n from core.investment',
      );
      expect(total[0]?.n).toBe(20);

      // M1 acceptance: every active investment resolves Investment > Vehicle > Sponsor Fund > Sponsor.
      const orphans = await handle.query<{ n: number }>(`
        select count(*)::int as n from core.investment i
        left join core.vehicle v on v.id = i.vehicle_id
        left join core.sponsor_fund f on f.id = i.sponsor_fund_id
        left join core.sponsor s on s.id = i.sponsor_id
        where i.is_active and (v.id is null or f.id is null or s.id is null)`);
      expect(orphans[0]?.n).toBe(0);

      const [walledId] = small.scenarios.walled_deal ?? [];
      const viewer = small.users.find((u) => u.roles.includes('viewer'))!;
      const member = small.users.find((u) => u.externalId === 'deal.three')!;
      const seen = async (userId: string, roles: typeof viewer.roles) =>
        withUserContext(handle.db, { userId, roles }, async (tx) => {
          const r = await tx.execute<{ n: number }>(
            sql`select count(*)::int as n from core.investment where id = ${walledId}`,
          );
          return r.rows[0]?.n ?? -1;
        });
      expect(await seen(viewer.id, viewer.roles)).toBe(0);
      expect(await seen(member.id, member.roles)).toBe(1);

      // Business timestamps are written from the dataset, so set_at never falls back to now().
      const outlooks = await handle.query<{ id: string; set_at: string }>(
        `select id, to_char(set_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as set_at
         from mon.realization_outlook`,
      );
      expect(new Map(outlooks.map((r) => [r.id, r.set_at]))).toEqual(
        new Map(small.realizationOutlooks.map((o) => [o.id, o.setAt])),
      );

      // Client look-through: ownership per closed vehicle sums to 100%.
      const sums = await handle.query<{ name: string; total: string }>(
        'select v.name, sum(l.ownership_pct)::text as total from core.lp_commitment l join core.vehicle v on v.id = l.vehicle_id group by v.name',
      );
      for (const s of sums) expect(Number(s.total)).toBeCloseTo(1, 6);
    } finally {
      await handle.close();
    }
  });

  it('generates the default profile within the documented volumes', () => {
    const d = generateDataset({ profile: 'default', seed: 7 });
    const report = verifyDataset(d);
    expect(report.problems).toEqual([]);
    expect(d.investments.length).toBe(200);
    expect(d.sponsors.length).toBe(40);
    expect(d.capitalNotices.length).toBeGreaterThan(600);
    expect(d.valuations.length).toBeGreaterThan(1000);
    // The pipeline is the same twelve deals in every profile, plus one Closed opportunity per investment.
    const pipeline = Object.values(PIPELINE_STAGE_COUNTS).reduce((a, b) => a + b, 0);
    expect(d.opportunities.length).toBe(d.investments.length + pipeline);
    expect(d.closings.length).toBe(d.investments.length + 1);
  });
});

describe('the Phase 3 controls (docs/14 section 10)', () => {
  const small = generateDataset({ profile: 'small', seed: 42 });
  const config = controlsConfig();
  const user = (externalId: string) => small.users.find((u) => u.externalId === externalId)!.id;
  const historyOf = (opportunityId: string) =>
    small.opportunityStageHistory.filter((h) => h.opportunityId === opportunityId);
  const scenarioId = (tag: string) => small.scenarios[tag]?.[0] ?? '';
  const opportunity = (id: string) => small.opportunities.find((o) => o.id === id)!;
  const sum = (values: readonly string[]) =>
    values.reduce((s, v) => s.plus(D(v)), D('0')).toFixed(2);
  const endOfAsOf = `${small.asOf}T23:59:59Z`;
  type Notice = (typeof small.capitalNotices)[number];
  const fundOf = (n: Notice): string | null =>
    n.investmentId !== null
      ? small.investments.find((i) => i.id === n.investmentId)!.sponsorFundId
      : (small.commitments.find((c) => c.id === n.commitmentId)?.sponsorFundId ?? null);

  it('carries every control scenario tag', () => {
    for (const s of CONTROL_SCENARIOS)
      expect(small.scenarios[s]?.length ?? 0, s).toBeGreaterThan(0);
    expect(small.scenarios.passed_deal).toHaveLength(2);
  });

  it('builds the pipeline with the documented count per stage plus one Closed opportunity per investment', () => {
    const counts: Record<string, number> = {};
    for (const o of small.opportunities) counts[o.stage] = (counts[o.stage] ?? 0) + 1;
    expect(counts).toEqual({ ...PIPELINE_STAGE_COUNTS, Closed: small.investments.length });
    const closed = small.opportunities.filter((o) => o.stage === 'Closed');
    expect(new Set(closed.map((o) => o.investmentId)).size).toBe(small.investments.length);
    expect(new Set(small.opportunities.map((o) => o.id)).size).toBe(small.opportunities.length);
    for (const o of small.opportunities) {
      if (o.stage !== 'Closed') expect(o.investmentId).toBeNull();
      expect(o.receivedDate <= small.asOf).toBe(true);
      expect(o.dealType.startsWith('deal_type.')).toBe(true);
      expect(small.sponsors.some((s) => s.id === o.sponsorId)).toBe(true);
      if (o.stage === 'Passed') expect(o.passReasonCode).not.toBeNull();
      else expect(o.passReasonCode).toBeNull();
    }
  });

  it('writes a stage history from Sourced to the stage, spaced by the aging config and dated from the as-of date', () => {
    for (const o of small.opportunities) {
      const rows = historyOf(o.id);
      expect(rows[0]).toMatchObject({ fromStage: null, toStage: 'Sourced', command: 'create' });
      expect(rows[rows.length - 1]!.toStage).toBe(o.stage);
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.fromStage).toBe(rows[i - 1]!.toStage);
      expect(rows[0]!.changedAt.slice(0, 10)).toBe(o.receivedDate);
      for (const r of rows) expect(r.changedAt <= endOfAsOf).toBe(true);
    }
    const ic = historyOf(scenarioId('ic_pending'));
    expect(ic.map((r) => r.toStage)).toEqual([
      'Sourced',
      'Screening',
      'Prescreen',
      'Diligence',
      'IC',
    ]);
    const day = (r: { changedAt: string }) => r.changedAt.slice(0, 10);
    expect(Math.abs(daysBetween(day(ic[0]!), day(ic[1]!)))).toBe(
      Math.round(config.stageAgingDays.Sourced * 0.6),
    );
    expect(Math.abs(daysBetween(day(ic[3]!), day(ic[4]!)))).toBe(
      Math.round(config.stageAgingDays.Diligence * 0.6),
    );
    // Everything is measured back from the as-of date, never the wall clock.
    const earlier = generateDataset({ profile: 'small', seed: 42, asOf: '2024-12-31' });
    const shifted = earlier.opportunities.find((o) => o.scenarioTag === 'ic_pending')!;
    expect(
      Math.abs(
        daysBetween(shifted.receivedDate, opportunity(scenarioId('ic_pending')).receivedDate),
      ),
    ).toBe(Math.abs(daysBetween('2024-12-31', '2025-06-30')));
  });

  it('seeds the scenario opportunities for journey 6 and the closing page', () => {
    const sourced = opportunity(scenarioId('sourced_deal'));
    expect(sourced).toMatchObject({
      stage: 'Sourced',
      ownerId: user('deal.one'),
      scenarioTag: 'sourced_deal',
    });
    const template = diligenceTemplateFor(sourced.dealType, config.diligenceTemplates);
    const sourcedTasks = small.diligenceTasks.filter((t) => t.opportunityId === sourced.id);
    expect(sourcedTasks.map((t) => [t.workstream, t.title, t.requiredForIc])).toEqual(
      template.map((t) => [t.workstream, t.title, t.requiredForIc]),
    );
    for (const t of sourcedTasks)
      expect(t).toMatchObject({ status: 'open', evidenceDocumentId: null, waivedReason: null });

    const closingDeal = opportunity(scenarioId('closing_open'));
    expect(closingDeal.stage).toBe('Closing');
    const record = small.closings.find((c) => c.opportunityId === closingDeal.id)!;
    expect(record).toMatchObject({
      state: 'Open',
      investmentId: null,
      opsConfirmedBy: null,
      opsConfirmedAt: null,
      commitmentAmount: closingDeal.targetCommitment,
    });
    const items = small.closingItems.filter((i) => i.closingId === record.id);
    expect(items.map((i) => [i.itemCode, i.label, i.required])).toEqual(
      config.closingChecklist.map((i) => [i.code, i.label, i.required]),
    );
    expect(items.filter((i) => i.required && i.status === 'open')).toHaveLength(1);
    for (const i of items) {
      if (i.status === 'waived') expect(i.waivedReason).not.toBeNull();
      if (i.status === 'received') expect(i.documentId).not.toBeNull();
    }
    const lines = small.allocations.filter((a) => a.opportunityId === closingDeal.id);
    expect(lines.length).toBeGreaterThan(0);
    expect(sum(lines.map((a) => a.requested))).toBe(record.commitmentAmount);
    expect(sum(lines.map((a) => a.received ?? '0'))).toBe(record.commitmentAmount);
    expect(
      small.icDecisions.filter((d) => d.opportunityId === closingDeal.id).map((d) => d.decision),
    ).toEqual(['approved']);
    const closingTasks = small.diligenceTasks.filter((t) => t.opportunityId === closingDeal.id);
    expect(closingTasks.length).toBeGreaterThan(0);
    for (const t of closingTasks.filter((t) => t.requiredForIc)) expect(t.status).toBe('done');
    const drafts = small.legalTerms.filter((t) => t.closingId === record.id);
    expect(drafts.length).toBeGreaterThan(0);
    for (const t of drafts)
      expect(t).toMatchObject({
        status: 'draft',
        confirmedBy: null,
        confirmedAt: null,
        investmentId: null,
      });

    for (const id of small.scenarios.passed_deal!) {
      const passed = opportunity(id);
      expect(passed.stage).toBe('Passed');
      expect(passed.passReasonCode?.startsWith('pass_reason.')).toBe(true);
      expect(passed.passNote).not.toBeNull();
      const last = historyOf(id).at(-1)!;
      expect(last).toMatchObject({ toStage: 'Passed', command: 'pass' });
      expect(last.fromStage).not.toBeNull();
      expect(last.reason).not.toBeNull();
    }

    const walled = opportunity(scenarioId('walled_opportunity'));
    expect(walled.stage).toBe('Diligence');
    expect(small.walls[0]!.records).toContainEqual({ entity: 'opportunity', entityId: walled.id });
    expect(small.walls[0]!.memberUserIds).toContain(walled.ownerId);

    const pending = opportunity(scenarioId('ic_pending'));
    expect(pending.stage).toBe('IC');
    const pendingTasks = small.diligenceTasks.filter((t) => t.opportunityId === pending.id);
    expect(pendingTasks.length).toBeGreaterThan(0);
    for (const t of pendingTasks.filter((t) => t.requiredForIc)) expect(t.status).toBe('done');
    expect(small.icDecisions.filter((d) => d.opportunityId === pending.id)).toEqual([]);
  });

  it('gives every investment an OpsConfirmed closing at its entry date whose allocations tie out exactly, with confirmed legal terms', () => {
    const multiLp = small.scenarios.lp_second_closing![0]!;
    const walledId = small.scenarios.walled_deal![0]!;
    for (const inv of small.investments) {
      const closing = small.closings.find((c) => c.investmentId === inv.id)!;
      expect(closing.closeDate).toBe(inv.entryDate);
      expect(closing.state).toBe('OpsConfirmed');
      expect(closing.opsConfirmedBy).toBe(user('ops.one'));
      expect(closing.opsConfirmedAt).not.toBeNull();
      const contributions = small.cashFlows
        .filter((f) => f.investmentId === inv.id && f.flowType === 'flow_type.contribution')
        .map((f) => D(f.amount).abs().toFixed(2));
      expect(closing.commitmentAmount).toBe(sum(contributions));
      const opp = opportunity(closing.opportunityId);
      expect(opp).toMatchObject({
        stage: 'Closed',
        investmentId: inv.id,
        portfolioCompanyId: inv.portfolioCompanyId,
        sponsorId: inv.sponsorId,
        sponsorFundId: inv.sponsorFundId,
        dealType: inv.dealType,
        companyName: small.portfolioCompanies.find((c) => c.id === inv.portfolioCompanyId)!.name,
      });
      expect(opp.receivedDate < inv.entryDate).toBe(true);
      // The walled deal's own opportunity sits on the wall too, so the pipeline never leaks it.
      const onWall = small.walls[0]!.records.some(
        (r) => r.entity === 'opportunity' && r.entityId === opp.id,
      );
      expect(onWall).toBe(inv.id === walledId);
      const lines = small.allocations.filter((a) => a.investmentId === inv.id);
      expect(lines.length).toBe(
        inv.vehicleId === multiLp
          ? small.lpCommitments.filter((l) => l.vehicleId === multiLp).length
          : 1,
      );
      for (const a of lines) {
        expect(a.opportunityId).toBeNull();
        expect(a.vehicleId).toBe(inv.vehicleId);
        expect(a.received).toBe(a.requested);
        if (inv.vehicleId === multiLp) expect(a.clientId).not.toBeNull();
        else expect(a.clientId).toBeNull();
      }
      expect(sum(lines.map((a) => a.requested))).toBe(closing.commitmentAmount);
      const terms = small.legalTerms.filter((t) => t.closingId === closing.id);
      expect(terms.length).toBeGreaterThanOrEqual(2);
      expect(terms.length).toBeLessThanOrEqual(3);
      expect(new Set(terms.map((t) => t.termType)).size).toBe(terms.length);
      for (const t of terms) {
        expect(t).toMatchObject({ status: 'confirmed', investmentId: inv.id });
        expect(t.confirmedBy).not.toBeNull();
        expect(t.confirmedAt! <= endOfAsOf).toBe(true);
        expect(t.termType.startsWith('legal_term_type.')).toBe(true);
      }
      expect(small.icDecisions.filter((d) => d.opportunityId === opp.id)).toHaveLength(1);
      const tasks = small.diligenceTasks.filter((t) => t.opportunityId === opp.id);
      expect(tasks.length).toBeGreaterThan(0);
      for (const t of tasks) expect(t.status).toBe('done');
    }
    expect(
      small.allocations.filter((a) => a.vehicleId === multiLp && a.investmentId !== null).length,
    ).toBeGreaterThan(0);
  });

  it('keeps one Verified, active instruction per calling sponsor fund (at most eight), with a callback by a second person', () => {
    const verified = small.wireInstructions.filter((w) => w.state === 'Verified');
    expect(verified.length).toBeGreaterThan(0);
    expect(verified.length).toBeLessThanOrEqual(WIRE_COUNTERPARTY_CAP);
    const activeKeys = small.wireInstructions
      .filter((w) => w.active)
      .map((w) => `${w.sponsorFundId}|${w.investmentId}`);
    expect(new Set(activeKeys).size).toBe(activeKeys.length);
    const callingFunds = new Set(
      small.capitalNotices
        .filter((n) => n.noticeType === 'notice_type.capital_call')
        .map((n) => fundOf(n)),
    );
    for (const w of small.wireInstructions) {
      expect((w.sponsorFundId === null) !== (w.investmentId === null)).toBe(true);
      expect(w.callbackBy === null || w.callbackBy !== w.proposedBy).toBe(true);
      expect(w.bankDetails.accountNumber).toMatch(/^\d{10}$/);
      expect(w.bankDetails.routingCode).toMatch(/^\d{9}$/);
      expect(w.bankDetails.accountName).toBe(w.counterpartyName);
      expect(BANK_NAMES).toContain(w.bankDetails.bankName);
      expect(w.proposedAt <= endOfAsOf).toBe(true);
      expect(callingFunds.has(w.sponsorFundId)).toBe(true);
      expect(w.counterpartyName).toBe(
        small.sponsorFunds.find((f) => f.id === w.sponsorFundId)!.name,
      );
      if (w.state === 'Verified') {
        expect(w).toMatchObject({
          proposedBy: user('ops.one'),
          callbackBy: user('ops.two'),
          callbackNumberSource: 'prior_instruction',
          callbackResult: 'confirmed',
          active: true,
          rejectionReason: null,
        });
        expect(w.verifiedAt).not.toBeNull();
        expect(w.callbackAt! > w.proposedAt).toBe(true);
      }
    }
  });

  it('turns the wire_change notice into a proposed second version, a drafted ticket and both alerts', () => {
    const notice = small.capitalNotices.find((n) => n.scenarioTag === 'wire_change')!;
    expect(notice).toMatchObject({ urgencyFlag: true, wireChangeFlag: true });
    for (const n of small.capitalNotices)
      if (n.id !== notice.id)
        expect(n).toMatchObject({ urgencyFlag: false, wireChangeFlag: false });
    const fundId = fundOf(notice);
    const versions = small.wireInstructions
      .filter((w) => w.sponsorFundId === fundId)
      .sort((a, b) => a.version - b.version);
    expect(versions.map((w) => [w.version, w.state, w.active])).toEqual([
      [1, 'Verified', true],
      [2, 'Proposed', false],
    ]);
    const [v1, v2] = versions as [(typeof versions)[number], (typeof versions)[number]];
    expect(v2).toMatchObject({
      proposedBy: user('ops.one'),
      sourceNote: 'Changed instructions received in the notice',
      callbackBy: null,
      callbackAt: null,
      callbackNumberSource: null,
      callbackResult: null,
      verifiedAt: null,
      rejectionReason: null,
    });
    expect(v2.proposedAt.startsWith(small.asOf)).toBe(true);
    expect(v2.bankDetails.accountNumber).not.toBe(v1.bankDetails.accountNumber);
    const ticket = small.tradeTickets.find((t) => t.capitalNoticeId === notice.id)!;
    expect(ticket).toMatchObject({
      state: 'Drafted',
      amount: notice.amount,
      fundingDate: notice.dueDate,
      preparedBy: user('ops.one'),
      wireInstructionId: null,
      approvedBy: null,
      approvedAt: null,
      currency: 'USD',
    });
    expect(ticket.preparedAt.startsWith(small.asOf)).toBe(true);
  });

  it('funds every reconciled capital call of a verified counterparty through a ticket approved by a different person', () => {
    const active = new Map(
      small.wireInstructions.filter((w) => w.active).map((w) => [w.sponsorFundId, w]),
    );
    const funded = small.tradeTickets.filter((t) => t.state === 'Funded');
    expect(funded.length).toBeGreaterThan(0);
    const expected = small.capitalNotices.filter(
      (n) =>
        n.noticeType === 'notice_type.capital_call' &&
        n.state === 'Reconciled' &&
        active.has(fundOf(n)),
    );
    expect(funded.map((t) => t.capitalNoticeId).sort()).toEqual(expected.map((n) => n.id).sort());
    expect(new Set(small.tradeTickets.map((t) => t.capitalNoticeId)).size).toBe(
      small.tradeTickets.length,
    );
    for (const t of small.tradeTickets) {
      const notice = small.capitalNotices.find((n) => n.id === t.capitalNoticeId)!;
      expect(t.amount).toBe(notice.amount);
      expect(t.fundingDate).toBe(notice.dueDate);
      expect(t.approvedBy === null || t.approvedBy !== t.preparedBy).toBe(true);
      expect(t.preparedAt <= endOfAsOf).toBe(true);
      if (t.state === 'Funded') {
        expect(t.preparedBy).toBe(user('ops.one'));
        expect(t.approvedBy).toBe(user('head.one'));
        const instruction = active.get(fundOf(notice))!;
        expect(t.wireInstructionId).toBe(instruction.id);
        expect(t.approvedAt).not.toBeNull();
        expect(t.approvedAt! > instruction.verifiedAt!).toBe(true);
        expect(t.approvedAt! <= endOfAsOf).toBe(true);
      }
    }
  });

  it('seeds six change requests on active positions, one per state plus one more Applied, inside the last two quarters', () => {
    const counts: Record<string, number> = {};
    for (const r of small.changeRequests) counts[r.state] = (counts[r.state] ?? 0) + 1;
    expect(counts).toEqual({ Submitted: 1, Routed: 1, InProgress: 1, Applied: 2, Rejected: 1 });
    const walledId = small.scenarios.walled_deal![0];
    const floor = addMonths(small.asOf, -6);
    for (const r of small.changeRequests) {
      const inv = small.investments.find((i) => i.id === r.investmentId)!;
      expect(inv.isActive).toBe(true);
      expect(inv.id).not.toBe(walledId);
      expect(r.changeType.startsWith('change_type.')).toBe(true);
      expect(r.submittedBy).toBe(user('deal.one'));
      expect(r.effectiveDate >= floor && r.effectiveDate <= small.asOf).toBe(true);
      expect(r.ownerId).toBe(r.state === 'Submitted' ? null : user('ops.one'));
      expect(r.summary.length).toBeGreaterThan(3);
      if (r.state === 'Applied') {
        expect(r.appliedBy).toBe(user('ops.one'));
        expect(isQuarterEnd(r.appliedPeriod!)).toBe(true);
        expect(r.appliedPeriod! <= small.asOf).toBe(true);
        expect(r.appliedAt! <= endOfAsOf).toBe(true);
      } else {
        expect(r.appliedPeriod).toBeNull();
        expect(r.appliedBy).toBeNull();
        expect(r.appliedAt).toBeNull();
      }
      expect(r.rejectionReason === null).toBe(r.state !== 'Rejected');
    }
    expect(new Set(small.changeRequests.map((r) => r.investmentId)).size).toBe(6);
    const open = small.changeRequests.find((r) => r.state === 'InProgress')!;
    expect(small.scenarios.change_request_open).toEqual([open.id]);
  });

  it('keeps account numbers inside the bank details and account-like digit runs out of free text', () => {
    const withoutBankDetails = JSON.stringify({
      ...small,
      wireInstructions: small.wireInstructions.map(({ bankDetails: _bank, ...w }) => w),
    });
    for (const w of small.wireInstructions) {
      expect(withoutBankDetails).not.toContain(w.bankDetails.accountNumber);
      expect(withoutBankDetails).not.toContain(w.bankDetails.routingCode);
    }
    const freeText = [
      ...small.opportunities.flatMap((o) => [o.name, o.companyName, o.source, o.passNote]),
      ...small.diligenceTasks.flatMap((t) => [t.title, t.waivedReason]),
      ...small.closingItems.flatMap((i) => [i.label, i.waivedReason]),
      ...small.icDecisions.flatMap((d) => d.conditions),
      ...small.changeRequests.flatMap((r) => [
        r.summary,
        r.rejectionReason,
        ...Object.values(r.details),
      ]),
      ...small.wireInstructions.flatMap((w) => [
        w.sourceNote,
        w.rejectionReason,
        w.counterpartyName,
      ]),
      ...small.legalTerms.flatMap((t) => Object.values(t.value).map(String)),
    ];
    for (const text of freeText) if (text !== null) expect(text).not.toMatch(/\d{6,}/);
  });

  it('reports the control rules verify.ts checks when a dataset breaks them', () => {
    const clone = () => JSON.parse(JSON.stringify(small)) as typeof small;
    const problems = (d: typeof small) => verifyDataset(d).problems.join('\n');

    const sameApprover = clone();
    const funded = sameApprover.tradeTickets.find((t) => t.state === 'Funded')!;
    funded.approvedBy = funded.preparedBy;
    expect(problems(sameApprover)).toMatch(/preparer/);

    const selfCallback = clone();
    const v = selfCallback.wireInstructions.find((w) => w.state === 'Verified')!;
    v.callbackBy = v.proposedBy;
    expect(problems(selfCallback)).toMatch(/callback/);

    const offByACent = clone();
    const line = offByACent.allocations.find((a) => a.investmentId !== null)!;
    line.requested = D(line.requested).plus(D('0.01')).toFixed(2);
    expect(problems(offByACent)).toMatch(/tie/);

    const closedWithoutInvestment = clone();
    closedWithoutInvestment.opportunities.find((o) => o.stage === 'Closed')!.investmentId = null;
    expect(problems(closedWithoutInvestment)).toMatch(/Closed/);

    const twoActive = clone();
    twoActive.wireInstructions.find((w) => w.state === 'Proposed')!.active = true;
    expect(problems(twoActive)).toMatch(/active/);

    const brokenChain = clone();
    const rows = brokenChain.opportunityStageHistory.filter(
      (h) => h.opportunityId === scenarioId('ic_pending'),
    );
    rows[2]!.fromStage = 'Sourced';
    expect(problems(brokenChain)).toMatch(/history/);
  });
});
