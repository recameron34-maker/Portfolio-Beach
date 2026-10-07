import type { Rng } from './prng.js';

/**
 * Fictional name parts. Combinations are generated, never copied from real firms. The local
 * deny-list scan (docs/10) is the control that catches an accidental collision with a real name.
 */
const COASTAL = [
  'Harborlight',
  'Saltmarsh',
  'Tidewater',
  'Driftwood',
  'Seagrass',
  'Dunecrest',
  'Pelican',
  'Kelpwood',
  'Sandbar',
  'Lighthouse',
  'Breakwater',
  'Shoreline',
  'Coralstone',
  'Estuary',
  'Cliffside',
  'Marram',
  'Wavecrest',
  'Oysterbed',
  'Gullwing',
  'Anchorage',
  'Northcape',
  'Lagoon',
  'Skerry',
  'Headland',
  'Brightwater',
  'Stormglass',
  'Tern',
  'Ebbtide',
  'Fathom',
  'Reefpoint',
];
const SPONSOR_SUFFIX = [
  'Capital',
  'Partners',
  'Equity Partners',
  'Growth Partners',
  'Capital Partners',
  'Investors',
  'Private Equity',
];
const CREDIT_SUFFIX = ['Credit Partners', 'Direct Lending', 'Capital Credit'];
const FUND_ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const COMPANY_A = [
  'Meridian',
  'Quill',
  'Copperleaf',
  'Northstar',
  'Brightpath',
  'Lumen',
  'Cobalt',
  'Juniper',
  'Granite',
  'Orchard',
  'Summit',
  'Beacon',
  'Ridgeway',
  'Larkspur',
  'Alder',
  'Tamarack',
  'Ironbridge',
  'Silverline',
  'Evergreen',
  'Keystone',
  'Whitfield',
  'Marlowe',
  'Hollis',
  'Ashby',
  'Penrose',
  'Calder',
  'Westbrook',
  'Fairhaven',
  'Linden',
  'Vantage',
];
const COMPANY_B: Record<string, string[]> = {
  'sector.software': ['Software', 'Systems', 'Analytics', 'Cloud', 'Data', 'Digital'],
  'sector.healthcare': ['Health', 'Diagnostics', 'Medical', 'Therapeutics', 'Care', 'Clinical'],
  'sector.industrials': [
    'Industries',
    'Manufacturing',
    'Engineering',
    'Components',
    'Automation',
    'Logistics',
  ],
  'sector.consumer': ['Brands', 'Foods', 'Retail', 'Home', 'Outdoors', 'Goods'],
  'sector.business_services': [
    'Services',
    'Solutions',
    'Advisory',
    'Outsourcing',
    'Staffing',
    'Compliance',
  ],
  'sector.financials': [
    'Financial',
    'Payments',
    'Insurance Services',
    'Wealth',
    'Lending',
    'Capital Markets',
  ],
  'sector.energy_transition': ['Energy', 'Renewables', 'Power', 'Grid', 'Storage', 'Solar'],
};
const COMPANY_SUFFIX = ['Holdings', 'Group', 'Inc', 'Co', 'Corp', 'Partners'];
const FIRST = [
  'Avery',
  'Blake',
  'Casey',
  'Dana',
  'Ellis',
  'Finley',
  'Harper',
  'Jordan',
  'Kai',
  'Lane',
  'Morgan',
  'Noor',
  'Parker',
  'Quinn',
  'Reese',
  'Sage',
  'Tatum',
  'Wren',
  'Rowan',
  'Emerson',
];
const LAST = [
  'Whitaker',
  'Okafor',
  'Lindqvist',
  'Marchetti',
  'Nakamura',
  'Oyelaran',
  'Petrova',
  'Haddad',
  'Castellano',
  'Brennan',
  'Delacroix',
  'Fairweather',
  'Iyer',
  'Kowalski',
  'Mbeki',
  'Sorensen',
  'Thackeray',
  'Vasquez',
  'Yamamoto',
  'Zielinski',
];

export class NameFactory {
  private readonly used = new Set<string>();
  constructor(private readonly rng: Rng) {}

  private unique(make: () => string): string {
    for (let i = 0; i < 200; i++) {
      const candidate = make();
      const key = candidate.toLowerCase();
      if (!this.used.has(key)) {
        this.used.add(key);
        return candidate;
      }
    }
    throw new Error('ran out of unique names; add words to names.ts');
  }

  sponsor(credit = false): string {
    return this.unique(
      () => `${this.rng.pick(COASTAL)} ${this.rng.pick(credit ? CREDIT_SUFFIX : SPONSOR_SUFFIX)}`,
    );
  }

  /** "Harborlight Fund IV" from "Harborlight Capital". Collisions move to the next numeral. */
  fund(sponsorName: string, index: number, strategy: string): string {
    const stem = sponsorName.split(' ')[0] ?? sponsorName;
    const label =
      strategy === 'strategy.credit'
        ? 'Credit Fund'
        : strategy === 'strategy.growth'
          ? 'Growth Fund'
          : 'Fund';
    let attempt = Math.min(index, FUND_ROMAN.length - 1);
    return this.unique(() => {
      const roman = FUND_ROMAN[attempt % FUND_ROMAN.length] ?? 'I';
      const cycle = Math.floor(attempt / FUND_ROMAN.length);
      attempt++;
      return cycle === 0
        ? `${stem} ${label} ${roman}`
        : `${stem} ${label} ${roman} (${String.fromCharCode(64 + cycle)})`;
    });
  }

  /** "HF IV" style short names; a collision appends a counter so aliases stay unique. */
  fundAlias(fundName: string): string {
    const parts = fundName.split(' ');
    const initials = parts
      .slice(0, -1)
      .map((p) => p[0] ?? '')
      .join('');
    let attempt = 0;
    return this.unique(() => {
      const base = `${initials} ${parts[parts.length - 1] ?? ''}`.trim();
      attempt++;
      return attempt === 1 ? base : `${base}-${attempt}`;
    });
  }

  company(sector: string): string {
    const nouns = COMPANY_B[sector] ?? ['Group'];
    return this.unique(
      () => `${this.rng.pick(COMPANY_A)} ${this.rng.pick(nouns)} ${this.rng.pick(COMPANY_SUFFIX)}`,
    );
  }

  /** A deliberately similar name for the near-miss scenario (docs/14). */
  nearMiss(name: string): string {
    const parts = name.split(' ');
    const others = COMPANY_SUFFIX.filter((s) => s !== parts[parts.length - 1]);
    return this.unique(() => `${parts.slice(0, -1).join(' ')} ${this.rng.pick(others)}`);
  }

  person(): { displayName: string; email: string } {
    const displayName = this.unique(() => `${this.rng.pick(FIRST)} ${this.rng.pick(LAST)}`);
    return {
      displayName,
      email: `${displayName.replace(' ', '.')}@portfolio-beach.example`.toLowerCase(),
    };
  }

  project(): string {
    return this.unique(() => `Project ${this.rng.pick(COASTAL)}`);
  }
}

export function canonical(name: string): string {
  return name.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}
