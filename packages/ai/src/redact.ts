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
  'tax_id',
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

/** ISO 13616: country, two check digits, 11 to 30 more characters, written solid or in groups of four, in either case. */
const IBAN = /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b/gi;

/**
 * A BIC named as such: "SWIFT" or "BIC", up to two label words ("code", "no.", "number", "id"),
 * up to ten separator characters, then the 8 or 11 character code (a letter-only location code
 * such as "FF" included, since the label says what follows).
 */
const SWIFT_NAMED =
  /\b((?:swift|bic)\b(?:[^A-Za-z0-9\n]{0,10}(?:code|no|number|num|id)\b\.?){0,2})([^A-Za-z0-9\n]{0,10})([A-Za-z]{6}[A-Za-z0-9]{2}(?:[A-Za-z0-9]{3})?)\b/gi;
/** A bare BIC whose location code carries a digit (six letters, then "2L", "33" and the like), which no heading word has. */
const SWIFT_BARE = /\b[A-Z]{6}(?:[A-Z]\d|\d[A-Z0-9])(?:[A-Z0-9]{3})?\b/g;

/**
 * An account number after a label that can mean nothing else ("account no", "acct", "a/c",
 * "account #", "FFC", "for further credit to"), then at most eight characters that are neither
 * letters nor digits, then 2 to 20 digits (spaces or hyphens between them allowed).
 */
const ACCOUNT_LABELLED =
  /\b((?:account|acct)\.?\s*(?:no|number|num)\b\.?|(?:account|acct)\s*#|a\/c(?:\s*(?:no|number|num)\b\.?)?|acct\b\.?|ffc\b|for\s+(?:further\s+)?credit\s+to(?:\s+(?:the\s+)?account)?\b)([^\dA-Za-z\n]{0,8})((?:\d[ -]?){1,19}\d)\b/gi;
/**
 * The bare word "account" ("Account: 1234567890", "bank account 1234567890123"), then 6 to 20
 * digits within the same gap: the word alone is ordinary report text, so a short figure after it
 * is left alone, and a thousands separator or a decimal point ends the digits as everywhere here.
 */
const ACCOUNT_BARE = /\b(account)\b([^\dA-Za-z\n]{0,8})((?:\d[ -]?){5,19}\d)\b/gi;

/** Nine bare digits that are not part of a separated or decimal figure; the routing number checksum (ABA) decides below. */
const ROUTING = /(?<![\d,.])\b(\d{9})\b(?![.,]\d)/g;

const SSN = /\b\d{3}[ -]\d{2}[ -]\d{4}\b/g;

/** A US employer identification number (EIN): two digits, a hyphen, seven digits. */
const TAX_ID = /\b\d{2}-\d{7}\b/g;

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
 * Replaces every email address, IBAN, SWIFT/BIC, account number, US routing number, US SSN, US
 * EIN and phone number with `[redacted:<kind>]` and counts what it replaced. Kinds are applied
 * in the order of REDACTION_KINDS, so an email address is never half eaten by the phone pattern.
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
  const keepLabel = (_m: string, word: string, gap: string): string =>
    `${word}${gap}${hit('account')}`;
  out = out.replace(ACCOUNT_LABELLED, keepLabel);
  out = out.replace(ACCOUNT_BARE, keepLabel);
  out = out.replace(ROUTING, (match: string) =>
    isAbaRoutingNumber(match) ? hit('routing') : match,
  );
  out = out.replace(SSN, () => hit('ssn'));
  out = out.replace(TAX_ID, () => hit('tax_id'));
  out = out.replace(PHONE_NA, () => hit('phone'));
  out = out.replace(PHONE_INTL, () => hit('phone'));
  return { text: out, counts };
}
