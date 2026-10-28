import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { latestQuarterEndOnOrBefore } from '@pb/calc';
import { generateDataset, lookthroughExtract, weeklyValues } from '@pb/synthetic';
import { ANALYTICS_TABS, DEAL_TABS } from '../src/app/nav.js';
import {
  ensureExtractionOn,
  indexDocuments,
  latestQuarter,
  listRuns,
  loadDataset,
  signInAs,
  startExtractionBatch,
  walledDeal,
} from './fixtures.js';

/** WCAG 2.1 AA with zero critical or serious issues on every page (docs/12 section 1, docs/17 section 9). */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });

/**
 * What the intake pages need before they can be scanned, built from the same dataset the API is
 * seeded with: the weekly values with defects (findings on the file page, and the exceptions its
 * unlinked names open) and a clean look-through extract for the record's as-of date (a run that
 * agrees). Neither is the file the intake journeys stage, so their first import stays no duplicate.
 */
const weeklyDefects = weeklyValues(full, { scenario: 'defects' });
const cleanExtract = lookthroughExtract(full, { scenario: 'clean' });

test.beforeAll(() => {
  // The e2e API reads the look-through folder under its scratch (scripts/e2e-api.mjs sets
  // PB_DROP_ROOT there); the folder provider reads <asOf>.json at request time.
  const scratch: unknown = test.info().config.metadata.scratch;
  if (typeof scratch !== 'string') throw new Error('the Playwright config names no scratch folder');
  const folder = join(scratch, 'drops', 'lookthrough');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${cleanExtract.asOf}.json`), cleanExtract.json);
});

/** The rule ids and node counts axe reports as serious or critical on the page as it stands. */
async function seriousViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id}: ${v.help} (${v.nodes.length})`);
}

async function expectNoSeriousViolations(page: Page): Promise<void> {
  expect(await seriousViolations(page)).toEqual([]);
}

test('sign-in page @a11y', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByTestId('mock-user-list').waitFor();
  await expectNoSeriousViolations(page);
});

test('home, portfolio and one-pager @a11y', async ({ page }) => {
  await signInAs(page, 'deal.three', d);
  await page.getByTestId('home-tiles').waitFor();
  await expectNoSeriousViolations(page);
  await page.goto('/portfolio');
  await page.getByTestId('portfolio-count').waitFor();
  await expectNoSeriousViolations(page);
  await page.goto(`/portfolio/${walledDeal(d).id}`);
  await page.getByTestId('detail-banner').waitFor();
  await expectNoSeriousViolations(page);
});

test('sign-in scene is static under reduced motion @a11y', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/sign-in');
  await page.getByTestId('mock-user-list').waitFor();
  const names = await page
    .locator('.pb-scene-glow, .pb-scene-wave, .pb-scene-tide, .pb-scene-foam')
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName));
  expect(names.length).toBeGreaterThan(0);
  expect(names.every((n) => n === 'none')).toBe(true);
});

// ---- Every page added this round, at a laptop and a phone width --------------------------------

/** A page to scan and what shows once its own data has arrived. */
interface Visit {
  path: string;
  ready: (page: Page) => Locator;
}

const heading = (page: Page): Locator => page.getByRole('heading', { level: 1 });
const banner = (page: Page): Locator => page.getByTestId('detail-banner');

function idOf<T>(item: T | undefined, what: string): T {
  if (item === undefined) throw new Error(`the dataset has no ${what}`);
  return item;
}

const walled = walledDeal(d).id;
/** An active equity position outside the wall, so operations sees every tab filled. */
const openDeal = idOf(
  full.investments.find(
    (i) => i.isActive && i.dealType === 'deal_type.co_invest_equity' && i.id !== walled,
  ),
  'active equity position outside the wall',
).id;
/** The vehicle with client commitments (two clients in one fund). */
const vehicle = idOf(
  full.vehicles.find((v) => v.name === 'Beach CV Opportunities I'),
  'CV fund',
).id;
/** The sponsor with the most active positions, so its 360 page has every section filled. */
const sponsor = idOf(
  [...full.sponsors]
    .map((s) => ({
      id: s.id,
      active: full.investments.filter((i) => i.sponsorId === s.id && i.isActive).length,
    }))
    .sort((a, b) => b.active - a.active || a.id.localeCompare(b.id))[0],
  'sponsor',
).id;
const notice = idOf(
  full.capitalNotices.find((n) => n.scenarioTag === 'wire_change'),
  'wire change notice',
).id;
/** Phase 3 W2: the Proposed version of the wire change notice's counterparty, with its callback form. */
const wire = idOf(
  full.wireInstructions.find((w) => w.state === 'Proposed'),
  'proposed wire instruction',
).id;

const PORTFOLIO_PAGES: Visit[] = [
  { path: '/', ready: (p) => p.getByTestId('home-tiles') },
  ...ANALYTICS_TABS.map((t) => ({ path: t.to, ready: heading })),
  { path: '/portfolio/watchlist', ready: heading },
  { path: '/portfolio/monitoring', ready: (p) => p.getByTestId('monitoring-board') },
  { path: '/portfolio/vehicles', ready: (p) => p.getByRole('table', { name: 'Vehicles' }) },
  { path: `/portfolio/vehicles/${vehicle}`, ready: (p) => p.getByTestId('vehicle-banner') },
  { path: '/sponsors', ready: (p) => p.getByRole('table', { name: 'Sponsors' }) },
  { path: `/sponsors/${sponsor}`, ready: (p) => p.getByTestId('sponsor-banner') },
];
const WORKFLOW_PAGES: Visit[] = [
  { path: '/valuations', ready: heading },
  { path: '/capital-activity', ready: heading },
  { path: '/capital-activity/commitments', ready: heading },
  { path: `/capital-activity/${notice}`, ready: heading },
  // Phase 3 W2: capital activity (M16), the wire register, one instruction and the trade tickets.
  { path: '/capital-activity/wires', ready: (p) => p.getByTestId('wire-register') },
  { path: `/capital-activity/wires/${wire}`, ready: (p) => p.getByTestId('wire-instruction') },
  { path: '/capital-activity/tickets', ready: (p) => p.getByTestId('trade-tickets') },
  { path: '/reporting', ready: heading },
  { path: '/reporting/clients', ready: heading },
  { path: '/assistants', ready: heading },
];
const ADMIN_PAGES: Visit[] = [
  { path: '/admin/audit', ready: heading },
  { path: '/admin/access', ready: heading },
  { path: '/admin/health', ready: heading },
  { path: '/data/taxonomy', ready: heading },
  { path: '/data/intake', ready: (p) => p.getByTestId('intake-upload') },
];
/** The rest of the router, so every route is scanned at both widths (the grid once its rows are in). */
const EARLIER_PAGES: Visit[] = [
  { path: '/portfolio', ready: (p) => p.getByTestId('portfolio-grid').locator('.ag-row') },
  { path: '/pipeline', ready: heading },
  { path: '/documents', ready: heading },
  { path: '/reporting/disclosures', ready: heading },
  { path: '/admin/flags', ready: heading },
  { path: '/data/health', ready: heading },
  { path: '/data/dictionary', ready: heading },
];
// Phase 3: W1 valuations (M10) and change requests (M11)
/** A Locked version outside the wall, so operations opens its screen with every card filled. */
const valuation = idOf(
  full.valuations.find((v) => v.investmentId !== walled && v.state === 'Locked'),
  'Locked valuation outside the wall',
).id;
const W1_PAGES: Visit[] = [
  { path: '/valuations/changes', ready: (p) => p.getByTestId('change-requests-card') },
  { path: `/valuations/${valuation}`, ready: (p) => p.getByTestId('valuation-detail') },
];

const dealTabs = (id: string): Visit[] =>
  DEAL_TABS.map((t) => ({ path: `/portfolio/${id}${t.path}`, ready: banner }));

/**
 * Opens each page, waits for its own content and for every loading state to end (no busy
 * skeleton, no spinner), then scans it. Findings from every page are reported together.
 */
async function scanPages(page: Page, visits: readonly Visit[]): Promise<void> {
  const findings: string[] = [];
  for (const visit of visits) {
    await page.goto(visit.path);
    await visit.ready(page).first().waitFor();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('[aria-busy="true"], .fui-Spinner')).toHaveCount(0, {
      timeout: 20_000,
    });
    for (const v of await seriousViolations(page)) findings.push(`${visit.path} ${v}`);
  }
  expect(findings).toEqual([]);
}

/**
 * Stages what the intake pages need, as operations, and names them: the weekly list and the file
 * just staged, the look-through list and the run just reconciled, the queue and one exception on
 * it. Staged once per width, so the second time the same file is a duplicate and says so in the
 * search; the page is the same.
 */
async function stageIntakePages(page: Page): Promise<Visit[]> {
  await page.goto('/data/weekly');
  await page.getByLabel('Weekly values (CSV)').setInputFiles({
    name: weeklyDefects.fileName,
    mimeType: 'text/csv',
    buffer: Buffer.from(weeklyDefects.csv, 'utf8'),
  });
  await page.getByRole('button', { name: 'Stage weekly values' }).click();
  await expect(page).toHaveURL(/\/data\/weekly\/[0-9a-f-]{36}(\?duplicate=true)?$/);
  const weeklyFile = new URL(page.url()).pathname;

  await page.goto('/data/lookthrough');
  await page.getByTestId('lookthrough-run').getByRole('button', { name: 'Reconcile' }).click();
  await expect(page).toHaveURL(/\/data\/lookthrough\/[0-9a-f-]{36}(\?duplicate=true)?$/, {
    timeout: 30_000,
  });
  const run = new URL(page.url()).pathname;

  await page.goto('/data/exceptions');
  const exception = await page
    .getByRole('table', { name: 'Data exceptions' })
    .locator('a[href^="/data/exceptions/"]')
    .first()
    .getAttribute('href');
  if (exception === null) throw new Error('the queue lists no exception');

  return [
    { path: '/data/weekly', ready: (p) => p.getByTestId('weekly-upload') },
    { path: weeklyFile, ready: (p) => p.getByTestId('weekly-banner') },
    { path: '/data/lookthrough', ready: (p) => p.getByTestId('lookthrough-run') },
    { path: run, ready: (p) => p.getByTestId('lookthrough-banner') },
    { path: '/data/exceptions', ready: (p) => p.getByTestId('exceptions-table') },
    { path: exception, ready: (p) => p.getByTestId('exception-banner') },
  ];
}

/**
 * What the documents pages need before they can be scanned: the store indexed and the latest
 * quarter's expected rows generated, as operations through the API (both idempotent). Then the
 * hub, the newest document, the document waiting for review with its classify form (the scan,
 * until a journey classifies it), the review queue and the expected-document tracker.
 */
async function documentPages(page: Page): Promise<Visit[]> {
  const headers = { authorization: 'Bearer ops.one' };
  expect((await page.request.post('/api/v1/documents/index', { headers })).ok()).toBe(true);
  const generated = await page.request.post('/api/v1/expected-documents/generate', {
    headers,
    data: { periodEnd: latestQuarterEndOnOrBefore(full.asOf) },
  });
  expect(generated.ok()).toBe(true);
  const firstOf = async (path: string): Promise<string | undefined> => {
    const body = (await (await page.request.get(path, { headers })).json()) as {
      items: { id: string }[];
    };
    return body.items[0]?.id;
  };
  const newest = await firstOf('/api/v1/documents?limit=1');
  if (newest === undefined) throw new Error('the hub lists no document after the index');
  const queued = await firstOf('/api/v1/documents/review-queue?limit=1');
  return [
    { path: '/documents', ready: (p) => p.getByTestId('documents-table') },
    { path: `/documents/${newest}`, ready: (p) => p.getByTestId('document-banner') },
    ...(queued === undefined
      ? []
      : [{ path: `/documents/${queued}`, ready: (p: Page) => p.getByTestId('document-classify') }]),
    { path: '/documents/review', ready: heading },
    { path: '/documents/expected', ready: (p) => p.getByTestId('expected-table') },
  ];
}

/**
 * Indexes the hub and runs an extraction batch over the latest quarter's reports, as operations,
 * so the extraction pages have batches, runs and a run to review (the API processes the batch
 * before it answers). Run once per width; the index is idempotent and a second batch is one more.
 */
async function stageExtractionPages(page: Page): Promise<Visit[]> {
  await ensureExtractionOn(page, d);
  await indexDocuments(page);
  const batch = await startExtractionBatch(page, {
    periodEnd: latestQuarter(d),
    docType: 'doc_type.quarterly_financials',
  });
  const [run] = await listRuns(page, `&batchId=${batch.id}`);
  if (run === undefined) throw new Error('the extraction batch queued no run');
  return [
    { path: '/documents/extraction', ready: (p) => p.getByTestId('extraction-runs') },
    { path: `/documents/extraction/${run.id}`, ready: (p) => p.getByTestId('run-fields') },
  ];
}

for (const width of [1280, 390]) {
  test.describe(`at ${width} pixels wide`, () => {
    test.use({ viewport: { width, height: 900 } });

    test(`operations: home, analytics, watchlist, vehicles and sponsors @a11y`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await signInAs(page, 'ops.one', d);
      await scanPages(page, PORTFOLIO_PAGES);
    });

    test(`operations: valuations, capital activity, reporting and assistants @a11y`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await signInAs(page, 'ops.one', d);
      await scanPages(page, WORKFLOW_PAGES);
    });

    test(`operations: audit, access, integration health and taxonomy @a11y`, async ({ page }) => {
      test.setTimeout(120_000);
      await signInAs(page, 'ops.one', d);
      await scanPages(page, ADMIN_PAGES);
    });

    test(`operations: the positions grid and the earlier pages @a11y`, async ({ page }) => {
      test.setTimeout(120_000);
      await signInAs(page, 'ops.one', d);
      await scanPages(page, EARLIER_PAGES);
    });

    test(`operations: weekly values, look-through and the exceptions queue @a11y`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await signInAs(page, 'ops.one', d);
      await scanPages(page, await stageIntakePages(page));
    });

    test(`operations: the document hub, a document, the review queue and the expected tracker @a11y`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await signInAs(page, 'ops.one', d);
      await scanPages(page, await documentPages(page));
    });

    // Phase 3: W1 valuations and change requests
    test(`operations: the change request queue and a valuation version @a11y`, async ({ page }) => {
      test.setTimeout(120_000);
      await signInAs(page, 'ops.one', d);
      await scanPages(page, W1_PAGES);
    });

    test(`operations: every deal workspace tab @a11y`, async ({ page }) => {
      test.setTimeout(180_000);
      await signInAs(page, 'ops.one', d);
      await scanPages(page, dealTabs(openDeal));
    });

    test(`approver: every deal workspace tab of the walled deal @a11y`, async ({ page }) => {
      test.setTimeout(180_000);
      await signInAs(page, 'head.one', d);
      await scanPages(page, dealTabs(walled));
    });

    test(`operations: extraction batches, runs and a run review @a11y`, async ({ page }) => {
      test.setTimeout(180_000);
      await signInAs(page, 'ops.one', d);
      await scanPages(page, await stageExtractionPages(page));
    });
  });
}
