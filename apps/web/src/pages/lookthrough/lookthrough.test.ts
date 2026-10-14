import { afterEach, describe, expect, it } from 'vitest';
import { clearTaxonomyLabels, MISSING, registerTaxonomyLabels } from '../../lib/format.js';
import {
  lookthroughRowFixture,
  lookthroughRunDetailFixture,
  lookthroughRuns,
} from '../../test/fixtures-lookthrough.js';
import {
  approvedText,
  asOfFromFileName,
  describeDifference,
  isReconcileDate,
  mappedLabel,
  rowExceptionsText,
  runCountsLine,
  runStatusTone,
  runStatusWord,
  runSummary,
} from './lookthrough.js';

describe('look-through helpers', () => {
  afterEach(() => clearTaxonomyLabels());

  it('accepts only a real calendar date as the as-of to reconcile', () => {
    expect(isReconcileDate('2025-06-30')).toBe(true);
    expect(isReconcileDate(' 2025-06-30 ')).toBe(true);
    expect(isReconcileDate('2025-02-30')).toBe(false);
    expect(isReconcileDate('June 2025')).toBe(false);
    expect(isReconcileDate('')).toBe(false);
  });

  it('words a difference with the record first and the provider second, money to the cent', () => {
    expect(
      describeDifference({
        field: 'exposureAtNav',
        expected: '20000000.00',
        actual: '21500000.00',
      }),
    ).toBe('NAV $20,000,000.00 on record, provider $21,500,000.00');
    expect(
      describeDifference({
        field: 'sector',
        expected: 'sector.energy_transition',
        actual: 'Healthcare (sector.healthcare)',
      }),
    ).toBe('Sector sector.energy_transition on record, provider Healthcare (sector.healthcare)');
    expect(describeDifference({ field: 'exposureAtCost', expected: null, actual: '1.00' })).toBe(
      `Cost ${MISSING} on record, provider $1.00`,
    );
  });

  it('labels a mapped code with the taxonomy term and says when a label is unmapped', () => {
    expect(mappedLabel('Technology', 'sector.software')).toBe('Technology (Software)');
    registerTaxonomyLabels([{ code: 'geography.north_america', label: 'North America' }]);
    expect(mappedLabel('North America', 'geography.north_america')).toBe(
      'North America (North America)',
    );
    expect(mappedLabel('Other', null)).toBe('Other (unmapped)');
  });

  it('shows the record figure to the cent, or the placeholder when the record has none', () => {
    expect(approvedText('25000000.00')).toBe('$25,000,000.00');
    expect(approvedText(null)).toBe(MISSING);
  });

  it('summarizes a run: rows and exceptions are the run facts, matched and differences count the rows seen', () => {
    expect(runSummary(lookthroughRunDetailFixture())).toEqual({
      rows: 7,
      matched: 6,
      differences: 2,
      exceptions: 4,
    });
    expect(runSummary(lookthroughRunDetailFixture({ rows: [], hiddenRows: 7 }))).toEqual({
      rows: 7,
      matched: 0,
      differences: 0,
      exceptions: 4,
    });
  });

  it('words a run status: flagged holds differences, validated agrees, new had no extract', () => {
    expect([runStatusWord('flagged'), runStatusTone('flagged')]).toEqual(['Differences', 'watch']);
    expect([runStatusWord('validated'), runStatusTone('validated')]).toEqual(['Agrees', 'good']);
    expect([runStatusWord('new'), runStatusTone('new')]).toEqual(['No extract', 'neutral']);
    expect([runStatusWord('promoted'), runStatusTone('promoted')]).toEqual(['promoted', 'neutral']);
  });

  it('counts a run and a row in plain words', () => {
    expect(runCountsLine(lookthroughRuns()[0]!.counts)).toBe('1 agree, 6 flagged');
    expect(rowExceptionsText(lookthroughRowFixture())).toBeNull();
    expect(rowExceptionsText(lookthroughRowFixture({ exceptions: 1 }))).toBe('1 exception');
    expect(rowExceptionsText(lookthroughRowFixture({ exceptions: 2 }))).toBe('2 exceptions');
  });

  it('reads the as-of date from a run file name, and only a real date', () => {
    expect(asOfFromFileName('lookthrough-2025-06-30.json')).toBe('2025-06-30');
    expect(asOfFromFileName('lookthrough-2025-13-40.json')).toBeNull();
    expect(asOfFromFileName('other.json')).toBeNull();
  });
});
