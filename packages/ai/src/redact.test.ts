import { describe, expect, it } from 'vitest';
import { REDACTION_KINDS, isAbaRoutingNumber, redact } from './redact.js';

/*
 * Every value below is an obviously fake pattern (reserved example domains, 555-01xx numbers,
 * all-zero identifiers, "TEST" bank codes); none belongs to anyone.
 */

const zero = Object.fromEntries(REDACTION_KINDS.map((k) => [k, 0]));

describe('redact (SEC-8.7)', () => {
  it('leaves ordinary report text and figures alone and reports zero counts', () => {
    const text =
      'Revenue for the quarter ended June 30, 2025 was 12,345,678 dollars (USD 12.35m), up 8.5% on 2024-06-30. EBITDA margin 23.4%. Headcount 1,234. Net debt 1234567890 at cost.';
    const r = redact(text);
    expect(r.text).toBe(text);
    expect(r.counts).toEqual(zero);
  });

  it('redacts email addresses', () => {
    const r = redact('Contact ir@sponsor.example or ops.team@fund-admin.example for details.');
    expect(r.text).toBe('Contact [redacted:email] or [redacted:email] for details.');
    expect(r.counts.email).toBe(2);
  });

  it('redacts an IBAN written solid or in groups of four', () => {
    const solid = redact('Pay to GB00TEST00000000000000 by wire.');
    expect(solid.text).toBe('Pay to [redacted:iban] by wire.');
    const spaced = redact('IBAN GB00 TEST 0000 0000 0000 00 (example only). Total 12.5');
    expect(spaced.text).toBe('IBAN [redacted:iban] (example only). Total 12.5');
    expect(spaced.counts.iban).toBe(1);
  });

  it('redacts a SWIFT/BIC named as such, or bare when its location code carries a digit', () => {
    const named = redact('SWIFT: TESTGB2LXXX, an example only; BIC testus33 (example).');
    expect(named.text).toBe(
      'SWIFT: [redacted:swift], an example only; BIC [redacted:swift] (example).',
    );
    expect(named.counts.swift).toBe(2);
    const bare = redact('Correspondent TESTGB2L holds the account (example).');
    expect(bare.text).toBe('Correspondent [redacted:swift] holds the account (example).');
    // an all-caps heading word of eight letters is not a bank code
    expect(redact('ADJUSTED EBITDA and SCHEDULE of investments').counts.swift).toBe(0);
  });

  it('redacts account numbers after "account no", "account number", "account #" and "a/c"', () => {
    const r = redact(
      'Account no. 0000 0000 1234 (placeholder); account number: 000000001; A/C #00001234 (placeholder)',
    );
    expect(r.text).toBe(
      'Account no. [redacted:account] (placeholder); account number: [redacted:account]; A/C #[redacted:account] (placeholder)',
    );
    expect(r.counts.account).toBe(3);
    expect(redact('the account of the quarter').counts.account).toBe(0);
  });

  it('redacts a nine-digit number only when it passes the routing number checksum (ABA)', () => {
    expect(isAbaRoutingNumber('123456780')).toBe(true);
    expect(isAbaRoutingNumber('123456789')).toBe(false);
    expect(isAbaRoutingNumber('12345678')).toBe(false);
    const r = redact(
      'ABA routing number 123456780 (example); reference 123456789; total 123,456,780.',
    );
    expect(r.text).toBe(
      'ABA routing number [redacted:routing] (example); reference 123456789; total 123,456,780.',
    );
    expect(r.counts.routing).toBe(1);
    // a decimal figure of nine digits is a figure, not a routing number
    expect(redact('cost 123456780.00 dollars').counts.routing).toBe(0);
  });

  it('redacts US SSN patterns', () => {
    const r = redact('SSN 000-00-0000 and 000 00 0000 on file.');
    expect(r.text).toBe('SSN [redacted:ssn] and [redacted:ssn] on file.');
    expect(r.counts.ssn).toBe(2);
  });

  it('redacts phone numbers with separators and international forms, never a bare ten-digit figure', () => {
    const r = redact('Call (555) 555-0123, 555-555-0199, +1 555 555 0147 or +44 20 5550 0100.');
    expect(r.text).toBe(
      'Call [redacted:phone], [redacted:phone], [redacted:phone] or [redacted:phone].',
    );
    expect(r.counts.phone).toBe(4);
    expect(redact('revenue 5555550123 in dollars').counts.phone).toBe(0);
  });

  it('counts every kind on one page and never leaves the original text behind', () => {
    const page = [
      'Wire instructions (example): IBAN GB00TEST00000000000000, SWIFT TESTGB2L, a/c 00001234,',
      'routing 123456780. Questions to ir@sponsor.example or 555-555-0123. Tax id 000-00-0000.',
    ].join('\n');
    const r = redact(page);
    expect(r.counts).toEqual({
      email: 1,
      iban: 1,
      swift: 1,
      account: 1,
      routing: 1,
      ssn: 1,
      phone: 1,
    });
    for (const original of [
      'GB00TEST',
      'TESTGB2L',
      '00001234',
      '123456780',
      '@sponsor',
      '555-0123',
      '000-00-0000',
    ])
      expect(r.text).not.toContain(original);
    expect(r.text.split('\n')).toHaveLength(2);
  });
});
