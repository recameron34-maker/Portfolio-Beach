import type { IntakeCounts, WeeklyRow } from '@pb/contracts';
import { DECIMAL_PATTERN } from '@pb/contracts';
import definitions from '../../../../../config/definitions.json';
import { formatDate, formatPct, MISSING, plural } from '../../lib/format.js';
import { commandResult } from '../intake/intake.js';

/*
 * Pure helpers of the weekly values pages (docs/04 M2 weekly-report-intake, decision 0010): the
 * words of the page, how a prior and a variance are shown and what an approve did. The counts,
 * the action gates, the filters and the wall note are the intake page's helpers, shared.
 */

/** The page header's context line: what the intake does and the control it passes through. */
export const WEEKLY_META =
  'Weekly report values to valuation staging: prior, variance, threshold flag, then a Draft valuation (SEC-9.1)';

/** What a role the weekly routes refuse is told (the API answers 403). */
export const WEEKLY_FORBIDDEN = {
  title: 'Weekly values are for operations and reviewers',
  detail:
    'Operations stages the weekly report values; operations, the deal team, approvers and auditors read them. Ask a platform administrator if you need access.',
};

/** The move against the prior that flags a value (config/definitions.json intake.weeklyVarianceThresholdPct). */
export const VARIANCE_THRESHOLD_PCT: number = definitions.intake.weeklyVarianceThresholdPct;

/** "10%" or "2.5%": the threshold as the page names it beside a flagged variance. */
export function thresholdLabel(threshold: number = VARIANCE_THRESHOLD_PCT): string {
  return formatPct(String(threshold), Number.isInteger(threshold * 100) ? 0 : 1);
}

/** A report date as the table shows it: "Jun 27, 2025" when it is a day, else the cell as the file wrote it. */
export function reportDateText(reportDate: string | null): string {
  if (reportDate === null) return MISSING;
  const shown = formatDate(reportDate);
  return shown === MISSING ? reportDate : shown;
}

/** "Locked mark" or "Weekly value": where a prior came from (stg.valuation.prior_source). */
export const PRIOR_SOURCE_WORDS: Readonly<Record<NonNullable<WeeklyRow['priorSource']>, string>> = {
  locked_mark: 'Locked mark',
  weekly: 'Weekly value',
};

/** "Locked mark, Mar 31, 2025" beneath a prior, or "No prior on record" when the row has none. */
export function priorNote(row: Pick<WeeklyRow, 'priorSource' | 'priorDate'>): string {
  if (row.priorSource === null) return 'No prior on record';
  const date = row.priorDate === null ? '' : `, ${formatDate(row.priorDate)}`;
  return `${PRIOR_SOURCE_WORDS[row.priorSource]}${date}`;
}

/**
 * The variance as a signed percentage with one decimal ("+3.0%", "-4.5%"), or the missing
 * placeholder when it is not calculable (no prior, no value, or a prior of zero), never 0.
 */
export function varianceText(variancePct: string | null): string {
  if (variancePct === null || !DECIMAL_PATTERN.test(variancePct)) return MISSING;
  const shown = formatPct(variancePct, 1);
  if (shown === MISSING) return MISSING;
  return shown.startsWith('-') || Number(variancePct) === 0 ? shown : `+${shown}`;
}

/** The badge beside a variance at or beyond the threshold, as the API flagged it. */
export const ABOVE_THRESHOLD_LABEL = 'Above threshold';

/** Whether a row carries the threshold flag (stg.valuation.flag = above_threshold). */
export function isAboveThreshold(row: Pick<WeeklyRow, 'flag'>): boolean {
  return row.flag === 'above_threshold';
}

/**
 * "3 rows promoted (audited); 3 Draft valuations created" after an approve: every promoted row is
 * one Draft valuation; "2 rows rejected (audited)" after a reject.
 */
export function weeklyCommandResult(
  before: IntakeCounts,
  after: IntakeCounts,
  command: 'approve' | 'reject',
  suffix: string,
): string {
  const rows = `${commandResult(before, after, command)} ${suffix}`;
  if (command === 'reject') return rows;
  const created = Math.max(0, after.promoted - before.promoted);
  return `${rows}; ${plural(created, 'Draft valuation')} created`;
}

/** The decision line of a row: its decision text, else the missing placeholder. */
export function decisionText(row: Pick<WeeklyRow, 'decision'>): string {
  return row.decision ?? MISSING;
}
