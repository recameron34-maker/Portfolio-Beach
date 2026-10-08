import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { fmtDate } from '../common/dates.js';
import { ProblemError } from '../common/problem.js';

/* The shared helpers every service imports instead of keeping its own copy (CLAUDE.md rule 7). */

describe('fmtDate: dates in sentences', () => {
  it('writes the short month, the day without padding and the year', () => {
    expect(fmtDate('2025-03-31')).toBe('Mar 31, 2025');
    expect(fmtDate('2024-02-09')).toBe('Feb 9, 2024');
    expect(fmtDate('1999-12-01')).toBe('Dec 1, 1999');
  });
});

describe('single-key cursors share the composite cursor helpers', () => {
  it('encodes one key exactly as plain base64url and reads it back', () => {
    for (const key of ['INV-0012', '123456789', 'Kelpwood Capital Partners']) {
      const cursor = encodeCursor([key]);
      expect(cursor).toBe(Buffer.from(key, 'utf8').toString('base64url'));
      expect(decodeCursor(cursor, /^(.*)$/s)).toEqual([key]);
    }
  });

  it('answers a forged cursor with a 400 validation problem', () => {
    const forged = encodeCursor(['1; drop table x']);
    expect(() => decodeCursor(forged, /^(\d{1,19})$/)).toThrow(ProblemError);
    try {
      decodeCursor(forged, /^(\d{1,19})$/);
    } catch (error) {
      expect((error as ProblemError).getStatus()).toBe(400);
      expect((error as ProblemError).code).toBe('validation');
    }
  });
});
