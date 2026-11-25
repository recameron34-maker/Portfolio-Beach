import { describe, expect, it } from 'vitest';
import {
  axisLabels,
  barRows,
  chartLabels,
  compactValue,
  dodge,
  knownRuns,
  labelBudget,
  labelColumn,
  labelPx,
  labelStride,
  niceStep,
  labelLayout,
  niceTicks,
  outlierFences,
  tickAnchor,
  truncateMiddle,
  valueLabelPosition,
  widestLabel,
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
  it('caps the label column at about 36 percent of the chart, between 96 and 220 pixels', () => {
    expect(labelColumn(316)).toBe(114);
    expect(labelColumn(450)).toBe(162);
    expect(labelColumn(200)).toBe(96);
    expect(labelColumn(1000)).toBe(220);
  });

  it('sizes the label column from its widest label, never over the cap', () => {
    // Years: four tabular digits and the gap, not a third of the chart.
    expect(labelPx('2019')).toBeCloseTo(28.8, 5);
    expect(labelColumn(552, widestLabel(['2016', '2017', '2025']))).toBe(43);
    expect(labelColumn(343, widestLabel(['2016', '2025']))).toBe(43);
    // A long name takes what it needs and no more than the cap.
    const account = 'Client Gamma Separate Account';
    const column = labelColumn(552, widestLabel(['Beach Co-Invest Fund II', account]));
    expect(column).toBeGreaterThanOrEqual(Math.ceil(labelPx(account)) + 14);
    expect(column).toBeLessThanOrEqual(labelColumn(552));
    expect(labelColumn(316, 500)).toBe(labelColumn(316));
    expect(labelColumn(1000, 500)).toBe(220);
    // Nothing to label still leaves a column a tick figure can sit in.
    expect(labelColumn(552, widestLabel([]))).toBe(40);
  });

  it('estimates a label by the kind of each character, never under what the face draws', () => {
    // Measured in the bundled face at 12px (browser and font metrics agree to a pixel).
    const measured: [string, number][] = [
      ['Client Gamma Separate Account', 174.8],
      ['Beach Co-Invest Fund III', 137.0],
      ['Business services', 95.6],
      ['INV-0019', 54.2],
      ['8.0x to 10.0x', 71.3],
      ['Not recorded', 70.9],
    ];
    for (const [label, px] of measured) {
      expect(labelPx(label), label).toBeGreaterThanOrEqual(px - 0.5);
      expect(labelPx(label), label).toBeLessThanOrEqual(px + 8);
    }
  });

  it('fits about one character per 5.8 pixels of the column, after the gap', () => {
    expect(labelBudget(96)).toBe(14);
    expect(labelBudget(114)).toBe(17);
    expect(labelBudget(162)).toBe(25);
    expect(labelBudget(220)).toBe(35);
    expect(labelBudget(10)).toBe(5);
  });

  it('leaves a label whole when it fits its column, and cuts a wider one to what fits', () => {
    // The Home chart at 1440: a 552px chart, whose cap is 199px. The account's name fits it.
    const account = 'Client Gamma Separate Account';
    expect(labelBudget(labelColumn(552), account)).toBe(account.length);
    expect(chartLabels([account], (label) => labelBudget(labelColumn(552), label))).toEqual([
      account,
    ]);
    // A label wider than the column is cut to the share of its own characters that fits, and
    // what is left stays inside the column (the cut keeps different letters, so the 4px clear
    // edge takes the difference; the label ends 10px before the plot).
    for (const long of [
      'Borrower credit analysis and covenant review',
      'Kelpwood Capital Partners Fund IV',
      'INV-0019 2019202020212022',
    ]) {
      for (const column of [96, 114, 162]) {
        const budget = labelBudget(column, long);
        expect(budget, long).toBeLessThan(long.length);
        expect(labelPx(truncateMiddle(long, budget)), `${long} in ${column}`).toBeLessThanOrEqual(
          column - 10,
        );
      }
    }
    // Digits are wider than letters: a long number is cut sooner than words of its length.
    expect(labelBudget(114, '2019202020212022')).toBeLessThan(labelBudget(114, 'abcdefghijklmnop'));
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

  it('keeps the start of labels that differ only in the middle, so no two bars read the same', () => {
    expect(
      chartLabels(['Seagrass Fund II', 'Seagrass Growth Fund II', 'Skerry Fund I'], 15),
    ).toEqual(['Seagrass Fun...', 'Seagrass Gro...', 'Skerry Fund I']);
    expect(
      chartLabels(['Juniper Financial Group', 'Cobalt Energy Group', 'Juniper Payments Group'], 15),
    ).toEqual(['Juniper Fina...', 'Cobalt...Group', 'Juniper Paym...']);
    // Labels that differ at the end keep the middle cut.
    expect(chartLabels(['Beach Co-Invest Fund II', 'Beach Co-Invest Fund III'], 15)).toEqual([
      'Beach...Fund II',
      'Beac...Fund III',
    ]);
    // When the starts cannot tell them apart either, the middle cuts stay.
    expect(chartLabels(['Alpha Beta Gamma Omega', 'Alpha Beta Delta Omega'], 10)).toEqual([
      'Al...Omega',
      'Al...Omega',
    ]);
    expect(chartLabels([], 15)).toEqual([]);
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

describe('knownRuns', () => {
  it('splits a series at every missing value so the line shows a gap there', () => {
    expect(knownRuns([1, 2, null, 4, null, null, 7, 8])).toEqual([
      [
        { i: 0, v: 1 },
        { i: 1, v: 2 },
      ],
      [{ i: 3, v: 4 }],
      [
        { i: 6, v: 7 },
        { i: 7, v: 8 },
      ],
    ]);
    expect(knownRuns([null, 0, 5])).toEqual([
      [
        { i: 1, v: 0 },
        { i: 2, v: 5 },
      ],
    ]);
    expect(knownRuns([null, null])).toEqual([]);
    expect(knownRuns([])).toEqual([]);
  });

  it('runs over a point the series does not have by design, and still breaks at a missing value', () => {
    // Index 1 is a date of another series; index 3 is a figure that is missing.
    expect(knownRuns([1, null, 3, null, 5], [false, true, false, false, false])).toEqual([
      [
        { i: 0, v: 1 },
        { i: 2, v: 3 },
      ],
      [{ i: 4, v: 5 }],
    ]);
    // A value is drawn wherever it is, whatever the marks say.
    expect(knownRuns([1, 2], [true, true])).toEqual([
      [
        { i: 0, v: 1 },
        { i: 1, v: 2 },
      ],
    ]);
  });

  it('sets bar labels above their bars under 480px of chart width, beside them from there', () => {
    expect(labelLayout(358)).toBe('above');
    expect(labelLayout(479)).toBe('above');
    expect(labelLayout(480)).toBe('side');
    expect(labelLayout(1100)).toBe('side');
    // On a phone, labels that all fit their column whole (years) stay beside their bars.
    expect(labelLayout(358, ['2016', '2017', '2025'])).toBe('side');
    expect(labelLayout(358, ['2016', 'Client Gamma Separate Account'])).toBe('above');
    // Above: a 40px row, the label's line first, the 12px bar under it, from the left edge.
    const above = barRows(358);
    expect(above).toMatchObject({ row: 40, plotLeft: 0, labelX: 0, labelAnchor: 'start' });
    expect(above.labelBaseline).toBeLessThan(above.barTop);
    expect(above.barTop + 12).toBeLessThanOrEqual(above.row);
    // Beside: a 26px row, the bar centred in it, the label ending at the plot.
    const side = barRows(600);
    expect(side).toMatchObject({ row: 26, barTop: 7, labelAnchor: 'end' });
    expect(side.plotLeft).toBe(labelColumn(600));
    // With its labels, the plot starts where the widest of them ends; charts that share a scale
    // are handed the widest label of them all, so their plots start on one line.
    expect(barRows(552, ['2016', '2025']).plotLeft).toBe(43);
    expect(barRows(358, ['2016', '2025'])).toMatchObject({ layout: 'side', plotLeft: 43 });
    expect(barRows(552, ['2016', '2025'], labelPx('Healthcare')).plotLeft).toBe(
      labelColumn(552, labelPx('Healthcare')),
    );
  });

  it('starts a tick figure on its gridline at the left edge, and centres it elsewhere', () => {
    expect(tickAnchor(0)).toBe('start');
    expect(tickAnchor(15)).toBe('start');
    expect(tickAnchor(16)).toBe('middle');
  });

  it('fences off figures beyond three times the interquartile range, and none for a few', () => {
    const fences = outlierFences([-1.18, 0.05, 0.08, 0.1, 0.12, 0.15]);
    expect(fences?.lo).toBeCloseTo(-0.115, 6);
    expect(fences?.hi).toBeCloseTo(0.2875, 6);
    expect(outlierFences([1, 2, 3])).toBeNull();
    expect(outlierFences([2, 2, 2, 2, 9])).toBeNull();
  });

  it('moves end labels apart by 14px, down from the top and back up from the foot', () => {
    const at = (y: number) => ({ y, at: y });
    // Two lines ending 6px apart: the second label moves down, its line stays where it ends.
    expect(dodge([at(50), at(56)], 12, 212).map((l) => [l.y, l.at])).toEqual([
      [50, 50],
      [64, 56],
    ]);
    // At the foot: pushed back up, none below the plot.
    expect(dodge([at(200), at(205), at(210)], 12, 212).map((l) => l.y)).toEqual([184, 198, 212]);
    // Far apart already: nothing moves.
    expect(dodge([at(20), at(100)], 12, 212).map((l) => l.y)).toEqual([20, 100]);
  });

  it('writes an axis in one unit and as many decimals as its step needs, so no two ticks read alike', () => {
    // Close to par: ticks 0.2M apart would all read "$18M" or "$19M" one by one.
    expect(axisLabels([18_000_000, 18_200_000, 18_400_000, 19_000_000], 'money')).toEqual([
      '$18.0M',
      '$18.2M',
      '$18.4M',
      '$19.0M',
    ]);
    // One unit down the axis, and zero written plainly.
    expect(axisLabels([0, 500_000, 1_000_000, 1_500_000], 'money')).toEqual([
      '$0',
      '$0.5M',
      '$1.0M',
      '$1.5M',
    ]);
    expect(axisLabels([-200_000_000, -100_000_000, 0], 'money')).toEqual([
      '-$200M',
      '-$100M',
      '$0',
    ]);
    expect(axisLabels([0, 50, 100], 'money')).toEqual(['$0', '$50', '$100']);
    expect(axisLabels([-0.1, -0.05, 0, 0.05, 0.1], 'pct')).toEqual([
      '-10%',
      '-5%',
      '0%',
      '5%',
      '10%',
    ]);
    expect(axisLabels([0.12, 0.122, 0.124], 'pct')).toEqual(['12.0%', '12.2%', '12.4%']);
    expect(axisLabels([1, 2, 3], 'multiple')).toEqual(['1.0x', '2.0x', '3.0x']);
    expect(axisLabels([0, 1_000, 2_000], 'count')).toEqual(['0', '1,000', '2,000']);
    expect(axisLabels([0], 'money')).toEqual(['$0']);
  });
});
