import { describe, expect, it } from 'vitest';
import { readWorkbook } from '@pb/xlsx';
import { nodeInflateRaw } from '@pb/xlsx/node';
import { accountingExport } from './accounting-export.js';
import { generateDataset } from './generate.js';
import {
  OPS_DROP_FIGURES_HEADER,
  OPS_DROP_NOTES_PREPARED_BY,
  OPS_DROP_SCENARIOS,
  OPS_DROP_SHEET_NAMES,
  OPS_DROP_TEMPLATE,
  OPS_DROP_UNKNOWN_HEADER_CELL,
  opsDropSamples,
  opsDropSheets,
  opsDropWorkbook,
  opsDropWorkbooks,
} from './ops-drop.js';

const small = generateDataset({ profile: 'small', seed: 42 });

describe('the synthetic ops-drop workbook sheets (docs/04 M2 ops-drop-import)', () => {
  it('writes the Figures sheet under the template header with the accounting export rows', () => {
    const clean = opsDropSheets(small);
    const exported = accountingExport(small);
    expect(clean.scenario).toBe('clean');
    expect(clean.template).toBe(OPS_DROP_TEMPLATE);
    expect(clean.fileName).toBe('ops-drop-2025-06-30-clean.xlsx');
    expect(clean.periodEnd).toBe('2025-06-30');
    expect(clean.sheets.map((s) => s.name)).toEqual([...OPS_DROP_SHEET_NAMES]);
    const [figures, notes] = clean.sheets;
    expect(figures?.rows[0]).toEqual([
      'Investment number',
      'Company',
      'Period end',
      'Revenue LTM',
      'EBITDA LTM',
      'Enterprise value',
      'Net debt',
      'Fair value',
    ]);
    expect(figures?.rows[0]).toEqual(OPS_DROP_FIGURES_HEADER);
    expect(figures?.rows.slice(1)).toEqual(exported.rows);
    expect(figures?.rows).toHaveLength(exported.expectations.rows + 1);
    expect(notes?.rows).toEqual([[OPS_DROP_NOTES_PREPARED_BY], ['2025-06-30']]);
    for (const sheet of clean.sheets)
      for (const row of sheet.rows) for (const cell of row) expect(typeof cell).toBe('string');
    expect(clean.expectations).toEqual({ ...exported.expectations, refused: false });
  });

  it('reuses the accounting export scenarios and their expectations', () => {
    for (const scenario of ['update', 'defects'] as const) {
      const sample = opsDropSheets(small, { scenario });
      const exported = accountingExport(small, { scenario });
      expect(sample.fileName).toBe(`ops-drop-2025-06-30-${scenario}.xlsx`);
      expect(sample.sheets[0]?.rows.slice(1)).toEqual(exported.rows);
      expect(sample.expectations).toEqual({ ...exported.expectations, refused: false });
    }
    expect(opsDropSheets(small, { scenario: 'defects' }).sheets[0]?.rows.length).toBeGreaterThan(
      opsDropSheets(small).sheets[0]?.rows.length ?? 0,
    );
  });

  it('passes the period end through to the export and the Notes sheet', () => {
    const earlier = opsDropSheets(small, { periodEnd: '2025-03-31' });
    expect(earlier.periodEnd).toBe('2025-03-31');
    expect(earlier.fileName).toBe('ops-drop-2025-03-31-clean.xlsx');
    expect(earlier.sheets[1]?.rows[1]).toEqual(['2025-03-31']);
    expect(earlier.sheets[0]?.rows.slice(1)).toEqual(
      accountingExport(small, { periodEnd: '2025-03-31' }).rows,
    );
  });

  it('unknown-template renames one header cell so the import refuses the workbook', () => {
    const unknown = opsDropSheets(small, { scenario: 'unknown-template' });
    const clean = opsDropSheets(small);
    expect(unknown.template).toBeNull();
    expect(unknown.fileName).toBe('ops-drop-2025-06-30-unknown-template.xlsx');
    const header = unknown.sheets[0]?.rows[0] ?? [];
    expect(header).toHaveLength(OPS_DROP_FIGURES_HEADER.length);
    const differing = header.filter((cell, i) => cell !== OPS_DROP_FIGURES_HEADER[i]);
    expect(differing).toEqual([OPS_DROP_UNKNOWN_HEADER_CELL.renamed]);
    expect(header[OPS_DROP_FIGURES_HEADER.indexOf(OPS_DROP_UNKNOWN_HEADER_CELL.name)]).toBe(
      'Revenue (LTM)',
    );
    expect(unknown.sheets.map((s) => s.name)).toEqual([...OPS_DROP_SHEET_NAMES]);
    expect(unknown.sheets[0]?.rows.slice(1)).toEqual(clean.sheets[0]?.rows.slice(1));
    expect(unknown.sheets[1]).toEqual(clean.sheets[1]);
    expect(unknown.expectations).toEqual({ ...clean.expectations, refused: true });
  });

  it('is deterministic and ships four samples with distinct names', () => {
    expect(JSON.stringify(opsDropSheets(small, { scenario: 'defects' }))).toBe(
      JSON.stringify(opsDropSheets(small, { scenario: 'defects' })),
    );
    const samples = opsDropSamples(small);
    expect(samples.map((s) => s.scenario)).toEqual([
      'clean',
      'update',
      'defects',
      'unknown-template',
    ]);
    expect(samples.map((s) => s.scenario)).toEqual([...OPS_DROP_SCENARIOS]);
    expect(new Set(samples.map((s) => s.fileName)).size).toBe(4);
    expect(samples.filter((s) => s.expectations.refused).map((s) => s.scenario)).toEqual([
      'unknown-template',
    ]);
  });
});

describe('the synthetic ops-drop workbook files', () => {
  const read = (bytes: Uint8Array) => readWorkbook(bytes, { inflateRaw: nodeInflateRaw });

  it('writes the sheets as an .xlsx whose bytes are stable for a seed and differ by seed', () => {
    const first = opsDropWorkbook(small, { scenario: 'defects' });
    const again = opsDropWorkbook(small, { scenario: 'defects' });
    expect(first.fileName).toBe('ops-drop-2025-06-30-defects.xlsx');
    expect(first.template).toBe(OPS_DROP_TEMPLATE);
    expect(first.periodEnd).toBe('2025-06-30');
    expect(first.bytes.length).toBeGreaterThan(0);
    expect(Buffer.from(first.bytes).equals(Buffer.from(again.bytes))).toBe(true);
    expect(first.expectations).toEqual(opsDropSheets(small, { scenario: 'defects' }).expectations);
    // A zip archive starts with the local file header signature, so the file opens as an .xlsx.
    expect([...first.bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const other = opsDropWorkbook(generateDataset({ profile: 'small', seed: 7 }), {
      scenario: 'defects',
    });
    expect(Buffer.from(other.bytes).equals(Buffer.from(first.bytes))).toBe(false);
  });

  it('reads back exactly the sheets it was written from, every cell as text', async () => {
    for (const scenario of OPS_DROP_SCENARIOS) {
      const sample = opsDropSheets(small, { scenario });
      const workbook = await read(opsDropWorkbook(small, { scenario }).bytes);
      expect(workbook.sheets, scenario).toEqual(sample.sheets);
    }
  });

  it('writes the unknown-template workbook with a Figures header that differs in one cell', async () => {
    const known = await read(opsDropWorkbook(small).bytes);
    const unknown = await read(opsDropWorkbook(small, { scenario: 'unknown-template' }).bytes);
    expect(unknown.sheets.map((s) => s.name)).toEqual(known.sheets.map((s) => s.name));
    const knownHeader = known.sheets[0]?.rows[0] ?? [];
    const unknownHeader = unknown.sheets[0]?.rows[0] ?? [];
    expect(knownHeader).toEqual(OPS_DROP_FIGURES_HEADER);
    const differing = unknownHeader
      .map((cell, i) => (cell === knownHeader[i] ? null : cell))
      .filter((cell) => cell !== null);
    expect(differing).toEqual([OPS_DROP_UNKNOWN_HEADER_CELL.renamed]);
    expect(unknown.sheets[0]?.rows.slice(1)).toEqual(known.sheets[0]?.rows.slice(1));
  });

  it('ships the four workbooks under their distinct names', () => {
    const files = opsDropWorkbooks(small);
    expect(files.map((f) => f.fileName)).toEqual([
      'ops-drop-2025-06-30-clean.xlsx',
      'ops-drop-2025-06-30-update.xlsx',
      'ops-drop-2025-06-30-defects.xlsx',
      'ops-drop-2025-06-30-unknown-template.xlsx',
    ]);
    expect(files.map((f) => f.template)).toEqual([
      OPS_DROP_TEMPLATE,
      OPS_DROP_TEMPLATE,
      OPS_DROP_TEMPLATE,
      null,
    ]);
    expect(new Set(files.map((f) => Buffer.from(f.bytes).toString('base64'))).size).toBe(4);
  });
});
