import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function CapitalTab(): ReactNode {
  return (
    <PhasePage title="Capital activity" phase="this build" modules="M16 notices and cash flows" />
  );
}
