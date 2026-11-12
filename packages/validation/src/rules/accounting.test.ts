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
  ebitdaMarginAbsMax: '1',
  periodEndToleranceDays: 7,
  figureScale: 2,
  figureIntegerDigits: 18,
  minPeriodYear: 1900,
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

/** The record the baseline row restates: an entry snapshot, four approved quarters, a Locked mark. */
const BASELINE_QUARTERS = [
  { ...quarter('2018-09-30', '9000000.00'), isEntrySnapshot: true },
  quarter('2024-06-30', '12500000.00'),
  quarter('2024-09-30', '12800000.00'),
  quarter('2024-12-31', '13100000.00'),
  quarter('2025-03-31', '13400000.00'),
];

/** The figures a quarter on record carries, so a restatement of it changes nothing. */
const figuresOf = (q: ReturnType<typeof quarter>): AccountingRow['figures'] => ({
  revenueLtm: q.revenueLtm,
  ebitdaLtm: q.ebitdaLtm,
  ev: q.ev,
  netDebt: q.netDebt,
  fairValue: null,
});

const linked = (rows: readonly AccountingRow[]) =>
  rows.map((r) => ({ row: r, link: linkInvestment(r, DIRECTORY, GUARDS) }));

/** A context whose baseline row passes every rule; each case changes one thing. */
function context(
  rowOverrides: Parameters<typeof row>[0] = {},
  more: Partial<Omit<AccountingRuleContext, 'row' | 'link' | 'file'>> & {
    file?: AccountingRow[];
  } = {},
): AccountingRuleContext {
  const r = row(rowOverrides);
  return {
    row: r,
    file: linked(more.file ?? [r]),
    link: linkInvestment(r, DIRECTORY, GUARDS),
    current: more.current ?? {
      quarters: BASELINE_QUARTERS,
      lockedFairValue: { periodEnd: '2025-06-30', fairValue: '27400000.00' },
    },
    asOf: more.asOf ?? '2025-06-30',
    config: more.config ?? CONFIG,
  };
}

/** The distinct rule ids that fire, in rule order. */
const ids = (ctx: AccountingRuleContext): string[] => [
  ...new Set(runRules(ACCOUNTING_RULES, ctx).map((f) => f.ruleId)),
];
const messageOf = (ctx: AccountingRuleContext, id: string): string =>
  runRules(ACCOUNTING_RULES, ctx).find((f) => f.ruleId === id)?.message ?? '';

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

  /** Each rule's failing case, its severity, and every rule that fires on that case (nothing else). */
  const cases: [string, () => AccountingRuleContext, 'error' | 'warning', string[]][] = [
    ['REQ-01', () => context({ investmentNumber: null, companyName: null }), 'error', ['REQ-01']],
    ['REQ-02', () => context({ periodEnd: null }), 'error', ['REQ-02']],
    [
      'REQ-03',
      () =>
        context({
          figures: { revenueLtm: null, ebitdaLtm: null, ev: null, netDebt: null, fairValue: null },
        }),
      'error',
      ['REQ-03', 'REQ-04'],
    ],
    ['REQ-04', () => context({ figures: { revenueLtm: null } }), 'warning', ['REQ-04']],
    ['TYPE-01', () => context({ periodEnd: '30/06/2025' }), 'error', ['TYPE-01']],
    ['TYPE-02', () => context({ figures: { ev: '42,674,102.25' } }), 'error', ['TYPE-02']],
    ['TYPE-03', () => context({ periodEnd: '2025-05-15' }), 'error', ['TYPE-03']],
    [
      'TYPE-04',
      () => context({ figures: { revenueLtm: '13.88' } }),
      'error',
      ['TYPE-04', 'RANGE-03', 'BOUND-01'],
    ],
    ['TYPE-05', () => context({ figures: { ev: '42674102.2567' } }), 'error', ['TYPE-05']],
    [
      'RANGE-01',
      () => context({ figures: { revenueLtm: '-5' } }),
      'error',
      ['RANGE-01', 'BOUND-01', 'BOUND-03'],
    ],
    [
      'RANGE-02',
      () => context({ figures: { ev: '-1' } }),
      'error',
      ['RANGE-02', 'BOUND-04', 'TIE-02'],
    ],
    [
      'RANGE-03',
      () => context({ figures: { ebitdaLtm: '20000000.00' } }),
      'warning',
      ['RANGE-03', 'BOUND-02'],
    ],
    [
      'RANGE-04',
      () => context({ figures: { ev: '400000000.00' } }),
      'warning',
      ['RANGE-04', 'BOUND-04'],
    ],
    [
      'RANGE-05',
      () => context({ figures: { fairValue: '-27400000.00' } }),
      'error',
      ['RANGE-05', 'TIE-01'],
    ],
    ['PERIOD-01', () => context({ periodEnd: '2017-12-31' }), 'error', ['PERIOD-01', 'STALE-01']],
    ['PERIOD-02', () => context({ periodEnd: '2025-09-30' }), 'error', ['PERIOD-02', 'PERIOD-04']],
    [
      'PERIOD-03',
      () => context({ investmentNumber: 'INV-0017', companyName: 'Penrose Foods Holdings' }),
      'warning',
      ['PERIOD-03'],
    ],
    [
      'PERIOD-04',
      () =>
        context(
          { figures: { fairValue: null } },
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
      ['PERIOD-04'],
    ],
    [
      'PERIOD-05',
      () =>
        context(
          { periodEnd: '2025-03-31', figures: { fairValue: null } },
          {
            current: {
              quarters: [{ ...quarter('2025-03-31', '13400000.00'), isEntrySnapshot: true }],
              lockedFairValue: null,
            },
          },
        ),
      'error',
      ['PERIOD-05'],
    ],
    [
      'BOUND-01',
      () => context({ figures: { revenueLtm: '30000000.00' } }),
      'warning',
      ['BOUND-01', 'BOUND-03'],
    ],
    ['BOUND-02', () => context({ figures: { ebitdaLtm: '9000000.00' } }), 'warning', ['BOUND-02']],
    [
      'BOUND-03',
      () =>
        context(
          { figures: { revenueLtm: '26000000.00', fairValue: null } },
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
      ['BOUND-03'],
    ],
    ['BOUND-04', () => context({ figures: { ev: '90000000.00' } }), 'warning', ['BOUND-04']],
    ['TIE-01', () => context({ figures: { fairValue: '27400100.00' } }), 'error', ['TIE-01']],
    ['TIE-02', () => context({ figures: { netDebt: '50000000.00' } }), 'warning', ['TIE-02']],
    [
      'TIE-03',
      () => context({}, { current: { quarters: BASELINE_QUARTERS, lockedFairValue: null } }),
      'warning',
      ['TIE-03'],
    ],
    [
      'DUP-01',
      () => context({ rowNo: 2 }, { file: [row(), row({ rowNo: 2 })] }),
      'error',
      ['DUP-01'],
    ],
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
      ['DUP-02', 'XREF-04'],
    ],
    [
      'XREF-01',
      () => context({ investmentNumber: 'INV-9999', companyName: null }),
      'error',
      ['XREF-01'],
    ],
    [
      'XREF-02',
      () => context({ investmentNumber: null, companyName: 'Meridian Data Partners II' }),
      'error',
      ['XREF-02'],
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
      ['XREF-03'],
    ],
    ['XREF-04', () => context({ companyName: 'Meridian Data Partnerz' }), 'warning', ['XREF-04']],
    [
      'XREF-05',
      () => context({ investmentNumber: 'INV-0013', companyName: 'Summit Services Co' }),
      'error',
      ['XREF-05'],
    ],
    [
      'STALE-01',
      () =>
        context({
          periodEnd: '2024-06-30',
          figures: figuresOf(quarter('2024-06-30', '12500000.00')),
        }),
      'warning',
      ['STALE-01'],
    ],
  ];

  it.each(cases)(
    '%s fails on its case with exactly the findings expected',
    (id, make, severity, expected) => {
      const findings = runRules(ACCOUNTING_RULES, make());
      const mine = findings.filter((f) => f.ruleId === id);
      expect(mine.length, `${id} should fire`).toBeGreaterThan(0);
      expect(mine[0]?.severity).toBe(severity);
      expect([...new Set(findings.map((f) => f.ruleId))]).toEqual(expected);
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

  it('questions a collapse into a loss or to zero: only a prior at or below zero is not calculable', () => {
    const loss = context({ figures: { ebitdaLtm: '-2000000.00' } });
    expect(ids(loss)).toEqual(['BOUND-02']);
    expect(messageOf(loss, 'BOUND-02')).toContain('-150.0%');
    expect(ids(context({ figures: { ev: '0' } }))).toContain('BOUND-04');
  });

  it('takes the prior quarter by the quarter it reports for, never a shifted period end of the same quarter', () => {
    const shifted = {
      quarters: [quarter('2025-03-28', '13400000.00'), quarter('2025-06-27', '13500000.00')],
      lockedFairValue: null,
    };
    const restated = context(
      { figures: { revenueLtm: '25000000.00', fairValue: null } },
      { current: shifted },
    );
    expect(ids(restated)).toContain('BOUND-01');
    expect(messageOf(restated, 'BOUND-01')).toContain('(2025-03-28)');
    // The old Q2 already held the jump: the row is still an 86% move over Q1.
    const alreadyThere = context(
      { figures: { revenueLtm: '25000000.00', fairValue: null } },
      {
        current: {
          quarters: [quarter('2025-03-28', '13400000.00'), quarter('2025-06-27', '25000000.00')],
          lockedFairValue: null,
        },
      },
    );
    expect(ids(alreadyThere)).toContain('BOUND-01');
  });

  it('reports a period end before the first year the import reads and runs no date rule on it', () => {
    for (const periodEnd of ['0001-01-01', '0001-01-07', '1899-12-31']) {
      const ctx = context({ periodEnd });
      expect(ids(ctx), periodEnd).toEqual(['TYPE-01']);
      expect(messageOf(ctx, 'TYPE-01')).toContain('1900');
    }
    expect(ids(context({ periodEnd: '1900-03-31' }))).not.toContain('TYPE-01');
  });

  it('keys duplicates on the linked investment and the quarter, whatever the number, name or day', () => {
    const file = [
      row(),
      row({ rowNo: 2, investmentNumber: null }),
      row({ rowNo: 3, companyName: null, periodEnd: '2025-06-27' }),
      row({ rowNo: 4, periodEnd: '2025-03-31' }),
    ];
    const second = context({ rowNo: 2, investmentNumber: null }, { file });
    expect(ids(second)).toEqual(['DUP-01']);
    expect(messageOf(second, 'DUP-01')).toContain('Row 1');
    expect(
      ids(context({ rowNo: 3, companyName: null, periodEnd: '2025-06-27' }, { file })),
    ).toEqual(['DUP-01']);
    expect(ids(context({ rowNo: 4, periodEnd: '2025-03-31' }, { file }))).toEqual([]);
    // Two rows nobody can link still count as one row twice when they say the same thing.
    const unlinked = [
      row({ investmentNumber: 'INV-9999', companyName: null }),
      row({ rowNo: 2, investmentNumber: 'inv-9999', companyName: null }),
    ];
    expect(
      ids(
        context({ rowNo: 2, investmentNumber: 'inv-9999', companyName: null }, { file: unlinked }),
      ),
    ).toEqual(['DUP-01', 'XREF-01']);
  });

  it('XREF findings name no candidate and count none, so they read the same for everyone', () => {
    const nearMiss = context({ investmentNumber: null, companyName: 'Meridian Data Partner' });
    const nobody = context({ investmentNumber: 'INV-9999', companyName: null });
    expect(nearMiss.link.candidates).toHaveLength(1);
    expect(nobody.link.candidates).toHaveLength(0);
    expect(ids(nearMiss)).toEqual(['XREF-01']);
    expect(messageOf(nearMiss, 'XREF-01')).toBe(messageOf(nobody, 'XREF-01'));
    expect(messageOf(nearMiss, 'XREF-01')).not.toMatch(/near miss|\d/);

    const guarded = context({ investmentNumber: null, companyName: 'Meridian Data Partners II' });
    expect(guarded.link.candidates.map((c) => c.companyName)).toEqual(['Meridian Data Partners']);
    expect(messageOf(guarded, 'XREF-02')).not.toMatch(/Meridian|\d/);
    expect(messageOf(guarded, 'XREF-02')).toContain('match guard list');

    const twin = { ...REALIZED, canonicalName: 'meridian data partners', aliases: [] };
    const r = row({ investmentNumber: null });
    const ambiguous = {
      ...context({ investmentNumber: null }),
      link: linkInvestment(r, [MERIDIAN, twin], []),
    };
    expect(ambiguous.link.candidates).toHaveLength(2);
    expect(messageOf(ambiguous, 'XREF-03')).not.toMatch(/Meridian|\d/);
  });

  it('stays silent at the boundary: the exit quarter, one quarter behind, a near miss off the guard list', () => {
    const exitQuarter = (periodEnd: string) =>
      context(
        {
          investmentNumber: 'INV-0017',
          companyName: 'Penrose Foods Holdings',
          periodEnd,
          figures: figuresOf(quarter('2024-09-30', '13100000.00')),
        },
        {
          current: {
            quarters: [quarter('2024-06-30', '12500000.00'), quarter('2024-09-30', '13100000.00')],
            lockedFairValue: null,
          },
        },
      );
    expect(ids(exitQuarter('2024-09-30'))).toEqual([]);
    expect(ids(exitQuarter('2024-12-31'))).toEqual(['PERIOD-03']);

    const behind = (periodEnd: string, revenue: string) =>
      context({ periodEnd, figures: figuresOf(quarter(periodEnd, revenue)) });
    expect(ids(behind('2024-12-31', '13100000.00'))).toEqual([]);
    expect(ids(behind('2024-09-30', '12800000.00'))).toEqual(['STALE-01']);

    expect(ids(context({ investmentNumber: null, companyName: 'Meridian Data Partner' }))).toEqual([
      'XREF-01',
    ]);
  });

  it('counts the quarters a restatement is behind on the calendar, never by dividing days', () => {
    const withLatest = (latest: string, asOf: string) =>
      context(
        { periodEnd: '2025-02-10', figures: figuresOf(quarter('2025-03-31', '13400000.00')) },
        {
          asOf,
          current: {
            quarters: [
              ...BASELINE_QUARTERS,
              quarter('2025-06-30', '13878398.06', '4138835.16', '42674102.25', '11640057.58'),
              ...(latest > '2025-06-30' ? [quarter(latest, '14000000.00')] : []),
            ],
            lockedFairValue: null,
          },
        },
      );
    // An as-reported Q1 period end behind a Q2 record is one quarter behind, not two.
    expect(ids(withLatest('2025-06-30', '2025-06-30'))).toEqual(['TYPE-03']);
    const twoBehind = withLatest('2025-09-30', '2025-09-30');
    expect(ids(twoBehind)).toEqual(['TYPE-03', 'STALE-01']);
    expect(messageOf(twoBehind, 'STALE-01')).toContain('2 quarters behind');
  });

  it('reads the EBITDA margin band from config', () => {
    const tight = context({}, { config: { ...CONFIG, ebitdaMarginAbsMax: '0.25' } });
    expect(ids(tight)).toEqual(['RANGE-03']);
    expect(messageOf(tight, 'RANGE-03')).toContain('25.0%');
    expect(ids(context())).toEqual([]);
  });

  it('flags a figure the record would round or cannot hold, at the configured scale and digits', () => {
    const netDebt = (value: string, config = CONFIG) =>
      ids(context({ figures: { netDebt: value } }, { config })).filter((id) => id === 'TYPE-05');
    expect(netDebt('123456789012345678.99')).toEqual([]);
    expect(netDebt('1234567890123456789')).toEqual(['TYPE-05']);
    expect(netDebt('11640057.580')).toEqual([]);
    expect(netDebt('-0.5')).toEqual([]);
    expect(netDebt('0.125')).toEqual(['TYPE-05']);
    expect(netDebt('0.125', { ...CONFIG, figureScale: 3 })).toEqual([]);
    const both = context({ figures: { netDebt: '1234567890123456789.125' } });
    expect(runRules(ACCOUNTING_RULES, both).filter((f) => f.ruleId === 'TYPE-05')).toHaveLength(2);
  });

  it('flags the entry snapshot quarter even when the snapshot sits on a shifted period end', () => {
    const ctx = context(
      { periodEnd: '2025-03-31', figures: { fairValue: null } },
      {
        current: {
          quarters: [{ ...quarter('2025-03-28', '13400000.00'), isEntrySnapshot: true }],
          lockedFairValue: null,
        },
      },
    );
    expect(ids(ctx)).toEqual(['PERIOD-05']);
    expect(messageOf(ctx, 'PERIOD-05')).toContain('2025-03-28');
  });

  it('warns when a fair value in the file has no Locked mark to tie to, and only then', () => {
    const noMark = { quarters: BASELINE_QUARTERS, lockedFairValue: null };
    expect(ids(context({ figures: { fairValue: null } }, { current: noMark }))).toEqual([]);
    expect(
      ids(context({ investmentNumber: 'INV-9999', companyName: null }, { current: noMark })),
    ).toEqual(['XREF-01']);
    const warned = context({}, { current: noMark });
    expect(ids(warned)).toEqual(['TIE-03']);
    expect(messageOf(warned, 'TIE-03')).toContain('2025-06-30');
  });
});
