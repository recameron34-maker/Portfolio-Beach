import { describe, expect, it, vi } from 'vitest';
import definitions from '../../../config/definitions.json' with { type: 'json' };
import type { AccountingRow } from './layout.js';
import { linkInvestment } from './linking.js';
import type { InvestmentDirectoryEntry } from './linking.js';
import {
  exceptionsOpenedBy,
  linkOf,
  linkRows,
  prepareRow,
  prepareRows,
  selectTargets,
} from './prepare.js';
import type { LockedMark, PrepareContext, RecordQuarter } from './prepare.js';
import { intakeSettingsFrom } from './settings.js';

/** The thresholds of the repo's definitions file, as both the API and the preview read them. */
const SETTINGS = intakeSettingsFrom(definitions);
const AS_OF = '2025-06-30';

const MERIDIAN: InvestmentDirectoryEntry = {
  id: '30000000-0000-4000-8000-000000000001',
  investmentNumber: 'INV-0001',
  companyName: 'Meridian Data Partners',
  canonicalName: 'meridian data partners',
  aliases: [],
  dealType: 'deal_type.co_invest_equity',
  entryDate: '2018-11-15',
  exitDate: null,
  isActive: true,
};
const SUMMIT: InvestmentDirectoryEntry = {
  ...MERIDIAN,
  id: '30000000-0000-4000-8000-000000000013',
  investmentNumber: 'INV-0013',
  companyName: 'Summit Services Co',
  canonicalName: 'summit services co',
};
const DIRECTORY = [MERIDIAN, SUMMIT];
const GUARDS = [{ nameA: 'Meridian Data Partners', nameB: 'Meridian Data Partners II' }];

type RowOverrides = Omit<Partial<AccountingRow>, 'figures'> & {
  figures?: Partial<AccountingRow['figures']>;
};

/** The baseline row: Meridian's second quarter of 2025, with the fair value the Locked mark carries. */
function row(overrides: RowOverrides = {}): AccountingRow {
  return {
    rowNo: 1,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    periodEnd: '2025-06-30',
    raw: {},
    ...overrides,
    figures: {
      revenueLtm: '13878398.06',
      ebitdaLtm: '4138835.16',
      ev: '42674102.25',
      netDebt: '11640057.58',
      fairValue: '27400000.00',
      ...overrides.figures,
    },
  };
}

const quarter = (id: string, periodEnd: string, revenueLtm: string): RecordQuarter => ({
  id,
  periodEnd,
  revenueLtm,
  ebitdaLtm: '4000000.00',
  ev: '40000000.00',
  netDebt: '11000000.00',
  isEntrySnapshot: false,
});

/** The record before the row's quarter: an entry snapshot and four approved quarters. */
const ON_RECORD: RecordQuarter[] = [
  { ...quarter('q0', '2018-09-30', '9000000.00'), isEntrySnapshot: true },
  quarter('q1', '2024-06-30', '12500000.00'),
  quarter('q2', '2024-09-30', '12800000.00'),
  quarter('q3', '2024-12-31', '13100000.00'),
  quarter('q4', '2025-03-31', '13400000.00'),
];
/** The quarter the row would replace, carrying the row's own figures. */
const Q2_2025: RecordQuarter = {
  id: 'q5',
  periodEnd: '2025-06-30',
  revenueLtm: '13878398.06',
  ebitdaLtm: '4138835.16',
  ev: '42674102.25',
  netDebt: '11640057.58',
  isEntrySnapshot: false,
};
const LOCKED: LockedMark = { periodEnd: '2025-06-30', fairValue: '27400000.00', state: 'Locked' };

const link = (r: AccountingRow) => linkInvestment(r, DIRECTORY, GUARDS);

function context(more: Partial<PrepareContext> = {}, rows: readonly AccountingRow[] = [row()]) {
  return {
    file: linkRows(rows, DIRECTORY, GUARDS),
    quarters: ON_RECORD,
    marks: [LOCKED],
    asOf: AS_OF,
    settings: SETTINGS,
    ...more,
  };
}

const ruleIds = (findings: readonly { ruleId: string }[]): string[] =>
  findings.map((f) => f.ruleId);

describe('prepareRow: one row aligned, diffed and checked', () => {
  it('replaces the approved quarter on record and reads unchanged when the figures agree', () => {
    const r = row();
    const prepared = prepareRow(r, link(r), context({ quarters: [...ON_RECORD, Q2_2025] }));
    expect(prepared.link.status).toBe('matched');
    expect(prepared.quarterEnd).toBe('2025-06-30');
    expect(prepared.targetId).toBe('q5');
    expect(prepared.diff).toEqual({ kind: 'unchanged', changes: [] });
    expect(prepared.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(prepared.status).toBe('validated');
  });

  it('lists the field that changed against the quarter on record', () => {
    const r = row({ figures: { revenueLtm: '13900000.00' } });
    const prepared = prepareRow(r, link(r), context({ quarters: [...ON_RECORD, Q2_2025] }));
    expect(prepared.targetId).toBe('q5');
    expect(prepared.diff).toEqual({
      kind: 'changed',
      changes: [{ field: 'revenueLtm', before: '13878398.06', after: '13900000.00' }],
    });
  });

  it('is a new quarter when the record holds none for it: no target, every figure a change', () => {
    const r = row();
    const prepared = prepareRow(r, link(r), context());
    expect(prepared.quarterEnd).toBe('2025-06-30');
    expect(prepared.targetId).toBeNull();
    expect(prepared.diff.kind).toBe('new');
    expect(prepared.diff.changes.map((c) => c.field)).toEqual([
      'revenueLtm',
      'ebitdaLtm',
      'ev',
      'netDebt',
    ]);
    expect(prepared.diff.changes.every((c) => c.before === null)).toBe(true);
    expect(prepared.status).toBe('validated');
  });

  it('aligns a period end a few days off the quarter end, either side of the record', () => {
    // The file closed three days early: the row reports for the quarter and replaces its record.
    const early = row({ periodEnd: '2025-06-27' });
    const fromFile = prepareRow(early, link(early), context({ quarters: [...ON_RECORD, Q2_2025] }));
    expect(fromFile.quarterEnd).toBe('2025-06-30');
    expect(fromFile.targetId).toBe('q5');
    expect(fromFile.diff.kind).toBe('unchanged');
    // The record closed early: the row at the quarter end still finds it, by the same tolerance.
    const r = row();
    const fromRecord = prepareRow(
      r,
      link(r),
      context({ quarters: [...ON_RECORD, { ...Q2_2025, periodEnd: '2025-06-27' }] }),
    );
    expect(fromRecord.targetId).toBe('q5');
    expect(fromRecord.diff.kind).toBe('unchanged');
    // Beyond the tolerance the period end is its own date and nothing on record answers it.
    const far = row({ periodEnd: '2025-06-15' });
    const alone = prepareRow(far, link(far), context({ quarters: [...ON_RECORD, Q2_2025] }));
    expect(alone.quarterEnd).toBe('2025-06-15');
    expect(alone.targetId).toBeNull();
  });

  it('has no quarter when the period end is not a calendar date', () => {
    const r = row({ periodEnd: '2025-06-31' });
    const prepared = prepareRow(r, link(r), context({ quarters: [...ON_RECORD, Q2_2025] }));
    expect(prepared.quarterEnd).toBeNull();
    expect(prepared.targetId).toBeNull();
    expect(prepared.diff.kind).toBe('new');
    expect(ruleIds(prepared.findings)).toContain('TYPE-01');
    expect(prepared.status).toBe('flagged');
  });

  it('ties the fair value to a Locked mark a few days off the quarter end, and only to a Locked one', () => {
    const r = row();
    const nearMark = { ...LOCKED, periodEnd: '2025-06-27' };
    const ties = prepareRow(r, link(r), context({ marks: [nearMark] }));
    expect(ruleIds(ties.findings)).not.toContain('TIE-01');
    const off = row({ figures: { fairValue: '27400005.00' } });
    const differs = prepareRow(off, link(off), context({ marks: [nearMark] }));
    const tie = differs.findings.find((f) => f.ruleId === 'TIE-01');
    expect(tie?.severity).toBe('error');
    expect(tie?.message).toContain('2025-06-27');
    expect(differs.status).toBe('flagged');
    // A mark outside the tolerance, or one that is not Locked, is not the mark for the quarter.
    const farMark = { ...LOCKED, periodEnd: '2025-06-15' };
    expect(
      ruleIds(prepareRow(off, link(off), context({ marks: [farMark] })).findings),
    ).not.toContain('TIE-01');
    const draft = { ...LOCKED, state: 'Draft' };
    expect(ruleIds(prepareRow(off, link(off), context({ marks: [draft] })).findings)).not.toContain(
      'TIE-01',
    );
  });

  it('reads nothing on record for a row with no link, even when quarters are passed', () => {
    const r = row({ investmentNumber: null, companyName: 'Nobody Holdings' });
    const prepared = prepareRow(r, link(r), context({ quarters: [...ON_RECORD, Q2_2025] }));
    expect(prepared.link.status).toBe('unmatched');
    expect(prepared.targetId).toBeNull();
    expect(prepared.diff.kind).toBe('new');
    expect(ruleIds(prepared.findings)).toContain('XREF-01');
    expect(prepared.status).toBe('flagged');
  });
});

describe('linkRows and prepareRows: a whole file', () => {
  it('zips every row with its link in file order and reads the record once per linked investment', () => {
    const rows = [row(), row({ rowNo: 2, investmentNumber: 'INV-0013', companyName: null })];
    const file = linkRows(rows, DIRECTORY, GUARDS);
    expect(file.map((l) => [l.row.rowNo, l.link.investment?.investmentNumber])).toEqual([
      [1, 'INV-0001'],
      [2, 'INV-0013'],
    ]);
    const quartersOf = vi.fn((id: string) => (id === MERIDIAN.id ? [...ON_RECORD, Q2_2025] : []));
    const marksOf = vi.fn((id: string) => (id === MERIDIAN.id ? [LOCKED] : []));
    const prepared = prepareRows(file, { quartersOf, marksOf }, SETTINGS, AS_OF);
    expect(prepared.map((p) => [p.row.rowNo, p.targetId, p.diff.kind])).toEqual([
      [1, 'q5', 'unchanged'],
      [2, null, 'new'],
    ]);
    expect(quartersOf.mock.calls.map(([id]) => id)).toEqual([MERIDIAN.id, SUMMIT.id]);
    expect(marksOf.mock.calls.map(([id]) => id)).toEqual([MERIDIAN.id, SUMMIT.id]);
  });

  it('never asks the record about a row with no link', () => {
    const rows = [row({ investmentNumber: null, companyName: 'Nobody Holdings' })];
    const quartersOf = vi.fn(() => []);
    const marksOf = vi.fn(() => []);
    prepareRows(linkRows(rows, DIRECTORY, GUARDS), { quartersOf, marksOf }, SETTINGS, AS_OF);
    expect(quartersOf).not.toHaveBeenCalled();
    expect(marksOf).not.toHaveBeenCalled();
  });

  it('lets the duplicate rules see the whole file', () => {
    const rows = [row(), row({ rowNo: 2 })];
    const lookups = { quartersOf: () => ON_RECORD, marksOf: () => [LOCKED] };
    const prepared = prepareRows(linkRows(rows, DIRECTORY, GUARDS), lookups, SETTINGS, AS_OF);
    expect(ruleIds(prepared[0]?.findings ?? [])).not.toContain('DUP-01');
    expect(ruleIds(prepared[1]?.findings ?? [])).toContain('DUP-01');
    expect(prepared.map((p) => p.status)).toEqual(['validated', 'flagged']);
  });
});

describe('linkOf: the link as the contract carries it', () => {
  it('names the matched investment, or carries the candidates', () => {
    expect(linkOf(link(row()))).toEqual({
      status: 'matched',
      investmentId: MERIDIAN.id,
      investmentNumber: 'INV-0001',
      companyName: 'Meridian Data Partners',
      candidates: [],
    });
    const near = row({ investmentNumber: null, companyName: 'Meridian Data Partner' });
    expect(linkOf(link(near))).toEqual({
      status: 'unmatched',
      investmentId: null,
      investmentNumber: null,
      companyName: null,
      candidates: [
        {
          investmentNumber: 'INV-0001',
          companyName: 'Meridian Data Partners',
          reason: 'near miss',
        },
      ],
    });
  });
});

describe('exceptionsOpenedBy: the data exceptions a prepared row opens', () => {
  const prepare = (r: AccountingRow, more: Partial<PrepareContext> = {}) =>
    prepareRow(r, link(r), context(more, [r]));

  it('opens none for a row that links and ties', () => {
    expect(exceptionsOpenedBy(prepare(row()))).toEqual([]);
  });

  it('opens one per unresolved link, with its candidates by reason only (SEC-5.3)', () => {
    const near = prepare(row({ investmentNumber: null, companyName: 'Meridian Data Partner' }));
    const opened = exceptionsOpenedBy(near);
    expect(opened).toEqual([
      {
        ruleId: 'XREF-01',
        expected: 'an investment on record',
        actual: 'Meridian Data Partner',
        candidates: [{ reason: 'near miss' }],
      },
    ]);
    expect(JSON.stringify(opened)).not.toContain('INV-0001');
    expect(JSON.stringify(opened)).not.toContain('Meridian Data Partners');
    const guarded = prepare(
      row({ investmentNumber: null, companyName: 'Meridian Data Partners II' }),
    );
    expect(exceptionsOpenedBy(guarded)).toEqual([
      {
        ruleId: 'XREF-02',
        expected: 'an investment on record',
        actual: 'Meridian Data Partners II',
        candidates: [{ reason: 'match guard' }],
      },
    ]);
    // A name two entries answer (one by company name, one by alias) is ambiguous: both are offered.
    const twiceDirectory = [
      { ...SUMMIT, companyName: 'Twice Co', canonicalName: 'twice co' },
      { ...SUMMIT, id: 'other', investmentNumber: 'INV-0099', aliases: ['Twice Co'] },
    ];
    const twiceRow = row({ investmentNumber: null, companyName: 'Twice Co' });
    const ambiguous = prepareRow(
      twiceRow,
      linkInvestment(twiceRow, twiceDirectory, []),
      context({ file: linkRows([twiceRow], twiceDirectory, []) }),
    );
    expect(ambiguous.link.status).toBe('ambiguous');
    expect(exceptionsOpenedBy(ambiguous)).toEqual([
      {
        ruleId: 'XREF-03',
        expected: 'an investment on record',
        actual: 'Twice Co',
        candidates: [{ reason: 'near miss' }, { reason: 'near miss' }],
      },
    ]);
  });

  it('opens one per fair value that does not tie, carrying no values', () => {
    const off = prepare(row({ figures: { fairValue: '27400005.00' } }));
    expect(exceptionsOpenedBy(off)).toEqual([
      { ruleId: 'TIE-01', expected: null, actual: null, candidates: [] },
    ]);
  });

  it('names an unresolved row by its number before its name, and by nothing when it has neither', () => {
    const byNumber = prepare(row({ investmentNumber: 'INV-9999', companyName: 'Nobody Holdings' }));
    expect(exceptionsOpenedBy(byNumber)[0]?.actual).toBe('INV-9999');
    const blank = prepare(row({ investmentNumber: null, companyName: null }));
    expect(exceptionsOpenedBy(blank)).toEqual([
      { ruleId: 'XREF-01', expected: 'an investment on record', actual: '', candidates: [] },
    ]);
  });
});

describe('selectTargets: the rows a command acts on', () => {
  const rows = [
    { id: 'a', status: 'validated' as const },
    { id: 'b', status: 'flagged' as const },
    { id: 'c', status: 'validated' as const },
  ];

  it('takes every visible row in the wanted state when none is named', () => {
    expect(selectTargets(rows, undefined, 'validated')).toEqual({
      ok: true,
      rows: [rows[0], rows[2]],
    });
    expect(selectTargets(rows, undefined, 'flagged')).toEqual({ ok: true, rows: [rows[1]] });
    expect(selectTargets(rows, undefined, 'promoted')).toEqual({ ok: true, rows: [] });
  });

  it('takes the rows named once each, in the order named', () => {
    expect(selectTargets(rows, ['c', 'a', 'c'], 'validated')).toEqual({
      ok: true,
      rows: [rows[2], rows[0]],
    });
    expect(selectTargets(rows, [], 'validated')).toEqual({ ok: true, rows: [] });
  });

  it('refuses a named row in another state, and one the caller does not see, the same way', () => {
    const refusal = {
      ok: false,
      refusal: { path: 'rowIds', message: 'Every row must belong to this file and be validated' },
    };
    expect(selectTargets(rows, ['b'], 'validated')).toEqual(refusal);
    expect(selectTargets(rows, ['a', 'hidden'], 'validated')).toEqual(refusal);
    expect(selectTargets(rows, ['a'], 'flagged')).toEqual({
      ok: false,
      refusal: { path: 'rowIds', message: 'Every row must belong to this file and be flagged' },
    });
  });
});
