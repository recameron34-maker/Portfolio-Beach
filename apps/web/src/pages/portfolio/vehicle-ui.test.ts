import { describe, expect, it } from 'vitest';
import { vehicleSummaryFixture } from '../../test/fixtures-vehicles-sponsors.js';
import {
  activePositionBars,
  CLIENT_DATA_VISIBILITY,
  closingsLabel,
  finalCloseLabel,
  NO_CASH_FLOW_NOTE,
  quarterLabel,
} from './vehicle-ui.js';

describe('vehicle page helpers', () => {
  it('labels a quarter-end date by its calendar quarter', () => {
    expect(quarterLabel('2025-06-30')).toBe('Q2 2025');
    expect(quarterLabel('2023-09-30')).toBe('Q3 2023');
    expect(quarterLabel('2023-12-28')).toBe('Q4 2023');
    expect(quarterLabel('2024-03-31')).toBe('Q1 2024');
    expect(quarterLabel('2024-13-31')).toBe('-');
    expect(quarterLabel('June 2025')).toBe('-');
  });

  it('counts closings and words the final close', () => {
    expect(closingsLabel(1)).toBe('1 closing');
    expect(closingsLabel(2)).toBe('2 closings');
    expect(closingsLabel(0)).toBe('0 closings');
    expect(finalCloseLabel('2021-06-30')).toBe('Final close Jun 30, 2021');
    expect(finalCloseLabel(null)).toBe('Final close not yet');
  });

  it('orders the active position bars largest first, ties by name', () => {
    const bars = activePositionBars([
      vehicleSummaryFixture({ name: 'Vehicle B', activeInvestments: 2 }),
      vehicleSummaryFixture({ name: 'Vehicle C', activeInvestments: 5 }),
      vehicleSummaryFixture({ name: 'Vehicle A', activeInvestments: 2 }),
      vehicleSummaryFixture({ name: 'Vehicle D', activeInvestments: 0 }),
    ]);
    expect(bars).toEqual([
      { label: 'Vehicle C', value: 5, display: '5' },
      { label: 'Vehicle A', value: 2, display: '2' },
      { label: 'Vehicle B', value: 2, display: '2' },
      { label: 'Vehicle D', value: 0, display: '0' },
    ]);
  });

  it('keeps its sentences free of em dashes', () => {
    for (const text of [CLIENT_DATA_VISIBILITY, NO_CASH_FLOW_NOTE]) {
      expect(text).not.toContain(String.fromCharCode(0x2014));
    }
  });
});
