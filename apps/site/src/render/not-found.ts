/**
 * The 404 page. A static host serves it at whatever address was not found, so it cannot rely on
 * a relative URL: it carries its own small stylesheet inline, loads nothing else, and its one link
 * goes to the site's base path (the root unless PB_SITE_BASE says otherwise at build time).
 */
import { NOT_FOUND, SITE } from '../content/site.js';
import { html, trusted } from './html.js';
import { crest } from './scene.js';

const CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;display:grid;grid-template-rows:1fr auto;background:var(--pb-bg);color:var(--pb-text);font-family:var(--pb-font-ui);font-size:17px;line-height:1.6}
main{display:grid;place-items:center;padding:72px 16px 96px;text-align:center;background:linear-gradient(180deg,var(--pb-scene-sky-top) 0%,var(--pb-scene-sky) 100%)}
p.wordmark{margin:0 auto 40px;max-width:none;font-family:var(--pb-font-display);font-size:22px;color:var(--pb-primary);letter-spacing:.01em}
h1{margin:0 0 16px;font-family:var(--pb-font-display);font-weight:400;font-size:clamp(34px,7vw,60px);line-height:1.08;letter-spacing:-.01em;color:var(--pb-primary);text-wrap:balance}
p{margin:0 auto 28px;max-width:46ch;color:var(--pb-muted)}
a.button{display:inline-flex;align-items:center;min-height:48px;padding:0 26px;border-radius:999px;background:var(--pb-primary);color:var(--pb-on-primary);font-weight:600;text-decoration:none}
a.button:hover{background:var(--pb-primary-hover)}
a:focus-visible{outline:3px solid var(--pb-accent);outline-offset:3px}
footer{position:relative;padding:28px 16px 32px;background:var(--pb-deep);color:var(--pb-on-deep-muted);font-size:14px;text-align:center}
footer p{margin:0 auto;max-width:70ch;color:inherit}
.crest{position:absolute;left:0;right:0;bottom:calc(100% - 1px);width:100%;height:clamp(20px,4vw,48px);display:block;color:var(--pb-deep)}
.crest path{fill:currentColor}
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
        <p class="wordmark">${SITE.name}</p>
        <h1>${NOT_FOUND.heading}</h1>
        <p>${NOT_FOUND.text}</p>
        <a class="button" href="${home}">${NOT_FOUND.action}</a>
      </div>
    </main>
    <footer>
      ${crest()}
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
    <style>${trusted(tokens).value}${CSS}</style>
  </head>
  <body>
    ${body.value}
  </body>
</html>
`;
}
