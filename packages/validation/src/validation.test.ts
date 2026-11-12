import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from './csv.js';
import { diffRow, sameValue } from './diff.js';
import { accountingLayout, naturalKeyOf, readAccountingFile } from './layout.js';
import type { AccountingRow } from './layout.js';
import { editDistance, isNearMiss, linkInvestment, normalizeName } from './linking.js';
import type { InvestmentDirectoryEntry } from './linking.js';
import { finding, runRules, statusFromFindings } from './types.js';
import type { Rule } from './types.js';

const LAYOUT = accountingLayout.parse({
  export: {
    format: 'csv',
    dateFormat: 'YYYY-MM-DD',
    columns: [
      { name: 'InvestmentNumber', source: 'investment.investment_number' },
      { name: 'CompanyName', source: 'portfolio_company.name', optional: true },
      { name: 'PeriodEnd', source: 'quarterly_performance.period_end' },
      { name: 'RevenueLTM', source: 'quarterly_performance.revenue_ltm', unit: 'USD' },
      { name: 'EBITDALTM', source: 'quarterly_performance.ebitda_ltm', unit: 'USD' },
      { name: 'EnterpriseValue', source: 'quarterly_performance.ev', unit: 'USD' },
      { name: 'NetDebt', source: 'quarterly_performance.net_debt', unit: 'USD' },
      { name: 'FairValue', source: 'valuation.fair_value', unit: 'USD' },
    ],
  },
  import: { keyColumns: ['InvestmentNumber', 'PeriodEnd'], rejectUnknownColumns: true },
});

const HEADER =
  'InvestmentNumber,CompanyName,PeriodEnd,RevenueLTM,EBITDALTM,EnterpriseValue,NetDebt,FairValue';

describe('csv', () => {
  it('reads quoted cells, doubled quotes, CRLF and a byte order mark', () => {
    const text = '﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n2,,\n';
    expect(parseCsv(text)).toEqual({
      header: ['a', 'b', 'c'],
      rows: [
        ['1', 'x, y', 'say "hi"'],
        ['2', '', ''],
      ],
    });
  });
  it('writes what it reads', () => {
    const rows = [
      ['1', 'x, y', 'say "hi"'],
      ['2', '', 'plain'],
    ];
    expect(parseCsv(toCsv(['a', 'b', 'c'], rows)).rows).toEqual(rows);
  });
});

describe('readAccountingFile', () => {
  it('maps columns by the layout, keeps blanks as null and the raw cells for lineage', () => {
    const file = readAccountingFile(
      `${HEADER}\nINV-0001,Meridian Data Partners,2025-06-30,13878398.06,4138835.16,42674102.25,11640057.58,\n`,
      LAYOUT,
      { maxRows: 100 },
    );
    expect(file.fileFindings).toEqual([]);
    expect(file.rows).toHaveLength(1);
    const r = file.rows[0]!;
    expect(r.rowNo).toBe(1);
    expect(r.investmentNumber).toBe('INV-0001');
    expect(r.periodEnd).toBe('2025-06-30');
    expect(r.figures.fairValue).toBeNull();
    expect(r.figures.ev).toBe('42674102.25');
    expect(r.raw.RevenueLTM).toBe('13878398.06');
    expect(naturalKeyOf(r, LAYOUT)).toBe('INV-0001|2025-06-30');
  });
  it('refuses an unknown column and a missing one as file findings, and reads on', () => {
    const file = readAccountingFile(
      'InvestmentNumber,PeriodEnd,Revenue\nINV-0001,2025-06-30,1\n',
      LAYOUT,
      { maxRows: 100 },
    );
    expect(file.fileFindings.map((f) => `${f.ruleId}:${f.field}`).sort()).toEqual([
      'LAYOUT-01:Revenue',
      'LAYOUT-02:EBITDALTM',
      'LAYOUT-02:EnterpriseValue',
      'LAYOUT-02:FairValue',
      'LAYOUT-02:NetDebt',
      'LAYOUT-02:RevenueLTM',
    ]);
    expect(file.rows[0]?.figures.revenueLtm).toBeNull();
  });
  it('reports an empty file and a file past the row limit', () => {
    expect(
      readAccountingFile(`${HEADER}\n`, LAYOUT, { maxRows: 10 }).fileFindings.map((f) => f.ruleId),
    ).toEqual(['LAYOUT-03']);
    const lines = Array.from({ length: 3 }, (_, i) => `INV-000${i + 1},,2025-06-30,1,1,1,1,1`);
    const file = readAccountingFile(`${HEADER}\n${lines.join('\n')}\n`, LAYOUT, { maxRows: 2 });
    expect(file.fileFindings.map((f) => f.ruleId)).toEqual(['LAYOUT-04']);
    expect(file.rows).toHaveLength(2);
  });
});

const entry = (
  investmentNumber: string,
  companyName: string,
  aliases: string[] = [],
): InvestmentDirectoryEntry => ({
  id: `30000000-0000-4000-8000-${investmentNumber.replace(/\D/g, '').padStart(12, '0')}`,
  investmentNumber,
  companyName,
  canonicalName: companyName.toLowerCase(),
  aliases,
  dealType: 'deal_type.co_invest_equity',
  entryDate: '2020-01-01',
  exitDate: null,
  isActive: true,
});
const DIRECTORY = [
  entry('INV-0001', 'Meridian Data Partners', ['Meridian Data']),
  entry('INV-0002', 'Juniper Financial Group'),
  entry('INV-0003', 'Ridgeway Home Group'),
];

describe('linking (docs/03 section 5)', () => {
  it('links by investment number first, whatever the name says', () => {
    const r = linkInvestment(
      { investmentNumber: 'inv-0002', companyName: 'Nonsense' },
      DIRECTORY,
      [],
    );
    expect(r.status).toBe('matched');
    expect(r.by).toBe('number');
    expect(r.investment?.investmentNumber).toBe('INV-0002');
  });
  it('links an exact canonical name or alias, ignoring case and punctuation', () => {
    expect(
      linkInvestment(
        { investmentNumber: null, companyName: 'MERIDIAN DATA, PARTNERS' },
        DIRECTORY,
        [],
      ).by,
    ).toBe('name');
    expect(
      linkInvestment({ investmentNumber: null, companyName: 'meridian data' }, DIRECTORY, [])
        .investment?.investmentNumber,
    ).toBe('INV-0001');
  });
  it('never links a near miss: it is unmatched with the candidates listed for a person', () => {
    const r = linkInvestment(
      { investmentNumber: null, companyName: 'Meridian Data Partner' },
      DIRECTORY,
      [],
    );
    expect(r.status).toBe('unmatched');
    expect(r.investment).toBeNull();
    expect(r.candidates).toEqual([
      { investmentNumber: 'INV-0001', companyName: 'Meridian Data Partners', reason: 'near miss' },
    ]);
  });
  it('marks a pair on the match guard list as guarded, never linked, even when the names are close', () => {
    const guards = [{ nameA: 'Juniper Financial Group', nameB: 'Juniper Finance Group' }];
    const r = linkInvestment(
      { investmentNumber: null, companyName: 'Juniper Finance Group' },
      DIRECTORY,
      guards,
    );
    expect(r.status).toBe('guarded');
    expect(r.candidates[0]).toEqual({
      investmentNumber: 'INV-0002',
      companyName: 'Juniper Financial Group',
      reason: 'match guard',
    });
  });
  it('reports a name that resolves to two investments as ambiguous', () => {
    const twin = { ...entry('INV-0009', 'Meridian Data Partners') };
    const r = linkInvestment(
      { investmentNumber: null, companyName: 'Meridian Data Partners' },
      [...DIRECTORY, twin],
      [],
    );
    expect(r.status).toBe('ambiguous');
    expect(r.candidates.map((c) => c.investmentNumber)).toEqual(['INV-0001', 'INV-0009']);
  });
  it('is unmatched with no candidates when nothing identifies the row', () => {
    expect(linkInvestment({ investmentNumber: null, companyName: null }, DIRECTORY, [])).toEqual({
      status: 'unmatched',
      by: null,
      investment: null,
      candidates: [],
    });
  });
  it('measures near misses on normalized names', () => {
    expect(normalizeName('Kelp-Wood Capital, L.P.')).toBe('kelpwoodcapitallp');
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(isNearMiss('Meridian Data Partners', 'Meridian Data Partner')).toBe(true);
    expect(isNearMiss('Meridian Data Partners', 'Ridgeway Home Group')).toBe(false);
    expect(isNearMiss('Meridian Data Partners', 'Meridian Data Partners')).toBe(false);
  });
});

describe('diff against the current quarter', () => {
  const r: AccountingRow = {
    rowNo: 1,
    investmentNumber: 'INV-0001',
    companyName: null,
    periodEnd: '2025-06-30',
    figures: { revenueLtm: '100.00', ebitdaLtm: '20', ev: '300.0', netDebt: null, fairValue: '50' },
    raw: {},
  };
  it('is new without a quarter on record', () => {
    const d = diffRow(r, null);
    expect(d.kind).toBe('new');
    expect(d.changes.map((c) => c.field)).toEqual(['revenueLtm', 'ebitdaLtm', 'ev', 'netDebt']);
  });
  it('is unchanged when every figure agrees as a decimal, whatever the formatting', () => {
    expect(
      diffRow(r, {
        periodEnd: '2025-06-30',
        revenueLtm: '100',
        ebitdaLtm: '20.00',
        ev: '300',
        netDebt: null,
      }),
    ).toEqual({
      kind: 'unchanged',
      changes: [],
    });
  });
  it('lists exactly the fields that differ, fair value never among them', () => {
    const d = diffRow(r, {
      periodEnd: '2025-06-30',
      revenueLtm: '100',
      ebitdaLtm: '21',
      ev: '300',
      netDebt: '5',
    });
    expect(d.kind).toBe('changed');
    expect(d.changes).toEqual([
      { field: 'ebitdaLtm', before: '21', after: '20' },
      { field: 'netDebt', before: '5', after: null },
    ]);
    expect(sameValue('1.0', '1')).toBe(true);
    expect(sameValue('abc', 'abc ')).toBe(true);
    expect(sameValue(null, '0')).toBe(false);
  });
});

describe('rule running', () => {
  const always: Rule<number> = {
    id: 'TEST-01',
    category: 'required',
    severity: 'warning',
    title: 'A rule that fires on odd numbers',
    check: (n) => (n % 2 === 1 ? finding(always, 'odd', { actual: String(n) }) : null),
  };
  it('flattens findings and derives the staging status from the severities', () => {
    expect(runRules([always], 2)).toEqual([]);
    const findings = runRules([always], 3);
    expect(findings).toEqual([
      {
        ruleId: 'TEST-01',
        severity: 'warning',
        message: 'odd',
        field: null,
        expected: null,
        actual: '3',
      },
    ]);
    expect(statusFromFindings(findings)).toBe('validated');
    expect(statusFromFindings([{ ...findings[0]!, severity: 'error' }])).toBe('flagged');
  });
});
