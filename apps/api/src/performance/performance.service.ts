import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Principal } from '@pb/adapters';
import {
  CALC_VERSION,
  D,
  allInCoupon,
  currentYield,
  ebitdaMargin,
  entrySnapshot,
  evToEbitda,
  growthSinceEntry,
  interestCoverage,
  latestPeriod,
  leverageThroughTranche,
  loanToValue,
  multipleDelta,
  netDebtToEbitda,
  sameQuarterPriorYear,
  yieldToMaturity,
  yoyGrowth,
} from '@pb/calc';
import type { Decimal, PaymentFrequency } from '@pb/calc';
import type { InvestmentPerformance, QuarterRow } from '@pb/contracts';
import { schema } from '@pb/db';
import { DEFINITIONS } from '../common/tokens.js';
import { ProblemError } from '../common/problem.js';
import { DbService } from '../db/db.service.js';
import { loadInvestmentRows } from '../portfolio/loaders.js';
import { str } from '../portfolio/metrics.js';

/** Calculation settings from config/definitions.json (docs/03 section 4); only the keys this service reads. */
interface Definitions {
  priorYearPeriodEndToleranceDays?: number;
  /** Base rate code to annual rate (decimal). Absent from the prototype config, so no all-in coupon is calculable. */
  baseRates?: Record<string, unknown>;
  [key: string]: unknown;
}

type CreditDetail = NonNullable<InvestmentPerformance['credit']>;
type CreditTermsDetail = CreditDetail['terms'];
type CreditQuarterRow = CreditDetail['quarters'][number];

/** One mon.quarterly_performance row as selected below; highlights is the raw jsonb column. */
interface QuarterSource {
  periodEnd: string;
  isEntrySnapshot: boolean;
  status: string;
  revenueLtm: string | null;
  ebitdaLtm: string | null;
  ev: string | null;
  netDebt: string | null;
  cash: string | null;
  totalEquity: string | null;
  highlights: unknown;
}

/** One mon.credit_performance row as selected below. */
interface CreditSource {
  periodEnd: string;
  isEntrySnapshot: boolean;
  status: string;
  parValue: string | null;
  costBasis: string | null;
  fairValue: string | null;
  accruedInterest: string | null;
  cashInterestLtm: string | null;
  pikCapitalizedLtm: string | null;
  principalRepaidLtm: string | null;
  fundedAmount: string | null;
  ebitdaLtm: string | null;
  cashInterestExpenseLtm: string | null;
  netDebtThroughTranche: string | null;
  ev: string | null;
  covenantStatus: string | null;
  paymentStatus: string | null;
}

/** The mon.credit_terms columns the Performance tab renders; the three schedules are raw jsonb. */
interface CreditTermsSource {
  facilityType: string;
  seniorityRank: number;
  commitmentAmount: string;
  baseRate: string;
  floor: string | null;
  spread: string;
  cashCoupon: string;
  pikCoupon: string;
  oid: string;
  upfrontFee: string;
  maturityDate: string;
  paymentFrequency: string;
  effectiveDate: string;
  amortization: unknown;
  callProtection: unknown;
  covenants: unknown;
}

const DECIMAL = /^-?\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FREQUENCIES: readonly PaymentFrequency[] = ['monthly', 'quarterly', 'semiannual', 'annual'];

const configError = (key: string): ProblemError =>
  new ProblemError(500, 'configuration', `config/definitions.json is missing a usable ${key}`);

function configInteger(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw configError(key);
  return value;
}

/* ---- jsonb readers: a value that cannot be read is left out, never replaced by an invented one ---- */

/** A jsonb numeric string or finite number as a decimal string; anything else is not a number. */
function decimalOf(value: unknown): string | null {
  if (typeof value === 'string') return DECIMAL.test(value) ? value : null;
  if (typeof value === 'number' && Number.isFinite(value)) return str(D(String(value)));
  return null;
}

const isoDateOf = (value: unknown): string | null =>
  typeof value === 'string' && ISO_DATE.test(value) ? value : null;

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The string entries of a jsonb array; a null or malformed column reads as no highlights. */
function highlightsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((h): h is string => typeof h === 'string') : [];
}

/** The entries of a jsonb array of objects that read completely; an entry missing a field is skipped. */
function entriesOf<T>(value: unknown, read: (entry: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const parsed = read(entry as Record<string, unknown>);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/* ---- composition of @pb/calc over the rows (docs/08 sections 4, 5 and 10) ---- */

const withCalcStatus = <T extends { status: string }>(rows: readonly T[]): T[] =>
  rows.map((r) => ({ ...r, status: r.status.replace('record_status.', '') }));

const evMultiple = (row: QuarterSource): Decimal | null =>
  row.ev === null ? null : evToEbitda(row.ev, row.ebitdaLtm);

const leverage = (row: QuarterSource): Decimal | null =>
  row.netDebt === null ? null : netDebtToEbitda(row.netDebt, row.ebitdaLtm);

/** A quarter with its ratios; the year-on-year columns compare against the matched prior-year row. */
function quarterRow(row: QuarterSource, prior: QuarterSource | null): QuarterRow {
  return {
    periodEnd: row.periodEnd,
    isEntrySnapshot: row.isEntrySnapshot,
    status: row.status,
    revenueLtm: row.revenueLtm,
    ebitdaLtm: row.ebitdaLtm,
    ev: row.ev,
    netDebt: row.netDebt,
    cash: row.cash,
    totalEquity: row.totalEquity,
    evToEbitda: str(evMultiple(row)),
    netDebtToEbitda: str(leverage(row)),
    ebitdaMargin: row.ebitdaLtm === null ? null : str(ebitdaMargin(row.ebitdaLtm, row.revenueLtm)),
    revenueYoy: str(yoyGrowth(row.revenueLtm, prior?.revenueLtm ?? null)),
    ebitdaYoy: str(yoyGrowth(row.ebitdaLtm, prior?.ebitdaLtm ?? null)),
    highlights: highlightsOf(row.highlights),
  };
}

/**
 * Growth and multiple change since entry, from the latest approved quarter on or before the as-of
 * date. Not calculable without a snapshot or a quarter, and not calculable while the snapshot is
 * dated after the as-of date: a forward-dated snapshot is still returned as `entry` so the tab can
 * show it, but it is no basis for a comparison as of an earlier date (forward_entry_snapshot).
 */
function sinceEntryOf(
  rows: readonly QuarterSource[],
  entry: QuarterSource | null,
  asOf: string,
): InvestmentPerformance['sinceEntry'] {
  if (entry === null || entry.periodEnd > asOf) return null;
  const latest = latestPeriod(withCalcStatus(rows), asOf);
  if (latest === null) return null;
  return {
    periodEnd: latest.periodEnd,
    revenueGrowth: str(growthSinceEntry(latest.revenueLtm, entry.revenueLtm)),
    ebitdaGrowth: str(growthSinceEntry(latest.ebitdaLtm, entry.ebitdaLtm)),
    multipleDelta: str(multipleDelta(evMultiple(latest), evMultiple(entry))),
    evToEbitdaAtEntry: str(evMultiple(entry)),
    netDebtToEbitdaAtEntry: str(leverage(entry)),
  };
}

function creditQuarterRow(row: CreditSource, cashCoupon: string): CreditQuarterRow {
  return {
    periodEnd: row.periodEnd,
    parValue: row.parValue,
    costBasis: row.costBasis,
    fairValue: row.fairValue,
    accruedInterest: row.accruedInterest,
    cashInterestLtm: row.cashInterestLtm,
    pikCapitalizedLtm: row.pikCapitalizedLtm,
    principalRepaidLtm: row.principalRepaidLtm,
    fundedAmount: row.fundedAmount,
    ebitdaLtm: row.ebitdaLtm,
    cashInterestExpenseLtm: row.cashInterestExpenseLtm,
    netDebtThroughTranche: row.netDebtThroughTranche,
    ev: row.ev,
    currentYield:
      row.parValue === null || row.fairValue === null
        ? null
        : str(currentYield(cashCoupon, row.parValue, row.fairValue)),
    interestCoverage: str(interestCoverage(row.ebitdaLtm, row.cashInterestExpenseLtm)),
    leverageThroughTranche:
      row.netDebtThroughTranche === null
        ? null
        : str(leverageThroughTranche(row.netDebtThroughTranche, row.ebitdaLtm)),
    loanToValue:
      row.netDebtThroughTranche === null
        ? null
        : str(loanToValue(row.netDebtThroughTranche, row.ev)),
    covenantStatus: row.covenantStatus,
    paymentStatus: row.paymentStatus,
  };
}

/**
 * The facility terms with the schedules read from jsonb and the two derived yields. Yield to
 * maturity prices the latest approved credit row (fair value and par on or before the as-of date)
 * over the contractual flows to maturity; it is null past maturity or without a priced row.
 */
function creditTermsOf(
  terms: CreditTermsSource,
  rows: readonly CreditSource[],
  asOf: string,
  baseRate: string | null,
): CreditTermsDetail {
  const amortization = entriesOf(terms.amortization, (e) => {
    const date = isoDateOf(e.date);
    const amount = decimalOf(e.amount);
    return date === null || amount === null ? null : { date, amount };
  });
  const callProtection = entriesOf(terms.callProtection, (e) => {
    const until = isoDateOf(e.until);
    const premium = decimalOf(e.premium);
    return until === null || premium === null ? null : { until, premium };
  });
  const covenants = entriesOf(terms.covenants, (e) => {
    const name = textOf(e.name);
    const level = decimalOf(e.level);
    const test = textOf(e.test);
    return name === null || level === null || test === null ? null : { name, level, test };
  });
  const latest = latestPeriod(withCalcStatus(rows), asOf);
  const fairValue = latest?.fairValue ?? null;
  const par = latest?.parValue ?? null;
  const frequency = FREQUENCIES.find((f) => f === terms.paymentFrequency);
  let ytm: Decimal | null = null;
  if (fairValue !== null && par !== null && frequency !== undefined) {
    ytm = yieldToMaturity({
      asOf,
      fairValue,
      par,
      cashCoupon: terms.cashCoupon,
      pikCoupon: terms.pikCoupon,
      maturity: terms.maturityDate,
      frequency,
      // Steps already paid by the as-of date are reflected in the row's par; only the remaining
      // steps are future flows. Passing a past step would repay it a second time.
      scheduledPrincipal: amortization.filter((step) => step.date > asOf),
    }).value;
  }
  return {
    facilityType: terms.facilityType,
    seniorityRank: terms.seniorityRank,
    commitmentAmount: terms.commitmentAmount,
    baseRate: terms.baseRate,
    floor: terms.floor,
    spread: terms.spread,
    cashCoupon: terms.cashCoupon,
    pikCoupon: terms.pikCoupon,
    oid: terms.oid,
    upfrontFee: terms.upfrontFee,
    maturityDate: terms.maturityDate,
    paymentFrequency: terms.paymentFrequency,
    effectiveDate: terms.effectiveDate,
    amortization,
    callProtection,
    covenants,
    // Null whenever the base rate itself is unknown (docs/08 section 10); never an assumed rate.
    allInCoupon: str(allInCoupon({ baseRate, floor: terms.floor, spread: terms.spread })),
    yieldToMaturity: str(ytm),
    pastMaturity: terms.maturityDate < asOf,
  };
}

@Injectable()
export class PerformanceService {
  constructor(
    private readonly db: DbService,
    @Inject(DEFINITIONS) private readonly definitions: Definitions,
  ) {}

  /**
   * The annual rate for a base rate code from config (`baseRates`). config/definitions.json has no
   * baseRates entry in the prototype, so this returns null and the all-in coupon shows as not
   * calculable; a rate is never invented here (CLAUDE.md rule 10).
   */
  private baseRateOf(code: string): string | null {
    const rates = this.definitions.baseRates;
    if (rates === undefined || typeof rates !== 'object') return null;
    return decimalOf(rates[code]);
  }

  /**
   * Quarterly operating and credit series for one investment (docs/04 M9 Performance tab). 404 for
   * anything the caller cannot see (SEC-5.3); the open is an audited sensitive read (SEC-11.1).
   * Every figure comes from @pb/calc as a decimal string; null means not calculable.
   */
  async performance(
    principal: Principal,
    requestId: string,
    id: string,
    asOf: string,
  ): Promise<InvestmentPerformance> {
    return this.db.run(principal, requestId, async (tx, audit) => {
      const rows = await loadInvestmentRows(tx, { where: eq(schema.investment.id, id), limit: 1 });
      const investment = rows[0];
      if (investment === undefined)
        throw new ProblemError(404, 'not-found', 'Investment not found');
      const tolerance = configInteger(
        this.definitions.priorYearPeriodEndToleranceDays,
        'priorYearPeriodEndToleranceDays',
      );

      const q = schema.quarterlyPerformance;
      const operatingRows: QuarterSource[] = await tx
        .select({
          periodEnd: q.periodEnd,
          isEntrySnapshot: q.isEntrySnapshot,
          status: q.status,
          revenueLtm: q.revenueLtm,
          ebitdaLtm: q.ebitdaLtm,
          ev: q.ev,
          netDebt: q.netDebt,
          cash: q.cash,
          totalEquity: q.totalEquity,
          highlights: q.highlights,
        })
        .from(q)
        .where(eq(q.investmentId, investment.id))
        .orderBy(asc(q.periodEnd));
      // Prior-year matches come from approved rows only; the row itself keeps its stored status code.
      const approved = operatingRows.filter((r) => r.status === 'record_status.approved');
      // The database allows one flagged snapshot per investment, so this never throws here.
      const entry = entrySnapshot(operatingRows);
      const quarters = operatingRows
        .filter((r) => !r.isEntrySnapshot)
        .map((r) =>
          quarterRow(r, sameQuarterPriorYear(approved, r.periodEnd, { toleranceDays: tolerance })),
        );

      const t = schema.creditTerms;
      const terms = (
        await tx
          .select({
            facilityType: t.facilityType,
            seniorityRank: t.seniorityRank,
            commitmentAmount: t.commitmentAmount,
            baseRate: t.baseRate,
            floor: t.floor,
            spread: t.spread,
            cashCoupon: t.cashCoupon,
            pikCoupon: t.pikCoupon,
            oid: t.oid,
            upfrontFee: t.upfrontFee,
            maturityDate: t.maturityDate,
            paymentFrequency: t.paymentFrequency,
            effectiveDate: t.effectiveDate,
            amortization: t.amortization,
            callProtection: t.callProtection,
            covenants: t.covenants,
          })
          .from(t)
          .where(eq(t.investmentId, investment.id))
          .limit(1)
      )[0];
      let credit: InvestmentPerformance['credit'] = null;
      if (terms !== undefined) {
        const c = schema.creditPerformance;
        const creditRows: CreditSource[] = await tx
          .select({
            periodEnd: c.periodEnd,
            isEntrySnapshot: c.isEntrySnapshot,
            status: c.status,
            parValue: c.parValue,
            costBasis: c.costBasis,
            fairValue: c.fairValue,
            accruedInterest: c.accruedInterest,
            cashInterestLtm: c.cashInterestLtm,
            pikCapitalizedLtm: c.pikCapitalizedLtm,
            principalRepaidLtm: c.principalRepaidLtm,
            fundedAmount: c.fundedAmount,
            ebitdaLtm: c.ebitdaLtm,
            cashInterestExpenseLtm: c.cashInterestExpenseLtm,
            netDebtThroughTranche: c.netDebtThroughTranche,
            ev: c.ev,
            covenantStatus: c.covenantStatus,
            paymentStatus: c.paymentStatus,
          })
          .from(c)
          .where(eq(c.investmentId, investment.id))
          .orderBy(asc(c.periodEnd));
        credit = {
          terms: creditTermsOf(terms, creditRows, asOf, this.baseRateOf(terms.baseRate)),
          quarters: creditRows.map((r) => creditQuarterRow(r, terms.cashCoupon)),
        };
      }

      const o = schema.realizationOutlook;
      const outlook = (
        await tx
          .select({
            horizonMonths: o.horizonMonths,
            outlook: o.outlook,
            note: o.note,
            setAt: o.setAt,
          })
          .from(o)
          .where(eq(o.investmentId, investment.id))
          .limit(1)
      )[0];

      await audit({
        action: 'investment.performance.read',
        entity: 'core.investment',
        entityId: investment.id,
      });
      return {
        investmentId: investment.id,
        asOf,
        entry: entry === null ? null : quarterRow(entry, null),
        quarters,
        sinceEntry: sinceEntryOf(operatingRows, entry, asOf),
        credit,
        realizationOutlook:
          outlook === undefined
            ? null
            : {
                horizonMonths: outlook.horizonMonths,
                outlook: outlook.outlook,
                note: outlook.note,
                setAt: outlook.setAt.toISOString(),
              },
        calcVersion: CALC_VERSION,
      };
    });
  }
}
