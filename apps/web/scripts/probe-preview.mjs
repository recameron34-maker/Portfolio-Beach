// Serves dist-preview statically and walks it in headless Chromium: journey 1 against the recorded
// preview, every route of src/app/router.tsx for six users with the recording-miss detector, and
// the simulated workflow journeys at the API level inside the page. One line per check, a summary,
// and a non-zero exit on any failure. Checks that need recordings an endpoint has not produced yet
// (it answered 501 when the preview was built) are skipped with a line that says so.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { chromium } from '@playwright/test';
import {
  D,
  addDays,
  latestQuarterEndOnOrBefore,
  nextQuarterEnd,
  toDollars,
  valueCreationRollup,
} from '@pb/calc';
import { canonicalJson } from '@pb/contracts';
import { runReportQa } from '@pb/report-engine';
import { accountingExports, failingPackageCase, generateDataset } from '@pb/synthetic';
import { readsRegister } from '@pb/workflows';
import { keyFor } from './preview-plan.mjs';
import { bankDetailLeaks } from './preview-wires.mjs';

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
/** SHA-256 as the API takes it, to verify a lock text the simulation hashed in the page. */
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

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

// A client allocation line follows the client's entitlement (review finding D1-06). The deal at
// Closing holds client lines only: a viewer is shown none of them, reads the deal's own
// commitment and tie-out, and is told how many lines are not shown, on both pages.
const clientLineDeal = d.scenarios.closing_open[0];
const clientLineCount = d.allocations.filter(
  (a) => a.opportunityId === clientLineDeal && a.clientId !== null,
).length;
const hiddenNote = `${clientLineCount} client lines are not shown.`;
const namesAClient = (text) => d.clients.some((c) => text.includes(c.name));
await page.goto(`${origin}/#/pipeline/${clientLineDeal}`);
await page.getByTestId('allocations-hidden-lines').waitFor();
const viewerCard = await page.getByTestId('allocations-editor').innerText();
check(
  'viewer: the allocations card leads with the commitment and says how many client lines are not shown',
  clientLineCount > 1 &&
    viewerCard.includes(hiddenNote) &&
    /commitment/i.test(viewerCard) &&
    viewerCard.includes('Tied out') &&
    !namesAClient(viewerCard),
  viewerCard.replace(/\s+/g, ' ').slice(0, 160),
);
await page.goto(`${origin}/#/pipeline/${clientLineDeal}/closing`);
await page.getByTestId('allocations-hidden-lines').waitFor();
const viewerTieOut = await page.getByTestId('closing-tie-out').innerText();
check(
  'viewer: the closing page shows the tie-out of every line and the same count of lines not shown',
  viewerTieOut.includes(hiddenNote) &&
    viewerTieOut.includes('Tied out') &&
    !namesAClient(viewerTieOut),
  viewerTieOut.replace(/\s+/g, ' ').slice(0, 160),
);

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
  const parents = {
    child: '',
    dealTab: '/portfolio/$id',
    analyticsTab: '/analytics',
    filteredAnalyticsTab: '/analytics',
  };
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
// The reviewer is held to the validator's rules: dollars typed with the $M unit convert to a
// figure outside the configured revenue range and are refused naming it, as the API refuses them (FIN-1).
const rangeRefusal = await api(
  'ops.one',
  'POST',
  `/api/v1/extraction/runs/${reviewed.id}/commands`,
  {
    command: 'edit',
    field: 'revenue_ltm',
    value: '125400000',
    unit: 'USD_M',
    reason: 'probe: dollars typed with the millions unit',
  },
);
check(
  'extraction: a money edit outside the configured range is refused with 400 naming the range (FIN-1)',
  rangeRefusal.status === 400 &&
    rangeRefusal.simulated &&
    rangeRefusal.json?.errors?.[0]?.path === 'value' &&
    /outside the revenue range \d+ to \d+/.test(rangeRefusal.json?.errors?.[0]?.message ?? ''),
  rangeRefusal.status === 400
    ? (rangeRefusal.json?.errors?.[0]?.message ?? '')
    : `got ${rangeRefusal.status}: ${rangeRefusal.json?.detail ?? ''}`,
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
  /** A figure the validator flagged as outside the configured range: an edit to the same figure would be refused (FIN-1), so a reviewer who checked it accepts it knowingly. */
  const outOfRange = (v) => v.findings.some((f) => f.ruleId === 'EXT-UNIT-02');
  for (const [i, v] of undecided.entries()) {
    if (outOfRange(v)) {
      await page.getByRole('button', { name: `Accept, ${v.label}`, exact: true }).click();
      await page
        .getByTestId('run-action-status')
        .filter({ hasText: `${v.label} accepted` })
        .waitFor();
    } else if (i === 0 || v.required) {
      await page.getByRole('button', { name: `Edit, ${v.label}`, exact: true }).click();
      const editDialog = page.getByRole('dialog');
      // A date edit must be the quarter the run covers (FIN-2), which the batch over the quarter end gives every run.
      await editDialog.getByLabel('Value').fill(v.kind === 'date' ? quarterEnd : (v.value ?? '1'));
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
    `extraction: ${undecided.length} flagged or invalid value(s) accepted, edited or rejected through the page`,
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
// An edited figure converts with the edit's own unit, the model's with the model's (WF-1).
const revenueDollars = (
  finalRevenue?.decision === 'edited'
    ? toDollars(finalRevenue.editedValue, finalRevenue.editedUnit ?? finalRevenue.unit)
    : toDollars(finalRevenue?.value, finalRevenue?.unit)
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

// A reporting package exists only once somebody starts one in the session (the book seeds none).
// Investor relations starts one here and generates it, so the package route opens a real package
// with its figures and its checks for every user of the walk (a viewer is told who reads them).
// It is the net package of the client the generator names; the journey at the end of this file
// starts the gross one after a reset.
const packageCase = failingPackageCase(d);
const PACKAGES = '/api/v1/report-packages';
const walkPackage = await api(packageCase.user.externalId, 'POST', PACKAGES, {
  clientId: packageCase.client.id,
  periodEnd: quarterEnd,
  basis: 'net',
  label: 'preliminary',
});
const walkPackageId = walkPackage.json?.id;
const walkPackageRun = await api(
  packageCase.user.externalId,
  'POST',
  `${PACKAGES}/${walkPackageId}/commands`,
  { command: 'generate' },
  { 'if-match': `"${walkPackage.json?.rowVersion}"` },
);
check(
  'packages: one is started and generated for the route walk (201, then its checks, simulated)',
  walkPackage.status === 201 &&
    walkPackage.simulated &&
    walkPackageRun.status === 200 &&
    walkPackageRun.simulated &&
    walkPackageRun.json?.content?.lines?.length > 0 &&
    walkPackageRun.json.findings.length > 0,
  `start ${walkPackage.status}, generate ${walkPackageRun.status}: ${walkPackageRun.json?.detail ?? walkPackageRun.json?.state ?? ''}`,
);

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
    } else if (path === '/valuations/$id') {
      // Phase 3 (decision 0013): a version of the credential's own board, else a dataset id.
      const valuation = firstId(externalId, '/api/v1/valuations?limit=200') ?? d.valuations[0].id;
      visits.push(path.replace('$id', valuation));
    } else if (path === '/capital-activity/wires/$id') {
      visits.push(path.replace('$id', d.wireInstructions[0].id));
    } else if (path === '/pipeline/$id') {
      const deal =
        firstId(externalId, '/api/v1/opportunities?limit=200') ?? d.scenarios.sourced_deal[0];
      visits.push(path.replace('$id', deal));
    } else if (path === '/pipeline/$id/closing') {
      visits.push(path.replace('$id', d.scenarios.closing_open[0]));
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
    } else if (path === '/reporting/packages/$id') {
      // The package started above, and the page of an id nobody started: "Package not found"
      // for a role that reads packages, "not visible" for the rest.
      if (walkPackageId !== undefined) visits.push(path.replace('$id', walkPackageId));
      visits.push(path.replace('$id', '00000000-0000-4000-8000-0000000000f0'));
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
  // The hash is taken at the lock, over what the version holds then; none before, as the API.
  expectStatus(
    'valuation: ops.one prepares (200, no lock hash before the lock)',
    prepared,
    200,
    prepared.json?.state === 'OpsPrepared' && prepared.json?.lockHash === null,
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
    'valuation: head.one locks (200, the lock hash computed)',
    locked,
    200,
    locked.json?.state === 'Locked' &&
      locked.json?.approvedBy === by('head.one').displayName &&
      /^[0-9a-f]{64}$/.test(locked.json?.lockHash ?? ''),
  );
  const lockedDetail = (await api('viewer.one', 'GET', `/api/v1/valuations/${id}`)).json;
  check(
    'valuation detail: the lock text names the inputs (none) and hashes to the lock hash',
    lockedDetail?.lockText?.includes('"inputs":{}') === true &&
      sha256(lockedDetail.lockText) === locked.json?.lockHash,
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
  // The answer is the new Draft version the reopen created (docs/18 section 1, as the API answers).
  expectStatus(
    'valuation: head.one reopens with a reason (200); the answer is the new Draft version',
    reopened,
    200,
    reopened.json?.state === 'Draft' && reopened.json?.version === 2,
  );
  const afterReopen = await versionsAt('ops.one');
  check(
    'valuation: reopen created version 2 in Draft',
    afterReopen.some((v) => v.version === 1 && v.state === 'Reopened') &&
      afterReopen.some((v) => v.version === 2 && v.state === 'Draft'),
  );

  // The edit of a Draft (VAL-1): operations corrects the reopened version before preparing it.
  const draftId = reopened.json?.id;
  const edit = (credential, body, headers) =>
    api(credential, 'PATCH', `/api/v1/valuations/${draftId}`, body, headers);
  expectStatus(
    'valuation edit: the deal team cannot edit a Draft (403)',
    await edit('deal.one', { fairValue: '5.00' }),
    403,
  );
  const thirdDecimal = await edit('ops.one', { fairValue: '5.005' });
  expectStatus(
    'valuation edit: a value the column could not store is refused, naming the field (400)',
    thirdDecimal,
    400,
    thirdDecimal.json?.errors?.[0]?.path === 'fairValue' && !thirdDecimal.text.includes('5.005'),
  );
  expectStatus(
    'valuation edit: a stale If-Match is refused (412)',
    await edit('ops.one', { fairValue: '5.00' }, { 'if-match': '"99"' }),
    412,
  );
  const notADraft = await api('ops.one', 'PATCH', `/api/v1/valuations/${id}`, {
    fairValue: '5.00',
  });
  expectStatus(
    'valuation edit: the Reopened version is not edited (409, only a Draft can be edited)',
    notADraft,
    409,
    notADraft.json?.detail ===
      'valuation: edit is not allowed from Reopened; only a Draft can be edited',
  );
  const corrected = D(mark.fairValue).times('1.1').toFixed(2);
  const inputs = { multiple: 11.5, source: 'restated sponsor letter' };
  const edited = await edit('ops.one', { fairValue: corrected, inputs }, { 'if-match': '"1"' });
  expectStatus(
    'valuation edit: ops.one corrects the Draft (200): the value, the row version up, still a Draft',
    edited,
    200,
    edited.simulated &&
      edited.json?.state === 'Draft' &&
      edited.json?.fairValue === corrected &&
      edited.json?.rowVersion === 2,
  );
  const editedDetail = (await api('deal.one', 'GET', `/api/v1/valuations/${draftId}`)).json;
  check(
    'valuation detail: the edited Draft shows its inputs, with no approval and no lock',
    JSON.stringify(editedDetail?.inputs) === JSON.stringify(inputs) &&
      editedDetail?.approvals?.length === 0 &&
      editedDetail?.lockText === null &&
      editedDetail?.lockHash === null,
  );
}

// ---- The wire register in the published bundle (WEB-1, D1-05) --------------------------------

// Nothing published carries a full account number, a routing code or a payment reference of the
// register in clear: the book holds each version in its masked form, the recordings none at all.
{
  const publishedFiles = JSON.parse(readFileSync(join(root, 'publish.json'), 'utf8')).files;
  const textFiles = ['artifact.html', ...publishedFiles].filter((f) =>
    /\.(json|csv|js|css|html|txt|svg)$/.test(f),
  );
  const leaks = textFiles.flatMap((f) =>
    bankDetailLeaks(d, readFileSync(join(root, f), 'utf8')).map(
      (leak) => `${f}: ${leak.field} of ${leak.id}`,
    ),
  );
  check(
    `preview bundle: no full account number, routing code or reference of the register in ${textFiles.length} published text files`,
    textFiles.includes('preview/book.json') &&
      textFiles.includes('preview/fixtures.json') &&
      leaks.length === 0,
    leaks.slice(0, 3).join(' | '),
  );
  check(
    'preview bundle: the book carries every wire instruction as its id and its masked form, nothing else',
    Array.isArray(book.wireInstructions) &&
      book.wireInstructions.length === d.wireInstructions.length &&
      book.wireInstructions.every(
        (w) =>
          Object.keys(w).sort().join() === 'bankDetailsMasked,id' &&
          /^.+ \*{4}\d{4}$/.test(w.bankDetailsMasked),
      ),
  );
  // The register's row, even masked, is recorded for the register's readers only (D1-05): the
  // notice detail, the ticket list and the ticket of every other role carry none.
  const outside = d.users.filter((u) => !readsRegister(u));
  const rowsOutside = [];
  for (const u of outside) {
    for (const n of d.capitalNotices) {
      const r = recorded(u.externalId, `/api/v1/capital-notices/${n.id}`);
      if (r.status !== 200) continue;
      if (
        r.json.activeWireInstruction !== null ||
        (r.json.ticket?.wireInstruction ?? null) !== null
      )
        rowsOutside.push(`${u.externalId} notice ${n.id}`);
    }
    const list = recorded(u.externalId, '/api/v1/trade-tickets?limit=200');
    if (list.status === 200 && list.json.items.some((t) => t.wireInstruction !== null))
      rowsOutside.push(`${u.externalId} ticket list`);
  }
  check(
    `recordings: no notice or ticket recorded for the ${outside.length} users outside the register carries a register row`,
    outside.length > 0 && rowsOutside.length === 0,
    rowsOutside.slice(0, 3).join(' | '),
  );
  // The page: the simulated reveal shows a clear reader the masked values of a recorded version
  // and says that the full details are not part of the preview.
  const shown = d.wireInstructions[0];
  const card = await (async () => {
    try {
      await signIn('ops.one');
      await page.goto(`${origin}/#/capital-activity/wires/${shown.id}`);
      await page.getByTestId('wire-details-reveal').click({ timeout: 15_000 });
      return await page.getByTestId('wire-instruction').innerText();
    } catch (error) {
      return `the reveal did not open: ${error instanceof Error ? error.message.split('\n')[0] : 'unknown error'}`;
    }
  })();
  check(
    'wire register page: the reveal shows operations the masked values and says full details are not part of the preview',
    card.includes(`Ends in ${shown.bankDetails.accountNumber.slice(-4)}`) &&
      card.includes('Not part of the preview') &&
      card.includes('Full bank details are not part of this preview') &&
      !card.includes(shown.bankDetails.accountNumber) &&
      !card.includes(shown.bankDetails.routingCode),
    card.startsWith('the reveal did not open') ? card : '',
  );
}

const wire = d.capitalNotices.find((n) => n.scenarioTag === 'wire_change');
const wireFund = d.investments.find((i) => i.id === wire.investmentId)?.sponsorFundId;
if (recorded('ops.one', `/api/v1/capital-notices/${wire.id}`).status !== 200) {
  skip('capital notice journey 4 (wire_change notice)', NOT_RECORDED);
} else {
  // Journey 4 (docs/12) over the simulated controls (decision 0013): review, the drafted ticket
  // and the alerts, dual control and the hold, the callback by a second person, approval,
  // funding and reconciliation.
  const run = (credential, body) =>
    api(credential, 'POST', `/api/v1/capital-notices/${wire.id}/commands`, body);
  const viewerSees = recorded('viewer.one', `/api/v1/capital-notices/${wire.id}`).status === 200;
  expectStatus(
    `capital notice: viewer.one cannot review (${viewerSees ? '403' : '404, not visible'})`,
    await run('viewer.one', { command: 'review' }),
    viewerSees ? 403 : 404,
  );
  const reviewed = await run('ops.one', { command: 'review' });
  expectStatus(
    'capital notice: ops.one reviews (200); the panel shows the Drafted ticket and the wire change alert',
    reviewed,
    200,
    reviewed.json?.state === 'Reviewed' &&
      reviewed.json?.ticket?.state === 'Drafted' &&
      reviewed.json?.alerts?.includes('wire_changed') === true,
  );
  const drafted = await run('ops.one', { command: 'draftTicket' });
  expectStatus(
    'capital notice: ops.one re-drafts the one ticket (200)',
    drafted,
    200,
    drafted.json?.state === 'TicketDrafted' &&
      drafted.json?.ticket?.id === reviewed.json?.ticket?.id,
  );
  const own = await run('ops.one', { command: 'approveTicket' });
  expectStatus(
    'capital notice: the drafter cannot approve (422, SEC-12.3)',
    own,
    422,
    /SEC-12\.3/.test(own.json?.detail ?? ''),
  );
  const held = await run('head.one', { command: 'approveTicket' });
  expectStatus(
    'capital notice: the changed instruction holds the approval (422, SEC-12.3)',
    held,
    422,
    /changed recently/.test(held.json?.detail ?? ''),
  );
  const proposed = (
    await api(
      'ops.one',
      'GET',
      `/api/v1/wire-instructions?limit=200&sponsorFundId=${wireFund}&state=Proposed`,
    )
  ).json?.items?.[0];
  check('wire register: the fund of the notice has a Proposed version', proposed !== undefined);
  const wireCommands = `/api/v1/wire-instructions/${proposed?.id}/commands`;
  const verifyBody = {
    command: 'verify',
    callbackNumberSource: 'prior_instruction',
    callbackResult: 'confirmed',
  };
  expectStatus(
    'wire register: the proposer cannot verify (422, SEC-12.2)',
    await api('ops.one', 'POST', wireCommands, verifyBody),
    422,
  );
  const verified = await api('ops.two', 'POST', wireCommands, verifyBody);
  expectStatus(
    'wire register: ops.two records the callback; the changed version is Verified and active (200)',
    verified,
    200,
    verified.json?.state === 'Verified' && verified.json?.active === true,
  );
  const afterCallback = (await api('head.one', 'GET', `/api/v1/capital-notices/${wire.id}`)).json;
  check(
    'capital notice: the hold lifts and the ticket may be released by a third person',
    afterCallback?.wireChangeHold === null && afterCallback?.ticket?.release?.allowed === true,
    JSON.stringify(afterCallback?.ticket?.release),
  );
  // Inside the hold window the change takes a third person (SEC-12.3): the person whose callback
  // verified it sees the blocker and is refused with the API's sentence.
  const verifierRelease = (await api('ops.two', 'GET', `/api/v1/capital-notices/${wire.id}`)).json
    ?.ticket?.release;
  check(
    'capital notice: the verifier of the change sees the third-person blocker',
    verifierRelease?.allowed === false &&
      verifierRelease?.blockers?.join() === 'verifier_within_hold',
    JSON.stringify(verifierRelease),
  );
  const byVerifier = await run('ops.two', { command: 'approveTicket' });
  expectStatus(
    'capital notice: the verifier of the change cannot approve the release (422, SEC-12.3)',
    byVerifier,
    422,
    byVerifier.json?.detail ===
      'capital_notice: the wire instruction changed recently: the person who verified the change cannot approve the release, a third person must (SEC-12.3)',
  );
  const approved = await run('head.one', { command: 'approveTicket' });
  expectStatus(
    'capital notice: head.one approves the ticket against the verified version (200)',
    approved,
    200,
    approved.json?.state === 'TicketApproved' &&
      approved.json?.ticket?.wireInstruction?.id === proposed?.id,
  );
  const funded = await run('ops.one', { command: 'confirmFunding' });
  expectStatus(
    'capital notice: ops.one confirms funding (200)',
    funded,
    200,
    funded.json?.state === 'Funded' && funded.json?.ticket?.state === 'Funded',
  );
  const reconciled = await run('ops.one', {
    command: 'reconcile',
    reason: 'Wire confirmed by the bank',
  });
  expectStatus(
    "capital notice: ops.one reconciles (200); one approved cash flow for the ticket's amount and no note",
    reconciled,
    200,
    reconciled.json?.state === 'Reconciled' &&
      reconciled.json?.cashFlows?.length === 1 &&
      reconciled.json?.cashFlows?.[0]?.amount === `-${reconciled.json?.ticket?.amount}` &&
      reconciled.json?.notes?.length === 0,
  );
  // The register's row, even masked, goes to the register's readers only (D1-05): a viewer gets
  // none on the notice or the ticket, and the alerts say a Verified instruction is on file.
  if (viewerSees) {
    const asViewer = (await api('viewer.one', 'GET', `/api/v1/capital-notices/${wire.id}`)).json;
    check(
      'capital notice: a viewer gets no register row on the notice or its ticket; the alerts say an instruction is on file',
      asViewer?.state === 'Reconciled' &&
        asViewer?.activeWireInstruction === null &&
        asViewer?.ticket?.wireInstruction === null &&
        asViewer?.alerts?.includes('unverified_instruction') === false &&
        !/\*{4}\d{4}/.test(JSON.stringify(asViewer)),
    );
  }
  const asOperations = (await api('ops.one', 'GET', `/api/v1/capital-notices/${wire.id}`)).json;
  check(
    'capital notice: operations get the active version and the version the ticket was approved against, masked',
    asOperations?.activeWireInstruction?.id === proposed?.id &&
      asOperations?.ticket?.wireInstruction?.id === proposed?.id &&
      /^.+ \*{4}\d{4}$/.test(asOperations?.activeWireInstruction?.bankDetailsMasked ?? ''),
  );
  // The preview holds the masked form of a recorded version only (WEB-1): the reveal answers
  // null to operations as to the auditor, and the page shows the masked values with a note.
  const revealed = (await api('ops.one', 'GET', `/api/v1/wire-instructions/${proposed?.id}`)).json;
  const maskedForAuditor = (
    await api('audit.one', 'GET', `/api/v1/wire-instructions/${proposed?.id}`)
  ).json;
  check(
    'wire register: the reveal of a recorded version answers the masked form only, to operations as to the auditor',
    revealed?.bankDetails === null &&
      maskedForAuditor?.bankDetails === null &&
      /^.+ \*{4}\d{4}$/.test(revealed?.bankDetailsMasked ?? ''),
  );
  check(
    'wire register: the recordings carry no bank details for any credential',
    d.users.every((u) =>
      d.wireInstructions.every((w) => {
        const r = recorded(u.externalId, `/api/v1/wire-instructions/${w.id}`);
        return r.status !== 200 || r.json?.bankDetails === null;
      }),
    ),
  );
  // A version a person types in the session is shown back to that session's clear readers,
  // and to nobody else; a version older than a Verified one is rejected, never verified.
  const typed = {
    bankName: 'Probe Street Bank',
    accountName: 'Probe account',
    accountNumber: '1234500099',
    routingCode: '900000017',
  };
  const proposeTyped = () =>
    api('ops.one', 'POST', '/api/v1/wire-instructions', {
      sponsorFundId: wireFund,
      counterpartyName: d.sponsorFunds.find((f) => f.id === wireFund)?.name ?? 'Probe fund',
      bankDetails: typed,
    });
  const older = await proposeTyped();
  const olderPath = `/api/v1/wire-instructions/${older.json?.id}`;
  expectStatus(
    'wire register: ops.one proposes a version by hand (201); what was typed is shown back to operations and the approver, never to the auditor',
    older,
    201,
    older.json?.bankDetails?.accountNumber === typed.accountNumber &&
      (await api('head.one', 'GET', olderPath)).json?.bankDetails?.routingCode ===
        typed.routingCode &&
      (await api('audit.one', 'GET', olderPath)).json?.bankDetails === null &&
      (await api('audit.one', 'GET', olderPath)).json?.bankDetailsMasked ===
        'Probe Street Bank ****0099',
  );
  const newer = await proposeTyped();
  expectStatus(
    'wire register: a newer version is proposed and verified while the older one still waits (200)',
    await api(
      'ops.two',
      'POST',
      `/api/v1/wire-instructions/${newer.json?.id}/commands`,
      verifyBody,
    ),
    200,
    newer.json?.version === (older.json?.version ?? 0) + 1,
  );
  const overNewer = await api('ops.two', 'POST', `${olderPath}/commands`, verifyBody);
  expectStatus(
    'wire register: the older Proposed version is not verified over the newer Verified one (422, SEC-12.2)',
    overNewer,
    422,
    overNewer.json?.detail ===
      'wire_instruction: a newer version of this counterparty is already Verified; reject this older version instead (SEC-12.2)',
  );
  const resultOnly = await api('ops.two', 'POST', `${olderPath}/commands`, {
    command: 'reject',
    callbackResult: 'not_confirmed',
    reason: 'Superseded before its callback',
  });
  expectStatus(
    'wire register: a failed callback without its number source is refused with the field (400, SEC-12.2)',
    resultOnly,
    400,
    resultOnly.json?.errors?.[0]?.path === 'callbackNumberSource',
  );
  const failedCallback = await api('ops.two', 'POST', `${olderPath}/commands`, {
    command: 'reject',
    callbackNumberSource: 'known_contact',
    callbackResult: 'not_confirmed',
    reason: 'Superseded before its callback',
  });
  expectStatus(
    'wire register: the older version is rejected with its failed callback logged (200)',
    failedCallback,
    200,
    failedCallback.json?.state === 'Rejected' &&
      failedCallback.json?.callback?.result === 'not_confirmed' &&
      failedCallback.json?.callback?.numberSource === 'known_contact',
  );
  const tickets = (await api('ops.one', 'GET', '/api/v1/trade-tickets?limit=200')).json;
  check(
    'trade tickets: the list carries the funded ticket with no release and every row masked',
    tickets?.items?.some((t) => t.capitalNoticeId === wire.id && t.state === 'Funded') === true &&
      !JSON.stringify(tickets).includes('accountNumber'),
  );
}

// ---- The valuation detail and the batch screen (M10), the change requests (M11) --------------

const draftVersion = (
  await api('ops.one', 'GET', `/api/v1/valuations?investmentId=${staleId}&limit=200`)
).json?.items?.find((r) => r.state === 'Draft');
if (draftVersion === undefined) {
  skip('valuation detail and batch', 'skipped: the reopen above left no Draft version');
} else {
  const detail = (await api('viewer.one', 'GET', `/api/v1/valuations/${draftVersion.id}`)).json;
  check(
    'valuation detail: the new Draft version reads with an empty trail and no lock text',
    detail?.approvals?.length === 0 && detail?.lockText === null,
  );
  const prepared = await api('ops.one', 'POST', `/api/v1/valuations/${draftVersion.id}/commands`, {
    command: 'prepare',
  });
  expectStatus('valuation: ops.one prepares version 2 (200)', prepared, 200);
  const batch = await api('deal.one', 'POST', '/api/v1/valuations/batch-commands', {
    command: 'dealTeamApprove',
    ids: [draftVersion.id, '00000000-0000-4000-8000-000000000000'],
  });
  expectStatus(
    'valuation batch: one result per id, the approval and a 404, in the order sent',
    batch,
    200,
    batch.json?.results?.[0]?.state === 'DealTeamApproved' &&
      batch.json?.results?.[1]?.problem?.status === 404,
  );
  const trail = (await api('viewer.one', 'GET', `/api/v1/valuations/${draftVersion.id}`)).json;
  check(
    'valuation detail: the trail carries the prepare and the deal team approval',
    trail?.approvals?.map((a) => a.step).join(',') === 'ops_prepared,deal_team',
  );
  expectStatus(
    'valuation edit: an approved version is not edited (409)',
    await api('ops.one', 'PATCH', `/api/v1/valuations/${draftVersion.id}`, { fairValue: '5.00' }),
    409,
  );
  // The corrected version locks: the hash covers the value and the inputs the edit gave it.
  const relocked = await api('head.one', 'POST', `/api/v1/valuations/${draftVersion.id}/commands`, {
    command: 'lock',
  });
  const relockedDetail = (await api('viewer.one', 'GET', `/api/v1/valuations/${draftVersion.id}`))
    .json;
  expectStatus(
    'valuation: the corrected version locks; its lock text names the inputs and hashes to the lock hash',
    relocked,
    200,
    relockedDetail?.lockText?.includes(
      '"inputs":{"multiple":11.5,"source":"restated sponsor letter"}',
    ) === true && sha256(relockedDetail.lockText) === relocked.json?.lockHash,
  );
}

// A recorded Locked version the build recorded no detail for (scripts/preview-plan.mjs records
// the first positions only): the simulation builds it from the list row, which carries the
// people and the real hash, so the lock text verifies as it does against the API (VAL-6).
const undetailed = (
  (await api('viewer.one', 'GET', '/api/v1/valuations?limit=200')).json?.items ?? []
).find(
  (r) =>
    r.state === 'Locked' &&
    r.investmentId !== staleId &&
    recorded('viewer.one', `/api/v1/valuations/${r.id}`).status === undefined,
);
if (undetailed === undefined) {
  skip('valuation detail: a recorded Locked version without a recorded detail', NOT_RECORDED);
} else {
  const built = (await api('viewer.one', 'GET', `/api/v1/valuations/${undetailed.id}`)).json;
  check(
    'valuation detail: a recorded Locked version without a recorded detail names its approver and verifies its lock',
    built?.approvedBy === by('head.one').displayName &&
      built?.approvedAt !== null &&
      JSON.stringify(built?.inputs) === '{}' &&
      sha256(built?.lockText ?? '') === built?.lockHash,
  );
}

const changeRequest = await api('deal.one', 'POST', '/api/v1/change-requests', {
  investmentId: staleId,
  changeType: 'change_type.add_on_acquisition',
  effectiveDate: asOf,
  summary: 'Add-on acquisition of a regional competitor closed',
  details: { target: 'A regional competitor' },
});
expectStatus(
  'change request: deal.one submits the one form (201, simulated)',
  changeRequest,
  201,
  changeRequest.simulated && changeRequest.json?.state === 'Submitted',
);
const changeRequestId = changeRequest.json?.id;
const routed = await api(
  'deal.one',
  'POST',
  `/api/v1/change-requests/${changeRequestId}/commands`,
  {
    command: 'route',
    ownerId: by('ops.one').id,
  },
);
expectStatus(
  'change request: routed to ops.one (200)',
  routed,
  200,
  routed.json?.state === 'Routed' && routed.json?.owner?.id === by('ops.one').id,
);
expectStatus(
  'change request: ops.one starts the work (200)',
  await api('ops.one', 'POST', `/api/v1/change-requests/${changeRequestId}/commands`, {
    command: 'start',
  }),
  200,
);

// The valuation screen lists a position's open requests for the roles the change request
// routes serve, and for nobody else (CR-5).
const staleLocked = (
  (await api('ops.one', 'GET', `/api/v1/valuations?investmentId=${staleId}&limit=200`)).json
    ?.items ?? []
).find((r) => r.state === 'Locked');
if (staleLocked === undefined) {
  skip('valuation detail: open change requests by role', 'skipped: no Locked version to open');
} else {
  const forOps = (await api('ops.one', 'GET', `/api/v1/valuations/${staleLocked.id}`)).json;
  const forViewer = (await api('viewer.one', 'GET', `/api/v1/valuations/${staleLocked.id}`)).json;
  check(
    'valuation detail: operations reads the open change request of the position, a viewer reads none',
    forOps?.openChangeRequests?.some((r) => r.id === changeRequestId) === true &&
      forViewer?.openChangeRequests?.length === 0,
  );
}

// A request on the walled position, by a member of the wall: the owner must be inside the wall
// (CR-3), and operations outside it never sees the request or its exception (CR-1, CR-2).
const walledRequest = await api('deal.three', 'POST', '/api/v1/change-requests', {
  investmentId: walledId,
  changeType: 'change_type.add_on_acquisition',
  effectiveDate: asOf,
  summary: 'Add-on acquisition behind the wall',
  details: {},
});
expectStatus(
  'change request: a wall member submits one on the walled position (201)',
  walledRequest,
  201,
);
const walledRequestId = walledRequest.json?.id;
const outsideOwner = await api(
  'deal.three',
  'POST',
  `/api/v1/change-requests/${walledRequestId}/commands`,
  { command: 'route', ownerId: by('ops.one').id },
);
expectStatus(
  'change request: an owner outside the wall is refused (422) in the API words',
  outsideOwner,
  422,
  outsideOwner.json?.detail ===
    'deal_change_request: the owner is outside the wall of this position and could not open the request; name an owner inside the wall',
);

const checked = await api('ops.one', 'POST', '/api/v1/change-requests/quarter-end-check', {
  periodEnd: quarterEnd,
});
expectStatus(
  'change request: the quarter-end check lists the unapplied request and opens exceptions',
  checked,
  200,
  checked.json?.unapplied?.some((r) => r.id === changeRequestId) === true &&
    checked.json?.exceptionsOpened >= 1,
);
const opsQueue = (
  await api('ops.one', 'GET', '/api/v1/data-exceptions?limit=200&source=change_request')
).json;
const memberQueue = (
  await api('head.one', 'GET', '/api/v1/data-exceptions?limit=200&source=change_request')
).json;
check(
  'change request: the walled request is counted as hidden, never listed, and its exception stays inside the wall',
  checked.json?.hidden === 1 &&
    checked.json?.unapplied?.every((r) => r.id !== walledRequestId) === true &&
    !checked.text.includes(walledRequestId) &&
    opsQueue?.items?.every((x) => x.entityId !== walledRequestId) === true &&
    memberQueue?.items?.some((x) => x.entityId === walledRequestId) === true,
);
const hiddenException = memberQueue?.items?.find((x) => x.entityId === walledRequestId);
expectStatus(
  'change request: the exception about the walled request is not found outside the wall (404)',
  await api('ops.one', 'GET', `/api/v1/data-exceptions/${hiddenException?.id}`),
  404,
);
// A change is applied in a quarter that has started: never one after the current quarter (CR-6).
const tooLate = await api(
  'ops.one',
  'POST',
  `/api/v1/change-requests/${changeRequestId}/commands`,
  { command: 'apply', appliedPeriod: nextQuarterEnd(asOf) },
);
expectStatus(
  'change request: applying in a quarter after the current one is refused (422)',
  tooLate,
  422,
  tooLate.json?.detail?.includes('is after the current quarter end') === true,
);

// ---- The pipeline (M5) and the closing (M8, M22) at the API level -----------------------------

const sponsor = d.sponsors[0];
const createdDeal = await api('deal.one', 'POST', '/api/v1/opportunities', {
  name: 'Project Probe',
  companyName: 'Probe Logistics Co',
  sponsorId: sponsor.id,
  dealType: 'deal_type.co_invest_equity',
  receivedDate: asOf,
  targetCommitment: '15000000.00',
});
expectStatus(
  'pipeline: deal.one creates a deal at Sourced (201, simulated)',
  createdDeal,
  201,
  createdDeal.simulated && createdDeal.json?.stage === 'Sourced',
);
const dealId = createdDeal.json?.id;
const screening = await api('deal.one', 'POST', `/api/v1/opportunities/${dealId}/commands`, {
  command: 'advance',
});
expectStatus(
  'pipeline: advanced to Screening (200)',
  screening,
  200,
  screening.json?.stage === 'Screening',
);
check(
  'pipeline: the board lists the new deal for a viewer',
  (await api('viewer.one', 'GET', '/api/v1/opportunities?limit=200')).json?.items?.some(
    (o) => o.id === dealId,
  ) === true,
);
const closingOpenId = d.scenarios.closing_open[0];
const closingOpen = d.closings.find((c) => c.opportunityId === closingOpenId);
const closingPath = `/api/v1/closings/${closingOpen.id}`;
const blocked = await api('ops.one', 'POST', `${closingPath}/commands`, { command: 'confirm' });
expectStatus(
  'closing: confirmation is refused while the wire confirmation is open (422, M8)',
  blocked,
  422,
  /required closing document/.test(blocked.json?.detail ?? ''),
);
const received = await api('ops.one', 'POST', `${closingPath}/items/wire_confirmation/commands`, {
  command: 'receive',
  documentId: walkDocumentId,
});
expectStatus(
  'closing: ops.one receives the wire confirmation from the hub (200)',
  received,
  200,
  received.json?.itemsRequiredOpen === 0,
);
const closingOpenPath = `/api/v1/opportunities/${closingOpenId}`;
const gatesOfClosingOpen = async () =>
  (await api('deal.one', 'GET', closingOpenPath)).json?.gates?.closing;
const advanceClosingOpen = () =>
  api('ops.one', 'POST', `${closingOpenPath}/commands`, { command: 'advance' });

// The tie-out sums received amounts only (M22): a line with none keeps the closing from confirming.
const recordedLines = (received.json?.allocations ?? []).map((a) => ({
  vehicleId: a.vehicle.id,
  ...(a.client === null ? {} : { clientId: a.client.id }),
  requested: a.requested,
  ...(a.received === null ? {} : { received: a.received }),
}));
const putLines = (lines) =>
  api('deal.one', 'PUT', `${closingOpenPath}/allocations`, { allocations: lines });
const withoutReceived = await putLines(
  recordedLines.map((line, i) =>
    i === 0
      ? {
          vehicleId: line.vehicleId,
          ...(line.clientId === undefined ? {} : { clientId: line.clientId }),
          requested: line.requested,
        }
      : line,
  ),
);
const receivedElsewhere = recordedLines
  .slice(1)
  .reduce((sum, line) => sum + Number(line.received ?? 0), 0);
expectStatus(
  'closing: a line with no received amount does not tie, whatever was requested (200, M22)',
  withoutReceived,
  200,
  recordedLines.length > 0 &&
    withoutReceived.json?.closing?.allocationTieOut?.tiedOut === false &&
    Math.abs(
      Number(withoutReceived.json?.closing?.allocationTieOut?.allocated) - receivedElsewhere,
    ) < 0.005,
);
// After the simulated replace the simulation holds every line: it still answers a viewer the
// lines a viewer may read, with the deal's totals and tie-out and the count of lines not shown.
const replacedForViewer = (await api('viewer.one', 'GET', closingOpenPath)).json;
const replacedClientLines = recordedLines.filter((line) => line.clientId !== undefined).length;
const sameFigures = (mine, theirs) =>
  JSON.stringify({ ...mine, hiddenLines: 0 }) === JSON.stringify({ ...theirs, hiddenLines: 0 });
check(
  'closing: after a simulated replace a viewer is shown no client line, the count not shown and the same tie-out',
  replacedClientLines > 0 &&
    replacedForViewer?.allocations?.every((a) => a.client === null) === true &&
    replacedForViewer?.allocationTotals?.hiddenLines === replacedClientLines &&
    replacedForViewer?.closing?.allocationTieOut?.hiddenLines === replacedClientLines &&
    withoutReceived.json?.allocationTotals?.hiddenLines === 0 &&
    sameFigures(replacedForViewer?.allocationTotals, withoutReceived.json?.allocationTotals) &&
    sameFigures(
      replacedForViewer?.closing?.allocationTieOut,
      withoutReceived.json?.closing?.allocationTieOut,
    ),
  JSON.stringify(replacedForViewer?.allocationTotals ?? null),
);
const missingReceived = await api('ops.one', 'POST', `${closingPath}/commands`, {
  command: 'confirm',
});
expectStatus(
  'closing: the confirmation says how many received amounts are missing (422, M22)',
  missingReceived,
  422,
  missingReceived.json?.detail === 'closing: received amounts are missing on 1 line (M22)',
);
expectStatus(
  'closing: the recorded lines, received in full, tie out again (200)',
  await putLines(recordedLines),
  200,
  (await gatesOfClosingOpen())?.allocationTiedOut === true,
);

// The gate reads clear only once operations confirmed (M8).
const beforeConfirmation = await gatesOfClosingOpen();
check(
  'closing: with the checklist in and the lines tying, the gate still waits for the confirmation',
  beforeConfirmation?.checklistComplete === true &&
    beforeConfirmation?.allocationTiedOut === true &&
    beforeConfirmation?.confirmed === false &&
    beforeConfirmation?.ok === false,
);
const unconfirmedAdvance = await advanceClosingOpen();
expectStatus(
  'pipeline: Closing to Closed is refused while the closing is not confirmed (422, M8)',
  unconfirmedAdvance,
  422,
  unconfirmedAdvance.json?.detail === 'the closing is not confirmed by operations (M8)',
);
const confirmedClosing = await api('ops.one', 'POST', `${closingPath}/commands`, {
  command: 'confirm',
});
const afterConfirmation = await gatesOfClosingOpen();
expectStatus(
  'closing: ops.one confirms (200); the deal gates read confirmed and ok',
  confirmedClosing,
  200,
  confirmedClosing.json?.state === 'OpsConfirmed' &&
    afterConfirmation?.confirmed === true &&
    afterConfirmation?.ok === true,
);

// What operations confirmed stays as confirmed until they reopen it with a reason.
const CONFIRMED_REFUSAL =
  'the closing is confirmed; change the close date or ask operations to reopen it';
const frozenLines = await putLines(recordedLines);
expectStatus(
  'closing: the allocation lines of a confirmed closing are refused (422)',
  frozenLines,
  422,
  frozenLines.json?.detail === CONFIRMED_REFUSAL,
);
const frozenItem = await api('ops.one', 'POST', `${closingPath}/items/wire_confirmation/commands`, {
  command: 'reopen',
});
expectStatus(
  'closing: the checklist items of a confirmed closing are refused (422)',
  frozenItem,
  422,
  frozenItem.json?.detail === CONFIRMED_REFUSAL,
);
const REOPEN_REASON = 'Probe: a line moves to the second vehicle';
expectStatus(
  'closing: the reopen is for operations (403 for the deal team)',
  await api('deal.one', 'POST', `${closingPath}/commands`, {
    command: 'reopen',
    reason: REOPEN_REASON,
  }),
  403,
);
const reopenedClosing = await api('ops.one', 'POST', `${closingPath}/commands`, {
  command: 'reopen',
  reason: REOPEN_REASON,
});
expectStatus(
  'closing: ops.one reopens with a reason (200): Open, the confirmation cleared, the gate waiting again',
  reopenedClosing,
  200,
  reopenedClosing.json?.state === 'Open' &&
    reopenedClosing.json?.opsConfirmedBy === null &&
    (await gatesOfClosingOpen())?.confirmed === false,
);
expectStatus(
  'closing: an Open closing is not reopened (409)',
  await api('ops.one', 'POST', `${closingPath}/commands`, {
    command: 'reopen',
    reason: REOPEN_REASON,
  }),
  409,
);
expectStatus(
  'closing: ops.one confirms again (200)',
  await api('ops.one', 'POST', `${closingPath}/commands`, { command: 'confirm' }),
  200,
);
const closedDeal = await advanceClosingOpen();
expectStatus(
  'pipeline: ops.one closes the deal; the position appears on the portfolio grid with its close date',
  closedDeal,
  200,
  closedDeal.json?.stage === 'Closed' &&
    (await api('viewer.one', 'GET', '/api/v1/investments?limit=100')).json?.items?.[0]?.id ===
      closedDeal.json?.investmentId &&
    (await api('viewer.one', 'GET', `/api/v1/investments/${closedDeal.json?.investmentId}`)).json
      ?.closeDate === closingOpen.closeDate,
);

// Once the position exists, the close date is its entry date: the closing no longer moves.
const POSITION_REFUSAL = 'the position exists; record the change through a deal change request';
for (const body of [
  { command: 'changeCloseDate', closeDate: asOf, reason: 'Probe: the signing date moved' },
  { command: 'reopen', reason: 'Probe: the signing date moved' },
]) {
  const refused = await api('ops.one', 'POST', `${closingPath}/commands`, body);
  expectStatus(
    `closing: ${body.command} is refused once the position exists (422)`,
    refused,
    422,
    refused.json?.detail === POSITION_REFUSAL,
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
  'reset: the created deal, the change request and the new wire version are gone',
  (await api('viewer.one', 'GET', '/api/v1/opportunities?limit=200')).json?.items?.every(
    (o) => o.id !== dealId,
  ) === true &&
    (await api('ops.one', 'GET', `/api/v1/change-requests/${changeRequestId}`)).status === 404 &&
    (await api('ops.one', 'GET', '/api/v1/wire-instructions?limit=200&state=Proposed')).json?.items
      ?.length === 1,
);
// ---- Value creation and entry metrics (M13, M20), from the recordings alone ------------------

const VALUE_CREATION = '/api/v1/analytics/value-creation';
/** Dollars as $M with one decimal, as the pages write them; a change carries its sign. */
const moneyM = (value) => {
  const millions = D(value).div(1_000_000);
  return `${millions.isNegative() ? '-' : ''}$${millions.abs().toFixed(1)}M`;
};
const signedM = (value) =>
  moneyM(value).startsWith('-') || D(value).isZero() ? moneyM(value) : `+${moneyM(value)}`;
const vcViewer = recorded('viewer.one', VALUE_CREATION).json;
const vcMember = recorded('deal.three', VALUE_CREATION).json;
check(
  'value creation: recorded for every user, with the export and every position (200, 404 past the wall)',
  d.users.every(
    (u) =>
      recorded(u.externalId, VALUE_CREATION).status === 200 &&
      fixtures.responses[keyFor(u.externalId, 'GET', `${VALUE_CREATION}/export`)]?.status === 200 &&
      d.investments.every((i) =>
        [200, 404].includes(
          recorded(u.externalId, `/api/v1/investments/${i.id}/value-creation`).status,
        ),
      ),
  ) && recorded('viewer.one', `/api/v1/investments/${walledId}/value-creation`).status === 404,
);
check(
  'value creation: the wall member sees one position more than a viewer, as recorded (SEC-5.3)',
  vcMember.positions.length === vcViewer.positions.length + 1 &&
    vcMember.positions.some((p) => p.id === walledId) &&
    !JSON.stringify(vcViewer).includes(walledId),
  `viewer ${vcViewer.positions.length}, member ${vcMember.positions.length}`,
);
/**
 * The four parts of a recorded roll-up (the three drivers and mark and timing) are its gain
 * exactly, no driver outweighs the gain, and invested plus the gain is the value now.
 */
const partsOf = (g) => [g.ebitdaGrowth, g.multipleExpansion, g.debtPaydown, g.other];
const rollUpTies = (portfolio) =>
  portfolio.gainByDriver !== null &&
  partsOf(portfolio.gainByDriver)
    .reduce((acc, part) => acc.plus(part), D('0'))
    .eq(portfolio.gain) &&
  partsOf(portfolio.gainByDriver)
    .slice(0, 3)
    .every((part) => D(part).abs().lt(D(portfolio.gain).abs())) &&
  D(portfolio.invested).plus(portfolio.gain).eq(portfolio.totalValue) &&
  portfolio.positions + portfolio.notCalculable.reduce((n, r) => n + r.count, 0) > 0;
check(
  'value creation: the bridge with mark and timing sums to the headline exactly for a viewer and for the wall member (recorded)',
  rollUpTies(vcViewer.portfolio) && rollUpTies(vcMember.portfolio),
  `viewer gain ${vcViewer.portfolio.gain}, member gain ${vcMember.portfolio.gain}`,
);
/** A split row: each driver part is our entry stake times the company's driver, and the four parts are the gain. */
const rowTies = (p) =>
  p.gainByDriver === null ||
  (partsOf(p.gainByDriver)
    .reduce((acc, part) => acc.plus(part), D('0'))
    .eq(p.gain) &&
    ['ebitdaGrowth', 'multipleExpansion', 'debtPaydown'].every((key) =>
      D(p.invested)
        .times(p.bridge[key])
        .div(p.bridge.equityAtEntry)
        .minus(p.gainByDriver[key])
        .abs()
        .lte('1e-9'),
    ) &&
    D(p.invested).div(p.bridge.equityAtEntry).minus(p.stake).abs().lte('1e-9'));
check(
  'value creation: every split row is our entry stake times the company drivers plus the remainder (recorded)',
  vcMember.positions.every(rowTies) && vcMember.positions.some((p) => p.gainByDriver !== null),
);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rolledFor = (view, rows = view.positions) =>
  valueCreationRollup(rows, view.cohorts, view.asOf);
check(
  'value creation: the roll-up of the recorded rows is the recorded portfolio and cohorts, field for field (the one rule a page filters by)',
  [vcViewer, vcMember].every(
    (view) =>
      sameJson(rolledFor(view).portfolio, view.portfolio) &&
      sameJson(rolledFor(view).cohorts, view.cohorts),
  ),
);
check(
  'value creation: a realized position stops at its exit, and a forward-dated entry snapshot has its own reason (recorded)',
  vcMember.positions
    .filter((p) => p.status === 'realized')
    .every((p) => p.current === null || p.current.periodEnd <= p.exitDate) &&
    vcMember.positions.some((p) => p.status === 'realized' && p.current !== null) &&
    vcMember.positions.find((p) => p.id === d.scenarios.forward_entry_snapshot[0])
      ?.notCalculable === 'entry_snapshot_forward_dated' &&
    !JSON.stringify(vcMember).includes('no_equity_change'),
);
await signIn('viewer.one');
await page.goto(`${origin}/#/analytics/value-creation`);
await page.getByTestId('value-creation-tiles').waitFor();
const vcPortfolio = vcViewer.portfolio;
const vcBridge = page.getByRole('group', { name: 'Our gain by driver' });
const bridgeMarks = await vcBridge
  .getByRole('img')
  .evaluateAll((marks) => marks.map((m) => m.getAttribute('aria-label')));
check(
  'value creation tab: the headline is the recorded gain and the bridge shows the recorded steps',
  (
    await page
      .getByTestId('value-creation-tiles')
      .getByRole('group', { name: 'Our gain' })
      .innerText()
  ).includes(moneyM(vcPortfolio.gain)) &&
    JSON.stringify(bridgeMarks) ===
      JSON.stringify([
        `Invested: ${moneyM(vcPortfolio.invested)}`,
        `EBITDA growth: ${signedM(vcPortfolio.gainByDriver.ebitdaGrowth)}`,
        `Multiple expansion: ${signedM(vcPortfolio.gainByDriver.multipleExpansion)}`,
        `Debt paydown: ${signedM(vcPortfolio.gainByDriver.debtPaydown)}`,
        `Mark and timing: ${signedM(vcPortfolio.gainByDriver.other)}`,
        `Value now: ${moneyM(vcPortfolio.totalValue)}`,
      ]) &&
    (
      await page
        .getByTestId('value-creation-tiles')
        .getByRole('group', { name: 'Mark and timing' })
        .innerText()
    ).includes(signedM(vcPortfolio.gainByDriver.other)),
  bridgeMarks.join(' | '),
);
const pickOption = async (combobox, option) => {
  await page.getByRole('combobox', { name: combobox, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
};
const growthMarks = () =>
  page
    .getByRole('group', { name: 'Valuation growth against EBITDA growth' })
    .getByRole('img')
    .evaluateAll((marks) => marks.map((m) => m.getAttribute('aria-label')));
const onMark = await growthMarks();
await pickOption('Valuation measure', 'Enterprise value');
const onEv = await growthMarks();
const evPlotted = vcViewer.positions.filter(
  (p) => p.growth.evGrowth !== null && p.growth.ebitdaGrowth !== null,
);
const evAhead = evPlotted.filter((p) => D(p.growth.evGrowth).gt(p.growth.ebitdaGrowth)).length;
check(
  'value creation tab: the valuation chart compares our mark by default and the enterprise value on demand, where the companies fall on both sides of the line',
  onMark.length > 0 &&
    onMark.every((label) => label.includes('Growth in our mark')) &&
    onEv.length === evPlotted.length &&
    onEv.every((label) => label.includes('Enterprise value growth')) &&
    evAhead > 0 &&
    evAhead < evPlotted.length &&
    (await page.getByTestId('value-creation-growth-card').innerText()).includes(
      `${evAhead} of ${evPlotted.length} marks sit above the line`,
    ),
  `${evAhead} of ${evPlotted.length} above the line on enterprise value`,
);
await pickOption('Valuation measure', 'Our mark');
const vcRows = page.getByRole('table', { name: 'Value creation by position' }).locator('tbody tr');
check(
  'value creation tab: one row per recorded position, the valuation chart with its reference line, and no walled name for a viewer',
  (await vcRows.count()) === vcViewer.positions.length &&
    (await page.getByTestId('value-creation-scatter-equal-line').count()) === 1 &&
    !(await page.getByTestId('value-creation-positions').innerText()).includes(walledName),
  `${await vcRows.count()} rows`,
);
const [vcDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.getByTestId('value-creation-export').click(),
]);
await page.getByTestId('value-creation-action-status').filter({ hasText: 'Exported' }).waitFor();
const vcCsv = (
  await api('viewer.one', 'GET', `${VALUE_CREATION}/export`, null, { accept: 'text/csv' })
).text;
check(
  'value creation tab: Export CSV downloads the recorded rows (the header plus one line per position)',
  vcDownload.suggestedFilename() === `value-creation-${fixtures.asOf}.csv` &&
    (await page.getByTestId('value-creation-action-status').innerText()).includes(
      `Exported ${vcViewer.positions.length} rows to value-creation-${fixtures.asOf}.csv`,
    ) &&
    vcCsv.split('\n')[0].startsWith('investmentNumber,companyName,') &&
    vcCsv.split('\n').length === vcViewer.positions.length + 2 &&
    !vcCsv.includes(walledName),
  vcDownload.suggestedFilename(),
);
// The filters: one vehicle, in the page over the one recorded answer, with no new recording.
const vcCounts = new Map();
for (const p of vcViewer.positions) vcCounts.set(p.vehicleId, (vcCounts.get(p.vehicleId) ?? 0) + 1);
const vcVehicleId = [...vcCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
const vcVehicleRows = vcViewer.positions.filter((p) => p.vehicleId === vcVehicleId);
const vcVehicleRoll = rolledFor(vcViewer, vcVehicleRows);
// The gain of the vehicle summed here row by row, apart from the roll-up the page uses.
const vcVehicleGain = vcVehicleRows
  .filter((p) => p.gainByDriver !== null)
  .reduce((acc, p) => acc.plus(p.gain), D('0'));
const missesBeforeFilter = (await misses()).length;
await pickOption('Vehicle', vcVehicleRows[0].vehicleName);
await page
  .getByTestId('value-creation-filter-count')
  .filter({ hasText: `${vcVehicleRows.length} of ${vcViewer.positions.length} positions` })
  .waitFor();
const filteredMarks = await vcBridge
  .getByRole('img')
  .evaluateAll((marks) => marks.map((m) => m.getAttribute('aria-label')));
check(
  'value creation tab: a filter to one vehicle recomputes the headline and the bridge exactly, keeps the filter in the address and records nothing new',
  vcVehicleRows.length > 1 &&
    vcVehicleRows.length < vcViewer.positions.length &&
    D(vcVehicleRoll.portfolio.gain).eq(vcVehicleGain) &&
    (
      await page
        .getByTestId('value-creation-tiles')
        .getByRole('group', { name: 'Our gain' })
        .innerText()
    ).includes(moneyM(vcVehicleRoll.portfolio.gain)) &&
    JSON.stringify(filteredMarks) ===
      JSON.stringify([
        `Invested: ${moneyM(vcVehicleRoll.portfolio.invested)}`,
        `EBITDA growth: ${signedM(vcVehicleRoll.portfolio.gainByDriver.ebitdaGrowth)}`,
        `Multiple expansion: ${signedM(vcVehicleRoll.portfolio.gainByDriver.multipleExpansion)}`,
        `Debt paydown: ${signedM(vcVehicleRoll.portfolio.gainByDriver.debtPaydown)}`,
        `Mark and timing: ${signedM(vcVehicleRoll.portfolio.gainByDriver.other)}`,
        `Value now: ${moneyM(vcVehicleRoll.portfolio.totalValue)}`,
      ]) &&
    (await vcRows.count()) === vcVehicleRows.length &&
    page.url().includes(`vehicleId=${vcVehicleId}`) &&
    (await misses()).length === missesBeforeFilter,
  filteredMarks.join(' | '),
);
const [vcFilteredDownload] = await Promise.all([
  page.waitForEvent('download'),
  page.getByTestId('value-creation-export').click(),
]);
await page
  .getByTestId('value-creation-action-status')
  .filter({ hasText: `Exported ${vcVehicleRows.length} rows` })
  .waitFor();
const vcFilteredCsv = readFileSync(await vcFilteredDownload.path(), 'utf8')
  .trimEnd()
  .split('\n');
check(
  'value creation tab: the export follows the filter (the recorded file narrowed to the rows the view shows)',
  vcFilteredCsv.length === vcVehicleRows.length + 1 &&
    vcFilteredCsv[0] === vcCsv.split('\n')[0] &&
    vcVehicleRows.every((p) => vcFilteredCsv.some((line) => line.endsWith(`,${p.id}`))) &&
    vcFilteredCsv.slice(1).every((line) => vcCsv.split('\n').includes(line)) &&
    (await misses()).length === missesBeforeFilter,
  `${vcFilteredCsv.length - 1} lines`,
);
// The filter carries to the Entry metrics tab, where each cohort is pooled over the vehicle's rows.
await page.getByRole('navigation', { name: 'Analytics' }).getByText('Entry metrics').click();
await page.getByRole('table', { name: 'Performance by entry purchase multiple' }).waitFor();
const filteredBars = await page
  .getByRole('group', { name: 'Gross MOIC by entry purchase multiple' })
  .getByRole('img')
  .evaluateAll((marks) => marks.map((m) => m.getAttribute('aria-label')));
check(
  'entry metrics tab: under the filter each band is pooled again over the rows that pass (MOIC bars as rolled up), and the filter came with the tab',
  page.url().includes(`vehicleId=${vcVehicleId}`) &&
    JSON.stringify(filteredBars) ===
      JSON.stringify(
        vcVehicleRoll.cohorts.byEntryMultiple
          .filter((c) => c.key !== 'not_calculable' && c.grossMoic !== null)
          .map((c) => `${c.label}: ${D(c.grossMoic).toFixed(2)}x`),
      ) &&
    !sameJson(vcVehicleRoll.cohorts.byEntryMultiple, vcViewer.cohorts.byEntryMultiple),
  filteredBars.join(' | '),
);
// A filter that leaves no position: the empty state, never zeros.
await page.goto(`${origin}/#/analytics/value-creation?entryYear=1999`);
await page.getByText('No position matches these filters').waitFor();
check(
  'value creation tab: a filter that leaves no position shows the empty state, not zeros',
  (await page.getByTestId('value-creation-tiles').count()) === 0 &&
    (await page.getByText('$0.0M').count()) === 0 &&
    (await page.getByTestId('value-creation-filter-count').innerText()).includes(
      `0 of ${vcViewer.positions.length} positions`,
    ),
);
await page.goto(`${origin}/#/analytics/entry-metrics`);
await page.getByRole('table', { name: 'Performance by entry net leverage' }).waitFor();
const bandsOk = async (metric, cohorts) => {
  const banded = cohorts.filter((c) => c.key !== 'not_calculable');
  const bars = await page
    .getByRole('group', { name: `Gross MOIC by ${metric}` })
    .getByRole('img')
    .evaluateAll((marks) => marks.map((m) => m.getAttribute('aria-label')));
  const rows = await page
    .getByRole('table', { name: `Performance by ${metric}` })
    .locator('tbody tr')
    .count();
  return (
    banded.filter((c) => c.count > 0).length >= 3 &&
    JSON.stringify(bars) ===
      JSON.stringify(
        banded
          .filter((c) => c.grossMoic !== null)
          .map((c) => `${c.label}: ${D(c.grossMoic).toFixed(2)}x`),
      ) &&
    rows === cohorts.filter((c) => c.key !== 'not_calculable' || c.count > 0).length &&
    cohorts.reduce((n, c) => n + c.count, 0) === vcViewer.positions.length
  );
};
check(
  'entry metrics tab: MOIC bars and a row per band for entry multiple and entry leverage, at least three bands populated, every position counted',
  (await bandsOk('entry purchase multiple', vcViewer.cohorts.byEntryMultiple)) &&
    (await bandsOk('entry net leverage', vcViewer.cohorts.byEntryLeverage)) &&
    (await page
      .getByRole('group', { name: 'Entry purchase multiple against gross MOIC' })
      .count()) === 1,
);
const vcDeal = vcViewer.positions.find((p) => p.bridge !== null && p.isActive);
await page.goto(`${origin}/#/portfolio/${vcDeal.id}/performance`);
await page.getByTestId('deal-value-creation').waitFor();
const dealMarks = await page
  .getByRole('group', { name: 'Value creation bridge' })
  .getByRole('img')
  .evaluateAll((marks) => marks.map((m) => m.getAttribute('aria-label')));
check(
  'deal workspace: the value creation card shows the company bridge, the indexed lines and entry against current',
  JSON.stringify(dealMarks) ===
    JSON.stringify([
      `Equity value at entry: ${moneyM(vcDeal.bridge.equityAtEntry)}`,
      `EBITDA growth: ${signedM(vcDeal.bridge.ebitdaGrowth)}`,
      `Multiple expansion: ${signedM(vcDeal.bridge.multipleExpansion)}`,
      `Debt paydown: ${signedM(vcDeal.bridge.debtPaydown)}`,
      `Equity value now: ${moneyM(vcDeal.bridge.equityCurrent)}`,
    ]) &&
    D(vcDeal.bridge.ebitdaGrowth)
      .plus(vcDeal.bridge.multipleExpansion)
      .plus(vcDeal.bridge.debtPaydown)
      .minus(vcDeal.bridge.total)
      .abs()
      .lte('3e-10') &&
    (await page.getByRole('group', { name: 'Indexed since entry' }).count()) === 1 &&
    (await page.getByRole('table', { name: 'Entry against current' }).count()) === 1,
  dealMarks.join(' | '),
);
const vcCredit = d.investments.find((i) => i.dealType === 'deal_type.private_credit');
await page.goto(`${origin}/#/portfolio/${vcCredit.id}/performance`);
await page.getByTestId('deal-credit-terms').waitFor();
await settle();
check(
  'deal workspace: a credit position has no value creation row as recorded, and shows no card',
  recorded('viewer.one', `/api/v1/investments/${vcCredit.id}/value-creation`).json?.position ===
    null && (await page.getByTestId('deal-value-creation').count()) === 0,
);
// ---- The position against the sponsor's base case (decision 0022), as recorded ---------------

const underwritingPath = (id) => `/api/v1/investments/${id}/underwriting`;
const scenarioId = (name) => d.scenarios[name][0];
const STATUS_WORDS = { ahead: 'Ahead of plan', on_plan: 'On plan', behind: 'Behind plan' };
const loanRead = recorded('viewer.one', underwritingPath(vcCredit.id)).json;
check(
  'base case: recorded for every user and every position (200, 404 past the wall), a loan with the credit form and its case',
  d.users.every((u) =>
    d.investments.every((i) =>
      [200, 404].includes(recorded(u.externalId, underwritingPath(i.id)).status),
    ),
  ) &&
    recorded('viewer.one', underwritingPath(walledId)).status === 404 &&
    recorded('deal.three', underwritingPath(walledId)).json?.comparedVersion === 1 &&
    loanRead?.form === 'credit' &&
    loanRead.versions.length === 1 &&
    loanRead.versions[0].form === 'credit' &&
    loanRead.versions[0].points.length === 0 &&
    loanRead.comparedVersion === 1,
);
const statusOnPage = async (name) => {
  const id = scenarioId(name);
  await page.goto(`${origin}/#/portfolio/${id}/performance`);
  const tile = page
    .getByTestId('deal-underwriting-tiles')
    .getByRole('group', { name: 'EBITDA against plan' });
  await tile.waitFor();
  const headline = recorded('viewer.one', underwritingPath(id)).json?.comparison?.headline;
  return { headline, text: await tile.innerText() };
};
const seen = {};
for (const name of ['underwriting_ahead', 'underwriting_on_plan', 'underwriting_behind'])
  seen[name] = await statusOnPage(name);
check(
  'deal workspace: the base case card badges EBITDA ahead of, on and behind plan as the API judged each seeded position',
  seen.underwriting_ahead.headline === 'ahead' &&
    seen.underwriting_on_plan.headline === 'on_plan' &&
    seen.underwriting_behind.headline === 'behind' &&
    Object.values(seen).every((s) => s.text.includes(STATUS_WORDS[s.headline])),
  Object.values(seen)
    .map((s) => s.text.replaceAll('\n', ' '))
    .join(' | '),
);
check(
  'deal workspace: the base case card charts actual against plan and sets the drivers against the planned bridge',
  (await page.getByRole('group', { name: 'EBITDA, actual and plan' }).count()) === 1 &&
    (await page.getByRole('table', { name: 'Value creation against plan' }).count()) === 1 &&
    (await page.getByTestId('deal-underwriting-case').innerText()).includes('Entry case'),
);
const noCase = d.investments.find(
  (i) =>
    recorded('viewer.one', underwritingPath(i.id)).json?.form === 'equity' &&
    recorded('viewer.one', underwritingPath(i.id)).json.versions.length === 0,
);
await page.goto(`${origin}/#/portfolio/${noCase.id}/performance`);
await page.getByTestId('deal-underwriting-empty').waitFor();
const noCaseText = await page.getByTestId('deal-underwriting').innerText();
await page.goto(`${origin}/#/portfolio/${scenarioId('underwriting_draft')}/performance`);
await page.getByTestId('deal-underwriting-draft').waitFor();
const draftText = await page.getByTestId('deal-underwriting').innerText();
await page.goto(`${origin}/#/portfolio/${scenarioId('underwriting_withdrawn')}/performance`);
await page.getByTestId('deal-underwriting-versions').waitFor();
const withdrawnText = await page.getByTestId('deal-underwriting').innerText();
check(
  'deal workspace: no base case, a draft alone and a withdrawn case each say what they are, and none is compared',
  noCaseText.includes('No base case recorded.') &&
    draftText.includes('A draft base case waits for a second person to confirm it.') &&
    withdrawnText.includes('No base case stands') &&
    (await page.getByTestId('deal-underwriting-tiles').count()) === 0,
);
// A loan is judged on its IRR alone: its card shows the IRR as the API judged it and the yield
// to maturity of its own credit terms, with no company figure, no chart and no drivers.
await page.goto(`${origin}/#/portfolio/${vcCredit.id}/performance`);
await page.getByTestId('deal-credit-terms').waitFor();
await page.getByTestId('deal-underwriting-tiles').waitFor();
await settle();
const loanTiles = page.getByTestId('deal-underwriting-tiles');
const loanIrrText = await loanTiles
  .getByRole('group', { name: 'Gross IRR against plan' })
  .innerText();
const loanYieldText = await loanTiles.getByRole('group', { name: 'Yield to maturity' }).innerText();
const loanTerms = recorded('viewer.one', `/api/v1/investments/${vcCredit.id}/performance`).json
  ?.credit?.terms;
const loanYield = loanRead?.comparison?.yieldToMaturity ?? null;
check(
  'deal workspace: a loan is compared on its IRR alone, with the yield to maturity of its credit terms and no company plan',
  loanRead?.comparison?.metrics.length === 0 &&
    loanRead.comparison.valueCreation === null &&
    loanRead.comparison.returns.irrStatus !== null &&
    loanIrrText.includes(STATUS_WORDS[loanRead.comparison.returns.irrStatus]) &&
    loanYield !== null &&
    loanYield === loanTerms?.yieldToMaturity &&
    loanYieldText.includes(`${D(loanYield).times(100).toFixed(2)}%`) &&
    (await loanTiles.getByRole('group').count()) === 5 &&
    (await loanTiles.getByRole('group', { name: 'EBITDA against plan' }).count()) === 0 &&
    (await page.getByTestId('deal-underwriting-chart').count()) === 0 &&
    (await page.getByTestId('deal-underwriting-drivers').count()) === 0 &&
    (await page.getByTestId('deal-underwriting-yield-note').innerText()).includes(
      'Yield to maturity is priced on the fair value of the latest approved credit quarter, which our own mark does not change. It rises when that fair value falls, so it is not judged.',
    ) &&
    (await page.getByTestId('deal-underwriting-case').innerText()).includes('Expected repayment'),
  `${loanIrrText.replaceAll('\n', ' ')} | ${loanYieldText.replaceAll('\n', ' ')}`,
);
// Its card follows the terms of the facility and comes before its quarters: the three cards in
// the order the page holds them.
const loanCardOrder = await page
  .locator(
    '[data-testid="deal-credit-terms"], [data-testid="deal-underwriting"], [data-testid="deal-credit-quarters"]',
  )
  .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-testid')));
check(
  'deal workspace: the loan card sits after the credit terms and before the credit quarters',
  loanCardOrder.join() === 'deal-credit-terms,deal-underwriting,deal-credit-quarters',
  loanCardOrder.join(', '),
);

// ---- The base case read worked out in the browser, and the simulated writes -----------------

// The shim works the comparison out again on every read (src/preview/routes/underwriting.ts),
// from the credential's recorded performance, one-pager and value creation answers. Before any
// simulated write it must give back what the API recorded, for every user and every position.
const underwritingDiffs = [];
let underwritingCompared = 0;
for (const u of d.users) {
  for (const i of d.investments) {
    const was = recorded(u.externalId, underwritingPath(i.id));
    const now = await api(u.externalId, 'GET', underwritingPath(i.id));
    if ((was.json?.comparison ?? null) !== null) underwritingCompared += 1;
    if (now.status !== was.status || (was.status === 200 && !isDeepStrictEqual(now.json, was.json)))
      underwritingDiffs.push(`${u.externalId} ${i.investmentNumber}: ${now.status}`);
  }
}
check(
  'base case: the comparison worked out in the browser equals the API recording, for every user and every position',
  underwritingDiffs.length === 0 && underwritingCompared > 0,
  underwritingDiffs.length === 0
    ? `${underwritingCompared} comparisons`
    : underwritingDiffs.slice(0, 5).join(' | '),
);

// A version the reader picks was never recorded: the re-underwritten position answers both.
const reunderwrittenId = scenarioId('underwriting_reunderwritten');
const twoCases = recorded('viewer.one', underwritingPath(reunderwrittenId)).json;
const laterCase = twoCases.versions.find((v) => v.kind === 'reunderwrite');
const pickedRead = await api(
  'viewer.one',
  'GET',
  `${underwritingPath(reunderwrittenId)}?version=${laterCase.version}`,
);
await page.goto(`${origin}/#/portfolio/${reunderwrittenId}/performance`);
await page.getByTestId('deal-underwriting-tiles').waitFor();
const missesBeforePick = (await misses()).length;
const laterLabel = /Re-underwritten [A-Z][a-z]{2} \d{1,2}, \d{4}/.exec(
  await page.getByTestId('deal-underwriting-versions').innerText(),
)?.[0];
await pickOption('Compared with', laterLabel);
await page.getByRole('table', { name: `${laterLabel}, terms` }).waitFor();
check(
  'base case: the reader picks the re-underwritten case, the comparison is worked out for it and nothing is missed',
  pickedRead.status === 200 &&
    pickedRead.json?.comparedVersion === laterCase.version &&
    twoCases.comparedVersion !== laterCase.version &&
    pickedRead.json.comparison.returns.irrGap !== twoCases.comparison.returns.irrGap &&
    (await misses()).length === missesBeforePick,
  `${twoCases.comparedVersion} then ${pickedRead.json?.comparedVersion}`,
);
expectStatus(
  'base case: a version that never stood as the plan is not found',
  await api('viewer.one', 'GET', `${underwritingPath(reunderwrittenId)}?version=99`),
  404,
);

// The two-person rule, on a position with no base case whose page was not opened yet (the page
// holds a read for a minute): deal.one records a Draft and cannot confirm it, deal.two does, and
// only then is the position compared.
const journeyPosition = d.investments.find(
  (i) =>
    i.id !== noCase.id &&
    recorded('deal.one', underwritingPath(i.id)).json?.form === 'equity' &&
    recorded('deal.one', underwritingPath(i.id)).json.versions.length === 0,
);
const journeyPerf = recorded(
  'deal.one',
  `/api/v1/investments/${journeyPosition.id}/performance`,
).json;
const snapshot = journeyPerf.entry;
const plannedExit = `${Number(snapshot.periodEnd.slice(0, 4)) + 7}-12-31`;
const grown = (value, by) => (value === null ? null : D(value).times(by).toFixed(2));
const caseBody = {
  caseDate: snapshot.periodEnd,
  plannedExitDate: plannedExit,
  exitMultiple: '11',
  grossMoic: '2.5',
  grossIrr: '0.2',
  points: [
    {
      periodEnd: snapshot.periodEnd,
      revenueLtm: snapshot.revenueLtm,
      ebitdaLtm: snapshot.ebitdaLtm,
      netDebt: snapshot.netDebt,
    },
    {
      periodEnd: plannedExit,
      revenueLtm: grown(snapshot.revenueLtm, '1.8'),
      ebitdaLtm: grown(snapshot.ebitdaLtm, '2'),
      netDebt: grown(snapshot.netDebt, '0.6'),
    },
  ],
  sourceNote: 'Sponsor base case model, held in the deal folder',
};
const caseCommands = (id) => `/api/v1/underwriting-cases/${id}/commands`;
expectStatus(
  'base case: a viewer cannot record one',
  await api('viewer.one', 'POST', underwritingPath(journeyPosition.id), caseBody),
  403,
);
const draftCase = await api('deal.one', 'POST', underwritingPath(journeyPosition.id), caseBody);
expectStatus(
  'base case: the deal team records a Draft, which is shown and not compared',
  draftCase,
  201,
  draftCase.simulated &&
    draftCase.json?.state === 'Draft' &&
    (await api('viewer.one', 'GET', underwritingPath(journeyPosition.id))).json?.notCalculable ===
      'draft_only',
);
const ownConfirm = await api('deal.one', 'POST', caseCommands(draftCase.json.id), {
  command: 'confirm',
});
expectStatus(
  'base case: the person who entered the figures cannot confirm them',
  ownConfirm,
  422,
  (ownConfirm.json?.detail ?? '').includes('cannot confirm'),
);
const confirmedCase = await api(
  'deal.two',
  'POST',
  caseCommands(draftCase.json.id),
  { command: 'confirm' },
  { 'if-match': `"${draftCase.json.rowVersion}"` },
);
const comparedNow = (await api('viewer.one', 'GET', underwritingPath(journeyPosition.id))).json;
const journeyDetail = recorded('viewer.one', `/api/v1/investments/${journeyPosition.id}`).json;
expectStatus(
  'base case: a second person confirms it, and the position is compared with it from its own recorded figures',
  confirmedCase,
  200,
  confirmedCase.json?.state === 'Confirmed' &&
    confirmedCase.json.confirmedBy?.name === by('deal.two').displayName &&
    comparedNow?.comparedVersion === 1 &&
    comparedNow.comparison?.returns.grossMoic === journeyDetail.grossMoic &&
    comparedNow.comparison.metrics.length === 3,
);
await page.goto(`${origin}/#/portfolio/${journeyPosition.id}/performance`);
await page.getByTestId('deal-underwriting-tiles').waitFor();
check(
  'deal workspace: the card compares the position with the case confirmed in this session',
  (await page.getByTestId('deal-underwriting-case').innerText()).includes(
    by('deal.two').displayName,
  ),
);

// The same rule through the page: deal.one records a base case with the form, which shows every
// figure back in full before it saves, and is told a second person confirms it; deal.two
// confirms, and the card compares the position for every reader.
const formPosition = d.investments.find(
  (i) =>
    i.id !== noCase.id &&
    i.id !== journeyPosition.id &&
    recorded('deal.one', underwritingPath(i.id)).json?.form === 'equity' &&
    recorded('deal.one', underwritingPath(i.id)).json.versions.length === 0,
);
if (formPosition === undefined) {
  skip('base case form', 'skipped: no third position without a base case in this dataset');
} else {
  const formSnapshot = recorded('deal.one', `/api/v1/investments/${formPosition.id}/performance`)
    .json.entry;
  const formExit = `${Number(formSnapshot.periodEnd.slice(0, 4)) + 7}-12-31`;
  const millions = (value, times = '1') => D(value).times(times).div(1_000_000).toFixed(1);
  const dollars = (typed) => Number(D(typed).times(1_000_000).toFixed(0)).toLocaleString('en-US');
  const inFull = (typed) => '$' + dollars(typed) + '.00';
  const entryRevenue = millions(formSnapshot.revenueLtm);
  await switchTo('deal.one');
  await page.goto(`${origin}/#/portfolio/${formPosition.id}/performance`);
  await page.getByRole('button', { name: 'Record base case' }).click();
  const caseForm = page.getByRole('form', { name: 'Record the base case' });
  await caseForm.getByLabel('Case date').fill(formSnapshot.periodEnd);
  await caseForm.getByLabel('Planned exit').fill(formExit);
  await caseForm.getByLabel('Exit multiple').fill('11');
  await caseForm.getByLabel('Underwritten gross MOIC').fill('2.5');
  await caseForm.getByLabel('Underwritten gross IRR').fill('20');
  await caseForm.getByLabel('Twelve months ending, plan date 1').fill(formSnapshot.periodEnd);
  const figure = (name, row) => caseForm.getByLabel(`${name} in US$ millions, plan date ${row}`);
  await figure('Revenue', 1).fill(entryRevenue);
  await figure('EBITDA', 1).fill(millions(formSnapshot.ebitdaLtm));
  await figure('Net debt', 1).fill(millions(formSnapshot.netDebt));
  await figure('Revenue', 2).fill(millions(formSnapshot.revenueLtm, '1.8'));
  await figure('EBITDA', 2).fill(millions(formSnapshot.ebitdaLtm, '2'));
  await figure('Net debt', 2).fill(millions(formSnapshot.netDebt, '0.6'));
  await caseForm.getByLabel('Where the model is held').fill('Sponsor model, in the deal folder');
  await caseForm.getByRole('button', { name: 'Review figures' }).click();
  const reviewText = await page.getByTestId('underwriting-review').innerText();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await page.getByTestId('underwriting-own-figures').waitFor();
  const afterSave = await page.getByTestId('deal-underwriting').innerText();
  check(
    'base case form: the deal team records a Draft after seeing its figures in full, and is told a second person confirms it',
    reviewText.includes(inFull(entryRevenue)) &&
      reviewText.includes('Underwritten gross IRR') &&
      reviewText.includes('20%') &&
      afterSave.includes(
        'Draft recorded: a second person confirms it (simulated in this preview',
      ) &&
      afterSave.includes('You entered these figures. A second person confirms them.') &&
      afterSave.includes('A draft base case waits for a second person to confirm it.') &&
      (await page.getByRole('button', { name: 'Confirm', exact: true }).count()) === 0 &&
      (await page.getByRole('button', { name: 'Edit draft' }).count()) === 1,
    `${inFull(entryRevenue)} in the review: ${reviewText.includes(inFull(entryRevenue))}`,
  );
  await switchTo('deal.two');
  await page.goto(`${origin}/#/portfolio/${formPosition.id}/performance`);
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByTestId('deal-underwriting-tiles').waitFor();
  const afterConfirm = await page.getByTestId('deal-underwriting').innerText();
  await switchTo('viewer.one');
  await page.goto(`${origin}/#/portfolio/${formPosition.id}/performance`);
  await page.getByTestId('deal-underwriting-tiles').waitFor();
  await settle();
  const card = page.getByTestId('deal-underwriting');
  check(
    'base case form: a second person confirms on the page, and every reader then sees the position compared, with nothing to act on',
    afterConfirm.includes('Base case confirmed (simulated in this preview') &&
      afterConfirm.includes('EBITDA AGAINST PLAN') &&
      (await page.getByTestId('deal-underwriting-case').innerText()).includes(
        by('deal.two').displayName,
      ) &&
      (await card.getByRole('button', { name: 'Revise' }).count()) === 0 &&
      (await card.getByRole('button', { name: 'Retire' }).count()) === 0,
  );
}

// A loan's base case through the page: deal.one revises the seeded case from its own rates in
// a loan's form (no exit multiple, no plan), an approver confirms the correction, and the loan
// is compared with it.
{
  const seededLoanCase = loanRead.versions[0];
  await switchTo('deal.one');
  await page.goto(`${origin}/#/portfolio/${vcCredit.id}/performance`);
  await page.getByTestId('deal-underwriting-tiles').waitFor();
  await page.getByTestId('deal-underwriting').getByRole('button', { name: 'Revise' }).click();
  const loanForm = page.getByRole('form', { name: 'Revise the base case' });
  const yieldTyped = await loanForm.getByLabel('Underwritten yield').inputValue();
  const loanFormShape =
    (await loanForm.getByLabel('Expected repayment').inputValue()) ===
      seededLoanCase.plannedExitDate &&
    (await loanForm.getByLabel('Exit multiple').count()) === 0 &&
    (await loanForm.getByRole('table').count()) === 0 &&
    (await loanForm.getByRole('button', { name: 'Add a plan date' }).count()) === 0;
  await loanForm.getByLabel('Annual loss rate').fill('2.5');
  await loanForm.getByLabel('Reason for the revision').fill('The loss rate was mistyped');
  await loanForm.getByRole('button', { name: 'Review figures' }).click();
  const loanReview = await page.getByTestId('underwriting-review').innerText();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await page.getByTestId('underwriting-own-figures').waitFor();
  const loanDraft = await page.getByTestId('deal-underwriting-draft').innerText();
  check(
    "base case form: the deal team revises a loan's case in a loan's form, from its own rates, with no plan to type",
    D(yieldTyped).div(100).eq(seededLoanCase.underwrittenYield) &&
      loanFormShape &&
      loanReview.includes('Annual loss rate') &&
      loanReview.includes('2.5%') &&
      !loanReview.includes('Plan as it will be saved') &&
      loanDraft.includes('Draft correction of the case dated') &&
      loanDraft.includes('2.50%') &&
      (await page.getByTestId('deal-underwriting-tiles').count()) === 1,
    `yield typed ${yieldTyped}`,
  );
  await switchTo('head.one');
  await page.goto(`${origin}/#/portfolio/${vcCredit.id}/performance`);
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByTestId('deal-underwriting-versions').waitFor();
  await page.getByTestId('deal-underwriting-case').getByText('2.50%').waitFor();
  const loanNow = (await api('viewer.one', 'GET', underwritingPath(vcCredit.id))).json;
  check(
    'base case form: an approver confirms the correction of a loan, which replaces the case it corrects and is the one compared',
    (await page.getByTestId('deal-underwriting').innerText()).includes(
      'Correction confirmed: it replaces the case it corrects (simulated in this preview',
    ) &&
      loanNow?.comparedVersion === 2 &&
      loanNow.versions.map((v) => v.state).join() === 'Superseded,Confirmed' &&
      loanNow.versions[1].annualLossRate === '0.02500000' &&
      loanNow.comparison.returns.grossIrr === loanRead.comparison.returns.grossIrr &&
      loanNow.comparison.yieldToMaturity === loanRead.comparison.yieldToMaturity &&
      (await page.getByTestId('deal-underwriting-tiles').getByRole('group').count()) === 5,
    loanNow?.versions.map((v) => `${v.version} ${v.state}`).join(', '),
  );
}
await switchTo('deal.three');
await page.goto(`${origin}/#/analytics/value-creation`);
await page.getByTestId('value-creation-tiles').waitFor();
check(
  'value creation tab: the wall member sees the walled position row and the member headline',
  (await vcRows.count()) === vcMember.positions.length &&
    (await page.getByTestId('value-creation-positions').innerText()).includes(walledName) &&
    (
      await page
        .getByTestId('value-creation-tiles')
        .getByRole('group', { name: 'Our gain' })
        .innerText()
    ).includes(moneyM(vcMember.portfolio.gain)),
  `${await vcRows.count()} rows`,
);

// ---- Valuation suggestions (decision 0023): the example sequence in the built preview ------
// Nothing is recorded: a suggestion exists only once a statement or a sponsor report is approved
// in the session. The session starts afresh, so the sequence is the one the walkthrough names.
await api('viewer.one', 'POST', '/api/v1/preview/reset');
const SUGGESTIONS = '/api/v1/valuation-suggestions';
const suggestionsOf = async (who, query = '') =>
  (await api(who, 'GET', `${SUGGESTIONS}?limit=200${query}`)).json;
check(
  'suggestions: none before anything is approved, and a viewer is refused',
  (await suggestionsOf('ops.one', '&state=all'))?.items?.length === 0 &&
    (await api('viewer.one', 'GET', `${SUGGESTIONS}?limit=200`)).status === 403,
);
await api('ops.one', 'POST', '/api/v1/documents/index');
await api('admin.one', 'PATCH', '/api/v1/flags/ai.extraction', {
  enabled: true,
  reason: 'probe: valuation suggestions',
});
const staleDocuments =
  (await api('ops.one', 'GET', `/api/v1/documents?limit=200&investmentId=${staleId}`)).json
    ?.items ?? [];
const staleDocument = (docType) =>
  staleDocuments.find(
    (x) => x.docType === docType && x.periodEnd === quarterEnd && x.reviewStatus === 'Classified',
  );
/** One run for one document, as operations queue it (a batch covers one document type). */
const runFor = async (doc) => {
  const batch = await api('ops.one', 'POST', '/api/v1/extraction/batches', {
    documentIds: [doc.id],
  });
  const runs =
    (await api('ops.one', 'GET', `/api/v1/extraction/runs?limit=200&batchId=${batch.json?.id}`))
      .json?.items ?? [];
  return runs.find((r) => r.documentId === doc.id);
};
/** Decides every value of a run (clean and flagged accepted, the rest rejected) and approves it. */
const approveRun = async (who, runId) => {
  const commands = `/api/v1/extraction/runs/${runId}/commands`;
  const before = (await api(who, 'GET', `/api/v1/extraction/runs/${runId}`)).json;
  for (const v of before?.values ?? []) {
    if (v.decision !== null || v.validationState === 'clean') continue;
    await api(
      who,
      'POST',
      commands,
      v.validationState === 'flagged'
        ? { command: 'accept', field: v.field }
        : { command: 'reject', field: v.field, reason: 'probe: not read' },
    );
  }
  await api(who, 'POST', commands, { command: 'acceptClean' });
  return api(who, 'POST', commands, { command: 'approve' });
};
const staleReport = staleDocument('doc_type.quarterly_financials');
const staleStatement = staleDocument('doc_type.capital_account_statement');
const statementExpected = docExpectations.positionStatements.find(
  (p) => p.investmentId === staleId && p.periodEnd === quarterEnd,
);
if (staleReport === undefined || staleStatement === undefined || statementExpected === undefined) {
  check(
    'suggestions: the stale position has a report and a statement for the latest quarter',
    false,
    `report ${staleReport?.fileName}, statement ${staleStatement?.fileName}`,
  );
} else {
  const reportRun = await runFor(staleReport);
  const statementRun = await runFor(staleStatement);
  const reportApproved = await approveRun('ops.one', reportRun.id);
  const afterReport = await suggestionsOf('ops.one');
  const fromReport = afterReport?.items?.[0];
  check(
    'suggestions: approving the sponsor report opens one, the last Locked mark scaled by the equity value',
    reportApproved.status === 200 &&
      afterReport?.openCount === 1 &&
      fromReport?.investmentId === staleId &&
      fromReport.periodEnd === quarterEnd &&
      fromReport.basis === 'sponsor_equity_value' &&
      fromReport.method === 'valuation_method.report_indication' &&
      fromReport.suggestedValue !== null &&
      fromReport.currentMark?.previousQuarter === true &&
      fromReport.source.extractionRunId === reportRun.id &&
      fromReport.workings.inputs.map((i) => i.key).join() ===
        'reference_mark,reference_enterprise_value,reference_net_debt,enterprise_value,net_debt',
    `${reportApproved.status}: ${fromReport?.basis} ${fromReport?.suggestedValue}`,
  );
  // A deal team reviewer approves the statement: they stand behind its figure from here on.
  const statementApproved = await approveRun('deal.one', statementRun.id);
  const afterStatement = await suggestionsOf('ops.one');
  const fromStatement = afterStatement?.items?.[0];
  const replaced = (await api('ops.one', 'GET', `${SUGGESTIONS}/${fromReport?.id}`)).json;
  const beside = fromStatement?.crossChecks?.[0];
  check(
    'suggestions: approving the statement replaces it with the ending balance, the report indication beside it',
    statementApproved.status === 200 &&
      afterStatement?.openCount === 1 &&
      fromStatement?.basis === 'capital_account_balance' &&
      fromStatement.method === 'valuation_method.sponsor_mark' &&
      D(fromStatement.suggestedValue).eq(statementExpected.endingBalance) &&
      fromStatement.checks?.ties === true &&
      fromStatement.crossChecks.length === 1 &&
      beside.basis === 'sponsor_equity_value' &&
      D(beside.value).eq(fromReport.suggestedValue) &&
      beside.differs === false &&
      D(beside.difference).abs().lt(10_000) &&
      replaced?.state === 'Superseded' &&
      replaced.supersededReason === 'better_source' &&
      replaced.supersededById === fromStatement.id &&
      replaced.suggestedValue === fromReport.suggestedValue,
    `${fromStatement?.basis} ${fromStatement?.suggestedValue} beside ${beside?.value}; the first is ${replaced?.state}`,
  );
  const outcomes = {
    report: (await suggestionsOf('ops.one', `&extractionRunId=${reportRun.id}&state=all`))
      ?.runOutcome,
    statement: (await suggestionsOf('ops.one', `&extractionRunId=${statementRun.id}&state=all`))
      ?.runOutcome,
  };
  check(
    'suggestions: each run says what its approval did',
    outcomes.report?.outcome === 'opened' &&
      outcomes.statement?.outcome === 'replaced' &&
      outcomes.statement.suggestionId === fromStatement?.id,
    JSON.stringify(outcomes),
  );

  // The pages, as operations: the run, the list, the workings and the draft opened from them.
  await switchTo('ops.one');
  await page.goto(`${origin}/#/documents/extraction/${statementRun.id}`);
  await page.getByTestId('run-suggestion').waitFor();
  check(
    'suggestions: the statement run page says the suggestion was replaced, and what to do about a wrong position',
    (await page.getByTestId('run-suggestion').innerText()).includes(
      'Valuation suggestion replaced',
    ) && (await page.getByTestId('run-relink-note').isVisible()),
    await page.getByTestId('run-suggestion').innerText(),
  );
  await page.goto(`${origin}/#/valuations/suggestions`);
  await page.getByTestId('suggestions-table').waitFor();
  check(
    'suggestions: the tab lists the open suggestion with its position and its source',
    (await page.getByTestId('suggestions-table').innerText()).includes(staleDetail.companyName) &&
      (await page.getByTestId('suggestions-table').innerText()).includes(
        'Capital account statement',
      ),
    await page.getByTestId('suggestions-table').innerText(),
  );
  await page
    .getByRole('link', { name: /^Workings, / })
    .first()
    .click();
  await page.getByTestId('suggestion-detail').waitFor();
  check(
    'suggestions: the workings give the rule and the other source of the quarter',
    (await page.getByTestId('suggestion-rule').innerText()).includes('ending capital balance') &&
      (await page.getByTestId('suggestion-detail').innerText()).includes('Sponsor report'),
    await page.getByTestId('suggestion-rule').innerText(),
  );
  await page.getByRole('button', { name: 'Open a draft valuation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Open a draft valuation' }).click();
  await page
    .getByTestId('suggestion-action-status')
    .filter({ hasText: 'Draft valuation opened' })
    .waitFor();
  const accepted = (await api('ops.one', 'GET', `${SUGGESTIONS}/${fromStatement?.id}`)).json;
  const draft = (await api('ops.one', 'GET', `/api/v1/valuations/${accepted?.valuationId}`)).json;
  check(
    'suggestions: Open a draft valuation opens a Draft at the suggested value, with where it came from',
    accepted?.state === 'Accepted' &&
      draft?.state === 'Draft' &&
      draft.investmentId === staleId &&
      draft.periodEnd === quarterEnd &&
      draft.method === 'valuation_method.sponsor_mark' &&
      draft.fairValue === fromStatement.suggestedValue &&
      draft.inputs?.['suggestion.id'] === fromStatement.id &&
      draft.inputs['suggestion.documentId'] === staleStatement.id &&
      (await suggestionsOf('ops.one'))?.openCount === 0,
    `${accepted?.state}; draft ${draft?.state} ${draft?.fairValue}`,
  );
  await page.getByRole('link', { name: 'Open the valuation it went onto' }).click();
  await page.getByTestId('valuation-from-suggestion').waitFor();
  check(
    'suggestions: the version screen says the valuation was started from a suggestion',
    (await page.getByTestId('valuation-from-suggestion').innerText()).includes(
      'Started from a suggestion of',
    ),
    await page.getByTestId('valuation-from-suggestion').innerText(),
  );
  // Whoever approved the run behind the figure cannot approve the valuation it went onto.
  const versionCommands = `/api/v1/valuations/${draft?.id}/commands`;
  await api('ops.two', 'POST', versionCommands, { command: 'prepare' });
  const barred = await api('deal.one', 'POST', versionCommands, { command: 'dealTeamApprove' });
  const another = await api('deal.two', 'POST', versionCommands, { command: 'dealTeamApprove' });
  check(
    'suggestions: the reviewer who approved the statement cannot approve the valuation; another deal team user can',
    barred.status === 422 &&
      (barred.json?.detail ?? '').includes('cannot approve the valuation') &&
      another.status === 200 &&
      another.json?.state === 'DealTeamApproved',
    `barred ${barred.status}: ${barred.json?.detail ?? ''}; another ${another.status}`,
  );
  await switchTo('viewer.one');
  await page.goto(`${origin}/#/valuations/suggestions`);
  await page.getByTestId('suggestions-not-shown').waitFor();
  check(
    'suggestions: a viewer is told who suggestions are for, and the tab is not in the row',
    !(await page.getByRole('navigation', { name: 'Valuations' }).innerText()).includes(
      'Suggestions',
    ),
  );
}

// ---- Reporting packages (decision 0024): the release gate in the built preview --------------
// Nothing is recorded: a package exists only once investor relations starts one in the session.
// The session starts afresh, so the record is the recordings' own: the package the generator
// names as failing fails on the position with no Locked mark at the start of the quarter and,
// labelled final, on the stale mark no session has locked yet.
await api('viewer.one', 'POST', '/api/v1/preview/reset');
const preparer = packageCase.user.externalId;
const breakRef = packageCase.positionNumber;
const breakCompany = d.portfolioCompanies.find(
  (c) => c.id === d.investments.find((i) => i.investmentNumber === breakRef).portfolioCompanyId,
).name;
const staleRef = d.investments.find((i) => i.id === staleId).investmentNumber;
const quarterWords = `Q${Math.ceil(Number(quarterEnd.slice(5, 7)) / 3)} ${quarterEnd.slice(0, 4)}`;
const packageWords = `${packageCase.client.name}, ${quarterWords}, gross, version 1`;
const SIMULATED = '(simulated in this preview, not audited)';
const packageStatus = page.getByTestId('package-action-status');
const packageActions = page.getByTestId('package-actions');
const packageOf = async (who, id) => (await api(who, 'GET', `${PACKAGES}/${id}`)).json;
const packageCommand = (who, id, body, headers) =>
  api(who, 'POST', `${PACKAGES}/${id}/commands`, body, headers);
/** A card's or a row's text on one line, for the detail of a check. */
const oneLine = (text) => text.replace(/\s+/g, ' ').slice(0, 160);
/** A finding as the engine states it, for comparing the page's answer with the rules. */
const findingKey = (f) => `${f.rule} ${f.entityRef}`;
const asEngine = (findings) =>
  findings
    .map(({ rule, entityRef, expected, actual, passed, detail }) => ({
      rule,
      entityRef,
      expected,
      actual,
      passed,
      detail,
    }))
    .sort((a, b) => (findingKey(a) < findingKey(b) ? -1 : findingKey(a) > findingKey(b) ? 1 : 0));
/** The cells of the Checks table row for a check about one thing: Result, Check, About, Expected, Found, Detail. */
const checkCells = (checkName, about) =>
  page
    .getByRole('table', { name: 'Checks' })
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: checkName, exact: true }) })
    .filter({ hasText: about })
    .getByRole('cell')
    .allInnerTexts();

check(
  'packages: none after a reset; a viewer and a platform admin are refused the list',
  (await api(preparer, 'GET', PACKAGES)).json?.items?.length === 0 &&
    (await api('viewer.one', 'GET', PACKAGES)).status === 403 &&
    (await api('admin.one', 'GET', PACKAGES)).status === 403,
);
await switchTo(preparer);
await page.goto(`${origin}/#/reporting/packages`);
await page.getByTestId('packages-empty').waitFor();
await page.getByTestId('packages-card').getByRole('button', { name: 'Start package' }).click();
const startForm = page.getByTestId('package-start-form');
await startForm.getByRole('combobox', { name: 'Client' }).click();
await page.getByRole('option', { name: packageCase.client.name, exact: true }).click();
await startForm.getByRole('combobox', { name: 'Basis' }).click();
await page.getByRole('option', { name: 'Gross', exact: true }).click();
await startForm.getByRole('combobox', { name: 'Label' }).click();
await page.getByRole('option', { name: 'Final', exact: true }).click();
const quarterChosen = await startForm.getByRole('combobox', { name: 'Quarter' }).innerText();
await startForm.getByRole('button', { name: 'Start package' }).click();
await page.waitForURL(/#\/reporting\/packages\/[0-9a-f-]{36}$/);
const packageHash = new URL(page.url()).hash.slice(1);
const packageId = packageHash.split('/').pop();
await page.getByTestId('package-gate').waitFor();
const draftPackage = await packageOf(preparer, packageId);
check(
  'packages: investor relations starts a final package from the list; it opens as a Draft of the latest quarter with no figures',
  quarterChosen === quarterWords &&
    draftPackage?.state === 'Draft' &&
    draftPackage.periodEnd === quarterEnd &&
    draftPackage.asOf === fixtures.asOf &&
    draftPackage.label === 'final' &&
    draftPackage.content === null &&
    draftPackage.preparedBy.name === by(preparer).displayName &&
    (await page.getByTestId('package-checks').innerText()).includes('Not generated yet') &&
    (await page.getByTestId('package-positions').innerText()).includes('Not generated yet') &&
    (await packageActions.getByRole('button').allInnerTexts()).join() === 'Generate' &&
    (await packageActions.getByText('Simulated').isVisible()),
  `${quarterChosen}: ${draftPackage?.state} as of ${draftPackage?.asOf}`,
);

await packageActions.getByRole('button', { name: 'Generate' }).click();
await packageStatus.filter({ hasText: 'is now QA failed' }).waitFor();
const generatedPackage = await packageOf(preparer, packageId);
const packageFindings = generatedPackage?.findings ?? [];
const failedFindings = packageFindings.filter((f) => !f.passed);
check(
  'packages: Generate fails the gate on the position with no start mark and on the final label over the stale mark',
  generatedPackage?.state === 'QAFailed' &&
    generatedPackage.rowVersion === draftPackage.rowVersion + 2 &&
    isDeepStrictEqual(failedFindings.map(findingKey).sort(), [
      'QA-LBL-01 status',
      `QA-QTD-01 ${breakRef}`,
      `QA-RF-01 ${breakRef}`,
      `QA-SIGN-01 ${breakRef}`,
    ]) &&
    (await packageStatus.innerText()) ===
      `${packageWords} is now QA failed: 4 of ${packageFindings.length} checks failed in run 1 ${SIMULATED}`,
  await packageStatus.innerText(),
);
check(
  'packages: the findings are exactly what the report engine finds on the content the package shows',
  generatedPackage?.content !== null &&
    packageFindings.length > 0 &&
    isDeepStrictEqual(
      asEngine(packageFindings),
      asEngine(
        runReportQa(generatedPackage.content, {
          toleranceUsd: String(definitions.rollForwardToleranceUsd),
          moversCount: definitions.reporting.weeklyMoversCount,
        }),
      ),
    ),
  `${packageFindings.length} findings`,
);
const breakLine = generatedPackage?.content?.lines?.find((l) => l.ref === breakRef);
const staleLine = generatedPackage?.content?.lines?.find((l) => l.ref === staleRef);
const labelCells = await checkCells(
  'Preliminary or final, gross or net',
  'Preliminary or final label',
);
const startCells = await checkCells(
  'Quarter starts from the prior locked mark',
  `${breakRef} ${breakCompany}`,
);
const checksCard = await page.getByTestId('package-checks').innerText();
check(
  'packages: the failed checks show what each expected and found, in words, with no rule code and no identifier',
  (await page.getByRole('table', { name: 'Checks' }).locator('tbody tr').count()) === 4 &&
    labelCells[0] === 'Failed' &&
    labelCells[3] === 'Preliminary' &&
    labelCells[4] === 'Final' &&
    startCells[0] === 'Failed' &&
    startCells[3] === '-' &&
    startCells[4] === '-' &&
    !/QA-[A-Z]+-\d+/.test(checksCard) &&
    !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(checksCard),
  `label ${labelCells.slice(3, 5).join(' / ')}; start ${startCells.slice(3, 5).join(' / ')}`,
);
const breakRow = page
  .getByTestId('package-positions')
  .getByRole('row')
  .filter({ hasText: breakRef });
const NO_START = 'Not calculable: no locked mark at the start of the quarter';
check(
  'packages: the line with no start mark shows no begin NAV and no gain, each saying why, never a zero',
  breakLine?.beginNav === null &&
    breakLine.gainLoss === null &&
    breakLine.endNav !== null &&
    (await breakRow.getByRole('cell').nth(0).getAttribute('title')) === NO_START &&
    (await breakRow.getByRole('cell').nth(3).getAttribute('title')) === NO_START &&
    (await breakRow.getByRole('cell').nth(0).innerText()).trim().startsWith('-') &&
    (await breakRow.getByRole('cell').nth(4).innerText()) === moneyM(breakLine.endNav),
  oneLine(await breakRow.innerText()),
);
// The page names the mark by the day it is dated; the quarter it reports for is what makes it stale.
const staleMarkWords = new Date(`${staleLine?.endNavMarkDate}T00:00:00Z`).toLocaleDateString(
  'en-US',
  { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' },
);
check(
  'packages: the stale position is carried at its last Locked mark and footnoted with that mark',
  staleLine?.endNavPeriodEnd < quarterEnd &&
    typeof staleLine?.endNavMarkDate === 'string' &&
    generatedPackage.content.footnotes.some((n) => n.ref === staleRef) &&
    (await page.getByTestId('package-footnotes').innerText()).includes(
      `Carried at the mark of ${staleMarkWords}, rolled forward for cash flows since.`,
    ) &&
    (await page.getByTestId('package-positions').innerText()).includes(
      `Rolled forward from ${staleMarkWords}`,
    ),
  oneLine(await page.getByTestId('package-footnotes').innerText()),
);
// What the gate refuses while the checks fail, in the API's own statuses.
const earlySubmit = await packageCommand(preparer, packageId, { command: 'submit' });
const ownOverride = await packageCommand(preparer, packageId, {
  command: 'overrideQa',
  reason: 'probe: not an approver',
});
const staleOverride = await packageCommand(
  'head.one',
  packageId,
  { command: 'overrideQa', reason: 'probe: a stale page' },
  { 'if-match': `"${draftPackage.rowVersion}"` },
);
const outsiderIr = d.users.find(
  (u) => u.roles.includes('investor_relations') && !u.clientIds.includes(packageCase.client.id),
);
const unseenPackage = await api(outsiderIr.externalId, 'GET', `${PACKAGES}/${packageId}`);
check(
  'packages: no Submit while the checks fail, no override by investor relations, none from a stale page, and no package for another client',
  (await packageActions.getByRole('button', { name: 'Submit' }).count()) === 0 &&
    (await packageActions.getByRole('button', { name: 'Override QA' }).isDisabled()) &&
    earlySubmit.status === 409 &&
    ownOverride.status === 403 &&
    staleOverride.status === 412 &&
    unseenPackage.status === 404 &&
    (await packageOf(preparer, packageId))?.rowVersion === generatedPackage.rowVersion,
  `submit ${earlySubmit.status}, override ${ownOverride.status}, stale ${staleOverride.status}, other client ${unseenPackage.status}`,
);

const overrideReason = 'probe: the breaks are disclosed in the cover letter';
await switchTo('head.one');
await page.goto(`${origin}/#${packageHash}`);
await packageActions.getByRole('button', { name: 'Override QA' }).click();
const overrideDialog = page.getByRole('dialog');
const overrideSubject = await overrideDialog.innerText();
await overrideDialog.getByRole('textbox', { name: /Reason/ }).fill(overrideReason);
await overrideDialog.getByRole('button', { name: 'Override QA' }).click();
await packageStatus.filter({ hasText: 'overridden' }).waitFor();
const overriddenPackage = await packageOf('head.one', packageId);
check(
  'packages: an approver overrides the failed checks with a reason, recorded against each with their name',
  overrideSubject.includes(
    'The reason is recorded against all 4 failed checks of this run, with your name.',
  ) &&
    overriddenPackage?.state === 'QAPassed' &&
    overriddenPackage.qa.overridden === 4 &&
    overriddenPackage.findings
      .filter((f) => !f.passed)
      .every(
        (f) =>
          f.override?.reason === overrideReason &&
          f.override.approver.name === by('head.one').displayName,
      ) &&
    isDeepStrictEqual(overriddenPackage.content, generatedPackage.content) &&
    (await packageStatus.innerText()) ===
      `${packageWords} is now QA passed: 4 failed checks overridden ${SIMULATED}` &&
    (await page.getByTestId('package-override').innerText()).includes(`Reason: ${overrideReason}`),
  await packageStatus.innerText(),
);

await switchTo(preparer);
await page.goto(`${origin}/#${packageHash}`);
await packageActions.getByRole('button', { name: 'Submit' }).click();
await packageStatus.filter({ hasText: 'is now In review' }).waitFor();
const preparerApproves = await packageCommand(preparer, packageId, { command: 'approve' });
await switchTo('head.one');
await page.goto(`${origin}/#${packageHash}`);
await packageActions.getByRole('button', { name: 'Approve' }).click();
await packageStatus.filter({ hasText: 'is now Approved' }).waitFor();
const approvedPackage = await packageOf('head.one', packageId);
const hashShown = await page.getByTestId('package-hash').innerText();
check(
  'packages: submitted by investor relations and approved by an approver; the hash is the SHA-256 of the content shown, in full on the page',
  preparerApproves.status === 403 &&
    approvedPackage?.state === 'Approved' &&
    approvedPackage.reviewer?.name === by('head.one').displayName &&
    approvedPackage.contentHash === sha256(canonicalJson(approvedPackage.content)) &&
    isDeepStrictEqual(approvedPackage.content, generatedPackage.content) &&
    hashShown.includes('Content hash (SHA-256)') &&
    hashShown.includes(approvedPackage.contentHash),
  `${approvedPackage?.state}; ${approvedPackage?.contentHash}`,
);

await switchTo(preparer);
await page.goto(`${origin}/#${packageHash}`);
await packageActions.getByRole('button', { name: 'Release' }).click();
await packageStatus.filter({ hasText: 'is now Released' }).waitFor();
const releasedPackage = await packageOf(preparer, packageId);
const lateRegenerate = await packageCommand(preparer, packageId, { command: 'regenerate' });
const startBody = {
  clientId: packageCase.client.id,
  periodEnd: quarterEnd,
  basis: 'gross',
  label: 'final',
};
const unexplainedVersion = await api(preparer, 'POST', PACKAGES, startBody);
check(
  'packages: released by investor relations, the page is read only, nothing leaves Released and a new version needs a reason',
  releasedPackage?.state === 'Released' &&
    releasedPackage.releasedBy?.name === by(preparer).displayName &&
    releasedPackage.contentHash === approvedPackage.contentHash &&
    (await packageActions.count()) === 0 &&
    (await page.getByTestId('package-gate').getByRole('button').count()) === 0 &&
    (await page.getByTestId('package-next').innerText()).includes(
      'Released packages are read only.',
    ) &&
    lateRegenerate.status === 409 &&
    unexplainedVersion.status === 422,
  `${releasedPackage?.state}; regenerate ${lateRegenerate.status}; start again ${unexplainedVersion.status}`,
);
await page.goto(`${origin}/#/reporting/packages`);
const packageListRow = page
  .getByRole('table', { name: 'Client packages' })
  .getByRole('row')
  .filter({ hasText: packageCase.client.name });
await packageListRow.waitFor();
check(
  'packages: the list shows the package Released, its checks as failed and overridden',
  (await packageListRow.innerText()).includes('Released') &&
    (await packageListRow.innerText()).includes('4 failed, overridden') &&
    (await page.getByTestId('package-count').innerText()).includes('0 packages not yet released'),
  oneLine(await packageListRow.innerText()),
);
// Who else opens the package: the other investor relations user finds none, a viewer is told
// whom packages are for, and the deal team reads the released package with nothing to press.
await switchTo(outsiderIr.externalId);
await page.goto(`${origin}/#${packageHash}`);
await page.getByText('Package not found').waitFor();
await switchTo('viewer.one');
await page.goto(`${origin}/#${packageHash}`);
await page.getByTestId('package-unavailable').waitFor();
const viewerPackage = await page.getByTestId('package-unavailable').innerText();
await switchTo('deal.one');
await page.goto(`${origin}/#${packageHash}`);
await page.getByTestId('package-hash').waitFor();
check(
  'packages: not found for investor relations of another client, not visible to a viewer, read only for the deal team',
  viewerPackage.includes('not visible to your role') &&
    (await page.getByTestId('package-banner').innerText()).includes('Released') &&
    (await packageActions.count()) === 0,
  oneLine(viewerPackage),
);
await api('viewer.one', 'POST', '/api/v1/preview/reset');
check(
  'packages: a reset forgets every package of the session',
  (await api(preparer, 'GET', PACKAGES)).json?.items?.length === 0 &&
    (await api(preparer, 'GET', `${PACKAGES}/${packageId}`)).status === 404,
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
