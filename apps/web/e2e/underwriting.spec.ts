import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { D } from '@pb/calc';
import {
  auditPage,
  investmentPerformance,
  investmentValueCreation,
  underwritingRead,
} from '@pb/contracts';
import type { UnderwritingRead } from '@pb/contracts';
import { generateDataset } from '@pb/synthetic';
import { apiCall, loadDataset, signInAs, switchTo } from './fixtures.js';

/**
 * A position against the base case its sponsor underwrote (docs/04 M9, decision 0022), over the
 * real API: a deal team member records the base case through the form on the Performance tab and
 * cannot confirm their own figures, a second deal team member confirms it, and the card then
 * shows where the position stands against the plan. A viewer reads the same card and an approver
 * is offered the retirement and nothing else. A loan is read against the case it was underwritten
 * on: its IRR against plan and its yields, with no company plan, and its own form.
 *
 * The plan is built in the test from the position's own current quarter, as the API answers it
 * at run time (the specs share one API process, and an earlier journey may have promoted a
 * quarter): plan EBITDA of the quarter is 80% of the actual, plan revenue 125% of it and plan net
 * debt the actual itself. So what the card must say is known before anything is recorded: EBITDA
 * 25% ahead of plan, revenue 20% behind it, net debt on plan. Every figure is formatted here
 * independently of src/lib/format.ts.
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });
const walled = new Set(d.scenarios.walled_deal ?? []);
const seeded = new Set((full.underwritingCases ?? []).map((c) => c.investmentId));

/** A held equity co-investment outside every wall with no base case on record in the seed. */
function positionWithoutCase(): { id: string; investmentNumber: string } {
  const found = full.investments.find(
    (i) =>
      i.isActive &&
      i.dealType === 'deal_type.co_invest_equity' &&
      !seeded.has(i.id) &&
      !walled.has(i.id),
  );
  if (found === undefined)
    throw new Error('the dataset has no held equity position without a case');
  return found;
}

/** A held loan that has not reached its maturity: its card carries a yield to maturity. */
function runningLoan(): { id: string; investmentNumber: string } {
  const found = full.investments.find(
    (i) =>
      i.isActive &&
      i.dealType === 'deal_type.private_credit' &&
      !walled.has(i.id) &&
      full.creditTerms.some((t) => t.investmentId === i.id && t.maturityDate > full.asOf),
  );
  if (found === undefined) throw new Error('the dataset has no held loan before its maturity');
  return found;
}

function scenarioId(scenario: string): string {
  const id = full.scenarios[scenario]?.[0];
  if (id === undefined) throw new Error(`the dataset has no ${scenario} position`);
  return id;
}

const nameOf = (externalId: string): string => {
  const user = d.users.find((u) => u.externalId === externalId);
  if (user === undefined) throw new Error(`no user ${externalId}`);
  return user.displayName;
};

const EXIT_DATE = '2028-06-30';
const EXIT_MULTIPLE = '11';
const GROSS_MOIC = '2.5';
const GROSS_IRR_PCT = '20';
const SOURCE_NOTE = 'Sponsor base case model, held in the deal folder';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Jun 30, 2020" from an ISO date. */
const day = (iso: string): string =>
  `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
/** Dollars as $M with one decimal. */
function money(value: string): string {
  const millions = D(value).div(1_000_000);
  return `${millions.isNegative() ? '-' : ''}$${millions.abs().toFixed(1)}M`;
}
/** A change in $M with its sign. */
function signedMoney(value: string): string {
  const text = money(value);
  return text.startsWith('-') || !/[1-9]/.test(text) ? text : `+${text}`;
}
/** Dollars in full with their cents: "$12,848,792.96". */
function dollars(value: string): string {
  const [whole = '0', cents = '00'] = D(value).toFixed(2).split('.');
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}
/** Dollars as the millions the form takes, exactly. */
const millions = (value: string): string => D(value).div(1_000_000).toFixed();
const pct = (value: string, places = 1): string => `${D(value).times(100).toFixed(places)}%`;
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const PLAN_STATUS_LABEL = {
  ahead: 'Ahead of plan',
  on_plan: 'On plan',
  behind: 'Behind plan',
} as const;

const readFor = (page: Page, who: string, id: string): Promise<UnderwritingRead> =>
  apiCall(page, 'GET', `/api/v1/investments/${id}/underwriting`, who, underwritingRead);

const card = (page: Page): Locator => page.getByTestId('deal-underwriting');
const actionStatus = (page: Page): Locator => page.getByTestId('underwriting-action-status');
const tile = (page: Page, name: string): Locator =>
  page.getByTestId('deal-underwriting-tiles').getByRole('group', { name, exact: true });

/** The buttons that change a base case; a reader who only reads is offered none of them. */
const WRITE_BUTTONS = [
  'Record base case',
  'Edit draft',
  'Withdraw draft',
  'Confirm',
  'Revise',
  'Retire',
] as const;

async function expectNoWriteButtons(page: Page, except: readonly string[] = []): Promise<void> {
  for (const name of WRITE_BUTTONS)
    await expect(card(page).getByRole('button', { name, exact: true })).toHaveCount(
      except.includes(name) ? 1 : 0,
    );
}

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

async function openPerformance(page: Page, id: string): Promise<void> {
  await page.goto(`/portfolio/${id}/performance`);
  await expect(card(page)).toBeVisible();
}

test('the deal team records the sponsor base case, a second person confirms it, and the card shows where the position stands', async ({
  page,
}) => {
  const position = positionWithoutCase();
  await signInAs(page, 'deal.one', d);

  // What the plan is built from: the position's entry snapshot and current quarter, as the value
  // creation card carries them today.
  const own = await apiCall(
    page,
    'GET',
    `/api/v1/investments/${position.id}/value-creation`,
    'deal.one',
    investmentValueCreation,
  );
  const entry = own.position?.entry ?? null;
  const current = own.position?.current ?? null;
  if (own.position === null || entry === null || current === null)
    throw new Error(`${position.investmentNumber} has no entry snapshot or no current quarter`);
  const { revenueLtm, ebitdaLtm, netDebt } = current;
  if (
    revenueLtm === null ||
    ebitdaLtm === null ||
    netDebt === null ||
    entry.revenueLtm === null ||
    entry.ebitdaLtm === null ||
    entry.netDebt === null ||
    entry.ev === null
  )
    throw new Error(
      `${position.investmentNumber} lacks a figure at entry or in its current quarter`,
    );
  expect(D(ebitdaLtm).gt(0), 'the current quarter has EBITDA above zero').toBe(true);
  expect(D(netDebt).gt(0), 'the current quarter has net debt above zero').toBe(true);
  expect(entry.periodEnd < current.periodEnd, 'the quarter is after the entry snapshot').toBe(true);
  expect(current.periodEnd < EXIT_DATE, 'the planned exit is after the quarter').toBe(true);
  const caseDate = own.position.entryDate;

  // The plan at the quarter, by construction, and at the planned exit.
  const plan = {
    quarter: {
      revenue: D(revenueLtm).times('1.25').toFixed(2),
      ebitda: D(ebitdaLtm).times('0.8').toFixed(2),
      netDebt: D(netDebt).toFixed(2),
    },
    exit: {
      revenue: D(revenueLtm).times('1.5').toFixed(2),
      ebitda: D(ebitdaLtm).times('1.2').toFixed(2),
      netDebt: D(netDebt).times('0.8').toFixed(2),
    },
  };

  // Nothing is on record yet, and the card says so.
  const before = await readFor(page, 'deal.one', position.id);
  expect(before.form).toBe('equity');
  expect(before.versions).toEqual([]);
  expect(before.notCalculable).toBe('no_case');
  await openPerformance(page, position.id);
  await expect(page.getByTestId('deal-underwriting-empty')).toContainText('No base case recorded.');
  await expect(card(page)).toContainText("Against the sponsor's base case");
  await expectNoWriteButtons(page, ['Record base case']);

  // ---- deal.one records the case: three plan dates, typed in US$ millions ----
  await card(page).getByRole('button', { name: 'Record base case' }).click();
  const form = page.getByRole('form', { name: 'Record the base case' });
  await form.getByRole('button', { name: 'Add a plan date' }).click();
  const figure = (name: string, row: number): Locator =>
    form.getByLabel(`${name} in US$ millions, plan date ${row}`);

  // Asked for the review with nothing typed, the form names what is missing and sends nothing.
  await form.getByRole('button', { name: 'Review figures' }).click();
  await expect(form).toContainText('Give the date of the base case.');
  await expect(page.getByTestId('underwriting-plan-faults')).toContainText(
    'Plan date 1: Give the plan date.',
  );
  await expectNoSeriousViolations(page);

  await form.getByLabel('Case date').fill(caseDate);
  await form.getByLabel('Planned exit').fill(EXIT_DATE);
  await form.getByLabel('Exit multiple').fill(EXIT_MULTIPLE);
  await form.getByLabel('Underwritten gross MOIC').fill(GROSS_MOIC);
  await form.getByLabel('Underwritten gross IRR').fill(GROSS_IRR_PCT);
  await form.getByLabel('Twelve months ending, plan date 1').fill(entry.periodEnd);
  await figure('Revenue', 1).fill(millions(entry.revenueLtm));
  await figure('EBITDA', 1).fill(millions(entry.ebitdaLtm));
  await figure('Net debt', 1).fill(millions(entry.netDebt));
  await form.getByLabel('Twelve months ending, plan date 2').fill(current.periodEnd);
  await figure('Revenue', 2).fill(millions(plan.quarter.revenue));
  await figure('EBITDA', 2).fill(millions(plan.quarter.ebitda));
  await figure('Net debt', 2).fill(millions(plan.quarter.netDebt));
  await figure('Revenue', 3).fill(millions(plan.exit.revenue));
  await figure('EBITDA', 3).fill(millions(plan.exit.ebitda));
  await figure('Net debt', 3).fill(millions(plan.exit.netDebt));
  await form.getByLabel('Where the model is held').fill(SOURCE_NOTE);
  await expect(form).toContainText(`${day(EXIT_DATE)}, the planned exit`);
  await form.getByRole('button', { name: 'Review figures' }).click();

  // The review shows every figure back in dollars in full before anything is saved.
  const review = page.getByTestId('underwriting-review');
  const saved = review.getByRole('table', { name: 'Plan as it will be saved, in dollars' });
  await expect(saved.locator('tbody tr')).toHaveCount(3);
  const savedRow = (iso: string): Locator =>
    saved.locator('tbody tr').filter({ hasText: day(iso) });
  await expect(savedRow(entry.periodEnd)).toContainText(dollars(entry.ebitdaLtm));
  await expect(savedRow(current.periodEnd)).toContainText(dollars(plan.quarter.revenue));
  await expect(savedRow(current.periodEnd)).toContainText(dollars(plan.quarter.ebitda));
  await expect(savedRow(current.periodEnd)).toContainText(dollars(plan.quarter.netDebt));
  await expect(savedRow(EXIT_DATE)).toContainText(dollars(plan.exit.ebitda));
  const terms = review.getByRole('table', { name: 'Terms as they will be saved' });
  await expect(terms).toContainText(day(caseDate));
  await expect(terms).toContainText(`${EXIT_MULTIPLE}x`);
  await expect(terms).toContainText(`${GROSS_IRR_PCT}%`);
  await expect(terms).toContainText(SOURCE_NOTE);
  await expectNoSeriousViolations(page);
  await review.getByRole('button', { name: 'Save draft' }).click();
  await expect(actionStatus(page)).toContainText(
    'Draft recorded: a second person confirms it (audited)',
  );

  // A Draft is not compared, and the person who entered it is told a second person confirms it.
  const draftBlock = page.getByTestId('deal-underwriting-draft');
  await expect(draftBlock).toContainText('Draft base case');
  await expect(draftBlock).toContainText(nameOf('deal.one'));
  await expect(draftBlock).toContainText(SOURCE_NOTE);
  await expect(
    draftBlock.getByRole('table', { name: 'Draft base case, plan' }).locator('tbody tr'),
  ).toHaveCount(3);
  await expect(page.getByTestId('deal-underwriting-empty')).toContainText(
    'A draft base case waits for a second person to confirm it.',
  );
  await expect(page.getByTestId('underwriting-own-figures')).toHaveText(
    'You entered these figures. A second person confirms them.',
  );
  await expect(page.getByTestId('deal-underwriting-tiles')).toHaveCount(0);
  await expectNoWriteButtons(page, ['Edit draft', 'Withdraw draft']);
  await expectNoSeriousViolations(page);

  // The API holds the Draft as typed, to the cent, and compares nothing with it.
  const drafted = await readFor(page, 'deal.one', position.id);
  expect(drafted.notCalculable).toBe('draft_only');
  expect(drafted.comparison).toBeNull();
  const draft = drafted.versions[0];
  if (draft === undefined) throw new Error('the Draft is not on record');
  expect(drafted.versions).toHaveLength(1);
  expect(draft.state).toBe('Draft');
  expect(draft.kind).toBe('entry');
  expect(draft.caseDate).toBe(caseDate);
  expect(draft.plannedExitDate).toBe(EXIT_DATE);
  expect(D(draft.grossIrr).eq('0.2')).toBe(true);
  expect(draft.source.note).toBe(SOURCE_NOTE);
  expect(draft.points.map((p) => [p.periodEnd, p.revenueLtm, p.ebitdaLtm, p.netDebt])).toEqual([
    [
      entry.periodEnd,
      D(entry.revenueLtm).toFixed(2),
      D(entry.ebitdaLtm).toFixed(2),
      D(entry.netDebt).toFixed(2),
    ],
    [current.periodEnd, plan.quarter.revenue, plan.quarter.ebitda, plan.quarter.netDebt],
    [EXIT_DATE, plan.exit.revenue, plan.exit.ebitda, plan.exit.netDebt],
  ]);
  // The rule is the API's, not the page's: the same person's confirmation is refused there too.
  const ownConfirm = await page.request.post(`/api/v1/underwriting-cases/${draft.id}/commands`, {
    headers: { authorization: 'Bearer deal.one', accept: 'application/json' },
    data: { command: 'confirm' },
  });
  expect(ownConfirm.status()).toBe(422);

  // ---- deal.two, the second person, confirms ----
  await switchTo(page, 'deal.two', d);
  await openPerformance(page, position.id);
  await expect(page.getByTestId('underwriting-own-figures')).toHaveCount(0);
  await card(page).getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(actionStatus(page)).toContainText('Base case confirmed (audited)');
  await expect(page.getByTestId('deal-underwriting-tiles')).toBeVisible();
  await expect(page.getByTestId('deal-underwriting-draft')).toHaveCount(0);

  // ---- The card shows where the position stands, as the plan was built to read ----
  await expect(card(page)).toContainText(`Quarter ended ${day(current.periodEnd)}`);
  const ebitda = tile(page, 'EBITDA against plan');
  await expect(ebitda).toContainText('+25.0%');
  await expect(ebitda).toContainText('Ahead of plan');
  await expect(ebitda).toContainText(
    `${money(ebitdaLtm)} against a plan of ${money(plan.quarter.ebitda)}`,
  );
  const revenue = tile(page, 'Revenue against plan');
  await expect(revenue).toContainText('-20.0%');
  await expect(revenue).toContainText('Behind plan');
  await expect(revenue).toContainText(
    `${money(revenueLtm)} against a plan of ${money(plan.quarter.revenue)}`,
  );
  const debt = tile(page, 'Net debt against plan');
  await expect(debt).toContainText('0.0%');
  await expect(debt).not.toContainText('+0.0%');
  await expect(debt).toContainText('On plan');

  // The API's answer is the same reading, and the page shows its returns as it gives them.
  const confirmed = await readFor(page, 'deal.two', position.id);
  const comparison = confirmed.comparison;
  if (comparison === null) throw new Error('the Confirmed case is not compared');
  expect(confirmed.comparedVersion).toBe(1);
  expect(confirmed.notCalculable).toBeNull();
  expect(comparison.quarter).toBe(current.periodEnd);
  expect(comparison.headline).toBe('ahead');
  expect(comparison.metrics.map((m) => [m.metric, m.status, m.interpolated])).toEqual([
    ['ebitda', 'ahead', false],
    ['revenue', 'behind', false],
    ['net_debt', 'on_plan', false],
  ]);
  const version = confirmed.versions[0];
  expect(version?.state).toBe('Confirmed');
  expect(version?.enteredBy.name).toBe(nameOf('deal.one'));
  expect(version?.confirmedBy?.name).toBe(nameOf('deal.two'));

  const { returns } = comparison;
  const irr = tile(page, 'Gross IRR against plan');
  if (returns.grossIrr !== null && returns.irrStatus !== null) {
    await expect(irr).toContainText(PLAN_STATUS_LABEL[returns.irrStatus]);
    await expect(irr).toContainText(`${pct(returns.grossIrr)} against 20.0% underwritten`);
  } else
    for (const label of Object.values(PLAN_STATUS_LABEL))
      await expect(irr).not.toContainText(label);
  const moic = tile(page, 'Gross MOIC');
  await expect(moic).toContainText('2.50x at exit');
  if (returns.grossMoic !== null)
    await expect(moic).toContainText(`${D(returns.grossMoic).toFixed(2)}x`);
  // The MOIC carries no status: only a figure judged against a tolerance is badged.
  for (const label of Object.values(PLAN_STATUS_LABEL)) await expect(moic).not.toContainText(label);

  // The planned bridge is the exit equity value less the entry equity value, worked out here from
  // what was typed, and the share of the planned time is a count of days.
  const plannedTotal = D(EXIT_MULTIPLE)
    .times(plan.exit.ebitda)
    .minus(plan.exit.netDebt)
    .minus(D(entry.ev).minus(entry.netDebt));
  const planned = comparison.valueCreation?.planned ?? null;
  if (planned === null) throw new Error('the Confirmed case has no planned bridge');
  expect(D(planned.total).minus(plannedTotal).abs().lt('0.01')).toBe(true);
  const drivers = page.getByRole('table', { name: 'Value creation against plan' });
  await expect(drivers.locator('tfoot tr')).toContainText(signedMoney(plannedTotal.toFixed(2)));
  for (const column of ['Planned to exit', 'Earned to date', 'Progress'])
    await expect(drivers.getByRole('columnheader', { name: column, exact: true })).toBeVisible();
  const passed =
    daysBetween(entry.periodEnd, current.periodEnd) / daysBetween(entry.periodEnd, EXIT_DATE);
  await expect(page.getByTestId('deal-underwriting-drivers')).toContainText(
    `${(passed * 100).toFixed(0)}% of the planned time has passed.`,
  );

  // The chart leads with EBITDA; the picker moves it to another metric, and the note says what
  // the plan is between two plan dates.
  await expect(page.getByTestId('deal-underwriting-chart')).toContainText(
    'EBITDA, actual and plan',
  );
  await page.getByRole('combobox', { name: 'Metric', exact: true }).click();
  await page.getByRole('option', { name: 'Revenue', exact: true }).click();
  await expect(page.getByTestId('deal-underwriting-chart')).toContainText(
    'Revenue, actual and plan',
  );
  await expect(card(page)).toContainText(
    'Between plan dates the plan is a straight line, not a sponsor figure.',
  );

  // The case itself: its terms, who entered and confirmed it, and its source.
  const block = page.getByTestId('deal-underwriting-case');
  await expect(block).toContainText('Entry case');
  await expect(block).toContainText('Confirmed');
  const caseTerms = block.getByRole('table', { name: 'Entry case, terms' });
  await expect(caseTerms).toContainText(day(caseDate));
  await expect(caseTerms).toContainText(day(EXIT_DATE));
  await expect(caseTerms).toContainText('11.0x');
  await expect(caseTerms).toContainText('2.50x');
  await expect(caseTerms).toContainText('20.0%');
  await expect(caseTerms).toContainText(nameOf('deal.one'));
  await expect(caseTerms).toContainText(nameOf('deal.two'));
  await expect(caseTerms).toContainText(SOURCE_NOTE);
  // The deal team revises a Confirmed case; retiring it is an approver's.
  await expectNoWriteButtons(page, ['Revise']);
  await expectNoSeriousViolations(page);

  // ---- The audit trail holds both steps, each with the person who took it ----
  const trail = await apiCall(
    page,
    'GET',
    `/api/v1/audit/events?entityId=${draft.id}&limit=100`,
    'audit.one',
    auditPage,
  );
  const stepBy = (action: string): (string | null)[] =>
    trail.items.filter((e) => e.action === action).map((e) => e.actorName);
  expect(stepBy('underwriting_case.create')).toEqual([nameOf('deal.one')]);
  expect(stepBy('underwriting_case.confirm')).toEqual([nameOf('deal.two')]);

  // ---- A viewer reads the same card and is offered nothing; an approver may retire the case ----
  await switchTo(page, 'viewer.one', d);
  await openPerformance(page, position.id);
  await expect(tile(page, 'EBITDA against plan')).toContainText('Ahead of plan');
  await expectNoWriteButtons(page);
  await switchTo(page, 'head.one', d);
  await openPerformance(page, position.id);
  await expect(tile(page, 'EBITDA against plan')).toContainText('+25.0%');
  await expectNoWriteButtons(page, ['Retire']);
});

test('a loan is read against the case it was underwritten on: its IRR against plan and its yields, and no company plan', async ({
  page,
}) => {
  const loan = runningLoan();
  await signInAs(page, 'viewer.one', d);
  // What the API answers for the loan today, and the yield its Credit terms show on this page.
  const read = await readFor(page, 'viewer.one', loan.id);
  const comparison = read.comparison;
  const version = read.versions.find((v) => v.version === read.comparedVersion);
  if (comparison === null || version === undefined)
    throw new Error(`${loan.investmentNumber} has no Confirmed base case`);
  const perf = await apiCall(
    page,
    'GET',
    `/api/v1/investments/${loan.id}/performance`,
    'viewer.one',
    investmentPerformance,
  );
  const { underwrittenYield, annualLossRate } = version;
  const ytm = comparison.yieldToMaturity;
  if (ytm === null || underwrittenYield === null || annualLossRate === null)
    throw new Error(`${loan.investmentNumber} lacks a yield or a loss rate`);
  expect(read.form).toBe('credit');
  expect([comparison.metrics, comparison.series, comparison.valueCreation]).toEqual([[], [], null]);
  expect(ytm).toBe(perf.credit?.terms.yieldToMaturity);

  await openPerformance(page, loan.id);
  // The card sits after the terms of the facility and before its quarters.
  const order = await page
    .locator(
      '[data-testid="deal-credit-terms"], [data-testid="deal-underwriting"], [data-testid="deal-credit-quarters"]',
    )
    .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-testid')));
  expect(order).toEqual(['deal-credit-terms', 'deal-underwriting', 'deal-credit-quarters']);
  await expect(card(page)).toContainText(`As of ${day(read.asOf)}`);

  // The IRR is the one figure judged; the yields are shown to two decimals and never badged.
  const tiles = page.getByTestId('deal-underwriting-tiles');
  await expect(tiles.getByRole('group')).toHaveCount(5);
  const { returns } = comparison;
  const irr = tile(page, 'Gross IRR against plan');
  if (returns.grossIrr !== null && returns.irrStatus !== null) {
    await expect(irr).toContainText(PLAN_STATUS_LABEL[returns.irrStatus]);
    await expect(irr).toContainText(
      `${pct(returns.grossIrr)} against ${pct(version.grossIrr)} underwritten`,
    );
  }
  await expect(tile(page, 'Gross MOIC')).toContainText(
    `${D(version.grossMoic).toFixed(2)}x at repayment`,
  );
  await expect(tile(page, 'Yield to maturity')).toContainText(pct(ytm, 2));
  await expect(tile(page, 'Underwritten yield')).toContainText(pct(underwrittenYield, 2));
  await expect(tile(page, 'Underwritten loss rate')).toContainText(pct(annualLossRate, 2));
  for (const name of ['Gross MOIC', 'Yield to maturity', 'Underwritten yield'])
    for (const label of Object.values(PLAN_STATUS_LABEL))
      await expect(tile(page, name)).not.toContainText(label);
  await expect(page.getByTestId('deal-underwriting-yield-note')).toHaveText(
    'Yield to maturity is priced on the fair value of the latest approved credit quarter, which our own mark does not change. It rises when that fair value falls, so it is not judged.',
  );
  // The same yield to maturity as the terms above it: one figure on the page, not two.
  await expect(page.getByRole('table', { name: 'Fees, yield and maturity' })).toContainText(
    pct(ytm, 2),
  );
  // No company plan: no metric against plan, no chart and no drivers.
  await expect(tiles.getByRole('group', { name: 'EBITDA against plan' })).toHaveCount(0);
  await expect(page.getByTestId('deal-underwriting-chart')).toHaveCount(0);
  await expect(page.getByTestId('deal-underwriting-drivers')).toHaveCount(0);
  const terms = page
    .getByTestId('deal-underwriting-case')
    .getByRole('table', { name: 'Entry case, terms' });
  await expect(terms).toContainText(`Expected repayment${day(version.plannedExitDate)}`);
  await expect(terms).not.toContainText('Exit multiple');
  await expectNoWriteButtons(page);
  await expectNoSeriousViolations(page);

  // The deal team revises it in a loan's form, opened on its own rates; left without saving.
  await switchTo(page, 'deal.two', d);
  await openPerformance(page, loan.id);
  await card(page).getByRole('button', { name: 'Revise' }).click();
  const form = page.getByRole('form', { name: 'Revise the base case' });
  await expect(form.getByLabel('Expected repayment')).toHaveValue(version.plannedExitDate);
  await expect(form.getByLabel('Underwritten yield')).toHaveValue(
    D(underwrittenYield).times(100).toFixed(),
  );
  await expect(form.getByLabel('Annual loss rate')).toHaveValue(
    D(annualLossRate).times(100).toFixed(),
  );
  await expect(form.getByLabel('Exit multiple')).toHaveCount(0);
  await expect(form.getByRole('table')).toHaveCount(0);
  await expectNoSeriousViolations(page);
  await form.getByRole('button', { name: 'Cancel' }).click();
  expect((await readFor(page, 'deal.two', loan.id)).versions).toHaveLength(read.versions.length);
});

/**
 * The card's other states at a phone width, on the seeded positions (nothing is written): the
 * comparison of the position seeded ahead of its plan, the Draft that waits with the dialog that
 * asks why it is withdrawn, the form with its review on the position whose case was retired, and
 * a loan's card with its form.
 */
test.describe('at 390 pixels wide', () => {
  test.use({ viewport: { width: 390, height: 900 } });

  test('the base case card, its draft, its form and its review have no serious accessibility issue @a11y', async ({
    page,
  }) => {
    await signInAs(page, 'deal.two', d);

    // The seed's position ahead of its plan: the status the scenario names is on the card.
    const ahead = scenarioId('underwriting_ahead');
    const answer = await readFor(page, 'deal.two', ahead);
    expect(answer.comparison?.headline).toBe('ahead');
    await openPerformance(page, ahead);
    await expect(tile(page, 'EBITDA against plan')).toContainText('Ahead of plan');
    await expectNoSeriousViolations(page);
    // Nothing of the card runs off the side of a phone.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // The seed's Draft, entered by deal.one: deal.two is offered the confirmation, and the
    // withdrawal asks for its reason in a dialog. Closed again, nothing was sent.
    const drafted = scenarioId('underwriting_draft');
    await openPerformance(page, drafted);
    await expect(page.getByTestId('deal-underwriting-draft')).toContainText('Draft base case');
    await expect(card(page).getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
    await expectNoSeriousViolations(page);
    await card(page).getByRole('button', { name: 'Withdraw draft' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('The draft stays on record as withdrawn, with your reason.');
    await expectNoSeriousViolations(page);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect((await readFor(page, 'deal.two', drafted)).versions.map((v) => v.state)).toEqual([
      'Draft',
    ]);

    // The seed's retired case: nothing stands, so a new case can be recorded, and as a later
    // version it says why. The form and its review are scanned, and left without saving.
    const retired = scenarioId('underwriting_withdrawn');
    await openPerformance(page, retired);
    await expect(page.getByTestId('deal-underwriting-empty')).toContainText(
      'No base case stands: what was recorded has been withdrawn.',
    );
    await card(page).getByRole('button', { name: 'Record base case' }).click();
    const form = page.getByRole('form', { name: 'Record the base case' });
    await expect(form.getByLabel('Reason for the revision')).toBeVisible();
    await expectNoSeriousViolations(page);
    await form.getByLabel('Case date').fill('2024-01-31');
    await form.getByLabel('Planned exit').fill(EXIT_DATE);
    await form.getByLabel('Exit multiple').fill(EXIT_MULTIPLE);
    await form.getByLabel('Underwritten gross MOIC').fill(GROSS_MOIC);
    await form.getByLabel('Underwritten gross IRR').fill(GROSS_IRR_PCT);
    await form.getByLabel('Twelve months ending, plan date 1').fill('2023-12-31');
    await form.getByLabel('EBITDA in US$ millions, plan date 1').fill('30');
    await form.getByLabel('EBITDA in US$ millions, plan date 2').fill('42.5');
    await form.getByLabel('Reason for the revision').fill('Entered again from the right model');
    await form.getByRole('button', { name: 'Review figures' }).click();
    const review = page.getByTestId('underwriting-review');
    await expect(review).toContainText('$42,500,000.00');
    await expectNoSeriousViolations(page);
    await review.getByRole('button', { name: 'Back to the form' }).click();
    await expect(form.getByLabel('EBITDA in US$ millions, plan date 2')).toHaveValue('42.5');
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('form', { name: 'Record the base case' })).toHaveCount(0);
    expect((await readFor(page, 'deal.two', retired)).versions.map((v) => v.state)).toEqual([
      'Withdrawn',
    ]);

    // A loan: its five tiles and its terms fit a phone, and so does its form with its review.
    const loan = runningLoan();
    await openPerformance(page, loan.id);
    await expect(page.getByTestId('deal-underwriting-tiles').getByRole('group')).toHaveCount(5);
    await expectNoSeriousViolations(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
    await card(page).getByRole('button', { name: 'Revise' }).click();
    const loanForm = page.getByRole('form', { name: 'Revise the base case' });
    await loanForm.getByLabel('Reason for the revision').fill('Checked against the model again');
    await expectNoSeriousViolations(page);
    await loanForm.getByRole('button', { name: 'Review figures' }).click();
    const loanReview = page.getByTestId('underwriting-review');
    await expect(loanReview).toContainText('Annual loss rate');
    await expect(
      loanReview.getByRole('table', { name: 'Plan as it will be saved, in dollars' }),
    ).toHaveCount(0);
    await expectNoSeriousViolations(page);
    await loanReview.getByRole('button', { name: 'Back to the form' }).click();
    await loanForm.getByRole('button', { name: 'Cancel' }).click();
  });
});
