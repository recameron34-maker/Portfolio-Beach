import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkClassification, classify, LIST_COLUMNS_SQL } from './classification.js';
import type { ColumnRef } from './classification.js';
import { createTestDb } from './testing.js';
import type { DbHandle } from './client.js';

describe('data classification (SEC-2.1)', () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createTestDb();
  });
  afterAll(async () => {
    await handle.close();
  });

  it('classifies every column in the migrated schema and has no stale entries', async () => {
    const columns = await handle.query<ColumnRef>(LIST_COLUMNS_SQL);
    const report = checkClassification(columns);
    expect(report.unclassified).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.columnCount).toBeGreaterThan(300);
  });

  it('treats history tables as their parent and metadata columns as internal', () => {
    expect(classify({ schema: 'mon', table: 'valuation', column: 'fair_value' })).toBe(
      'restricted_mnpi',
    );
    expect(classify({ schema: 'mon', table: 'valuation', column: 'row_version' })).toBe('internal');
    expect(classify({ schema: 'mon', table: 'valuation_history', column: 'row_image' })).toBe(
      'restricted_mnpi',
    );
    expect(classify({ schema: 'mon', table: 'valuation_history', column: 'actor_id' })).toBe(
      'internal',
    );
    expect(classify({ schema: 'core', table: 'portfolio_company', column: 'name' })).toBe(
      'internal',
    );
    expect(classify({ schema: 'nope', table: 'x', column: 'y' })).toBeNull();
  });

  it('reports unclassified and stale entries', () => {
    const report = checkClassification([
      { schema: 'core', table: 'mystery', column: 'id' },
      { schema: 'core', table: 'client', column: 'name' },
    ]);
    expect(report.ok).toBe(false);
    expect(report.unclassified).toEqual(['core.mystery.id']);
    expect(report.stale.length).toBeGreaterThan(10);
  });
});
