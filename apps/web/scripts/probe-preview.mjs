// Serves dist-preview statically and walks it in headless Chromium: journey 1 against the recorded
// preview, every route of src/app/router.tsx for six users with the recording-miss detector, and
// the simulated workflow journeys at the API level inside the page. One line per check, a summary,
// and a non-zero exit on any failure. Checks that need recordings an endpoint has not produced yet
// (it answered 501 when the preview was built) are skipped with a line that says so.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';
import { addDays, latestQuarterEndOnOrBefore, toDollars } from '@pb/calc';
import { accountingExports, generateDataset } from '@pb/synthetic';
import { keyFor } from './preview-plan.mjs';

const root = resolve(process.env.PB_PREVIEW_OUT ?? 'dist-preview');
const shell = join(root, 'index.html');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};
function requestedPath(url) {
  try {
    return resolve(root, `.${decodeURIComponent(url.split('?')[0])}`);
  } catch {
    return shell;
  }
}
const server = createServer((req, res) => {
  // Only files inside the preview directory are served; anything else (including path traversal
  // and unknown routes) gets the app shell, as a static host would.
  const requested = requestedPath(req.url ?? '/');
  const inside = requested.startsWith(root + sep);
  const file =
    inside && existsSync(requested) && !statSync(requested).isDirectory() ? requested : shell;
  res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

/** Sends a raw request path (fetch would normalize the dot segments away before sending). */
function rawGet(path) {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => done({ type: res.headers['content-type'], body }));
    });
    req.on('error', fail);
    req.end();
  });
}

const d = generateDataset({ profile: 'small', seed: 42 });
const walledId = d.scenarios.walled_deal[0];
const walledName = d.portfolioCompanies.find(
  (c) => c.id === d.investments.find((i) => i.id === walledId).portfolioCompanyId,
).name;
const by = (id) => d.users.find((u) => u.externalId === id);

/** What the build recorded for a credential's GET, read straight from fixtures.json. */
const fixtures = JSON.parse(readFileSync(join(root, 'preview', 'fixtures.json'), 'utf8'));
/** The book the simulated intakes work over, for the dates and names of the bundled samples. */
const book = JSON.parse(readFileSync(join(root, 'preview', 'book.json'), 'utf8'));
/** The thresholds the pages and the simulation read (config/definitions.json). */
const definitions = JSON.parse(
  readFileSync(new URL('../../../config/definitions.json', import.meta.url), 'utf8'),
);
function recorded(credential, path) {
  const response = fixtures.responses[keyFor(credential, 'GET', path)];
  if (response === undefined) return { status: undefined, json: undefined };
  const text = fixtures.bodies[response.body];
  return { status: response.status, json: response.status === 200 ? JSON.parse(text) : undefined };
}

const results = [];
const check = (name, ok, detail = '') =>
  results.push({ status: ok ? 'PASS' : 'FAIL', name, detail });
const skip = (name, reason) => results.push({ status: 'SKIP', name, detail: reason });
const NOT_RECORDED = 'skipped: endpoint not recorded';

const browser = await chromium.launch(
  process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
);
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

async function signIn(externalId) {
  await page.goto(`${origin}/#/sign-in`);
  await page.getByRole('button', { name: new RegExp(by(externalId).displayName) }).click();
  await page
    .getByTestId('current-user')
    .filter({ hasText: by(externalId).displayName })
    .waitFor();
}

/**
 * The shim answers inside the page, so these requests never reach the network: wait until it has
 * nothing in flight and has answered nothing new for a quiet spell.
 */
async function settle(quietMs = 350, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    const a = await page.evaluate(
      () => globalThis.__pbPreviewActivity ?? { inflight: 0, total: 0 },
    );
    if (a.inflight > 0 || a.total !== last) {
      last = a.total;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) return;
    await page.waitForTimeout(50);
  }
  throw new Error('the page did not settle');
}

const misses = () => page.evaluate(() => [...(globalThis.__pbPreviewMisses ?? [])]);

// ---- Static server and journey 1 (the original checks) ------------------------------------

for (const path of ['/../package.json', '/%2e%2e/package.json', '/assets/../../package.json']) {
  const r = await rawGet(path);
  check(
    `server: ${path} stays inside the preview directory`,
    r.type === 'text/html' && !r.body.includes('"name": "@pb/web"'),
  );
}

await page.goto(`${origin}/#/portfolio`);
await page.waitForURL(/#\/sign-in$/);
check('anonymous redirected to sign-in', page.url().includes('#/sign-in'));
await signIn('viewer.one');
check(
  'mock identity banner shown',
  await page
    .getByRole('status')
    .first()
    .innerText()
    .then((t) => t.includes('synthetic data only')),
);
await page.goto(`${origin}/#/portfolio`);
await page.getByTestId('portfolio-count').waitFor();
const viewerGrid = await page.getByTestId('portfolio-grid').innerText();
check(
  'viewer: grid rendered with positions',
  (await page.getByTestId('portfolio-count').innerText()).includes('positions shown'),
);
check('viewer: walled deal absent', !viewerGrid.includes(walledName), walledName);
await page.goto(`${origin}/#/portfolio/${walledId}`);
await page.getByTestId('error-state').waitFor();
check(
  'viewer: walled detail is not found',
  ((await page.getByTestId('error-state').textContent()) ?? '').includes('Investment not found'),
);
await page.goto(`${origin}/#/data/health`);
await page.getByTestId('data-health-tiles').waitFor();
check('viewer: data health renders', true);
await page.goto(`${origin}/#/data/dictionary`);
await page.getByRole('table', { name: 'Definitions' }).waitFor();
check('viewer: data dictionary renders', true);

await signIn('deal.three');
await page.goto(`${origin}/#/portfolio`);
await page.getByTestId('portfolio-count').waitFor();
check(
  'wall member: walled deal present',
  (await page.getByTestId('portfolio-grid').innerText()).includes(walledName),
);
await page.goto(`${origin}/#/portfolio/${walledId}`);
await page.getByTestId('detail-banner').waitFor();
check(
  'wall member: one-pager opens',
  (await page.getByTestId('detail-banner').innerText()).includes(walledName),
);
check(
  'one-pager: valuations table',
  await page.getByRole('table', { name: 'Valuations' }).isVisible(),
);

const credit = d.investments.find((i) => i.dealType === 'deal_type.private_credit' && i.isActive);
await page.goto(`${origin}/#/portfolio/${credit.id}`);
await page.getByTestId('detail-banner').waitFor();
check(
  'credit one-pager shows credit terms',
  await page.getByRole('table', { name: 'Credit terms' }).isVisible(),
);

const admin = d.users.find((u) => u.roles.includes('platform_admin'));
await page.getByTestId('role-switcher').click();
await page.getByRole('option', { name: new RegExp(admin.displayName) }).click();
await page.getByTestId('current-user').filter({ hasText: admin.displayName }).waitFor();
await page.goto(`${origin}/#/admin/flags`);
await page.getByText('You can change flags').waitFor();
await page.getByLabel('Reason for the next change').fill('preview demo');
await page.getByLabel('ai.extraction enabled').click();
await page.getByTestId('flag-message').waitFor();
check(
  'admin: simulated flag change acknowledged',
  (await page.getByTestId('flag-message').innerText()).includes(
    'is now on (simulated in this preview',
  ),
);

// ---- Every route, six users, no recording misses ------------------------------------------

/** Route paths from src/app/router.tsx: the helper calls and the explicit createRoute paths. */
function routerPaths() {
  const source = readFileSync(new URL('../src/app/router.tsx', import.meta.url), 'utf8');
  const parents = { child: '', dealTab: '/portfolio/$id', analyticsTab: '/analytics' };
  const paths = new Set();
  for (const m of source.matchAll(/\b([A-Za-z]+)\(\s*'(\/[^']*)'/g)) {
    const [, helper, path] = m;
    if (!Object.hasOwn(parents, helper))
      throw new Error(`router.tsx calls ${helper}('${path}'); teach the probe its parent path`);
    paths.add(`${parents[helper]}${path === '/' ? '' : path}` || '/');
  }
  for (const m of source.matchAll(/createRoute\(\{[^}]*?path:\s*'([^']+)'/gs)) paths.add(m[1]);
  return [...paths].sort();
}

const firstId = (credential, path) => recorded(credential, path).json?.items[0]?.id;

// Intake files exist only once the simulation stages one: the clean sample, staged here as
// operations, gives the file route an id for every user (403 for the roles outside intake).
const stagedForWalk = await api('ops.one', 'POST', '/api/v1/intake/accounting', {
  exportId: 'accounting-clean.csv',
});
check(
  'intake: the clean sample is staged for the route walk (201, simulated)',
  stagedForWalk.status === 201 &&
    stagedForWalk.simulated &&
    stagedForWalk.json?.duplicate === false,
  stagedForWalk.status === 201
    ? ''
    : `got ${stagedForWalk.status}: ${stagedForWalk.json?.detail ?? ''}`,
);
const walkFileId = stagedForWalk.json?.id;
// The weekly file, reconcile run and data exception the route walk opens: the update weekly
// sample (nothing flagged), the clean extract of the quarter end before the as-of date (nothing
// opened), and an accounting row no position matches, whose exception every reviewer may see.
// None of them is what the journeys below stage, so those stage afresh rather than answering a duplicate.
const weeklyForWalk = await api('ops.one', 'POST', '/api/v1/intake/weekly', {
  dropId: 'weekly-values-update.csv',
});
check(
  'weekly: the update sample is staged for the route walk (201, simulated)',
  weeklyForWalk.status === 201 &&
    weeklyForWalk.simulated &&
    weeklyForWalk.json?.duplicate === false,
  weeklyForWalk.status === 201
    ? ''
    : `got ${weeklyForWalk.status}: ${weeklyForWalk.json?.detail ?? ''}`,
);
const walkWeeklyId = weeklyForWalk.json?.id;
const cleanExtract = book.lookthroughSamples.find((s) => s.scenario === 'clean');
const runForWalk = await api('ops.one', 'POST', '/api/v1/intake/lookthrough/reconcile', {
  asOf: cleanExtract.asOf,
});
check(
  `look-through: the clean extract of ${cleanExtract.asOf} is reconciled for the route walk (201, agrees)`,
  runForWalk.status === 201 &&
    runForWalk.json?.status === 'validated' &&
    runForWalk.json?.exceptions === 0,
  runForWalk.status === 201 ? '' : `got ${runForWalk.status}: ${runForWalk.json?.detail ?? ''}`,
);
const walkRunId = runForWalk.json?.id;
const exportHeader = accountingExports(d)[0].csv.split('\n')[0].split(',');
const unmatchedRow = exportHeader
  .map((column) =>
    column === 'InvestmentNumber'
      ? 'INV-9999'
      : column === 'CompanyName'
        ? 'Harbor Example Holdings'
        : column === 'PeriodEnd'
          ? fixtures.asOf
          : '',
  )
  .join(',');
const unmatchedForWalk = await api('ops.one', 'POST', '/api/v1/intake/accounting', {
  fileName: 'walk-unmatched.csv',
  csv: `${exportHeader.join(',')}\n${unmatchedRow}\n`,
});
check(
  'exceptions: an accounting row no position matches opens one exception for the route walk',
  unmatchedForWalk.status === 201 && unmatchedForWalk.json?.exceptions === 1,
  unmatchedForWalk.status === 201
    ? ''
    : `got ${unmatchedForWalk.status}: ${unmatchedForWalk.json?.detail ?? ''}`,
);
const walkExceptionId = (await api('ops.one', 'GET', '/api/v1/data-exceptions?limit=200')).json
  ?.items?.[0]?.id;

// ---- Documents, extraction and monitoring in the UI (Phase 2, decision 0012) ---------------
// Run before the route walk so the document and run pages have ids to visit for every user.

const quarterEnd = latestQuarterEndOnOrBefore(fixtures.asOf);
const docExpectations = book.documentExpectations;
const lateFinancials = docExpectations.lateFinancials;
const reportDue = addDays(quarterEnd, definitions.documents.expectedDueDaysAfterQuarterEnd);
/** The number a tile shows in a tile row, from its text (the label, the figure, the hint). */
const tileNumber = async (tiles, name) =>
  Number(
    (await page.getByTestId(tiles).getByRole('group', { name }).innerText()).match(/\d+/)?.[0] ??
      -1,
  );
async function switchUser(externalId) {
  await page.getByTestId('role-switcher').click();
  await page.getByRole('option', { name: new RegExp(by(externalId).displayName) }).click();
  await page
    .getByTestId('current-user')
    .filter({ hasText: by(externalId).displayName })
    .waitFor();
}

await signIn('ops.one');
await page.goto(`${origin}/#/documents`);
await page.getByRole('button', { name: 'Index documents' }).click();
await page
  .getByTestId('documents-action-status')
  .filter({ hasText: 'Indexed' })
  .waitFor({ timeout: 60_000 });
const indexPhrase = await page.getByTestId('documents-action-status').innerText();
check(
  'documents: ops.one indexes the bundled set from the hub; the counts equal the book (one duplicate pair)',
  indexPhrase.includes(
    `Indexed ${docExpectations.total - 1} documents, 1 duplicates, 0 unchanged`,
  ) && indexPhrase.includes('simulated'),
  indexPhrase,
);
await page.getByRole('table', { name: 'Documents' }).waitFor();
check(
  'documents: the hub lists every document outside the wall for operations, the walled ones absent',
  (await page.getByRole('table', { name: 'Documents' }).getByRole('row').count()) ===
    docExpectations.total - docExpectations.walledFiles.length + 1 &&
    !(await page.getByTestId('documents-card').innerText()).includes(walledName),
);
await page.goto(`${origin}/#/documents/review`);
await page.getByTestId('review-queue').waitFor();
check(
  'documents: the review queue holds the untitled scan alone',
  (await page.getByTestId('review-queue').getByRole('row').count()) === 2 &&
    (await page.getByTestId('review-queue').innerText()).includes('scan_0042'),
);
await page.getByTestId('review-queue').getByRole('link', { name: 'scan_0042' }).click();
await page.getByTestId('document-classify').waitFor();
const scanTruth = book.documents.find((d) => d.fileName === 'scan_0042.pdf')?.truth;
check(
  'documents: the scan page shows Needs review, its 30 percent confidence and its pages',
  (await page.getByTestId('document-banner').innerText()).includes('Needs review') &&
    (await page.getByTestId('document-detail').innerText()).includes('30%') &&
    (await page.getByTestId('document-pages').count()) === 1,
);
const classifyForm = page.getByTestId('document-classify');
await classifyForm.getByRole('combobox', { name: 'Document type' }).click();
await page.getByRole('option', { name: 'Quarterly financials' }).click();
await classifyForm.getByRole('combobox', { name: 'Investment' }).click();
await page
  .getByRole('option', { name: new RegExp(scanTruth?.investmentNumber ?? 'INV-') })
  .first()
  .click();
await classifyForm.getByLabel('Period end').fill(scanTruth?.periodEnd ?? quarterEnd);
await classifyForm
  .getByLabel('Reason')
  .fill('The financial summary names the company and the quarter');
await classifyForm.getByRole('button', { name: 'Classify' }).click();
await page.getByTestId('document-action-status').filter({ hasText: 'Classified as' }).waitFor();
check(
  'documents: operations classifies the scan by hand; the banner reads Classified and the form is gone',
  (await page.getByTestId('document-action-status').innerText()).includes(
    'Classified as Quarterly financials',
  ) &&
    (await page.getByTestId('document-banner').innerText()).includes('Classified') &&
    (await page.getByTestId('document-classify').count()) === 0,
);
await page.goto(`${origin}/#/documents/expected`);
await page.getByTestId('expected-generate').waitFor();
check(
  'documents: the tracker proposes the latest quarter end',
  (await page.getByTestId('expected-generate').getByLabel('Quarter end').inputValue()) ===
    quarterEnd,
);
await page.getByRole('button', { name: 'Generate expected documents' }).click();
await page.getByTestId('expected-action-status').filter({ hasText: 'generated' }).waitFor();
const generatePhrase = await page.getByTestId('expected-action-status').innerText();
await page.getByTestId('expected-table').waitFor();
const lateRow = page
  .getByTestId('expected-table')
  .getByRole('row')
  .filter({ hasText: lateFinancials?.investmentNumber ?? '' });
check(
  'documents: expected documents generated for the latest quarter; the absent report reads Expected',
  /Expected documents generated: [1-9]\d* created, 0 existing/.test(generatePhrase) &&
    (await lateRow.innerText()).includes('Expected'),
  generatePhrase,
);
await page.getByLabel('Judged as of').fill(addDays(reportDue, 16));
await lateRow.filter({ hasText: 'Late' }).waitFor();
await page.getByLabel('Judged as of').fill(addDays(reportDue, 76));
await lateRow.filter({ hasText: 'Missing' }).waitFor();
check('documents: judged later, the absent report turns late, then missing', true);

// Extraction: refused while the switch is off, then a batch over the latest quarter's reports.
const flagOff = await api('admin.one', 'PATCH', '/api/v1/flags/ai.extraction', {
  enabled: false,
  reason: 'probe: the switch off',
});
check(
  'extraction: the admin turns ai.extraction off through the simulated flag route',
  flagOff.status === 200,
);
await page.goto(`${origin}/#/documents/extraction`);
const batchForm = page.getByTestId('extraction-batch-form');
await batchForm.getByLabel('Period end').waitFor();
await batchForm.getByLabel('Period end').fill(quarterEnd);
await batchForm.getByRole('button', { name: 'Start extraction', exact: true }).click();
await page
  .getByTestId('extraction-action-status')
  .filter({ hasText: 'Start extraction' })
  .waitFor();
check(
  'extraction: a batch is refused while the kill switch is off, with the problem in plain words',
  (await page.getByTestId('extraction-action-status').innerText()).includes('switched off'),
  await page.getByTestId('extraction-action-status').innerText(),
);
check(
  'extraction: the admin turns ai.extraction on again',
  (
    await api('admin.one', 'PATCH', '/api/v1/flags/ai.extraction', {
      enabled: true,
      reason: 'probe: the switch on',
    })
  ).status === 200,
);
await batchForm.getByRole('button', { name: 'Start extraction', exact: true }).click();
await page
  .getByTestId('extraction-action-status')
  .filter({ hasText: 'Batch started' })
  .waitFor({ timeout: 60_000 });
const batchPhrase = await page.getByTestId('extraction-action-status').innerText();
const opsRuns =
  (await api('ops.one', 'GET', '/api/v1/extraction/runs?limit=200')).json?.items ?? [];
check(
  'extraction: ops.one starts a batch for the latest quarter from the page; every run outside the wall succeeds',
  /Batch started: \d+ runs?/.test(batchPhrase) &&
    opsRuns.length > 0 &&
    opsRuns.every((r) => r.state === 'Succeeded' && r.batchId !== null) &&
    (await page.getByTestId('extraction-batches').getByRole('row').nth(1).innerText()).includes(
      'Succeeded',
    ),
  `${batchPhrase}; ${opsRuns.length} runs`,
);
const restatementFile = docExpectations.scenarioFiles.restatement?.[0];
const reviewed =
  opsRuns.find((r) => r.counts.flagged > 0) ??
  opsRuns.find((r) => r.fileName === restatementFile) ??
  opsRuns[0];
await page.goto(`${origin}/#/documents/extraction/${reviewed.id}`);
await page.getByTestId('run-fields').waitFor();
const detailBefore = (await api('ops.one', 'GET', `/api/v1/extraction/runs/${reviewed.id}`)).json;
const revenueValue = detailBefore?.values?.find((v) => v.field === 'revenue_ltm');
check(
  'extraction: the run page shows the values, the counts and the page layouts read from the PDF',
  (await page.getByTestId('run-banner').innerText()).includes(reviewed.documentTitle) &&
    (await tileNumber('run-tiles', 'Values')) === reviewed.counts.values &&
    (await page.getByTestId('run-fields').getByRole('row').count()) ===
      reviewed.counts.values + 1 &&
    detailBefore?.pages?.length > 0 &&
    revenueValue?.quote !== null,
);
await page
  .getByRole('button', { name: `Show Revenue LTM on page ${revenueValue?.page}`, exact: true })
  .click();
await page.getByTestId('run-page-drawing').waitFor();
check(
  'extraction: choosing the revenue page draws it and highlights the quote (click-to-source)',
  (await page.getByTestId('run-page-drawing').getAttribute('data-page')) ===
    String(revenueValue?.page) && (await page.getByTestId('run-page-highlight').count()) > 0,
);
await page.getByRole('button', { name: 'Accept clean values', exact: true }).click();
await page.getByTestId('run-action-status').filter({ hasText: 'accepted' }).waitFor();
check(
  'extraction: the clean values are accepted in one go',
  /\d+ clean values? accepted/.test(await page.getByTestId('run-action-status').innerText()) &&
    (await tileNumber('run-tiles', 'Decided')) === reviewed.counts.clean,
);
const undecided = (
  (await api('ops.one', 'GET', `/api/v1/extraction/runs/${reviewed.id}`)).json?.values ?? []
).filter((v) => v.decision === null);
if (undecided.length === 0) {
  check(
    'extraction: no flagged or invalid value is left to edit on this run',
    true,
    reviewed.fileName,
  );
} else {
  for (const [i, v] of undecided.entries()) {
    if (i === 0 || v.required) {
      await page.getByRole('button', { name: `Edit, ${v.label}`, exact: true }).click();
      const editDialog = page.getByRole('dialog');
      await editDialog.getByLabel('Value').fill(v.value ?? (v.kind === 'date' ? quarterEnd : '1'));
      await editDialog.getByLabel('Reason').fill('Checked against the synthetic report');
      await editDialog.getByRole('button', { name: 'Edit', exact: true }).click();
      await page
        .getByTestId('run-action-status')
        .filter({ hasText: `${v.label} edited` })
        .waitFor();
    } else {
      await page.getByRole('button', { name: `Reject, ${v.label}`, exact: true }).click();
      const rejectDialog = page.getByRole('dialog');
      await rejectDialog.getByLabel('Reason').fill('Not stated in the report');
      await rejectDialog.getByRole('button', { name: 'Reject', exact: true }).click();
      await page
        .getByTestId('run-action-status')
        .filter({ hasText: `${v.label} rejected` })
        .waitFor();
    }
  }
  check(
    `extraction: ${undecided.length} flagged or invalid value(s) edited or rejected through the dialogs`,
    true,
  );
}
await page.getByRole('button', { name: 'Approve and promote', exact: true }).click();
const approveDialog = page.getByRole('dialog');
await approveDialog.getByLabel('Reason').fill('Reviewed against the synthetic report');
await approveDialog.getByRole('button', { name: 'Approve and promote', exact: true }).click();
await page.getByTestId('run-action-status').filter({ hasText: 'Approved' }).waitFor();
const approvedDetail = (await api('ops.one', 'GET', `/api/v1/extraction/runs/${reviewed.id}`)).json;
check(
  'extraction: approve and promote writes the approval on the run',
  (await page.getByTestId('run-action-status').innerText()).includes(
    'Approved: figures promoted for',
  ) &&
    approvedDetail?.run?.approvedBy === by('ops.one').displayName &&
    approvedDetail?.run?.promotedRecordId !== null,
);
const finalRevenue = approvedDetail?.values?.find((v) => v.field === 'revenue_ltm');
const revenueDollars = toDollars(
  finalRevenue?.decision === 'edited' ? finalRevenue.editedValue : finalRevenue?.value,
  finalRevenue?.unit,
).toFixed();

// The Performance tab of the position, as the deal team: the promoted figure and its source.
await switchUser('deal.one');
await page.goto(`${origin}/#/portfolio/${reviewed.investmentId}/performance`);
const sourceLink = page.getByTestId(`performance-source-${quarterEnd}`);
await sourceLink.waitFor();
const perfAfter = (
  await api('deal.one', 'GET', `/api/v1/investments/${reviewed.investmentId}/performance`)
).json;
const promotedQuarter = perfAfter?.quarters?.find((q) => q.periodEnd === quarterEnd);
check(
  'performance: the quarter shows the promoted revenue in dollars with a source link to the document page',
  ((await sourceLink.getAttribute('href')) ?? '').includes(`/documents/${reviewed.documentId}`) &&
    (await sourceLink.innerText()).includes(`page ${revenueValue?.page}`) &&
    promotedQuarter?.revenueLtm === revenueDollars &&
    promotedQuarter?.source?.runId === reviewed.id &&
    promotedQuarter?.status === 'record_status.approved',
  `href ${await sourceLink.getAttribute('href')}, revenue ${promotedQuarter?.revenueLtm}`,
);
const outlookSet = await api(
  'deal.one',
  'PUT',
  `/api/v1/monitoring/outlook/${reviewed.investmentId}`,
  {
    outlook: 'partial',
    horizonMonths: 12,
    note: null,
    reason: 'probe: sale process started',
  },
);
check(
  'outlook: the deal team sets the realization outlook and reads it back',
  outlookSet.status === 200 &&
    (await api('viewer.one', 'GET', `/api/v1/monitoring/outlook/${reviewed.investmentId}`)).json
      ?.outlook === 'partial',
  outlookSet.status === 200 ? '' : `got ${outlookSet.status}: ${outlookSet.json?.detail ?? ''}`,
);

// The monitoring board: the counts, the late report, the approval and the export.
await page.goto(`${origin}/#/portfolio/monitoring`);
await page.getByTestId('monitoring-board').waitFor();
const boardNow = (await api('deal.one', 'GET', '/api/v1/monitoring/board')).json;
const boardRows = page.getByRole('table', { name: 'Monitoring board' }).getByRole('row');
check(
  'monitoring: the tiles carry the board counts; the absent report reads Expected with its due date; the approved run reads Approved',
  boardNow?.counts !== undefined &&
    (await tileNumber('monitoring-tiles', 'Received')) === boardNow.counts.received &&
    (await tileNumber('monitoring-tiles', 'Approved')) === boardNow.counts.approved &&
    (await tileNumber('monitoring-tiles', 'In review')) === boardNow.counts.inReview &&
    (await boardRows.count()) === boardNow.rows.length + 1 &&
    (
      await boardRows.filter({ hasText: lateFinancials?.investmentNumber ?? '' }).innerText()
    ).includes('Expected') &&
    (await boardRows.filter({ hasText: reviewed.investmentNumber }).innerText()).includes(
      'Approved',
    ) &&
    boardNow.rows.find((r) => r.investmentId === reviewed.investmentId)?.approvedAt !== null,
  JSON.stringify(boardNow?.counts),
);
await page.getByRole('button', { name: 'Export CSV' }).click();
await page.getByTestId('monitoring-action-status').filter({ hasText: 'Exported' }).waitFor();
const exportText = (
  await api('deal.one', 'GET', '/api/v1/monitoring/board/export', null, { accept: 'text/csv' })
).text;
const exportLines = exportText.split('\n');
check(
  'monitoring: Export CSV reports the rows, and the export holds the header plus one line per row',
  (await page.getByTestId('monitoring-action-status').innerText()).includes(
    `Exported ${boardNow.rows.length} rows to monitoring-board-${quarterEnd}.csv`,
  ) &&
    exportLines[0].startsWith('investmentNumber,companyName,') &&
    exportLines.length === boardNow.rows.length + 2 &&
    !exportText.includes(walledName),
);

// The wall on the hub: a deal team user outside the wall finds nothing; a member finds the files.
await page.goto(`${origin}/#/documents`);
await page.getByTestId('documents-search').waitFor();
await page.getByTestId('documents-search').fill(walledName);
await page.getByTestId('documents-search').press('Enter');
await page.getByTestId('documents-empty').waitFor();
const memberSearch = (
  await api('deal.three', 'GET', `/api/v1/documents?limit=200&q=${encodeURIComponent(walledName)}`)
).json;
check(
  'documents: deal.one searching the walled company finds nothing; deal.three finds its files',
  (await page.getByTestId('documents-empty').innerText()).includes('No documents match') &&
    (await page.getByRole('table').count()) === 0 &&
    memberSearch?.items?.length === docExpectations.walledFiles.length,
  `member found ${memberSearch?.items?.length}`,
);
// Ids for the route walk: a document outside the wall and the reviewed run.
const walkDocumentId = reviewed.documentId;
const walkExtractionRunId = reviewed.id;

/** Concrete addresses for one user, ids taken from that user's own recorded lists. */
function visitsFor(externalId, paths) {
  const positions =
    recorded(externalId, '/api/v1/investments?active=true&limit=200').json?.items ?? [];
  // Two positions; for the wall member the second is the walled deal.
  const ids = positions.map((i) => i.id);
  const investments =
    externalId === 'deal.three' ? [ids.find((id) => id !== walledId), walledId] : ids.slice(0, 2);
  const vehicle = firstId(externalId, '/api/v1/vehicles');
  const sponsor = firstId(externalId, '/api/v1/sponsors?limit=200');
  const listed = firstId(externalId, '/api/v1/capital-notices?limit=200');
  // While the notices list is not recorded, a dataset id still exercises the detail route.
  const notice = listed ?? d.capitalNotices.find((n) => n.scenarioTag === 'wire_change').id;
  const visits = [];
  for (const path of paths) {
    if (!path.includes('$')) {
      visits.push(path);
    } else if (path.startsWith('/portfolio/$id')) {
      visits.push(path.replace('$id', investments[0]));
      if (path === '/portfolio/$id' && investments[1] !== undefined)
        visits.push(path.replace('$id', investments[1]));
    } else if (path === '/portfolio/vehicles/$id') {
      if (vehicle !== undefined) visits.push(path.replace('$id', vehicle));
    } else if (path === '/sponsors/$id') {
      if (sponsor !== undefined) visits.push(path.replace('$id', sponsor));
    } else if (path === '/capital-activity/$id') {
      visits.push(path.replace('$id', notice));
    } else if (path === '/data/intake/$id') {
      if (walkFileId !== undefined) visits.push(path.replace('$id', walkFileId));
    } else if (path === '/data/weekly/$id') {
      if (walkWeeklyId !== undefined) visits.push(path.replace('$id', walkWeeklyId));
    } else if (path === '/data/lookthrough/$id') {
      if (walkRunId !== undefined) visits.push(path.replace('$id', walkRunId));
    } else if (path === '/data/exceptions/$id') {
      if (walkExceptionId !== undefined) visits.push(path.replace('$id', walkExceptionId));
    } else if (path === '/documents/$id') {
      visits.push(path.replace('$id', walkDocumentId));
    } else if (path === '/documents/extraction/$id') {
      visits.push(path.replace('$id', walkExtractionRunId));
    } else {
      throw new Error(`the probe does not know how to fill ${path}`);
    }
  }
  return visits;
}

const paths = routerPaths();
check(
  'router: route paths found in src/app/router.tsx',
  paths.length >= 40,
  `${paths.length} paths`,
);
for (const externalId of [
  'viewer.one',
  'deal.three',
  'ops.one',
  'head.one',
  'ir.one',
  'audit.one',
]) {
  await signIn(externalId);
  const visits = visitsFor(externalId, paths);
  const failures = [];
  for (const path of visits) {
    const missesBefore = (await misses()).length;
    const errorsBefore = errors.length;
    await page.goto(`${origin}/#${path}`);
    try {
      await settle();
    } catch {
      failures.push(`${path}: did not settle`);
    }
    const newMisses = (await misses()).slice(missesBefore);
    const newErrors = errors.slice(errorsBefore);
    if (newMisses.length > 0) failures.push(`${path}: not recorded ${newMisses.join(', ')}`);
    if (newErrors.length > 0) failures.push(`${path}: page error ${newErrors[0]}`);
  }
  check(
    `${externalId}: ${visits.length} routes render with no recording miss or page error`,
    failures.length === 0,
    failures.slice(0, 4).join(' | '),
  );
}

// ---- Simulated workflow journeys at the API level, inside the page -------------------------

/** Sets the credential the way src/app/session.ts does, then sends as src/api/client.ts does. */
function api(credential, method, path, body, headers = {}) {
  return page.evaluate(
    async ({ credential, method, path, body, headers }) => {
      // The shim reads the signed-in credential from session storage; ask as this credential and
      // then put the page's own back, so a call as another user never changes whom the page acts as.
      let signedIn = null;
      try {
        signedIn = globalThis.sessionStorage.getItem('pb.credential');
        globalThis.sessionStorage.setItem('pb.credential', credential);
      } catch {
        // Storage blocked: the header below still carries the credential.
      }
      const h = { accept: 'application/json', authorization: `Bearer ${credential}`, ...headers };
      if (body !== null) h['content-type'] = 'application/json';
      let res;
      try {
        res = await globalThis.fetch(path, {
          method,
          headers: h,
          ...(body === null ? {} : { body: JSON.stringify(body) }),
        });
      } finally {
        try {
          if (signedIn === null) globalThis.sessionStorage.removeItem('pb.credential');
          else globalThis.sessionStorage.setItem('pb.credential', signedIn);
        } catch {
          // Storage blocked: nothing was changed.
        }
      }
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return {
        status: res.status,
        json,
        text,
        simulated: res.headers.get('x-pb-simulated') === 'true',
      };
    },
    { credential, method, path, body: body ?? null, headers },
  );
}
const expectStatus = (name, answer, status, extra = true) =>
  check(
    name,
    answer.status === status && extra,
    answer.status === status ? '' : `got ${answer.status}: ${answer.json?.detail ?? ''}`,
  );

const asOf = fixtures.asOf;
const staleId = d.scenarios.stale_valuation[0];
const staleDetail = recorded('ops.one', `/api/v1/investments/${staleId}`).json;
const versionsAt = async (credential) =>
  ((await api(credential, 'GET', `/api/v1/investments/${staleId}`)).json?.valuations ?? []).filter(
    (v) => v.periodEnd === asOf,
  );

if (staleDetail === undefined) {
  skip('valuation journey', 'skipped: the stale position detail is not recorded');
} else {
  // The draft carries the latest Locked mark's method and value, typed in as this quarter's input.
  const mark = staleDetail.valuations.filter((v) => v.state === 'Locked').at(-1);
  const createBody = {
    investmentId: staleId,
    periodEnd: asOf,
    method: mark.method,
    fairValue: mark.fairValue,
  };
  check(
    `valuation journey: the stale position has no ${asOf} mark before the journey`,
    (await versionsAt('ops.one')).length === 0,
  );
  expectStatus(
    'valuation: deal team cannot create a draft (403)',
    await api('deal.one', 'POST', '/api/v1/valuations', createBody),
    403,
  );
  const created = await api('ops.one', 'POST', '/api/v1/valuations', createBody);
  expectStatus(
    'valuation: ops.one creates a Draft (201, simulated)',
    created,
    201,
    created.simulated && created.json?.state === 'Draft' && created.json?.version === 1,
  );
  const id = created.json?.id;
  const run = (credential, body, headers) =>
    api(credential, 'POST', `/api/v1/valuations/${id}/commands`, body, headers);
  const prepared = await run('ops.one', { command: 'prepare' });
  expectStatus(
    'valuation: ops.one prepares (200, lock hash computed)',
    prepared,
    200,
    prepared.json?.state === 'OpsPrepared' && /^[0-9a-f]{64}$/.test(prepared.json?.lockHash ?? ''),
  );
  expectStatus(
    'valuation: ops.one cannot approve as deal team (403)',
    await run('ops.one', { command: 'dealTeamApprove' }),
    403,
  );
  const approved = await run('deal.one', { command: 'dealTeamApprove' });
  expectStatus(
    'valuation: deal.one approves (200)',
    approved,
    200,
    approved.json?.state === 'DealTeamApproved',
  );
  expectStatus(
    'valuation: a stale If-Match is refused (412)',
    await run('head.one', { command: 'lock' }, { 'if-match': '"1"' }),
    412,
  );
  const locked = await run('head.one', { command: 'lock' });
  expectStatus(
    'valuation: head.one locks (200)',
    locked,
    200,
    locked.json?.state === 'Locked' && locked.json?.approvedBy === by('head.one').displayName,
  );
  const viewerVersions = await versionsAt('viewer.one');
  check(
    'valuation: viewer.one one-pager shows the Locked mark',
    viewerVersions.some((v) => v.version === 1 && v.state === 'Locked'),
  );
  if (recorded('viewer.one', '/api/v1/valuations?limit=200').status !== 200) {
    skip('valuation: viewer.one list shows the Locked row', NOT_RECORDED);
    skip('valuation: viewer.one list never shows the walled position', NOT_RECORDED);
  } else {
    const list = (await api('viewer.one', 'GET', '/api/v1/valuations?limit=200')).json;
    check(
      'valuation: viewer.one list shows the Locked row',
      list?.items?.some((r) => r.id === id && r.state === 'Locked') === true,
    );
    check(
      'valuation: viewer.one list never shows the walled position',
      list?.items?.every((r) => r.investmentId !== walledId) === true,
    );
  }
  expectStatus(
    'valuation: reopen without a reason is refused (422)',
    await run('head.one', { command: 'reopen' }),
    422,
  );
  const reopened = await run('head.one', {
    command: 'reopen',
    reason: 'sponsor restated the mark',
  });
  expectStatus(
    'valuation: head.one reopens with a reason (200)',
    reopened,
    200,
    reopened.json?.state === 'Reopened',
  );
  const afterReopen = await versionsAt('ops.one');
  check(
    'valuation: reopen created version 2 in Draft',
    afterReopen.some((v) => v.version === 1 && v.state === 'Reopened') &&
      afterReopen.some((v) => v.version === 2 && v.state === 'Draft'),
  );
}

const wire = d.capitalNotices.find((n) => n.scenarioTag === 'wire_change');
if (recorded('ops.one', '/api/v1/capital-notices?limit=200').status !== 200) {
  skip('capital notice journey (wire_change notice)', NOT_RECORDED);
} else {
  const run = (credential, cmd) =>
    api(credential, 'POST', `/api/v1/capital-notices/${wire.id}/commands`, { command: cmd });
  const viewerSees = recorded('viewer.one', `/api/v1/capital-notices/${wire.id}`).status === 200;
  expectStatus(
    `capital notice: viewer.one cannot review (${viewerSees ? '403' : '404, not visible'})`,
    await run('viewer.one', 'review'),
    viewerSees ? 403 : 404,
  );
  const reviewed = await run('ops.one', 'review');
  expectStatus(
    'capital notice: ops.one reviews (200)',
    reviewed,
    200,
    reviewed.json?.state === 'Reviewed',
  );
  const drafted = await run('ops.one', 'draftTicket');
  expectStatus(
    'capital notice: ops.one drafts the ticket (200)',
    drafted,
    200,
    drafted.json?.state === 'TicketDrafted',
  );
  const own = await run('ops.one', 'approveTicket');
  expectStatus(
    'capital notice: the drafter cannot approve (422, SEC-12.3)',
    own,
    422,
    /SEC-12\.3/.test(own.json?.detail ?? ''),
  );
  const other = await run('ops.two', 'approveTicket');
  expectStatus(
    'capital notice: an unverified wire blocks approval (422, SEC-12.2)',
    other,
    422,
    /SEC-12\.2/.test(other.json?.detail ?? ''),
  );
  expectStatus(
    'capital notice: funding cannot be confirmed from TicketDrafted (409)',
    await run('ops.one', 'confirmFunding'),
    409,
  );
}

// ---- Intake journey in the UI: the defects sample through operations, the wall member and a viewer

check(
  'intake: the file staged for the route walk survived it (the simulation state lives in the page)',
  (await api('ops.one', 'GET', `/api/v1/intake/files/${walkFileId}`)).status === 200,
);
/** The number a tile shows, from its text ("Flagged", the figure, the hint). */
const tileValue = async (name) =>
  Number(
    (await page.getByTestId('intake-tiles').getByRole('group', { name }).innerText()).match(
      /\d+/,
    )?.[0] ?? -1,
  );
async function switchTo(externalId) {
  await page.getByTestId('role-switcher').click();
  await page.getByRole('option', { name: new RegExp(by(externalId).displayName) }).click();
  await page
    .getByTestId('current-user')
    .filter({ hasText: by(externalId).displayName })
    .waitFor();
}
await signIn('ops.one');
await page.goto(`${origin}/#/data/intake`);
await page.getByTestId('intake-sample-defects').click();
await page.waitForURL(/#\/data\/intake\/[0-9a-f-]{36}$/);
const fileUrl = page.url();
await page.getByTestId('intake-tiles').waitFor();
check(
  'intake: ops.one stages the defects sample; the file page counts flagged rows and exceptions',
  (await page.getByTestId('intake-banner').innerText()).includes('accounting-defects.csv') &&
    (await tileValue('Flagged')) > 0 &&
    (await tileValue('Exceptions')) > 0,
  `flagged ${await tileValue('Flagged')}, exceptions ${await tileValue('Exceptions')}`,
);
check(
  'intake: ops.one is told a row is linked to a position outside the wall, never shown it',
  (await page.getByTestId('intake-hidden-rows').innerText()).includes(
    'linked to positions you cannot see',
  ) && !(await page.getByTestId('intake-rows').innerText()).includes(walledName),
);
await page.getByRole('button', { name: 'Approve validated rows' }).click();
await page.getByTestId('intake-action-status').filter({ hasText: 'rows promoted' }).waitFor();
check(
  'intake: approving promotes the validated rows (simulated)',
  (await page.getByTestId('intake-action-status').innerText()).includes('simulated') &&
    (await tileValue('Promoted')) > 0,
);
await page.getByRole('button', { name: 'Reject flagged rows' }).click();
const dialog = page.getByRole('dialog');
await dialog
  .getByRole('textbox', { name: 'Reason' })
  .fill('Names sent back to the accounting team');
await dialog.getByRole('button', { name: 'Reject flagged rows' }).click();
await page.getByTestId('intake-action-status').filter({ hasText: 'rows rejected' }).waitFor();
check(
  'intake: rejecting with a reason rejects the flagged rows ops.one sees',
  (await tileValue('Rejected')) > 0,
);
// A switch lands on Home; back on the same file (a hash change, so the page and its simulation
// state stay), the wall member sees the walled position's row and no hidden-rows note.
await switchTo('deal.three');
await page.goto(fileUrl);
await page.getByTestId('intake-rows').filter({ hasText: walledName }).waitFor();
check(
  'intake: the wall member sees the walled position row and no hidden-rows note',
  (await page.getByTestId('intake-hidden-rows').count()) === 0,
);
await switchTo('viewer.one');
await page.goto(`${origin}/#/data/intake`);
await page.getByTestId('intake-unavailable').waitFor();
check(
  'intake: a viewer is told who intake is for',
  (await page.getByTestId('intake-unavailable').innerText()).includes(
    'Intake is for operations and reviewers',
  ),
);

// ---- Weekly values in the UI: the defects sample through operations, the Drafts on the board

/** The number a tile shows in a tile row, from its text (the label, the figure, the hint). */
const tileIn = async (tiles, name) =>
  Number(
    (await page.getByTestId(tiles).getByRole('group', { name }).innerText()).match(/\d+/)?.[0] ??
      -1,
  );
await signIn('ops.one');
await page.goto(`${origin}/#/data/weekly`);
await page.getByRole('button', { name: 'Stage, weekly-values-defects.csv' }).click();
await page.waitForURL(/#\/data\/weekly\/[0-9a-f-]{36}$/);
const weeklyUrl = page.url();
await page.getByTestId('weekly-tiles').waitFor();
check(
  'weekly: ops.one stages the defects sample; the file page counts flagged values and badges the move beyond the threshold',
  (await page.getByTestId('weekly-banner').innerText()).includes('weekly-values-defects.csv') &&
    (await tileIn('weekly-tiles', 'Flagged')) > 0 &&
    (await page.getByTestId('weekly-rows').innerText()).includes('Above threshold'),
  `flagged ${await tileIn('weekly-tiles', 'Flagged')}, exceptions ${await tileIn('weekly-tiles', 'Exceptions')}`,
);
check(
  'weekly: ops.one is told a value is linked to a position outside the wall, never shown it',
  (await page.getByTestId('weekly-hidden-rows').innerText()).includes(
    'linked to positions you cannot see',
  ) && !(await page.getByTestId('weekly-rows').innerText()).includes(walledName),
);
await page.getByRole('button', { name: 'Approve validated rows' }).click();
await page.getByTestId('weekly-action-status').filter({ hasText: 'Draft valuation' }).waitFor();
check(
  'weekly: approving promotes the validated values into Draft valuations (simulated)',
  /Draft valuations? created/.test(await page.getByTestId('weekly-action-status').innerText()) &&
    (await page.getByTestId('weekly-action-status').innerText()).includes('simulated') &&
    (await tileIn('weekly-tiles', 'Promoted')) > 0,
);
const weeklyFile = (
  await api('ops.one', 'GET', `/api/v1/intake/weekly/files/${weeklyUrl.split('/').pop()}`)
).json;
const promotedValue = weeklyFile?.rows?.find((r) => r.status === 'promoted');
await page.goto(`${origin}/#/valuations`);
const board = page.getByRole('table', { name: 'Valuations' });
await board.waitFor();
check(
  'weekly: the Draft valuation of a promoted value is on the valuations board, of method weekly report',
  promotedValue !== undefined &&
    (await board
      .locator('tr')
      .filter({ hasText: promotedValue.link.companyName })
      .filter({ hasText: 'Draft' })
      .filter({ hasText: /weekly/i })
      .count()) > 0,
  promotedValue === undefined ? 'no promoted value' : promotedValue.link.companyName,
);

// ---- Look-through and the exceptions queue in the UI --------------------------------------

await page.goto(`${origin}/#/data/lookthrough`);
await page.getByTestId('lookthrough-run').waitFor();
// The as-of input defaults to the record's as-of date (Data Health), the defects extract's date.
await page.getByRole('button', { name: 'Reconcile' }).click();
await page.waitForURL(/#\/data\/lookthrough\/[0-9a-f-]{36}$/);
const runUrl = page.url();
await page.getByTestId('lookthrough-tiles').waitFor();
check(
  `look-through: ops.one reconciles ${asOf}; the run counts differences against the record and the exceptions opened`,
  (await page.getByTestId('lookthrough-banner').innerText()).includes(`lookthrough-${asOf}.json`) &&
    (await tileIn('lookthrough-tiles', 'Differences')) > 0 &&
    (await tileIn('lookthrough-tiles', 'Exceptions')) > 0,
  `differences ${await tileIn('lookthrough-tiles', 'Differences')}, exceptions ${await tileIn('lookthrough-tiles', 'Exceptions')}`,
);
check(
  'look-through: ops.one is told a row is linked to a position outside the wall, never shown it',
  (await page.getByTestId('lookthrough-hidden-rows').innerText()).includes(
    'linked to positions you cannot see',
  ) && !(await page.getByTestId('lookthrough-rows').innerText()).includes(walledName),
);
await page.getByTestId('lookthrough-exceptions-link').click();
await page.waitForURL(/#\/data\/exceptions\?/);
await page.getByTestId('exceptions-table').waitFor();
check(
  'exceptions: the queue opens on the exceptions of the run',
  (await page.getByTestId('exceptions-file-note').innerText()).includes(
    `lookthrough-${asOf}.json`,
  ) && (await page.getByTestId('exceptions-table').locator('tbody tr').count()) > 1,
);
await page.getByTestId('exceptions-table').getByRole('link', { name: /^LT-/ }).first().click();
await page.waitForURL(/#\/data\/exceptions\/[0-9a-f-]{36}$/);
await page.getByTestId('exception-actions').waitFor();
await page.getByRole('button', { name: 'Acknowledge' }).click();
await page.getByTestId('exception-action-status').filter({ hasText: 'Acknowledged' }).waitFor();
check(
  'exceptions: ops.one acknowledges one and takes it (simulated)',
  (await page.getByTestId('exception-banner').innerText()).includes('Acknowledged') &&
    (await page.getByTestId('exception-action-status').innerText()).includes(
      by('ops.one').displayName,
    ),
);
await page.getByRole('button', { name: 'Resolve' }).click();
const reasonDialog = page.getByRole('dialog');
await reasonDialog.getByRole('textbox', { name: 'Reason' }).fill('Provider resent the row');
await reasonDialog.getByRole('button', { name: 'Resolve' }).click();
await page.getByTestId('exception-action-status').filter({ hasText: 'Resolved' }).waitFor();
check(
  'exceptions: resolving with a reason closes it; a final state lists no transition',
  (await page.getByTestId('exception-banner').innerText()).includes('Resolved') &&
    (await page.getByTestId('exception-terminal').count()) === 1,
);
await page.getByLabel('External ticket').fill('HD-1234');
await page.getByRole('button', { name: 'Set ticket' }).click();
await page
  .getByTestId('exception-action-status')
  .filter({ hasText: 'Ticket HD-1234 noted' })
  .waitFor();
check(
  'exceptions: a ticket is noted without a state change',
  (await page.getByTestId('exception-detail').innerText()).includes('HD-1234') &&
    (await page.getByTestId('exception-banner').innerText()).includes('Resolved'),
);
// Read as the signed-in user: api() sets the page's credential, and the UI steps below continue as ops.one.
const healthAfter = (await api('ops.one', 'GET', '/api/v1/data-health')).json;
const healthRecorded = recorded('ops.one', '/api/v1/data-health').json;
check(
  'data health: the open exception count carries the simulated intakes',
  healthAfter?.openExceptions > (healthRecorded?.openExceptions ?? 0),
  `recorded ${healthRecorded?.openExceptions}, now ${healthAfter?.openExceptions}`,
);

// ---- The operations workbook drop in the UI ------------------------------------------------

await page.goto(`${origin}/#/data/intake`);
await page.getByRole('button', { name: 'Stage, ops-drop-clean.xlsx' }).click();
await page.waitForURL(/#\/data\/intake\/[0-9a-f-]{36}$/);
const workbookUrl = page.url();
await page.getByTestId('intake-tiles').waitFor();
check(
  'ops drop: ops.one stages the clean workbook from the drop folder; the banner names the template it matched',
  (await page.getByTestId('intake-banner').innerText()).includes('ops-drop-clean.xlsx') &&
    (await page.getByTestId('intake-banner').innerText()).includes('Template: quarterly-figures') &&
    (await tileIn('intake-tiles', 'Validated')) > 0,
);
check(
  'ops drop: ops.one is told a row is linked to a position outside the wall, never shown it',
  (await page.getByTestId('intake-hidden-rows').innerText()).includes(
    'linked to positions you cannot see',
  ) && !(await page.getByTestId('intake-rows').innerText()).includes(walledName),
);
await page.getByRole('button', { name: 'Approve validated rows' }).click();
await page.getByTestId('intake-action-status').filter({ hasText: 'rows promoted' }).waitFor();
check(
  'ops drop: approving promotes the validated rows (simulated)',
  (await tileIn('intake-tiles', 'Promoted')) > 0,
);
await page.goto(`${origin}/#/data/intake`);
await page.getByRole('button', { name: 'Stage, ops-drop-unknown-template.xlsx' }).click();
await page.waitForURL(/#\/data\/intake\/[0-9a-f-]{36}$/);
await page.getByRole('list', { name: 'File findings' }).waitFor();
const findings = await page.getByRole('list', { name: 'File findings' }).innerText();
check(
  'ops drop: a workbook no template describes is refused with a finding naming the templates, and nothing is staged',
  findings.includes('LAYOUT-05') &&
    findings.includes('No template matches this workbook') &&
    findings.includes('quarterly-figures') &&
    (await page.getByTestId('intake-banner').innerText()).includes('Template: none matched') &&
    (await tileIn('intake-tiles', 'Rows')) === 0,
);

// ---- The wall member sees what was hidden; a viewer is told who each page is for -----------

await switchTo('deal.three');
await page.goto(weeklyUrl);
await page.getByTestId('weekly-rows').filter({ hasText: walledName }).waitFor();
check(
  'weekly: the wall member sees the walled position value and no hidden-rows note',
  (await page.getByTestId('weekly-hidden-rows').count()) === 0,
);
await page.goto(runUrl);
await page.getByTestId('lookthrough-rows').filter({ hasText: walledName }).waitFor();
check(
  'look-through: the wall member sees the walled position row and no hidden-rows note',
  (await page.getByTestId('lookthrough-hidden-rows').count()) === 0,
);
await page.goto(workbookUrl);
await page.getByTestId('intake-rows').filter({ hasText: walledName }).waitFor();
check(
  'ops drop: the wall member sees the walled position row and no hidden-rows note',
  (await page.getByTestId('intake-hidden-rows').count()) === 0,
);
await switchTo('viewer.one');
for (const [route, testId, text] of [
  ['/data/weekly', 'weekly-unavailable', 'Weekly values are for operations and reviewers'],
  ['/data/lookthrough', 'lookthrough-unavailable', 'Look-through is for operations and reviewers'],
  ['/data/exceptions', 'exceptions-unavailable', 'Exceptions are for operations and reviewers'],
]) {
  await page.goto(`${origin}/#${route}`);
  await page.getByTestId(testId).waitFor();
  check(
    `${route}: a viewer is told who the page is for`,
    (await page.getByTestId(testId).innerText()).includes(text),
  );
}
check(
  'data health: a viewer sees the same open exception count as operations',
  (await api('viewer.one', 'GET', '/api/v1/data-health')).json?.openExceptions ===
    healthAfter?.openExceptions,
);

const reset = await api('viewer.one', 'POST', '/api/v1/preview/reset');
expectStatus(
  'reset: answers 200 (simulated)',
  reset,
  200,
  reset.simulated && reset.json?.reset === true,
);
check(
  'reset: the simulated valuations are gone',
  staleDetail === undefined || (await versionsAt('viewer.one')).length === 0,
);
check(
  'reset: the intake list is empty again, every source',
  (await api('ops.one', 'GET', '/api/v1/intake/files?limit=200')).json?.items?.length === 0,
);
check(
  'reset: the documents, the expected documents, the runs and the promoted quarters are gone',
  (await api('ops.one', 'GET', '/api/v1/documents?limit=200')).json?.items?.length === 0 &&
    (await api('ops.one', 'GET', '/api/v1/expected-documents?limit=200')).json?.items?.length ===
      0 &&
    (await api('ops.one', 'GET', '/api/v1/extraction/runs?limit=200')).json?.items?.length === 0 &&
    (await api('deal.one', 'GET', '/api/v1/monitoring/board')).json?.counts?.inReview === 0 &&
    (
      await api('deal.one', 'GET', `/api/v1/investments/${reviewed.investmentId}/performance`)
    ).json?.quarters?.find((q) => q.periodEnd === quarterEnd)?.source === null,
);
check(
  'reset: the weekly files, the reconcile runs and the exceptions are gone',
  (await api('ops.one', 'GET', '/api/v1/intake/files?limit=200&source=weekly')).json?.items
    ?.length === 0 &&
    (await api('ops.one', 'GET', '/api/v1/intake/files?limit=200&source=lookthrough')).json?.items
      ?.length === 0 &&
    (await api('ops.one', 'GET', '/api/v1/data-exceptions?limit=200')).json?.items?.length === 0 &&
    (await api('viewer.one', 'GET', '/api/v1/data-health')).json?.openExceptions ===
      healthRecorded?.openExceptions,
);
check(
  'no recording misses in the whole session',
  (await misses()).length === 0,
  (await misses()).slice(0, 3).join(' | '),
);
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

// A bundle whose recordings are missing must say so instead of rendering nothing.
const broken = await browser.newPage();
await broken.route('**/preview/fixtures.json', (route) => route.fulfill({ status: 404, body: '' }));
await broken.goto(`${origin}/#/sign-in`);
await broken.getByText('could not load its recorded data').waitFor();
check('missing recordings: message shown instead of a blank page', true);
await broken.close();

await browser.close();
server.close();
for (const r of results)
  process.stdout.write(`${r.status} ${r.name}${r.detail ? ` (${r.detail})` : ''}\n`);
const count = (status) => results.filter((r) => r.status === status).length;
process.stdout.write(
  `probe: ${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped\n`,
);
process.exit(count('FAIL') === 0 ? 0 : 1);
