import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { closingDetail, documentPage, opportunityDetail, problemDetails } from '@pb/contracts';
import type { ClosingDetail, OpportunityDetail } from '@pb/contracts';
import { generateDataset } from '@pb/synthetic';
import { apiCall, indexDocuments, loadDataset, signInAs, switchTo } from './fixtures.js';

/**
 * Critical journey 6 (docs/12 section 3): a deal moves from Sourced to Closed with the diligence
 * gate and the closing checklist (docs/18 sections 4 and 12; docs/04 M5, M7, M8, M22). The deal
 * team advances the sourced deal through Screening, Prescreen and Diligence; the advance to IC is
 * refused while a required task is open and goes through once every required task is done; an
 * approver records the IC decision and advances to Approved; the deal team opens the closing
 * with a close date and a commitment; operations cannot confirm while a required item is open
 * or the allocations do not tie, receives the items, saves allocations that tie exactly,
 * confirms and closes; the new position shows in the grid and its workspace carries the close
 * date, the tasks and the decision. Every refusal is proven twice: on the page (the disabled
 * action names the rule) and at the API (422 workflow-precondition).
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });

function idOf<T>(item: T | undefined, what: string): T {
  if (item === undefined) throw new Error(`the dataset has no ${what}`);
  return item;
}

const sourcedId = idOf(d.scenarios.sourced_deal?.[0], 'sourced deal');
const deal = idOf(
  full.opportunities.find((o) => o.id === sourcedId),
  'opportunity tagged sourced_deal',
);
/** The two vehicles the closing allocates to (the position closes into the one with the larger line). */
const [vehicleA, vehicleB] = full.vehicles;
if (vehicleA === undefined || vehicleB === undefined)
  throw new Error('the dataset has one vehicle');
const ops = idOf(
  d.users.find((u) => u.externalId === 'ops.one'),
  'operations user',
);
/**
 * The close date is the as-of date (the API's clock): the position's entry date follows it, and the
 * portfolio grid lists what was entered by the as-of date. The commitment is the IC amount.
 */
const closeDate = d.asOf;
const commitment = deal.targetCommitment ?? '11000000.00';
const REASON = 'Journey 6: covered by the sponsor materials shared in diligence';

/** A date as the pages show it, for example "Jun 30, 2025". */
const shownDate = (isoDate: string): string =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

const opportunityStatus = (page: Page) => page.getByTestId('opportunity-action-status');
const closingStatus = (page: Page) => page.getByTestId('closing-action-status');
const advanceButton = (page: Page) =>
  page.getByRole('button', { name: `Advance, ${deal.name}`, exact: true });

const detail = (page: Page, who: string): Promise<OpportunityDetail> =>
  apiCall(page, 'GET', `/api/v1/opportunities/${sourcedId}`, who, opportunityDetail);

/** A write the API must refuse: its status and the problem's detail, as the page would show them. */
async function refusal(
  page: Page,
  path: string,
  who: string,
  body: unknown,
): Promise<{ status: number; detail: string }> {
  const res = await page.request.fetch(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${who}`, accept: 'application/json' },
    data: body,
  });
  const problem = problemDetails.parse(await res.json());
  return { status: res.status(), detail: problem.detail ?? '' };
}

/** Advances the deal from the stage actions and waits for the page to say where it is now. */
async function advance(page: Page, to: string): Promise<void> {
  await advanceButton(page).click();
  await expect(opportunityStatus(page)).toContainText(`${deal.name} is now ${to}`);
}

/** Picks an option of a Fluent dropdown by its visible name. */
async function choose(page: Page, combobox: ReturnType<Page['getByRole']>, option: string) {
  await combobox.click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('a deal moves from Sourced to Closed through the diligence gate and the closing checklist, and becomes a position', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signInAs(page, 'deal.one', d);
  // The hub, indexed as operations, supplies the evidence and closing documents (idempotent).
  await indexDocuments(page);
  const documents = await apiCall(
    page,
    'GET',
    '/api/v1/documents?limit=200',
    'ops.one',
    documentPage,
  );
  const documentId = idOf(documents.items[0]?.id, 'document in the hub');

  // The board: the sourced deal sits in the Sourced column; its card opens the opportunity.
  await page.goto('/pipeline');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pipeline');
  const card = page
    .getByTestId('pipeline-column-Sourced')
    .getByTestId(`opportunity-card-${sourcedId}`);
  await expect(card).toContainText(deal.companyName);
  await card.getByRole('link', { name: deal.name }).click();
  await expect(page).toHaveURL(new RegExp(`/pipeline/${sourcedId}$`));
  const banner = page.getByTestId('opportunity-banner');
  await expect(banner).toContainText(`${deal.name}: ${deal.companyName}`);
  await expect(banner).toContainText('Sourced');

  // Sourced > Screening > Prescreen > Diligence: the template tasks of the deal type are listed.
  await advance(page, 'Screening');
  await advance(page, 'Prescreen');
  await advance(page, 'Diligence');
  await expect(banner).toContainText('Diligence');
  const atDiligence = await detail(page, 'deal.one');
  expect(atDiligence.stage).toBe('Diligence');
  const tasks = atDiligence.diligenceTasks;
  expect(tasks.length).toBeGreaterThan(0);
  const required = tasks.filter((t) => t.requiredForIc);
  const optional = tasks.filter((t) => !t.requiredForIc);
  expect(required.length).toBeGreaterThan(0);
  expect(optional.length).toBeGreaterThan(0);
  const taskTable = page
    .getByTestId('diligence-tasks')
    .getByRole('table', { name: 'Diligence tasks' });
  await expect(taskTable.getByRole('row')).toHaveCount(tasks.length + 1);

  // The IC gate: the advance is disabled on the page with the rule, the gates card says so, and
  // the API refuses it (M7 AC: required tasks done or an audited override).
  await expect(advanceButton(page)).toHaveAttribute('title', /required for IC still open/);
  await expect(advanceButton(page)).toBeDisabled();
  await expect(page.getByTestId('opportunity-gates')).toContainText(
    `${required.length} diligence tasks required for IC are still open`,
  );
  await expect(page.getByTestId('opportunity-tiles')).toContainText(String(required.length));
  const gate = await refusal(page, `/api/v1/opportunities/${sourcedId}/commands`, 'deal.one', {
    command: 'advance',
  });
  expect(gate.status).toBe(422);
  expect(gate.detail).toMatch(/required diligence tasks are open/);

  // Every required task is completed from its row (the first with its evidence document); one
  // optional task is waived with a reason, the other stays open and never blocks.
  for (const [i, task] of required.entries()) {
    await page.getByRole('button', { name: `Complete, ${task.title}`, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Complete task');
    if (i === 0) await dialog.getByLabel('Evidence document id').fill(documentId);
    await dialog.getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(opportunityStatus(page)).toContainText(`${task.title} is now Done`);
    await expect(page.getByTestId(`diligence-task-${task.id}`)).toContainText('Done');
  }
  const first = idOf(required[0], 'required task');
  await expect(
    page.getByTestId(`diligence-task-${first.id}`).getByRole('link', { name: 'Document' }),
  ).toHaveAttribute('href', `/documents/${documentId}`);
  const waived = idOf(optional[0], 'optional task');
  await page.getByRole('button', { name: `Waive, ${waived.title}`, exact: true }).click();
  const waiveDialog = page.getByRole('dialog');
  await waiveDialog.getByLabel('Reason').fill(REASON);
  await waiveDialog.getByRole('button', { name: 'Waive', exact: true }).click();
  await expect(opportunityStatus(page)).toContainText(`${waived.title} is now Waived`);
  await expect(page.getByTestId(`diligence-task-${waived.id}`)).toContainText(`Waived: ${REASON}`);
  await expect(page.getByTestId('opportunity-gates')).toContainText(
    'Every diligence task required for IC is done or waived.',
  );

  // Diligence > IC, then the decision gate: the approver records an approved decision.
  await advance(page, 'IC');
  await switchTo(page, 'head.one', d);
  await page.goto(`/pipeline/${sourcedId}`);
  await expect(banner).toContainText('IC');
  await expect(advanceButton(page)).toHaveAttribute('title', 'An IC decision record is required');
  await expect(advanceButton(page)).toBeDisabled();
  const noDecision = await refusal(
    page,
    `/api/v1/opportunities/${sourcedId}/commands`,
    'head.one',
    { command: 'advance' },
  );
  expect(noDecision.status).toBe(422);
  expect(noDecision.detail).toMatch(/IC decision record is required/);
  const icForm = page.getByTestId('ic-decision-form');
  await icForm.getByLabel('Decision date').fill(closeDate);
  await choose(page, icForm.getByRole('combobox', { name: /^Decision/ }), 'Approved');
  await icForm.getByLabel('Amount (dollars)').fill(commitment);
  await icForm.getByLabel('Conditions').fill('Confirmatory legal review complete before signing');
  await icForm.getByRole('button', { name: 'Record decision', exact: true }).click();
  await expect(opportunityStatus(page)).toContainText(
    `IC decision recorded: Approved on ${shownDate(closeDate)}`,
  );
  await expect(page.getByTestId('ic-decisions')).toContainText('Approved');
  await expect(page.getByTestId('opportunity-gates')).toContainText('An IC decision is recorded.');
  await advance(page, 'Approved');

  // Approved > Closing: the deal team opens the closing with the close date and the commitment
  // (prefilled from the IC amount); the checklist opens and the tie-out starts short.
  await switchTo(page, 'deal.one', d);
  await page.goto(`/pipeline/${sourcedId}`);
  await expect(banner).toContainText('Approved');
  await advanceButton(page).click();
  const closingDialog = page.getByRole('dialog');
  await expect(closingDialog).toContainText('Open closing');
  await closingDialog.getByLabel('Close date').fill(closeDate);
  await expect(closingDialog.getByLabel('Commitment (dollars)')).toHaveValue(commitment);
  await closingDialog.getByRole('button', { name: 'Open closing', exact: true }).click();
  await expect(opportunityStatus(page)).toContainText(`${deal.name} is now Closing`);
  await expect(page.getByTestId('opportunity-closing')).toContainText(shownDate(closeDate));
  await expect(page.getByTestId('opportunity-tiles')).toContainText('Short by');
  const atClosing = await detail(page, 'deal.one');
  const closingId = idOf(atClosing.closing?.id, 'closing record');
  expect(atClosing.closing?.allocationTieOut.tiedOut).toBe(false);

  // The closing page as operations: the confirmation is blocked twice over (a required item open,
  // allocations short), on the page and at the API.
  await switchTo(page, 'ops.one', d);
  await page.goto(`/pipeline/${sourcedId}/closing`);
  await expect(page.getByTestId('closing-banner')).toContainText(`Closing: ${deal.name}`);
  const panel = page.getByTestId('closing-panel');
  await expect(panel).toBeVisible();
  const confirm = page.getByTestId('closing-confirm');
  await expect(confirm).toHaveAttribute('title', /required closing item/);
  await expect(confirm).toHaveAttribute('title', /do not tie/);
  await expect(confirm).toBeDisabled();
  await expect(page.getByTestId('closing-blockers').getByRole('listitem')).toHaveCount(2);
  const itemOpen = await refusal(page, `/api/v1/closings/${closingId}/commands`, 'ops.one', {
    command: 'confirm',
  });
  expect(itemOpen.status).toBe(422);
  expect(itemOpen.detail).toMatch(/required closing document is missing/);

  // Every required item is received with the hub document; one optional item is waived with a
  // reason, the other stays open and never blocks.
  const closingBefore: ClosingDetail = await apiCall(
    page,
    'GET',
    `/api/v1/closings/${closingId}`,
    'ops.one',
    closingDetail,
  );
  const requiredItems = closingBefore.items.filter((i) => i.required && i.status === 'open');
  const optionalItems = closingBefore.items.filter((i) => !i.required);
  expect(requiredItems.length).toBeGreaterThan(0);
  expect(optionalItems.length).toBeGreaterThan(0);
  for (const item of requiredItems) {
    await page.getByRole('button', { name: `Receive, ${item.label}`, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Receive item');
    await dialog.getByLabel('Document id').fill(documentId);
    await dialog.getByRole('button', { name: 'Receive', exact: true }).click();
    await expect(closingStatus(page)).toContainText(`${item.label} is now Received`);
    const row = page.getByTestId(`closing-item-${item.itemCode}`);
    await expect(row).toContainText('Received');
    await expect(row.getByRole('link', { name: 'Document' })).toHaveAttribute(
      'href',
      `/documents/${documentId}`,
    );
  }
  const waivedItem = idOf(optionalItems[0], 'optional closing item');
  await page.getByRole('button', { name: `Waive, ${waivedItem.label}`, exact: true }).click();
  const waiveItemDialog = page.getByRole('dialog');
  await waiveItemDialog.getByLabel('Reason').fill(REASON);
  await waiveItemDialog.getByRole('button', { name: 'Waive', exact: true }).click();
  await expect(closingStatus(page)).toContainText(`${waivedItem.label} is now Waived`);
  await expect(page.getByTestId('closing-items')).toContainText(
    `${optionalItems.length - 1} item open, 0 required`,
  );
  await expect(confirm).toHaveAttribute('title', /do not tie/);
  await expect(confirm).not.toHaveAttribute('title', /required closing item/);
  await expect(confirm).toBeDisabled();
  await expect(page.getByTestId('closing-blockers').getByRole('listitem')).toHaveCount(1);
  const shortAllocations = await refusal(
    page,
    `/api/v1/closings/${closingId}/commands`,
    'ops.one',
    { command: 'confirm' },
  );
  expect(shortAllocations.status).toBe(422);
  expect(shortAllocations.detail).toMatch(/allocations do not tie/);

  // The allocations editor on the opportunity page: two vehicle lines that tie to the commitment
  // exactly (received when known, else requested; M22).
  await page.goto(`/pipeline/${sourcedId}`);
  const editor = page.getByTestId('allocations-editor');
  await editor.getByRole('button', { name: 'Add line', exact: true }).click();
  const line1 = page.getByTestId('allocation-row-0');
  await choose(page, line1.getByRole('combobox', { name: 'Vehicle, line 1' }), vehicleA.name);
  await line1.getByLabel('Requested, line 1').fill('10000000.00');
  await line1.getByLabel('Received, line 1').fill('10000000.00');
  await editor.getByRole('button', { name: 'Add line', exact: true }).click();
  const line2 = page.getByTestId('allocation-row-1');
  await choose(page, line2.getByRole('combobox', { name: 'Vehicle, line 2' }), vehicleB.name);
  await line2.getByLabel('Requested, line 2').fill('1000000.00');
  await editor.getByRole('button', { name: 'Save allocations', exact: true }).click();
  await expect(opportunityStatus(page)).toContainText(
    `Allocations saved for ${deal.name}: 2 lines, tied out`,
  );
  await expect(page.getByTestId('opportunity-tiles')).toContainText('Tied out');
  await expect(page.getByTestId('opportunity-gates')).toContainText(
    'Allocations tie to the closing commitment.',
  );

  // Operations confirms the closing, then closes the deal: it becomes a position.
  await page.goto(`/pipeline/${sourcedId}/closing`);
  await expect(page.getByTestId('closing-tie-out')).toContainText('Tied out');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(closingStatus(page)).toContainText(
    `Closing confirmed for ${shownDate(closeDate)}; the record is Ops confirmed`,
  );
  await expect(page.getByTestId('closing-record')).toContainText(ops.displayName);
  await page.goto(`/pipeline/${sourcedId}`);
  await expect(page.getByTestId('opportunity-gates')).toContainText(
    'Every required closing item is received or waived.',
  );
  await advance(page, 'Closed and converted into a position');
  const closed = await detail(page, 'ops.one');
  expect(closed.stage).toBe('Closed');
  const investmentId = idOf(closed.investmentId ?? undefined, 'position the deal converted into');
  await expect(
    page.getByTestId('opportunity-workflow').getByRole('link', { name: 'open the deal workspace' }),
  ).toHaveAttribute('href', `/portfolio/${investmentId}`);

  // The new position: in the grid by its company name, and its workspace carries the close date
  // on the Closing tab and the tasks and decision on the Diligence tab, read only.
  await page.goto('/portfolio');
  await expect(page.getByTestId('portfolio-grid')).toBeVisible();
  await page.getByLabel('Search').fill(deal.companyName);
  await expect(page.getByTestId('portfolio-count')).toHaveText(/^1 of \d+ positions shown$/);
  await expect(page.getByTestId('portfolio-grid')).toContainText(deal.companyName);
  await page.goto(`/portfolio/${investmentId}/closing`);
  await expect(page.getByTestId('detail-banner')).toContainText(deal.companyName);
  await expect(page.getByTestId('closing-close-date')).toContainText(shownDate(closeDate));
  await expect(page.getByTestId('closing-record')).toContainText('Ops confirmed');
  await page.goto(`/portfolio/${investmentId}/diligence`);
  await expect(
    page
      .getByTestId('diligence-tasks')
      .getByRole('table', { name: 'Diligence tasks' })
      .getByRole('row'),
  ).toHaveCount(tasks.length + 1);
  await expect(page.getByTestId('ic-decisions')).toContainText('Approved');
});
