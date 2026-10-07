import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDataset } from './generate.js';
import { verifyDataset } from './verify.js';

/**
 * pnpm synth --profile default --seed 42 --out .synthetic/
 * pnpm synth:verify --in .synthetic/dataset.json
 */
function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ?? fallback;
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
} else {
  process.stderr.write(
    'usage: cli.js generate [--profile p] [--seed n] [--out dir] | verify [--in file]\n',
  );
  process.exit(2);
}
