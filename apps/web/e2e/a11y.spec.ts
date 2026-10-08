import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loadDataset, signInAs, walledDeal } from './fixtures.js';

/** WCAG 2.1 AA with zero critical or serious issues on the Phase 0 pages (docs/12 section 1, docs/17 section 9). */
const d = loadDataset();

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
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
