import { describe, expect, it } from 'vitest';
import definitions from '../../../../../config/definitions.json';
import { weeklyFileFixture, weeklyRowFixture } from '../../test/fixtures-weekly.js';
import { MISSING } from '../../lib/format.js';
import { intakeActions, filterRows, noRowsState } from '../intake/intake.js';
import {
  ABOVE_THRESHOLD_LABEL,
  decisionText,
  isAboveThreshold,
  PRIOR_SOURCE_WORDS,
  priorNote,
  reportDateText,
  thresholdLabel,
  VARIANCE_THRESHOLD_PCT,
  varianceText,
  WEEKLY_FORBIDDEN,
  WEEKLY_META,
  weeklyCommandResult,
} from './weekly.js';

const counts = weeklyFileFixture().counts;

describe('weekly helpers', () => {
  it('reads the threshold from config and names it as a percentage', () => {
    expect(VARIANCE_THRESHOLD_PCT).toBe(definitions.intake.weeklyVarianceThresholdPct);
    expect(thresholdLabel(0.1)).toBe('10%');
    expect(thresholdLabel(0.025)).toBe('2.5%');
    expect(thresholdLabel()).toBe(thresholdLabel(VARIANCE_THRESHOLD_PCT));
  });

  it('shows a report date as a day when it is one, else as the file wrote it, and the placeholder when blank', () => {
    expect(reportDateText('2025-06-27')).toBe('Jun 27, 2025');
    expect(reportDateText('27/06/2025')).toBe('27/06/2025');
    expect(reportDateText(null)).toBe(MISSING);
  });

  it('names the prior by its source and date, or says there is none', () => {
    expect(priorNote({ priorSource: 'locked_mark', priorDate: '2025-03-31' })).toBe(
      'Locked mark, Mar 31, 2025',
    );
    expect(priorNote({ priorSource: 'weekly', priorDate: '2025-06-20' })).toBe(
      'Weekly value, Jun 20, 2025',
    );
    expect(priorNote({ priorSource: 'weekly', priorDate: null })).toBe('Weekly value');
    expect(priorNote({ priorSource: null, priorDate: null })).toBe('No prior on record');
    expect(Object.keys(PRIOR_SOURCE_WORDS).sort()).toEqual(['locked_mark', 'weekly']);
  });

  it('shows the variance as a signed percentage with one decimal, never 0 for not calculable', () => {
    expect(varianceText('0.03000000')).toBe('+3.0%');
    expect(varianceText('-0.04500000')).toBe('-4.5%');
    expect(varianceText('0.00000000')).toBe('0.0%');
    expect(varianceText('0.5')).toBe('+50.0%');
    expect(varianceText(null)).toBe(MISSING);
    expect(varianceText('n/a')).toBe(MISSING);
  });

  it('reads the threshold flag the API set, and never computes one', () => {
    expect(isAboveThreshold(weeklyRowFixture({ flag: 'above_threshold' }))).toBe(true);
    expect(isAboveThreshold(weeklyRowFixture({ flag: null, variancePct: '0.9' }))).toBe(false);
    expect(ABOVE_THRESHOLD_LABEL).toBe('Above threshold');
  });

  it('says what an approve or a reject did: rows promoted and Draft valuations created, or rows rejected', () => {
    const after = { ...counts, validated: 0, promoted: counts.promoted + 2 };
    expect(weeklyCommandResult(counts, after, 'approve', '(audited)')).toBe(
      '2 rows promoted (audited); 2 Draft valuations created',
    );
    const one = { ...counts, validated: 1, promoted: counts.promoted + 1 };
    expect(weeklyCommandResult(counts, one, 'approve', '(audited)')).toBe(
      '1 row promoted (audited); 1 Draft valuation created',
    );
    expect(weeklyCommandResult(counts, counts, 'approve', '(audited)')).toBe(
      '0 rows promoted (audited); 0 Draft valuations created',
    );
    const rejected = { ...counts, flagged: 0, rejected: counts.rejected + 3 };
    expect(weeklyCommandResult(counts, rejected, 'reject', '(audited)')).toBe(
      '3 rows rejected (audited)',
    );
  });

  it('shows a decision or the placeholder', () => {
    expect(decisionText(weeklyRowFixture())).toBe(MISSING);
    expect(decisionText(weeklyRowFixture({ decision: 'Approved' }))).toBe('Approved');
  });

  it('shares the intake gates, filters and empty states with the weekly rows', () => {
    const rows = [
      weeklyRowFixture(),
      weeklyRowFixture({ id: 'x', rowNo: 2, status: 'flagged' }),
      weeklyRowFixture({ id: 'y', rowNo: 3, status: 'promoted' }),
    ];
    const ops = intakeActions(['operations'], rows);
    expect(ops.approve.enabled).toBe(true);
    expect(ops.reject.enabled).toBe(true);
    const deal = intakeActions(['deal_team'], rows);
    expect(deal.approve.enabled).toBe(true);
    expect(deal.reject.enabled).toBe(false);
    expect(filterRows(rows, { state: 'flagged', search: '' }).map((r) => r.rowNo)).toEqual([2]);
    expect(filterRows(rows, { state: '', search: 'meridian' })).toHaveLength(3);
    expect(filterRows(rows, { state: '', search: 'nobody' })).toHaveLength(0);
    expect(
      noRowsState({ rowCount: 3, rows: [], hiddenRows: 3, fileFindings: [] })?.title,
    ).toContain('linked to positions you cannot see');
    expect(noRowsState({ rowCount: 3, rows, hiddenRows: 0, fileFindings: [] })).toBeNull();
  });

  it('never carries an em dash in its words', () => {
    for (const text of [WEEKLY_META, WEEKLY_FORBIDDEN.title, WEEKLY_FORBIDDEN.detail])
      expect(text).not.toContain(String.fromCharCode(0x2014));
  });
});
