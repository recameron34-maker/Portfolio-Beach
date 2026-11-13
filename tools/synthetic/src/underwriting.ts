import {
  D,
  addDays,
  addMonths,
  compareIso,
  daysBetween,
  entrySnapshot,
  flaggedIrr,
  latestPeriod,
  moic,
  summarizeFlows,
  toDecimalString,
  toSignedFlows,
  underwritingComparison,
  valueCreationBridge,
  yieldToMaturity,
} from '@pb/calc';
import type {
  Decimal,
  FlowKind,
  TypedCashFlow,
  UnderwritingCase,
  UnderwritingComparison,
  UnderwritingInputs,
  UnderwritingTolerances,
} from '@pb/calc';
import type { SyntheticDataset } from '@pb/db';
import { latestLockedMark } from './marks.js';
import { QUARTERLY_REPORTING_DEAL_TYPES } from './preview-book.js';
import { Rng } from './prng.js';

/*
 * The sponsor's underwritten base cases (docs/14 section 12, docs/04 M9, decision 0022): the plan
 * each equity and continuation vehicle position is compared with on its deal page, and the yield,
 * loss rate, MOIC and IRR each loan was underwritten on. Built last, from the dataset as it stands
 * and from streams of its own, so adding them moved no other value. Every figure is fictional.
 * Primary funds have none.
 */

export type UnderwritingCaseRow = NonNullable<SyntheticDataset['underwritingCases']>[number];
export type UnderwritingPointRow = UnderwritingCaseRow['points'][number];

type Investment = SyntheticDataset['investments'][number];
type Quarter = SyntheticDataset['quarterlyPerformance'][number];
type CreditTerms = SyntheticDataset['creditTerms'][number];

/** The deal type whose positions carry a loan's base case. */
export const UNDERWRITING_CREDIT_DEAL_TYPE = 'deal_type.private_credit';

/** Scenario tags of the base cases, each naming one investment (docs/14 section 3). */
export const UNDERWRITING_SCENARIOS = [
  'underwriting_ahead',
  'underwriting_on_plan',
  'underwriting_behind',
  'underwriting_reunderwritten',
  'underwriting_corrected',
  'underwriting_draft',
  'underwriting_withdrawn',
  'underwriting_past_exit',
  'underwriting_gap',
  'underwriting_net_cash',
] as const;
export type UnderwritingScenario = (typeof UNDERWRITING_SCENARIOS)[number];

/** The data scenarios whose positions always carry an ordinary Confirmed case, so each edge is on a card. */
export const UNDERWRITING_EXISTING_SCENARIOS = [
  'negative_ebitda',
  'forward_entry_snapshot',
  'period_end_shift',
  'walled_deal',
] as const;

/** One position in this many has no base case on record (the fifth, the tenth and so on). */
export const UNDERWRITING_NONE_EVERY = 5;
/** An ordinary plan runs this many years from the entry snapshot. */
export const UNDERWRITING_PLAN_YEARS = { min: 4, max: 6 } as const;
/** How far a scenario moves the plan from what the position did: EBITDA growth a year, and the IRR. */
export const UNDERWRITING_GROWTH_SHIFT = 0.08;
export const UNDERWRITING_IRR_SHIFT = 0.05;
/** The shortest ownership the ahead, on plan and behind scenarios take, in days. */
export const UNDERWRITING_MIN_HELD_DAYS = 730;

/** The expected loss a year a loan is underwritten with, drawn inside this band. */
export const UNDERWRITING_LOSS_RATE = { min: 0.005, max: 0.02 } as const;

/** "UNDW": the base cases' own stream, the seed turned by a constant as the other late streams are. */
const UNDERWRITING_STREAM = 0x554e4457;
/** "UNDC": the loans' stream, apart from the equity one, so neither moves the other's draws. */
const UNDERWRITING_CREDIT_STREAM = 0x554e4443;
/** The longest plan a scenario may need (an old position whose plan must reach past the as-of date). */
const MAX_PLAN_YEARS = 14;
const SOURCE_NOTE = 'Sponsor base case model at entry, held in the deal folder';
const LOAN_SOURCE_NOTE = 'Underwriting model of the loan at entry, held in the deal folder';

const fixed = (value: number, places = 2): string => value.toFixed(places);
const kindOf = (flowType: string): FlowKind => flowType.replace('flow_type.', '') as FlowKind;
const approved = (q: Quarter): boolean => q.status === 'record_status.approved';

/** The parts of the dataset the base cases are built from and checked against. */
export interface UnderwritingBase {
  asOf: string;
  users: SyntheticDataset['users'];
  investments: SyntheticDataset['investments'];
  quarterlyPerformance: SyntheticDataset['quarterlyPerformance'];
  creditTerms: SyntheticDataset['creditTerms'];
  creditPerformance: SyntheticDataset['creditPerformance'];
  valuations: SyntheticDataset['valuations'];
  cashFlows: SyntheticDataset['cashFlows'];
  walls: SyntheticDataset['walls'];
  scenarios: Record<string, string[]>;
}

export interface UnderwritingDeps {
  seed: number;
  /** Records a scenario tag against an id in the dataset's scenario log. */
  tag: (scenario: string, id: string) => void;
}

/** The day a position's company figures stop counting: the as-of date, or its exit when that came first. */
const cutoffOf = (investment: Investment, asOf: string): string =>
  investment.exitDate !== null && investment.exitDate < asOf ? investment.exitDate : asOf;

/**
 * A loan's yield to maturity as of the dataset's as-of date, as the Performance tab works it out
 * (docs/08 section 10): the latest approved credit row on or before the date is priced over the
 * contractual flows to maturity, with only the repayment steps still to come. Null for a position
 * with no credit terms, past maturity, or with no priced row.
 */
function loanYieldToMaturity(base: UnderwritingBase, investment: Investment): Decimal | null {
  const terms = base.creditTerms.find((t) => t.investmentId === investment.id);
  if (terms === undefined) return null;
  const rows = base.creditPerformance
    .filter((c) => c.investmentId === investment.id)
    .map((c) => ({ ...c, status: c.status.replace('record_status.', '') }));
  const latest = latestPeriod(rows, base.asOf);
  const fairValue = latest?.fairValue ?? null;
  const par = latest?.parValue ?? null;
  if (fairValue === null || par === null) return null;
  return yieldToMaturity({
    asOf: base.asOf,
    fairValue,
    par,
    cashCoupon: terms.cashCoupon,
    pikCoupon: terms.pikCoupon,
    maturity: terms.maturityDate,
    frequency: terms.paymentFrequency,
    scheduledPrincipal: (terms.amortization ?? []).filter((step) => step.date > base.asOf),
  }).value;
}

/**
 * What a position's comparison is worked out from, as of the dataset's as-of date, by the rules
 * the API follows (docs/08 sections 2, 5, 8 and 10): the approved entry snapshot once it is dated
 * on or before the date, the latest approved quarter on or before it (or before the exit), the
 * company's bridge between the two, our own flows, invested capital, distributions, gross MOIC
 * and gross IRR with its flag over the latest Locked mark, and for a loan its yield to maturity.
 * The generator and its dataset check read a position through this one function.
 */
export function underwritingInputsOf(
  base: UnderwritingBase,
  investment: Investment,
): UnderwritingInputs {
  const asOf = base.asOf;
  const isActive = investment.exitDate === null || investment.exitDate > asOf;
  const rows = base.quarterlyPerformance
    .filter((q) => q.investmentId === investment.id)
    .map((q) => ({ ...q, status: q.status.replace('record_status.', '') }));
  const flagged = entrySnapshot(rows);
  const snapshot = flagged !== null && flagged.status === 'approved' ? flagged : null;
  const forwardDated = snapshot !== null && snapshot.periodEnd > asOf;
  const entry = forwardDated ? null : snapshot;
  const current = latestPeriod(rows, cutoffOf(investment, asOf));

  let bridge: UnderwritingInputs['bridge'] = null;
  let bridgeNotCalculable: UnderwritingInputs['bridgeNotCalculable'] = null;
  if (entry === null)
    bridgeNotCalculable = forwardDated ? 'entry_snapshot_forward_dated' : 'no_entry_snapshot';
  else if (current === null) bridgeNotCalculable = 'no_current_quarter';
  else if (
    entry.ebitdaLtm === null ||
    entry.ev === null ||
    entry.netDebt === null ||
    current.ebitdaLtm === null ||
    current.ev === null ||
    current.netDebt === null
  )
    bridgeNotCalculable = 'missing_figures';
  else {
    const result = valueCreationBridge(
      { ebitda: entry.ebitdaLtm, ev: entry.ev, netDebt: entry.netDebt },
      { ebitda: current.ebitdaLtm, ev: current.ev, netDebt: current.netDebt },
    );
    if (result.value === null) bridgeNotCalculable = result.reason;
    else {
      const { ebitdaGrowth, multipleExpansion, debtPaydown, total } = result.value;
      bridge = { ebitdaGrowth, multipleExpansion, debtPaydown, total };
    }
  }

  const typed: TypedCashFlow[] = base.cashFlows
    .filter(
      (f) =>
        f.investmentId === investment.id &&
        f.status === 'record_status.approved' &&
        f.flowDate <= asOf,
    )
    .map((f) => ({ date: f.flowDate, kind: kindOf(f.flowType), amount: f.amount }));
  const summary = summarizeFlows(typed);
  const mark = isActive ? latestLockedMark(base.valuations, investment.id, asOf) : null;
  const invested = summary.contributions.isZero() ? null : summary.contributions;
  // A realized position holds nothing; a held one without a Locked mark has no NAV, and nothing
  // that needs one is calculable.
  const nav = mark === null ? (isActive ? null : D('0')) : D(mark.fairValue);
  const grossMoic =
    invested === null || nav === null ? null : moic(summary.distributions, nav, invested);
  const flows = toSignedFlows(typed);
  const { grossIrr, irrFlag } = flaggedIrr(
    mark === null ? flows : [...flows, { date: asOf, amount: mark.fairValue }],
    nav !== null,
  );
  const figures = (q: Pick<Quarter, 'periodEnd' | 'revenueLtm' | 'ebitdaLtm' | 'netDebt'>) => ({
    periodEnd: q.periodEnd,
    revenueLtm: q.revenueLtm,
    ebitdaLtm: q.ebitdaLtm,
    netDebt: q.netDebt,
  });
  return {
    asOf,
    isActive,
    entry:
      entry === null
        ? null
        : {
            periodEnd: entry.periodEnd,
            ebitdaLtm: entry.ebitdaLtm,
            ev: entry.ev,
            netDebt: entry.netDebt,
          },
    current: current === null ? null : figures(current),
    quarters: rows
      .filter((q) => !q.isEntrySnapshot && q.status === 'approved' && q.periodEnd <= asOf)
      .map(figures),
    bridge,
    bridgeNotCalculable,
    flows,
    invested,
    distributions: invested === null ? null : summary.distributions,
    grossMoic,
    grossIrr,
    irrFlag,
    yieldToMaturity: loanYieldToMaturity(base, investment),
  };
}

/** A seeded case as the comparison reads it. */
export function calcCaseOf(row: UnderwritingCaseRow): UnderwritingCase {
  return {
    form: row.form,
    plannedExitDate: row.plannedExitDate,
    exitMultiple: row.exitMultiple,
    grossMoic: row.grossMoic,
    grossIrr: row.grossIrr,
    points: row.points.map(({ periodEnd, revenueLtm, ebitdaLtm, netDebt }) => ({
      periodEnd,
      revenueLtm,
      ebitdaLtm,
      netDebt,
    })),
  };
}

/** A position against one of its seeded cases, as of the dataset's as-of date (docs/08 section 11). */
export function seededComparison(
  base: UnderwritingBase,
  row: UnderwritingCaseRow,
  tolerances: UnderwritingTolerances,
): UnderwritingComparison {
  const investment = base.investments.find((i) => i.id === row.investmentId);
  if (investment === undefined)
    throw new Error(`underwriting case ${row.id} names no investment of the dataset`);
  return underwritingComparison(
    calcCaseOf(row),
    underwritingInputsOf(base, investment),
    tolerances,
  );
}

/** The gross IRR a MOIC stands for over a holding period: MOIC^(365 / days) - 1, to four places. */
export function irrOfMoic(grossMoic: number, from: string, to: string): string {
  return fixed(Math.pow(grossMoic, 365 / daysBetween(from, to)) - 1, 4);
}

/** A position that can carry a base case: its approved entry snapshot has EBITDA and equity value above zero. */
interface Host {
  investment: Investment;
  snapshot: Quarter;
  /** Approved quarters on or before the day the company's figures stop counting, oldest first. */
  quarters: Quarter[];
  current: Quarter | null;
  walled: boolean;
  /** The position's own draws, in a fixed order, so no other position and no scenario moves them. */
  draws: Draws;
}

interface Draws {
  caseId: string;
  years: number;
  multipleShift: number;
  growth: number[];
  marginStep: number[];
  paydown: number[];
  pointIds: string[];
  /** A second version of the same position (a correction, a re-underwriting). */
  second: { caseId: string; years: number; multipleShift: number; pointIds: string[] };
}

function drawsOf(seed: number, index: number): Draws {
  const rng = new Rng(((seed ^ UNDERWRITING_STREAM) + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const list = <T>(draw: () => T): T[] => Array.from({ length: MAX_PLAN_YEARS + 1 }, draw);
  return {
    caseId: rng.uuid(),
    years: rng.int(UNDERWRITING_PLAN_YEARS.min, UNDERWRITING_PLAN_YEARS.max),
    multipleShift: Number(rng.decimal(-1, 1, 2)),
    growth: list(() => Number(rng.decimal(0.04, 0.12, 4))),
    marginStep: list(() => Number(rng.decimal(0, 0.015, 4))),
    paydown: list(() => Number(rng.decimal(0.04, 0.1, 4))),
    pointIds: list(() => rng.uuid()),
    second: {
      caseId: rng.uuid(),
      years: rng.int(3, 5),
      multipleShift: Number(rng.decimal(-0.5, 0.5, 2)),
      pointIds: list(() => rng.uuid()),
    },
  };
}

/** How a plan departs from the ordinary one. */
interface PlanShape {
  years: number;
  /** A fixed EBITDA growth a year at the entry margin, in place of the drawn growth and margin. */
  ebitdaGrowth?: number;
  /** Net debt at each year as a share of the entry net debt, in place of the drawn paydown. */
  netDebtShare?: (year: number) => number;
}

interface Plan {
  points: UnderwritingPointRow[];
  exitEbitda: number;
  exitNetDebt: number;
}

/**
 * The plan from a starting quarter: its own figures at year 0, then one point on each anniversary.
 * Ordinary: revenue up by the year's drawn growth, the margin up by its drawn step, net debt down
 * by its drawn paydown.
 */
function planFrom(start: Quarter, draws: Draws, ids: readonly string[], shape: PlanShape): Plan {
  const revenue0 = Number(start.revenueLtm ?? '0');
  const ebitda0 = Number(start.ebitdaLtm ?? '0');
  const netDebt0 = Number(start.netDebt ?? '0');
  let revenue = revenue0;
  let margin = revenue0 === 0 ? 0 : ebitda0 / revenue0;
  let ebitda = ebitda0;
  let netDebt = netDebt0;
  const points: UnderwritingPointRow[] = [
    {
      id: ids[0] ?? '',
      periodEnd: start.periodEnd,
      revenueLtm: start.revenueLtm,
      ebitdaLtm: start.ebitdaLtm,
      netDebt: start.netDebt,
    },
  ];
  for (let year = 1; year <= shape.years; year++) {
    if (shape.ebitdaGrowth === undefined) {
      revenue *= 1 + (draws.growth[year] ?? 0.08);
      margin += draws.marginStep[year] ?? 0;
      ebitda = revenue * margin;
    } else {
      revenue = revenue0 * Math.pow(1 + shape.ebitdaGrowth, year);
      ebitda = ebitda0 * Math.pow(1 + shape.ebitdaGrowth, year);
    }
    netDebt =
      shape.netDebtShare === undefined
        ? netDebt * (1 - (draws.paydown[year] ?? 0.07))
        : netDebt0 * shape.netDebtShare(year);
    points.push({
      id: ids[year] ?? '',
      periodEnd: addMonths(start.periodEnd, 12 * year),
      revenueLtm: start.revenueLtm === null ? null : fixed(revenue),
      ebitdaLtm: fixed(ebitda),
      netDebt: start.netDebt === null ? null : fixed(netDebt),
    });
  }
  return { points, exitEbitda: Number(fixed(ebitda)), exitNetDebt: Number(fixed(netDebt)) };
}

/** The smallest number of years, never under the minimum, whose last anniversary falls after a date. */
function yearsPast(start: string, date: string, atLeast: number): number {
  let years = Math.max(atLeast, UNDERWRITING_PLAN_YEARS.min);
  while (years < MAX_PLAN_YEARS && addMonths(start, 12 * years) <= date) years += 1;
  return years;
}

/** An instant on a business date, never after the as-of date: nothing in the dataset has happened later. */
const instantOn = (date: string, asOf: string, time: string): string =>
  `${compareIso(date, asOf) > 0 ? asOf : date}T${time}Z`;

/**
 * The yield a loan is underwritten on, from its terms: the cash coupon, the PIK coupon and the
 * original issue discount spread over the years from our entry to maturity, to four places.
 */
export function underwrittenYieldOf(
  terms: Pick<CreditTerms, 'cashCoupon' | 'pikCoupon' | 'oid'>,
  years: number,
): number {
  return Number(
    fixed(Number(terms.cashCoupon) + Number(terms.pikCoupon) + Number(terms.oid) / years, 4),
  );
}

/**
 * Builds the base cases of the equity and continuation vehicle positions and of the loans, and
 * tags the scenario positions. A scenario that no position of the dataset can carry is left out,
 * and the dataset check reports it missing: a small profile under an unusual seed is short of
 * positions, and the generator never bends a scenario to fit one.
 */
export function generateUnderwriting(
  base: UnderwritingBase,
  deps: UnderwritingDeps,
): UnderwritingCaseRow[] {
  const { asOf } = base;
  const userBy = (externalId: string): string | null =>
    base.users.find((u) => u.externalId === externalId)?.id ?? null;
  const dealOne = userBy('deal.one');
  const dealTwo = userBy('deal.two');
  if (dealOne === null || dealTwo === null) return [];
  const roleOf = new Map(base.users.map((u) => [u.id, u.roles]));
  const wallOf = (investmentId: string) =>
    base.walls.find((w) =>
      w.records.some((r) => r.entity === 'investment' && r.entityId === investmentId),
    );

  // ---- The positions that can carry a case ---------------------------------------------------
  const hosts: Host[] = [];
  base.investments.forEach((investment, index) => {
    if (!QUARTERLY_REPORTING_DEAL_TYPES.includes(investment.dealType)) return;
    const rows = base.quarterlyPerformance.filter((q) => q.investmentId === investment.id);
    const snapshot = rows.find((q) => q.isEntrySnapshot && approved(q));
    if (
      snapshot === undefined ||
      snapshot.ebitdaLtm === null ||
      snapshot.ev === null ||
      snapshot.netDebt === null ||
      Number(snapshot.ebitdaLtm) <= 0 ||
      Number(snapshot.ev) - Number(snapshot.netDebt) <= 0
    )
      return;
    const cutoff = cutoffOf(investment, asOf);
    const quarters = rows
      .filter((q) => !q.isEntrySnapshot && approved(q) && q.periodEnd <= cutoff)
      .sort((a, b) => compareIso(a.periodEnd, b.periodEnd));
    hosts.push({
      investment,
      snapshot,
      quarters,
      current: quarters[quarters.length - 1] ?? null,
      walled: wallOf(investment.id) !== undefined,
      draws: drawsOf(deps.seed, index),
    });
  });

  const existing = new Set(
    UNDERWRITING_EXISTING_SCENARIOS.flatMap((scenario) => base.scenarios[scenario] ?? []),
  );
  const entryEquity = (host: Host): number =>
    Number(host.snapshot.ev ?? '0') - Number(host.snapshot.netDebt ?? '0');
  const entryMultiple = (host: Host): number =>
    Number(host.snapshot.ev ?? '0') / Number(host.snapshot.ebitdaLtm ?? '1');

  /**
   * The two people of a case: one deal team member enters it and another confirms it. Only
   * people inside the wall can have recorded and confirmed a walled position's case.
   */
  const twoPeople = (investmentId: string): { enteredBy: string; confirmedBy: string } | null => {
    const wall = wallOf(investmentId);
    if (wall === undefined) return { enteredBy: dealOne, confirmedBy: dealTwo };
    const inside = wall.memberUserIds;
    const author = inside.find((id) => roleOf.get(id)?.includes('deal_team') === true);
    const second = inside.find(
      (id) =>
        id !== author &&
        (roleOf.get(id) ?? []).some((role) => role === 'deal_team' || role === 'approver'),
    );
    return author === undefined || second === undefined
      ? null
      : { enteredBy: author, confirmedBy: second };
  };

  /** A Confirmed version 1 dated at our entry, entered by one deal team member and confirmed by another. */
  const entryCase = (host: Host, shape: PlanShape): UnderwritingCaseRow | null => {
    const { investment, draws } = host;
    const people = twoPeople(investment.id);
    if (people === null) return null;
    const { enteredBy, confirmedBy } = people;
    const plan = planFrom(host.snapshot, draws, draws.pointIds, shape);
    const plannedExitDate = plan.points[plan.points.length - 1]?.periodEnd ?? '';
    if (compareIso(plannedExitDate, investment.entryDate) <= 0) return null;
    const exitMultiple = Number(fixed(entryMultiple(host) + draws.multipleShift));
    const grossMoic = Number(
      fixed((exitMultiple * plan.exitEbitda - plan.exitNetDebt) / entryEquity(host), 4),
    );
    if (!(exitMultiple > 0) || !(grossMoic > 0)) return null;
    return {
      id: draws.caseId,
      investmentId: investment.id,
      version: 1,
      form: 'equity',
      state: 'Confirmed',
      caseDate: investment.entryDate,
      plannedExitDate,
      exitMultiple: fixed(exitMultiple),
      grossMoic: fixed(grossMoic, 4),
      grossIrr: irrOfMoic(grossMoic, investment.entryDate, plannedExitDate),
      underwrittenYield: null,
      annualLossRate: null,
      note: null,
      revisionReason: null,
      withdrawnReason: null,
      sourceNote: SOURCE_NOTE,
      enteredBy,
      enteredAt: instantOn(addDays(investment.entryDate, 7), asOf, '10:00:00'),
      confirmedBy,
      confirmedAt: instantOn(addDays(investment.entryDate, 9), asOf, '15:00:00'),
      points: plan.points,
    };
  };

  // ---- The ordinary cases: four positions in five, and always the four existing scenarios ----
  const cases = new Map<string, UnderwritingCaseRow[]>();
  hosts.forEach((host, position) => {
    const forced = existing.has(host.investment.id);
    if (!forced && position % UNDERWRITING_NONE_EVERY === UNDERWRITING_NONE_EVERY - 1) return;
    const row = entryCase(host, { years: host.draws.years });
    if (row !== null) cases.set(host.investment.id, [row]);
  });

  // ---- The scenarios -------------------------------------------------------------------------
  const used = new Set<string>();
  /** Positions a scenario may reshape: with an ordinary case, outside every wall, held ones first. */
  const free = (): Host[] =>
    hosts
      .filter(
        (h) =>
          cases.has(h.investment.id) &&
          !used.has(h.investment.id) &&
          !existing.has(h.investment.id) &&
          !h.walled,
      )
      .sort((a, b) => Number(b.investment.isActive) - Number(a.investment.isActive));
  const take = (scenario: UnderwritingScenario, host: Host, rows: UnderwritingCaseRow[]): void => {
    used.add(host.investment.id);
    cases.set(host.investment.id, rows);
    deps.tag(scenario, host.investment.id);
  };
  const ordinary = (host: Host): UnderwritingCaseRow | undefined =>
    cases.get(host.investment.id)?.[0];
  const heldDays = (host: Host): number =>
    host.current === null ? 0 : daysBetween(host.snapshot.periodEnd, host.current.periodEnd);
  const inside = (host: Host): host is Host & { current: Quarter } =>
    host.investment.isActive &&
    host.current !== null &&
    compareIso(host.snapshot.periodEnd, host.current.periodEnd) <= 0;

  // underwriting_past_exit: a held position whose plan has ended.
  {
    const ended = (h: Host, years: number): boolean =>
      h.current !== null &&
      compareIso(addMonths(h.snapshot.periodEnd, 12 * years), h.current.periodEnd) < 0;
    const pool = free().filter((h) => h.investment.isActive);
    const natural = pool.find((h) => ended(h, h.draws.years));
    const shortened = pool.find((h) => ended(h, UNDERWRITING_PLAN_YEARS.min));
    const host = natural ?? shortened;
    const row =
      host === undefined
        ? null
        : natural !== undefined
          ? (ordinary(host) ?? null)
          : entryCase(host, { years: UNDERWRITING_PLAN_YEARS.min });
    if (host !== undefined && row !== null) take('underwriting_past_exit', host, [row]);
  }

  // underwriting_ahead, underwriting_on_plan, underwriting_behind: the plan's EBITDA grows at the
  // position's own annualised rate less, at or plus the shift, at the entry margin, and the
  // underwritten IRR is its gross IRR less, at or plus the shift. Each takes the position it
  // suits best: the strongest performer is the one ahead of a plausible plan.
  {
    interface Candidate {
      host: Host & { current: Quarter };
      growth: number;
      irr: number;
    }
    const candidates = (): Candidate[] =>
      free().flatMap((host) => {
        if (!inside(host) || heldDays(host) < UNDERWRITING_MIN_HELD_DAYS) return [];
        const ebitda = Number(host.current.ebitdaLtm ?? '0');
        if (ebitda <= 0) return [];
        const inputs = underwritingInputsOf(base, host.investment);
        if (inputs.grossIrr === null || inputs.irrFlag !== null) return [];
        const growth =
          Math.pow(ebitda / Number(host.snapshot.ebitdaLtm ?? '1'), 365 / heldDays(host)) - 1;
        return [{ host, growth, irr: Number(toDecimalString(D(inputs.grossIrr))) }];
      });
    const build = (c: Candidate, sign: -1 | 0 | 1): UnderwritingCaseRow | null => {
      const years = yearsPast(c.host.snapshot.periodEnd, asOf, c.host.draws.years);
      const row = entryCase(c.host, {
        years,
        ebitdaGrowth: c.growth + sign * UNDERWRITING_GROWTH_SHIFT,
      });
      if (row === null) return null;
      const grossIrr = Number(fixed(c.irr + sign * UNDERWRITING_IRR_SHIFT, 4));
      if (grossIrr <= -0.9) return null;
      const grossMoic = Math.pow(
        1 + grossIrr,
        daysBetween(c.host.investment.entryDate, row.plannedExitDate) / 365,
      );
      return { ...row, grossIrr: fixed(grossIrr, 4), grossMoic: fixed(grossMoic, 4) };
    };
    const place = (scenario: UnderwritingScenario, sign: -1 | 0 | 1): void => {
      // How plausible the plan is for a base case: its growth and its underwritten IRR, each
      // wanted at or above a floor; the weaker of the two decides.
      const fit = (c: Candidate): number =>
        Math.min(
          c.growth + sign * UNDERWRITING_GROWTH_SHIFT,
          c.irr + sign * UNDERWRITING_IRR_SHIFT - UNDERWRITING_IRR_SHIFT,
        );
      const ranked = candidates().sort((a, b) => fit(b) - fit(a));
      for (const candidate of ranked) {
        const row = build(candidate, sign);
        if (row === null) continue;
        take(scenario, candidate.host, [row]);
        return;
      }
    };
    place('underwriting_ahead', -1);
    place('underwriting_on_plan', 0);
    place('underwriting_behind', 1);
  }

  // underwriting_net_cash: the plan pays the debt off inside two years and holds net cash after.
  {
    const host = free().find((h) => inside(h) && heldDays(h) >= UNDERWRITING_MIN_HELD_DAYS);
    const row =
      host === undefined
        ? null
        : entryCase(host, {
            years: yearsPast(host.snapshot.periodEnd, asOf, host.draws.years),
            netDebtShare: (year) => (year === 1 ? 0.45 : -0.1 - 0.12 * (year - 2)),
          });
    if (host !== undefined && row !== null) take('underwriting_net_cash', host, [row]);
  }

  // underwriting_gap: the sponsor gave no net debt at one plan date beside the current quarter.
  {
    const host = free().find(inside);
    const row =
      host === undefined
        ? null
        : entryCase(host, { years: yearsPast(host.snapshot.periodEnd, asOf, host.draws.years) });
    if (host !== undefined && row !== null && host.current !== null) {
      const quarter = host.current.periodEnd;
      const after = row.points.findIndex((p) => compareIso(p.periodEnd, quarter) >= 0);
      // A point between the first and the last, so the entry figures and the exit stay whole.
      const at = after >= 1 && after < row.points.length - 1 ? after : after - 1;
      if (at >= 1 && at < row.points.length - 1) {
        const points = row.points.map((p, i) => (i === at ? { ...p, netDebt: null } : p));
        take('underwriting_gap', host, [{ ...row, points }]);
      }
    }
  }

  // underwriting_reunderwritten: a second Confirmed case dated a year before the latest quarter,
  // starting from that quarter's own figures. Both stay Confirmed.
  {
    const startOf = (h: Host): Quarter | undefined => {
      const q = h.quarters[h.quarters.length - 5];
      const first = ordinary(h);
      return q !== undefined &&
        first !== undefined &&
        Number(q.ebitdaLtm ?? '0') > 0 &&
        q.netDebt !== null &&
        compareIso(q.periodEnd, addMonths(h.investment.entryDate, 12)) > 0
        ? q
        : undefined;
    };
    const host = free().find((h) => startOf(h) !== undefined);
    const first = host === undefined ? undefined : ordinary(host);
    const start = host === undefined ? undefined : startOf(host);
    if (host !== undefined && first !== undefined && start !== undefined) {
      const { second } = host.draws;
      const plan = planFrom(start, host.draws, second.pointIds, { years: second.years });
      const plannedExitDate = plan.points[plan.points.length - 1]?.periodEnd ?? '';
      const exitMultiple = Number(fixed(Number(first.exitMultiple ?? '0') + second.multipleShift));
      const grossMoic = Number(
        fixed((exitMultiple * plan.exitEbitda - plan.exitNetDebt) / entryEquity(host), 4),
      );
      if (exitMultiple > 0 && grossMoic > 0)
        take('underwriting_reunderwritten', host, [
          first,
          {
            ...first,
            id: second.caseId,
            version: 2,
            caseDate: start.periodEnd,
            plannedExitDate,
            exitMultiple: fixed(exitMultiple),
            grossMoic: fixed(grossMoic, 4),
            grossIrr: irrOfMoic(grossMoic, host.investment.entryDate, plannedExitDate),
            revisionReason:
              'Re-underwritten by the sponsor a year ago: a new plan from that quarter and a new exit',
            sourceNote: 'Sponsor revised base case model, held in the deal folder',
            enteredAt: instantOn(addDays(start.periodEnd, 50), asOf, '10:00:00'),
            confirmedAt: instantOn(addDays(start.periodEnd, 52), asOf, '15:00:00'),
            points: plan.points,
          },
        ]);
    }
  }

  // underwriting_corrected: version 1 carried a mistyped exit multiple; version 2, dated as it
  // is, corrects it and supersedes it. The second person each time is the other deal team member.
  {
    const host = free()[0];
    const right = host === undefined ? undefined : ordinary(host);
    if (host !== undefined && right !== undefined) {
      const wrong = fixed(Number(right.exitMultiple ?? '0') + 3);
      const entered = addDays(host.investment.entryDate, 30);
      take('underwriting_corrected', host, [
        { ...right, state: 'Superseded', exitMultiple: wrong },
        {
          ...right,
          id: host.draws.second.caseId,
          version: 2,
          revisionReason: `The exit multiple was entered as ${wrong}; the sponsor model shows ${right.exitMultiple ?? ''}`,
          enteredBy: right.confirmedBy ?? dealTwo,
          enteredAt: instantOn(entered, asOf, '10:00:00'),
          confirmedBy: right.enteredBy,
          confirmedAt: instantOn(addDays(entered, 1), asOf, '15:00:00'),
          points: right.points.map((p, i) => ({ ...p, id: host.draws.second.pointIds[i] ?? '' })),
        },
      ]);
    }
  }

  // underwriting_draft: entered last week and waiting for a second person.
  {
    const host = free()[0];
    const row = host === undefined ? undefined : ordinary(host);
    if (host !== undefined && row !== undefined)
      take('underwriting_draft', host, [
        {
          ...row,
          state: 'Draft',
          enteredAt: instantOn(addDays(asOf, -6), asOf, '10:00:00'),
          confirmedBy: null,
          confirmedAt: null,
        },
      ]);
  }

  // underwriting_withdrawn: confirmed, then retired by an approver; nothing is in force.
  {
    const host = free()[0];
    const row = host === undefined ? undefined : ordinary(host);
    if (host !== undefined && row !== undefined)
      take('underwriting_withdrawn', host, [
        {
          ...row,
          state: 'Withdrawn',
          withdrawnReason: 'Confirmed against the model of another company; to be entered again',
        },
      ]);
  }

  // ---- Private credit: every loan carries the case it was underwritten on -------------------
  // Version 1, Confirmed, dated at our entry: the yield its terms stand for, an expected loss a
  // year drawn from the loan's own stream, the IRR the two leave and the MOIC that IRR pays by
  // maturity, which is the expected repayment. A loan has no plan points and no exit multiple.
  const loans: UnderwritingCaseRow[] = [];
  base.investments.forEach((investment, index) => {
    if (investment.dealType !== UNDERWRITING_CREDIT_DEAL_TYPE) return;
    const terms = base.creditTerms.find((t) => t.investmentId === investment.id);
    const people = twoPeople(investment.id);
    if (terms === undefined || people === null) return;
    if (compareIso(terms.maturityDate, investment.entryDate) <= 0) return;
    const rng = new Rng(
      ((deps.seed ^ UNDERWRITING_CREDIT_STREAM) + Math.imul(index + 1, 0x9e3779b1)) >>> 0,
    );
    const id = rng.uuid();
    const lossRate = Number(rng.decimal(UNDERWRITING_LOSS_RATE.min, UNDERWRITING_LOSS_RATE.max, 4));
    const years = daysBetween(investment.entryDate, terms.maturityDate) / 365;
    const underwrittenYield = underwrittenYieldOf(terms, years);
    const grossIrr = Number(fixed(underwrittenYield - lossRate, 4));
    const grossMoic = Number(fixed(1 + grossIrr * years, 4));
    if (!(grossMoic > 0) || grossIrr <= -1 || underwrittenYield <= -1) return;
    loans.push({
      id,
      investmentId: investment.id,
      version: 1,
      form: 'credit',
      state: 'Confirmed',
      caseDate: investment.entryDate,
      plannedExitDate: terms.maturityDate,
      exitMultiple: null,
      grossMoic: fixed(grossMoic, 4),
      grossIrr: fixed(grossIrr, 4),
      underwrittenYield: fixed(underwrittenYield, 4),
      annualLossRate: fixed(lossRate, 4),
      note: null,
      revisionReason: null,
      withdrawnReason: null,
      sourceNote: LOAN_SOURCE_NOTE,
      enteredBy: people.enteredBy,
      enteredAt: instantOn(addDays(investment.entryDate, 7), asOf, '10:00:00'),
      confirmedBy: people.confirmedBy,
      confirmedAt: instantOn(addDays(investment.entryDate, 9), asOf, '15:00:00'),
      points: [],
    });
  });

  return [...hosts.flatMap((host) => cases.get(host.investment.id) ?? []), ...loans];
}
