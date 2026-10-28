import { z } from 'zod';
import * as s from './schemas.js';

/**
 * The Phase 3 controls (decision 0013): the valuation workflow commands (M10), capital notice
 * commands with the wire register and trade tickets (M16, SEC-12), deal change requests (M11),
 * the pipeline's opportunity record with its stage commands (M5 skeleton) and the closing record
 * with its checklist, allocations and legal terms (M8, M22). Bodies are strict; money travels as
 * decimal strings; reasons are bounded plain text. The route table these serve is CONTROL_ROUTES
 * (routes-controls.ts): the preview simulates them client side through @pb/workflows until the
 * API serves them (wave 2).
 */

/* ---- Shared shapes ---- */

/**
 * The person, wire instruction and trade ticket shapes live in schemas.ts, since the notice
 * detail carries them (M16); they are re-exported here so the imports written against this file
 * keep working.
 */
import {
  callbackNumberSource,
  callbackResult,
  capitalNoticeAlert,
  person,
  releaseBlocker,
  tradeTicketRow,
  tradeTicketState,
  wireCallback,
  wireCounterparty,
  wireInstructionRow,
  wireInstructionState,
} from './schemas.js';

export {
  callbackNumberSource,
  callbackResult,
  capitalNoticeAlert,
  person,
  releaseBlocker,
  tradeTicketRow,
  tradeTicketState,
  wireCallback,
  wireCounterparty,
  wireInstructionRow,
  wireInstructionState,
};
export type {
  CallbackNumberSource,
  CallbackResult,
  CapitalNoticeAlert,
  Person,
  ReleaseBlocker,
  TradeTicketRow,
  TradeTicketState,
  WireCallback,
  WireCounterparty,
  WireInstructionRow,
  WireInstructionState,
} from './schemas.js';

/** A record another one points at by id, with its display name. */
const namedRef = z.object({ id: s.uuid, name: z.string() });

/** A reason a person writes on a command: at least a few words, bounded, no control characters. */
const reason = s.plainText(500).min(3);

/** A decimal string strictly above zero (an amount, a commitment). */
export const positiveDecimal = s.decimalString.refine(
  (value) => !value.startsWith('-') && /[1-9]/.test(value),
  'Must be above zero',
);

/** A decimal string of zero or more (an allocation requested or received). */
export const nonNegativeDecimal = s.decimalString.refine(
  (value) => !value.startsWith('-'),
  'Must not be negative',
);

const timestamp = z.string();

/* ---- Valuations (M10, docs/18 section 1) ---- */

export const valuationCommand = z.enum([
  'prepare',
  'sendBack',
  'dealTeamApprove',
  'lock',
  'reopen',
]);
export type ValuationCommand = z.infer<typeof valuationCommand>;

/** The method inputs a version carries (mon.valuation.inputs): plain names to numbers or text. */
export const valuationInputs = z.record(
  z.string().min(1).max(100),
  z.union([z.string(), z.number()]),
);

/** The "(new) to Draft" row of docs/18 section 1: operations starts a version for a period. */
export const valuationCreateBody = z
  .object({
    investmentId: s.uuid,
    periodEnd: s.isoDate,
    method: z.string().min(1),
    fairValue: s.decimalString,
    inputs: valuationInputs.optional(),
  })
  .strict();
export type ValuationCreateBody = z.infer<typeof valuationCreateBody>;

export const valuationCommandBody = z
  .object({ command: valuationCommand, reason: reason.optional() })
  .strict();
export type ValuationCommandBody = z.infer<typeof valuationCommandBody>;

/** The batch approval screen (docs/04 M10): the two approvals, never a lock reopen or a send back. */
export const valuationBatchCommand = z.enum(['dealTeamApprove', 'lock']);
export type ValuationBatchCommand = z.infer<typeof valuationBatchCommand>;

export const valuationBatchCommandBody = z
  .object({
    command: valuationBatchCommand,
    ids: z.array(s.uuid).min(1).max(100),
    reason: reason.optional(),
  })
  .strict();
export type ValuationBatchCommandBody = z.infer<typeof valuationBatchCommandBody>;

/** One result per id, in the order sent: the new state, or the problem that refused this one. */
export const valuationBatchResult = z.object({
  results: z.array(
    z.object({
      id: s.uuid,
      ok: z.boolean(),
      state: s.valuationState.optional(),
      problem: z
        .object({ status: z.number().int(), code: z.string(), detail: z.string() })
        .optional(),
    }),
  ),
});
export type ValuationBatchResult = z.infer<typeof valuationBatchResult>;

export const valuationApprovalStep = z.enum(['ops_prepared', 'deal_team', 'final', 'reopen']);
export const valuationApprovalDecision = z.enum(['approve', 'reject', 'reopen']);

/** One row of mon.valuation_approval: who decided what at which step, and why. */
export const valuationApproval = z.object({
  id: s.uuid,
  step: valuationApprovalStep,
  decision: valuationApprovalDecision,
  actorId: s.uuid,
  actorName: z.string(),
  at: timestamp,
  reason: z.string().nullable(),
});
export type ValuationApproval = z.infer<typeof valuationApproval>;

/* ---- Deal change requests (M11, docs/18 section 8) ---- */

export const changeRequestState = z.enum([
  'Submitted',
  'Routed',
  'InProgress',
  'Applied',
  'Rejected',
]);
export type ChangeRequestState = z.infer<typeof changeRequestState>;

export const changeRequestCommand = z.enum(['route', 'start', 'apply', 'reject']);
export type ChangeRequestCommand = z.infer<typeof changeRequestCommand>;

/** A core.taxonomy_term code of the change_type domain, such as change_type.add_on_acquisition. */
export const changeTypeCode = s.taxonomyCodeOf('change_type');

/** The form's fields as plain text by name (mon.deal_change_request.details). */
export const changeRequestDetails = z.record(z.string().min(1).max(100), s.plainText(2000));

export const changeRequestRow = z.object({
  id: s.uuid,
  investmentId: s.uuid,
  investmentName: z.string(),
  changeType: changeTypeCode,
  effectiveDate: s.isoDate,
  summary: z.string(),
  details: changeRequestDetails,
  owner: person.nullable(),
  submittedBy: person,
  state: changeRequestState,
  /** The quarter end the change was applied in; null until Applied. */
  appliedPeriod: s.isoDate.nullable(),
  appliedBy: person.nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: timestamp,
  rowVersion: z.number().int(),
});
export type ChangeRequestRow = z.infer<typeof changeRequestRow>;

export const changeRequestCreateBody = z
  .object({
    investmentId: s.uuid,
    changeType: changeTypeCode,
    effectiveDate: s.isoDate,
    summary: s.plainText(200).min(3),
    details: changeRequestDetails.default({}),
  })
  .strict();
export type ChangeRequestCreateBody = z.infer<typeof changeRequestCreateBody>;

/**
 * route names the operations owner; apply names the quarter end the change was applied in
 * (docs/04 M11: an applied-in-period value before quarter close); reject needs a reason.
 */
export const changeRequestCommandBody = z.discriminatedUnion('command', [
  z.object({ command: z.literal('route'), ownerId: s.uuid }).strict(),
  z.object({ command: z.literal('start') }).strict(),
  z.object({ command: z.literal('apply'), appliedPeriod: s.quarterEndDate }).strict(),
  z.object({ command: z.literal('reject'), reason }).strict(),
]);
export type ChangeRequestCommandBody = z.infer<typeof changeRequestCommandBody>;

export const changeRequestListQuery = s.pageQuery.extend({
  investmentId: s.uuid.optional(),
  state: changeRequestState.optional(),
});

export const changeRequestPage = z.object({
  items: z.array(changeRequestRow),
  nextCursor: z.string().nullable(),
});
export type ChangeRequestPage = z.infer<typeof changeRequestPage>;

/** The quarter-end check (docs/18 section 8): every request not Applied opens a data exception. */
export const quarterEndCheckBody = z.object({ periodEnd: s.quarterEndDate }).strict();
export type QuarterEndCheckBody = z.infer<typeof quarterEndCheckBody>;

export const quarterEndCheckResult = z.object({
  periodEnd: s.isoDate,
  unapplied: z.array(changeRequestRow),
  exceptionsOpened: z.number().int(),
});
export type QuarterEndCheckResult = z.infer<typeof quarterEndCheckResult>;

/** The valuation screen: the version, its approval trail, the open change requests (M11) and the lock text. */
export const valuationDetail = s.valuationRow.extend({
  approvals: z.array(valuationApproval),
  openChangeRequests: z.array(changeRequestRow),
  /** The exact text the lock hash covers (lock.ts valuationLockText); null until prepared. */
  lockText: z.string().nullable(),
});
export type ValuationDetail = z.infer<typeof valuationDetail>;

/* ---- Wire instruction register (M16, SEC-12.2) ---- */

const digits = (min: number, max: number): z.ZodString =>
  z.string().regex(new RegExp(`^\\d{${min},${max}}$`), `${min} to ${max} digits`);

/**
 * Bank details as a person types them from a verified source (SEC-12.1: never from a document or
 * a model). Stored encrypted at the application layer and read back only by operations and
 * approvers; every other reader gets the masked form.
 */
export const bankDetails = z
  .object({
    bankName: s.plainText(200).min(1),
    accountName: s.plainText(200).min(1),
    accountNumber: digits(6, 20),
    routingCode: digits(6, 20),
    reference: s.plainText(200).min(1).optional(),
  })
  .strict();
export type BankDetails = z.infer<typeof bankDetails>;

/** The row plus the bank details in clear: null for every role but operations and approver. */
export const wireInstructionDetail = wireInstructionRow.extend({
  bankDetails: bankDetails.nullable(),
});
export type WireInstructionDetail = z.infer<typeof wireInstructionDetail>;

/** A new version for a counterparty (a sponsor fund or an investment, exactly one). */
export const wireInstructionProposeBody = z
  .object({
    sponsorFundId: s.uuid.optional(),
    investmentId: s.uuid.optional(),
    counterpartyName: s.plainText(200).min(1),
    bankDetails,
    /** How the instruction reached us, in plain words: never a document or email body. */
    sourceNote: s.plainText(500).optional(),
  })
  .strict()
  .refine((body) => (body.sponsorFundId === undefined) !== (body.investmentId === undefined), {
    message: 'Exactly one of sponsorFundId and investmentId is required',
    path: ['investmentId'],
  });
export type WireInstructionProposeBody = z.infer<typeof wireInstructionProposeBody>;

/**
 * verify records a confirming callback by a person other than the proposer (the machine refuses
 * the proposer); reject needs a reason and may record the callback that failed to confirm.
 */
export const wireInstructionCommandBody = z.discriminatedUnion('command', [
  z
    .object({
      command: z.literal('verify'),
      callbackNumberSource,
      callbackResult: z.literal('confirmed'),
    })
    .strict(),
  z
    .object({
      command: z.literal('reject'),
      callbackNumberSource: callbackNumberSource.optional(),
      callbackResult: z.literal('not_confirmed').optional(),
      reason,
    })
    .strict(),
]);
export type WireInstructionCommandBody = z.infer<typeof wireInstructionCommandBody>;

export const wireInstructionListQuery = s.pageQuery.extend({
  investmentId: s.uuid.optional(),
  sponsorFundId: s.uuid.optional(),
  state: wireInstructionState.optional(),
});

export const wireInstructionPage = z.object({
  items: z.array(wireInstructionRow),
  nextCursor: z.string().nullable(),
});
export type WireInstructionPage = z.infer<typeof wireInstructionPage>;

/* ---- Trade tickets (M16, SEC-12.3) ---- */

export const tradeTicketListQuery = s.pageQuery.extend({ state: tradeTicketState.optional() });

export const tradeTicketPage = z.object({
  items: z.array(tradeTicketRow),
  nextCursor: z.string().nullable(),
});
export type TradeTicketPage = z.infer<typeof tradeTicketPage>;

/* ---- Capital notice commands (M16, docs/18 section 3) ---- */

export const capitalNoticeCommand = z.enum([
  'extract',
  'review',
  'draftTicket',
  'approveTicket',
  'wireChanged',
  'confirmFunding',
  'reconcile',
]);
export type CapitalNoticeCommand = z.infer<typeof capitalNoticeCommand>;

const plainNoticeCommand = <C extends string>(command: C) =>
  z.object({ command: z.literal(command), reason: reason.optional() }).strict();

/**
 * draftTicket may name the funding date and amount (the notice's due date and amount otherwise);
 * wireChanged is fired by the service when a new instruction version is proposed, and a person
 * firing it may say why; every other command takes an optional reason as before.
 */
export const capitalNoticeCommandBody = z.discriminatedUnion('command', [
  plainNoticeCommand('extract'),
  plainNoticeCommand('review'),
  z
    .object({
      command: z.literal('draftTicket'),
      fundingDate: s.isoDate.optional(),
      amount: positiveDecimal.optional(),
      reason: reason.optional(),
    })
    .strict(),
  plainNoticeCommand('approveTicket'),
  plainNoticeCommand('wireChanged'),
  plainNoticeCommand('confirmFunding'),
  plainNoticeCommand('reconcile'),
]);
export type CapitalNoticeCommandBody = z.infer<typeof capitalNoticeCommandBody>;

/**
 * The notice detail with the ticket, the counterparty's active instruction (masked) and the
 * alerts is capitalNoticeDetail itself (schemas.ts), now that the API serves them on the read
 * route too; this name stays as an alias of it for the routes and tests written against it.
 */
export const capitalNoticeControlDetail = s.capitalNoticeDetail;
export type CapitalNoticeControlDetail = s.CapitalNoticeDetail;

/* ---- Pipeline: opportunities (M5 skeleton, docs/18 section 4) ---- */

export const dealStage = z.enum([
  'Sourced',
  'Screening',
  'Prescreen',
  'Diligence',
  'IC',
  'Approved',
  'Closing',
  'Closed',
  'Passed',
]);
export type DealStage = z.infer<typeof dealStage>;

export const dealTypeCode = s.taxonomyCodeOf('deal_type');
export const passReasonCode = s.taxonomyCodeOf('pass_reason');
export const diligenceWorkstreamCode = s.taxonomyCodeOf('diligence_workstream');
export const legalTermTypeCode = s.taxonomyCodeOf('legal_term_type');

export const diligenceTaskStatus = z.enum(['open', 'done', 'waived']);

export const diligenceTask = z.object({
  id: s.uuid,
  workstream: diligenceWorkstreamCode,
  title: z.string(),
  owner: person.nullable(),
  dueDate: s.isoDate.nullable(),
  status: diligenceTaskStatus,
  requiredForIc: z.boolean(),
  evidenceDocumentId: s.uuid.nullable(),
  waivedReason: z.string().nullable(),
});
export type DiligenceTask = z.infer<typeof diligenceTask>;

export const icDecisionOutcome = z.enum(['approved', 'declined', 'deferred']);

export const icDecision = z.object({
  id: s.uuid,
  decisionDate: s.isoDate,
  decision: icDecisionOutcome,
  amount: s.decimalString.nullable(),
  conditions: z.array(z.string()),
  recordedBy: person,
});
export type IcDecision = z.infer<typeof icDecision>;

/** Requested against received by vehicle and client (M5, M22). */
export const allocationRow = z.object({
  id: s.uuid,
  vehicle: namedRef,
  client: namedRef.nullable(),
  requested: s.decimalString,
  received: s.decimalString.nullable(),
});
export type AllocationRow = z.infer<typeof allocationRow>;

export const closingState = z.enum(['Open', 'OpsConfirmed']);
export type ClosingState = z.infer<typeof closingState>;

/** The allocation tie-out (M22): allocations must equal the closing commitment or closing cannot complete. */
export const allocationTieOut = z.object({
  commitment: s.decimalString,
  allocated: s.decimalString,
  difference: s.decimalString,
  tiedOut: z.boolean(),
});
export type AllocationTieOut = z.infer<typeof allocationTieOut>;

export const closingSummary = z.object({
  id: s.uuid,
  /** The single source of every close date (docs/04 M8). */
  closeDate: s.isoDate,
  commitmentAmount: s.decimalString,
  currency: z.string(),
  state: closingState,
  opsConfirmedBy: person.nullable(),
  opsConfirmedAt: timestamp.nullable(),
  itemsOpen: z.number().int(),
  itemsRequiredOpen: z.number().int(),
  allocationTieOut,
});
export type ClosingSummary = z.infer<typeof closingSummary>;

export const opportunityRow = z.object({
  id: s.uuid,
  name: z.string(),
  companyName: z.string(),
  sponsor: namedRef,
  sponsorFund: namedRef.nullable(),
  dealType: dealTypeCode,
  sector: z.string().nullable(),
  geography: z.string().nullable(),
  stage: dealStage,
  owner: person.nullable(),
  receivedDate: s.isoDate,
  targetCommitment: s.decimalString.nullable(),
  currency: z.string(),
  /** Days since the stage was entered, against config pipeline.stageAgingDays. */
  daysInStage: z.number().int(),
  passReasonCode: passReasonCode.nullable(),
  /** The investment the opportunity became on close. */
  investmentId: s.uuid.nullable(),
  rowVersion: z.number().int(),
});
export type OpportunityRow = z.infer<typeof opportunityRow>;

export const stageHistoryEntry = z.object({
  fromStage: dealStage.nullable(),
  toStage: dealStage,
  command: z.string(),
  reason: z.string().nullable(),
  changedBy: person,
  changedAt: timestamp,
});
export type StageHistoryEntry = z.infer<typeof stageHistoryEntry>;

/** The gates the stage commands check (docs/18 section 4), shown before a person tries them. */
export const opportunityGates = z.object({
  diligence: z.object({ requiredOpen: z.number().int(), ok: z.boolean() }),
  icDecision: z.object({ ok: z.boolean() }),
  closing: z.object({
    checklistComplete: z.boolean(),
    allocationTiedOut: z.boolean(),
    ok: z.boolean(),
  }),
});
export type OpportunityGates = z.infer<typeof opportunityGates>;

export const opportunityDetail = opportunityRow.extend({
  source: z.string().nullable(),
  passNote: z.string().nullable(),
  stageHistory: z.array(stageHistoryEntry),
  diligenceTasks: z.array(diligenceTask),
  icDecisions: z.array(icDecision),
  allocations: z.array(allocationRow),
  closing: closingSummary.nullable(),
  gates: opportunityGates,
});
export type OpportunityDetail = z.infer<typeof opportunityDetail>;

export const opportunityCreateBody = z
  .object({
    name: s.plainText(200).min(1),
    companyName: s.plainText(200).min(1),
    sponsorId: s.uuid,
    sponsorFundId: s.uuid.optional(),
    dealType: dealTypeCode,
    sector: s.taxonomyCodeOf('sector').optional(),
    geography: s.taxonomyCodeOf('geography').optional(),
    receivedDate: s.isoDate,
    targetCommitment: positiveDecimal.optional(),
    source: s.plainText(500).optional(),
  })
  .strict();
export type OpportunityCreateBody = z.infer<typeof opportunityCreateBody>;

export const opportunityCommand = z.enum(['advance', 'pass', 'reopen']);
export type OpportunityCommand = z.infer<typeof opportunityCommand>;

/**
 * advance moves to the next stage; from Approved to Closing it opens the closing record, so the
 * close date and the commitment amount travel together (the API requires both on that step and
 * ignores them elsewhere). pass needs a reason code (docs/04 M5); reopen (Passed to Screening)
 * needs a reason.
 */
export const opportunityCommandBody = z
  .discriminatedUnion('command', [
    z
      .object({
        command: z.literal('advance'),
        reason: reason.optional(),
        closeDate: s.isoDate.optional(),
        commitmentAmount: positiveDecimal.optional(),
      })
      .strict(),
    z
      .object({
        command: z.literal('pass'),
        passReasonCode,
        note: s.plainText(2000).optional(),
      })
      .strict(),
    z.object({ command: z.literal('reopen'), reason }).strict(),
  ])
  .superRefine((body, ctx) => {
    if (body.command !== 'advance') return;
    if ((body.closeDate === undefined) !== (body.commitmentAmount === undefined))
      ctx.addIssue({
        code: 'custom',
        path: [body.closeDate === undefined ? 'closeDate' : 'commitmentAmount'],
        message: 'A close date and a commitment amount are given together',
      });
  });
export type OpportunityCommandBody = z.infer<typeof opportunityCommandBody>;

export const diligenceTaskCommandBody = z.discriminatedUnion('command', [
  z.object({ command: z.literal('complete'), evidenceDocumentId: s.uuid.optional() }).strict(),
  z.object({ command: z.literal('waive'), reason }).strict(),
  z.object({ command: z.literal('reopen') }).strict(),
]);
export type DiligenceTaskCommandBody = z.infer<typeof diligenceTaskCommandBody>;

export const diligenceTaskCreateBody = z
  .object({
    workstream: diligenceWorkstreamCode,
    title: s.plainText(200).min(1),
    ownerId: s.uuid.optional(),
    dueDate: s.isoDate.optional(),
    requiredForIc: z.boolean(),
  })
  .strict();
export type DiligenceTaskCreateBody = z.infer<typeof diligenceTaskCreateBody>;

export const icDecisionBody = z
  .object({
    decisionDate: s.isoDate,
    decision: icDecisionOutcome,
    amount: positiveDecimal.optional(),
    conditions: z.array(s.plainText(500).min(1)).max(50),
  })
  .strict();
export type IcDecisionBody = z.infer<typeof icDecisionBody>;

/** The whole allocation list at once: what is sent replaces what was there. */
export const allocationsPutBody = z
  .object({
    allocations: z
      .array(
        z
          .object({
            vehicleId: s.uuid,
            clientId: s.uuid.optional(),
            requested: nonNegativeDecimal,
            received: nonNegativeDecimal.optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();
export type AllocationsPutBody = z.infer<typeof allocationsPutBody>;

export const opportunityListQuery = s.pageQuery.extend({
  stage: dealStage.optional(),
  ownerId: s.uuid.optional(),
});

/** The board groups rows by stage client side. */
export const opportunityPage = z.object({
  items: z.array(opportunityRow),
  nextCursor: z.string().nullable(),
});
export type OpportunityPage = z.infer<typeof opportunityPage>;

/* ---- Closing (M8) and legal terms (M22) ---- */

export const closingItemStatus = z.enum(['open', 'received', 'waived']);

/** One required-document checklist item (config/closing_checklist.json). */
export const closingItem = z.object({
  id: s.uuid,
  itemCode: z.string(),
  label: z.string(),
  required: z.boolean(),
  documentId: s.uuid.nullable(),
  status: closingItemStatus,
  waivedReason: z.string().nullable(),
});
export type ClosingItem = z.infer<typeof closingItem>;

export const closingItemCommandBody = z.discriminatedUnion('command', [
  z.object({ command: z.literal('receive'), documentId: s.uuid }).strict(),
  z.object({ command: z.literal('waive'), reason }).strict(),
  z.object({ command: z.literal('reopen') }).strict(),
]);
export type ClosingItemCommandBody = z.infer<typeof closingItemCommandBody>;

export const closingCommand = z.enum(['confirm', 'changeCloseDate']);
export type ClosingCommand = z.infer<typeof closingCommand>;

/** confirm is the operations confirmation; changeCloseDate after it needs a reason and re-confirmation (docs/04 M8). */
export const closingCommandBody = z.discriminatedUnion('command', [
  z.object({ command: z.literal('confirm') }).strict(),
  z.object({ command: z.literal('changeCloseDate'), closeDate: s.isoDate, reason }).strict(),
]);
export type ClosingCommandBody = z.infer<typeof closingCommandBody>;

export const legalTermStatus = z.enum(['draft', 'confirmed']);

/** A term's structured value by field name (deal.legal_term.value). */
export const legalTermValue = z.record(
  z.string().min(1).max(100),
  z.union([z.string(), z.number(), z.boolean()]),
);

export const legalTerm = z.object({
  id: s.uuid,
  termType: legalTermTypeCode,
  value: legalTermValue,
  sourceDocumentId: s.uuid.nullable(),
  status: legalTermStatus,
  confirmedBy: person.nullable(),
});
export type LegalTerm = z.infer<typeof legalTerm>;

export const legalTermCreateBody = z
  .object({
    termType: legalTermTypeCode,
    value: legalTermValue,
    sourceDocumentId: s.uuid.optional(),
  })
  .strict();
export type LegalTermCreateBody = z.infer<typeof legalTermCreateBody>;

export const legalTermCommandBody = z.object({ command: z.literal('confirm') }).strict();
export type LegalTermCommandBody = z.infer<typeof legalTermCommandBody>;

export const closingDetail = closingSummary.extend({
  opportunityId: s.uuid,
  investmentId: s.uuid.nullable(),
  items: z.array(closingItem),
  legalTerms: z.array(legalTerm),
  allocations: z.array(allocationRow),
  rowVersion: z.number().int(),
});
export type ClosingDetail = z.infer<typeof closingDetail>;
