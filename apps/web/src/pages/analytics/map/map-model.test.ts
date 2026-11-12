import { describe, expect, it } from 'vitest';
import type { InvestmentSummary } from '@pb/contracts';
import { investmentFixture } from '../../../test/fixtures.js';
import {
  DEFAULT_FILTERS,
  MAX_ZOOM,
  REGIONS,
  WORLD_VIEW,
  clampView,
  clusterSites,
  countryName,
  filterPositions,
  fitPoints,
  markerLabel,
  markerRadius,
  panBy,
  placePositions,
  steppedZoom,
  regionView,
  tourOrder,
  tweenView,
  viewBox,
  zoomAbout,
} from './map-model.js';
import { MAP_HEIGHT, MAP_WIDTH, project } from './projection.js';

const AUSTIN = { city: 'Austin', country: 'US', latitude: 30.2672, longitude: -97.7431 };
const DALLAS = { city: 'Dallas', country: 'US', latitude: 32.7767, longitude: -96.797 };
const LONDON = { city: 'London', country: 'GB', latitude: 51.5074, longitude: -0.1278 };
const SYDNEY = { city: 'Sydney', country: 'AU', latitude: -33.8688, longitude: 151.2093 };

let n = 0;
const position = (overrides: Partial<InvestmentSummary>): InvestmentSummary => {
  n += 1;
  return investmentFixture({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    investmentNumber: `INV-${String(n).padStart(4, '0')}`,
    companyName: `Company ${n}`,
    ...overrides,
  });
};

describe('which positions the map shows', () => {
  const coInvest = position({ companyName: 'Alder', hq: AUSTIN });
  const cv = position({ companyName: 'Birch', dealType: 'deal_type.cv_single_asset', hq: LONDON });
  const credit = position({ companyName: 'Cedar', dealType: 'deal_type.private_credit' });
  const fund = position({ companyName: 'Dune', dealType: 'deal_type.primary_fund' });
  const realized = position({ companyName: 'Elm', isActive: false, exitDate: '2024-03-31' });
  const other = position({
    companyName: 'Fir',
    vehicleName: 'Beach CV Opportunities I',
    sector: 'sector.healthcare',
  });
  const all = [coInvest, cv, credit, fund, realized, other];

  it('starts with held co-investments and single-asset CVs, and nothing else', () => {
    expect(filterPositions(all, DEFAULT_FILTERS).map((p) => p.companyName)).toEqual([
      'Alder',
      'Birch',
      'Fir',
    ]);
  });
  it('narrows by deal type, status, vehicle and sector', () => {
    const names = (f: Partial<typeof DEFAULT_FILTERS>): string[] =>
      filterPositions(all, { ...DEFAULT_FILTERS, ...f }).map((p) => p.companyName);
    expect(names({ dealTypes: ['deal_type.cv_single_asset'] })).toEqual(['Birch']);
    expect(names({ dealTypes: [] })).toEqual([]);
    expect(names({ status: 'realized' })).toEqual(['Elm']);
    expect(names({ status: 'all' })).toEqual(['Alder', 'Birch', 'Elm', 'Fir']);
    expect(names({ vehicle: 'Beach CV Opportunities I' })).toEqual(['Fir']);
    expect(names({ sector: 'sector.healthcare' })).toEqual(['Fir']);
    // The deal types on offer are the two the map is for; another never slips in.
    expect(names({ dealTypes: ['deal_type.private_credit'] })).toEqual([]);
  });
});

describe('placing positions', () => {
  it('groups positions by head office and lists apart those with none recorded', () => {
    const a = position({ companyName: 'Zephyr', hq: AUSTIN });
    const b = position({ companyName: 'Anchor', hq: AUSTIN });
    const c = position({ companyName: 'Marlin', hq: LONDON });
    const d = position({ companyName: 'Nowhere', hq: null });
    const { sites, unplaced } = placePositions([a, b, c, d]);
    expect(sites.map((s) => [s.city, s.positions.map((p) => p.companyName)])).toEqual([
      ['Austin', ['Anchor', 'Zephyr']],
      ['London', ['Marlin']],
    ]);
    expect(unplaced.map((p) => p.companyName)).toEqual(['Nowhere']);
    const austin = sites[0]!;
    expect({ x: austin.x, y: austin.y }).toEqual(project(AUSTIN.longitude, AUSTIN.latitude));
    expect(austin.key).toBe('US|Austin|30.2672|-97.7431');
  });
});

describe('markers', () => {
  const sites = placePositions([
    position({ hq: AUSTIN, nav: '10000000.00' }),
    position({ hq: AUSTIN, nav: '5000000.00' }),
    position({ hq: DALLAS, nav: null }),
    position({ hq: LONDON, dealType: 'deal_type.cv_single_asset' }),
    position({ hq: SYDNEY }),
  ]).sites;

  it('draws near cities as one marker from afar and apart once zoomed in', () => {
    const far = clusterSites(sites, 1);
    expect(far.map((m) => [m.sites.map((s) => s.city), m.count])).toEqual([
      [['Austin', 'Dallas'], 3],
      [['London'], 1],
      [['Sydney'], 1],
    ]);
    const near = clusterSites(sites, 8);
    expect(near.map((m) => m.sites.map((s) => s.city))).toEqual([
      ['Austin'],
      ['Dallas'],
      ['London'],
      ['Sydney'],
    ]);
    // A marker sits at the centre of its positions, weighted by how many each city holds.
    const texas = far[0]!;
    const austin = sites.find((s) => s.city === 'Austin')!;
    const dallas = sites.find((s) => s.city === 'Dallas')!;
    expect(texas.x).toBeCloseTo((2 * austin.x + dallas.x) / 3, 9);
    expect(texas.y).toBeCloseTo((2 * austin.y + dallas.y) / 3, 9);
    expect(texas.dealTypes).toEqual(['deal_type.co_invest_equity']);
    expect(clusterSites([], 1)).toEqual([]);
  });

  it('is stable: the same sites and zoom give the same markers, whatever order they come in', () => {
    const forward = clusterSites(sites, 2);
    const backward = clusterSites([...sites].reverse(), 2);
    expect(backward).toEqual(forward);
  });

  it('sizes a marker by how many positions it holds, up to a cap', () => {
    expect(markerRadius(1)).toBeLessThan(markerRadius(4));
    expect(markerRadius(4)).toBeLessThan(markerRadius(20));
    expect(markerRadius(400)).toBe(markerRadius(4000));
    expect(markerRadius(1)).toBeGreaterThanOrEqual(8);
  });

  it('regroups the cities at half steps of doubling, not on every frame of a flight', () => {
    expect(
      [1, 1.1, 1.3, 1.9, 2.2, 3, 6, 14].map(steppedZoom).map((k) => Number(k.toFixed(3))),
    ).toEqual([1, 1, 1.414, 2, 2, 2.828, 5.657, 16]);
    expect(steppedZoom(0.5)).toBe(1);
  });

  it('names a marker for a reader who cannot see it', () => {
    const [texas, london] = clusterSites(sites, 1);
    expect(markerLabel(texas!)).toBe('2 cities, 3 positions');
    expect(markerLabel(london!)).toBe('London, United Kingdom: 1 position');
    expect(countryName('US')).toBe('United States');
    // A code the browser has no name for, or that is no code at all, is shown as it is.
    expect(countryName('QQ')).toBe('QQ');
    expect(countryName('not a code')).toBe('not a code');
  });

  it('tours the markers from west to east', () => {
    expect(tourOrder(clusterSites(sites, 8)).map((m) => m.sites[0]!.city)).toEqual([
      'Austin',
      'Dallas',
      'London',
      'Sydney',
    ]);
  });
});

describe('the view', () => {
  it('starts on the whole world', () => {
    expect(viewBox(WORLD_VIEW)).toEqual({ x: 0, y: 0, width: MAP_WIDTH, height: MAP_HEIGHT });
  });

  it('never leaves the map and never zooms past its limits', () => {
    expect(clampView({ k: 0.2, x: -50, y: 9999 })).toEqual(WORLD_VIEW);
    const corner = clampView({ k: 4, x: 0, y: 0 });
    expect(viewBox(corner)).toEqual({ x: 0, y: 0, width: MAP_WIDTH / 4, height: MAP_HEIGHT / 4 });
    expect(clampView({ k: 999, x: 500, y: 200 }).k).toBe(MAX_ZOOM);
  });

  it('zooms about a point, which stays where it is on the screen', () => {
    const at = { x: 250, y: 120 };
    const zoomed = zoomAbout(WORLD_VIEW, 2, at);
    expect(zoomed.k).toBe(2);
    const before = viewBox(WORLD_VIEW);
    const after = viewBox(zoomed);
    // The point's share of the way across the frame is unchanged.
    expect((at.x - after.x) / after.width).toBeCloseTo((at.x - before.x) / before.width, 9);
    expect((at.y - after.y) / after.height).toBeCloseTo((at.y - before.y) / before.height, 9);
    // With no point given it zooms about the centre of the view.
    expect(zoomAbout({ k: 2, x: 400, y: 200 }, 2)).toEqual({ k: 4, x: 400, y: 200 });
  });

  it('pans by a distance on the map, held at the edges', () => {
    expect(panBy({ k: 4, x: 500, y: 200 }, 30, -10)).toEqual({ k: 4, x: 530, y: 190 });
    expect(panBy(WORLD_VIEW, 500, 500)).toEqual(WORLD_VIEW);
  });

  it('fits a set of points with room around them', () => {
    const a = project(AUSTIN.longitude, AUSTIN.latitude);
    const b = project(DALLAS.longitude, DALLAS.latitude);
    const view = fitPoints([a, b]);
    const box = viewBox(view);
    for (const p of [a, b]) {
      expect(p.x).toBeGreaterThan(box.x);
      expect(p.x).toBeLessThan(box.x + box.width);
      expect(p.y).toBeGreaterThan(box.y);
      expect(p.y).toBeLessThan(box.y + box.height);
    }
    expect(view.k).toBeGreaterThan(4);
    // One point alone is shown close, not at the deepest zoom; no points is the world.
    expect(fitPoints([a]).k).toBe(6);
    expect(fitPoints([])).toEqual(WORLD_VIEW);
  });

  it('offers the regions the book is spread over', () => {
    expect(REGIONS.map((r) => r.label)).toEqual([
      'World',
      'North America',
      'Europe',
      'Asia Pacific',
    ]);
    expect(regionView('world')).toEqual(WORLD_VIEW);
    const europe = viewBox(regionView('europe'));
    const london = project(LONDON.longitude, LONDON.latitude);
    const austin = project(AUSTIN.longitude, AUSTIN.latitude);
    expect(london.x).toBeGreaterThan(europe.x);
    expect(london.x).toBeLessThan(europe.x + europe.width);
    expect(austin.x).toBeLessThan(europe.x);
  });

  it('flies between two views: the ends are exact and the zoom changes by ratio', () => {
    const from = WORLD_VIEW;
    const to = { k: 8, x: 300, y: 150 };
    expect(tweenView(from, to, 0)).toEqual(from);
    expect(tweenView(from, to, 1)).toEqual(to);
    const half = tweenView(from, to, 0.5);
    expect(half.k).toBeCloseTo(Math.sqrt(8), 9);
    expect(half.x).toBeGreaterThan(Math.min(from.x, to.x));
    expect(half.x).toBeLessThan(Math.max(from.x, to.x));
  });
});
