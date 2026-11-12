import { describe, expect, it } from 'vitest';
import definitions from '../../../config/definitions.json' with { type: 'json' };
import { IntakeSettingsError, intakeSettingsFrom } from './settings.js';
import { countsOf, emptyCounts, fileStatusOf } from './staging.js';
import type { StagingCounts } from './staging.js';

describe('intake settings from config/definitions.json', () => {
  it('maps the repo file to the rule config as plain decimal digits, never exponent form', () => {
    expect(intakeSettingsFrom(definitions)).toEqual({
      maxRows: 5000,
      maxFileBytes: 2_000_000,
      toleranceDays: 7,
      rules: {
        revenueMinUsd: '1000000',
        revenueMaxUsd: '50000000000',
        fairValueTieToleranceUsd: '1',
        quarterOverQuarterMaxChangePct: '0.5',
        yearOverYearMaxChangePct: '1',
        staleQuarters: 2,
        evToEbitdaMax: '60',
        ebitdaMarginAbsMax: '1',
        figureScale: 2,
        figureIntegerDigits: 18,
        minPeriodYear: 1900,
        periodEndToleranceDays: 7,
      },
    });
  });

  it('accepts decimal strings and ignores keys it does not read', () => {
    const settings = intakeSettingsFrom({
      ...definitions,
      _note: 'other settings live here too',
      intake: { ...definitions.intake, quarterOverQuarterMaxChangePct: '0.25' },
      unitSanityBoundsUsd: { revenueMin: '2500000.50', revenueMax: 1e9 },
    });
    expect(settings.rules.quarterOverQuarterMaxChangePct).toBe('0.25');
    expect(settings.rules.revenueMinUsd).toBe('2500000.5');
    expect(settings.rules.revenueMaxUsd).toBe('1000000000');
  });

  it('names the first missing or unusable key and never substitutes a default', () => {
    const { intake, ...rest } = definitions;
    const withIntake = (key: string, value: unknown): Record<string, unknown> => {
      const block: Record<string, unknown> = { ...intake };
      if (value === undefined) delete block[key];
      else block[key] = value;
      return { ...rest, intake: block };
    };
    const keyOf = (input: unknown): string => {
      try {
        intakeSettingsFrom(input);
      } catch (error) {
        if (error instanceof IntakeSettingsError) return error.key;
        throw error;
      }
      throw new Error('expected a refusal');
    };
    expect(keyOf(rest)).toBe('intake');
    expect(keyOf(withIntake('maxRowsPerFile', undefined))).toBe('intake.maxRowsPerFile');
    expect(keyOf(withIntake('maxFileBytes', -1))).toBe('intake.maxFileBytes');
    expect(keyOf(withIntake('staleQuarters', 1.5))).toBe('intake.staleQuarters');
    expect(keyOf(withIntake('evToEbitdaMax', 'sixty'))).toBe('intake.evToEbitdaMax');
    expect(keyOf({ ...definitions, priorYearPeriodEndToleranceDays: '7' })).toBe(
      'priorYearPeriodEndToleranceDays',
    );
    expect(keyOf({ ...definitions, unitSanityBoundsUsd: { revenueMin: 1 } })).toBe(
      'unitSanityBoundsUsd.revenueMax',
    );
    expect(keyOf(null)).toBe('intake');
    expect(() => intakeSettingsFrom(rest)).toThrow(
      'config/definitions.json is missing a usable intake',
    );
  });
});

describe('staging counts and the file status (docs/18 section 2)', () => {
  it('counts rows per state', () => {
    expect(countsOf([])).toEqual(emptyCounts());
    expect(countsOf(['validated', 'flagged', 'validated', 'promoted'])).toEqual({
      new: 0,
      validated: 2,
      flagged: 1,
      approved: 0,
      rejected: 0,
      promoted: 1,
    });
  });

  it('sums the rows up into the file status the contract describes', () => {
    const counts = (partial: Partial<StagingCounts>): StagingCounts =>
      Object.assign(emptyCounts(), partial);
    expect(fileStatusOf(emptyCounts())).toBe('new');
    expect(fileStatusOf(counts({ flagged: 1, promoted: 9 }))).toBe('flagged');
    expect(fileStatusOf(counts({ validated: 1, promoted: 9 }))).toBe('validated');
    expect(fileStatusOf(counts({ new: 1 }))).toBe('validated');
    expect(fileStatusOf(counts({ approved: 1, rejected: 2 }))).toBe('validated');
    expect(fileStatusOf(counts({ promoted: 2, rejected: 1 }))).toBe('promoted');
    expect(fileStatusOf(counts({ rejected: 3 }))).toBe('rejected');
  });
});
