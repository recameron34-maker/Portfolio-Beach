import { existsSync, readFileSync } from 'node:fs';
import type { SyntheticDataset } from '@pb/db';
import { syntheticDatasetSchema } from '@pb/db';
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
        r.entity !== 'investment' || ids.investments.has(r.entityId),
        `wall ${w.name}: unknown record`,
      );
  }
  const entryCounts = new Map<string, number>();
  for (const q of d.quarterlyPerformance.filter((x) => x.isEntrySnapshot))
    entryCounts.set(q.investmentId, (entryCounts.get(q.investmentId) ?? 0) + 1);
  for (const [inv, n] of entryCounts) must(n === 1, `investment ${inv} has ${n} entry snapshots`);

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
  return { ok: problems.length === 0, problems, counts };
}
