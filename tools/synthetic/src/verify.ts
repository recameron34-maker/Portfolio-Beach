import { existsSync, readFileSync } from 'node:fs';
import { D, isQuarterEnd } from '@pb/calc';
import type { SyntheticDataset } from '@pb/db';
import { syntheticDatasetSchema } from '@pb/db';
import { controlsOf } from './controls.js';
import type { Allocation, ControlsDataset, OpportunityStageHistory } from './controls.js';
import { DATA_SCENARIOS } from './profiles.js';

export interface VerifyReport {
  ok: boolean;
  problems: string[];
  counts: Record<string, number>;
}

/**
 * Consistency checks (docs/14 section 1): the contract validates, every reference resolves,
 * ownership sums to 100% per closed vehicle, cash flows and valuations point at real
 * investments, every data-level scenario is present, and no generated name hits the local
 * deny-list.
 */
export function verifyDataset(
  raw: unknown,
  denyListPath = 'config/local/denylist.txt',
): VerifyReport {
  const problems: string[] = [];
  const parsed = syntheticDatasetSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`),
      counts: {},
    };
  }
  const d: SyntheticDataset = parsed.data;
  // The control arrays (docs/14 section 10) as the dataset carries them: a seed schema from before
  // their tables strips them on parse, so they are read from the raw input.
  const controls = controlsOf(raw);
  const ids = {
    users: new Set(d.users.map((u) => u.id)),
    sponsors: new Set(d.sponsors.map((s) => s.id)),
    funds: new Set(d.sponsorFunds.map((f) => f.id)),
    companies: new Set(d.portfolioCompanies.map((c) => c.id)),
    vehicles: new Set(d.vehicles.map((v) => v.id)),
    investments: new Set(d.investments.map((i) => i.id)),
    clients: new Set(d.clients.map((c) => c.id)),
    commitments: new Set(d.commitments.map((c) => c.id)),
    notices: new Set(d.capitalNotices.map((n) => n.id)),
  };
  const must = (ok: boolean, message: string): void => {
    if (!ok) problems.push(message);
  };

  for (const f of d.sponsorFunds)
    must(ids.sponsors.has(f.sponsorId), `fund ${f.name} has no sponsor`);
  for (const i of d.investments) {
    must(ids.vehicles.has(i.vehicleId), `${i.investmentNumber}: unknown vehicle`);
    must(ids.companies.has(i.portfolioCompanyId), `${i.investmentNumber}: unknown company`);
    must(ids.sponsors.has(i.sponsorId), `${i.investmentNumber}: unknown sponsor`);
    must(
      i.sponsorFundId === null || ids.funds.has(i.sponsorFundId),
      `${i.investmentNumber}: unknown fund`,
    );
    must(
      i.exitDate === null || i.exitDate >= i.entryDate,
      `${i.investmentNumber}: exit before entry`,
    );
    must(
      i.isActive === (i.exitDate === null),
      `${i.investmentNumber}: active flag and exit date disagree`,
    );
  }
  for (const c of d.commitments)
    must(
      ids.vehicles.has(c.vehicleId) && ids.funds.has(c.sponsorFundId),
      'commitment with unknown vehicle or fund',
    );
  // Nothing has happened after the dataset's as-of date: no notice issued, no cash flow paid.
  for (const n of d.capitalNotices)
    must(n.issueDate <= d.asOf, `notice ${n.id} is issued after the as-of date`);
  for (const f of d.cashFlows)
    must(f.flowDate <= d.asOf, `cash flow ${f.id} is dated after the as-of date`);
  for (const l of d.lpCommitments)
    must(
      ids.clients.has(l.clientId) && ids.vehicles.has(l.vehicleId),
      'lp commitment with unknown client or vehicle',
    );
  for (const v of d.vehicles) {
    if (v.finalCloseDate === null) continue;
    const sum = d.lpCommitments
      .filter((l) => l.vehicleId === v.id)
      .reduce((s, l) => s + Number(l.ownershipPct ?? '0'), 0);
    must(Math.abs(sum - 1) < 1e-6, `${v.name}: ownership sums to ${sum.toFixed(6)}, not 1`);
  }
  for (const q of d.quarterlyPerformance)
    must(ids.investments.has(q.investmentId), 'quarterly row with unknown investment');
  for (const v of d.valuations) {
    must(ids.investments.has(v.investmentId), 'valuation with unknown investment');
    must(
      v.state !== 'Locked' || (v.lockHash !== null && v.approvedBy !== null),
      'Locked valuation without hash or approver',
    );
    must(
      v.preparedBy === null || v.approvedBy === null || v.preparedBy !== v.approvedBy,
      'valuation preparer equals approver',
    );
  }
  const lockedKeys = new Set<string>();
  for (const v of d.valuations.filter((x) => x.state === 'Locked')) {
    const key = `${v.investmentId}|${v.periodEnd}`;
    must(!lockedKeys.has(key), `two Locked valuations for ${key}`);
    lockedKeys.add(key);
  }
  for (const f of d.cashFlows) {
    must(
      (f.investmentId !== null && ids.investments.has(f.investmentId)) ||
        (f.commitmentId !== null && ids.commitments.has(f.commitmentId)),
      'cash flow with no valid owner',
    );
    const outflow = ['flow_type.contribution', 'flow_type.fee', 'flow_type.expense'].includes(
      f.flowType,
    );
    must(
      outflow ? Number(f.amount) <= 0 : Number(f.amount) >= 0,
      `cash flow ${f.id} has the wrong sign for ${f.flowType}`,
    );
    must(
      f.sourceNoticeId === null || ids.notices.has(f.sourceNoticeId),
      `cash flow ${f.id} points at an unknown notice`,
    );
  }
  for (const t of d.creditTerms)
    must(
      ids.investments.has(t.investmentId) && t.maturityDate > t.effectiveDate,
      'credit terms invalid',
    );
  for (const w of d.walls) {
    for (const m of w.memberUserIds) must(ids.users.has(m), `wall ${w.name}: unknown member`);
    for (const r of w.records)
      must(
        (r.entity !== 'investment' || ids.investments.has(r.entityId)) &&
          (r.entity !== 'opportunity' || controls.opportunities.some((o) => o.id === r.entityId)),
        `wall ${w.name}: unknown record`,
      );
  }
  const entryCounts = new Map<string, number>();
  for (const q of d.quarterlyPerformance.filter((x) => x.isEntrySnapshot))
    entryCounts.set(q.investmentId, (entryCounts.get(q.investmentId) ?? 0) + 1);
  for (const [inv, n] of entryCounts) must(n === 1, `investment ${inv} has ${n} entry snapshots`);

  verifyControls(d, controls, must);

  for (const scenario of DATA_SCENARIOS)
    must((d.scenarios[scenario]?.length ?? 0) > 0, `scenario ${scenario} is missing`);

  // Deny-list scan (docs/10): generated names must never match a real name the owner listed locally.
  if (existsSync(denyListPath)) {
    const terms = readFileSync(denyListPath, 'utf8')
      .split('\n')
      .map((t) => t.replace(/#.*/, '').trim().toLowerCase())
      .filter((t) => t.length > 0);
    const haystack = [
      ...d.sponsors.map((s) => s.name),
      ...d.sponsorFunds.map((f) => f.name),
      ...d.portfolioCompanies.map((c) => c.name),
      ...d.clients.map((c) => c.name),
      ...d.users.map((u) => u.displayName),
    ]
      .join('\n')
      .toLowerCase();
    for (const t of terms)
      must(!haystack.includes(t), 'a generated name matches a deny-list term (term not shown)');
  }

  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(d))
    if (Array.isArray(value)) counts[key] = value.length;
  for (const key of Object.keys(controls) as (keyof ControlsDataset)[])
    counts[key] = controls[key].length;
  return { ok: problems.length === 0, problems, counts };
}

type Must = (ok: boolean, message: string) => void;

/**
 * The Phase 3 controls (docs/14 section 10): every reference resolves, the rules the migration
 * checks hold (a Closed deal names its investment, a Passed one its reason, a Verified instruction
 * its confirming callback by a second person, an approved ticket a different approver), every
 * stage history chains from Sourced to the stage, allocations tie out exactly to every closing's
 * commitment, and nothing happened after the as-of date.
 */
function verifyControls(d: SyntheticDataset, c: ControlsDataset, must: Must): void {
  const users = new Set(d.users.map((u) => u.id));
  const sponsors = new Set(d.sponsors.map((s) => s.id));
  const funds = new Map(d.sponsorFunds.map((f) => [f.id, f]));
  const companies = new Set(d.portfolioCompanies.map((x) => x.id));
  const vehicles = new Set(d.vehicles.map((v) => v.id));
  const clients = new Set(d.clients.map((x) => x.id));
  const investments = new Map(d.investments.map((i) => [i.id, i]));
  const commitments = new Map(d.commitments.map((x) => [x.id, x]));
  const notices = new Map(d.capitalNotices.map((n) => [n.id, n]));
  const opportunities = new Map(c.opportunities.map((o) => [o.id, o]));
  const closings = new Map(c.closings.map((x) => [x.id, x]));
  const instructions = new Map(c.wireInstructions.map((w) => [w.id, w]));
  const knownUser = (id: string | null): boolean => id === null || users.has(id);
  const notAfterAsOf = (instant: string | null): boolean =>
    instant === null || instant.slice(0, 10) <= d.asOf;
  const once = (label: string): ((key: string) => void) => {
    const seen = new Set<string>();
    return (key) => {
      must(!seen.has(key), `${label} repeats ${key}`);
      seen.add(key);
    };
  };

  const investmentOnce = once('opportunity investment');
  for (const o of c.opportunities) {
    const who = `opportunity ${o.name}`;
    must(sponsors.has(o.sponsorId), `${who}: unknown sponsor`);
    must(
      o.sponsorFundId === null || funds.get(o.sponsorFundId)?.sponsorId === o.sponsorId,
      `${who}: fund does not belong to the sponsor`,
    );
    must(
      o.portfolioCompanyId === null || companies.has(o.portfolioCompanyId),
      `${who}: unknown company`,
    );
    must(knownUser(o.ownerId), `${who}: unknown owner`);
    must(o.receivedDate <= d.asOf, `${who}: received after the as-of date`);
    must(
      o.stage !== 'Passed' || (o.passReasonCode?.startsWith('pass_reason.') ?? false),
      `${who}: Passed without a pass reason code`,
    );
    must(o.stage !== 'Closed' || o.investmentId !== null, `${who}: Closed without an investment`);
    if (o.investmentId !== null) {
      must(investments.has(o.investmentId), `${who}: unknown investment`);
      investmentOnce(o.investmentId);
    }
  }

  const historyByOpportunity = new Map<string, OpportunityStageHistory[]>();
  for (const h of c.opportunityStageHistory) {
    must(opportunities.has(h.opportunityId), 'stage history row with unknown opportunity');
    must(users.has(h.changedBy), 'stage history row with unknown actor');
    must(notAfterAsOf(h.changedAt), 'stage history row after the as-of date');
    const rows = historyByOpportunity.get(h.opportunityId) ?? [];
    rows.push(h);
    historyByOpportunity.set(h.opportunityId, rows);
  }
  for (const o of c.opportunities) {
    const rows = historyByOpportunity.get(o.id) ?? [];
    const who = `opportunity ${o.name}`;
    must(
      rows[0]?.fromStage === null && rows[0]?.toStage === 'Sourced',
      `${who}: stage history does not start at Sourced`,
    );
    must(
      rows[rows.length - 1]?.toStage === o.stage,
      `${who}: stage history does not end at ${o.stage}`,
    );
    for (let i = 1; i < rows.length; i++)
      must(rows[i]?.fromStage === rows[i - 1]?.toStage, `${who}: stage history breaks at row ${i}`);
  }

  for (const t of c.diligenceTasks) {
    must(opportunities.has(t.opportunityId), 'diligence task with unknown opportunity');
    must(knownUser(t.ownerId), 'diligence task with unknown owner');
    must(
      t.workstream.startsWith('diligence_workstream.'),
      `diligence task ${t.title}: workstream is not a taxonomy code`,
    );
    must(
      t.status !== 'waived' || t.waivedReason !== null,
      `diligence task ${t.title}: waived without a reason`,
    );
  }

  const decisionOnce = once('IC decision day');
  for (const x of c.icDecisions) {
    must(opportunities.has(x.opportunityId), 'IC decision with unknown opportunity');
    must(users.has(x.recordedBy), 'IC decision with unknown recorder');
    must(x.decisionDate <= d.asOf, 'IC decision after the as-of date');
    decisionOnce(`${x.opportunityId}|${x.decisionDate}`);
  }

  const allocationOnce = once('allocation line');
  const allocationsByOwner = new Map<string, Allocation[]>();
  for (const a of c.allocations) {
    const who = `allocation ${a.id}`;
    must(
      (a.opportunityId === null) !== (a.investmentId === null),
      `${who}: names an opportunity or an investment, never both or neither`,
    );
    must(
      a.opportunityId === null || opportunities.has(a.opportunityId),
      `${who}: unknown opportunity`,
    );
    must(a.investmentId === null || investments.has(a.investmentId), `${who}: unknown investment`);
    must(vehicles.has(a.vehicleId), `${who}: unknown vehicle`);
    must(a.clientId === null || clients.has(a.clientId), `${who}: unknown client`);
    must(
      !D(a.requested).isNegative() && (a.received === null || !D(a.received).isNegative()),
      `${who}: negative amount`,
    );
    const owner = a.investmentId ?? a.opportunityId ?? '';
    allocationOnce(`${owner}|${a.vehicleId}|${a.clientId ?? ''}`);
    const lines = allocationsByOwner.get(owner) ?? [];
    lines.push(a);
    allocationsByOwner.set(owner, lines);
  }

  const closingOpportunityOnce = once('closing opportunity');
  const closingInvestmentOnce = once('closing investment');
  for (const x of c.closings) {
    const who = `closing ${x.id}`;
    must(opportunities.has(x.opportunityId), `${who}: unknown opportunity`);
    closingOpportunityOnce(x.opportunityId);
    if (x.investmentId !== null) {
      must(investments.has(x.investmentId), `${who}: unknown investment`);
      closingInvestmentOnce(x.investmentId);
    }
    must(
      opportunities.get(x.opportunityId)?.investmentId === x.investmentId,
      `${who}: investment differs from its opportunity`,
    );
    must(D(x.commitmentAmount).gt(0), `${who}: commitment must be above zero`);
    must(
      x.state !== 'OpsConfirmed' || (x.opsConfirmedBy !== null && x.opsConfirmedAt !== null),
      `${who}: OpsConfirmed without the confirmation`,
    );
    must(
      knownUser(x.opsConfirmedBy) && notAfterAsOf(x.opsConfirmedAt),
      `${who}: confirmation by an unknown user or after the as-of date`,
    );
    const lines = allocationsByOwner.get(x.investmentId ?? x.opportunityId) ?? [];
    const requested = lines.reduce((s, a) => s.plus(D(a.requested)), D('0'));
    must(
      lines.length > 0 && requested.eq(D(x.commitmentAmount)),
      `${who}: allocations of ${requested.toFixed(2)} do not tie out to the commitment of ${x.commitmentAmount}`,
    );
    if (lines.length > 0 && lines.every((a) => a.received !== null)) {
      const received = lines.reduce((s, a) => s.plus(D(a.received ?? '0')), D('0'));
      must(
        received.eq(D(x.commitmentAmount)),
        `${who}: received allocations of ${received.toFixed(2)} do not tie out to the commitment of ${x.commitmentAmount}`,
      );
    }
  }

  const itemOnce = once('closing item');
  for (const i of c.closingItems) {
    must(closings.has(i.closingId), `closing item ${i.itemCode}: unknown closing`);
    itemOnce(`${i.closingId}|${i.itemCode}`);
    must(
      i.status !== 'received' || i.documentId !== null,
      `closing item ${i.itemCode}: received without a document`,
    );
    must(
      i.status !== 'waived' || i.waivedReason !== null,
      `closing item ${i.itemCode}: waived without a reason`,
    );
  }

  for (const t of c.legalTerms) {
    const who = `legal term ${t.id}`;
    const closing = closings.get(t.closingId);
    must(closing !== undefined, `${who}: unknown closing`);
    must(
      t.investmentId === null ||
        (investments.has(t.investmentId) && closing?.investmentId === t.investmentId),
      `${who}: investment differs from its closing`,
    );
    must(t.termType.startsWith('legal_term_type.'), `${who}: term type is not a taxonomy code`);
    must(
      t.status !== 'confirmed' || (t.confirmedBy !== null && t.confirmedAt !== null),
      `${who}: confirmed without the confirmation`,
    );
    must(
      knownUser(t.confirmedBy) && notAfterAsOf(t.confirmedAt),
      `${who}: confirmation by an unknown user or after the as-of date`,
    );
  }

  const versionOnce = once('wire instruction version');
  const activeOnce = once('active wire instruction for counterparty');
  const digits = /^\d{6,20}$/;
  for (const w of c.wireInstructions) {
    const who = `wire instruction ${w.id}`;
    must(
      (w.sponsorFundId === null) !== (w.investmentId === null),
      `${who}: names a sponsor fund or an investment, never both or neither`,
    );
    must(w.sponsorFundId === null || funds.has(w.sponsorFundId), `${who}: unknown sponsor fund`);
    must(w.investmentId === null || investments.has(w.investmentId), `${who}: unknown investment`);
    must(users.has(w.proposedBy) && knownUser(w.callbackBy), `${who}: unknown proposer or caller`);
    must(
      Number.isInteger(w.version) && w.version >= 1,
      `${who}: version must be a whole number from 1`,
    );
    const counterparty = `${w.sponsorFundId ?? ''}|${w.investmentId ?? ''}`;
    versionOnce(`${counterparty}|${String(w.version)}`);
    must(
      w.callbackBy === null || w.callbackBy !== w.proposedBy,
      `${who}: the callback was made by the proposer (SEC-12.2)`,
    );
    must(
      w.state !== 'Verified' ||
        (w.callbackResult === 'confirmed' && w.callbackBy !== null && w.verifiedAt !== null),
      `${who}: Verified without a confirming callback`,
    );
    must(w.state !== 'Rejected' || w.rejectionReason !== null, `${who}: Rejected without a reason`);
    must(!w.active || w.state === 'Verified', `${who}: active but not Verified`);
    if (w.active) activeOnce(counterparty);
    must(
      digits.test(w.bankDetails.accountNumber) && digits.test(w.bankDetails.routingCode),
      `${who}: account number and routing code must be 6 to 20 digits`,
    );
    must(
      notAfterAsOf(w.proposedAt) && notAfterAsOf(w.callbackAt) && notAfterAsOf(w.verifiedAt),
      `${who}: dated after the as-of date`,
    );
  }

  const fundOfNotice = (n: SyntheticDataset['capitalNotices'][number]): string | null =>
    n.investmentId !== null
      ? (investments.get(n.investmentId)?.sponsorFundId ?? null)
      : n.commitmentId !== null
        ? (commitments.get(n.commitmentId)?.sponsorFundId ?? null)
        : null;
  const ticketOnce = once('trade ticket notice');
  for (const t of c.tradeTickets) {
    const who = `trade ticket ${t.id}`;
    const notice = notices.get(t.capitalNoticeId);
    must(notice !== undefined, `${who}: unknown capital notice`);
    ticketOnce(t.capitalNoticeId);
    const instruction = t.wireInstructionId === null ? null : instructions.get(t.wireInstructionId);
    must(instruction !== undefined, `${who}: unknown wire instruction`);
    must(D(t.amount).gt(0), `${who}: amount must be above zero`);
    must(
      users.has(t.preparedBy) && knownUser(t.approvedBy),
      `${who}: unknown preparer or approver`,
    );
    must(
      t.approvedBy === null || t.approvedBy !== t.preparedBy,
      `${who}: the preparer is the approver (SEC-12.3)`,
    );
    must(
      (t.state !== 'Approved' && t.state !== 'Funded') ||
        (t.approvedBy !== null && t.wireInstructionId !== null),
      `${who}: ${t.state} without an approver and an instruction version`,
    );
    must(
      t.state !== 'Withdrawn',
      `${who}: a withdrawn ticket carries a reason the dataset does not hold`,
    );
    must(
      notAfterAsOf(t.preparedAt) && notAfterAsOf(t.approvedAt),
      `${who}: dated after the as-of date`,
    );
    if (notice !== undefined && instruction !== undefined && instruction !== null)
      must(
        instruction.sponsorFundId === null || instruction.sponsorFundId === fundOfNotice(notice),
        `${who}: the instruction belongs to another counterparty`,
      );
  }

  for (const r of c.changeRequests) {
    const who = `change request ${r.id}`;
    must(investments.has(r.investmentId), `${who}: unknown investment`);
    must(r.changeType.startsWith('change_type.'), `${who}: change type is not a taxonomy code`);
    must(
      users.has(r.submittedBy) && knownUser(r.ownerId) && knownUser(r.appliedBy),
      `${who}: unknown submitter, owner or applier`,
    );
    must(
      !['Routed', 'InProgress', 'Applied'].includes(r.state) || r.ownerId !== null,
      `${who}: ${r.state} without an owner`,
    );
    must(
      r.state !== 'Applied' ||
        (r.appliedPeriod !== null &&
          isQuarterEnd(r.appliedPeriod) &&
          r.appliedBy !== null &&
          r.appliedAt !== null),
      `${who}: Applied without the applied-in quarter end, applier and time`,
    );
    must(r.state !== 'Rejected' || r.rejectionReason !== null, `${who}: Rejected without a reason`);
    must(
      r.effectiveDate <= d.asOf && notAfterAsOf(r.appliedAt),
      `${who}: dated after the as-of date`,
    );
  }
}
