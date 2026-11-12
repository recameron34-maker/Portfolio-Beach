import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, ZERO, addDays, daysBetween } from '@pb/calc';
import { investmentPage, weeklyReport } from '@pb/contracts';
import type { WeeklyReport } from '@pb/contracts';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

describe('weekly report (M12)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const get = async (who: string, query = ''): Promise<WeeklyReport> =>
    weeklyReport.parse(
      (
        await h
          .http()
          .get(`/api/v1/reports/weekly${query}`)
          .set('authorization', h.as(who))
          .expect(200)
      ).body,
    );
  const walled = (): Set<string> => new Set(h.dataset.scenarios.walled_deal ?? []);
  const visibleActive = () =>
    h.dataset.investments.filter((i) => i.isActive && !walled().has(i.id));

  it('defaults the as-of date from the clock, names the reader and pools the visible active positions', async () => {
    const report = await get('viewer');
    expect(report.asOf).toBe(h.dataset.asOf);
    expect(report.periodEnd).toBe('2025-06-30');
    const reader = h.dataset.users.find((u) => u.externalId === 'viewer.one')!;
    expect(report.preparedFor).toBe(reader.displayName);
    expect(report.summary.activeInvestments).toBe(visibleActive().length);
    expect(report.summary.count).toBe(visibleActive().length);
    // The pooled NAV and invested capital equal the sum of the grid's active rows for the same reader.
    const grid = investmentPage.parse(
      (
        await h
          .http()
          .get(`/api/v1/investments?limit=200&active=true&asOf=${h.dataset.asOf}`)
          .set('authorization', h.as('viewer'))
          .expect(200)
      ).body,
    );
    const sum = (key: 'nav' | 'invested') =>
      grid.items.reduce((acc, i) => (i[key] === null ? acc : acc.plus(i[key])), ZERO);
    expect(D(report.summary.nav!).equals(sum('nav'))).toBe(true);
    expect(D(report.summary.invested!).equals(sum('invested'))).toBe(true);
    expect(report.summary.grossMoic).not.toBeNull();
    expect(report.calcVersion).toBe('0.1.0');
    expect(report.footnotes[report.footnotes.length - 1]).toBe(
      'Figures are gross, before fees and carry.',
    );
  });

  it('honours an explicit as-of date for the period end', async () => {
    const report = await get('viewer', '?asOf=2025-05-15');
    expect(report.asOf).toBe('2025-05-15');
    expect(report.periodEnd).toBe('2025-03-31');
    await h
      .http()
      .get('/api/v1/reports/weekly?asOf=yesterday')
      .set('authorization', h.as('viewer'))
      .expect(400);
  });

  it('applies walls: a wall member sees one more active position, counted on its vehicle', async () => {
    const member = await get('deal.three');
    const viewer = await get('viewer');
    expect(member.summary.activeInvestments).toBe(viewer.summary.activeInvestments + 1);
    const sma = (r: WeeklyReport) =>
      r.byVehicle.find((v) => v.vehicleType === 'vehicle_type.client_sma');
    expect(sma(member)?.count).toBe(sma(viewer)!.count + 1);
    expect(D(sma(member)!.nav!).gt(D(sma(viewer)!.nav!))).toBe(true);
  });

  it('lists one row per vehicle with active positions, sorted by NAV descending', async () => {
    const report = await get('operations');
    const expected = new Set(visibleActive().map((i) => i.vehicleId));
    expect(new Set(report.byVehicle.map((v) => v.vehicleId))).toEqual(expected);
    expect(report.byVehicle.reduce((n, v) => n + v.count, 0)).toBe(
      report.summary.activeInvestments,
    );
    for (let i = 1; i < report.byVehicle.length; i++) {
      const a = report.byVehicle[i - 1]!.nav;
      const b = report.byVehicle[i]!.nav;
      if (a !== null && b !== null) expect(D(a).gte(D(b))).toBe(true);
      if (a === null) expect(b).toBeNull();
    }
    const primary = h.dataset.vehicles.find(
      (v) => v.vehicleType === 'vehicle_type.primary_program',
    )!;
    expect(report.byVehicle.some((v) => v.vehicleId === primary.id)).toBe(false);
    for (const v of report.byVehicle) {
      expect(v.invested).not.toBeNull();
      expect(v.grossMoic).not.toBeNull();
    }
  });

  it('ranks movers by Locked fair value change against the prior quarter end', async () => {
    const report = await get('operations');
    expect(report.movers.length).toBeGreaterThan(0);
    expect(report.movers.length).toBeLessThanOrEqual(5);
    // No mark for the period end (stale) or for the prior quarter end (roll-forward break): not a mover.
    expect(report.movers.map((m) => m.investmentId)).not.toContain(
      h.dataset.scenarios.stale_valuation![0]!,
    );
    expect(report.movers.map((m) => m.investmentId)).not.toContain(
      h.dataset.scenarios.roll_forward_break![0]!,
    );
    for (const m of report.movers) {
      expect(m.priorFairValue).not.toBeNull();
      const expected = D(m.fairValue).minus(m.priorFairValue!).div(m.priorFairValue!);
      expect(D(m.changePct!).toFixed(8)).toBe(expected.toFixed(8));
    }
    for (let i = 1; i < report.movers.length; i++) {
      expect(D(report.movers[i - 1]!.changePct!).gte(D(report.movers[i]!.changePct!))).toBe(true);
    }
    const sentence = report.commentary.paragraphs[2]!;
    expect(sentence).toMatch(
      /^Largest Locked valuation changes from Mar 31, 2025 to Jun 30, 2025: /,
    );
    for (const m of report.movers) expect(sentence).toContain(`(${m.investmentNumber}) `);
  });

  it('treats marks shifted a few days before the quarter end as that quarter', async () => {
    const report = await get('operations');
    const shifted = h.dataset.scenarios.period_end_shift![0]!;
    expect(report.staleValuations.map((s) => s.investmentId)).not.toContain(shifted);
    const mover = report.movers.find((m) => m.investmentId === shifted);
    if (mover !== undefined) expect(mover.periodEnd < '2025-06-30').toBe(true);
  });

  it('flags stale valuations with the configured footnote and both dates', async () => {
    const report = await get('operations');
    const stale = h.dataset.scenarios.stale_valuation![0]!;
    const entry = report.staleValuations.find((s) => s.investmentId === stale);
    expect(entry).toBeDefined();
    expect(entry!.latestLockedPeriodEnd).toBe('2025-03-31');
    expect(entry!.footnote).toBe(
      'Carried at the latest Locked valuation of Mar 31, 2025; no Locked mark for Jun 30, 2025.',
    );
    expect(
      report.footnotes.some(
        (f) =>
          f.startsWith(`${entry!.investmentNumber} ${entry!.companyName}: `) &&
          f.endsWith(entry!.footnote),
      ),
    ).toBe(true);
    expect(report.commentary.paragraphs[3]).toContain(
      `${entry!.companyName} (${entry!.investmentNumber}, carried at Mar 31, 2025)`,
    );
    const numbers = report.staleValuations.map((s) => s.investmentNumber);
    expect(numbers).toEqual([...numbers].sort());
  });

  it('lists capital notices that are open or due within the window, sorted by due date then id', async () => {
    const report = await get('operations');
    const from = addDays(h.dataset.asOf, -30);
    const to = addDays(h.dataset.asOf, 30);
    const expected = h.dataset.capitalNotices
      .filter(
        (n) =>
          (n.state !== 'Reconciled' || (n.dueDate >= from && n.dueDate <= to)) &&
          !(n.investmentId !== null && walled().has(n.investmentId)),
      )
      .map((n) => n.id)
      .sort();
    expect([...report.capitalActivity.map((c) => c.id)].sort()).toEqual(expected);
    const keys = report.capitalActivity.map((c) => `${c.dueDate}|${c.id}`);
    expect(keys).toEqual([...keys].sort());
    for (const c of report.capitalActivity) {
      expect(c.daysToDue).toBe(daysBetween(h.dataset.asOf, c.dueDate));
      expect(c.vehicleName.length).toBeGreaterThan(0);
    }
    const wire = report.capitalActivity.find((c) => c.scenarioTag === 'wire_change');
    expect(wire?.state).toBe('Extracted');
    expect(wire?.daysToDue).toBeGreaterThan(0);
    expect(wire?.investmentNumber).not.toBeNull();
    const prepayment = report.capitalActivity.find((c) => c.scenarioTag === 'credit_prepayment');
    expect(prepayment?.state).toBe('Reviewed');
    expect(prepayment?.settledAmount).toBeNull();
    expect(Object.keys(prepayment!.split).sort()).toEqual(['premium', 'principal']);
    const amortization = report.capitalActivity.find(
      (c) => c.scenarioTag === 'credit_amortization' && c.state === 'Reconciled',
    );
    expect(amortization?.settledAmount).not.toBeNull();
    expect(report.commentary.paragraphs[4]).toMatch(
      /^Capital activity: \d+ notices are open or due within 30 days of Jun 30, 2025, of which \d+ are not yet Reconciled\.$/,
    );
  });

  it('writes template commentary from the figures, with no em dashes and no model call', async () => {
    const report = await get('operations');
    expect(report.commentary.source).toBe('template');
    expect(report.commentary.aiDraft).toBe(false);
    expect(report.commentary.paragraphs.length).toBe(5);
    expect(report.commentary.paragraphs[0]).toMatch(
      /^As of Jun 30, 2025 the portfolio holds \d+ active positions with NAV of \$[\d,]+\.\dM on \$[\d,]+\.\dM invested, a gross MOIC of \d+\.\d\dx\./,
    );
    expect(report.commentary.paragraphs[1]).toMatch(/^NAV by vehicle: /);
    for (const v of report.byVehicle)
      expect(report.commentary.paragraphs[1]).toContain(`${v.vehicleName} $`);
    expect(JSON.stringify(report)).not.toContain(String.fromCharCode(0x2014));
    // Reading the report is not a sensitive read, so nothing is audited.
    const audited = await h.runtime.db.query<{ n: number }>(
      "select count(*)::int as n from audit.event where action like 'report%'",
    );
    expect(audited[0]?.n).toBe(0);
  });
});
