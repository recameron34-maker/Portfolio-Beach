import type { Decimal, DecimalInput } from './decimal.js';
import { D, ZERO } from './decimal.js';
import type { IsoDate } from './dates.js';
import { compareIso } from './dates.js';

/** A dated amount from the investor's perspective: outflows negative, inflows positive (docs/08 section 1). */
export interface CashFlow {
  date: IsoDate;
  amount: DecimalInput;
}

export interface DatedAmount {
  date: IsoDate;
  amount: Decimal;
}

/** Cash flow kinds stored in mon.cash_flow (docs/03). PIK capitalization is deliberately absent. */
export type FlowKind =
  | 'contribution'
  | 'distribution'
  | 'fee'
  | 'expense'
  | 'interest'
  | 'principal'
  | 'recallable';

export interface TypedCashFlow extends CashFlow {
  kind: FlowKind;
}

/** Normalizes and sorts flows by date (stable for equal dates). */
export function normalizeFlows(flows: readonly CashFlow[]): DatedAmount[] {
  return flows
    .map((f, index) => ({ date: f.date, amount: D(f.amount), index }))
    .sort((a, b) => compareIso(a.date, b.date) || a.index - b.index)
    .map(({ date, amount }) => ({ date, amount }));
}

export interface FlowSummary {
  /** Sum of absolute contributions (paid-in). */
  contributions: Decimal;
  /** Sum of distributions, interest, principal and recallable distributions received. */
  distributions: Decimal;
  /** Sum of recallable distributions only (positive). */
  recallable: Decimal;
  /** Fees and expenses paid (positive total of the absolute amounts). */
  feesAndExpenses: Decimal;
  /** Date of the first contribution, if any. */
  firstContributionDate: IsoDate | null;
}

/**
 * Derives the totals the multiples need from typed flows. Signs follow docs/08 section 1:
 * contributions, fees and expenses are negative amounts; distributions, interest, principal and
 * recallables are positive. The function takes absolute values so a sign slip in a source is
 * caught by validation, not silently absorbed here.
 */
export function summarizeFlows(flows: readonly TypedCashFlow[]): FlowSummary {
  let contributions = ZERO;
  let distributions = ZERO;
  let recallable = ZERO;
  let feesAndExpenses = ZERO;
  let firstContributionDate: IsoDate | null = null;
  for (const f of flows) {
    const amount = D(f.amount).abs();
    switch (f.kind) {
      case 'contribution':
        contributions = contributions.plus(amount);
        if (firstContributionDate === null || compareIso(f.date, firstContributionDate) < 0) {
          firstContributionDate = f.date;
        }
        break;
      case 'distribution':
      case 'interest':
      case 'principal':
        distributions = distributions.plus(amount);
        break;
      case 'recallable':
        distributions = distributions.plus(amount);
        recallable = recallable.plus(amount);
        break;
      case 'fee':
      case 'expense':
        feesAndExpenses = feesAndExpenses.plus(amount);
        break;
    }
  }
  return { contributions, distributions, recallable, feesAndExpenses, firstContributionDate };
}

/** Converts typed flows to signed flows for IRR: outflows negative, inflows positive. */
export function toSignedFlows(flows: readonly TypedCashFlow[]): CashFlow[] {
  return flows.map((f) => {
    const amount = D(f.amount).abs();
    const outflow = f.kind === 'contribution' || f.kind === 'fee' || f.kind === 'expense';
    return { date: f.date, amount: outflow ? amount.neg() : amount };
  });
}
