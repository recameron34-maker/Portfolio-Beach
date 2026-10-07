import { createDb } from '../client.js';
import { checkClassification, LIST_COLUMNS_SQL } from '../classification.js';
import type { ColumnRef } from '../classification.js';
import { migrate } from '../migrate.js';

/** CI gate for SEC-2.1: every column in the migrated schema must have a data classification. */
const handle = await createDb({ kind: 'pglite' });
await migrate(handle);
const columns = await handle.query<ColumnRef>(LIST_COLUMNS_SQL);
const report = checkClassification(columns);
await handle.close();
if (!report.ok) {
  for (const c of report.unclassified) process.stderr.write(`unclassified column: ${c}\n`);
  for (const s of report.stale) process.stderr.write(`stale registry entry: ${s}\n`);
  process.exit(1);
}
process.stdout.write(`check:classification: OK (${report.columnCount} columns classified)\n`);
