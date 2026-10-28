import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { D } from '@pb/calc';
import { investmentPage } from '@pb/contracts';
import type { InvestmentSummary } from '@pb/contracts';
import { generateDataset, lookthroughExtract } from '@pb/synthetic';
import definitions from '../../../config/definitions.json' with { type: 'json' };
import { apiCall, loadDataset, signInAs, switchTo, walledDeal } from './fixtures.js';

/**
 * Look-through reconcile and the exceptions queue (docs/04 M2 lookthrough-reconcile, M1 Data
 * Health, decision 0010) over the real API: operations reconciles the synthetic "defects"
 * extract, reads the differences it opened, works three exceptions (acknowledge, resolve with a
 * reason, note a ticket), and the walled position's rows are counted, never shown, until a wall
 * member opens the run (SEC-5.3). The extract is built from the same dataset the API is seeded
 * with (small profile, seed 42) and written into the e2e API's look-through folder before the run,
 * so its expectations name the rows to look for. The exposures the run compares them with are
 * read from the API at run time: the specs share one API process, and a journey that runs earlier
 * may have moved a position's record away from the seed the extract was built from.
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });
const defects = lookthroughExtract(full, { scenario: 'defects' });
type ExtractRow = (typeof defects.rows)[number];

/**
 * The label differences the generator built into the extract: a mapped code that disagrees with
 * the company on record. Nothing in the suite changes a company's codes, so these stand as named;
 * the generator's asOf difference is the stale finding, not a difference.
 */
const LABEL_FIELDS = new Set(['sector', 'geography']);
const labelDifferences = defects.expectations.differences.filter((x) =>
  LABEL_FIELDS.has(x.field),
).length;

type ExposureField = 'exposureAtCost' | 'exposureAtNav';
interface ExposureDifference {
  rowNo: number;
  field: ExposureField;
}
const isExposureField = (field: string): field is ExposureField =>
  field === 'exposureAtCost' || field === 'exposureAtNav';
/** The exposure differences the generator built in: a NAV moved beyond the tolerance, a cost off by more than the dollar tolerance. */
const builtInExposureDifferences: ExposureDifference[] = defects.expectations.differences.flatMap(
  ({ rowNo, field }) => (isExposureField(field) ? [{ rowNo, field }] : []),
);

/** The two tolerances the reconcile reads from config (rules LT-TIE-01 and LT-TIE-02), never literals here. */
const navTolerance = D(String(definitions.intake.lookthroughNavTolerancePct));
const costTolerance = D(String(definitions.intake.lookthroughCostToleranceUsd));

const walled = walledDeal(d);
const walledNumber = d.investments.find((i) => i.id === walled.id)?.investmentNumber ?? '';

/**
 * The position an extract row links to, among the positions the API serves: by its number, else
 * by the alias the generator put in place of the company name (the row links by the alias). A row
 * the record has no position for (the unknown number, the near miss on a name) links to nothing.
 */
function positionOf(
  row: ExtractRow,
  positions: readonly InvestmentSummary[],
): InvestmentSummary | undefined {
  if (row.investmentNumber !== null)
    return positions.find((p) => p.investmentNumber === row.investmentNumber);
  const companyIds = new Set(
    full.companyAliases.filter((a) => a.alias === row.companyName).map((a) => a.portfolioCompanyId),
  );
  const linked = full.investments.filter((i) => companyIds.has(i.portfolioCompanyId));
  const [one] = linked;
  return linked.length === 1 && one !== undefined
    ? positions.find((p) => p.id === one.id)
    : undefined;
}

/**
 * The exposure differences the run must report, read against the record the API serves on the
 * run's date rather than against the seed: the extract carries the seed's figures, and a journey
 * that runs earlier may have moved a position's record (journey 4 settles the wire_change capital
 * call as an approved contribution dated the as-of date, which raises that position's invested
 * cost). The rule is the reconcile's own (LT-TIE-01, LT-TIE-02): a row linked to a position
 * whose provider figure sits beyond the tolerance from the record's invested cost or latest
 * Locked mark is a difference, the two the generator built in among them. The record is read as
 * the wall member, who sees every position, so the walled rows count the way the run counts
 * them: on the tiles, never in the rows the reconciler is shown (SEC-5.3).
 */
async function exposureDifferences(page: Page): Promise<ExposureDifference[]> {
  const positions = await apiCall(
    page,
    'GET',
    `/api/v1/investments?asOf=${defects.asOf}&limit=200`,
    'deal.three',
    investmentPage,
  );
  expect(positions.nextCursor, 'the small profile fits in one page').toBeNull();
  const out: ExposureDifference[] = [];
  for (const [index, row] of defects.rows.entries()) {
    const position = positionOf(row, positions.items);
    if (position === undefined) continue;
    if (
      position.invested !== null &&
      D(row.exposureAtCost).minus(position.invested).abs().gt(costTolerance)
    )
      out.push({ rowNo: index + 1, field: 'exposureAtCost' });
    if (
      position.nav !== null &&
      D(row.exposureAtNav).minus(position.nav).abs().gt(D(position.nav).abs().times(navTolerance))
    )
      out.push({ rowNo: index + 1, field: 'exposureAtNav' });
  }
  return out;
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
  // What the run must report, against the record as it stands: the generator's own exposure
  // differences are among them, whatever an earlier journey moved besides.
  const exposure = await exposureDifferences(page);
  expect(exposure).toEqual(expect.arrayContaining(builtInExposureDifferences));
  const differences = labelDifferences + exposure.length;
  const exceptionsOpened =
    differences + defects.expectations.unmatched.length + defects.expectations.unmapped.length;
  /** One NAV badge per NAV difference on a row the reconciler is shown (a walled row is counted, never shown). */
  const navBadges = exposure.filter(
    (x) => x.field === 'exposureAtNav' && !defects.expectations.walled.includes(x.rowNo),
  ).length;
  expect(navBadges, 'the generator moved one NAV beyond the tolerance').toBeGreaterThan(0);

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
  await expect(rows.locator('.pb-badge', { hasText: 'NAV' })).toHaveCount(navBadges);

  // The run links to its exceptions on the queue.
  await page.getByTestId('lookthrough-exceptions-link').click();
  await expect(page).toHaveURL(/\/data\/exceptions\?file=/);
  await expect(page.getByTestId('exceptions-file-note')).toContainText(
    `lookthrough-${defects.asOf}.json`,
  );
  const queue = page.getByRole('table', { name: 'Data exceptions' });
  await expect(queue.getByRole('row')).toHaveCount(exceptionsOpened + 1);
  await expect(queue.getByRole('row').filter({ hasText: 'Open' })).toHaveCount(exceptionsOpened);

  // Acknowledge a NAV difference, then resolve it with a reason.
  await queue.getByRole('link', { name: 'LT-TIE-01' }).first().click();
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
  await switchTo(page, 'deal.three', d);
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
  await switchTo(page, 'ops.one', d);
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
