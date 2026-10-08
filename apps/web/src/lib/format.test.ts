import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  formatMonthYear,
  formatMultiple,
  formatPct,
  clearTaxonomyLabels,
  labelOf,
  registerTaxonomyLabels,
  MISSING,
  moneyLabel,
} from './format.js';

describe('number and date display (docs/06 section 3)', () => {
  it('shows $M with one decimal and the missing placeholder for null', () => {
    expect(formatMoneyM('12345678.90')).toBe('$12.3M');
    expect(formatMoneyM('-2500000')).toBe('-$2.5M');
    expect(formatMoneyM('1250000000')).toBe('$1,250.0M');
    expect(formatMoneyM(null)).toBe(MISSING);
    expect(formatMoneyM('abc')).toBe(MISSING);
  });
  it('formats MOIC, multiples and rates', () => {
    expect(formatMoic('1.8349')).toBe('1.83x');
    expect(formatMoic('2.005')).toBe('2.01x');
    expect(formatMultiple('11.26')).toBe('11.3x');
    expect(formatPct('0.14457')).toBe('14.5%');
    expect(formatPct('0.091836', 2)).toBe('9.18%');
    expect(formatPct(null)).toBe(MISSING);
  });
  it('formats dates without touching time zones', () => {
    expect(formatDate('2026-01-15')).toBe('Jan 15, 2026');
    expect(formatDate('2024-12-31')).toBe('Dec 31, 2024');
    expect(formatMonthYear('2026-01-15')).toBe('January 2026');
    expect(formatDate(null)).toBe(MISSING);
    expect(formatDate('garbage')).toBe(MISSING);
  });
  it('labels chart numbers in $M from the API figure, never from arithmetic', () => {
    expect(moneyLabel(346917161.92)).toBe('$346.9M');
    expect(moneyLabel(-28891502.17)).toBe('-$28.9M');
    expect(moneyLabel(0)).toBe('$0.0M');
  });
  it('labels taxonomy codes', () => {
    expect(labelOf('deal_type.co_invest_equity')).toBe('Co invest equity');
    expect(labelOf(null)).toBe(MISSING);
  });

  it('prefers the taxonomy label once registered', () => {
    registerTaxonomyLabels([
      { code: 'base_rate.sofr', label: 'SOFR' },
      { code: 'sector.financials', label: 'Financial services' },
    ]);
    expect(labelOf('base_rate.sofr')).toBe('SOFR');
    expect(labelOf('sector.financials')).toBe('Financial services');
    expect(labelOf('sector.software')).toBe('Software');
    clearTaxonomyLabels();
    expect(labelOf('base_rate.sofr')).toBe('Sofr');
  });
});
