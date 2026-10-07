import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function ActivityTab(): ReactNode {
  return <PhasePage title="Activity" phase="this build" modules="SEC-11 audit trail" />;
}
