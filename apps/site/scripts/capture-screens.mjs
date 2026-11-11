// Takes the screenshots the site and the brochures show, from the interactive preview: one page
// session walked as the mock user who holds the role for each screen, at 1440 by 900 with a device
// scale factor of 2, light theme. Each shot is written as WebP at two widths (2880 and 1440 pixels)
// with a manifest beside them. Output: media/screens/ (generated, never committed).
//
//   node scripts/capture-screens.mjs [--only name,name]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChromium } from './lib/browser.mjs';
import {
  MEDIA_DIR,
  previewAsOf,
  previewDriver,
  quarterEndOnOrBefore,
  servePreview,
} from './lib/preview.mjs';

const OUT = join(MEDIA_DIR, 'screens');
const VIEWPORT = { width: 1440, height: 900 };
const SCALE = 2;
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg === -1 ? null : new Set((process.argv[onlyArg + 1] ?? '').split(','));

const log = (line) => process.stdout.write(`${line}\n`);

const server = await servePreview();
const browser = await launchChromium();
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: SCALE,
  colorScheme: 'light',
  reducedMotion: 'reduce',
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const p = previewDriver(page, server.origin);
const asOf = previewAsOf();
const quarter = quarterEndOnOrBefore(asOf);

/** @type {{ name: string, png: Buffer }[]} */
const shots = [];

/** Screenshots the viewport once the page is quiet. `top` scrolls an element to the top first. */
async function shoot(name, options = {}) {
  if (only !== null && !only.has(name)) return;
  await p.settle();
  if (options.top !== undefined) {
    await options.top.evaluate((el, offset) => {
      const y = el.getBoundingClientRect().top + globalThis.scrollY - offset;
      globalThis.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
    }, options.offset ?? 64);
  } else {
    await page.evaluate(() => globalThis.scrollTo({ top: 0, behavior: 'instant' }));
  }
  // Park the pointer where it hovers nothing, and let fonts and charts finish painting.
  await page.mouse.move(VIEWPORT.width - 2, VIEWPORT.height - 2);
  await page.evaluate(() => globalThis.document.fonts.ready);
  await page.waitForTimeout(350);
  shots.push({ name, png: await page.screenshot({ type: 'png' }) });
  log(`shot ${name}`);
}

await p.open();

// ---- The approver: home, the portfolio, a one-pager, analytics ---------------------------------
await p.signIn('head.one');
const hideGuide = page.getByRole('button', { name: 'Hide guide' });
if ((await hideGuide.count()) > 0) await hideGuide.click();
await shoot('home');

await p.go('/portfolio');
await page.getByTestId('portfolio-count').waitFor();
await shoot('portfolio');

const investments = (await p.read('head.one', '/api/v1/investments?limit=200')).items;
/** The one-pager shown: an active equity co-investment with a mark on the quarter end. */
const featured =
  investments.find(
    (i) => i.isActive && i.dealType === 'deal_type.co_invest_equity' && i.navDate === quarter,
  ) ?? investments[0];
await p.go(`/portfolio/${featured.id}`);
await page.getByTestId('detail-banner').waitFor();
await shoot('one-pager');
await p.go(`/portfolio/${featured.id}/performance`);
await page.getByRole('table', { name: 'Quarterly financials' }).waitFor();
await shoot('performance');

await p.go('/portfolio/watchlist');
await shoot('watchlist');

await p.go('/analytics');
await page.getByRole('heading', { level: 1, name: 'Analytics' }).waitFor();
await shoot('analytics');
await p.go('/analytics/performance');
await shoot('analytics-performance');
await p.go('/analytics/credit');
await shoot('analytics-credit');
await p.go('/analytics/realizations');
await shoot('analytics-realizations');

// ---- Operations: intake, the document hub, extraction ------------------------------------------
await p.switchUser('ops.one');
await p.go('/data/intake');
await page.getByTestId('intake-sample-defects').click();
await page.waitForURL(/#\/data\/intake\/[0-9a-f-]{36}$/);
await page.getByTestId('intake-tiles').waitFor();
await shoot('intake');

await p.go('/data/lookthrough');
await page.getByTestId('lookthrough-run').waitFor();
await page.getByRole('button', { name: 'Reconcile' }).click();
await page.waitForURL(/#\/data\/lookthrough\/[0-9a-f-]{36}$/);
await page.getByTestId('lookthrough-tiles').waitFor();
await p.go('/data/exceptions');
await shoot('exceptions');

await p.go('/documents');
await page.getByRole('button', { name: 'Index documents' }).click();
await page
  .getByTestId('documents-action-status')
  .filter({ hasText: 'Indexed' })
  .waitFor({ timeout: 60_000 });
await page.getByRole('table', { name: 'Documents' }).waitFor();
await shoot('documents');

// The extraction switch is off by default; a platform admin turns it on (audited in the API).
await p.send('admin.one', 'PATCH', '/api/v1/flags/ai.extraction', {
  enabled: true,
  reason: 'Enabled for the site screenshots',
});
await p.send('ops.one', 'POST', '/api/v1/expected-documents/generate', { periodEnd: quarter });
await p.send('ops.one', 'POST', '/api/v1/extraction/batches', {
  periodEnd: quarter,
  docType: 'doc_type.quarterly_financials',
});
const runs = (await p.read('ops.one', '/api/v1/extraction/runs?limit=200')).items.filter(
  (r) => r.state === 'Succeeded',
);
if (runs.length === 0) throw new Error('the extraction batch produced no run to show');
const run = runs.find((r) => r.counts.flagged > 0) ?? runs[0];
const runDetail = await p.read('ops.one', `/api/v1/extraction/runs/${run.id}`);
const revenue = runDetail.values.find((v) => v.field === 'revenue_ltm');
await p.go(`/documents/extraction/${run.id}`);
await page.getByTestId('run-fields').waitFor();
if (revenue?.page !== null && revenue?.page !== undefined) {
  await page
    .getByRole('button', { name: `Show Revenue LTM on page ${revenue.page}`, exact: true })
    .click();
  await page.getByTestId('run-page-highlight').first().waitFor();
}
// The lower rows of the values and, under them, the cited page with the quote highlighted.
await shoot('extraction', { top: page.getByTestId('run-page-drawing'), offset: 400 });

// A few runs reviewed and approved, so the monitoring board shows every state side by side.
for (const reviewed of runs.filter((r) => r.id !== run.id).slice(0, 4)) {
  await p.send('ops.one', 'POST', `/api/v1/extraction/runs/${reviewed.id}/commands`, {
    command: 'acceptClean',
  });
  await p.send('ops.one', 'POST', `/api/v1/extraction/runs/${reviewed.id}/commands`, {
    command: 'approve',
    reason: 'Reviewed against the synthetic report',
  });
}
await p.go('/portfolio/monitoring');
await page.getByTestId('monitoring-board').waitFor();
await shoot('monitoring');

// ---- Valuations: one version taken through prepare, approve and lock ----------------------------
await p.go('/valuations');
await page.getByTestId('missing-marks').waitFor();
const missingRow = page.getByTestId('missing-marks').getByRole('row').nth(1);
const missing = {
  number: (await missingRow.getByRole('cell').nth(0).innerText()).trim(),
  company: (await missingRow.getByRole('cell').nth(1).innerText()).trim(),
};
const position = investments.find((i) => i.investmentNumber === missing.number);
if (position === undefined) throw new Error(`no position ${missing.number} for the valuation shot`);
const fairValue = (Math.round(Number(position.nav) * 1.04 * 100) / 100).toFixed(2);
const draft = await p.send('ops.one', 'POST', '/api/v1/valuations', {
  investmentId: position.id,
  periodEnd: quarter,
  method: 'valuation_method.sponsor_mark',
  fairValue,
  inputs: { multiple: 11.5, source: 'sponsor quarterly letter' },
});
const command = (who, name) =>
  p.send(who, 'POST', `/api/v1/valuations/${draft.id}/commands`, { command: name });
await command('ops.one', 'prepare');
await p.go('/valuations');
await page.getByRole('table', { name: 'Valuations' }).waitFor();
await page.getByLabel('Search').fill('Cobalt');
await shoot('valuations');
await command('deal.one', 'dealTeamApprove');
await command('head.one', 'lock');
await p.switchUser('head.one');
await p.go(`/valuations/${draft.id}`);
await page.getByTestId('valuation-lock-text').waitFor();
await shoot('valuation-lock');

// ---- Capital activity: the call with a changed wire instruction --------------------------------
await p.switchUser('ops.one');
const notices = (await p.read('ops.one', '/api/v1/capital-notices?limit=200')).items;
const notice = notices.find((n) => n.scenarioTag === 'wire_change');
if (notice === undefined) throw new Error('the preview has no capital call with a changed wire');
await p.go('/capital-activity');
await shoot('capital-activity');
await p.go(`/capital-activity/${notice.id}`);
await page.getByTestId('notice-banner').waitFor();
await shoot('capital-notice');
await p.go('/capital-activity/wires');
await page.getByRole('table', { name: 'Wire instructions' }).waitFor();
await shoot('wire-register');

// ---- The deal team: the pipeline and a deal in diligence ---------------------------------------
await p.switchUser('deal.one');
await p.go('/pipeline');
await page.getByTestId('pipeline-column-Sourced').waitFor();
await shoot('pipeline');
const opportunities = (await p.read('deal.one', '/api/v1/opportunities?limit=200')).items;
const inDiligence = opportunities.find((o) => o.stage === 'Diligence');
if (inDiligence !== undefined) {
  await p.go(`/pipeline/${inDiligence.id}`);
  await page.getByTestId('opportunity-banner').waitFor();
  await shoot('opportunity');
}

// ---- The auditor and the platform admin: the audit trail, access and walls ----------------------
await p.switchUser('audit.one');
await p.go('/admin/audit');
await page.getByTestId('audit-note').waitFor();
await shoot('audit');
await p.switchUser('admin.one');
await p.go('/admin/access');
await shoot('access');

if (pageErrors.length > 0)
  throw new Error(`page errors while capturing: ${pageErrors.join(' | ')}`);

// ---- WebP at two widths, encoded by the browser's own canvas -----------------------------------
const encoder = await context.newPage();
await encoder.setContent('<!doctype html><title>encode</title>');
async function toWebp(png, width, quality) {
  const base64 = await encoder.evaluate(
    async ({ source, width, quality }) => {
      const blob = await (await globalThis.fetch(`data:image/png;base64,${source}`)).blob();
      const bitmap = await globalThis.createImageBitmap(blob);
      const height = Math.round((bitmap.height * width) / bitmap.width);
      const canvas = new globalThis.OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);
      const out = await canvas.convertToBlob({ type: 'image/webp', quality });
      const bytes = new Uint8Array(await out.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return globalThis.btoa(binary);
    },
    { source: png.toString('base64'), width, quality },
  );
  return Buffer.from(base64, 'base64');
}

if (only === null) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const manifest = { generatedFrom: 'apps/web/dist-preview', asOf, viewport: VIEWPORT, shots: [] };
for (const shot of shots) {
  const large = await toWebp(shot.png, VIEWPORT.width * SCALE, 0.9);
  const small = await toWebp(shot.png, VIEWPORT.width, 0.9);
  writeFileSync(join(OUT, `${shot.name}-2x.webp`), large);
  writeFileSync(join(OUT, `${shot.name}.webp`), small);
  manifest.shots.push({
    name: shot.name,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    file: `${shot.name}.webp`,
    file2x: `${shot.name}-2x.webp`,
    bytes: small.length,
    bytes2x: large.length,
  });
}
if (only === null)
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await browser.close();
await server.close();
log(`capture-screens: ${shots.length} screenshots in ${OUT}`);
