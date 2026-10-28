import type {
  AllocationRow,
  ClientList,
  ClosingDetail,
  ClosingItem,
  ClosingSummary,
  DiligenceTask,
  IcDecision,
  LegalTerm,
  OpportunityDetail,
  OpportunityPage,
  OpportunityRow,
  Taxonomy,
} from '@pb/contracts';
import { AS_OF, ID } from './fixtures.js';
import { USER_ID } from './fixtures-valuations.js';
import { VS_ID } from './fixtures-vehicles-sponsors.js';

/* Contract-shaped synthetic fixtures for the pipeline, opportunity and closing pages (docs/12 section 4: synthetic data only). */

export const OPP_ID = {
  sourced: '00000000-0000-4000-8000-000000000401',
  screening: '00000000-0000-4000-8000-000000000402',
  prescreen: '00000000-0000-4000-8000-000000000403',
  diligence: '00000000-0000-4000-8000-000000000404',
  ic: '00000000-0000-4000-8000-000000000405',
  approved: '00000000-0000-4000-8000-000000000406',
  closing: '00000000-0000-4000-8000-000000000407',
  closed: '00000000-0000-4000-8000-000000000408',
  passed: '00000000-0000-4000-8000-000000000409',
} as const;

export const PIPE_ID = {
  closing: '00000000-0000-4000-8000-000000000501',
  taskCommercial: '00000000-0000-4000-8000-000000000511',
  taskFinancial: '00000000-0000-4000-8000-000000000512',
  taskLegal: '00000000-0000-4000-8000-000000000513',
  taskTax: '00000000-0000-4000-8000-000000000514',
  decision: '00000000-0000-4000-8000-000000000521',
  allocationA: '00000000-0000-4000-8000-000000000531',
  allocationB: '00000000-0000-4000-8000-000000000532',
  itemSigned: '00000000-0000-4000-8000-000000000541',
  itemCapTable: '00000000-0000-4000-8000-000000000542',
  itemFundsFlow: '00000000-0000-4000-8000-000000000543',
  itemWire: '00000000-0000-4000-8000-000000000544',
  itemConsents: '00000000-0000-4000-8000-000000000545',
  itemSideLetter: '00000000-0000-4000-8000-000000000546',
  itemMemo: '00000000-0000-4000-8000-000000000547',
  termFee: '00000000-0000-4000-8000-000000000551',
  termMfn: '00000000-0000-4000-8000-000000000552',
  document: '00000000-0000-4000-8000-000000000561',
  sponsorFund: VS_ID.fundOne,
  investment: '00000000-0000-4000-8000-000000000571',
} as const;

/** The paths the pages read and write, exactly as the api file builds them. */
export const PIPE_PATHS = {
  me: '/api/v1/auth/me',
  board: '/api/v1/opportunities?limit=200',
  taxonomy: '/api/v1/taxonomy',
  sponsors: '/api/v1/sponsors?limit=200',
  vehicles: '/api/v1/vehicles',
  clients: '/api/v1/clients',
  create: '/api/v1/opportunities',
  opportunity: (id: string): string => `/api/v1/opportunities/${id}`,
  commands: (id: string): string => `/api/v1/opportunities/${id}/commands`,
  tasks: (id: string): string => `/api/v1/opportunities/${id}/diligence-tasks`,
  taskCommands: (id: string, taskId: string): string =>
    `/api/v1/opportunities/${id}/diligence-tasks/${taskId}/commands`,
  decisions: (id: string): string => `/api/v1/opportunities/${id}/ic-decisions`,
  allocations: (id: string): string => `/api/v1/opportunities/${id}/allocations`,
  closing: (id: string): string => `/api/v1/closings/${id}`,
  closingCommands: (id: string): string => `/api/v1/closings/${id}/commands`,
  itemCommands: (id: string, code: string): string =>
    `/api/v1/closings/${id}/items/${code}/commands`,
  terms: (id: string): string => `/api/v1/closings/${id}/legal-terms`,
  termCommands: (id: string, termId: string): string =>
    `/api/v1/closings/${id}/legal-terms/${termId}/commands`,
} as const;

const DEAL_LEAD = { id: USER_ID.deal, name: 'Blake Mbeki' };
const OPS = { id: USER_ID.ops, name: 'Rowan Castellanos' };
const HEAD = { id: USER_ID.approver, name: 'Harper Lindqvist' };

export function opportunityRowFixture(overrides: Partial<OpportunityRow> = {}): OpportunityRow {
  return {
    id: OPP_ID.diligence,
    name: 'Project Dune',
    companyName: 'Dune Logistics Holdings',
    sponsor: { id: ID.sponsor1, name: 'Kelpwood Capital Partners' },
    sponsorFund: { id: PIPE_ID.sponsorFund, name: 'Kelpwood Fund I' },
    dealType: 'deal_type.co_invest_equity',
    sector: 'sector.industrials',
    geography: 'geography.north_america',
    stage: 'Diligence',
    owner: DEAL_LEAD,
    receivedDate: '2025-03-10',
    targetCommitment: '15000000.00',
    currency: 'USD',
    daysInStage: 40,
    passReasonCode: null,
    investmentId: null,
    rowVersion: 3,
    ...overrides,
  };
}

/** One opportunity per stage: two aging (Sourced over 30 days, Diligence not), one Passed, one Closed. */
export function opportunityRows(): OpportunityRow[] {
  return [
    opportunityRowFixture({
      id: OPP_ID.sourced,
      name: 'Project Shoal',
      companyName: 'Shoal Analytics',
      sponsorFund: null,
      dealType: 'deal_type.cv_single_asset',
      stage: 'Sourced',
      owner: null,
      receivedDate: '2025-05-01',
      targetCommitment: null,
      daysInStage: 45,
      rowVersion: 1,
    }),
    opportunityRowFixture({
      id: OPP_ID.screening,
      name: 'Project Reef',
      companyName: 'Reef Dental Group',
      dealType: 'deal_type.private_credit',
      stage: 'Screening',
      daysInStage: 12,
      receivedDate: '2025-06-01',
      targetCommitment: '8000000.00',
      rowVersion: 2,
    }),
    opportunityRowFixture({
      id: OPP_ID.prescreen,
      name: 'Project Kelp',
      companyName: 'Kelp Foods',
      stage: 'Prescreen',
      daysInStage: 20,
      rowVersion: 2,
    }),
    opportunityRowFixture(),
    opportunityRowFixture({
      id: OPP_ID.ic,
      name: 'Project Tern',
      companyName: 'Tern Software',
      stage: 'IC',
      daysInStage: 3,
      targetCommitment: '12000000.00',
      rowVersion: 5,
    }),
    opportunityRowFixture({
      id: OPP_ID.approved,
      name: 'Project Gull',
      companyName: 'Gull Marine Services',
      stage: 'Approved',
      daysInStage: 9,
      rowVersion: 6,
    }),
    opportunityRowFixture({
      id: OPP_ID.closing,
      name: 'Project Cove',
      companyName: 'Cove Health Partners',
      stage: 'Closing',
      daysInStage: 15,
      targetCommitment: '20000000.00',
      rowVersion: 7,
    }),
    opportunityRowFixture({
      id: OPP_ID.closed,
      name: 'Project Harbor',
      companyName: 'Harbor Packaging',
      stage: 'Closed',
      daysInStage: 120,
      investmentId: PIPE_ID.investment,
      rowVersion: 9,
    }),
    opportunityRowFixture({
      id: OPP_ID.passed,
      name: 'Project Dusk',
      companyName: 'Dusk Retail',
      stage: 'Passed',
      daysInStage: 200,
      passReasonCode: 'pass_reason.valuation',
      rowVersion: 4,
    }),
  ];
}

export function opportunityPageFixture(
  items: OpportunityRow[] = opportunityRows(),
  nextCursor: string | null = null,
): OpportunityPage {
  return { items, nextCursor };
}

export function diligenceTaskFixture(overrides: Partial<DiligenceTask> = {}): DiligenceTask {
  return {
    id: PIPE_ID.taskCommercial,
    workstream: 'diligence_workstream.commercial',
    title: 'Market and competitive review',
    owner: DEAL_LEAD,
    dueDate: '2025-05-15',
    status: 'done',
    requiredForIc: true,
    evidenceDocumentId: PIPE_ID.document,
    waivedReason: null,
    ...overrides,
  };
}

/** Three tasks required for IC (one done, one waived, one open) and one optional open task. */
export function diligenceTasks(): DiligenceTask[] {
  return [
    diligenceTaskFixture(),
    diligenceTaskFixture({
      id: PIPE_ID.taskFinancial,
      workstream: 'diligence_workstream.financial',
      title: 'Quality of earnings review',
      status: 'waived',
      evidenceDocumentId: null,
      waivedReason: 'Audited accounts received from the sponsor',
    }),
    diligenceTaskFixture({
      id: PIPE_ID.taskLegal,
      workstream: 'diligence_workstream.legal',
      title: 'Legal due diligence summary',
      owner: null,
      dueDate: null,
      status: 'open',
      evidenceDocumentId: null,
    }),
    diligenceTaskFixture({
      id: PIPE_ID.taskTax,
      workstream: 'diligence_workstream.tax',
      title: 'Tax structuring memo',
      status: 'open',
      requiredForIc: false,
      evidenceDocumentId: null,
    }),
  ];
}

export function icDecisionFixture(overrides: Partial<IcDecision> = {}): IcDecision {
  return {
    id: PIPE_ID.decision,
    decisionDate: '2025-06-20',
    decision: 'approved',
    amount: '20000000.00',
    conditions: ['Key person clause confirmed', 'Side letter MFN election'],
    recordedBy: HEAD,
    ...overrides,
  };
}

export function allocationFixture(overrides: Partial<AllocationRow> = {}): AllocationRow {
  return {
    id: PIPE_ID.allocationA,
    vehicle: { id: ID.vehicle1, name: 'Beach Co-Invest Fund I' },
    client: null,
    requested: '12000000.00',
    received: '12000000.00',
    ...overrides,
  };
}

/** Two lines: the vehicle line and a client line, tying out to a 20,000,000.00 commitment. */
export function allocations(): AllocationRow[] {
  return [
    allocationFixture(),
    allocationFixture({
      id: PIPE_ID.allocationB,
      vehicle: { id: ID.vehicle2, name: 'Beach Credit Partners I' },
      client: { id: VS_ID.clientAlpha, name: 'Alpha Pension Trust' },
      requested: '8000000.00',
      received: null,
    }),
  ];
}

export function closingSummaryFixture(overrides: Partial<ClosingSummary> = {}): ClosingSummary {
  return {
    id: PIPE_ID.closing,
    closeDate: '2025-08-15',
    commitmentAmount: '20000000.00',
    currency: 'USD',
    state: 'Open',
    opsConfirmedBy: null,
    opsConfirmedAt: null,
    itemsOpen: 3,
    itemsRequiredOpen: 1,
    allocationTieOut: {
      commitment: '20000000.00',
      allocated: '20000000.00',
      difference: '0.00',
      tiedOut: true,
    },
    ...overrides,
  };
}

/** A deal at Diligence with one required task open; no decision, no allocations, no closing. */
export function opportunityDetailFixture(
  overrides: Partial<OpportunityDetail> = {},
): OpportunityDetail {
  return {
    ...opportunityRowFixture(),
    source: 'Sponsor introduction at the annual meeting',
    passNote: null,
    stageHistory: [
      {
        fromStage: null,
        toStage: 'Sourced',
        command: 'create',
        reason: null,
        changedBy: DEAL_LEAD,
        changedAt: '2025-03-10T09:00:00Z',
      },
      {
        fromStage: 'Sourced',
        toStage: 'Screening',
        command: 'advance',
        reason: null,
        changedBy: DEAL_LEAD,
        changedAt: '2025-03-20T09:00:00Z',
      },
      {
        fromStage: 'Screening',
        toStage: 'Prescreen',
        command: 'advance',
        reason: null,
        changedBy: DEAL_LEAD,
        changedAt: '2025-04-05T09:00:00Z',
      },
      {
        fromStage: 'Prescreen',
        toStage: 'Diligence',
        command: 'advance',
        reason: null,
        changedBy: DEAL_LEAD,
        changedAt: '2025-05-21T09:00:00Z',
      },
    ],
    diligenceTasks: diligenceTasks(),
    icDecisions: [],
    allocations: [],
    closing: null,
    gates: {
      diligence: { requiredOpen: 1, ok: false },
      icDecision: { ok: false },
      closing: { checklistComplete: false, allocationTiedOut: false, ok: false },
    },
    ...overrides,
  };
}

/** The Closing deal: every required task done, an approved decision, allocations tying out, one required item open. */
export function closingOpportunityFixture(
  overrides: Partial<OpportunityDetail> = {},
): OpportunityDetail {
  return opportunityDetailFixture({
    ...opportunityRowFixture({
      id: OPP_ID.closing,
      name: 'Project Cove',
      companyName: 'Cove Health Partners',
      stage: 'Closing',
      daysInStage: 15,
      targetCommitment: '20000000.00',
      rowVersion: 7,
    }),
    diligenceTasks: diligenceTasks().map((t) =>
      t.status === 'open' && t.requiredForIc ? { ...t, status: 'done' } : t,
    ),
    icDecisions: [icDecisionFixture()],
    allocations: allocations(),
    closing: closingSummaryFixture(),
    gates: {
      diligence: { requiredOpen: 0, ok: true },
      icDecision: { ok: true },
      closing: { checklistComplete: false, allocationTiedOut: true, ok: false },
    },
    ...overrides,
  });
}

export function closingItemFixture(overrides: Partial<ClosingItem> = {}): ClosingItem {
  return {
    id: PIPE_ID.itemSigned,
    itemCode: 'signed_documents',
    label: 'Signed subscription and transaction documents',
    required: true,
    documentId: PIPE_ID.document,
    status: 'received',
    waivedReason: null,
    ...overrides,
  };
}

/** The seven items of config/closing_checklist.json in order: wire confirmation and the two optional items open. */
export function closingItems(): ClosingItem[] {
  return [
    closingItemFixture(),
    closingItemFixture({
      id: PIPE_ID.itemCapTable,
      itemCode: 'cap_table',
      label: 'Closing capitalization table',
    }),
    closingItemFixture({
      id: PIPE_ID.itemFundsFlow,
      itemCode: 'funds_flow',
      label: 'Funds flow memorandum',
      documentId: null,
      status: 'waived',
      waivedReason: 'Funds flow agreed in the signed documents',
    }),
    closingItemFixture({
      id: PIPE_ID.itemWire,
      itemCode: 'wire_confirmation',
      label: 'Wire confirmation',
      documentId: null,
      status: 'open',
    }),
    closingItemFixture({
      id: PIPE_ID.itemConsents,
      itemCode: 'consents',
      label: 'Required consents recorded',
    }),
    closingItemFixture({
      id: PIPE_ID.itemSideLetter,
      itemCode: 'side_letter',
      label: 'Side letter',
      required: false,
      documentId: null,
      status: 'open',
    }),
    closingItemFixture({
      id: PIPE_ID.itemMemo,
      itemCode: 'closing_memo',
      label: 'Closing memo',
      required: false,
      documentId: null,
      status: 'open',
    }),
  ];
}

export function legalTermFixture(overrides: Partial<LegalTerm> = {}): LegalTerm {
  return {
    id: PIPE_ID.termFee,
    termType: 'legal_term_type.management_fee',
    value: { rate: '2%', basis: 'committed capital' },
    sourceDocumentId: PIPE_ID.document,
    status: 'confirmed',
    confirmedBy: OPS,
    ...overrides,
  };
}

export function legalTerms(): LegalTerm[] {
  return [
    legalTermFixture(),
    legalTermFixture({
      id: PIPE_ID.termMfn,
      termType: 'legal_term_type.mfn',
      value: { elected: true, deadline: '2025-09-30' },
      sourceDocumentId: null,
      status: 'draft',
      confirmedBy: null,
    }),
  ];
}

/** The Closing deal's closing record: Open, one required item (wire confirmation) open, tied out, two terms. */
export function closingDetailFixture(overrides: Partial<ClosingDetail> = {}): ClosingDetail {
  return {
    ...closingSummaryFixture(),
    opportunityId: OPP_ID.closing,
    investmentId: null,
    items: closingItems(),
    legalTerms: legalTerms(),
    allocations: allocations(),
    rowVersion: 2,
    ...overrides,
  };
}

/** The same closing once operations confirmed it: every required item in, confirmed by operations. */
export function confirmedClosingFixture(): ClosingDetail {
  return closingDetailFixture({
    state: 'OpsConfirmed',
    opsConfirmedBy: OPS,
    opsConfirmedAt: '2025-08-16T10:00:00Z',
    itemsOpen: 2,
    itemsRequiredOpen: 0,
    items: closingItems().map((i) =>
      i.itemCode === 'wire_confirmation'
        ? { ...i, status: 'received', documentId: PIPE_ID.document }
        : i,
    ),
  });
}

const term = (
  domain: string,
  code: string,
  label: string,
  sortOrder: number,
): Taxonomy['domains'][number]['terms'][number] => ({
  code: `${domain}.${code}`,
  label,
  parentCode: null,
  active: true,
  sortOrder,
});

/** The taxonomy domains the pipeline pickers read; labels as migrations 0002 and 0013 name them. */
export function taxonomyFixture(): Taxonomy {
  return {
    domains: [
      {
        domain: 'deal_type',
        terms: [
          term('deal_type', 'co_invest_equity', 'Co-investment (equity)', 1),
          term('deal_type', 'cv_single_asset', 'Continuation vehicle (single asset)', 2),
          term('deal_type', 'private_credit', 'Private credit', 5),
        ],
      },
      {
        domain: 'sector',
        terms: [
          term('sector', 'software', 'Software', 1),
          term('sector', 'industrials', 'Industrials', 3),
        ],
      },
      {
        domain: 'geography',
        terms: [
          term('geography', 'north_america', 'North America', 1),
          term('geography', 'europe', 'Europe', 2),
        ],
      },
      {
        domain: 'pass_reason',
        terms: [
          term('pass_reason', 'valuation', 'Valuation', 1),
          term('pass_reason', 'fund_fit', 'Fund fit', 2),
          term('pass_reason', 'other', 'Other', 8),
        ],
      },
      {
        domain: 'diligence_workstream',
        terms: [
          term('diligence_workstream', 'commercial', 'Commercial', 1),
          term('diligence_workstream', 'financial', 'Financial', 2),
          term('diligence_workstream', 'legal', 'Legal', 3),
          term('diligence_workstream', 'tax', 'Tax', 4),
          term('diligence_workstream', 'references', 'References', 7),
        ],
      },
      {
        domain: 'legal_term_type',
        terms: [
          term('legal_term_type', 'management_fee', 'Management fee', 1),
          term('legal_term_type', 'mfn', 'MFN', 7),
          term('legal_term_type', 'key_person', 'Key person', 4),
        ],
      },
    ],
  };
}

/** Two clients, each with one vehicle share; only the ids and names matter to the allocation picker. */
export function clientListFixture(): ClientList {
  const client = (id: string, name: string): ClientList['items'][number] => ({
    id,
    name,
    reportingBases: ['reporting_basis.gross'],
    reportingCadence: 'reporting_cadence.quarterly',
    vehicles: [
      {
        vehicleId: ID.vehicle2,
        vehicleName: 'Beach Credit Partners I',
        vehicleType: 'vehicle_type.private_credit',
        commitment: '50000000.00',
        closingNumber: 1,
        ownershipPct: '0.5',
        commitmentDate: '2020-03-31',
        invested: null,
        distributions: null,
        nav: null,
        grossMoic: null,
      },
    ],
    totals: { commitment: null, invested: null, distributions: null, nav: null, grossMoic: null },
  });
  return {
    asOf: AS_OF,
    items: [
      client(VS_ID.clientAlpha, 'Alpha Pension Trust'),
      client(VS_ID.clientBeta, 'Beta Endowment'),
    ],
    calcVersion: '0.1.0',
  };
}
