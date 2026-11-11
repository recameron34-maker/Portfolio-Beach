import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import { tokensCss } from './scripts/lib/tokens.mjs';
import { renderFavicon } from './src/render/favicon.js';
import { readMedia } from './src/render/media.js';
import { renderNotFound } from './src/render/not-found.js';
import { renderPage } from './src/render/page.js';

const here = dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = join(here, 'media');
const PREVIEW_DIR = resolve(process.env.PB_PREVIEW_OUT ?? join(here, '..', 'web', 'dist-preview'));
/** The file types of each media folder that are published; manifests and working files stay behind. */
const PUBLISHED: Record<string, string[]> = {
  screens: ['.webp'],
  videos: ['.webm', '.webp'],
  brochures: ['.pdf', '.webp'],
};
/** Files of the preview that are for publishing it as an artifact, not for a static host. */
const PREVIEW_ONLY = new Set(['artifact.html', 'publish.json']);

/**
 * Renders the page into index.html when Vite builds or serves (static markup, no rendering in
 * the browser), writes the 404 page, and copies the generated media and the interactive preview
 * into the built folder. The injection runs after Vite has processed the document, so the media
 * URLs stay exactly as written: relative, unhashed, the same on every host and base path.
 */
function site(): Plugin {
  let outDir = join(here, 'dist');
  return {
    name: 'pb-site',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    transformIndexHtml: {
      order: 'post',
      handler(document) {
        return document
          .replace(
            '<!--pb:head-->',
            `<link rel="icon" href="favicon.svg" type="image/svg+xml" /><style>${tokensCss()}</style>`,
          )
          .replace('<!--pb:page-->', renderPage(readMedia(MEDIA_DIR)));
      },
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'favicon.svg', source: renderFavicon() });
      this.emitFile({
        type: 'asset',
        fileName: '404.html',
        source: renderNotFound(tokensCss(), process.env.PB_SITE_BASE ?? '/'),
      });
    },
    closeBundle() {
      for (const [folder, extensions] of Object.entries(PUBLISHED)) {
        const from = join(MEDIA_DIR, folder);
        const to = join(outDir, 'media', folder);
        mkdirSync(to, { recursive: true });
        for (const file of readdirSync(from))
          if (extensions.includes(extname(file))) cpSync(join(from, file), join(to, file));
      }
      if (!existsSync(join(PREVIEW_DIR, 'index.html')))
        throw new Error(
          `the interactive preview is not built: ${PREVIEW_DIR} has no index.html. Run "node scripts/build-preview.mjs" in apps/web, or "pnpm --filter @pb/site build".`,
        );
      cpSync(PREVIEW_DIR, join(outDir, 'demo'), {
        recursive: true,
        filter: (source) => !PREVIEW_ONLY.has(source.slice(PREVIEW_DIR.length + 1)),
      });
    },
  };
}

export default defineConfig({
  // Relative URLs only: the built folder works from any base path.
  base: './',
  plugins: [site()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0 },
});
