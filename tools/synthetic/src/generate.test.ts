import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { loadSyntheticDataset, withUserContext } from '@pb/db';
import { createTestDb } from '@pb/db/testing';
import { xirr } from '@pb/calc';
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
  });
});
