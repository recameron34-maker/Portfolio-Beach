import {
  D,
  ZERO,
  addMonths,
  alignedQuarterEnd,
  containingQuarterEnd,
  flowKindOf,
  isQuarterEnd,
  lockedNear,
  summarizeFlows,
  toDecimalString,
} from '@pb/calc';
import type { Decimal, TypedCashFlow } from '@pb/calc';
import { STALE_FOOTNOTE, rankMovers } from './qa.js';
import type { QaLine, QaSnapshot } from './qa.js';

/*
 * The package snapshot (docs/08 section 7): the lines of a reporting package for one quarter,
 * built from Locked marks and approved cash flows and from nothing else. It is the input of the
 * QA rules and, stored on the package, what a later package ties out to. Pure: it reads what it
 * is given and returns the snapshot.
 */

/** One position as the record holds it: only Locked marks, only approved flows. */
export interface PositionRecord {
  /** The position's number. */
  ref: string;
  vehicleRef: string;
  entryDate: string;
  /** The date the position was fully exited; null while it is held. */
  exitDate: string | null;
  /**
   * Its Locked marks, each with its own period end: the date the sponsor closed its books on,
   * which may sit a few days from the calendar quarter end the mark reports for.
   */
  marks: readonly { periodEnd: string; nav: string }[];
  flows: readonly TypedCashFlow[];
}

export interface SnapshotRequest {
  /** A calendar quarter end. */
  periodEnd: string;
  asOf: string;
  label: 'preliminary' | 'final';
  basis: 'gross' | 'net';
  positions: readonly PositionRecord[];
  /** Each client's ownership share of a vehicle, as a rate between 0 and 1. */
  shares: readonly { clientRef: string; vehicleRef: string; ownershipPct: string }[];
  priorRelease: QaSnapshot['priorRelease'];
  commentary: QaSnapshot['commentary'];
  moversCount: number;
  /**
   * How many days a mark may be dated from a calendar quarter end and still report for it
   * (`priorYearPeriodEndToleranceDays` of config/definitions.json, the tolerance of every
   * quarter match on the platform).
   */
  toleranceDays: number;
}

/** One position as a caller reads it from the record: every version of every mark, every approved flow. */
export interface PositionSource {
  /** The position's number. */
  ref: string;
  vehicleRef: string;
  entryDate: string;
  exitDate: string | null;
  /** The versions of its marks in any state; a package reads the Locked ones (docs/18 section 1). */
  valuations: readonly { periodEnd: string; state: string; fairValue: string }[];
  /** Its approved cash flows, each with the stored flow type (the taxonomy code). */
  flows: readonly { date: string; flowType: string; amount: string }[];
}

/**
 * What a package is generated from, as the record holds it. The API reads it from its tables
 * and the static preview from its recordings; both hand it to snapshotRequestOf, so the
 * snapshot is built from one reading of the record whoever generates it.
 */
export interface SnapshotSource {
  /** The package: its client, quarter, as-of date and labels. */
  clientRef: string;
  /** A calendar quarter end. */
  periodEnd: string;
  asOf: string;
  label: 'preliminary' | 'final';
  basis: 'gross' | 'net';
  /**
   * The client's commitments: the vehicle of each and the client's ownership share of it, as a
   * rate between 0 and 1; null while no share is on record.
   */
  commitments: readonly { vehicleRef: string; ownershipPct: string | null }[];
  /** The positions the preparer reads; those of a vehicle the client is not committed to are left out. */
  positions: readonly PositionSource[];
  /**
   * Every package released to this client on this basis, in any order: the quarter and version
   * of each, and the lines it showed; null for lines when the stored content cannot be read.
   */
  released: readonly {
    periodEnd: string;
    version: number;
    lines: readonly { ref: string; endNav: string | null }[] | null;
  }[];
  /** Why a begin NAV differs from the last released package, by position number. */
  explanations: Readonly<Record<string, string>>;
  moversCount: number;
  /** `priorYearPeriodEndToleranceDays` of config/definitions.json (SnapshotRequest.toleranceDays). */
  toleranceDays: number;
}

const text = (value: Decimal): string => toDecimalString(value) ?? '0';

/** Order by text, code unit by code unit: the order a database gives ids and ISO dates. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The snapshot request of a package, read from the record. Nothing is computed here: the rules
 * that decide what a package may read are applied, and buildPackageSnapshot does the arithmetic.
 *
 *  - A mark counts only when it is Locked (docs/18 section 1) and dated on or before the as-of
 *    date: a sponsor's close a few days after a quarter end is not known before its date. Each
 *    keeps its own date; which quarter it reports for is buildPackageSnapshot's to say.
 *  - A flow counts when it is dated on or before the as-of date.
 *  - The positions are those of the vehicles the client is committed to.
 *  - The client's share of a vehicle is its ownership on record, in vehicle order; a commitment
 *    with no share on record gives no client line (never a share of zero).
 *  - The prior release is the latest package released for an earlier quarter, its highest
 *    version; the package ties to the end NAV of each line that release showed. A release that
 *    cannot be read is no prior release: an older one is never read in its place.
 */
export function snapshotRequestOf(source: SnapshotSource): SnapshotRequest {
  const vehicles = new Set(source.commitments.map((c) => c.vehicleRef));
  const positions: PositionRecord[] = source.positions
    .filter((p) => vehicles.has(p.vehicleRef))
    .map((p) => ({
      ref: p.ref,
      vehicleRef: p.vehicleRef,
      entryDate: p.entryDate,
      exitDate: p.exitDate,
      marks: p.valuations
        .filter((v) => v.state === 'Locked' && v.periodEnd <= source.asOf)
        .map((v) => ({ periodEnd: v.periodEnd, nav: v.fairValue })),
      flows: p.flows
        .filter((f) => f.date <= source.asOf)
        .map((f) => ({ date: f.date, kind: flowKindOf(f.flowType), amount: f.amount })),
    }));

  const shares = source.commitments
    .map((c, index) => ({ ...c, index }))
    .sort((a, b) => byText(a.vehicleRef, b.vehicleRef) || a.index - b.index)
    .flatMap((c) =>
      c.ownershipPct === null
        ? []
        : [
            {
              clientRef: source.clientRef,
              vehicleRef: c.vehicleRef,
              ownershipPct: c.ownershipPct,
            },
          ],
    );

  const prior = source.released
    .filter((r) => r.periodEnd < source.periodEnd)
    .reduce<SnapshotSource['released'][number] | null>(
      (best, r) =>
        best === null ||
        r.periodEnd > best.periodEnd ||
        (r.periodEnd === best.periodEnd && r.version > best.version)
          ? r
          : best,
      null,
    );
  // Null with no earlier release, and for one whose stored lines cannot be read.
  const priorLines = prior?.lines ?? null;
  const priorRelease =
    priorLines === null
      ? null
      : {
          endNav: Object.fromEntries(
            priorLines.flatMap((l): [string, string][] =>
              l.endNav === null ? [] : [[l.ref, l.endNav]],
            ),
          ),
          explanations: source.explanations,
        };

  return {
    periodEnd: source.periodEnd,
    asOf: source.asOf,
    label: source.label,
    basis: source.basis,
    positions,
    shares,
    priorRelease,
    commentary: [],
    moversCount: source.moversCount,
    toleranceDays: source.toleranceDays,
  };
}

/** The latest of some ISO dates; null for none. */
const latest = (dates: readonly string[]): string | null =>
  dates.reduce<string | null>((max, d) => (max === null || d > max ? d : max), null);

/**
 * One position's line for the quarter (docs/08 section 7). A Locked mark reports for the calendar
 * quarter end it is dated within the tolerance of (alignedQuarterEnd), and the mark of a quarter
 * is the latest dated of those (lockedNear): the rule of the valuation board and the weekly
 * report, so a sponsor that closes its books a few days early or late is marked for the quarter
 * here as it is there. A mark holds the flows up to its own date, so the flows of a line are
 * those after the date of the mark it starts from and on or before the date of the mark it ends
 * on, and the calendar quarter end stands in on a side that has no mark. A flow between a
 * sponsor's close and the calendar quarter end is therefore in the next quarter's line, once.
 */
function lineOf(
  position: PositionRecord,
  periodEnd: string,
  quarterStart: string,
  toleranceDays: number,
): QaLine {
  const enteredInPeriod = position.entryDate > quarterStart;
  // Every mark is Locked here (PositionRecord); lockedNear reads the state it is given.
  const marks = position.marks.map((m) => ({
    ...m,
    state: 'Locked',
    reportsFor: alignedQuarterEnd(m.periodEnd, toleranceDays),
  }));
  const startMark = lockedNear(marks, quarterStart, toleranceDays);
  const current = lockedNear(marks, periodEnd, toleranceDays);
  const recorded = startMark === null ? null : D(startMark.nav);
  const begin = enteredInPeriod ? null : recorded;

  // The window of the line: from the date of the mark it starts from to the date of its own.
  const from = startMark === null || enteredInPeriod ? quarterStart : startMark.periodEnd;
  const to = current === null ? periodEnd : current.periodEnd;
  const between = (after: string, onOrBefore: string): TypedCashFlow[] =>
    position.flows.filter((f) => f.date > after && f.date <= onOrBefore);
  const inQuarter = between(from, to);
  const quarter = summarizeFlows(inQuarter);

  let end: Decimal | null = null;
  // The quarter the end NAV's mark reports for, and the date that mark carries.
  let endPeriod: string | null = null;
  let endMarkDate: string | null = null;
  if (current !== null) {
    end = D(current.nav);
    endPeriod = periodEnd;
    endMarkDate = current.periodEnd;
  } else if (position.exitDate !== null && position.exitDate <= periodEnd) {
    // Fully exited in the quarter: nothing is left to mark.
    end = ZERO;
    endPeriod = periodEnd;
  } else {
    // No mark for the period: the latest one for an earlier period, rolled forward with the
    // flows since its own date.
    let last: (typeof marks)[number] | null = null;
    for (const m of marks)
      if (m.reportsFor < periodEnd && (last === null || m.periodEnd > last.periodEnd)) last = m;
    if (last !== null) {
      const since = summarizeFlows(between(last.periodEnd, periodEnd));
      end = D(last.nav).plus(since.contributions).minus(since.distributions);
      endPeriod = last.reportsFor;
      endMarkDate = last.periodEnd;
    }
  }

  const base = enteredInPeriod ? ZERO : begin;
  const gainLoss =
    end === null || base === null
      ? null
      : end.minus(base).minus(quarter.contributions).plus(quarter.distributions);

  const figureDates = [
    // The date of the mark behind the end NAV; the quarter end for a position exited at zero.
    ...(endMarkDate === null ? (endPeriod === null ? [] : [endPeriod]) : [endMarkDate]),
    ...(startMark === null || enteredInPeriod ? [] : [startMark.periodEnd]),
    ...inQuarter.map((f) => f.date),
  ];

  return {
    ref: position.ref,
    enteredInPeriod,
    beginNav: begin === null ? null : text(begin),
    contributions: text(quarter.contributions),
    distributions: text(quarter.distributions),
    gainLoss: gainLoss === null ? null : text(gainLoss),
    endNav: end === null ? null : text(end),
    endNavPeriodEnd: endPeriod,
    endNavMarkDate: endMarkDate,
    recordedQuarterStartNav: recorded === null ? null : text(recorded),
    latestFigureDate: latest(figureDates),
  };
}

/** The snapshot of one package: its lines, movers, footnotes and client lines, ready for the QA rules. */
export function buildPackageSnapshot(request: SnapshotRequest): QaSnapshot {
  const { periodEnd, asOf } = request;
  if (!isQuarterEnd(periodEnd))
    throw new Error(`a package period is a quarter end, not ${periodEnd}`);
  if (asOf < periodEnd)
    throw new Error(`the as-of date ${asOf} is before the period end ${periodEnd}`);
  const { toleranceDays } = request;
  if (!Number.isInteger(toleranceDays) || toleranceDays < 0)
    throw new Error(`the period end tolerance is a whole number of days, not ${toleranceDays}`);
  const quarterStart = containingQuarterEnd(addMonths(periodEnd, -3));

  const seen = new Set<string>();
  for (const p of request.positions) {
    if (seen.has(p.ref)) throw new Error(`two positions carry the number ${p.ref}`);
    seen.add(p.ref);
  }

  const held = request.positions
    .filter((p) => p.entryDate <= periodEnd && (p.exitDate === null || p.exitDate > quarterStart))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const lines = held.map((p) => lineOf(p, periodEnd, quarterStart, toleranceDays));

  const footnotes = lines
    .filter((l) => l.endNav !== null && l.endNavPeriodEnd !== null && l.endNavPeriodEnd < periodEnd)
    .map((l) => ({ ref: l.ref, code: STALE_FOOTNOTE }));

  const vehicleOf = new Map(held.map((p) => [p.ref, p.vehicleRef]));
  const clientLines = request.shares.flatMap((share) =>
    lines.flatMap((line) =>
      line.endNav === null || vehicleOf.get(line.ref) !== share.vehicleRef
        ? []
        : [
            {
              clientRef: share.clientRef,
              ref: line.ref,
              ownershipPct: share.ownershipPct,
              nav: text(D(line.endNav).times(share.ownershipPct)),
            },
          ],
    ),
  );

  return {
    periodEnd,
    asOf,
    status: request.label,
    basis: request.basis,
    lines,
    movers: rankMovers(lines, request.moversCount),
    commentary: request.commentary,
    footnotes,
    clientLines,
    priorRelease: request.priorRelease,
  };
}
