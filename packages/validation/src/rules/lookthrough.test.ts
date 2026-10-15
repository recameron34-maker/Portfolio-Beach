import { describe, expect, it } from 'vitest';
import { linkInvestment } from '../linking.js';
import type { InvestmentDirectoryEntry } from '../linking.js';
import { IntakeSettingsError } from '../settings.js';
import { runRules, statusFromFindings } from '../types.js';
import {
  LOOKTHROUGH_RULES,
  linkLookthroughRows,
  lookthroughDifferences,
  lookthroughExceptionsOpenedBy,
  lookthroughNaturalKey,
  lookthroughRuleConfigFrom,
  mapLabels,
  prepareLookthroughRows,
} from './lookthrough.js';
import type {
  LookthroughLabelMapping,
  LookthroughRecord,
  LookthroughRow,
  LookthroughRuleConfig,
  LookthroughRuleContext,
} from './lookthrough.js';

/** Thresholds as config/definitions.json carries them (the API reads them strictly; tests state them). */
const CONFIG: LookthroughRuleConfig = { navTolerancePct: '0.02', costToleranceUsd: '1' };

const MAPPING: LookthroughLabelMapping = {
  sector: { Technology: 'sector.software', Healthcare: 'sector.healthcare' },
  geography: { 'North America': 'geography.north_america', Europe: 'geography.europe' },
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
const COBALT: InvestmentDirectoryEntry = {
  ...MERIDIAN,
  id: '30000000-0000-4000-8000-000000000007',
  investmentNumber: 'INV-0007',
  companyName: 'Cobalt Energy Group',
  canonicalName: 'cobalt energy group',
  aliases: [],
};
/** A second position in a company that shares its name: a name alone cannot tell them apart. */
const TWIN_A: InvestmentDirectoryEntry = {
  ...MERIDIAN,
  id: '30000000-0000-4000-8000-000000000021',
  investmentNumber: 'INV-0021',
  companyName: 'Harbor Twin Holdings',
  canonicalName: 'harbor twin holdings',
  aliases: [],
};
const TWIN_B: InvestmentDirectoryEntry = {
  ...TWIN_A,
  id: '30000000-0000-4000-8000-000000000022',
  investmentNumber: 'INV-0022',
};
const DIRECTORY = [MERIDIAN, COBALT, TWIN_A, TWIN_B];
const GUARDS = [{ nameA: 'Meridian Data Partners', nameB: 'Meridian Data Partners II' }];

const RECORD: LookthroughRecord = {
  sector: 'sector.software',
  geography: 'geography.north_america',
  exposureAtCost: '25000000.00',
  exposureAtNav: '27400000.00',
};

function row(overrides: Partial<LookthroughRow> = {}): LookthroughRow {
  return {
    rowNo: 1,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    sector: 'Technology',
    geography: 'North America',
    exposureAtCost: '25000000.00',
    exposureAtNav: '27400000.00',
    asOf: '2025-06-30',
    ...overrides,
  };
}

/** A context whose baseline row passes every rule; each case changes one thing. */
function context(
  rowOverrides: Partial<LookthroughRow> = {},
  more: { file?: LookthroughRow[]; record?: LookthroughRecord | null; asOf?: string } = {},
): LookthroughRuleContext {
  const r = row(rowOverrides);
  const link = linkInvestment(r, DIRECTORY, GUARDS);
  return {
    row: r,
    link,
    file: linkLookthroughRows(more.file ?? [r], DIRECTORY, GUARDS),
    mapped: mapLabels(MAPPING, r),
    record: 'record' in more ? (more.record ?? null) : link.investment === null ? null : RECORD,
    asOf: more.asOf ?? '2025-06-30',
    config: CONFIG,
  };
}

/** The distinct rule ids that fire, in rule order. */
const ids = (ctx: LookthroughRuleContext): string[] => [
  ...new Set(runRules(LOOKTHROUGH_RULES, ctx).map((f) => f.ruleId)),
];
const findingOf = (ctx: LookthroughRuleContext, id: string) =>
  runRules(LOOKTHROUGH_RULES, ctx).find((f) => f.ruleId === id);

describe('the look-through reconcile rules (docs/04 M2, decision 0010)', () => {
  it('have unique ids with the LT prefix and a category prefix, and a title', () => {
    const seen = new Set<string>();
    for (const rule of LOOKTHROUGH_RULES) {
      expect(seen.has(rule.id), rule.id).toBe(false);
      seen.add(rule.id);
      expect(rule.id).toMatch(/^LT-(REQ|TYPE|XREF|MAP|DIFF|TIE|DUP|STALE)-\d{2}$/);
      expect(rule.title.length).toBeGreaterThan(10);
    }
    expect(LOOKTHROUGH_RULES.length).toBe(13);
  });

  it('pass a well-formed row that maps and ties to the record', () => {
    expect(ids(context())).toEqual([]);
    expect(statusFromFindings(runRules(LOOKTHROUGH_RULES, context()))).toBe('validated');
  });

  /** Each rule's failing case, and every rule that fires on that case (nothing else). */
  const failing: [string, () => LookthroughRuleContext, string[]][] = [
    ['LT-REQ-01', () => context({ investmentNumber: null, companyName: ' ' }), ['LT-REQ-01']],
    ['LT-REQ-01', () => context({ exposureAtNav: '' }), ['LT-REQ-01']],
    ['LT-TYPE-01', () => context({ exposureAtNav: '27,400,000.00' }), ['LT-TYPE-01']],
    ['LT-TYPE-01', () => context({ asOf: '30/06/2025' }), ['LT-TYPE-01']],
    [
      'LT-XREF-01',
      () => context({ investmentNumber: 'INV-9999', companyName: 'Harbor Example Holdings' }),
      ['LT-XREF-01'],
    ],
    [
      'LT-XREF-02',
      () => context({ investmentNumber: null, companyName: 'Meridian Data Partners II' }),
      ['LT-XREF-02'],
    ],
    [
      'LT-XREF-03',
      () => context({ investmentNumber: null, companyName: 'Harbor Twin Holdings' }),
      ['LT-XREF-03'],
    ],
    ['LT-MAP-01', () => context({ sector: 'Other' }), ['LT-MAP-01']],
    ['LT-MAP-02', () => context({ geography: 'Mars' }), ['LT-MAP-02']],
    ['LT-DIFF-01', () => context({ sector: 'Healthcare' }), ['LT-DIFF-01']],
    ['LT-DIFF-02', () => context({ geography: 'Europe' }), ['LT-DIFF-02']],
    ['LT-TIE-01', () => context({ exposureAtNav: '28000000.00' }), ['LT-TIE-01']],
    ['LT-TIE-02', () => context({ exposureAtCost: '25000001.50' }), ['LT-TIE-02']],
    ['LT-DUP-01', () => context({ rowNo: 2 }, { file: [row(), row({ rowNo: 2 })] }), ['LT-DUP-01']],
    ['LT-STALE-01', () => context({ asOf: '2025-03-31' }), ['LT-STALE-01']],
  ];
  it.each(failing)(
    '%s fails: exactly the rules named fire, every finding an error',
    (id, make, fired) => {
      const ctx = make();
      expect(ids(ctx)).toEqual(fired);
      const findings = runRules(LOOKTHROUGH_RULES, ctx);
      expect(findings.length).toBeGreaterThan(0);
      for (const f of findings) {
        expect(f.severity).toBe('error');
        expect(f.message).not.toContain(String.fromCharCode(0x2014));
      }
      expect(statusFromFindings(findings)).toBe('flagged');
      expect(findings.some((f) => f.ruleId === id)).toBe(true);
    },
  );

  /** Each rule's passing case: the row sits just inside the rule and nothing fires. */
  const passing: [string, () => LookthroughRuleContext][] = [
    ['LT-REQ-01 by name alone', () => context({ investmentNumber: null })],
    [
      'LT-TYPE-01 a signed or zero exposure is still a plain number',
      () =>
        context(
          { exposureAtNav: '-1.00', exposureAtCost: '0' },
          { record: { ...RECORD, exposureAtNav: '-1.00', exposureAtCost: '0' } },
        ),
    ],
    ['LT-XREF-01 by number', () => context()],
    ['LT-XREF-02 the guarded name is not in the file', () => context()],
    ['LT-XREF-03 by number of a twin', () => context({ investmentNumber: 'INV-0022' })],
    ['LT-MAP-01 a listed label', () => context({ sector: 'Technology' })],
    ['LT-MAP-02 a listed label', () => context({ geography: ' North America ' })],
    ['LT-DIFF-01 no sector on record', () => context({}, { record: { ...RECORD, sector: null } })],
    [
      'LT-DIFF-02 no geography on record',
      () => context({}, { record: { ...RECORD, geography: null } }),
    ],
    ['LT-TIE-01 inside the tolerance', () => context({ exposureAtNav: '27948000.00' })],
    [
      'LT-TIE-01 no Locked mark on record',
      () => context({}, { record: { ...RECORD, exposureAtNav: null } }),
    ],
    ['LT-TIE-02 inside the tolerance', () => context({ exposureAtCost: '25000001.00' })],
    ['LT-DUP-01 the first of two', () => context({}, { file: [row(), row({ rowNo: 2 })] })],
    [
      'LT-DUP-01 the same position on another date',
      () =>
        context(
          { rowNo: 2, asOf: '2025-03-31' },
          {
            file: [row(), row({ rowNo: 2, asOf: '2025-03-31' })],
            asOf: '2025-03-31',
          },
        ),
    ],
    ["LT-STALE-01 the run's own date", () => context({ asOf: '2025-06-30' })],
  ];
  it.each(passing)('%s passes', (_name, make) => {
    expect(ids(make())).toEqual([]);
  });

  it('TIE-01 flags from the exact tolerance boundary: a move of the whole tolerance passes, a cent more fails', () => {
    // 2% of 27,400,000.00 is 548,000.00.
    expect(ids(context({ exposureAtNav: '27948000.00' }))).toEqual([]);
    expect(ids(context({ exposureAtNav: '27948000.01' }))).toEqual(['LT-TIE-01']);
    expect(ids(context({ exposureAtNav: '26852000.00' }))).toEqual([]);
    expect(ids(context({ exposureAtNav: '26851999.99' }))).toEqual(['LT-TIE-01']);
  });

  it('TIE-02 compares in dollars: the tolerance itself passes, beyond it fails, in either direction', () => {
    expect(ids(context({ exposureAtCost: '24999999.00' }))).toEqual([]);
    expect(ids(context({ exposureAtCost: '24999998.99' }))).toEqual(['LT-TIE-02']);
  });

  it('writes the record first and the provider second in a difference, as the exception will', () => {
    const tie = findingOf(context({ exposureAtNav: '28000000.00' }), 'LT-TIE-01')!;
    expect(tie.field).toBe('exposureAtNav');
    expect(tie.expected).toBe('27400000.00');
    expect(tie.actual).toBe('28000000.00');
    expect(tie.message).toBe(
      'The exposure at NAV differs from the latest Locked mark by 600000.00 dollars, beyond 2.0% of the mark',
    );
    const diff = findingOf(context({ sector: 'Healthcare' }), 'LT-DIFF-01')!;
    expect(diff.expected).toBe('sector.software');
    expect(diff.actual).toBe('Healthcare (sector.healthcare)');
    const unmapped = findingOf(context({ sector: 'Other' }), 'LT-MAP-01')!;
    expect(unmapped.expected).toBe('a sector label the mapping lists');
    expect(unmapped.actual).toBe('Other');
  });

  it('names no candidate in an XREF finding, so the row reads the same inside and outside a wall', () => {
    const near = context({ investmentNumber: null, companyName: 'Meridian Data Partner' });
    expect(near.link.candidates.map((c) => c.companyName)).toEqual(['Meridian Data Partners']);
    const f = findingOf(near, 'LT-XREF-01')!;
    expect(f.message).not.toContain('Meridian');
    expect(f.message).not.toContain('INV-0001');
    expect(f.field).toBe('companyName');
    expect(f.expected).toBeNull();
    expect(f.actual).toBeNull();
  });

  it('links a row by an alias exactly and keys the duplicate rule on the position, not the text', () => {
    const byAlias = row({ rowNo: 2, investmentNumber: null, companyName: 'Meridian Data' });
    const ctx = context(byAlias, { file: [row(), byAlias] });
    expect(ctx.link.status).toBe('matched');
    expect(ctx.link.by).toBe('name');
    expect(ids(ctx)).toEqual(['LT-DUP-01']);
    expect(findingOf(ctx, 'LT-DUP-01')!.message).toBe(
      'Row 1 already carries this position for 2025-06-30',
    );
  });

  it('runs no date arithmetic on an as-of that is not a date: STALE skips it and TYPE reports it', () => {
    const ctx = context({ asOf: 'June 2025' }, { asOf: '2025-06-30' });
    expect(ids(ctx)).toEqual(['LT-TYPE-01']);
  });
});

describe('the look-through helpers', () => {
  it('maps labels exactly (trimmed), never by a near miss, and leaves an unlisted label as null', () => {
    expect(mapLabels(MAPPING, { sector: ' Technology ', geography: 'Europe' })).toEqual({
      sector: 'sector.software',
      geography: 'geography.europe',
    });
    expect(mapLabels(MAPPING, { sector: 'technology', geography: 'Other' })).toEqual({
      sector: null,
      geography: null,
    });
    // A prototype property is never a label.
    expect(mapLabels(MAPPING, { sector: 'constructor', geography: 'toString' })).toEqual({
      sector: null,
      geography: null,
    });
  });

  it('keys a staged row on the number as written, else the name, and the row date', () => {
    expect(lookthroughNaturalKey(row())).toBe('INV-0001|2025-06-30');
    expect(
      lookthroughNaturalKey(row({ investmentNumber: null, companyName: ' Meridian Data ' })),
    ).toBe('Meridian Data|2025-06-30');
    expect(lookthroughNaturalKey(row({ investmentNumber: ' ' }))).toBe(
      'Meridian Data Partners|2025-06-30',
    );
  });

  it('reports differences from the DIFF and TIE findings only, in rule order', () => {
    const ctx = context({ sector: 'Healthcare', exposureAtNav: '28000000.00', asOf: '2025-03-31' });
    const findings = runRules(LOOKTHROUGH_RULES, ctx);
    expect(findings.map((f) => f.ruleId)).toEqual(['LT-DIFF-01', 'LT-TIE-01', 'LT-STALE-01']);
    expect(lookthroughDifferences(findings)).toEqual([
      { field: 'sector', expected: 'sector.software', actual: 'Healthcare (sector.healthcare)' },
      { field: 'exposureAtNav', expected: '27400000.00', actual: '28000000.00' },
    ]);
  });

  it('prepares every row of an extract against the record of the position it links to', () => {
    const rows = [
      row(),
      row({
        rowNo: 2,
        investmentNumber: 'INV-0007',
        companyName: 'Cobalt Energy Group',
        sector: 'Other',
      }),
      row({ rowNo: 3, investmentNumber: 'INV-9999', companyName: 'Harbor Example Holdings' }),
    ];
    const seen: string[] = [];
    const prepared = prepareLookthroughRows(
      linkLookthroughRows(rows, DIRECTORY, GUARDS),
      {
        mapping: MAPPING,
        recordOf: (id) => {
          seen.push(id);
          return id === MERIDIAN.id ? RECORD : null;
        },
      },
      '2025-06-30',
      CONFIG,
    );
    // The record is read for linked rows only.
    expect(seen).toEqual([MERIDIAN.id, COBALT.id]);
    expect(prepared.map((p) => p.status)).toEqual(['validated', 'flagged', 'flagged']);
    expect(prepared[0]!.differences).toEqual([]);
    expect(prepared[1]!.mapped).toEqual({ sector: null, geography: 'geography.north_america' });
    expect(prepared[1]!.record).toBeNull();
    expect(prepared[1]!.findings.map((f) => f.ruleId)).toEqual(['LT-MAP-01']);
    expect(prepared[2]!.link.status).toBe('unmatched');
    expect(prepared[2]!.findings.map((f) => f.ruleId)).toEqual(['LT-XREF-01']);
  });

  it('opens one exception per unresolved link, unmapped label and difference, tiered, with reasons only', () => {
    const near = row({
      rowNo: 4,
      investmentNumber: null,
      companyName: 'Meridian Data Partner',
      sector: 'Other',
    });
    const [p] = prepareLookthroughRows(
      linkLookthroughRows([near], DIRECTORY, GUARDS),
      { mapping: MAPPING, recordOf: () => RECORD },
      '2025-06-30',
      CONFIG,
    );
    expect(lookthroughExceptionsOpenedBy(p!)).toEqual([
      {
        ruleId: 'LT-XREF-01',
        tier: 'high',
        expected: 'a position on record',
        actual: 'Meridian Data Partner',
        candidates: [{ reason: 'near miss' }],
      },
      {
        ruleId: 'LT-MAP-01',
        tier: 'medium',
        expected: 'a sector label the mapping lists',
        actual: 'Other',
        candidates: [],
      },
    ]);
    const differing = row({
      sector: 'Healthcare',
      exposureAtNav: '28000000.00',
      exposureAtCost: '25000002.00',
    });
    const [q] = prepareLookthroughRows(
      linkLookthroughRows([differing], DIRECTORY, GUARDS),
      { mapping: MAPPING, recordOf: () => RECORD },
      '2025-06-30',
      CONFIG,
    );
    expect(lookthroughExceptionsOpenedBy(q!).map((x) => [x.ruleId, x.tier])).toEqual([
      ['LT-DIFF-01', 'medium'],
      ['LT-TIE-01', 'high'],
      ['LT-TIE-02', 'high'],
    ]);
    // A stale or duplicate row is flagged but opens nothing: it is neither a difference nor a link.
    const stale = row({ asOf: '2025-03-31' });
    const [s] = prepareLookthroughRows(
      linkLookthroughRows([stale], DIRECTORY, GUARDS),
      { mapping: MAPPING, recordOf: () => RECORD },
      '2025-06-30',
      CONFIG,
    );
    expect(s!.status).toBe('flagged');
    expect(lookthroughExceptionsOpenedBy(s!)).toEqual([]);
    // A row that names nothing fails LT-REQ-01 and opens no link exception: there is nothing to link.
    const nameless = row({ investmentNumber: null, companyName: '' });
    const [n] = prepareLookthroughRows(
      linkLookthroughRows([nameless], DIRECTORY, GUARDS),
      { mapping: MAPPING, recordOf: () => RECORD },
      '2025-06-30',
      CONFIG,
    );
    expect(n!.link.status).toBe('unmatched');
    expect(n!.status).toBe('flagged');
    expect(n!.findings.map((f) => f.ruleId)).toEqual(['LT-REQ-01']);
    expect(lookthroughExceptionsOpenedBy(n!)).toEqual([]);
  });

  it('reads the two thresholds from the definitions, as numbers or decimal strings, and names a missing key', () => {
    expect(
      lookthroughRuleConfigFrom({
        intake: { lookthroughNavTolerancePct: 0.02, lookthroughCostToleranceUsd: '1.0' },
      }),
    ).toEqual({ navTolerancePct: '0.02', costToleranceUsd: '1' });
    expect(() =>
      lookthroughRuleConfigFrom({ intake: { lookthroughNavTolerancePct: 0.02 } }),
    ).toThrow(IntakeSettingsError);
    try {
      lookthroughRuleConfigFrom({ intake: { lookthroughNavTolerancePct: '2%' } });
    } catch (error) {
      expect((error as IntakeSettingsError).key).toBe('intake.lookthroughNavTolerancePct');
    }
    expect(() => lookthroughRuleConfigFrom({})).toThrow(/intake/);
  });
});
