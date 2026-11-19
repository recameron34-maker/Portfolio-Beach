/*
 * References to the build guide inside a sentence a person reads: a control ("SEC-12.3"), a
 * document section ("docs/18 section 4", "docs/04 M8") or a module ("M8"). The API cites them in
 * its refusals, for the audit trail and the engineer; the page shows the sentence without them.
 * The two patterns spell a reference out twice each, as literals, so neither is built from a
 * string at run time.
 */

/** A parenthesis that holds nothing but references: " (SEC-12.2, SEC-12.3)". */
const ONLY_REFERENCES =
  / ?\((?:docs\/\d{2}(?: sections? \d+(?: and \d+)?)?(?: M\d{1,2})?|SEC-\d+(?:\.\d+)?|M\d{1,2})(?:(?:, | and |; )(?:docs\/\d{2}(?: sections? \d+(?: and \d+)?)?(?: M\d{1,2})?|SEC-\d+(?:\.\d+)?|M\d{1,2}))*\)/g;
/** References that close a parenthesis which says something else first: "(30 days, SEC-12.3)". */
const TRAILING_REFERENCES =
  /(?:, |; )(?:docs\/\d{2}(?: sections? \d+(?: and \d+)?)?(?: M\d{1,2})?|SEC-\d+(?:\.\d+)?|M\d{1,2})(?:(?:, | and )(?:docs\/\d{2}(?: sections? \d+(?: and \d+)?)?(?: M\d{1,2})?|SEC-\d+(?:\.\d+)?|M\d{1,2}))*\)/g;

/** The sentence without its references to the build guide; everything else as it came. */
export function withoutReferences(text: string): string {
  return text.replace(ONLY_REFERENCES, '').replace(TRAILING_REFERENCES, ')');
}
