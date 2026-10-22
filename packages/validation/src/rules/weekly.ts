import { D, daysBetween, isCalendarDate } from '@pb/calc';
import type { Decimal } from '@pb/calc';
import { z } from 'zod';
import { parseCsv } from '../csv.js';
import { normalizeName } from '../linking.js';
import type { LinkResult } from '../linking.js';
import { IntakeSettingsError } from '../settings.js';
import { finding } from '../types.js';
import type { Finding, Rule } from '../types.js';
import { digitsOf } from './accounting.js';

/*
 * The weekly report values (docs/04 M2 weekly-report-intake, decision 0010): a four-column file
 * (InvestmentNumber, CompanyName, ReportDate, ReportedValue) whose every row is compared with its
 * prior, the latest Locked mark on or before the report date or the weekly value promoted after
 * it, and flagged for a person when it moves at or beyond the threshold. A weekly value never
 * becomes a mark: approval creates a Draft valuation and the valuation workflow carries it from
 * there. Like the accounting rules, nothing here reads a clock, a float or a literal threshold.
 */

/** The columns a weekly file carries, in order; a file with any other header is refused. */
export const WEEKLY_COLUMNS = [
  'InvestmentNumber',
  'CompanyName',
  'ReportDate',
  'ReportedValue',
] as const;
export type WeeklyColumn = (typeof WEEKLY_COLUMNS)[number];

/** One data line of a weekly file: cells stay text until a rule reads them; raw holds every cell as written. */
export interface WeeklyRow {
  rowNo: number;
  investmentNumber: string | null;
  companyName: string | null;
  reportDate: string | null;
  reportedValue: string | null;
  raw: Record<string, string>;
}

/** A row of the file with the link the importer made for it. */
export interface WeeklyLinkedRow {
  row: WeeklyRow;
  link: LinkResult;
}

/** What a staged value is compared with: the latest Locked mark, or the weekly value promoted after it. */
export interface WeeklyPrior {
  value: string;
  source: 'locked_mark' | 'weekly';
  date: string;
}

/**
 * Thresholds every weekly rule reads from config/definitions.json (CLAUDE.md rule 9), never from
 * a literal here; weeklyRuleConfigFrom reads them strictly.
 */
export interface WeeklyRuleConfig {
  /** The move against the prior (a decimal, 0.1 is 10%) at or beyond which a value is held for a person. */
  varianceThresholdPct: string;
  /** How many days before the as-of date a report date may sit before it is stale. */
  staleDays: number;
  /** A report date before this year is not a date the intake reads. */
  minPeriodYear: number;
  /** Decimal places the record keeps for a value (the scale of its numeric columns). */
  figureScale: number;
  /** Digits before the decimal point the record holds (precision minus scale). */
  figureIntegerDigits: number;
}

export interface WeeklyRuleContext {
  row: WeeklyRow;
  /** Every row of the file with its link, for the duplicate rule. */
  file: readonly WeeklyLinkedRow[];
  link: LinkResult;
  /** The prior of the linked position for this report date; null for a row with no link or no mark. */
  prior: WeeklyPrior | null;
  asOf: string;
  config: WeeklyRuleConfig;
}

type WeeklyRule = Rule<WeeklyRuleContext>;

const DECIMAL = /^-?\d+(\.\d+)?$/;
/** A whole number of zero or more, such as a number of days or digits. */
const wholeNumber = z.number().int().min(0);
/** A rate or threshold as plain decimal digits (never exponent form), from a JSON number or a decimal string. */
const decimalDigits = z
  .union([z.number(), z.string().regex(DECIMAL)])
  .transform((value) => D(typeof value === 'number' ? String(value) : value).toFixed());

/** Only the keys the weekly rules read; the rest of the file is ignored here. */
export const weeklyDefinitions = z.object({
  intake: z.object({
    weeklyVarianceThresholdPct: decimalDigits,
    weeklyStaleDays: wholeNumber,
    figureScale: wholeNumber,
    figureIntegerDigits: wholeNumber,
    minPeriodYear: wholeNumber,
  }),
});

/** The weekly thresholds from the parsed definitions file, or an IntakeSettingsError naming the first bad key. */
export function weeklyRuleConfigFrom(definitions: unknown): WeeklyRuleConfig {
  const parsed = weeklyDefinitions.safeParse(definitions);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.map(String) ?? [];
    throw new IntakeSettingsError(path.length === 0 ? 'intake' : path.join('.'));
  }
  const { intake } = parsed.data;
  return {
    varianceThresholdPct: intake.weeklyVarianceThresholdPct,
    staleDays: intake.weeklyStaleDays,
    minPeriodYear: intake.minPeriodYear,
    figureScale: intake.figureScale,
    figureIntegerDigits: intake.figureIntegerDigits,
  };
}

/* ---- The file ---- */

export interface WeeklyFile {
  rows: WeeklyRow[];
  /** Problems with the file as a whole: a column the file lacks or adds, nothing to read. */
  fileFindings: Finding[];
}

const UNKNOWN_COLUMN = { id: 'LAYOUT-01', severity: 'error' } as const;
const MISSING_COLUMN = { id: 'LAYOUT-02', severity: 'error' } as const;
const EMPTY_FILE = { id: 'LAYOUT-03', severity: 'error' } as const;
const TOO_MANY = { id: 'LAYOUT-04', severity: 'error' } as const;

const blankToNull = (value: string | undefined): string | null => {
  const text = (value ?? '').trim();
  return text === '' ? null : text;
};

/**
 * Reads a weekly file. The header must carry the four columns and no other (a renamed column is
 * never guessed at); a file-level error means nothing is staged. Rows are still read past file
 * errors so the reviewer sees what the file holds.
 */
export function readWeeklyFile(text: string, options: { maxRows: number }): WeeklyFile {
  const table = parseCsv(text);
  const fileFindings: Finding[] = [];
  const known = new Set<string>(WEEKLY_COLUMNS);
  const headerSet = new Set(table.header);
  for (const name of table.header) {
    if (!known.has(name))
      fileFindings.push(
        finding(UNKNOWN_COLUMN, `The file has a column the weekly layout does not know: ${name}`, {
          field: name,
          expected: WEEKLY_COLUMNS.join(', '),
          actual: name,
        }),
      );
  }
  for (const name of WEEKLY_COLUMNS) {
    if (!headerSet.has(name))
      fileFindings.push(
        finding(MISSING_COLUMN, `The file lacks the column ${name}`, {
          field: name,
          expected: name,
        }),
      );
  }
  if (table.rows.length === 0)
    fileFindings.push(finding(EMPTY_FILE, 'The file has a header and no rows'));
  if (table.rows.length > options.maxRows)
    fileFindings.push(
      finding(TOO_MANY, 'The file has more rows than one import takes', {
        expected: String(options.maxRows),
        actual: String(table.rows.length),
      }),
    );
  const index = new Map(table.header.map((name, i) => [name, i]));
  const cell = (line: readonly string[], column: WeeklyColumn): string | null =>
    blankToNull(line[index.get(column) ?? -1]);
  const rows: WeeklyRow[] = table.rows.slice(0, options.maxRows).map((line, i) => ({
    rowNo: i + 1,
    investmentNumber: cell(line, 'InvestmentNumber'),
    companyName: cell(line, 'CompanyName'),
    reportDate: cell(line, 'ReportDate'),
    reportedValue: cell(line, 'ReportedValue'),
    raw: Object.fromEntries(table.header.map((name, c) => [name, line[c] ?? ''])),
  }));
  return { rows, fileFindings };
}

/* ---- Shared readings ---- */

/** The reported value as a Decimal when it is a well-formed decimal string, else null. */
export function reportedValueOf(row: Pick<WeeklyRow, 'reportedValue'>): Decimal | null {
  const value = row.reportedValue;
  return value !== null && DECIMAL.test(value) ? D(value) : null;
}

/**
 * The row's report date when it is a real day from the first year the intake reads, else null:
 * WK-TYPE-01 reports the cell and every date rule skips the row, so no date arithmetic runs on it.
 */
export function reportDateOf(
  row: Pick<WeeklyRow, 'reportDate'>,
  config: WeeklyRuleConfig,
): string | null {
  const value = row.reportDate;
  if (value === null || !isCalendarDate(value)) return null;
  return Number(value.slice(0, 4)) < config.minPeriodYear ? null : value;
}

/**
 * The move against the prior as a decimal fraction (0.12 is up 12%): (reported minus prior)
 * divided by the size of the prior; null without a value, without a prior or against a prior of
 * zero (not calculable, docs/08). The service stores this and WK-BOUND-01 reads it.
 */
export function weeklyVariance(
  reportedValue: string | null,
  prior: Pick<WeeklyPrior, 'value'> | null,
): Decimal | null {
  const reported = reportedValueOf({ reportedValue });
  if (reported === null || prior === null || !DECIMAL.test(prior.value)) return null;
  const before = D(prior.value);
  if (before.isZero()) return null;
  return reported.minus(before).div(before.abs());
}

/** "the Locked mark of 2025-03-31" or "the weekly value of 2025-06-20", for a message. */
function priorWords(prior: WeeklyPrior): string {
  return `${prior.source === 'locked_mark' ? 'the Locked mark' : 'the weekly value'} of ${prior.date}`;
}

/** A fraction as a percentage with two decimals, for a message. */
const pct = (value: Decimal): string => `${value.times(100).toFixed(2)}%`;

/* ---- Required ---- */
const WK_REQ_01: WeeklyRule = {
  id: 'WK-REQ-01',
  category: 'required',
  severity: 'error',
  title:
    'An investment number or a company name identifies the row, and it carries a report date and a value',
  check: ({ row }) => {
    const out: Finding[] = [];
    if (row.investmentNumber === null && row.companyName === null)
      out.push(
        finding(
          WK_REQ_01,
          'The row names no investment: both the number and the company name are blank',
          { field: 'InvestmentNumber' },
        ),
      );
    // Required like the accounting REQ-02: a Draft valuation needs a date to value at, so a row
    // with no report date is flagged here and never lands validated only to fail at approval.
    if (row.reportDate === null)
      out.push(finding(WK_REQ_01, 'The row carries no report date', { field: 'ReportDate' }));
    if (row.reportedValue === null)
      out.push(finding(WK_REQ_01, 'The row carries no value', { field: 'ReportedValue' }));
    return out;
  },
};

/* ---- Types and units ---- */
const WK_TYPE_01: WeeklyRule = {
  id: 'WK-TYPE-01',
  category: 'types_units',
  severity: 'error',
  title: 'The report date is a calendar date of the form YYYY-MM-DD, from a year the intake reads',
  check: ({ row, config }) => {
    if (row.reportDate === null) return null;
    if (!isCalendarDate(row.reportDate))
      return finding(WK_TYPE_01, 'The report date is not a date of the form YYYY-MM-DD', {
        field: 'ReportDate',
        expected: 'YYYY-MM-DD',
        actual: row.reportDate,
      });
    return reportDateOf(row, config) === null
      ? finding(
          WK_TYPE_01,
          `The report date is before ${config.minPeriodYear}, earlier than any date the intake reads`,
          {
            field: 'ReportDate',
            expected: `${config.minPeriodYear}-01-01 or later`,
            actual: row.reportDate,
          },
        )
      : null;
  },
};
const WK_TYPE_02: WeeklyRule = {
  id: 'WK-TYPE-02',
  category: 'types_units',
  severity: 'error',
  title: 'The reported value is a plain decimal number',
  check: ({ row }) =>
    row.reportedValue !== null && !DECIMAL.test(row.reportedValue)
      ? finding(
          WK_TYPE_02,
          'ReportedValue is not a plain number (digits, a sign and a decimal point only)',
          {
            field: 'ReportedValue',
            expected: 'a decimal number',
            actual: row.reportedValue,
          },
        )
      : null,
};
/** The unit mistakes the rule looks for: the value scaled back would land within the threshold of the prior. */
const UNIT_SLIPS: readonly { factor: string; question: string }[] = [
  { factor: '1000000', question: 'was it entered in millions?' },
  { factor: '1000', question: 'was it entered in thousands?' },
  { factor: '0.01', question: 'was it entered in cents?' },
];
const WK_TYPE_04: WeeklyRule = {
  id: 'WK-TYPE-04',
  category: 'types_units',
  severity: 'error',
  title: 'The reported value is in dollars, judged against the prior',
  check: ({ row, prior, config }) => {
    const value = reportedValueOf(row);
    if (value === null || value.lte(0) || prior === null || !DECIMAL.test(prior.value)) return null;
    const before = D(prior.value);
    if (before.lte(0)) return null;
    const threshold = D(config.varianceThresholdPct);
    for (const slip of UNIT_SLIPS) {
      const scaled = value.times(slip.factor);
      if (scaled.minus(before).abs().div(before).lt(threshold))
        return finding(
          WK_TYPE_04,
          `ReportedValue is far from ${priorWords(prior)} but lands on it when scaled: ${slip.question}`,
          {
            field: 'ReportedValue',
            expected: `about ${before.toFixed(2)} dollars`,
            actual: value.toFixed(2),
          },
        );
    }
    return null;
  },
};
const WK_TYPE_05: WeeklyRule = {
  id: 'WK-TYPE-05',
  category: 'types_units',
  severity: 'error',
  title:
    'The reported value fits the record as written: no more decimal places or integer digits than it keeps',
  check: ({ row, config }) => {
    const value = row.reportedValue;
    if (value === null || !DECIMAL.test(value)) return null;
    const { integerDigits, decimalPlaces } = digitsOf(value);
    const out: Finding[] = [];
    if (decimalPlaces > config.figureScale)
      out.push(
        finding(
          WK_TYPE_05,
          `ReportedValue has ${decimalPlaces} decimal places; the record keeps ${config.figureScale}, so the value would be rounded`,
          {
            field: 'ReportedValue',
            expected: `at most ${config.figureScale} decimal places`,
            actual: value,
          },
        ),
      );
    if (integerDigits > config.figureIntegerDigits)
      out.push(
        finding(
          WK_TYPE_05,
          `ReportedValue has ${integerDigits} digits before the decimal point; the record holds at most ${config.figureIntegerDigits}`,
          {
            field: 'ReportedValue',
            expected: `at most ${config.figureIntegerDigits} digits before the decimal point`,
            actual: value,
          },
        ),
      );
    return out;
  },
};

/* ---- Ranges ---- */
const WK_RANGE_01: WeeklyRule = {
  id: 'WK-RANGE-01',
  category: 'ranges',
  severity: 'error',
  title: 'The reported value is not negative',
  check: ({ row }) => {
    const value = reportedValueOf(row);
    return value?.lt(0) === true
      ? finding(WK_RANGE_01, 'ReportedValue is negative', {
          field: 'ReportedValue',
          expected: '0 or more',
          actual: value.toFixed(2),
        })
      : null;
  },
};

/* ---- Period continuity ---- */
const WK_PERIOD_01: WeeklyRule = {
  id: 'WK-PERIOD-01',
  category: 'period_continuity',
  severity: 'error',
  title: 'The report date is not after the as-of date',
  check: ({ row, asOf, config }) => {
    const date = reportDateOf(row, config);
    if (date === null || date <= asOf) return null;
    return finding(WK_PERIOD_01, `The report date is after the as-of date (${asOf})`, {
      field: 'ReportDate',
      expected: `${asOf} or earlier`,
      actual: date,
    });
  },
};

/* ---- Bounds against the prior ---- */
const WK_BOUND_01: WeeklyRule = {
  id: 'WK-BOUND-01',
  category: 'period_bounds',
  severity: 'error',
  title: 'The value moves within the threshold against the prior; a larger move waits for a person',
  check: ({ row, prior, config }) => {
    const change = weeklyVariance(row.reportedValue, prior);
    if (change === null || prior === null) return null;
    const threshold = D(config.varianceThresholdPct);
    return change.abs().gte(threshold)
      ? finding(
          WK_BOUND_01,
          `ReportedValue moved ${pct(change)} against ${priorWords(prior)}, at or beyond the ${pct(threshold)} threshold; a person confirms the move`,
          {
            field: 'ReportedValue',
            expected: `within ${pct(threshold)} of ${D(prior.value).toFixed(2)}`,
            actual: reportedValueOf(row)?.toFixed(2) ?? '',
          },
        )
      : null;
  },
};

/* ---- Duplicates ---- */
/** The linked investment (else the number or name as written) and the report date as written. */
function duplicateKey(row: WeeklyRow, link: LinkResult): string | null {
  const who = link.investment?.id ?? normalizeName(row.investmentNumber ?? row.companyName ?? '');
  if (who === '') return null;
  return `${who}|${(row.reportDate ?? '').trim()}`;
}
const WK_DUP_01: WeeklyRule = {
  id: 'WK-DUP-01',
  category: 'duplicates',
  severity: 'error',
  title: 'A position and report date appear once in the file',
  check: ({ row, link, file }) => {
    const key = duplicateKey(row, link);
    if (key === null) return null;
    const first = file.find((r) => duplicateKey(r.row, r.link) === key);
    return first !== undefined && first.row.rowNo !== row.rowNo
      ? finding(WK_DUP_01, `Row ${first.row.rowNo} already carries this position and report date`, {
          expected: 'one row per position and report date',
          actual: `rows ${first.row.rowNo} and ${row.rowNo}`,
        })
      : null;
  },
};

/* ---- Cross-entity consistency ---- */
// The XREF messages name no candidate and count none: candidates travel on the link, where a reader
// sees the ones they may see, so a finding reads the same for everyone (walls, SEC-5.3).
const WK_XREF_01: WeeklyRule = {
  id: 'WK-XREF-01',
  category: 'cross_entity',
  severity: 'error',
  title: 'The row links to an investment on record',
  check: ({ link, row }) =>
    link.status === 'unmatched' && (row.investmentNumber !== null || row.companyName !== null)
      ? finding(
          WK_XREF_01,
          'No investment on record matches the number or the name; any candidates a person may see are listed on the row',
          { field: row.investmentNumber !== null ? 'InvestmentNumber' : 'CompanyName' },
        )
      : null,
};
const WK_XREF_02: WeeklyRule = {
  id: 'WK-XREF-02',
  category: 'cross_entity',
  severity: 'error',
  title: 'A name on the match guard list is never linked',
  check: ({ link }) =>
    link.status === 'guarded'
      ? finding(
          WK_XREF_02,
          'The company name is on the match guard list and is never linked automatically; a person decides',
          { field: 'CompanyName' },
        )
      : null,
};
const WK_XREF_03: WeeklyRule = {
  id: 'WK-XREF-03',
  category: 'cross_entity',
  severity: 'error',
  title: 'A name resolves to one investment',
  check: ({ link }) =>
    link.status === 'ambiguous'
      ? finding(
          WK_XREF_03,
          'The company name resolves to more than one investment on record; a person must pick one from the candidates they may see on the row',
          { field: 'CompanyName' },
        )
      : null,
};
// Approval opens a Draft valuation, and (new) > Draft needs an active investment (docs/18 section
// 1): an exited position is flagged here so one row never blocks the whole file's approval. The
// service's own check stays as the last guard, for a position exited between staging and approval.
const WK_XREF_04: WeeklyRule = {
  id: 'WK-XREF-04',
  category: 'cross_entity',
  severity: 'error',
  title: 'The linked investment is active, so approval can open a Draft valuation for it',
  check: ({ link }) =>
    link.investment !== null && !link.investment.isActive
      ? finding(
          WK_XREF_04,
          'The linked investment is not active: a weekly value cannot open a Draft valuation for it',
          { field: 'InvestmentNumber' },
        )
      : null,
};

/* ---- Stale ---- */
const WK_STALE_01: WeeklyRule = {
  id: 'WK-STALE-01',
  category: 'stale',
  severity: 'error',
  title: 'The report date is recent: not more than the stale window before the as-of date',
  check: ({ row, asOf, config }) => {
    const date = reportDateOf(row, config);
    if (date === null || date > asOf) return null;
    const behind = daysBetween(date, asOf);
    return behind > config.staleDays
      ? finding(
          WK_STALE_01,
          `The report date is ${behind} days before the as-of date (${asOf}), more than the ${config.staleDays} days the intake keeps current`,
          {
            field: 'ReportDate',
            expected: `${config.staleDays} days before ${asOf} or later`,
            actual: date,
          },
        )
      : null;
  },
};

/* ---- The prior ---- */
// The bound cannot be judged without a prior; the row still passes so a reviewer decides with the
// warning in view (a first weekly value for a position with no Locked mark yet).
const WK_PRIOR_01: WeeklyRule = {
  id: 'WK-PRIOR-01',
  category: 'period_bounds',
  severity: 'warning',
  title: 'A prior value is on record, so the move can be judged',
  check: ({ link, prior }) => {
    if (link.investment === null) return null;
    if (prior === null)
      return finding(
        WK_PRIOR_01,
        'No prior value is on record for this position by the report date: the variance is not calculable',
        { field: 'ReportedValue' },
      );
    return DECIMAL.test(prior.value) && D(prior.value).isZero()
      ? finding(WK_PRIOR_01, `${priorWords(prior)} is zero: the variance is not calculable`, {
          field: 'ReportedValue',
        })
      : null;
  },
};

/** Every weekly intake rule, in the order findings are reported. */
export const WEEKLY_RULES: readonly WeeklyRule[] = [
  WK_REQ_01,
  WK_TYPE_01,
  WK_TYPE_02,
  WK_TYPE_04,
  WK_TYPE_05,
  WK_RANGE_01,
  WK_PERIOD_01,
  WK_BOUND_01,
  WK_DUP_01,
  WK_XREF_01,
  WK_XREF_02,
  WK_XREF_03,
  WK_XREF_04,
  WK_STALE_01,
  WK_PRIOR_01,
];

/** The rule whose finding sets the flag column of a staged weekly value (stg.valuation.flag). */
export const ABOVE_THRESHOLD_RULE = WK_BOUND_01.id;

/** The flag of a staged value from its findings: above_threshold when WK-BOUND-01 fired, else null. */
export function weeklyFlagOf(findings: readonly Finding[]): 'above_threshold' | null {
  return findings.some((f) => f.ruleId === ABOVE_THRESHOLD_RULE) ? 'above_threshold' : null;
}
