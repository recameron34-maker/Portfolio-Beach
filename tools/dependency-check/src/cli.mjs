/**
 * pnpm check:licenses (decision 0016): fails when an installed package's licence is on the deny
 * list given with --deny, the same list the workflow hands GitHub's dependency review where that
 * is offered. Reads `pnpm licenses list --json`, so it needs an installed workspace and nothing
 * from the network.
 */
import { execFileSync } from 'node:child_process';
import { findings, parseDenyList } from './licenses.mjs';

const flag = process.argv.indexOf('--deny');
const denyList = parseDenyList(flag === -1 ? '' : (process.argv[flag + 1] ?? ''));
if (denyList.length === 0) {
  console.error('check-licenses: give the deny list, for example --deny GPL-2.0,GPL-3.0');
  process.exit(2);
}

const listing = JSON.parse(
  execFileSync('pnpm', ['licenses', 'list', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);
const { packages, denied, unknown } = findings(listing, denyList);
const line = (p) => `  ${p.name} ${p.versions.join(', ')}: ${p.license}`;

if (unknown.length > 0) {
  console.warn(`check-licenses: ${unknown.length} with a licence that could not be read:`);
  for (const p of unknown) console.warn(line(p));
}
if (denied.length > 0) {
  console.error(`check-licenses: ${denied.length} on the deny list (${denyList.join(', ')}):`);
  for (const p of denied) console.error(line(p));
  process.exit(1);
}
console.warn(`check-licenses: OK (${packages} packages, none on ${denyList.join(', ')})`);
