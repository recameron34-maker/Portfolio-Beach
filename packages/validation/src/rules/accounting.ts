import {
  D,
  addMonths,
  alignedQuarterEnd,
  containingQuarterEnd,
  quarterOf as calendarQuarterOf,
  sameQuarterPriorYear,
  yearOf,
} from '@pb/calc';
import type { Decimal } from '@pb/calc';
import type { CurrentQuarter } from '../diff.js';
import { FIGURE_FIELDS } from '../layout.js';
import type { AccountingRow, FigureField } from '../layout.js';
import { normalizeName } from '../linking.js';
import type { LinkResult } from '../linking.js';
import { finding } from '../types.js';
import type { Finding, Rule } from '../types.js';

/**
 * Thresholds every rule reads from config (CLAUDE.md rule 9), never from literals here. The API
 * fills them from config/definitions.json with its strict readers; the preview from the same file.
 */
export interface AccountingRuleConfig {
  /** Revenue below this reads as entered in thousands or millions (definitions.unitSanityBoundsUsd). */
  revenueMinUsd: string;
  revenueMaxUsd: string;
  /** How far the file's fair value may sit from the Locked mark before it is an error. */
  fairValueTieToleranceUsd: string;
  /** Quarter-over-quarter change (as a decimal, 0.5 = 50%) above which a figure is questioned. */
  quarterOverQuarterMaxChangePct: string;
  yearOverYearMaxChangePct: string;
  /** A row this many quarters behind the latest approved quarter is a late restatement. */
  staleQuarters: number;
  /** EV/EBITDA above this is questioned. */
  evToEbitdaMax: string;
  /** An EBITDA margin whose size (as a decimal, 1 = 100%) is above this is questioned (intake.ebitdaMarginAbsMax). */
  ebitdaMarginAbsMax: string;
  /** How far a period end may sit from a quarter end (definitions.priorYearPeriodEndToleranceDays). */
  periodEndToleranceDays: number;
  /** Decimal places the record keeps for a figure (intake.figureScale, the scale of its numeric columns). */
  figureScale: number;
  /** Digits before the decimal point the record holds (intake.figureIntegerDigits, precision minus scale). */
  figureIntegerDigits: number;
  /** A period end before this year is not a date the import reads (intake.minPeriodYear). */
  minPeriodYear: number;
}

/** A row of the file with the link the importer made for it. */
export interface LinkedRow {
  row: AccountingRow;
  link: LinkResult;
}

export interface AccountingRuleContext {
  row: AccountingRow;
  /** Every row of the file with its link, for duplicates and in-file continuity. */
  file: readonly LinkedRow[];
  link: LinkResult;
  /** The linked investment's approved quarters, oldest first, and its Locked mark for the row's quarter. */
  current: {
    quarters: readonly (CurrentQuarter & { isEntrySnapshot: boolean })[];
    lockedFairValue: { periodEnd: string; fairValue: string } | null;
  };
  asOf: string;
  config: AccountingRuleConfig;
}

type AccountingRule = Rule<AccountingRuleContext>;

const DECIMAL = /^-?\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD_LABEL: Record<FigureField, string> = {
  revenueLtm: 'RevenueLTM',
  ebitdaLtm: 'EBITDALTM',
  ev: 'EnterpriseValue',
  netDebt: 'NetDebt',
  fairValue: 'FairValue',
};

/** The figure as a Decimal when it is a well-formed decimal string, else null. */
function figure(row: AccountingRow, field: FigureField): Decimal | null {
  const value = row.figures[field];
  return value !== null && DECIMAL.test(value) ? D(value) : null;
}

/** The digits a well-formed decimal string carries, leading and trailing zeros aside (TYPE-05 and WK-TYPE-05). */
export function digitsOf(value: string): { integerDigits: number; decimalPlaces: number } {
  const [whole = '', fraction = ''] = value.replace(/^-/, '').split('.');
  return {
    integerDigits: whole.replace(/^0+(?=\d)/, '').length,
    decimalPlaces: fraction.replace(/0+$/, '').length,
  };
}

/** A real calendar date in ISO form (year, month and day all within range), with no date arithmetic. */
export function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const lengths = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= (lengths[month - 1] ?? 0);
}

/**
 * The row's period end when it is a real date from the first year the import reads, else null:
 * TYPE-01 reports the cell and every date rule skips the row, so no date arithmetic runs on it.
 */
function periodOf(row: AccountingRow, config: AccountingRuleConfig): string | null {
  const value = row.periodEnd;
  if (value === null || !isCalendarDate(value)) return null;
  return Number(value.slice(0, 4)) < config.minPeriodYear ? null : value;
}

/** The quarter a row reports for (a sponsor closing a few days early lands on the quarter). */
function quarterOfRow(row: AccountingRow, config: AccountingRuleConfig): string | null {
  const period = periodOf(row, config);
  return period === null ? null : alignedQuarterEnd(period, config.periodEndToleranceDays);
}

function quarterOf(ctx: AccountingRuleContext): string | null {
  return quarterOfRow(ctx.row, ctx.config);
}

/** Calendar quarters counted from year zero for the quarter a date reports for: counted, never divided. */
function quarterIndex(date: string, toleranceDays: number): number {
  const quarter = containingQuarterEnd(alignedQuarterEnd(date, toleranceDays));
  return yearOf(quarter) * 4 + calendarQuarterOf(quarter);
}

/** The latest approved quarter on record, the entry snapshot aside. */
function latestOnRecord(ctx: AccountingRuleContext): string | null {
  return ctx.current.quarters
    .filter((q) => !q.isEntrySnapshot)
    .reduce<string | null>(
      (max, q) => (max === null || q.periodEnd > max ? q.periodEnd : max),
      null,
    );
}

/**
 * The latest approved quarter strictly before the row's quarter, compared on the quarter each
 * reports for, so a shifted period end of the row's own quarter is never its prior.
 */
function priorQuarter(ctx: AccountingRuleContext): CurrentQuarter | null {
  const quarter = quarterOf(ctx);
  if (quarter === null) return null;
  let best: { quarter: CurrentQuarter; aligned: string } | null = null;
  for (const q of ctx.current.quarters) {
    const aligned = alignedQuarterEnd(q.periodEnd, ctx.config.periodEndToleranceDays);
    if (aligned < quarter && (best === null || aligned > best.aligned))
      best = { quarter: q, aligned };
  }
  return best?.quarter ?? null;
}

function changePct(current: Decimal, prior: Decimal): Decimal | null {
  if (prior.isZero()) return null;
  return current.minus(prior).div(prior.abs());
}

const pct = (d: Decimal): string => `${d.times(100).toFixed(1)}%`;

function boundFinding(
  rule: AccountingRule,
  field: FigureField,
  label: string,
  change: Decimal,
  limit: string,
): Finding {
  return finding(
    rule,
    `${FIELD_LABEL[field]} moved ${pct(change)} ${label}, beyond the ${pct(D(limit))} the import questions`,
    { field: FIELD_LABEL[field], expected: `within ${pct(D(limit))}`, actual: pct(change) },
  );
}

/* ---- Required ---- */
const REQ_01: AccountingRule = {
  id: 'REQ-01',
  category: 'required',
  severity: 'error',
  title: 'An investment number or a company name identifies the row',
  check: ({ row }) =>
    row.investmentNumber === null && row.companyName === null
      ? finding(
          REQ_01,
          'The row names no investment: both the number and the company name are blank',
          {
            field: 'InvestmentNumber',
          },
        )
      : null,
};
const REQ_02: AccountingRule = {
  id: 'REQ-02',
  category: 'required',
  severity: 'error',
  title: 'The period end is present',
  check: ({ row }) =>
    row.periodEnd === null
      ? finding(REQ_02, 'The period end is blank', { field: 'PeriodEnd' })
      : null,
};
const REQ_03: AccountingRule = {
  id: 'REQ-03',
  category: 'required',
  severity: 'error',
  title: 'At least one figure is present',
  check: ({ row }) =>
    FIGURE_FIELDS.every((f) => row.figures[f] === null)
      ? finding(REQ_03, 'The row carries no figure at all')
      : null,
};
const REQ_04: AccountingRule = {
  id: 'REQ-04',
  category: 'required',
  severity: 'warning',
  title: 'Revenue is present, so margins stay calculable',
  check: ({ row }) =>
    row.figures.revenueLtm === null
      ? finding(REQ_04, 'RevenueLTM is blank, so the EBITDA margin will not be calculable', {
          field: 'RevenueLTM',
        })
      : null,
};

/* ---- Types and units ---- */
const TYPE_01: AccountingRule = {
  id: 'TYPE-01',
  category: 'types_units',
  severity: 'error',
  title: 'The period end is a calendar date in the layout format, from a year the import reads',
  check: ({ row, config }) => {
    if (row.periodEnd === null) return null;
    if (!isCalendarDate(row.periodEnd))
      return finding(TYPE_01, 'The period end is not a date of the form YYYY-MM-DD', {
        field: 'PeriodEnd',
        expected: 'YYYY-MM-DD',
        actual: row.periodEnd,
      });
    return periodOf(row, config) === null
      ? finding(
          TYPE_01,
          `The period end is before ${config.minPeriodYear}, earlier than any period the import reads`,
          {
            field: 'PeriodEnd',
            expected: `${config.minPeriodYear}-01-01 or later`,
            actual: row.periodEnd,
          },
        )
      : null;
  },
};
const TYPE_02: AccountingRule = {
  id: 'TYPE-02',
  category: 'types_units',
  severity: 'error',
  title: 'Every figure is a plain decimal number',
  check: ({ row }) =>
    FIGURE_FIELDS.filter((f) => row.figures[f] !== null && !DECIMAL.test(row.figures[f] ?? '')).map(
      (f) =>
        finding(
          TYPE_02,
          `${FIELD_LABEL[f]} is not a plain number (digits, a sign and a decimal point only)`,
          {
            field: FIELD_LABEL[f],
            expected: 'a decimal number',
            actual: row.figures[f] ?? '',
          },
        ),
    ),
};
const TYPE_03: AccountingRule = {
  id: 'TYPE-03',
  category: 'types_units',
  severity: 'error',
  title: 'The period end sits on or near a calendar quarter end',
  check: (ctx) => {
    const period = periodOf(ctx.row, ctx.config);
    if (period === null) return null;
    // alignedQuarterEnd returns the period itself when it is too far from any quarter end.
    const aligned = alignedQuarterEnd(period, ctx.config.periodEndToleranceDays);
    return aligned === containingQuarterEnd(aligned)
      ? null
      : finding(
          TYPE_03,
          'The period end is more than a few days from a calendar quarter end; a person confirms which quarter it reports for',
          {
            field: 'PeriodEnd',
            expected: `a quarter end, or within ${ctx.config.periodEndToleranceDays} days of one`,
            actual: period,
          },
        );
  },
};
const TYPE_04: AccountingRule = {
  id: 'TYPE-04',
  category: 'types_units',
  severity: 'error',
  title: 'Revenue is in dollars, within the unit sanity bounds',
  check: (ctx) => {
    const revenue = figure(ctx.row, 'revenueLtm');
    if (revenue === null || revenue.lte(0)) return null;
    const min = D(ctx.config.revenueMinUsd);
    const max = D(ctx.config.revenueMaxUsd);
    if (revenue.lt(min))
      return finding(
        TYPE_04,
        'RevenueLTM is far below the unit sanity floor: was it entered in thousands or millions?',
        {
          field: 'RevenueLTM',
          expected: `at least ${min.toFixed(0)} dollars`,
          actual: revenue.toFixed(2),
        },
      );
    if (revenue.gt(max))
      return finding(
        TYPE_04,
        'RevenueLTM is above the unit sanity ceiling: was it entered in cents?',
        {
          field: 'RevenueLTM',
          expected: `at most ${max.toFixed(0)} dollars`,
          actual: revenue.toFixed(2),
        },
      );
    return null;
  },
};
const TYPE_05: AccountingRule = {
  id: 'TYPE-05',
  category: 'types_units',
  severity: 'error',
  title:
    'Every figure fits the record as written: no more decimal places or integer digits than it keeps',
  check: ({ row, config }) =>
    FIGURE_FIELDS.flatMap((f) => {
      const value = row.figures[f];
      if (value === null || !DECIMAL.test(value)) return [];
      const { integerDigits, decimalPlaces } = digitsOf(value);
      const out: Finding[] = [];
      if (decimalPlaces > config.figureScale)
        out.push(
          finding(
            TYPE_05,
            `${FIELD_LABEL[f]} has ${decimalPlaces} decimal places; the record keeps ${config.figureScale}, so the figure would be rounded`,
            {
              field: FIELD_LABEL[f],
              expected: `at most ${config.figureScale} decimal places`,
              actual: value,
            },
          ),
        );
      if (integerDigits > config.figureIntegerDigits)
        out.push(
          finding(
            TYPE_05,
            `${FIELD_LABEL[f]} has ${integerDigits} digits before the decimal point; the record holds at most ${config.figureIntegerDigits}`,
            {
              field: FIELD_LABEL[f],
              expected: `at most ${config.figureIntegerDigits} digits before the decimal point`,
              actual: value,
            },
          ),
        );
      return out;
    }),
};

/* ---- Ranges ---- */
const nonNegative = (id: string, field: FigureField, title: string): AccountingRule => {
  const rule: AccountingRule = {
    id,
    category: 'ranges',
    severity: 'error',
    title,
    check: ({ row }) => {
      const value = figure(row, field);
      return value?.lt(0) === true
        ? finding(rule, `${FIELD_LABEL[field]} is negative`, {
            field: FIELD_LABEL[field],
            expected: '0 or more',
            actual: value.toFixed(2),
          })
        : null;
    },
  };
  return rule;
};
const RANGE_01 = nonNegative('RANGE-01', 'revenueLtm', 'Revenue is not negative');
const RANGE_02 = nonNegative('RANGE-02', 'ev', 'Enterprise value is not negative');
const RANGE_03: AccountingRule = {
  id: 'RANGE-03',
  category: 'ranges',
  severity: 'warning',
  title: 'The EBITDA margin lies within the band the import questions',
  check: ({ row, config }) => {
    const revenue = figure(row, 'revenueLtm');
    const ebitda = figure(row, 'ebitdaLtm');
    if (revenue === null || ebitda === null || revenue.lte(0)) return null;
    const margin = ebitda.div(revenue);
    const max = D(config.ebitdaMarginAbsMax);
    return margin.abs().gt(max)
      ? finding(
          RANGE_03,
          `The EBITDA margin is ${pct(margin)}, outside the -${pct(max)} to ${pct(max)} the import questions`,
          {
            field: 'EBITDALTM',
            expected: `between -${pct(max)} and ${pct(max)}`,
            actual: pct(margin),
          },
        )
      : null;
  },
};
const RANGE_04: AccountingRule = {
  id: 'RANGE-04',
  category: 'ranges',
  severity: 'warning',
  title: 'EV/EBITDA is within the questioned ceiling',
  check: (ctx) => {
    const ev = figure(ctx.row, 'ev');
    const ebitda = figure(ctx.row, 'ebitdaLtm');
    if (ev === null || ebitda === null || ebitda.lte(0)) return null;
    const multiple = ev.div(ebitda);
    const max = D(ctx.config.evToEbitdaMax);
    return multiple.gt(max)
      ? finding(
          RANGE_04,
          `EV/EBITDA is ${multiple.toFixed(1)}x, above the ${max.toFixed(0)}x the import questions`,
          {
            field: 'EnterpriseValue',
            expected: `at most ${max.toFixed(0)}x`,
            actual: `${multiple.toFixed(1)}x`,
          },
        )
      : null;
  },
};
const RANGE_05 = nonNegative('RANGE-05', 'fairValue', 'Fair value is not negative');

/* ---- Period continuity ---- */
const PERIOD_01: AccountingRule = {
  id: 'PERIOD-01',
  category: 'period_continuity',
  severity: 'error',
  title: 'The period is not before the investment was entered',
  check: (ctx) => {
    const quarter = quarterOf(ctx);
    const inv = ctx.link.investment;
    if (quarter === null || inv === null) return null;
    // The quarter before entry carries the entry snapshot; anything earlier is not this position's.
    const earliest = containingQuarterEnd(addMonths(inv.entryDate, -3));
    return quarter < earliest
      ? finding(PERIOD_01, `The period ends before the investment was entered (${inv.entryDate})`, {
          field: 'PeriodEnd',
          expected: `${earliest} or later`,
          actual: quarter,
        })
      : null;
  },
};
const PERIOD_02: AccountingRule = {
  id: 'PERIOD-02',
  category: 'period_continuity',
  severity: 'error',
  title: 'The period is not after the as-of date',
  check: (ctx) => {
    const period = periodOf(ctx.row, ctx.config);
    return period !== null && period > ctx.asOf
      ? finding(PERIOD_02, `The period ends after the as-of date (${ctx.asOf})`, {
          field: 'PeriodEnd',
          expected: `${ctx.asOf} or earlier`,
          actual: period,
        })
      : null;
  },
};
const PERIOD_03: AccountingRule = {
  id: 'PERIOD-03',
  category: 'period_continuity',
  severity: 'warning',
  title: 'A realized investment receives no quarter after its exit',
  check: (ctx) => {
    const quarter = quarterOf(ctx);
    const inv = ctx.link.investment;
    const exitDate = inv?.exitDate ?? null;
    if (quarter === null || inv === null || exitDate === null) return null;
    return quarter > containingQuarterEnd(exitDate)
      ? finding(
          PERIOD_03,
          `The investment was realized on ${exitDate}; this quarter comes after it`,
          {
            field: 'PeriodEnd',
            expected: `${containingQuarterEnd(exitDate)} or earlier`,
            actual: quarter,
          },
        )
      : null;
  },
};
const PERIOD_04: AccountingRule = {
  id: 'PERIOD-04',
  category: 'period_continuity',
  severity: 'warning',
  title: 'A new quarter follows the latest approved one without a gap',
  check: (ctx) => {
    const quarter = quarterOf(ctx);
    if (quarter === null || ctx.link.investment === null) return null;
    const latest = latestOnRecord(ctx);
    if (latest === null || quarter <= latest) return null;
    const next = containingQuarterEnd(addMonths(latest, 3));
    return quarter > next
      ? finding(PERIOD_04, `The quarters between ${latest} and ${quarter} are not on record`, {
          field: 'PeriodEnd',
          expected: next,
          actual: quarter,
        })
      : null;
  },
};
const PERIOD_05: AccountingRule = {
  id: 'PERIOD-05',
  category: 'period_continuity',
  severity: 'error',
  title: 'The quarter is not the entry snapshot, the basis of growth since entry',
  check: (ctx) => {
    const quarter = quarterOf(ctx);
    if (quarter === null || ctx.link.investment === null) return null;
    const snapshot = ctx.current.quarters.find(
      (q) =>
        q.isEntrySnapshot &&
        alignedQuarterEnd(q.periodEnd, ctx.config.periodEndToleranceDays) === quarter,
    );
    return snapshot === undefined
      ? null
      : finding(
          PERIOD_05,
          `This quarter (${snapshot.periodEnd}) is the entry snapshot on record, the basis of growth since entry; a person decides whether it changes`,
          {
            field: 'PeriodEnd',
            expected: 'a quarter after the entry snapshot',
            actual: quarter,
          },
        );
  },
};

/* ---- Quarter-over-quarter and year-over-year bounds ---- */
const qoq = (
  id: string,
  field: Exclude<FigureField, 'fairValue'>,
  title: string,
): AccountingRule => {
  const rule: AccountingRule = {
    id,
    category: 'period_bounds',
    severity: 'warning',
    title,
    check: (ctx) => {
      const current = figure(ctx.row, field);
      const prior = priorQuarter(ctx);
      const before = prior?.[field] ?? null;
      if (current === null || before === null || !DECIMAL.test(before)) return null;
      // A prior at or below zero makes the change not calculable (docs/08); a current one does not:
      // a collapse into a loss is the move most worth questioning.
      const priorValue = D(before);
      if (priorValue.lte(0)) return null;
      const change = changePct(current, priorValue);
      const limit = ctx.config.quarterOverQuarterMaxChangePct;
      return change?.abs().gt(D(limit)) === true
        ? boundFinding(
            rule,
            field,
            `against the prior quarter (${prior?.periodEnd ?? ''})`,
            change,
            limit,
          )
        : null;
    },
  };
  return rule;
};
const BOUND_01 = qoq(
  'BOUND-01',
  'revenueLtm',
  'Revenue moves within the quarter-over-quarter bound',
);
const BOUND_02 = qoq('BOUND-02', 'ebitdaLtm', 'EBITDA moves within the quarter-over-quarter bound');
const BOUND_03: AccountingRule = {
  id: 'BOUND-03',
  category: 'period_bounds',
  severity: 'warning',
  title: 'Revenue moves within the year-over-year bound against the same quarter a year earlier',
  check: (ctx) => {
    const current = figure(ctx.row, 'revenueLtm');
    const quarter = quarterOf(ctx);
    if (current === null || quarter === null) return null;
    // Every quarter in the context is approved: the API loads only those.
    const prior = sameQuarterPriorYear(
      ctx.current.quarters.map((q) => ({ ...q, status: 'approved' })),
      quarter,
      { toleranceDays: ctx.config.periodEndToleranceDays },
    );
    if (prior === null) return null;
    if (prior.revenueLtm === null || !DECIMAL.test(prior.revenueLtm)) return null;
    const priorValue = D(prior.revenueLtm);
    if (priorValue.lte(0)) return null;
    const change = changePct(current, priorValue);
    const limit = ctx.config.yearOverYearMaxChangePct;
    return change?.abs().gt(D(limit)) === true
      ? boundFinding(
          BOUND_03,
          'revenueLtm',
          `against the same quarter a year earlier (${prior.periodEnd})`,
          change,
          limit,
        )
      : null;
  },
};
const BOUND_04 = qoq(
  'BOUND-04',
  'ev',
  'Enterprise value moves within the quarter-over-quarter bound',
);

/* ---- Totals that tie ---- */
const TIE_01: AccountingRule = {
  id: 'TIE-01',
  category: 'totals_tie',
  severity: 'error',
  title: 'The fair value ties to the Locked mark for the quarter',
  check: (ctx) => {
    const fileValue = figure(ctx.row, 'fairValue');
    const locked = ctx.current.lockedFairValue;
    if (fileValue === null || locked === null) return null;
    const gap = fileValue.minus(D(locked.fairValue)).abs();
    return gap.gt(D(ctx.config.fairValueTieToleranceUsd))
      ? finding(
          TIE_01,
          `FairValue differs from the Locked mark for ${locked.periodEnd} by ${gap.toFixed(2)} dollars`,
          {
            field: 'FairValue',
            expected: D(locked.fairValue).toFixed(2),
            actual: fileValue.toFixed(2),
          },
        )
      : null;
  },
};
const TIE_02: AccountingRule = {
  id: 'TIE-02',
  category: 'totals_tie',
  severity: 'warning',
  title: 'Enterprise value covers net debt (equity is not negative)',
  check: ({ row }) => {
    const ev = figure(row, 'ev');
    const netDebt = figure(row, 'netDebt');
    if (ev === null || netDebt === null) return null;
    return ev.lt(netDebt)
      ? finding(
          TIE_02,
          `NetDebt exceeds EnterpriseValue by ${netDebt.minus(ev).toFixed(2)} dollars, so equity is negative`,
          {
            field: 'NetDebt',
            expected: `at most ${ev.toFixed(2)}`,
            actual: netDebt.toFixed(2),
          },
        )
      : null;
  },
};
const TIE_03: AccountingRule = {
  id: 'TIE-03',
  category: 'totals_tie',
  severity: 'warning',
  title: 'A fair value in the file has a Locked mark on record to tie to',
  check: (ctx) => {
    const fileValue = figure(ctx.row, 'fairValue');
    const quarter = quarterOf(ctx);
    if (fileValue === null || quarter === null || ctx.link.investment === null) return null;
    if (ctx.current.lockedFairValue !== null) return null;
    return finding(TIE_03, `No Locked mark on record for ${quarter}; FairValue could not be tied`, {
      field: 'FairValue',
      expected: 'a Locked mark for the quarter',
      actual: fileValue.toFixed(2),
    });
  },
};

/* ---- Duplicates ---- */
/**
 * What a row is about: the investment it links to, else the number or name as written, and the
 * quarter it reports for; so a row by number and a row by name, or two period ends of one
 * quarter, are the same row twice.
 */
function duplicateKey(
  row: AccountingRow,
  link: LinkResult,
  config: AccountingRuleConfig,
): string | null {
  const who = link.investment?.id ?? normalizeName(row.investmentNumber ?? row.companyName ?? '');
  if (who === '') return null;
  return `${who}|${quarterOfRow(row, config) ?? row.periodEnd ?? ''}`;
}
const DUP_01: AccountingRule = {
  id: 'DUP-01',
  category: 'duplicates',
  severity: 'error',
  title: 'An investment and quarter appear once in the file',
  check: ({ row, link, file, config }) => {
    const key = duplicateKey(row, link, config);
    if (key === null) return null;
    const first = file.find((r) => duplicateKey(r.row, r.link, config) === key);
    return first !== undefined && first.row.rowNo !== row.rowNo
      ? finding(DUP_01, `Row ${first.row.rowNo} already carries this investment and quarter`, {
          expected: 'one row per investment and quarter',
          actual: `rows ${first.row.rowNo} and ${row.rowNo}`,
        })
      : null;
  },
};
const DUP_02: AccountingRule = {
  id: 'DUP-02',
  category: 'duplicates',
  severity: 'warning',
  title: 'An investment number carries one company name across the file',
  check: ({ row, file }) => {
    if (row.investmentNumber === null || row.companyName === null) return null;
    const other = file.find(
      ({ row: r }) =>
        r.rowNo < row.rowNo &&
        r.investmentNumber?.toUpperCase() === row.investmentNumber?.toUpperCase() &&
        r.companyName !== null &&
        r.companyName.trim() !== row.companyName?.trim(),
    )?.row;
    return other !== undefined
      ? finding(
          DUP_02,
          `Row ${other.rowNo} names this investment ${other.companyName ?? ''}; this row says ${row.companyName}`,
          {
            field: 'CompanyName',
            expected: other.companyName ?? '',
            actual: row.companyName,
          },
        )
      : null;
  },
};

/* ---- Cross-entity consistency ---- */
// The XREF messages name no candidate and count none: candidates travel on the link, where a reader
// sees the ones they may see, so a finding reads the same for everyone (walls, SEC-5.3).
const XREF_01: AccountingRule = {
  id: 'XREF-01',
  category: 'cross_entity',
  severity: 'error',
  title: 'The row links to an investment on record',
  check: ({ link, row }) =>
    link.status === 'unmatched' && (row.investmentNumber !== null || row.companyName !== null)
      ? finding(
          XREF_01,
          'No investment on record matches the number or the name; any candidates a person may see are listed on the row',
          { field: row.investmentNumber !== null ? 'InvestmentNumber' : 'CompanyName' },
        )
      : null,
};
const XREF_02: AccountingRule = {
  id: 'XREF-02',
  category: 'cross_entity',
  severity: 'error',
  title: 'A name on the match guard list is never linked',
  check: ({ link }) =>
    link.status === 'guarded'
      ? finding(
          XREF_02,
          'The company name is on the match guard list and is never linked automatically; a person decides',
          {
            field: 'CompanyName',
          },
        )
      : null,
};
const XREF_03: AccountingRule = {
  id: 'XREF-03',
  category: 'cross_entity',
  severity: 'error',
  title: 'A name resolves to one investment',
  check: ({ link }) =>
    link.status === 'ambiguous'
      ? finding(
          XREF_03,
          'The company name resolves to more than one investment on record; a person must pick one from the candidates they may see on the row',
          {
            field: 'CompanyName',
          },
        )
      : null,
};
const XREF_04: AccountingRule = {
  id: 'XREF-04',
  category: 'cross_entity',
  severity: 'warning',
  title: 'The company name on the row agrees with the linked investment',
  check: ({ link, row }) => {
    if (link.status !== 'matched' || link.by !== 'number' || link.investment === null) return null;
    if (row.companyName === null) return null;
    const inv = link.investment;
    const wanted = row.companyName.trim().toLowerCase();
    const agrees = [inv.companyName, inv.canonicalName, ...inv.aliases].some(
      (n) => n.trim().toLowerCase() === wanted,
    );
    return agrees
      ? null
      : finding(
          XREF_04,
          `The file calls ${inv.investmentNumber} ${row.companyName}; on record it is ${inv.companyName}`,
          {
            field: 'CompanyName',
            expected: inv.companyName,
            actual: row.companyName,
          },
        );
  },
};
const XREF_05: AccountingRule = {
  id: 'XREF-05',
  category: 'cross_entity',
  severity: 'error',
  title: 'Quarterly performance applies to equity and CV positions, not private credit',
  check: ({ link }) =>
    link.investment !== null && link.investment.dealType === 'deal_type.private_credit'
      ? finding(
          XREF_05,
          `${link.investment.investmentNumber} is a private credit position; its figures belong in credit performance, not here`,
          {
            field: 'InvestmentNumber',
          },
        )
      : null,
};

/* ---- Stale ---- */
const STALE_01: AccountingRule = {
  id: 'STALE-01',
  category: 'stale',
  severity: 'warning',
  title: 'A restated quarter is not far behind the latest approved one',
  check: (ctx) => {
    const quarter = quarterOf(ctx);
    if (quarter === null || ctx.link.investment === null) return null;
    const latest = latestOnRecord(ctx);
    if (latest === null) return null;
    const tolerance = ctx.config.periodEndToleranceDays;
    const behind = quarterIndex(latest, tolerance) - quarterIndex(quarter, tolerance);
    if (behind <= 0 || behind < ctx.config.staleQuarters) return null;
    return finding(
      STALE_01,
      `This quarter is ${behind} quarter${behind === 1 ? '' : 's'} behind the latest approved one (${latest}): a late restatement`,
      {
        field: 'PeriodEnd',
        expected: `within ${ctx.config.staleQuarters} quarters of ${latest}`,
        actual: quarter,
      },
    );
  },
};

/** Every accounting import rule, in the order findings are reported. */
export const ACCOUNTING_RULES: readonly AccountingRule[] = [
  REQ_01,
  REQ_02,
  REQ_03,
  REQ_04,
  TYPE_01,
  TYPE_02,
  TYPE_03,
  TYPE_04,
  TYPE_05,
  RANGE_01,
  RANGE_02,
  RANGE_03,
  RANGE_04,
  RANGE_05,
  PERIOD_01,
  PERIOD_02,
  PERIOD_03,
  PERIOD_04,
  PERIOD_05,
  BOUND_01,
  BOUND_02,
  BOUND_03,
  BOUND_04,
  TIE_01,
  TIE_02,
  TIE_03,
  DUP_01,
  DUP_02,
  XREF_01,
  XREF_02,
  XREF_03,
  XREF_04,
  XREF_05,
  STALE_01,
];
