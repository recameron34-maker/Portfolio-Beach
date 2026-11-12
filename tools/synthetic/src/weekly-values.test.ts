import { D, addDays, daysBetween } from '@pb/calc';
import { describe, expect, it } from 'vitest';
import { aliasesOf } from './aliases.js';
import type { AliasedDataset } from './aliases.js';
import { generateDataset } from './generate.js';
import { latestLockedMark } from './marks.js';
import { intakeDecimal, intakeWholeNumber } from './settings.js';
import {
  WEEKLY_HEADER,
  WEEKLY_MOVES,
  fridayOnOrBefore,
  weeklyValues,
  weeklyValuesSet,
} from './weekly-values.js';

const small = generateDataset({ profile: 'small', seed: 42 });
const threshold = intakeDecimal('weeklyVarianceThresholdPct');
const staleDays = intakeWholeNumber('weeklyStaleDays');
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const lines = (csv: string): string[] => csv.trimEnd().split('\n');

const scenarioInvestment = (dataset: AliasedDataset, scenario: string) => {
  const inv = dataset.investments.find((i) => i.id === dataset.scenarios[scenario]?.[0]);
  if (inv === undefined) throw new Error(`the dataset tags no ${scenario} investment`);
  return inv;
};
const byNumber = (dataset: AliasedDataset, n: string) =>
  dataset.investments.find((i) => i.investmentNumber === n);
/** The Locked mark a numbered row is compared with, as the module defines the prior. */
const priorOf = (dataset: AliasedDataset, n: string, reportDate: string): string => {
  const inv = byNumber(dataset, n);
  return latestLockedMark(dataset.valuations, inv?.id ?? '', reportDate)?.fairValue ?? '';
};
const variance = (value: string, prior: string): string => D(value).div(prior).minus(1).toFixed(6);
const equityWithMark = (dataset: AliasedDataset, reportDate: string) =>
  dataset.investments.filter(
    (i) =>
      i.isActive &&
      i.dealType !== 'deal_type.private_credit' &&
      latestLockedMark(dataset.valuations, i.id, reportDate) !== null,
  );
/** True when the position has a mark locked for the as-of quarter end itself. */
const hasAsOfMark = (dataset: AliasedDataset, n: string): boolean =>
  dataset.valuations.some(
    (v) =>
      v.investmentId === byNumber(dataset, n)?.id &&
      v.periodEnd === dataset.asOf &&
      v.state === 'Locked',
  );
/** The row a defects file flags by a rule, by the row number its expectations name. */
const flaggedRow = (file: ReturnType<typeof weeklyValues>, ruleId: string): string[] => {
  const f = file.expectations.flagged.find((x) => x.ruleId === ruleId);
  const row = file.rows[(f?.rowNo ?? 0) - 1];
  if (row === undefined) throw new Error(`no row for ${ruleId}`);
  return row;
};

describe('the synthetic weekly values file (docs/04 M2 weekly-report-intake)', () => {
  it('dates the report on the Friday on or before the as-of date, from the calendar', () => {
    expect(fridayOnOrBefore('2025-06-27')).toBe('2025-06-27');
    expect(fridayOnOrBefore('2025-06-28')).toBe('2025-06-27');
    expect(fridayOnOrBefore('2025-06-30')).toBe('2025-06-27');
    expect(fridayOnOrBefore('2025-07-03')).toBe('2025-06-27');
    expect(fridayOnOrBefore('2024-12-31')).toBe('2024-12-27');
    expect(weeklyValues(small).reportDate).toBe('2025-06-27');
    // A report date of its own, inside the window the as-of date keeps current.
    expect(weeklyValues(small, { reportDate: '2025-06-20' }).fileName).toBe(
      'weekly-values-2025-06-20-clean.csv',
    );
  });

  it('writes one row per active equity or CV position with a mark, equal to that mark when clean', () => {
    const clean = weeklyValues(small);
    expect(clean.header).toEqual(WEEKLY_HEADER);
    expect(clean.fileName).toBe('weekly-values-2025-06-27-clean.csv');
    const body = lines(clean.csv);
    expect(body[0]).toBe(WEEKLY_HEADER.join(','));
    expect(body.length - 1).toBe(clean.expectations.rows);
    expect(clean.rows.map((r) => r.join(','))).toEqual(body.slice(1));
    const positions = equityWithMark(small, '2025-06-27');
    expect(clean.expectations.rows).toBe(positions.length);
    expect(clean.expectations.rows).toBeGreaterThan(5);
    expect(clean.expectations).toMatchObject({ flagged: [], moved: [] });
    const numbers = clean.rows.map((r) => r[0] ?? '').filter((n) => n !== '');
    expect(numbers).toEqual([...numbers].sort());
    for (const r of clean.rows) {
      expect(r[2]).toBe('2025-06-27');
      if (r[0] !== '') expect(r[3]).toBe(priorOf(small, r[0] ?? '', '2025-06-27'));
    }
    // The positions outside the file are exactly those with no mark by the report date.
    expect(new Set(numbers).size + clean.expectations.aliased.length).toBe(positions.length);
  });

  it('compares with the latest Locked mark on or before the report date, never one locked later', () => {
    // The default report date is before the as-of date, so a mark locked for the as-of quarter
    // end is never the prior: every clean row carries the latest mark on or before 2025-06-27
    // (the 2025-03-31 mark, an older one, or a sponsor's own earlier period end) and no variance
    // against it, even where a 2025-06-30 mark exists.
    const clean = weeklyValues(small);
    expect(clean.reportDate < small.asOf).toBe(true);
    let withAsOfMark = 0;
    for (const r of clean.rows) {
      if (r[0] === '') continue;
      const prior = latestLockedMark(
        small.valuations,
        byNumber(small, r[0] ?? '')?.id ?? '',
        clean.reportDate,
      );
      expect(prior).not.toBeNull();
      const periodEnd = prior?.periodEnd ?? '';
      expect(periodEnd <= clean.reportDate).toBe(true);
      expect(periodEnd).not.toBe(small.asOf);
      expect(variance(r[3] ?? '0', prior?.fairValue ?? '')).toBe('0.000000');
      if (hasAsOfMark(small, r[0] ?? '')) withAsOfMark++;
    }
    expect(withAsOfMark).toBeGreaterThan(0);
    // A report dated on the as-of date takes those marks, by the same rule.
    const onAsOf = weeklyValues(small, { reportDate: small.asOf });
    let taken = 0;
    for (const r of onAsOf.rows) {
      if (r[0] === '' || !hasAsOfMark(small, r[0] ?? '')) continue;
      const prior = latestLockedMark(
        small.valuations,
        byNumber(small, r[0] ?? '')?.id ?? '',
        small.asOf,
      );
      expect(prior?.periodEnd).toBe(small.asOf);
      expect(r[3]).toBe(prior?.fairValue);
      taken++;
    }
    expect(taken).toBe(withAsOfMark);
  });

  it('carries one row by an alias of the company and no number, which still links', () => {
    for (const scenario of ['clean', 'update', 'defects'] as const) {
      const file = weeklyValues(small, { scenario });
      expect(file.expectations.aliased).toHaveLength(1);
      const row = file.rows[(file.expectations.aliased[0] ?? 0) - 1];
      expect(row?.[0]).toBe('');
      const company = small.portfolioCompanies.find((c) =>
        aliasesOf(small, c.id).includes(row?.[1] ?? ''),
      );
      expect(company).toBeDefined();
      const inv = small.investments.find((i) => i.isActive && i.portfolioCompanyId === company?.id);
      expect(inv).toBeDefined();
      expect(inv?.id).not.toBe(small.scenarios.walled_deal?.[0]);
      expect(row?.[3]).toBe(priorOf(small, inv?.investmentNumber ?? '', '2025-06-27'));
      // The alias is not the company's name, and the position is in the file once.
      expect(row?.[1]).not.toBe(company?.name);
      expect(file.rows.some((r) => r[0] === inv?.investmentNumber && r[2] === '2025-06-27')).toBe(
        false,
      );
    }
  });

  it('is deterministic and never carries the wall clock', () => {
    expect(weeklyValues(small, { scenario: 'defects' }).csv).toBe(
      weeklyValues(small, { scenario: 'defects' }).csv,
    );
  });

  it('update moves three positions inside the threshold and flags nothing', () => {
    const update = weeklyValues(small, { scenario: 'update' });
    expect(update.expectations.flagged).toEqual([]);
    expect(update.expectations.moved).toHaveLength(WEEKLY_MOVES.length);
    expect(update.expectations.rows).toBe(weeklyValues(small).expectations.rows);
    const walled = scenarioInvestment(small, 'walled_deal');
    for (const [k, m] of update.expectations.moved.entries()) {
      expect(m.pct).toBe(
        D(threshold)
          .times(WEEKLY_MOVES[k] ?? '0')
          .toFixed(),
      );
      expect(D(m.pct).abs().lessThan(threshold)).toBe(true);
      expect(m.investmentNumber).not.toBe(walled.investmentNumber);
      const row = update.rows.find((r) => r[0] === m.investmentNumber);
      expect(row).toBeDefined();
      const prior = priorOf(small, m.investmentNumber, '2025-06-27');
      expect(row?.[3]).not.toBe(prior);
      expect(Math.abs(Number(variance(row?.[3] ?? '0', prior)) - Number(m.pct))).toBeLessThan(1e-6);
    }
    // Every other numbered row still equals its mark.
    const moved = new Set(update.expectations.moved.map((m) => m.investmentNumber));
    for (const r of update.rows)
      if (r[0] !== '' && !moved.has(r[0] ?? ''))
        expect(r[3]).toBe(priorOf(small, r[0] ?? '', '2025-06-27'));
  });

  it('defects adds one row per rule it exists for, each flagged by that rule', () => {
    const defects = weeklyValues(small, { scenario: 'defects' });
    const update = weeklyValues(small, { scenario: 'update' });
    expect(defects.expectations.moved).toEqual(update.expectations.moved);
    expect(defects.expectations.rows).toBe(update.expectations.rows + 10);
    const rules = defects.expectations.flagged.map((f) => f.ruleId);
    expect(rules).toEqual(
      expect.arrayContaining([
        'WK-REQ-01',
        'WK-TYPE-01',
        'WK-TYPE-02',
        'WK-TYPE-04',
        'WK-RANGE-01',
        'WK-BOUND-01',
        'WK-DUP-01',
        'WK-XREF-01',
        'WK-PERIOD-01',
        'WK-STALE-01',
      ]),
    );
    expect(new Set(defects.expectations.flagged.map((f) => f.rowNo)).size).toBe(rules.length);
    const rowOf = (ruleId: string): string[] => flaggedRow(defects, ruleId);
    const asOf = small.asOf;
    // Beyond the threshold, in place on a position's own row.
    const beyond = rowOf('WK-BOUND-01');
    const beyondVariance = variance(
      beyond[3] ?? '0',
      priorOf(small, beyond[0] ?? '', '2025-06-27'),
    );
    expect(D(beyondVariance).abs().greaterThan(threshold)).toBe(true);
    expect(beyond[2]).toBe('2025-06-27');
    // An unknown number and a near miss with no number.
    const xref = defects.expectations.flagged.filter((f) => f.ruleId === 'WK-XREF-01');
    expect(xref).toHaveLength(2);
    expect(defects.rows[(xref[0]?.rowNo ?? 0) - 1]?.[0]).toBe('INV-9999');
    const nearMiss = defects.rows[(xref[1]?.rowNo ?? 0) - 1];
    expect(nearMiss?.[0]).toBe('');
    expect(small.portfolioCompanies.some((c) => c.name.slice(0, -1) === nearMiss?.[1])).toBe(true);
    // The duplicate repeats an earlier row exactly.
    const dup = rowOf('WK-DUP-01');
    const dupNo = defects.expectations.flagged.find((f) => f.ruleId === 'WK-DUP-01')?.rowNo ?? 0;
    expect(
      defects.rows.slice(0, dupNo - 1).some((r) => r.join('\u001f') === dup.join('\u001f')),
    ).toBe(true);
    // Required, type, units and range, each on its own earlier day of the same week.
    expect(rowOf('WK-REQ-01')[3]).toBe('');
    expect(rowOf('WK-TYPE-02')[3]).toBe('12.5m');
    expect(Number(rowOf('WK-TYPE-04')[3])).toBeLessThan(1000);
    expect(Number(rowOf('WK-RANGE-01')[3])).toBeLessThan(0);
    for (const id of ['WK-REQ-01', 'WK-TYPE-02', 'WK-TYPE-04', 'WK-RANGE-01']) {
      const date = rowOf(id)[2] ?? '';
      expect(date).toMatch(ISO);
      expect(date < '2025-06-27').toBe(true);
      expect(daysBetween(date, asOf)).toBeLessThanOrEqual(staleDays);
    }
    // Dates: not a day, stale, after the as-of date.
    expect(rowOf('WK-TYPE-01')[2]).not.toMatch(ISO);
    const stale = rowOf('WK-STALE-01')[2] ?? '';
    expect(daysBetween(stale, asOf)).toBeGreaterThan(staleDays);
    expect(fridayOnOrBefore(stale)).toBe(stale);
    expect((rowOf('WK-PERIOD-01')[2] ?? '') > asOf).toBe(true);
    // No row repeats a report date and number except the duplicate.
    const keys = defects.rows.filter((r) => r[0] !== '').map((r) => `${r[0]}|${r[2]}`);
    expect(keys.length - new Set(keys).size).toBe(1);
  });

  it('takes a report date inside the stale window of the as-of date and refuses one outside it', () => {
    const asOf = small.asOf;
    const earliest = addDays(asOf, -staleDays);
    expect(weeklyValues(small, { reportDate: earliest }).reportDate).toBe(earliest);
    expect(weeklyValues(small, { reportDate: asOf }).reportDate).toBe(asOf);
    const thrown = (reportDate: string): unknown => {
      try {
        weeklyValues(small, { reportDate });
      } catch (error) {
        return error;
      }
      return undefined;
    };
    for (const [reportDate, reason] of [
      [addDays(asOf, 1), 'after the as-of date'],
      [addDays(earliest, -1), 'intake.weeklyStaleDays'],
    ] as const) {
      const error = thrown(reportDate);
      expect(error).toBeInstanceOf(Error);
      expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
      expect(error instanceof Error ? error.message : '').toContain(reason);
    }
    // At either edge of the window the defect rows keep their places: the value defects on their
    // own days inside it, the stale row on a Friday before it, the after-as-of row on the Friday
    // after it, and every numbered row still a key of its own.
    for (const reportDate of [earliest, asOf]) {
      const defects = weeklyValues(small, { reportDate, scenario: 'defects' });
      const days = ['WK-REQ-01', 'WK-TYPE-02', 'WK-TYPE-04', 'WK-RANGE-01'].map(
        (id) => flaggedRow(defects, id)[2] ?? '',
      );
      expect(new Set(days).size).toBe(days.length);
      for (const date of days) {
        expect(date).toMatch(ISO);
        expect(date).not.toBe(reportDate);
        expect(date >= earliest && date <= asOf).toBe(true);
      }
      const stale = flaggedRow(defects, 'WK-STALE-01')[2] ?? '';
      expect(fridayOnOrBefore(stale)).toBe(stale);
      expect(stale < earliest).toBe(true);
      expect(daysBetween(stale, asOf)).toBeGreaterThan(staleDays);
      const after = flaggedRow(defects, 'WK-PERIOD-01')[2] ?? '';
      expect(fridayOnOrBefore(after)).toBe(after);
      expect(after > asOf).toBe(true);
      const keys = defects.rows.filter((r) => r[0] !== '').map((r) => `${r[0]}|${r[2]}`);
      expect(keys.length - new Set(keys).size).toBe(1);
    }
    // The default report date and its rows are unchanged by the window: the earlier days first.
    const byDefault = weeklyValues(small, { scenario: 'defects' });
    expect(flaggedRow(byDefault, 'WK-REQ-01')[2]).toBe(addDays(byDefault.reportDate, -1));
    expect(flaggedRow(byDefault, 'WK-RANGE-01')[2]).toBe(addDays(byDefault.reportDate, -4));
  });

  it.each([42, 7, 14])(
    'reports the walled position: its row, and in defects the hidden row after the as-of date (seed %i)',
    (seed) => {
      const dataset = seed === 42 ? small : generateDataset({ profile: 'small', seed });
      const walled = scenarioInvestment(dataset, 'walled_deal');
      const clean = weeklyValues(dataset);
      expect(clean.expectations.walled).toHaveLength(1);
      expect(clean.rows[(clean.expectations.walled[0] ?? 0) - 1]?.[0]).toBe(
        walled.investmentNumber,
      );
      expect(clean.expectations.aliased).toHaveLength(1);
      const defects = weeklyValues(dataset, { scenario: 'defects' });
      expect(defects.expectations.walled).toHaveLength(2);
      const hidden = defects.expectations.flagged.find((f) => f.ruleId === 'WK-PERIOD-01')?.rowNo;
      expect(defects.expectations.walled).toContain(hidden);
      for (const n of defects.expectations.walled)
        expect(defects.rows[n - 1]?.[0]).toBe(walled.investmentNumber);
      expect(defects.rows.filter((r) => r[0] === walled.investmentNumber)).toHaveLength(2);
      // The walled position's own row is untouched: neither moved nor flagged.
      const own = defects.expectations.walled[0] ?? 0;
      expect(defects.expectations.flagged.map((f) => f.rowNo)).not.toContain(own);
      expect(defects.expectations.moved.map((m) => m.investmentNumber)).not.toContain(
        walled.investmentNumber,
      );
      expect(defects.rows[own - 1]?.[3]).toBe(
        priorOf(dataset, walled.investmentNumber, '2025-06-27'),
      );
      expect(defects.expectations.flagged).toHaveLength(11);
    },
  );

  it('ships the three samples with distinct names', () => {
    const names = weeklyValuesSet(small).map((f) => f.fileName);
    expect(new Set(names).size).toBe(3);
  });
});
