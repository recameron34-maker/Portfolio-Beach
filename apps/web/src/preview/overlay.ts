import definitions from '../../../../config/definitions.json';
import {
  ebitdaMargin,
  evToEbitda,
  growthSinceEntry,
  latestPeriod,
  multipleDelta,
  netDebtToEbitda,
  sameQuarterPriorYear,
  toDecimalString,
  yoyGrowth,
} from '@pb/calc';
import type { Decimal } from '@pb/calc';
import {
  capitalNoticeDetail,
  capitalNoticePage,
  dataHealth,
  featureFlagList,
  investmentDetail,
  investmentPerformance,
  valuationPage,
} from '@pb/contracts';
import type {
  CapitalNoticeDetail,
  CapitalNoticePage,
  DataHealth,
  InvestmentDetail,
  InvestmentPerformance,
  QuarterRow,
  ValuationPage,
} from '@pb/contracts';
import type { z } from 'zod';
import type { Recordings } from './fixtures.js';
import { QUARTERLY_FIGURE_KEYS } from './state.js';
import type {
  PreviewState,
  SimException,
  SimNotice,
  SimPromotedQuarter,
  SimValuation,
} from './state.js';

/**
 * Read overlays: recorded GET bodies with this session's simulated changes laid over them, so lists
 * and the one-pager show what the simulated workflow did. Each overlay is a pure function that
 * returns its input unchanged when nothing applies. Records are added to a list only when the
 * credential's own recorded investment detail answered 200, so a wall still hides what it hid.
 * Figures stay as recorded: nothing here recomputes NAV, MOIC or IRR.
 */

type FeatureFlagList = z.infer<typeof featureFlagList>;

export interface ValuationFilters {
  investmentId?: string;
  periodEnd?: string;
  state?: string;
  vehicleId?: string;
}

/** Every filter the record satisfies; a vehicle filter needs the record's vehicle to be known. */
function matchesAll(sim: SimValuation, filters: ValuationFilters): boolean {
  return (
    (filters.investmentId === undefined || sim.row.investmentId === filters.investmentId) &&
    (filters.periodEnd === undefined || sim.row.periodEnd === filters.periodEnd) &&
    (filters.state === undefined || sim.row.state === filters.state) &&
    (filters.vehicleId === undefined || sim.vehicleId === filters.vehicleId)
  );
}

export function overlayValuationPage(
  page: ValuationPage,
  sims: Iterable<SimValuation>,
  filters: ValuationFilters,
  canSee: (investmentId: string) => boolean,
): ValuationPage {
  const touched = new Map<string, SimValuation>();
  for (const sim of sims) if (sim.changed) touched.set(sim.row.id, sim);
  if (touched.size === 0) return page;
  let changed = false;
  const present = new Set<string>();
  const items: ValuationPage['items'] = [];
  for (const item of page.items) {
    present.add(item.id);
    const sim = touched.get(item.id);
    if (sim === undefined) {
      items.push(item);
      continue;
    }
    changed = true;
    // Only the state can move a listed record out of the filter; the rest never changes.
    if (filters.state === undefined || sim.row.state === filters.state) items.push(sim.row);
  }
  const added: ValuationPage['items'] = [];
  for (const sim of touched.values()) {
    if (present.has(sim.row.id) || !matchesAll(sim, filters) || !canSee(sim.row.investmentId))
      continue;
    added.push(sim.row);
  }
  if (!changed && added.length === 0) return page;
  const periods = [...new Set([...page.periods, ...added.map((r) => r.quarterEnd)])].sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
  return { ...page, items: [...added, ...items], periods };
}

/** The one-pager's version list, keyed by period end and version, in the API's order. */
export function overlayInvestmentDetail(
  detail: InvestmentDetail,
  sims: Iterable<SimValuation>,
): InvestmentDetail {
  const entries = new Map<string, InvestmentDetail['valuations'][number]>();
  for (const v of detail.valuations) entries.set(`${v.periodEnd}#${v.version}`, v);
  let changed = false;
  for (const sim of sims) {
    if (!sim.changed || sim.row.investmentId !== detail.id) continue;
    const { periodEnd, version, state, fairValue, method } = sim.row;
    entries.set(`${periodEnd}#${version}`, { periodEnd, version, state, fairValue, method });
    changed = true;
  }
  if (!changed) return detail;
  const valuations = [...entries.values()].sort((a, b) =>
    a.periodEnd === b.periodEnd ? a.version - b.version : a.periodEnd < b.periodEnd ? -1 : 1,
  );
  return { ...detail, valuations };
}

export function overlayCapitalNoticePage(
  page: CapitalNoticePage,
  sims: Iterable<SimNotice>,
  filters: { state?: string },
): CapitalNoticePage {
  const touched = new Map<string, SimNotice>();
  for (const sim of sims) if (sim.changed) touched.set(sim.row.id, sim);
  if (touched.size === 0) return page;
  let changed = false;
  const replace = (
    rows: CapitalNoticePage['items'],
    keep: (sim: SimNotice) => boolean,
  ): CapitalNoticePage['items'] =>
    rows.flatMap((row) => {
      const sim = touched.get(row.id);
      if (sim === undefined) return [row];
      changed = true;
      return keep(sim) ? [sim.row] : [];
    });
  const items = replace(
    page.items,
    (sim) => filters.state === undefined || sim.row.state === filters.state,
  );
  const attention = replace(page.attention, () => true);
  return changed ? { ...page, items, attention } : page;
}

export function overlayCapitalNoticeDetail(
  detail: CapitalNoticeDetail,
  sim: SimNotice | undefined,
): CapitalNoticeDetail {
  if (sim?.changed !== true) return detail;
  return { ...detail, state: sim.row.state, rowVersion: sim.row.rowVersion };
}

export function overlayFlags(
  list: FeatureFlagList,
  overrides: ReadonlyMap<string, boolean>,
): FeatureFlagList {
  if (!list.flags.some((f) => overrides.has(f.key))) return list;
  return {
    flags: list.flags.map((f) => {
      const enabled = overrides.get(f.key);
      return enabled === undefined ? f : { ...f, enabled };
    }),
  };
}

/**
 * Data Health's open exception count, as the API counts it (apps/api/src/data/data.controller.ts):
 * every exception in open or acknowledged, whoever may see it, so the simulated intakes' exceptions
 * add to the recorded count until they are resolved or closed.
 */
export function overlayDataHealth(health: DataHealth, sims: Iterable<SimException>): DataHealth {
  let open = 0;
  for (const sim of sims) if (sim.state === 'open' || sim.state === 'acknowledged') open += 1;
  return open === 0 ? health : { ...health, openExceptions: health.openExceptions + open };
}

/* ---- The Performance tab: the quarters an approved extraction run promoted ---- */

const str = toDecimalString;
const APPROVED_STATUS = 'record_status.approved';
const isApproved = (status: string): boolean =>
  status.slice(status.indexOf('.') + 1) === 'approved';

/** A quarter the record lacked, before the promoted figures are laid over it. */
function blankQuarter(periodEnd: string): QuarterRow {
  return {
    periodEnd,
    isEntrySnapshot: false,
    status: APPROVED_STATUS,
    revenueLtm: null,
    ebitdaLtm: null,
    ev: null,
    netDebt: null,
    cash: null,
    totalEquity: null,
    evToEbitda: null,
    netDebtToEbitda: null,
    ebitdaMargin: null,
    revenueYoy: null,
    ebitdaYoy: null,
    highlights: [],
    source: null,
  };
}

const evMultiple = (row: Pick<QuarterRow, 'ev' | 'ebitdaLtm'>): Decimal | null =>
  row.ev === null ? null : evToEbitda(row.ev, row.ebitdaLtm);
const leverage = (row: Pick<QuarterRow, 'netDebt' | 'ebitdaLtm'>): Decimal | null =>
  row.netDebt === null ? null : netDebtToEbitda(row.netDebt, row.ebitdaLtm);

/** The quarter's own ratios from its figures, as apps/api/src/performance/performance.service.ts derives them. */
function withRatios(row: QuarterRow, prior: QuarterRow | null): QuarterRow {
  return {
    ...row,
    evToEbitda: str(evMultiple(row)),
    netDebtToEbitda: str(leverage(row)),
    ebitdaMargin: row.ebitdaLtm === null ? null : str(ebitdaMargin(row.ebitdaLtm, row.revenueLtm)),
    revenueYoy: str(yoyGrowth(row.revenueLtm, prior?.revenueLtm ?? null)),
    ebitdaYoy: str(yoyGrowth(row.ebitdaLtm, prior?.ebitdaLtm ?? null)),
  };
}

/** The rows with the status word packages/calc reads ('approved'), for the latest-period rule. */
const withCalcStatus = (rows: readonly QuarterRow[]): QuarterRow[] =>
  rows.map((r) => (isApproved(r.status) ? { ...r, status: 'approved' } : r));

/**
 * The recorded performance with the promoted quarters laid over it: a promoted quarter replaces
 * the recorded quarter of its period end (the figures written in dollars, the status approved,
 * the source lineage, the narrative when accepted; every other column stays as recorded) or is
 * added when the record lacked it. The ratios of the promoted quarters, the year-on-year columns
 * and the since-entry block are derived again with the same @pb/calc functions the API uses, so
 * no ratio is left standing next to a figure it no longer describes (rule 10). Nothing else is
 * recomputed; a performance answer with no promoted quarter is returned as it is.
 */
export function overlayInvestmentPerformance(
  perf: InvestmentPerformance,
  promoted: Iterable<SimPromotedQuarter>,
  toleranceDays: number,
): InvestmentPerformance {
  const own = [...promoted].filter((q) => q.investmentId === perf.investmentId);
  if (own.length === 0) return perf;
  const byPeriod = new Map(perf.quarters.map((q) => [q.periodEnd, q]));
  for (const q of own) {
    const base = byPeriod.get(q.periodEnd) ?? blankQuarter(q.periodEnd);
    const row: QuarterRow = { ...base, status: APPROVED_STATUS, source: { ...q.source } };
    for (const key of QUARTERLY_FIGURE_KEYS) {
      const value = q.figures[key];
      if (value !== undefined) row[key] = value;
    }
    if (q.highlights !== undefined) row.highlights = [...q.highlights];
    byPeriod.set(q.periodEnd, row);
  }
  const ordered = [...byPeriod.values()].sort((a, b) =>
    a.periodEnd < b.periodEnd ? -1 : a.periodEnd > b.periodEnd ? 1 : 0,
  );
  const approved = ordered.filter((r) => isApproved(r.status));
  const promotedPeriods = new Set(own.map((q) => q.periodEnd));
  const quarters = ordered.map((row) =>
    withRatios(row, sameQuarterPriorYear(approved, row.periodEnd, { toleranceDays })),
  );
  // Only a promoted quarter's own ratios and every year-on-year column are derived again; an
  // untouched quarter keeps the ratios the API answered.
  const quartersKept = quarters.map((row, i) => {
    const recorded = ordered[i];
    if (recorded === undefined || promotedPeriods.has(row.periodEnd)) return row;
    return {
      ...row,
      evToEbitda: recorded.evToEbitda,
      netDebtToEbitda: recorded.netDebtToEbitda,
      ebitdaMargin: recorded.ebitdaMargin,
    };
  });
  const entry = perf.entry;
  let sinceEntry = perf.sinceEntry;
  if (entry !== null && entry.periodEnd <= perf.asOf) {
    const latest = latestPeriod(withCalcStatus(quartersKept), perf.asOf);
    sinceEntry =
      latest === null
        ? null
        : {
            periodEnd: latest.periodEnd,
            revenueGrowth: str(growthSinceEntry(latest.revenueLtm, entry.revenueLtm)),
            ebitdaGrowth: str(growthSinceEntry(latest.ebitdaLtm, entry.ebitdaLtm)),
            multipleDelta: str(multipleDelta(evMultiple(latest), evMultiple(entry))),
            evToEbitdaAtEntry: str(evMultiple(entry)),
            netDebtToEbitdaAtEntry: str(leverage(entry)),
          };
  }
  return { ...perf, quarters: quartersKept, sinceEntry };
}

/** `definitions.priorYearPeriodEndToleranceDays`, the tolerance the prior-year match reads. */
function priorYearTolerance(): number {
  const value: unknown = (definitions as Record<string, unknown>).priorYearPeriodEndToleranceDays;
  return typeof value === 'number' && Number.isInteger(value) ? value : 7;
}

/** Context the overlays read: the credential's own recordings decide what it may see. */
export interface OverlayContext {
  credential: string;
  recordings: Recordings;
  state: PreviewState;
}

const INVESTMENT = /^\/api\/v1\/investments\/([^/]+)$/;
const PERFORMANCE = /^\/api\/v1\/investments\/([^/]+)\/performance$/;
const NOTICE = /^\/api\/v1\/capital-notices\/([^/]+)$/;

function param(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null || value === '' ? undefined : value;
}

/**
 * Applies the overlay for a recorded 200 GET body, if any. Returns the recorded text untouched
 * when no overlay applies, nothing changed, or the body does not match its contract.
 */
export function overlayRecordedBody(url: URL, text: string, ctx: OverlayContext): string {
  const { state } = ctx;
  const path = url.pathname;
  const parse = <T>(schema: z.ZodType<T>): T | undefined => {
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };
  const write = <T>(before: T | undefined, after: (value: T) => T): string => {
    if (before === undefined) return text;
    const next = after(before);
    return next === before ? text : JSON.stringify(next);
  };
  const canSee = (investmentId: string): boolean =>
    ctx.recordings.status(ctx.credential, `/api/v1/investments/${investmentId}`) === 200;

  if (path === '/api/v1/flags' && state.flags.size > 0)
    return write(parse(featureFlagList), (list) => overlayFlags(list, state.flags));

  if (path === '/api/v1/data-health' && state.exceptions.size > 0)
    return write(parse(dataHealth), (health) =>
      overlayDataHealth(health, state.exceptions.values()),
    );

  if (state.promotedQuarters.size > 0 && PERFORMANCE.test(path))
    return write(parse(investmentPerformance), (perf) =>
      overlayInvestmentPerformance(perf, state.promotedQuarters.values(), priorYearTolerance()),
    );

  if (state.valuations !== null) {
    const sims = state.valuations;
    if (path === '/api/v1/valuations') {
      const filters: ValuationFilters = {};
      for (const name of ['investmentId', 'periodEnd', 'state', 'vehicleId'] as const) {
        const value = param(url, name);
        if (value !== undefined) filters[name] = value;
      }
      return write(parse(valuationPage), (page) =>
        overlayValuationPage(page, sims.values(), filters, canSee),
      );
    }
    if (INVESTMENT.test(path))
      return write(parse(investmentDetail), (detail) =>
        overlayInvestmentDetail(detail, sims.values()),
      );
  }

  if (state.notices !== null) {
    const notices = state.notices;
    if (path === '/api/v1/capital-notices') {
      const noticeState = param(url, 'state');
      return write(parse(capitalNoticePage), (page) =>
        overlayCapitalNoticePage(
          page,
          notices.values(),
          noticeState === undefined ? {} : { state: noticeState },
        ),
      );
    }
    const match = NOTICE.exec(path);
    if (match !== null) {
      const sim = notices.get(decodeURIComponent(match[1] ?? ''));
      return write(parse(capitalNoticeDetail), (detail) => overlayCapitalNoticeDetail(detail, sim));
    }
  }
  return text;
}
