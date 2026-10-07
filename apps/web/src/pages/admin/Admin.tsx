import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function AuditPage(): ReactNode {
  return <PhasePage title="Audit trail" phase="this build" modules="SEC-11 audit events" />;
}

export function AccessPage(): ReactNode {
  return <PhasePage title="Access and walls" phase="this build" modules="SEC-5 roles and walls" />;
}

export function HealthPage(): ReactNode {
  return <PhasePage title="Integration health" phase="this build" modules="docs/15 health" />;
}
