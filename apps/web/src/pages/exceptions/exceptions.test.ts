import { describe, expect, it } from 'vitest';
import {
  EXCEPTION_ID,
  exceptionFixture,
  exceptions,
  weeklyExceptionFixture,
} from '../../test/fixtures-exceptions.js';
import { FILE_ID } from '../../test/fixtures-intake.js';
import { RUN_ID } from '../../test/fixtures-lookthrough.js';
import { WEEKLY_FILE_ID } from '../../test/fixtures-weekly.js';
import {
  ageLabel,
  blockedReason,
  COMMAND_ROLES,
  commandResult,
  contextLink,
  EXCEPTION_STATES,
  exceptionActions,
  exceptionStateWord,
  exceptionTone,
  isExceptionState,
  isSeverity,
  isTicket,
  knownSources,
  parseExceptionsSearch,
  positionText,
  rowText,
  severityLabel,
  severityTone,
  sourceLabel,
  transitionLabel,
} from './exceptions.js';

describe('exceptions helpers', () => {
  it('reads the states from the transition table and recognizes them', () => {
    expect(EXCEPTION_STATES).toEqual(['open', 'acknowledged', 'resolved', 'wont_fix']);
    expect(isExceptionState('wont_fix')).toBe(true);
    expect(isExceptionState('closed')).toBe(false);
  });

  it('tones and words a severity and a state', () => {
    expect([
      severityTone('exception_severity.high'),
      severityLabel('exception_severity.high'),
    ]).toEqual(['bad', 'High']);
    expect(severityTone('exception_severity.medium')).toBe('watch');
    expect(severityTone('exception_severity.low')).toBe('neutral');
    expect(severityTone('other')).toBe('neutral');
    expect([exceptionTone('open'), exceptionStateWord('open')]).toEqual(['watch', 'Open']);
    expect([exceptionTone('acknowledged'), exceptionStateWord('acknowledged')]).toEqual([
      'brand',
      'Acknowledged',
    ]);
    expect([exceptionTone('resolved'), exceptionStateWord('resolved')]).toEqual([
      'good',
      'Resolved',
    ]);
    expect([exceptionTone('wont_fix'), exceptionStateWord('wont_fix')]).toEqual([
      'neutral',
      "Won't fix",
    ]);
  });

  it('names the intakes that open exceptions, and any other source in words', () => {
    expect(sourceLabel('lookthrough_reconcile')).toBe('Look-through reconcile');
    expect(sourceLabel('accounting_import')).toBe('Accounting import');
    expect(sourceLabel('ownership_check')).toBe('Ownership check');
    expect(knownSources([{ source: 'ownership_check' }, { source: 'accounting_import' }])).toEqual([
      'accounting_import',
      'lookthrough_reconcile',
      'ops_drop_import',
      'ownership_check',
      'weekly_import',
    ]);
  });

  it('links a look-through exception to its run, a staged row to its intake file and a staged value to its weekly file', () => {
    expect(contextLink(exceptionFixture())).toEqual({
      to: '/data/lookthrough/$id',
      params: { id: RUN_ID.defects },
      label: 'lookthrough-2025-06-30.json',
    });
    const accounting = exceptions().find((x) => x.id === EXCEPTION_ID.accounting)!;
    expect(contextLink(accounting)).toEqual({
      to: '/data/intake/$id',
      params: { id: FILE_ID.update },
      label: 'accounting-export-2025-06-30-update.csv',
    });
    expect(contextLink(weeklyExceptionFixture())).toEqual({
      to: '/data/weekly/$id',
      params: { id: WEEKLY_FILE_ID.update },
      label: 'weekly-values-2025-06-27-update.csv',
    });
    // An entity the pages do not show is named, never linked.
    expect(
      contextLink(exceptionFixture({ source: 'ownership_check', entity: 'core.investment' })),
    ).toBeNull();
    expect(
      contextLink(
        exceptionFixture({
          context: {
            intakeFileId: null,
            intakeFileName: null,
            rowNo: null,
            investmentId: null,
            investmentNumber: null,
            companyName: null,
          },
        }),
      ),
    ).toBeNull();
  });

  it('words the row and the position an exception is about, or nothing', () => {
    expect(rowText(exceptionFixture())).toBe('Row 2');
    expect(positionText(exceptionFixture())).toBe('INV-0004 Silverline Staffing Holdings');
    const unmatched = exceptions().find((x) => x.id === EXCEPTION_ID.unmatched)!;
    expect(rowText(unmatched)).toBe('Row 5');
    expect(positionText(unmatched)).toBeNull();
  });

  it('ages an exception in whole days by the calendar, never a negative age', () => {
    const now = new Date('2025-07-14T09:00:00Z');
    expect(ageLabel('2025-07-14T08:00:00.000Z', now)).toBe('today');
    expect(ageLabel('2025-07-13T08:00:00.000Z', now)).toBe('1 day');
    expect(ageLabel('2025-07-02T10:15:00.000Z', now)).toBe('11 days');
    expect(ageLabel('2025-07-15T10:15:00.000Z', now)).toBe('today');
  });

  it('reads the command roles from the contract and gates the transitions by the table', () => {
    expect(COMMAND_ROLES).toEqual(['operations']);
    const open = exceptionActions(['operations'], 'open');
    expect(open.offered).toBe(true);
    expect(open.ticket).toBe(true);
    expect(open.transitions.map((t) => [t.command, t.to, t.allowed, t.needsReason])).toEqual([
      ['acknowledge', 'acknowledged', true, false],
      ['resolve', 'resolved', true, true],
      ['wont_fix', 'wont_fix', true, true],
    ]);
    const acknowledged = exceptionActions(['operations'], 'acknowledged');
    expect(acknowledged.transitions.map((t) => t.command)).toEqual(['resolve', 'wont_fix']);
    const terminal = exceptionActions(['operations'], 'resolved');
    expect(terminal.transitions).toEqual([]);
    expect(terminal.ticket).toBe(true);
    const reader = exceptionActions(['deal_team', 'approver'], 'open');
    expect(reader).toEqual({ offered: false, transitions: [], ticket: false });
  });

  it('words a blocked button, a command and its result', () => {
    const [acknowledge] = exceptionActions(['operations'], 'open').transitions;
    expect(blockedReason(acknowledge!)).toBeNull();
    expect(blockedReason({ ...acknowledge!, allowed: false })).toBe('Needs operations');
    expect(transitionLabel('wont_fix')).toBe("Won't fix");
    expect(transitionLabel('acknowledge')).toBe('Acknowledge');
    const taken = exceptionFixture({ state: 'acknowledged', owner: 'Avery Castellanos' });
    expect(commandResult('acknowledge', taken)).toBe('Acknowledged, taken by Avery Castellanos');
    expect(commandResult('acknowledge', exceptionFixture({ state: 'acknowledged' }))).toBe(
      'Acknowledged',
    );
    expect(commandResult('resolve', exceptionFixture({ state: 'resolved' }))).toBe('Resolved');
    expect(commandResult('wont_fix', exceptionFixture({ state: 'wont_fix' }))).toBe(
      "Closed as won't fix",
    );
    expect(commandResult('set_ticket', exceptionFixture({ externalTicket: 'HD-1' }))).toBe(
      'Ticket HD-1 noted',
    );
    expect(commandResult('set_ticket', exceptionFixture())).toBe('Ticket cleared');
  });

  it('accepts a ticket of one line, 1 to 64 characters once trimmed', () => {
    expect(isTicket('HD-1042')).toBe(true);
    expect(isTicket('   ')).toBe(false);
    expect(isTicket('x'.repeat(64))).toBe(true);
    expect(isTicket('x'.repeat(65))).toBe(false);
  });

  it('keeps a known state and severity from the address and drops anything else, so a stale bookmark opens the queue', () => {
    expect(
      parseExceptionsSearch({
        file: RUN_ID.defects,
        state: 'open',
        source: 'weekly_import',
        severity: 'exception_severity.high',
      }),
    ).toEqual({
      file: RUN_ID.defects,
      state: 'open',
      source: 'weekly_import',
      severity: 'exception_severity.high',
    });
    expect(
      parseExceptionsSearch({ state: 'closed', severity: 'urgent', file: 7, source: '' }),
    ).toEqual({});
    expect(
      parseExceptionsSearch({ state: 'wont_fix', severity: 'exception_severity.low' }),
    ).toEqual({
      state: 'wont_fix',
      severity: 'exception_severity.low',
    });
    expect(parseExceptionsSearch({})).toEqual({});
    expect(isSeverity('exception_severity.medium')).toBe(true);
    expect(isSeverity('medium')).toBe(false);
  });
});
