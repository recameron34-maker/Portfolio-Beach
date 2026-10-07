import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildOpenApi } from '@pb/contracts';

/** pnpm openapi:generate: writes the OpenAPI 3.1 document from the shared contracts (docs/17 section 3). */
const out = process.argv[2] ?? 'openapi.json';
const doc = buildOpenApi(process.env.PB_VERSION ?? '0.1.0');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
process.stdout.write(`openapi:generate: wrote ${out} (${Object.keys(doc.paths).length} paths)\n`);
