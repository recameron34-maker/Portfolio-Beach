import { describe, expect, it } from 'vitest';
import {
  MAX_COLUMNS,
  MAX_ROWS,
  cellReference,
  columnIndex,
  columnLetters,
  decodeExcelEscapes,
  encodeExcelEscapes,
  parseCellReference,
} from './cells.js';
import { WorkbookError } from './errors.js';

describe('column letters', () => {
  it('converts both ways across the whole grid', () => {
    const cases: [number, string][] = [
      [0, 'A'],
      [25, 'Z'],
      [26, 'AA'],
      [27, 'AB'],
      [51, 'AZ'],
      [52, 'BA'],
      [701, 'ZZ'],
      [702, 'AAA'],
      [MAX_COLUMNS - 1, 'XFD'],
    ];
    for (const [index, letters] of cases) {
      expect(columnLetters(index)).toBe(letters);
      expect(columnIndex(letters)).toBe(index);
    }
    for (let i = 0; i < 2000; i += 1) expect(columnIndex(columnLetters(i))).toBe(i);
  });

  it('rejects what is outside the grid or not upper-case letters', () => {
    expect(columnIndex('XFE')).toBeNull();
    expect(columnIndex('AAAA')).toBeNull();
    expect(columnIndex('a')).toBeNull();
    expect(columnIndex('')).toBeNull();
    expect(() => columnLetters(MAX_COLUMNS)).toThrow(WorkbookError);
    expect(() => columnLetters(-1)).toThrow(WorkbookError);
  });
});

describe('cell references', () => {
  it('parses and prints A1 references, zero-based inside', () => {
    expect(parseCellReference('A1')).toEqual({ row: 0, column: 0 });
    expect(parseCellReference('C7')).toEqual({ row: 6, column: 2 });
    expect(parseCellReference(`XFD${MAX_ROWS}`)).toEqual({
      row: MAX_ROWS - 1,
      column: MAX_COLUMNS - 1,
    });
    expect(cellReference({ row: 6, column: 2 })).toBe('C7');
    expect(cellReference({ row: 0, column: 26 })).toBe('AA1');
  });

  it('refuses references Excel would not accept', () => {
    for (const bad of [
      'A0',
      'a1',
      '1A',
      'A',
      '7',
      'A01',
      `A${MAX_ROWS + 1}`,
      'XFE1',
      'A1:B2',
      ' A1',
    ]) {
      expect(parseCellReference(bad), bad).toBeNull();
    }
    expect(() => cellReference({ row: MAX_ROWS, column: 0 })).toThrow(WorkbookError);
    expect(() => cellReference({ row: 0.5, column: 0 })).toThrow(WorkbookError);
  });
});

describe('Excel escapes', () => {
  it('decodes _xHHHH_ sequences the way Excel writes them', () => {
    expect(decodeExcelEscapes('Line_x000D_break')).toBe('Line\rbreak');
    expect(decodeExcelEscapes('_x005F_x000D_')).toBe('_x000D_');
    expect(decodeExcelEscapes('_x0041_')).toBe('A');
    expect(decodeExcelEscapes('_x41_ and _xZZZZ_ stay')).toBe('_x41_ and _xZZZZ_ stay');
    expect(decodeExcelEscapes('plain')).toBe('plain');
  });

  it('encodes what XML cannot carry and protects literal escapes', () => {
    expect(encodeExcelEscapes('a\rb')).toBe('a_x000D_b');
    expect(encodeExcelEscapes('\u0001\u001f\u007f')).toBe('_x0001__x001F_\u007f');
    expect(encodeExcelEscapes('￾')).toBe('_xFFFE_');
    expect(encodeExcelEscapes('_x0041_')).toBe('_x005F_x0041_');
    expect(encodeExcelEscapes('tab\tand\nnewline')).toBe('tab\tand\nnewline');
    expect(encodeExcelEscapes('emoji \u{1F600} ok')).toBe('emoji \u{1F600} ok');
  });

  it('round-trips every encoded text and refuses a lone surrogate', () => {
    for (const text of [
      'a\rb',
      '_x0041_',
      '_x000D\r',
      '__x0041_',
      '_x0041_\r',
      '\r_x0041_',
      '_x0041_x0042_',
      '_x005F_',
      '\u0000',
      'mix _x000D_ \r \u{1F600} _x005F_x0041_',
    ]) {
      expect(decodeExcelEscapes(encodeExcelEscapes(text)), JSON.stringify(text)).toBe(text);
    }
    expect(() => encodeExcelEscapes('bad \ud800 text')).toThrow(WorkbookError);
    expect(() => encodeExcelEscapes('\udc00')).toThrow(WorkbookError);
  });
});
