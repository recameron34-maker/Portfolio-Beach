import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { opportunityFit, opportunityPage } from '@pb/contracts';
import { apiCall, loadDataset, settled, signInAs } from './fixtures.js';

/**
 * The "Portfolio fit" card of an opportunity (docs/08 section 8, decision 0018) over the real
 * API: the radar chart and the list beside it show the seven measures the API answers, a measure
 * with no score is shown as having none, and pointing at one brings the other forward.
 *
 * What is expected is read from the API at run time: the specs share one API process, and a
 * journey that runs earlier may have changed the book the fit is measured against.
 */
const d = loadDataset();

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

/** A score as the card shows it: a whole number. */
const shown = (score: string): string => String(Math.round(Number(score)));

test('portfolio fit: the radar chart and the reading of each measure', async ({ page }) => {
  const who = 'deal.three';
  await signInAs(page, who, d);
  const deals = (
    await apiCall(page, 'GET', '/api/v1/opportunities?limit=200', who, opportunityPage)
  ).items;
  expect(deals.length).toBeGreaterThan(0);
  // A deal with the most measures scored, so the shape is on the page.
  let best: { id: string; scored: number } | null = null;
  for (const deal of deals.slice(0, 12)) {
    const fit = await apiCall(
      page,
      'GET',
      `/api/v1/opportunities/${deal.id}/fit`,
      who,
      opportunityFit,
    );
    const scored = fit.measures.filter((m) => m.score !== null).length;
    if (best === null || scored > best.scored) best = { id: deal.id, scored };
  }
  if (best === null) throw new Error('no deal to open');
  const fit = await apiCall(
    page,
    'GET',
    `/api/v1/opportunities/${best.id}/fit`,
    who,
    opportunityFit,
  );
  expect(best.scored).toBeGreaterThanOrEqual(3);

  await page.goto(`/pipeline/${best.id}`);
  const card = page.getByTestId('opportunity-fit');
  await expect(card.getByRole('heading', { level: 2 })).toContainText('Portfolio fit');
  await expect(card.getByTestId('opportunity-fit-lead')).toContainText('higher is a better fit');

  // The chart: a spoke for every measure, a point for every one with a score.
  const chart = card.getByTestId('opportunity-fit-chart');
  await expect(chart.locator('.pb-radar-axis')).toHaveCount(fit.measures.length);
  await expect(chart.locator('.pb-radar-point')).toHaveCount(best.scored);
  await expect(chart.locator('.pb-radar-axis.is-missing')).toHaveCount(
    fit.measures.length - best.scored,
  );

  // The list: every measure in the API's order, with its score or that it has none.
  const rows = card.getByRole('list', { name: 'Fit measures' }).getByRole('listitem');
  await expect(rows).toHaveCount(fit.measures.length);
  for (const [i, measure] of fit.measures.entries()) {
    const row = rows.nth(i);
    await expect(row).toHaveAttribute('data-measure', measure.key);
    if (measure.score === null) await expect(row).toContainText('No score');
    else await expect(row.locator('.pb-fit-score')).toContainText(`${shown(measure.score)} of 100`);
  }

  // Pointing at a measure in the list brings its spoke forward; focusing a spoke marks the row.
  const scoredKey = fit.measures.find((m) => m.score !== null)?.key ?? '';
  const row = card.locator(`[data-measure="${scoredKey}"]`);
  const axis = chart.locator(`[data-axis="${scoredKey}"]`);
  await row.hover();
  await expect(axis).toHaveClass(/is-active/);
  await axis.focus();
  await expect(row).toHaveClass(/is-active/);
  await expect(chart.getByRole('tooltip')).toBeVisible();

  // The same rows as a table, for a reader who cannot use the chart.
  await chart.getByRole('button', { name: 'Show table' }).click();
  await expect(
    chart.getByRole('table', { name: 'Fit by measure, as a table' }).locator('tbody tr'),
  ).toHaveCount(fit.measures.length);
  await chart.getByRole('button', { name: 'Show chart' }).click();
  await expect(chart.locator('.pb-radar-axis')).toHaveCount(fit.measures.length);

  await expectNoSeriousViolations(page);
});
