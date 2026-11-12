import { describe, expect, it } from 'vitest';
import { investmentFixture } from '../../test/fixtures.js';
import { sponsorPageFixture } from '../../test/fixtures-vehicles-sponsors.js';
import {
  filterSponsors,
  fundSizeLabel,
  navByPosition,
  sponsorCountLabel,
  tierTone,
} from './sponsor-ui.js';

describe('sponsor page helpers', () => {
  it('tones a core relationship as brand and a sponsor on watch as watch', () => {
    expect(tierTone('sponsor_tier.core')).toBe('brand');
    expect(tierTone('sponsor_tier.watch')).toBe('watch');
    expect(tierTone('sponsor_tier.active')).toBe('neutral');
    expect(tierTone('sponsor_tier.new')).toBe('neutral');
  });

  it('writes a fund size in its own currency and never converts it', () => {
    expect(fundSizeLabel('4000000000.00', 'USD')).toBe('$4,000.0M');
    expect(fundSizeLabel('500000000.00', 'EUR')).toBe('EUR 500.0M');
    expect(fundSizeLabel(null, 'EUR')).toBe('-');
  });

  it('filters by name ignoring case and surrounding spaces', () => {
    const items = sponsorPageFixture().items;
    expect(filterSponsors(items, '').map((s) => s.name)).toEqual(items.map((s) => s.name));
    expect(filterSponsors(items, '  marram ').map((s) => s.name)).toEqual([
      'Marram Equity Partners',
    ]);
    expect(filterSponsors(items, 'partners')).toHaveLength(3);
    expect(filterSponsors(items, 'nobody')).toEqual([]);
  });

  it('counts sponsors, saying how many of them a search shows', () => {
    expect(sponsorCountLabel(8, 8)).toBe('8 sponsors');
    expect(sponsorCountLabel(1, 1)).toBe('1 sponsor');
    expect(sponsorCountLabel(2, 8)).toBe('2 of 8 sponsors');
    expect(sponsorCountLabel(0, 8)).toBe('0 of 8 sponsors');
  });

  it('charts NAV for active positions with a Locked mark, largest first, with distinct labels', () => {
    const { bars, withoutNav } = navByPosition([
      investmentFixture({ investmentNumber: 'INV-0001', companyName: 'Alder Co', nav: '1000000' }),
      investmentFixture({
        investmentNumber: 'INV-0002',
        companyName: 'Birch Co',
        nav: '3000000.00',
      }),
      investmentFixture({ investmentNumber: 'INV-0003', companyName: 'Alder Co', nav: '2500000' }),
      investmentFixture({ investmentNumber: 'INV-0004', companyName: 'Cedar Co', nav: null }),
      investmentFixture({
        investmentNumber: 'INV-0005',
        companyName: 'Dune Co',
        isActive: false,
        nav: '0',
      }),
    ]);
    expect(bars).toEqual([
      { label: 'Birch Co', value: 3000000, display: '$3.0M' },
      { label: 'Alder Co (INV-0003)', value: 2500000, display: '$2.5M' },
      { label: 'Alder Co (INV-0001)', value: 1000000, display: '$1.0M' },
    ]);
    expect(withoutNav).toBe(1);
  });
});
