/*
 * The SEC-12.4 alerts a capital notice carries (docs/04 M16): the instructions changed, the
 * notice uses urgency language, the due date is under the configured number of business days
 * away, the counterparty has no verified instruction. The look-alike sender domain alert waits
 * for the mail adapter (docs/11). Pure functions over what the service already read; no clock.
 * The business-day count and the alert list are the shared rules of @pb/workflows
 * (controls-capital.ts), which the preview simulation reads too; the urgency scan is the API's
 * own, since only the API reads a notice document.
 */
export { businessDaysBetween, noticeAlerts, weekdayOf } from '@pb/workflows';
export type { AlertInput } from '@pb/workflows';

/** Whitespace folded, case folded: a phrase matches across a line break in the notice text. */
const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** True when any configured phrase (capitalActivity.urgencyPhrases) appears in the text, case-insensitively. */
export function urgencyLanguageIn(text: string, phrases: readonly string[]): boolean {
  const folded = fold(text);
  return phrases.some((phrase) => fold(phrase).length > 0 && folded.includes(fold(phrase)));
}
