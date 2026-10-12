import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { accountingExport, generateDataset } from '@pb/synthetic';
import { loadDataset, signInAs } from './fixtures.js';

/**
 * Intake (docs/04 M2, SEC-9.1) over the real API: operations stages the synthetic "update" export,
 * reads the changed and new rows it staged, approves the validated rows and sees them promoted;
 * a viewer is told who intake is for. The export is built in the test from the same dataset the
 * API is seeded with (small profile, seed 42), so its expectations name the rows to look for.
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });
const update = accountingExport(full, { scenario: 'update' });

function expectOne(items: readonly string[], what: string): string {
  const [first] = items;
  if (first === undefined) throw new Error(`the update export has no ${what}`);
  return first;
}

const changedNumber = expectOne(update.expectations.changed, 'restated position');
const addedNumber = expectOne(update.expectations.added, 'new quarter');

/** The staged rows table on the file page. */
const stagedRows = (page: Page) => page.getByRole('table', { name: 'Staged rows' });

/** The row of the staged rows table that carries the investment number. */
const rowFor = (page: Page, investmentNumber: string) =>
  stagedRows(page).getByRole('row').filter({ hasText: investmentNumber });

test('operations stages the update export, reviews the diff and promotes the validated rows', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signInAs(page, 'ops.one', d);
  await page.goto('/data/intake');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Intake');
  await expect(page.getByTestId('intake-upload')).toBeVisible();

  // The file is read in the browser and sent as text, never as bytes.
  await page.getByLabel('Accounting export (CSV)').setInputFiles({
    name: update.fileName,
    mimeType: 'text/csv',
    buffer: Buffer.from(update.csv, 'utf8'),
  });
  await page.getByRole('button', { name: 'Stage export' }).click();

  await expect(page).toHaveURL(/\/data\/intake\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('intake-banner')).toContainText(update.fileName);
  await expect(page.getByTestId('intake-duplicate')).toHaveCount(0);
  const tiles = page.getByTestId('intake-tiles');
  await expect(tiles.getByRole('group', { name: 'Rows' })).toContainText(
    String(update.expectations.rows),
  );
  await expect(tiles.getByRole('group', { name: 'Flagged' })).toContainText('0');
  await expect(tiles.getByRole('group', { name: 'Promoted' })).toContainText('0');

  await expect(stagedRows(page)).toBeVisible();
  await expect(rowFor(page, changedNumber)).toContainText('Changed');
  await expect(rowFor(page, changedNumber)).toContainText('EBITDA');
  await expect(rowFor(page, addedNumber)).toContainText('New');
  await expect(rowFor(page, addedNumber)).toContainText('Validated');
  // Every linked row names its position and links to the deal workspace.
  await expect(rowFor(page, changedNumber).getByRole('link')).toHaveAttribute(
    'href',
    /\/portfolio\/[0-9a-f-]{36}$/,
  );

  await page.getByRole('button', { name: 'Approve validated rows' }).click();
  await expect(page.getByTestId('intake-action-status')).toContainText('rows promoted');
  await expect(rowFor(page, changedNumber)).toContainText('Promoted');
  await expect(rowFor(page, addedNumber)).toContainText('Promoted');
  await expect(tiles.getByRole('group', { name: 'Validated' })).toContainText('0');
  await expect(tiles.getByRole('group', { name: 'Promoted' })).toContainText(
    String(update.expectations.rows),
  );
  await expect(page.getByRole('button', { name: 'Approve validated rows' })).toBeDisabled();

  // The list shows the file as promoted, and staging the same text again stages nothing new.
  await page.getByRole('link', { name: 'All intake files' }).click();
  const files = page.getByRole('table', { name: 'Intake files' });
  await expect(files.getByRole('row').filter({ hasText: update.fileName })).toContainText(
    'Promoted',
  );
  await page.getByLabel('Accounting export (CSV)').setInputFiles({
    name: update.fileName,
    mimeType: 'text/csv',
    buffer: Buffer.from(update.csv, 'utf8'),
  });
  await page.getByRole('button', { name: 'Stage export' }).click();
  await expect(page.getByTestId('intake-duplicate')).toBeVisible();
});

test('a viewer is told intake is for operations and reviewers', async ({ page }) => {
  await signInAs(page, 'viewer.one', d);
  await page.goto('/data/intake');
  await expect(page.getByText('Intake is for operations and reviewers')).toBeVisible();
  await expect(page.getByTestId('intake-upload')).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Intake files' })).toHaveCount(0);
});
