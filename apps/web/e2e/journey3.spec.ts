import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { D, addDays } from '@pb/calc';
import { investmentDetail, valuationLockText, valuationPage } from '@pb/contracts';
import type { ValuationRow } from '@pb/contracts';
import { generateDataset } from '@pb/synthetic';
import { apiCall, latestQuarter, loadDataset, signInAs, switchTo } from './fixtures.js';

/**
 * Critical journey 3 (docs/12 section 3, docs/18 section 1) over the real API: operations starts
 * a Draft for the one active position with no mark for the latest quarter, prepares it from the
 * board; the deal team approves it from the board; an approver locks it from the batch bar and
 * reads the lock text and its hash on the version screen; the one-pager's NAV tile moves to the
 * Locked fair value. The edit after lock: the approver reopens the version with a reason, which
 * opens a new Draft version (v2), marks v1 Reopened, writes a valuation.reopen audit event and
 * takes the one-pager back to the prior Locked mark, since reports read Locked versions only.
 * The alert to the prior approver is an ops.task row the API test checks; the prototype has no
 * tasks page yet (M15), so this journey does not read it.
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });
const quarter = latestQuarter(d);
const METHOD = 'valuation_method.sponsor_mark';
const REASON = 'Journey 3: the sponsor restated the quarter';
/** config/definitions.json priorYearPeriodEndToleranceDays: a mark within these days of the quarter end belongs to it. */
const TOLERANCE_DAYS = 7;

/**
 * $M with one decimal and thousands separators (docs/06 section 3), written independently of
 * src/lib/format.ts so the journey also checks the app's formatter. Rounds half away from zero.
 */
function moneyM(value: string): string {
  const millions = Number(value) / 1_000_000;
  const [whole = '0', frac = '0'] = (Math.round(Math.abs(millions) * 10) / 10)
    .toFixed(1)
    .split('.');
  return `${millions < 0 ? '-' : ''}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}M`;
}

/** A date as the pages show it, for example "Jun 30, 2025". */
const shownDate = (isoDate: string): string =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function userName(externalId: string): string {
  const user = d.users.find((u) => u.externalId === externalId);
  if (user === undefined) throw new Error(`no user ${externalId}`);
  return user.displayName;
}

interface Position {
  id: string;
  investmentNumber: string;
  companyName: string;
  dealType: string;
  /** The latest Locked mark before the quarter: what the one-pager reads until the new version locks. */
  prior: { periodEnd: string; fairValue: string };
}

/**
 * An active position outside the wall, held at the quarter end, with no version of any state in
 * the quarter window, so a new chain may start for it (the API refuses a Locked or in-flight
 * quarter). The dataset's stale_valuation position is built for this (docs/14); any other
 * position meeting the rule would do.
 */
function freshPosition(): Position {
  const walled = new Set(d.scenarios.walled_deal ?? []);
  const windowStart = addDays(quarter, -TOLERANCE_DAYS);
  const inQuarter = (periodEnd: string): boolean => periodEnd > windowStart && periodEnd <= quarter;
  const candidates = full.investments.filter(
    (i) =>
      i.isActive &&
      !walled.has(i.id) &&
      i.entryDate <= quarter &&
      !full.valuations.some((v) => v.investmentId === i.id && inQuarter(v.periodEnd)),
  );
  const stale = d.scenarios.stale_valuation?.[0];
  const inv = candidates.find((i) => i.id === stale) ?? candidates[0];
  if (inv === undefined)
    throw new Error(`no active unwalled position without a mark for ${quarter}`);
  const company = full.portfolioCompanies.find((c) => c.id === inv.portfolioCompanyId);
  const prior = full.valuations
    .filter((v) => v.investmentId === inv.id && v.state === 'Locked' && v.periodEnd < quarter)
    .sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1))[0];
  if (prior === undefined)
    throw new Error(`${inv.investmentNumber} has no Locked mark before ${quarter}`);
  return {
    id: inv.id,
    investmentNumber: inv.investmentNumber,
    companyName: company?.name ?? '',
    dealType: inv.dealType,
    prior: { periodEnd: prior.periodEnd, fairValue: prior.fairValue },
  };
}

const position = freshPosition();
/** Ten percent above the prior mark: a visible change, below nothing the API refuses. */
const FAIR_VALUE = D(position.prior.fairValue).times('1.1').toFixed(2);
/** "Cobalt Energy Group, Jun 30, 2025 v1": how the board and its messages name a version. */
const label = (version: number): string =>
  `${position.companyName}, ${shownDate(quarter)} v${version}`;

const boardStatus = (page: Page) => page.getByTestId('valuation-action-status');
const boardRow = (page: Page) =>
  page
    .getByRole('table', { name: 'Valuations' })
    .getByRole('row')
    .filter({ hasText: position.investmentNumber });

/** The position's versions for the quarter, newest version first (the board order), as the caller sees them. */
async function versions(page: Page, who: string): Promise<ValuationRow[]> {
  const result = await apiCall(
    page,
    'GET',
    `/api/v1/valuations?investmentId=${position.id}&periodEnd=${quarter}`,
    who,
    valuationPage,
  );
  return result.items;
}

/** The one-pager's NAV tile: "Current NAV" for equity, "Fair value" for private credit (docs/06 section 2). */
function navTile(page: Page) {
  const name = position.dealType === 'deal_type.private_credit' ? 'Fair value' : 'Current NAV';
  return page.getByTestId('deal-tiles').getByRole('group', { name, exact: true });
}

async function expectOnePagerNav(page: Page, fairValue: string, lockedOn: string): Promise<void> {
  await page.goto(`/portfolio/${position.id}`);
  await expect(navTile(page)).toContainText(moneyM(fairValue));
  await expect(navTile(page)).toContainText(`Locked ${shownDate(lockedOn)}`);
}

test('operations prepares, the deal team approves and an approver locks a valuation; a reopen after lock creates a new version', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signInAs(page, 'ops.one', d);

  // Before anything: the one-pager reads the prior quarter's Locked mark.
  await expectOnePagerNav(page, position.prior.fairValue, position.prior.periodEnd);

  // The board opens on the latest quarter and lists the position among the missing marks.
  await page.goto('/valuations');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Valuations');
  await expect(page.getByTestId('valuation-gate')).toContainText(
    'Reports read Locked valuations only',
  );
  await expect(page.getByRole('combobox', { name: 'Period' })).toHaveText(shownDate(quarter));
  await expect(page.getByTestId('missing-marks')).toContainText(position.companyName);

  // Start the Draft through the New valuation dialog: position, method and fair value.
  await page.getByRole('button', { name: 'New valuation', exact: true }).click();
  const newDialog = page.getByRole('dialog');
  await expect(newDialog).toContainText('New valuation');
  await newDialog.getByRole('combobox', { name: 'Investment' }).click();
  await page
    .getByRole('option', { name: `${position.investmentNumber} ${position.companyName}` })
    .click();
  await newDialog.getByRole('combobox', { name: 'Method' }).click();
  await page.getByRole('option', { name: /sponsor mark/i }).click();
  await newDialog.getByLabel('Fair value (dollars)').fill(FAIR_VALUE);
  await expect(newDialog).toContainText(`Reads as ${moneyM(FAIR_VALUE)}.`);
  await newDialog.getByRole('button', { name: 'Create draft', exact: true }).click();
  await expect(boardStatus(page)).toContainText(
    `Draft valuation created for ${position.companyName}, ${shownDate(quarter)}`,
  );
  const [draft] = await versions(page, 'ops.one');
  expect(draft, 'the Draft is listed for the quarter').toBeDefined();
  if (draft === undefined) return;
  expect(draft.state).toBe('Draft');
  expect(draft.version).toBe(1);
  expect(draft.method).toBe(METHOD);
  expect(draft.fairValue).toBe(FAIR_VALUE);
  expect(draft.priorFairValue).toBe(position.prior.fairValue);

  // The row is on the board with its figures; the position has left the missing marks.
  const row = boardRow(page);
  await expect(row).toContainText('Draft');
  await expect(row).toContainText(moneyM(FAIR_VALUE));
  await expect(row).toContainText(moneyM(position.prior.fairValue));
  await expect(page.getByTestId('missing-marks')).not.toContainText(position.companyName);

  // Prepare from the row.
  await page.getByRole('button', { name: `Prepare, ${label(1)}`, exact: true }).click();
  await expect(boardStatus(page)).toContainText(`${label(1)} is now Ops prepared (audited)`);
  await expect(row).toContainText('Ops prepared');

  // The deal team approves from the board.
  await switchTo(page, 'deal.one', d);
  await page.goto('/valuations');
  await expect(boardRow(page)).toContainText('Ops prepared');
  await page.getByRole('button', { name: `Deal team approve, ${label(1)}`, exact: true }).click();
  await expect(boardStatus(page)).toContainText(`${label(1)} is now Deal team approved (audited)`);
  await expect(boardRow(page)).toContainText('Deal team approved');

  // The approver locks from the batch bar: select the row, Lock selected.
  await switchTo(page, 'head.one', d);
  await page.goto('/valuations');
  await expect(boardRow(page)).toContainText('Deal team approved');
  const bar = page.getByTestId('valuation-batch-bar');
  await expect(bar).toContainText('0 versions selected');
  await expect(bar.getByRole('button', { name: 'Lock selected', exact: true })).toBeDisabled();
  await page.getByTestId(`valuation-batch-select-${draft.id}`).check();
  await expect(bar).toContainText('1 version selected');
  await bar.getByRole('button', { name: 'Lock selected (1)', exact: true }).click();
  await expect(boardStatus(page)).toContainText('Lock on 1 version: 1 done, 0 refused.');
  await expect(boardRow(page)).toContainText('Locked');
  await expect(boardRow(page)).toContainText(`Approved ${shownDate(d.asOf)}`);
  const [locked] = await versions(page, 'head.one');
  expect(locked?.state).toBe('Locked');
  expect(locked?.approvedBy).toBe(userName('head.one'));
  if (locked === undefined) return;
  const lockText = valuationLockText(locked);
  expect(locked.lockHash).toBe(sha256(lockText));

  // The version screen: the lock text, its hash and the three approvals.
  await page.goto(`/valuations/${draft.id}`);
  await expect(page.getByTestId('valuation-detail')).toBeVisible();
  const banner = page.getByTestId('valuation-banner');
  await expect(banner).toContainText(`${position.companyName}: ${shownDate(quarter)} v1`);
  await expect(banner).toContainText('Locked');
  const tiles = page.getByTestId('valuation-detail-tiles');
  await expect(tiles.getByRole('group', { name: 'Fair value', exact: true })).toContainText(
    moneyM(FAIR_VALUE),
  );
  await expect(tiles.getByRole('group', { name: 'Prior fair value', exact: true })).toContainText(
    moneyM(position.prior.fairValue),
  );
  await expect(tiles.getByRole('group', { name: 'Locked', exact: true })).toContainText(
    shownDate(d.asOf),
  );
  await expect(tiles.getByRole('group', { name: 'Locked', exact: true })).toContainText(
    `By ${userName('head.one')}`,
  );
  await expect(page.getByTestId('valuation-lock-text')).toHaveText(lockText);
  await expect(page.getByTestId('valuation-lock')).toContainText(`Hash: ${locked.lockHash ?? ''}`);
  const approvals = page.getByRole('table', { name: 'Approvals' }).getByRole('row');
  await expect(approvals).toHaveCount(4);
  await expect(approvals.nth(1)).toContainText('Ops prepared');
  await expect(approvals.nth(1)).toContainText(userName('ops.one'));
  await expect(approvals.nth(2)).toContainText('Deal team');
  await expect(approvals.nth(2)).toContainText(userName('deal.one'));
  await expect(approvals.nth(3)).toContainText('Final approval');
  await expect(approvals.nth(3)).toContainText(userName('head.one'));

  // The one-pager now reads the Locked fair value, formatted by the page from the API's number.
  const detail = await apiCall(
    page,
    'GET',
    `/api/v1/investments/${position.id}?asOf=${d.asOf}`,
    'head.one',
    investmentDetail,
  );
  expect(detail.nav).toBe(FAIR_VALUE);
  expect(detail.navDate).toBe(quarter);
  await expectOnePagerNav(page, FAIR_VALUE, quarter);

  // The edit after lock: reopen with a reason from the version screen.
  await page.goto(`/valuations/${draft.id}`);
  const workflow = page.getByTestId('valuation-workflow');
  await workflow.getByRole('button', { name: 'Reopen', exact: true }).click();
  const reasonDialog = page.getByRole('dialog');
  await expect(reasonDialog).toContainText(label(1));
  await reasonDialog.getByLabel('Reason').fill(REASON);
  await reasonDialog.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(page.getByTestId('valuation-action-status')).toContainText(
    `${label(1)} is now Reopened; the new Draft version is ${label(2)} (audited)`,
  );
  const [v2, v1] = await versions(page, 'head.one');
  expect(v2?.state).toBe('Draft');
  expect(v2?.version).toBe(2);
  expect(v2?.fairValue).toBe(FAIR_VALUE);
  expect(v1?.id).toBe(draft.id);
  expect(v1?.state).toBe('Reopened');
  if (v2 === undefined) return;
  const reopened = page.getByTestId('valuation-reopened');
  await expect(reopened).toContainText('Reopened into a new Draft:');
  await expect(reopened.getByRole('link', { name: label(2), exact: true })).toHaveAttribute(
    'href',
    `/valuations/${v2.id}`,
  );
  await expect(banner).toContainText('Reopened');
  await expect(workflow).toContainText(`Reopen reason: ${REASON}`);
  await expect(workflow).toContainText('the work continues on the next Draft version');
  const reopenRow = page
    .getByRole('table', { name: 'Approvals' })
    .getByRole('row')
    .filter({ hasText: REASON });
  await expect(reopenRow).toContainText('Reopen');
  await expect(reopenRow).toContainText(userName('head.one'));

  // The new Draft version carries the figures and waits for operations; an approver cannot prepare it.
  await reopened.getByRole('link', { name: label(2), exact: true }).click();
  await expect(page.getByTestId('valuation-banner')).toContainText(
    `${position.companyName}: ${shownDate(quarter)} v2`,
  );
  await expect(page.getByTestId('valuation-banner')).toContainText('Draft');
  await expect(
    page
      .getByTestId('valuation-detail-tiles')
      .getByRole('group', { name: 'Fair value', exact: true }),
  ).toContainText(moneyM(FAIR_VALUE));
  await expect(page.getByTestId('valuation-lock')).toContainText('Not locked');
  await expect(
    page.getByTestId('valuation-workflow').getByRole('button', { name: 'Prepare', exact: true }),
  ).toBeDisabled();

  // Reports read Locked only: with v1 Reopened and v2 a Draft, the one-pager is back on the prior
  // mark, and its Valuations tab lists both versions with the reopen reason.
  await expectOnePagerNav(page, position.prior.fairValue, position.prior.periodEnd);
  await page.goto(`/portfolio/${position.id}/valuations`);
  const versionRows = page.getByRole('table', { name: 'Valuation versions' }).getByRole('row');
  await expect(versionRows.filter({ hasText: shownDate(quarter) }).first()).toContainText('Draft');
  await expect(versionRows.filter({ hasText: shownDate(quarter) }).nth(1)).toContainText(
    'Reopened',
  );
  await expect(page.getByTestId('deal-valuations')).toContainText(`Reopen reason: ${REASON}`);

  // The audit trail lists the reopen with its reason and actor, and the lock before it.
  await switchTo(page, 'audit.one', d);
  await page.goto('/admin/audit');
  const events = page.getByRole('table', { name: 'Audit events' }).getByRole('row');
  const reopenEvent = events.filter({ hasText: 'valuation.reopen' });
  await expect(reopenEvent).toHaveCount(1);
  await expect(reopenEvent).toContainText(userName('head.one'));
  await expect(reopenEvent).toContainText(REASON);
  await expect(reopenEvent).toContainText(draft.id.slice(0, 8));
  const lockEvent = events.filter({ hasText: 'valuation.lock' });
  await expect(lockEvent).toHaveCount(1);
  await expect(lockEvent).toContainText(userName('head.one'));
  await expect(lockEvent).toContainText(draft.id.slice(0, 8));
});
