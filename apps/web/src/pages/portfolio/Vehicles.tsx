import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function VehiclesPage(): ReactNode {
  return <PhasePage title="Vehicles" phase="this build" modules="M17 vehicles and commitments" />;
}

export function VehicleDetailPage(): ReactNode {
  return <PhasePage title="Vehicle" phase="this build" modules="M17 vehicle detail" />;
}
