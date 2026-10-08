import { expect, test } from '@playwright/test';
import { loadDataset, signInAs, walledDeal } from './fixtures.js';
import type { E2eDataset } from './fixtures.js';

/**
 * $M with one decimal and thousands separators (docs/06 section 3), written independently of
 * src/lib/format.ts so the journey also checks the app's formatter. Rounds half away from zero.
 */
function moneyM(value: string): string {
  const millions = Number(value) / 1_000_000;
  const [whole = '0', frac = '0'] = (Math.round(Math.abs(millions) * 10) / 10)
    .toFixed(1)
    .split('.');
  return `${millions < 0 ? '-' : ''}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}M`;
}

/**
 * Deal workspace tabs over the real endpoints (docs/12 section 3): a wall member opens the walled
 * position, reads its Performance tab and its Sponsor tab, and each shows a figure that matches
 * the seeded synthetic dataset.
 */
interface DealDataset extends E2eDataset {
  investments: (E2eDataset['investments'][number] & { sponsorId: string })[];
  sponsors: { id: string; name: string }[];
  quarterlyPerformance: {
    investmentId: string;
    periodEnd: string;
    isEntrySnapshot: boolean;
    revenueLtm: string | null;
  }[];
}

const d = loadDataset() as DealDataset;
const deal = walledDeal(d);
const investment = d.investments.find((i) => i.id === deal.id);
const sponsor = d.sponsors.find((s) => s.id === investment?.sponsorId);
const latestQuarter = d.quarterlyPerformance
  .filter((q) => q.investmentId === deal.id && !q.isEntrySnapshot)
  .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd))[0];
// deal.three sits on the wall, so every position with the sponsor is visible to them.
const sponsorPositions = d.investments.filter((i) => i.sponsorId === sponsor?.id).length;

test('a wall member reads the performance and sponsor tabs of a position', async ({ page }) => {
  expect(sponsor, 'the walled position has a sponsor in the dataset').toBeDefined();
  expect(latestQuarter, 'the walled position has quarterly financials').toBeDefined();
  await signInAs(page, 'deal.three', d);
  await page.goto(`/portfolio/${deal.id}`);
  await expect(page.getByTestId('detail-banner')).toContainText(deal.companyName);
  const tabs = page.getByRole('navigation', { name: 'Deal workspace' });

  await tabs.getByRole('link', { name: 'Performance', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/portfolio/${deal.id}/performance$`));
  const quarters = page.getByRole('table', { name: 'Quarterly financials' });
  // Newest first: the first body row is the latest quarter, its LTM revenue as the API serves it.
  await expect(quarters.getByRole('row').nth(1)).toContainText(
    moneyM(latestQuarter?.revenueLtm ?? '0'),
  );
  // The banner is shared by every tab.
  await expect(page.getByTestId('detail-banner')).toContainText(deal.companyName);

  await tabs.getByRole('link', { name: 'Sponsor and contacts', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/portfolio/${deal.id}/sponsor$`));
  await expect(page.getByRole('link', { name: sponsor?.name ?? '', exact: true })).toHaveAttribute(
    'href',
    `/sponsors/${sponsor?.id ?? ''}`,
  );
  await expect(page.getByRole('group', { name: 'Positions' }).locator('.pb-stat-value')).toHaveText(
    String(sponsorPositions),
  );
});
