import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  documentPage,
  extractionRunDetail,
  problemDetails,
  valuationDetail,
  valuationPage,
  valuationRow,
  valuationSuggestionPage,
  valuationSuggestionRow,
} from '@pb/contracts';
import type {
  DocumentSummary,
  ExtractionRun,
  ValuationRow,
  ValuationSuggestionRow,
} from '@pb/contracts';
import { generateDataset, generateDocuments } from '@pb/synthetic';
import {
  apiCall,
  ensureExtractionOn,
  indexDocuments,
  latestQuarter,
  listRuns,
  loadDataset,
  runDetail,
  signInAs,
  startExtractionBatch,
  switchTo,
} from './fixtures.js';

/**
 * Valuation suggestions (docs/04 M10, docs/18 section 14, decision 0023) over the real API: with
 * extraction on, the sponsor report of the position that has no mark for the latest quarter is
 * approved and a suggestion opens, the last Locked mark scaled by the sponsor's equity value; the
 * position's capital account statement is approved and its ending balance replaces that
 * suggestion, the report's indication staying beside it; operations reads the workings with the
 * page each figure came from and opens the draft valuation from it; the draft is on the board
 * and its version screen names the source. Whoever approved the statement cannot approve the
 * valuation; another deal team user does and an approver locks it as a sponsor mark. The deal
 * team reads the suggestion and is offered nothing; a viewer has no tab and sends no request.
 *
 * The specs share one API process, and the valuation journey before this one locks a mark for
 * this very position and quarter. A Locked mark keeps a suggestion from being raised, so the
 * approver first reopens it, as they would when a statement arrives after the lock; the suggested
 * value then goes onto the Draft the reopen started. Run alone, no version exists and the
 * suggestion opens a draft of its own. Either way the valuation ends Locked at the statement's
 * balance. The documents and what they state come from the generator the API is seeded with.
 */
const d = loadDataset();
const full = generateDataset({ profile: 'small', seed: 42 });
const documents = generateDocuments(full);
const quarter = latestQuarter(d);
const SUGGESTIONS = '/api/v1/valuation-suggestions';
const QUARTERLY_FINANCIALS = 'doc_type.quarterly_financials';
const STATEMENT = 'doc_type.capital_account_statement';
const SPONSOR_MARK = 'valuation_method.sponsor_mark';
const REOPEN_REASON = 'The capital account statement arrived after the lock';

const position = (() => {
  const id = d.scenarios.stale_valuation?.[0];
  const inv = d.investments.find((i) => i.id === id);
  const company = d.portfolioCompanies.find((c) => c.id === inv?.portfolioCompanyId);
  if (id === undefined || inv === undefined || company === undefined)
    throw new Error('the dataset has no position without a mark for the latest quarter');
  return { id, investmentNumber: inv.investmentNumber, companyName: company.name };
})();

/** What the generator printed on the position's statement for the quarter. */
const statement = (() => {
  const found = documents.expectations.positionStatements.find(
    (p) => p.investmentId === position.id && p.periodEnd === quarter,
  );
  const endingBalance = found?.endingBalance ?? null;
  if (found === undefined || endingBalance === null)
    throw new Error('the position has no capital account statement for the latest quarter');
  return { fileName: found.fileName, endingBalance };
})();

/** $M with one decimal (docs/06 section 3), written independently of src/lib/format.ts. */
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

const userName = (externalId: string): string =>
  d.users.find((u) => u.externalId === externalId)?.displayName ?? '';

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  expect(serious.map((v) => `${v.id}: ${v.help} (${v.nodes.length})`)).toEqual([]);
}

/** The position's versions that report for the quarter, as an approver sees them. */
async function quarterVersions(page: Page): Promise<ValuationRow[]> {
  const all = await apiCall(
    page,
    'GET',
    `/api/v1/valuations?investmentId=${position.id}&limit=200`,
    'head.one',
    valuationPage,
  );
  return all.items.filter((v) => v.quarterEnd === quarter);
}

const valuationCommand = (
  page: Page,
  who: string,
  id: string,
  body: object,
): Promise<ValuationRow> =>
  apiCall(page, 'POST', `/api/v1/valuations/${id}/commands`, who, valuationRow, body);

/** The position's classified document of a type for the quarter. */
function documentOf(items: readonly DocumentSummary[], docType: string): DocumentSummary {
  const found = items.find(
    (x) => x.docType === docType && x.periodEnd === quarter && x.reviewStatus === 'Classified',
  );
  if (found === undefined) throw new Error(`the position has no ${docType} for ${quarter}`);
  return found;
}

/** A fresh run of one document (a batch covers one document type). */
async function runFor(page: Page, doc: DocumentSummary): Promise<ExtractionRun> {
  const batch = await startExtractionBatch(page, { documentIds: [doc.id] });
  const run = (await listRuns(page, `&batchId=${batch.id}`)).find((r) => r.documentId === doc.id);
  if (run === undefined) throw new Error(`no run for ${doc.fileName}`);
  expect(run.state, doc.fileName).toBe('Succeeded');
  return run;
}

/** Decides every value of a run (clean and flagged accepted, the rest rejected) and approves it. */
async function approveRun(page: Page, who: string, runId: string): Promise<void> {
  const command = (body: unknown) =>
    apiCall(
      page,
      'POST',
      `/api/v1/extraction/runs/${runId}/commands`,
      who,
      extractionRunDetail,
      body,
    );
  for (const v of (await runDetail(page, runId, who)).values) {
    if (v.decision !== null || v.validationState === 'clean') continue;
    await command(
      v.validationState === 'flagged'
        ? { command: 'accept', field: v.field }
        : { command: 'reject', field: v.field, reason: 'Not read in this journey' },
    );
  }
  await command({ command: 'acceptClean' });
  await command({ command: 'approve' });
}

const openSuggestion = async (page: Page, who: string): Promise<ValuationSuggestionRow> => {
  const open = await apiCall(
    page,
    'GET',
    `${SUGGESTIONS}?limit=200&investmentId=${position.id}&periodEnd=${quarter}`,
    who,
    valuationSuggestionPage,
  );
  const [row] = open.items;
  if (row === undefined) throw new Error('no suggestion is open for the position and quarter');
  return row;
};

test('a report then a statement suggest a mark; operations opens the draft from it, and whoever approved the statement cannot approve the valuation', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signInAs(page, 'ops.one', d);
  await ensureExtractionOn(page, d);
  await indexDocuments(page);

  // The quarter as an earlier journey may have left it. A version on its way to approval is sent
  // back or locked, and a Locked mark is reopened by the approver, so that no mark is Locked for
  // the quarter and whatever is in progress for it is a Draft.
  for (const version of await quarterVersions(page)) {
    let { state } = version;
    if (state === 'OpsPrepared')
      await valuationCommand(page, 'ops.one', version.id, {
        command: 'sendBack',
        reason: REOPEN_REASON,
      });
    if (state === 'DealTeamApproved')
      state = (await valuationCommand(page, 'head.one', version.id, { command: 'lock' })).state;
    if (state === 'Locked')
      await valuationCommand(page, 'head.one', version.id, {
        command: 'reopen',
        reason: REOPEN_REASON,
      });
  }
  for (const version of await quarterVersions(page))
    expect(['Draft', 'Reopened'], `${version.periodEnd} v${version.version}`).toContain(
      version.state,
    );

  const own = await apiCall(
    page,
    'GET',
    `/api/v1/documents?limit=200&investmentId=${position.id}`,
    'ops.one',
    documentPage,
  );
  const report = documentOf(own.items, QUARTERLY_FINANCIALS);
  const statementDoc = documentOf(own.items, STATEMENT);
  expect(statementDoc.fileName).toBe(statement.fileName);
  const reportRun = await runFor(page, report);
  const statementRun = await runFor(page, statementDoc);

  // The report first: the last Locked mark scaled by the change in the sponsor's equity value.
  await approveRun(page, 'ops.one', reportRun.id);
  await page.goto(`/documents/extraction/${reportRun.id}`);
  await expect(page.getByTestId('run-suggestion')).toContainText('Valuation suggestion opened');
  const fromReport = await openSuggestion(page, 'ops.one');
  expect(fromReport.basis).toBe('sponsor_equity_value');
  expect(fromReport.suggestedValue).not.toBeNull();
  await page.goto('/valuations/suggestions');
  const table = page.getByTestId('suggestions-table');
  const row = table.getByRole('row').filter({ hasText: position.investmentNumber });
  await expect(row).toContainText(position.companyName);
  await expect(row).toContainText(moneyM(fromReport.suggestedValue ?? ''));
  await expect(row).toContainText('Sponsor report');

  // The statement next, approved by a deal team reviewer: its ending balance is the sponsor's own
  // value of our interest, so it replaces the report's indication, which stays beside it.
  await approveRun(page, 'deal.one', statementRun.id);
  await page.goto(`/documents/extraction/${statementRun.id}`);
  await expect(page.getByTestId('run-suggestion')).toContainText('Valuation suggestion replaced');
  await expect(page.getByTestId('run-relink-note')).toBeVisible();
  const fromStatement = await openSuggestion(page, 'ops.one');
  expect(fromStatement).toMatchObject({
    basis: 'capital_account_balance',
    method: SPONSOR_MARK,
    suggestedValue: statement.endingBalance,
    sourceReviewerIds: [full.users.find((u) => u.externalId === 'deal.one')?.id],
  });
  // The Draft the value would go onto, when one is open for the quarter; none when run alone.
  const onto = fromStatement.inProgress;
  if (onto !== null) expect(onto.state).toBe('Draft');
  expect(fromStatement.crossChecks).toMatchObject([
    { basis: 'sponsor_equity_value', value: fromReport.suggestedValue, differs: false },
  ]);
  const replaced = await apiCall(
    page,
    'GET',
    `${SUGGESTIONS}/${fromReport.id}`,
    'ops.one',
    valuationSuggestionRow,
  );
  expect(replaced).toMatchObject({
    state: 'Superseded',
    supersededReason: 'better_source',
    supersededById: fromStatement.id,
  });

  // The workings: the rule in a sentence, the figure with the page it was read from, the lines
  // that add up and the report's indication beside the statement, never blended into it.
  await page
    .getByTestId('run-suggestion')
    .getByRole('link', { name: 'Open the suggestion' })
    .click();
  const detail = page.getByTestId('suggestion-detail');
  await expect(detail).toBeVisible();
  await expect(page.getByTestId('suggestion-rule')).toContainText('ending capital balance');
  const tiles = page.getByTestId('suggestion-tiles');
  await expect(tiles.getByRole('group', { name: 'Suggested mark', exact: true })).toContainText(
    moneyM(statement.endingBalance),
  );
  await expect(tiles.getByRole('group', { name: 'Suggested mark', exact: true })).toContainText(
    'Sponsor mark',
  );
  await expect(detail).toContainText('The lines add up.');
  await expect(detail.getByRole('list', { name: 'Other sources for this quarter' })).toContainText(
    'Sponsor report',
  );
  await detail.getByRole('button', { name: `From ${statement.fileName}, page 1` }).click();
  await expect(page.getByTestId('suggestion-page-note')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expectNoSeriousViolations(page);

  // Every state: the report's suggestion reads as replaced.
  await page.getByRole('combobox', { name: 'State' }).click();
  await page.getByRole('option', { name: 'All states' }).click();
  await expect(page.getByTestId('suggestions-table')).toContainText('Replaced');

  // With no version for the quarter the board lists the position among the missing marks, with
  // the suggested mark and its source beside it.
  if (onto === null) {
    await page.goto('/valuations');
    const missing = page.getByTestId('missing-marks');
    await expect(missing).toContainText(position.companyName);
    await expect(
      missing.getByRole('link', { name: `suggested mark for ${position.companyName}` }),
    ).toContainText(moneyM(statement.endingBalance));
    await expect(missing).toContainText('Capital account statement');
  }

  // The decision, with its confirmation: a draft of its own, or the Draft already open.
  await page.goto(`/valuations/suggestions?id=${fromStatement.id}`);
  await expect(detail).toBeVisible();
  const action = onto === null ? 'Open a draft valuation' : 'Use this value on the draft';
  await page.getByTestId('suggestion-actions').getByRole('button', { name: action }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(
    onto === null
      ? `This opens a draft valuation at ${moneyM(statement.endingBalance)} for ${shownDate(quarter)}. It still has to be prepared and approved before it is locked.`
      : `This puts ${moneyM(statement.endingBalance)} and the method Sponsor mark on the draft dated ${shownDate(onto.periodEnd)}. The draft keeps its date.`,
  );
  await dialog.getByRole('button', { name: action }).click();
  await expect(page.getByTestId('suggestion-action-status')).toContainText(
    onto === null
      ? `Draft valuation opened at ${moneyM(statement.endingBalance)}`
      : `${moneyM(statement.endingBalance)} and the method Sponsor mark put on the draft`,
  );
  await expect(page.getByTestId('suggestion-decision')).toContainText(
    `Accepted by ${userName('ops.one')}`,
  );

  // The record: the suggestion is Accepted onto a Draft that carries its value, its method and
  // where both came from; a suggestion writes no mark.
  const accepted = await apiCall(
    page,
    'GET',
    `${SUGGESTIONS}/${fromStatement.id}`,
    'ops.one',
    valuationSuggestionRow,
  );
  expect(accepted.state).toBe('Accepted');
  const valuationId = accepted.valuationId ?? '';
  if (onto !== null) expect(valuationId).toBe(onto.valuationId);
  const draft = await apiCall(
    page,
    'GET',
    `/api/v1/valuations/${valuationId}`,
    'ops.one',
    valuationDetail,
  );
  expect(draft).toMatchObject({
    investmentId: position.id,
    periodEnd: onto?.periodEnd ?? quarter,
    state: 'Draft',
    method: SPONSOR_MARK,
    fairValue: statement.endingBalance,
  });
  expect(draft.inputs).toMatchObject({
    'suggestion.id': fromStatement.id,
    'suggestion.basis': 'capital_account_balance',
    'suggestion.value': statement.endingBalance,
    'suggestion.documentId': statementDoc.id,
    'suggestion.page': '1',
    'suggestion.runId': statementRun.id,
  });

  // On the board the draft stands for the quarter; its version screen names the source.
  await page.goto('/valuations');
  const boardRow = page
    .getByRole('table', { name: 'Valuations' })
    .getByRole('row')
    .filter({ hasText: position.investmentNumber })
    .filter({ hasText: 'Draft' });
  await expect(boardRow).toContainText(moneyM(statement.endingBalance));
  await page.goto(`/valuations/${valuationId}`);
  const started = page.getByTestId('valuation-from-suggestion');
  await expect(started).toContainText(
    `Started from a suggestion of ${moneyM(statement.endingBalance)}.`,
  );
  await expect(started).toContainText('Source document, page 1.');
  await expect(started.getByRole('link', { name: 'Source document' })).toHaveAttribute(
    'href',
    `/documents/${statementDoc.id}`,
  );

  // Whoever approved the statement stood behind the figure: they cannot approve the valuation.
  await valuationCommand(page, 'ops.two', valuationId, { command: 'prepare' });
  const barred = await page.request.fetch(`/api/v1/valuations/${valuationId}/commands`, {
    method: 'POST',
    headers: { authorization: 'Bearer deal.one', accept: 'application/json' },
    data: { command: 'dealTeamApprove' },
  });
  expect(barred.status()).toBe(422);
  expect(problemDetails.parse(await barred.json()).detail).toContain(
    'cannot approve the valuation',
  );
  await valuationCommand(page, 'deal.two', valuationId, { command: 'dealTeamApprove' });
  const locked = await valuationCommand(page, 'head.one', valuationId, { command: 'lock' });
  expect(locked).toMatchObject({
    state: 'Locked',
    method: SPONSOR_MARK,
    fairValue: statement.endingBalance,
  });

  // The deal team reads the suggestion and what became of it, and is offered nothing.
  await switchTo(page, 'deal.one', d);
  await page.goto(`/valuations/suggestions?id=${fromStatement.id}`);
  await expect(detail).toBeVisible();
  await expect(page.getByTestId('suggestion-decision')).toContainText('Accepted');
  await expect(page.getByTestId('suggestion-actions')).toHaveCount(0);

  // A viewer has no tab, is told who suggestions are for, and no request is sent for them.
  const requests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('valuation-suggestions')) requests.push(r.url());
  });
  await signInAs(page, 'viewer.one', d);
  await page.goto('/valuations');
  await expect(page.getByTestId('valuation-board')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Valuations' })).not.toContainText(
    'Suggestions',
  );
  await page.goto('/valuations/suggestions');
  await expect(page.getByTestId('suggestions-not-shown')).toBeVisible();
  expect(requests).toEqual([]);
});
