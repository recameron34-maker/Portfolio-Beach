import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function DocumentsPage(): ReactNode {
  return <PhasePage title="Documents" phase="Phase 2" modules="M3 document hub, M4 extraction" />;
}
