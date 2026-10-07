// Builds a self-contained static preview: records every API response the UI needs from the real
// API over the small synthetic dataset, then bundles the app in preview mode with relative asset
// paths. Output: dist-preview/ (index.html for local serving, artifact.html fragment for publishing).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { generateDataset } from '@pb/synthetic';
import { createDb, loadSyntheticDataset, migrate } from '@pb/db';
import { FixedClock } from '@pb/adapters';
import { buildRuntime } from '../../api/dist/composition.js';
import { createApp } from '../../api/dist/app.js';
import { loadConfig } from '../../api/dist/config.js';

const out = process.env.PB_PREVIEW_OUT ?? 'dist-preview';
const scratch = join(out, '.scratch');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'preview'), { recursive: true });
mkdirSync(scratch, { recursive: true });

const dataset = generateDataset({ profile: 'small', seed: 42 });
writeFileSync(join(scratch, 'dataset.json'), JSON.stringify(dataset));
const db = await createDb({ kind: 'pglite' });
await migrate(db);
await loadSyntheticDataset(db, dataset);
const config = loadConfig({
  NODE_ENV: 'test',
  PORT: '0',
  PB_LOG_LEVEL: 'silent',
  PB_MOCK_USERS: join(scratch, 'dataset.json'),
  PB_CONFIG_DIR: new URL('../../../config/', import.meta.url).pathname,
  PB_DOCUMENT_ROOT: join(scratch, 'documents'),
  PB_ACCOUNTING_ROOT: join(scratch, 'accounting'),
});
const runtime = await buildRuntime(config, {
  db,
  clock: new FixedClock(`${dataset.asOf}T12:00:00Z`),
});
const app = await createApp(runtime);
await app.listen(0, '127.0.0.1');
const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');

function normalizeKey(credential, method, pathname, search) {
  const params = new URLSearchParams(search);
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const query =
    sorted.length === 0
      ? ''
      : `?${sorted.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
  return `${credential}|${method.toUpperCase()} ${pathname}${query}`;
}

const responses = {};
let count = 0;
async function record(credential, path) {
  const url = new URL(path, base);
  const res = await fetch(url, {
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
  });
  const body = await res.text();
  responses[normalizeKey(credential, 'GET', url.pathname, url.search)] = {
    status: res.status,
    contentType: res.headers.get('content-type') ?? 'application/json',
    body,
  };
  count++;
  return res.ok ? JSON.parse(body) : null;
}

// Public routes.
await record('', '/health/live');
await record('', '/health/ready');
await record('', '/api/v1/auth/mock-users');

const DEAL_TYPES = [
  '',
  'deal_type.co_invest_equity',
  'deal_type.cv_single_asset',
  'deal_type.cv_multi_asset',
  'deal_type.private_credit',
];
for (const user of dataset.users) {
  const c = user.externalId;
  await record(c, '/api/v1/auth/me');
  await record(c, '/api/v1/flags');
  await record(c, '/api/v1/vehicles');
  await record(c, '/api/v1/sponsors?limit=50');
  await record(c, '/api/v1/data-health');
  await record(c, '/api/v1/data-dictionary');
  // Every grid and home combination the UI can request.
  for (const dealType of DEAL_TYPES) {
    for (const active of ['true', '']) {
      const params = new URLSearchParams();
      params.set('limit', '100');
      if (dealType) params.set('dealType', dealType);
      if (active) params.set('active', active);
      await record(c, `/api/v1/investments?${params.toString()}`);
    }
  }
  await record(c, '/api/v1/investments?active=true&limit=200');
  // Every investment detail, including the recorded 404 for the walled deal when this user is not on the wall.
  for (const inv of dataset.investments) await record(c, `/api/v1/investments/${inv.id}`);
}
await app.close();
await db.close();

const fixtures = {
  generatedFrom: 'tools/synthetic small profile, seed 42, recorded from apps/api',
  asOf: dataset.asOf,
  users: dataset.users.map((u) => ({ externalId: u.externalId, roles: u.roles })),
  responses,
};
writeFileSync(join(out, 'preview', 'fixtures.json'), JSON.stringify(fixtures));
process.stdout.write(`preview: recorded ${count} responses for ${dataset.users.length} users\n`);

const build = spawnSync(
  'pnpm',
  [
    'exec',
    'vite',
    'build',
    '--base',
    './',
    '--outDir',
    out,
    '--emptyOutDir',
    'false',
    '--manifest',
    '--sourcemap',
    'false',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, VITE_PB_PREVIEW: 'true' },
  },
);
if (build.status !== 0) process.exit(build.status ?? 1);

// Artifact fragment: the publishing host wraps the page in its own document skeleton. The asset
// names come from Vite's build manifest, not from parsing the generated HTML.
const manifest = JSON.parse(readFileSync(join(out, '.vite', 'manifest.json'), 'utf8'));
const entry = manifest['index.html'];
if (entry === undefined) throw new Error('vite manifest has no index.html entry');
const tags = [
  `<script type="module" crossorigin src="./${entry.file}"></script>`,
  ...(entry.css ?? []).map((css) => `<link rel="stylesheet" crossorigin href="./${css}">`),
];
rmSync(join(out, '.vite'), { recursive: true, force: true });
const brand = JSON.parse(
  readFileSync(new URL('../../../config/brand.json', import.meta.url), 'utf8'),
);
const fragment = [
  '<title>Portfolio Beach</title>',
  `<style>html,body,#root{min-height:100%;margin:0}body{background:${brand.colors.ui.bg};color:${brand.colors.ui.text}}</style>`,
  ...tags,
  '<div id="root"></div>',
  '',
].join('\n');
writeFileSync(join(out, 'artifact.html'), fragment);

// The bundle is build output that git never sees, so the employer-data guard scans it here.
const guard = spawnSync('bash', ['scripts/check-employer-data.sh', '--paths', resolve(out)], {
  stdio: 'inherit',
  cwd: new URL('../../../', import.meta.url).pathname,
});
if (guard.status !== 0) process.exit(guard.status ?? 1);
rmSync(scratch, { recursive: true, force: true });
process.stdout.write(
  `preview: built ${out} (index.html for local serving, artifact.html for publishing)\n`,
);
