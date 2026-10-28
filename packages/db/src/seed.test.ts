import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './testing.js';
import type { DbHandle } from './client.js';
import { decryptBankDetails, DEV_FIELD_KEY, FieldCipher } from './fieldCrypto.js';
import { loadSyntheticDataset, syntheticDatasetSchema } from './seed.js';
import type { ParsedSyntheticDataset, SyntheticDataset } from './seed.js';
import { expectDbRejection } from './test-utils.js';

const COMPANY = '20000000-0000-4000-8000-000000000003';
const OTHER_COMPANY = '20000000-0000-4000-8000-000000000004';
const SPONSOR = '20000000-0000-4000-8000-000000000001';
const SPONSOR_FUND = '20000000-0000-4000-8000-000000000002';
const VEHICLE = '20000000-0000-4000-8000-000000000005';
const INVESTMENT = '30000000-0000-4000-8000-000000000001';
const OPS = '10000000-0000-4000-8000-000000000003';
const OPS_TWO = '10000000-0000-4000-8000-000000000009';
const HEAD = '10000000-0000-4000-8000-000000000004';
const DEAL = '10000000-0000-4000-8000-000000000002';
const NOTICE = 'b0000000-0000-4000-8000-000000000014';
const WIRE_VERIFIED = 'b0000000-0000-4000-8000-000000000012';
const WIRE_PROPOSED = 'b0000000-0000-4000-8000-000000000013';
const OPPORTUNITY = 'b0000000-0000-4000-8000-000000000001';
const CLOSING = 'b0000000-0000-4000-8000-00000000000c';

const BANK = {
  bankName: 'Harbor Street Bank',
  accountName: 'Harborlight Fund IV',
  accountNumber: '4455667788',
  routingCode: '021000021',
};

/** Users, a sponsor with a fund, a company, a vehicle, an investment and a notice: what the controls hang off. */
function controlsDataset(): ParsedSyntheticDataset {
  const base = dataset();
  return {
    ...base,
    users: [
      {
        id: OPS,
        externalId: 'ops.one',
        displayName: 'Ops One',
        email: 'ops.one@portfolio-beach.example',
        roles: ['operations'],
        clientIds: [],
      },
      {
        id: OPS_TWO,
        externalId: 'ops.two',
        displayName: 'Ops Two',
        email: 'ops.two@portfolio-beach.example',
        roles: ['operations'],
        clientIds: [],
      },
      {
        id: HEAD,
        externalId: 'head.one',
        displayName: 'Head One',
        email: 'head.one@portfolio-beach.example',
        roles: ['approver'],
        clientIds: [],
      },
      {
        id: DEAL,
        externalId: 'deal.one',
        displayName: 'Deal One',
        email: 'deal.one@portfolio-beach.example',
        roles: ['deal_team'],
        clientIds: [],
      },
    ],
    sponsors: [
      {
        id: SPONSOR,
        name: 'Harborlight Capital',
        canonicalName: 'harborlight capital',
        tier: 'sponsor_tier.core',
        hqGeography: null,
        description: null,
      },
    ],
    sponsorFunds: [
      {
        id: SPONSOR_FUND,
        sponsorId: SPONSOR,
        name: 'Harborlight Fund IV',
        canonicalName: 'harborlight fund iv',
        vintage: 2021,
        strategy: 'strategy.buyout',
        sizeTarget: null,
        sizeHardCap: null,
        sizeFinal: null,
      },
    ],
    vehicles: [
      {
        id: VEHICLE,
        name: 'Beach Co-Invest Fund I',
        vehicleType: 'vehicle_type.co_invest',
        vintage: 2021,
        closingCount: 1,
        finalCloseDate: null,
      },
    ],
    investments: [
      {
        id: INVESTMENT,
        investmentNumber: 'INV-0001',
        vehicleId: VEHICLE,
        portfolioCompanyId: COMPANY,
        sponsorFundId: SPONSOR_FUND,
        sponsorId: SPONSOR,
        dealType: 'deal_type.co_invest_equity',
        entryDate: '2022-03-15',
        exitDate: null,
        isActive: true,
        scenarioTags: [],
      },
    ],
    capitalNotices: [
      {
        id: NOTICE,
        noticeType: 'notice_type.capital_call',
        vehicleId: VEHICLE,
        investmentId: INVESTMENT,
        commitmentId: null,
        issueDate: '2024-09-01',
        dueDate: '2024-09-15',
        amount: '2000000.00',
        split: {},
        state: 'Funded',
        scenarioTag: 'wire_change',
        urgencyFlag: true,
        wireChangeFlag: true,
      },
    ],
    wireInstructions: [
      {
        id: WIRE_VERIFIED,
        sponsorFundId: SPONSOR_FUND,
        investmentId: null,
        counterpartyName: 'Harborlight Fund IV',
        version: 1,
        bankDetails: BANK,
        state: 'Verified',
        proposedBy: OPS,
        proposedAt: '2024-08-01T09:00:00Z',
        sourceNote: null,
        callbackBy: OPS_TWO,
        callbackAt: '2024-08-02T15:00:00Z',
        callbackNumberSource: 'prior_instruction',
        callbackResult: 'confirmed',
        verifiedAt: '2024-08-02T15:05:00Z',
        rejectionReason: null,
        active: true,
      },
      // proposedAt as a business date: read as UTC midnight.
      {
        id: WIRE_PROPOSED,
        sponsorFundId: SPONSOR_FUND,
        investmentId: null,
        counterpartyName: 'Harborlight Fund IV',
        version: 2,
        bankDetails: { ...BANK, accountNumber: '9988776655' },
        state: 'Proposed',
        proposedBy: OPS,
        proposedAt: '2025-06-30',
        sourceNote: 'Changed instructions received in the notice',
        callbackBy: null,
        callbackAt: null,
        callbackNumberSource: null,
        callbackResult: null,
        verifiedAt: null,
        rejectionReason: null,
        active: false,
      },
    ],
    tradeTickets: [
      {
        id: 'b0000000-0000-4000-8000-000000000016',
        capitalNoticeId: NOTICE,
        wireInstructionId: WIRE_VERIFIED,
        amount: '2000000.00',
        currency: 'USD',
        fundingDate: '2024-09-15',
        preparedBy: OPS,
        preparedAt: '2024-09-03T09:00:00Z',
        approvedBy: HEAD,
        approvedAt: '2024-09-04T09:00:00Z',
        state: 'Funded',
      },
    ],
    changeRequests: [
      {
        id: 'b0000000-0000-4000-8000-000000000018',
        investmentId: INVESTMENT,
        changeType: 'change_type.add_on_acquisition',
        effectiveDate: '2024-08-15',
        details: { target: 'a regional competitor' },
        summary: 'Add-on acquisition of a regional competitor closed',
        ownerId: OPS,
        submittedBy: DEAL,
        state: 'Applied',
        appliedPeriod: '2024-09-30',
        appliedBy: OPS,
        appliedAt: '2024-10-05T09:00:00Z',
        rejectionReason: null,
      },
    ],
    opportunities: [
      {
        id: OPPORTUNITY,
        name: 'Project Saltmarsh II',
        companyName: 'Saltmarsh Holdings',
        portfolioCompanyId: COMPANY,
        sponsorId: SPONSOR,
        sponsorFundId: SPONSOR_FUND,
        dealType: 'deal_type.co_invest_equity',
        sector: 'sector.software',
        geography: 'geography.north_america',
        stage: 'Closing',
        ownerId: DEAL,
        receivedDate: '2024-03-01',
        targetCommitment: '10000000.00',
        source: 'Sponsor outreach',
        passReasonCode: null,
        passNote: null,
        investmentId: null,
        scenarioTag: 'closing_open',
      },
    ],
    opportunityStageHistory: [
      {
        id: 'b0000000-0000-4000-8000-000000000003',
        opportunityId: OPPORTUNITY,
        fromStage: null,
        toStage: 'Sourced',
        command: 'create',
        reason: null,
        changedBy: DEAL,
        changedAt: '2024-03-01T09:00:00Z',
      },
    ],
    diligenceTasks: [
      {
        id: 'b0000000-0000-4000-8000-000000000005',
        opportunityId: OPPORTUNITY,
        workstream: 'diligence_workstream.financial',
        title: 'Quality of earnings review',
        ownerId: DEAL,
        dueDate: '2024-06-30',
        status: 'done',
        requiredForIc: true,
        evidenceDocumentId: null,
        waivedReason: null,
      },
    ],
    icDecisions: [
      {
        id: 'b0000000-0000-4000-8000-000000000007',
        opportunityId: OPPORTUNITY,
        decisionDate: '2024-09-15',
        decision: 'approved',
        amount: '10000000.00',
        conditions: ['Close by year end'],
        recordedBy: HEAD,
      },
    ],
    allocations: [
      {
        id: 'b0000000-0000-4000-8000-000000000009',
        opportunityId: OPPORTUNITY,
        investmentId: null,
        vehicleId: VEHICLE,
        clientId: null,
        requested: '10000000.00',
        received: null,
      },
      {
        id: 'b0000000-0000-4000-8000-00000000000b',
        opportunityId: null,
        investmentId: INVESTMENT,
        vehicleId: VEHICLE,
        clientId: null,
        requested: '30000000.00',
        received: '30000000.00',
      },
    ],
    closings: [
      {
        id: CLOSING,
        opportunityId: OPPORTUNITY,
        investmentId: null,
        closeDate: '2024-10-31',
        commitmentAmount: '10000000.00',
        state: 'Open',
        opsConfirmedBy: null,
        opsConfirmedAt: null,
      },
      {
        id: 'b0000000-0000-4000-8000-00000000000d',
        opportunityId: null,
        investmentId: INVESTMENT,
        closeDate: '2022-03-15',
        commitmentAmount: '30000000.00',
        state: 'OpsConfirmed',
        opsConfirmedBy: OPS,
        opsConfirmedAt: '2022-03-16T09:00:00Z',
      },
    ],
    closingItems: [
      {
        id: 'b0000000-0000-4000-8000-00000000000e',
        closingId: CLOSING,
        itemCode: 'signed_documents',
        label: 'Signed subscription and transaction documents',
        required: true,
        documentId: null,
        status: 'open',
        waivedReason: null,
      },
    ],
    legalTerms: [
      {
        id: 'b0000000-0000-4000-8000-000000000010',
        closingId: CLOSING,
        investmentId: null,
        termType: 'legal_term_type.management_fee',
        value: { rate: '0.0100', basis: 'invested capital', stepDown: true, years: 5 },
        status: 'draft',
        confirmedBy: null,
        confirmedAt: null,
      },
    ],
  };
}

/** The smallest dataset the contract accepts: one company and its aliases, nothing else. */
function dataset(companyAliases?: SyntheticDataset['companyAliases']): SyntheticDataset {
  const base: SyntheticDataset = {
    version: 1,
    profile: 'test',
    seed: 1,
    asOf: '2025-06-30',
    scenarios: {},
    users: [],
    sponsors: [],
    sponsorFunds: [],
    fundAliases: [],
    portfolioCompanies: [
      {
        id: COMPANY,
        name: 'Saltmarsh Holdings',
        canonicalName: 'saltmarsh holdings',
        sector: 'sector.software',
        geography: 'geography.north_america',
        description: null,
      },
      {
        id: OTHER_COMPANY,
        name: 'Tidewater Diagnostics',
        canonicalName: 'tidewater diagnostics',
        sector: 'sector.healthcare',
        geography: 'geography.europe',
        description: null,
      },
    ],
    fundHoldings: [],
    vehicles: [],
    investments: [],
    clients: [],
    commitments: [],
    lpCommitments: [],
    matchGuards: [],
    walls: [],
    quarterlyPerformance: [],
    creditTerms: [],
    creditPerformance: [],
    valuations: [],
    capitalNotices: [],
    cashFlows: [],
    realizationOutlooks: [],
    opportunities: [],
    opportunityStageHistory: [],
    diligenceTasks: [],
    icDecisions: [],
    allocations: [],
    closings: [],
    closingItems: [],
    legalTerms: [],
    wireInstructions: [],
    tradeTickets: [],
    changeRequests: [],
  };
  return companyAliases === undefined ? base : { ...base, companyAliases };
}

describe('the seed loader and the Phase 3 controls (migration 0013)', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });

  it('accepts a dataset made before Phase 3 and reads every new array as empty', () => {
    const legacy: Record<string, unknown> = { ...dataset() };
    for (const key of [
      'opportunities',
      'opportunityStageHistory',
      'diligenceTasks',
      'icDecisions',
      'allocations',
      'closings',
      'closingItems',
      'legalTerms',
      'wireInstructions',
      'tradeTickets',
      'changeRequests',
    ])
      delete legacy[key];
    const parsed = syntheticDatasetSchema.parse(legacy);
    expect(parsed.opportunities).toEqual([]);
    expect(parsed.wireInstructions).toEqual([]);
    expect(parsed.changeRequests).toEqual([]);
  });

  it('refuses bank details that are not identifiers, so a sentence never reaches the register (SEC-12.1)', () => {
    const d = controlsDataset();
    const bad = {
      ...d,
      wireInstructions: [
        {
          ...d.wireInstructions[0]!,
          bankDetails: { ...BANK, accountNumber: 'please wire to the account below' },
        },
      ],
    };
    expect(syntheticDatasetSchema.safeParse(bad).success).toBe(false);
  });

  it('loads one row of every control, encrypting the bank details with the prototype key by default', async () => {
    const counts = await loadSyntheticDataset(handle, controlsDataset());
    expect(counts).toMatchObject({
      opportunities: 1,
      opportunityStageHistory: 1,
      diligenceTasks: 1,
      icDecisions: 1,
      allocations: 2,
      closings: 2,
      closingItems: 1,
      legalTerms: 1,
      wireInstructions: 2,
      tradeTickets: 1,
      changeRequests: 1,
    });
    // Loading again changes nothing (stable ids).
    await loadSyntheticDataset(handle, controlsDataset());
    const wires = await handle.query<{
      version: number;
      state: string;
      bank_details_enc: string;
      bank_details_masked: string;
      proposed_at: Date;
      active: boolean;
    }>(
      'select version, state, bank_details_enc, bank_details_masked, proposed_at, active from mon.wire_instruction order by version',
    );
    expect(wires.map((w) => [w.version, w.state, w.bank_details_masked, w.active])).toEqual([
      [1, 'Verified', 'Harbor Street Bank ****7788', true],
      [2, 'Proposed', 'Harbor Street Bank ****6655', false],
    ]);
    const dev = new FieldCipher(DEV_FIELD_KEY);
    expect(decryptBankDetails(dev, wires[0]!.bank_details_enc)).toEqual(BANK);
    expect(decryptBankDetails(dev, wires[1]!.bank_details_enc).accountNumber).toBe('9988776655');
    for (const w of wires) {
      expect(w.bank_details_enc).not.toContain('4455667788');
      expect(w.bank_details_enc).not.toContain('021000021');
    }
    expect(new Date(wires[1]!.proposed_at).toISOString()).toBe('2025-06-30T00:00:00.000Z');
    const notice = await handle.query<{ urgency_flag: boolean; wire_change_flag: boolean }>(
      `select urgency_flag, wire_change_flag from mon.capital_notice where id = '${NOTICE}'`,
    );
    expect(notice[0]).toEqual({ urgency_flag: true, wire_change_flag: true });
    const ticket = await handle.query<{ state: string; wire_instruction_id: string }>(
      'select state, wire_instruction_id from mon.trade_ticket',
    );
    expect(ticket[0]).toEqual({ state: 'Funded', wire_instruction_id: WIRE_VERIFIED });
    const term = await handle.query<{ value: Record<string, unknown> }>(
      'select value from deal.legal_term',
    );
    expect(term[0]?.value).toEqual({
      rate: '0.0100',
      basis: 'invested capital',
      stepDown: true,
      years: 5,
    });
    const closings = await handle.query<{ opportunity_id: string | null; state: string }>(
      'select opportunity_id, state from deal.closing order by close_date',
    );
    expect(closings).toEqual([
      { opportunity_id: null, state: 'OpsConfirmed' },
      { opportunity_id: OPPORTUNITY, state: 'Open' },
    ]);
  });

  it('encrypts with the cipher passed in, so a real key never shares ciphertext with the prototype key', async () => {
    const own = await createTestDb();
    try {
      const key = new Uint8Array(32);
      key.fill(42);
      const cipher = new FieldCipher(key);
      await loadSyntheticDataset(own, controlsDataset(), { cipher });
      const rows = await own.query<{ bank_details_enc: string }>(
        'select bank_details_enc from mon.wire_instruction where version = 1',
      );
      const enc = rows[0]!.bank_details_enc;
      expect(decryptBankDetails(cipher, enc)).toEqual(BANK);
      expect(() => decryptBankDetails(new FieldCipher(DEV_FIELD_KEY), enc)).toThrow();
    } finally {
      await own.close();
    }
  });
});

describe('the seed loader and company aliases (migration 0010, docs/03 section 5)', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });

  it('accepts a dataset without aliases, as every dataset made before migration 0010 is', async () => {
    expect(syntheticDatasetSchema.safeParse(dataset()).success).toBe(true);
    const counts = await loadSyntheticDataset(handle, dataset());
    expect(counts.portfolioCompanies).toBe(2);
    expect(counts.companyAliases).toBeUndefined();
    const rows = await handle.query<{ n: number }>(
      'select count(*)::int as n from core.company_alias',
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('loads aliases against their companies, and loads the same dataset again without duplicates', async () => {
    const aliases = [
      {
        id: '80000000-0000-4000-8000-000000000101',
        portfolioCompanyId: COMPANY,
        alias: 'Saltmarsh Group',
      },
      {
        id: '80000000-0000-4000-8000-000000000102',
        portfolioCompanyId: OTHER_COMPANY,
        alias: 'Tidewater Dx',
      },
    ];
    const counts = await loadSyntheticDataset(handle, dataset(aliases));
    expect(counts.companyAliases).toBe(2);
    await loadSyntheticDataset(handle, dataset(aliases));
    const rows = await handle.query<{ alias: string; company: string }>(
      'select a.alias, c.name as company from core.company_alias a join core.portfolio_company c on c.id = a.portfolio_company_id order by a.alias',
    );
    expect(rows).toEqual([
      { alias: 'Saltmarsh Group', company: 'Saltmarsh Holdings' },
      { alias: 'Tidewater Dx', company: 'Tidewater Diagnostics' },
    ]);
  });

  it('refuses an alias with no company, an empty alias and the same alias on two companies', async () => {
    expect(
      syntheticDatasetSchema.safeParse(
        dataset([
          { id: '80000000-0000-4000-8000-000000000103', portfolioCompanyId: COMPANY, alias: '' },
        ]),
      ).success,
    ).toBe(false);
    await expectDbRejection(
      loadSyntheticDataset(
        handle,
        dataset([
          {
            id: '80000000-0000-4000-8000-000000000104',
            portfolioCompanyId: '20000000-0000-4000-8000-0000000000ff',
            alias: 'Nobody',
          },
        ]),
      ),
      /foreign key|violates/,
    );
    // The alias column is unique: a second company cannot claim an alias already taken, so an
    // exact alias match is never ambiguous.
    await expectDbRejection(
      handle.exec(
        `insert into core.company_alias (portfolio_company_id, alias) values ('${OTHER_COMPANY}', 'Saltmarsh Group')`,
      ),
      /unique|duplicate key/,
    );
  });
});
