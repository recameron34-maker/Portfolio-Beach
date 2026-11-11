import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { D } from '@pb/calc';
import { investmentValueCreation, valueCreation } from '@pb/contracts';
import type { InvestmentValueCreation, ValueCreation } from '@pb/contracts';
import { generateDataset } from '@pb/synthetic';
import { apiCall, loadDataset, signInAs, switchTo, walledDeal } from './fixtures.js';

/**
 * Value creation and entry metric analytics (docs/04 M13 and M20) over the real API: the Value
 * creation tab leads with our gain and its three drivers, and its bridge sums to that headline;
 * the positions sort, open their deal and export as CSV; a wall member sees one position more
 * than a viewer (SEC-5.3); the Entry metrics tab shows performance by entry purchase multiple
 * and entry net leverage band; and the deal workspace shows a position's own bridge, indexed
 * lines and entry against current metrics, and nothing for a credit position.
 *
 * Every expected figure is read from the API at run time, since the specs share one API process
 * and a journey that runs earlier may have locked a mark or closed a deal; the pages are checked
 * against that answer, formatted here independently of src/lib/format.ts.
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });
const walled = walledDeal(d);
const VIEW = '/api/v1/analytics/value-creation';

/** Dollars as $M with one decimal, "-" for a figure that is not calculable. */
function money(value: string | null): string {
  if (value === null) return '-';
  const millions = D(value).div(1_000_000);
  return `${millions.isNegative() ? '-' : ''}$${millions.abs().toFixed(1)}M`;
}
/** A change in $M with its sign. */
function signed(value: string | null): string {
  const text = money(value);
  return value === null || text.startsWith('-') || D(value).isZero() ? text : `+${text}`;
}
const moic = (value: string): string => `${D(value).toFixed(2)}x`;
const turns = (value: string): string => `${D(value).toFixed(1)}x`;

const numberOf = (scenario: string): string => {
  const id = full.scenarios[scenario]?.[0];
  const investment = full.investments.find((i) => i.id === id);
  if (investment === undefined) throw new Error(`the dataset has no ${scenario} position`);
  return investment.investmentNumber;
};

const viewFor = (page: Page, who: string): Promise<ValueCreation> =>
  apiCall(page, 'GET', VIEW, who, valueCreation);
const oneFor = (page: Page, who: string, id: string): Promise<InvestmentValueCreation> =>
  apiCall(page, 'GET', `/api/v1/investments/${id}/value-creation`, who, investmentValueCreation);

const positions = (page: Page): Locator =>
  page.getByRole('table', { name: 'Value creation by position' });
const bodyRows = (table: Locator): Locator => table.locator('tbody tr');

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

test('value creation: the headline, a bridge that sums to it, the positions and the export', async ({
  page,
}) => {
  await signInAs(page, 'viewer.one', d);
  const view = await viewFor(page, 'viewer.one');
  const p = view.portfolio;
  const g = p.gainByDriver;
  if (g === null || p.gain === null || p.invested === null || p.totalValue === null)
    throw new Error('the seeded book has no position that can be split by driver');

  await page.goto('/analytics/value-creation');
  const tiles = page.getByTestId('value-creation-tiles');
  await expect(tiles.getByRole('group', { name: 'Our gain' })).toContainText(money(p.gain));
  await expect(tiles.getByRole('group', { name: 'Our gain' })).toContainText(
    `${p.positions} positions`,
  );
  await expect(tiles.getByRole('group', { name: 'EBITDA growth' })).toContainText(
    signed(g.ebitdaGrowth),
  );
  await expect(tiles.getByRole('group', { name: 'Multiple expansion' })).toContainText(
    signed(g.multipleExpansion),
  );
  await expect(tiles.getByRole('group', { name: 'Debt paydown' })).toContainText(
    signed(g.debtPaydown),
  );

  // The bridge runs from invested capital to the value now, and its steps are the headline:
  // the three drivers sum to our gain, and invested plus the gain is the value now.
  const bridge = page.getByRole('group', { name: 'Our gain by driver' });
  for (const name of [
    `Invested: ${money(p.invested)}`,
    `EBITDA growth: ${signed(g.ebitdaGrowth)}`,
    `Multiple expansion: ${signed(g.multipleExpansion)}`,
    `Debt paydown: ${signed(g.debtPaydown)}`,
    `Value now: ${money(p.totalValue)}`,
  ])
    await expect(bridge.getByRole('img', { name, exact: true })).toBeVisible();
  const drivers = D(g.ebitdaGrowth).plus(g.multipleExpansion).plus(g.debtPaydown);
  expect(drivers.minus(p.gain).abs().lte('3e-10')).toBe(true);
  expect(D(p.invested).plus(p.gain).eq(p.totalValue)).toBe(true);

  // EBITDA growth opens into revenue growth and margin change, and the bridge has a table twin.
  if (g.revenueGrowth !== null && g.marginChange !== null) {
    await page
      .getByRole('switch', { name: 'Open EBITDA growth into revenue growth and margin change' })
      .check();
    await expect(
      bridge.getByRole('img', { name: `Revenue growth: ${signed(g.revenueGrowth)}`, exact: true }),
    ).toBeVisible();
    await expect(
      bridge.getByRole('img', { name: `Margin change: ${signed(g.marginChange)}`, exact: true }),
    ).toBeVisible();
    expect(D(g.revenueGrowth).plus(g.marginChange).minus(g.ebitdaGrowth).abs().lte('3e-10')).toBe(
      true,
    );
  }
  const figure = page.getByTestId('value-creation-bridge');
  await figure.getByRole('button', { name: 'Show table' }).click();
  const twin = figure.getByRole('table', { name: 'Our gain by driver, as a table' });
  await expect(twin.getByRole('row').last()).toContainText(`Value now${money(p.totalValue)}`);

  // The positions the split leaves out are counted quietly, with their reasons on demand.
  const left = view.positions.filter((x) => x.gainNotCalculable !== null);
  expect(left.length).toBe(p.notCalculable.reduce((n, r) => n + r.count, 0));
  const note = page.getByTestId('value-creation-not-calculable');
  await note.locator('summary').click();
  await expect(note.getByRole('listitem')).toHaveCount(left.length);
  const forward = view.positions.find(
    (x) => x.investmentNumber === numberOf('forward_entry_snapshot'),
  );
  expect(forward?.notCalculable).toBe('no_entry_snapshot');
  await expect(note).toContainText(
    `${forward?.companyName} (${forward?.investmentNumber}): No approved entry snapshot on or before the as-of date`,
  );

  // Valuation growth against EBITDA growth, with the line where the two are equal.
  await expect(
    page.getByRole('group', { name: 'Valuation growth against EBITDA growth' }),
  ).toBeVisible();
  await expect(page.getByTestId('value-creation-scatter-equal-line')).toBeVisible();

  // One row per position the viewer may see, largest gain first; the walled deal is not there.
  const table = positions(page);
  await expect(bodyRows(table)).toHaveCount(view.positions.length);
  await expect(table).not.toContainText(walled.companyName);
  const byGain = [...view.positions].sort((a, b) =>
    a.gain === null || b.gain === null
      ? Number(a.gain === null) - Number(b.gain === null)
      : D(b.gain).comparedTo(a.gain),
  );
  await expect(bodyRows(table).first()).toContainText(byGain[0]!.investmentNumber);
  const top = byGain[0]!;
  await expect(bodyRows(table).first()).toContainText(money(top.gain));
  // A position without a bridge shows the placeholder and the reason, never a zero.
  const negative = view.positions.find((x) => x.investmentNumber === numberOf('negative_ebitda'));
  expect(negative?.notCalculable).toBe('non_positive_ebitda');
  await expect(bodyRows(table).filter({ hasText: negative?.investmentNumber ?? '' })).toContainText(
    '- EBITDA is at or below zero at entry or in the current quarter',
  );

  // Sorting from a header: the highest MOIC first, then the lowest.
  const byMoic = view.positions
    .filter((x) => x.grossMoic !== null)
    .sort((a, b) => D(b.grossMoic!).comparedTo(a.grossMoic!));
  const moicHeader = table.getByRole('columnheader', { name: /^Gross MOIC/ });
  await moicHeader.getByRole('button').click();
  await expect(moicHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(bodyRows(table).first()).toContainText(byMoic[0]!.investmentNumber);
  await expect(bodyRows(table).first()).toContainText(moic(byMoic[0]!.grossMoic!));
  await moicHeader.getByRole('button').click();
  await expect(moicHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(bodyRows(table).first()).toContainText(byMoic[byMoic.length - 1]!.investmentNumber);

  // The export is the same rows as CSV: the header line plus one line per position.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`value-creation-${view.asOf}.csv`);
  const lines = readFileSync(await download.path(), 'utf8').split('\n');
  expect(lines[0]).toMatch(/^investmentNumber,companyName,vehicleName,sponsorName,/);
  expect(lines[lines.length - 1]).toBe('');
  expect(lines).toHaveLength(view.positions.length + 2);
  expect(lines.some((line) => line.includes(walled.companyName))).toBe(false);
  for (const position of view.positions)
    expect(lines.some((line) => line.startsWith(`${position.investmentNumber},`))).toBe(true);
  await expect(page.getByTestId('value-creation-action-status')).toContainText(
    `Exported ${view.positions.length} rows to value-creation-${view.asOf}.csv`,
  );

  // A company opens its deal, on the tab that carries its own bridge.
  await table.getByRole('link', { name: top.companyName, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/portfolio/${top.id}/performance$`));
  await expect(page.getByTestId('detail-banner')).toContainText(top.companyName);
  await expect(page.getByTestId('deal-value-creation')).toBeVisible();

  // A wall member sees the walled position as well: one row more, and a different headline.
  await switchTo(page, 'deal.three', d);
  const member = await viewFor(page, 'deal.three');
  expect(member.positions.length).toBe(view.positions.length + 1);
  await page.goto('/analytics/value-creation');
  await expect(bodyRows(positions(page))).toHaveCount(member.positions.length);
  await expect(positions(page)).toContainText(walled.companyName);
  await expect(
    page.getByTestId('value-creation-tiles').getByRole('group', { name: 'Our gain' }),
  ).toContainText(money(member.portfolio.gain));
});

test('entry metrics: performance by entry purchase multiple and entry net leverage band', async ({
  page,
}) => {
  await signInAs(page, 'viewer.one', d);
  const view = await viewFor(page, 'viewer.one');
  await page.goto('/analytics/entry-metrics');
  for (const [metric, cohorts] of [
    ['entry purchase multiple', view.cohorts.byEntryMultiple],
    ['entry net leverage', view.cohorts.byEntryLeverage],
  ] as const) {
    const bars = page.getByRole('group', { name: `Gross MOIC by ${metric}` });
    await expect(bars).toBeVisible();
    const banded = cohorts.filter((c) => c.key !== 'not_calculable');
    // At least three bands hold positions, and each band with a MOIC has its bar.
    expect(banded.filter((c) => c.count > 0).length).toBeGreaterThanOrEqual(3);
    for (const c of banded.filter((x) => x.grossMoic !== null))
      await expect(
        bars.getByRole('img', { name: `${c.label}: ${moic(c.grossMoic!)}`, exact: true }),
      ).toBeVisible();
    // The table beneath lists every band the response names, with its count, invested and NAV.
    const table = page.getByRole('table', { name: `Performance by ${metric}` });
    const listed = cohorts.filter((c) => c.key !== 'not_calculable' || c.count > 0);
    await expect(bodyRows(table)).toHaveCount(listed.length);
    for (const c of listed) {
      const row = bodyRows(table).filter({
        has: page.getByRole('cell', { name: c.label, exact: true }),
      });
      await expect(row).toContainText(`${c.label}${c.count}${money(c.invested)}${money(c.nav)}`);
    }
    // A position with no entry figure is counted in its own row, never dropped.
    const none = cohorts.find((c) => c.key === 'not_calculable');
    expect(cohorts.reduce((n, c) => n + c.count, 0)).toBe(view.positions.length);
    if (none !== undefined && none.count > 0)
      await expect(table).toContainText(`Not calculable${none.count}`);
  }

  // Entry multiple against MOIC per company, the leverage band as the series.
  const scatter = page.getByRole('group', { name: 'Entry purchase multiple against gross MOIC' });
  await expect(scatter).toBeVisible();
  const plotted = view.positions.find(
    (x) => (x.entry?.evToEbitda ?? null) !== null && x.grossMoic !== null,
  );
  if (plotted === undefined) throw new Error('no position has an entry multiple and a MOIC');
  const band = view.cohorts.byEntryLeverage.find((c) => c.key === plotted.entryLeverageBand);
  await expect(
    scatter.getByRole('img', {
      name: `${plotted.companyName}: Entry EV / EBITDA ${turns(plotted.entry!.evToEbitda!)}, Gross MOIC ${moic(plotted.grossMoic!)}, Entry net leverage ${band?.label}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByTestId('entry-scatter').getByRole('list', { name: 'Legend' }),
  ).toBeVisible();
});

test('deal workspace: a position shows its own bridge, indexed lines and entry against current; a credit position shows none', async ({
  page,
}) => {
  await signInAs(page, 'viewer.one', d);
  const view = await viewFor(page, 'viewer.one');
  const position = view.positions.find((x) => x.bridge !== null && x.isActive);
  if (position === undefined) throw new Error('no active position has a bridge');
  const one = await oneFor(page, 'viewer.one', position.id);
  const bridge = one.position?.bridge ?? null;
  if (one.position === null || bridge === null) throw new Error('the position has no bridge');

  await page.goto(`/portfolio/${position.id}/performance`);
  const card = page.getByTestId('deal-value-creation');
  await expect(card).toBeVisible();
  const tiles = page.getByTestId('deal-value-creation-tiles');
  await expect(tiles.getByRole('group', { name: 'Equity value change' })).toContainText(
    signed(bridge.total),
  );
  const chart = card.getByRole('group', { name: 'Value creation bridge' });
  for (const name of [
    `Equity value at entry: ${money(bridge.equityAtEntry)}`,
    `EBITDA growth: ${signed(bridge.ebitdaGrowth)}`,
    `Multiple expansion: ${signed(bridge.multipleExpansion)}`,
    `Debt paydown: ${signed(bridge.debtPaydown)}`,
    `Equity value now: ${money(bridge.equityCurrent)}`,
  ])
    await expect(chart.getByRole('img', { name, exact: true })).toBeVisible();
  // The company's three drivers are its change in equity value.
  expect(
    D(bridge.ebitdaGrowth)
      .plus(bridge.multipleExpansion)
      .plus(bridge.debtPaydown)
      .minus(bridge.total)
      .abs()
      .lte('3e-10'),
  ).toBe(true);
  await expect(card.getByRole('group', { name: 'Indexed since entry' })).toBeVisible();
  const table = card.getByRole('table', { name: 'Entry against current' });
  await expect(
    table
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: 'EV / EBITDA', exact: true }) }),
  ).toContainText(
    `EV / EBITDA${turns(one.position.entry!.evToEbitda!)}${turns(one.position.current!.evToEbitda!)}`,
  );
  await expect(page.getByTestId('deal-value-creation-ours')).toContainText(
    `Our gain on this position is ${money(one.position.gain)}`,
  );
  // The series behind the lines starts at 100 on the entry snapshot.
  expect(one.series[0]).toMatchObject({ isEntry: true, ebitdaIndex: '100', markIndex: null });

  // A position whose bridge is not calculable says why, and still shows what is on record.
  const negative = view.positions.find((x) => x.investmentNumber === numberOf('negative_ebitda'));
  if (negative === undefined) throw new Error('the viewer cannot see the negative EBITDA position');
  await page.goto(`/portfolio/${negative.id}/performance`);
  await expect(page.getByTestId('deal-value-creation-not-calculable')).toContainText(
    'EBITDA is at or below zero at entry or in the current quarter.',
  );
  await expect(page.getByTestId('deal-value-creation-tiles')).toHaveCount(0);
  await expect(
    page.getByTestId('deal-value-creation').getByRole('table', { name: 'Entry against current' }),
  ).toBeVisible();

  // Credit positions are not part of these views: the tab shows its credit cards and no bridge.
  const credit = full.investments.find((i) => i.dealType === 'deal_type.private_credit');
  if (credit === undefined) throw new Error('the dataset has no credit position');
  expect(view.positions.some((x) => x.id === credit.id)).toBe(false);
  await page.goto(`/portfolio/${credit.id}/performance`);
  await expect(page.getByTestId('deal-credit-terms')).toBeVisible();
  await expect(page.getByTestId('deal-value-creation')).toHaveCount(0);
  await expect(page.getByTestId('deal-value-creation-loading')).toHaveCount(0);
});

test('value creation pages with their tables shown @a11y', async ({ page }) => {
  await signInAs(page, 'deal.three', d);
  await page.goto('/analytics/value-creation');
  await positions(page).waitFor();
  await page.getByTestId('value-creation-not-calculable').locator('summary').click();
  for (const id of ['value-creation-bridge', 'value-creation-scatter'])
    await page.getByTestId(id).getByRole('button', { name: 'Show table' }).click();
  await expectNoSeriousViolations(page);
  await page.goto('/analytics/entry-metrics');
  await page.getByRole('table', { name: 'Performance by entry net leverage' }).waitFor();
  await page.getByTestId('entry-scatter').getByRole('button', { name: 'Show table' }).click();
  await expectNoSeriousViolations(page);
  const view = await viewFor(page, 'deal.three');
  const position = view.positions.find((x) => x.bridge !== null);
  if (position === undefined) throw new Error('no position has a bridge');
  await page.goto(`/portfolio/${position.id}/performance`);
  await page.getByTestId('deal-value-creation').waitFor();
  await page
    .getByRole('switch', { name: 'Open EBITDA growth into revenue growth and margin change' })
    .check();
  await page
    .getByTestId('deal-value-creation-index')
    .getByRole('button', { name: 'Show table' })
    .click();
  await expectNoSeriousViolations(page);
});
