import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { Outlet, useSearch } from '@tanstack/react-router';
import { ANALYTICS_TABS } from '../../app/nav.js';
import { ClientLookThrough } from '../../components/ClientLookThrough.js';
import { PageHeader, PageSkeleton, TabNav } from '../../components/ui.js';
import { parseValueCreationSearch, valueCreationSearch } from './value-creation-filters.js';
import './analytics.css';

export { ExposureTab } from './ExposureTab.js';
export { PerformanceAnalyticsTab } from './PerformanceTab.js';
export { CreditTab } from './CreditTab.js';
export { RealizationsTab } from './RealizationsTab.js';

/*
 * The Value creation and Entry metrics tabs load on demand, as one chunk: they are the only
 * pages that roll figures up in the browser, so the calculation library's roll-up and IRR solver
 * (@pb/calc) come with them and stay out of the entry chunk every other page loads.
 */
const LazyValueCreationTab = lazy(async () => ({
  default: (await import('./value-creation-tabs.js')).ValueCreationTab,
}));
const LazyEntryMetricsTab = lazy(async () => ({
  default: (await import('./value-creation-tabs.js')).EntryMetricsTab,
}));

export function ValueCreationTab(): ReactNode {
  return (
    <Suspense fallback={<PageSkeleton tiles={5} rows={6} />}>
      <LazyValueCreationTab />
    </Suspense>
  );
}

export function EntryMetricsTab(): ReactNode {
  return (
    <Suspense fallback={<PageSkeleton rows={8} />}>
      <LazyEntryMetricsTab />
    </Suspense>
  );
}

/* The co-investment map loads on demand too: the world's outline comes with it and nowhere else. */
const LazyMapTab = lazy(async () => ({ default: (await import('./map/MapTab.js')).MapTab }));

export function MapTab(): ReactNode {
  return (
    <Suspense fallback={<PageSkeleton tiles={4} rows={6} />}>
      <LazyMapTab />
    </Suspense>
  );
}

/** The two tabs that share the value creation filters: a filter set on one carries to the other. */
const FILTERED_TABS: readonly string[] = ['/analytics/value-creation', '/analytics/entry-metrics'];

export function AnalyticsLayout(): ReactNode {
  const search: Record<string, unknown> = useSearch({ strict: false });
  const filters = valueCreationSearch(parseValueCreationSearch(search));
  const items = ANALYTICS_TABS.map((tab) =>
    FILTERED_TABS.includes(tab.to) ? { ...tab, search: filters } : tab,
  );
  return (
    <>
      <PageHeader title="Analytics" />
      <TabNav label="Analytics" items={items} className="pb-analytics-tabs" />
      <Outlet />
    </>
  );
}

/** The client look-through is shared with Reporting and built there; Analytics renders the same component. */
export function ClientAnalyticsTab(): ReactNode {
  return <ClientLookThrough />;
}
