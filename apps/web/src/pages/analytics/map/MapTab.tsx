import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Dropdown, Label, Option } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { InvestmentSummary } from '@pb/contracts';
import { investmentsQuery } from '../../../app/queries.js';
import { UnavailableState } from '../../../components/UnavailableState.js';
import {
  Badge,
  Card,
  CountTile,
  EmptyState,
  Field,
  NumCell,
  PageSkeleton,
  SectionHeader,
  TableWrap,
  Toolbar,
} from '../../../components/ui.js';
import { formatDate, formatMoic, formatMoneyM, labelOf, plural } from '../../../lib/format.js';
import { WorldMap } from './WorldMap.js';
import {
  DEFAULT_FILTERS,
  MAP_DEAL_TYPES,
  REGIONS,
  WORLD_VIEW,
  citiesText,
  filterPositions,
  fitPoints,
  placePositions,
  regionView,
  siteLabel,
  tourOrder,
} from './map-model.js';
import type { MapFilters, MapStatus, Site } from './map-model.js';
import { useMapView, usePrefersReducedMotion } from './use-map-view.js';
import { WORLD_SOURCE } from './world.js';
import './map.css';

/** One page of every position the reader may see; the map picks its own out of it. */
const POSITIONS = { limit: 200 };

/** Marker colours by deal type, from the chart series (config/brand.json). */
const COLOURS: Readonly<Record<string, string>> = {
  'deal_type.co_invest_equity': 'var(--pb-chart-1)',
  'deal_type.cv_single_asset': 'var(--pb-chart-2)',
};

const STATUSES: readonly { key: MapStatus; label: string }[] = [
  { key: 'held', label: 'Held' },
  { key: 'realized', label: 'Realized' },
  { key: 'all', label: 'All' },
];

/** How long the tour rests on each city, and how long the flight there takes. */
const TOUR_REST = 3000;
const TOUR_FLIGHT = 1300;
/** How close the tour and "Show on map" come to one city. */
const CITY_ZOOM = 5;

const distinct = (values: readonly (string | null)[]): string[] =>
  [...new Set(values.filter((v): v is string => v !== null))].sort((a, b) => a.localeCompare(b));

function PositionLine({ position }: { position: InvestmentSummary }): ReactNode {
  return (
    <li className="pb-map-position">
      <Link to="/portfolio/$id" params={{ id: position.id }} className="pb-map-position-name">
        {position.companyName}
      </Link>
      <span className="pb-map-position-meta">
        {position.sponsorName}, {position.vehicleName}
      </span>
      <span className="pb-map-position-figures">
        <Badge tone="neutral" plain>
          {labelOf(position.dealType)}
        </Badge>
        <span>
          NAV <strong>{formatMoneyM(position.nav)}</strong>
        </span>
        <span>
          MOIC <strong>{formatMoic(position.grossMoic)}</strong>
        </span>
      </span>
    </li>
  );
}

function SelectionPanel({ sites }: { sites: readonly Site[] }): ReactNode {
  if (sites.length === 0)
    return (
      <p className="pb-map-panel-empty" data-testid="map-panel-empty">
        Choose a marker, or a row of the table, to see the positions headquartered there.
      </p>
    );
  return (
    <div data-testid="map-panel" aria-live="polite">
      {sites.map((site) => (
        <section key={site.key} className="pb-map-panel-site">
          <h3>
            {siteLabel(site)}
            <span className="pb-map-panel-count">{plural(site.positions.length, 'position')}</span>
          </h3>
          <ul>
            {site.positions.map((p) => (
              <PositionLine key={p.id} position={p} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function MapTab(): ReactNode {
  const page = useQuery(investmentsQuery(POSITIONS));
  const reduced = usePrefersReducedMotion();
  const map = useMapView(reduced);
  const { flyTo } = map;
  const [filters, setFilters] = useState<MapFilters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  /** The tour's place in its list of cities, or null when it is not playing. */
  const [tourAt, setTourAt] = useState<number | null>(null);

  const items = page.data?.items;
  const { sites, unplaced, shown, vehicles, sectors } = useMemo(() => {
    const all = (items ?? []).filter((p) => MAP_DEAL_TYPES.includes(p.dealType));
    const passing = filterPositions(items ?? [], filters);
    return {
      ...placePositions(passing),
      shown: passing,
      vehicles: distinct(all.map((p) => p.vehicleName)),
      sectors: distinct(all.map((p) => p.sector)),
    };
  }, [items, filters]);
  const stops = useMemo(() => tourOrder(sites), [sites]);

  /*
   * The tour: fly to each city in turn, west to east, then back out to the world. A visit is made
   * by the reader's click or by the timer below, never by an effect setting state as it runs.
   */
  const visit = useCallback(
    (index: number): void => {
      const stop = stops[index];
      if (stop === undefined) {
        setTourAt(null);
        setSelected([]);
        flyTo(WORLD_VIEW, TOUR_FLIGHT);
        return;
      }
      setTourAt(index);
      setSelected([stop.key]);
      flyTo({ k: CITY_ZOOM, x: stop.x, y: stop.y }, TOUR_FLIGHT);
    },
    [stops, flyTo],
  );
  const stopTour = useCallback((): void => setTourAt(null), []);
  useEffect(() => {
    if (tourAt === null) return;
    const timer = window.setTimeout(() => visit(tourAt + 1), TOUR_REST);
    return () => window.clearTimeout(timer);
  }, [tourAt, visit]);

  if (page.isPending) return <PageSkeleton tiles={4} rows={6} />;
  if (page.isError)
    return <UnavailableState card error={page.error} subject="The co-investment map" />;

  const partial = page.data.nextCursor !== null;
  const change = (patch: Partial<MapFilters>): void => {
    stopTour();
    setSelected([]);
    setFilters((f) => ({ ...f, ...patch }));
  };
  const toggleType = (type: string): void =>
    change({
      dealTypes: filters.dealTypes.includes(type)
        ? filters.dealTypes.filter((t) => t !== type)
        : MAP_DEAL_TYPES.filter((t) => t === type || filters.dealTypes.includes(t)),
    });

  const choose = (chosen: readonly Site[]): void => {
    setSelected(chosen.map((s) => s.key));
    if (chosen.length === 0) return;
    // One city: come closer to it. Several under one marker: open them out.
    const [only] = chosen;
    if (chosen.length === 1 && only !== undefined)
      flyTo({ k: Math.max(map.target().k, CITY_ZOOM - 1), x: only.x, y: only.y });
    else flyTo(fitPoints(chosen));
  };
  const showOnMap = (site: Site): void => {
    stopTour();
    setSelected([site.key]);
    flyTo({ k: CITY_ZOOM, x: site.x, y: site.y }, 900);
  };

  const siteOf = new Map(sites.flatMap((s) => s.positions.map((p) => [p.id, s] as const)));
  const selectedSites = sites.filter((s) => selected.includes(s.key));
  const countries = new Set(sites.map((s) => s.country)).size;
  const placed = shown.length - unplaced.length;

  return (
    <>
      <div className="pb-tiles" data-testid="map-tiles">
        <CountTile
          label="Positions on the map"
          count={placed}
          hint="Co-investments and single-asset CVs with a head office recorded"
          partial={partial}
        />
        <CountTile label="Cities" count={sites.length} hint="Head offices" partial={partial} />
        <CountTile label="Countries" count={countries} hint="Where they sit" partial={partial} />
        <CountTile
          label="No head office recorded"
          count={unplaced.length}
          hint="Listed below the map, never placed by a guess"
          tone={unplaced.length > 0 ? 'watch' : undefined}
          partial={partial}
        />
      </div>

      <Card testId="map-card">
        <SectionHeader aside={`As of ${formatDate(page.data.asOf)}`}>
          Co-investment map
        </SectionHeader>
        <Toolbar
          end={
            <div className="pb-map-jump" role="group" aria-label="Jump to a region">
              {REGIONS.map((region) => (
                <button
                  key={region.key}
                  type="button"
                  className="pb-map-chip"
                  onClick={() => {
                    stopTour();
                    flyTo(regionView(region.key), 900);
                  }}
                >
                  {region.label}
                </button>
              ))}
              <button
                type="button"
                className={`pb-map-chip pb-map-tour${tourAt !== null ? ' is-on' : ''}`}
                aria-pressed={tourAt !== null}
                disabled={stops.length === 0}
                onClick={() => (tourAt === null ? visit(0) : stopTour())}
              >
                {tourAt === null ? 'Play tour' : 'Stop tour'}
              </button>
            </div>
          }
        >
          <Field>
            <span className="pb-map-field-label" id="map-deal-types">
              Deal type
            </span>
            <div className="pb-map-toggles" role="group" aria-labelledby="map-deal-types">
              {MAP_DEAL_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className="pb-map-chip"
                  aria-pressed={filters.dealTypes.includes(type)}
                  onClick={() => toggleType(type)}
                >
                  <span
                    className="pb-map-swatch"
                    style={{ background: COLOURS[type] }}
                    aria-hidden="true"
                  />
                  {labelOf(type)}
                </button>
              ))}
            </div>
          </Field>
          <Field>
            <span className="pb-map-field-label" id="map-status">
              Status
            </span>
            <div className="pb-map-toggles" role="group" aria-labelledby="map-status">
              {STATUSES.map((status) => (
                <button
                  key={status.key}
                  type="button"
                  className="pb-map-chip"
                  aria-pressed={filters.status === status.key}
                  onClick={() => change({ status: status.key })}
                >
                  {status.label}
                </button>
              ))}
            </div>
          </Field>
          <Field>
            <Label htmlFor="map-vehicle">Vehicle</Label>
            <Dropdown
              id="map-vehicle"
              value={filters.vehicle === '' ? 'All vehicles' : filters.vehicle}
              selectedOptions={[filters.vehicle]}
              onOptionSelect={(_e, d) => change({ vehicle: d.optionValue ?? '' })}
            >
              <Option value="">All vehicles</Option>
              {vehicles.map((v) => (
                <Option key={v} value={v}>
                  {v}
                </Option>
              ))}
            </Dropdown>
          </Field>
          <Field>
            <Label htmlFor="map-sector">Sector</Label>
            <Dropdown
              id="map-sector"
              value={filters.sector === '' ? 'All sectors' : labelOf(filters.sector)}
              selectedOptions={[filters.sector]}
              onOptionSelect={(_e, d) => change({ sector: d.optionValue ?? '' })}
            >
              <Option value="">All sectors</Option>
              {sectors.map((s) => (
                <Option key={s} value={s} text={labelOf(s)}>
                  {labelOf(s)}
                </Option>
              ))}
            </Dropdown>
          </Field>
        </Toolbar>

        <div className="pb-map-layout">
          <WorldMap
            sites={sites}
            selected={selected}
            onSelect={choose}
            highlighted={highlighted}
            map={map}
            reduced={reduced}
            colours={COLOURS}
            onInteract={stopTour}
          />
          <aside className="pb-map-panel" aria-label="Positions at the chosen marker">
            <SelectionPanel sites={selectedSites} />
          </aside>
        </div>
        {partial ? (
          <p className="pb-meta" data-testid="map-truncated">
            Showing the first {POSITIONS.limit} positions; more exist.
          </p>
        ) : null}
        <p className="pb-map-credit">Outline: {WORLD_SOURCE}.</p>
      </Card>

      <Card testId="map-positions">
        <SectionHeader aside={`${plural(placed, 'position')} in ${citiesText(sites.length)}`}>
          Positions on the map
        </SectionHeader>
        {placed === 0 ? (
          <EmptyState
            title="No positions to place"
            detail={
              shown.length === 0
                ? 'No co-investment or single-asset CV matches these filters.'
                : 'None of the positions shown has a head office recorded.'
            }
            testId="map-empty"
          />
        ) : (
          <TableWrap label="Positions on the map">
            <table className="pb-table" aria-label="Positions on the map">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Head office</th>
                  <th>Sponsor</th>
                  <th>Vehicle</th>
                  <th>Deal type</th>
                  <th className="pb-num">NAV</th>
                  <th className="pb-num">Gross MOIC</th>
                  <th>Map</th>
                </tr>
              </thead>
              <tbody>
                {shown
                  .filter((p) => p.hq !== null)
                  .map((p) => {
                    const site = siteOf.get(p.id);
                    return (
                      <tr
                        key={p.id}
                        className={
                          site !== undefined && selected.includes(site.key) ? 'is-selected' : ''
                        }
                        onPointerEnter={() => setHighlighted(site?.key ?? null)}
                        onPointerLeave={() => setHighlighted(null)}
                      >
                        <td>
                          <Link to="/portfolio/$id" params={{ id: p.id }}>
                            {p.companyName}
                          </Link>
                          <span className="pb-cell-sub">{p.investmentNumber}</span>
                        </td>
                        <td>{site === undefined ? null : siteLabel(site)}</td>
                        <td>{p.sponsorName}</td>
                        <td>{p.vehicleName}</td>
                        <td>{labelOf(p.dealType)}</td>
                        <NumCell>{formatMoneyM(p.nav)}</NumCell>
                        <NumCell>{formatMoic(p.grossMoic)}</NumCell>
                        <td>
                          {site === undefined ? null : (
                            <button
                              type="button"
                              className="pb-map-show"
                              aria-label={`Show ${p.companyName} on the map`}
                              onClick={() => showOnMap(site)}
                            >
                              Show
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      {unplaced.length > 0 ? (
        <Card testId="map-unplaced">
          <SectionHeader aside={plural(unplaced.length, 'position')}>
            No head office recorded
          </SectionHeader>
          <p className="pb-meta">
            These positions are not on the map: their company has no head office on record, and a
            place is never guessed.
          </p>
          <TableWrap label="Positions with no head office recorded">
            <table className="pb-table" aria-label="Positions with no head office recorded">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Sponsor</th>
                  <th>Vehicle</th>
                  <th>Deal type</th>
                  <th className="pb-num">NAV</th>
                </tr>
              </thead>
              <tbody>
                {unplaced.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to="/portfolio/$id" params={{ id: p.id }}>
                        {p.companyName}
                      </Link>
                      <span className="pb-cell-sub">{p.investmentNumber}</span>
                    </td>
                    <td>{p.sponsorName}</td>
                    <td>{p.vehicleName}</td>
                    <td>{labelOf(p.dealType)}</td>
                    <NumCell>{formatMoneyM(p.nav)}</NumCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </Card>
      ) : null}
    </>
  );
}
