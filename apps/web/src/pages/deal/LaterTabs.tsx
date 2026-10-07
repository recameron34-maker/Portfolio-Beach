import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function DocumentsTab(): ReactNode {
  return <PhasePage title="Documents" phase="Phase 2" modules="M3 document hub, M4 extraction" />;
}

export function DiligenceTab(): ReactNode {
  return <PhasePage title="Diligence" phase="Phase 5" modules="M7 diligence and IC" />;
}

export function ClosingTab(): ReactNode {
  return <PhasePage title="Closing" phase="Phase 5" modules="M8 closing" />;
}

export function TasksTab(): ReactNode {
  return <PhasePage title="Tasks" phase="Phase 1" modules="M1 tasks and exceptions" />;
}
