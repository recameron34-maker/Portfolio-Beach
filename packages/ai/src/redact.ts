/*
 * Deterministic redaction before any model call (SEC-8.7): bank details and personal identifiers
 * become `[redacted:<kind>]`. The counts are what gets logged (SEC-8.9); the text never is. The
 * filters prefer redacting a little too much over missing a detail: a figure that happens to look
 * like an identifier is lost to one extraction, a bank detail that reaches a model is not
 * recoverable. Sponsor reports write figures with thousands separators, decimals or in millions,
 * which none of the patterns match.
 */

export const REDACTION_KINDS = [
  'email',
  'iban',
  'swift',
  'account',
  'routing',
  'ssn',
  'phone',
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

export interface RedactionResult {
  text: string;
  /** Replacements made, per kind (every kind is present, zero when none). */
  counts: Record<RedactionKind, number>;
}

export function redactionMarker(kind: RedactionKind): string {
  return `[redacted:${kind}]`;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** ISO 13616: country, two check digits, 11 to 30 more characters, written solid or in groups of four. */
const IBAN = /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b/g;

/** A BIC named as such: "SWIFT" or "BIC", then up to ten separator characters, then the 8 or 11 character code. */
const SWIFT_NAMED =
  /\b(swift|bic)\b([^A-Za-z0-9\n]{0,10})([A-Za-z]{6}[A-Za-z0-9]{2}(?:[A-Za-z0-9]{3})?)\b/gi;
/** A bare BIC whose location code carries a digit (six letters, then "2L", "33" and the like), which no heading word has. */
const SWIFT_BARE = /\b[A-Z]{6}(?:[A-Z]\d|\d[A-Z0-9])(?:[A-Z0-9]{3})?\b/g;

/** "account no", "account number", "account #" or "a/c", then the digits (spaces or hyphens inside allowed). */
const ACCOUNT =
  /\b(account\s*(?:no|number|num)\b\.?|account\s*#|a\/c)(\s*[:#]?\s*)(\d(?:[\d -]{4,30})?\d)\b/gi;

/** Nine bare digits that are not part of a separated or decimal figure; the routing number checksum (ABA) decides below. */
const ROUTING = /(?<![\d,.])\b(\d{9})\b(?![.,]\d)/g;

const SSN = /\b\d{3}[ -]\d{2}[ -]\d{4}\b/g;

/** North American forms with separators (a bare ten-digit figure is not touched), and "+" international forms. */
const PHONE_NA = /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)[ .-]?|\b\d{3}[ .-])\d{3}[ .-]\d{4}\b/g;
const PHONE_INTL = /\+\d{1,3}(?:[ .-]\d{2,4}){2,4}\b/g;

/** The ABA routing number checksum: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) is a multiple of ten. */
export function isAbaRoutingNumber(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const d = [...digits].map(Number);
  const sum =
    3 * ((d[0] ?? 0) + (d[3] ?? 0) + (d[6] ?? 0)) +
    7 * ((d[1] ?? 0) + (d[4] ?? 0) + (d[7] ?? 0)) +
    ((d[2] ?? 0) + (d[5] ?? 0) + (d[8] ?? 0));
  return sum % 10 === 0;
}

/**
 * Replaces every email address, IBAN, SWIFT/BIC, account number, US routing number, US SSN and
 * phone number with `[redacted:<kind>]` and counts what it replaced. Kinds are applied in the
 * order of REDACTION_KINDS, so an email address is never half eaten by the phone pattern.
 */
export function redact(text: string): RedactionResult {
  const counts = Object.fromEntries(REDACTION_KINDS.map((kind) => [kind, 0])) as Record<
    RedactionKind,
    number
  >;
  const hit = (kind: RedactionKind): string => {
    counts[kind] += 1;
    return redactionMarker(kind);
  };
  let out = text;
  out = out.replace(EMAIL, () => hit('email'));
  out = out.replace(IBAN, () => hit('iban'));
  out = out.replace(SWIFT_NAMED, (_m, word: string, gap: string) => `${word}${gap}${hit('swift')}`);
  out = out.replace(SWIFT_BARE, () => hit('swift'));
  out = out.replace(ACCOUNT, (_m, word: string, gap: string) => `${word}${gap}${hit('account')}`);
  out = out.replace(ROUTING, (match: string) =>
    isAbaRoutingNumber(match) ? hit('routing') : match,
  );
  out = out.replace(SSN, () => hit('ssn'));
  out = out.replace(PHONE_NA, () => hit('phone'));
  out = out.replace(PHONE_INTL, () => hit('phone'));
  return { text: out, counts };
}
