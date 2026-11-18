import type { Machine, TransitionContext } from './machine.js';
import { all, flag, notAmong, notSameAs, requireReason } from './machine.js';

// ---- 1. Valuation (docs/18 section 1) --------------------------------------------------------
export type ValuationState = 'Draft' | 'OpsPrepared' | 'DealTeamApproved' | 'Locked' | 'Reopened';
export type ValuationCommand = 'prepare' | 'sendBack' | 'dealTeamApprove' | 'lock' | 'reopen';

const notPreparer = notSameAs(
  'preparedBy',
  'the preparer cannot approve their own valuation (SEC-5.6)',
);

/**
 * A version that carries a suggested mark (section 14) names its source reviewers: whoever
 * approved a run behind a suggestion accepted onto it, and whoever typed one of its figures. None
 * of them takes either approval of the valuation, so the figures and the mark are never judged by
 * the same person. The record key sourceReviewers is the union over every Accepted suggestion
 * whose valuation is a version of the same investment and quarter (a reopen copies the mark to
 * the next version, and the rule follows the mark); a version with none bars nobody.
 */
const notSourceReviewer = notAmong(
  'sourceReviewers',
  'whoever approved or typed a figure behind the suggestion on this valuation cannot approve the valuation (SEC-5.6)',
);

export const valuationMachine: Machine<ValuationState, ValuationCommand> = {
  name: 'valuation',
  states: ['Draft', 'OpsPrepared', 'DealTeamApproved', 'Locked', 'Reopened'],
  commands: ['prepare', 'sendBack', 'dealTeamApprove', 'lock', 'reopen'],
  initial: 'Draft',
  terminal: ['Reopened'],
  transitions: [
    {
      from: 'Draft',
      to: 'OpsPrepared',
      command: 'prepare',
      roles: ['operations'],
      precondition: all(
        flag('inputsComplete', true, 'inputs are incomplete'),
        flag('validationPassed', true, 'validation has not passed'),
      ),
    },
    {
      from: 'OpsPrepared',
      to: 'Draft',
      command: 'sendBack',
      roles: ['operations', 'deal_team'],
      precondition: requireReason,
    },
    {
      from: 'OpsPrepared',
      to: 'DealTeamApproved',
      command: 'dealTeamApprove',
      roles: ['deal_team'],
      precondition: all(notPreparer, notSourceReviewer),
    },
    {
      from: 'DealTeamApproved',
      to: 'Locked',
      command: 'lock',
      roles: ['approver'],
      precondition: all(notPreparer, notSourceReviewer, (ctx) =>
        typeof ctx.record.lockHash === 'string' && ctx.record.lockHash.length > 0
          ? null
          : 'lock hash must be computed over inputs and value',
      ),
      note: 'Reports read Locked only; one Locked version per investment and period.',
    },
    {
      from: 'Locked',
      to: 'Reopened',
      command: 'reopen',
      roles: ['operations', 'approver'],
      precondition: requireReason,
      note: 'Creates a new Draft version and alerts prior approvers.',
    },
  ],
};

// ---- 2. Staging records (docs/18 section 2) --------------------------------------------------
export type StagingState = 'new' | 'validated' | 'flagged' | 'approved' | 'rejected' | 'promoted';
export type StagingCommand = 'validate' | 'flag' | 'revalidate' | 'reject' | 'approve' | 'promote';

export const stagingMachine: Machine<StagingState, StagingCommand> = {
  name: 'staging',
  states: ['new', 'validated', 'flagged', 'approved', 'rejected', 'promoted'],
  commands: ['validate', 'flag', 'revalidate', 'reject', 'approve', 'promote'],
  initial: 'new',
  terminal: ['rejected', 'promoted'],
  transitions: [
    { from: 'new', to: 'validated', command: 'validate', roles: ['service', 'operations'] },
    { from: 'new', to: 'flagged', command: 'flag', roles: ['service', 'operations'] },
    {
      from: 'flagged',
      to: 'validated',
      command: 'revalidate',
      roles: ['operations'],
      precondition: flag('edited', true, 'a flagged row must be edited before revalidation'),
    },
    {
      from: 'flagged',
      to: 'rejected',
      command: 'reject',
      roles: ['operations'],
      precondition: requireReason,
    },
    { from: 'validated', to: 'approved', command: 'approve', roles: ['operations', 'deal_team'] },
    {
      from: 'approved',
      to: 'promoted',
      command: 'promote',
      roles: ['service'],
      note: 'Single transaction with an audit event.',
    },
  ],
};

// ---- 3. Capital notice and funding (docs/18 section 3) ---------------------------------------
export type CapitalNoticeState =
  | 'Received'
  | 'Extracted'
  | 'Reviewed'
  | 'TicketDrafted'
  | 'TicketApproved'
  | 'Funded'
  | 'Reconciled';
export type CapitalNoticeCommand =
  | 'extract'
  | 'review'
  | 'draftTicket'
  | 'approveTicket'
  | 'wireChanged'
  | 'confirmFunding'
  | 'reconcile';

export const capitalNoticeMachine: Machine<CapitalNoticeState, CapitalNoticeCommand> = {
  name: 'capital_notice',
  states: [
    'Received',
    'Extracted',
    'Reviewed',
    'TicketDrafted',
    'TicketApproved',
    'Funded',
    'Reconciled',
  ],
  commands: [
    'extract',
    'review',
    'draftTicket',
    'approveTicket',
    'wireChanged',
    'confirmFunding',
    'reconcile',
  ],
  initial: 'Received',
  terminal: ['Reconciled'],
  transitions: [
    {
      from: 'Received',
      to: 'Extracted',
      command: 'extract',
      roles: ['service'],
      precondition: flag('documentIndexed', true, 'the notice document must be indexed first'),
    },
    {
      from: 'Extracted',
      to: 'Reviewed',
      command: 'review',
      roles: ['operations'],
      precondition: flag(
        'bankFieldsExtracted',
        false,
        'bank fields are never taken from extraction (SEC-12.1)',
      ),
    },
    { from: 'Reviewed', to: 'TicketDrafted', command: 'draftTicket', roles: ['operations'] },
    {
      from: 'TicketDrafted',
      to: 'TicketApproved',
      command: 'approveTicket',
      roles: ['approver', 'operations'],
      precondition: all(
        flag('ticketExists', true, 'no trade ticket is drafted'),
        notSameAs('ticketPreparedBy', 'the ticket preparer cannot approve it (SEC-12.3)'),
        flag('wireVerified', true, 'the wire instruction is not verified (SEC-12.2)'),
        flag(
          'wireChangedWithinHold',
          false,
          'the wire instruction changed recently and needs a second approval (SEC-12.3)',
        ),
        // A change verified inside the hold window: its proposer and the person whose callback
        // verified it are the first two people, the release takes a third. Both keys are null
        // when the active instruction was proposed before the window.
        notSameAs(
          'wireProposedByWithinHold',
          'the wire instruction changed recently: the person who proposed the change cannot approve the release, a third person must (SEC-12.3)',
        ),
        notSameAs(
          'wireVerifiedByWithinHold',
          'the wire instruction changed recently: the person who verified the change cannot approve the release, a third person must (SEC-12.3)',
        ),
      ),
    },
    {
      from: 'TicketApproved',
      to: 'TicketDrafted',
      command: 'wireChanged',
      roles: ['service', 'operations'],
      note: 'Any wire change returns the ticket to draft and requires callback verification.',
    },
    {
      from: 'TicketApproved',
      to: 'Funded',
      command: 'confirmFunding',
      roles: ['operations'],
      precondition: flag('ticketApproved', true, 'the ticket is not approved'),
    },
    {
      from: 'Funded',
      to: 'Reconciled',
      command: 'reconcile',
      roles: ['service', 'operations'],
      note: 'Cash Flow row promoted; unfunded recalculated.',
    },
  ],
};

// ---- 4. Deal stage (docs/18 section 4) -------------------------------------------------------
export type DealStage =
  | 'Sourced'
  | 'Screening'
  | 'Prescreen'
  | 'Diligence'
  | 'IC'
  | 'Approved'
  | 'Closing'
  | 'Closed'
  | 'Passed';
export type DealCommand = 'advance' | 'pass' | 'reopen';

const requirePassReason = (ctx: TransitionContext): string | null =>
  typeof ctx.record.passReasonCode === 'string' && ctx.record.passReasonCode.length > 0
    ? null
    : 'a pass reason code is required';

const diligenceGate = (ctx: TransitionContext): string | null => {
  if (ctx.record.requiredTasksDone === true) return null;
  if (
    ctx.actorRoles.includes('approver') &&
    ctx.reason !== undefined &&
    ctx.reason.trim().length > 0
  )
    return null;
  return 'required diligence tasks are open; an Approver may override with a reason';
};

export const dealStageMachine: Machine<DealStage, DealCommand> = {
  name: 'deal_stage',
  states: [
    'Sourced',
    'Screening',
    'Prescreen',
    'Diligence',
    'IC',
    'Approved',
    'Closing',
    'Closed',
    'Passed',
  ],
  commands: ['advance', 'pass', 'reopen'],
  initial: 'Sourced',
  terminal: ['Closed'],
  transitions: [
    { from: 'Sourced', to: 'Screening', command: 'advance', roles: ['deal_team'] },
    { from: 'Screening', to: 'Prescreen', command: 'advance', roles: ['deal_team'] },
    { from: 'Prescreen', to: 'Diligence', command: 'advance', roles: ['deal_team'] },
    {
      from: 'Diligence',
      to: 'IC',
      command: 'advance',
      roles: ['deal_team', 'approver'],
      precondition: diligenceGate,
    },
    {
      from: 'IC',
      to: 'Approved',
      command: 'advance',
      roles: ['approver'],
      precondition: flag('icDecisionRecorded', true, 'an IC decision record is required'),
    },
    {
      from: 'Approved',
      to: 'Closing',
      command: 'advance',
      roles: ['deal_team', 'operations'],
      precondition: flag(
        'closingRecordReady',
        true,
        'a close date and commitment are required to open closing',
      ),
      note: 'Opens the closing record (section 12) with the close date and commitment given.',
    },
    {
      from: 'Closing',
      to: 'Closed',
      command: 'advance',
      roles: ['operations'],
      precondition: all(
        flag('closingChecklistComplete', true, 'the closing checklist is incomplete'),
        flag('allocationTiedOut', true, 'allocations do not tie to the closing commitment (M22)'),
      ),
    },
    ...(
      ['Sourced', 'Screening', 'Prescreen', 'Diligence', 'IC', 'Approved', 'Closing'] as const
    ).map((from) => ({
      from,
      to: 'Passed' as const,
      command: 'pass' as const,
      roles: ['deal_team', 'approver'],
      precondition: requirePassReason,
    })),
    {
      from: 'Passed',
      to: 'Screening',
      command: 'reopen',
      roles: ['deal_team'],
      precondition: requireReason,
    },
  ],
};

// ---- 5. Reporting package (docs/18 section 5) ------------------------------------------------
export type ReportingPackageState =
  'Draft' | 'Generated' | 'QAFailed' | 'QAPassed' | 'InReview' | 'Approved' | 'Released';
export type ReportingPackageCommand =
  'generate' | 'qaFail' | 'qaPass' | 'regenerate' | 'overrideQa' | 'submit' | 'approve' | 'release';

export const reportingPackageMachine: Machine<ReportingPackageState, ReportingPackageCommand> = {
  name: 'reporting_package',
  states: ['Draft', 'Generated', 'QAFailed', 'QAPassed', 'InReview', 'Approved', 'Released'],
  commands: [
    'generate',
    'qaFail',
    'qaPass',
    'regenerate',
    'overrideQa',
    'submit',
    'approve',
    'release',
  ],
  initial: 'Draft',
  terminal: ['Released'],
  transitions: [
    {
      from: 'Draft',
      to: 'Generated',
      command: 'generate',
      roles: ['investor_relations', 'service'],
    },
    { from: 'Generated', to: 'QAFailed', command: 'qaFail', roles: ['service'] },
    { from: 'Generated', to: 'QAPassed', command: 'qaPass', roles: ['service'] },
    {
      from: 'QAFailed',
      to: 'Generated',
      command: 'regenerate',
      roles: ['investor_relations', 'service'],
    },
    {
      from: 'QAFailed',
      to: 'QAPassed',
      command: 'overrideQa',
      roles: ['approver'],
      precondition: requireReason,
      note: 'Audited override of a failed QA check.',
    },
    { from: 'QAPassed', to: 'InReview', command: 'submit', roles: ['investor_relations'] },
    {
      from: 'InReview',
      to: 'Approved',
      command: 'approve',
      roles: ['approver'],
      precondition: notSameAs('preparedBy', 'the package preparer cannot approve it (SEC-5.6)'),
    },
    {
      from: 'Approved',
      to: 'Released',
      command: 'release',
      roles: ['investor_relations', 'operations'],
      note: 'Released is immutable; corrections create a new version.',
    },
  ],
};

// ---- 6. Document classification (docs/18 section 6) ------------------------------------------
export type DocumentState = 'Received' | 'Classified' | 'NeedsReview' | 'Duplicate';
export type DocumentCommand = 'autoClassify' | 'flagForReview' | 'classify' | 'markDuplicate';

export const documentClassificationMachine: Machine<DocumentState, DocumentCommand> = {
  name: 'document_classification',
  states: ['Received', 'Classified', 'NeedsReview', 'Duplicate'],
  commands: ['autoClassify', 'flagForReview', 'classify', 'markDuplicate'],
  initial: 'Received',
  terminal: ['Classified', 'Duplicate'],
  transitions: [
    {
      from: 'Received',
      to: 'Classified',
      command: 'autoClassify',
      roles: ['service'],
      precondition: flag(
        'confidenceAboveThreshold',
        true,
        'classifier confidence is below the threshold',
      ),
    },
    { from: 'Received', to: 'NeedsReview', command: 'flagForReview', roles: ['service'] },
    {
      from: 'Received',
      to: 'Duplicate',
      command: 'markDuplicate',
      roles: ['service'],
      precondition: flag(
        'sameHashAsExisting',
        true,
        'only a matching content hash marks a duplicate',
      ),
    },
    {
      from: 'NeedsReview',
      to: 'Classified',
      command: 'classify',
      roles: ['deal_team', 'operations'],
    },
  ],
};

// ---- 7. Extraction run (docs/18 section 7) ---------------------------------------------------
export type ExtractionState = 'Queued' | 'Running' | 'Succeeded' | 'Failed' | 'NeedsRetry';
export type ExtractionCommand = 'start' | 'succeed' | 'fail' | 'scheduleRetry' | 'retry';

const retryBudget = (ctx: TransitionContext): string | null => {
  const schemaRetries = Number(ctx.record.schemaRetries ?? 0);
  const transientRetries = Number(ctx.record.transientRetries ?? 0);
  if (ctx.record.lastErrorKind === 'schema' && schemaRetries >= 1)
    return 'schema failures retry once, then flag';
  if (ctx.record.lastErrorKind === 'transient' && transientRetries >= 3)
    return 'transient failures retry three times, then fail';
  return null;
};

export const extractionRunMachine: Machine<ExtractionState, ExtractionCommand> = {
  name: 'extraction_run',
  states: ['Queued', 'Running', 'Succeeded', 'Failed', 'NeedsRetry'],
  commands: ['start', 'succeed', 'fail', 'scheduleRetry', 'retry'],
  initial: 'Queued',
  terminal: ['Succeeded', 'Failed'],
  transitions: [
    { from: 'Queued', to: 'Running', command: 'start', roles: ['service'] },
    { from: 'Running', to: 'Succeeded', command: 'succeed', roles: ['service'] },
    {
      from: 'Running',
      to: 'Failed',
      command: 'fail',
      roles: ['service'],
      note: 'Surfaced as a Data Exception.',
    },
    {
      from: 'Running',
      to: 'NeedsRetry',
      command: 'scheduleRetry',
      roles: ['service'],
      precondition: retryBudget,
      note: 'A schema failure retries once and a transient one three times; after that the run fails.',
    },
    { from: 'NeedsRetry', to: 'Running', command: 'retry', roles: ['service'] },
  ],
};

// ---- 8. Deal change request (docs/18 section 8) ----------------------------------------------
export type ChangeRequestState = 'Submitted' | 'Routed' | 'InProgress' | 'Applied' | 'Rejected';
export type ChangeRequestCommand = 'route' | 'start' | 'apply' | 'reject';

export const dealChangeRequestMachine: Machine<ChangeRequestState, ChangeRequestCommand> = {
  name: 'deal_change_request',
  states: ['Submitted', 'Routed', 'InProgress', 'Applied', 'Rejected'],
  commands: ['route', 'start', 'apply', 'reject'],
  initial: 'Submitted',
  terminal: ['Applied', 'Rejected'],
  transitions: [
    { from: 'Submitted', to: 'Routed', command: 'route', roles: ['deal_team', 'service'] },
    { from: 'Routed', to: 'InProgress', command: 'start', roles: ['operations'] },
    {
      from: 'Routed',
      to: 'Rejected',
      command: 'reject',
      roles: ['operations'],
      precondition: requireReason,
    },
    {
      from: 'InProgress',
      to: 'Applied',
      command: 'apply',
      roles: ['operations'],
      precondition: (ctx) =>
        typeof ctx.record.appliedPeriod === 'string' ? null : 'the applied-in period is required',
    },
    {
      from: 'InProgress',
      to: 'Rejected',
      command: 'reject',
      roles: ['operations'],
      precondition: requireReason,
    },
  ],
};

// ---- 9. Data exception (docs/18 section 9) --------------------------------------------------
export type ExceptionState = 'open' | 'acknowledged' | 'resolved' | 'wont_fix';
export type ExceptionCommand = 'acknowledge' | 'resolve' | 'wont_fix';

/**
 * ops.data_exception.state. Operations owns the queue: an exception is acknowledged while someone
 * works it, then resolved (the record or the source was fixed) or closed as wont_fix, each with a
 * reason on record. Setting the external ticket is not a transition and goes through no command
 * here. Resolved and wont_fix are terminal: a problem that comes back opens a new exception.
 */
export const exceptionMachine: Machine<ExceptionState, ExceptionCommand> = {
  name: 'data_exception',
  states: ['open', 'acknowledged', 'resolved', 'wont_fix'],
  commands: ['acknowledge', 'resolve', 'wont_fix'],
  initial: 'open',
  terminal: ['resolved', 'wont_fix'],
  transitions: [
    { from: 'open', to: 'acknowledged', command: 'acknowledge', roles: ['operations'] },
    {
      from: 'open',
      to: 'resolved',
      command: 'resolve',
      roles: ['operations'],
      precondition: requireReason,
    },
    {
      from: 'acknowledged',
      to: 'resolved',
      command: 'resolve',
      roles: ['operations'],
      precondition: requireReason,
    },
    {
      from: 'open',
      to: 'wont_fix',
      command: 'wont_fix',
      roles: ['operations'],
      precondition: requireReason,
      note: 'The difference stays as it is; the reason is the record of why.',
    },
    {
      from: 'acknowledged',
      to: 'wont_fix',
      command: 'wont_fix',
      roles: ['operations'],
      precondition: requireReason,
      note: 'The difference stays as it is; the reason is the record of why.',
    },
  ],
};

// ---- 11. Wire instruction (docs/18 section 11, SEC-12.2) -------------------------------------
export type WireInstructionState = 'Proposed' | 'Verified' | 'Rejected' | 'Superseded';
export type WireInstructionCommand = 'verify' | 'reject' | 'supersede';

/**
 * A Proposed version older than the counterparty's Verified one would supersede a newer
 * instruction if it were verified: olderThanVerified is true when such a newer version exists.
 */
const notOlderThanVerified = (ctx: TransitionContext): string | null =>
  ctx.record.olderThanVerified === true
    ? 'a newer version of this counterparty is already Verified; reject this older version instead (SEC-12.2)'
    : null;

/**
 * mon.wire_instruction.state. A new or changed instruction is a new Proposed version for its
 * counterparty. It becomes Verified only through a callback made by a person other than the
 * proposer, to an independently sourced number, that confirmed it (SEC-12.2); a later Verified
 * version supersedes it, and a Proposed version older than the Verified one is rejected, never
 * verified over it. Rejected and Superseded are terminal: a corrected instruction is proposed
 * again as a new version.
 */
export const wireInstructionMachine: Machine<WireInstructionState, WireInstructionCommand> = {
  name: 'wire_instruction',
  states: ['Proposed', 'Verified', 'Rejected', 'Superseded'],
  commands: ['verify', 'reject', 'supersede'],
  initial: 'Proposed',
  terminal: ['Rejected', 'Superseded'],
  transitions: [
    {
      from: 'Proposed',
      to: 'Verified',
      command: 'verify',
      roles: ['operations', 'approver'],
      precondition: all(
        notSameAs(
          'proposedBy',
          'the callback must be made by a person other than the proposer (SEC-12.2)',
        ),
        flag('callbackConfirmed', true, 'the callback did not confirm the instruction (SEC-12.2)'),
        notOlderThanVerified,
      ),
      note: 'The callback is logged with its date, number source and result; this version becomes the active instruction.',
    },
    {
      from: 'Proposed',
      to: 'Rejected',
      command: 'reject',
      roles: ['operations', 'approver'],
      precondition: requireReason,
    },
    {
      from: 'Verified',
      to: 'Superseded',
      command: 'supersede',
      roles: ['service', 'operations'],
      precondition: flag(
        'newerVerifiedExists',
        true,
        'only a newer Verified version supersedes this one',
      ),
    },
  ],
};

// ---- 12. Closing (docs/18 section 12, M8) ----------------------------------------------------
export type ClosingState = 'Open' | 'OpsConfirmed';
export type ClosingCommand = 'confirm' | 'changeCloseDate' | 'reopen';

/**
 * deal.closing.state. Operations confirms a closing once every required checklist item is received
 * or waived and the allocations tie to the closing commitment (M22). A close date change after
 * confirmation returns the record to Open with a reason and needs confirmation again (docs/04 M8).
 * What operations confirmed stays as confirmed: the checklist items and the allocation lines
 * change again only once the closing is reopened with a reason, by operations, or by the system
 * step when a deal that was passed and reopened reaches Closing again with a new close date and
 * commitment (section 4). No state is terminal.
 */
export const closingMachine: Machine<ClosingState, ClosingCommand> = {
  name: 'closing',
  states: ['Open', 'OpsConfirmed'],
  commands: ['confirm', 'changeCloseDate', 'reopen'],
  initial: 'Open',
  terminal: [],
  transitions: [
    {
      from: 'Open',
      to: 'OpsConfirmed',
      command: 'confirm',
      roles: ['operations'],
      precondition: all(
        flag('requiredItemsComplete', true, 'a required closing document is missing (M8)'),
        flag('allocationTiedOut', true, 'allocations do not tie to the closing commitment (M22)'),
      ),
    },
    {
      from: 'OpsConfirmed',
      to: 'Open',
      command: 'changeCloseDate',
      roles: ['operations'],
      precondition: requireReason,
      note: 'The close date is the single source for every report; the change is audited and the closing needs confirmation again.',
    },
    {
      from: 'OpsConfirmed',
      to: 'Open',
      command: 'reopen',
      roles: ['operations', 'service'],
      precondition: requireReason,
      note: 'The one way the checklist and the allocations change after confirmation; the closing needs confirmation again.',
    },
  ],
};

// ---- 13. Underwritten base case (docs/18 section 13, decision 0022) --------------------------
export type UnderwritingCaseState = 'Draft' | 'Confirmed' | 'Superseded' | 'Withdrawn';
export type UnderwritingCaseCommand = 'confirm' | 'withdraw' | 'supersede' | 'retire';

/**
 * mon.underwriting_case.state. The deal team records the sponsor's base case of a position as a
 * Draft (one per position) and may edit or withdraw it. A second person confirms it: someone on
 * the deal team or an approver, never the person who last changed the figures (record key
 * enteredBy, which every edit resets), and only once the case names its source (hasSource). Only
 * a Confirmed case is compared with the actuals, and it never changes: a later version dated as
 * it is corrects it, and the confirmation of that version supersedes it as a system step in the
 * same transaction (correctedBySameDate), never as a caller's command; a version with a later
 * date is a re-underwriting and both stay Confirmed. An approver retires a case confirmed in
 * error. Superseded and Withdrawn are terminal: a revision is always a new version.
 */
export const underwritingCaseMachine: Machine<UnderwritingCaseState, UnderwritingCaseCommand> = {
  name: 'underwriting_case',
  states: ['Draft', 'Confirmed', 'Superseded', 'Withdrawn'],
  commands: ['confirm', 'withdraw', 'supersede', 'retire'],
  initial: 'Draft',
  terminal: ['Superseded', 'Withdrawn'],
  transitions: [
    {
      from: 'Draft',
      to: 'Confirmed',
      command: 'confirm',
      roles: ['deal_team', 'approver'],
      precondition: all(
        notSameAs(
          'enteredBy',
          'the person who last changed the figures cannot confirm them (SEC-5.6)',
        ),
        flag(
          'hasSource',
          true,
          'a base case names its source before it is confirmed: a document of the position or a note on where the model is held (SEC-9.4)',
        ),
      ),
      note: 'Only a confirmed base case is compared with the actuals.',
    },
    {
      from: 'Draft',
      to: 'Withdrawn',
      command: 'withdraw',
      roles: ['deal_team'],
      precondition: requireReason,
    },
    {
      from: 'Confirmed',
      to: 'Superseded',
      command: 'supersede',
      roles: ['service'],
      precondition: flag(
        'correctedBySameDate',
        true,
        'only the confirmation of a later version with the same case date supersedes a base case',
      ),
      note: 'A step of that confirmation, in the same transaction; nobody sends it.',
    },
    {
      from: 'Confirmed',
      to: 'Withdrawn',
      command: 'retire',
      roles: ['approver'],
      precondition: requireReason,
      note: 'For a base case confirmed in error; a revision is a new version instead.',
    },
  ],
};

// ---- 14. Valuation suggestion (docs/18 section 14, decision 0023) ----------------------------
export type ValuationSuggestionState = 'Open' | 'Accepted' | 'Dismissed' | 'Superseded';
export type ValuationSuggestionCommand = 'accept' | 'applyToDraft' | 'dismiss' | 'supersede';

/**
 * Why an Open suggestion is superseded. The first two leave a replacement behind (a source earlier
 * in the order of sources arrived, or the figures behind the suggestion changed); the last two
 * leave none (a mark for the quarter or a later one is Locked, or the position is no longer one a
 * suggestion applies to).
 */
export const SUPERSEDED_REASONS = [
  'better_source',
  'figures_changed',
  'mark_locked',
  'position_closed',
] as const;
export type SupersededReason = (typeof SUPERSEDED_REASONS)[number];

const hasSuggestedValue = flag(
  'hasValue',
  true,
  'the suggestion has no value, so there is nothing to put on a valuation',
);

const supersededForAReason = (ctx: TransitionContext): string | null =>
  (SUPERSEDED_REASONS as readonly unknown[]).includes(ctx.record.supersededReason)
    ? null
    : 'a superseded suggestion names why: a better source, changed figures, a Locked mark or a closed position';

/**
 * mon.valuation_suggestion.state. The system actor opens a suggestion when a statement or a
 * sponsor report is approved for a position and quarter (one Open at most), and supersedes it
 * when a better source arrives, its figures change, a mark is Locked or the position stops being
 * one a suggestion applies to. Operations decide an Open one: accept opens a draft valuation at
 * the suggested value (record key versionInProgress: a Draft, OpsPrepared or DealTeamApproved
 * version already reports for the quarter), applyToDraft puts the value and its method on the
 * Draft already open for the quarter (draftOpen), and dismiss sets it aside with a reason. A
 * suggestion with no value (hasValue false: "not calculable" is data, never a state) can only be
 * dismissed or superseded. Accepting writes no mark: the Draft goes through the valuation
 * workflow of section 1 like any other. Accepted, Dismissed and Superseded are terminal.
 */
export const valuationSuggestionMachine: Machine<
  ValuationSuggestionState,
  ValuationSuggestionCommand
> = {
  name: 'valuation_suggestion',
  states: ['Open', 'Accepted', 'Dismissed', 'Superseded'],
  commands: ['accept', 'applyToDraft', 'dismiss', 'supersede'],
  initial: 'Open',
  terminal: ['Accepted', 'Dismissed', 'Superseded'],
  transitions: [
    {
      from: 'Open',
      to: 'Accepted',
      command: 'accept',
      roles: ['operations'],
      precondition: all(
        hasSuggestedValue,
        flag(
          'versionInProgress',
          false,
          'a version for this investment and quarter is already in progress; continue that version',
        ),
      ),
      note: 'Opens a draft valuation at the suggested value; it is prepared and approved like any other before it is Locked.',
    },
    {
      from: 'Open',
      to: 'Accepted',
      command: 'applyToDraft',
      roles: ['operations'],
      precondition: all(
        hasSuggestedValue,
        flag(
          'draftOpen',
          true,
          'no Draft is open for this investment and quarter; only a Draft can take a suggested value',
        ),
      ),
      note: 'Puts the suggested value and its method on the Draft already open for the quarter; the Draft keeps its date.',
    },
    {
      from: 'Open',
      to: 'Dismissed',
      command: 'dismiss',
      roles: ['operations'],
      precondition: requireReason,
    },
    {
      from: 'Open',
      to: 'Superseded',
      command: 'supersede',
      roles: ['service'],
      precondition: supersededForAReason,
      note: 'A step of the derivation that replaces or closes the suggestion, in the same transaction; nobody sends it.',
    },
  ],
};

export const MACHINES = {
  valuation: valuationMachine,
  staging: stagingMachine,
  capitalNotice: capitalNoticeMachine,
  dealStage: dealStageMachine,
  reportingPackage: reportingPackageMachine,
  documentClassification: documentClassificationMachine,
  extractionRun: extractionRunMachine,
  dealChangeRequest: dealChangeRequestMachine,
  exception: exceptionMachine,
  wireInstruction: wireInstructionMachine,
  closing: closingMachine,
  underwritingCase: underwritingCaseMachine,
  valuationSuggestion: valuationSuggestionMachine,
} as const;
