import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { D, valueCreationRollup } from '@pb/calc';
import { investmentValueCreation, matchesValueCreationFilters, valueCreation } from '@pb/contracts';
import type { InvestmentValueCreation, ValueCreation } from '@pb/contracts';
import { generateDataset } from '@pb/synthetic';
import { apiCall, loadDataset, signInAs, switchTo, walledDeal } from './fixtures.js';

/**
 * Value creation and entry metric analytics (docs/04 M13 and M20) over the real API: the Value
 * creation tab leads with our gain, its three drivers and mark and timing, and its bridge sums
 * to that headline exactly; the valuation chart compares our mark, the company equity value or
 * the enterprise value with EBITDA growth; the positions sort, open their deal and export as
 * CSV; the filters live in the address, recompute every figure and narrow the export; a wall
 * member sees one position more than a viewer (SEC-5.3); the Entry metrics tab shows performance
 * by entry purchase multiple and entry net leverage band, pooled again under a filter; and the
 * deal workspace shows a position's own bridge (to its exit when realized), indexed lines and
 * entry against current metrics, and nothing for a credit position.
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
const pct = (value: string): string => `${D(value).times(100).toFixed(1)}%`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Jun 30, 2020" from an ISO date. */
const day = (iso: string): string =>
  `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

async function pick(page: Page, combobox: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: combobox, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

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
  await expect(tiles.getByRole('group', { name: 'Mark and timing' })).toContainText(
    signed(g.other),
  );

  // The bridge runs from invested capital to the value now, and its steps are the headline:
  // the three drivers and mark and timing sum to our gain exactly, and invested plus the gain is
  // the value now.
  const bridge = page.getByRole('group', { name: 'Our gain by driver' });
  for (const name of [
    `Invested: ${money(p.invested)}`,
    `EBITDA growth: ${signed(g.ebitdaGrowth)}`,
    `Multiple expansion: ${signed(g.multipleExpansion)}`,
    `Debt paydown: ${signed(g.debtPaydown)}`,
    `Mark and timing: ${signed(g.other)}`,
    `Value now: ${money(p.totalValue)}`,
  ])
    await expect(bridge.getByRole('img', { name, exact: true })).toBeVisible();
  const drivers = D(g.ebitdaGrowth).plus(g.multipleExpansion).plus(g.debtPaydown);
  expect(drivers.plus(g.other).eq(p.gain)).toBe(true);
  expect(D(p.invested).plus(p.gain).eq(p.totalValue)).toBe(true);
  // No driver outweighs the gain it is part of: a company whose equity value barely moved no
  // longer blows the headline up.
  for (const part of [g.ebitdaGrowth, g.multipleExpansion, g.debtPaydown])
    expect(D(part).abs().lt(D(p.gain).abs())).toBe(true);
  await expect(page.getByTestId('value-creation-bridge-note')).toContainText(
    'Mark and timing is the rest of our gain',
  );
  // What the page shows is the roll-up of the rows it holds, which is the API's own answer.
  const rolled = valueCreationRollup(view.positions, view.cohorts, view.asOf);
  expect(rolled.portfolio).toEqual(view.portfolio);
  expect(rolled.cohorts).toEqual(view.cohorts);

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
  // A forward-dated entry snapshot has its own reason, in the words of the Since entry card.
  expect(forward?.notCalculable).toBe('entry_snapshot_forward_dated');
  await expect(note).toContainText(
    `${forward?.companyName} (${forward?.investmentNumber}): The entry snapshot is dated after the as-of date`,
  );

  // Valuation growth against EBITDA growth, with the line where the two are equal: our mark by
  // default, the company equity value or the enterprise value on demand.
  const growth = page.getByRole('group', { name: 'Valuation growth against EBITDA growth' });
  await expect(growth).toBeVisible();
  await expect(page.getByTestId('value-creation-scatter-equal-line')).toBeVisible();
  const plotted = view.positions.find(
    (x) =>
      x.growth.ebitdaGrowth !== null && x.valuationGrowth !== null && x.growth.evGrowth !== null,
  );
  if (plotted === undefined) throw new Error('no position has the three growth figures');
  await expect(
    growth.getByRole('img', {
      name: new RegExp(
        `^${plotted.companyName}: EBITDA growth since entry ${pct(plotted.growth.ebitdaGrowth!).replace('.', '\\.')}, Growth in our mark `,
      ),
    }),
  ).toBeVisible();
  await expect(page.getByTestId('value-creation-measure-note')).toContainText(
    'enterprise value is the like-for-like view',
  );
  await pick(page, 'Valuation measure', 'Enterprise value');
  const aheadOnEv = D(plotted.growth.evGrowth!).gt(plotted.growth.ebitdaGrowth!);
  await expect(
    growth.getByRole('img', {
      name: `${plotted.companyName}: EBITDA growth since entry ${pct(plotted.growth.ebitdaGrowth!)}, Enterprise value growth ${pct(plotted.growth.evGrowth!)}, Side of the line Enterprise value ${aheadOnEv ? 'ahead of' : 'at or behind'} EBITDA growth`,
      exact: true,
    }),
  ).toBeVisible();
  // On enterprise value the seeded companies fall on both sides of the line.
  const onEv = view.positions.filter(
    (x) => x.growth.evGrowth !== null && x.growth.ebitdaGrowth !== null,
  );
  const above = onEv.filter((x) => D(x.growth.evGrowth!).gt(x.growth.ebitdaGrowth!)).length;
  expect(above).toBeGreaterThan(0);
  expect(above).toBeLessThan(onEv.length);
  await expect(page.getByTestId('value-creation-growth-card')).toContainText(
    `${above} of ${onEv.length} marks sit above the line: the enterprise value grew faster than the company EBITDA.`,
  );
  await pick(page, 'Valuation measure', 'Company equity value');
  await expect(
    growth.getByRole('img', {
      name: new RegExp(`^${plotted.companyName}: .*Equity value growth `),
    }),
  ).toBeVisible();
  await pick(page, 'Valuation measure', 'Our mark');

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
  // Each split row shows our entry stake and the four parts of its gain, mark and timing last.
  const split = view.positions.find((x) => x.gainByDriver !== null && x.stake !== null);
  if (split === undefined) throw new Error('no position is split by driver');
  await expect(bodyRows(table).filter({ hasText: split.investmentNumber })).toContainText(
    `${pct(split.stake!)}${money(split.gain)}${signed(split.gainByDriver!.ebitdaGrowth)}${signed(split.gainByDriver!.multipleExpansion)}${signed(split.gainByDriver!.debtPaydown)}${signed(split.gainByDriver!.other)}`,
  );
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

test('filters: one vehicle recomputes every figure, lives in the address, carries to entry metrics and narrows the export', async ({
  page,
}) => {
  await signInAs(page, 'viewer.one', d);
  const view = await viewFor(page, 'viewer.one');
  // The vehicle that holds the most of the viewer's positions, and the rows a page keeps for it.
  const counts = new Map<string, number>();
  for (const x of view.positions) counts.set(x.vehicleId, (counts.get(x.vehicleId) ?? 0) + 1);
  const vehicleId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const rows = view.positions.filter((x) => matchesValueCreationFilters(x, { vehicleId }));
  const vehicleName = rows[0]!.vehicleName;
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.length).toBeLessThan(view.positions.length);
  // The figures the page must show: summed here row by row, and the same by the shared roll-up.
  const included = rows.filter((x) => x.gainByDriver !== null);
  const sum = (pickOf: (x: (typeof rows)[number]) => string): string =>
    included.reduce((acc, x) => acc.plus(pickOf(x)), D('0')).toString();
  const gain = sum((x) => x.gain!);
  const other = sum((x) => x.gainByDriver!.other);
  const ebitda = sum((x) => x.gainByDriver!.ebitdaGrowth);
  const rolled = valueCreationRollup(rows, view.cohorts, view.asOf);
  expect(D(rolled.portfolio.gain!).eq(gain)).toBe(true);
  expect(D(rolled.portfolio.gainByDriver!.other).eq(other)).toBe(true);

  await page.goto('/analytics/value-creation');
  const tiles = page.getByTestId('value-creation-tiles');
  await expect(tiles.getByRole('group', { name: 'Our gain' })).toContainText(
    money(view.portfolio.gain),
  );
  await expect(page.getByTestId('value-creation-filter-count')).toHaveText(
    `${view.positions.length} positions`,
  );
  await pick(page, 'Vehicle', vehicleName);
  await expect(page).toHaveURL(new RegExp(`vehicleId=${vehicleId}`));
  await expect(page.getByTestId('value-creation-filter-count')).toHaveText(
    `${rows.length} of ${view.positions.length} positions`,
  );
  await expect(tiles.getByRole('group', { name: 'Our gain' })).toContainText(money(gain));
  await expect(tiles.getByRole('group', { name: 'Our gain' })).toContainText(
    `${included.length} position`,
  );
  await expect(tiles.getByRole('group', { name: 'EBITDA growth' })).toContainText(signed(ebitda));
  await expect(tiles.getByRole('group', { name: 'Mark and timing' })).toContainText(signed(other));
  const bridge = page.getByRole('group', { name: 'Our gain by driver' });
  await expect(
    bridge.getByRole('img', {
      name: `Invested: ${money(rolled.portfolio.invested)}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    bridge.getByRole('img', {
      name: `Value now: ${money(rolled.portfolio.totalValue)}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(bodyRows(positions(page))).toHaveCount(rows.length);

  // The export carries the filter: the header line and the rows the view shows, no others.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV' }).click(),
  ]);
  const lines = readFileSync(await download.path(), 'utf8')
    .trimEnd()
    .split('\n');
  expect(lines).toHaveLength(rows.length + 1);
  for (const x of view.positions)
    expect(lines.some((line) => line.startsWith(`${x.investmentNumber},`))).toBe(
      rows.some((r) => r.id === x.id),
    );
  await expect(page.getByTestId('value-creation-action-status')).toContainText(
    `Exported ${rows.length} rows to value-creation-${view.asOf}.csv`,
  );

  // The filter carries to the Entry metrics tab, where each cohort is pooled over these rows.
  await page.getByRole('navigation', { name: 'Analytics' }).getByText('Entry metrics').click();
  await expect(page).toHaveURL(new RegExp(`/analytics/entry-metrics\\?.*vehicleId=${vehicleId}`));
  await expect(page.getByRole('combobox', { name: 'Vehicle', exact: true })).toContainText(
    vehicleName,
  );
  const table = page.getByRole('table', { name: 'Performance by entry purchase multiple' });
  for (const c of rolled.cohorts.byEntryMultiple.filter(
    (x) => x.key !== 'not_calculable' || x.count > 0,
  )) {
    const row = bodyRows(table).filter({
      has: page.getByRole('cell', { name: c.label, exact: true }),
    });
    await expect(row).toContainText(
      `${c.label}${c.count}${money(c.invested)}${money(c.nav)}${money(c.distributions)}${c.grossMoic === null ? '-' : moic(c.grossMoic)}`,
    );
  }
  // It is a different pool from the whole book's.
  expect(rolled.cohorts.byEntryMultiple).not.toEqual(view.cohorts.byEntryMultiple);

  // A shared address opens the same view: realized positions only.
  const realized = view.positions.filter((x) => x.status === 'realized');
  await page.goto('/analytics/value-creation?status=realized');
  await expect(bodyRows(positions(page))).toHaveCount(realized.length);
  await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toContainText(
    'Realized',
  );
  const realizedRoll = valueCreationRollup(realized, view.cohorts, view.asOf);
  await expect(
    page.getByTestId('value-creation-tiles').getByRole('group', { name: 'Our gain' }),
  ).toContainText(money(realizedRoll.portfolio.gain));

  // A filter that leaves no position shows the empty state, never zeros; clearing brings it back.
  await page.goto(
    `/analytics/value-creation?status=realized&vehicleId=${vehicleId}&entryYear=1999`,
  );
  await expect(page.getByText('No position matches these filters')).toBeVisible();
  await expect(page.getByTestId('value-creation-tiles')).toHaveCount(0);
  await expect(page.getByText('$0.0M')).toHaveCount(0);
  await page.getByTestId('value-creation-filters-clear').click();
  await expect(bodyRows(positions(page))).toHaveCount(view.positions.length);
  await expect(page).not.toHaveURL(/vehicleId=/);
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
  if (one.position.gainByDriver !== null && one.position.stake !== null)
    await expect(page.getByTestId('deal-value-creation-ours')).toContainText(
      `at our entry stake of ${pct(one.position.stake)}, ${signed(one.position.gainByDriver.ebitdaGrowth)} from EBITDA growth, ${signed(one.position.gainByDriver.multipleExpansion)} from multiple expansion and ${signed(one.position.gainByDriver.debtPaydown)} from debt paydown, and ${signed(one.position.gainByDriver.other)} from mark and timing`,
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

  // A realized position's bridge and its lines stop at its exit, not at a later quarter.
  const gone = view.positions.find(
    (x) => x.status === 'realized' && x.entry !== null && x.current !== null,
  );
  if (gone === undefined)
    throw new Error('no realized position has an entry and a current quarter');
  expect(gone.exitDate).not.toBeNull();
  expect(gone.current!.periodEnd <= gone.exitDate!).toBe(true);
  const goneSeries = await oneFor(page, 'viewer.one', gone.id);
  expect(goneSeries.series.every((point) => point.periodEnd <= gone.exitDate!)).toBe(true);
  await page.goto(`/portfolio/${gone.id}/performance`);
  await expect(page.getByTestId('deal-value-creation')).toContainText(
    `Entry snapshot ${day(gone.entry!.periodEnd)} to ${day(gone.current!.periodEnd)}`,
  );

  // A forward-dated entry snapshot is named as that.
  const forward = view.positions.find(
    (x) => x.investmentNumber === numberOf('forward_entry_snapshot'),
  );
  if (forward === undefined) throw new Error('the viewer cannot see the forward snapshot position');
  await page.goto(`/portfolio/${forward.id}/performance`);
  await expect(page.getByTestId('deal-value-creation-not-calculable')).toContainText(
    'The entry snapshot is dated after the as-of date.',
  );

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
  // The filter row with a filter set, and the empty state it can lead to.
  await pick(page, 'Status', 'Realized');
  await pick(page, 'Valuation measure', 'Enterprise value');
  await expectNoSeriousViolations(page);
  await page.goto('/analytics/value-creation?entryYear=1999');
  await page.getByText('No position matches these filters').waitFor();
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
