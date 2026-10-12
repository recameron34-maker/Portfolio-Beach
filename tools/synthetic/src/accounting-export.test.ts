import { alignedQuarterEnd } from '@pb/calc';
import type { SyntheticDataset } from '@pb/db';
import { describe, expect, it } from 'vitest';
import definitions from '../../../config/definitions.json' with { type: 'json' };
import { accountingExport, accountingExports } from './accounting-export.js';
import { generateDataset } from './generate.js';

const small = generateDataset({ profile: 'small', seed: 42 });
const tolerance = definitions.priorYearPeriodEndToleranceDays;
const lines = (csv: string): string[] => csv.trimEnd().split('\n');

/** The cells of one CSV line (quoted cells and doubled quotes read as the writer wrote them). */
function cells(line: string): string[] {
  const out: string[] = [];
  let text = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        text += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else text += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(text);
      text = '';
    } else text += ch;
  }
  out.push(text);
  return out;
}
const numberOf = (line: string): string => cells(line)[0] ?? '';
const periodOf = (line: string): string => cells(line)[2] ?? '';

const equityOf = (dataset: SyntheticDataset) =>
  dataset.investments.filter((i) => i.isActive && i.dealType !== 'deal_type.private_credit');
const scenarioInvestment = (dataset: SyntheticDataset, scenario: string) => {
  const inv = dataset.investments.find((i) => i.id === dataset.scenarios[scenario]?.[0]);
  if (inv === undefined) throw new Error(`the dataset tags no ${scenario} investment`);
  return inv;
};

describe('the synthetic accounting export (docs/14, docs/04 M2)', () => {
  it('writes the layout columns in order and one row per active equity or CV position', () => {
    const clean = accountingExport(small);
    expect(clean.header).toEqual([
      'InvestmentNumber',
      'CompanyName',
      'PeriodEnd',
      'RevenueLTM',
      'EBITDALTM',
      'EnterpriseValue',
      'NetDebt',
      'FairValue',
    ]);
    const rows = lines(clean.csv);
    expect(rows[0]).toBe(clean.header.join(','));
    expect(rows.length - 1).toBe(clean.expectations.rows);
    const equity = equityOf(small);
    expect(clean.expectations.rows).toBeGreaterThan(5);
    expect(clean.expectations.rows).toBe(equity.length);
    expect(clean.expectations).toMatchObject({ changed: [], added: [], flagged: [] });
    expect(clean.fileName).toBe('accounting-export-2025-06-30-clean.csv');
    // Every row names the quarter and an investment on record, numbers ascending.
    const body = rows.slice(1);
    const numbers = body.map(numberOf);
    expect(numbers).toEqual([...numbers].sort());
    expect(new Set(numbers)).toEqual(new Set(equity.map((i) => i.investmentNumber)));
    for (const r of body) expect(alignedQuarterEnd(periodOf(r), tolerance)).toBe('2025-06-30');
  });

  it('exports the sponsor that closes a few days off the quarter end with its own period end', () => {
    const shifted = scenarioInvestment(small, 'period_end_shift');
    const quarter = small.quarterlyPerformance.find(
      (q) =>
        q.investmentId === shifted.id &&
        !q.isEntrySnapshot &&
        alignedQuarterEnd(q.periodEnd, tolerance) === '2025-06-30',
    );
    expect(quarter).toBeDefined();
    expect(quarter?.periodEnd).not.toBe('2025-06-30');
    const body = lines(accountingExport(small).csv).slice(1);
    const line = body.find((r) => numberOf(r) === shifted.investmentNumber);
    expect(line).toBeDefined();
    expect(periodOf(line ?? '')).toBe(quarter?.periodEnd);
    // The Locked mark for that quarter travels with the line, so the import can tie it.
    expect(cells(line ?? '')[7]).not.toBe('');
    for (const r of body)
      if (numberOf(r) !== shifted.investmentNumber) expect(periodOf(r)).toBe('2025-06-30');
  });

  it('is deterministic and never carries the wall clock', () => {
    expect(accountingExport(small, { scenario: 'defects' }).csv).toBe(
      accountingExport(small, { scenario: 'defects' }).csv,
    );
  });

  it('update restates one position and supplies the quarter missing_prior_year left out', () => {
    const update = accountingExport(small, { scenario: 'update' });
    expect(update.expectations.changed).toHaveLength(1);
    expect(update.expectations.added).toHaveLength(1);
    expect(update.expectations.flagged).toEqual([]);
    const missing = scenarioInvestment(small, 'missing_prior_year');
    expect(update.expectations.added[0]).toBe(missing.investmentNumber);
    const body = lines(update.csv).slice(1);
    const added = body.find(
      (r) => numberOf(r) === missing.investmentNumber && periodOf(r) !== '2025-06-30',
    );
    expect(added).toBeDefined();
    expect(periodOf(added ?? '')).toBe('2024-06-30');
    // The restated row sits on the quarter end and is neither the walled nor the shifted position.
    const restated = update.expectations.changed[0];
    expect(restated).not.toBe(scenarioInvestment(small, 'walled_deal').investmentNumber);
    expect(restated).not.toBe(scenarioInvestment(small, 'period_end_shift').investmentNumber);
    const restatedLine = body.find((r) => numberOf(r) === restated);
    expect(periodOf(restatedLine ?? '')).toBe('2025-06-30');
  });

  it('defects adds one row per rule it exists for, each flagged by that rule', () => {
    const defects = accountingExport(small, { scenario: 'defects' });
    const update = accountingExport(small, { scenario: 'update' });
    expect(defects.expectations.rows).toBeGreaterThan(update.expectations.rows);
    const rules = defects.expectations.flagged.map((f) => f.ruleId);
    expect(rules).toEqual(
      expect.arrayContaining([
        'XREF-01',
        'XREF-02',
        'DUP-01',
        'TYPE-04',
        'TYPE-03',
        'TIE-01',
        'PERIOD-01',
        'XREF-05',
      ]),
    );
    const body = lines(defects.csv).slice(1);
    for (const { rowNo } of defects.expectations.flagged) expect(body[rowNo - 1]).toBeDefined();
    expect(body.some((r) => numberOf(r) === 'INV-9999')).toBe(true);
    expect(
      body.some((r) => numberOf(r) === '' && cells(r)[1] === small.matchGuards[0]?.nameB),
    ).toBe(true);
    // The period end off the quarter is flagged for a person, never a warning that bulk approval skips.
    const off = defects.expectations.flagged.find((f) => f.ruleId === 'TYPE-03');
    expect(off).toBeDefined();
    expect(periodOf(body[(off?.rowNo ?? 0) - 1] ?? '')).toBe('2025-06-16');
    // Each in-place defect lands on its own row.
    const inPlace = defects.expectations.flagged
      .filter((f) => ['TYPE-04', 'TYPE-03', 'TIE-01'].includes(f.ruleId))
      .map((f) => f.rowNo);
    expect(new Set(inPlace).size).toBe(inPlace.length);
  });

  it.each([42, 7])(
    'builds the before-entry defect from the walled position and reports its rows (seed %i)',
    (seed) => {
      const dataset = seed === 42 ? small : generateDataset({ profile: 'small', seed });
      const walled = scenarioInvestment(dataset, 'walled_deal');
      const clean = accountingExport(dataset);
      const cleanBody = lines(clean.csv).slice(1);
      expect(clean.expectations.walled).toHaveLength(1);
      expect(numberOf(cleanBody[(clean.expectations.walled[0] ?? 0) - 1] ?? '')).toBe(
        walled.investmentNumber,
      );

      const defects = accountingExport(dataset, { scenario: 'defects' });
      const body = lines(defects.csv).slice(1);
      expect(defects.expectations.walled).toHaveLength(2);
      const [quarterRow = 0, defectRow = 0] = defects.expectations.walled;
      expect(numberOf(body[quarterRow - 1] ?? '')).toBe(walled.investmentNumber);
      expect(numberOf(body[defectRow - 1] ?? '')).toBe(walled.investmentNumber);
      expect(defects.expectations.flagged).toContainEqual({
        rowNo: defectRow,
        ruleId: 'PERIOD-01',
      });
      // The defect's period is before entry; the quarter row is untouched by any in-place defect.
      expect(periodOf(body[defectRow - 1] ?? '') < walled.entryDate).toBe(true);
      expect(alignedQuarterEnd(periodOf(body[quarterRow - 1] ?? ''), tolerance)).toBe('2025-06-30');
      expect(defects.expectations.flagged.map((f) => f.rowNo)).not.toContain(quarterRow);
      expect(body.filter((r) => numberOf(r) === walled.investmentNumber)).toHaveLength(2);
      expect(defects.expectations.changed).not.toContain(walled.investmentNumber);
    },
  );

  it('ships the three samples with distinct names', () => {
    const names = accountingExports(small).map((e) => e.fileName);
    expect(new Set(names).size).toBe(3);
  });
});
