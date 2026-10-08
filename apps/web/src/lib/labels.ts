import type { WatchFlagCode } from '@pb/contracts';
import type { Tone } from '../components/ui.js';
import { labelOf } from './format.js';

/** Short labels for the monitoring flags (docs/04 M9); the full message travels with each flag. */
export const WATCH_FLAG_LABELS: Record<WatchFlagCode, string> = {
  no_locked_valuation: 'No Locked valuation',
  stale_valuation: 'Stale',
  missing_prior_year: 'No prior year',
  negative_ebitda: 'Negative EBITDA',
  leverage_above_max: 'Leverage above limit',
  ebitda_decline: 'EBITDA decline',
  markdown: 'Markdown',
  covenant_breach: 'Covenant breach',
  covenant_waiver: 'Covenant waiver',
  payment_not_current: 'Payment not current',
  maturity_within_12_months: 'Maturity within 12 months',
  past_maturity: 'Past maturity',
};

export function watchFlagLabel(code: string): string {
  return (WATCH_FLAG_LABELS as Record<string, string | undefined>)[code] ?? labelOf(code);
}

/** Covenant and payment status codes: compliant or current is good, breach or default is bad, anything else watch. */
export function creditStatusTone(code: string | null): Tone {
  if (code === null) return 'neutral';
  const tail = code.slice(code.indexOf('.') + 1);
  if (tail === 'compliant' || tail === 'current') return 'good';
  if (tail === 'breach' || tail === 'default') return 'bad';
  return 'watch';
}

/** Plain-language reasons for an IRR that shows NM or the missing placeholder (docs/08). */
const IRR_FLAG_REASONS: Record<string, string> = {
  short_period: 'held for less than the minimum period',
  multiple_irr: 'the cash flows have more than one IRR',
  no_root: 'no rate fits the cash flows',
  same_sign: 'the cash flows have the same sign',
  insufficient_flows: 'too few cash flows',
  no_convergence: 'the calculation did not converge',
};

export function irrFlagHint(flag: string | null): string | undefined {
  if (flag === null) return undefined;
  const reason = IRR_FLAG_REASONS[flag] ?? labelOf(flag).toLowerCase();
  return flag === 'short_period' || flag === 'multiple_irr'
    ? `Not meaningful: ${reason}`
    : `Not calculable: ${reason}`;
}
