import type {
  UnderwritingCaseState,
  UnderwritingCaseVersion,
  UnderwritingComparison,
} from '@pb/contracts';
import { isComparableVersion, UNDERWRITING_ROUTES } from '@pb/contracts';
import { underwritingCaseMachine } from '@pb/workflows';
import type { Tone } from '../../components/ui.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  formatMonthYearShort,
  formatPct,
  joinList,
  MISSING,
} from '../../lib/format.js';
import { commandOptions } from '../../lib/states.js';
import { formatSignedMoneyM } from '../analytics/value-creation.js';
import { datePart } from './data.js';

/*
 * The words and the view rules of the card "Against the sponsor's base case" on the Performance
 * tab. Pure: every figure a reader sees is formatted from the API's decimal string, and a figure
 * that is not calculable is the missing placeholder with the reason beside it, never a zero.
 * Number is used for chart geometry only.
 */

export type PlanMetricRow = UnderwritingComparison['metrics'][number];
export type PlanMetric = PlanMetricRow['metric'];
export type PlanStatus = NonNullable<PlanMetricRow['status']>;
export type PlanSeries = UnderwritingComparison['series'][number];
export type PlanProgress = NonNullable<UnderwritingComparison['valueCreation']>;
export type PlanReturns = UnderwritingComparison['returns'];

export const CARD_TITLE = "Against the sponsor's base case";
export const NO_CASE = 'No base case recorded.';
/** Said when versions are on record and none of them stands or waits: all were withdrawn. */
export const NO_STANDING_CASE = 'No base case stands: what was recorded has been withdrawn.';
export const DRAFT_ONLY = 'A draft base case waits for a second person to confirm it.';
/** Under the chart: what a plan figure between two plan dates is. */
export const STRAIGHT_LINE_NOTE =
  'Between plan dates the plan is a straight line, not a sponsor figure.';

/** Where a figure stands against plan, as the badge says it. */
export const PLAN_STATUS_LABEL: Readonly<Record<PlanStatus, string>> = {
  ahead: 'Ahead of plan',
  on_plan: 'On plan',
  behind: 'Behind plan',
};

/** Ahead reads good and behind is a matter to watch; on plan needs nobody's attention. */
const PLAN_STATUS_TONE: Readonly<Record<PlanStatus, Tone>> = {
  ahead: 'good',
  on_plan: 'neutral',
  behind: 'watch',
};
export const planStatusTone = (status: PlanStatus): Tone => PLAN_STATUS_TONE[status];

export const METRIC_LABEL: Readonly<Record<PlanMetric, string>> = {
  ebitda: 'EBITDA',
  revenue: 'Revenue',
  net_debt: 'Net debt',
};

/** Why a metric has no percent against plan; the placeholder always travels with one of these. */
export const METRIC_REASON_TEXT: Readonly<
  Record<NonNullable<PlanMetricRow['notCalculable']>, string>
> = {
  no_current_quarter: 'No approved quarter to compare.',
  before_plan_start: 'Before the plan starts.',
  past_plan_end: 'After the plan ends.',
  missing_plan_figure: 'The plan has no figure here.',
  missing_actual: 'No approved figure this quarter.',
  non_positive_plan: 'The plan figure is zero or less.',
};

/** Why the value creation against plan is not calculable; the first two in the Since entry card's words. */
export const PROGRESS_REASON_TEXT: Readonly<
  Record<NonNullable<PlanProgress['notCalculable']>, string>
> = {
  no_entry_snapshot: 'No entry snapshot recorded.',
  entry_snapshot_forward_dated: 'The entry snapshot is dated after the as-of date.',
  no_current_quarter: METRIC_REASON_TEXT.no_current_quarter,
  missing_figures: 'A figure is missing at entry or in this quarter.',
  non_positive_ebitda: 'EBITDA is zero or less.',
  missing_plan_figure: METRIC_REASON_TEXT.missing_plan_figure,
};

/** Why a held position has no MOIC on the underwritten path. */
export const PATH_REASON_TEXT: Readonly<
  Record<NonNullable<PlanReturns['pathNotCalculable']>, string>
> = {
  past_plan_end: METRIC_REASON_TEXT.past_plan_end,
  no_invested_capital: 'Nothing invested by this date.',
};

/** Said when a figure is missing and the answer names no reason. */
const NOT_CALCULABLE = 'Not calculable this quarter.';
const NO_SINGLE_IRR = 'The cash flows give no single IRR.';

/** Why the gross IRR is not judged against the underwritten one. */
export function irrReasonText(flag: PlanReturns['irrFlag']): string {
  if (flag === 'short_period') return 'Held under a year, so the IRR is not judged.';
  if (flag === 'no_valuation') return 'No locked valuation yet.';
  return NO_SINGLE_IRR;
}

/**
 * A formatted figure with its sign. One that rounds to nothing carries none: "+0.0%" would claim
 * a direction the figure does not show. The placeholder stays the placeholder.
 */
function signed(text: string): string {
  if (text === MISSING) return text;
  if (!/[1-9]/.test(text)) return text.replace(/^-/, '');
  return text.startsWith('-') ? text : `+${text}`;
}

/** A percent with its sign: "+0.8%", "-7.2%"; one that rounds to zero has none; null is the placeholder. */
export function formatSignedPct(value: string | null | undefined, places = 1): string {
  return signed(formatPct(value, places));
}

/** A difference of two rates in points: 0.0598 below is "-6.0 points". */
export function formatPoints(value: string | null | undefined): string {
  const text = formatSignedPct(value);
  return text === MISSING ? text : `${text.slice(0, -1)} points`;
}

/** A difference of two MOICs with its sign: "-0.14x". */
export function formatSignedMoic(value: string | null | undefined): string {
  return signed(formatMoic(value));
}

/** One tile of the card: a figure, what it was worked out from and, where it is judged, its status. */
export interface PlanTile {
  label: string;
  value: string;
  hint: string;
  status: PlanStatus | null;
}

/**
 * A company figure of the current quarter against plan: the percent over or under, with both
 * amounts beneath it. Without a percent the tile says why, and keeps the two amounts when it has
 * them (a plan figure at or below zero has a variance in money and no percent).
 */
export function metricTile(row: PlanMetricRow): PlanTile {
  const label = `${METRIC_LABEL[row.metric]} against plan`;
  const amounts =
    row.actual === null || row.plan === null
      ? null
      : `${formatMoneyM(row.actual)} against a plan of ${formatMoneyM(row.plan)}`;
  if (row.variancePct !== null && amounts !== null)
    return { label, value: formatSignedPct(row.variancePct), hint: amounts, status: row.status };
  const reason =
    row.notCalculable === null ? NOT_CALCULABLE : METRIC_REASON_TEXT[row.notCalculable];
  return {
    label,
    value: MISSING,
    hint: amounts === null ? reason : `${amounts}. ${reason}`,
    status: null,
  };
}

/**
 * Our gross IRR against the underwritten one, in points. An IRR that carries a flag is not
 * judged, and the flag is the reason: a short hold and a flow pattern with several rates read
 * "NM", as the IRR itself does everywhere else.
 */
export function irrTile(returns: PlanReturns, underwrittenIrr: string): PlanTile {
  const label = 'Gross IRR against plan';
  if (returns.irrFlag !== null || returns.irrGap === null || returns.grossIrr === null) {
    const notMeaningful = returns.irrFlag === 'short_period' || returns.irrFlag === 'multiple_irr';
    return {
      label,
      value: notMeaningful ? 'NM' : MISSING,
      hint: irrReasonText(returns.irrFlag),
      status: null,
    };
  }
  return {
    label,
    value: formatPoints(returns.irrGap),
    hint: `${formatPct(returns.grossIrr)} against ${formatPct(underwrittenIrr)} underwritten`,
    status: returns.irrStatus,
  };
}

/**
 * Our gross MOIC with what it is set against: for a held position the MOIC it would show today
 * on the underwritten path, and the underwritten MOIC at exit beside it; for a realized one the
 * underwritten MOIC at exit alone. It carries no status.
 */
export function moicTile(returns: PlanReturns, underwrittenMoic: string): PlanTile {
  const label = 'Gross MOIC';
  const atExit = `${formatMoic(underwrittenMoic)} at exit`;
  const value = formatMoic(returns.grossMoic);
  if (returns.pathNotCalculable !== null)
    return {
      label,
      value,
      hint: `No figure on the underwritten path: ${PATH_REASON_TEXT[returns.pathNotCalculable]} Underwritten ${atExit}.`,
      status: null,
    };
  if (returns.moicOnPath === null)
    // A realized position has no path: its MOIC is final and is set against the exit target.
    return {
      label,
      value,
      hint:
        returns.moicGap === null
          ? `Underwritten ${atExit}`
          : `${formatSignedMoic(returns.moicGap)} against ${formatMoic(underwrittenMoic)} underwritten at exit`,
      status: null,
    };
  return {
    label,
    value,
    hint:
      returns.moicGap === null
        ? `${formatMoic(returns.moicOnPath)} on the underwritten path; ${atExit}`
        : `${formatSignedMoic(returns.moicGap)} against ${formatMoic(returns.moicOnPath)} on the underwritten path; ${atExit}`,
    status: null,
  };
}

/** Numbers feed chart geometry only. */
const toNumber = (value: string | null): number | null => (value === null ? null : Number(value));

/** One metric's series as the line chart takes it: a label per date, the actual and the plan. */
export interface PlanChart {
  x: string[];
  /** Days from the first date to each date: where the chart places the point. */
  at: number[];
  actual: (number | null)[];
  plan: (number | null)[];
}

const DAY_MS = 86_400_000;
/** An ISO date as a day count, for the distance between two dates on the chart only. */
const dayOf = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);

/**
 * A series as the chart draws it. Plan dates are often a year apart and quarters three months,
 * so each point is placed by its date: the plan, a straight line by days between two plan dates,
 * is then drawn as one. The labels are month and year, or the full date when two dates share a
 * month (a plan dated mid-month beside a quarter end), so no two labels are the same.
 */
export function planChart(series: PlanSeries): PlanChart {
  const short = series.points.map((p) => formatMonthYearShort(p.periodEnd));
  const x =
    new Set(short).size === short.length
      ? short
      : series.points.map((p) => formatDate(p.periodEnd));
  const first = series.points[0];
  return {
    x,
    at: series.points.map((p) => dayOf(p.periodEnd) - dayOf(first?.periodEnd ?? p.periodEnd)),
    actual: series.points.map((p) => toNumber(p.actual)),
    plan: series.points.map((p) => toNumber(p.plan)),
  };
}

/** The drivers of the bridge and their total: the key, the row label and the words inside a sentence. */
const DRIVERS = [
  ['ebitdaGrowth', 'EBITDA growth', 'EBITDA growth'],
  ['multipleExpansion', 'Multiple expansion', 'multiple expansion'],
  ['debtPaydown', 'Debt paydown', 'debt paydown'],
  ['total', 'Total', 'the total'],
] as const;

export interface DriverRow {
  key: (typeof DRIVERS)[number][0];
  label: string;
  planned: string;
  earned: string;
  progress: string;
}

/** The planned bridge, the one earned so far and the share earned, driver by driver and in total. */
export function driverRows(progress: PlanProgress): DriverRow[] {
  return DRIVERS.map(([key, label]) => ({
    key,
    label,
    planned: formatSignedMoneyM(progress.planned?.[key] ?? null),
    earned: formatSignedMoneyM(progress.actual?.[key] ?? null),
    progress: formatPct(progress.progress?.[key] ?? null),
  }));
}

/**
 * What stands under the drivers table, as sentences: how much of the planned time has passed,
 * why there is no progress at all, and which drivers have none because their planned figure is
 * zero or less. Empty when there is nothing to say.
 */
export function progressNotes(progress: PlanProgress): string[] {
  const notes: string[] = [];
  if (progress.timePassed !== null)
    notes.push(`${formatPct(progress.timePassed, 0)} of the planned time has passed.`);
  if (progress.notCalculable !== null)
    notes.push(`Progress is not calculable: ${PROGRESS_REASON_TEXT[progress.notCalculable]}`);
  const shares = progress.progress;
  if (shares !== null) {
    const without = DRIVERS.filter(([key]) => shares[key] === null).map(([, , words]) => words);
    if (without.length > 0)
      notes.push(`No progress for ${joinList(without)}: ${METRIC_REASON_TEXT.non_positive_plan}`);
  }
  return notes;
}

type VersionRef = Pick<UnderwritingCaseVersion, 'version' | 'kind' | 'caseDate' | 'state'>;

/**
 * What each version is, in the reader's words: the entry case, a correction of it, or a
 * re-underwriting with its date. A correction of a re-underwriting keeps that date. Two versions
 * that would read the same are told apart by their numbers.
 */
export function versionLabels(versions: readonly VersionRef[]): Map<number, string> {
  const earliest = versions
    .filter(isComparableVersion)
    .reduce<string | null>(
      (first, v) => (first === null || v.caseDate < first ? v.caseDate : first),
      null,
    );
  const plain = versions.map((v) => {
    if (v.kind === 'entry') return 'Entry case';
    const dated = `Re-underwritten ${formatDate(v.caseDate)}`;
    if (v.kind === 'reunderwrite') return dated;
    return earliest === null || v.caseDate === earliest ? 'Corrected' : `${dated}, corrected`;
  });
  const withState = versions.map((v, i) =>
    v.state === 'Superseded' ? `${plain[i] ?? ''} (superseded)` : (plain[i] ?? ''),
  );
  const labels = new Map<number, string>();
  versions.forEach((v, i) => {
    const text = withState[i] ?? '';
    const shared = withState.filter((other) => other === text).length > 1;
    labels.set(v.version, shared ? `${text}, version ${v.version}` : text);
  });
  return labels;
}

/** The heading of a Draft, by what confirming it would make it. */
export function draftLabel(draft: Pick<UnderwritingCaseVersion, 'kind' | 'caseDate'>): string {
  if (draft.kind === 'entry') return 'Draft base case';
  return draft.kind === 'correction'
    ? `Draft correction of the case dated ${formatDate(draft.caseDate)}`
    : `Draft re-underwriting dated ${formatDate(draft.caseDate)}`;
}

/** The versions a reader may compare the position with: those that stand or stood as the plan, oldest first. */
export function comparableVersions<T extends VersionRef>(versions: readonly T[]): T[] {
  return versions.filter(isComparableVersion).sort((a, b) => a.version - b.version);
}

/** A Draft waits on a second person, a Confirmed case is the plan, the other two are history. */
const CASE_STATE_TONE: Readonly<Record<UnderwritingCaseState, Tone>> = {
  Draft: 'watch',
  Confirmed: 'good',
  Superseded: 'neutral',
  Withdrawn: 'neutral',
};
export const caseStateTone = (state: UnderwritingCaseState): Tone => CASE_STATE_TONE[state];

/** "Blake Mbeki, Feb 22, 2021": who did a thing to a case and on which day. */
export function byLine(person: { name: string } | null, at: string | null): string {
  if (person === null) return MISSING;
  return at === null ? person.name : `${person.name}, ${formatDate(datePart(at))}`;
}

/** Where in a source document the figures are: "page 12", "Model!B14", or both. */
export function sourcePlace(source: UnderwritingCaseVersion['source']): string | null {
  const parts = [source.page === null ? null : `page ${source.page}`, source.locator].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(', ');
}

/* ---- Who may do what to a case (the transition table and the routes decide; the API judges again) ---- */

/** Said in place of the Confirm button to the person who last changed the figures of a Draft. */
export const OWN_FIGURES = 'You entered these figures. A second person confirms them.';
/** Said when a write is refused because somebody changed the case since the reader opened it. */
export const STALE_CASE = 'This base case changed since you opened it. Open it again.';

/** The roles that record and edit a Draft: the ones the route that records one names. */
const RECORD_ROLES: readonly string[] =
  UNDERWRITING_ROUTES.find((r) => r.method === 'POST' && r.path.endsWith('/underwriting'))?.roles ??
  [];

/** What the reader may do on the card. Everything false is a reader who only reads. */
export interface CaseActions {
  /** Record the first case, or a new one when none stands. */
  record: boolean;
  /** Record a revision of the Confirmed case shown. */
  revise: boolean;
  editDraft: boolean;
  withdrawDraft: boolean;
  /** `offer` the button; `own_figures` the sentence in its place; null for a reader who cannot confirm. */
  confirm: 'offer' | 'own_figures' | null;
  /** Retire the Confirmed case shown. */
  retire: boolean;
}

type ActedOn = Pick<UnderwritingCaseVersion, 'state' | 'enteredBy'>;

/**
 * The actions of the card for a reader, from the transition table of a base case and the roles
 * its routes name. One Draft per position: while one waits, no other is recorded. A first case
 * is recorded while none stands; once one does, the Confirmed case shown is revised. The person who
 * last changed the figures of a Draft is told a second person confirms them, since the API would
 * refuse their confirmation. Everything else that can refuse (a source, the plan, a stale
 * version) is the API's to judge, and the card shows the refusal it gets.
 */
export function caseActions(input: {
  roles: readonly string[];
  userId: string | null;
  /** The Draft of the position, if one waits. */
  draft: ActedOn | undefined;
  /** The version the card shows in full: the one compared. */
  shown: ActedOn | undefined;
  /** Whether a Confirmed case stands for the position, shown or not. */
  standing: boolean;
}): CaseActions {
  const { roles, userId, draft, shown } = input;
  const may = (state: UnderwritingCaseState, command: string): boolean =>
    commandOptions(underwritingCaseMachine, state, roles).some(
      (option) => option.command === command && option.allowed,
    );
  const records = RECORD_ROLES.some((role) => roles.includes(role));
  const confirmed = shown?.state === 'Confirmed';
  return {
    record: records && draft === undefined && !input.standing,
    revise: records && draft === undefined && confirmed,
    editDraft: records && draft !== undefined,
    withdrawDraft: draft !== undefined && may('Draft', 'withdraw'),
    confirm:
      draft === undefined || !may('Draft', 'confirm')
        ? null
        : draft.enteredBy.id === userId
          ? 'own_figures'
          : 'offer',
    retire: confirmed && may('Confirmed', 'retire'),
  };
}
