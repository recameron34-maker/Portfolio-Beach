import type { Decimal, DecimalInput } from './decimal.js';
import { D } from './decimal.js';

export interface AttributionPoint {
  revenue: DecimalInput;
  ebitda: DecimalInput;
  ev: DecimalInput;
  netDebt: DecimalInput;
}

export interface AttributionResult {
  equityAtEntry: Decimal;
  equityCurrent: Decimal;
  revenueGrowth: Decimal;
  marginChange: Decimal;
  multipleChange: Decimal;
  netDebtChange: Decimal;
  /** Always equals equityCurrent - equityAtEntry; exposed so callers can assert it. */
  total: Decimal;
}

/**
 * Value creation attribution by sequential substitution in the fixed order revenue, margin,
 * multiple, net debt (docs/08 section 8). Equity = revenue x margin x multiple - net debt, where
 * margin = EBITDA / revenue and multiple = EV / EBITDA. Null when a revenue or EBITDA is not
 * positive, because the multiple is then undefined.
 */
export function valueCreationAttribution(
  entry: AttributionPoint,
  current: AttributionPoint,
): AttributionResult | null {
  const r0 = D(entry.revenue);
  const e0 = D(entry.ebitda);
  const r1 = D(current.revenue);
  const e1 = D(current.ebitda);
  if (r0.lte(0) || e0.lte(0) || r1.lte(0) || e1.lte(0)) return null;
  const m0 = e0.div(r0);
  const x0 = D(entry.ev).div(e0);
  const m1 = e1.div(r1);
  const x1 = D(current.ev).div(e1);
  const d0 = D(entry.netDebt);
  const d1 = D(current.netDebt);

  const equity0 = r0.times(m0).times(x0).minus(d0);
  const step1 = r1.times(m0).times(x0).minus(d0);
  const step2 = r1.times(m1).times(x0).minus(d0);
  const step3 = r1.times(m1).times(x1).minus(d0);
  const equity1 = r1.times(m1).times(x1).minus(d1);

  return {
    equityAtEntry: equity0,
    equityCurrent: equity1,
    revenueGrowth: step1.minus(equity0),
    marginChange: step2.minus(step1),
    multipleChange: step3.minus(step2),
    netDebtChange: equity1.minus(step3),
    total: equity1.minus(equity0),
  };
}
