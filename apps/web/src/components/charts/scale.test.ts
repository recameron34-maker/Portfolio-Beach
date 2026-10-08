import { describe, expect, it } from 'vitest';
import { compactValue, labelStride, niceStep, niceTicks, truncateLabel } from './scale.js';

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
  it('truncates long labels without cutting the tooltip copy', () => {
    expect(truncateLabel('Beach Co-Invest Fund III Partners LP', 22)).toBe(
      'Beach Co-Invest Fund...',
    );
    expect(truncateLabel('Short')).toBe('Short');
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
