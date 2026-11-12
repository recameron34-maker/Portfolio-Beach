import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addDays, latestQuarterEndOnOrBefore } from '@pb/calc';
import { generateDataset, generateDocuments, UNTAGGED_FILE_NAME } from '@pb/synthetic';
import definitions from '../../../config/definitions.json' with { type: 'json' };
import { loadDataset, signInAs, switchTo, walledDeal } from './fixtures.js';

/**
 * The document hub (docs/04 M3, decision 0012) over the real API: operations indexes the
 * synthetic document set and reads the counts, classifies the untagged scan from the review
 * queue, a deal team member outside the wall searching the walled company's name finds nothing
 * while the wall member finds its reports (the M3 search-permission acceptance criterion,
 * SEC-8.5), and the expected documents of the latest quarter are generated, the position whose
 * report is deliberately absent reading late and then missing as the as-of day moves. The set is
 * generated in the test from the same dataset the API is seeded with (small profile, seed 42), so
 * its expectations name the counts and files to look for.
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });
const set = generateDocuments(full);
const total = set.documents.length;
const distinct = new Set(set.documents.map((x) => x.truth.contentHash)).size;
const duplicates = total - distinct;
const walled = walledDeal(d);
const walledFiles = set.expectations.walledFiles;
const scan = set.documents.find((x) => x.fileName === UNTAGGED_FILE_NAME);
const late = set.expectations.lateFinancials;
const latestQuarter = latestQuarterEndOnOrBefore(d.asOf);
const { expectedDueDaysAfterQuarterEnd, lateAfterDays, missingAfterDays } = definitions.documents;
const dueDate = addDays(latestQuarter, expectedDueDaysAfterQuarterEnd);

const hubTable = (page: Page) => page.getByRole('table', { name: 'Documents' });
const search = (page: Page) => page.getByTestId('documents-search');

/** Indexes the store as operations through the API (idempotent), for the tests that read documents. */
async function indexAs(page: Page, externalId: string): Promise<void> {
  const res = await page.request.post('/api/v1/documents/index', {
    headers: { authorization: `Bearer ${externalId}` },
  });
  expect(res.ok()).toBe(true);
}

test('operations indexes the documents and reads the counts; the scan waits in the queue and is classified', async ({
  page,
}) => {
  test.setTimeout(150_000);
  expect(scan, 'the set has the untagged scan').toBeDefined();
  await signInAs(page, 'ops.one', d);
  await page.goto('/documents');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Documents');

  // The counts match the generated set: one row per distinct content hash, the second name of
  // the duplicate pair as a duplicate. The suite shares one API, so when another spec has indexed
  // the store already the scan finds every item unchanged instead.
  await page.getByRole('button', { name: 'Index documents' }).click();
  await expect(page.getByTestId('documents-action-status')).toContainText(
    new RegExp(
      `Indexed ${distinct} documents, ${duplicates} duplicates, 0 unchanged|Indexed 0 documents, 0 duplicates, ${total} unchanged`,
    ),
    { timeout: 60_000 },
  );
  // Every item the user may see, newest first: the walled position's files are absent for
  // operations outside the wall (SEC-8.5).
  await expect(hubTable(page)).toBeVisible();
  await expect(hubTable(page).getByRole('row')).toHaveCount(total - walledFiles.length + 1);
  await expect(hubTable(page)).not.toContainText(walled.companyName);
  await expect(hubTable(page).getByText('Duplicate')).toHaveCount(duplicates);
  await expect(hubTable(page).getByText('Needs review')).toHaveCount(1);

  // A second scan changes nothing.
  await page.getByRole('button', { name: 'Index documents' }).click();
  await expect(page.getByTestId('documents-action-status')).toContainText(
    `Indexed 0 documents, 0 duplicates, ${total} unchanged`,
    { timeout: 60_000 },
  );

  // The queue holds the scan alone; operations opens it and names what it is.
  await page.goto('/documents/review');
  const queue = page.getByTestId('review-queue');
  await expect(queue.getByRole('row')).toHaveCount(2);
  await expect(queue).toContainText(UNTAGGED_FILE_NAME);
  await queue.getByRole('link', { name: 'scan_0042' }).click();
  await expect(page).toHaveURL(/\/documents\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('document-banner')).toContainText('Needs review');
  await expect(page.getByTestId('document-detail')).toContainText('30%');
  // The text is read from the store page by page; the selector moves to the financial summary.
  const pages = page.getByTestId('document-pages');
  await expect(pages).toContainText('Page 1 of 4', { timeout: 20_000 });
  await expect(pages).toContainText('for the quarter ended');
  await pages.getByRole('combobox', { name: 'Page' }).click();
  await page.getByRole('option', { name: 'Page 2' }).click();
  await expect(pages).toContainText('Financial summary');
  await expect(pages).toContainText('LTM revenue');

  const form = page.getByTestId('document-classify');
  await form.getByRole('combobox', { name: 'Document type' }).click();
  await page.getByRole('option', { name: 'Quarterly financials' }).click();
  await form.getByRole('combobox', { name: 'Investment' }).click();
  await page
    .getByRole('option', {
      name: `${scan?.truth.investmentNumber ?? ''} ${scan?.truth.companyName ?? ''}`,
    })
    .click();
  await form.getByLabel('Period end').fill(scan?.truth.periodEnd ?? '');
  await form.getByLabel('Reason').fill('The financial summary names the company and the quarter');
  await form.getByRole('button', { name: 'Classify' }).click();
  await expect(page.getByTestId('document-action-status')).toContainText(
    'Classified as Quarterly financials',
  );
  await expect(page.getByTestId('document-banner')).toContainText('Classified');
  await expect(
    page.getByTestId('document-banner').getByRole('link', { name: scan?.truth.companyName ?? '' }),
  ).toHaveAttribute('href', `/portfolio/${scan?.truth.investmentId ?? ''}`);
  await expect(page.getByTestId('document-classify')).toHaveCount(0);

  await page.goto('/documents/review');
  await expect(page.getByTestId('review-queue-empty')).toContainText('Nothing waits for review');
});

test('a deal team member outside the wall finds no document of the walled company; the wall member finds its reports', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await indexAs(page, 'ops.one');
  await signInAs(page, 'deal.one', d);
  await page.goto('/documents');
  await expect(hubTable(page)).toBeVisible();
  await search(page).fill(walled.companyName);
  await search(page).press('Enter');
  await expect(page.getByTestId('documents-empty')).toContainText('No documents match');
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByTestId('documents-card')).not.toContainText(walled.companyName);

  await switchTo(page, 'deal.three', d);
  await page.goto('/documents');
  await expect(hubTable(page)).toBeVisible();
  await search(page).fill(walled.companyName);
  await search(page).press('Enter');
  await expect(hubTable(page).getByRole('row')).toHaveCount(walledFiles.length + 1);
  for (const fileName of walledFiles) await expect(hubTable(page)).toContainText(fileName);
  await expect(
    hubTable(page).getByRole('link', { name: walled.companyName, exact: true }).first(),
  ).toHaveAttribute('href', `/portfolio/${walled.id}`);
});

test('operations generates the expected documents of the latest quarter; the absent report reads late, then missing', async ({
  page,
}) => {
  test.setTimeout(120_000);
  expect(late, 'the set names the position whose latest report is absent').not.toBeNull();
  await indexAs(page, 'ops.one');
  await signInAs(page, 'ops.one', d);
  await page.goto('/documents/expected');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Expected documents');
  const card = page.getByTestId('expected-generate');
  // The latest quarter of the record is picked by default.
  await expect(card.getByLabel('Quarter end')).toHaveValue(latestQuarter);
  await card.getByRole('button', { name: 'Generate expected documents' }).click();
  const status = page.getByTestId('expected-action-status');
  await expect(status).toContainText(/Expected documents generated: \d+ created, \d+ existing/);
  // The suite shares one API: a spec that generated the quarter before leaves nothing to create.
  const counts = /generated: (\d+) created, (\d+) existing/.exec(
    (await status.textContent()) ?? '',
  );
  const wanted = Number(counts?.[1]) + Number(counts?.[2]);
  expect(wanted).toBeGreaterThan(0);
  // Idempotent: a second generation creates nothing and counts every row as existing.
  await card.getByRole('button', { name: 'Generate expected documents' }).click();
  await expect(status).toContainText(`Expected documents generated: 0 created, ${wanted} existing`);

  // Judged on the record's own day nothing is due yet; the reports indexed earlier are received.
  const table = page.getByTestId('expected-table');
  await expect(table).toBeVisible();
  const lateRow = table.getByRole('row').filter({ hasText: late?.investmentNumber ?? '' });
  await expect(lateRow).toContainText(late?.companyName ?? '');
  await expect(lateRow).toContainText('Expected');
  await expect(table.getByText('Received').first()).toBeVisible();
  await expect(table.getByRole('link', { name: 'Open document' }).first()).toHaveAttribute(
    'href',
    /\/documents\/[0-9a-f-]{36}$/,
  );

  // Past the grace the absent report is late, and past the missing threshold it is missing.
  await page.getByLabel('Judged as of').fill(addDays(dueDate, lateAfterDays + 1));
  await expect(lateRow).toContainText('Late');
  await expect(lateRow).toContainText(String(lateAfterDays + 1));
  await page.getByLabel('Judged as of').fill(addDays(dueDate, missingAfterDays + 1));
  await expect(lateRow).toContainText('Missing');
  await expect(lateRow).toContainText(String(missingAfterDays + 1));
  // A filter on the status keeps the missing rows alone (the absent report, and any position
  // whose report carries a period end that is not the quarter end).
  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Missing' }).click();
  await expect(lateRow).toContainText('Missing');
  await expect(table.getByText('Received')).toHaveCount(0);
  await expect(table.getByText('Late')).toHaveCount(0);
  await expect(table.getByText('Expected')).toHaveCount(0);
  const rows = await table.getByRole('row').count();
  await expect(table.getByText('Missing')).toHaveCount(rows - 1);
});

test('a viewer reads the document hub and the tracker without the write buttons', async ({
  page,
}) => {
  await signInAs(page, 'viewer.one', d);
  await page.goto('/documents');
  await expect(page.getByTestId('documents-read-only')).toHaveText(
    'Operations indexes documents; your role reads the hub.',
  );
  await expect(page.getByRole('button', { name: 'Index documents' })).toHaveCount(0);
  await page.goto('/documents/expected');
  await expect(page.getByTestId('expected-read-only')).toHaveText(
    'Operations generates expected documents; your role reads the tracker.',
  );
  await expect(page.getByTestId('expected-generate')).toHaveCount(0);
});
