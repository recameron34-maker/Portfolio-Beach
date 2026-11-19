/**
 * What the co-investment map shows and how it moves, as plain functions (decision 0017): which
 * positions are on it, where each head office sits, which cities share a marker at a zoom, and
 * the arithmetic of the view (zoom, pan, fit, fly). Nothing here reads the page or the clock.
 *
 * Money is never added up here for display. A marker's size comes from how many positions it
 * holds; every figure a reader sees is the API's own, formatted (docs/06 section 3).
 */
import type { InvestmentSummary } from '@pb/contracts';
import { plural } from '../../../lib/format.js';
import { MAP_HEIGHT, MAP_WIDTH, project } from './projection.js';

/* ---- Which positions ---- */

/** The two kinds of deal the map is for: one company each, so one head office each. */
export const MAP_DEAL_TYPES: readonly string[] = [
  'deal_type.co_invest_equity',
  'deal_type.cv_single_asset',
];

export type MapStatus = 'held' | 'realized' | 'all';

export interface MapFilters {
  dealTypes: readonly string[];
  status: MapStatus;
  /** A vehicle's name, or '' for every vehicle. */
  vehicle: string;
  /** A sector code, or '' for every sector. */
  sector: string;
}

export const DEFAULT_FILTERS: MapFilters = {
  dealTypes: MAP_DEAL_TYPES,
  status: 'held',
  vehicle: '',
  sector: '',
};

const byText =
  <T>(text: (item: T) => string) =>
  (a: T, b: T): number => {
    const x = text(a);
    const y = text(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };

/** The positions the filters let through, by company name. */
export function filterPositions(
  items: readonly InvestmentSummary[],
  filters: MapFilters,
): InvestmentSummary[] {
  return items
    .filter(
      (p) =>
        MAP_DEAL_TYPES.includes(p.dealType) &&
        filters.dealTypes.includes(p.dealType) &&
        (filters.status === 'all' || (filters.status === 'held') === p.isActive) &&
        (filters.vehicle === '' || p.vehicleName === filters.vehicle) &&
        (filters.sector === '' || p.sector === filters.sector),
    )
    .sort(byText((p) => p.companyName));
}

/* ---- Where they sit ---- */

/** One head office and the positions whose company is there. */
export interface Site {
  key: string;
  city: string;
  country: string;
  longitude: number;
  latitude: number;
  /** In the map's frame. */
  x: number;
  y: number;
  positions: InvestmentSummary[];
}

/**
 * Positions by head office, cities in name order, and apart from them the positions whose company
 * has none recorded: those are listed, never placed.
 */
export function placePositions(items: readonly InvestmentSummary[]): {
  sites: Site[];
  unplaced: InvestmentSummary[];
} {
  const sites = new Map<string, Site>();
  const unplaced: InvestmentSummary[] = [];
  for (const position of items) {
    const hq = position.hq;
    if (hq === null) {
      unplaced.push(position);
      continue;
    }
    const key = `${hq.country}|${hq.city}|${hq.latitude}|${hq.longitude}`;
    const site = sites.get(key);
    if (site !== undefined) site.positions.push(position);
    else
      sites.set(key, {
        key,
        city: hq.city,
        country: hq.country,
        longitude: hq.longitude,
        latitude: hq.latitude,
        ...project(hq.longitude, hq.latitude),
        positions: [position],
      });
  }
  const name = byText((p: InvestmentSummary) => p.companyName);
  for (const site of sites.values()) site.positions.sort(name);
  return {
    sites: [...sites.values()].sort(byText((s) => `${s.city}|${s.key}`)),
    unplaced: unplaced.sort(name),
  };
}

/* ---- Markers ---- */

/** What is drawn: one city, or several too close to tell apart at this zoom. */
export interface Marker {
  key: string;
  x: number;
  y: number;
  sites: Site[];
  /** Positions under the marker. */
  count: number;
  /** The deal types under it, in code order: one means the marker takes that type's colour. */
  dealTypes: string[];
}

/** How close two cities may be on screen, in pixels, before they share a marker. */
const CLUSTER_DISTANCE = 26;

/**
 * Cities within reach of each other on screen become one marker, placed at the centre of its
 * positions. `scale` is how many pixels one unit of the frame takes (the zoom, times the drawn
 * width over the frame's). The busiest city claims its neighbours first, ties broken by key, so
 * the same sites give the same markers in any order.
 */
export function clusterSites(sites: readonly Site[], scale: number): Marker[] {
  const reach = CLUSTER_DISTANCE / scale;
  const order = [...sites].sort(
    (a, b) => b.positions.length - a.positions.length || byText((s: Site) => s.key)(a, b),
  );
  const groups: { x: number; y: number; count: number; sites: Site[] }[] = [];
  for (const site of order) {
    const home = groups.find((g) => Math.hypot(g.x - site.x, g.y - site.y) <= reach);
    if (home === undefined) {
      groups.push({ x: site.x, y: site.y, count: site.positions.length, sites: [site] });
      continue;
    }
    const total = home.count + site.positions.length;
    home.x = (home.x * home.count + site.x * site.positions.length) / total;
    home.y = (home.y * home.count + site.y * site.positions.length) / total;
    home.count = total;
    home.sites.push(site);
  }
  return groups
    .map((g) => {
      const members = [...g.sites].sort(byText((s) => `${s.city}|${s.key}`));
      return {
        key: members.map((s) => s.key).join('+'),
        x: g.x,
        y: g.y,
        sites: members,
        count: g.count,
        dealTypes: [...new Set(members.flatMap((s) => s.positions.map((p) => p.dealType)))].sort(),
      };
    })
    .sort((a, b) => a.x - b.x || a.y - b.y || byText((m: Marker) => m.key)(a, b));
}

/** A marker's radius in pixels: it grows with the square root of its positions, to a cap. */
export function markerRadius(count: number): number {
  return Math.min(5.5 + 3 * Math.sqrt(Math.max(count, 1)), 20);
}

/**
 * The zoom the markers are worked out at: the nearest half step of doubling, so a flight regroups
 * the cities a few times on its way and not on every frame.
 */
export function steppedZoom(zoom: number): number {
  return Math.pow(2, Math.round(Math.log2(Math.max(zoom, 1)) * 2) / 2);
}

let regionNames: Intl.DisplayNames | undefined;

/** "United States" for US; the code itself when the browser has no name for it. */
export function countryName(code: string): string {
  regionNames ??= new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** "1 city", "3 cities". */
export const citiesText = (count: number): string => (count === 1 ? '1 city' : `${count} cities`);

export const siteLabel = (site: Pick<Site, 'city' | 'country'>): string =>
  `${site.city}, ${countryName(site.country)}`;

/** The marker in words: its city, or how many cities, and its positions. */
export function markerLabel(marker: Marker): string {
  const positions = plural(marker.count, 'position');
  const only = marker.sites.length === 1 ? marker.sites[0] : undefined;
  return only === undefined
    ? `${citiesText(marker.sites.length)}, ${positions}`
    : `${siteLabel(only)}: ${positions}`;
}

/** The order a tour visits places in: west to east, as they are drawn. */
export function tourOrder<T extends { x: number; y: number }>(places: readonly T[]): T[] {
  return [...places].sort((a, b) => a.x - b.x || a.y - b.y);
}

/* ---- The view ---- */

/** What part of the map is on screen: a zoom and the point at the centre, in the frame's units. */
export interface View {
  k: number;
  x: number;
  y: number;
}

export const MAX_ZOOM = 14;
export const WORLD_VIEW: View = { k: 1, x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };

const within = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/** The same view, kept inside the zoom limits and inside the map. */
export function clampView(view: View): View {
  const k = within(view.k, 1, MAX_ZOOM);
  const halfW = MAP_WIDTH / k / 2;
  const halfH = MAP_HEIGHT / k / 2;
  return {
    k,
    x: within(view.x, halfW, MAP_WIDTH - halfW),
    y: within(view.y, halfH, MAP_HEIGHT - halfH),
  };
}

export function viewBox(view: View): { x: number; y: number; width: number; height: number } {
  const width = MAP_WIDTH / view.k;
  const height = MAP_HEIGHT / view.k;
  return { x: view.x - width / 2, y: view.y - height / 2, width, height };
}

/** Zooms by a factor about a point of the map, which keeps its place on the screen. */
export function zoomAbout(view: View, factor: number, at?: { x: number; y: number }): View {
  const k = within(view.k * factor, 1, MAX_ZOOM);
  const point = at ?? { x: view.x, y: view.y };
  const ratio = view.k / k;
  return clampView({
    k,
    x: point.x + (view.x - point.x) * ratio,
    y: point.y + (view.y - point.y) * ratio,
  });
}

export function panBy(view: View, dx: number, dy: number): View {
  return clampView({ k: view.k, x: view.x + dx, y: view.y + dy });
}

/** How close the map comes to a single point. */
const POINT_ZOOM = 6;

/** The view that shows every point with room around it; one point is shown close, none is the world. */
export function fitPoints(points: readonly { x: number; y: number }[], margin = 0.35): View {
  if (points.length === 0) return WORLD_VIEW;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [minX, maxX] = [Math.min(...xs), Math.max(...xs)];
  const [minY, maxY] = [Math.min(...ys), Math.max(...ys)];
  const spanX = (maxX - minX) * (1 + 2 * margin);
  const spanY = (maxY - minY) * (1 + 2 * margin);
  const k =
    spanX === 0 && spanY === 0
      ? POINT_ZOOM
      : Math.min(MAP_WIDTH / Math.max(spanX, 1e-9), MAP_HEIGHT / Math.max(spanY, 1e-9));
  return clampView({ k: Math.min(k, MAX_ZOOM), x: (minX + maxX) / 2, y: (minY + maxY) / 2 });
}

/** Parts of the world to jump to: west, south, east and north edges in degrees. */
export const REGIONS: readonly {
  key: string;
  label: string;
  bounds: readonly [west: number, south: number, east: number, north: number] | null;
}[] = [
  { key: 'world', label: 'World', bounds: null },
  { key: 'north_america', label: 'North America', bounds: [-128, 22, -62, 54] },
  { key: 'europe', label: 'Europe', bounds: [-12, 35, 32, 62] },
  { key: 'asia_pacific', label: 'Asia Pacific', bounds: [66, -42, 178, 44] },
];

export function regionView(key: string): View {
  const bounds = REGIONS.find((r) => r.key === key)?.bounds ?? null;
  if (bounds === null) return WORLD_VIEW;
  const [west, south, east, north] = bounds;
  return fitPoints([project(west, north), project(east, south)], 0);
}

/**
 * The view a share of the way from one to another, for the flight between them: the centre moves
 * in a straight line and the zoom changes by ratio, so each moment of the flight zooms as much
 * as the last.
 */
export function tweenView(from: View, to: View, t: number): View {
  if (t <= 0) return from;
  if (t >= 1) return to;
  return {
    k: from.k * Math.pow(to.k / from.k, t),
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  };
}
