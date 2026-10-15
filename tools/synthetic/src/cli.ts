import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountingExports } from './accounting-export.js';
import { generateDocuments } from './documents.js';
import { generateDataset } from './generate.js';
import type { GeneratedDataset } from './generate.js';
import { lookthroughExtract } from './lookthrough-extract.js';
import { opsDropWorkbooks } from './ops-drop.js';
import { verifyDataset } from './verify.js';
import { weeklyValuesSet } from './weekly-values.js';

/**
 * pnpm synth --profile default --seed 42 --out .synthetic/
 * pnpm synth:verify --in .synthetic/dataset.json
 * pnpm synth:exports --profile small --seed 42 --out .synthetic/accounting/in
 * pnpm synth:drops --profile small --seed 42 --root .synthetic/drops   (weekly, look-through and ops drop)
 * pnpm synth:documents --profile small --seed 42 --root .synthetic/documents   (the PDF inbox and its truth sidecars)
 */
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ?? fallback;
}

/** The drop folders the API reads (PB_DROP_ROOT): `weekly/in` and `lookthrough` sit under it. */
const DEFAULT_DROP_ROOT = '.synthetic/drops';
/** The document store's root (PB_DOCUMENT_ROOT): `inbox/` and `truth/` sit under it. */
const DEFAULT_DOCUMENT_ROOT = '.synthetic/documents';

function sampleDataset(): GeneratedDataset {
  return generateDataset({ profile: arg('profile', 'small'), seed: Number(arg('seed', '42')) });
}

function dropRoot(): string {
  return arg('root', process.env.PB_DROP_ROOT ?? DEFAULT_DROP_ROOT);
}

/** The three weekly values files into `<root>/weekly/in`, the folder the weekly drop reads. */
function writeWeekly(root: string, dataset: GeneratedDataset): void {
  const out = join(root, 'weekly', 'in');
  mkdirSync(out, { recursive: true });
  for (const file of weeklyValuesSet(dataset)) {
    writeFileSync(join(out, file.fileName), file.csv);
    process.stdout.write(
      `synth:weekly: wrote ${join(out, file.fileName)} (${file.expectations.rows} rows)\n`,
    );
  }
}

/** The clean extract as `<root>/lookthrough/<asOf>.json`, the defects one beside it. */
function writeLookthrough(root: string, dataset: GeneratedDataset): void {
  const out = join(root, 'lookthrough');
  mkdirSync(out, { recursive: true });
  for (const scenario of ['clean', 'defects'] as const) {
    const file = lookthroughExtract(dataset, { scenario });
    writeFileSync(join(out, file.dropName), file.json);
    process.stdout.write(
      `synth:lookthrough: wrote ${join(out, file.dropName)} (${file.expectations.rows} rows)\n`,
    );
  }
}

/** The four sample workbooks into `<root>/ops-drop/in`, the folder the ops drop reads. */
function writeOpsDrop(root: string, dataset: GeneratedDataset): void {
  const out = join(root, 'ops-drop', 'in');
  mkdirSync(out, { recursive: true });
  for (const file of opsDropWorkbooks(dataset)) {
    writeFileSync(join(out, file.fileName), file.bytes);
    process.stdout.write(
      `synth:ops-drop: wrote ${join(out, file.fileName)} (${file.expectations.rows} rows, ${file.bytes.length} bytes)\n`,
    );
  }
}

/**
 * The synthetic document set into `<root>/inbox` (every PDF) and `<root>/truth/<sha256>.json`
 * (one sidecar per distinct content; the duplicate pair shares one, which lists both names), the
 * folder tree the local document store reads (PB_DOCUMENT_ROOT). The generator computes each
 * hash itself; node:crypto recomputes it here as a cross-check before anything is written.
 */
function writeDocuments(root: string, dataset: GeneratedDataset): void {
  const inbox = join(root, 'inbox');
  const truth = join(root, 'truth');
  mkdirSync(inbox, { recursive: true });
  mkdirSync(truth, { recursive: true });
  const set = generateDocuments(dataset);
  let sidecars = 0;
  for (const document of set.documents) {
    const hash = createHash('sha256').update(document.bytes).digest('hex');
    if (hash !== document.truth.contentHash)
      throw new Error(
        `synth:documents: ${document.fileName}: the generator's hash differs from node:crypto's`,
      );
    writeFileSync(join(inbox, document.fileName), document.bytes);
    if (document.truth.fileNames[0] === document.fileName) {
      writeFileSync(join(truth, `${hash}.json`), `${JSON.stringify(document.truth, null, 2)}\n`);
      sidecars++;
    }
  }
  const counts = Object.entries(set.expectations.byDocType)
    .map(([code, n]) => `${code.replace('doc_type.', '')}=${n}`)
    .join(', ');
  process.stdout.write(
    `synth:documents: wrote ${set.expectations.total} files to ${inbox} and ${sidecars} truth sidecars to ${truth} (${counts})\n`,
  );
}

const command = process.argv[2];
if (command === 'generate') {
  const profile = arg('profile', 'default');
  const seed = Number(arg('seed', '42'));
  const out = arg('out', '.synthetic');
  const dataset = generateDataset({ profile, seed });
  const report = verifyDataset(dataset);
  if (!report.ok) {
    for (const p of report.problems) process.stderr.write(`synth: ${p}\n`);
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'dataset.json'), JSON.stringify(dataset));
  writeFileSync(
    join(out, 'manifest.json'),
    JSON.stringify(
      { profile, seed, asOf: dataset.asOf, counts: report.counts, scenarios: dataset.scenarios },
      null,
      2,
    ),
  );
  process.stdout.write(
    `synth: wrote ${join(out, 'dataset.json')} (${profile}, seed ${seed}): ${Object.entries(
      report.counts,
    )
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}\n`,
  );
} else if (command === 'verify') {
  const input = arg('in', '.synthetic/dataset.json');
  const raw: unknown = JSON.parse(readFileSync(input, 'utf8'));
  const report = verifyDataset(raw);
  for (const p of report.problems) process.stderr.write(`synth:verify: ${p}\n`);
  process.stdout.write(
    `synth:verify: ${report.ok ? 'OK' : 'FAILED'} (${Object.values(report.counts).reduce((a, b) => a + b, 0)} rows)\n`,
  );
  process.exit(report.ok ? 0 : 1);
} else if (command === 'exports') {
  // The accounting system's drop folder (the local folder adapter reads `in/`): three sample exports.
  const out = arg('out', '.synthetic/accounting/in');
  mkdirSync(out, { recursive: true });
  for (const file of accountingExports(sampleDataset())) {
    writeFileSync(join(out, file.fileName), file.csv);
    process.stdout.write(
      `synth:exports: wrote ${join(out, file.fileName)} (${file.expectations.rows} rows)\n`,
    );
  }
} else if (command === 'weekly') {
  writeWeekly(dropRoot(), sampleDataset());
} else if (command === 'lookthrough') {
  writeLookthrough(dropRoot(), sampleDataset());
} else if (command === 'ops-drop') {
  writeOpsDrop(dropRoot(), sampleDataset());
} else if (command === 'documents') {
  writeDocuments(
    arg('root', process.env.PB_DOCUMENT_ROOT ?? DEFAULT_DOCUMENT_ROOT),
    sampleDataset(),
  );
} else if (command === 'drops') {
  const dataset = sampleDataset();
  const root = dropRoot();
  writeWeekly(root, dataset);
  writeLookthrough(root, dataset);
  writeOpsDrop(root, dataset);
} else {
  process.stderr.write(
    'usage: cli.js generate [--profile p] [--seed n] [--out dir] | verify [--in file] | exports [--profile p] [--seed n] [--out dir] | weekly | lookthrough | ops-drop | drops | documents [--profile p] [--seed n] [--root dir]\n',
  );
  process.exit(2);
}
