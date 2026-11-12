// Checks the built site (apps/site/dist) the way a visitor on a static host meets it: served from
// a sub-path, in headless Chromium. Every internal link and asset must resolve, nothing may be
// requested from another origin, the demo must open in a new tab and sign in, every video must
// play and have a poster, every brochure link must return a PDF, every page must ask search
// engines not to list it unless the site is switched to findable, axe must find no serious or
// critical issue on each page in the light and the dark theme, and nothing may scroll sideways on
// a phone.
// One line per check, a summary, and a non-zero exit on any failure.
//
// With --artifact it checks the private preview build (apps/site/dist-artifact) instead: the
// fragment artifact.html is put into the <body> of a minimal document, as its host does, and
// served beside its supporting files. The same checks run against that page, apart from the 404
// page, the demo (it is not in that build: its links must go to the one address the build was
// given) and the robots tag (a fragment has no head). On top of them: the fragment's shape and
// order, publish.json, the file limits, and the theme following the host's root element.
//
//   node scripts/check-site.mjs [--base /portfolio-beach/] [--artifact]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { launchChromium } from './lib/browser.mjs';
import { SITE_DIR } from './lib/preview.mjs';
import { serveStatic } from './lib/serve.mjs';
import { contrast, tokenSets } from './lib/tokens.mjs';

const ARTIFACT = process.argv.includes('--artifact');
const DIST = join(SITE_DIR, ARTIFACT ? 'dist-artifact' : 'dist');
const ENTRY = ARTIFACT ? 'artifact.html' : 'index.html';
const PAGE = ARTIFACT ? 'artifact' : 'landing page';
const baseArg = process.argv.indexOf('--base');
const BASE =
  baseArg === -1 ? '/portfolio-beach/' : (process.argv[baseArg + 1] ?? '/portfolio-beach/');
const NOTICE = 'Synthetic data only: no real firm, fund, company or person appears.';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

if (!existsSync(join(DIST, ENTRY))) {
  process.stdout.write(
    ARTIFACT
      ? 'check-site: the artifact is not built: run "pnpm --filter @pb/site build:artifact" first\n'
      : 'check-site: the site is not built: run "pnpm --filter @pb/site build" first\n',
  );
  process.exit(1);
}
const entrySource = readFileSync(join(DIST, ENTRY), 'utf8');

/**
 * The document a host wraps a fragment in: a skeleton with nothing of the page's own. The theme
 * attribute, when given, sits on its root element, where a host puts it. The icon is the host's
 * (an empty one here, so the browser does not ask the server for /favicon.ico).
 */
const hostDocument = (theme) =>
  `<!doctype html>
<html lang="en"${theme === undefined ? '' : ` data-theme="${theme}"`}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"></head>
<body>
${entrySource}</body>
</html>
`;

const results = [];
const check = (name, ok, detail = '') =>
  results.push({ status: ok ? 'PASS' : 'FAIL', name, detail: ok ? '' : detail });

const server = await serveStatic(DIST, {
  base: BASE,
  pages: ARTIFACT
    ? {
        '': hostDocument(),
        'host-dark.html': hostDocument('dark'),
        'host-light.html': hostDocument('light'),
      }
    : undefined,
});
const browser = await launchChromium();
const home = server.url;

/** A context that records every request, so a call to another origin or a failed one is seen. */
async function open(options = {}) {
  const context = await browser.newContext({
    viewport: DESKTOP,
    reducedMotion: 'reduce',
    ...options,
  });
  const seen = { foreign: [], failed: [], errors: [] };
  // Every page of the context is watched: the demo opens in a tab of its own.
  context.on('page', (opened) => {
    opened.on('request', (request) => {
      const url = request.url();
      if (!url.startsWith(server.origin) && !url.startsWith('data:') && !url.startsWith('blob:'))
        seen.foreign.push(url);
    });
    opened.on('response', (response) => {
      if (response.status() >= 400) seen.failed.push(`${response.status()} ${response.url()}`);
    });
    opened.on('requestfailed', (request) => {
      // A video the browser stops loading once it has what it needs is not a failure.
      if (request.failure()?.errorText !== 'net::ERR_ABORTED')
        seen.failed.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`);
    });
    opened.on('pageerror', (error) => seen.errors.push(error.message));
    opened.on('console', (message) => {
      if (message.type() === 'error') seen.errors.push(message.text());
    });
  });
  const page = await context.newPage();
  return { context, page, seen };
}

async function loadAll(page) {
  await page.evaluate(async () => {
    for (const image of globalThis.document.images) image.loading = 'eager';
    await Promise.all(
      [...globalThis.document.images].map((image) =>
        image.complete ? null : new Promise((done) => image.addEventListener('load', done)),
      ),
    );
    await globalThis.document.fonts.ready;
  });
}

const sideways = (page) =>
  page.evaluate(
    () =>
      globalThis.document.documentElement.scrollWidth -
      globalThis.document.documentElement.clientWidth,
  );

// ---- The built files: relative URLs only -------------------------------------------------------

// In the artifact the demo is elsewhere: its links are the only ones that leave, all to one address.
const demoTags = ARTIFACT ? (entrySource.match(/<a\b[^>]*\btarget="_blank"[^>]*>/g) ?? []) : [];
const demoAddresses = [...new Set(demoTags.map((tag) => /\bhref="([^"]*)"/.exec(tag)?.[1] ?? ''))];
const rooted = [...entrySource.matchAll(/\s(?:href|src|poster|srcset)="(\/[^"]*|https?:[^"]*)"/g)]
  .map((m) => m[1])
  .filter((url) => !demoAddresses.includes(url));
check(
  ARTIFACT
    ? 'artifact.html: every URL is relative, apart from the address of the demo'
    : 'index.html: every URL is relative (no root-absolute path, no other origin)',
  rooted.length === 0,
  rooted.slice(0, 5).join(' | '),
);

// ---- The artifact: the fragment's shape, its files and the limits of its host ---------------------

if (ARTIFACT) {
  const documentTags = entrySource.match(/<!doctype\b|<html[\s>]|<head[\s>]|<body[\s>]/gi) ?? [];
  check(
    'artifact.html: a fragment, with no doctype and no <html>, <head> or <body> tag',
    documentTags.length === 0,
    documentTags.join(' '),
  );
  const fragmentTitle = /^<title>([^<]*)<\/title>/.exec(entrySource)?.[1] ?? '';
  const words = fragmentTitle.trim().split(/\s+/).filter(Boolean).length;
  check(
    'artifact.html: opens with a <title> of two to four words',
    words >= 2 && words <= 4,
    `"${fragmentTitle}"`,
  );
  // The order: the title, the stylesheet link and the inline style, the markup, then the script.
  const at = (pattern, last = false) => {
    const found = [...entrySource.matchAll(pattern)].map((m) => m.index);
    return found.length === 0 ? -1 : last ? found[found.length - 1] : found[0];
  };
  const styling = /<link\b[^>]*rel="stylesheet"[^>]*>|<style\b/g;
  const markupAt = entrySource.indexOf('<a class="skip-link"');
  const scriptsAt = at(/<script\b/g);
  const tail = entrySource
    .slice(scriptsAt)
    .replace(/<script\b[^>]*\bsrc="[^"]*"[^>]*><\/script>/g, '');
  check(
    'artifact.html: the title, then the stylesheet link and the inline style, then the markup, then the script, and no inline script',
    at(styling) > 0 &&
      at(/<link\b[^>]*rel="stylesheet"[^>]*>/g) > 0 &&
      at(/<style\b/g) > 0 &&
      at(styling, true) < markupAt &&
      markupAt < scriptsAt &&
      tail.trim() === '',
    `styling ${at(styling)} to ${at(styling, true)}, markup ${markupAt}, scripts ${scriptsAt}, after them "${tail.trim().slice(0, 40)}"`,
  );

  const walk = (folder = '') =>
    readdirSync(join(DIST, folder), { withFileTypes: true }).flatMap((entry) => {
      const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
      return entry.isDirectory() ? walk(path) : [path];
    });
  const onDisk = walk()
    .filter((file) => file !== 'artifact.html' && file !== 'publish.json')
    .sort();
  let published = { files: [] };
  try {
    published = JSON.parse(readFileSync(join(DIST, 'publish.json'), 'utf8'));
  } catch {
    // Reported by the check below.
  }
  const listed = Array.isArray(published.files) ? published.files : [];
  check(
    'publish.json: lists every supporting file beside the fragment, and only those',
    listed.length > 0 && JSON.stringify([...listed].sort()) === JSON.stringify(onDisk),
    `${listed.length} listed, ${onDisk.length} beside the fragment`,
  );
  const named = [
    ...entrySource.matchAll(/\s(?:href|src|poster)="([^"#][^"]*)"/g),
    ...[...entrySource.matchAll(/\ssrcset="([^"]*)"/g)].flatMap((m) =>
      m[1].split(',').map((candidate) => [null, candidate.trim().split(/\s+/)[0]]),
    ),
  ]
    .map((m) => m[1])
    .filter((url) => !/^[a-z][a-z0-9+.-]*:/i.test(url))
    .map((url) => url.replace(/^\.\//, ''));
  const notListed = [...new Set(named)].filter((url) => !listed.includes(url));
  check(
    'publish.json: every file the fragment names is listed, at the path the fragment uses',
    named.length > 20 && notListed.length === 0,
    notListed.slice(0, 5).join(' | '),
  );
  check(
    'artifact: the demo is not in the folder',
    !existsSync(join(DIST, 'demo')) && listed.every((file) => !file.startsWith('demo/')),
  );
  const sizes = ['artifact.html', ...onDisk].map((file) => ({
    file,
    megabytes: statSync(join(DIST, file)).size / 1024 / 1024,
  }));
  const heaviest = sizes.reduce((a, b) => (b.megabytes > a.megabytes ? b : a));
  check(
    `artifact: every file is under 15 MB (the largest is ${heaviest.file} at ${heaviest.megabytes.toFixed(1)} MB)`,
    heaviest.megabytes < 15,
  );
  check(
    `artifact: fewer than 200 files (${sizes.length + 1} with publish.json, ${sizes.reduce((sum, s) => sum + s.megabytes, 0).toFixed(1)} MB in all)`,
    sizes.length + 1 < 200,
  );
  const expected = (process.env.SITE_DEMO_URL ?? '').trim();
  check(
    demoTags.length === 0
      ? 'artifact: built without an address for the demo, so the page carries no link to one'
      : 'artifact: all three "Open the demo" links go to the one address the build was given, in a new tab (target="_blank" rel="noopener")',
    demoTags.length === 0
      ? expected === '' && entrySource.includes('This copy of the site does not carry the demo.')
      : demoTags.length === 3 &&
          demoAddresses.length === 1 &&
          /^https?:\/\//.test(demoAddresses[0]) &&
          (expected === '' || new URL(expected).href === demoAddresses[0]) &&
          demoTags.every((tag) => /\brel="noopener"/.test(tag)),
    `${demoTags.length} links to ${demoAddresses.join(', ') || 'nowhere'}${expected === '' ? '' : `, expected ${expected}`}`,
  );
}

// ---- Colour tokens: every text and background pair the stylesheet uses, at WCAG AA --------------
// axe cannot judge text that sits on a gradient (the hero's sky, the deep band, the shore band),
// so the pairs are checked here from the tokens themselves, at both ends of each gradient.

const TEXT_PAIRS = [
  ['text', 'bg'],
  ['text', 'card'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'card'],
  ['muted', 'sceneSkyTop'],
  ['muted', 'sceneSky'],
  ['muted', 'sceneSeaNear'],
  ['primary', 'bg'],
  ['primary', 'surface'],
  ['primary', 'card'],
  ['primary', 'sceneSkyTop'],
  ['primary', 'sceneSky'],
  ['primary', 'sceneSeaNear'],
  ['accentInk', 'bg'],
  ['accentInk', 'surface'],
  ['accentInk', 'card'],
  ['accentInk', 'accentWash'],
  ['accentInk', 'sceneSky'],
  ['onPrimary', 'primary'],
  ['onPrimary', 'primaryHover'],
  ['onSand', 'sand'],
  ['watch', 'card'],
  ['onDeep', 'deep'],
  ['onDeep', 'deepEnd'],
  ['onDeep', 'deepCard'],
  ['onDeepMuted', 'deep'],
  ['onDeepMuted', 'deepEnd'],
  ['onDeepMuted', 'deepCard'],
  ['deepAccent', 'deep'],
  ['deepAccent', 'deepEnd'],
  ['deepAccent', 'deepCard'],
];
const sets = tokenSets();
for (const theme of ['light', 'dark']) {
  const low = TEXT_PAIRS.map(([text, surface]) => ({
    pair: `${text} on ${surface}`,
    ratio: contrast(sets[theme][text], sets[theme][surface]),
  })).filter((p) => p.ratio < 4.5);
  check(
    `tokens, ${theme}: all ${TEXT_PAIRS.length} text and background pairs reach 4.5 to 1`,
    low.length === 0,
    low.map((p) => `${p.pair} is ${p.ratio.toFixed(2)}`).join(' | '),
  );
}

// ---- The landing page ---------------------------------------------------------------------------

const main = await open();
const response = await main.page.goto(home);
check(
  `${PAGE}: answers 200 from the sub-path`,
  response?.status() === 200,
  `${response?.status()}`,
);
await loadAll(main.page);

const title = await main.page.title();
check(
  `${PAGE}: a title of two to four words`,
  title.trim().split(/\s+/).length >= 2 && title.trim().split(/\s+/).length <= 4,
  title,
);
check(
  `${PAGE}: says it is a prototype on synthetic data`,
  (await main.page.locator('body').innerText()).includes(NOTICE) &&
    (await main.page.locator('.hero').innerText()).toLowerCase().includes('prototype'),
);
const noAlt = await main.page.evaluate(() =>
  [...globalThis.document.images]
    .filter((image) => !image.closest('[data-lightbox-dialog]'))
    .filter((image) => (image.getAttribute('alt') ?? '').trim().length < 12)
    .map((image) => image.getAttribute('src')),
);
check(`${PAGE}: every image has real alt text`, noAlt.length === 0, noAlt.join(' | '));
const broken = await main.page.evaluate(() =>
  [...globalThis.document.images]
    .filter((image) => !image.closest('[data-lightbox-dialog]'))
    .filter((image) => image.naturalWidth === 0)
    .map((image) => image.currentSrc || image.src),
);
check(`${PAGE}: every image loaded`, broken.length === 0, broken.join(' | '));

// Every URL the page names: links, images at both widths, posters, sources, stylesheets, scripts.
const named = await main.page.evaluate(() => {
  const urls = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value !== '')
      urls.add(new URL(value, globalThis.location.href).href);
  };
  for (const el of globalThis.document.querySelectorAll('a[href], link[href]'))
    add(el.getAttribute('href'));
  for (const el of globalThis.document.querySelectorAll('img[src], script[src], source[src]'))
    add(el.getAttribute('src'));
  for (const el of globalThis.document.querySelectorAll('video[poster]'))
    add(el.getAttribute('poster'));
  for (const el of globalThis.document.querySelectorAll('img[srcset]'))
    for (const candidate of (el.getAttribute('srcset') ?? '').split(','))
      add(candidate.trim().split(/\s+/)[0]);
  return [...urls];
});
const outside = named.filter(
  (url) => !url.startsWith(home) && !url.startsWith('data:') && !demoAddresses.includes(url),
);
check(
  ARTIFACT
    ? 'artifact: no link or asset points outside the folder, apart from the demo'
    : 'landing page: no link or asset points outside the site',
  outside.length === 0,
  outside.join(' | '),
);
const unresolved = [];
const anchors = [];
for (const url of named.filter((u) => u.startsWith(home))) {
  const [path, hash] = url.split('#');
  if (path === home) {
    if (hash !== undefined && hash !== '') anchors.push(hash);
    continue;
  }
  const answer = await main.page.request.get(path);
  if (answer.status() !== 200) unresolved.push(`${answer.status()} ${path.slice(home.length)}`);
}
check(
  `${PAGE}: all ${named.filter((u) => u.startsWith(home)).length} links and assets resolve`,
  unresolved.length === 0,
  unresolved.join(' | '),
);
const missingAnchors = [];
for (const id of new Set(anchors))
  if ((await main.page.locator(`[id="${id}"]`).count()) !== 1) missingAnchors.push(id);
check(
  `${PAGE}: every in-page link has its target`,
  missingAnchors.length === 0,
  missingAnchors.join(' | '),
);

// The sections the brief asks for, each with a heading.
for (const id of ['top', 'overview', 'tour', 'controls', 'videos', 'brochures', 'demo'])
  check(
    `${PAGE}: section #${id} is present with a heading`,
    (await main.page.locator(`#${id}`).locator('h1, h2').count()) >= 1,
  );
const featureShots = await main.page
  .locator('.feature')
  .evaluateAll((blocks) => blocks.map((block) => block.querySelectorAll('img').length));
check(
  `${PAGE}: nine feature blocks, each with at least one screenshot`,
  featureShots.length === 9 && featureShots.every((count) => count >= 1),
  `${featureShots.length} blocks with ${featureShots.join(', ')} screenshots`,
);

// ---- Videos: a poster, a playable WebM source, no autoplay ----------------------------------------

const videos = main.page.locator('video[data-video]');
const videoCount = await videos.count();
check('videos: six recordings', videoCount === 6, `${videoCount}`);
for (let i = 0; i < videoCount; i += 1) {
  const video = videos.nth(i);
  const label = (await video.getAttribute('aria-label')) ?? `video ${i + 1}`;
  const attributes = await video.evaluate((el) => ({
    poster: el.getAttribute('poster'),
    source: el.querySelector('source')?.getAttribute('src') ?? null,
    type: el.querySelector('source')?.getAttribute('type') ?? null,
    controls: el.controls,
    autoplay: el.autoplay,
  }));
  const poster =
    attributes.poster === null
      ? null
      : await main.page.request.get(new URL(attributes.poster, home).href);
  const source =
    attributes.source === null
      ? null
      : await main.page.request.get(new URL(attributes.source, home).href);
  const megabytes = source === null ? 0 : (await source.body()).length / 1024 / 1024;
  check(
    `${label}: has a poster, a WebM source under 12 MB, controls and no autoplay`,
    poster?.status() === 200 &&
      (poster.headers()['content-type'] ?? '').startsWith('image/') &&
      source?.status() === 200 &&
      (source.headers()['content-type'] ?? '') === 'video/webm' &&
      attributes.type === 'video/webm' &&
      megabytes > 0.2 &&
      megabytes <= 12 &&
      attributes.controls &&
      !attributes.autoplay,
    `poster ${poster?.status()}, source ${source?.status()} ${megabytes.toFixed(1)} MB`,
  );
  const played = await video.evaluate(
    (el) =>
      new Promise((resolve) => {
        const finish = (ok, detail) => resolve({ ok, detail, seconds: el.duration });
        const timer = globalThis.setTimeout(
          () => finish(false, 'no playback within 20 seconds'),
          20_000,
        );
        el.muted = true;
        el.addEventListener('error', () => finish(false, 'the element reported an error'));
        el.querySelector('source')?.addEventListener('error', () =>
          finish(false, 'the source failed'),
        );
        el.addEventListener('timeupdate', () => {
          if (el.currentTime > 0.4 && el.videoWidth > 0) {
            globalThis.clearTimeout(timer);
            el.pause();
            finish(true, '');
          }
        });
        el.play().catch((error) => finish(false, String(error)));
      }),
  );
  check(`${label}: plays in the browser`, played.ok, played.detail);
}
const steps = await main.page.locator('.video details ol li').count();
check('videos: each recording lists its steps as text', steps >= videoCount * 5, `${steps} steps`);

// ---- Brochures: each link returns a PDF -------------------------------------------------------------

const brochureLinks = await main.page
  .locator('.brochure a[download]')
  .evaluateAll((links) => links.map((a) => a.getAttribute('href')));
check('brochures: three of them', brochureLinks.length === 3, `${brochureLinks.length}`);
for (const href of brochureLinks) {
  const answer = await main.page.request.get(new URL(href, home).href);
  const body = await answer.body();
  check(
    `brochure ${href?.split('/').pop()}: returns a PDF`,
    answer.status() === 200 &&
      (answer.headers()['content-type'] ?? '') === 'application/pdf' &&
      body.subarray(0, 5).toString('latin1') === '%PDF-',
    `${answer.status()} ${answer.headers()['content-type']}`,
  );
}
check(
  'brochures: each has a cover image and a page count',
  (await main.page.locator('.brochure-cover img').count()) === 3 &&
    (await main.page.locator('.brochure .meta').allInnerTexts()).every((t) => /^\d+ pages/.test(t)),
);

// ---- Behaviour: theme switch, lightbox, keyboard ------------------------------------------------------

await main.page.keyboard.press('Tab');
check(
  'keyboard: the first Tab lands on the skip link',
  (await main.page.evaluate(() => globalThis.document.activeElement?.className)) === 'skip-link',
);
const toggle = main.page.locator('[data-theme-toggle]');
await toggle.click();
const switched = await main.page.evaluate(() => globalThis.document.documentElement.dataset.theme);
await toggle.click();
const back = await main.page.evaluate(() => globalThis.document.documentElement.dataset.theme);
check(
  'theme switch: sets the theme and sets it back',
  switched === 'dark' && back === 'light',
  `${switched}, ${back}`,
);
await main.page.locator('a[data-lightbox]').first().click();
const enlarged = main.page.locator('dialog[open] img');
await enlarged.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
const enlargedBox = await enlarged.boundingBox();
check(
  'lightbox: a screenshot opens enlarged, inside the view',
  enlargedBox !== null &&
    enlargedBox.width > 600 &&
    enlargedBox.x >= 0 &&
    enlargedBox.x + enlargedBox.width <= DESKTOP.width &&
    enlargedBox.y + enlargedBox.height <= DESKTOP.height,
  JSON.stringify(enlargedBox),
);
await main.page.keyboard.press('Escape');
check('lightbox: Escape closes it', (await main.page.locator('dialog[open]').count()) === 0);
const unfocusable = await main.page.evaluate(() =>
  [...globalThis.document.querySelectorAll('a[href], button, summary, video[controls]')]
    .filter((el) => el.checkVisibility())
    .filter((el) => el.tabIndex < 0)
    .map((el) => el.outerHTML.slice(0, 60)),
);
check(
  'keyboard: every link, button and video control is reachable',
  unfocusable.length === 0,
  unfocusable.join(' | '),
);

check(
  `${PAGE}: no request to another origin`,
  main.seen.foreign.length === 0,
  main.seen.foreign.join(' | '),
);
check(`${PAGE}: no failed request`, main.seen.failed.length === 0, main.seen.failed.join(' | '));
check(`${PAGE}: no script error`, main.seen.errors.length === 0, main.seen.errors.join(' | '));
await main.context.close();

// ---- The artifact: its own background, and the theme of the host's root element ---------------------

if (ARTIFACT) {
  const rgb = (hex) =>
    `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  const background = async (path, colorScheme) => {
    const { context, page } = await open({ colorScheme });
    await page.goto(`${home}${path}`);
    const colour = await page.evaluate(
      () => globalThis.getComputedStyle(globalThis.document.body).backgroundColor,
    );
    await context.close();
    return colour;
  };
  const shown = {
    systemLight: await background('', 'light'),
    systemDark: await background('', 'dark'),
    // The attribute on the host's root element wins over the system setting, both ways.
    hostDark: await background('host-dark.html', 'light'),
    hostLight: await background('host-light.html', 'dark'),
  };
  check(
    'artifact: the stylesheet sets the background on <body> itself, light and dark by the system setting',
    shown.systemLight === rgb(sets.light.bg) && shown.systemDark === rgb(sets.dark.bg),
    JSON.stringify(shown),
  );
  check(
    'artifact: the theme follows the data-theme attribute on the root element of the host document',
    shown.hostDark === rgb(sets.dark.bg) && shown.hostLight === rgb(sets.light.bg),
    JSON.stringify(shown),
  );
}

// ---- The 404 page ---------------------------------------------------------------------------------------

if (!ARTIFACT) {
  const lost = await open();
  const lostResponse = await lost.page.goto(`${home}no/such/page`);
  const lostTitle = await lost.page.title();
  check(
    '404 page: served with status 404, a title of two to four words and the prototype notice',
    lostResponse?.status() === 404 &&
      lostTitle.trim().split(/\s+/).length >= 2 &&
      lostTitle.trim().split(/\s+/).length <= 4 &&
      (await lost.page.locator('body').innerText()).includes(NOTICE),
    `${lostResponse?.status()} "${lostTitle}"`,
  );
  check(
    '404 page: loads nothing else (no other origin, no missing file)',
    lost.seen.foreign.length === 0 &&
      lost.seen.failed.filter((f) => !f.includes('no/such/page')).length === 0,
    [...lost.seen.foreign, ...lost.seen.failed].join(' | '),
  );
  await lost.context.close();
  // Its one link goes to the base path the site was built for (the root unless PB_SITE_BASE is set).
  const rootServer = await serveStatic(DIST, { base: process.env.PB_SITE_BASE ?? '/' });
  const atRoot = await open();
  await atRoot.page.goto(`${rootServer.url}no/such/page`);
  await atRoot.page.getByRole('link').first().click();
  await atRoot.page
    .locator('.hero h1')
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
  check(
    '404 page: its link leads back to the landing page',
    atRoot.page.url() === rootServer.url && (await atRoot.page.locator('.hero h1').count()) === 1,
    atRoot.page.url(),
  );
  await atRoot.context.close();
  await rootServer.close();
}

// ---- Accessibility and layout: each page, both themes, a desktop and a phone ------------------------------

const PAGES = ARTIFACT
  ? [{ name: 'artifact', url: home }]
  : [
      { name: 'landing page', url: home },
      { name: '404 page', url: `${home}no/such/page` },
    ];
for (const target of PAGES)
  for (const theme of ['light', 'dark'])
    for (const view of [
      { name: '1440 px', viewport: DESKTOP },
      { name: '390 px', viewport: PHONE, isMobile: true, hasTouch: true },
    ]) {
      const { context, page } = await open({
        viewport: view.viewport,
        colorScheme: theme,
        isMobile: view.isMobile === true,
        hasTouch: view.hasTouch === true,
      });
      await page.goto(target.url);
      await loadAll(page);
      const scan = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      const blocking = scan.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      check(
        `${target.name}, ${theme}, ${view.name}: axe finds no serious or critical issue`,
        blocking.length === 0,
        blocking
          .map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target?.join(' ') ?? ''}`)
          .join(' | '),
      );
      const overflow = await sideways(page);
      check(
        `${target.name}, ${theme}, ${view.name}: no horizontal scroll`,
        overflow <= 0,
        `${overflow}px wider than the view`,
      );
      if (view.isMobile === true && target.url === home) {
        const menu = page.locator('[data-menu-toggle]');
        await menu.click();
        const shown = await page.locator('.site-nav a').first().isVisible();
        const wider = await sideways(page);
        await page.locator('.site-nav a', { hasText: 'Videos' }).click();
        check(
          `${target.name}, ${theme}, ${view.name}: the menu opens, fits and closes on a choice`,
          shown && wider <= 0 && (await menu.getAttribute('aria-expanded')) === 'false',
          `shown ${shown}, ${wider}px wider`,
        );
      }
      await context.close();
    }

// ---- Without script: the page is complete, on a phone too ----------------------------------------------------

const plain = await open({
  viewport: PHONE,
  isMobile: true,
  hasTouch: true,
  javaScriptEnabled: false,
});
await plain.page.goto(home);
const hiddenBlocks = await plain.page
  .locator('[data-reveal]')
  .evaluateAll(
    (blocks) => blocks.filter((el) => Number(globalThis.getComputedStyle(el).opacity) < 1).length,
  );
check(
  'without script: every block is visible, the section links are there and nothing scrolls sideways',
  hiddenBlocks === 0 &&
    (await plain.page.locator('.site-nav a').first().isVisible()) &&
    (await plain.page.locator('[data-theme-toggle]').isHidden()) &&
    (await sideways(plain.page)) <= 0,
  `${hiddenBlocks} hidden blocks, ${await sideways(plain.page)}px wider than the view`,
);
await plain.context.close();

// ---- The demo, from the sub-path: it opens and signs in ----------------------------------------------------

if (!ARTIFACT) {
  const demo = await open();
  await demo.page.goto(home);
  const demoLinks = await demo.page
    .locator('a[href^="demo/"]')
    .evaluateAll((links) =>
      links.map((a) => ({ target: a.getAttribute('target'), rel: a.getAttribute('rel') })),
    );
  check(
    'demo: all three "Open the demo" links open a new tab without handing it the site (target="_blank" rel="noopener")',
    demoLinks.length === 3 &&
      demoLinks.every(
        (a) => a.target === '_blank' && (a.rel ?? '').split(/\s+/).includes('noopener'),
      ),
    JSON.stringify(demoLinks),
  );
  const [demoTab] = await Promise.all([
    demo.context.waitForEvent('page'),
    demo.page.locator('.hero .actions a').first().click(),
  ]);
  await demoTab.waitForURL(/\/demo\/index\.html/);
  check(
    'demo: "Open the demo" opens demo/index.html under the sub-path in a new tab, and the site stays open behind it',
    demoTab.url().startsWith(`${home}demo/`) &&
      demo.page.url() === home &&
      // What rel="noopener" means inside the new tab: it holds no handle on the site's window.
      (await demoTab.evaluate(() => globalThis.opener)) === null,
    `${demoTab.url()} with the site at ${demo.page.url()}`,
  );
  demo.page = demoTab;
  const picker = demo.page.getByTestId('mock-user-list');
  await picker.waitFor({ timeout: 30_000 }).catch(() => undefined);
  check('demo: the sign-in picker loads', await picker.isVisible());
  await picker.getByRole('button').first().click();
  const signedIn = demo.page.getByTestId('current-user');
  await signedIn.waitFor({ timeout: 30_000 }).catch(() => undefined);
  check('demo: picking a synthetic user signs in', await signedIn.isVisible());
  await demo.page.goto(`${home}demo/index.html#/portfolio`);
  const grid = demo.page.getByTestId('portfolio-count');
  await grid.waitFor({ timeout: 30_000 }).catch(() => undefined);
  check('demo: the portfolio grid renders', await grid.isVisible());
  const misses = await demo.page.evaluate(() => [...(globalThis.__pbPreviewMisses ?? [])]);
  check(
    'demo: no request to another origin, no failed request, no recording miss, no script error',
    demo.seen.foreign.length === 0 &&
      demo.seen.failed.length === 0 &&
      misses.length === 0 &&
      demo.seen.errors.length === 0,
    [...demo.seen.foreign, ...demo.seen.failed, ...misses, ...demo.seen.errors]
      .slice(0, 4)
      .join(' | '),
  );
  await demo.context.close();

  // ---- Search engines: every page asks not to be listed, unless the site is switched to findable ---------------

  // The switch is SITE.findable in src/content/site.ts; this file reads it as text.
  const findable = /\bfindable:\s*true\b/.test(
    readFileSync(join(SITE_DIR, 'src', 'content', 'site.ts'), 'utf8'),
  );
  const noindex = (file) =>
    /<meta\s+name="robots"\s+content="noindex"\s*\/?>/.test(readFileSync(join(DIST, file), 'utf8'));
  const listed = {
    'index.html': noindex('index.html'),
    '404.html': noindex('404.html'),
    'demo/index.html': noindex(join('demo', 'index.html')),
  };
  check(
    findable
      ? 'search engines: the site is switched to findable, so only the 404 page carries noindex'
      : 'search engines: the landing page, the 404 page and the demo all carry noindex',
    findable
      ? !listed['index.html'] && listed['404.html'] && !listed['demo/index.html']
      : Object.values(listed).every(Boolean),
    JSON.stringify(listed),
  );
}

await browser.close();
await server.close();
for (const r of results)
  process.stdout.write(`${r.status} ${r.name}${r.detail ? ` (${r.detail})` : ''}\n`);
const count = (status) => results.filter((r) => r.status === status).length;
process.stdout.write(
  `check-site: ${count('PASS')} passed, ${count('FAIL')} failed (${ARTIFACT ? 'the artifact fragment inside a host document, ' : ''}served from ${BASE})\n`,
);
process.exit(count('FAIL') === 0 ? 0 : 1);
