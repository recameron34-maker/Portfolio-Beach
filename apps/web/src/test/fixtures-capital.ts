import type {
  CapitalNoticeDetail,
  CapitalNoticePage,
  CapitalNoticeRow,
  CommitmentList,
  FundCommitmentRow,
  Person,
  TradeTicketPage,
  TradeTicketRow,
  WireInstructionDetail,
  WireInstructionPage,
  WireInstructionRow,
} from '@pb/contracts';
import { AS_OF, ID, noticeFixture } from './fixtures.js';
import { USER_ID } from './fixtures-valuations.js';

/* Contract-shaped synthetic fixtures for the capital activity pages (docs/12 section 4: synthetic data only). */

export const NOTICE_ID = {
  received: '00000000-0000-4000-8000-000000000401',
  extracted: '00000000-0000-4000-8000-000000000402',
  reviewed: '00000000-0000-4000-8000-000000000403',
  drafted: '00000000-0000-4000-8000-000000000404',
  funded: '00000000-0000-4000-8000-000000000405',
  reconciled: '00000000-0000-4000-8000-000000000406',
} as const;

/* ---- The wire register and the trade tickets (M16, SEC-12) ---- */

export const WIRE_ID = {
  /** Silverline's sponsor fund, version 1: Verified and active. */
  verified: '00000000-0000-4000-8000-000000000701',
  /** The same fund, version 2: Proposed by ops.one from the changed notice, waiting for its callback. */
  proposed: '00000000-0000-4000-8000-000000000702',
  /** Summit Services Co (investment level), version 1: Verified and active. */
  summit: '00000000-0000-4000-8000-000000000703',
  /** Summit, version 2: Rejected after a callback that did not confirm. */
  rejected: '00000000-0000-4000-8000-000000000704',
} as const;

export const TICKET_ID = {
  drafted: '00000000-0000-4000-8000-000000000801',
  approved: '00000000-0000-4000-8000-000000000802',
  funded: '00000000-0000-4000-8000-000000000803',
} as const;

export const SPONSOR_FUND_ID = {
  silverline: '00000000-0000-4000-8000-000000000611',
} as const;

/** The people on the register and the tickets: ops.one proposes and prepares, ops.two calls back, head.one approves. */
export const PERSON: Readonly<Record<'opsOne' | 'opsTwo' | 'approver', Person>> = {
  opsOne: { id: USER_ID.ops, name: 'Priya Lindqvist' },
  opsTwo: { id: '00000000-0000-4000-8000-000000000304', name: 'Tomas Achterberg' },
  approver: { id: USER_ID.approver, name: 'Mina Halvorsen' },
};

export function wireRowFixture(overrides: Partial<WireInstructionRow> = {}): WireInstructionRow {
  return {
    id: WIRE_ID.verified,
    counterparty: {
      kind: 'sponsor_fund',
      id: SPONSOR_FUND_ID.silverline,
      name: 'Silverline Partners Fund II',
    },
    version: 1,
    state: 'Verified',
    bankDetailsMasked: 'Harbor Street Bank ****4821',
    proposedBy: PERSON.opsOne,
    proposedAt: '2024-03-04T10:00:00.000Z',
    sourceNote: 'Typed from the signed subscription pack',
    callback: {
      by: PERSON.opsTwo,
      at: '2024-03-05T15:30:00.000Z',
      numberSource: 'prior_instruction',
      result: 'confirmed',
    },
    verifiedAt: '2024-03-05T15:30:00.000Z',
    rejectionReason: null,
    active: true,
    rowVersion: 2,
    ...overrides,
  };
}

/** Four versions over two counterparties: an active one and a Proposed change, an active one and a rejected change. */
export function wireRows(): WireInstructionRow[] {
  return [
    wireRowFixture({
      id: WIRE_ID.proposed,
      version: 2,
      state: 'Proposed',
      bankDetailsMasked: 'Northline Trust ****9930',
      proposedAt: '2025-07-10T09:00:00.000Z',
      sourceNote: 'Changed instructions received in the notice',
      callback: null,
      verifiedAt: null,
      active: false,
      rowVersion: 1,
    }),
    wireRowFixture({
      id: WIRE_ID.rejected,
      counterparty: { kind: 'investment', id: ID.inv3, name: 'Summit Services Co' },
      version: 2,
      state: 'Rejected',
      bankDetailsMasked: 'Meridian Clearing ****1177',
      proposedAt: '2025-05-02T11:00:00.000Z',
      sourceNote: null,
      callback: {
        by: PERSON.opsTwo,
        at: '2025-05-03T11:00:00.000Z',
        numberSource: 'known_contact',
        result: 'not_confirmed',
      },
      verifiedAt: null,
      rejectionReason: 'The contact did not recognise the account',
      active: false,
      rowVersion: 2,
    }),
    wireRowFixture(),
    wireRowFixture({
      id: WIRE_ID.summit,
      counterparty: { kind: 'investment', id: ID.inv3, name: 'Summit Services Co' },
      bankDetailsMasked: 'Meridian Clearing ****2204',
      proposedAt: '2023-11-20T10:00:00.000Z',
      callback: {
        by: PERSON.approver,
        at: '2023-11-21T10:00:00.000Z',
        numberSource: 'fund_administrator',
        result: 'confirmed',
      },
      verifiedAt: '2023-11-21T10:00:00.000Z',
    }),
  ];
}

export function wirePageFixture(
  items: WireInstructionRow[] = wireRows(),
  nextCursor: string | null = null,
): WireInstructionPage {
  return { items, nextCursor };
}

/** The clear bank details operations and approvers read (synthetic digits; null for every other role). */
export const CLEAR_DETAILS = {
  bankName: 'Northline Trust',
  accountName: 'Silverline Partners Fund II',
  accountNumber: '4455667799',
  routingCode: '021000021',
  reference: 'Capital account 44',
} as const;

export function wireDetailFixture(
  row: WireInstructionRow = wireRows()[0] ?? wireRowFixture(),
  clear = true,
): WireInstructionDetail {
  return { ...row, bankDetails: clear ? { ...CLEAR_DETAILS } : null };
}

export function ticketFixture(overrides: Partial<TradeTicketRow> = {}): TradeTicketRow {
  return {
    id: TICKET_ID.drafted,
    capitalNoticeId: NOTICE_ID.extracted,
    amount: '2500000.00',
    currency: 'USD',
    fundingDate: '2025-07-12',
    preparedBy: PERSON.opsOne,
    preparedAt: '2025-07-10T09:05:00.000Z',
    approvedBy: null,
    approvedAt: null,
    wireInstruction: null,
    state: 'Drafted',
    release: { allowed: false, blockers: ['changed_within_hold', 'same_person'] },
    rowVersion: 1,
    ...overrides,
  };
}

/** One ticket per state the API serves: drafted and held, approved against version 1, funded. */
export function ticketRows(): TradeTicketRow[] {
  return [
    ticketFixture(),
    ticketFixture({
      id: TICKET_ID.approved,
      capitalNoticeId: NOTICE_ID.drafted,
      amount: '1200000.00',
      fundingDate: '2025-07-02',
      preparedAt: '2025-06-23T09:00:00.000Z',
      approvedBy: PERSON.approver,
      approvedAt: '2025-06-24T09:00:00.000Z',
      wireInstruction: {
        id: WIRE_ID.summit,
        version: 1,
        state: 'Verified',
        bankDetailsMasked: 'Meridian Clearing ****2204',
      },
      state: 'Approved',
      release: { allowed: true, blockers: [] },
      rowVersion: 2,
    }),
    ticketFixture({
      id: TICKET_ID.funded,
      capitalNoticeId: NOTICE_ID.funded,
      amount: '212500.00',
      fundingDate: '2025-06-25',
      preparedAt: '2025-06-16T09:00:00.000Z',
      approvedBy: PERSON.approver,
      approvedAt: '2025-06-17T09:00:00.000Z',
      wireInstruction: {
        id: WIRE_ID.summit,
        version: 1,
        state: 'Verified',
        bankDetailsMasked: 'Meridian Clearing ****2204',
      },
      state: 'Funded',
      release: { allowed: false, blockers: [] },
      rowVersion: 3,
    }),
  ];
}

export function ticketPageFixture(
  items: TradeTicketRow[] = ticketRows(),
  nextCursor: string | null = null,
): TradeTicketPage {
  return { items, nextCursor };
}

const COMMITMENT_ID = {
  kelpwood: '00000000-0000-4000-8000-000000000501',
  oysterbed: '00000000-0000-4000-8000-000000000502',
  seagrass: '00000000-0000-4000-8000-000000000503',
  seagrassClient: '00000000-0000-4000-8000-000000000504',
  skerry: '00000000-0000-4000-8000-000000000505',
} as const;

const SMA_VEHICLE = '00000000-0000-4000-8000-0000000000b5';
const PRIMARY_VEHICLE = '00000000-0000-4000-8000-0000000000b6';

/** One notice in most states, across calls, distributions and credit payments. */
export function noticeRows(): CapitalNoticeRow[] {
  return [
    noticeFixture({
      id: NOTICE_ID.extracted,
      state: 'Extracted',
      investmentId: ID.inv2,
      investmentNumber: 'INV-0004',
      companyName: 'Silverline Staffing Holdings',
      issueDate: '2025-07-10',
      dueDate: '2025-07-12',
      amount: '2500000.00',
      split: { investment: '2500000.00' },
      scenarioTag: 'wire_change',
      daysToDue: 12,
    }),
    noticeFixture({
      id: NOTICE_ID.drafted,
      state: 'TicketDrafted',
      vehicleId: ID.vehicle2,
      vehicleName: 'Beach Credit Partners I',
      investmentId: ID.inv3,
      investmentNumber: 'INV-0013',
      companyName: 'Summit Services Co',
      noticeType: 'notice_type.capital_call',
      issueDate: '2025-06-22',
      dueDate: '2025-07-02',
      amount: '1200000.00',
      split: { investment: '1150000.00', fees: '50000.00' },
      daysToDue: 2,
    }),
    noticeFixture({
      id: NOTICE_ID.reviewed,
      state: 'Reviewed',
      noticeType: 'notice_type.distribution',
      vehicleId: PRIMARY_VEHICLE,
      vehicleName: 'Beach Primary Program',
      investmentId: null,
      investmentNumber: null,
      companyName: null,
      commitmentId: COMMITMENT_ID.kelpwood,
      sponsorFundName: 'Kelpwood Fund I',
      issueDate: '2025-06-17',
      dueDate: '2025-06-27',
      amount: '3776500.00',
      daysToDue: -3,
    }),
    noticeFixture({
      id: NOTICE_ID.funded,
      state: 'Funded',
      noticeType: 'notice_type.interest_payment',
      vehicleId: ID.vehicle2,
      vehicleName: 'Beach Credit Partners I',
      investmentId: ID.inv3,
      investmentNumber: 'INV-0013',
      companyName: 'Summit Services Co',
      issueDate: '2025-06-15',
      dueDate: '2025-06-25',
      amount: '212500.00',
      settledAmount: '212500.00',
      daysToDue: -5,
    }),
    noticeFixture({
      id: NOTICE_ID.reconciled,
      state: 'Reconciled',
      noticeType: 'notice_type.equalization',
      vehicleName: 'Beach Co-Invest Fund III',
      investmentId: null,
      investmentNumber: null,
      companyName: null,
      commitmentId: COMMITMENT_ID.kelpwood,
      sponsorFundName: 'Kelpwood Fund I',
      issueDate: '2025-01-05',
      dueDate: '2025-01-15',
      amount: '1000000.00',
      split: { equalization: '950000.00', interest: '50000.00' },
      scenarioTag: 'equalization',
      settledAmount: '1000000.00',
      daysToDue: -166,
    }),
    noticeFixture({
      id: NOTICE_ID.received,
      state: 'Received',
      noticeType: 'notice_type.principal_repayment',
      vehicleId: ID.vehicle2,
      vehicleName: 'Beach Credit Partners I',
      investmentId: ID.inv3,
      investmentNumber: 'INV-0013',
      companyName: 'Summit Services Co',
      issueDate: '2025-06-30',
      dueDate: '2025-07-20',
      amount: '496885.57',
      daysToDue: 20,
    }),
  ];
}

/** The list response: attention holds everything not yet Reconciled, as the API defines it. */
export function noticePageFixture(
  items: CapitalNoticeRow[] = noticeRows(),
  nextCursor: string | null = null,
): CapitalNoticePage {
  return {
    items,
    nextCursor,
    asOf: AS_OF,
    attention: items.filter((n) => n.state !== 'Reconciled'),
    alertDaysBeforeDue: 3,
  };
}

/**
 * The wire-change capital call in Extracted, with its hold, one note and no cash flows yet; its
 * ticket is Drafted and held, version 1 of its sponsor fund is the active instruction, and it
 * carries the three SEC-12.4 alerts the synthetic scenario sets.
 */
export function noticeDetailFixture(
  overrides: Partial<CapitalNoticeDetail> = {},
): CapitalNoticeDetail {
  const row = noticeRows().find((n) => n.id === NOTICE_ID.extracted);
  if (row === undefined) throw new Error('fixture: no extracted notice');
  return {
    ...row,
    cashFlows: [],
    wireChangeHold: { until: '2025-07-30', holdDays: 30 },
    notes: ['The notice carries changed bank details; the instructions on file are unchanged.'],
    ticket: ticketFixture(),
    activeWireInstruction: wireRowFixture(),
    alerts: ['wire_changed', 'urgency_language', 'due_within_two_business_days'],
    ...overrides,
  };
}

/** A reconciled detail with its approved cash flows and no hold. */
export function settledDetailFixture(): CapitalNoticeDetail {
  const row = noticeRows().find((n) => n.id === NOTICE_ID.reconciled);
  if (row === undefined) throw new Error('fixture: no reconciled notice');
  return {
    ...row,
    cashFlows: [
      {
        date: '2025-01-15',
        flowType: 'flow_type.recallable',
        amount: '1000000.00',
        status: 'record_status.approved',
      },
    ],
    wireChangeHold: null,
    notes: [],
    ticket: ticketRows()[2] ?? null,
    activeWireInstruction: wireRows()[3] ?? null,
    alerts: [],
  };
}

function commitment(overrides: Partial<FundCommitmentRow>): FundCommitmentRow {
  return {
    id: COMMITMENT_ID.kelpwood,
    vehicleId: PRIMARY_VEHICLE,
    vehicleName: 'Beach Primary Program',
    vehicleType: 'vehicle_type.primary_program',
    sponsorId: ID.sponsor1,
    sponsorName: 'Kelpwood Capital Partners',
    sponsorFundId: '00000000-0000-4000-8000-000000000601',
    sponsorFundName: 'Kelpwood Fund I',
    vintage: 2015,
    strategy: 'strategy.buyout',
    clientName: null,
    amount: '25000000.00',
    called: '22775000',
    distributed: '3776500',
    recallable: '0',
    unfunded: '2225000',
    commitmentDate: '2015-03-31',
    ...overrides,
  };
}

/**
 * Five commitments: one over-called (negative unfunded), one client-directed with no recorded cash
 * flow, and one sponsor fund committed to from two accounts. Totals are what the API reports.
 */
export function commitmentListFixture(): CommitmentList {
  return {
    asOf: AS_OF,
    items: [
      commitment({}),
      commitment({
        id: COMMITMENT_ID.oysterbed,
        sponsorId: '00000000-0000-4000-8000-0000000000c2',
        sponsorName: 'Oysterbed Direct Lending',
        sponsorFundId: '00000000-0000-4000-8000-000000000602',
        sponsorFundName: 'Oysterbed Credit Fund I',
        vintage: 2016,
        strategy: 'strategy.credit',
        amount: '31000000.00',
        called: '32427000',
        distributed: '1000000',
        recallable: '1000000',
        unfunded: '-427000',
        commitmentDate: '2016-03-31',
      }),
      commitment({
        id: COMMITMENT_ID.seagrass,
        sponsorId: '00000000-0000-4000-8000-0000000000c3',
        sponsorName: 'Seagrass Equity Partners',
        sponsorFundId: '00000000-0000-4000-8000-000000000603',
        sponsorFundName: 'Seagrass Growth Fund II',
        vintage: 2018,
        strategy: 'strategy.growth',
        amount: '16000000.00',
        called: '15504000',
        distributed: '0',
        recallable: '0',
        unfunded: '496000',
        commitmentDate: '2018-09-30',
      }),
      commitment({
        id: COMMITMENT_ID.skerry,
        sponsorId: '00000000-0000-4000-8000-0000000000c4',
        sponsorName: 'Skerry Partners',
        sponsorFundId: '00000000-0000-4000-8000-000000000604',
        sponsorFundName: 'Skerry Fund I',
        vintage: 2019,
        amount: '42000000.00',
        called: '38178000',
        distributed: '0',
        recallable: '0',
        unfunded: '3822000',
        commitmentDate: '2019-06-30',
      }),
      commitment({
        id: COMMITMENT_ID.seagrassClient,
        vehicleId: SMA_VEHICLE,
        vehicleName: 'Client Gamma Separate Account',
        vehicleType: 'vehicle_type.client_sma',
        sponsorId: '00000000-0000-4000-8000-0000000000c3',
        sponsorName: 'Seagrass Equity Partners',
        sponsorFundId: '00000000-0000-4000-8000-000000000603',
        sponsorFundName: 'Seagrass Growth Fund II',
        vintage: 2018,
        strategy: 'strategy.growth',
        clientName: 'Client Gamma Insurance',
        amount: '6000000.00',
        called: null,
        distributed: null,
        recallable: null,
        unfunded: null,
        commitmentDate: '2018-12-31',
      }),
    ],
    totals: {
      amount: '120000000',
      called: '108884000',
      distributed: '4776500',
      unfunded: '6116000',
    },
    calcVersion: '0.1.0',
  };
}
