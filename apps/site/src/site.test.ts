import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contrast, tokenSets, tokensCss } from '../scripts/lib/tokens.mjs';
import * as content from './content/site.js';
import { demoAddress, fragmentFiles, toFragment } from './render/artifact.js';
import { escapeHtml, html, trusted } from './render/html.js';
import { lengthText, sizeText } from './render/media.js';
import type { Media } from './render/media.js';
import { renderNotFound } from './render/not-found.js';
import { renderPage } from './render/page.js';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..');

/** Every screenshot of the tour: each area's first one and the smaller ones under it. */
function tourShots(): { shot: string; alt: string }[] {
  const features: readonly content.Feature[] = content.TOUR.features;
  return features.flatMap((f) => [{ shot: f.shot, alt: f.alt }, ...(f.more ?? [])]);
}

/** A stand-in for the generated media: the names the page asks for, with made-up sizes. */
function media(): Media {
  const shots = [content.OVERVIEW.heroShot.name, ...tourShots().map((s) => s.shot)];
  return {
    screens: new Map(
      shots.map((name) => [
        name,
        { name, width: 1440, height: 900, file: `${name}.webp`, file2x: `${name}-2x.webp` },
      ]),
    ),
    videos: [
      {
        name: 'tour',
        title: 'A first look',
        summary: 'A walk through the tool.',
        file: 'tour.webm',
        poster: 'tour.webp',
        width: 1280,
        height: 720,
        seconds: 58.4,
        bytes: 5_100_000,
        steps: [{ at: 4, text: 'A <caption> with markup in it' }],
      },
    ],
    brochures: [
      {
        name: 'product-overview',
        title: 'Product overview',
        description: 'What it is.',
        file: 'portfolio-beach-product-overview.pdf',
        cover: 'product-overview.webp',
        pages: 3,
        bytes: 3_000_000,
      },
    ],
  };
}

/** Every string the content file holds, however deep. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

describe('the HTML builder', () => {
  it('escapes interpolated text and passes nested markup through', () => {
    const inner = html`<b>${'a < b & "c"'}</b>`;
    expect(html`<p title="${'x"y'}">${inner}${['1', '2']}${null}${false}</p>`.value).toBe(
      '<p title="x&quot;y"><b>a &lt; b &amp; &quot;c&quot;</b>12</p>',
    );
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(html`${trusted('<i>as written</i>')}`.value).toBe('<i>as written</i>');
  });
});

describe('the tokens', () => {
  const sets = tokenSets();

  it('defines light on :root and dark twice: for the system setting unless switched to light, and when switched to dark', () => {
    const css = tokensCss();
    expect(css).toContain(':root{color-scheme:light;');
    expect(css).toContain(
      '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;',
    );
    expect(css).toContain(':root[data-theme="dark"]{color-scheme:dark;');
    expect(css).toContain('--pb-bg:');
    expect(css).toContain('--pb-bg-rgb:');
  });

  it('holds the same keys in both themes, so no property is left over from the other one', () => {
    expect(Object.keys(sets.dark).sort()).toEqual(Object.keys(sets.light).sort());
  });

  it('keeps the brand colours of config/brand.json as they are in the light theme', () => {
    const brand = JSON.parse(
      readFileSync(join(site, '..', '..', 'config', 'brand.json'), 'utf8'),
    ) as { colors: { brand: { primary: string; accent: string; sand: string } } };
    expect(sets.light.primary).toBe(brand.colors.brand.primary);
    expect(sets.light.accent).toBe(brand.colors.brand.accent);
    expect(sets.light.sand).toBe(brand.colors.brand.sand);
  });

  it('reaches 4.5 to 1 for body text, secondary text and headings on every surface, light and dark', () => {
    for (const set of [sets.light, sets.dark])
      for (const surface of [set.bg, set.surface, set.card]) {
        expect(contrast(set.text, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(set.muted, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(set.primary, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(set.accentInk, surface)).toBeGreaterThanOrEqual(4.5);
      }
  });

  it('computes a contrast ratio the way WCAG defines it', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBe(1);
  });
});

describe('the words', () => {
  const sources = [
    ...strings(content),
    ...readdirSync(join(site, 'brochures'))
      .filter((file) => file.endsWith('.html'))
      .map((file) => readFileSync(join(site, 'brochures', file), 'utf8')),
  ];

  it('carry no em dash', () => {
    // Written as a code point, so this file holds no em dash itself.
    const emDash = String.fromCharCode(0x2014);
    for (const text of sources) expect(text).not.toContain(emDash);
  });

  it('name no product or brand: only kinds of system', () => {
    // The copy speaks of spreadsheets, dashboards, mail and single sign-on, never of a product.
    const products =
      /\b(Excel|PowerPoint|Power BI|Outlook|SharePoint|Teams|Azure|Entra|Microsoft|Cloudflare|GitHub|Anthropic|Claude)\b/;
    for (const text of sources) expect(text).not.toMatch(products);
  });

  it('use no sales language', () => {
    const sales =
      /\b(best[- ]in[- ]class|world[- ]class|leading|revolutionary|seamless|pricing|free trial|buy now|contact sales)\b/i;
    for (const text of strings(content)) expect(text).not.toMatch(sales);
  });

  it('say on every page that this is a prototype on synthetic data', () => {
    expect(content.SITE.footer).toContain('Prototype');
    expect(content.SITE.footer).toContain('Synthetic data only');
    for (const file of readdirSync(join(site, 'brochures')).filter((f) => f.endsWith('.html'))) {
      const text = readFileSync(join(site, 'brochures', file), 'utf8');
      const sheets = text.split('<section class="page').length - 1;
      expect(text.split(content.SITE.footer).length - 1, file).toBe(sheets);
    }
  });

  it('mark what is not built as planned or in progress', () => {
    const statuses = content.TOUR.roadmap.items.map((item) => item.status);
    expect(statuses.length).toBeGreaterThan(0);
    for (const status of statuses) expect(['In progress', 'Planned']).toContain(status);
  });

  it('no longer list value creation or entry metrics as unbuilt: they are in the tour', () => {
    for (const item of content.TOUR.roadmap.items)
      expect(`${item.name} ${item.text}`).not.toMatch(/value creation|entry metric/i);
    expect(content.TOUR.features.map((f) => f.id)).toContain('value-creation');
    for (const text of strings(content)) expect(text).not.toMatch(/in progress/i);
  });

  it('keep the site unlisted by search engines until the one switch is turned', () => {
    expect(content.SITE.findable).toBe(false);
  });
});

describe('the page', () => {
  const page = renderPage(media());

  it('has every section the navigation links to, the hero and the demo', () => {
    for (const id of ['top', 'overview', 'tour', 'controls', 'videos', 'brochures', 'demo'])
      expect(page).toContain(`id="${id}"`);
    for (const item of content.NAV) expect(page).toContain(`href="${item.href}"`);
  });

  it('writes relative URLs only', () => {
    const urls = [...page.matchAll(/\s(?:href|src|poster)="([^"]*)"/g)].map((m) => m[1] ?? '');
    expect(urls.length).toBeGreaterThan(20);
    for (const url of urls) expect(url, url).toMatch(/^(#|media\/|demo\/)/);
  });

  it('opens the demo in a new tab from all three places, and says so to a screen reader', () => {
    const links = [...page.matchAll(/<a\b[^>]*href="demo\/index\.html"[^>]*>/g)].map((m) => m[0]);
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link).toContain('target="_blank"');
      expect(link).toContain('rel="noopener"');
    }
    expect(page.split(content.SITE.newTab).length - 1).toBe(3);
    // No other link leaves the page it is on.
    expect(page.split('target="_blank"').length - 1).toBe(3);
  });

  it('links the demo to the address a build without the demo was given, or leaves the action out', () => {
    const elsewhere = renderPage(media(), { demoHref: 'https://demo.example/preview' });
    expect(elsewhere.split('href="https://demo.example/preview"').length - 1).toBe(3);
    expect(elsewhere).not.toContain('demo/index.html');
    const without = renderPage(media(), { demoHref: null });
    expect(without).not.toContain('target="_blank"');
    expect(without).not.toContain('demo/index.html');
    expect(without).toContain(content.DEMO.unlinked);
  });

  it('gives every screenshot its alt text and both widths', () => {
    expect(tourShots().length).toBeGreaterThan(content.TOUR.features.length);
    for (const feature of tourShots()) {
      expect(page).toContain(`alt="${escapeHtml(feature.alt)}"`);
      expect(page).toContain(`media/screens/${feature.shot}-2x.webp 2880w`);
    }
  });

  it('gives a video a poster, a WebM source, its length and its steps as escaped text, and never autoplay', () => {
    expect(page).toContain('poster="media/videos/tour.webp"');
    expect(page).toContain('<source src="media/videos/tour.webm" type="video/webm" />');
    expect(page).toContain('58 seconds');
    expect(page).toContain('A &lt;caption&gt; with markup in it');
    expect(page).not.toContain('autoplay');
  });

  it('links a brochure to its PDF with its page count', () => {
    expect(page).toContain('href="media/brochures/portfolio-beach-product-overview.pdf"');
    expect(page).toContain('3 pages');
  });

  it('fails with the script to run when a screenshot is missing', () => {
    const without = media();
    without.screens.delete('analytics');
    expect(() => renderPage(without)).toThrow(/capture-screens/);
  });
});

describe('the artifact fragment', () => {
  const built = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Portfolio Beach</title>
    <meta name="robots" content="noindex" />
    <style>:root{--pb-bg:#ffffff}</style>
    <script>document.documentElement.classList.add('js');</script>
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-abc.css">
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to the content</a>
    <header class="site-header"><a href="https://demo.example/x" target="_blank">Open</a></header>
    <main id="main"><img src="media/screens/home.webp" srcset="media/screens/home.webp 1440w, media/screens/home-2x.webp 2880w" /><video poster="media/videos/tour.webp"><source src="media/videos/tour.webm" /></video></main>
  </body>
</html>`;
  const fragment = toFragment(built, 'Portfolio Beach website');

  it('is no document: no doctype, no html, head or body tag, no meta and no inline script', () => {
    expect(fragment).not.toMatch(/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]|<meta\b/i);
    expect(fragment).not.toContain("classList.add('js')");
    // The page's own <header> is markup, not the document's head.
    expect(fragment).toContain('<header class="site-header">');
  });

  it('holds the title, then the stylesheet and the inline style, then the markup, then the script', () => {
    expect(fragment.startsWith('<title>Portfolio Beach website</title>\n')).toBe(true);
    const order = [
      '<title>',
      '<link rel="stylesheet"',
      '<style>',
      '<a class="skip-link"',
      '</main>',
      '<script type="module"',
    ].map((part) => fragment.indexOf(part));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(fragment.trimEnd().endsWith('</script>')).toBe(true);
    expect(fragment.split('<script').length - 1).toBe(1);
  });

  it('refuses a page it cannot make a fragment from', () => {
    expect(() => toFragment('<html><head></head><body><p>x</p></body></html>', 'A page')).toThrow(
      /stylesheet/,
    );
    expect(() => toFragment('<p>no document</p>', 'A page')).toThrow(/<head>/);
  });

  it('names every relative file that must sit beside it, and no address elsewhere', () => {
    expect(fragmentFiles(fragment)).toEqual([
      'assets/index-abc.css',
      'assets/index-abc.js',
      'media/screens/home-2x.webp',
      'media/screens/home.webp',
      'media/videos/tour.webm',
      'media/videos/tour.webp',
    ]);
  });

  it('takes the address of the demo from the environment: http or https, or none', () => {
    expect(demoAddress(undefined)).toBeNull();
    expect(demoAddress('  ')).toBeNull();
    expect(demoAddress(' https://demo.example/preview ')).toBe('https://demo.example/preview');
    expect(() => demoAddress('demo/index.html')).toThrow(/absolute/);
    expect(() => demoAddress('javascript:alert(1)')).toThrow(/http/);
  });

  it('has a title of two to four words', () => {
    const words = content.SITE.artifactTitle.split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(2);
    expect(words).toBeLessThanOrEqual(4);
  });
});

describe('the 404 page', () => {
  it('is self-contained, links to the base path it was built for and carries the notice', () => {
    const page = renderNotFound(':root{--pb-bg:#ffffff}', '/portfolio-beach');
    expect(page).toContain('href="/portfolio-beach/"');
    expect(renderNotFound('', '/')).toContain('href="/"');
    expect(page).toContain(content.SITE.footer);
    expect(page).not.toMatch(/<(link|script|img)\b/);
  });
});

describe('lengths and sizes', () => {
  it('reads as a person would say them', () => {
    expect(lengthText(58.4)).toBe('58 seconds');
    expect(lengthText(63)).toBe('1 min 3 s');
    expect(lengthText(120)).toBe('2 min');
    expect(sizeText(5_100_000)).toBe('4.9 MB');
    expect(sizeText(160_000)).toBe('156 KB');
  });
});
