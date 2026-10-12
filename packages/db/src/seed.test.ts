import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './testing.js';
import type { DbHandle } from './client.js';
import { loadSyntheticDataset, syntheticDatasetSchema } from './seed.js';
import type { SyntheticDataset } from './seed.js';
import { expectDbRejection } from './test-utils.js';

const COMPANY = '20000000-0000-4000-8000-000000000003';
const OTHER_COMPANY = '20000000-0000-4000-8000-000000000004';

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
  };
  return companyAliases === undefined ? base : { ...base, companyAliases };
}

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
