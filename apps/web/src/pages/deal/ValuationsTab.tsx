import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function ValuationsTab(): ReactNode {
  return <PhasePage title="Valuations" phase="this build" modules="M10 valuation versions" />;
}
