import { describe, expect, it } from 'vitest';
import { all, attempt, flag, forbiddenPairs, requireReason } from './machine.js';
import type { Check, Machine, TransitionContext, TransitionResult } from './machine.js';
import type { ClosingState, DealStage } from './machines.js';
import {
  MACHINES,
  capitalNoticeMachine,
  closingMachine,
  dealStageMachine,
  documentClassificationMachine,
  exceptionMachine,
  extractionRunMachine,
  reportingPackageMachine,
  valuationMachine,
  wireInstructionMachine,
} from './machines.js';

const OPS = '10000000-0000-4000-8000-000000000003';
const OPS2 = '10000000-0000-4000-8000-000000000005';
const DEAL = '10000000-0000-4000-8000-000000000002';
const HEAD = '10000000-0000-4000-8000-000000000004';

const EVERY_ROLE = [
  'viewer',
  'deal_team',
  'operations',
  'approver',
  'investor_relations',
  'platform_admin',
  'auditor',
  'service',
];

/** The checks an all() keeps, so a test can prove their order. */
const checksOf = (precondition: Check | undefined): readonly Check[] =>
  (precondition as { checks?: readonly Check[] } | undefined)?.checks ?? [];

/** A context that satisfies every precondition in every machine, so allowed rows can be exercised generically. */
const happyRecord = {
  inputsComplete: true,
  validationPassed: true,
  preparedBy: OPS,
  lockHash: 'abc',
  edited: true,
  documentIndexed: true,
  bankFieldsExtracted: false,
  ticketExists: true,
  ticketPreparedBy: OPS,
  wireVerified: true,
  wireChangedWithinHold: false,
  ticketApproved: true,
  passReasonCode: 'valuation',
  requiredTasksDone: true,
  icDecisionRecorded: true,
  closingRecordReady: true,
  closingChecklistComplete: true,
  allocationTiedOut: true,
  proposedBy: OPS,
  callbackConfirmed: true,
  newerVerifiedExists: true,
  requiredItemsComplete: true,
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
  it('approval is refused first when no trade ticket is drafted, whoever asks', () => {
    const noTicket = { ...happyRecord, ticketExists: false, wireVerified: false };
    for (const [role, actorId] of [
      ['approver', OPS],
      ['approver', HEAD],
      ['operations', OPS2],
    ] as const) {
      expect(
        attempt(
          capitalNoticeMachine,
          'TicketDrafted',
          'approveTicket',
          ctx([role], { actorId, record: noTicket }),
        ),
      ).toEqual({
        ok: false,
        code: 'precondition',
        message: 'capital_notice: no trade ticket is drafted',
      });
    }
    // A record that says nothing about a ticket has none.
    const { ticketExists: _dropped, ...silent } = happyRecord;
    expect(
      attempt(
        capitalNoticeMachine,
        'TicketDrafted',
        'approveTicket',
        ctx(['approver'], { record: silent }),
      ).ok,
    ).toBe(false);
    // The ticket check comes before the dual-control and wire checks, and every check stays listed.
    const approve = capitalNoticeMachine.transitions.find((t) => t.command === 'approveTicket');
    expect(
      checksOf(approve?.precondition).map((c) =>
        c(ctx(['approver'], { record: { ...happyRecord, ticketExists: false } })),
      ),
    ).toEqual(['no trade ticket is drafted', null, null, null]);
  });
  it('funding is confirmed only against an approved ticket', () => {
    expect(
      attempt(
        capitalNoticeMachine,
        'TicketApproved',
        'confirmFunding',
        ctx(['operations'], { record: { ...happyRecord, ticketApproved: false } }),
      ),
    ).toEqual({
      ok: false,
      code: 'precondition',
      message: 'capital_notice: the ticket is not approved',
    });
    expect(
      attempt(capitalNoticeMachine, 'TicketApproved', 'confirmFunding', ctx(['operations'])),
    ).toEqual({ ok: true, to: 'Funded' });
    for (const role of EVERY_ROLE.filter((r) => r !== 'operations'))
      expect(
        attempt(capitalNoticeMachine, 'TicketApproved', 'confirmFunding', ctx([role])),
      ).toMatchObject({ ok: false, code: 'role' });
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
  it('opening closing needs a closing record with a close date and a commitment', () => {
    for (const role of ['deal_team', 'operations']) {
      expect(
        attempt(
          dealStageMachine,
          'Approved',
          'advance',
          ctx([role], { record: { ...happyRecord, closingRecordReady: false } }),
        ),
      ).toEqual({
        ok: false,
        code: 'precondition',
        message: 'deal_stage: a close date and commitment are required to open closing',
      });
      expect(attempt(dealStageMachine, 'Approved', 'advance', ctx([role]))).toEqual({
        ok: true,
        to: 'Closing',
      });
    }
    for (const role of EVERY_ROLE.filter((r) => r !== 'deal_team' && r !== 'operations'))
      expect(attempt(dealStageMachine, 'Approved', 'advance', ctx([role]))).toMatchObject({
        ok: false,
        code: 'role',
      });
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

describe('data exception (docs/18 section 9)', () => {
  it('is in the machine registry under its table name, with resolved and wont_fix terminal', () => {
    expect(MACHINES.exception).toBe(exceptionMachine);
    expect(exceptionMachine.name).toBe('data_exception');
    expect(exceptionMachine.initial).toBe('open');
    expect(exceptionMachine.terminal).toEqual(['resolved', 'wont_fix']);
    expect(exceptionMachine.commands).not.toContain('set_ticket');
  });
  it('operations acknowledges an open exception; no one else does', () => {
    expect(attempt(exceptionMachine, 'open', 'acknowledge', ctx(['operations']))).toEqual({
      ok: true,
      to: 'acknowledged',
    });
    for (const role of ['deal_team', 'approver', 'auditor', 'platform_admin', 'service', 'viewer'])
      expect(attempt(exceptionMachine, 'open', 'acknowledge', ctx([role]))).toMatchObject({
        ok: false,
        code: 'role',
      });
  });
  it('resolving or closing needs a reason, from open and from acknowledged', () => {
    for (const from of ['open', 'acknowledged'] as const) {
      for (const [command, to] of [
        ['resolve', 'resolved'],
        ['wont_fix', 'wont_fix'],
      ] as const) {
        expect(attempt(exceptionMachine, from, command, ctx(['operations']))).toEqual({
          ok: true,
          to,
        });
        expect(
          attempt(exceptionMachine, from, command, ctx(['operations'], { reason: null })),
        ).toMatchObject({
          ok: false,
          code: 'precondition',
          message: expect.stringContaining('reason') as string,
        });
        expect(
          attempt(exceptionMachine, from, command, ctx(['operations'], { reason: '   ' })).ok,
        ).toBe(false);
      }
    }
    // The reason is the whole precondition, so the web's command options can ask for one.
    for (const t of exceptionMachine.transitions.filter((x) => x.command !== 'acknowledge'))
      expect(t.precondition).toBe(requireReason);
  });
  it('rejects every move out of a terminal state and a second acknowledgement', () => {
    const every = ['operations', 'deal_team', 'approver', 'service', 'platform_admin'];
    for (const from of ['resolved', 'wont_fix'] as const)
      for (const command of exceptionMachine.commands)
        expect(attempt(exceptionMachine, from, command, ctx(every))).toMatchObject({
          ok: false,
          code: 'forbidden',
        });
    expect(attempt(exceptionMachine, 'acknowledged', 'acknowledge', ctx(every))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(forbiddenPairs(exceptionMachine)).toHaveLength(7);
  });
});

describe('wire instruction (docs/18 section 11, SEC-12.2)', () => {
  it('is in the registry under its table name; Rejected and Superseded are terminal', () => {
    expect(MACHINES.wireInstruction).toBe(wireInstructionMachine);
    expect(wireInstructionMachine.name).toBe('wire_instruction');
    expect(wireInstructionMachine.states).toEqual([
      'Proposed',
      'Verified',
      'Rejected',
      'Superseded',
    ]);
    expect(wireInstructionMachine.commands).toEqual(['verify', 'reject', 'supersede']);
    expect(wireInstructionMachine.initial).toBe('Proposed');
    expect(wireInstructionMachine.terminal).toEqual(['Rejected', 'Superseded']);
  });

  it('verifies only through a confirming callback made by someone other than the proposer', () => {
    const verify = (roles: string[], extra: CtxOverrides = {}): TransitionResult<string> =>
      attempt(wireInstructionMachine, 'Proposed', 'verify', ctx(roles, extra));
    // The proposer is refused even when the callback confirmed the instruction.
    for (const role of ['operations', 'approver'])
      expect(verify([role], { actorId: OPS })).toEqual({
        ok: false,
        code: 'precondition',
        message:
          'wire_instruction: the callback must be made by a person other than the proposer (SEC-12.2)',
      });
    // A callback that did not confirm, or was never made, verifies nothing.
    expect(verify(['approver'], { record: { ...happyRecord, callbackConfirmed: false } })).toEqual({
      ok: false,
      code: 'precondition',
      message: 'wire_instruction: the callback did not confirm the instruction (SEC-12.2)',
    });
    const { callbackConfirmed: _dropped, ...noCallback } = happyRecord;
    expect(verify(['operations'], { actorId: OPS2, record: noCallback }).ok).toBe(false);
    // The second-person check comes first and both checks stay listed.
    const row = wireInstructionMachine.transitions.find((t) => t.command === 'verify');
    expect(
      checksOf(row?.precondition).map((c) =>
        c(
          ctx(['operations'], {
            actorId: OPS,
            record: { ...happyRecord, callbackConfirmed: false },
          }),
        ),
      ),
    ).toEqual([
      'the callback must be made by a person other than the proposer (SEC-12.2)',
      'the callback did not confirm the instruction (SEC-12.2)',
    ]);
    // A second operations person or an approver verifies it.
    expect(verify(['operations'], { actorId: OPS2 })).toEqual({ ok: true, to: 'Verified' });
    expect(verify(['approver'], { actorId: HEAD })).toEqual({ ok: true, to: 'Verified' });
  });

  it('rejecting needs a reason, from operations or an approver', () => {
    for (const role of ['operations', 'approver']) {
      expect(attempt(wireInstructionMachine, 'Proposed', 'reject', ctx([role]))).toEqual({
        ok: true,
        to: 'Rejected',
      });
      for (const reason of [null, '', '   '])
        expect(
          attempt(wireInstructionMachine, 'Proposed', 'reject', ctx([role], { reason })),
        ).toEqual({
          ok: false,
          code: 'precondition',
          message: 'wire_instruction: a reason is required',
        });
    }
    const row = wireInstructionMachine.transitions.find((t) => t.command === 'reject');
    expect(row?.precondition).toBe(requireReason);
  });

  it('a Verified version is superseded only by a newer Verified one', () => {
    for (const role of ['service', 'operations']) {
      expect(attempt(wireInstructionMachine, 'Verified', 'supersede', ctx([role]))).toEqual({
        ok: true,
        to: 'Superseded',
      });
      expect(
        attempt(
          wireInstructionMachine,
          'Verified',
          'supersede',
          ctx([role], { record: { ...happyRecord, newerVerifiedExists: false } }),
        ),
      ).toEqual({
        ok: false,
        code: 'precondition',
        message: 'wire_instruction: only a newer Verified version supersedes this one',
      });
    }
  });

  it('refuses every role the row does not name, on every row', () => {
    for (const t of wireInstructionMachine.transitions)
      for (const role of EVERY_ROLE.filter((r) => !t.roles.includes(r)))
        expect(
          attempt(wireInstructionMachine, t.from, t.command, ctx([role], { actorId: OPS2 })),
          `${role} ${t.command} from ${t.from}`,
        ).toMatchObject({ ok: false, code: 'role' });
  });

  it('rejects the nine (state, command) pairs the table does not list, for an actor holding every role', () => {
    const forbidden = forbiddenPairs(wireInstructionMachine);
    expect(forbidden).toEqual([
      { from: 'Proposed', command: 'supersede' },
      { from: 'Verified', command: 'verify' },
      { from: 'Verified', command: 'reject' },
      { from: 'Rejected', command: 'verify' },
      { from: 'Rejected', command: 'reject' },
      { from: 'Rejected', command: 'supersede' },
      { from: 'Superseded', command: 'verify' },
      { from: 'Superseded', command: 'reject' },
      { from: 'Superseded', command: 'supersede' },
    ]);
    for (const { from, command } of forbidden)
      expect(
        attempt(wireInstructionMachine, from, command, ctx(EVERY_ROLE, { actorId: OPS2 })),
      ).toEqual({
        ok: false,
        code: 'forbidden',
        message: `wire_instruction: ${command} is not allowed from ${from}`,
      });
  });
});

describe('closing (docs/18 section 12, M8)', () => {
  it('is in the registry under its table name, with no terminal state', () => {
    expect(MACHINES.closing).toBe(closingMachine);
    expect(closingMachine.name).toBe('closing');
    expect(closingMachine.states).toEqual(['Open', 'OpsConfirmed']);
    expect(closingMachine.commands).toEqual(['confirm', 'changeCloseDate']);
    expect(closingMachine.initial).toBe('Open');
    expect(closingMachine.terminal).toEqual([]);
  });

  it('operations confirms once every required item is in and the allocations tie out', () => {
    expect(attempt(closingMachine, 'Open', 'confirm', ctx(['operations']))).toEqual({
      ok: true,
      to: 'OpsConfirmed',
    });
    expect(
      attempt(
        closingMachine,
        'Open',
        'confirm',
        ctx(['operations'], { record: { ...happyRecord, requiredItemsComplete: false } }),
      ),
    ).toEqual({
      ok: false,
      code: 'precondition',
      message: 'closing: a required closing document is missing (M8)',
    });
    expect(
      attempt(
        closingMachine,
        'Open',
        'confirm',
        ctx(['operations'], { record: { ...happyRecord, allocationTiedOut: false } }),
      ),
    ).toEqual({
      ok: false,
      code: 'precondition',
      message: 'closing: allocations do not tie to the closing commitment (M22)',
    });
    // The missing document is the first refusal when both fail; both checks stay listed.
    const row = closingMachine.transitions.find((t) => t.command === 'confirm');
    expect(
      checksOf(row?.precondition).map((c) =>
        c(
          ctx(['operations'], {
            record: { ...happyRecord, requiredItemsComplete: false, allocationTiedOut: false },
          }),
        ),
      ),
    ).toEqual([
      'a required closing document is missing (M8)',
      'allocations do not tie to the closing commitment (M22)',
    ]);
    for (const role of EVERY_ROLE.filter((r) => r !== 'operations'))
      expect(attempt(closingMachine, 'Open', 'confirm', ctx([role]))).toMatchObject({
        ok: false,
        code: 'role',
      });
  });

  it('a close date change after confirmation needs a reason and reopens the closing for confirmation again', () => {
    for (const reason of [null, '', '   '])
      expect(
        attempt(closingMachine, 'OpsConfirmed', 'changeCloseDate', ctx(['operations'], { reason })),
      ).toEqual({ ok: false, code: 'precondition', message: 'closing: a reason is required' });
    const row = closingMachine.transitions.find((t) => t.command === 'changeCloseDate');
    expect(row?.precondition).toBe(requireReason);
    for (const role of EVERY_ROLE.filter((r) => r !== 'operations'))
      expect(attempt(closingMachine, 'OpsConfirmed', 'changeCloseDate', ctx([role]))).toMatchObject(
        { ok: false, code: 'role' },
      );
    // Open > OpsConfirmed > Open > OpsConfirmed: nothing is terminal.
    const path: ClosingState[] = [];
    let state: ClosingState = 'Open';
    for (const command of ['confirm', 'changeCloseDate', 'confirm'] as const) {
      const r: TransitionResult<ClosingState> = attempt(
        closingMachine,
        state,
        command,
        ctx(['operations']),
      );
      if (!r.ok) throw new Error(r.message);
      state = r.to;
      path.push(state);
    }
    expect(path).toEqual(['OpsConfirmed', 'Open', 'OpsConfirmed']);
  });

  it('rejects the two (state, command) pairs the table does not list', () => {
    const forbidden = forbiddenPairs(closingMachine);
    expect(forbidden).toEqual([
      { from: 'Open', command: 'changeCloseDate' },
      { from: 'OpsConfirmed', command: 'confirm' },
    ]);
    for (const { from, command } of forbidden)
      expect(attempt(closingMachine, from, command, ctx(EVERY_ROLE))).toEqual({
        ok: false,
        code: 'forbidden',
        message: `closing: ${command} is not allowed from ${from}`,
      });
  });
});

describe('a combined precondition', () => {
  const ctx: TransitionContext = { actorId: 'a', actorRoles: [], record: {} };

  it('refuses with the first failing check and keeps every check listed', () => {
    const both = all(flag('done', true, 'not done'), requireReason);
    expect(both(ctx)).toBe('not done');
    expect(both({ ...ctx, record: { done: true } })).toBe('a reason is required');
    expect(both({ ...ctx, record: { done: true }, reason: 'why' })).toBeNull();
    expect(both.checks.map((c) => c(ctx))).toEqual(['not done', 'a reason is required']);
  });
});
