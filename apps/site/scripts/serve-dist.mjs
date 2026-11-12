// Serves the built site (apps/site/dist) on this machine, to look at it before it is hosted.
//   node scripts/serve-dist.mjs [--base /portfolio-beach/] [--port 4173]
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SITE_DIR } from './lib/preview.mjs';
import { serveStatic } from './lib/serve.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};
const dist = join(SITE_DIR, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  process.stdout.write('serve: the site is not built: run "pnpm --filter @pb/site build" first\n');
  process.exit(1);
}
const server = await serveStatic(dist, {
  base: arg('--base', '/'),
  port: Number(arg('--port', '4173')),
});
process.stdout.write(`serve: ${server.url} (Ctrl+C to stop)\n`);
