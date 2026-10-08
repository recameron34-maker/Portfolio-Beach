import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lte, ne, or } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import {
  CALC_VERSION,
  D,
  addDays,
  daysBetween,
  valueChange,
  latestQuarterEndOnOrBefore,
  lockedNear,
} from '@pb/calc';
import type { Decimal } from '@pb/calc';
import type { CapitalNoticeRow, PooledMetrics, WeeklyReport } from '@pb/contracts';
import { schema } from '@pb/db';
import type { Tx } from '@pb/db';
import { DUE_ORDER, buildNoticeRows } from '../capital/notices.js';
import { fmtDate } from '../common/dates.js';
import { configInteger, configString } from '../common/definitions.js';
import { DEFINITIONS } from '../common/tokens.js';
import { DbService } from '../db/db.service.js';
import { loadInvestmentsWithMetrics } from '../portfolio/loaders.js';
import { latestLockedValuation, pooledPositionMetrics, str } from '../portfolio/metrics.js';
import { compareDecimalDesc, compareText } from '../common/order.js';

/** Calculation and reporting settings from config/definitions.json; only the keys this service reads. */
interface Definitions {
  priorYearPeriodEndToleranceDays?: unknown;
  irr?: { displayShortPeriodAs?: unknown };
  reporting?: {
    weeklyMoversCount?: unknown;
    capitalActivityWindowDays?: unknown;
    staleValuationFootnote?: unknown;
    noValuationFootnote?: unknown;
  };
  [key: string]: unknown;
}

type Position = Awaited<ReturnType<typeof loadInvestmentsWithMetrics>>[number];
type Mover = WeeklyReport['movers'][number];
type Stale = WeeklyReport['staleValuations'][number];
type VehicleRow = WeeklyReport['byVehicle'][number];

const IRR_FLAG_LABEL: Record<NonNullable<PooledMetrics['irrFlag']>, string> = {
  short_period: 'held under one year',
  multiple_irr: 'more than one IRR root',
  no_root: 'no IRR root',
  same_sign: 'cash flows of one sign only',
  insufficient_flows: 'too few cash flows',
  no_convergence: 'IRR did not converge',
};

/* ---- Display helpers for the template commentary (docs/06 section 3) ---- */

const group = (whole: string): string => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Dollars as $M with one decimal from a decimal string: "390009856.77" -> "$390.0M". */
function fmtMoneyM(value: string): string {
  const millions = D(value).div('1000000');
  const [whole, frac] = millions.abs().toFixed(1).split('.');
  return `${millions.isNegative() ? '-' : ''}$${group(whole ?? '0')}.${frac ?? '0'}M`;
}

const fmtMoic = (value: string): string => `${D(value).toFixed(2)}x`;

/** Percentage with one decimal: "0.0530" -> "5.3%". */
const fmtPct = (value: string): string => `${D(value).mul('100').toFixed(1)}%`;

/** Signed percentage with one decimal for changes: "0.1234" -> "+12.3%". */
function fmtSignedPct(value: string): string {
  const pct = D(value).mul('100');
  return `${pct.isNegative() ? '-' : '+'}${pct.abs().toFixed(1)}%`;
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

const joinList = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

  /**
   * The weekly report assembled from visible figures only: pooled metrics over active positions,
   * a vehicle breakdown, quarter-over-quarter movers, stale marks, capital activity around the
   * as-of date and template commentary written from those numbers (M12). Reads visible data
   * only, so nothing is audited; every number is a decimal string or null.
   */
  async weekly(principal: Principal, requestId: string, asOf: string): Promise<WeeklyReport> {
    // Every setting through the config readers: a missing key is a 500 'configuration' problem
    // before the database is touched, never a default written here (CLAUDE.md rules 9 and 10).
    const tolerance = configInteger(
      this.definitions.priorYearPeriodEndToleranceDays,
      'priorYearPeriodEndToleranceDays',
    );
    const reporting = this.definitions.reporting;
    const moversCount = configInteger(reporting?.weeklyMoversCount, 'reporting.weeklyMoversCount');
    const windowDays = configInteger(
      reporting?.capitalActivityWindowDays,
      'reporting.capitalActivityWindowDays',
    );
    const staleTemplate = configString(
      reporting?.staleValuationFootnote,
      'reporting.staleValuationFootnote',
    );
    const noValuationFootnote = configString(
      reporting?.noValuationFootnote,
      'reporting.noValuationFootnote',
    );
    const shortPeriodAs = configString(
      this.definitions.irr?.displayShortPeriodAs,
      'irr.displayShortPeriodAs',
    );
    const periodEnd = latestQuarterEndOnOrBefore(asOf);
    const priorPeriodEnd = latestQuarterEndOnOrBefore(addDays(periodEnd, -1));

    return this.db.run(principal, requestId, async (tx) => {
      const positions = await loadInvestmentsWithMetrics(
        tx,
        asOf,
        eq(schema.investment.isActive, true),
      );
      const asInputs = (set: readonly Position[]): Parameters<typeof pooledPositionMetrics>[0] =>
        set.map((p) => ({ flows: p.flows, valuations: p.valuations, isActive: p.row.isActive }));
      const pooled = pooledPositionMetrics(asInputs(positions), asOf);
      const summary = { ...pooled, activeInvestments: positions.length };

      const byVehicle = await this.vehicleRows(tx, positions, asOf, asInputs);
      const movers = this.movers(positions, periodEnd, priorPeriodEnd, tolerance, moversCount);
      const staleValuations = this.stale(
        positions,
        asOf,
        periodEnd,
        tolerance,
        staleTemplate,
        noValuationFootnote,
      );
      const capitalActivity = await this.capitalActivity(tx, asOf, windowDays);

      const flagged = positions
        .filter((p) => p.summary.irrFlag !== null)
        .map((p) => `${p.row.investmentNumber} (${IRR_FLAG_LABEL[p.summary.irrFlag!]})`);
      const footnotes = staleValuations.map((s) => {
        const p = positions.find((x) => x.row.id === s.investmentId);
        return `${s.investmentNumber} ${p?.row.companyName ?? ''}: ${s.footnote}`.replace(
          '  ',
          ' ',
        );
      });
      if (flagged.length > 0)
        footnotes.push(`Gross IRR is shown as ${shortPeriodAs} for ${joinList(flagged)}.`);
      if (summary.irrFlag !== null)
        footnotes.push(
          `The portfolio gross IRR is shown as ${shortPeriodAs} (${IRR_FLAG_LABEL[summary.irrFlag]}).`,
        );
      footnotes.push('Figures are gross, before fees and carry.');

      return {
        asOf,
        periodEnd,
        preparedFor: principal.displayName,
        summary,
        byVehicle,
        movers,
        staleValuations,
        capitalActivity,
        commentary: {
          paragraphs: this.commentary({
            asOf,
            periodEnd,
            priorPeriodEnd,
            windowDays,
            summary,
            byVehicle,
            movers,
            staleValuations,
            capitalActivity,
          }),
          source: 'template',
          aiDraft: false,
        },
        footnotes,
        calcVersion: CALC_VERSION,
      };
    });
  }

  /** One row per visible vehicle holding an active position, pooled per vehicle, NAV descending. */
  private async vehicleRows(
    tx: Tx,
    positions: readonly Position[],
    asOf: string,
    asInputs: (set: readonly Position[]) => Parameters<typeof pooledPositionMetrics>[0],
  ): Promise<VehicleRow[]> {
    const groups = new Map<string, Position[]>();
    for (const p of positions) {
      const set = groups.get(p.row.vehicleId);
      if (set === undefined) groups.set(p.row.vehicleId, [p]);
      else set.push(p);
    }
    if (groups.size === 0) return [];
    const vehicles = await tx
      .select({
        id: schema.vehicle.id,
        name: schema.vehicle.name,
        vehicleType: schema.vehicle.vehicleType,
      })
      .from(schema.vehicle)
      .where(inArray(schema.vehicle.id, [...groups.keys()]));
    const rows: VehicleRow[] = [];
    for (const v of vehicles) {
      const set = groups.get(v.id);
      if (set === undefined) continue;
      const m = pooledPositionMetrics(asInputs(set), asOf);
      rows.push({
        vehicleId: v.id,
        vehicleName: v.name,
        vehicleType: v.vehicleType,
        count: m.count,
        invested: m.invested,
        distributions: m.distributions,
        nav: m.nav,
        grossMoic: m.grossMoic,
      });
    }
    return rows.sort(
      (a, b) => compareDecimalDesc(a.nav, b.nav) || compareText(a.vehicleName, b.vehicleName),
    );
  }

  /**
   * Largest Locked fair value changes between the prior quarter end and the period end, up and
   * down together. Both marks may sit up to the prior-year tolerance before their quarter end so
   * sponsors whose period ends are shifted by a few days still compare like for like.
   */
  private movers(
    positions: readonly Position[],
    periodEnd: string,
    priorPeriodEnd: string,
    tolerance: number,
    count: number,
  ): Mover[] {
    const ranked: { mover: Mover; size: Decimal }[] = [];
    for (const p of positions) {
      const current = lockedNear(p.valuations, periodEnd, tolerance);
      const prior = lockedNear(p.valuations, priorPeriodEnd, tolerance);
      if (current === null || prior === null) continue;
      // Not calculable against a zero prior mark: that position is not a mover.
      const change = valueChange(current.fairValue, prior.fairValue);
      if (change === null) continue;
      ranked.push({
        mover: {
          investmentId: p.row.id,
          investmentNumber: p.row.investmentNumber,
          companyName: p.row.companyName,
          periodEnd: current.periodEnd,
          priorFairValue: prior.fairValue,
          fairValue: current.fairValue,
          changePct: str(change),
        },
        size: change.abs(),
      });
    }
    ranked.sort(
      (a, b) =>
        b.size.comparedTo(a.size) ||
        compareText(a.mover.investmentNumber, b.mover.investmentNumber),
    );
    return ranked
      .slice(0, count)
      .map((r) => r.mover)
      .sort(
        (a, b) =>
          compareDecimalDesc(a.changePct, b.changePct) ||
          compareText(a.investmentNumber, b.investmentNumber),
      );
  }

  /** Active positions whose latest Locked mark is older than the period end (beyond the tolerance) or missing. */
  private stale(
    positions: readonly Position[],
    asOf: string,
    periodEnd: string,
    tolerance: number,
    staleTemplate: string,
    noValuationFootnote: string,
  ): Stale[] {
    const out: Stale[] = [];
    for (const p of positions) {
      const latest = latestLockedValuation(p.valuations, asOf);
      if (latest !== null && daysBetween(latest.periodEnd, periodEnd) <= tolerance) continue;
      out.push({
        investmentId: p.row.id,
        investmentNumber: p.row.investmentNumber,
        companyName: p.row.companyName,
        latestLockedPeriodEnd: latest?.periodEnd ?? null,
        footnote:
          latest === null
            ? noValuationFootnote
            : staleTemplate
                .replaceAll('{lockedPeriodEnd}', fmtDate(latest.periodEnd))
                .replaceAll('{periodEnd}', fmtDate(periodEnd)),
      });
    }
    return out.sort((a, b) => compareText(a.investmentNumber, b.investmentNumber));
  }

  /** Visible notices that are not Reconciled or fall due within the window either side of the as-of date, soonest first. */
  private capitalActivity(tx: Tx, asOf: string, windowDays: number): Promise<CapitalNoticeRow[]> {
    const n = schema.capitalNotice;
    return buildNoticeRows(
      tx,
      asOf,
      or(
        ne(n.state, 'Reconciled'),
        and(gte(n.dueDate, addDays(asOf, -windowDays)), lte(n.dueDate, addDays(asOf, windowDays))),
      ),
      { orderBy: DUE_ORDER },
    );
  }

  /** Plain sentences built from the figures above. No model call, no adjectives, no predictions. */
  private commentary(input: {
    asOf: string;
    periodEnd: string;
    priorPeriodEnd: string;
    windowDays: number;
    summary: WeeklyReport['summary'];
    byVehicle: readonly VehicleRow[];
    movers: readonly Mover[];
    staleValuations: readonly Stale[];
    capitalActivity: readonly CapitalNoticeRow[];
  }): string[] {
    const { summary: s } = input;
    const opening = `As of ${fmtDate(input.asOf)} the portfolio holds ${plural(s.activeInvestments, 'active position')}`;
    let figures: string;
    if (s.nav !== null && s.invested !== null)
      figures = ` with NAV of ${fmtMoneyM(s.nav)} on ${fmtMoneyM(s.invested)} invested`;
    else if (s.nav !== null) figures = ` with NAV of ${fmtMoneyM(s.nav)}`;
    else if (s.invested !== null)
      figures = ` with ${fmtMoneyM(s.invested)} invested; NAV is not calculable this quarter`;
    else figures = '';
    const moic = s.grossMoic === null ? '.' : `, a gross MOIC of ${fmtMoic(s.grossMoic)}.`;
    const first = [`${opening}${figures}${moic}`];
    if (s.distributions !== null)
      first.push(`Distributions to date total ${fmtMoneyM(s.distributions)}.`);
    if (s.grossIrr !== null) first.push(`The pooled gross IRR is ${fmtPct(s.grossIrr)}.`);

    const vehicles =
      input.byVehicle.length === 0
        ? 'No vehicle holds an active position.'
        : `NAV by vehicle: ${input.byVehicle
            .map(
              (v) =>
                `${v.vehicleName} ${v.nav === null ? 'not calculable' : fmtMoneyM(v.nav)} (${plural(v.count, 'position')})`,
            )
            .join('; ')}.`;

    const movers =
      input.movers.length === 0
        ? `No position has Locked valuations for both ${fmtDate(input.priorPeriodEnd)} and ${fmtDate(input.periodEnd)}.`
        : `Largest Locked valuation changes from ${fmtDate(input.priorPeriodEnd)} to ${fmtDate(input.periodEnd)}: ${joinList(
            input.movers.map(
              (m) =>
                `${m.companyName} (${m.investmentNumber}) ${m.changePct === null ? 'not calculable' : fmtSignedPct(m.changePct)}`,
            ),
          )}.`;

    const stale =
      input.staleValuations.length === 0
        ? `Every active position has a Locked valuation for ${fmtDate(input.periodEnd)}.`
        : `Positions without a Locked valuation for ${fmtDate(input.periodEnd)}: ${joinList(
            input.staleValuations.map(
              (x) =>
                `${x.companyName} (${x.investmentNumber}, ${
                  x.latestLockedPeriodEnd === null
                    ? 'no Locked mark on record'
                    : `carried at ${fmtDate(x.latestLockedPeriodEnd)}`
                })`,
            ),
          )}.`;

    const open = input.capitalActivity.filter((c) => c.state !== 'Reconciled').length;
    const capital =
      input.capitalActivity.length === 0
        ? `No capital notices are open or due within ${input.windowDays} days of ${fmtDate(input.asOf)}.`
        : `Capital activity: ${plural(input.capitalActivity.length, 'notice')} ${
            input.capitalActivity.length === 1 ? 'is' : 'are'
          } open or due within ${input.windowDays} days of ${fmtDate(input.asOf)}, of which ${open} ${
            open === 1 ? 'is' : 'are'
          } not yet Reconciled.`;

    return [first.join(' '), vehicles, movers, stale, capital];
  }
}
