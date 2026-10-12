import { describe, expect, it } from 'vitest';
import { linkInvestment } from '../linking.js';
import type { InvestmentDirectoryEntry } from '../linking.js';
import type { AccountingRow } from '../layout.js';
import { runRules, statusFromFindings } from '../types.js';
import { ACCOUNTING_RULES } from './accounting.js';
import type { AccountingRuleConfig, AccountingRuleContext } from './accounting.js';

/** Thresholds as config/definitions.json carries them (the API reads them strictly; tests state them). */
const CONFIG: AccountingRuleConfig = {
  revenueMinUsd: '1000000',
  revenueMaxUsd: '50000000000',
  fairValueTieToleranceUsd: '1',
  quarterOverQuarterMaxChangePct: '0.5',
  yearOverYearMaxChangePct: '1',
  staleQuarters: 2,
  evToEbitdaMax: '60',
  periodEndToleranceDays: 7,
};

const MERIDIAN: InvestmentDirectoryEntry = {
  id: '30000000-0000-4000-8000-000000000001',
  investmentNumber: 'INV-0001',
  companyName: 'Meridian Data Partners',
  canonicalName: 'meridian data partners',
  aliases: ['Meridian Data'],
  dealType: 'deal_type.co_invest_equity',
  entryDate: '2018-11-15',
  exitDate: null,
  isActive: true,
};
const CREDIT: InvestmentDirectoryEntry = {
  ...MERIDIAN,
  id: '30000000-0000-4000-8000-000000000013',
  investmentNumber: 'INV-0013',
  companyName: 'Summit Services Co',
  canonicalName: 'summit services co',
  aliases: [],
  dealType: 'deal_type.private_credit',
};
const REALIZED: InvestmentDirectoryEntry = {
  ...MERIDIAN,
  id: '30000000-0000-4000-8000-000000000017',
  investmentNumber: 'INV-0017',
  companyName: 'Penrose Foods Holdings',
  canonicalName: 'penrose foods holdings',
  aliases: [],
  exitDate: '2024-09-30',
  isActive: false,
};
const DIRECTORY = [MERIDIAN, CREDIT, REALIZED];
const GUARDS = [{ nameA: 'Meridian Data Partners', nameB: 'Meridian Data Partners II' }];

type RowOverrides = Omit<Partial<AccountingRow>, 'figures'> & {
  figures?: Partial<AccountingRow['figures']>;
};

function row(overrides: RowOverrides = {}): AccountingRow {
  const figures = {
    revenueLtm: '13878398.06',
    ebitdaLtm: '4138835.16',
    ev: '42674102.25',
    netDebt: '11640057.58',
    fairValue: '27400000.00',
    ...overrides.figures,
  };
  return {
    rowNo: 1,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    periodEnd: '2025-06-30',
    raw: {},
    ...overrides,
    figures,
  };
}

const quarter = (
  periodEnd: string,
  revenueLtm: string,
  ebitdaLtm = '4000000.00',
  ev = '40000000.00',
  netDebt = '11000000.00',
) => ({ periodEnd, revenueLtm, ebitdaLtm, ev, netDebt, isEntrySnapshot: false });

/** A context whose baseline row passes every rule; each case changes one thing. */
function context(
  rowOverrides: Parameters<typeof row>[0] = {},
  more: Partial<Omit<AccountingRuleContext, 'row' | 'link'>> & { file?: AccountingRow[] } = {},
): AccountingRuleContext {
  const r = row(rowOverrides);
  return {
    row: r,
    file: more.file ?? [r],
    link: linkInvestment(r, DIRECTORY, GUARDS),
    current: more.current ?? {
      quarters: [
        { ...quarter('2018-09-30', '9000000.00'), isEntrySnapshot: true },
        quarter('2024-06-30', '12500000.00'),
        quarter('2024-09-30', '12800000.00'),
        quarter('2024-12-31', '13100000.00'),
        quarter('2025-03-31', '13400000.00'),
      ],
      lockedFairValue: { periodEnd: '2025-06-30', fairValue: '27400000.00' },
    },
    asOf: more.asOf ?? '2025-06-30',
    config: more.config ?? CONFIG,
  };
}

const ids = (ctx: AccountingRuleContext): string[] =>
  runRules(ACCOUNTING_RULES, ctx).map((f) => f.ruleId);

describe('the accounting import rules (docs/04 M2)', () => {
  it('have unique ids with their category prefix, and a title', () => {
    const seen = new Set<string>();
    for (const rule of ACCOUNTING_RULES) {
      expect(seen.has(rule.id), rule.id).toBe(false);
      seen.add(rule.id);
      expect(rule.id).toMatch(/^(REQ|TYPE|RANGE|PERIOD|BOUND|TIE|DUP|XREF|STALE)-\d{2}$/);
      expect(rule.title.length).toBeGreaterThan(10);
    }
    expect(ACCOUNTING_RULES.length).toBeGreaterThanOrEqual(30);
  });

  it('pass a well-formed row that matches the record', () => {
    expect(ids(context())).toEqual([]);
    expect(statusFromFindings(runRules(ACCOUNTING_RULES, context()))).toBe('validated');
  });

  const cases: [string, () => AccountingRuleContext, 'error' | 'warning'][] = [
    ['REQ-01', () => context({ investmentNumber: null, companyName: null }), 'error'],
    ['REQ-02', () => context({ periodEnd: null }), 'error'],
    [
      'REQ-03',
      () =>
        context({
          figures: { revenueLtm: null, ebitdaLtm: null, ev: null, netDebt: null, fairValue: null },
        }),
      'error',
    ],
    ['REQ-04', () => context({ figures: { revenueLtm: null } }), 'warning'],
    ['TYPE-01', () => context({ periodEnd: '30/06/2025' }), 'error'],
    ['TYPE-02', () => context({ figures: { ev: '42,674,102.25' } }), 'error'],
    ['TYPE-03', () => context({ periodEnd: '2025-05-15' }), 'warning'],
    ['TYPE-04', () => context({ figures: { revenueLtm: '13.88' } }), 'error'],
    ['RANGE-01', () => context({ figures: { revenueLtm: '-5' } }), 'error'],
    ['RANGE-02', () => context({ figures: { ev: '-1' } }), 'error'],
    ['RANGE-03', () => context({ figures: { ebitdaLtm: '20000000.00' } }), 'warning'],
    ['RANGE-04', () => context({ figures: { ev: '400000000.00' } }), 'warning'],
    ['RANGE-05', () => context({ figures: { fairValue: '-27400000.00' } }), 'error'],
    ['PERIOD-01', () => context({ periodEnd: '2017-12-31' }), 'error'],
    ['PERIOD-02', () => context({ periodEnd: '2025-09-30' }), 'error'],
    [
      'PERIOD-03',
      () => context({ investmentNumber: 'INV-0017', companyName: 'Penrose Foods Holdings' }),
      'warning',
    ],
    [
      'PERIOD-04',
      () =>
        context(
          {},
          {
            current: {
              quarters: [
                quarter('2024-06-30', '12500000.00'),
                quarter('2024-09-30', '12800000.00'),
              ],
              lockedFairValue: null,
            },
          },
        ),
      'warning',
    ],
    ['BOUND-01', () => context({ figures: { revenueLtm: '30000000.00' } }), 'warning'],
    ['BOUND-02', () => context({ figures: { ebitdaLtm: '9000000.00' } }), 'warning'],
    [
      'BOUND-03',
      () =>
        context(
          { figures: { revenueLtm: '26000000.00', ebitdaLtm: '4138835.16' } },
          {
            current: {
              quarters: [
                quarter('2024-06-30', '12500000.00'),
                quarter('2025-03-31', '25000000.00'),
              ],
              lockedFairValue: null,
            },
          },
        ),
      'warning',
    ],
    ['BOUND-04', () => context({ figures: { ev: '90000000.00' } }), 'warning'],
    ['TIE-01', () => context({ figures: { fairValue: '27400100.00' } }), 'error'],
    ['TIE-02', () => context({ figures: { netDebt: '50000000.00' } }), 'warning'],
    ['DUP-01', () => context({ rowNo: 2 }, { file: [row(), row({ rowNo: 2 })] }), 'error'],
    [
      'DUP-02',
      () =>
        context(
          { rowNo: 2, periodEnd: '2025-03-31', companyName: 'Meridian Data Partners Holdco' },
          {
            file: [
              row(),
              row({
                rowNo: 2,
                periodEnd: '2025-03-31',
                companyName: 'Meridian Data Partners Holdco',
              }),
            ],
          },
        ),
      'warning',
    ],
    ['XREF-01', () => context({ investmentNumber: 'INV-9999', companyName: null }), 'error'],
    [
      'XREF-02',
      () => context({ investmentNumber: null, companyName: 'Meridian Data Partners II' }),
      'error',
    ],
    [
      'XREF-03',
      () => {
        const twin = { ...REALIZED, canonicalName: 'meridian data partners', aliases: [] };
        const r = row({ investmentNumber: null });
        const ctx = context({ investmentNumber: null });
        return { ...ctx, link: linkInvestment(r, [MERIDIAN, twin], []) };
      },
      'error',
    ],
    ['XREF-04', () => context({ companyName: 'Meridian Data Partnerz' }), 'warning'],
    [
      'XREF-05',
      () => context({ investmentNumber: 'INV-0013', companyName: 'Summit Services Co' }),
      'error',
    ],
    [
      'STALE-01',
      () =>
        context({
          periodEnd: '2024-06-30',
          figures: {
            revenueLtm: '12500000.00',
            ebitdaLtm: '4000000.00',
            ev: '40000000.00',
            netDebt: '11000000.00',
            fairValue: null,
          },
        }),
      'warning',
    ],
  ];

  it.each(cases)(
    '%s fails on its case and nothing else fails on the baseline',
    (id, make, severity) => {
      const findings = runRules(ACCOUNTING_RULES, make());
      const mine = findings.filter((f) => f.ruleId === id);
      expect(mine.length, `${id} should fire`).toBeGreaterThan(0);
      expect(mine[0]?.severity).toBe(severity);
      for (const f of findings) {
        expect(f.message).not.toContain(String.fromCharCode(0x2014));
        expect(f.message.length).toBeGreaterThan(10);
      }
      expect(statusFromFindings(findings)).toBe(severity === 'error' ? 'flagged' : 'validated');
    },
  );

  it('covers every rule with a failing case', () => {
    const covered = new Set(cases.map(([id]) => id));
    for (const rule of ACCOUNTING_RULES) expect(covered.has(rule.id), rule.id).toBe(true);
  });

  it('reads a sponsor closing a few days early as the quarter it reports for', () => {
    expect(ids(context({ periodEnd: '2025-06-27' }))).toEqual([]);
    expect(ids(context({ periodEnd: '2025-07-03' }))).toContain('PERIOD-02');
  });

  it('skips a bound when the prior figure is zero or missing, never dividing by it', () => {
    const ctx = context(
      {},
      {
        current: {
          quarters: [quarter('2025-03-31', '0', '0', '0', '0')],
          lockedFairValue: null,
        },
      },
    );
    expect(ids(ctx).filter((id) => id.startsWith('BOUND'))).toEqual([]);
  });
});
