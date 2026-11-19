import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { auditPage, canonicalJson, reportPackageDetail, reportPackageList } from '@pb/contracts';
import type { QaFindingRow, ReportPackageDetail } from '@pb/contracts';
import { failingPackageCase, generateDataset } from '@pb/synthetic';
import { apiCall, latestQuarter, loadDataset, settled, signInAs, switchTo } from './fixtures.js';

/**
 * The packages journey (docs/04 M14, docs/18 section 5, decision 0024) over the real API: the
 * package the generator names as failing (`failingPackageCase`: an investor relations user, one
 * of their clients, and the position with no Locked mark at the start of the quarter) is started
 * from the list as final, generated, and fails its checks. The page shows what each failed check
 * expected and found, the line with no begin NAV and no gain (never a zero), and offers no
 * Submit. An approver overrides the failed checks with a reason; investor relations submits; the
 * approver approves and the content hash shows; investor relations releases and the page is
 * read only. The audit trail lists every step with who took it.
 *
 * This is not critical journey 5 of docs/12 (fix data, regenerate with identical layout,
 * release): that one needs the template engine.
 *
 * Order: the specs share one API and one dataset. No other spec starts a package, and this one
 * changes no mark, flow or position, so it leaves what the others read as it found it. How many
 * checks fail depends on what ran before: the valuation journey locks the stale position's mark
 * for the quarter, and the label check then passes. The journey therefore takes the counts from
 * the API's own answer, and asserts by name only the three checks the break position fails
 * whatever ran before it; the label check is read too whenever it failed.
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });
const quarter = latestQuarter(d);
const BASE = '/api/v1/report-packages';
const APPROVER = 'head.one';
const REASON = 'Packages journey: the missing start mark is disclosed in the cover letter';

const found = failingPackageCase(full);
if (found === null) throw new Error('the dataset names no failing package');
const PREPARER = found.user.externalId;
const client = found.client;
const positionNumber = found.positionNumber;
const position = full.investments.find((i) => i.investmentNumber === positionNumber);
const companyName =
  full.portfolioCompanies.find((c) => c.id === position?.portfolioCompanyId)?.name ?? '';
/** An investor relations user who is not entitled to the client. */
const outsider = full.users.find(
  (u) => u.roles.includes('investor_relations') && !u.clientIds.includes(client.id),
);

/** "Q2 2025" from a quarter end, written independently of src/lib/format.ts. */
const shownQuarter = (isoDate: string): string =>
  `Q${Math.ceil(Number(isoDate.slice(5, 7)) / 3)} ${isoDate.slice(0, 4)}`;

/**
 * Dollars to the cent with thousands separators, "$35,100,000.25", written independently of
 * src/lib/format.ts so the journey also checks the app's formatter. Exact below 2^53 cents.
 */
const usdExact = (value: string): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));

const userName = (externalId: string): string => {
  const user = d.users.find((u) => u.externalId === externalId);
  if (user === undefined) throw new Error(`no user ${externalId}`);
  return user.displayName;
};

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** "Client Alpha Pension, Q2 2025, gross, version 1": how the pages and their messages name the package. */
const WORDS = `${client.name}, ${shownQuarter(quarter)}, gross, version 1`;

const read = (page: Page, id: string, who = PREPARER): Promise<ReportPackageDetail> =>
  apiCall(page, 'GET', `${BASE}/${id}`, who, reportPackageDetail);

const status = (page: Page): Locator => page.getByTestId('package-action-status');
const actions = (page: Page): Locator => page.getByTestId('package-actions');
const banner = (page: Page): Locator => page.getByTestId('package-banner');
/** The step of the release gate the package stands on. */
const currentStep = (page: Page): Locator =>
  page.getByRole('list', { name: 'Release gate' }).locator('[aria-current="step"]');

/** Signs in as another user and opens the package again (a switch lands on Home). */
async function openAs(page: Page, externalId: string, id: string): Promise<void> {
  await switchTo(page, externalId, d);
  await page.goto(`/reporting/packages/${id}`);
  await page.getByTestId('package-gate').waitFor();
}

/** The row of the Checks table for one check about one thing. */
const checkRow = (page: Page, check: string, about: string): Locator =>
  page
    .getByRole('table', { name: 'Checks' })
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: check, exact: true }) })
    .filter({ hasText: about });

/** The Result cell of every row the Checks table shows, top to bottom. */
const checkResults = (page: Page): Locator =>
  page.getByRole('table', { name: 'Checks' }).locator('tbody tr td:first-child');

/** The Expected and Found cells of a Checks row (Result, Check, About, Expected, Found, Detail). */
const expectedCell = (row: Locator): Locator => row.getByRole('cell').nth(3);
const foundCell = (row: Locator): Locator => row.getByRole('cell').nth(4);

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

/**
 * Waits for the animations under way to end (a dialog fades in): scanned while it is still half
 * transparent, its text reads as low contrast. One that never ends, a spinner, is not waited for.
 */
async function animationsDone(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}

const failedOf = (detail: ReportPackageDetail): QaFindingRow[] =>
  detail.findings.filter((f) => !f.passed);

test('the packages journey: a failing package is started, overridden with a reason, approved and released', async ({
  page,
}) => {
  test.setTimeout(240_000);
  expect(found.scenario, 'the case is the break position, which no other spec mends').toBe(
    'roll_forward_break',
  );
  expect(companyName).not.toBe('');

  await signInAs(page, PREPARER, d);
  // Nothing is in the way: no package of this client, quarter and basis exists yet.
  const before = await apiCall(page, 'GET', BASE, PREPARER, reportPackageList);
  expect(
    before.items.filter(
      (p) => p.client.id === client.id && p.periodEnd === quarter && p.basis === 'gross',
    ),
  ).toEqual([]);

  /* ---- Investor relations starts the package from the list ---- */
  await page.goto('/reporting/packages');
  await expect(page.getByRole('heading', { name: 'Client packages' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Reporting' })).toContainText('Packages');
  await page.getByTestId('packages-card').getByRole('button', { name: 'Start package' }).click();
  const form = page.getByTestId('package-start-form');
  await form.getByRole('combobox', { name: 'Client' }).click();
  await page.getByRole('option', { name: client.name, exact: true }).click();
  // The latest quarter that has ended is already chosen; there is no as-of field to fill.
  await expect(form.getByRole('combobox', { name: 'Quarter' })).toHaveText(shownQuarter(quarter));
  await expect(form.getByLabel(/as.of/i)).toHaveCount(0);
  await form.getByRole('combobox', { name: 'Basis' }).click();
  await page.getByRole('option', { name: 'Gross', exact: true }).click();
  await form.getByRole('combobox', { name: 'Label' }).click();
  await page.getByRole('option', { name: 'Final', exact: true }).click();
  await form.getByRole('button', { name: 'Start package' }).click();
  await expect(page).toHaveURL(/\/reporting\/packages\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split('/').pop() ?? '';

  // A Draft: no figures and no checks, and the one step open is Generate.
  await expect(banner(page)).toContainText(`${client.name}: ${shownQuarter(quarter)}`);
  await expect(banner(page)).toContainText('Gross');
  await expect(banner(page)).toContainText('Final');
  await expect(banner(page)).toContainText('Version 1');
  await expect(banner(page)).toContainText('Draft');
  await expect(currentStep(page)).toContainText('Draft');
  for (const card of ['package-checks', 'package-positions', 'package-footnotes'])
    await expect(page.getByTestId(card)).toContainText('Not generated yet');
  await expect(page.getByTestId('package-hash')).toHaveCount(0);
  const draft = await read(page, id);
  expect(draft).toMatchObject({
    state: 'Draft',
    version: 1,
    basis: 'gross',
    label: 'final',
    periodEnd: quarter,
    client: { id: client.id, name: client.name },
    preparedBy: { name: userName(PREPARER) },
    content: null,
    findings: [],
    contentHash: null,
    rowVersion: 1,
  });
  await expect(actions(page).getByRole('button')).toHaveText(['Generate']);

  /* ---- Generate: the checks run and fail ---- */
  await actions(page).getByRole('button', { name: 'Generate' }).click();
  await expect(status(page)).toContainText(`${WORDS} is now QA failed`);
  const generated = await read(page, id);
  const failed = failedOf(generated);
  const total = generated.findings.length;
  expect(generated.state).toBe('QAFailed');
  expect(generated.qa).toMatchObject({ runNo: 1, findings: total, failed: failed.length });
  // Two writes, the generation and the system's verdict: the row version moved by two.
  expect(generated.rowVersion).toBe(draft.rowVersion + 2);
  await expect(status(page)).toHaveText(
    `${WORDS} is now QA failed: ${failed.length} of ${total} checks failed in run 1 (audited)`,
  );
  await expect(banner(page)).toContainText('QA failed');
  await expect(currentStep(page)).toContainText('QA failed');

  // The three checks the position fails, with what each expected and found: nothing, shown as
  // the placeholder, never as zero.
  const failedKeys = failed.map((f) => `${f.rule} ${f.entityRef}`);
  for (const rule of ['QA-QTD-01', 'QA-RF-01', 'QA-SIGN-01'])
    expect(failedKeys).toContain(`${rule} ${positionNumber}`);
  const failedRows = page.getByRole('table', { name: 'Checks' }).locator('tbody').getByRole('row');
  await expect(failedRows).toHaveCount(failed.length);
  await expect(checkResults(page)).toHaveText(failed.map(() => 'Failed'));
  const about = `${positionNumber} ${companyName}`;
  for (const [check, detail] of [
    [
      'Quarter starts from the prior locked mark',
      'There is no Locked mark at the end of the prior quarter to start the quarter from.',
    ],
    ['NAV roll-forward', 'The roll-forward cannot be checked. The line has no begin NAV.'],
    ['Gain or loss sign', 'The sign cannot be checked. The line has no begin NAV.'],
  ] as const) {
    const row = checkRow(page, check, about);
    await expect(row, check).toHaveCount(1);
    await expect(row).toContainText('Failed');
    await expect(row).toContainText(detail);
    await expect(expectedCell(row)).toHaveText('-');
    await expect(foundCell(row)).toHaveText('-');
  }
  // The label check fails too while the stale position's mark for the quarter is not Locked.
  const label = failed.find((f) => f.rule === 'QA-LBL-01');
  if (label !== undefined) {
    const row = checkRow(page, 'Preliminary or final, gross or net', 'Preliminary or final label');
    await expect(expectedCell(row)).toHaveText('Preliminary');
    await expect(foundCell(row)).toHaveText('Final');
  }
  // No rule code and no identifier reaches the page.
  const checksText = await page.getByTestId('package-checks').innerText();
  expect(checksText).not.toMatch(/QA-[A-Z]+-\d+/);
  expect(checksText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);

  // A check that passed shows its figures to the cent: the client's share of the position.
  const content = generated.content;
  if (content === null) throw new Error('a generated package has content');
  const line = content.lines.find((l) => l.ref === positionNumber);
  const share = content.clientLines.find((c) => c.ref === positionNumber);
  if (line === undefined || line.endNav === null || share === undefined)
    throw new Error(`the package carries no line and share for ${positionNumber}`);
  expect(line).toMatchObject({ beginNav: null, gainLoss: null, enteredInPeriod: false });
  const passed = total - failed.length;
  await page.getByRole('button', { name: `Show the ${passed} checks that passed` }).click();
  await expect(failedRows).toHaveCount(total);
  const shareRow = checkRow(page, 'Client share of NAV', about);
  await expect(shareRow).toHaveCount(1);
  await expect(shareRow).toContainText('Passed');
  await expect(expectedCell(shareRow)).toHaveText(usdExact(share.nav));
  await expect(foundCell(shareRow)).toHaveText(usdExact(share.nav));
  await expect(foundCell(checkRow(page, 'End NAV on record', about))).toHaveText(
    usdExact(line.endNav),
  );
  await page.getByRole('button', { name: 'Hide the checks that passed' }).click();
  await expect(failedRows).toHaveCount(failed.length);

  // The position's line: no begin NAV and no gain, each saying why, beside the end NAV on record.
  const positions = page.getByTestId('package-positions');
  await expect(positions).toContainText(
    `Built from the positions ${userName(PREPARER)} could read when it was generated.`,
  );
  const lineRow = positions.getByRole('row').filter({ hasText: positionNumber });
  await expect(lineRow.getByRole('rowheader')).toHaveText(about);
  const WHY = 'Not calculable: no locked mark at the start of the quarter';
  for (const cell of [lineRow.getByRole('cell').nth(0), lineRow.getByRole('cell').nth(3)]) {
    await expect(cell).toHaveAttribute('title', WHY);
    await expect(cell).toHaveText(`- ${WHY}`);
  }
  await expect(lineRow.getByRole('cell').nth(5)).toHaveText('Quarter end');
  // The client's share of that position, and the run in the change log.
  await expect(
    page.getByTestId('package-client-share').getByRole('row').filter({ hasText: positionNumber }),
  ).toHaveCount(1);
  const runRow = page.getByTestId('package-change-log').getByRole('row').filter({
    hasText: 'Run 1',
  });
  await expect(runRow).toContainText(userName(PREPARER));
  await expect(runRow.getByRole('cell').nth(2)).toHaveText(String(content.lines.length));
  await expect(runRow.getByRole('cell').nth(3)).toHaveText(String(total));
  await expect(runRow.getByRole('cell').nth(4)).toHaveText(String(failed.length));

  // Submit is not offered while the checks fail. Investor relations may regenerate; the
  // override is an approver's, and the button says so.
  await expect(actions(page).getByRole('button', { name: 'Submit' })).toHaveCount(0);
  await expect(actions(page).getByRole('button', { name: 'Regenerate' })).toBeEnabled();
  const overrideButton = actions(page).getByRole('button', { name: 'Override QA' });
  await expect(overrideButton).toBeDisabled();
  await expect(overrideButton).toHaveAttribute('title', 'Needs approver');
  await expectNoSeriousViolations(page);
  // The same page at phone width: nothing scrolls sideways but the tables, and it still scans clean.
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.getByTestId('package-gate')).toBeVisible();
  await expectNoSeriousViolations(page);
  await page.setViewportSize({ width: 1280, height: 720 });

  /* ---- Who else reads it ---- */
  // Investor relations without the client: the package does not exist for them. A viewer is
  // told whom packages are for. The deal team reads it and is offered nothing it can use.
  if (outsider === undefined) throw new Error('every investor relations user reads this client');
  await switchTo(page, outsider.externalId, d);
  await page.goto(`/reporting/packages/${id}`);
  await expect(page.getByText('Package not found')).toBeVisible();
  await expect(page.getByTestId('package-gate')).toHaveCount(0);
  await switchTo(page, 'viewer.one', d);
  await page.goto(`/reporting/packages/${id}`);
  await expect(page.getByTestId('package-unavailable')).toContainText('not visible to your role');
  await openAs(page, 'deal.one', id);
  await expect(banner(page)).toContainText('QA failed');
  for (const button of await actions(page).getByRole('button').all())
    await expect(button).toBeDisabled();

  /* ---- The approver overrides the failed checks with a reason ---- */
  await openAs(page, APPROVER, id);
  await expect(actions(page).getByRole('button', { name: 'Regenerate' })).toBeDisabled();
  await actions(page).getByRole('button', { name: 'Override QA' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(
    `The reason is recorded against all ${failed.length} failed checks of this run, with your name.`,
  );
  await animationsDone(page);
  await expectNoSeriousViolations(page);
  await dialog.getByRole('textbox', { name: /Reason/ }).fill(REASON);
  await dialog.getByRole('button', { name: 'Override QA' }).click();
  await expect(status(page)).toHaveText(
    `${WORDS} is now QA passed: ${failed.length} failed checks overridden (audited)`,
  );
  await expect(currentStep(page)).toContainText('QA passed by override');
  const override = page.getByTestId('package-override');
  await expect(override).toContainText(
    `${failed.length} failed checks overridden by ${userName(APPROVER)}`,
  );
  await expect(override).toContainText(`Reason: ${REASON}`);
  await expect(checkResults(page)).toHaveText(failed.map(() => 'Overridden'));
  const overridden = await read(page, id, APPROVER);
  expect(overridden.state).toBe('QAPassed');
  expect(overridden.qa).toMatchObject({ failed: failed.length, overridden: failed.length });
  for (const f of failedOf(overridden))
    expect(f.override).toMatchObject({ reason: REASON, approver: { name: userName(APPROVER) } });
  // The figures are what was generated: an override changes no line.
  expect(overridden.content).toEqual(content);

  /* ---- Investor relations submits; the approver approves and the hash shows ---- */
  await openAs(page, PREPARER, id);
  await expect(page.getByTestId('package-next')).toContainText('There is no way back from here');
  await actions(page).getByRole('button', { name: 'Submit' }).click();
  await expect(status(page)).toHaveText(`${WORDS} is now In review (audited)`);
  await expect(currentStep(page)).toContainText('In review');
  // The preparer is not an approver: Approve names the role it needs.
  await expect(actions(page).getByRole('button', { name: 'Approve' })).toBeDisabled();

  await openAs(page, APPROVER, id);
  await expect(page.getByTestId('package-hash')).toHaveCount(0);
  await actions(page).getByRole('button', { name: 'Approve' }).click();
  await expect(status(page)).toHaveText(`${WORDS} is now Approved (audited)`);
  const approved = await read(page, id, APPROVER);
  expect(approved.state).toBe('Approved');
  expect(approved.reviewer?.name).toBe(userName(APPROVER));
  // The hash is taken over the content as stored, and the page shows it in full.
  expect(approved.contentHash).toBe(sha256(canonicalJson(approved.content)));
  expect(approved.content).toEqual(content);
  const hash = page.getByTestId('package-hash');
  await expect(hash).toContainText('Content hash (SHA-256)');
  await expect(hash).toContainText(approved.contentHash ?? 'no hash');
  await expect(hash).toContainText('Taken over everything this package shows, as approved.');
  await expect(page.getByTestId('package-gate')).toContainText(userName(APPROVER));

  /* ---- Investor relations releases; the page is read only ---- */
  await openAs(page, PREPARER, id);
  await actions(page).getByRole('button', { name: 'Release' }).click();
  await expect(status(page)).toHaveText(`${WORDS} is now Released (audited)`);
  await expect(banner(page)).toContainText('Released');
  await expect(currentStep(page)).toContainText('Released');
  await expect(actions(page)).toHaveCount(0);
  await expect(page.getByTestId('package-gate').getByRole('button')).toHaveCount(0);
  await expect(page.getByTestId('package-next')).toContainText('Released packages are read only.');
  const released = await read(page, id);
  expect(released).toMatchObject({
    state: 'Released',
    contentHash: approved.contentHash,
    releasedBy: { name: userName(PREPARER) },
  });
  expect(released.content).toEqual(content);
  await expectNoSeriousViolations(page);
  // A command sent past the page is refused by the API: nothing leaves Released.
  const late = await page.request.post(`${BASE}/${id}/commands`, {
    headers: {
      authorization: `Bearer ${PREPARER}`,
      'if-match': `"${released.rowVersion}"`,
      'idempotency-key': `packages-journey-${id}`,
    },
    data: { command: 'regenerate' },
  });
  expect(late.status()).toBe(409);

  // The list: one row for the package, Released, its checks said as overridden. A new version
  // of it asks for a reason; the journey starts none, so nothing is left in progress.
  await page.goto('/reporting/packages');
  const listRow = page
    .getByRole('table', { name: 'Client packages' })
    .getByRole('row')
    .filter({ hasText: client.name })
    .filter({ hasText: shownQuarter(quarter) })
    .filter({ hasText: 'Gross' });
  await expect(listRow).toHaveCount(1);
  await expect(listRow).toContainText('Released');
  await expect(listRow).toContainText(`${failed.length} failed, overridden`);
  await expect(listRow).toContainText(userName(PREPARER));
  await expectNoSeriousViolations(page);
  await page.getByTestId('packages-card').getByRole('button', { name: 'Start package' }).click();
  await form.getByRole('combobox', { name: 'Client' }).click();
  await page.getByRole('option', { name: client.name, exact: true }).click();
  await form.getByRole('combobox', { name: 'Basis' }).click();
  await page.getByRole('option', { name: 'Gross', exact: true }).click();
  await expect(form.getByRole('textbox', { name: 'Reason for the new version' })).toBeVisible();
  await expect(form).toContainText('Version 1 was released');
  await expect(form.getByRole('button', { name: 'Start new version' })).toBeEnabled();
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);

  /* ---- The audit trail ---- */
  await switchTo(page, 'audit.one', d);
  const audit = await apiCall(
    page,
    'GET',
    `/api/v1/audit/events?entity=rpt.package&entityId=${id}&limit=200`,
    'audit.one',
    auditPage,
  );
  const who = (action: string): (string | null)[] =>
    audit.items.filter((e) => e.action === `report_package.${action}`).map((e) => e.actorName);
  expect(who('create')).toEqual([userName(PREPARER)]);
  expect(who('generate')).toEqual([userName(PREPARER)]);
  expect(who('overrideQa')).toEqual([userName(APPROVER)]);
  expect(who('submit')).toEqual([userName(PREPARER)]);
  expect(who('approve')).toEqual([userName(APPROVER)]);
  expect(who('release')).toEqual([userName(PREPARER)]);
  expect(audit.items.find((e) => e.action === 'report_package.overrideQa')?.reason).toBe(REASON);
  await page.goto('/admin/audit');
  const events = page.getByRole('table', { name: 'Audit events' }).getByRole('row');
  const overrideEvent = events.filter({ hasText: 'report_package.overrideQa' });
  await expect(overrideEvent).toHaveCount(1);
  await expect(overrideEvent).toContainText(userName(APPROVER));
  await expect(overrideEvent).toContainText(REASON);
  await expect(overrideEvent).toContainText(id.slice(0, 8));
  // The auditor reads the released package as it was approved, and is offered nothing.
  await page.goto(`/reporting/packages/${id}`);
  await expect(page.getByTestId('package-hash')).toContainText(approved.contentHash ?? 'no hash');
  await expect(actions(page)).toHaveCount(0);
});
