import type { Decimal, DecimalInput } from './decimal.js';
import { D } from './decimal.js';

export interface RollForwardInput {
  beginNav: DecimalInput;
  contributions: DecimalInput;
  distributions: DecimalInput;
  gainLoss: DecimalInput;
  endNav: DecimalInput;
}

export interface CheckResult {
  passed: boolean;
  /** Actual minus expected. */
  difference: Decimal;
}

/** begin_nav + contributions - distributions + gain_loss = end_nav within the tolerance (docs/08 section 7). */
export function navRollForward(
  input: RollForwardInput,
  toleranceUsd: DecimalInput = '1',
): CheckResult {
  const expected = D(input.beginNav)
    .plus(D(input.contributions))
    .minus(D(input.distributions))
    .plus(D(input.gainLoss));
  const difference = D(input.endNav).minus(expected);
  return { passed: difference.abs().lte(D(toleranceUsd)), difference };
}

export interface QtdInput {
  endNav: DecimalInput;
  beginNavOfQuarter: DecimalInput;
  contributionsQtd: DecimalInput;
  distributionsQtd: DecimalInput;
}

/** QTD gain/loss = end_nav - begin_nav_of_quarter - contributions_qtd + distributions_qtd. */
export function qtdGainLoss(input: QtdInput): Decimal {
  return D(input.endNav)
    .minus(D(input.beginNavOfQuarter))
    .minus(D(input.contributionsQtd))
    .plus(D(input.distributionsQtd));
}

/** This report's begin NAV must equal the last released report's end NAV, or an explanation must exist. */
export function priorReportTieOut(
  thisBeginNav: DecimalInput,
  lastReleasedEndNav: DecimalInput,
  explanation: string | null,
  toleranceUsd: DecimalInput = '1',
): CheckResult & { explained: boolean } {
  const difference = D(thisBeginNav).minus(D(lastReleasedEndNav));
  const ties = difference.abs().lte(D(toleranceUsd));
  const explained = !ties && explanation !== null && explanation.trim().length > 0;
  return { passed: ties || explained, difference, explained };
}
