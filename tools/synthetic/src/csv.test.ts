import { describe, expect, it } from 'vitest';
import { csvCell, csvText } from './csv.js';

describe('the CSV the sample drops are written in', () => {
  it('quotes only a cell that needs it, doubling its quotes', () => {
    expect(csvCell('INV-0001')).toBe('INV-0001');
    expect(csvCell('')).toBe('');
    expect(csvCell('Harbor, Example')).toBe('"Harbor, Example"');
    expect(csvCell('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('writes the header, every row in order, and a line feed after the last line', () => {
    expect(
      csvText(
        ['A', 'B'],
        [
          ['1', 'x,y'],
          ['2', ''],
        ],
      ),
    ).toBe('A,B\n1,"x,y"\n2,\n');
    expect(csvText(['A'], [])).toBe('A\n');
  });
});
