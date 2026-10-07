import type { Machine, TransitionContext } from './machine.js';
import { all, flag, notSameAs, requireReason } from './machine.js';

// ---- 1. Valuation (docs/18 section 1) --------------------------------------------------------
export type ValuationState = 'Draft' | 'OpsPrepared' | 'DealTeamApproved' | 'Locked' | 'Reopened';
export type ValuationCommand = 'prepare' | 'sendBack' | 'dealTeamApprove' | 'lock' | 'reopen';

const notPreparer = notSameAs(
  'preparedBy',
  'the preparer cannot approve their own valuation (SEC-5.6)',
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
      precondition: notPreparer,
    },
    {
      from: 'DealTeamApproved',
      to: 'Locked',
      command: 'lock',
      roles: ['approver'],
      precondition: all(notPreparer, (ctx) =>
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
        notSameAs('ticketPreparedBy', 'the ticket preparer cannot approve it (SEC-12.3)'),
        flag('wireVerified', true, 'the wire instruction is not verified (SEC-12.2)'),
        flag(
          'wireChangedWithinHold',
          false,
          'the wire instruction changed recently and needs a second approval (SEC-12.3)',
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
    { from: 'TicketApproved', to: 'Funded', command: 'confirmFunding', roles: ['operations'] },
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
    { from: 'Approved', to: 'Closing', command: 'advance', roles: ['deal_team', 'operations'] },
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

export const MACHINES = {
  valuation: valuationMachine,
  staging: stagingMachine,
  capitalNotice: capitalNoticeMachine,
  dealStage: dealStageMachine,
  reportingPackage: reportingPackageMachine,
  documentClassification: documentClassificationMachine,
  extractionRun: extractionRunMachine,
  dealChangeRequest: dealChangeRequestMachine,
} as const;
