import { describe, expect, it } from 'vitest';
import { WorkbookError } from './errors.js';
import type { Workbook } from './read.js';
import { TEMPLATE_RECORD_SEPARATOR, TEMPLATE_UNIT_SEPARATOR, templateKey } from './template.js';

const workbook: Workbook = {
  sheets: [
    {
      name: 'Positions',
      rows: [
        ['Investment', 'Value', ''],
        ['INV-001', '10', ''],
      ],
    },
    { name: 'Notes', rows: [] },
    { name: 'Lookups', rows: [['Code']] },
  ],
};

describe('templateKey', () => {
  it('joins the sheet names and the header row with the record and unit separators', () => {
    const key = templateKey(workbook, 'Positions');
    expect(key.sheets).toEqual(['Positions', 'Notes', 'Lookups']);
    expect(key.header).toEqual(['Investment', 'Value']);
    expect(key.canonical).toBe('Positions\u001eNotes\u001eLookups\u001fInvestment\u001fValue');
    expect(TEMPLATE_RECORD_SEPARATOR).toBe('\u001e');
    expect(TEMPLATE_UNIT_SEPARATOR).toBe('\u001f');
  });

  it('drops trailing empty header cells, so one Excel template gives one signature', () => {
    const trimmed: Workbook = {
      sheets: [{ name: 'Positions', rows: [['Investment', 'Value']] }],
    };
    const padded: Workbook = {
      sheets: [{ name: 'Positions', rows: [['Investment', 'Value', '', '', '']] }],
    };
    expect(templateKey(padded, 'Positions')).toEqual(templateKey(trimmed, 'Positions'));
    expect(templateKey(padded, 'Positions').header).toEqual(['Investment', 'Value']);
    const inner: Workbook = {
      sheets: [{ name: 'Positions', rows: [['Investment', '', 'Value', '']] }],
    };
    expect(templateKey(inner, 'Positions').header).toEqual(['Investment', '', 'Value']);
    expect(templateKey(inner, 'Positions').canonical).toBe(
      'Positions\u001fInvestment\u001f\u001fValue',
    );
    const blank: Workbook = { sheets: [{ name: 'Positions', rows: [['', '']] }] };
    expect(templateKey(blank, 'Positions').header).toEqual([]);
    expect(templateKey(blank, 'Positions').canonical).toBe('Positions\u001f');
    expect(padded.sheets[0]?.rows[0]).toEqual(['Investment', 'Value', '', '', '']);
  });

  it('gives an empty header for a sheet with no rows, and a copy the caller may change', () => {
    const key = templateKey(workbook, 'Notes');
    expect(key.header).toEqual([]);
    expect(key.canonical).toBe('Positions\u001eNotes\u001eLookups\u001f');
    key.header.push('x');
    key.sheets.pop();
    expect(workbook.sheets[1]?.rows).toEqual([]);
    expect(workbook.sheets).toHaveLength(3);
  });

  it('tells a different sheet list or a different header apart', () => {
    const renamed: Workbook = { sheets: [workbook.sheets[0]!, { name: 'Other', rows: [] }] };
    expect(templateKey(renamed, 'Positions').canonical).not.toBe(
      templateKey(workbook, 'Positions').canonical,
    );
    const reordered: Workbook = {
      sheets: [workbook.sheets[1]!, workbook.sheets[0]!, workbook.sheets[2]!],
    };
    expect(templateKey(reordered, 'Positions').canonical).not.toBe(
      templateKey(workbook, 'Positions').canonical,
    );
    expect(templateKey(workbook, 'Lookups').canonical).not.toBe(
      templateKey(workbook, 'Positions').canonical,
    );
  });

  it('refuses a header sheet the workbook does not have', () => {
    expect(() => templateKey(workbook, 'positions')).toThrow(WorkbookError);
    try {
      templateKey(workbook, 'Missing');
    } catch (error) {
      expect((error as WorkbookError).code).toBe('missing_part');
      expect((error as WorkbookError).message).toBe('The workbook has no sheet named Missing');
    }
  });
});
