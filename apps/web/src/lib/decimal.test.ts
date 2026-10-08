import { describe, expect, it } from 'vitest';
import { moneyLabel, sumDecimals } from './decimal.js';

describe('sumDecimals', () => {
  it('adds decimal strings exactly, never through floats', () => {
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.3');
    expect(sumDecimals(['105893922.44', '96603473.9', '94356331.24'])).toBe('296853727.58');
  });

  it('keeps as many places as the widest input and handles negatives and zero', () => {
    expect(sumDecimals(['1', '2.5', '0.125'])).toBe('3.625');
    expect(sumDecimals(['-14116725.89', '14116725.89'])).toBe('0.00');
    expect(sumDecimals(['-5.50', '2'])).toBe('-3.50');
    expect(sumDecimals(['-0.5', '-0.25'])).toBe('-0.75');
  });

  it('ignores nulls and malformed values and is null when nothing usable remains', () => {
    expect(sumDecimals(['3', null, undefined, 'n/a'])).toBe('3');
    expect(sumDecimals([null, undefined])).toBeNull();
    expect(sumDecimals([])).toBeNull();
  });
});

describe('moneyLabel', () => {
  it('formats a chart number as $M through the house formatter', () => {
    expect(moneyLabel(346917161.92)).toBe('$346.9M');
    expect(moneyLabel(-28891502.17)).toBe('-$28.9M');
    expect(moneyLabel(0)).toBe('$0.0M');
  });
});
