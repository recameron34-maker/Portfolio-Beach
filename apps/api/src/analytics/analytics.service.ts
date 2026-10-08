import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import {
  CALC_VERSION,
  D,
  ZERO,
  addMonths,
  daysBetween,
  latestPeriod,
  valueChange,
  latestQuarterEndOnOrBefore,
} from '@pb/calc';
import type { Decimal } from '@pb/calc';
import type {
  AnalyticsSummary,
  ExposureBucket,
  InvestmentSummary,
  Watchlist,
  WatchlistItem,
} from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { configDecimal, configError, configInteger } from '../common/definitions.js';
import { DEFINITIONS } from '../common/tokens.js';
import { DbService } from '../db/db.service.js';
import { loadInvestmentsWithMetrics } from '../portfolio/loaders.js';
import type { InvestmentBaseRow } from '../portfolio/loaders.js';
import {
  latestLockedValuation,
  lockedNavSeries,
  operatingView,
  pooledPositionMetrics,
  str,
} from '../portfolio/metrics.js';
import type { FlowRow, OperatingRow, ValuationRow } from '../portfolio/metrics.js';

/** Calculation settings from config/definitions.json (docs/03 section 4); only the keys this service reads. */
interface Definitions {
  priorYearPeriodEndToleranceDays?: number;
  watchlist?: Record<string, number | string>;
  analytics?: { navSeriesQuarters?: number; topPositions?: number };
  [key: string]: unknown;
}

type WatchFlag = WatchlistItem['flags'][number];

/** One visible investment with everything the aggregate views derive from (loaders.ts). */
interface Position {
  row: InvestmentBaseRow;
  summary: InvestmentSummary;
  flows: FlowRow[];
  valuations: ValuationRow[];
}

/** Watchlist thresholds, parsed once per request from config; never hard-coded. */
export interface Thresholds {
  raw: Record<string, number | string>;
  netDebtToEbitdaMax: Decimal;
  ebitdaYoYDeclinePct: Decimal;
  markdownPct: Decimal;
  missingFinancialsDays: number;
  maturityWithinMonths: number;
  priorYearToleranceDays: number;
}

/** The credit side of a position: facility maturity plus the status columns of each performance row. */
export interface CreditInputs {
  maturityDate: string | null;
  rows: {
    periodEnd: string;
    status: string;
    isEntrySnapshot: boolean;
    covenantStatus: string | null;
    paymentStatus: string | null;
  }[];
}

export interface WatchInputs {
  valuations: readonly ValuationRow[];
  operating: readonly OperatingRow[];
  credit: CreditInputs | null;
}

const OUTFLOW_TYPES = new Set(['flow_type.contribution', 'flow_type.fee', 'flow_type.expense']);

/* ---- pure helpers ---- */

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Descending by value with "not calculable" last. */
function compareNavDesc(a: Decimal | null, b: Decimal | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return b.cmp(a);
}

const navOf = (p: Position): Decimal | null => (p.summary.nav === null ? null : D(p.summary.nav));

/** Share of a total as a rate; null when either side is not calculable or the total is zero. */
function navShareOf(nav: Decimal | null, total: Decimal | null): string | null {
  return nav === null || total === null || total.isZero() ? null : str(nav.div(total));
}

/** Sum of the positions' NAV; null when none of them has a calculable NAV. */
function sumNav(positions: readonly Position[]): Decimal | null {
  let total: Decimal | null = null;
  for (const p of positions) {
    const nav = navOf(p);
    if (nav !== null) total = (total ?? ZERO).plus(nav);
  }
  return total;
}

/** The latest Locked valuation strictly before a period end (the previous Locked mark). */
function previousLocked(valuations: readonly ValuationRow[], before: string): ValuationRow | null {
  let best: ValuationRow | null = null;
  for (const v of valuations) {
    if (v.state !== 'Locked' || v.periodEnd >= before) continue;
    if (best === null || v.periodEnd > best.periodEnd) best = v;
  }
  return best;
}

/** A rate as a percentage with one decimal for messages, for example 0.225 to "22.5". */
const pct = (rate: Decimal): string => rate.times(100).toFixed(1);

/** Buckets over the active positions: count, invested and NAV sums, NAV share of the active total. */
function exposures(
  positions: readonly Position[],
  totalNav: Decimal | null,
  keyOf: (p: Position) => { key: string; label: string },
): ExposureBucket[] {
  const groups = new Map<
    string,
    { label: string; count: number; invested: Decimal | null; nav: Decimal | null }
  >();
  for (const p of positions) {
    const { key, label } = keyOf(p);
    const g = groups.get(key) ?? { label, count: 0, invested: null, nav: null };
    g.count += 1;
    if (p.summary.invested !== null) g.invested = (g.invested ?? ZERO).plus(p.summary.invested);
    if (p.summary.nav !== null) g.nav = (g.nav ?? ZERO).plus(p.summary.nav);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => compareNavDesc(a.nav, b.nav) || compareText(a.label, b.label))
    .map(([key, g]) => ({
      key,
      label: g.label,
      count: g.count,
      invested: str(g.invested),
      nav: str(g.nav),
      navShare: navShareOf(g.nav, totalNav),
    }));
}

/**
 * NAV per vehicle split by deal type (the stacked chart on the Exposure tab): the active
 * positions with a Locked mark, grouped by vehicle, each vehicle's segments the deal type buckets
 * of its positions (Decimal sums, shares of the total active NAV). Vehicles by total NAV, largest
 * first, then name; segments follow the order of the deal type buckets so every bar stacks alike.
 */
export function vehicleByDealType(
  active: readonly Position[],
  totalNav: Decimal | null,
  dealTypes: readonly ExposureBucket[],
  dealTypeOf: (p: Position) => { key: string; label: string },
): AnalyticsSummary['exposures']['vehicleByDealType'] {
  const rank = new Map(dealTypes.map((b, i) => [b.key, i]));
  const rankOf = (key: string): number => rank.get(key) ?? dealTypes.length;
  const byVehicle = new Map<string, { label: string; positions: Position[] }>();
  for (const p of active) {
    if (p.summary.nav === null) continue;
    const vehicle = byVehicle.get(p.row.vehicleId) ?? { label: p.row.vehicleName, positions: [] };
    vehicle.positions.push(p);
    byVehicle.set(p.row.vehicleId, vehicle);
  }
  return [...byVehicle.entries()]
    .map(([key, v]) => ({
      key,
      label: v.label,
      nav: sumNav(v.positions),
      segments: exposures(v.positions, totalNav, dealTypeOf).sort(
        (a, b) => rankOf(a.key) - rankOf(b.key) || compareText(a.key, b.key),
      ),
    }))
    .sort((a, b) => compareNavDesc(a.nav, b.nav) || compareText(a.label, b.label))
    .map(({ key, label, segments }) => ({ key, label, segments }));
}

/** Approved investment-level flows by calendar year: absolute sums, net and the running net. */
function flowsByYear(
  positions: readonly Position[],
  asOf: string,
): AnalyticsSummary['flowsByYear'] {
  const years = new Map<string, { contributions: Decimal; distributions: Decimal }>();
  for (const p of positions) {
    for (const f of p.flows) {
      if (f.flowDate > asOf) continue;
      const period = f.flowDate.slice(0, 4);
      const y = years.get(period) ?? { contributions: ZERO, distributions: ZERO };
      const amount = D(f.amount).abs();
      if (OUTFLOW_TYPES.has(f.flowType)) y.contributions = y.contributions.plus(amount);
      else y.distributions = y.distributions.plus(amount);
      years.set(period, y);
    }
  }
  let cumulative = ZERO;
  return [...years.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([period, y]) => {
      const net = y.distributions.minus(y.contributions);
      cumulative = cumulative.plus(net);
      return {
        period,
        contributions: str(y.contributions)!,
        distributions: str(y.distributions)!,
        net: str(net)!,
        cumulativeNet: str(cumulative)!,
      };
    });
}

function topPositions(
  active: readonly Position[],
  totalNav: Decimal | null,
  limit: number,
): AnalyticsSummary['topPositions'] {
  return active
    .map((p) => ({ p, nav: navOf(p) }))
    .sort(
      (a, b) =>
        compareNavDesc(a.nav, b.nav) ||
        compareText(a.p.row.investmentNumber, b.p.row.investmentNumber),
    )
    .slice(0, limit)
    .map(({ p, nav }) => ({
      id: p.row.id,
      investmentNumber: p.row.investmentNumber,
      companyName: p.row.companyName,
      vehicleName: p.row.vehicleName,
      nav: p.summary.nav,
      navShare: navShareOf(nav, totalNav),
      grossMoic: p.summary.grossMoic,
    }));
}

/**
 * Monitoring flags for one active position (docs/04 M9). Every threshold comes from config. A
 * figure that is not calculable never raises a flag on its own; only an explicit data gap does.
 */
export function evaluateFlags(
  input: WatchInputs,
  asOf: string,
  t: Thresholds,
  labels: ReadonlyMap<string, string>,
): WatchFlag[] {
  const flags: WatchFlag[] = [];
  const labelOf = (code: string): string => labels.get(code) ?? code;
  const quarterEnd = latestQuarterEndOnOrBefore(asOf);

  const locked = latestLockedValuation(input.valuations, asOf);
  if (locked === null) {
    flags.push({
      code: 'no_locked_valuation',
      severity: 'bad',
      message: `No Locked valuation on or before ${asOf}`,
      value: null,
      threshold: null,
    });
  } else if (daysBetween(locked.periodEnd, quarterEnd) > t.priorYearToleranceDays) {
    // A sponsor reporting a few days off the calendar quarter end is within tolerance, not stale.
    flags.push({
      code: 'stale_valuation',
      severity: 'watch',
      message: `Latest Locked valuation is for ${locked.periodEnd}; no Locked mark for ${quarterEnd}`,
      value: null,
      threshold: null,
    });
  }

  const operating = operatingView(input.operating, asOf, t.priorYearToleranceDays);
  if (operating !== null) {
    if (operating.priorYearPeriodEnd === null) {
      flags.push({
        code: 'missing_prior_year',
        severity: 'watch',
        message: `No approved quarter one year before ${operating.periodEnd} (within ${t.priorYearToleranceDays} days), so year-on-year growth is not calculable`,
        value: null,
        threshold: String(t.priorYearToleranceDays),
      });
    }
    if (operating.ebitdaLtm !== null && D(operating.ebitdaLtm).lte(0)) {
      flags.push({
        code: 'negative_ebitda',
        severity: 'bad',
        message: `EBITDA LTM of ${D(operating.ebitdaLtm).toFixed(2)} for ${operating.periodEnd} is at or below zero`,
        value: operating.ebitdaLtm,
        threshold: '0',
      });
    }
    if (operating.netDebtToEbitda !== null) {
      const leverage = D(operating.netDebtToEbitda);
      if (leverage.gt(t.netDebtToEbitdaMax)) {
        // Two decimals unless the figure rounds onto the limit, when the message would read as equal.
        const limit = t.netDebtToEbitdaMax.toFixed(2);
        const shown = leverage.toFixed(2) === limit ? leverage.toFixed(4) : leverage.toFixed(2);
        flags.push({
          code: 'leverage_above_max',
          severity: 'bad',
          message: `Net debt to EBITDA of ${shown}x for ${operating.periodEnd} is above the ${limit}x limit`,
          value: operating.netDebtToEbitda,
          threshold: str(t.netDebtToEbitdaMax),
        });
      }
    }
    if (operating.ebitdaYoy !== null) {
      const yoy = D(operating.ebitdaYoy);
      const limit = t.ebitdaYoYDeclinePct.neg();
      if (yoy.lte(limit)) {
        flags.push({
          code: 'ebitda_decline',
          severity: 'watch',
          message: `EBITDA LTM fell ${pct(yoy.neg())}% against the same quarter last year (limit ${pct(t.ebitdaYoYDeclinePct)}%)`,
          value: operating.ebitdaYoy,
          threshold: str(limit),
        });
      }
    }
  }

  if (locked !== null) {
    const previous = previousLocked(input.valuations, locked.periodEnd);
    // A markdown is measured against a positive prior mark, with the one value change rule.
    if (previous !== null && D(previous.fairValue).gt(0)) {
      const change = valueChange(locked.fairValue, previous.fairValue);
      const limit = t.markdownPct.neg();
      if (change?.lt(limit)) {
        flags.push({
          code: 'markdown',
          severity: 'watch',
          message: `Locked fair value for ${locked.periodEnd} is ${pct(change.neg())}% below ${previous.periodEnd} (limit ${pct(t.markdownPct)}%)`,
          value: str(change),
          threshold: str(limit),
        });
      }
    }
  }

  let latestFinancials = operating?.periodEnd ?? null;
  if (input.credit !== null) {
    const latest = latestPeriod(
      input.credit.rows.map((r) => ({ ...r, status: r.status.replace('record_status.', '') })),
      asOf,
    );
    if (latest !== null) {
      if (latestFinancials === null || latest.periodEnd > latestFinancials)
        latestFinancials = latest.periodEnd;
      if (latest.covenantStatus === 'covenant_status.breach') {
        flags.push({
          code: 'covenant_breach',
          severity: 'bad',
          message: `Covenant status is ${labelOf(latest.covenantStatus)} for ${latest.periodEnd}`,
          value: null,
          threshold: null,
        });
      } else if (latest.covenantStatus === 'covenant_status.waiver') {
        flags.push({
          code: 'covenant_waiver',
          severity: 'watch',
          message: `Covenant status is ${labelOf(latest.covenantStatus)} for ${latest.periodEnd}`,
          value: null,
          threshold: null,
        });
      }
      if (latest.paymentStatus !== null && latest.paymentStatus !== 'payment_status.current') {
        flags.push({
          code: 'payment_not_current',
          severity: 'bad',
          message: `Payment status is ${labelOf(latest.paymentStatus)} for ${latest.periodEnd}`,
          value: null,
          threshold: null,
        });
      }
    }
    const maturity = input.credit.maturityDate;
    if (maturity !== null) {
      if (maturity < asOf) {
        flags.push({
          code: 'past_maturity',
          severity: 'bad',
          message: `Facility matured on ${maturity} and the position is still active`,
          value: null,
          threshold: null,
        });
      } else if (maturity <= addMonths(asOf, t.maturityWithinMonths)) {
        flags.push({
          code: 'maturity_within_12_months',
          severity: 'watch',
          message: `Facility matures on ${maturity}, within ${t.maturityWithinMonths} months of ${asOf}`,
          value: null,
          threshold: String(t.maturityWithinMonths),
        });
      }
    }
  }

  // Financials older than the configured gap share the stale code; no separate code is invented.
  if (latestFinancials !== null && !flags.some((f) => f.code === 'stale_valuation')) {
    const days = daysBetween(latestFinancials, asOf);
    if (days > t.missingFinancialsDays) {
      flags.push({
        code: 'stale_valuation',
        severity: 'watch',
        message: `Latest approved financials are for ${latestFinancials}, ${days} days before ${asOf} (limit ${t.missingFinancialsDays} days)`,
        value: String(days),
        threshold: String(t.missingFinancialsDays),
      });
    }
  }
  return flags;
}

const severityRank = (item: WatchlistItem): number =>
  item.flags.some((f) => f.severity === 'bad') ? 0 : 1;

/* ---- batched loaders (row-level security applies through the transaction) ---- */

async function loadLabels(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx
    .select({ code: schema.taxonomyTerm.code, label: schema.taxonomyTerm.label })
    .from(schema.taxonomyTerm);
  return new Map(rows.map((r) => [r.code, r.label]));
}

async function loadOperatingRows(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, OperatingRow[]>> {
  const out = new Map<string, OperatingRow[]>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({
      investmentId: schema.quarterlyPerformance.investmentId,
      periodEnd: schema.quarterlyPerformance.periodEnd,
      status: schema.quarterlyPerformance.status,
      isEntrySnapshot: schema.quarterlyPerformance.isEntrySnapshot,
      revenueLtm: schema.quarterlyPerformance.revenueLtm,
      ebitdaLtm: schema.quarterlyPerformance.ebitdaLtm,
      ev: schema.quarterlyPerformance.ev,
      netDebt: schema.quarterlyPerformance.netDebt,
    })
    .from(schema.quarterlyPerformance)
    .where(inArray(schema.quarterlyPerformance.investmentId, [...ids]))
    .orderBy(asc(schema.quarterlyPerformance.periodEnd));
  for (const { investmentId, ...row } of rows) {
    const list = out.get(investmentId);
    if (list === undefined) out.set(investmentId, [row]);
    else list.push(row);
  }
  return out;
}

async function loadCreditInputs(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, CreditInputs>> {
  const out = new Map<string, CreditInputs>();
  if (ids.length === 0) return out;
  const terms = await tx
    .select({
      investmentId: schema.creditTerms.investmentId,
      maturityDate: schema.creditTerms.maturityDate,
    })
    .from(schema.creditTerms)
    .where(inArray(schema.creditTerms.investmentId, [...ids]));
  for (const t of terms) out.set(t.investmentId, { maturityDate: t.maturityDate, rows: [] });
  const rows = await tx
    .select({
      investmentId: schema.creditPerformance.investmentId,
      periodEnd: schema.creditPerformance.periodEnd,
      status: schema.creditPerformance.status,
      isEntrySnapshot: schema.creditPerformance.isEntrySnapshot,
      covenantStatus: schema.creditPerformance.covenantStatus,
      paymentStatus: schema.creditPerformance.paymentStatus,
    })
    .from(schema.creditPerformance)
    .where(inArray(schema.creditPerformance.investmentId, [...ids]))
    .orderBy(asc(schema.creditPerformance.periodEnd));
  for (const { investmentId, ...row } of rows) {
    const credit = out.get(investmentId) ?? { maturityDate: null, rows: [] };
    credit.rows.push(row);
    out.set(investmentId, credit);
  }
  return out;
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

  private thresholds(): Thresholds {
    const raw = this.definitions.watchlist;
    if (raw === undefined || typeof raw !== 'object') throw configError('watchlist');
    return {
      raw,
      netDebtToEbitdaMax: configDecimal(raw.netDebtToEbitdaMax, 'watchlist.netDebtToEbitdaMax'),
      ebitdaYoYDeclinePct: configDecimal(raw.ebitdaYoYDeclinePct, 'watchlist.ebitdaYoYDeclinePct'),
      markdownPct: configDecimal(raw.markdownPct, 'watchlist.markdownPct'),
      missingFinancialsDays: configInteger(
        raw.missingFinancialsDays,
        'watchlist.missingFinancialsDays',
      ),
      maturityWithinMonths: configInteger(
        raw.maturityWithinMonths,
        'watchlist.maturityWithinMonths',
      ),
      priorYearToleranceDays: configInteger(
        this.definitions.priorYearPeriodEndToleranceDays,
        'priorYearPeriodEndToleranceDays',
      ),
    };
  }

  /**
   * Portfolio analytics over every investment the caller can see (SEC-5.1, SEC-5.3): pooled
   * metrics for all, active and realized positions, exposure buckets, the Locked NAV series,
   * flows by year and the largest positions. Every figure is a Decimal; null means not calculable.
   */
  async summary(principal: Principal, requestId: string, asOf: string): Promise<AnalyticsSummary> {
    const quarters = configInteger(
      this.definitions.analytics?.navSeriesQuarters,
      'analytics.navSeriesQuarters',
    );
    const top = configInteger(this.definitions.analytics?.topPositions, 'analytics.topPositions');
    const tolerance = configInteger(
      this.definitions.priorYearPeriodEndToleranceDays,
      'priorYearPeriodEndToleranceDays',
    );
    return this.db.run(principal, requestId, async (tx, audit) => {
      const positions = await loadInvestmentsWithMetrics(tx, asOf);
      const labels = await loadLabels(tx);
      const active = positions.filter((p) => p.row.isActive);
      const realized = positions.filter((p) => !p.row.isActive);
      const activeNav = sumNav(active);
      const input = (
        p: Position,
      ): { flows: FlowRow[]; valuations: ValuationRow[]; isActive: boolean } => ({
        flows: p.flows,
        valuations: p.valuations,
        isActive: p.row.isActive,
      });
      const taxonomy = (code: string | null): { key: string; label: string } =>
        code === null
          ? { key: 'unknown', label: 'Not recorded' }
          : { key: code, label: labels.get(code) ?? code };
      const dealTypeOf = (p: Position): { key: string; label: string } => taxonomy(p.row.dealType);
      const dealTypes = exposures(active, activeNav, dealTypeOf);
      await audit({ action: 'analytics.read', entity: 'core.investment' });
      return {
        asOf,
        activeInvestments: active.length,
        realizedInvestments: realized.length,
        totals: pooledPositionMetrics(positions.map(input), asOf),
        active: pooledPositionMetrics(active.map(input), asOf),
        realized: pooledPositionMetrics(realized.map(input), asOf),
        exposures: {
          sector: exposures(active, activeNav, (p) => taxonomy(p.row.sector)),
          geography: exposures(active, activeNav, (p) => taxonomy(p.row.geography)),
          dealType: dealTypes,
          vehicle: exposures(active, activeNav, (p) => ({
            key: p.row.vehicleId,
            label: p.row.vehicleName,
          })),
          sponsor: exposures(active, activeNav, (p) => ({
            key: p.row.sponsorId,
            label: p.row.sponsorName,
          })),
          vintage: exposures(active, activeNav, (p) => {
            const year = p.row.entryDate.slice(0, 4);
            return { key: year, label: year };
          }),
          vehicleByDealType: vehicleByDealType(active, activeNav, dealTypes, dealTypeOf),
        },
        navSeries: lockedNavSeries(
          active.map((p) => p.valuations),
          asOf,
          { quarters, toleranceDays: tolerance },
        ),
        flowsByYear: flowsByYear(positions, asOf),
        topPositions: topPositions(active, activeNav, top),
        calcVersion: CALC_VERSION,
      };
    });
  }

  /**
   * Monitoring watchlist (docs/04 M9): every visible active position evaluated against the
   * thresholds in config/definitions.json. Only flagged positions are listed, bad before watch.
   */
  async watchlist(principal: Principal, requestId: string, asOf: string): Promise<Watchlist> {
    const thresholds = this.thresholds();
    return this.db.run(principal, requestId, async (tx, audit) => {
      const positions = await loadInvestmentsWithMetrics(
        tx,
        asOf,
        eq(schema.investment.isActive, true),
      );
      const ids = positions.map((p) => p.row.id);
      const labels = await loadLabels(tx);
      const operating = await loadOperatingRows(tx, ids);
      const credit = await loadCreditInputs(tx, ids);
      const items: WatchlistItem[] = [];
      let bad = 0;
      let watch = 0;
      for (const p of positions) {
        const flags = evaluateFlags(
          {
            valuations: p.valuations,
            operating: operating.get(p.row.id) ?? [],
            credit: credit.get(p.row.id) ?? null,
          },
          asOf,
          thresholds,
          labels,
        );
        if (flags.length === 0) continue;
        const item: WatchlistItem = {
          investmentId: p.row.id,
          investmentNumber: p.row.investmentNumber,
          companyName: p.row.companyName,
          vehicleName: p.row.vehicleName,
          dealType: p.row.dealType,
          flags,
        };
        if (severityRank(item) === 0) bad += 1;
        else watch += 1;
        items.push(item);
      }
      items.sort(
        (a, b) =>
          severityRank(a) - severityRank(b) || compareText(a.investmentNumber, b.investmentNumber),
      );
      await audit({ action: 'watchlist.read', entity: 'core.investment' });
      return {
        asOf,
        thresholds: thresholds.raw,
        items,
        counts: { watch, bad, clear: positions.length - items.length },
        calcVersion: CALC_VERSION,
      };
    });
  }
}
