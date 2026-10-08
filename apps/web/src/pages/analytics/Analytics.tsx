import type { ReactNode } from 'react';
import { Outlet } from '@tanstack/react-router';
import { ANALYTICS_TABS } from '../../app/nav.js';
import { ClientLookThrough } from '../../components/ClientLookThrough.js';
import { PageHeader, TabNav } from '../../components/ui.js';

export { ExposureTab } from './ExposureTab.js';
export { PerformanceAnalyticsTab } from './PerformanceTab.js';
export { CreditTab } from './CreditTab.js';
export { RealizationsTab } from './RealizationsTab.js';

export function AnalyticsLayout(): ReactNode {
  return (
    <>
      <PageHeader
        title="Analytics"
        meta="Exposure, performance, credit, realizations and client views"
      />
      <TabNav label="Analytics" items={ANALYTICS_TABS} />
      <Outlet />
    </>
  );
}

/** The client look-through is shared with Reporting and built there; Analytics renders the same component. */
export function ClientAnalyticsTab(): ReactNode {
  return <ClientLookThrough />;
}
