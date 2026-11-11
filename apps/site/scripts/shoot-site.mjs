// Screenshots of the built site, for looking at the design: the whole page and each section, on a
// desktop and a phone, in the light and the dark theme, served from a sub-path as the check
// serves it. Motion is parked (as for a reader who prefers less of it) so every block is in place.
//
//   node scripts/shoot-site.mjs [--out <dir>] [--only desktop-light,phone-dark]
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchChromium } from './lib/browser.mjs';
import { MEDIA_DIR, SITE_DIR } from './lib/preview.mjs';
import { serveStatic } from './lib/serve.mjs';

const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
};
const out = arg('--out') ?? join(MEDIA_DIR, 'site-shots');
const only = arg('--only') === null ? null : new Set(arg('--only').split(','));
const DIST = join(SITE_DIR, 'dist');
if (!existsSync(join(DIST, 'index.html')))
  throw new Error('the site is not built: run "pnpm --filter @pb/site build" first');

const VIEWS = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, scale: 1 },
  { name: 'phone', viewport: { width: 390, height: 844 }, scale: 2, isMobile: true },
];
const SECTIONS = ['top', 'overview', 'tour', 'controls', 'videos', 'brochures', 'demo'];

mkdirSync(out, { recursive: true });
const server = await serveStatic(DIST, { base: '/portfolio-beach/' });
const browser = await launchChromium();
let count = 0;
for (const view of VIEWS)
  for (const theme of ['light', 'dark']) {
    const label = `${view.name}-${theme}`;
    if (only !== null && !only.has(label)) continue;
    const context = await browser.newContext({
      viewport: view.viewport,
      deviceScaleFactor: view.scale,
      isMobile: view.isMobile === true,
      hasTouch: view.isMobile === true,
      colorScheme: theme,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.goto(server.url);
    await page.evaluate(async () => {
      for (const image of globalThis.document.images) image.loading = 'eager';
      await Promise.all(
        [...globalThis.document.images].map((image) =>
          image.complete ? null : new Promise((done) => image.addEventListener('load', done)),
        ),
      );
      await globalThis.document.fonts.ready;
    });
    await page.screenshot({ path: join(out, `${label}-fold.png`) });
    await page.screenshot({ path: join(out, `${label}-full.png`), fullPage: true });
    count += 2;
    // Two states a still page does not show: the menu on a phone, a screenshot enlarged.
    if (view.isMobile === true) {
      await page.locator('[data-menu-toggle]').click();
      await page.screenshot({ path: join(out, `${label}-menu.png`) });
      await page.locator('[data-menu-toggle]').click();
    } else {
      await page.locator('#tour a[data-lightbox]').first().click();
      await page.locator('dialog[open] img').waitFor();
      await page.waitForFunction(() => {
        const image = globalThis.document.querySelector('dialog[open] img');
        return image !== null && image.complete && image.naturalWidth > 0;
      });
      await page.screenshot({ path: join(out, `${label}-lightbox.png`) });
      await page.keyboard.press('Escape');
    }
    count += 1;
    // A section taller than the view is stitched from several captures, and anything pinned to
    // the window would be drawn into its middle: set the header and the skip link aside.
    await page.addStyleTag({
      content: '.site-header, .skip-link { visibility: hidden !important; }',
    });
    for (const id of SECTIONS) {
      const section = page.locator(`#${id}`);
      await section.scrollIntoViewIfNeeded();
      await section.screenshot({ path: join(out, `${label}-${id}.png`) });
      count += 1;
    }
    await page.goto(`${server.url}no-such-page`);
    await page.screenshot({ path: join(out, `${label}-404.png`) });
    count += 1;
    await context.close();
  }
await browser.close();
await server.close();
process.stdout.write(`shoot-site: ${count} screenshots in ${out}\n`);
