import { describe, expect, it } from 'vitest';
import { API_PREFIX, ROUTES } from '@pb/contracts';
import { stagingMachine } from '@pb/workflows';
import definitions from '../../../../../config/definitions.json';
import {
  fileFindingsFixture,
  intakeFileDetailFixture,
  intakeFileFixture,
  intakeRowFixture,
  intakeRows,
} from '../../test/fixtures-intake.js';
import {
  approvableRows,
  candidatesText,
  COMMAND_ROLES,
  commandResult,
  countsLine,
  dayOf,
  describeChange,
  EMPTY_FILE_PROBLEM,
  exactMoney,
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
  noRowsState,
  rejectableRows,
  rowSubject,
  sampleFileName,
  sampleUrl,
  uploadSizeProblem,
} from './intake.js';

const counts = intakeFileFixture().counts;

describe('intake helpers', () => {
  it('reads the upload limit from config and refuses a larger or an empty file in plain words', () => {
    expect(MAX_UPLOAD_BYTES).toBe(definitions.intake.maxFileBytes);
    expect(uploadSizeProblem(MAX_UPLOAD_BYTES)).toBeNull();
    expect(uploadSizeProblem(1)).toBeNull();
    expect(uploadSizeProblem(2_000_001)).toBe('This file is 2.0 MB; the limit is 2 MB.');
    expect(uploadSizeProblem(3_450_000)).toBe('This file is 3.5 MB; the limit is 2 MB.');
    expect(uploadSizeProblem(0)).toBe('The file is empty.');
    expect(EMPTY_FILE_PROBLEM).toBe('The file is empty.');
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
    expect(countsLine(counts)).toBe('2 validated, 3 flagged, 1 promoted');
    expect(exceptionsText({ exceptions: 3, rowCount: 7 })).toBe('3');
    expect(exceptionsText({ exceptions: 0, rowCount: 0 })).toBe('-');
  });

  it('shows a figure to the cent, the placeholder for null, and what the file said when it is not a number', () => {
    expect(exactMoney('4140000.00')).toBe('$4,140,000.00');
    expect(exactMoney('1.5')).toBe('$1.50');
    expect(exactMoney('-250')).toBe('-$250.00');
    expect(exactMoney('1000000000000.00')).toBe('$1,000,000,000,000.00');
    expect(exactMoney(null)).toBe('-');
    expect(exactMoney('12,500,000')).toBe('12,500,000');
  });

  it('words a field change to the cent with the deal team label, and in $M only as the secondary scale', () => {
    expect(describeChange({ field: 'ebitdaLtm', before: '4140000.00', after: '3970000.00' })).toBe(
      'EBITDA $4,140,000.00 to $3,970,000.00',
    );
    expect(describeChange({ field: 'netDebt', before: null, after: '12500000.00' })).toBe(
      'Net debt - to $12,500,000.00',
    );
    expect(describeChange({ field: 'revenueLtm', before: '1.00', after: null })).toBe(
      'Revenue $1.00 to -',
    );
    // A restatement under $50,000 rounds to the same $M on both sides; the line itself never does.
    const small = { field: 'ebitdaLtm' as const, before: '4140000.00', after: '4141000.00' };
    expect(describeChange(small)).toBe('EBITDA $4,140,000.00 to $4,141,000.00');
    expect(exactMoney(small.before)).not.toBe(exactMoney(small.after));
    expect(describeChange(small, 'millions')).toBe('EBITDA $4.1M to $4.1M');
    expect(
      describeChange({ field: 'netDebt', before: null, after: '12500000.00' }, 'millions'),
    ).toBe('Net debt - to $12.5M');
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
    expect(filterRows(rows, { state: 'flagged', search: '' }).map((r) => r.rowNo)).toEqual([
      3, 4, 5,
    ]);
    expect(filterRows(rows, { state: '', search: 'inv-0004' }).map((r) => r.rowNo)).toEqual([2]);
    expect(filterRows(rows, { state: '', search: 'MERIDIAN' }).map((r) => r.rowNo)).toEqual([1, 4]);
    expect(filterRows(rows, { state: 'validated', search: 'summit' })).toEqual([]);
    expect(filterRows(rows, { state: '', search: 'summit' }).map((r) => r.rowNo)).toEqual([5, 7]);
  });

  it('picks the rows an approve or a reject applies to', () => {
    const rows = intakeRows();
    expect(approvableRows(rows).map((r) => r.rowNo)).toEqual([1, 2]);
    expect(rejectableRows(rows).map((r) => r.rowNo)).toEqual([3, 4, 5]);
    expect(approvableRows([intakeRowFixture({ status: 'approved' })])).toEqual([]);
  });

  it('offers commands to the roles the contract names on the commands route, never a copy of them', () => {
    const route = ROUTES.find(
      (r) => r.method === 'POST' && r.path === `${API_PREFIX}/intake/files/{id}/commands`,
    );
    expect(route).toBeDefined();
    expect(COMMAND_ROLES.length).toBeGreaterThan(0);
    expect(COMMAND_ROLES).toEqual(route?.roles);
    // The route agrees with the staging table: whoever may approve or reject a row may call it.
    const fromTable = new Set(
      stagingMachine.transitions
        .filter((t) => t.command === 'approve' || t.command === 'reject')
        .flatMap((t) => t.roles),
    );
    expect(new Set(COMMAND_ROLES)).toEqual(fromTable);
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
    expect(commandResult(counts, { ...counts, validated: 0, promoted: 3 }, 'approve')).toBe(
      '2 rows promoted',
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

  it('tells a staged-nothing file from one whose every row sits behind a wall', () => {
    expect(noRowsState(intakeFileDetailFixture())).toBeNull();
    expect(noRowsState(intakeFileDetailFixture({ hiddenRows: 2 }))).toBeNull();
    expect(noRowsState(intakeFileDetailFixture({ rowCount: 0, rows: [], hiddenRows: 0 }))).toEqual({
      title: 'No rows were staged',
      detail: 'The file holds no data lines.',
    });
    expect(
      noRowsState(
        intakeFileDetailFixture({
          rowCount: 0,
          rows: [],
          hiddenRows: 0,
          fileFindings: fileFindingsFixture(),
        }),
      ),
    ).toEqual({
      title: 'No rows were staged',
      detail: 'The file was refused before any row was read; the file findings above say why.',
    });
    expect(noRowsState(intakeFileDetailFixture({ rowCount: 3, rows: [], hiddenRows: 3 }))).toEqual({
      title: 'Every row in this file is linked to positions you cannot see',
      detail:
        'The tiles above count every row in the file. Someone with access to those positions reviews them.',
    });
    // The contract allows a count with no visible and no hidden rows; the page says so, never "none staged".
    expect(noRowsState(intakeFileDetailFixture({ rowCount: 2, rows: [], hiddenRows: 0 }))).toEqual({
      title: 'No rows in this file are visible to you',
      detail: 'The file holds 2 rows; none of them is in your view.',
    });
  });
});
