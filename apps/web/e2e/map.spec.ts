import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { investmentPage } from '@pb/contracts';
import type { InvestmentSummary } from '@pb/contracts';
import { apiCall, loadDataset, settled, signInAs, switchTo, walledDeal } from './fixtures.js';

/**
 * The co-investment map (decision 0017) over the real API: held co-investments and single-asset
 * CVs sit at their company's head office, a position with none recorded is listed apart and never
 * placed, a marker opens the positions there and leads to the deal, the keyboard and the region
 * buttons move the view, and a wall member sees one position more than a viewer (SEC-5.3).
 *
 * What is expected is read from the API at run time: the specs share one API process, and a
 * journey that runs earlier may have closed a deal into a new position.
 */
const d = loadDataset();
const walled = walledDeal(d);
const MAP_TYPES = ['deal_type.co_invest_equity', 'deal_type.cv_single_asset'];

async function heldOnMap(page: Page, who: string): Promise<InvestmentSummary[]> {
  const list = await apiCall(page, 'GET', '/api/v1/investments?limit=200', who, investmentPage);
  return list.items.filter((p) => MAP_TYPES.includes(p.dealType) && p.isActive);
}

async function expectNoSeriousViolations(page: Page): Promise<void> {
  await settled(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

const tile = (page: Page, label: string) =>
  page.getByTestId('map-tiles').getByRole('group', { name: label });

test('co-investment map: head offices, the positions at a marker, and the wall', async ({
  page,
}) => {
  await signInAs(page, 'deal.three', d);
  const held = await heldOnMap(page, 'deal.three');
  const placed = held.filter((p) => p.hq !== null);
  const unplaced = held.filter((p) => p.hq === null);
  expect(placed.length).toBeGreaterThan(0);
  expect(unplaced.length).toBeGreaterThan(0);

  await page.goto('/analytics/map');
  await page.getByTestId('world-map').waitFor();
  const cities = new Set(placed.map((p) => `${p.hq?.country}|${p.hq?.city}`));
  await expect(tile(page, 'Positions on the map')).toContainText(String(placed.length));
  await expect(tile(page, 'Cities')).toContainText(String(cities.size));
  await expect(tile(page, 'No head office recorded')).toContainText(String(unplaced.length));

  // Every placed position is in the table; every one with nothing recorded is in the other.
  const onMap = page.getByRole('table', { name: 'Positions on the map' });
  await expect(onMap.locator('tbody tr')).toHaveCount(placed.length);
  const apart = page.getByRole('table', { name: 'Positions with no head office recorded' });
  await expect(apart.locator('tbody tr')).toHaveCount(unplaced.length);
  await expect(apart).toContainText(unplaced[0]!.companyName);
  await expect(onMap).not.toContainText(unplaced[0]!.companyName);

  // The markers together hold every placed position, however the cities are grouped.
  const markers = page.getByTestId('map-marker');
  await expect(markers.first()).toBeVisible();
  const labels = await markers.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('aria-label') ?? ''),
  );
  const counted = labels
    .map((label) => Number(/(\d{1,4}) positions?$/.exec(label)?.[1] ?? 0))
    .reduce((a, b) => a + b, 0);
  expect(counted).toBe(placed.length);

  // A row of the table shows its city on the map and opens the positions there.
  const target = placed[0]!;
  await page.getByRole('button', { name: `Show ${target.companyName} on the map` }).click();
  const panel = page.getByTestId('map-panel');
  await expect(panel).toContainText(target.hq!.city);
  await expect(panel).toContainText(target.companyName);
  await expect(
    page.getByRole('button', {
      name: new RegExp(`^${target.hq!.city}, .*position`),
      pressed: true,
    }),
  ).toBeVisible();

  // The keyboard moves the map and lets go of what was chosen.
  await page.getByTestId('world-map').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('+');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('map-panel-empty')).toBeVisible();
  await page.getByRole('button', { name: 'Show the whole world' }).click();
  await page.getByRole('button', { name: 'Europe' }).click();
  await expect(markers.first()).toBeAttached();

  // From the panel, a position opens its deal.
  await page.getByRole('button', { name: `Show ${target.companyName} on the map` }).click();
  await panel.getByRole('link', { name: target.companyName }).click();
  await expect(page).toHaveURL(new RegExp(`/portfolio/${target.id}`));

  // A viewer is outside the wall: the walled position is not on their map or in their tables.
  await page.goto('/analytics/map');
  await page.getByTestId('world-map').waitFor();
  const walledOnMap = held.some((p) => p.id === walled.id);
  if (walledOnMap) await expect(page.locator('main')).toContainText(walled.companyName);
  await switchTo(page, 'viewer.one', d);
  await page.goto('/analytics/map');
  await page.getByTestId('world-map').waitFor();
  const viewerHeld = await heldOnMap(page, 'viewer.one');
  expect(viewerHeld.map((p) => p.id)).not.toContain(walled.id);
  await expect(page.locator('main')).not.toContainText(walled.companyName);
  await expect(tile(page, 'Positions on the map')).toContainText(
    String(viewerHeld.filter((p) => p.hq !== null).length),
  );
});

test('co-investment map with a marker chosen, zoomed in, and with nothing left @a11y', async ({
  page,
}) => {
  await signInAs(page, 'deal.three', d);
  await page.goto('/analytics/map');
  await page.getByTestId('world-map').waitFor();
  await page.getByTestId('map-marker').first().waitFor();
  await expectNoSeriousViolations(page);
  await page.getByTestId('map-marker').first().click();
  await page.getByTestId('map-panel').waitFor();
  await expectNoSeriousViolations(page);
  await page.getByRole('button', { name: 'North America' }).click();
  await page.getByRole('button', { name: 'Realized' }).click();
  await expectNoSeriousViolations(page);
  for (const name of ['Co-investment (equity)', 'Continuation vehicle (single asset)']) {
    const chip = page.getByRole('button', { name });
    if ((await chip.getAttribute('aria-pressed')) === 'true') await chip.click();
  }
  await page.getByTestId('map-empty').waitFor();
  await expectNoSeriousViolations(page);
});

test('the map opens once in about a second, then holds still, and is simply there under reduced motion @a11y', async ({
  page,
}) => {
  await signInAs(page, 'deal.three', d);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/analytics/map');
  await page.getByTestId('map-marker').first().waitFor();
  const map = page.getByTestId('world-map');
  // The opening plays: the coast draws, and nothing on the map is set to repeat.
  const loops = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations === Infinity)
      .map((a) => (a as CSSAnimation).animationName ?? ''),
  );
  expect(loops.filter((name) => name.startsWith('pb-map'))).toEqual([]);
  // It is over in about a second, and its class comes off.
  await expect(map).not.toHaveClass(/is-intro/, { timeout: 2_000 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter((a) => a.playState === 'running')
            .filter((a) => ((a as CSSAnimation).animationName ?? '').startsWith('pb-map')).length,
      ),
    )
    .toBe(0);
  // Under reduced motion the opening never plays: the coast is drawn whole at once.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.getByTestId('map-marker').first().waitFor();
  await expect(map).not.toHaveClass(/is-intro/);
  const coast = await map
    .locator('.pb-map-coast')
    .evaluate((el) => getComputedStyle(el).animationName);
  expect(coast).toBe('none');
});
