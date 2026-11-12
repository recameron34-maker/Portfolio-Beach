/**
 * pnpm --filter @pb/web map:world: writes src/pages/analytics/map/world.generated.json, the
 * world's outline the co-investment map draws (decision 0017). Run it only when the source
 * package changes; a test fails when the file and the package disagree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorld } from './lib/world.mjs';

const require = createRequire(import.meta.url);
const topology = JSON.parse(
  readFileSync(require.resolve('world-atlas/countries-110m.json'), 'utf8'),
);
const target = join(
  dirname(fileURLToPath(import.meta.url)),
  '../src/pages/analytics/map/world.generated.json',
);
const world = buildWorld(topology);
writeFileSync(target, `${JSON.stringify(world)}\n`);
const points = [...world.land, ...world.borders].reduce(
  (n, line) => n + line.split(',').length / 2,
  0,
);
console.warn(
  `build-world-map: ${world.land.length} coastlines, ${world.borders.length} borders, ${points} points`,
);
