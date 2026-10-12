import { describe, expect, it } from 'vitest';
import { stagingMachine } from '@pb/workflows';
import definitions from '../../../../../config/definitions.json';
import { intakeFileFixture, intakeRowFixture, intakeRows } from '../../test/fixtures-intake.js';
import {
  approvableRows,
  candidatesText,
  commandResult,
  countsLine,
  dayOf,
  describeChange,
  exceptionsText,
  filterRows,
  findingDetail,
  findingTone,
  hiddenRowsNote,
  INTAKE_FILTER_STATES,
  intakeActions,
  isStagingState,
  linkNote,
  MAX_UPLOAD_BYTES,
  rejectableRows,
  rowSubject,
  sampleFileName,
  sampleUrl,
  uploadSizeProblem,
} from './intake.js';

const counts = intakeFileFixture().counts;

describe('intake helpers', () => {
  it('reads the upload limit from config and refuses a larger file in plain words', () => {
    expect(MAX_UPLOAD_BYTES).toBe(definitions.intake.maxFileBytes);
    expect(uploadSizeProblem(MAX_UPLOAD_BYTES)).toBeNull();
    expect(uploadSizeProblem(2_000_001)).toBe('This file is 2.0 MB; the limit is 2 MB.');
    expect(uploadSizeProblem(3_450_000)).toBe('This file is 3.5 MB; the limit is 2 MB.');
  });

  it('names the preview samples by scenario, relative to the page', () => {
    expect(sampleFileName('update')).toBe('accounting-update.csv');
    expect(sampleUrl('defects')).toBe('preview/samples/accounting-defects.csv');
  });

  it('filters by the states the staging machine knows, not every one of them', () => {
    for (const s of INTAKE_FILTER_STATES) expect(stagingMachine.states).toContain(s);
    expect(INTAKE_FILTER_STATES).not.toContain('new');
    expect(INTAKE_FILTER_STATES).not.toContain('approved');
    expect(isStagingState('flagged')).toBe(true);
    expect(isStagingState('Locked')).toBe(false);
  });

  it('shows the date part of a timestamp and the counts a reviewer needs', () => {
    expect(dayOf('2025-07-01T09:15:00.000Z')).toBe('Jul 1, 2025');
    expect(dayOf('not a date')).toBe('-');
    expect(countsLine(counts)).toBe('3 validated, 2 flagged, 1 promoted');
    expect(exceptionsText({ exceptions: 3, rowCount: 7 })).toBe('3');
    expect(exceptionsText({ exceptions: 0, rowCount: 0 })).toBe('-');
  });

  it('words a field change in $M with the deal team label', () => {
    expect(describeChange({ field: 'ebitdaLtm', before: '4140000.00', after: '3970000.00' })).toBe(
      'EBITDA $4.1M to $4.0M',
    );
    expect(describeChange({ field: 'netDebt', before: null, after: '12500000.00' })).toBe(
      'Net debt - to $12.5M',
    );
    expect(describeChange({ field: 'revenueLtm', before: '1.00', after: null })).toBe(
      'Revenue $0.0M to -',
    );
  });

  it('grades findings by severity and words expected and actual', () => {
    expect(findingTone('error')).toBe('bad');
    expect(findingTone('warning')).toBe('watch');
    const base = { ruleId: 'X', severity: 'warning' as const, message: 'm', field: null };
    expect(findingDetail({ ...base, expected: '2024-06-30', actual: '2024-06-16' })).toBe(
      'Expected 2024-06-30, actual 2024-06-16',
    );
    expect(findingDetail({ ...base, expected: null, actual: '2024-06-16' })).toBe(
      'Actual 2024-06-16',
    );
    expect(findingDetail({ ...base, expected: 'x', actual: null })).toBe('Expected x');
    expect(findingDetail({ ...base, expected: null, actual: null })).toBeNull();
  });

  it('names a row by its linked investment, else by what the file said, with why it did not link', () => {
    const rows = intakeRows();
    const [unchanged, , , unmatched, guarded] = rows;
    expect(rowSubject(unchanged!)).toEqual({
      investmentNumber: 'INV-0001',
      companyName: 'Meridian Data Partners',
    });
    expect(rowSubject(unmatched!)).toEqual({
      investmentNumber: null,
      companyName: 'Meridian Data Partner',
    });
    expect(linkNote(unchanged!.link)).toBeNull();
    expect(linkNote(unmatched!.link)).toBe('no match');
    expect(linkNote(guarded!.link)).toBe('match guard');
    expect(linkNote({ ...guarded!.link, status: 'ambiguous' })).toBe('ambiguous');
    expect(candidatesText(unmatched!.link.candidates)).toBe(
      'Candidates: INV-0001 Meridian Data Partners (near miss)',
    );
    expect(candidatesText(guarded!.link.candidates)).toBe(
      'Candidates: INV-0013 Summit Services Co (match guard)',
    );
    expect(candidatesText([])).toBeNull();
  });

  it('filters in the browser by state and by a search over number and company', () => {
    const rows = intakeRows();
    expect(filterRows(rows, { state: '', search: '' })).toHaveLength(7);
    expect(filterRows(rows, { state: 'flagged', search: '' }).map((r) => r.rowNo)).toEqual([4, 5]);
    expect(filterRows(rows, { state: '', search: 'inv-0004' }).map((r) => r.rowNo)).toEqual([2]);
    expect(filterRows(rows, { state: '', search: 'MERIDIAN' }).map((r) => r.rowNo)).toEqual([1, 4]);
    expect(filterRows(rows, { state: 'validated', search: 'summit' })).toEqual([]);
    expect(filterRows(rows, { state: '', search: 'summit' }).map((r) => r.rowNo)).toEqual([5, 7]);
  });

  it('picks the rows an approve or a reject applies to', () => {
    const rows = intakeRows();
    expect(approvableRows(rows).map((r) => r.rowNo)).toEqual([1, 2, 3]);
    expect(rejectableRows(rows).map((r) => r.rowNo)).toEqual([4, 5]);
    expect(approvableRows([intakeRowFixture({ status: 'approved' })])).toEqual([]);
  });

  it('offers the actions to operations and the deal team from the staging table', () => {
    const rows = intakeRows();
    const ops = intakeActions(['operations'], rows);
    expect(ops.approve).toEqual({ offered: true, enabled: true, title: null });
    expect(ops.reject).toEqual({ offered: true, enabled: true, title: null });

    const deal = intakeActions(['deal_team'], rows);
    expect(deal.approve.enabled).toBe(true);
    expect(deal.reject).toEqual({ offered: true, enabled: false, title: 'Needs operations' });

    for (const role of ['approver', 'auditor', 'viewer', 'platform_admin']) {
      const gate = intakeActions([role], rows);
      expect(gate.approve.offered, role).toBe(false);
      expect(gate.reject.offered, role).toBe(false);
    }

    // Rows the reviewer cannot see are not theirs to act on, however the file's counts read.
    const nothing = intakeActions(['operations'], [intakeRowFixture({ status: 'promoted' })]);
    expect(nothing.approve).toEqual({
      offered: true,
      enabled: false,
      title: 'No validated rows you can see to approve',
    });
    expect(nothing.reject).toEqual({
      offered: true,
      enabled: false,
      title: 'No flagged rows you can see to reject',
    });
  });

  it('reports what a command did from the counts before and after it', () => {
    expect(commandResult(counts, { ...counts, validated: 0, promoted: 4 }, 'approve')).toBe(
      '3 rows promoted',
    );
    expect(commandResult(counts, { ...counts, flagged: 1, rejected: 2 }, 'reject')).toBe(
      '1 row rejected',
    );
    expect(commandResult(counts, counts, 'approve')).toBe('0 rows promoted');
  });

  it('says how many rows sit behind a wall without naming them', () => {
    expect(hiddenRowsNote(0)).toBeNull();
    expect(hiddenRowsNote(1)).toBe('1 row is linked to positions you cannot see');
    expect(hiddenRowsNote(2)).toBe('2 rows are linked to positions you cannot see');
  });
});
