import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addMonths, latestQuarterEndOnOrBefore } from '@pb/calc';
import { accountingExport, generateDataset } from '@pb/synthetic';
import { loadDataset, signInAs, walledDeal } from './fixtures.js';

/**
 * Intake (docs/04 M2, SEC-9.1) over the real API: operations stages the synthetic "update" export,
 * reads the changed and new rows it staged, approves the validated rows it may see and sees them
 * promoted; the walled position's row is counted, never shown, and a wall member finishes the file
 * (SEC-5.3); a viewer is told who intake is for. The export is built in the test from the same dataset the
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

/** The row of the staged rows table that carries the investment number (and, when given, the period). */
const rowFor = (page: Page, investmentNumber: string, period?: string) => {
  const rows = stagedRows(page).getByRole('row').filter({ hasText: investmentNumber });
  return period === undefined ? rows : rows.filter({ hasText: period });
};

/** A period end as the staged rows table shows it, for example "Jun 30, 2024". */
const shownDate = (isoDate: string): string =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

// The supplied quarter is a year before the export's quarter; that position also has its usual row.
const addedPeriod = shownDate(addMonths(latestQuarterEndOnOrBefore(full.asOf), -12));

/** Switches the acting user through the shell's role switcher (the prototype's sign-in). */
async function switchTo(page: Page, externalId: string): Promise<void> {
  const user = d.users.find((u) => u.externalId === externalId);
  if (!user) throw new Error(`no user ${externalId}`);
  await page.getByTestId('role-switcher').click();
  await page.getByRole('option', { name: new RegExp(user.displayName) }).click();
  await expect(page.getByTestId('current-user')).toHaveText(user.displayName);
}

const walled = walledDeal(d);
const walledNumber = d.investments.find((i) => i.id === walled.id)?.investmentNumber ?? '';

test('operations stages the update export, reviews the diff and promotes what it may see; a wall member finishes the file', async ({
  page,
}) => {
  test.setTimeout(150_000);
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
  const fileUrl = page.url();
  await expect(page.getByTestId('intake-banner')).toContainText(update.fileName);
  await expect(page.getByTestId('intake-duplicate')).toHaveCount(0);
  const tiles = page.getByTestId('intake-tiles');
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

  await expect(rowFor(page, changedNumber)).toContainText('Changed');
  await expect(rowFor(page, changedNumber)).toContainText('EBITDA');
  await expect(rowFor(page, addedNumber, addedPeriod)).toContainText('New');
  await expect(rowFor(page, addedNumber, addedPeriod)).toContainText('Validated');
  // Every linked row names its position and links to the deal workspace.
  await expect(rowFor(page, changedNumber).getByRole('link')).toHaveAttribute(
    'href',
    /\/portfolio\/[0-9a-f-]{36}$/,
  );

  await page.getByRole('button', { name: 'Approve validated rows' }).click();
  await expect(page.getByTestId('intake-action-status')).toContainText('rows promoted');
  await expect(rowFor(page, changedNumber)).toContainText('Promoted');
  await expect(rowFor(page, addedNumber, addedPeriod)).toContainText('Promoted');
  // One row is left: the walled position's, which only a wall member may approve.
  await expect(tiles.getByRole('group', { name: 'Validated' })).toContainText('1');
  await expect(tiles.getByRole('group', { name: 'Promoted' })).toContainText(
    String(update.expectations.rows - 1),
  );
  await expect(page.getByRole('button', { name: 'Approve validated rows' })).toBeDisabled();

  // A wall member sees that row and finishes the file.
  await switchTo(page, 'deal.three');
  await page.goto(fileUrl);
  await expect(page.getByTestId('intake-banner')).toContainText(update.fileName);
  await expect(page.getByText('linked to positions you cannot see')).toHaveCount(0);
  await expect(rowFor(page, walledNumber)).toContainText(walled.companyName);
  await expect(rowFor(page, walledNumber)).toContainText('Validated');
  await page.getByRole('button', { name: 'Approve validated rows' }).click();
  await expect(page.getByTestId('intake-action-status')).toContainText('1 row promoted');
  await expect(rowFor(page, walledNumber)).toContainText('Promoted');
  await expect(tiles.getByRole('group', { name: 'Validated' })).toContainText('0');
  await expect(tiles.getByRole('group', { name: 'Promoted' })).toContainText(
    String(update.expectations.rows),
  );

  // Back as operations: the list shows the file as promoted, and the same text stages nothing new.
  await switchTo(page, 'ops.one');
  await page.goto('/data/intake');
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
