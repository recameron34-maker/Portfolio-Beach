// Renders the brochures: the HTML templates in brochures/ become Letter-size PDFs with Playwright's
// page.pdf() (print backgrounds on), in the site's style and with the screenshots the capture
// script took. Each brochure also gets a cover thumbnail and an entry in the manifest with its
// page count. Output: media/brochures/ (generated, never committed).
//
//   node scripts/make-brochures.mjs
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchChromium } from './lib/browser.mjs';
import { MEDIA_DIR, SITE_DIR } from './lib/preview.mjs';
import { lightTokensCss } from './lib/tokens.mjs';

const OUT = join(MEDIA_DIR, 'brochures');
const TEMPLATES = join(SITE_DIR, 'brochures');
/** Letter at 96 CSS pixels to the inch. */
const PAGE = { width: 816, height: 1056 };
const COVER_SCALE = 1.5;
const log = (line) => process.stdout.write(`${line}\n`);
/** --pages <dir> also writes every sheet as a PNG, to look at a layout without opening the PDF. */
const pagesAt = process.argv.indexOf('--pages');
const pagesDir = pagesAt === -1 ? null : (process.argv[pagesAt + 1] ?? null);
/**
 * --ui-font <family> renders with another font in place of the system UI font. The brochures use
 * the system font stack, so their line breaks differ from one machine to the next; this is how to
 * see that every sheet still fits with a wider font than the one installed here.
 */
const fontAt = process.argv.indexOf('--ui-font');
const uiFont = fontAt === -1 ? null : (process.argv[fontAt + 1] ?? null);

/** The brochures, in the order the site lists them. `pages` is what each template must render to. */
const BROCHURES = [
  {
    name: 'product-overview',
    template: 'product-overview.html',
    file: 'portfolio-beach-product-overview.pdf',
    title: 'Product overview',
    description:
      'What Portfolio Beach is, who uses it, how the work flows and the areas built today, with the roadmap.',
    pages: 3,
  },
  {
    name: 'controls-and-security',
    template: 'controls-and-security.html',
    file: 'portfolio-beach-controls-and-security.pdf',
    title: 'Controls and security',
    description:
      'What the prototype enforces: roles and walls, the preparer never approves, the valuation lock, wire controls and human review of AI output.',
    pages: 2,
  },
  {
    name: 'analytics-and-monitoring',
    template: 'analytics-and-monitoring.html',
    file: 'portfolio-beach-analytics-and-monitoring.pdf',
    title: 'Analytics and monitoring',
    description:
      'The monitoring board, each deal quarter by quarter, the watchlist and the analytics tabs, with a page on value creation and entry metrics.',
    pages: 3,
  },
];

if (!existsSync(join(MEDIA_DIR, 'screens', 'manifest.json')))
  throw new Error(
    'the screenshots are not captured: media/screens/manifest.json is missing. Run "node scripts/capture-screens.mjs" first.',
  );

/** The pages of a PDF, counted from its page objects. */
function pageCount(pdf) {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

const browser = await launchChromium();
const context = await browser.newContext({
  viewport: PAGE,
  deviceScaleFactor: COVER_SCALE,
  colorScheme: 'light',
});
const page = await context.newPage();
const tokens = lightTokensCss();
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const manifest = { brochures: [] };
let failed = false;
for (const brochure of BROCHURES) {
  const missing = [];
  page.removeAllListeners('requestfailed');
  page.on('requestfailed', (request) => missing.push(request.url()));
  await page.goto(pathToFileURL(join(TEMPLATES, brochure.template)).href);
  await page.addStyleTag({ content: tokens });
  if (uiFont !== null)
    await page.addStyleTag({
      content: `:root{--pb-font-ui:"${uiFont.replace(/["\\;{}]/g, '')}", sans-serif}`,
    });
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    await Promise.all(
      [...globalThis.document.images].map((image) =>
        image.complete ? null : new Promise((done) => image.addEventListener('load', done)),
      ),
    );
  });
  const broken = await page.evaluate(() =>
    [...globalThis.document.images].filter((i) => i.naturalWidth === 0).map((i) => i.src),
  );
  if (missing.length + broken.length > 0)
    throw new Error(`${brochure.template}: missing files: ${[...missing, ...broken].join(', ')}`);

  // A sheet whose content runs past its bottom edge would be cut off in print: fail instead.
  // `spare` is the room left above each sheet's footer, in CSS pixels.
  const spare = await page.evaluate(() =>
    [...globalThis.document.querySelectorAll('.page')].map((sheet) => {
      const foot = sheet.querySelector('.page-foot')?.getBoundingClientRect().top ?? Infinity;
      const lowest = Math.max(
        ...[...sheet.children]
          .filter((el) => !el.classList.contains('page-foot'))
          .map((el) => el.getBoundingClientRect().bottom),
      );
      return Math.round(foot - lowest);
    }),
  );
  const overflow = spare
    .map((room, i) => (room < 4 ? `page ${i + 1} overruns its footer by ${4 - room}px` : null))
    .filter((problem) => problem !== null);

  if (pagesDir !== null) {
    mkdirSync(pagesDir, { recursive: true });
    const sheets = page.locator('.page');
    for (let i = 0; i < (await sheets.count()); i += 1)
      await sheets.nth(i).screenshot({ path: join(pagesDir, `${brochure.name}-${i + 1}.png`) });
  }
  const cover = await page.locator('.page').first().screenshot({ type: 'png' });
  const coverWebp = await page.evaluate(async (source) => {
    const blob = await (await globalThis.fetch(`data:image/png;base64,${source}`)).blob();
    const bitmap = await globalThis.createImageBitmap(blob);
    const canvas = new globalThis.OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return globalThis.btoa(binary);
  }, cover.toString('base64'));
  writeFileSync(join(OUT, `${brochure.name}.webp`), Buffer.from(coverWebp, 'base64'));

  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({
    format: 'Letter',
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
  });
  await page.emulateMedia({ media: 'screen' });
  writeFileSync(join(OUT, brochure.file), pdf);
  const pages = pageCount(pdf);
  const bytes = statSync(join(OUT, brochure.file)).size;
  manifest.brochures.push({
    name: brochure.name,
    title: brochure.title,
    description: brochure.description,
    file: brochure.file,
    cover: `${brochure.name}.webp`,
    pages,
    bytes,
  });
  log(
    `${brochure.file}: ${pages} pages, ${(bytes / 1024 / 1024).toFixed(1)} MB (room left on each sheet: ${spare.join(', ')} px)`,
  );
  if (pages !== brochure.pages) {
    log(`FAIL ${brochure.template}: rendered ${pages} pages, expected ${brochure.pages}`);
    failed = true;
  }
  for (const problem of overflow) {
    log(`FAIL ${brochure.template}: ${problem}`);
    failed = true;
  }
}
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await browser.close();
log(`make-brochures: ${manifest.brochures.length} brochures in ${OUT}`);
process.exit(failed ? 1 : 0);
