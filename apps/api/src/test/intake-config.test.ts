import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEMPLATE_HEADER_SEPARATOR } from '@pb/contracts';
import { accountingLayout } from '@pb/validation';
import { createTestDb } from '@pb/db/testing';
import type { DbHandle } from '@pb/db';
import { loadConfig } from '../config.js';
import { dropFolders, loadLookthroughMapping, loadOpsDropTemplates } from '../composition.js';
import { LOOKTHROUGH_MAPPING, OPS_DROP_TEMPLATES } from '../common/tokens.js';

const CONFIG_DIR = new URL('../../../../config/', import.meta.url).pathname;

/** A config folder in scratch space holding one file with the given content. */
function configDirWith(fileName: string, content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'pb-config-'));
  writeFileSync(join(dir, fileName), JSON.stringify(content));
  return dir;
}

describe('the intake config files (rule 9: config over code)', () => {
  let db: DbHandle;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('maps every taxonomy sector and geography to at least one provider label, and leaves Other unmapped', async () => {
    const mapping = loadLookthroughMapping(CONFIG_DIR);
    const terms = await db.query<{ domain: string; code: string }>(
      "select domain, code from core.taxonomy_term where domain in ('sector', 'geography') and active order by code",
    );
    const mappedSectors = new Set(Object.values(mapping.sector));
    const mappedGeographies = new Set(Object.values(mapping.geography));
    for (const term of terms) {
      const mapped = term.domain === 'sector' ? mappedSectors : mappedGeographies;
      expect(mapped.has(term.code), term.code).toBe(true);
    }
    // Every code the mapping names exists in the taxonomy; the mapping never adds to it.
    const codes = new Set(terms.map((t) => t.code));
    for (const code of [...mappedSectors, ...mappedGeographies])
      expect(codes.has(code), code).toBe(true);
    // The provider's "Other" is deliberately unmapped so the reconcile has something to flag.
    expect(mapping.sector.Other).toBeUndefined();
    expect(mapping.geography.Other).toBeUndefined();
    expect(mapping.sector.Technology).toBe('sector.software');
    expect(mapping.geography['Rest of World']).toBe('geography.other');
  });

  it('describes the quarterly-figures template with a header hash that matches its header cells', () => {
    const templates = loadOpsDropTemplates(CONFIG_DIR);
    const template = templates.templates.find((t) => t.name === 'quarterly-figures');
    expect(template).toBeDefined();
    expect(template?.sheets).toEqual(['Figures', 'Notes']);
    expect(template?.headerSheet).toBe('Figures');
    const hash = createHash('sha256')
      .update(template!.header.join(TEMPLATE_HEADER_SEPARATOR))
      .digest('hex');
    expect(template?.headerHash).toBe(hash);
    // Every header cell maps onto a column of the accounting layout, so a matched workbook stages
    // through the accounting import; the key columns are among them.
    const layout = accountingLayout.parse(
      JSON.parse(readFileSync(join(CONFIG_DIR, 'accounting_layout.json'), 'utf8')),
    );
    const layoutColumns = new Set(layout.export.columns.map((c) => c.name));
    for (const cell of template!.header) {
      const column = template!.columns[cell];
      expect(column, cell).toBeDefined();
      expect(layoutColumns.has(column!), `${cell} -> ${column}`).toBe(true);
    }
    for (const key of layout.import.keyColumns)
      expect(Object.values(template!.columns)).toContain(key);
  });

  it('refuses a missing or malformed config file at startup, naming the path and never a value', () => {
    expect(() => loadLookthroughMapping(mkdtempSync(join(tmpdir(), 'pb-config-')))).toThrow(
      /missing: lookthrough_mapping.json/,
    );
    const marker = 'MARKER-NEVER-ECHOED-0010';
    let message = '';
    try {
      loadLookthroughMapping(
        configDirWith('lookthrough_mapping.json', {
          sector: { Technology: `geography.${marker}` },
          geography: {},
        }),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('not valid (lookthrough_mapping.json)');
    expect(message).toContain('sector.Technology');
    expect(message).not.toContain(marker);
    expect(() =>
      loadOpsDropTemplates(
        configDirWith('ops_drop_templates.json', {
          templates: [
            {
              name: 'quarterly-figures',
              sheets: ['Figures'],
              headerSheet: 'Summary',
              header: ['Investment number'],
              headerHash: 'a'.repeat(64),
              columns: { 'Investment number': 'InvestmentNumber' },
            },
          ],
        }),
      ),
    ).toThrow(/templates\.0\.headerSheet/);
  });

  it('reads the drop root from the environment with the synthetic default, and names its three folders', () => {
    expect(loadConfig({}).PB_DROP_ROOT).toBe('.synthetic/drops');
    expect(loadConfig({ PB_DROP_ROOT: '/srv/drops' }).PB_DROP_ROOT).toBe('/srv/drops');
    expect(dropFolders('/srv/drops')).toEqual({
      weekly: '/srv/drops/weekly',
      opsDrop: '/srv/drops/ops-drop',
      lookthrough: '/srv/drops/lookthrough',
    });
    expect(LOOKTHROUGH_MAPPING).not.toBe(OPS_DROP_TEMPLATES);
  });
});
