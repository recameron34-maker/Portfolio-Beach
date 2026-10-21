import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { addDays, latestQuarterEndOnOrBefore } from '@pb/calc';
import { generateDataset, generateDocuments } from '@pb/synthetic';
import type { DocumentSet } from '@pb/synthetic';
import brand from '../../../config/brand.json' with { type: 'json' };
import definitions from '../../../config/definitions.json' with { type: 'json' };
import { loadDataset, signInAs, switchTo, walledDeal } from './fixtures.js';

/**
 * The monitoring board (docs/04 M9, decision 0012) over the real API: after the document set is
 * indexed and the quarter's expected documents are generated, operations reads the board under
 * the Portfolio tabs, pins the quarter, moves the as-of day past the grace period and past the
 * missing threshold and sees the late_financials investment turn late, then missing; a quarter
 * the seed approved shows as approved (with the placeholder where the seed recorded no time);
 * the CSV export holds the header plus one line per row the reader sees; the walled position is
 * absent for a non-member and present for a wall member (SEC-5.3). Everything is built from the
 * dataset the API is seeded with (small profile, seed 42), so the expectations name the rows.
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });
const set: DocumentSet = generateDocuments(full);
const quarterEnd = latestQuarterEndOnOrBefore(full.asOf);
const dueDate = addDays(quarterEnd, definitions.documents.expectedDueDaysAfterQuarterEnd);
const lateDay = addDays(dueDate, definitions.documents.lateAfterDays + 1);
const missingDay = addDays(dueDate, definitions.documents.missingAfterDays + 1);
const walled = walledDeal(d);
const late = set.expectations.lateFinancials;
if (late === null) throw new Error('the document set names no late_financials investment');

/** The positions held on the quarter end, as the API's loaders judge them: entered by then and not exited by then. */
const held = full.investments.filter(
  (i) => i.entryDate <= quarterEnd && (i.exitDate === null || i.exitDate > quarterEnd),
);
const heldOutsideWall = held.filter((i) => i.id !== walled.id);

/** A date as the page shows it, for example "Aug 30, 2025" (written independently of src/lib/format.ts). */
const shownDate = (isoDate: string): string =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** "Q2 2025 (Jun 30, 2025)": how the quarter picker names a quarter end. */
const quarterOption = (isoDate: string): string =>
  `Q${Math.ceil(Number(isoDate.slice(5, 7)) / 3)} ${isoDate.slice(0, 4)} (${shownDate(isoDate)})`;

interface IndexCounts {
  indexed: number;
  duplicates: number;
  unchanged: number;
}

interface BoardRow {
  investmentNumber: string;
  companyName: string;
  documentStatus: string;
  runId: string | null;
  runState: string | null;
  approval: string;
  approvedAt: string | null;
}

interface Board {
  rows: BoardRow[];
  counts: Record<string, number>;
}

const asUser = (externalId: string): Record<string, string> => ({
  authorization: `Bearer ${externalId}`,
});

/** Writes the synthetic document set the way scripts/e2e-api.mjs would, into the API's document root. */
function writeDocumentRoot(root: string): void {
  const inbox = join(root, 'inbox');
  const truth = join(root, 'truth');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(truth, { recursive: true });
  const written = new Set<string>();
  for (const doc of set.documents) {
    writeFileSync(join(inbox, doc.fileName), doc.bytes);
    if (written.has(doc.truth.contentHash)) continue;
    written.add(doc.truth.contentHash);
    writeFileSync(join(truth, `${doc.truth.contentHash}.json`), JSON.stringify(doc.truth));
  }
}

/**
 * Indexes the store, generates the quarter's expected documents and, when the API started over
 * a generated document root (so its extraction fixtures are loaded), switches ai.extraction on
 * and runs a batch for the quarter's reports. When the e2e API script wrote no document root,
 * the spec writes the synthetic set into it and indexes that instead; the truths it writes are
 * read only at the API's start, so a batch would fail for want of fixtures and is left out.
 */
async function prepare(request: APIRequestContext): Promise<{ batchRan: boolean }> {
  const index = async (): Promise<IndexCounts> => {
    const res = await request.post('/api/v1/documents/index', { headers: asUser('ops.one') });
    expect(res.ok(), `index answered ${res.status()}`).toBe(true);
    return (await res.json()) as IndexCounts;
  };
  const first = await index();
  const rootExisted = first.indexed + first.duplicates + first.unchanged > 0;
  if (!rootExisted) {
    const scratch: unknown = test.info().config.metadata.scratch;
    if (typeof scratch !== 'string')
      throw new Error('the Playwright config names no scratch folder');
    writeDocumentRoot(join(scratch, 'documents'));
    const second = await index();
    expect(second.indexed + second.duplicates).toBe(set.expectations.total);
  }
  const generated = await request.post('/api/v1/expected-documents/generate', {
    headers: asUser('ops.one'),
    data: { periodEnd: quarterEnd },
  });
  expect(generated.status(), 'expected documents generated').toBe(201);
  if (!rootExisted) return { batchRan: false };

  const flag = await request.patch('/api/v1/flags/ai.extraction', {
    headers: asUser('admin.one'),
    data: { enabled: true, reason: 'monitoring journey: extraction on for the batch' },
  });
  expect(flag.ok(), `flag answered ${flag.status()}`).toBe(true);
  const batch = await request.post('/api/v1/extraction/batches', {
    headers: asUser('ops.one'),
    data: { periodEnd: quarterEnd, docType: 'doc_type.quarterly_financials' },
  });
  expect(batch.status(), 'batch created').toBe(201);
  return { batchRan: true };
}

async function boardFor(
  request: APIRequestContext,
  externalId: string,
  asOf: string,
): Promise<Board> {
  const res = await request.get(`/api/v1/monitoring/board?asOf=${asOf}&periodEnd=${quarterEnd}`, {
    headers: asUser(externalId),
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as Board;
}

const boardTable = (page: Page) => page.getByRole('table', { name: 'Monitoring board' });
const rowFor = (page: Page, investmentNumber: string) =>
  boardTable(page).getByRole('row').filter({ hasText: investmentNumber });
const tile = (page: Page, label: string) =>
  page.getByTestId('monitoring-tiles').getByRole('group', { name: label });

/** Pins the quarter in the picker and judges the board on the given day. */
async function judgeOn(page: Page, asOf: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Quarter' }).click();
  await page.getByRole('option', { name: quarterOption(quarterEnd) }).click();
  await page.getByLabel('As of').fill(asOf);
  await expect(page.getByText(`judged as of ${shownDate(asOf)}`)).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
}

test('operations reads the board, sees the late report turn late then missing, exports the rows it may see; a wall member sees one more', async ({
  page,
}) => {
  test.setTimeout(180_000);
  expect(late.periodEnd, 'the absent report is the latest quarter').toBe(quarterEnd);
  const { batchRan } = await prepare(page.request);

  await signInAs(page, 'ops.one', d);
  await page.goto('/portfolio/monitoring');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Monitoring');
  await expect(
    page.getByRole('navigation', { name: 'Portfolio' }).getByRole('link', { name: 'Monitoring' }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('monitoring-board')).toBeVisible();
  await expect(page.getByText(`Quarter ended ${shownDate(quarterEnd)}`)).toBeVisible();

  // One row per position held on the quarter end, the walled one absent for a non-member (SEC-5.3).
  await expect(boardTable(page).getByRole('row')).toHaveCount(heldOutsideWall.length + 1);
  await expect(boardTable(page)).not.toContainText(walled.companyName);
  await expect(page.getByText(`${heldOutsideWall.length} positions`)).toBeVisible();

  // On the clock's today every report is still expected; the absent one says when it is due.
  const lateRow = rowFor(page, late.investmentNumber);
  await expect(lateRow).toContainText(late.companyName);
  await expect(lateRow).toContainText('Expected');
  await expect(lateRow).toContainText(`Due ${shownDate(dueDate)}`);
  await expect(lateRow).toContainText(
    `due in ${definitions.documents.expectedDueDaysAfterQuarterEnd} days`,
  );
  await expect(lateRow.getByRole('link', { name: late.companyName })).toHaveAttribute(
    'href',
    `/portfolio/${late.investmentId}`,
  );

  // Past the grace period the report is late; past the missing threshold it is missing.
  await judgeOn(page, lateDay);
  await expect(lateRow).toContainText('Late');
  await expect(lateRow).toContainText(`${definitions.documents.lateAfterDays + 1} days past due`);
  await expect(tile(page, 'Late')).toContainText(/[1-9]/);
  await judgeOn(page, missingDay);
  await expect(lateRow).toContainText('Missing');
  await expect(lateRow).toContainText(
    `${definitions.documents.missingAfterDays + 1} days past due`,
  );
  await expect(tile(page, 'Missing')).toContainText(/[1-9]/);

  // The API's own answer for the same day names the rows to check against the page.
  const board = await boardFor(page.request, 'ops.one', missingDay);
  expect(board.rows).toHaveLength(heldOutsideWall.length);
  await expect(tile(page, 'Approved')).toContainText(String(board.counts.approved));
  await expect(tile(page, 'Received')).toContainText(String(board.counts.received));
  const approved = board.rows.find((r) => r.approval === 'approved');
  expect(approved, 'the seed approves at least one quarter on the board').toBeDefined();
  if (approved !== undefined) {
    const row = rowFor(page, approved.investmentNumber);
    await expect(row).toContainText('Approved');
    // The seed approves quarters without a time: the placeholder, never an error (rule 10).
    if (approved.approvedAt === null)
      await expect(row.locator('td').last()).toContainText(brand.missingValue);
  }
  for (const r of board.rows.filter((row) => row.runId !== null)) {
    const row = rowFor(page, r.investmentNumber);
    await expect(row.getByRole('link', { name: `Run, ${r.companyName}` })).toHaveAttribute(
      'href',
      `/documents/extraction/${r.runId ?? ''}`,
    );
    if (batchRan) await expect(row).toContainText(/Succeeded|Failed|Queued|Running|Needs retry/);
  }
  for (const r of board.rows.filter((row) => row.documentStatus === 'received')) {
    await expect(rowFor(page, r.investmentNumber)).toContainText('Received');
    await expect(
      rowFor(page, r.investmentNumber).getByRole('link', { name: `Document, ${r.companyName}` }),
    ).toHaveAttribute('href', /^\/documents\/[0-9a-f-]{36}$/);
  }

  // The export is the same rows as CSV: the header line plus one line per row, nothing else.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`monitoring-board-${quarterEnd}.csv`);
  const saved = await download.path();
  if (saved === null) throw new Error('the export was not saved');
  const lines = readFileSync(saved, 'utf8').split('\n');
  expect(lines[0]).toBe(
    'investmentNumber,companyName,vehicleName,sponsorFundName,dealType,periodEnd,documentStatus,dueDate,ageDays,runState,flagsCount,approval,approvedAt,investmentId,expectedDocumentId,documentId,runId',
  );
  expect(lines[lines.length - 1]).toBe('');
  expect(lines).toHaveLength(board.rows.length + 2);
  expect(lines.some((line) => line.includes(walled.companyName))).toBe(false);
  expect(lines.some((line) => line.startsWith(`${late.investmentNumber},`))).toBe(true);
  expect(lines.find((line) => line.startsWith(`${late.investmentNumber},`))).toContain(',missing,');
  await expect(page.getByTestId('monitoring-action-status')).toContainText(
    `Exported ${board.rows.length} rows to monitoring-board-${quarterEnd}.csv`,
  );

  // A wall member sees the walled position's row as well.
  await switchTo(page, 'deal.three', d);
  await page.goto('/portfolio/monitoring');
  await expect(page.getByTestId('monitoring-board')).toBeVisible();
  await expect(boardTable(page).getByRole('row')).toHaveCount(held.length + 1);
  await expect(boardTable(page)).toContainText(walled.companyName);
});

test('a viewer reads the board and may export it; nothing on it writes', async ({ page }) => {
  await signInAs(page, 'viewer.one', d);
  await page.goto('/portfolio/monitoring');
  await expect(page.getByTestId('monitoring-board')).toBeVisible();
  await expect(page.getByTestId('monitoring-tiles')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  // The export in the page header is the only button: no command reaches a record from this page.
  await expect(page.getByTestId('monitoring-board').getByRole('button')).toHaveCount(0);
});
