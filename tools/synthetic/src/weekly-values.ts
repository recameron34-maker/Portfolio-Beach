import { D, ONE, addDays, toDayNumber } from '@pb/calc';
import type { AliasedDataset } from './aliases.js';
import { aliasesOf } from './aliases.js';
import { csvText } from './csv.js';
import { activePositions, latestLockedMark, takeRows, walledInvestment } from './marks.js';
import { intakeDecimal, intakeWholeNumber } from './settings.js';

/**
 * A synthetic weekly values file (docs/04 M2 weekly-report-intake): one row per active equity or
 * CV position with a Locked mark on or before the report date, carrying the value the sponsor's
 * weekly report states. The intake compares each value with that mark (its prior), so:
 *
 * clean: every value equals its mark (variance 0), nothing to flag.
 * update: three positions moved by small fractions of intake.weeklyVarianceThresholdPct, so
 *   their variance is inside the threshold and they pass; the rest unchanged.
 * defects: update plus one row per rule the intake exists for, each on its own row.
 *
 * One row in every scenario carries one of the company's aliases in place of its name and no
 * number: it must still link (docs/03 section 5). The walled position's rows are reported like
 * the accounting export's, and in defects its hidden flagged row is the report date after the
 * as-of date, so the wall tests have one.
 */
export type WeeklyScenario = 'clean' | 'update' | 'defects';

export interface WeeklyValuesOptions {
  /** The report date; the Friday on or before the dataset's as-of date by default. */
  reportDate?: string;
  scenario?: WeeklyScenario;
}

export interface WeeklyValuesExpectations {
  rows: number;
  /** Rows the intake must flag, by the rule a reviewer sees first. */
  flagged: { rowNo: number; ruleId: string }[];
  /** Positions whose value moved inside the threshold, with the move as a signed decimal of the prior. */
  moved: { investmentNumber: string; pct: string }[];
  /** Rows carrying an alias in place of the company name and no number: they link by the alias. */
  aliased: number[];
  /** The row numbers of every row of the walled position (walled_deal). */
  walled: number[];
}

export interface WeeklyValues {
  fileName: string;
  csv: string;
  header: string[];
  reportDate: string;
  /** The cells of every data line in header order, as the CSV carries them before quoting. */
  rows: string[][];
  expectations: WeeklyValuesExpectations;
}

export const WEEKLY_HEADER = ['InvestmentNumber', 'CompanyName', 'ReportDate', 'ReportedValue'];

/** The three moves of the update scenario, as fractions of the threshold: all inside it. */
export const WEEKLY_MOVES = ['0.3', '-0.45', '0.6'] as const;
/** The move of the defects scenario's flagged position, as a multiple of the threshold. */
export const WEEKLY_MOVE_BEYOND = '1.5';

/** The Friday on or before a date, from the civil calendar (1970-01-01 was a Thursday). */
export function fridayOnOrBefore(iso: string): string {
  const weekday = (((toDayNumber(iso) + 4) % 7) + 7) % 7;
  return addDays(iso, -((weekday - 5 + 7) % 7));
}

interface Line {
  investmentNumber: string;
  companyName: string;
  reportDate: string;
  reportedValue: string;
}

const moved = (value: string, pct: string): string => D(value).times(ONE.plus(pct)).toFixed(2);

export function weeklyValues(
  dataset: AliasedDataset,
  options: WeeklyValuesOptions = {},
): WeeklyValues {
  const scenario = options.scenario ?? 'clean';
  const threshold = intakeDecimal('weeklyVarianceThresholdPct');
  const staleDays = intakeWholeNumber('weeklyStaleDays');
  const reportDate = options.reportDate ?? fridayOnOrBefore(dataset.asOf);
  const companyName = new Map(dataset.portfolioCompanies.map((c) => [c.id, c.name]));

  const lines: Line[] = [];
  const companyOf: string[] = [];
  for (const inv of activePositions(dataset, 'equity')) {
    const mark = latestLockedMark(dataset.valuations, inv.id, reportDate);
    if (mark === null) continue;
    lines.push({
      investmentNumber: inv.investmentNumber,
      companyName: companyName.get(inv.portfolioCompanyId) ?? '',
      reportDate,
      reportedValue: mark.fairValue,
    });
    companyOf.push(inv.portfolioCompanyId);
  }
  const positions = lines.length;
  const expectations: WeeklyValuesExpectations = {
    rows: 0,
    flagged: [],
    moved: [],
    aliased: [],
    walled: [],
  };
  // The walled position is found by its number, never by its place in the file.
  const walled = walledInvestment(dataset);
  const walledIndex = lines.findIndex((l) => l.investmentNumber === walled?.investmentNumber);
  if (walledIndex >= 0) expectations.walled.push(walledIndex + 1);
  // The rows no move or defect may change in place: the walled position's and the alias row.
  const taken = new Set<number>([walledIndex]);

  // The alias row: the first position outside the wall whose company has an alias, by that alias
  // and no number.
  const aliasIndex = lines.findIndex(
    (_, i) => i !== walledIndex && aliasesOf(dataset, companyOf[i] ?? '').length > 0,
  );
  if (aliasIndex >= 0) {
    const line = lines[aliasIndex];
    const alias = aliasesOf(dataset, companyOf[aliasIndex] ?? '')[0];
    if (line !== undefined && alias !== undefined) {
      line.investmentNumber = '';
      line.companyName = alias;
      expectations.aliased.push(aliasIndex + 1);
      taken.add(aliasIndex);
    }
  }

  if (scenario !== 'clean') {
    // Three positions moved inside the threshold: a reviewer sees the variance and nothing flags.
    const picks = takeRows(positions, taken, WEEKLY_MOVES.length);
    for (const [k, index] of picks.entries()) {
      const line = lines[index];
      const fraction = WEEKLY_MOVES[k];
      if (line === undefined || fraction === undefined) continue;
      const pct = D(threshold).times(fraction);
      line.reportedValue = moved(line.reportedValue, pct.toFixed());
      expectations.moved.push({ investmentNumber: line.investmentNumber, pct: pct.toFixed() });
    }
  }

  if (scenario === 'defects') {
    const flag = (ruleId: string): void => {
      expectations.flagged.push({ rowNo: lines.length, ruleId });
    };
    // One position moved beyond the threshold, in place: the row the intake must hold back.
    const [beyondIndex] = takeRows(positions, taken, 1);
    const beyond = lines[beyondIndex ?? -1];
    if (beyondIndex !== undefined && beyond !== undefined) {
      beyond.reportedValue = moved(
        beyond.reportedValue,
        D(threshold).times(WEEKLY_MOVE_BEYOND).toFixed(),
      );
      expectations.flagged.push({ rowNo: beyondIndex + 1, ruleId: 'WK-BOUND-01' });
    }
    // The rows below are appended, each built from a position row that carries its number and
    // sits outside the wall, so a wall test reads them and a reviewer can tell them apart.
    const bases = lines
      .slice(0, positions)
      .map((l, i) => i)
      .filter((i) => i !== walledIndex && i !== aliasIndex);
    const baseAt = (n: number): Line | undefined => lines[bases[n % bases.length] ?? -1];
    const sample = baseAt(0);
    if (sample !== undefined) {
      // An investment number the record does not have.
      lines.push({
        ...sample,
        investmentNumber: 'INV-9999',
        companyName: 'Harbor Example Holdings',
      });
      flag('WK-XREF-01');
      // A near miss on the name with no number: candidates for a person, never a link.
      lines.push({ ...sample, investmentNumber: '', companyName: sample.companyName.slice(0, -1) });
      flag('WK-XREF-01');
      // The same investment and report date twice.
      lines.push({ ...(baseAt(1) ?? sample) });
      flag('WK-DUP-01');
      // The four value defects keep their number, so each takes its own day earlier in the week
      // (the report date and the number are the duplicate key) and its own position when there are
      // enough; all four dates stay inside intake.weeklyStaleDays of the as-of date.
      const earlier = (k: number): string => addDays(reportDate, -k);
      // A value the row lacks.
      lines.push({ ...(baseAt(2) ?? sample), reportDate: earlier(1), reportedValue: '' });
      flag('WK-REQ-01');
      // A value that is not a decimal.
      lines.push({ ...(baseAt(3) ?? sample), reportDate: earlier(2), reportedValue: '12.5m' });
      flag('WK-TYPE-02');
      // A value entered in millions.
      const millions = baseAt(4) ?? sample;
      lines.push({
        ...millions,
        reportDate: earlier(3),
        reportedValue: D(millions.reportedValue).times('0.000001').toFixed(2),
      });
      flag('WK-TYPE-04');
      // A negative value.
      const negative = baseAt(5) ?? sample;
      lines.push({
        ...negative,
        reportDate: earlier(4),
        reportedValue: D(negative.reportedValue).negated().toFixed(2),
      });
      flag('WK-RANGE-01');
      // A report date that is not a day as the layout writes one.
      lines.push({
        ...(baseAt(6) ?? sample),
        reportDate: reportDate.split('-').reverse().join('/'),
      });
      flag('WK-TYPE-01');
      // A report date older than intake.weeklyStaleDays before the as-of date (its Friday).
      lines.push({
        ...(baseAt(7) ?? sample),
        reportDate: fridayOnOrBefore(addDays(dataset.asOf, -(staleDays + 1))),
      });
      flag('WK-STALE-01');
    }
    // A report date after the as-of date, built from the walled position so the wall tests have a
    // hidden flagged row; from the first row when the dataset has no wall.
    const base = lines[walledIndex] ?? lines[0];
    if (base !== undefined) {
      lines.push({ ...base, reportDate: fridayOnOrBefore(addDays(dataset.asOf, 7)) });
      flag('WK-PERIOD-01');
      if (walledIndex >= 0) expectations.walled.push(lines.length);
    }
  }

  expectations.rows = lines.length;
  const rows = lines.map((l) => [l.investmentNumber, l.companyName, l.reportDate, l.reportedValue]);
  return {
    fileName: `weekly-values-${reportDate}-${scenario}.csv`,
    csv: csvText(WEEKLY_HEADER, rows),
    header: [...WEEKLY_HEADER],
    reportDate,
    rows,
    expectations,
  };
}

/** The three sample files a drop folder or the preview ships with. */
export function weeklyValuesSet(dataset: AliasedDataset): WeeklyValues[] {
  return (['clean', 'update', 'defects'] as const).map((scenario) =>
    weeklyValues(dataset, { scenario }),
  );
}
