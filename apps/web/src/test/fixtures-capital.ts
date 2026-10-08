import type {
  CapitalNoticeDetail,
  CapitalNoticePage,
  CapitalNoticeRow,
  CommitmentList,
  FundCommitmentRow,
} from '@pb/contracts';
import { AS_OF, ID, noticeFixture } from './fixtures.js';

/* Contract-shaped synthetic fixtures for the capital activity pages (docs/12 section 4: synthetic data only). */

export const NOTICE_ID = {
  received: '00000000-0000-4000-8000-000000000401',
  extracted: '00000000-0000-4000-8000-000000000402',
  reviewed: '00000000-0000-4000-8000-000000000403',
  drafted: '00000000-0000-4000-8000-000000000404',
  funded: '00000000-0000-4000-8000-000000000405',
  reconciled: '00000000-0000-4000-8000-000000000406',
} as const;

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

/** The wire-change capital call in Extracted, with its hold, one note and no cash flows yet. */
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
