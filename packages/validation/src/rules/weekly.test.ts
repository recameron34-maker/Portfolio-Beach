import { describe, expect, it } from 'vitest';
import { D } from '@pb/calc';
import { linkInvestment } from '../linking.js';
import type { InvestmentDirectoryEntry } from '../linking.js';
import { IntakeSettingsError } from '../settings.js';
import { runRules, statusFromFindings } from '../types.js';
import {
  WEEKLY_COLUMNS,
  WEEKLY_RULES,
  readWeeklyFile,
  weeklyFlagOf,
  weeklyRuleConfigFrom,
  weeklyVariance,
} from './weekly.js';
import type { WeeklyPrior, WeeklyRow, WeeklyRuleConfig, WeeklyRuleContext } from './weekly.js';

/** Thresholds as config/definitions.json carries them (the API reads them strictly; tests state them). */
const CONFIG: WeeklyRuleConfig = {
  varianceThresholdPct: '0.1',
  staleDays: 10,
  minPeriodYear: 1900,
  figureScale: 2,
  figureIntegerDigits: 18,
};
const AS_OF = '2025-06-30';
const REPORT_DATE = '2025-06-27';

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
const SILVERLINE: InvestmentDirectoryEntry = {
  ...MERIDIAN,
  id: '30000000-0000-4000-8000-000000000004',
  investmentNumber: 'INV-0004',
  companyName: 'Silverline Staffing Holdings',
  canonicalName: 'silverline staffing holdings',
  aliases: [],
};
const TWIN: InvestmentDirectoryEntry = {
  ...MERIDIAN,
  id: '30000000-0000-4000-8000-000000000021',
  investmentNumber: 'INV-0021',
  companyName: 'Harbor Logistics Group',
  canonicalName: 'harbor logistics group',
  aliases: ['Harbor Twin'],
};
const TWIN_TOO: InvestmentDirectoryEntry = {
  ...TWIN,
  id: '30000000-0000-4000-8000-000000000022',
  investmentNumber: 'INV-0022',
  companyName: 'Harbor Logistics Holdings',
  canonicalName: 'harbor logistics holdings',
  aliases: ['Harbor Twin'],
};
/** A position the firm has exited: still on record, so a row links to it, but no longer active. */
const EXITED: InvestmentDirectoryEntry = {
  ...MERIDIAN,
  id: '30000000-0000-4000-8000-000000000009',
  investmentNumber: 'INV-0009',
  companyName: 'Driftwood Marine Services',
  canonicalName: 'driftwood marine services',
  aliases: [],
  exitDate: '2024-12-31',
  isActive: false,
};
const DIRECTORY = [MERIDIAN, SILVERLINE, TWIN, TWIN_TOO, EXITED];
const GUARDS = [{ nameA: 'Meridian Data Partners', nameB: 'Meridian Data Partners II' }];

const PRIOR: WeeklyPrior = { value: '27400000.00', source: 'locked_mark', date: '2025-03-31' };

function row(overrides: Partial<WeeklyRow> = {}): WeeklyRow {
  return {
    rowNo: 1,
    investmentNumber: 'INV-0001',
    companyName: 'Meridian Data Partners',
    reportDate: REPORT_DATE,
    reportedValue: '27400000.00',
    raw: {},
    ...overrides,
  };
}

const linked = (rows: readonly WeeklyRow[]) =>
  rows.map((r) => ({ row: r, link: linkInvestment(r, DIRECTORY, GUARDS) }));

/** A context whose baseline row passes every rule; each case changes one thing. */
function context(
  rowOverrides: Partial<WeeklyRow> = {},
  more: Partial<Omit<WeeklyRuleContext, 'row' | 'link' | 'file'>> & { file?: WeeklyRow[] } = {},
): WeeklyRuleContext {
  const r = row(rowOverrides);
  const { file, ...rest } = more;
  return {
    row: r,
    link: linkInvestment(r, DIRECTORY, GUARDS),
    file: linked(file ?? [r]),
    prior: 'prior' in rest ? (rest.prior ?? null) : PRIOR,
    asOf: AS_OF,
    config: CONFIG,
    ...rest,
  };
}

const ids = (ctx: WeeklyRuleContext): string[] => runRules(WEEKLY_RULES, ctx).map((f) => f.ruleId);
const noEmDash = (ctx: WeeklyRuleContext): void => {
  for (const f of runRules(WEEKLY_RULES, ctx))
    expect(f.message, f.ruleId).not.toContain(String.fromCharCode(0x2014));
};

describe('WEEKLY_RULES: the baseline row', () => {
  it('passes every rule with no finding and lands validated', () => {
    const ctx = context();
    expect(ids(ctx)).toEqual([]);
    expect(statusFromFindings(runRules(WEEKLY_RULES, ctx))).toBe('validated');
  });
  it('every rule id carries the WK prefix and its category prefix, and no two share an id', () => {
    const seen = new Set<string>();
    for (const rule of WEEKLY_RULES) {
      expect(rule.id).toMatch(/^WK-[A-Z]+-\d{2}$/);
      expect(seen.has(rule.id)).toBe(false);
      seen.add(rule.id);
    }
  });
});

describe('WK-REQ-01: a number or a name, a report date and a value', () => {
  it('passes a row with a name alone, a report date and a value', () => {
    expect(ids(context({ investmentNumber: null }))).toEqual([]);
  });
  it('fails a row with neither number nor name, a row with no report date and a row with no value, each on its own field', () => {
    const nameless = context({ investmentNumber: null, companyName: null });
    expect(ids(nameless)).toEqual(['WK-REQ-01']);
    expect(runRules(WEEKLY_RULES, nameless)[0]?.field).toBe('InvestmentNumber');
    // A blank report date is flagged here, so it never lands validated and fails at approval.
    const dateless = context({ reportDate: null });
    expect(ids(dateless)).toEqual(['WK-REQ-01']);
    const [noDate] = runRules(WEEKLY_RULES, dateless);
    expect(noDate?.field).toBe('ReportDate');
    expect(noDate?.severity).toBe('error');
    expect(statusFromFindings(runRules(WEEKLY_RULES, dateless))).toBe('flagged');
    const valueless = context({ reportedValue: null });
    expect(ids(valueless)).toEqual(['WK-REQ-01']);
    expect(runRules(WEEKLY_RULES, valueless)[0]?.field).toBe('ReportedValue');
    expect(statusFromFindings(runRules(WEEKLY_RULES, valueless))).toBe('flagged');
    // Every blank is its own finding, in column order.
    const empty = context({
      investmentNumber: null,
      companyName: null,
      reportDate: null,
      reportedValue: null,
    });
    expect(runRules(WEEKLY_RULES, empty).map((f) => [f.ruleId, f.field])).toEqual([
      ['WK-REQ-01', 'InvestmentNumber'],
      ['WK-REQ-01', 'ReportDate'],
      ['WK-REQ-01', 'ReportedValue'],
    ]);
    noEmDash(nameless);
    noEmDash(dateless);
  });
});

describe('WK-TYPE-01: the report date is a calendar date', () => {
  it('passes an ISO day', () => {
    expect(ids(context({ reportDate: '2025-06-27' }))).toEqual([]);
  });
  it('fails a day written the other way round, an impossible day and a year before the first the intake reads; no date rule runs on it', () => {
    for (const reportDate of ['27/06/2025', '2025-06-31', '2025-13-01', '1899-12-31'])
      expect(ids(context({ reportDate })), reportDate).toEqual(['WK-TYPE-01']);
    const [found] = runRules(WEEKLY_RULES, context({ reportDate: '27/06/2025' }));
    expect(found?.expected).toBe('YYYY-MM-DD');
    expect(found?.actual).toBe('27/06/2025');
    noEmDash(context({ reportDate: '1899-12-31' }));
  });
});

describe('WK-TYPE-02: the value is a plain decimal', () => {
  it('passes a signed decimal with a fraction', () => {
    expect(ids(context({ reportedValue: '27400000.50' }))).toEqual([]);
  });
  it('fails a value with a unit letter, a thousands separator or exponent form', () => {
    for (const reportedValue of ['12.5m', '27,400,000.00', '2.74e7', '$27400000'])
      expect(ids(context({ reportedValue })), reportedValue).toEqual(['WK-TYPE-02']);
  });
});

describe('WK-TYPE-04: the value is in dollars, judged against the prior', () => {
  it('passes a value that moves inside the threshold, and skips a row with no prior', () => {
    expect(ids(context({ reportedValue: '28000000.00' }))).toEqual([]);
    expect(ids(context({ reportedValue: '27.40' }, { prior: null }))).toEqual(['WK-PRIOR-01']);
  });
  it('fails a value entered in millions, in thousands or in cents (the bound fires too: the move is real until a person says otherwise)', () => {
    const millions = context({ reportedValue: '27.40' });
    expect(ids(millions)).toEqual(['WK-TYPE-04', 'WK-BOUND-01']);
    const [found] = runRules(WEEKLY_RULES, millions);
    expect(found?.message).toContain('millions');
    expect(found?.expected).toBe('about 27400000.00 dollars');
    expect(runRules(WEEKLY_RULES, context({ reportedValue: '27400.00' }))[0]?.message).toContain(
      'thousands',
    );
    expect(
      runRules(WEEKLY_RULES, context({ reportedValue: '2740000000.00' }))[0]?.message,
    ).toContain('cents');
    noEmDash(millions);
  });
});

describe('WK-TYPE-05: the value fits the record as written', () => {
  it('passes two decimal places and eighteen integer digits', () => {
    expect(ids(context({ reportedValue: '123456789012345678.99' }, { prior: null }))).toEqual([
      'WK-PRIOR-01',
    ]);
  });
  it('fails three decimal places and nineteen integer digits, one finding each', () => {
    expect(ids(context({ reportedValue: '27400000.005' }))).toEqual(['WK-TYPE-05']);
    const wide = context({ reportedValue: '1234567890123456789.00' }, { prior: null });
    expect(ids(wide)).toEqual(['WK-TYPE-05', 'WK-PRIOR-01']);
    expect(runRules(WEEKLY_RULES, wide)[0]?.message).toContain('19 digits');
  });
});

describe('WK-RANGE-01: the value is not negative', () => {
  it('passes zero', () => {
    expect(ids(context({ reportedValue: '0' }))).toEqual(['WK-BOUND-01']);
  });
  it('fails a negative value', () => {
    const negative = context({ reportedValue: '-27400000.00' });
    expect(ids(negative)).toEqual(['WK-RANGE-01', 'WK-BOUND-01']);
    expect(runRules(WEEKLY_RULES, negative)[0]?.actual).toBe('-27400000.00');
  });
});

describe('WK-PERIOD-01: the report date is not after the as-of date', () => {
  it('passes a report date on the as-of date', () => {
    expect(ids(context({ reportDate: AS_OF }))).toEqual([]);
  });
  it('fails a report date after the as-of date, and names it', () => {
    const after = context({ reportDate: '2025-07-04' });
    expect(ids(after)).toEqual(['WK-PERIOD-01']);
    expect(runRules(WEEKLY_RULES, after)[0]?.expected).toBe('2025-06-30 or earlier');
    noEmDash(after);
  });
});

describe('WK-BOUND-01: the move against the prior stays inside the threshold', () => {
  it('passes a move just inside the threshold, up or down, and a row with no prior', () => {
    expect(ids(context({ reportedValue: '30139999.99' }))).toEqual([]);
    expect(ids(context({ reportedValue: '24660000.01' }))).toEqual([]);
    expect(ids(context({ reportedValue: '30139999.99' }, { prior: null }))).toEqual([
      'WK-PRIOR-01',
    ]);
  });
  it('fails a move at the threshold and beyond it, against a weekly prior too; an error, so the row waits for a person', () => {
    const at = context({ reportedValue: '30140000.00' });
    expect(ids(at)).toEqual(['WK-BOUND-01']);
    const [found] = runRules(WEEKLY_RULES, at);
    expect(found?.severity).toBe('error');
    expect(found?.message).toBe(
      'ReportedValue moved 10.00% against the Locked mark of 2025-03-31, at or beyond the 10.00% threshold; a person confirms the move',
    );
    expect(found?.expected).toBe('within 10.00% of 27400000.00');
    expect(statusFromFindings(runRules(WEEKLY_RULES, at))).toBe('flagged');
    expect(weeklyFlagOf(runRules(WEEKLY_RULES, at))).toBe('above_threshold');
    expect(weeklyFlagOf([])).toBeNull();
    const weekly = context(
      { reportedValue: '20000000.00' },
      { prior: { value: '27400000.00', source: 'weekly', date: '2025-06-20' } },
    );
    expect(ids(weekly)).toEqual(['WK-BOUND-01']);
    expect(runRules(WEEKLY_RULES, weekly)[0]?.message).toContain(
      'against the weekly value of 2025-06-20',
    );
    noEmDash(at);
  });
});

describe('WK-DUP-01: a position and report date appear once in the file', () => {
  it('passes the same position on two report dates, and two positions on one date', () => {
    const first = row();
    const nextWeek = row({ rowNo: 2, reportDate: '2025-06-20' });
    const other = row({
      rowNo: 3,
      investmentNumber: 'INV-0004',
      companyName: 'Silverline Staffing Holdings',
    });
    const file = [first, nextWeek, other];
    expect(ids(context(nextWeek, { file }))).toEqual([]);
    expect(ids(context(other, { file }))).toEqual([]);
  });
  it('fails the later of two rows for one position and date, linked by number or by name alike, and names the first', () => {
    const first = row();
    const byAlias = row({ rowNo: 2, investmentNumber: null, companyName: 'Meridian Data' });
    const file = [first, byAlias];
    expect(ids(context(first, { file }))).toEqual([]);
    const dup = context(byAlias, { file });
    expect(ids(dup)).toEqual(['WK-DUP-01']);
    expect(runRules(WEEKLY_RULES, dup)[0]?.message).toBe(
      'Row 1 already carries this position and report date',
    );
    // Unlinked rows repeat by the name as written.
    const stranger = row({ investmentNumber: 'INV-9999', companyName: 'Harbor Example Holdings' });
    const again = row({ ...stranger, rowNo: 2 });
    expect(ids(context(again, { file: [stranger, again], prior: null }))).toEqual([
      'WK-DUP-01',
      'WK-XREF-01',
    ]);
  });
});

describe('WK-XREF-01, 02 and 03: the row links to one investment on record', () => {
  it('passes a link by number, by canonical name and by alias', () => {
    expect(ids(context())).toEqual([]);
    expect(ids(context({ investmentNumber: null }))).toEqual([]);
    expect(ids(context({ investmentNumber: null, companyName: 'Meridian Data' }))).toEqual([]);
  });
  it('fails an unknown number, a near miss, a guarded name and an ambiguous alias, naming no candidate', () => {
    const unknown = context(
      { investmentNumber: 'INV-9999', companyName: 'Harbor Example Holdings' },
      { prior: null },
    );
    expect(ids(unknown)).toEqual(['WK-XREF-01']);
    expect(runRules(WEEKLY_RULES, unknown)[0]?.field).toBe('InvestmentNumber');
    const nearMiss = context(
      { investmentNumber: null, companyName: 'Meridian Data Partner' },
      { prior: null },
    );
    expect(ids(nearMiss)).toEqual(['WK-XREF-01']);
    expect(nearMiss.link.candidates.map((c) => c.investmentNumber)).toEqual(['INV-0001']);
    const [miss] = runRules(WEEKLY_RULES, nearMiss);
    expect(miss?.field).toBe('CompanyName');
    expect(miss?.message).not.toContain('INV-0001');
    expect(miss?.message).not.toMatch(/\d candidate/);
    const guarded = context(
      { investmentNumber: null, companyName: 'Meridian Data Partners II' },
      { prior: null },
    );
    expect(ids(guarded)).toEqual(['WK-XREF-02']);
    expect(runRules(WEEKLY_RULES, guarded)[0]?.message).not.toContain('Meridian');
    const ambiguous = context(
      { investmentNumber: null, companyName: 'Harbor Twin' },
      { prior: null },
    );
    expect(ids(ambiguous)).toEqual(['WK-XREF-03']);
    expect(runRules(WEEKLY_RULES, ambiguous)[0]?.message).not.toContain('Harbor');
    for (const ctx of [unknown, nearMiss, guarded, ambiguous]) noEmDash(ctx);
  });
});

describe('WK-XREF-04: the linked investment is active', () => {
  it('passes a link to an active investment, and says nothing of a row with no link', () => {
    expect(ids(context())).toEqual([]);
    expect(
      ids(context({ investmentNumber: 'INV-9999', companyName: 'Nobody' }, { prior: null })),
    ).toEqual(['WK-XREF-01']);
  });
  it('fails a link to an exited investment, by number or by name: approval could not open a Draft for it', () => {
    const byNumber = context({
      investmentNumber: 'INV-0009',
      companyName: 'Driftwood Marine Services',
    });
    expect(byNumber.link.status).toBe('matched');
    expect(ids(byNumber)).toEqual(['WK-XREF-04']);
    const [found] = runRules(WEEKLY_RULES, byNumber);
    expect(found?.severity).toBe('error');
    expect(found?.field).toBe('InvestmentNumber');
    expect(found?.message).toContain('not active');
    expect(statusFromFindings(runRules(WEEKLY_RULES, byNumber))).toBe('flagged');
    const byName = context({ investmentNumber: null, companyName: 'Driftwood Marine Services' });
    expect(byName.link.by).toBe('name');
    expect(ids(byName)).toEqual(['WK-XREF-04']);
    noEmDash(byNumber);
  });
});

describe('WK-STALE-01: the report date is recent', () => {
  it('passes a report date exactly the stale window before the as-of date', () => {
    expect(ids(context({ reportDate: '2025-06-20' }))).toEqual([]);
  });
  it('fails a report date one day older than the window, and counts the days', () => {
    const stale = context({ reportDate: '2025-06-19' });
    expect(ids(stale)).toEqual(['WK-STALE-01']);
    const [found] = runRules(WEEKLY_RULES, stale);
    expect(found?.severity).toBe('error');
    expect(found?.message).toBe(
      'The report date is 11 days before the as-of date (2025-06-30), more than the 10 days the intake keeps current',
    );
    expect(found?.expected).toBe('10 days before 2025-06-30 or later');
    noEmDash(stale);
  });
});

describe('WK-PRIOR-01: a prior is on record', () => {
  it('passes a linked row with a prior above zero, and says nothing of an unlinked row', () => {
    expect(ids(context())).toEqual([]);
    expect(
      ids(context({ investmentNumber: 'INV-9999', companyName: 'Nobody' }, { prior: null })),
    ).toEqual(['WK-XREF-01']);
  });
  it('warns, never flags, a linked row with no prior or a prior of zero', () => {
    const none = context({}, { prior: null });
    expect(ids(none)).toEqual(['WK-PRIOR-01']);
    const [found] = runRules(WEEKLY_RULES, none);
    expect(found?.severity).toBe('warning');
    expect(statusFromFindings(runRules(WEEKLY_RULES, none))).toBe('validated');
    const zero = context({}, { prior: { value: '0.00', source: 'weekly', date: '2025-06-20' } });
    expect(ids(zero)).toEqual(['WK-PRIOR-01']);
    expect(runRules(WEEKLY_RULES, zero)[0]?.message).toContain('is zero');
    noEmDash(none);
  });
});

describe('weeklyVariance', () => {
  it('is the move as a fraction of the size of the prior, through decimals', () => {
    expect(weeklyVariance('30140000.00', PRIOR)?.toFixed()).toBe('0.1');
    expect(weeklyVariance('24660000.00', PRIOR)?.toFixed()).toBe('-0.1');
    expect(weeklyVariance('27400000.00', PRIOR)?.eq(D('0'))).toBe(true);
    expect(weeklyVariance('100', { value: '-50' })?.toFixed()).toBe('3');
  });
  it('is null without a value, with a value that is not a decimal, without a prior or against a prior of zero', () => {
    expect(weeklyVariance(null, PRIOR)).toBeNull();
    expect(weeklyVariance('12.5m', PRIOR)).toBeNull();
    expect(weeklyVariance('1', null)).toBeNull();
    expect(weeklyVariance('1', { value: '0' })).toBeNull();
  });
});

describe('readWeeklyFile', () => {
  const header = WEEKLY_COLUMNS.join(',');
  it('reads the four columns as text, blanks as null, and keeps every cell raw', () => {
    const file = readWeeklyFile(
      `${header}\nINV-0001, Meridian Data Partners ,2025-06-27,27400000.00\n,,,\n`,
      {
        maxRows: 10,
      },
    );
    expect(file.fileFindings).toEqual([]);
    expect(file.rows).toEqual([
      {
        rowNo: 1,
        investmentNumber: 'INV-0001',
        companyName: 'Meridian Data Partners',
        reportDate: '2025-06-27',
        reportedValue: '27400000.00',
        raw: {
          InvestmentNumber: 'INV-0001',
          CompanyName: ' Meridian Data Partners ',
          ReportDate: '2025-06-27',
          ReportedValue: '27400000.00',
        },
      },
      {
        rowNo: 2,
        investmentNumber: null,
        companyName: null,
        reportDate: null,
        reportedValue: null,
        raw: { InvestmentNumber: '', CompanyName: '', ReportDate: '', ReportedValue: '' },
      },
    ]);
  });
  it('refuses a column the layout does not know, a missing column, an empty file and too many rows, each as a file finding', () => {
    const extra = readWeeklyFile(`${header},Extra\nINV-0001,x,2025-06-27,1,2\n`, { maxRows: 10 });
    expect(extra.fileFindings.map((f) => [f.ruleId, f.field])).toEqual([['LAYOUT-01', 'Extra']]);
    const missing = readWeeklyFile('InvestmentNumber,CompanyName,ReportedValue\nINV-0001,x,1\n', {
      maxRows: 10,
    });
    expect(missing.fileFindings.map((f) => [f.ruleId, f.field])).toEqual([
      ['LAYOUT-02', 'ReportDate'],
    ]);
    expect(missing.rows[0]?.reportDate).toBeNull();
    expect(
      readWeeklyFile(`${header}\n`, { maxRows: 10 }).fileFindings.map((f) => f.ruleId),
    ).toEqual(['LAYOUT-03']);
    const many = readWeeklyFile(`${header}\na,b,c,d\ne,f,g,h\n`, { maxRows: 1 });
    expect(many.fileFindings.map((f) => f.ruleId)).toEqual(['LAYOUT-04']);
    expect(many.rows).toHaveLength(1);
    for (const f of [...extra.fileFindings, ...missing.fileFindings, ...many.fileFindings])
      expect(f.message).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('weeklyRuleConfigFrom', () => {
  const definitions = {
    intake: {
      weeklyVarianceThresholdPct: 0.1,
      weeklyStaleDays: 10,
      figureScale: 2,
      figureIntegerDigits: 18,
      minPeriodYear: 1900,
      other: 'ignored',
    },
    unrelated: true,
  };
  it('reads the five keys and nothing else, the threshold as decimal digits', () => {
    expect(weeklyRuleConfigFrom(definitions)).toEqual(CONFIG);
    expect(
      weeklyRuleConfigFrom({
        intake: { ...definitions.intake, weeklyVarianceThresholdPct: '0.25' },
      }).varianceThresholdPct,
    ).toBe('0.25');
  });
  it('names the first missing or unusable key, never a default', () => {
    const without = (key: string): unknown => {
      const { [key]: _dropped, ...rest } = definitions.intake as Record<string, unknown>;
      return { intake: rest };
    };
    for (const key of [
      'weeklyVarianceThresholdPct',
      'weeklyStaleDays',
      'figureScale',
      'figureIntegerDigits',
      'minPeriodYear',
    ]) {
      let caught: unknown;
      try {
        weeklyRuleConfigFrom(without(key));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(IntakeSettingsError);
      expect((caught as IntakeSettingsError).key).toBe(`intake.${key}`);
    }
    expect(() => weeklyRuleConfigFrom({})).toThrow(IntakeSettingsError);
    expect(() =>
      weeklyRuleConfigFrom({ intake: { ...definitions.intake, weeklyStaleDays: 1.5 } }),
    ).toThrow(/intake\.weeklyStaleDays/);
  });
});
