// Serves dist-preview statically and walks it in headless Chromium: journey 1 against the recorded
// preview, every route of src/app/router.tsx for six users with the recording-miss detector, and
// the simulated workflow journeys at the API level inside the page. One line per check, a summary,
// and a non-zero exit on any failure. Checks that need recordings an endpoint has not produced yet
// (it answered 501 when the preview was built) are skipped with a line that says so.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';
import { generateDataset } from '@pb/synthetic';
import { keyFor } from './preview-plan.mjs';

const root = resolve(process.env.PB_PREVIEW_OUT ?? 'dist-preview');
const shell = join(root, 'index.html');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
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
      try {
        globalThis.sessionStorage.setItem('pb.credential', credential);
      } catch {
        // Storage blocked: the header below still carries the credential.
      }
      const h = { accept: 'application/json', authorization: `Bearer ${credential}`, ...headers };
      if (body !== null) h['content-type'] = 'application/json';
      const res = await globalThis.fetch(path, {
        method,
        headers: h,
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, json, simulated: res.headers.get('x-pb-simulated') === 'true' };
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
