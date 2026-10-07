// Serves dist-preview statically and walks journey 1 in headless Chromium against the recorded preview.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { chromium } from '@playwright/test';
import { generateDataset } from '@pb/synthetic';

const root = process.env.PB_PREVIEW_OUT ?? 'dist-preview';
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]));
  let file = join(root, path === '/' ? 'index.html' : path);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const d = generateDataset({ profile: 'small', seed: 42 });
const walledId = d.scenarios.walled_deal[0];
const walledName = d.portfolioCompanies.find(
  (c) => c.id === d.investments.find((i) => i.id === walledId).portfolioCompanyId,
).name;
const by = (id) => d.users.find((u) => u.externalId === id);
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

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
  await page.getByTestId('current-user').waitFor();
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
  (await page.getByTestId('flag-message').innerText()).includes('is now on'),
);
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
server.close();
for (const r of results)
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` (${r.detail})` : ''}\n`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
