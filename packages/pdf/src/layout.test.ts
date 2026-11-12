import { describe, expect, it } from 'vitest';
import type { TextRun } from './content.js';
import { BASELINE_TOLERANCE, buildLines } from './layout.js';

const run = (x: number, y: number, text: string, over: Partial<TextRun> = {}): TextRun => ({
  x,
  y,
  width: text.length * 6,
  size: 12,
  font: 'Helvetica',
  text,
  ...over,
});

describe('buildLines', () => {
  it('groups runs by baseline within the tolerance and orders lines top to bottom', () => {
    const lines = buildLines([
      run(72, 700, 'Bottom', { y: 600 }),
      run(72, 700, 'Top'),
      run(200, 701.5, 'line'),
      run(72, 650, 'Middle'),
    ]);
    expect(lines).toEqual([
      { y: 700, text: 'Top line' },
      { y: 650, text: 'Middle' },
      { y: 600, text: 'Bottom' },
    ]);
  });

  it('starts a new line when the baseline differs by more than the tolerance', () => {
    const lines = buildLines([
      run(72, 700, 'a'),
      run(100, 700 - BASELINE_TOLERANCE, 'b'),
      run(72, 700 - BASELINE_TOLERANCE - 0.01, 'c'),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['a b', 'c']);
  });

  it('orders the runs of a line left to right whatever their drawing order', () => {
    const lines = buildLines([run(200, 700, 'world'), run(72, 700, 'hello')]);
    expect(lines).toEqual([{ y: 700, text: 'hello world' }]);
  });

  it('inserts a space only when the gap exceeds a third of the font size', () => {
    const touching = buildLines([run(72, 700, 'ab'), run(84, 700, 'cd')]);
    expect(touching[0]?.text).toBe('abcd');
    const kerned = buildLines([run(72, 700, 'ab'), run(88, 700, 'cd')]);
    expect(kerned[0]?.text).toBe('abcd');
    const exact = buildLines([run(72, 700, 'ab'), run(88.00001, 700, 'cd')]);
    expect(exact[0]?.text).toBe('ab cd');
    const spaced = buildLines([run(72, 700, 'ab'), run(100, 700, 'cd')]);
    expect(spaced[0]?.text).toBe('ab cd');
    const bigger = buildLines([run(72, 700, 'ab'), run(90, 700, 'cd', { size: 60 })]);
    expect(bigger[0]?.text).toBe('abcd');
  });

  it('does not double a space the text already carries', () => {
    expect(buildLines([run(72, 700, 'ab '), run(100, 700, 'cd')])[0]?.text).toBe('ab cd');
    expect(buildLines([run(72, 700, 'ab'), run(100, 700, ' cd')])[0]?.text).toBe('ab cd');
  });

  it('keeps undecodable runs in place without text and without a stray space', () => {
    const lines = buildLines([
      run(72, 700, 'ab'),
      run(84, 700, '', { undecodable: true, width: 30 }),
      run(114, 700, 'cd'),
    ]);
    expect(lines).toEqual([{ y: 700, text: 'abcd' }]);
    const only = buildLines([run(72, 700, '', { undecodable: true })]);
    expect(only).toEqual([{ y: 700, text: '' }]);
    const leading = buildLines([
      run(72, 700, '', { undecodable: true, width: 0 }),
      run(120, 700, 'cd'),
    ]);
    expect(leading[0]?.text).toBe('cd');
  });

  it('returns no lines for no runs', () => {
    expect(buildLines([])).toEqual([]);
  });
});
