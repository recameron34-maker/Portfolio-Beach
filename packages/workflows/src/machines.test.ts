import { describe, expect, it } from 'vitest';
import {
  all,
  attempt,
  flag,
  forbiddenPairs,
  notAmong,
  notSameAs,
  requireReason,
} from './machine.js';
import type { Check, Machine, TransitionContext, TransitionResult } from './machine.js';
import type { ClosingState, DealStage } from './machines.js';
import {
  MACHINES,
  SUPERSEDED_REASONS,
  capitalNoticeMachine,
  closingMachine,
  dealStageMachine,
  documentClassificationMachine,
  exceptionMachine,
  extractionRunMachine,
  reportingPackageMachine,
  underwritingCaseMachine,
  valuationMachine,
  valuationSuggestionMachine,
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
  enteredBy: DEAL,
  hasSource: true,
  correctedBySameDate: true,
  // A version carrying a suggested mark names its source reviewers; none of them acts below.
  sourceReviewers: [OPS2],
  hasValue: true,
  versionInProgress: false,
  draftOpen: true,
  supersededReason: 'better_source',
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

describe('valuation: the source reviewers of a suggested mark (docs/18 sections 1 and 14, SEC-5.6)', () => {
  const REFUSAL =
    'valuation: whoever approved or typed a figure behind the suggestion on this valuation cannot approve the valuation (SEC-5.6)';
  const approve = (actorId: string, record: Record<string, unknown>): TransitionResult<string> =>
    attempt(
      valuationMachine,
      'OpsPrepared',
      'dealTeamApprove',
      ctx(['deal_team'], { actorId, record: { ...happyRecord, ...record } }),
    );
  const lock = (actorId: string, record: Record<string, unknown>): TransitionResult<string> =>
    attempt(
      valuationMachine,
      'DealTeamApproved',
      'lock',
      ctx(['approver'], { actorId, record: { ...happyRecord, ...record } }),
    );

  it('refuses both approvals to every source reviewer, and to nobody else', () => {
    const sourceReviewers = [DEAL, HEAD];
    for (const actorId of sourceReviewers) {
      expect(approve(actorId, { sourceReviewers })).toEqual({
        ok: false,
        code: 'precondition',
        message: REFUSAL,
      });
      expect(lock(actorId, { sourceReviewers })).toEqual({
        ok: false,
        code: 'precondition',
        message: REFUSAL,
      });
    }
    // A second person on the deal team and an approver who reviewed nothing take them.
    expect(approve(OPS2, { sourceReviewers })).toEqual({ ok: true, to: 'DealTeamApproved' });
    expect(lock(OPS2, { sourceReviewers })).toEqual({ ok: true, to: 'Locked' });
  });

  it('bars nobody on a version that names no source reviewers', () => {
    const { sourceReviewers: _dropped, ...unnamed } = happyRecord;
    for (const record of [
      unnamed,
      { ...unnamed, sourceReviewers: [] },
      { ...unnamed, sourceReviewers: null },
    ]) {
      expect(
        attempt(
          valuationMachine,
          'OpsPrepared',
          'dealTeamApprove',
          ctx(['deal_team'], { actorId: DEAL, record }),
        ),
      ).toEqual({ ok: true, to: 'DealTeamApproved' });
      expect(
        attempt(valuationMachine, 'DealTeamApproved', 'lock', ctx(['approver'], { record })),
      ).toEqual({ ok: true, to: 'Locked' });
    }
  });

  it('never passes on a list it cannot read', () => {
    // A single id where the list belongs is a mistake of the caller, not a reason to approve.
    for (const sourceReviewers of [DEAL, { [DEAL]: true }, 0])
      expect(approve(OPS2, { sourceReviewers })).toEqual({
        ok: false,
        code: 'precondition',
        message: "valuation: the record's sourceReviewers must be a list of people",
      });
  });

  it('judges the preparer first, then the source reviewers, then the lock hash', () => {
    const record = { ...happyRecord, sourceReviewers: [OPS, HEAD], lockHash: '' };
    // The preparer who also reviewed a source is told they prepared it.
    expect(approve(OPS, record)).toEqual({
      ok: false,
      code: 'precondition',
      message: 'valuation: the preparer cannot approve their own valuation (SEC-5.6)',
    });
    // A source reviewer is refused before the missing hash is.
    expect(lock(HEAD, record)).toEqual({ ok: false, code: 'precondition', message: REFUSAL });
    const row = (command: string) =>
      valuationMachine.transitions.find((t) => t.command === command)?.precondition;
    expect(
      checksOf(row('dealTeamApprove')).map((c) => c(ctx(['deal_team'], { actorId: OPS, record }))),
    ).toEqual([
      'the preparer cannot approve their own valuation (SEC-5.6)',
      'whoever approved or typed a figure behind the suggestion on this valuation cannot approve the valuation (SEC-5.6)',
    ]);
    expect(
      checksOf(row('lock')).map((c) => c(ctx(['approver'], { actorId: OPS, record }))),
    ).toEqual([
      'the preparer cannot approve their own valuation (SEC-5.6)',
      'whoever approved or typed a figure behind the suggestion on this valuation cannot approve the valuation (SEC-5.6)',
      'lock hash must be computed over inputs and value',
    ]);
  });

  it('leaves preparing, sending back and reopening to a source reviewer', () => {
    // The rule is about the two approvals: a reviewer of the source may still do the other steps.
    const record = { ...happyRecord, sourceReviewers: [HEAD] };
    for (const [from, command, role] of [
      ['Draft', 'prepare', 'operations'],
      ['OpsPrepared', 'sendBack', 'operations'],
      ['Locked', 'reopen', 'approver'],
    ] as const)
      expect(
        attempt(valuationMachine, from, command, ctx([role], { actorId: HEAD, record })).ok,
        command,
      ).toBe(true);
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
    ).toEqual(['no trade ticket is drafted', null, null, null, null, null]);
  });
  it('inside the hold window after a verified change the release needs a third person (SEC-12.3)', () => {
    const approve = (actorId: string, record: Record<string, unknown>): TransitionResult<string> =>
      attempt(
        capitalNoticeMachine,
        'TicketDrafted',
        'approveTicket',
        ctx(['approver', 'operations'], { actorId, record: { ...happyRecord, ...record } }),
      );
    // The person whose callback verified the change is the second person, never the third.
    expect(
      approve(OPS2, { wireProposedByWithinHold: DEAL, wireVerifiedByWithinHold: OPS2 }),
    ).toEqual({
      ok: false,
      code: 'precondition',
      message:
        'capital_notice: the wire instruction changed recently: the person who verified the change cannot approve the release, a third person must (SEC-12.3)',
    });
    // Nor is the person who proposed the change.
    expect(
      approve(OPS2, { wireProposedByWithinHold: OPS2, wireVerifiedByWithinHold: DEAL }),
    ).toEqual({
      ok: false,
      code: 'precondition',
      message:
        'capital_notice: the wire instruction changed recently: the person who proposed the change cannot approve the release, a third person must (SEC-12.3)',
    });
    expect(
      approve(HEAD, { wireProposedByWithinHold: DEAL, wireVerifiedByWithinHold: OPS2 }),
    ).toEqual({
      ok: true,
      to: 'TicketApproved',
    });
    // No change inside the window (null), or a record that names none: the dual control rule stands.
    expect(
      approve(OPS2, { wireProposedByWithinHold: null, wireVerifiedByWithinHold: null }),
    ).toEqual({ ok: true, to: 'TicketApproved' });
    expect(approve(OPS2, {})).toEqual({ ok: true, to: 'TicketApproved' });
    // The preparer, the verified instruction and a pending change are judged first.
    const row = capitalNoticeMachine.transitions.find((t) => t.command === 'approveTicket');
    expect(
      checksOf(row?.precondition).map((c) =>
        c(
          ctx(['operations'], {
            actorId: OPS2,
            record: {
              ...happyRecord,
              wireProposedByWithinHold: OPS2,
              wireVerifiedByWithinHold: OPS2,
            },
          }),
        ),
      ),
    ).toEqual([
      null,
      null,
      null,
      null,
      'the wire instruction changed recently: the person who proposed the change cannot approve the release, a third person must (SEC-12.3)',
      'the wire instruction changed recently: the person who verified the change cannot approve the release, a third person must (SEC-12.3)',
    ]);
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
      null,
    ]);
    // A second operations person or an approver verifies it.
    expect(verify(['operations'], { actorId: OPS2 })).toEqual({ ok: true, to: 'Verified' });
    expect(verify(['approver'], { actorId: HEAD })).toEqual({ ok: true, to: 'Verified' });
  });

  it('never verifies an older Proposed version over a newer Verified one: it is rejected instead', () => {
    const verify = (olderThanVerified: boolean): TransitionResult<string> =>
      attempt(
        wireInstructionMachine,
        'Proposed',
        'verify',
        ctx(['operations'], { actorId: OPS2, record: { ...happyRecord, olderThanVerified } }),
      );
    expect(verify(true)).toEqual({
      ok: false,
      code: 'precondition',
      message:
        'wire_instruction: a newer version of this counterparty is already Verified; reject this older version instead (SEC-12.2)',
    });
    expect(verify(false)).toEqual({ ok: true, to: 'Verified' });
    // Rejecting it stays open.
    expect(
      attempt(
        wireInstructionMachine,
        'Proposed',
        'reject',
        ctx(['operations'], { actorId: OPS2, record: { ...happyRecord, olderThanVerified: true } }),
      ),
    ).toEqual({ ok: true, to: 'Rejected' });
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
    expect(closingMachine.commands).toEqual(['confirm', 'changeCloseDate', 'reopen']);
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

  it('operations reopen a confirmed closing with a reason, and so does the system step when a deal returns to Closing', () => {
    for (const role of ['operations', 'service'])
      expect(
        attempt(
          closingMachine,
          'OpsConfirmed',
          'reopen',
          ctx([role], { reason: 'a second vehicle takes part of the allocation' }),
        ),
      ).toEqual({ ok: true, to: 'Open' });
    for (const reason of [null, '', '   '])
      expect(
        attempt(closingMachine, 'OpsConfirmed', 'reopen', ctx(['operations'], { reason })),
      ).toEqual({ ok: false, code: 'precondition', message: 'closing: a reason is required' });
    const row = closingMachine.transitions.find((t) => t.command === 'reopen');
    expect(row?.precondition).toBe(requireReason);
    expect(row?.roles).toEqual(['operations', 'service']);
    // The deal team hands the closing to operations and never reopens a confirmation themselves.
    for (const role of EVERY_ROLE.filter((r) => r !== 'operations' && r !== 'service'))
      expect(
        attempt(closingMachine, 'OpsConfirmed', 'reopen', ctx([role], { reason: 'a reason' })),
      ).toEqual({
        ok: false,
        code: 'role',
        message: 'closing: reopen from OpsConfirmed requires one of: operations, service',
      });
    // Reopened, the closing is confirmed again like any Open one.
    expect(attempt(closingMachine, 'Open', 'confirm', ctx(['operations']))).toEqual({
      ok: true,
      to: 'OpsConfirmed',
    });
  });

  it('rejects the three (state, command) pairs the table does not list', () => {
    const forbidden = forbiddenPairs(closingMachine);
    expect(forbidden).toEqual([
      { from: 'Open', command: 'changeCloseDate' },
      { from: 'Open', command: 'reopen' },
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

describe('underwritten base case (docs/18 section 13, SEC-5.6, SEC-9.1, SEC-9.4)', () => {
  const DEAL2 = '10000000-0000-4000-8000-00000000000a';
  const confirm = (roles: string[], extra: CtxOverrides = {}): TransitionResult<string> =>
    attempt(underwritingCaseMachine, 'Draft', 'confirm', ctx(roles, extra));

  it('is in the registry under its table name; Superseded and Withdrawn are terminal', () => {
    expect(MACHINES.underwritingCase).toBe(underwritingCaseMachine);
    expect(underwritingCaseMachine.name).toBe('underwriting_case');
    expect(underwritingCaseMachine.states).toEqual([
      'Draft',
      'Confirmed',
      'Superseded',
      'Withdrawn',
    ]);
    expect(underwritingCaseMachine.commands).toEqual([
      'confirm',
      'withdraw',
      'supersede',
      'retire',
    ]);
    expect(underwritingCaseMachine.initial).toBe('Draft');
    expect(underwritingCaseMachine.terminal).toEqual(['Superseded', 'Withdrawn']);
  });

  it('lists exactly the four moves of the table, each with its roles', () => {
    expect(
      underwritingCaseMachine.transitions.map(
        (t) => `${t.from} ${t.command} ${t.to}: ${t.roles.join(', ')}`,
      ),
    ).toEqual([
      'Draft confirm Confirmed: deal_team, approver',
      'Draft withdraw Withdrawn: deal_team',
      'Confirmed supersede Superseded: service',
      'Confirmed retire Withdrawn: approver',
    ]);
  });

  it('is confirmed by a second person: the deal team or an approver, never the last editor', () => {
    // The person who entered the figures is refused, whatever role they hold.
    for (const role of ['deal_team', 'approver'])
      expect(confirm([role], { actorId: DEAL })).toEqual({
        ok: false,
        code: 'precondition',
        message:
          'underwriting_case: the person who last changed the figures cannot confirm them (SEC-5.6)',
      });
    expect(confirm(['deal_team'], { actorId: DEAL2 })).toEqual({ ok: true, to: 'Confirmed' });
    expect(confirm(['approver'], { actorId: HEAD })).toEqual({ ok: true, to: 'Confirmed' });
  });

  it('A creates, B edits, B confirms: refused, because every edit makes its editor the last one', () => {
    // enteredBy is the last person to change the figures, not the first: the record after each step.
    const created = { ...happyRecord, enteredBy: DEAL };
    const edited = { ...created, enteredBy: DEAL2 };
    // Before the edit B is a second person and may confirm what A entered.
    expect(confirm(['deal_team'], { actorId: DEAL2, record: created })).toEqual({
      ok: true,
      to: 'Confirmed',
    });
    // After it B confirms nothing: the figures are B's.
    expect(confirm(['deal_team'], { actorId: DEAL2, record: edited })).toEqual({
      ok: false,
      code: 'precondition',
      message:
        'underwriting_case: the person who last changed the figures cannot confirm them (SEC-5.6)',
    });
    // A is now the second person for B's figures, and an approver always was.
    expect(confirm(['deal_team'], { actorId: DEAL, record: edited })).toEqual({
      ok: true,
      to: 'Confirmed',
    });
    expect(confirm(['approver'], { actorId: HEAD, record: edited })).toEqual({
      ok: true,
      to: 'Confirmed',
    });
  });

  it('is confirmed only once it names its source', () => {
    const noSource = {
      ok: false,
      code: 'precondition',
      message:
        'underwriting_case: a base case names its source before it is confirmed: a document of the position or a note on where the model is held (SEC-9.4)',
    };
    expect(confirm(['approver'], { record: { ...happyRecord, hasSource: false } })).toEqual(
      noSource,
    );
    const { hasSource: _dropped, ...unknownSource } = happyRecord;
    expect(confirm(['approver'], { record: unknownSource })).toEqual(noSource);
    // The second-person check comes first, and both stay listed.
    const row = underwritingCaseMachine.transitions.find((t) => t.command === 'confirm');
    expect(
      checksOf(row?.precondition).map((c) =>
        c(ctx(['deal_team'], { actorId: DEAL, record: { ...happyRecord, hasSource: false } })),
      ),
    ).toEqual([
      'the person who last changed the figures cannot confirm them (SEC-5.6)',
      'a base case names its source before it is confirmed: a document of the position or a note on where the model is held (SEC-9.4)',
    ]);
  });

  it('withdrawing a Draft and retiring a Confirmed case each need a reason', () => {
    for (const [from, command, role] of [
      ['Draft', 'withdraw', 'deal_team'],
      ['Confirmed', 'retire', 'approver'],
    ] as const) {
      expect(attempt(underwritingCaseMachine, from, command, ctx([role]))).toEqual({
        ok: true,
        to: 'Withdrawn',
      });
      for (const reason of [null, '', '   '])
        expect(attempt(underwritingCaseMachine, from, command, ctx([role], { reason }))).toEqual({
          ok: false,
          code: 'precondition',
          message: 'underwriting_case: a reason is required',
        });
      const row = underwritingCaseMachine.transitions.find((t) => t.command === command);
      expect(row?.precondition).toBe(requireReason);
    }
  });

  it('the person who entered a Draft may withdraw it: withdrawing takes no second person', () => {
    expect(
      attempt(underwritingCaseMachine, 'Draft', 'withdraw', ctx(['deal_team'], { actorId: DEAL })),
    ).toEqual({ ok: true, to: 'Withdrawn' });
  });

  it('a Confirmed case is superseded only by the confirmation of a correction, as a system step', () => {
    const supersede = (roles: string[], correctedBySameDate: boolean): TransitionResult<string> =>
      attempt(
        underwritingCaseMachine,
        'Confirmed',
        'supersede',
        ctx(roles, { record: { ...happyRecord, correctedBySameDate } }),
      );
    expect(supersede(['service'], true)).toEqual({ ok: true, to: 'Superseded' });
    // A re-underwriting on a later date leaves the case as it is.
    expect(supersede(['service'], false)).toEqual({
      ok: false,
      code: 'precondition',
      message:
        'underwriting_case: only the confirmation of a later version with the same case date supersedes a base case',
    });
    // Never a caller's command: no sign-in carries the service role.
    for (const role of EVERY_ROLE.filter((r) => r !== 'service'))
      expect(supersede([role], true), role).toEqual({
        ok: false,
        code: 'role',
        message: 'underwriting_case: supersede from Confirmed requires one of: service',
      });
  });

  it('refuses every role the row does not name, on every row', () => {
    for (const t of underwritingCaseMachine.transitions)
      for (const role of EVERY_ROLE.filter((r) => !t.roles.includes(r)))
        expect(
          attempt(underwritingCaseMachine, t.from, t.command, ctx([role])),
          `${role} ${t.command} from ${t.from}`,
        ).toMatchObject({ ok: false, code: 'role' });
    // The moves a role might expect and does not have.
    expect(attempt(underwritingCaseMachine, 'Draft', 'withdraw', ctx(['approver']))).toMatchObject({
      ok: false,
      code: 'role',
    });
    expect(
      attempt(underwritingCaseMachine, 'Confirmed', 'retire', ctx(['deal_team'])),
    ).toMatchObject({ ok: false, code: 'role' });
    expect(attempt(underwritingCaseMachine, 'Draft', 'confirm', ctx(['operations']))).toMatchObject(
      { ok: false, code: 'role' },
    );
  });

  it('rejects the twelve (state, command) pairs the table does not list, for an actor holding every role', () => {
    const forbidden = forbiddenPairs(underwritingCaseMachine);
    expect(forbidden).toEqual([
      { from: 'Draft', command: 'supersede' },
      { from: 'Draft', command: 'retire' },
      { from: 'Confirmed', command: 'confirm' },
      { from: 'Confirmed', command: 'withdraw' },
      { from: 'Superseded', command: 'confirm' },
      { from: 'Superseded', command: 'withdraw' },
      { from: 'Superseded', command: 'supersede' },
      { from: 'Superseded', command: 'retire' },
      { from: 'Withdrawn', command: 'confirm' },
      { from: 'Withdrawn', command: 'withdraw' },
      { from: 'Withdrawn', command: 'supersede' },
      { from: 'Withdrawn', command: 'retire' },
    ]);
    for (const { from, command } of forbidden)
      expect(attempt(underwritingCaseMachine, from, command, ctx(EVERY_ROLE))).toEqual({
        ok: false,
        code: 'forbidden',
        message: `underwriting_case: ${command} is not allowed from ${from}`,
      });
  });

  it('never moves a case back: no row leads to Draft and none leaves a terminal state', () => {
    for (const t of underwritingCaseMachine.transitions) {
      expect(t.to).not.toBe('Draft');
      expect(['Superseded', 'Withdrawn']).not.toContain(t.from);
    }
  });
});

describe('valuation suggestion (docs/18 section 14, SEC-9.1)', () => {
  const act = (
    command: 'accept' | 'applyToDraft' | 'dismiss' | 'supersede',
    roles: string[],
    extra: CtxOverrides = {},
  ): TransitionResult<string> =>
    attempt(valuationSuggestionMachine, 'Open', command, ctx(roles, extra));
  const refusal = (message: string) => ({
    ok: false,
    code: 'precondition',
    message: `valuation_suggestion: ${message}`,
  });
  const NO_VALUE = 'the suggestion has no value, so there is nothing to put on a valuation';

  it('is in the registry under its table name; every decided state is terminal', () => {
    expect(MACHINES.valuationSuggestion).toBe(valuationSuggestionMachine);
    expect(valuationSuggestionMachine.name).toBe('valuation_suggestion');
    expect(valuationSuggestionMachine.states).toEqual([
      'Open',
      'Accepted',
      'Dismissed',
      'Superseded',
    ]);
    expect(valuationSuggestionMachine.commands).toEqual([
      'accept',
      'applyToDraft',
      'dismiss',
      'supersede',
    ]);
    expect(valuationSuggestionMachine.initial).toBe('Open');
    expect(valuationSuggestionMachine.terminal).toEqual(['Accepted', 'Dismissed', 'Superseded']);
  });

  it('lists exactly the four moves of the table, each with its roles', () => {
    expect(
      valuationSuggestionMachine.transitions.map(
        (t) => `${t.from} ${t.command} ${t.to}: ${t.roles.join(', ')}`,
      ),
    ).toEqual([
      'Open accept Accepted: operations',
      'Open applyToDraft Accepted: operations',
      'Open dismiss Dismissed: operations',
      'Open supersede Superseded: service',
    ]);
  });

  it('is accepted only with a value and with no version in progress for the quarter', () => {
    expect(act('accept', ['operations'])).toEqual({ ok: true, to: 'Accepted' });
    expect(act('accept', ['operations'], { record: { ...happyRecord, hasValue: false } })).toEqual(
      refusal(NO_VALUE),
    );
    // The valuation workflow's own sentence for a second version of a quarter.
    const inProgress = refusal(
      'a version for this investment and quarter is already in progress; continue that version',
    );
    expect(
      act('accept', ['operations'], { record: { ...happyRecord, versionInProgress: true } }),
    ).toEqual(inProgress);
    // A record that does not say is not taken for a quarter with no version.
    const { versionInProgress: _dropped, ...silent } = happyRecord;
    expect(act('accept', ['operations'], { record: silent })).toEqual(inProgress);
    // The value is judged first, and both checks stay listed.
    const row = valuationSuggestionMachine.transitions.find((t) => t.command === 'accept');
    expect(
      checksOf(row?.precondition).map((c) =>
        c(ctx(['operations'], { record: { hasValue: false, versionInProgress: true } })),
      ),
    ).toEqual([
      NO_VALUE,
      'a version for this investment and quarter is already in progress; continue that version',
    ]);
  });

  it('is put on a draft only with a value and with a Draft open for the quarter', () => {
    expect(act('applyToDraft', ['operations'])).toEqual({ ok: true, to: 'Accepted' });
    expect(
      act('applyToDraft', ['operations'], { record: { ...happyRecord, hasValue: false } }),
    ).toEqual(refusal(NO_VALUE));
    const noDraft = refusal(
      'no Draft is open for this investment and quarter; only a Draft can take a suggested value',
    );
    expect(
      act('applyToDraft', ['operations'], { record: { ...happyRecord, draftOpen: false } }),
    ).toEqual(noDraft);
    const { draftOpen: _dropped, ...silent } = happyRecord;
    expect(act('applyToDraft', ['operations'], { record: silent })).toEqual(noDraft);
    // A Draft in progress takes the value through applyToDraft, never through accept.
    const withDraft = { ...happyRecord, versionInProgress: true, draftOpen: true };
    expect(act('applyToDraft', ['operations'], { record: withDraft })).toEqual({
      ok: true,
      to: 'Accepted',
    });
    expect(act('accept', ['operations'], { record: withDraft }).ok).toBe(false);
  });

  it('is dismissed only with a reason', () => {
    expect(act('dismiss', ['operations'])).toEqual({ ok: true, to: 'Dismissed' });
    for (const reason of [null, '', '   '])
      expect(act('dismiss', ['operations'], { reason })).toEqual(refusal('a reason is required'));
    const row = valuationSuggestionMachine.transitions.find((t) => t.command === 'dismiss');
    expect(row?.precondition).toBe(requireReason);
  });

  it('with no value can be dismissed or superseded, never put on a valuation', () => {
    // "Not calculable" is data, not a state: such a suggestion is Open like any other.
    const record = { ...happyRecord, hasValue: false };
    expect(act('dismiss', ['operations'], { record })).toEqual({ ok: true, to: 'Dismissed' });
    expect(act('supersede', ['service'], { record })).toEqual({ ok: true, to: 'Superseded' });
    expect(act('accept', ['operations'], { record })).toEqual(refusal(NO_VALUE));
    expect(act('applyToDraft', ['operations'], { record })).toEqual(refusal(NO_VALUE));
  });

  it('is superseded only as a system step, and only for one of the four reasons', () => {
    expect(SUPERSEDED_REASONS).toEqual([
      'better_source',
      'figures_changed',
      'mark_locked',
      'position_closed',
    ]);
    for (const supersededReason of SUPERSEDED_REASONS)
      expect(
        act('supersede', ['service'], { record: { ...happyRecord, supersededReason } }),
        supersededReason,
      ).toEqual({ ok: true, to: 'Superseded' });
    const unnamed = refusal(
      'a superseded suggestion names why: a better source, changed figures, a Locked mark or a closed position',
    );
    const { supersededReason: _dropped, ...silent } = happyRecord;
    for (const record of [
      silent,
      { ...silent, supersededReason: null },
      { ...silent, supersededReason: '' },
      { ...silent, supersededReason: 'dismissed' },
      { ...silent, supersededReason: ['better_source'] },
    ])
      expect(act('supersede', ['service'], { record })).toEqual(unnamed);
    // Never a caller's command: no sign-in carries the service role.
    for (const role of EVERY_ROLE.filter((r) => r !== 'service'))
      expect(act('supersede', [role]), role).toEqual({
        ok: false,
        code: 'role',
        message: 'valuation_suggestion: supersede from Open requires one of: service',
      });
  });

  it('refuses every role the row does not name, on every row', () => {
    for (const t of valuationSuggestionMachine.transitions)
      for (const role of EVERY_ROLE.filter((r) => !t.roles.includes(r)))
        expect(
          attempt(valuationSuggestionMachine, t.from, t.command, ctx([role])),
          `${role} ${t.command} from ${t.from}`,
        ).toMatchObject({ ok: false, code: 'role' });
    // The readers of a suggestion decide nothing, and the system actor decides nothing for a person.
    for (const role of ['deal_team', 'approver', 'auditor', 'service'])
      for (const command of ['accept', 'applyToDraft', 'dismiss'] as const)
        expect(act(command, [role]), `${role} ${command}`).toEqual({
          ok: false,
          code: 'role',
          message: `valuation_suggestion: ${command} from Open requires one of: operations`,
        });
  });

  it('rejects the twelve (state, command) pairs the table does not list, for an actor holding every role', () => {
    const forbidden = forbiddenPairs(valuationSuggestionMachine);
    expect(forbidden).toEqual(
      (['Accepted', 'Dismissed', 'Superseded'] as const).flatMap((from) =>
        (['accept', 'applyToDraft', 'dismiss', 'supersede'] as const).map((command) => ({
          from,
          command,
        })),
      ),
    );
    expect(forbidden).toHaveLength(12);
    for (const { from, command } of forbidden)
      expect(attempt(valuationSuggestionMachine, from, command, ctx(EVERY_ROLE))).toEqual({
        ok: false,
        code: 'forbidden',
        message: `valuation_suggestion: ${command} is not allowed from ${from}`,
      });
  });

  it('never reopens a decided suggestion: every row leaves Open and none returns to it', () => {
    for (const t of valuationSuggestionMachine.transitions) {
      expect(t.from).toBe('Open');
      expect(t.to).not.toBe('Open');
    }
  });
});

describe('notAmong: the actor is not one of the people a record lists', () => {
  const check = notAmong('reviewers', 'a reviewer cannot approve');
  const as = (actorId: string, record: TransitionContext['record']): string | null =>
    check({ actorId, actorRoles: [], record });

  it('refuses a person on the list and passes anyone else', () => {
    expect(as('a', { reviewers: ['a', 'b'] })).toBe('a reviewer cannot approve');
    expect(as('b', { reviewers: ['a', 'b'] })).toBe('a reviewer cannot approve');
    expect(as('c', { reviewers: ['a', 'b'] })).toBeNull();
  });

  it('bars nobody with an absent list or an empty one, as notSameAs passes an absent key', () => {
    expect(as('a', {})).toBeNull();
    expect(as('a', { reviewers: undefined })).toBeNull();
    expect(as('a', { reviewers: null })).toBeNull();
    expect(as('a', { reviewers: [] })).toBeNull();
    expect(as('a', { others: ['a'] })).toBeNull();
    const same = notSameAs('reviewer', 'the reviewer cannot approve');
    expect(same({ actorId: 'a', actorRoles: [], record: {} })).toBeNull();
    // With nothing done yet the rule has nothing to say, as a page listing the rules expects.
    expect(as('', {})).toBeNull();
  });

  it('refuses a value that is there and is not a list, whoever asks', () => {
    for (const reviewers of ['a', 'a,b', { a: true }, 1, true])
      for (const actorId of ['a', 'c'])
        expect(as(actorId, { reviewers })).toBe("the record's reviewers must be a list of people");
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
