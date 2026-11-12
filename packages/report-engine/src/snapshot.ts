import {
  D,
  ZERO,
  addMonths,
  containingQuarterEnd,
  isQuarterEnd,
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
}

const text = (value: Decimal): string => toDecimalString(value) ?? '0';

/** The latest of some ISO dates; null for none. */
const latest = (dates: readonly string[]): string | null =>
  dates.reduce<string | null>((max, d) => (max === null || d > max ? d : max), null);

function lineOf(position: PositionRecord, periodEnd: string, quarterStart: string): QaLine {
  const inPeriod = (date: string, after: string): boolean => date > after && date <= periodEnd;
  const quarter = summarizeFlows(position.flows.filter((f) => inPeriod(f.date, quarterStart)));
  const enteredInPeriod = position.entryDate > quarterStart;

  // Marks on or before the period end, the latest first.
  const marks = position.marks
    .filter((m) => m.periodEnd <= periodEnd)
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : a.periodEnd > b.periodEnd ? -1 : 0));
  const startMark = marks.find((m) => m.periodEnd === quarterStart);
  const recorded = startMark === undefined ? null : D(startMark.nav);
  const begin = enteredInPeriod ? null : recorded;

  let end: Decimal | null = null;
  let endPeriod: string | null = null;
  const current = marks.find((m) => m.periodEnd === periodEnd);
  const last = marks[0];
  if (current !== undefined) {
    end = D(current.nav);
    endPeriod = periodEnd;
  } else if (position.exitDate !== null && position.exitDate <= periodEnd) {
    // Fully exited in the quarter: nothing is left to mark.
    end = ZERO;
    endPeriod = periodEnd;
  } else if (last !== undefined) {
    // No mark for the period: the last one, rolled forward with the flows since it.
    const since = summarizeFlows(position.flows.filter((f) => inPeriod(f.date, last.periodEnd)));
    end = D(last.nav).plus(since.contributions).minus(since.distributions);
    endPeriod = last.periodEnd;
  }

  const base = enteredInPeriod ? ZERO : begin;
  const gainLoss =
    end === null || base === null
      ? null
      : end.minus(base).minus(quarter.contributions).plus(quarter.distributions);

  const figureDates = [
    ...(endPeriod === null ? [] : [endPeriod]),
    ...(startMark === undefined || enteredInPeriod ? [] : [startMark.periodEnd]),
    ...position.flows.filter((f) => inPeriod(f.date, quarterStart)).map((f) => f.date),
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
  const quarterStart = containingQuarterEnd(addMonths(periodEnd, -3));

  const seen = new Set<string>();
  for (const p of request.positions) {
    if (seen.has(p.ref)) throw new Error(`two positions carry the number ${p.ref}`);
    seen.add(p.ref);
  }

  const held = request.positions
    .filter((p) => p.entryDate <= periodEnd && (p.exitDate === null || p.exitDate > quarterStart))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const lines = held.map((p) => lineOf(p, periodEnd, quarterStart));

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
