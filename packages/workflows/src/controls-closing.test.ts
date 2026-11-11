import { describe, expect, it } from 'vitest';
import {
  CLOSING_CONFIRMED_REFUSAL,
  CLOSING_NOT_CONFIRMED_REFUSAL,
  CLOSING_REENTERED_REASON,
  POSITION_EXISTS_REFUSAL,
  checklistCounts,
  closingGate,
  confirmRefusal,
  diligenceGate,
  icDecisionApproved,
  icGateDecision,
  icRoundStart,
  latestReopen,
  missingReceived,
  missingReceivedRefusal,
  requiredItemsComplete,
  tieOut,
} from './controls-closing.js';
import type { ChecklistItem, GateTask, RoundDecision, StageMove } from './controls-closing.js';

/*
 * The pure rules the API and the web preview share for the pipeline gates and the closing
 * (docs/04 M7, M8, M22; docs/18 sections 4 and 12). Instants here are text that sorts as time
 * does: the API passes UTC timestamps to the microsecond, the preview its own sequence keys.
 */

const EM_DASH = String.fromCharCode(0x2014);

describe('the refusals both sides answer', () => {
  it('words them once, without an em dash', () => {
    expect(CLOSING_CONFIRMED_REFUSAL).toBe(
      'the closing is confirmed; change the close date or ask operations to reopen it',
    );
    expect(POSITION_EXISTS_REFUSAL).toBe(
      'the position exists; record the change through a deal change request',
    );
    expect(CLOSING_NOT_CONFIRMED_REFUSAL).toBe('the closing is not confirmed by operations (M8)');
    expect(CLOSING_REENTERED_REASON).toBe(
      'The deal reached Closing again with a new close date and commitment; operations confirm again',
    );
    for (const text of [
      CLOSING_CONFIRMED_REFUSAL,
      POSITION_EXISTS_REFUSAL,
      CLOSING_NOT_CONFIRMED_REFUSAL,
      CLOSING_REENTERED_REASON,
    ])
      expect(text).not.toContain(EM_DASH);
  });
});

describe('the allocation tie-out (M22)', () => {
  it('sums the received amounts only, to two places, compared exactly', () => {
    expect(
      tieOut('15000000.00', [{ received: '10000000.00' }, { received: '5000000.00' }]),
    ).toEqual({
      commitment: '15000000.00',
      allocated: '15000000.00',
      difference: '0.00',
      tiedOut: true,
    });
    expect(tieOut('15000000', [{ received: '10000000.00' }, { received: '4999999.99' }])).toEqual({
      commitment: '15000000.00',
      allocated: '14999999.99',
      difference: '-0.01',
      tiedOut: false,
    });
    expect(tieOut('1.00', [{ received: '0.70' }, { received: '0.40' }])).toEqual({
      commitment: '1.00',
      allocated: '1.10',
      difference: '0.10',
      tiedOut: false,
    });
    // Decimal, never binary floating point: 0.1 + 0.2 is 0.3.
    expect(tieOut('0.30', [{ received: '0.10' }, { received: '0.20' }]).tiedOut).toBe(true);
  });

  it('never lets a line with no received amount tie, whatever the sum', () => {
    expect(tieOut('15000000.00', [{ received: '10000000.00' }, { received: null }])).toEqual({
      commitment: '15000000.00',
      allocated: '10000000.00',
      difference: '-5000000.00',
      tiedOut: false,
    });
    // The received amounts reach the commitment, and another line still has none.
    expect(tieOut('15000000.00', [{ received: '15000000.00' }, { received: null }])).toEqual({
      commitment: '15000000.00',
      allocated: '15000000.00',
      difference: '0.00',
      tiedOut: false,
    });
    expect(tieOut('0.00', [])).toEqual({
      commitment: '0.00',
      allocated: '0.00',
      difference: '0.00',
      tiedOut: true,
    });
    expect(tieOut('5.00', []).tiedOut).toBe(false);
  });

  it('counts the lines with no received amount and words the refusal in the singular and the plural', () => {
    expect(missingReceived([])).toBe(0);
    expect(missingReceived([{ received: '1.00' }, { received: null }, { received: null }])).toBe(2);
    expect(missingReceivedRefusal([{ received: '1.00' }])).toBeNull();
    expect(missingReceivedRefusal([{ received: null }])).toBe(
      'received amounts are missing on 1 line (M22)',
    );
    expect(missingReceivedRefusal([{ received: null }, { received: null }])).toBe(
      'received amounts are missing on 2 lines (M22)',
    );
  });

  it('names the missing received amounts in the confirmation refusal only when the tie-out is what refused', () => {
    const rows = [{ received: '1.00' }, { received: null }];
    const refused = {
      command: 'confirm',
      code: 'precondition',
      itemsComplete: true,
      tiedOut: false,
      rows,
    } as const;
    expect(confirmRefusal(refused)).toBe('closing: received amounts are missing on 1 line (M22)');
    // The checklist refusal comes first, as the machine orders them.
    expect(confirmRefusal({ ...refused, itemsComplete: false })).toBeNull();
    // Every line received and still short: the machine's own tie-out message stands.
    expect(confirmRefusal({ ...refused, rows: [{ received: '1.00' }] })).toBeNull();
    expect(confirmRefusal({ ...refused, tiedOut: true })).toBeNull();
    expect(confirmRefusal({ ...refused, code: 'role' })).toBeNull();
    expect(confirmRefusal({ ...refused, code: 'forbidden' })).toBeNull();
    expect(confirmRefusal({ ...refused, command: 'reopen' })).toBeNull();
    expect(confirmRefusal({ ...refused, command: 'changeCloseDate' })).toBeNull();
  });
});

describe('the closing checklist and the closing gate (M8)', () => {
  const item = (required: boolean, status: string): ChecklistItem => ({ required, status });

  it('is complete when every required item is received or waived; optional items never block', () => {
    expect(requiredItemsComplete([])).toBe(true);
    expect(requiredItemsComplete([item(true, 'received'), item(true, 'waived')])).toBe(true);
    expect(requiredItemsComplete([item(true, 'received'), item(false, 'open')])).toBe(true);
    expect(requiredItemsComplete([item(true, 'open'), item(false, 'received')])).toBe(false);
    expect(
      checklistCounts([item(true, 'open'), item(false, 'open'), item(true, 'received')]),
    ).toEqual({ itemsOpen: 2, itemsRequiredOpen: 1 });
    expect(checklistCounts([])).toEqual({ itemsOpen: 0, itemsRequiredOpen: 0 });
  });

  it('reads clear only when the checklist is complete, the allocations tie and operations confirmed', () => {
    const complete = [item(true, 'received')];
    expect(closingGate(null)).toEqual({
      checklistComplete: false,
      allocationTiedOut: false,
      confirmed: false,
      ok: false,
    });
    expect(closingGate({ state: 'Open', items: complete, tiedOut: true })).toEqual({
      checklistComplete: true,
      allocationTiedOut: true,
      confirmed: false,
      ok: false,
    });
    expect(closingGate({ state: 'OpsConfirmed', items: complete, tiedOut: true })).toEqual({
      checklistComplete: true,
      allocationTiedOut: true,
      confirmed: true,
      ok: true,
    });
    // A confirmed closing whose lines or items no longer hold does not read clear.
    expect(closingGate({ state: 'OpsConfirmed', items: complete, tiedOut: false }).ok).toBe(false);
    expect(
      closingGate({ state: 'OpsConfirmed', items: [item(true, 'open')], tiedOut: true }),
    ).toEqual({ checklistComplete: false, allocationTiedOut: true, confirmed: true, ok: false });
  });
});

describe('the stage history as the gates read it (docs/18 section 4)', () => {
  const walk = (...stages: string[]): StageMove[] =>
    stages.map((toStage, i) => ({
      fromStage: i === 0 ? null : (stages[i - 1] ?? null),
      toStage,
      at: `2025-06-01T10:00:0${i}.000000`,
    }));

  it('starts an IC round at the latest move into IC, or at a later reopen from Passed', () => {
    expect(icRoundStart([])).toBeNull();
    expect(icRoundStart(walk('Sourced', 'Screening'))).toBeNull();
    const first = walk('Sourced', 'Screening', 'Prescreen', 'Diligence', 'IC');
    expect(icRoundStart(first)).toBe('2025-06-01T10:00:04.000000');
    const reopened = walk(
      'Sourced',
      'Screening',
      'Prescreen',
      'Diligence',
      'IC',
      'Approved',
      'Passed',
      'Screening',
    );
    expect(icRoundStart(reopened)).toBe('2025-06-01T10:00:07.000000');
    expect(latestReopen(reopened)).toBe('2025-06-01T10:00:07.000000');
    expect(latestReopen(first)).toBeNull();
    // Back at IC, the round starts at the new entry; the reopen stays the latest reopen.
    const again = [
      ...reopened,
      { fromStage: 'Screening', toStage: 'Prescreen', at: '2025-06-01T10:00:08.000000' },
      { fromStage: 'Prescreen', toStage: 'Diligence', at: '2025-06-01T10:00:09.000000' },
      { fromStage: 'Diligence', toStage: 'IC', at: '2025-06-01T10:00:10.000000' },
    ];
    expect(icRoundStart(again)).toBe('2025-06-01T10:00:10.000000');
    expect(latestReopen(again)).toBe('2025-06-01T10:00:07.000000');
    // The order of the rows passed in does not matter.
    expect(icRoundStart([...again].reverse())).toBe('2025-06-01T10:00:10.000000');
  });
});

describe('the diligence gate (M7)', () => {
  const task = (status: string, changedAt: string | null, requiredForIc = true): GateTask => ({
    status,
    requiredForIc,
    changedAt,
  });
  const reopenAt5: StageMove[] = [{ fromStage: 'Passed', toStage: 'Screening', at: '05' }];

  it('counts the open tasks required for IC and is clear when none is', () => {
    expect(diligenceGate([], [])).toEqual({ requiredOpen: 0, ok: true, carriedOver: 0 });
    expect(
      diligenceGate(
        [task('open', '01'), task('done', '02'), task('waived', '03'), task('open', '04', false)],
        [],
      ),
    ).toEqual({ requiredOpen: 1, ok: false, carriedOver: 0 });
  });

  it('counts as carried over the required tasks done or waived before the latest reopen from Passed', () => {
    const tasks = [
      task('done', '02'),
      task('waived', '03'),
      // Done again after the reopen: this round's work.
      task('done', '06'),
      // Still open, last changed before the reopen: open, not carried over.
      task('open', '01'),
      // Not required for IC: never counted.
      task('done', '02', false),
      // No instant on record: never counted as before the reopen.
      task('done', null),
    ];
    expect(diligenceGate(tasks, reopenAt5)).toEqual({
      requiredOpen: 1,
      ok: false,
      carriedOver: 2,
    });
    // Strictly before: a task changed at the very instant of the reopen is not carried over.
    expect(diligenceGate([task('done', '05')], reopenAt5).carriedOver).toBe(0);
    // Without a reopen nothing is carried over.
    expect(
      diligenceGate(tasks, [{ fromStage: 'Diligence', toStage: 'IC', at: '09' }]).carriedOver,
    ).toBe(0);
    // The latest reopen is the one that counts.
    expect(
      diligenceGate(
        [task('done', '06')],
        [...reopenAt5, { fromStage: 'Passed', toStage: 'Screening', at: '07' }],
      ).carriedOver,
    ).toBe(1);
  });
});

describe('the IC decision gate (M7)', () => {
  const decision = (
    id: string,
    decisionDate: string,
    outcome: string,
    recordedAt: string,
  ): RoundDecision => ({ id, decisionDate, decision: outcome, recordedAt });
  const atIc: StageMove[] = [{ fromStage: 'Diligence', toStage: 'IC', at: '03' }];

  it('reads the latest decision of the current round: by decision date, then the record, then the id', () => {
    expect(icGateDecision([], atIc)).toBeNull();
    expect(icDecisionApproved([], atIc)).toBe(false);
    const approved = decision('a', '2025-06-20', 'approved', '04');
    expect(icGateDecision([approved], atIc)).toBe(approved);
    expect(icDecisionApproved([approved], atIc)).toBe(true);
    // A later decision date supersedes, whenever it was recorded.
    const declinedLater = decision('b', '2025-06-25', 'declined', '05');
    expect(icDecisionApproved([approved, declinedLater], atIc)).toBe(false);
    expect(icDecisionApproved([declinedLater, approved], atIc)).toBe(false);
    const approvedLatest = decision('c', '2025-06-30', 'approved', '06');
    expect(icDecisionApproved([approved, declinedLater, approvedLatest], atIc)).toBe(true);
    // The same date: the one recorded last, then the higher id.
    const sameDayFirst = decision('d', '2025-07-01', 'approved', '07');
    const sameDayLast = decision('e', '2025-07-01', 'deferred', '08');
    expect(icGateDecision([sameDayFirst, sameDayLast], atIc)).toBe(sameDayLast);
    expect(
      icGateDecision(
        [
          decision('x', '2025-07-01', 'approved', '07'),
          decision('y', '2025-07-01', 'declined', '07'),
        ],
        atIc,
      )?.id,
    ).toBe('y');
  });

  it('counts only decisions recorded since the deal last entered IC or left Passed', () => {
    const before = decision('a', '2025-06-20', 'approved', '04');
    const reopened: StageMove[] = [
      ...atIc,
      { fromStage: 'IC', toStage: 'Approved', at: '05' },
      { fromStage: 'Approved', toStage: 'Passed', at: '06' },
      { fromStage: 'Passed', toStage: 'Screening', at: '07' },
    ];
    // From the reopen until the next IC no decision counts.
    expect(icDecisionApproved([before], reopened)).toBe(false);
    const backAtIc: StageMove[] = [
      ...reopened,
      { fromStage: 'Diligence', toStage: 'IC', at: '09' },
    ];
    expect(icDecisionApproved([before], backAtIc)).toBe(false);
    // A decision of this round opens the gate, even one dated before the first round's.
    const thisRound = decision('b', '2025-06-10', 'approved', '10');
    expect(icDecisionApproved([before, thisRound], backAtIc)).toBe(true);
    expect(icGateDecision([before, thisRound], backAtIc)).toBe(thisRound);
    // Recorded at the very instant the round began counts (on or after).
    expect(icDecisionApproved([decision('c', '2025-06-10', 'approved', '09')], backAtIc)).toBe(
      true,
    );
    // A deal that never reached IC has no round: nothing counts.
    expect(icDecisionApproved([before], [])).toBe(false);
  });
});
