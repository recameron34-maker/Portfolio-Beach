import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { generateDataset, lookthroughExtract } from '@pb/synthetic';
import { loadDataset, signInAs, walledDeal } from './fixtures.js';

/**
 * Look-through reconcile and the exceptions queue (docs/04 M2 lookthrough-reconcile, M1 Data
 * Health, decision 0010) over the real API: operations reconciles the synthetic "defects"
 * extract, reads the differences it opened, works three exceptions (acknowledge, resolve with a
 * reason, note a ticket), and the walled position's rows are counted, never shown, until a wall
 * member opens the run (SEC-5.3). The extract is built from the same dataset the API is seeded
 * with (small profile, seed 42) and written into the e2e API's look-through folder before the run,
 * so its expectations name the rows and counts to look for.
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });
const defects = lookthroughExtract(full, { scenario: 'defects' });

/** The fields a difference is reported on; the generator's asOf difference is the stale finding, not a difference. */
const DIFFERENCE_FIELDS = new Set(['sector', 'geography', 'exposureAtCost', 'exposureAtNav']);
const differences = defects.expectations.differences.filter((x) =>
  DIFFERENCE_FIELDS.has(x.field),
).length;
const exceptionsOpened =
  differences + defects.expectations.unmatched.length + defects.expectations.unmapped.length;

const walled = walledDeal(d);
const walledNumber = d.investments.find((i) => i.id === walled.id)?.investmentNumber ?? '';

/** Switches the acting user through the shell's role switcher (the prototype's sign-in). */
async function switchTo(page: Page, externalId: string): Promise<void> {
  const user = d.users.find((u) => u.externalId === externalId);
  if (!user) throw new Error(`no user ${externalId}`);
  await page.getByTestId('role-switcher').click();
  await page.getByRole('option', { name: new RegExp(user.displayName) }).click();
  await expect(page.getByTestId('current-user')).toHaveText(user.displayName);
}

test.beforeAll(() => {
  // The e2e API reads the look-through folder under its scratch (scripts/e2e-api.mjs sets
  // PB_DROP_ROOT there); the folder provider reads <asOf>.json at request time.
  const scratch: unknown = test.info().config.metadata.scratch;
  if (typeof scratch !== 'string') throw new Error('the Playwright config names no scratch folder');
  const folder = join(scratch, 'drops', 'lookthrough');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${defects.asOf}.json`), defects.json);
});

test('operations reconciles the defects extract, reads its differences and works the exceptions; a wall member sees the walled rows', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInAs(page, 'ops.one', d);
  await page.goto('/data/lookthrough');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Look-through');
  const card = page.getByTestId('lookthrough-run');
  await expect(card).toBeVisible();
  // The as-of date defaults to the record's (Data Health).
  await expect(card.getByLabel('As of')).toHaveValue(d.asOf);
  await card.getByRole('button', { name: 'Reconcile' }).click();

  await expect(page).toHaveURL(/\/data\/lookthrough\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const runUrl = page.url();
  await expect(page.getByTestId('lookthrough-banner')).toContainText(
    `lookthrough-${defects.asOf}.json`,
  );
  await expect(page.getByTestId('lookthrough-duplicate')).toHaveCount(0);
  const tiles = page.getByTestId('lookthrough-tiles');
  await expect(tiles.getByRole('group', { name: 'Rows' })).toContainText(
    String(defects.expectations.rows),
  );
  await expect(tiles.getByRole('group', { name: 'Differences' })).toContainText(
    String(differences),
  );
  await expect(tiles.getByRole('group', { name: 'Exceptions' })).toContainText(
    String(exceptionsOpened),
  );
  // The walled position's rows (its own and the stale one) linked all the same but are past
  // ops.one's wall: counted, never shown (SEC-5.3, decision 0009).
  await expect(page.getByTestId('lookthrough-hidden-rows')).toHaveText(
    `${defects.expectations.walled.length} rows are linked to positions you cannot see`,
  );
  const rows = page.getByRole('table', { name: 'Reconciled positions' });
  await expect(rows).toBeVisible();
  await expect(rows).not.toContainText(walled.companyName);
  await expect(rows).not.toContainText(walledNumber);
  await expect(rows.getByText('no match')).toHaveCount(defects.expectations.unmatched.length);
  await expect(rows.getByText('Other (unmapped)')).toHaveCount(
    defects.expectations.unmapped.length,
  );
  await expect(rows.locator('.pb-badge', { hasText: 'NAV' })).toHaveCount(1);

  // The run links to its exceptions on the queue.
  await page.getByTestId('lookthrough-exceptions-link').click();
  await expect(page).toHaveURL(/\/data\/exceptions\?file=/);
  await expect(page.getByTestId('exceptions-file-note')).toContainText(
    `lookthrough-${defects.asOf}.json`,
  );
  const queue = page.getByRole('table', { name: 'Data exceptions' });
  await expect(queue.getByRole('row')).toHaveCount(exceptionsOpened + 1);
  await expect(queue.getByRole('row').filter({ hasText: 'Open' })).toHaveCount(exceptionsOpened);

  // Acknowledge the NAV difference, then resolve it with a reason.
  await queue.getByRole('link', { name: 'LT-TIE-01' }).click();
  await expect(page.getByTestId('exception-banner')).toContainText('LT-TIE-01');
  await page.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(page.getByTestId('exception-action-status')).toContainText('Acknowledged, taken by');
  await expect(page.getByTestId('exception-banner')).toContainText('Acknowledged');
  await page.getByRole('button', { name: 'Resolve' }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('textbox', { name: 'Reason' })
    .fill('The provider restated the mark; the record stands');
  await dialog.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByTestId('exception-action-status')).toContainText('Resolved');
  await expect(page.getByTestId('exception-banner')).toContainText('Resolved');
  await expect(page.getByTestId('exception-terminal')).toBeVisible();

  // Note a ticket on the unmapped label; the state stays open.
  await page.getByRole('link', { name: 'All exceptions' }).click();
  await page.getByRole('link', { name: 'LT-MAP-01' }).first().click();
  await expect(page.getByTestId('exception-banner')).toContainText('LT-MAP-01');
  await page.getByLabel('External ticket').fill('HD-1042');
  await page.getByRole('button', { name: 'Set ticket' }).click();
  await expect(page.getByTestId('exception-action-status')).toContainText('Ticket HD-1042 noted');
  await expect(page.getByTestId('exception-detail')).toContainText('HD-1042');
  await expect(page.getByTestId('exception-banner')).toContainText('Open');

  // The queue shows what was done.
  await page.goto('/data/exceptions');
  const whole = page.getByRole('table', { name: 'Data exceptions' });
  await expect(whole.getByRole('row').filter({ hasText: 'HD-1042' })).toHaveCount(1);
  await expect(whole.getByRole('row').filter({ hasText: 'Resolved' })).toHaveCount(1);

  // A wall member sees the walled rows of the run, the stale one with its finding.
  await switchTo(page, 'deal.three');
  await page.goto(runUrl);
  await expect(page.getByTestId('lookthrough-banner')).toContainText(
    `lookthrough-${defects.asOf}.json`,
  );
  await expect(page.getByTestId('lookthrough-hidden-rows')).toHaveCount(0);
  const memberRows = page.getByRole('table', { name: 'Reconciled positions' });
  await expect(memberRows.getByRole('row').filter({ hasText: walledNumber })).toHaveCount(
    defects.expectations.walled.length,
  );
  await expect(memberRows).toContainText(walled.companyName);
  await expect(memberRows.getByText('LT-STALE-01', { exact: true })).toHaveCount(1);

  // Back as operations: the same extract again is a duplicate and stages nothing new.
  await switchTo(page, 'ops.one');
  await page.goto('/data/lookthrough');
  await page.getByTestId('lookthrough-run').getByRole('button', { name: 'Reconcile' }).click();
  await expect(page.getByTestId('lookthrough-duplicate')).toBeVisible({ timeout: 30_000 });
});

test('a viewer is told look-through and the queue are for operations and reviewers', async ({
  page,
}) => {
  await signInAs(page, 'viewer.one', d);
  await page.goto('/data/lookthrough');
  await expect(page.getByText('Look-through is for operations and reviewers')).toBeVisible();
  await expect(page.getByTestId('lookthrough-run')).toHaveCount(0);
  await page.goto('/data/exceptions');
  await expect(page.getByText('Exceptions are for operations and reviewers')).toBeVisible();
});
