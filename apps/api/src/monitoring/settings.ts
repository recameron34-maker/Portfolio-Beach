import { realizationOutlookCode } from '@pb/contracts';
import type { RealizationOutlookCode } from '@pb/contracts';
import { configError } from '../common/definitions.js';

/*
 * The config the monitoring module reads from config/definitions.json (rule 9: config over
 * code). `realizationFlagEditableOnlyManually` is the guard docs/04 M9 asks for: the realization
 * outlook changes only by an explicit, audited edit, never by a rule or an agent. The route that
 * writes it checks the guard on every call, so a config change switches the edit off at once; a
 * missing or malformed key is a 500 'configuration' problem, never a default in code (rule 10).
 */

/** The taxonomy domain and prefix of the outlook codes (migration 0002: realization_outlook.none, .partial, .full). */
export const OUTLOOK_DOMAIN = 'realization_outlook';
const OUTLOOK_PREFIX = `${OUTLOOK_DOMAIN}.`;

/** The config key the outlook edit is guarded by. */
export const OUTLOOK_GUARD_KEY = 'realizationFlagEditableOnlyManually';

/** `definitions.realizationFlagEditableOnlyManually` as a boolean; anything else is a configuration problem. */
export function outlookEditableByHandOf(definitions: unknown): boolean {
  const value = (definitions as Record<string, unknown> | null | undefined)?.[OUTLOOK_GUARD_KEY];
  if (typeof value !== 'boolean') throw configError(OUTLOOK_GUARD_KEY);
  return value;
}

/** The taxonomy code of an outlook the contract names: 'full' is stored as 'realization_outlook.full'. */
export function outlookTermOf(code: RealizationOutlookCode): string {
  return `${OUTLOOK_PREFIX}${code}`;
}

/** The contract's outlook of a stored taxonomy code; a code outside the domain is a row the module cannot read. */
export function outlookCodeOf(term: string): RealizationOutlookCode {
  return realizationOutlookCode.parse(
    term.startsWith(OUTLOOK_PREFIX) ? term.slice(OUTLOOK_PREFIX.length) : term,
  );
}
