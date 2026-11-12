// Builds the whole site in order: the interactive preview when it is missing, the screenshots,
// the demo recordings, the brochures, then the pages with the media and the demo copied in.
// Nothing here publishes anything: the result is the static folder apps/site/dist.
//
//   node scripts/build.mjs               everything
//   node scripts/build.mjs --site-only   the pages only, reusing the media already in media/
//   node scripts/build.mjs --fresh-preview   rebuild the preview even when one exists
//   node scripts/build.mjs --artifact    the private preview: the landing page as a fragment with
//                                        its supporting files in apps/site/dist-artifact, reusing
//                                        the media; no demo inside ("Open the demo" goes to the
//                                        address in SITE_DEMO_URL), so no interactive preview needed
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_DIR, PREVIEW_DIR, REPO_DIR, SITE_DIR, previewExists } from './lib/preview.mjs';

const artifact = process.argv.includes('--artifact');
const siteOnly = process.argv.includes('--site-only') || artifact;
const freshPreview = process.argv.includes('--fresh-preview');
const log = (line) => process.stdout.write(`${line}\n`);

function run(label, command, args, cwd, env = process.env) {
  log(`\n== ${label}`);
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env });
  if (result.status !== 0) {
    log(`build: "${label}" failed${result.error ? `: ${result.error.message}` : ''}`);
    process.exit(result.status ?? 1);
  }
  log(`== ${label}: done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
const node = (label, script, args = [], cwd = SITE_DIR, env = process.env) =>
  run(label, process.execPath, [script, ...args], cwd, env);

if (artifact) {
  log('build: the artifact build carries no demo, so the interactive preview is not needed');
  const demo = (process.env.SITE_DEMO_URL ?? '').trim();
  log(
    demo === ''
      ? 'build: SITE_DEMO_URL is not set: the page is built WITHOUT "Open the demo". Set it to the address of the demo to link there.'
      : `build: "Open the demo" goes to ${demo}`,
  );
} else if (freshPreview || !previewExists()) {
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
        `build: this build reuses existing media, but media/${kind}/manifest.json is missing. The media is committed; in a checkout without it, run "pnpm --filter @pb/site build" once to generate it.`,
      );
      process.exit(1);
    }
  log('build: reusing the media in media/');
} else {
  node('screenshots', join('scripts', 'capture-screens.mjs'));
  node('demo recordings', join('scripts', 'record-demos.mjs'));
  node('brochures', join('scripts', 'make-brochures.mjs'));
}

const out = artifact ? 'dist-artifact' : 'dist';
node(
  artifact ? 'fragment and supporting files (vite build)' : 'pages (vite build)',
  join(SITE_DIR, 'node_modules', 'vite', 'bin', 'vite.js'),
  ['build'],
  SITE_DIR,
  artifact ? { ...process.env, PB_SITE_TARGET: 'artifact' } : process.env,
);

// The built folder never passes through git, so the employer-data guard reads it directly,
// as the preview's own build does for its output.
run(
  'employer-data guard over the built folder',
  'bash',
  [join('scripts', 'check-employer-data.sh'), '--paths', join('apps', 'site', out)],
  REPO_DIR,
);

const dist = join(SITE_DIR, out);
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
if (artifact) {
  const title = /^<title>([^<]*)<\/title>/.exec(readFileSync(join(dist, 'artifact.html'), 'utf8'));
  log(`build: artifact.html opens with <title>${title?.[1] ?? ''}</title>`);
}
