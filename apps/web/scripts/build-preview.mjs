// Builds a self-contained static preview: records every API response the pages can request (the
// plan in scripts/preview-plan.mjs) from the real API over the small synthetic dataset, then bundles
// the app in preview mode with relative asset paths. Output: dist-preview/ (index.html for local
// serving, artifact.html fragment for publishing).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDataset } from '@pb/synthetic';
import { createDb, loadSyntheticDataset, migrate } from '@pb/db';
import { FixedClock } from '@pb/adapters';
import { buildRuntime } from '../../api/dist/composition.js';
import { createApp } from '../../api/dist/app.js';
import { loadConfig } from '../../api/dist/config.js';
import { buildPlan, dealTypeCodes, keyFor } from './preview-plan.mjs';

/** The recordings stay well inside the hosted page limit (16 MB for the page and each file). */
const MAX_FIXTURE_BYTES = 8 * 1024 * 1024;
/** Text only the preview simulation contains; none of it may reach the entry chunk or a production build. */
const SIMULATION_MARKERS = ['x-pb-simulated', '__pbPreviewMisses', 'outside the recorded preview'];
/** Precondition messages of the transition tables in @pb/workflows. */
const TABLE_MARKERS = [
  'the preparer cannot approve their own valuation',
  'the wire instruction is not verified',
];

const out = process.env.PB_PREVIEW_OUT ?? 'dist-preview';
const scratch = join(out, '.scratch');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'preview'), { recursive: true });
mkdirSync(scratch, { recursive: true });
const started = Date.now();

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
  PB_CONFIG_DIR: fileURLToPath(new URL('../../../config/', import.meta.url)),
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

const get = (credential, path) =>
  fetch(new URL(path, base), {
    headers: credential ? { authorization: `Bearer ${credential}` } : {},
  });

// Content-addressed bodies: each distinct body is stored once under the first 16 hex digits of its
// SHA-256; every key points at its hash.
const bodies = {};
const responses = {};
const families = new Map();
async function record(credential, path, family) {
  const res = await get(credential, path);
  const text = await res.text();
  // Problem bodies carry a fresh request id per run; pin it so the recordings are byte-stable.
  const body = res.ok ? text : text.replace(/"request_id":"[^"]*"/, '"request_id":"preview"');
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  if (bodies[hash] !== undefined && bodies[hash] !== body)
    throw new Error(`two recorded bodies share the hash ${hash}`);
  bodies[hash] = body;
  responses[keyFor(credential, 'GET', path)] = {
    status: res.status,
    contentType: res.headers.get('content-type') ?? 'application/json',
    body: hash,
  };
  const stats = families.get(family) ?? { requests: 0, statuses: new Map() };
  stats.requests += 1;
  stats.statuses.set(res.status, (stats.statuses.get(res.status) ?? 0) + 1);
  families.set(family, stats);
}

async function recordFamilies(plan, first) {
  for (const user of dataset.users) {
    for (const family of plan.families) {
      if ((family.recordFirst === true) !== first) continue;
      for (const path of family.paths) await record(user.externalId, path, family.name);
    }
  }
}

// The audit trail first, before any audited read (see the header of preview-plan.mjs); those
// families need no deal-type codes.
await recordFamilies(buildPlan(dataset, { dealTypes: [] }), true);
// The deal-type codes the investment filters can send come from the seeded taxonomy.
const taxonomy = await get(dataset.users[0].externalId, '/api/v1/taxonomy');
if (!taxonomy.ok)
  throw new Error(`taxonomy answered ${taxonomy.status}; cannot plan the recordings`);
const plan = buildPlan(dataset, { dealTypes: dealTypeCodes(await taxonomy.json()) });
for (const path of plan.public) await record('', path, 'public');
await recordFamilies(plan, false);
await app.close();
await db.close();

const fixtures = {
  generatedFrom: 'tools/synthetic small profile, seed 42, recorded from apps/api',
  asOf: dataset.asOf,
  users: dataset.users.map((u) => ({
    externalId: u.externalId,
    roles: u.roles,
    userId: u.id,
    displayName: u.displayName,
  })),
  bodies,
  responses,
};
const fixturesJson = JSON.stringify(fixtures);
const fixtureBytes = Buffer.byteLength(fixturesJson);
writeFileSync(join(out, 'preview', 'fixtures.json'), fixturesJson);
for (const [name, stats] of families) {
  const statuses = [...stats.statuses]
    .sort(([a], [b]) => a - b)
    .map(([status, n]) => `${status} x ${n}`)
    .join(', ');
  process.stdout.write(`preview: ${name}: ${stats.requests} requests (${statuses})\n`);
}
process.stdout.write(
  `preview: recorded ${Object.keys(responses).length} keys, ${Object.keys(bodies).length} distinct bodies, ` +
    `fixtures.json ${fixtureBytes} bytes, for ${dataset.users.length} users in ${Math.round((Date.now() - started) / 1000)} s\n`,
);
if (fixtureBytes > MAX_FIXTURE_BYTES) {
  process.stderr.write(
    `preview: fixtures.json is ${fixtureBytes} bytes, over the ${MAX_FIXTURE_BYTES} byte budget\n`,
  );
  process.exit(1);
}

function viteBuild(outDir, preview) {
  const env = { ...process.env };
  if (preview) env.VITE_PB_PREVIEW = 'true';
  else delete env.VITE_PB_PREVIEW;
  const args = ['exec', 'vite', 'build', '--outDir', outDir, '--sourcemap', 'false'];
  if (preview) args.push('--base', './', '--emptyOutDir', 'false', '--manifest');
  else args.push('--emptyOutDir', '--logLevel', 'warn');
  const build = spawnSync('pnpm', args, { stdio: 'inherit', env });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

viteBuild(out, true);

// Artifact fragment: the publishing host wraps the page in its own document skeleton. The asset
// names come from Vite's build manifest, not from parsing the generated HTML.
const manifest = JSON.parse(readFileSync(join(out, '.vite', 'manifest.json'), 'utf8'));
const entry = manifest['index.html'];
if (entry === undefined) throw new Error('vite manifest has no index.html entry');
const shimChunk = manifest['src/preview/shim.ts'];
if (shimChunk === undefined || !shimChunk.isDynamicEntry)
  throw new Error('vite manifest has no dynamically imported preview shim chunk');
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

// The simulation must live only in the shim chunk, which the app imports dynamically in preview
// builds alone; a production build must carry none of it.
const read = (file) => readFileSync(join(out, file), 'utf8');
const entryCode = read(entry.file);
const shimCode = read(shimChunk.file);
const leaked = SIMULATION_MARKERS.filter((m) => entryCode.includes(m));
const missing = SIMULATION_MARKERS.filter((m) => !shimCode.includes(m));
if (leaked.length > 0 || missing.length > 0) {
  process.stderr.write(
    `preview: simulation code outside the shim chunk (${leaked.join(', ') || 'none'}) or missing from it (${missing.join(', ') || 'none'})\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `preview: shim chunk ${shimChunk.file} ${Buffer.byteLength(shimCode)} bytes; entry chunk carries no simulation code\n`,
);
// Where the bundler put the transition tables of @pb/workflows. They join the entry chunk when app
// code imports the package (statically, through its barrel); informational, not a failure.
const tablesIn = (code) => TABLE_MARKERS.some((m) => code.includes(m));
process.stdout.write(
  `preview: workflow transition tables in ${
    [tablesIn(entryCode) ? 'the entry chunk' : '', tablesIn(shimCode) ? 'the shim chunk' : '']
      .filter(Boolean)
      .join(' and ') || 'no chunk'
  }\n`,
);

const production = join(scratch, 'production');
viteBuild(production, false);
const productionCode = readdirSync(join(production, 'assets'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(join(production, 'assets', f), 'utf8'))
  .join('\n');
const inProduction = SIMULATION_MARKERS.filter((m) => productionCode.includes(m));
if (inProduction.length > 0) {
  process.stderr.write(
    `preview: the production build carries simulation code (${inProduction.join(', ')})\n`,
  );
  process.exit(1);
}
const tables = TABLE_MARKERS.filter((m) => productionCode.includes(m));
process.stdout.write(
  tables.length === 0
    ? 'preview: production build checked: no simulation code and no workflow transition table\n'
    : 'preview: production build checked: no simulation code; it carries the workflow transition tables because app code imports them\n',
);
rmSync(production, { recursive: true, force: true });

// The bundle is build output that git never sees, so the employer-data guard scans it here.
const guard = spawnSync('bash', ['scripts/check-employer-data.sh', '--paths', resolve(out)], {
  stdio: 'inherit',
  cwd: fileURLToPath(new URL('../../../', import.meta.url)),
});
if (guard.status !== 0) process.exit(guard.status ?? 1);
rmSync(scratch, { recursive: true, force: true });
process.stdout.write(
  `preview: built ${out} (index.html for local serving, artifact.html for publishing)\n`,
);
