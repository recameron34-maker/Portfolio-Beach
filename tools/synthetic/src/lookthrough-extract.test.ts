import { D, summarizeFlows, toDecimalString } from '@pb/calc';
import type { TypedCashFlow } from '@pb/calc';
import { describe, expect, it } from 'vitest';
import { aliasesOf } from './aliases.js';
import type { AliasedDataset } from './aliases.js';
import { generateDataset } from './generate.js';
import {
  LOOKTHROUGH_MOVES,
  PROVIDER_LABELS,
  PROVIDER_VOCABULARY,
  UNMAPPED_SECTOR_LABEL,
  lookthroughExtract,
  lookthroughExtracts,
} from './lookthrough-extract.js';
import { latestLockedMark } from './marks.js';
import { intakeDecimal } from './settings.js';

const small = generateDataset({ profile: 'small', seed: 42 });
const navTolerance = intakeDecimal('lookthroughNavTolerancePct');
const costTolerance = intakeDecimal('lookthroughCostToleranceUsd');

const scenarioInvestment = (dataset: AliasedDataset, scenario: string) => {
  const inv = dataset.investments.find((i) => i.id === dataset.scenarios[scenario]?.[0]);
  if (inv === undefined) throw new Error(`the dataset tags no ${scenario} investment`);
  return inv;
};
const byNumber = (dataset: AliasedDataset, n: string | null) =>
  dataset.investments.find((i) => i.investmentNumber === n);
const companyOf = (dataset: AliasedDataset, investmentId: string) =>
  dataset.portfolioCompanies.find(
    (c) => c.id === dataset.investments.find((i) => i.id === investmentId)?.portfolioCompanyId,
  );
/** The record's NAV for a position on a date, as the API reports it. */
const navOf = (dataset: AliasedDataset, investmentId: string, asOf: string): string | null =>
  toDecimalString(D(latestLockedMark(dataset.valuations, investmentId, asOf)?.fairValue ?? '0'));
/** The record's invested capital, summed here independently of the module. */
const costOf = (dataset: AliasedDataset, investmentId: string, asOf: string): string | null => {
  const flows: TypedCashFlow[] = dataset.cashFlows
    .filter((f) => f.investmentId === investmentId && f.flowDate <= asOf)
    .map((f) => ({
      date: f.flowDate,
      kind: f.flowType.replace('flow_type.', '') as TypedCashFlow['kind'],
      amount: f.amount,
    }));
  return toDecimalString(summarizeFlows(flows).contributions);
};
const ratio = (a: string, b: string): string => D(a).div(b).minus(1).toFixed(8);

describe('the synthetic look-through extract (docs/04 M2 lookthrough-reconcile)', () => {
  it('maps every taxonomy code the generator uses onto one provider label', () => {
    for (const c of small.portfolioCompanies) {
      expect(Object.keys(PROVIDER_LABELS.sector)).toContain(c.sector);
      expect(Object.keys(PROVIDER_LABELS.geography)).toContain(c.geography);
    }
    expect(PROVIDER_VOCABULARY.sector).toEqual([
      'Technology',
      'Healthcare',
      'Industrials',
      'Consumer',
      'Business Services',
      'Financials',
      'Energy',
      'Other',
    ]);
    expect(PROVIDER_VOCABULARY.geography).toEqual([
      'North America',
      'Europe',
      'Asia Pacific',
      'Rest of World',
    ]);
    expect(Object.values(PROVIDER_LABELS.sector)).not.toContain(UNMAPPED_SECTOR_LABEL);
    // A code the table does not know stops the extract rather than guessing a label.
    const unknown = {
      ...small,
      portfolioCompanies: small.portfolioCompanies.map((c, i) =>
        i === 0 ? { ...c, sector: 'sector.unknown' } : c,
      ),
    };
    expect(() => lookthroughExtract(unknown)).toThrow('sector.unknown');
  });

  it('writes one row per active position with a mark and a cost, tied to the record when clean', () => {
    const clean = lookthroughExtract(small);
    expect(clean.fileName).toBe('lookthrough-2025-06-30.json');
    expect(clean.dropName).toBe('2025-06-30.json');
    expect(clean.asOf).toBe('2025-06-30');
    expect(JSON.parse(clean.json)).toEqual(clean.rows);
    expect(clean.json.endsWith('\n')).toBe(true);
    const active = small.investments.filter((i) => i.isActive);
    expect(clean.expectations.rows).toBe(active.length);
    expect(clean.rows).toHaveLength(active.length);
    expect(clean.expectations).toMatchObject({
      differences: [],
      moved: [],
      unmatched: [],
      unmapped: [],
      duplicates: [],
    });
    const numbers = clean.rows.map((r) => r.investmentNumber).filter((n) => n !== null);
    expect(numbers).toEqual([...numbers].sort());
    expect(
      clean.rows.some(
        (r) => byNumber(small, r.investmentNumber)?.dealType === 'deal_type.private_credit',
      ),
    ).toBe(true);
    for (const r of clean.rows) {
      expect(r.asOf).toBe('2025-06-30');
      if (r.investmentNumber === null) continue;
      const inv = byNumber(small, r.investmentNumber);
      const company = companyOf(small, inv?.id ?? '');
      expect(r.companyName).toBe(company?.name);
      expect(r.sector).toBe(
        PROVIDER_LABELS.sector[company?.sector as keyof typeof PROVIDER_LABELS.sector],
      );
      expect(r.geography).toBe(
        PROVIDER_LABELS.geography[company?.geography as keyof typeof PROVIDER_LABELS.geography],
      );
      expect(r.exposureAtCost).toBe(costOf(small, inv?.id ?? '', '2025-06-30'));
      expect(r.exposureAtNav).toBe(navOf(small, inv?.id ?? '', '2025-06-30'));
    }
  });

  it('takes the as-of date as given: the marks and contributions on or before it', () => {
    const earlier = lookthroughExtract(small, { asOf: '2025-03-31' });
    expect(earlier.fileName).toBe('lookthrough-2025-03-31.json');
    expect(earlier.rows.length).toBeGreaterThan(0);
    for (const r of earlier.rows) {
      expect(r.asOf).toBe('2025-03-31');
      if (r.investmentNumber === null) continue;
      const inv = byNumber(small, r.investmentNumber);
      expect(r.exposureAtCost).toBe(costOf(small, inv?.id ?? '', '2025-03-31'));
      expect(r.exposureAtNav).toBe(navOf(small, inv?.id ?? '', '2025-03-31'));
    }
  });

  it('carries one row by an alias of the company and no number, which still links', () => {
    for (const scenario of ['clean', 'update', 'defects'] as const) {
      const file = lookthroughExtract(small, { scenario });
      expect(file.expectations.aliased).toHaveLength(1);
      const row = file.rows[(file.expectations.aliased[0] ?? 0) - 1];
      expect(row?.investmentNumber).toBeNull();
      const company = small.portfolioCompanies.find((c) =>
        aliasesOf(small, c.id).includes(row?.companyName ?? ''),
      );
      expect(company).toBeDefined();
      const inv = small.investments.find((i) => i.isActive && i.portfolioCompanyId === company?.id);
      expect(inv).toBeDefined();
      expect(inv?.id).not.toBe(small.scenarios.walled_deal?.[0]);
      expect(row?.exposureAtNav).toBe(navOf(small, inv?.id ?? '', '2025-06-30'));
      expect(row?.exposureAtCost).toBe(costOf(small, inv?.id ?? '', '2025-06-30'));
    }
  });

  it('is deterministic and never carries the wall clock', () => {
    expect(lookthroughExtract(small, { scenario: 'defects' }).json).toBe(
      lookthroughExtract(small, { scenario: 'defects' }).json,
    );
  });

  it('update moves three NAVs inside the tolerance and raises nothing', () => {
    const update = lookthroughExtract(small, { scenario: 'update' });
    expect(update.expectations.differences).toEqual([]);
    expect(update.expectations.rows).toBe(lookthroughExtract(small).expectations.rows);
    expect(update.expectations.moved).toHaveLength(LOOKTHROUGH_MOVES.length);
    const walled = scenarioInvestment(small, 'walled_deal');
    for (const [k, m] of update.expectations.moved.entries()) {
      expect(m.field).toBe('exposureAtNav');
      expect(m.pct).toBe(
        D(navTolerance)
          .times(LOOKTHROUGH_MOVES[k] ?? '0')
          .toFixed(),
      );
      expect(D(m.pct).abs().lessThan(navTolerance)).toBe(true);
      const row = update.rows[m.rowNo - 1];
      const inv = byNumber(small, row?.investmentNumber ?? null);
      expect(inv).toBeDefined();
      expect(inv?.id).not.toBe(walled.id);
      const record = navOf(small, inv?.id ?? '', '2025-06-30') ?? '0';
      expect(row?.exposureAtNav).not.toBe(record);
      expect(
        Math.abs(Number(ratio(row?.exposureAtNav ?? '0', record)) - Number(m.pct)),
      ).toBeLessThan(1e-6);
    }
  });

  it('defects adds one row per difference the reconcile exists for', () => {
    const defects = lookthroughExtract(small, { scenario: 'defects' });
    const update = lookthroughExtract(small, { scenario: 'update' });
    expect(defects.expectations.moved).toEqual(update.expectations.moved);
    expect(defects.expectations.rows).toBe(update.expectations.rows + 4);
    const e = defects.expectations;
    expect(e.differences.map((d) => d.field)).toEqual([
      'exposureAtNav',
      'exposureAtCost',
      'sector',
      'asOf',
    ]);
    const rowFor = (field: string) =>
      defects.rows[(e.differences.find((d) => d.field === field)?.rowNo ?? 0) - 1];
    const recordOf = (n: string | null) => byNumber(small, n)?.id ?? '';
    // NAV beyond the tolerance, cost beyond the dollar tolerance.
    const nav = rowFor('exposureAtNav');
    expect(
      D(
        ratio(
          nav?.exposureAtNav ?? '0',
          navOf(small, recordOf(nav?.investmentNumber ?? null), '2025-06-30') ?? '0',
        ),
      )
        .abs()
        .greaterThan(navTolerance),
    ).toBe(true);
    const cost = rowFor('exposureAtCost');
    expect(
      D(cost?.exposureAtCost ?? '0')
        .minus(costOf(small, recordOf(cost?.investmentNumber ?? null), '2025-06-30') ?? '0')
        .abs()
        .greaterThan(costTolerance),
    ).toBe(true);
    // A mapped sector label that is not the record's; an unmapped one.
    const sector = rowFor('sector');
    const sectorCompany = companyOf(small, recordOf(sector?.investmentNumber ?? null));
    expect(sector?.sector).not.toBe(
      PROVIDER_LABELS.sector[sectorCompany?.sector as keyof typeof PROVIDER_LABELS.sector],
    );
    expect(Object.values(PROVIDER_LABELS.sector)).toContain(sector?.sector);
    expect(e.unmapped).toHaveLength(1);
    expect(defects.rows[(e.unmapped[0] ?? 0) - 1]?.sector).toBe(UNMAPPED_SECTOR_LABEL);
    // Unmatched: an unknown number, then a near miss with no number.
    expect(e.unmatched).toHaveLength(2);
    expect(defects.rows[(e.unmatched[0] ?? 0) - 1]?.investmentNumber).toBe('INV-9999');
    const nearMiss = defects.rows[(e.unmatched[1] ?? 0) - 1];
    expect(nearMiss?.investmentNumber).toBeNull();
    expect(
      small.portfolioCompanies.some((c) => c.name.slice(0, -1) === nearMiss?.companyName),
    ).toBe(true);
    // The duplicate repeats an earlier row exactly.
    expect(e.duplicates).toHaveLength(1);
    const dup = defects.rows[(e.duplicates[0] ?? 0) - 1];
    expect(defects.rows.slice(0, (e.duplicates[0] ?? 0) - 1)).toContainEqual(dup);
    // An as-of a quarter old.
    expect(rowFor('asOf')?.asOf).toBe('2025-03-31');
    // Each in-place difference lands on its own row, none of them the alias row or a moved one.
    const inPlace = e.differences.filter((d) => d.field !== 'asOf').map((d) => d.rowNo);
    expect(
      new Set([...inPlace, ...e.unmapped, ...e.aliased, ...e.moved.map((m) => m.rowNo)]).size,
    ).toBe(inPlace.length + e.unmapped.length + e.aliased.length + e.moved.length);
  });

  it.each([42, 7, 14])(
    'reports the walled position: its row, and in defects the hidden row with the old as-of (seed %i)',
    (seed) => {
      const dataset = seed === 42 ? small : generateDataset({ profile: 'small', seed });
      const walled = scenarioInvestment(dataset, 'walled_deal');
      const clean = lookthroughExtract(dataset);
      expect(clean.expectations.walled).toHaveLength(1);
      expect(clean.rows[(clean.expectations.walled[0] ?? 0) - 1]?.investmentNumber).toBe(
        walled.investmentNumber,
      );
      expect(clean.expectations.aliased).toHaveLength(1);
      const defects = lookthroughExtract(dataset, { scenario: 'defects' });
      expect(defects.expectations.walled).toHaveLength(2);
      const hidden = defects.expectations.differences.find((d) => d.field === 'asOf')?.rowNo;
      expect(defects.expectations.walled).toContain(hidden);
      for (const n of defects.expectations.walled)
        expect(defects.rows[n - 1]?.investmentNumber).toBe(walled.investmentNumber);
      expect(
        defects.rows.filter((r) => r.investmentNumber === walled.investmentNumber),
      ).toHaveLength(2);
      // The walled position's own row is untouched.
      const own = defects.expectations.walled[0] ?? 0;
      const raised = [
        ...defects.expectations.differences.map((d) => d.rowNo),
        ...defects.expectations.unmapped,
        ...defects.expectations.moved.map((m) => m.rowNo),
      ];
      expect(raised).not.toContain(own);
      expect(defects.rows[own - 1]?.exposureAtNav).toBe(navOf(dataset, walled.id, '2025-06-30'));
    },
  );

  it('ships the three samples with distinct names', () => {
    const names = lookthroughExtracts(small).map((f) => f.fileName);
    expect(new Set(names).size).toBe(3);
    expect(names).toEqual([
      'lookthrough-2025-06-30.json',
      'lookthrough-2025-06-30-update.json',
      'lookthrough-2025-06-30-defects.json',
    ]);
  });
});
