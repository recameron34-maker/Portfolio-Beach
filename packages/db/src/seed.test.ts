import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './testing.js';
import { createDb } from './client.js';
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
    underwritingCases: [],
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
        hqCity: 'Austin',
        hqCountry: 'US',
        hqLatitude: '30.26720',
        hqLongitude: '-97.74310',
      },
      {
        id: OTHER_COMPANY,
        name: 'Tidewater Diagnostics',
        canonicalName: 'tidewater diagnostics',
        sector: 'sector.healthcare',
        geography: 'geography.europe',
        description: null,
        hqCity: null,
        hqCountry: null,
        hqLatitude: null,
        hqLongitude: null,
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

  describe('the seed CLI (cli/seed.ts) hands the loader the cipher of the environment (SEC-12.2)', () => {
    const KEY_HEX = '2a'.repeat(32);
    const scratch = mkdtempSync(join(tmpdir(), 'pb-seed-cli-'));
    const datasetPath = join(scratch, 'dataset.json');
    const argv = process.argv;
    beforeAll(() => {
      writeFileSync(datasetPath, JSON.stringify(controlsDataset()));
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      process.argv = argv;
    });

    /** Runs the script as `pnpm db:seed:synthetic <dataset>` does, against its own database folder. */
    const runCli = async (name: string, env: Record<string, string>): Promise<string> => {
      const dataDir = join(scratch, name);
      vi.resetModules();
      vi.stubEnv('PB_DATABASE_URL', '');
      vi.stubEnv('PB_PGLITE_DIR', dataDir);
      vi.stubEnv('PB_FIELD_KEY_HEX', '');
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      process.argv = ['node', 'seed.js', datasetPath];
      vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`exit ${String(code)}`);
      });
      await import('./cli/seed.js');
      return dataDir;
    };
    const seededCiphertext = async (dataDir: string): Promise<string> => {
      const seeded = await createDb({ kind: 'pglite', dataDir });
      try {
        const rows = await seeded.query<{ bank_details_enc: string }>(
          'select bank_details_enc from mon.wire_instruction where version = 1',
        );
        return rows[0]!.bank_details_enc;
      } finally {
        await seeded.close();
      }
    };

    it('encrypts with PB_FIELD_KEY_HEX when it is set, so the API holding that key reads what the seed wrote', async () => {
      const enc = await seededCiphertext(await runCli('keyed', { PB_FIELD_KEY_HEX: KEY_HEX }));
      const key = new Uint8Array(32).fill(0x2a);
      expect(decryptBankDetails(new FieldCipher(key), enc)).toEqual(BANK);
      expect(() => decryptBankDetails(new FieldCipher(DEV_FIELD_KEY), enc)).toThrow();
    });

    it('falls back to the prototype key outside production only: in production an unset key is refused before anything is written', async () => {
      const enc = await seededCiphertext(await runCli('dev', { NODE_ENV: 'development' }));
      expect(decryptBankDetails(new FieldCipher(DEV_FIELD_KEY), enc)).toEqual(BANK);

      await expect(runCli('production', { NODE_ENV: 'production' })).rejects.toThrow('exit 1');
      expect(existsSync(join(scratch, 'production'))).toBe(false);
    });

    it('refuses a key that is set but malformed, never falling back to the prototype key', async () => {
      await expect(runCli('malformed', { PB_FIELD_KEY_HEX: 'ab'.repeat(31) })).rejects.toThrow(
        /64 hex/,
      );
      expect(existsSync(join(scratch, 'malformed'))).toBe(false);
    });
  });
});

describe('the seed loader and the underwritten base cases (migration 0021)', () => {
  type SeedCase = ParsedSyntheticDataset['underwritingCases'][number];
  const caseId = (n: number): string => `e0000000-0000-4000-8000-00000000000${String(n)}`;
  let pointNo = 0;
  const point = (periodEnd: string, ebitdaLtm: string | null, netDebt: string | null = null) => {
    pointNo += 1;
    return {
      id: `e1000000-0000-4000-8000-${String(pointNo).padStart(12, '0')}`,
      periodEnd,
      revenueLtm: null,
      ebitdaLtm,
      netDebt,
    };
  };
  const equity = (version: number, overrides: Partial<SeedCase> = {}): SeedCase => ({
    id: caseId(version),
    investmentId: INVESTMENT,
    version,
    form: 'equity',
    state: 'Confirmed',
    caseDate: '2022-03-15',
    plannedExitDate: '2027-03-31',
    exitMultiple: '12.50',
    grossMoic: '2.5000',
    grossIrr: '0.2000',
    underwrittenYield: null,
    annualLossRate: null,
    note: null,
    revisionReason: version === 1 ? null : 'Revised',
    withdrawnReason: null,
    sourceNote: 'Sponsor base case model, held in the deal folder',
    enteredBy: DEAL,
    enteredAt: '2022-03-22T10:00:00Z',
    confirmedBy: HEAD,
    confirmedAt: '2022-03-24T15:00:00Z',
    points: [point('2021-12-31', '24000000.00', '95000000.00'), point('2027-03-31', '44000000.00')],
    ...overrides,
  });
  /** A correction, a re-underwriting, a retired loan case and an open Draft: every state at once. */
  const versions = (): SeedCase[] => [
    equity(1, { state: 'Superseded' }),
    equity(2, {
      exitMultiple: '11.50',
      revisionReason: 'The exit multiple was entered as 12.50; the model shows 11.50',
      enteredBy: HEAD,
      enteredAt: '2022-04-20T10:00:00Z',
      confirmedBy: DEAL,
      confirmedAt: '2022-04-21T15:00:00Z',
    }),
    equity(3, {
      caseDate: '2024-06-30',
      plannedExitDate: '2028-06-30',
      revisionReason: 'Re-underwritten after the add-on acquisition',
      enteredAt: '2024-08-14T10:00:00Z',
      confirmedAt: '2024-08-16',
      points: [point('2024-06-30', '30000000.00'), point('2028-06-30', '52000000.00')],
    }),
    {
      ...equity(4, { state: 'Withdrawn', withdrawnReason: 'Confirmed against the wrong model' }),
      form: 'credit',
      caseDate: '2024-09-30',
      plannedExitDate: '2029-09-30',
      exitMultiple: null,
      underwrittenYield: '0.1150',
      annualLossRate: '0.0100',
      points: [],
    },
    equity(5, {
      state: 'Draft',
      caseDate: '2025-03-31',
      plannedExitDate: '2029-03-31',
      enteredAt: '2025-06-24T10:00:00Z',
      confirmedBy: null,
      confirmedAt: null,
      points: [point('2025-03-31', '33000000.00'), point('2029-03-31', '55000000.00')],
    }),
  ];
  const withCases = (cases: SeedCase[]): ParsedSyntheticDataset => ({
    ...controlsDataset(),
    underwritingCases: cases,
  });

  it('accepts a dataset made before the base cases and reads them as none', () => {
    const legacy: Record<string, unknown> = { ...controlsDataset() };
    delete legacy.underwritingCases;
    expect(syntheticDatasetSchema.parse(legacy).underwritingCases).toEqual([]);
  });

  it('records each version as the product does, and leaves every case where the dataset says it stands', async () => {
    const handle = await createTestDb();
    try {
      // The first three versions, then the dataset grown by two: a version already there is
      // left as it is and the new ones are recorded on top of it.
      await loadSyntheticDataset(handle, withCases(versions().slice(0, 3)));
      const counts = await loadSyntheticDataset(handle, withCases(versions()));
      expect(counts).toMatchObject({ underwritingCases: 5, underwritingCasePoints: 8 });
      const read = () =>
        handle.query<{
          version: number;
          form: string;
          state: string;
          confirmed_by: string | null;
          confirmed_at: Date | null;
          entered_at: Date;
          withdrawn_reason: string | null;
          row_version: number;
          points: number;
        }>(
          `select c.version, c.form, c.state::text as state, c.confirmed_by, c.confirmed_at, c.entered_at, c.withdrawn_reason, c.row_version,
             (select count(*)::int from mon.underwriting_case_point p where p.case_id = c.id) as points
           from mon.underwriting_case c order by c.version`,
        );
      const rows = await read();
      expect(
        rows.map((r) => [r.version, r.form, r.state, r.confirmed_by, r.points, r.row_version]),
      ).toEqual([
        // Inserted as a Draft, confirmed, then superseded by the confirmation of version 2.
        [1, 'equity', 'Superseded', HEAD, 2, 3],
        [2, 'equity', 'Confirmed', DEAL, 2, 2],
        // A later case date: a re-underwriting, and both stay Confirmed.
        [3, 'equity', 'Confirmed', HEAD, 2, 2],
        // Confirmed, then retired: who confirmed it stays on the row.
        [4, 'credit', 'Withdrawn', HEAD, 0, 3],
        [5, 'equity', 'Draft', null, 2, 1],
      ]);
      expect(rows[3]?.withdrawn_reason).toBe('Confirmed against the wrong model');
      // Instants are written as given; a date reads as UTC midnight, never a local time.
      expect(new Date(rows[0]!.entered_at).toISOString()).toBe('2022-03-22T10:00:00.000Z');
      expect(new Date(rows[0]!.confirmed_at!).toISOString()).toBe('2022-03-24T15:00:00.000Z');
      expect(new Date(rows[2]!.confirmed_at!).toISOString()).toBe('2024-08-16T00:00:00.000Z');
      // The history holds the life of version 1 as it was recorded.
      const history = await handle.query<{ op: string; state: string }>(
        `select op, row_image ->> 'state' as state from mon.underwriting_case_history where row_id = '${caseId(1)}' order by history_id`,
      );
      expect(history).toEqual([
        { op: 'INSERT', state: 'Draft' },
        { op: 'UPDATE', state: 'Confirmed' },
        { op: 'UPDATE', state: 'Superseded' },
      ]);
      // Loading again changes nothing: no second row, no further row version, no new image.
      await loadSyntheticDataset(handle, withCases(versions()));
      expect(await read()).toEqual(rows);
      const images = await handle.query<{ n: number }>(
        'select count(*)::int as n from mon.underwriting_case_history',
      );
      expect(images[0]?.n).toBe(3 + 2 + 2 + 3 + 1);
    } finally {
      await handle.close();
    }
  });

  it('refuses a dataset whose states no history leads to, and writes none of that position', async () => {
    const handle = await createTestDb();
    try {
      // Superseded, with no later version dated as it is to have corrected it.
      const orphan = [equity(1, { state: 'Superseded' })];
      await expect(loadSyntheticDataset(handle, withCases(orphan))).rejects.toThrow(
        /version 1\): the dataset says Superseded, and its versions lead to Confirmed/,
      );
      // Confirmed by the person who entered it (SEC-5.6): the database refuses the confirmation.
      await expectDbRejection(
        loadSyntheticDataset(handle, withCases([equity(1, { confirmedBy: DEAL })])),
        /check constraint/,
      );
      // Confirmed with no source (SEC-9.4), and an equity case whose plan stops short of its exit.
      await expectDbRejection(
        loadSyntheticDataset(handle, withCases([equity(1, { sourceNote: null })])),
        /check constraint/,
      );
      await expectDbRejection(
        loadSyntheticDataset(
          handle,
          withCases([equity(1, { points: [point('2021-12-31', '24000000.00')] })]),
        ),
        /two plan points or more/,
      );
      const rows = await handle.query<{ n: number }>(
        'select (select count(*) from mon.underwriting_case)::int + (select count(*) from mon.underwriting_case_point)::int as n',
      );
      expect(rows[0]?.n).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it('refuses a case with a figure that is not a decimal or a state that does not exist', () => {
    const parse = (overrides: Record<string, unknown>) =>
      syntheticDatasetSchema.safeParse(withCases([{ ...equity(1), ...overrides }])).success;
    expect(parse({})).toBe(true);
    expect(parse({ grossIrr: '20%' })).toBe(false);
    expect(parse({ state: 'Locked' })).toBe(false);
    expect(parse({ form: 'primary' })).toBe(false);
    expect(parse({ version: 0 })).toBe(false);
    expect(parse({ enteredAt: 'last week' })).toBe(false);
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
