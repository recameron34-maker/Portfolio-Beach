import { describe, expect, it } from 'vitest';
import definitions from '../../../config/definitions.json' with { type: 'json' };
import { INTAKE_DEFAULTS, intakeDecimal, intakeWholeNumber } from './settings.js';

const intake = (overrides: Record<string, unknown>): unknown => ({
  intake: { ...definitions.intake, ...overrides },
});

describe('the intake thresholds the sample drops read (CLAUDE.md rule 9)', () => {
  it('reads the committed file, or the documented default for a key it does not carry yet', () => {
    const file = definitions.intake as Record<string, unknown>;
    expect(intakeDecimal('weeklyVarianceThresholdPct')).toBe(
      'weeklyVarianceThresholdPct' in file
        ? String(file.weeklyVarianceThresholdPct)
        : INTAKE_DEFAULTS.weeklyVarianceThresholdPct,
    );
    expect(intakeWholeNumber('weeklyStaleDays')).toBe(
      'weeklyStaleDays' in file ? file.weeklyStaleDays : INTAKE_DEFAULTS.weeklyStaleDays,
    );
    expect(intakeDecimal('weeklyVarianceThresholdPct', { intake: {} })).toBe('0.1');
    expect(intakeWholeNumber('weeklyStaleDays', { intake: {} })).toBe(10);
    expect(intakeDecimal('lookthroughNavTolerancePct', {})).toBe('0.02');
    expect(intakeDecimal('lookthroughCostToleranceUsd', null)).toBe('1');
  });

  it('takes a value the file carries as plain decimal digits', () => {
    expect(
      intakeDecimal('weeklyVarianceThresholdPct', intake({ weeklyVarianceThresholdPct: 0.25 })),
    ).toBe('0.25');
    expect(
      intakeDecimal('lookthroughCostToleranceUsd', intake({ lookthroughCostToleranceUsd: 1 })),
    ).toBe('1');
    expect(intakeWholeNumber('weeklyStaleDays', intake({ weeklyStaleDays: 14 }))).toBe(14);
  });

  it('stops on a value that is present but unusable, naming the key', () => {
    for (const bad of ['0.1', 0, -1, Number.NaN, null, true])
      expect(() =>
        intakeDecimal('weeklyVarianceThresholdPct', intake({ weeklyVarianceThresholdPct: bad })),
      ).toThrow('intake.weeklyVarianceThresholdPct');
    for (const bad of ['10', 1.5, -1, null])
      expect(() => intakeWholeNumber('weeklyStaleDays', intake({ weeklyStaleDays: bad }))).toThrow(
        'intake.weeklyStaleDays',
      );
  });
});
