import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { generateDataset } from '@pb/synthetic';
import { loadDataset, signInAs } from './fixtures.js';

/**
 * Vehicles and sponsors (M17, M6): operations reads a vehicle's client commitments, a viewer gets
 * the entitlement empty state instead (SEC-5.4), and a sponsor opens from the directory.
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });
const CV_FUND = 'Beach CV Opportunities I';
const CLIENT_DATA_VISIBILITY =
  'Client commitments are visible to operations, approvers, auditors and entitled investor relations users (SEC-5.4)';

/** The sponsor with the most active positions, so its 360 page has every section filled. */
function busiestSponsor(): { id: string; name: string } {
  const ranked = full.sponsors
    .map((s) => ({
      sponsor: s,
      active: full.investments.filter((i) => i.sponsorId === s.id && i.isActive).length,
    }))
    .sort((a, b) => b.active - a.active);
  const top = ranked[0];
  if (top === undefined) throw new Error('dataset has no sponsor');
  return { id: top.sponsor.id, name: top.sponsor.name };
}

async function openVehicleFromList(page: Page, name: string): Promise<void> {
  await page.goto('/portfolio/vehicles');
  await page.getByRole('table', { name: 'Vehicles' }).getByRole('link', { name }).click();
  await expect(page.getByTestId('vehicle-banner')).toContainText(name);
}

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

test('operations opens a vehicle from the list and reads its client commitments', async ({
  page,
}) => {
  await signInAs(page, 'ops.one', d);
  await openVehicleFromList(page, CV_FUND);
  await expect(page.getByRole('table', { name: 'Schedule of investments' })).toBeVisible();
  const clients = page.getByRole('table', { name: 'Client commitments' });
  await expect(clients).toBeVisible();
  await expect(clients).toContainText('Client Alpha Pension');
  await expect(clients).toContainText('Client Beta Endowment');
  await expect(clients).toContainText('60.0%');
  await expect(page.getByTestId('client-commitments-hidden')).toHaveCount(0);
});

test('a viewer sees who may read client commitments instead of the table', async ({ page }) => {
  await signInAs(page, 'viewer.one', d);
  await page.goto('/portfolio/vehicles');
  await expect(page.getByTestId('vehicles-client-note')).toContainText(CLIENT_DATA_VISIBILITY);
  await openVehicleFromList(page, CV_FUND);
  await expect(page.getByTestId('client-commitments-hidden')).toContainText(CLIENT_DATA_VISIBILITY);
  await expect(page.getByRole('table', { name: 'Client commitments' })).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Schedule of investments' })).toBeVisible();
});

test('a sponsor opens from the Sponsors list', async ({ page }) => {
  const sponsor = busiestSponsor();
  await signInAs(page, 'viewer.one', d);
  await page.goto('/sponsors');
  await page.getByRole('textbox', { name: 'Search' }).fill(sponsor.name.slice(0, 5));
  await page
    .getByRole('table', { name: 'Sponsors' })
    .getByRole('link', { name: sponsor.name })
    .click();
  await expect(page).toHaveURL(new RegExp(`/sponsors/${sponsor.id}$`));
  await expect(page.getByTestId('sponsor-banner')).toContainText(sponsor.name);
  await expect(page.getByTestId('sponsor-tiles')).toBeVisible();
  await expect(page.getByRole('group', { name: 'NAV by position' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Funds' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Our positions' })).toBeVisible();
  await page.getByRole('link', { name: 'All sponsors' }).click();
  await expect(page.getByRole('table', { name: 'Sponsors' })).toBeVisible();
});

test('vehicles and sponsors pages @a11y', async ({ page }) => {
  const sponsor = busiestSponsor();
  await signInAs(page, 'ops.one', d);
  await page.goto('/portfolio/vehicles');
  await page.getByRole('table', { name: 'Vehicles' }).waitFor();
  await expectNoSeriousViolations(page);
  await openVehicleFromList(page, CV_FUND);
  await page.getByRole('table', { name: 'Client commitments' }).waitFor();
  await expectNoSeriousViolations(page);
  await page.goto('/sponsors');
  await page.getByRole('table', { name: 'Sponsors' }).waitFor();
  await expectNoSeriousViolations(page);
  await page.goto(`/sponsors/${sponsor.id}`);
  await page.getByTestId('sponsor-banner').waitFor();
  await expectNoSeriousViolations(page);
});
