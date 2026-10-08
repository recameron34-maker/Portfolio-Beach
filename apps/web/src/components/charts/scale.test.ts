import { describe, expect, it } from 'vitest';
import {
  compactValue,
  labelBudget,
  labelColumn,
  labelStride,
  niceStep,
  niceTicks,
  truncateMiddle,
  valueLabelPosition,
} from './scale.js';

describe('chart scales', () => {
  it('picks 1, 2, 5 steps', () => {
    expect(niceStep(100, 5)).toBe(20);
    expect(niceStep(7, 5)).toBe(1);
    expect(niceStep(55, 4)).toBe(10);
    expect(niceStep(0.3, 4)).toBe(0.1);
  });
  it('covers the data range with a zero baseline', () => {
    expect(niceTicks(12, 87, 4)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(-15, 40, 4)).toEqual([-20, -10, 0, 10, 20, 30, 40]);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
    expect(niceTicks(0.11, 0.19, 4, false)).toEqual([0.1, 0.12, 0.14, 0.16, 0.18, 0.2]);
  });
  it('formats compact axis labels', () => {
    expect(compactValue(41_000_000, 'money')).toBe('$41M');
    expect(compactValue(4_150_000, 'money')).toBe('$4.2M');
    expect(compactValue(850_000, 'money')).toBe('$850K');
    expect(compactValue(-2_500_000, 'money')).toBe('-$2.5M');
    expect(compactValue(0.121, 'pct')).toBe('12%');
    expect(compactValue(0.025, 'pct')).toBe('2.5%');
    expect(compactValue(1.4, 'multiple')).toBe('1.4x');
    expect(compactValue(12345, 'count')).toBe('12,345');
  });
});

describe('category labels', () => {
  it('gives the label column about 36 percent of the chart, between 96 and 220 pixels', () => {
    expect(labelColumn(316)).toBe(114);
    expect(labelColumn(450)).toBe(162);
    expect(labelColumn(200)).toBe(96);
    expect(labelColumn(1000)).toBe(220);
  });

  it('fits about one character per 6.6 pixels of the column, after the gap', () => {
    expect(labelBudget(96)).toBe(12);
    expect(labelBudget(114)).toBe(15);
    expect(labelBudget(162)).toBe(22);
    expect(labelBudget(220)).toBe(31);
    expect(labelBudget(10)).toBe(5);
  });

  it('cuts the middle so funds that share a long start stay apart', () => {
    expect(truncateMiddle('Beach Co-Invest Fund II', 15)).toBe('Beach...Fund II');
    expect(truncateMiddle('Beach Co-Invest Fund III', 15)).toBe('Beac...Fund III');
    expect(truncateMiddle('Beach Co-Invest Fund II', 22)).toBe('Beach Co-Inv...Fund II');
    expect(truncateMiddle('Beach Co-Invest Fund III', 22)).toBe('Beach Co-In...Fund III');
    expect(truncateMiddle('Silverline Staffing Holdings', 22)).toBe('Silverline...Holdings');
    expect(truncateMiddle('Supercalifragilistic', 10)).toBe('Sup...stic');
    expect(truncateMiddle('Short', 15)).toBe('Short');
    expect(truncateMiddle('Beach Co-Invest Fund II', 23)).toBe('Beach Co-Invest Fund II');
  });

  it('never runs past its budget and always keeps the last character', () => {
    const labels = [
      'Beach Co-Invest Fund III',
      'Kelpwood Capital Partners Fund IV',
      'North America',
      'A B C D E F G H I J K',
      'Unbrokenlonglabelwithoutanyspaces',
    ];
    for (const label of labels) {
      for (let max = 4; max <= 36; max += 1) {
        const short = truncateMiddle(label, max);
        expect(short.length, `${label} at ${max}`).toBeLessThanOrEqual(max);
        if (label.length <= max) expect(short).toBe(label);
        else expect(short.endsWith(label.slice(-1)), `${label} at ${max}`).toBe(true);
      }
    }
  });

  it('keeps a value label inside the chart, reading back from the edge when it would spill', () => {
    expect(valueLabelPosition(100, 316)).toEqual({ x: 106, anchor: 'start' });
    expect(valueLabelPosition(306, 316)).toEqual({ x: 312, anchor: 'start' });
    expect(valueLabelPosition(315, 316)).toEqual({ x: 312, anchor: 'end' });
  });
});

describe('labelStride', () => {
  it('labels every tick when there is room and thins them in a narrow card', () => {
    expect(labelStride(4, 600)).toBe(1);
    expect(labelStride(6, 210)).toBe(2);
    expect(labelStride(6, 120)).toBe(3);
    expect(labelStride(0, 300)).toBe(1);
    expect(labelStride(5, 0)).toBe(1);
  });
});
