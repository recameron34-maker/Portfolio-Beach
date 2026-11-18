import { isCalendarDate, latestQuarterEndOnOrBefore, previousQuarterEnd } from '@pb/calc';
import {
  REPORT_PACKAGE_STATES,
  reportPackageBasis,
  reportPackageCommandBody,
  reportPackageCreateBody,
  reportPackageLabel,
} from '@pb/contracts';
import type {
  QaFindingRow,
  ReportPackageCommandBody,
  ReportPackageCreateBody,
  ReportPackageDetail,
  ReportPackageLine,
  ReportPackageRow,
  ReportPackageRun,
  ReportPackageState,
} from '@pb/contracts';
import { STALE_FOOTNOTE } from '@pb/report-engine';
import type { QaRule } from '@pb/report-engine';
import { reportingPackageMachine } from '@pb/workflows';
import type { ReportingPackageCommand } from '@pb/workflows';
import definitions from '../../../../../../config/definitions.json';
import type { Step, StepStatus } from '../../../components/StepStrip.js';
import {
  formatDate,
  formatDateTime,
  formatMoneyM,
  formatQuarter,
  formatUsdExact,
  labelOf,
  MISSING,
  plural,
} from '../../../lib/format.js';
import { WHO_READS_EVERY_CLIENT } from '../../../lib/roles.js';
import { commandOptions, humanizeState } from '../../../lib/states.js';
import type { CommandOption } from '../../../lib/states.js';

/*
 * Pure helpers of the Reporting, Packages pages (docs/04 M14, docs/18 section 5, docs/08 section
 * 7, decision 0024): the words for a check, for what it is about and for a footnote, the release
 * gate as steps, the commands a person may be offered and the quarters a package may be started
 * for. No component and no request here. The page does no arithmetic: every figure it shows is
 * one the package stores, and these helpers only say it in words. No identifier reaches the
 * page: a rule is called by its name, a client line by its position, never by a code or an id.
 */

/** The seven states in the order of docs/18 section 5. */
export const PACKAGE_STATES: readonly ReportPackageState[] = REPORT_PACKAGE_STATES;

export function isPackageState(value: string): value is ReportPackageState {
  return (PACKAGE_STATES as readonly string[]).includes(value);
}

/* ---- The quarters a package may be started for ---- */

/** How many of the latest quarter ends the start form offers (config/definitions.json reporting). */
export const PACKAGE_QUARTER_CHOICES: number = definitions.reporting.packageQuarterChoices;

/**
 * The latest quarter ends on or before a date, newest first: the quarters a package may be
 * started for when the record is read as of that date. A quarter that has not ended is never
 * offered, and a date that cannot be read offers none. The dates are @pb/calc's, never the
 * browser's clock.
 */
export function quarterChoices(asOf: string, count: number = PACKAGE_QUARTER_CHOICES): string[] {
  if (!isCalendarDate(asOf)) return [];
  const out: string[] = [];
  let quarter = latestQuarterEndOnOrBefore(asOf);
  for (let i = 0; i < count; i += 1) {
    out.push(quarter);
    quarter = previousQuarterEnd(quarter);
  }
  return out;
}

/* ---- Position names ---- */

/** The company of each position the reader can list, by position number. */
export type PositionNames = ReadonlyMap<string, string>;

const NO_NAMES: PositionNames = new Map();

/** The names from the reader's own positions list; a position the reader cannot list has none. */
export function positionNames(
  items: readonly { investmentNumber: string; companyName: string }[],
): PositionNames {
  return new Map(items.map((p) => [p.investmentNumber, p.companyName]));
}

/** A position by its number, with the company when the reader can list it: "INV-0007 Tidewater Analytics". */
export function positionWords(ref: string, names: PositionNames = NO_NAMES): string {
  const name = names.get(ref);
  return name === undefined ? ref : `${ref} ${name}`;
}

/* ---- Checks ---- */

/** How a check's expected and found values are said: dollars to the cent, a date, a label or positions. */
export type ValueKind = 'money' | 'date' | 'label' | 'positions' | 'text';

export interface RuleWords {
  name: string;
  kind: ValueKind;
}

/** Every QA rule of the report engine by the name a reader knows it by (docs/08 section 7). */
export const RULE_WORDS: Readonly<Record<QaRule, RuleWords>> = {
  'QA-RDY-01': { name: 'End NAV on record', kind: 'money' },
  'QA-STALE-01': { name: 'Stale mark footnoted', kind: 'date' },
  'QA-ASOF-01': { name: 'Nothing dated after the as-of date', kind: 'date' },
  'QA-QTD-01': { name: 'Quarter starts from the prior locked mark', kind: 'money' },
  'QA-RF-01': { name: 'NAV roll-forward', kind: 'money' },
  'QA-SIGN-01': { name: 'Gain or loss sign', kind: 'money' },
  'QA-TIE-01': { name: 'Ties to the last released package', kind: 'money' },
  'QA-MOV-01': { name: 'Movers list', kind: 'positions' },
  'QA-LBL-01': { name: 'Preliminary or final, gross or net', kind: 'label' },
  'QA-CLI-01': { name: 'Client share of NAV', kind: 'money' },
};

/** A rule the engine added after this page was written: named as a check, its values shown as sent. */
const UNKNOWN_RULE: RuleWords = { name: 'Another check', kind: 'text' };

/** The words of a finding's rule; a rule this page does not know is still never called by its code. */
export function ruleWords(rule: string): RuleWords {
  return (RULE_WORDS as Readonly<Record<string, RuleWords>>)[rule] ?? UNKNOWN_RULE;
}

/** The rule whose findings are about a client's share of a position ("client:position"). */
const CLIENT_LINE_RULE: QaRule = 'QA-CLI-01';

/** What a finding that is not about one position is about. */
const ENTITY_WORDS: Readonly<Record<string, string>> = {
  package: 'Whole package',
  status: 'Preliminary or final label',
  basis: 'Gross or net label',
};

/**
 * What a finding is about, in words: the whole package, one of its two labels, or a position. A
 * client line names its client by an id the reader has no use for; the page is one client's
 * package, so the line reads as its position alone.
 */
export function entityWords(rule: string, entityRef: string, names: PositionNames): string {
  const known = ENTITY_WORDS[entityRef];
  if (known !== undefined) return known;
  const colon = rule === CLIENT_LINE_RULE ? entityRef.indexOf(':') : -1;
  return positionWords(colon < 0 ? entityRef : entityRef.slice(colon + 1), names);
}

/** "preliminary" as "Preliminary"; the missing placeholder for no label at all. */
function labelWord(value: string): string {
  return value === '' ? MISSING : value.charAt(0).toUpperCase() + value.slice(1);
}

/** The movers of a check, as the engine joins them (", " in a list, "|" in a commentary key). */
function positionsOf(value: string): string[] {
  return value
    .split(/[,|]/)
    .map((ref) => ref.trim())
    .filter((ref) => ref !== '');
}

/**
 * What a check expected or found, in the words of its kind: dollars to the cent (a tie-out is
 * read to the cent), a date, a label, or positions in the order the check gives them. Nothing is
 * the missing placeholder, never zero; a figure that cannot be read is the placeholder too.
 */
export function findingValue(
  rule: string,
  value: string | null,
  names: PositionNames = NO_NAMES,
): string {
  if (value === null) return MISSING;
  switch (ruleWords(rule).kind) {
    case 'money':
      return formatUsdExact(value);
    case 'date':
      return formatDate(value);
    case 'label':
      return labelWord(value);
    case 'positions': {
      const refs = positionsOf(value);
      return refs.length === 0 ? 'None' : refs.map((ref) => positionWords(ref, names)).join(', ');
    }
    case 'text':
      return value;
  }
}

/** The latest run of a package in a few words: not run, all passed, how many failed, or overridden. */
export function checksSummary(qa: ReportPackageRow['qa']): string {
  if (qa.runNo === null) return 'Not run';
  if (qa.failed === 0) return `All ${qa.findings} passed`;
  // An override stands for the run only when it covers every failure of it.
  if (qa.overridden >= qa.failed) return `${qa.failed} failed, overridden`;
  return `${qa.failed} of ${qa.findings} failed`;
}

/** How a check came out: it failed, it failed and an approver overrode it, or it passed. */
export type FindingResult = 'failed' | 'overridden' | 'passed';

export const RESULT_WORDS: Readonly<Record<FindingResult, string>> = {
  failed: 'Failed',
  overridden: 'Overridden',
  passed: 'Passed',
};

export function findingResult(finding: Pick<QaFindingRow, 'passed' | 'override'>): FindingResult {
  if (finding.passed) return 'passed';
  return finding.override === null ? 'failed' : 'overridden';
}

/**
 * The checks of a run that did not pass (an overridden check still did not) and those that did,
 * each in the order the run answered them. The page shows the first and keeps the second behind
 * a toggle.
 */
export function splitFindings(findings: readonly QaFindingRow[]): {
  notPassed: QaFindingRow[];
  passed: QaFindingRow[];
} {
  return {
    notPassed: findings.filter((f) => !f.passed),
    passed: findings.filter((f) => f.passed),
  };
}

/** One override of a run: why, by whom, when, and how many failed checks it covers. */
export interface OverrideWords {
  reason: string;
  /** The approver's name. */
  approver: string;
  at: string;
  checks: number;
}

/**
 * The overrides of a run, each once. An approver overrides every failed check of a run with one
 * reason, so there is one as a rule; two are kept apart if the person, the time or the reason
 * ever differs.
 */
export function overridesOf(findings: readonly QaFindingRow[]): OverrideWords[] {
  const byKey = new Map<string, OverrideWords>();
  for (const { override } of findings) {
    if (override === null) continue;
    const key = JSON.stringify([override.approver.id, override.at, override.reason]);
    const seen = byKey.get(key);
    if (seen === undefined)
      byKey.set(key, {
        reason: override.reason,
        approver: override.approver.name,
        at: override.at,
        checks: 1,
      });
    else seen.checks += 1;
  }
  return [...byKey.values()];
}

/* ---- Positions ---- */

/** A figure of a position's line as its cell shows it; `why` says why it is the placeholder. */
export interface FigureCell {
  text: string;
  why?: string;
}

/** The begin NAV of a position entered in the quarter: it starts from nothing, which is not zero NAV on record. */
export const NEW_THIS_QUARTER = 'New this quarter';
export const NO_START_MARK = 'Not calculable: no locked mark at the start of the quarter';
export const NO_END_MARK = 'Not calculable: no locked mark on or before the end of the quarter';
const NO_MARK_QUARTER = 'The quarter of the mark is not recorded';

const money = (value: string): FigureCell => ({ text: formatMoneyM(value) });
const missing = (why: string): FigureCell => ({ text: MISSING, why });

/**
 * The begin NAV of a line as the package stores it. A position entered in the quarter reads as
 * new; a held one with no Locked mark at the start of the quarter has no begin NAV, and the cell
 * says so instead of showing zero or another quarter's figure.
 */
export function beginNavCell(line: ReportPackageLine): FigureCell {
  const stored = line.beginNav;
  if (line.enteredInPeriod && (stored === null || !/[1-9]/.test(stored)))
    return { text: NEW_THIS_QUARTER };
  return stored === null ? missing(NO_START_MARK) : money(stored);
}

/** The end NAV of a line; with no mark to report on or before the quarter end there is none. */
export function endNavCell(line: ReportPackageLine): FigureCell {
  return line.endNav === null ? missing(NO_END_MARK) : money(line.endNav);
}

/** The gain or loss of a line, or which of its two ends is missing when there is none. */
export function gainLossCell(line: ReportPackageLine): FigureCell {
  if (line.gainLoss !== null) return money(line.gainLoss);
  return missing(line.endNav === null ? NO_END_MARK : NO_START_MARK);
}

/**
 * Which mark the end NAV of a line stands on: the quarter end's, or an earlier one rolled
 * forward for the cash flows since (the line then carries the footnote).
 */
export function markCell(line: ReportPackageLine, periodEnd: string): FigureCell {
  if (line.endNav === null) return missing(NO_END_MARK);
  if (line.endNavPeriodEnd === null) return missing(NO_MARK_QUARTER);
  return {
    text:
      line.endNavPeriodEnd < periodEnd
        ? `Rolled forward from ${formatDate(line.endNavPeriodEnd)}`
        : 'Quarter end',
  };
}

/**
 * Whose reading of the record a package's figures are: the person who ran its latest generation
 * (the snapshot is built from the positions that person could read), or the preparer while
 * nothing has been generated.
 */
export function generatedBy(detail: Pick<ReportPackageDetail, 'preparedBy' | 'changeLog'>): string {
  const latest = detail.changeLog.reduce<ReportPackageRun | null>(
    (best, run) => (best === null || run.runNo > best.runNo ? run : best),
    null,
  );
  return (latest?.by ?? detail.preparedBy).name;
}

/** Order by text, code unit by code unit: the order the positions of a package are stored in. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The client lines in the order of the positions table (by position number), so the two read
 * side by side; the package stores them vehicle by vehicle. Lines of one position keep the
 * order they were stored in.
 */
export function clientShareRows(
  clientLines: NonNullable<ReportPackageDetail['content']>['clientLines'],
): NonNullable<ReportPackageDetail['content']>['clientLines'] {
  return clientLines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => byText(a.line.ref, b.line.ref) || a.index - b.index)
    .map(({ line }) => line);
}

/* ---- Tie-out explanations and the change log ---- */

/** The recorded explanations, one per position, by position number. */
export function explanationRows(
  explanations: Readonly<Record<string, string>>,
): { ref: string; text: string }[] {
  return Object.entries(explanations)
    .map(([ref, text]) => ({ ref, text }))
    .sort((a, b) => byText(a.ref, b.ref));
}

export interface ChangeLogRow {
  runNo: number;
  at: string;
  /** The name of the person who ran the generation. */
  by: string;
  positions: number;
  checks: number;
  failed: number;
}

/** The generation runs of a package, newest first, with the time in words and the person by name. */
export function changeLogRows(runs: readonly ReportPackageRun[]): ChangeLogRow[] {
  return [...runs]
    .sort((a, b) => b.runNo - a.runNo)
    .map((run) => ({
      runNo: run.runNo,
      at: formatDateTime(run.at),
      by: run.by.name,
      positions: run.lines,
      checks: run.findings,
      failed: run.failed,
    }));
}

/* ---- Footnotes ---- */

/** Each footnote the report engine writes, as the sentence the page shows for a position's line. */
export const FOOTNOTE_WORDS: Readonly<
  Record<string, (line: Pick<ReportPackageLine, 'endNavPeriodEnd'> | undefined) => string>
> = {
  [STALE_FOOTNOTE]: (line) => {
    const markedFor = line?.endNavPeriodEnd ?? null;
    return markedFor === null
      ? 'Carried at an earlier mark, rolled forward for cash flows since.'
      : `Carried at the mark of ${formatDate(markedFor)}, rolled forward for cash flows since.`;
  },
};

/**
 * A footnote of a position, from its code and the position's line. A code this page does not
 * know is said in the words of the code itself, never shown as the code.
 */
export function footnoteWords(
  code: string,
  line: Pick<ReportPackageLine, 'endNavPeriodEnd'> | undefined,
): string {
  const words = FOOTNOTE_WORDS[code];
  return words === undefined ? labelOf(code) : words(line);
}

/* ---- The release gate ---- */

/** The six steps of the gate; a failed and a passed QA are one step with two outcomes. */
const GATE_STEPS = ['Draft', 'Generated', 'QA', 'InReview', 'Approved', 'Released'] as const;
type GateStep = (typeof GATE_STEPS)[number];

const STEP_OF: Readonly<Record<ReportPackageState, GateStep>> = {
  Draft: 'Draft',
  Generated: 'Generated',
  QAFailed: 'QA',
  QAPassed: 'QA',
  InReview: 'InReview',
  Approved: 'Approved',
  Released: 'Released',
};

/** The QA step by its outcome: nothing yet, failed, passed, or passed because an approver overrode the failures. */
function qaStepWords(pkg: Pick<ReportPackageRow, 'state' | 'qa'>): string {
  if (pkg.state === 'Draft' || pkg.state === 'Generated') return 'QA';
  if (pkg.state === 'QAFailed') return 'QA failed';
  return pkg.qa.overridden > 0 ? 'QA passed by override' : 'QA passed';
}

/**
 * The release gate as the six steps of the strip. Every step before the one the package stands
 * on is done and the rest are still to come; Released is the last step and stays the current one.
 */
export function gateSteps(pkg: Pick<ReportPackageRow, 'state' | 'qa'>): Step[] {
  const at = GATE_STEPS.indexOf(STEP_OF[pkg.state]);
  return GATE_STEPS.map((step, i) => {
    const status: StepStatus = i < at ? 'done' : i === at ? 'current' : 'upcoming';
    return { key: step, label: step === 'QA' ? qaStepWords(pkg) : humanizeState(step), status };
  });
}

/**
 * What happens next from each state, and who does it (docs/18 section 5). The gate only moves
 * forward once the checks have passed, and the page says so where that begins to matter.
 */
export const NEXT_STEP_WORDS: Readonly<Record<ReportPackageState, string>> = {
  Draft:
    'Investor relations generates the package: the figures are read from the record and every check is run.',
  Generated: 'The checks have not answered yet. Reload the page to see their result.',
  QAFailed:
    'Investor relations regenerates the package once the record is fixed, or an approver overrides the failed checks with a reason.',
  QAPassed:
    'Investor relations submits the package for review. There is no way back from here: a correction is a new version, started once this one is released.',
  InReview:
    'An approver who did not prepare the package approves it. There is no way back from here: a correction is a new version, started once this one is released.',
  Approved: 'Investor relations or operations releases the package to the client.',
  Released:
    'Released packages are read only. Investor relations starts a new version, with a reason, to correct one.',
};

/** The role the system's own steps run as; never a person at the page. */
const SERVICE_ROLE = 'service';

/**
 * The commands a person may be offered from a state: the transition table's, without the steps
 * only the system takes (the outcome of the checks) and without the service account among the
 * roles a button names. Preconditions (a reason, the preparer approving) stay the API's to judge.
 */
export function personCommands(
  state: ReportPackageState,
  roles: readonly string[],
): CommandOption<ReportPackageState, ReportingPackageCommand>[] {
  return commandOptions(reportingPackageMachine, state, roles)
    .map((option) => {
      const people = option.roles.filter((role) => role !== SERVICE_ROLE);
      return { ...option, roles: people, allowed: people.some((role) => roles.includes(role)) };
    })
    .filter((option) => option.roles.length > 0);
}

/* ---- Commands ---- */

/** The rule whose failure an explanation settles: a begin NAV against the last released package. */
const TIE_OUT_RULE: QaRule = 'QA-TIE-01';

/**
 * The tie-outs a regeneration asks about: the positions whose begin NAV did not tie to the last
 * released package in the latest run and that carry no explanation yet, in the order of the run.
 * Each is its finding, so the dialog can show what was compared. A position that is explained is
 * not asked about again: an explanation stays on the package.
 */
export function unexplainedTieOuts(
  detail: Pick<ReportPackageDetail, 'findings' | 'tieOutExplanations'>,
): QaFindingRow[] {
  return detail.findings.filter(
    (finding) =>
      finding.rule === TIE_OUT_RULE &&
      !finding.passed &&
      ENTITY_WORDS[finding.entityRef] === undefined &&
      (detail.tieOutExplanations[finding.entityRef] ?? '').trim() === '',
  );
}

/**
 * The two figures a failed tie-out compared, to the cent, in a sentence: the end NAV of the last
 * released package and the begin NAV of this one. A side that is not there is said in words,
 * never as a figure.
 */
export function tieOutWords(finding: Pick<QaFindingRow, 'expected' | 'actual'>): string {
  const last =
    finding.expected === null
      ? 'Not in the last released package'
      : `Last released ${formatUsdExact(finding.expected)}`;
  const begin =
    finding.actual === null
      ? 'no begin NAV in this package'
      : `begin NAV ${formatUsdExact(finding.actual)}`;
  return `${last}, ${begin}.`;
}

export const EXPLANATION_PROBLEM = 'Give 3 to 500 characters, or leave the box empty.';

/** The body of a regeneration with the boxes that were filled in, trimmed; an empty box is left out. */
function regenerateDraft(explanations: Readonly<Record<string, string>>): unknown {
  const given = Object.entries(explanations)
    .map(([ref, text]): [string, string] => [ref, text.trim()])
    .filter(([, text]) => text !== '');
  return given.length === 0
    ? { command: 'regenerate' }
    : { command: 'regenerate', explanations: Object.fromEntries(given) };
}

/** What is wrong with one explanation, judged by the contract's own body; null for an empty box, which is allowed. */
export function explanationProblem(text: string): string | null {
  const draft = regenerateDraft({ position: text });
  return reportPackageCommandBody.safeParse(draft).success ? null : EXPLANATION_PROBLEM;
}

/** The regenerate command with its explanations by position number, or null while one of them cannot be sent. */
export function regenerateBody(
  explanations: Readonly<Record<string, string>>,
): ReportPackageCommandBody | null {
  const parsed = reportPackageCommandBody.safeParse(regenerateDraft(explanations));
  return parsed.success ? parsed.data : null;
}

/** How many failed checks of a run no approver has overridden: what an override would cover. */
export function openFailures(findings: readonly QaFindingRow[]): number {
  return findings.filter((finding) => findingResult(finding) === 'failed').length;
}

/** What the override dialog says of its reason before it is given. */
export function overrideSubject(failed: number): string {
  const checks = failed === 1 ? 'the 1 failed check' : `all ${failed} failed checks`;
  return `The reason is recorded against ${checks} of this run, with your name.`;
}

/**
 * The result of a command in one line, from the package it answered: where the package stands
 * now, and for a generation what its checks found, for an override how many failures it covers.
 */
export function commandResultWords(
  command: ReportPackageCommandBody['command'],
  detail: Pick<ReportPackageDetail, 'client' | 'periodEnd' | 'basis' | 'version' | 'state' | 'qa'>,
): string {
  const now = `${packageWords(detail)} is now ${humanizeState(detail.state)}`;
  const { qa } = detail;
  if (command === 'generate' || command === 'regenerate') {
    const found =
      qa.failed === 0
        ? `all ${plural(qa.findings, 'check')} passed`
        : `${qa.failed} of ${plural(qa.findings, 'check')} failed`;
    return qa.runNo === null ? now : `${now}: ${found} in run ${qa.runNo}`;
  }
  if (command === 'overrideQa')
    return `${now}: ${plural(qa.overridden, 'failed check')} overridden`;
  return now;
}

/* ---- The list ---- */

export interface PackageFilters {
  /** The client whose packages are listed; empty for every client the reader sees. */
  clientId: string;
  state: ReportPackageState | '';
}

/** Client-side filters over the one read, in the list's own order (newest period first). */
export function filterPackages(
  items: readonly ReportPackageRow[],
  filters: PackageFilters,
): ReportPackageRow[] {
  return items.filter(
    (row) =>
      (filters.clientId === '' || row.client.id === filters.clientId) &&
      (filters.state === '' || row.state === filters.state),
  );
}

/** The clients that have a package on the list, each once, by name. */
export function clientChoices(items: readonly ReportPackageRow[]): ReportPackageRow['client'][] {
  const byId = new Map<string, ReportPackageRow['client']>();
  for (const row of items) byId.set(row.client.id, row.client);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ---- Basis and label ---- */

export type PackageBasis = ReportPackageRow['basis'];
export type PackageLabel = ReportPackageRow['label'];

export const PACKAGE_BASES: readonly PackageBasis[] = reportPackageBasis.options;
export const PACKAGE_LABELS: readonly PackageLabel[] = reportPackageLabel.options;

export const BASIS_WORDS: Readonly<Record<PackageBasis, string>> = { gross: 'Gross', net: 'Net' };
export const LABEL_WORDS: Readonly<Record<PackageLabel, string>> = {
  preliminary: 'Preliminary',
  final: 'Final',
};

export function isPackageBasis(value: string): value is PackageBasis {
  return (PACKAGE_BASES as readonly string[]).includes(value);
}

export function isPackageLabel(value: string): value is PackageLabel {
  return (PACKAGE_LABELS as readonly string[]).includes(value);
}

/** What a net package says of its figures until net figures are worked out. */
export const NET_NOTICE =
  'Net figures are not worked out yet. These figures are gross of fees and carry.';

/** What the start form says of a basis the client's record does not list; it is still allowed. */
export const BASIS_NOT_ON_RECORD = "Not on this client's record";

/**
 * Whether a client's record lists a basis. The record holds the basis as a bare word ("net") or
 * as a taxonomy code ("reporting_basis.net"); either names it.
 */
export function basisOnRecord(reportingBases: readonly string[], basis: PackageBasis): boolean {
  return reportingBases.some((code) => code === basis || code.endsWith(`.${basis}`));
}

/* ---- Starting a package ---- */

export interface StartForm {
  clientId: string;
  /** A quarter end of quarterChoices. */
  periodEnd: string;
  basis: PackageBasis | '';
  label: PackageLabel | '';
  /** Why a released package is being corrected; asked for only when one was released. */
  correctionReason: string;
}

export const EMPTY_START_FORM: StartForm = {
  clientId: '',
  periodEnd: '',
  basis: '',
  label: '',
  correctionReason: '',
};

/**
 * Where a client, quarter and basis stand before a package is started for them: nothing yet (the
 * first version), one still on its way through the gate (a second cannot be started beside it),
 * or a released one (the next is a new version and needs a reason).
 */
export type StartStanding =
  | { kind: 'first' }
  | { kind: 'inProgress'; row: ReportPackageRow }
  | { kind: 'correction'; row: ReportPackageRow };

/**
 * The standing of the form's client, quarter and basis, read from the packages the reader sees.
 * The API judges again when the package is started; this only spares a request it would refuse.
 */
export function startStanding(
  items: readonly ReportPackageRow[],
  form: Pick<StartForm, 'clientId' | 'periodEnd' | 'basis'>,
): StartStanding {
  let latest: ReportPackageRow | undefined;
  for (const row of items) {
    if (
      row.client.id === form.clientId &&
      row.periodEnd === form.periodEnd &&
      row.basis === form.basis &&
      (latest === undefined || row.version > latest.version)
    )
      latest = row;
  }
  if (latest === undefined) return { kind: 'first' };
  return latest.state === 'Released'
    ? { kind: 'correction', row: latest }
    : { kind: 'inProgress', row: latest };
}

/** The body as the contract shapes it: no as-of date (the API reads its own), a trimmed reason only for a new version. */
export function startBody(form: StartForm, standing: StartStanding): unknown {
  return {
    clientId: form.clientId,
    periodEnd: form.periodEnd,
    basis: form.basis,
    label: form.label,
    ...(standing.kind === 'correction' ? { correctionReason: form.correctionReason.trim() } : {}),
  };
}

export type StartField = keyof StartForm;

/** What the form says about each field, in plain words, before anything is sent. */
const START_FIELD_WORDS: Readonly<Record<StartField, string>> = {
  clientId: 'Choose the client.',
  periodEnd: 'Choose the quarter.',
  basis: 'Choose gross or net.',
  label: 'Choose preliminary or final.',
  correctionReason: 'Say why the released package is being corrected, in 3 to 500 characters.',
};

function isStartField(value: string): value is StartField {
  return Object.hasOwn(START_FIELD_WORDS, value);
}

/**
 * The problems of the form by field, judged by the contract's own body: an empty map means the
 * body is ready. A package in progress is not a problem of a field; the form says that itself.
 */
export function startProblems(
  form: StartForm,
  standing: StartStanding,
): Partial<Record<StartField, string>> {
  const out: Partial<Record<StartField, string>> = {};
  const parsed = reportPackageCreateBody.safeParse(startBody(form, standing));
  if (parsed.success) return out;
  for (const issue of parsed.error.issues) {
    const path = String(issue.path[0] ?? '');
    const field: StartField = isStartField(path) ? path : 'clientId';
    out[field] ??= START_FIELD_WORDS[field];
  }
  return out;
}

/** The parsed body, or null while the form has problems or a package is already in progress. */
export function parsedStartBody(
  form: StartForm,
  standing: StartStanding,
): ReportPackageCreateBody | null {
  if (standing.kind === 'inProgress') return null;
  const parsed = reportPackageCreateBody.safeParse(startBody(form, standing));
  return parsed.success ? parsed.data : null;
}

/** "Client Alpha Pension, Q2 2025, gross, version 2": a package in one line, for a link or a result. */
export function packageWords(
  row: Pick<ReportPackageRow, 'client' | 'periodEnd' | 'basis' | 'version'>,
): string {
  return `${row.client.name}, ${formatQuarter(row.periodEnd)}, ${BASIS_WORDS[row.basis].toLowerCase()}, version ${row.version}`;
}

/** The fields of a start as the form names them, for a refusal that points at one. */
const START_FIELD_LABELS: Readonly<Record<string, string>> = {
  clientId: 'Client',
  periodEnd: 'Quarter',
  basis: 'Basis',
  label: 'Label',
  correctionReason: 'Reason for the new version',
  asOf: 'As-of date',
};

/** The form's name for a field a validation refusal points at; null for one it has no word for. */
export function startFieldLabel(path: string): string | null {
  return START_FIELD_LABELS[path] ?? null;
}

/** The role that starts a package, generates it and submits it (docs/18 section 5). */
export const START_ROLES: readonly string[] = ['investor_relations'];

/** Who reads packages, in the words both pages use for a reader they are not shown to. */
export const WHO_READS_PACKAGES = `Investor relations read the packages of the clients they are entitled to; ${WHO_READS_EVERY_CLIENT} read every client's. Ask a platform administrator if you need access.`;
