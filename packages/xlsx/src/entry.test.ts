/**
 * The main entry must bundle for the browser: no file it reaches imports a Node module, and
 * only the `@pb/xlsx/node` entry touches zlib.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as main from './index.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const sources = readdirSync(here).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('the main entry', () => {
  it('reaches no Node module and never re-exports the Node entry', () => {
    for (const file of sources.filter((f) => f !== 'node.ts')) {
      const text = readFileSync(`${here}${file}`, 'utf8');
      expect(text, file).not.toMatch(/from ['"]node:/);
      expect(text, file).not.toMatch(/require\(/);
      expect(text, file).not.toMatch(/['"]\.\/node\.js['"]/);
    }
  });

  it('exports the surface other packages rely on', () => {
    expect(Object.keys(main).sort()).toEqual([
      'MAX_CELL_TEXT_LENGTH',
      'MAX_COLUMNS',
      'MAX_ROWS',
      'MAX_SHEET_NAME_LENGTH',
      'READ_LIMITS',
      'TEMPLATE_RECORD_SEPARATOR',
      'TEMPLATE_UNIT_SEPARATOR',
      'WorkbookError',
      'cellReference',
      'columnIndex',
      'columnLetters',
      'parseCellReference',
      'readWorkbook',
      'resolvePartPath',
      'sheetNameProblem',
      'templateKey',
      'validateSheetNames',
      'writeWorkbook',
    ]);
    expect(main.READ_LIMITS).toEqual({
      maxCells: 200_000,
      maxTotalCells: 200_000,
      maxSheets: 64,
      maxDepth: 64,
      maxPartBytes: 16_777_216,
      maxTotalPartBytes: 67_108_864,
    });
    expect(Object.isFrozen(main.READ_LIMITS)).toBe(true);
  });

  it('uses no wall clock, randomness or float parsing anywhere in the package', () => {
    for (const file of sources) {
      const text = readFileSync(`${here}${file}`, 'utf8');
      expect(text, file).not.toMatch(/new Date\(|Date\.now\(|Math\.random\(|parseFloat\(|Number\(/);
    }
  });
});
