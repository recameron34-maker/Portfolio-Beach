// Builds the whole site in order: the interactive preview when it is missing, the screenshots,
// the demo recordings, the brochures, then the pages with the media and the demo copied in.
// Nothing here publishes anything: the result is the static folder apps/site/dist.
//
//   node scripts/build.mjs               everything
//   node scripts/build.mjs --site-only   the pages only, reusing the media already in media/
//   node scripts/build.mjs --fresh-preview   rebuild the preview even when one exists
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_DIR, PREVIEW_DIR, REPO_DIR, SITE_DIR, previewExists } from './lib/preview.mjs';

const siteOnly = process.argv.includes('--site-only');
const freshPreview = process.argv.includes('--fresh-preview');
const log = (line) => process.stdout.write(`${line}\n`);

function run(label, command, args, cwd) {
  log(`\n== ${label}`);
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    log(`build: "${label}" failed${result.error ? `: ${result.error.message}` : ''}`);
    process.exit(result.status ?? 1);
  }
  log(`== ${label}: done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
const node = (label, script, args = [], cwd = SITE_DIR) =>
  run(label, process.execPath, [script, ...args], cwd);

if (freshPreview || !previewExists()) {
  // The preview's own build: it records the API over the synthetic dataset, so the workspace
  // packages must be compiled first (the root "pnpm typecheck" does that).
  run('workspace packages (tsc -b)', 'pnpm', ['exec', 'tsc', '-b'], REPO_DIR);
  node(
    'interactive preview',
    join('scripts', 'build-preview.mjs'),
    [],
    join(REPO_DIR, 'apps', 'web'),
  );
} else {
  log(`build: reusing the interactive preview in ${PREVIEW_DIR}`);
}

if (siteOnly) {
  for (const kind of ['screens', 'videos', 'brochures'])
    if (!existsSync(join(MEDIA_DIR, kind, 'manifest.json'))) {
      log(
        `build: --site-only reuses existing media, but media/${kind}/manifest.json is missing. Run "pnpm --filter @pb/site build" once to generate it.`,
      );
      process.exit(1);
    }
  log('build: reusing the media in media/');
} else {
  node('screenshots', join('scripts', 'capture-screens.mjs'));
  node('demo recordings', join('scripts', 'record-demos.mjs'));
  node('brochures', join('scripts', 'make-brochures.mjs'));
}

node('pages (vite build)', join(SITE_DIR, 'node_modules', 'vite', 'bin', 'vite.js'), ['build']);

// The built folder never passes through git, so the employer-data guard reads it directly,
// as the preview's own build does for its output.
run(
  'employer-data guard over the built folder',
  'bash',
  [join('scripts', 'check-employer-data.sh'), '--paths', join('apps', 'site', 'dist')],
  REPO_DIR,
);

const dist = join(SITE_DIR, 'dist');
let files = 0;
let bytes = 0;
let largest = { path: '', size: 0 };
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else {
      const size = statSync(path).size;
      files += 1;
      bytes += size;
      if (size > largest.size) largest = { path: path.slice(dist.length + 1), size };
    }
  }
};
walk(dist);
log(
  `\nbuild: ${dist}: ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB; largest ${largest.path} (${(largest.size / 1024 / 1024).toFixed(1)} MB)`,
);
