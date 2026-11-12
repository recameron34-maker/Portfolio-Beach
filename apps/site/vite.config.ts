import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { tokensCss } from './scripts/lib/tokens.mjs';
import { SITE } from './src/content/site.js';
import { demoAddress, fragmentFiles, toFragment } from './src/render/artifact.js';
import { renderFavicon } from './src/render/favicon.js';
import { readMedia } from './src/render/media.js';
import { renderNotFound } from './src/render/not-found.js';
import { renderPage } from './src/render/page.js';

const here = dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = join(here, 'media');
const PREVIEW_DIR = resolve(process.env.PB_PREVIEW_OUT ?? join(here, '..', 'web', 'dist-preview'));
/**
 * PB_SITE_TARGET=artifact builds the private preview instead of the site: the landing page as a
 * fragment with its supporting files, in dist-artifact/ (src/render/artifact.ts, scripts/build.mjs).
 */
const ARTIFACT = process.env.PB_SITE_TARGET === 'artifact';
/** What the host that wraps a fragment allows: each file under 15 MB, fewer than 200 files. */
const ARTIFACT_MAX_BYTES = 15 * 1024 * 1024;
const ARTIFACT_MAX_FILES = 200;
/** Files of the preview that are for publishing it as an artifact, not for a static host. */
const PREVIEW_ONLY = new Set(['artifact.html', 'publish.json']);
/**
 * Asks search engines not to list a page. Every page carries it unless SITE.findable is set
 * (src/content/site.ts); the 404 page carries it always.
 */
const NOINDEX = '<meta name="robots" content="noindex" />';

/** The demo's entry page is the preview's own file: it gets the same tag as the site's pages. */
function noindexDemo(file: string): void {
  const document = readFileSync(file, 'utf8');
  if (/<meta\s+name="robots"/i.test(document)) return;
  const at = document.search(/<meta\s+charset=[^>]*>/i);
  if (at === -1) throw new Error(`${file}: no <meta charset> to put the robots tag after`);
  const end = document.indexOf('>', at) + 1;
  writeFileSync(file, `${document.slice(0, end)}\n    ${NOINDEX}${document.slice(end)}`);
}

/** Every file under a folder, as paths relative to it with forward slashes, sorted. */
function filesUnder(root: string, folder = ''): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true })
    .flatMap((entry) => {
      const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
      return entry.isDirectory() ? filesUnder(root, path) : [path];
    })
    .sort();
}

/**
 * Renders the page into index.html when Vite builds or serves (static markup, no rendering in
 * the browser), writes the 404 page, and copies the media the page shows and the interactive
 * preview into the built folder. The injection runs after Vite has processed the document, so the
 * media URLs stay exactly as written: relative, unhashed, the same on every host and base path.
 * The artifact build ends differently: the document becomes a fragment, the demo is left out and
 * publish.json lists the files beside the fragment.
 */
function site(): Plugin {
  let outDir = join(here, ARTIFACT ? 'dist-artifact' : 'dist');
  let page = '';
  return {
    name: 'pb-site',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    transformIndexHtml: {
      order: 'post',
      handler(document) {
        page = renderPage(
          readMedia(MEDIA_DIR),
          ARTIFACT ? { demoHref: demoAddress(process.env.SITE_DEMO_URL) } : {},
        );
        const icon = ARTIFACT ? '' : '<link rel="icon" href="favicon.svg" type="image/svg+xml" />';
        return document
          .replace('<!--pb:robots-->', SITE.findable || ARTIFACT ? '' : NOINDEX)
          .replace('<!--pb:head-->', `${icon}<style>${tokensCss()}</style>`)
          .replace('<!--pb:page-->', page);
      },
    },
    generateBundle() {
      // A fragment has no icon of its own, and its host answers for an address that is not there.
      if (ARTIFACT) return;
      this.emitFile({ type: 'asset', fileName: 'favicon.svg', source: renderFavicon() });
      this.emitFile({
        type: 'asset',
        fileName: '404.html',
        source: renderNotFound(tokensCss(), process.env.PB_SITE_BASE ?? '/'),
      });
    },
    closeBundle() {
      // The media the page names, and nothing else of the media folder (its manifests, and the
      // screenshots only a brochure shows, stay behind).
      const shown = new Set(
        [...page.matchAll(/media\/(?:screens|videos|brochures)\/[A-Za-z0-9._-]+/g)].map(
          (match) => match[0],
        ),
      );
      if (shown.size === 0) throw new Error('the page names no media: it was not rendered');
      for (const path of shown) {
        const from = join(here, path);
        if (!existsSync(from))
          throw new Error(
            `${path} is named by the page but is not in the media folder. Run "pnpm --filter @pb/site build" to generate the media.`,
          );
        mkdirSync(dirname(join(outDir, path)), { recursive: true });
        cpSync(from, join(outDir, path));
      }

      if (ARTIFACT) {
        const fragment = toFragment(
          readFileSync(join(outDir, 'index.html'), 'utf8'),
          SITE.artifactTitle,
        );
        rmSync(join(outDir, 'index.html'));
        rmSync(join(outDir, 'publish.json'), { force: true });
        writeFileSync(join(outDir, 'artifact.html'), fragment);
        const files = filesUnder(outDir).filter((file) => file !== 'artifact.html');
        const missing = fragmentFiles(fragment).filter((file) => !files.includes(file));
        if (missing.length > 0)
          throw new Error(`the fragment names files that are not beside it: ${missing.join(', ')}`);
        const heavy = files.filter(
          (file) => statSync(join(outDir, file)).size >= ARTIFACT_MAX_BYTES,
        );
        if (heavy.length > 0) throw new Error(`over 15 MB each: ${heavy.join(', ')}`);
        if (files.length + 1 >= ARTIFACT_MAX_FILES)
          throw new Error(`${files.length + 1} files, and the host takes fewer than 200`);
        writeFileSync(
          join(outDir, 'publish.json'),
          `${JSON.stringify({ page: 'artifact.html', files }, null, 2)}\n`,
        );
        return;
      }

      if (!existsSync(join(PREVIEW_DIR, 'index.html')))
        throw new Error(
          `the interactive preview is not built: ${PREVIEW_DIR} has no index.html. Run "node scripts/build-preview.mjs" in apps/web, or "pnpm --filter @pb/site build".`,
        );
      cpSync(PREVIEW_DIR, join(outDir, 'demo'), {
        recursive: true,
        filter: (source) => !PREVIEW_ONLY.has(source.slice(PREVIEW_DIR.length + 1)),
      });
      if (!SITE.findable) noindexDemo(join(outDir, 'demo', 'index.html'));
    },
  };
}

export default defineConfig({
  // Relative URLs only: the built folder works from any base path.
  base: './',
  plugins: [site()],
  build: {
    outDir: ARTIFACT ? 'dist-artifact' : 'dist',
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
  },
});
