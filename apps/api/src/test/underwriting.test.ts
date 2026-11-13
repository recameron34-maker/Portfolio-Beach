import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D, daysBetween, toDecimalString } from '@pb/calc';
import type { Decimal } from '@pb/calc';
import {
  entryCaseOf,
  investmentDetail,
  investmentValueCreation,
  problemDetails,
  underwritingRead,
} from '@pb/contracts';
import type { UnderwritingCaseVersion, UnderwritingRead } from '@pb/contracts';
import { seededComparison, underwritingTolerances } from '@pb/synthetic';
import { startHarness } from './harness.js';
import type { Harness } from './harness.js';

/*
 * Performance against the sponsor's underwritten base case (docs/04 M9, docs/08 section 11,
 * docs/18 section 13, decision 0022). The read is checked three ways: against the seeded cases
 * and the comparison the synthetic data's own oracle works out from the dataset (never from the
 * database), against the figures the value creation card and the position summary answer for the
 * same date, and rule by rule from the figures the read itself returns.
 */

const str = toDecimalString;
const NO_SUCH_ID = '00000000-0000-4000-8000-00000000abcd';
const EQUITY = [
  'deal_type.co_invest_equity',
  'deal_type.cv_single_asset',
  'deal_type.cv_multi_asset',
];
const path = (id: string, query = ''): string => `/api/v1/investments/${id}/underwriting${query}`;
/** A decimal as its value, so "11.000000" and "11" compare equal; null stays null. */
const num = (value: string | null): string | null => (value === null ? null : D(value).toString());

describe('a position against its underwritten base case: the read (M9, decision 0022)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const asOf = (): string => h.dataset.asOf;
  const tolerances = () => underwritingTolerances(h.runtime.definitions);
  const scenario = (name: string): string => {
    const id = h.dataset.scenarios[name]?.[0];
    if (id === undefined) throw new Error(`the dataset carries no ${name}`);
    return id;
  };
  const walledId = (): string => scenario('walled_deal');
  const idOf = (number: string): string =>
    h.dataset.investments.find((i) => i.investmentNumber === number)!.id;
  const seededCases = (investmentId: string) =>
    (h.dataset.underwritingCases ?? [])
      .filter((c) => c.investmentId === investmentId)
      .sort((a, b) => a.version - b.version);
  /** Someone who can open the position: a wall member for the walled one, a viewer otherwise. */
  const readerOf = (investmentId: string): string =>
    investmentId === walledId() ? 'deal.three' : 'viewer.one';
  const get = (who: string, url: string, requestId = 'req-underwriting') =>
    h.http().get(url).set('authorization', h.as(who)).set('x-request-id', requestId);
  const readFor = async (
    who: string,
    id: string,
    query = `?asOf=${asOf()}`,
    requestId?: string,
  ): Promise<UnderwritingRead> =>
    underwritingRead.parse((await get(who, path(id, query), requestId).expect(200)).body);
  const count = async (sql: string): Promise<number> =>
    (await h.runtime.db.query<{ n: number }>(sql))[0]!.n;
  const equityPositions = () =>
    h.dataset.investments.filter((i) => EQUITY.includes(i.dealType) && i.entryDate <= asOf());

  it('answers every equity position: its versions as recorded and the entry case compared, figure for figure', async () => {
    let compared = 0;
    for (const investment of equityPositions()) {
      const label = investment.investmentNumber;
      const read = await readFor(readerOf(investment.id), investment.id);
      expect(read.asOf, label).toBe(asOf());
      expect(read.form, label).toBe('equity');
      expect(read.thresholds, label).toEqual(tolerances());
      expect(read.calcVersion, label).toBe('0.1.0');

      // The versions are the seeded ones, in full and in version order.
      const seeded = seededCases(investment.id);
      expect(
        read.versions.map((v) => v.version),
        label,
      ).toEqual(seeded.map((c) => c.version));
      read.versions.forEach((v, i) => {
        const c = seeded[i]!;
        expect(
          {
            id: v.id,
            investmentId: v.investmentId,
            form: v.form,
            state: v.state,
            caseDate: v.caseDate,
            plannedExitDate: v.plannedExitDate,
            exitMultiple: num(v.exitMultiple),
            grossMoic: num(v.grossMoic),
            grossIrr: num(v.grossIrr),
            underwrittenYield: v.underwrittenYield,
            annualLossRate: v.annualLossRate,
            currency: v.currency,
            note: v.note,
            revisionReason: v.revisionReason,
            withdrawnReason: v.withdrawnReason,
            source: v.source,
            enteredBy: v.enteredBy.id,
            enteredAt: v.enteredAt,
            confirmedBy: v.confirmedBy?.id ?? null,
            confirmedAt: v.confirmedAt,
          },
          `${label} v${c.version}`,
        ).toEqual({
          id: c.id,
          investmentId: c.investmentId,
          form: 'equity',
          state: c.state,
          caseDate: c.caseDate,
          plannedExitDate: c.plannedExitDate,
          exitMultiple: num(c.exitMultiple),
          grossMoic: num(c.grossMoic),
          grossIrr: num(c.grossIrr),
          underwrittenYield: null,
          annualLossRate: null,
          currency: 'USD',
          note: c.note,
          revisionReason: c.revisionReason,
          withdrawnReason: c.withdrawnReason,
          source: { document: null, page: null, locator: null, note: c.sourceNote },
          enteredBy: c.enteredBy,
          enteredAt: new Date(c.enteredAt).toISOString(),
          confirmedBy: c.confirmedBy,
          confirmedAt: c.confirmedAt === null ? null : new Date(c.confirmedAt).toISOString(),
        });
        expect(
          h.dataset.users.find((u) => u.id === c.enteredBy)?.displayName,
          `${label} v${c.version}`,
        ).toBe(v.enteredBy.name);
        expect(
          v.points.map((p) => [p.periodEnd, num(p.revenueLtm), num(p.ebitdaLtm), num(p.netDebt)]),
          `${label} v${c.version}`,
        ).toEqual(
          [...c.points]
            .sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : 1))
            .map((p) => [p.periodEnd, num(p.revenueLtm), num(p.ebitdaLtm), num(p.netDebt)]),
        );
        expect(v.rowVersion, `${label} v${c.version}`).toBeGreaterThanOrEqual(1);
      });

      // The entry case is compared: the Confirmed version with the earliest case date.
      const entryCase = entryCaseOf(seeded);
      if (entryCase === null) {
        expect(read.comparedVersion, label).toBeNull();
        expect(read.comparison, label).toBeNull();
        expect(read.notCalculable, label).toBe(
          seeded.some((c) => c.state === 'Draft') ? 'draft_only' : 'no_case',
        );
        continue;
      }
      compared += 1;
      expect(read.comparedVersion, label).toBe(entryCase.version);
      expect(read.notCalculable, label).toBeNull();
      expect(read.comparison, label).toEqual(seededComparison(h.dataset, entryCase, tolerances()));
    }
    // Most positions carry a case, and some carry none or only a Draft.
    expect(compared).toBeGreaterThanOrEqual(10);
    expect(compared).toBeLessThan(equityPositions().length);
  });

  it('takes the actual side from the value creation card and the position summary of the same date', async () => {
    for (const investment of equityPositions()) {
      const label = investment.investmentNumber;
      const who = readerOf(investment.id);
      const { comparison } = await readFor(who, investment.id);
      if (comparison === null) continue;
      const card = investmentValueCreation.parse(
        (await get(who, `/api/v1/investments/${investment.id}/value-creation?asOf=${asOf()}`)).body,
      ).position!;
      const summary = investmentDetail.parse(
        (await get(who, `/api/v1/investments/${investment.id}?asOf=${asOf()}`)).body,
      );

      // The quarter and its figures are the card's current quarter.
      expect(comparison.quarter, label).toBe(card.current?.periodEnd ?? null);
      for (const row of comparison.metrics) {
        const field = { ebitda: 'ebitdaLtm', revenue: 'revenueLtm', net_debt: 'netDebt' } as const;
        expect(row.actual, `${label} ${row.metric}`).toBe(
          num(card.current?.[field[row.metric]] ?? null),
        );
      }
      // The bridge earned to date is the card's bridge, driver for driver, and its reason.
      const progress = comparison.valueCreation!;
      expect(progress.actual, label).toEqual(
        card.bridge === null
          ? null
          : {
              ebitdaGrowth: card.bridge.ebitdaGrowth,
              multipleExpansion: card.bridge.multipleExpansion,
              debtPaydown: card.bridge.debtPaydown,
              total: card.bridge.total,
            },
      );
      if (card.bridge === null) expect(progress.notCalculable, label).toBe(card.notCalculable);
      // Our returns are the summary's.
      expect(
        {
          grossMoic: comparison.returns.grossMoic,
          grossIrr: comparison.returns.grossIrr,
          irrFlag: comparison.returns.irrFlag,
        },
        label,
      ).toEqual({
        grossMoic: summary.grossMoic,
        grossIrr: summary.grossIrr,
        irrFlag: summary.irrFlag,
      });
    }
  });

  /** A figure held to the ten places it travels with, as docs/08 section 11 has it. */
  const held = (value: Decimal): string => str(value)!;
  const statusOf = (favourable: string, tolerance: string): string =>
    D(favourable).gt(tolerance)
      ? 'ahead'
      : D(favourable).lt(D(tolerance).neg())
        ? 'behind'
        : 'on_plan';

  /** Rule 1 by hand over the plan points the read returned. */
  function planByHand(
    version: UnderwritingCaseVersion,
    metric: 'ebitda' | 'revenue' | 'net_debt',
    date: string,
  ): { plan: string | null; interpolated: boolean; reason: string | null } {
    const field = { ebitda: 'ebitdaLtm', revenue: 'revenueLtm', net_debt: 'netDebt' } as const;
    const points = version.points;
    const none = (reason: string) => ({ plan: null, interpolated: false, reason });
    const on = points.find((p) => p.periodEnd === date);
    if (on !== undefined) {
      const own = on[field[metric]];
      return own === null
        ? none('missing_plan_figure')
        : { plan: held(D(own)), interpolated: false, reason: null };
    }
    const before = points.filter((p) => p.periodEnd < date).at(-1);
    const after = points.find((p) => p.periodEnd > date);
    if (before === undefined)
      return none(after === undefined ? 'missing_plan_figure' : 'before_plan_start');
    if (after === undefined) return none('past_plan_end');
    const v0 = before[field[metric]];
    const v1 = after[field[metric]];
    if (v0 === null || v1 === null) return none('missing_plan_figure');
    const line = D(v0).plus(
      D(v1)
        .minus(v0)
        .times(daysBetween(before.periodEnd, date))
        .div(daysBetween(before.periodEnd, after.periodEnd)),
    );
    return { plan: held(line), interpolated: true, reason: null };
  }

  it('answers every figure by its rule over the figures returned with it (docs/08 section 11)', async () => {
    const seen = {
      interpolated: 0,
      onPlanDate: 0,
      statuses: new Set<string>(),
      reasons: new Set<string>(),
    };
    for (const investment of equityPositions()) {
      const label = investment.investmentNumber;
      const who = readerOf(investment.id);
      const read = await readFor(who, investment.id);
      const comparison = read.comparison;
      if (comparison === null) continue;
      const version = read.versions.find((v) => v.version === read.comparedVersion)!;
      const { onPlanTolerance, irrTolerance } = read.thresholds;

      // Rules 1 to 3: the plan at the quarter's date, the variance, the percent and the status.
      expect(comparison.metrics.map((m) => m.metric)).toEqual(['ebitda', 'revenue', 'net_debt']);
      for (const row of comparison.metrics) {
        const what = `${label} ${row.metric}`;
        if (comparison.quarter === null) {
          expect(row, what).toMatchObject({
            actual: null,
            plan: null,
            variance: null,
            variancePct: null,
            status: null,
            notCalculable: 'no_current_quarter',
          });
          continue;
        }
        const byHand = planByHand(version, row.metric, comparison.quarter);
        expect({ plan: row.plan, interpolated: row.interpolated }, what).toEqual({
          plan: byHand.plan,
          interpolated: byHand.interpolated,
        });
        if (row.interpolated) seen.interpolated += 1;
        else if (row.plan !== null) seen.onPlanDate += 1;
        if (row.plan === null || row.actual === null) {
          // Never the nearest plan figure and never a zero: nothing, and the reason.
          expect(row, what).toMatchObject({
            variance: null,
            variancePct: null,
            status: null,
            notCalculable: byHand.reason ?? 'missing_actual',
          });
          seen.reasons.add(row.notCalculable!);
          continue;
        }
        expect(row.variance, what).toBe(held(D(row.actual).minus(row.plan)));
        if (!D(row.plan).gt(0)) {
          expect(row, what).toMatchObject({
            variancePct: null,
            status: null,
            notCalculable: 'non_positive_plan',
          });
          seen.reasons.add('non_positive_plan');
          continue;
        }
        expect(row.variancePct, what).toBe(held(D(row.variance!).div(row.plan)));
        const favourable =
          row.metric === 'net_debt' ? held(D(row.variancePct!).neg()) : row.variancePct!;
        expect(row.status, what).toBe(statusOf(favourable, onPlanTolerance));
        expect(row.notCalculable, what).toBeNull();
        seen.statuses.add(row.status!);
      }
      expect(comparison.headline, label).toBe(
        comparison.metrics.find((m) => m.metric === 'ebitda')!.status,
      );

      // The series: the plan at every date by rule 1, and an actual only on an approved quarter.
      for (const series of comparison.series)
        for (const p of series.points) {
          const byHand = planByHand(version, series.metric, p.periodEnd);
          expect({ plan: p.plan, interpolated: p.interpolated }, `${label} ${p.periodEnd}`).toEqual(
            { plan: byHand.plan, interpolated: byHand.interpolated },
          );
          if (comparison.quarter !== null && p.periodEnd > comparison.quarter)
            expect(p.actual, `${label} ${p.periodEnd}`).toBeNull();
        }

      // Rule 4: progress is earned over planned, and time passed runs from the entry snapshot.
      const progress = comparison.valueCreation!;
      if (progress.planned !== null && progress.actual !== null) {
        for (const driver of ['ebitdaGrowth', 'multipleExpansion', 'debtPaydown', 'total'] as const)
          expect(progress.progress![driver], `${label} ${driver}`).toBe(
            D(progress.planned[driver]).gt(0)
              ? held(D(progress.actual[driver]).div(progress.planned[driver]))
              : null,
          );
        expect(progress.planned.total, label).toBe(
          held(
            D(progress.planned.ebitdaGrowth)
              .plus(progress.planned.multipleExpansion)
              .plus(progress.planned.debtPaydown),
          ),
        );
      } else {
        expect(progress.progress, label).toBeNull();
        expect(progress.notCalculable, label).not.toBeNull();
      }
      const card = investmentValueCreation.parse(
        (await get(who, `/api/v1/investments/${investment.id}/value-creation?asOf=${asOf()}`)).body,
      ).position!;
      expect(progress.timePassed, label).toBe(
        card.entry === null || comparison.quarter === null
          ? null
          : held(
              D(String(daysBetween(card.entry.periodEnd, comparison.quarter))).div(
                daysBetween(card.entry.periodEnd, version.plannedExitDate),
              ),
            ),
      );

      // Rule 5: the IRR gap in points and its status; the MOIC gap against the path or the target.
      const returns = comparison.returns;
      expect(returns.irrGap, label).toBe(
        returns.grossIrr === null ? null : held(D(returns.grossIrr).minus(version.grossIrr)),
      );
      expect(returns.irrStatus, label).toBe(
        returns.irrGap === null || returns.irrFlag !== null
          ? null
          : statusOf(returns.irrGap, irrTolerance),
      );
      const held0 = investment.exitDate === null || investment.exitDate > asOf();
      if (!held0) {
        // Realized: against the underwritten MOIC at exit, and no path.
        expect(returns.moicOnPath, label).toBeNull();
        expect(returns.pathNotCalculable, label).toBeNull();
        expect(returns.moicGap, label).toBe(
          returns.grossMoic === null ? null : held(D(returns.grossMoic).minus(version.grossMoic)),
        );
      } else if (asOf() > version.plannedExitDate) {
        expect(returns, label).toMatchObject({
          moicOnPath: null,
          moicGap: null,
          pathNotCalculable: 'past_plan_end',
        });
      } else {
        expect(returns.moicGap, label).toBe(
          returns.grossMoic === null || returns.moicOnPath === null
            ? null
            : held(D(returns.grossMoic).minus(returns.moicOnPath)),
        );
      }
      expect(comparison.yieldToMaturity, label).toBeNull();
    }
    // The seeded book exercises the straight line, a plan date, every status and the reasons.
    expect(seen.interpolated).toBeGreaterThan(0);
    expect([...seen.statuses].sort()).toEqual(['ahead', 'behind', 'on_plan']);
    expect([...seen.reasons].sort()).toEqual(
      expect.arrayContaining(['missing_plan_figure', 'non_positive_plan', 'past_plan_end']),
    );
  });

  it('reads each seeded scenario as the scenario says', async () => {
    const headline = async (name: string) =>
      (await readFor('viewer.one', scenario(name))).comparison?.headline;
    expect(await headline('underwriting_ahead')).toBe('ahead');
    expect(await headline('underwriting_on_plan')).toBe('on_plan');
    expect(await headline('underwriting_behind')).toBe('behind');

    // A plan in net cash: the variance in money stands, the percent and the status do not.
    const netCash = (await readFor('viewer.one', scenario('underwriting_net_cash'))).comparison!;
    const netDebt = netCash.metrics.find((m) => m.metric === 'net_debt')!;
    expect(D(netDebt.plan!).lte(0)).toBe(true);
    expect(netDebt).toMatchObject({
      variancePct: null,
      status: null,
      notCalculable: 'non_positive_plan',
    });
    expect(netDebt.variance).not.toBeNull();

    // A plan date with no net debt: no figure there, and none borrowed from another date.
    const gap = (await readFor('viewer.one', scenario('underwriting_gap'))).comparison!;
    expect(gap.metrics.find((m) => m.metric === 'net_debt')).toMatchObject({
      plan: null,
      variance: null,
      status: null,
      notCalculable: 'missing_plan_figure',
    });
    expect(gap.metrics.find((m) => m.metric === 'ebitda')!.plan).not.toBeNull();

    // A plan that has ended: nothing to compare the quarter with, and no path either.
    const past = (await readFor('viewer.one', scenario('underwriting_past_exit'))).comparison!;
    for (const row of past.metrics)
      expect(row, row.metric).toMatchObject({
        plan: null,
        status: null,
        notCalculable: 'past_plan_end',
      });
    expect(past.headline).toBeNull();
    expect(past.returns).toMatchObject({ moicOnPath: null, pathNotCalculable: 'past_plan_end' });
    // The planned bridge still stands: it runs from entry to the planned exit.
    expect(past.valueCreation!.planned).not.toBeNull();
    expect(D(past.valueCreation!.timePassed!).gt(1)).toBe(true);
  });

  it('compares the entry case unless the reader names another that stands or stood as the plan', async () => {
    // A correction: version 2 replaced version 1, which a reader may still pick.
    const corrected = scenario('underwriting_corrected');
    const now = await readFor('viewer.one', corrected);
    expect(now.versions.map((v) => [v.version, v.state, v.kind])).toEqual([
      [1, 'Superseded', 'entry'],
      [2, 'Confirmed', 'correction'],
    ]);
    expect(now.versions[1]!.revisionReason).not.toBeNull();
    expect(now.comparedVersion).toBe(2);
    const before = await readFor('viewer.one', corrected, `?asOf=${asOf()}&version=1`);
    expect(before.comparedVersion).toBe(1);
    expect(before.versions).toEqual(now.versions);
    expect(before.comparison).toEqual(
      seededComparison(h.dataset, seededCases(corrected)[0]!, tolerances()),
    );
    expect(before.comparison).not.toEqual(now.comparison);

    // A re-underwriting: both stay Confirmed, the entry case is compared, the later one is a pick.
    const again = scenario('underwriting_reunderwritten');
    const entry = await readFor('viewer.one', again);
    expect(entry.versions.map((v) => [v.version, v.state, v.kind])).toEqual([
      [1, 'Confirmed', 'entry'],
      [2, 'Confirmed', 'reunderwrite'],
    ]);
    expect(entry.comparedVersion).toBe(1);
    const picked = await readFor('viewer.one', again, `?asOf=${asOf()}&version=2`);
    expect(picked.comparedVersion).toBe(2);
    expect(picked.comparison).toEqual(
      seededComparison(h.dataset, seededCases(again)[1]!, tolerances()),
    );

    // A Draft alone is not compared (SEC-9.1), and cannot be picked.
    const draft = scenario('underwriting_draft');
    const waiting = await readFor('viewer.one', draft);
    expect(waiting.versions.map((v) => [v.version, v.state, v.confirmedBy])).toEqual([
      [1, 'Draft', null],
    ]);
    expect(waiting).toMatchObject({
      comparedVersion: null,
      comparison: null,
      notCalculable: 'draft_only',
    });
    // A withdrawn case is on record with its reason, and is not compared.
    const withdrawn = scenario('underwriting_withdrawn');
    const gone = await readFor('viewer.one', withdrawn);
    expect(gone.versions.map((v) => v.state)).toEqual(['Withdrawn']);
    expect(gone.versions[0]!.withdrawnReason).not.toBeNull();
    expect(gone).toMatchObject({
      comparedVersion: null,
      comparison: null,
      notCalculable: 'no_case',
    });
    // A position with nothing on record.
    const none = await readFor('viewer.one', idOf('INV-0005'));
    expect(none).toMatchObject({
      form: 'equity',
      versions: [],
      comparedVersion: null,
      comparison: null,
      notCalculable: 'no_case',
    });

    for (const [id, version] of [
      [draft, 1],
      [withdrawn, 1],
      [corrected, 3],
      [idOf('INV-0005'), 1],
    ] as const) {
      const res = await get('viewer.one', path(id, `?asOf=${asOf()}&version=${version}`)).expect(
        404,
      );
      expect(problemDetails.parse(res.body).detail).toBe('Base case version not found');
    }
  });

  it('judges the position as of the date asked for', async () => {
    const id = scenario('underwriting_behind');
    const investment = h.dataset.investments.find((i) => i.id === id)!;
    const earlier = '2023-12-31';
    expect(investment.entryDate < earlier).toBe(true);
    const then = await readFor('viewer.one', id, `?asOf=${earlier}`);
    expect(then.asOf).toBe(earlier);
    expect(then.comparison).toEqual(
      seededComparison({ ...h.dataset, asOf: earlier }, seededCases(id)[0]!, tolerances()),
    );
    expect(then.comparison!.quarter! <= earlier).toBe(true);
    expect(then.comparison).not.toEqual((await readFor('viewer.one', id)).comparison);
    // Without a date the API reads as of its own day.
    expect((await readFor('viewer.one', id, '')).asOf).toBe(asOf());
    // Before we entered, the position does not exist.
    await get('viewer.one', path(id, '?asOf=2000-01-01')).expect(404);

    // A snapshot dated after the as-of date is no basis: the plan has not started.
    const forward = scenario('forward_entry_snapshot');
    const early = await readFor('viewer.one', forward);
    expect(early.comparison!.valueCreation).toMatchObject({
      actual: null,
      timePassed: null,
      notCalculable: 'entry_snapshot_forward_dated',
    });
    for (const row of early.comparison!.metrics)
      if (row.notCalculable !== null)
        expect(['before_plan_start', 'no_current_quarter', 'missing_actual']).toContain(
          row.notCalculable,
        );
  });

  it('is read by anyone who can open the position, and by nobody behind its wall', async () => {
    const open = scenario('underwriting_ahead');
    for (const who of ['viewer.one', 'deal.one', 'ops.one', 'head.one', 'ir.one', 'audit.one'])
      expect((await readFor(who, open)).comparedVersion, who).toBe(1);
    await h.http().get(path(open)).expect(401);

    // The walled position: its members read the case, everyone else is told it does not exist.
    const inside = await readFor('deal.three', walledId());
    expect(inside.versions).toHaveLength(1);
    expect(inside.comparison).not.toBeNull();
    expect((await readFor('head.one', walledId())).comparedVersion).toBe(1);
    for (const who of ['viewer.one', 'deal.one', 'ops.one', 'ir.one', 'audit.one', 'admin.one']) {
      const res = await get(who, path(walledId(), `?asOf=${asOf()}`)).expect(404);
      expect(problemDetails.parse(res.body).detail, who).toBe('Investment not found');
      expect(JSON.stringify(res.body), who).not.toContain('version');
    }
    const unknown = await get('viewer.one', path(NO_SUCH_ID)).expect(404);
    expect(problemDetails.parse(unknown.body).detail).toBe('Investment not found');
    await get('viewer.one', path('not-an-id')).expect(404);
  });

  it('refuses a query it cannot read with the field named, never the value', async () => {
    const id = scenario('underwriting_ahead');
    for (const [query, field] of [
      ['?asOf=2025-02-30', 'asOf'],
      ['?asOf=tomorrow', 'asOf'],
      ['?version=0', 'version'],
      ['?version=first', 'version'],
      ['?version=1.5', 'version'],
      ['?case=1', '(root)'],
    ] as const) {
      const res = await get('viewer.one', path(id, query)).expect(400);
      const problem = problemDetails.parse(res.body);
      expect(problem.type, query).toBe('https://portfolio-beach.example/problems/validation');
      expect(
        problem.errors?.map((e) => e.path),
        query,
      ).toEqual([field]);
      expect(JSON.stringify(res.body), query).not.toMatch(/tomorrow|first|2025-02-30/);
    }
  });

  it('answers no form and nothing else for a position that holds no base case', async () => {
    // A private credit position reads as holding none until its own form is served.
    const loan = h.dataset.investments.find((i) => i.dealType === 'deal_type.private_credit')!;
    const empty = {
      asOf: asOf(),
      form: null,
      versions: [],
      comparedVersion: null,
      comparison: null,
      notCalculable: null,
      thresholds: tolerances(),
      calcVersion: '0.1.0',
    };
    expect(await readFor('viewer.one', loan.id)).toEqual(empty);
    await get('viewer.one', path(loan.id, '?version=1')).expect(404);

    // A primary fund holds none. The small book has no primary fund, so one position is made one
    // for the length of this check, on the owner connection.
    const id = idOf('INV-0017');
    const setType = (dealType: string) =>
      h.runtime.db.query('update core.investment set deal_type = $1 where id = $2', [dealType, id]);
    await setType('deal_type.primary_fund');
    try {
      expect(await readFor('viewer.one', id)).toEqual(empty);
    } finally {
      await setType('deal_type.cv_single_asset');
    }
    expect((await readFor('viewer.one', id)).form).toBe('equity');
  });

  it('writes one audit event per read of the card, and none for a read that is refused', async () => {
    const id = scenario('underwriting_corrected');
    await readFor('viewer.one', id, `?asOf=${asOf()}`, 'req-underwriting-audit-1');
    await readFor('viewer.one', id, `?asOf=${asOf()}&version=1`, 'req-underwriting-audit-2');
    const events = await h.runtime.db.query<{
      action: string;
      entity: string;
      entity_id: string;
      details: { comparedVersion?: number };
      request_id: string;
    }>(
      "select action, entity, entity_id, details, request_id from audit.event where request_id like 'req-underwriting-audit-%' order by request_id",
    );
    expect(events).toEqual([
      {
        action: 'investment.underwriting.read',
        entity: 'core.investment',
        entity_id: id,
        details: { comparedVersion: 2 },
        request_id: 'req-underwriting-audit-1',
      },
      {
        action: 'investment.underwriting.read',
        entity: 'core.investment',
        entity_id: id,
        details: { comparedVersion: 1 },
        request_id: 'req-underwriting-audit-2',
      },
    ]);
    await get('viewer.one', path(walledId()), 'req-underwriting-refused-1').expect(404);
    await get('viewer.one', path(id, '?version=9'), 'req-underwriting-refused-2').expect(404);
    expect(
      await count(
        "select count(*)::int as n from audit.event where request_id like 'req-underwriting-refused-%'",
      ),
    ).toBe(0);
  });

  it('refuses to answer without its tolerances: a 500 that names the key, and nothing on record', async () => {
    const id = scenario('underwriting_ahead');
    const definitions = h.runtime.definitions;
    const kept = definitions.underwriting;
    try {
      for (const [settings, key] of [
        [undefined, 'underwriting.onPlanTolerance'],
        [{ onPlanTolerance: 0.05 }, 'underwriting.irrTolerance'],
        [{ onPlanTolerance: -0.05, irrTolerance: 0.02 }, 'underwriting.onPlanTolerance'],
        [{ onPlanTolerance: 0.05, irrTolerance: 'two points' }, 'underwriting.irrTolerance'],
      ] as const) {
        definitions.underwriting = settings;
        const res = await get('viewer.one', path(id), 'req-underwriting-config').expect(500);
        const problem = problemDetails.parse(res.body);
        expect(problem.type, key).toBe('https://portfolio-beach.example/problems/configuration');
        expect(problem.detail, key).toBe(`config/definitions.json is missing a usable ${key}`);
      }
    } finally {
      definitions.underwriting = kept;
    }
    expect(
      await count(
        "select count(*)::int as n from audit.event where request_id = 'req-underwriting-config'",
      ),
    ).toBe(0);
    expect((await readFor('viewer.one', id)).comparison).not.toBeNull();
  });
});
