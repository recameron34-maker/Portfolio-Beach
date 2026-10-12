import {
  D,
  addMonths,
  alignedQuarterEnd,
  containingQuarterEnd,
  daysBetween,
  sameQuarterPriorYear,
} from '@pb/calc';
import type { Decimal } from '@pb/calc';
import type { CurrentQuarter } from '../diff.js';
import { FIGURE_FIELDS } from '../layout.js';
import type { AccountingRow, FigureField } from '../layout.js';
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
  /** How far a period end may sit from a quarter end (definitions.priorYearPeriodEndToleranceDays). */
  periodEndToleranceDays: number;
}

export interface AccountingRuleContext {
  row: AccountingRow;
  /** Every row of the file, for duplicates and in-file continuity. */
  file: readonly AccountingRow[];
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

function isCalendarDate(value: string): boolean {
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

/** The row's period end when it is a real date, else null. */
function periodOf(row: AccountingRow): string | null {
  return row.periodEnd !== null && isCalendarDate(row.periodEnd) ? row.periodEnd : null;
}

/** The quarter the row reports for (a sponsor closing a few days early lands on the quarter). */
function quarterOf(ctx: AccountingRuleContext): string | null {
  const period = periodOf(ctx.row);
  return period === null ? null : alignedQuarterEnd(period, ctx.config.periodEndToleranceDays);
}

/** The latest approved quarter strictly before the row's quarter. */
function priorQuarter(ctx: AccountingRuleContext): CurrentQuarter | null {
  const quarter = quarterOf(ctx);
  if (quarter === null) return null;
  let best: CurrentQuarter | null = null;
  for (const q of ctx.current.quarters) {
    if (q.periodEnd < quarter && (best === null || q.periodEnd > best.periodEnd)) best = q;
  }
  return best;
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
  title: 'The period end is a calendar date in the layout format',
  check: ({ row }) =>
    row.periodEnd !== null && !isCalendarDate(row.periodEnd)
      ? finding(TYPE_01, 'The period end is not a date of the form YYYY-MM-DD', {
          field: 'PeriodEnd',
          expected: 'YYYY-MM-DD',
          actual: row.periodEnd,
        })
      : null,
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
  severity: 'warning',
  title: 'The period end sits on or near a calendar quarter end',
  check: (ctx) => {
    const period = periodOf(ctx.row);
    if (period === null) return null;
    const aligned = alignedQuarterEnd(period, ctx.config.periodEndToleranceDays);
    // alignedQuarterEnd returns the period itself when it is too far from any quarter end.
    const onQuarter = aligned === containingQuarterEnd(aligned) && aligned !== period;
    const isQuarterEnd = period === containingQuarterEnd(period);
    return isQuarterEnd || onQuarter
      ? null
      : finding(TYPE_03, 'The period end is more than a few days from a calendar quarter end', {
          field: 'PeriodEnd',
          expected: 'a quarter end',
          actual: period,
        });
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
  title: 'The EBITDA margin lies between -100% and 100%',
  check: ({ row }) => {
    const revenue = figure(row, 'revenueLtm');
    const ebitda = figure(row, 'ebitdaLtm');
    if (revenue === null || ebitda === null || revenue.lte(0)) return null;
    const margin = ebitda.div(revenue);
    return margin.abs().gt(1)
      ? finding(
          RANGE_03,
          `The EBITDA margin is ${pct(margin)}, outside what an operating business shows`,
          {
            field: 'EBITDALTM',
            expected: 'between -100% and 100%',
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
    const period = periodOf(ctx.row);
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
    const latest = ctx.current.quarters
      .filter((q) => !q.isEntrySnapshot)
      .reduce<string | null>(
        (max, q) => (max === null || q.periodEnd > max ? q.periodEnd : max),
        null,
      );
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
      const priorValue = D(before);
      if (priorValue.lte(0) || current.lte(0)) return null;
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
    if (current === null || quarter === null || current.lte(0)) return null;
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

/* ---- Duplicates ---- */
const keyOf = (row: AccountingRow): string =>
  `${(row.investmentNumber ?? row.companyName ?? '').trim().toUpperCase()}|${row.periodEnd ?? ''}`;
const DUP_01: AccountingRule = {
  id: 'DUP-01',
  category: 'duplicates',
  severity: 'error',
  title: 'An investment and period appear once in the file',
  check: ({ row, file }) => {
    const key = keyOf(row);
    if (key === '|') return null;
    const first = file.find((r) => keyOf(r) === key);
    return first !== undefined && first.rowNo !== row.rowNo
      ? finding(DUP_01, `Row ${first.rowNo} already carries this investment and period`, {
          expected: 'one row per investment and period',
          actual: `rows ${first.rowNo} and ${row.rowNo}`,
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
      (r) =>
        r.rowNo < row.rowNo &&
        r.investmentNumber?.toUpperCase() === row.investmentNumber?.toUpperCase() &&
        r.companyName !== null &&
        r.companyName.trim() !== row.companyName?.trim(),
    );
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
const XREF_01: AccountingRule = {
  id: 'XREF-01',
  category: 'cross_entity',
  severity: 'error',
  title: 'The row links to an investment on record',
  check: ({ link, row }) =>
    link.status === 'unmatched' && (row.investmentNumber !== null || row.companyName !== null)
      ? finding(
          XREF_01,
          link.candidates.length > 0
            ? `No investment matches; the nearest names are ${link.candidates.map((c) => `${c.companyName} (${c.investmentNumber})`).join(', ')}, which a person must confirm`
            : 'No investment on record matches the number or the name',
          { field: row.investmentNumber !== null ? 'InvestmentNumber' : 'CompanyName' },
        )
      : null,
};
const XREF_02: AccountingRule = {
  id: 'XREF-02',
  category: 'cross_entity',
  severity: 'error',
  title: 'A name on the match guard list is never linked',
  check: ({ link, row }) =>
    link.status === 'guarded'
      ? finding(
          XREF_02,
          `The name ${row.companyName ?? ''} is on the match guard list against ${link.candidates
            .filter((c) => c.reason === 'match guard')
            .map((c) => c.companyName)
            .join(', ')}; it is never linked automatically`,
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
  check: ({ link, row }) =>
    link.status === 'ambiguous'
      ? finding(
          XREF_03,
          `The name ${row.companyName ?? ''} matches more than one investment: ${link.candidates.map((c) => c.investmentNumber).join(', ')}`,
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
    const latest = ctx.current.quarters
      .filter((q) => !q.isEntrySnapshot)
      .reduce<string | null>(
        (max, q) => (max === null || q.periodEnd > max ? q.periodEnd : max),
        null,
      );
    if (latest === null || quarter >= latest) return null;
    const quartersBehind = Math.round(daysBetween(quarter, latest) / 91);
    return quartersBehind >= ctx.config.staleQuarters
      ? finding(
          STALE_01,
          `This quarter is ${quartersBehind} quarters behind the latest approved one (${latest}): a late restatement`,
          {
            field: 'PeriodEnd',
            expected: `within ${ctx.config.staleQuarters} quarters of ${latest}`,
            actual: quarter,
          },
        )
      : null;
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
  RANGE_01,
  RANGE_02,
  RANGE_03,
  RANGE_04,
  RANGE_05,
  PERIOD_01,
  PERIOD_02,
  PERIOD_03,
  PERIOD_04,
  BOUND_01,
  BOUND_02,
  BOUND_03,
  BOUND_04,
  TIE_01,
  TIE_02,
  DUP_01,
  DUP_02,
  XREF_01,
  XREF_02,
  XREF_03,
  XREF_04,
  XREF_05,
  STALE_01,
];
