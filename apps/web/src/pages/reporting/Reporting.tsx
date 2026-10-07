import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function WeeklyReportPage(): ReactNode {
  return <PhasePage title="Weekly report" phase="this build" modules="M12 weekly report" />;
}

export function ClientsPage(): ReactNode {
  return <PhasePage title="Clients" phase="this build" modules="M14 client look-through" />;
}

export function DisclosuresPage(): ReactNode {
  return (
    <PhasePage
      title="Disclosures and statistics"
      phase="Phase 4"
      modules="M19 disclosures and approved statistics"
    />
  );
}
