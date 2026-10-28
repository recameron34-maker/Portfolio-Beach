import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addDays } from '@pb/calc';
import { problemDetails } from '@pb/contracts';
import { generateDataset } from '@pb/synthetic';
import { loadDataset, signInAs, switchTo } from './fixtures.js';

/**
 * Critical journey 4 (docs/12 section 3, docs/18 sections 3 and 11, SEC-12) over the real API:
 * the `wire_change` capital call arrives with a second, unverified wire instruction. Operations
 * reviews it and drafts the trade ticket; the release is blocked by the changed instruction (and,
 * for the preparer, by dual control); the proposer cannot make the callback; a second operations
 * person verifies the new version by callback in the wire register, which lifts the hold; the
 * approver releases the ticket; operations confirms funding and reconciles, and the approved
 * contribution appears in the notice's cash flows and on the trade tickets page. Every id and
 * figure comes from the dataset the API is seeded with (small profile, seed 42), never from a
 * screen scrape, so the expectations name what the pages must show.
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });

const notice = full.capitalNotices.find((n) => n.scenarioTag === 'wire_change');
if (notice === undefined) throw new Error('the dataset has no wire_change notice');
const investment = full.investments.find((i) => i.id === notice.investmentId);
if (investment === undefined) throw new Error('the wire_change notice names no investment');
const company = full.portfolioCompanies.find((c) => c.id === investment.portfolioCompanyId);
const fund = full.sponsorFunds.find((f) => f.id === investment.sponsorFundId);
if (company === undefined || fund === undefined)
  throw new Error('the wire_change investment has no company or sponsor fund');
const versions = full.wireInstructions.filter((w) => w.sponsorFundId === fund.id);
const v1 = versions.find((w) => w.version === 1);
const v2 = versions.find((w) => w.version === 2);
if (v1 === undefined || v2 === undefined)
  throw new Error('the wire_change fund has no first and second instruction versions');

const HOLD_DAYS = 30;
/** The second-person rule as the page words it on the disabled button (wires.ts, SEC-12.2). */
const SECOND_PERSON_RULE =
  'The callback must be made by a person other than the proposer (SEC-12.2)';
const CHANGED_WITHIN_HOLD =
  "The wire instructions changed within the hold window and wait for a second person's callback (SEC-12.3).";
const SAME_PERSON = 'You prepared this ticket; a different person must approve it (SEC-12.3).';

const user = (externalId: string): string => {
  const u = d.users.find((x) => x.externalId === externalId);
  if (u === undefined) throw new Error(`no user ${externalId}`);
  return u.displayName;
};

/** "<bank name> ****<last four digits>": the masked form every role sees (SEC-12.2). */
const masked = (w: { bankDetails: { bankName: string; accountNumber: string } }): string =>
  `${w.bankDetails.bankName} ****${w.bankDetails.accountNumber.slice(-4)}`;

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

const noticeStatus = (page: Page) => page.getByTestId('notice-action-status');

/** Chooses an option of a Fluent dropdown by the label its field gives it. */
async function pick(page: Page, combobox: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: combobox }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** Issues a notice command from the Workflow card (one button per command the table lists). */
async function issue(page: Page, label: string): Promise<void> {
  await page
    .getByTestId('notice-workflow')
    .getByRole('button', { name: label, exact: true })
    .click();
}

test('operations reviews the call and drafts the ticket; the changed wire blocks the release until a second person verifies it; the approver releases; operations funds and reconciles', async ({
  page,
}) => {
  test.setTimeout(240_000);
  expect(d.scenarios.wire_change?.[0], 'the scenario names the investment').toBe(investment.id);
  expect(v1.state).toBe('Verified');
  expect(v2.state).toBe('Proposed');

  // The notice as operations: both SEC-12.4 alerts, the hold, the seeded Drafted ticket and
  // every reason the release is blocked for the person who drafted it.
  await signInAs(page, 'ops.one', d);
  await page.goto(`/capital-activity/${notice.id}`);
  const banner = page.getByTestId('notice-banner');
  await expect(banner).toContainText(`Capital call: ${company.name}`);
  await expect(banner).toContainText('Extracted');
  const alerts = page.getByTestId('notice-alerts');
  await expect(alerts).toContainText('Wire changed');
  await expect(alerts).toContainText('Urgency language');
  await expect(alerts.getByRole('listitem')).toHaveCount(2);
  const hold = page.getByTestId('wire-hold');
  await expect(hold).toContainText(
    `Ticket approval is held until ${shownDate(addDays(d.asOf, HOLD_DAYS))} (${HOLD_DAYS} days, SEC-12.3)`,
  );
  const ticketPanel = page.getByTestId('ticket-panel');
  await expect(ticketPanel).toContainText('Drafted');
  await expect(ticketPanel).toContainText(moneyM(notice.amount));
  const release = page.getByTestId('ticket-release');
  await expect(release).toContainText('Release is blocked:');
  await expect(release.getByRole('listitem')).toHaveCount(2);
  await expect(release).toContainText(CHANGED_WITHIN_HOLD);
  await expect(release).toContainText(SAME_PERSON);
  const wireCard = page.getByTestId('notice-wire');
  await expect(wireCard).toContainText(fund.name);
  await expect(wireCard).toContainText('Version 1');
  await expect(wireCard).toContainText('Verified');
  await expect(wireCard).toContainText(masked(v1));
  await expect(page.getByTestId('notice-cash-flows')).toContainText('No cash flows yet');

  // Review, then draft the ticket through the dialog (the seeded ticket is re-drafted, never a second one).
  await issue(page, 'Review');
  await expect(noticeStatus(page)).toContainText(
    `Capital call for ${company.name} is now Reviewed (audited)`,
  );
  await expect(banner).toContainText('Reviewed');
  await issue(page, 'Draft ticket');
  const draft = page.getByTestId('draft-ticket-form');
  await expect(draft.getByLabel('Funding date')).toHaveValue(notice.dueDate);
  await expect(draft.getByLabel('Amount (USD)')).toHaveValue(notice.amount);
  // The wire goes on the as-of date: the reconciliation dates the cash flow at the funding date,
  // and the notice's readers see flows up to the as-of date only (the as-of bound).
  await draft.getByLabel('Funding date').fill(d.asOf);
  await draft.getByRole('button', { name: 'Draft ticket', exact: true }).click();
  await expect(noticeStatus(page)).toContainText(
    `Capital call for ${company.name} is now Ticket drafted (audited)`,
  );
  await expect(banner).toContainText('Ticket drafted');
  await expect(ticketPanel).toContainText('Drafted');
  await expect(ticketPanel).toContainText(user('ops.one'));
  await expect(ticketPanel).toContainText(shownDate(d.asOf));
  await expect(release.getByRole('listitem')).toHaveCount(2);

  // Dual control (SEC-12.3): the preparer's own approval is refused by the rule, in the status region.
  await issue(page, 'Approve ticket');
  await expect(noticeStatus(page)).toContainText('Approve ticket: Blocked by a rule.');
  await expect(noticeStatus(page)).toContainText('preparer cannot approve it (SEC-12.3)');
  await expect(banner).toContainText('Ticket drafted');

  // The approver is held by the changed instruction until a second person's callback.
  await switchTo(page, 'head.one', d);
  await page.goto(`/capital-activity/${notice.id}`);
  await expect(release.getByRole('listitem')).toHaveCount(1);
  await expect(release).toContainText(CHANGED_WITHIN_HOLD);
  await issue(page, 'Approve ticket');
  await expect(noticeStatus(page)).toContainText(
    'Approve ticket: Blocked by a rule. The wire instruction changed recently and needs a second approval (SEC-12.3)',
  );
  await expect(banner).toContainText('Ticket drafted');

  // The register as the proposer: the Proposed version is found by its state, and the proposer
  // cannot make the callback (SEC-12.2): the page disables the submit with the rule, and the API
  // refuses the same command with the same rule should the page be bypassed.
  await switchTo(page, 'ops.one', d);
  await page.goto('/capital-activity/wires');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Wire instruction register');
  const count = page.getByTestId('wire-count');
  await expect(count).toContainText(`${full.wireInstructions.length} versions shown`);
  await expect(count).toContainText('1 version waiting for a callback');
  await pick(page, 'State', 'Proposed');
  const register = page.getByRole('table', { name: 'Wire instructions' });
  await expect(register.getByRole('row')).toHaveCount(2);
  const proposedRow = register.getByRole('row').nth(1);
  await expect(proposedRow).toContainText(fund.name);
  await expect(proposedRow).toContainText('Version 2');
  await expect(proposedRow).toContainText('Proposed');
  await expect(proposedRow).toContainText(masked(v2));
  await expect(proposedRow).toContainText(user('ops.one'));
  await expect(count).toContainText('1 version shown');
  await proposedRow.getByRole('link', { name: fund.name }).click();
  await expect(page).toHaveURL(new RegExp(`/capital-activity/wires/${v2.id}$`));
  const wireBanner = page.getByTestId('wire-banner');
  await expect(wireBanner).toContainText(`${fund.name}: version 2`);
  await expect(wireBanner).toContainText('Proposed');
  await expect(page.getByTestId('wire-masked')).toHaveText(masked(v2));
  const callback = page.getByTestId('wire-callback-form');
  await pick(page, 'Number source', 'Prior instruction on file');
  await pick(page, 'Result', 'Confirmed');
  const ownVerify = callback.getByRole('button', {
    name: 'Record callback and verify',
    exact: true,
  });
  await expect(ownVerify).toBeDisabled();
  await expect(ownVerify).toHaveAttribute('title', SECOND_PERSON_RULE);
  const refusal = await page.request.post(`/api/v1/wire-instructions/${v2.id}/commands`, {
    headers: { authorization: 'Bearer ops.one', accept: 'application/json' },
    data: {
      command: 'verify',
      callbackNumberSource: 'prior_instruction',
      callbackResult: 'confirmed',
    },
  });
  expect(refusal.status()).toBe(422);
  const problem = problemDetails.parse(await refusal.json());
  expect(problem.detail).toContain('other than the proposer');
  expect(problem.detail).toContain('SEC-12.2');

  // A second operations person reads the clear details (audited), makes the callback from the
  // prior instruction on file and verifies the version: it becomes the active one and the first
  // version is superseded.
  await switchTo(page, 'ops.two', d);
  await page.goto(`/capital-activity/wires/${v2.id}`);
  const reveal = page.getByTestId('wire-details-reveal');
  await expect(reveal).toHaveText('Show bank details');
  await reveal.click();
  const details = page.getByTestId('wire-instruction');
  await expect(details).toContainText(v2.bankDetails.accountNumber);
  await expect(details).toContainText(v2.bankDetails.routingCode);
  await expect(page.getByTestId('wire-details-note')).toContainText('SEC-11.1');
  await pick(page, 'Number source', 'Prior instruction on file');
  await pick(page, 'Result', 'Confirmed');
  await callback.getByRole('button', { name: 'Record callback and verify', exact: true }).click();
  await expect(page.getByTestId('wire-action-status')).toContainText(
    `Version 2 for ${fund.name} is now Verified and active (audited)`,
  );
  await expect(wireBanner).toContainText('Verified');
  await expect(wireBanner).toContainText('Active');
  await expect(callback).toHaveCount(0);
  await expect(page.getByTestId('wire-callback')).toContainText(user('ops.two'));
  await expect(page.getByTestId('wire-callback')).toContainText('Prior instruction on file');
  const history = page.getByRole('table', { name: 'Versions of this counterparty' });
  await expect(history.getByRole('row').filter({ hasText: 'Version 1' })).toContainText(
    'Superseded',
  );
  await expect(history.getByRole('row').filter({ hasText: 'Version 2' })).toContainText('Active');
  await page.goto('/capital-activity/wires');
  await expect(count).toContainText('0 versions waiting for a callback');

  // The hold is lifted: the approver releases the ticket against version 2.
  await switchTo(page, 'head.one', d);
  await page.goto(`/capital-activity/${notice.id}`);
  await expect(release).toContainText('Release allowed');
  await expect(hold).toHaveCount(0);
  await expect(wireCard).toContainText('Version 2');
  await expect(wireCard).toContainText(masked(v2));
  await expect(wireCard).toContainText(user('ops.two'));
  await expect(alerts).toContainText('Wire changed');
  await issue(page, 'Approve ticket');
  await expect(noticeStatus(page)).toContainText(
    `Capital call for ${company.name} is now Ticket approved (audited)`,
  );
  await expect(banner).toContainText('Ticket approved');
  await expect(ticketPanel).toContainText('Approved');
  await expect(ticketPanel).toContainText(user('head.one'));
  await expect(ticketPanel).toContainText('Version 2');
  await expect(ticketPanel).toContainText(masked(v2));

  // Operations confirms funding and reconciles: the one approved contribution, sourced to the notice.
  await switchTo(page, 'ops.one', d);
  await page.goto(`/capital-activity/${notice.id}`);
  await issue(page, 'Confirm funding');
  await expect(noticeStatus(page)).toContainText(
    `Capital call for ${company.name} is now Funded (audited)`,
  );
  await expect(ticketPanel).toContainText('Funded');
  await expect(release).toContainText('Nothing to release: the ticket is Funded.');
  await issue(page, 'Reconcile');
  await expect(noticeStatus(page)).toContainText(
    `Capital call for ${company.name} is now Reconciled (audited)`,
  );
  await expect(banner).toContainText('Reconciled');
  await expect(page.getByTestId('notice-workflow')).toContainText(
    'Reconciled is the last step; nothing further to do.',
  );
  const flows = page.getByRole('table', { name: 'Cash flows created' });
  await expect(flows.getByRole('row')).toHaveCount(2);
  const flow = flows.getByRole('row').nth(1);
  await expect(flow).toContainText(shownDate(d.asOf));
  await expect(flow).toContainText('Contribution');
  await expect(flow).toContainText(moneyM(`-${notice.amount}`));
  await expect(flow).toContainText('Approved');
  await expect(
    page.getByTestId('notice-tiles').getByRole('group', { name: 'Settled' }),
  ).toContainText(moneyM(notice.amount));

  // The trade tickets page lists the ticket as Funded against version 2, approved by the approver.
  await page.goto('/capital-activity/tickets');
  const tickets = page.getByRole('table', { name: 'Trade tickets' });
  const ticketRow = tickets.getByRole('row').filter({ hasText: `Version 2: ${masked(v2)}` });
  await expect(ticketRow).toHaveCount(1);
  await expect(ticketRow).toContainText(`Capital call: ${company.name}`);
  await expect(ticketRow).toContainText('Funded');
  await expect(ticketRow).toContainText(user('head.one'));
});
