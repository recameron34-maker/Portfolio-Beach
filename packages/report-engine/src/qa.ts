import { D, ZERO, navRollForward, toDecimalString, valueChange } from '@pb/calc';
import type { Decimal, DecimalInput } from '@pb/calc';

/*
 * The report QA engine (docs/04 M14, docs/08 section 7): the release gate of a reporting package.
 * It reads one snapshot of a package and answers a finding per rule and entity. It changes
 * nothing and writes nothing; what a failed finding means for the package is the state machine's
 * business (docs/18 section 5). A rule that cannot be checked for want of a figure fails and says
 * which figure is missing: it never passes by default and never reads another period (rule 10).
 */

export const QA_RULES = [
  'QA-RDY-01',
  'QA-STALE-01',
  'QA-ASOF-01',
  'QA-QTD-01',
  'QA-RF-01',
  'QA-SIGN-01',
  'QA-TIE-01',
  'QA-MOV-01',
  'QA-LBL-01',
  'QA-CLI-01',
] as const;
export type QaRule = (typeof QA_RULES)[number];

/** The footnote a position carries when its mark is for an earlier period than the package. */
export const STALE_FOOTNOTE = 'stale_valuation';

/** One position of a package for one quarter: what the package shows, beside what is on record. */
export interface QaLine {
  /** The position's number. */
  ref: string;
  /** Entered during the quarter: the line starts from zero and has no prior quarter to tie to. */
  enteredInPeriod: boolean;
  /** As the package shows them. Amounts are decimal strings in dollars. */
  beginNav: string | null;
  contributions: string;
  distributions: string;
  gainLoss: string | null;
  endNav: string | null;
  /** The period the end NAV's mark is for; earlier than the package's period when the mark is stale. */
  endNavPeriodEnd: string | null;
  /** On record: the Locked mark at the end of the prior quarter. */
  recordedQuarterStartNav: string | null;
  /** The latest date of any figure the line uses (a mark, a flow, an entry snapshot). */
  latestFigureDate: string | null;
}

export interface QaSnapshot {
  periodEnd: string;
  /** The date the package's data was read as of. */
  asOf: string;
  status: 'preliminary' | 'final' | null;
  basis: 'gross' | 'net' | null;
  lines: readonly QaLine[];
  /** The movers as the package shows them, in its order. */
  movers: readonly string[];
  /** Each commentary blurb with the key of the movers list it was written against (`moversKey`). */
  commentary: readonly { ref: string; moversKey: string }[];
  footnotes: readonly { ref: string; code: string }[];
  clientLines: readonly { clientRef: string; ref: string; ownershipPct: string; nav: string }[];
  /** The last released package for the same client and basis; null for the first one. */
  priorRelease: {
    endNav: Readonly<Record<string, string>>;
    explanations: Readonly<Record<string, string>>;
  } | null;
}

export interface QaSettings {
  /** `rollForwardToleranceUsd` of config/definitions.json. */
  toleranceUsd: DecimalInput;
  /** `reporting.weeklyMoversCount`. */
  moversCount: number;
}

export interface QaFinding {
  rule: QaRule;
  /** A position number, "client:position", or "package", "status", "basis". */
  entityRef: string;
  expected: string | null;
  actual: string | null;
  passed: boolean;
  /** One sentence a reviewer can act on. */
  detail: string;
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** A figure as a number; null when there is none; 'bad' when it is not a decimal. */
function read(value: string | null): Decimal | null | 'bad' {
  if (value === null) return null;
  return DECIMAL.test(value) ? D(value) : 'bad';
}

const text = (value: Decimal | null): string | null => toDecimalString(value);

/** The movers of a set of lines: largest value change by size first, ties by position number. */
export function rankMovers(lines: readonly QaLine[], count: number): string[] {
  const ranked: { ref: string; size: Decimal }[] = [];
  for (const line of lines) {
    if (line.enteredInPeriod) continue;
    const begin = read(line.beginNav);
    const end = read(line.endNav);
    if (begin === null || end === null || begin === 'bad' || end === 'bad') continue;
    const change = valueChange(end, begin);
    if (change !== null) ranked.push({ ref: line.ref, size: change.abs() });
  }
  return ranked
    .sort((a, b) => b.size.comparedTo(a.size) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    .slice(0, Math.max(0, count))
    .map((r) => r.ref);
}

/** What a commentary blurb records about the movers list it was written against. */
export function moversKey(refs: readonly string[]): string {
  return refs.join('|');
}

/** A package may be released on its findings alone when none failed. */
export function qaPassed(findings: readonly QaFinding[]): boolean {
  return findings.every((f) => f.passed);
}

/** Every finding of one snapshot, rule by rule in the order of QA_RULES, line by line within a rule. */
export function runReportQa(snapshot: QaSnapshot, settings: QaSettings): QaFinding[] {
  const tolerance = D(settings.toleranceUsd);
  const within = (difference: Decimal): boolean => difference.abs().lte(tolerance);
  const out: QaFinding[] = [];
  const add = (
    rule: QaRule,
    entityRef: string,
    passed: boolean,
    detail: string,
    expected: string | null = null,
    actual: string | null = null,
  ): void => {
    out.push({ rule, entityRef, expected, actual, passed, detail });
  };
  const stale = (line: QaLine): boolean =>
    line.endNav !== null &&
    (line.endNavPeriodEnd === null || line.endNavPeriodEnd < snapshot.periodEnd);
  const footnoted = (ref: string): boolean =>
    snapshot.footnotes.some((f) => f.ref === ref && f.code === STALE_FOOTNOTE);

  // QA-RDY-01: every position has an end NAV to report.
  for (const line of snapshot.lines) {
    const end = read(line.endNav);
    if (end === 'bad')
      add('QA-RDY-01', line.ref, false, 'The end NAV is not a number.', null, line.endNav);
    else if (end === null)
      add('QA-RDY-01', line.ref, false, 'The position has no end NAV to report.');
    else add('QA-RDY-01', line.ref, true, 'The position has an end NAV.', null, text(end));
  }

  // QA-STALE-01: a mark for an earlier period carries the stale-valuation footnote.
  for (const line of snapshot.lines) {
    if (!stale(line))
      add(
        'QA-STALE-01',
        line.ref,
        true,
        line.endNav === null
          ? 'There is no mark to be stale.'
          : 'The mark is for the period of the package.',
        snapshot.periodEnd,
        line.endNavPeriodEnd,
      );
    else if (footnoted(line.ref))
      add(
        'QA-STALE-01',
        line.ref,
        true,
        'The mark is for an earlier period and carries the stale-valuation footnote.',
        snapshot.periodEnd,
        line.endNavPeriodEnd,
      );
    else
      add(
        'QA-STALE-01',
        line.ref,
        false,
        line.endNavPeriodEnd === null
          ? 'The period of the mark is not recorded, so it cannot be shown as current.'
          : 'The mark is for an earlier period and the stale-valuation footnote is missing.',
        snapshot.periodEnd,
        line.endNavPeriodEnd,
      );
  }

  // QA-ASOF-01: nothing in the package is dated after its as-of date.
  add(
    'QA-ASOF-01',
    'package',
    snapshot.periodEnd <= snapshot.asOf,
    snapshot.periodEnd <= snapshot.asOf
      ? 'The period ends on or before the as-of date.'
      : 'The period ends after the as-of date of the package.',
    snapshot.asOf,
    snapshot.periodEnd,
  );
  for (const line of snapshot.lines) {
    if (line.latestFigureDate === null)
      add(
        'QA-ASOF-01',
        line.ref,
        false,
        'The line carries no dated figure to check.',
        snapshot.asOf,
      );
    else {
      const ok = line.latestFigureDate <= snapshot.asOf;
      add(
        'QA-ASOF-01',
        line.ref,
        ok,
        ok
          ? 'Every figure of the line is dated on or before the as-of date.'
          : 'A figure of the line is dated after the as-of date of the package.',
        snapshot.asOf,
        line.latestFigureDate,
      );
    }
  }

  // QA-QTD-01: a line starts from the Locked mark at the end of the prior quarter.
  for (const line of snapshot.lines) {
    const begin = read(line.beginNav);
    const recorded = read(line.recordedQuarterStartNav);
    if (begin === 'bad' || recorded === 'bad') {
      add('QA-QTD-01', line.ref, false, 'The begin NAV is not a number.', null, line.beginNav);
    } else if (line.enteredInPeriod) {
      const fromZero = begin === null || begin.isZero();
      add(
        'QA-QTD-01',
        line.ref,
        fromZero,
        fromZero
          ? 'The position was entered in the quarter and starts from zero.'
          : 'The position was entered in the quarter, so its line starts from zero, not from a begin NAV.',
        '0',
        text(begin),
      );
    } else if (recorded === null) {
      add(
        'QA-QTD-01',
        line.ref,
        false,
        'There is no Locked mark at the end of the prior quarter to start the quarter from.',
        null,
        text(begin),
      );
    } else if (begin === null) {
      add('QA-QTD-01', line.ref, false, 'The line shows no begin NAV.', text(recorded));
    } else {
      const ok = within(begin.minus(recorded));
      add(
        'QA-QTD-01',
        line.ref,
        ok,
        ok
          ? 'The line starts from the Locked mark at the end of the prior quarter.'
          : 'The line does not start from the Locked mark at the end of the prior quarter.',
        text(recorded),
        text(begin),
      );
    }
  }

  // The terms of a line's roll-forward, or the name of the one that is missing or unreadable.
  const terms = (
    line: QaLine,
  ):
    | {
        begin: Decimal;
        contributions: Decimal;
        distributions: Decimal;
        gain: Decimal;
        end: Decimal;
      }
    | string => {
    const named: [string, string | null][] = [
      ['begin NAV', line.enteredInPeriod ? (line.beginNav ?? '0') : line.beginNav],
      ['contributions', line.contributions],
      ['distributions', line.distributions],
      ['gain or loss', line.gainLoss],
      ['end NAV', line.endNav],
    ];
    const values: Decimal[] = [];
    for (const [name, raw] of named) {
      const value = read(raw);
      if (value === 'bad') return `The ${name} is not a number.`;
      if (value === null) return `The line has no ${name}.`;
      values.push(value);
    }
    const [begin, contributions, distributions, gain, end] = values as [
      Decimal,
      Decimal,
      Decimal,
      Decimal,
      Decimal,
    ];
    return { begin, contributions, distributions, gain, end };
  };

  // QA-RF-01: begin + contributions - distributions + gain or loss = end, within the tolerance.
  for (const line of snapshot.lines) {
    const t = terms(line);
    if (typeof t === 'string') {
      add('QA-RF-01', line.ref, false, `The roll-forward cannot be checked. ${t}`);
      continue;
    }
    const check = navRollForward(
      {
        beginNav: t.begin,
        contributions: t.contributions,
        distributions: t.distributions,
        gainLoss: t.gain,
        endNav: t.end,
      },
      tolerance,
    );
    add(
      'QA-RF-01',
      line.ref,
      check.passed,
      check.passed
        ? 'Begin NAV, flows and the gain or loss roll forward to the end NAV.'
        : 'Begin NAV, flows and the gain or loss do not roll forward to the end NAV.',
      text(t.end.minus(check.difference)),
      text(t.end),
    );
  }

  // QA-SIGN-01: the gain or loss has the sign the figures imply; flow totals are not negative.
  for (const line of snapshot.lines) {
    const t = terms(line);
    if (typeof t === 'string') {
      add('QA-SIGN-01', line.ref, false, `The sign cannot be checked. ${t}`);
      continue;
    }
    if (t.contributions.lt(ZERO) || t.distributions.lt(ZERO)) {
      add(
        'QA-SIGN-01',
        line.ref,
        false,
        'Contributions and distributions are totals and cannot be negative.',
      );
      continue;
    }
    const implied = t.end.minus(t.begin).minus(t.contributions).plus(t.distributions);
    // A figure within the tolerance of zero has no sign to get wrong.
    const flat = within(implied) || within(t.gain);
    const ok = flat || implied.isNegative() === t.gain.isNegative();
    add(
      'QA-SIGN-01',
      line.ref,
      ok,
      ok
        ? 'The gain or loss has the sign the figures imply.'
        : implied.isNegative()
          ? 'The figures imply a loss and the package shows a gain.'
          : 'The figures imply a gain and the package shows a loss.',
      text(implied),
      text(t.gain),
    );
  }

  // QA-TIE-01: a begin NAV ties to the last released package, or an explanation is recorded.
  if (snapshot.priorRelease === null) {
    add('QA-TIE-01', 'package', true, 'No package was released before this one to tie to.');
  } else {
    const prior = snapshot.priorRelease;
    for (const line of snapshot.lines) {
      if (line.enteredInPeriod) {
        add(
          'QA-TIE-01',
          line.ref,
          true,
          'The position was entered in the quarter: nothing to tie to.',
        );
        continue;
      }
      const explained = (prior.explanations[line.ref] ?? '').trim().length > 0;
      const begin = read(line.beginNav);
      const last = read(prior.endNav[line.ref] ?? null);
      if (begin === 'bad' || last === 'bad') {
        add('QA-TIE-01', line.ref, false, 'A NAV of the tie-out is not a number.');
      } else if (begin === null || last === null) {
        add(
          'QA-TIE-01',
          line.ref,
          explained,
          explained
            ? 'One side of the tie-out is missing and an explanation is recorded.'
            : last === null
              ? 'The last released package did not carry this position, and no explanation is recorded.'
              : 'The line shows no begin NAV to tie to the last released package.',
          text(last),
          text(begin),
        );
      } else {
        const ties = within(begin.minus(last));
        add(
          'QA-TIE-01',
          line.ref,
          ties || explained,
          ties
            ? 'The begin NAV ties to the end NAV of the last released package.'
            : explained
              ? 'The begin NAV differs from the last released package and an explanation is recorded.'
              : 'The begin NAV differs from the end NAV of the last released package, and no explanation is recorded.',
          text(last),
          text(begin),
        );
      }
    }
  }

  // QA-MOV-01: the movers shown are the movers of the lines as they stand, and every blurb was written against them.
  const movers = rankMovers(snapshot.lines, settings.moversCount);
  const sameList =
    movers.length === snapshot.movers.length &&
    movers.every((ref, i) => ref === snapshot.movers[i]);
  add(
    'QA-MOV-01',
    'package',
    sameList,
    sameList
      ? 'The movers shown are the movers of the figures as they stand.'
      : 'The movers shown are not the movers of the figures as they stand.',
    movers.join(', '),
    snapshot.movers.join(', '),
  );
  const key = moversKey(movers);
  for (const blurb of snapshot.commentary) {
    const current = blurb.moversKey === key;
    add(
      'QA-MOV-01',
      blurb.ref,
      current,
      current
        ? 'The commentary was written against the current movers.'
        : 'The commentary was written against a superseded list of movers.',
      key,
      blurb.moversKey,
    );
  }

  // QA-LBL-01: preliminary or final, gross or net; never final over a stale mark.
  const anyStale = snapshot.lines.some(stale);
  if (snapshot.status === null)
    add(
      'QA-LBL-01',
      'status',
      false,
      'The package does not say whether it is preliminary or final.',
    );
  else if (snapshot.status === 'final' && anyStale)
    add(
      'QA-LBL-01',
      'status',
      false,
      'The package says final while a position carries a mark for an earlier period.',
      'preliminary',
      'final',
    );
  else
    add(
      'QA-LBL-01',
      'status',
      true,
      `The package is labelled ${snapshot.status}.`,
      null,
      snapshot.status,
    );
  if (snapshot.basis === null)
    add(
      'QA-LBL-01',
      'basis',
      false,
      'The package does not say whether its figures are gross or net.',
    );
  else
    add(
      'QA-LBL-01',
      'basis',
      true,
      `The figures are labelled ${snapshot.basis}.`,
      null,
      snapshot.basis,
    );

  // QA-CLI-01: a client line is its position's end NAV times the client's ownership share.
  for (const client of snapshot.clientLines) {
    const entity = `${client.clientRef}:${client.ref}`;
    const line = snapshot.lines.find((l) => l.ref === client.ref);
    const end = line === undefined ? null : read(line.endNav);
    const share = read(client.ownershipPct);
    const nav = read(client.nav);
    if (line === undefined) {
      add(
        'QA-CLI-01',
        entity,
        false,
        'The client line names a position the package does not carry.',
      );
    } else if (
      end === 'bad' ||
      share === 'bad' ||
      nav === 'bad' ||
      share === null ||
      nav === null
    ) {
      add('QA-CLI-01', entity, false, 'A figure of the client line is not a number.');
    } else if (end === null) {
      add(
        'QA-CLI-01',
        entity,
        false,
        'The position has no end NAV to take a share of.',
        null,
        text(nav),
      );
    } else {
      const expected = end.times(share);
      const ok = within(nav.minus(expected));
      add(
        'QA-CLI-01',
        entity,
        ok,
        ok
          ? "The client line is the client's share of the position."
          : "The client line is not the client's share of the position.",
        text(expected),
        text(nav),
      );
    }
  }

  return out;
}
