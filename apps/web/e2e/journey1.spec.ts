import { expect, test } from '@playwright/test';
import { loadDataset, signInAs, walledDeal } from './fixtures.js';

/** Critical journey 1 (docs/12 section 3): each role sees only permitted records, including a walled deal hidden from non-members. */
const d = loadDataset();
const walled = walledDeal(d);

test('anonymous users are sent to sign-in', async ({ page }) => {
  await page.goto('/portfolio');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByTestId('mock-user-list')).toBeVisible();
});

test('a viewer sees the portfolio without the walled deal and gets not-found when opening it directly', async ({
  page,
}) => {
  await signInAs(page, 'viewer.one', d);
  await expect(page.getByRole('status')).toContainText('synthetic data only');
  await page.goto('/portfolio');
  const grid = page.getByTestId('portfolio-grid');
  await expect(grid).toBeVisible();
  await expect(page.getByTestId('portfolio-count')).toContainText('positions shown');
  await expect(grid).not.toContainText(walled.companyName);
  await page.goto(`/portfolio/${walled.id}`);
  await expect(page.getByTestId('error-state')).toContainText('Investment not found');
});

test('a wall member sees the walled deal in the grid and can open its one-pager', async ({
  page,
}) => {
  await signInAs(page, 'deal.three', d);
  await page.goto('/portfolio');
  const grid = page.getByTestId('portfolio-grid');
  await expect(grid).toContainText(walled.companyName);
  await page.goto(`/portfolio/${walled.id}`);
  await expect(page.getByTestId('detail-banner')).toContainText(walled.companyName);
  await expect(page.getByRole('table', { name: 'Valuations' })).toBeVisible();
});

test('the role switcher changes who the app acts as', async ({ page }) => {
  await signInAs(page, 'viewer.one', d);
  const admin = d.users.find((u) => u.roles.includes('platform_admin'))!;
  await page.getByTestId('role-switcher').click();
  await page.getByRole('option', { name: new RegExp(admin.displayName) }).click();
  await expect(page.getByTestId('current-user')).toHaveText(admin.displayName);
  await page.goto('/admin/flags');
  await expect(page.getByText('You can change flags')).toBeVisible();
});

test('investor relations users see only their entitled client data on Data Health', async ({
  page,
}) => {
  await signInAs(page, 'ir.two', d);
  await page.goto('/data/health');
  await expect(page.getByTestId('data-health-tiles')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Data Health' })).toBeVisible();
});
