/**
 * The 404 page. A static host serves it at whatever address was not found, so it cannot rely on
 * a relative URL: it carries its own small stylesheet inline, loads nothing else, and its one link
 * goes to the site's base path (the root unless PB_SITE_BASE says otherwise at build time).
 *
 * Its type is the product's own (decision 0026). A font file at an address would be one more
 * thing a host must serve from the right place, so the two weights the page uses travel inside
 * it, as data: the regular and the semibold Latin files of the web app (apps/web/src/app/fonts,
 * declared for the tool and the site in apps/web/src/app/fonts.css), about 43 KB before encoding.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_FOUND, SITE } from '../content/site.js';
import { html, trusted } from './html.js';
import { mark } from './mark.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..', '..', '..');
const FONTS = join(REPO, 'apps', 'web', 'src', 'app', 'fonts');

/** The first family of the brand's UI stack (config/brand.json): the one the bundled files are. */
function uiFamily(): string {
  const brand = JSON.parse(readFileSync(join(REPO, 'config', 'brand.json'), 'utf8')) as {
    fonts: { ui: string[] };
  };
  return brand.fonts.ui[0] ?? 'sans-serif';
}

/** The two weights the page sets (text, and the heading, the name and the button), as data. */
function faces(): string {
  const family = uiFamily();
  return [
    { weight: 400, file: 'IBMPlexSans-Regular-Latin1.woff2' },
    { weight: 600, file: 'IBMPlexSans-SemiBold-Latin1.woff2' },
  ]
    .map(
      ({ weight, file }) =>
        `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${readFileSync(join(FONTS, file)).toString('base64')}) format('woff2')}`,
    )
    .join('\n');
}

const CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;grid-template-rows:1fr auto;background:var(--pb-bg);color:var(--pb-text);font-family:var(--pb-font-ui);font-size:16px;line-height:1.6}
main{display:grid;place-items:center;padding:72px 16px 96px;text-align:center}
p.wordmark{display:inline-flex;align-items:center;gap:8px;margin:0 auto 32px;max-width:none;font-size:16px;font-weight:600;line-height:1;color:var(--pb-text)}
.mark{display:block;flex:none}
.mark-tile{fill:var(--pb-primary)}
.mark-bar{fill:var(--pb-bg)}
h1{margin:0 0 12px;font-weight:600;font-size:clamp(32px,6vw,48px);line-height:1.1;letter-spacing:-.02em;color:var(--pb-text);text-wrap:balance}
p{margin:0 auto 24px;max-width:46ch;color:var(--pb-muted)}
a.button{display:inline-flex;align-items:center;min-height:44px;padding:0 20px;border-radius:4px;background:var(--pb-primary);color:var(--pb-on-primary);font-weight:600;text-decoration:none}
a.button:hover{background:var(--pb-primary-hover)}
a:focus-visible{outline:2px solid var(--pb-accent);outline-offset:2px}
footer{padding:24px 16px 28px;border-top:1px solid var(--pb-border);color:var(--pb-muted);font-size:14px;text-align:center}
footer p{margin:0 auto;max-width:70ch;color:inherit}
`;

/** The base path without the slashes at either end, cut in loops (no pattern to backtrack). */
function withoutEdgeSlashes(path: string): string {
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === '/') start += 1;
  while (end > start && path[end - 1] === '/') end -= 1;
  return path.slice(start, end);
}

export function renderNotFound(tokens: string, base: string): string {
  const home = `/${withoutEdgeSlashes(base)}/`.replace('//', '/');
  const body = html`<main>
      <div>
        <p class="wordmark">${mark()}${SITE.name}</p>
        <h1>${NOT_FOUND.heading}</h1>
        <p>${NOT_FOUND.text}</p>
        <a class="button" href="${home}">${NOT_FOUND.action}</a>
      </div>
    </main>
    <footer>
      <p>${SITE.footer}</p>
    </footer>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${NOT_FOUND.title}</title>
    <meta name="robots" content="noindex" />
    <meta name="color-scheme" content="light dark" />
    <style>${trusted(tokens).value}${faces()}${CSS}</style>
  </head>
  <body>
    ${body.value}
  </body>
</html>
`;
}
