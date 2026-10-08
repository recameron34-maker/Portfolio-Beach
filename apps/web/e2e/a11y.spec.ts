import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { generateDataset } from '@pb/synthetic';
import { ANALYTICS_TABS, DEAL_TABS } from '../src/app/nav.js';
import { loadDataset, signInAs, walledDeal } from './fixtures.js';

/** WCAG 2.1 AA with zero critical or serious issues on the Phase 0 pages (docs/12 section 1, docs/17 section 9). */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });

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

const PORTFOLIO_PAGES: Visit[] = [
  { path: '/', ready: (p) => p.getByTestId('home-tiles') },
  ...ANALYTICS_TABS.map((t) => ({ path: t.to, ready: heading })),
  { path: '/portfolio/watchlist', ready: heading },
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
  { path: '/reporting', ready: heading },
  { path: '/reporting/clients', ready: heading },
  { path: '/assistants', ready: heading },
];
const ADMIN_PAGES: Visit[] = [
  { path: '/admin/audit', ready: heading },
  { path: '/admin/access', ready: heading },
  { path: '/admin/health', ready: heading },
  { path: '/data/taxonomy', ready: heading },
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
  });
}
