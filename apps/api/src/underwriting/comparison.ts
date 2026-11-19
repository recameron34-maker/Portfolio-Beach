import type {
  Decimal,
  UnderwritingCase,
  UnderwritingForm,
  UnderwritingInputs,
  UnderwritingTolerances,
} from '@pb/calc';
import type { UnderwritingCaseVersion } from '@pb/contracts';
import {
  bridgeOf,
  coversDealType,
  entryAndCurrent,
  signedFlows,
} from '../analytics/value-creation.js';
import type { PositionInputs } from '../analytics/value-creation.js';
import { configDecimal, configError } from '../common/definitions.js';
import { str } from '../portfolio/metrics.js';
import type { OperatingRow } from '../portfolio/metrics.js';

/*
 * A position against its underwritten base case (docs/04 M9, docs/08 section 11, decision 0022),
 * pure: what underwritingComparison of @pb/calc is handed, built from the rows the service loaded
 * under the caller's row-level security. Nothing is worked out a second time here. The entry
 * snapshot, the current quarter and the company's bridge are the value creation card's own
 * (analytics/value-creation.ts), our flows, invested capital, distributions, gross MOIC and
 * gross IRR are the position's summary, and a loan's yield to maturity is the Credit terms'
 * (performance/performance.service.ts), so the comparison cannot disagree with any of them. Every
 * figure is handed over as it travels (a decimal string), which is what a page that works the
 * comparison out again starts from.
 */

/** The deal type whose positions hold a loan's base case. */
export const CREDIT_DEAL_TYPE = 'deal_type.private_credit';

/**
 * The form of the base case a position holds, from its deal type: plan points and exit terms for
 * an equity co-investment or a continuation vehicle, the underwritten yield and loss rate for a
 * private credit position. A primary fund holds none (null).
 */
export function underwritingFormOf(dealType: string): UnderwritingForm | null {
  if (coversDealType(dealType)) return 'equity';
  return dealType === CREDIT_DEAL_TYPE ? 'credit' : null;
}

/** The settings this module reads of config/definitions.json. */
export interface UnderwritingDefinitions {
  underwriting?: { onPlanTolerance?: unknown; irrTolerance?: unknown };
}

/**
 * `underwriting.onPlanTolerance` and `underwriting.irrTolerance`, never a default in code (rules
 * 9 and 10): a missing, unreadable or negative one is a configuration problem that names the key.
 */
export function tolerancesOf(
  definitions: UnderwritingDefinitions,
): Record<keyof UnderwritingTolerances, Decimal> {
  const read = (name: keyof UnderwritingTolerances): Decimal => {
    const key = `underwriting.${name}`;
    const value = configDecimal(definitions.underwriting?.[name], key);
    if (value.isNegative()) throw configError(key);
    return value;
  };
  return { onPlanTolerance: read('onPlanTolerance'), irrTolerance: read('irrTolerance') };
}

/** A version of a base case as the comparison reads it. */
export function calcCaseOf(
  version: Pick<
    UnderwritingCaseVersion,
    'form' | 'plannedExitDate' | 'exitMultiple' | 'grossMoic' | 'grossIrr' | 'points'
  >,
): UnderwritingCase {
  return {
    form: version.form,
    plannedExitDate: version.plannedExitDate,
    exitMultiple: version.exitMultiple,
    grossMoic: version.grossMoic,
    grossIrr: version.grossIrr,
    points: version.points,
  };
}

const figuresOf = (row: OperatingRow): UnderwritingInputs['quarters'][number] => ({
  periodEnd: row.periodEnd,
  revenueLtm: row.revenueLtm,
  ebitdaLtm: row.ebitdaLtm,
  netDebt: row.netDebt,
});

/**
 * What a position's comparison is worked out from, as of a date. The quarters are the approved
 * ones on or before the date (the comparison itself keeps those up to the current quarter, which
 * for a realized position stops at its exit). A loan reports no company quarter: it is handed
 * with none, and with its yield to maturity as the Performance tab shows it, which an equity
 * position has not (null).
 */
export function comparisonInputs(
  position: PositionInputs,
  asOf: string,
  yieldToMaturity: string | null = null,
): UnderwritingInputs {
  const { row, summary } = position;
  const { entry, current, forwardDated } = entryAndCurrent(position.operating, asOf, row.exitDate);
  const { bridge, reason } = bridgeOf(entry, current, forwardDated);
  return {
    asOf,
    isActive: row.isActive,
    entry:
      entry === null
        ? null
        : {
            periodEnd: entry.periodEnd,
            ebitdaLtm: entry.ebitdaLtm,
            ev: entry.ev,
            netDebt: entry.netDebt,
          },
    current: current === null ? null : figuresOf(current),
    quarters: position.operating
      .filter(
        (q) => !q.isEntrySnapshot && q.status === 'record_status.approved' && q.periodEnd <= asOf,
      )
      .map(figuresOf),
    // The drivers as the value creation card carries them, to the place.
    bridge:
      bridge === null
        ? null
        : {
            ebitdaGrowth: str(bridge.ebitdaGrowth)!,
            multipleExpansion: str(bridge.multipleExpansion)!,
            debtPaydown: str(bridge.debtPaydown)!,
            total: str(bridge.total)!,
          },
    bridgeNotCalculable: reason,
    flows: signedFlows(position, asOf),
    invested: summary.invested,
    distributions: summary.distributions,
    grossMoic: summary.grossMoic,
    grossIrr: summary.grossIrr,
    irrFlag: summary.irrFlag,
    yieldToMaturity,
  };
}
