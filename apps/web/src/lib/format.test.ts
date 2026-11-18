import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  formatMoneyM2,
  formatMoneyMIn,
  formatMonthYear,
  formatMonthYearShort,
  formatMultiple,
  formatPct,
  formatQuarter,
  formatUsdExact,
  formatWholeDollars,
  formatYears,
  groupThousands,
  clearTaxonomyLabels,
  joinList,
  labelOf,
  registerTaxonomyLabels,
  MISSING,
  moneyLabel,
  plural,
} from './format.js';

describe('number and date display (docs/06 section 3)', () => {
  it('shows $M with one decimal and the missing placeholder for null', () => {
    expect(formatMoneyM('12345678.90')).toBe('$12.3M');
    expect(formatMoneyM('-2500000')).toBe('-$2.5M');
    expect(formatMoneyM('1250000000')).toBe('$1,250.0M');
    expect(formatMoneyM(null)).toBe(MISSING);
    // In its own currency: dollars as they are, another currency by its code, never converted.
    expect(formatMoneyMIn('2500000', 'USD')).toBe('$2.5M');
    expect(formatMoneyMIn('2500000', 'EUR')).toBe('EUR 2.5M');
    expect(formatMoneyMIn('-2500000', 'GBP')).toBe('-GBP 2.5M');
    expect(formatMoneyMIn(null, 'EUR')).toBe(MISSING);
    expect(formatMoneyM('abc')).toBe(MISSING);
  });
  it('shows $M with two decimals where two close figures sit side by side', () => {
    expect(formatMoneyM2('7831632.54')).toBe('$7.83M');
    expect(formatMoneyM2('30000000')).toBe('$30.00M');
    expect(formatMoneyM2('-12400000.00')).toBe('-$12.40M');
    expect(formatMoneyM2(null)).toBe(MISSING);
    expect(formatMoneyM2('abc')).toBe(MISSING);
  });
  it('shows a small amount in full to the whole dollar, with no sign on one that rounds to nothing', () => {
    expect(formatWholeDollars('21632.54')).toBe('$21,633');
    expect(formatWholeDollars('50000.00')).toBe('$50,000');
    expect(formatWholeDollars('-17600000')).toBe('-$17,600,000');
    expect(formatWholeDollars('0.5')).toBe('$1');
    expect(formatWholeDollars('-0.4')).toBe('$0');
    expect(formatWholeDollars(null)).toBe(MISSING);
    expect(formatWholeDollars('abc')).toBe(MISSING);
  });
  it('shows dollars to the cent where two figures are compared, from the digits and never a float', () => {
    expect(formatUsdExact('12450950.25')).toBe('$12,450,950.25');
    expect(formatUsdExact('11900000')).toBe('$11,900,000.00');
    expect(formatUsdExact('4074999.5')).toBe('$4,074,999.50');
    expect(formatUsdExact('0')).toBe('$0.00');
    expect(formatUsdExact('0.00')).toBe('$0.00');
    expect(formatUsdExact('-125000.5')).toBe('-$125,000.50');
    expect(formatUsdExact('999.99')).toBe('$999.99');
    expect(formatUsdExact('007.5')).toBe('$7.50');
    // More places than cents: half a cent rounds away from zero, and the carry runs through.
    expect(formatUsdExact('814999.904')).toBe('$814,999.90');
    expect(formatUsdExact('814999.905')).toBe('$814,999.91');
    expect(formatUsdExact('0.005')).toBe('$0.01');
    expect(formatUsdExact('-0.005')).toBe('-$0.01');
    expect(formatUsdExact('999.995')).toBe('$1,000.00');
    expect(formatUsdExact('999999.9999999999')).toBe('$1,000,000.00');
    expect(formatUsdExact('1.0049999999')).toBe('$1.00');
    // An amount that rounds to nothing carries no sign.
    expect(formatUsdExact('-0.004')).toBe('$0.00');
    expect(formatUsdExact('-0')).toBe('$0.00');
    // Larger than a float holds exactly: every digit is kept.
    expect(formatUsdExact('123456789012345678.91')).toBe('$123,456,789,012,345,678.91');
    expect(formatUsdExact('9007199254740993.01')).toBe('$9,007,199,254,740,993.01');
    for (const nothing of [null, undefined, '', 'abc', '1e6', '1,000.00', '.5', '5.', '$5'])
      expect(formatUsdExact(nothing), String(nothing)).toBe(MISSING);
  });
  it('groups the digits of a whole number in threes and leaves anything else alone', () => {
    for (const [whole, grouped] of [
      ['0', '0'],
      ['999', '999'],
      ['1000', '1,000'],
      ['12345', '12,345'],
      ['123456', '123,456'],
      ['1234567', '1,234,567'],
      ['-1234567', '-1,234,567'],
      ['-999', '-999'],
      ['1e+21', '1e+21'],
      ['', ''],
    ] as const)
      expect(groupThousands(whole), whole).toBe(grouped);
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
  it('shortens month and year for chart axes and never guesses a month', () => {
    expect(formatMonthYearShort('2025-06-30')).toBe('Jun 2025');
    expect(formatMonthYearShort('2024-09-30')).toBe('Sep 2024');
    expect(formatMonthYearShort('2026-01-15')).toBe('Jan 2026');
    expect(formatMonthYearShort('2024-12-31')).toBe('Dec 2024');
    for (const bad of [null, undefined, '', 'not a date', 'June 2025', '2024-13-31', '2024-00-31'])
      expect(formatMonthYearShort(bad), String(bad)).toBe(MISSING);
  });
  it('shows a holding period to one decimal and never computes one', () => {
    expect(formatYears('2.0027397260')).toBe('2.0 years');
    expect(formatYears('3.7')).toBe('3.7 years');
    expect(formatYears('0.0547945205')).toBe('0.1 years');
    for (const bad of [null, undefined, '', 'soon'])
      expect(formatYears(bad), String(bad)).toBe(MISSING);
  });

  it('counts with a plural noun and joins a list in plain words', () => {
    expect(plural(1, 'quarter')).toBe('1 quarter');
    expect(plural(0, 'quarter')).toBe('0 quarters');
    expect(plural(3, 'quarter')).toBe('3 quarters');
    expect(joinList([])).toBe('');
    expect(joinList(['Q1 2024'])).toBe('Q1 2024');
    expect(joinList(['Q1 2024', 'Q2 2024'])).toBe('Q1 2024 and Q2 2024');
    expect(joinList(['A', 'B', 'C'])).toBe('A, B and C');
  });
  it('labels a quarter-end date by its calendar quarter', () => {
    expect(formatQuarter('2025-06-30')).toBe('Q2 2025');
    expect(formatQuarter('2023-09-30')).toBe('Q3 2023');
    expect(formatQuarter('2023-12-28')).toBe('Q4 2023');
    expect(formatQuarter('2024-03-31')).toBe('Q1 2024');
    for (const bad of [null, undefined, '', 'June 2025', '2024-13-31', '2024-00-31'])
      expect(formatQuarter(bad), String(bad)).toBe(MISSING);
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
