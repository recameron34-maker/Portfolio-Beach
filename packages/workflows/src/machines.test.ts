import { describe, expect, it } from 'vitest';
import { attempt, forbiddenPairs } from './machine.js';
import type { Machine, TransitionContext, TransitionResult } from './machine.js';
import type { DealStage } from './machines.js';
import {
  MACHINES,
  capitalNoticeMachine,
  dealStageMachine,
  documentClassificationMachine,
  extractionRunMachine,
  reportingPackageMachine,
  valuationMachine,
} from './machines.js';

const OPS = '10000000-0000-4000-8000-000000000003';
const DEAL = '10000000-0000-4000-8000-000000000002';
const HEAD = '10000000-0000-4000-8000-000000000004';

/** A context that satisfies every precondition in every machine, so allowed rows can be exercised generically. */
const happyRecord = {
  inputsComplete: true,
  validationPassed: true,
  preparedBy: OPS,
  lockHash: 'abc',
  edited: true,
  documentIndexed: true,
  bankFieldsExtracted: false,
  ticketPreparedBy: OPS,
  wireVerified: true,
  wireChangedWithinHold: false,
  passReasonCode: 'valuation',
  requiredTasksDone: true,
  icDecisionRecorded: true,
  closingChecklistComplete: true,
  allocationTiedOut: true,
  confidenceAboveThreshold: true,
  sameHashAsExisting: true,
  schemaRetries: 0,
  transientRetries: 0,
  lastErrorKind: 'transient',
  appliedPeriod: '2025-06-30',
};

interface CtxOverrides {
  actorId?: string;
  /** null removes the reason entirely (the default context always carries one). */
  reason?: string | null;
  record?: TransitionContext['record'];
}

const ctx = (roles: string[], extra: CtxOverrides = {}): TransitionContext => {
  const out: TransitionContext = {
    actorId: extra.actorId ?? HEAD,
    actorRoles: roles,
    record: extra.record ?? happyRecord,
  };
  if (extra.reason !== null) out.reason = extra.reason ?? 'documented reason';
  return out;
};

describe('every machine in docs/18', () => {
  for (const [key, machine] of Object.entries(MACHINES) as [string, Machine<string, string>][]) {
    describe(`${key} (${machine.name})`, () => {
      it('declares states, commands, an initial state and terminal states consistently', () => {
        expect(machine.states).toContain(machine.initial);
        for (const t of machine.terminal) expect(machine.states).toContain(t);
        for (const t of machine.transitions) {
          expect(machine.states, `${t.from} is not a state`).toContain(t.from);
          expect(machine.states, `${t.to} is not a state`).toContain(t.to);
          expect(machine.commands, `${t.command} is not a command`).toContain(t.command);
          expect(t.roles.length).toBeGreaterThan(0);
        }
      });

      it('has no transition out of a terminal state', () => {
        for (const t of machine.transitions)
          expect(machine.terminal, `${t.from} is terminal`).not.toContain(t.from);
      });

      for (const t of machine.transitions) {
        it(`allows ${t.from} --${t.command}--> ${t.to} for ${t.roles.join('|')}`, () => {
          const r = attempt(machine, t.from, t.command, ctx([...t.roles]));
          expect(r).toEqual({ ok: true, to: t.to });
        });
        it(`rejects ${t.from} --${t.command}--> for a role outside ${t.roles.join('|')}`, () => {
          const r = attempt(machine, t.from, t.command, ctx(['viewer']));
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.code).toBe('role');
        });
      }

      const forbidden = forbiddenPairs(machine);
      it(`rejects all ${forbidden.length} (state, command) pairs the table does not list`, () => {
        expect(forbidden.length).toBeGreaterThan(0);
        for (const { from, command } of forbidden) {
          // Even an actor holding every role is refused: the table, not the role, decides.
          const r = attempt(
            machine,
            from,
            command,
            ctx([
              'operations',
              'deal_team',
              'approver',
              'service',
              'investor_relations',
              'platform_admin',
            ]),
          );
          expect(r.ok, `${from} ${command} should be forbidden`).toBe(false);
          if (!r.ok) expect(r.code).toBe('forbidden');
        }
      });
    });
  }
});

describe('valuation preconditions (docs/18 section 1, SEC-5.6)', () => {
  it('needs complete inputs and passed validation to prepare', () => {
    const r = attempt(
      valuationMachine,
      'Draft',
      'prepare',
      ctx(['operations'], { record: { ...happyRecord, inputsComplete: false } }),
    );
    expect(r).toMatchObject({ ok: false, code: 'precondition' });
  });
  it('the preparer cannot approve or lock their own valuation', () => {
    expect(
      attempt(
        valuationMachine,
        'OpsPrepared',
        'dealTeamApprove',
        ctx(['deal_team'], { actorId: OPS }),
      ).ok,
    ).toBe(false);
    expect(
      attempt(valuationMachine, 'DealTeamApproved', 'lock', ctx(['approver'], { actorId: OPS })).ok,
    ).toBe(false);
    expect(
      attempt(
        valuationMachine,
        'OpsPrepared',
        'dealTeamApprove',
        ctx(['deal_team'], { actorId: DEAL }),
      ).ok,
    ).toBe(true);
  });
  it('locking needs a lock hash; sending back and reopening need a reason', () => {
    expect(
      attempt(
        valuationMachine,
        'DealTeamApproved',
        'lock',
        ctx(['approver'], { record: { ...happyRecord, lockHash: '' } }),
      ).ok,
    ).toBe(false);
    expect(
      attempt(valuationMachine, 'OpsPrepared', 'sendBack', ctx(['operations'], { reason: '  ' }))
        .ok,
    ).toBe(false);
    const reopen = attempt(
      valuationMachine,
      'Locked',
      'reopen',
      ctx(['approver'], { reason: null }),
    );
    expect(reopen).toMatchObject({
      ok: false,
      code: 'precondition',
      message: expect.stringContaining('reason') as string,
    });
  });
});

describe('capital notice preconditions (docs/18 section 3, SEC-12)', () => {
  it('a notice with extracted bank fields can never be reviewed', () => {
    expect(
      attempt(
        capitalNoticeMachine,
        'Extracted',
        'review',
        ctx(['operations'], { record: { ...happyRecord, bankFieldsExtracted: true } }),
      ).ok,
    ).toBe(false);
  });
  it('a ticket needs a different approver, a verified wire and no recent change', () => {
    expect(
      attempt(
        capitalNoticeMachine,
        'TicketDrafted',
        'approveTicket',
        ctx(['approver'], { actorId: OPS }),
      ).ok,
    ).toBe(false);
    expect(
      attempt(
        capitalNoticeMachine,
        'TicketDrafted',
        'approveTicket',
        ctx(['approver'], { record: { ...happyRecord, wireVerified: false } }),
      ).ok,
    ).toBe(false);
    expect(
      attempt(
        capitalNoticeMachine,
        'TicketDrafted',
        'approveTicket',
        ctx(['approver'], { record: { ...happyRecord, wireChangedWithinHold: true } }),
      ).ok,
    ).toBe(false);
    expect(
      attempt(capitalNoticeMachine, 'TicketDrafted', 'approveTicket', ctx(['approver'])).ok,
    ).toBe(true);
  });
  it('a wire change sends an approved ticket back to draft', () => {
    expect(
      attempt(capitalNoticeMachine, 'TicketApproved', 'wireChanged', ctx(['service'])),
    ).toEqual({ ok: true, to: 'TicketDrafted' });
  });
});

describe('deal stage preconditions (docs/18 section 4)', () => {
  it('passing needs a reason code from any live stage; Closed cannot be passed', () => {
    expect(
      attempt(
        dealStageMachine,
        'Diligence',
        'pass',
        ctx(['deal_team'], { record: { ...happyRecord, passReasonCode: '' } }),
      ).ok,
    ).toBe(false);
    expect(attempt(dealStageMachine, 'Diligence', 'pass', ctx(['deal_team']))).toEqual({
      ok: true,
      to: 'Passed',
    });
    expect(attempt(dealStageMachine, 'Closed', 'pass', ctx(['deal_team']))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
  });
  it('the IC gate needs required tasks done, or an Approver override with a reason', () => {
    const open = { ...happyRecord, requiredTasksDone: false };
    expect(
      attempt(dealStageMachine, 'Diligence', 'advance', ctx(['deal_team'], { record: open })).ok,
    ).toBe(false);
    expect(
      attempt(
        dealStageMachine,
        'Diligence',
        'advance',
        ctx(['approver'], { record: open, reason: null }),
      ).ok,
    ).toBe(false);
    expect(
      attempt(
        dealStageMachine,
        'Diligence',
        'advance',
        ctx(['approver'], { record: open, reason: 'Outstanding item is immaterial' }),
      ),
    ).toEqual({ ok: true, to: 'IC' });
  });
  it('closing needs the checklist complete and allocations tied out', () => {
    expect(
      attempt(
        dealStageMachine,
        'Closing',
        'advance',
        ctx(['operations'], { record: { ...happyRecord, closingChecklistComplete: false } }),
      ).ok,
    ).toBe(false);
    expect(
      attempt(
        dealStageMachine,
        'Closing',
        'advance',
        ctx(['operations'], { record: { ...happyRecord, allocationTiedOut: false } }),
      ).ok,
    ).toBe(false);
    expect(attempt(dealStageMachine, 'Closing', 'advance', ctx(['deal_team'])).ok).toBe(false);
  });
  it('walks Sourced to Closed in order', () => {
    const path: string[] = [];
    let state: DealStage = 'Sourced';
    const roles = ['deal_team', 'approver', 'operations'];
    while (state !== 'Closed') {
      const r: TransitionResult<DealStage> = attempt(
        dealStageMachine,
        state,
        'advance',
        ctx(roles),
      );
      if (!r.ok) throw new Error(r.message);
      state = r.to;
      path.push(state);
    }
    expect(path).toEqual([
      'Screening',
      'Prescreen',
      'Diligence',
      'IC',
      'Approved',
      'Closing',
      'Closed',
    ]);
  });
});

describe('reporting package, documents and extraction (docs/18 sections 5 to 7)', () => {
  it('a failed QA check can only be overridden by an approver with a reason', () => {
    expect(
      attempt(reportingPackageMachine, 'QAFailed', 'overrideQa', ctx(['investor_relations'])).ok,
    ).toBe(false);
    expect(
      attempt(reportingPackageMachine, 'QAFailed', 'overrideQa', ctx(['approver'], { reason: '' }))
        .ok,
    ).toBe(false);
    expect(attempt(reportingPackageMachine, 'QAFailed', 'overrideQa', ctx(['approver']))).toEqual({
      ok: true,
      to: 'QAPassed',
    });
    expect(
      attempt(reportingPackageMachine, 'InReview', 'approve', ctx(['approver'], { actorId: OPS }))
        .ok,
    ).toBe(false);
  });
  it('auto-classification needs confidence above the threshold; duplicates need a matching hash', () => {
    expect(
      attempt(
        documentClassificationMachine,
        'Received',
        'autoClassify',
        ctx(['service'], { record: { ...happyRecord, confidenceAboveThreshold: false } }),
      ).ok,
    ).toBe(false);
    expect(
      attempt(
        documentClassificationMachine,
        'Received',
        'markDuplicate',
        ctx(['service'], { record: { ...happyRecord, sameHashAsExisting: false } }),
      ).ok,
    ).toBe(false);
  });
  it('extraction retries once for schema failures and three times for transient ones', () => {
    expect(
      attempt(
        extractionRunMachine,
        'Running',
        'scheduleRetry',
        ctx(['service'], { record: { ...happyRecord, lastErrorKind: 'schema', schemaRetries: 1 } }),
      ).ok,
    ).toBe(false);
    expect(
      attempt(
        extractionRunMachine,
        'Running',
        'scheduleRetry',
        ctx(['service'], { record: { ...happyRecord, lastErrorKind: 'schema', schemaRetries: 0 } }),
      ).ok,
    ).toBe(true);
    expect(
      attempt(
        extractionRunMachine,
        'Running',
        'scheduleRetry',
        ctx(['service'], {
          record: { ...happyRecord, lastErrorKind: 'transient', transientRetries: 3 },
        }),
      ).ok,
    ).toBe(false);
  });
});
