import type { Page } from '@playwright/test';
import { generateDataset } from '@pb/synthetic';

export interface E2eDataset {
  asOf: string;
  users: { externalId: string; displayName: string; roles: string[] }[];
  investments: {
    id: string;
    investmentNumber: string;
    portfolioCompanyId: string;
    isActive: boolean;
  }[];
  portfolioCompanies: { id: string; name: string }[];
  scenarios: Record<string, string[]>;
}

/** The same deterministic dataset scripts/e2e-api.mjs seeds (small profile, seed 42). */
export function loadDataset(): E2eDataset {
  return generateDataset({ profile: 'small', seed: 42 });
}

export function walledDeal(d: E2eDataset): { id: string; companyName: string } {
  const id = d.scenarios.walled_deal?.[0];
  if (id === undefined) throw new Error('dataset has no walled deal');
  const inv = d.investments.find((i) => i.id === id);
  const company = d.portfolioCompanies.find((c) => c.id === inv?.portfolioCompanyId);
  return { id, companyName: company?.name ?? '' };
}

/** Signs in through the prototype picker. */
export async function signInAs(page: Page, externalId: string, d: E2eDataset): Promise<void> {
  const user = d.users.find((u) => u.externalId === externalId);
  if (!user) throw new Error(`no user ${externalId}`);
  await page.goto('/sign-in');
  await page.getByRole('button', { name: new RegExp(user.displayName) }).click();
  await page.getByTestId('current-user').waitFor();
}
