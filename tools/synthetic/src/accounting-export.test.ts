import { describe, expect, it } from 'vitest';
import { accountingExport, accountingExports } from './accounting-export.js';
import { generateDataset } from './generate.js';

const small = generateDataset({ profile: 'small', seed: 42 });
const lines = (csv: string): string[] => csv.trimEnd().split('\n');

describe('the synthetic accounting export (docs/14, docs/04 M2)', () => {
  it('writes the layout columns in order and one row per active equity or CV position with a latest quarter', () => {
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
    const equity = small.investments.filter(
      (i) => i.isActive && i.dealType !== 'deal_type.private_credit',
    );
    expect(clean.expectations.rows).toBeGreaterThan(5);
    expect(clean.expectations.rows).toBeLessThanOrEqual(equity.length);
    expect(clean.expectations).toMatchObject({ changed: [], added: [], flagged: [] });
    expect(clean.fileName).toBe('accounting-export-2025-06-30-clean.csv');
    // Every row names the quarter and an investment on record, numbers ascending.
    const numbers = rows.slice(1).map((r) => r.split(',')[0] ?? '');
    expect(numbers).toEqual([...numbers].sort());
    for (const r of rows.slice(1)) expect(r.split(',')[2]).toBe('2025-06-30');
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
    const missing = small.investments.find((i) => i.id === small.scenarios.missing_prior_year?.[0]);
    expect(update.expectations.added[0]).toBe(missing?.investmentNumber);
    const added = lines(update.csv).find(
      (r) => r.startsWith(`${missing?.investmentNumber},`) && !r.includes(',2025-06-30,'),
    );
    expect(added).toBeDefined();
    expect(added?.split(',')[2]).toBe('2024-06-30');
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
        'TIE-01',
        'PERIOD-01',
        'XREF-05',
      ]),
    );
    const body = lines(defects.csv).slice(1);
    for (const { rowNo } of defects.expectations.flagged) expect(body[rowNo - 1]).toBeDefined();
    expect(body.some((r) => r.startsWith('INV-9999,'))).toBe(true);
    expect(body.some((r) => r.startsWith(`,${small.matchGuards[0]?.nameB ?? '?'},`))).toBe(true);
  });

  it('ships the three samples with distinct names', () => {
    const names = accountingExports(small).map((e) => e.fileName);
    expect(new Set(names).size).toBe(3);
  });
});
