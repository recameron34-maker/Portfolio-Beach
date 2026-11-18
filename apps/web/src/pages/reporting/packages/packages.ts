import { isCalendarDate, latestQuarterEndOnOrBefore, previousQuarterEnd } from '@pb/calc';
import { REPORT_PACKAGE_STATES } from '@pb/contracts';
import type { ReportPackageLine, ReportPackageRow, ReportPackageState } from '@pb/contracts';
import { STALE_FOOTNOTE } from '@pb/report-engine';
import type { QaRule } from '@pb/report-engine';
import { reportingPackageMachine } from '@pb/workflows';
import type { ReportingPackageCommand } from '@pb/workflows';
import definitions from '../../../../../../config/definitions.json';
import type { Step, StepStatus } from '../../../components/StepStrip.js';
import { formatDate, formatUsdExact, labelOf, MISSING } from '../../../lib/format.js';
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

/* ---- Positions ---- */

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
