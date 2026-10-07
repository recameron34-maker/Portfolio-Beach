import type { ReactNode } from 'react';
import { Outlet } from '@tanstack/react-router';
import { ANALYTICS_TABS } from '../../app/nav.js';
import { PageHeader, PhasePage, TabNav } from '../../components/ui.js';

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

export function ExposureTab(): ReactNode {
  return <PhasePage title="Exposure" phase="this build" modules="M13 exposures" />;
}

export function PerformanceAnalyticsTab(): ReactNode {
  return <PhasePage title="Performance" phase="this build" modules="M13 performance" />;
}

export function CreditTab(): ReactNode {
  return <PhasePage title="Credit book" phase="this build" modules="M13 credit" />;
}

export function RealizationsTab(): ReactNode {
  return <PhasePage title="Realizations" phase="this build" modules="M13 realizations" />;
}

export function ClientAnalyticsTab(): ReactNode {
  return <PhasePage title="Clients" phase="this build" modules="M14 client exposures" />;
}
