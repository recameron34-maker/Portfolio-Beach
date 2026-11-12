import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { generateDataset, weeklyValues } from '@pb/synthetic';
import { loadDataset, signInAs, switchTo, walledDeal } from './fixtures.js';

/**
 * Weekly values (docs/04 M2 weekly-report-intake, decision 0010) over the real API: operations
 * stages the synthetic "update" file, sees the three moved values with their variance against the
 * prior, approves the validated rows it may see and sees Draft valuations created; the walled
 * position's row is counted, never shown, and a wall member finishes the file (SEC-5.3); the same
 * file again stages nothing new; a viewer is told who weekly values are for. The file is built in
 * the test from the same dataset the API is seeded with (small profile, seed 42).
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });
const update = weeklyValues(full, { scenario: 'update' });

if (update.expectations.moved.length === 0) throw new Error('the update file has no moved value');

/** The staged weekly values table on the file page. */
const stagedRows = (page: Page) => page.getByRole('table', { name: 'Staged weekly values' });

/** The row of the staged values table that carries the investment number. */
const rowFor = (page: Page, investmentNumber: string) =>
  stagedRows(page).getByRole('row').filter({ hasText: investmentNumber });

/** The variance the page shows for a move the generator applied: signed, one decimal ("+3.0%"). */
const shownVariance = (pct: string): string => {
  const value = Number(pct) * 100;
  const text = `${Math.abs(value).toFixed(1)}%`;
  return value < 0 ? `-${text}` : `+${text}`;
};

const walled = walledDeal(d);
const walledNumber = d.investments.find((i) => i.id === walled.id)?.investmentNumber ?? '';

test('operations stages the update file, reviews the moved values and promotes what it may see into Draft valuations; a wall member finishes the file', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await signInAs(page, 'ops.one', d);
  await page.goto('/data/weekly');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Weekly values');
  await expect(page.getByTestId('weekly-upload')).toBeVisible();

  // The file is read in the browser and sent as text, never as bytes.
  await page.getByLabel('Weekly values (CSV)').setInputFiles({
    name: update.fileName,
    mimeType: 'text/csv',
    buffer: Buffer.from(update.csv, 'utf8'),
  });
  await page.getByRole('button', { name: 'Stage weekly values' }).click();

  await expect(page).toHaveURL(/\/data\/weekly\/[0-9a-f-]{36}$/);
  const fileUrl = page.url();
  await expect(page.getByTestId('weekly-banner')).toContainText(update.fileName);
  await expect(page.getByTestId('weekly-duplicate')).toHaveCount(0);
  const tiles = page.getByTestId('weekly-tiles');
  await expect(tiles.getByRole('group', { name: 'Rows' })).toContainText(
    String(update.expectations.rows),
  );
  await expect(tiles.getByRole('group', { name: 'Flagged' })).toContainText('0');
  await expect(tiles.getByRole('group', { name: 'Promoted' })).toContainText('0');
  await expect(tiles.getByRole('group', { name: 'Exceptions' })).toContainText('0');
  // The walled position's row linked all the same but is past ops.one's wall: counted, never
  // shown, and never a "no match" (SEC-5.3, decision 0009).
  await expect(page.getByText('1 row is linked to positions you cannot see')).toBeVisible();
  await expect(stagedRows(page)).toBeVisible();
  await expect(stagedRows(page)).not.toContainText(walled.companyName);
  await expect(stagedRows(page)).not.toContainText(walledNumber);

  // The moved values show their variance against the prior, inside the threshold, so nothing is flagged.
  for (const moved of update.expectations.moved) {
    const row = rowFor(page, moved.investmentNumber);
    await expect(row).toContainText(shownVariance(moved.pct));
    await expect(row).toContainText('Locked mark');
    await expect(row).toContainText('Validated');
    await expect(row).not.toContainText('Above threshold');
  }
  // Every linked row names its position and links to the deal workspace.
  const first = update.expectations.moved[0]?.investmentNumber ?? '';
  await expect(rowFor(page, first).getByRole('link').first()).toHaveAttribute(
    'href',
    /\/portfolio\/[0-9a-f-]{36}$/,
  );

  await page.getByRole('button', { name: 'Approve validated rows' }).click();
  await expect(page.getByTestId('weekly-action-status')).toContainText('rows promoted');
  await expect(page.getByTestId('weekly-action-status')).toContainText('Draft valuations created');
  await expect(rowFor(page, first)).toContainText('Promoted');
  await expect(rowFor(page, first).getByRole('link', { name: /Draft valuation/ })).toHaveAttribute(
    'href',
    /\/valuations$/,
  );
  await expect(page.getByTestId('weekly-board-link')).toContainText('valuations board');
  // One row is left: the walled position's, which only a wall member may approve.
  await expect(tiles.getByRole('group', { name: 'Validated' })).toContainText('1');
  await expect(tiles.getByRole('group', { name: 'Promoted' })).toContainText(
    String(update.expectations.rows - 1),
  );
  await expect(page.getByRole('button', { name: 'Approve validated rows' })).toBeDisabled();

  // A wall member sees that row and finishes the file.
  await switchTo(page, 'deal.three', d);
  await page.goto(fileUrl);
  await expect(page.getByTestId('weekly-banner')).toContainText(update.fileName);
  await expect(page.getByText('linked to positions you cannot see')).toHaveCount(0);
  await expect(rowFor(page, walledNumber)).toContainText(walled.companyName);
  await expect(rowFor(page, walledNumber)).toContainText('Validated');
  await page.getByRole('button', { name: 'Approve validated rows' }).click();
  await expect(page.getByTestId('weekly-action-status')).toContainText(
    '1 row promoted (audited); 1 Draft valuation created',
  );
  await expect(rowFor(page, walledNumber)).toContainText('Promoted');
  await expect(tiles.getByRole('group', { name: 'Validated' })).toContainText('0');
  await expect(tiles.getByRole('group', { name: 'Promoted' })).toContainText(
    String(update.expectations.rows),
  );

  // Back as operations: the list shows the file as promoted, and the same text stages nothing new.
  await switchTo(page, 'ops.one', d);
  await page.goto('/data/weekly');
  const files = page.getByRole('table', { name: 'Weekly files' });
  await expect(files.getByRole('row').filter({ hasText: update.fileName })).toContainText(
    'Promoted',
  );
  await page.getByLabel('Weekly values (CSV)').setInputFiles({
    name: update.fileName,
    mimeType: 'text/csv',
    buffer: Buffer.from(update.csv, 'utf8'),
  });
  await page.getByRole('button', { name: 'Stage weekly values' }).click();
  await expect(page.getByTestId('weekly-duplicate')).toBeVisible();
});

test('a viewer is told weekly values are for operations and reviewers', async ({ page }) => {
  await signInAs(page, 'viewer.one', d);
  await page.goto('/data/weekly');
  await expect(page.getByText('Weekly values are for operations and reviewers')).toBeVisible();
  await expect(page.getByTestId('weekly-upload')).toHaveCount(0);
  await expect(page.getByRole('table', { name: 'Weekly files' })).toHaveCount(0);
});
