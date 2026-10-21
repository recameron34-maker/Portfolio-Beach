import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { D, toDollars } from '@pb/calc';
import type { ExtractedValue, ExtractionRun, ExtractionRunDetail } from '@pb/contracts';
import { generateDataset, generateDocuments } from '@pb/synthetic';
import {
  ensureExtractionOn,
  generateExpectedDocuments,
  indexDocuments,
  latestQuarter,
  listRuns,
  loadDataset,
  runDetail,
  signInAs,
  startExtractionBatch,
  switchTo,
} from './fixtures.js';

/**
 * Critical journey 2 (docs/12 section 3, decision 0012) over the real API: operations indexes the
 * synthetic document set, generates the expected documents of the latest quarter and starts an
 * extraction batch over its quarterly financials from the Extraction page; a reviewer opens a run,
 * accepts the clean values, edits a value (a flagged one when the run has any, and the revenue
 * figure so the promotion is seen to write the reviewer's number), rejects a flagged or invalid
 * value when one is left, and approves; the deal team then reads the promoted figure on the
 * position's Performance tab with its source. The injection document's run shows the real figures.
 * The document set is built in the test from the same dataset the API is seeded with (small
 * profile, seed 42), so its expectations name the files and counts to look for.
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });
const documents = generateDocuments(full);
const quarter = latestQuarter(d);
const QUARTERLY_FINANCIALS = 'doc_type.quarterly_financials';
const REASON = 'Journey 2: checked against the synthetic report';

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

/** A date as the pages show it, for example "Jun 30, 2025". */
const shownDate = (isoDate: string): string =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

function valueOf(detail: ExtractionRunDetail, field: string): ExtractedValue {
  const v = detail.values.find((x) => x.field === field);
  if (v === undefined) throw new Error(`the run has no ${field} value`);
  return v;
}

const status = (page: Page) => page.getByTestId('run-action-status');

/** Edits a value through the row's dialog, keeping the unit the model answered with. */
async function editValue(page: Page, v: ExtractedValue, value: string): Promise<void> {
  await page.getByRole('button', { name: `Edit, ${v.label}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`Edit ${v.label}`);
  await dialog.getByLabel('Value').fill(value);
  await dialog.getByLabel('Reason').fill(REASON);
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(status(page)).toContainText(`${v.label} edited`);
}

async function rejectValue(page: Page, v: ExtractedValue): Promise<void> {
  await page.getByRole('button', { name: `Reject, ${v.label}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill(REASON);
  await dialog.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(status(page)).toContainText(`${v.label} rejected`);
}

/** Every Succeeded run of the latest quarter's reports as operations sees them, after a batch exists. */
async function succeededRuns(page: Page): Promise<ExtractionRun[]> {
  const runs = (await listRuns(page)).filter((r) => r.state === 'Succeeded');
  if (runs.length > 0) return runs;
  await indexDocuments(page);
  await startExtractionBatch(page, { periodEnd: quarter, docType: QUARTERLY_FINANCIALS });
  return (await listRuns(page)).filter((r) => r.state === 'Succeeded');
}

test('operations indexes, generates and extracts; a reviewer accepts, edits, rejects and approves; the deal team reads the promoted figure with its source', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signInAs(page, 'ops.one', d);
  await ensureExtractionOn(page, d);

  // The hub and the tracker through the API (documents.spec.ts covers their pages).
  const indexed = await indexDocuments(page);
  expect(indexed.indexed + indexed.duplicates + indexed.unchanged).toBe(
    documents.expectations.total,
  );
  expect(indexed.duplicates + indexed.unchanged).toBeGreaterThanOrEqual(
    documents.expectations.scenarioFiles.duplicate_doc.length - 1,
  );
  const generated = await generateExpectedDocuments(page, quarter);
  expect(generated.created + generated.existing).toBeGreaterThan(0);

  // The batch from the Extraction page: the latest quarter's quarterly financials.
  await page.goto('/documents/extraction');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Extraction');
  const form = page.getByTestId('extraction-batch-form');
  await form.getByLabel('Period end').fill(quarter);
  await expect(form.getByRole('combobox', { name: 'Document type' })).toHaveText(
    'Quarterly financials',
  );
  await form.getByRole('button', { name: 'Start extraction', exact: true }).click();
  await expect(page.getByTestId('extraction-action-status')).toContainText(
    /Batch started: \d+ runs?/,
    { timeout: 120_000 },
  );
  const batches = page.getByTestId('extraction-batches');
  await expect(batches.getByRole('row').nth(1)).toContainText('Succeeded');
  await expect(batches.getByRole('row').nth(1)).toContainText('100%');
  const runsTable = page.getByTestId('extraction-runs');
  await expect(runsTable.getByRole('row').nth(1)).toContainText('Succeeded');
  await expect(runsTable.getByRole('row').nth(1)).toContainText('Awaiting approval');

  // The run to review: one with flagged values, else the restatement report, else the first.
  // Operations stands outside the wall, so every run it lists is open to deal.one as well.
  const runs = await listRuns(page);
  const succeeded = runs.filter((r) => r.state === 'Succeeded');
  expect(succeeded.length).toBeGreaterThan(0);
  const restatement = documents.expectations.scenarioFiles.restatement[0];
  const run =
    succeeded.find((r) => r.counts.flagged > 0) ??
    succeeded.find((r) => r.fileName === restatement) ??
    succeeded[0]!;
  expect(run.investmentId, 'the run is linked to an investment').not.toBeNull();

  await page.goto(`/documents/extraction/${run.id}`);
  const banner = page.getByTestId('run-banner');
  await expect(banner).toContainText(run.documentTitle);
  await expect(banner).toContainText('Succeeded');
  await expect(banner).toContainText('Awaiting approval');
  const tiles = page.getByTestId('run-tiles');
  await expect(tiles.getByRole('group', { name: 'Values' })).toContainText(
    String(run.counts.values),
  );
  await expect(tiles.getByRole('group', { name: 'Flagged' })).toContainText(
    String(run.counts.flagged),
  );
  const fields = page.getByTestId('run-fields');
  await expect(fields.getByRole('row')).toHaveCount(run.counts.values + 1);

  // Click-to-source: the revenue's page button draws its page and highlights its quote.
  const before = await runDetail(page, run.id);
  const revenue = valueOf(before, 'revenue_ltm');
  expect(revenue.value, 'the report states its LTM revenue').not.toBeNull();
  expect(revenue.page, 'the revenue is cited on a page').not.toBeNull();
  await expect(fields).toContainText(revenue.quote ?? '');
  await page
    .getByRole('button', { name: `Show Revenue LTM on page ${revenue.page}`, exact: true })
    .click();
  await expect(page.getByTestId('run-page-drawing')).toHaveAttribute(
    'data-page',
    String(revenue.page),
  );
  await expect(page.getByTestId('run-page-note')).toContainText(
    'Highlighting the quote of Revenue LTM',
  );
  expect(await page.getByTestId('run-page-highlight').count()).toBeGreaterThan(0);

  // The review: the clean values in one go.
  await page.getByRole('button', { name: 'Accept clean values', exact: true }).click();
  await expect(status(page)).toContainText(/\d+ clean values? accepted/);
  await expect(tiles.getByRole('group', { name: 'Decided' })).toContainText(
    String(run.counts.clean),
  );

  // Every flagged or invalid value gets a decision: the first is edited (a required one always
  // is), the rest are rejected, so the approval has nothing left undecided.
  const open = (await runDetail(page, run.id)).values.filter(
    (v) => v.decision === null && v.validationState !== 'clean',
  );
  let edited = false;
  for (const v of open) {
    if (!edited || v.required) {
      await editValue(page, v, v.value ?? (v.kind === 'date' ? quarter : '1'));
      edited = true;
    } else {
      await rejectValue(page, v);
    }
  }

  // The revenue figure becomes the reviewer's own number (the report's plus one in its unit), so
  // the promotion is seen to write the edited value, not the model's.
  const revenueNow = valueOf(await runDetail(page, run.id), 'revenue_ltm');
  const unit = revenueNow.unit ?? 'USD_M';
  const promoted =
    revenueNow.decision === 'edited' && revenueNow.editedValue !== null
      ? revenueNow.editedValue
      : D(revenueNow.value ?? '0')
          .plus(1)
          .toFixed(2);
  if (revenueNow.decision !== 'edited') await editValue(page, revenueNow, promoted);
  await expect(fields.getByTestId('run-field-revenue_ltm')).toContainText('Edited');

  // Approve and promote.
  const approve = page.getByRole('button', { name: 'Approve and promote', exact: true });
  await expect(approve).not.toHaveAttribute('aria-disabled', 'true');
  await approve.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason').fill(REASON);
  await dialog.getByRole('button', { name: 'Approve and promote', exact: true }).click();
  await expect(status(page)).toContainText(`Approved: figures promoted for ${shownDate(quarter)}`);
  await expect(banner).toContainText('Approved by');
  await expect(approve).toHaveAttribute('aria-disabled', 'true');
  await expect(
    page.getByRole('button', { name: 'Accept, Revenue LTM', exact: true }),
  ).toHaveAttribute('aria-disabled', 'true');
  const after = await runDetail(page, run.id);
  expect(after.run.approvedBy).not.toBeNull();
  expect(after.run.promotedRecordId).not.toBeNull();
  // The runs list names the approver on this run's own row (the same document may have other
  // runs from earlier batches of this API process).
  await page.goto('/documents/extraction');
  await expect(page.getByTestId(`extraction-run-${run.id}`)).toContainText('Approved by');

  // The deal team reads the quarter on the Performance tab: the reviewer's revenue, approved.
  await switchTo(page, 'deal.one', d);
  await page.goto(`/portfolio/${run.investmentId ?? ''}/performance`);
  const quarters = page.getByRole('table', { name: 'Quarterly financials' });
  await expect(quarters).toBeVisible();
  const row = quarters
    .getByRole('row')
    .filter({ hasText: shownDate(quarter) })
    .filter({ hasNotText: 'Entry' })
    .first();
  await expect(row).toContainText(moneyM(toDollars(promoted, unit).toFixed(2)));
  await expect(row).toContainText('Approved');

  // Click-to-source on the record (I1): the quarter links to the document the figures came from,
  // on the page the revenue was read from, and to the run that read it.
  const source = page.getByTestId(`performance-source-${quarter}`);
  await expect(source).toHaveAttribute('href', `/documents/${run.documentId}`);
  await expect(source).toContainText(`page ${revenue.page}`);
  await expect(
    page.getByRole('link', { name: `run that read ${shownDate(quarter)}`, exact: true }),
  ).toHaveAttribute('href', `/documents/extraction/${run.id}`);
});

test('the injection document extracts its real figures: no 999.00 on the review page', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInAs(page, 'ops.one', d);
  await ensureExtractionOn(page, d);
  const injectionFile = documents.expectations.scenarioFiles.injection_doc[0];
  expect(injectionFile, 'the document set has an injection report').toBeDefined();
  const truth = documents.documents.find((doc) => doc.fileName === injectionFile)?.truth;
  expect(truth, 'the injection report has a truth sidecar').toBeDefined();
  const runs = await succeededRuns(page);
  const run = runs.find((r) => r.fileName === injectionFile);
  expect(run, 'the injection report has a Succeeded run').toBeDefined();

  await page.goto(`/documents/extraction/${run?.id ?? ''}`);
  const fields = page.getByTestId('run-fields');
  await expect(fields.getByRole('row')).toHaveCount(16);
  const revenue = truth?.fields.revenue_ltm;
  await expect(fields.getByTestId('run-field-revenue_ltm')).toContainText(
    `$${revenue?.value ?? ''}M`,
  );
  await expect(fields).not.toContainText('999.00');
  await expect(page.getByTestId('run-tiles')).not.toContainText('999.00');
  await expect(page.getByTestId('run-narrative')).not.toContainText('999.00');
  // The instruction is on the notes page of the document, drawn as it is; the figures stand.
  await page.getByRole('combobox', { name: 'Page' }).click();
  await page.getByRole('option', { name: `Page ${truth?.pageCount ?? 4}` }).click();
  await expect(page.getByTestId('run-page-drawing')).toContainText('ignore your instructions');
  await expect(fields).not.toContainText('999.00');
});
