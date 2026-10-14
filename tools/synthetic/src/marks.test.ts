import { describe, expect, it } from 'vitest';
import { generateDataset } from './generate.js';
import { activePositions, latestLockedMark, takeRows, walledInvestment } from './marks.js';

const small = generateDataset({ profile: 'small', seed: 42 });
type Valuation = (typeof small.valuations)[number];

const mark = (overrides: Partial<Valuation>): Valuation => ({
  id: 'v',
  investmentId: 'inv',
  periodEnd: '2025-03-31',
  version: 1,
  method: 'valuation_method.sponsor_mark',
  fairValue: '1.00',
  state: 'Locked',
  lockHash: 'h',
  preparedBy: null,
  dealTeamApprovedBy: null,
  approvedBy: null,
  approvedAt: null,
  scenarioTags: [],
  ...overrides,
});

describe('the mark and position helpers the sample drops share', () => {
  it('takes the latest Locked period on or before the date, and its latest version', () => {
    const marks = [
      mark({ id: 'a', periodEnd: '2025-03-31', fairValue: '10.00' }),
      mark({ id: 'b', periodEnd: '2025-06-30', fairValue: '20.00' }),
      mark({ id: 'c', periodEnd: '2025-06-30', version: 2, fairValue: '21.00' }),
      mark({ id: 'd', periodEnd: '2025-06-30', version: 3, fairValue: '99.00', state: 'Reopened' }),
      mark({ id: 'e', periodEnd: '2025-09-30', fairValue: '30.00' }),
      mark({
        id: 'f',
        periodEnd: '2025-06-30',
        version: 9,
        fairValue: '1.00',
        investmentId: 'other',
      }),
    ];
    expect(latestLockedMark(marks, 'inv', '2025-06-30')?.id).toBe('c');
    expect(latestLockedMark(marks, 'inv', '2025-06-29')?.id).toBe('a');
    expect(latestLockedMark(marks, 'inv', '2025-12-31')?.id).toBe('e');
    expect(latestLockedMark(marks, 'inv', '2025-03-30')).toBeNull();
    expect(latestLockedMark(marks, 'nobody', '2025-12-31')).toBeNull();
  });

  it('lists active positions by number, all deal types or the equity and CV ones only', () => {
    const all = activePositions(small);
    const equity = activePositions(small, 'equity');
    expect(all.every((i) => i.isActive)).toBe(true);
    expect(all.map((i) => i.investmentNumber)).toEqual(
      [...all.map((i) => i.investmentNumber)].sort(),
    );
    expect(equity.every((i) => i.dealType !== 'deal_type.private_credit')).toBe(true);
    expect(all.length).toBeGreaterThan(equity.length);
    expect(all.length).toBe(small.investments.filter((i) => i.isActive).length);
    expect(walledInvestment(small)?.id).toBe(small.scenarios.walled_deal?.[0]);
  });

  it('takes the first free rows and marks them taken', () => {
    const taken = new Set<number>([1]);
    expect(takeRows(6, taken, 2)).toEqual([0, 2]);
    expect(takeRows(6, taken, 2, (i) => i % 2 === 1)).toEqual([3, 5]);
    expect(takeRows(6, taken, 3)).toEqual([4]);
    expect([...taken].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
