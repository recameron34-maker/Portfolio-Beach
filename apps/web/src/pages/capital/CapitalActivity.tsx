import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function CapitalActivityPage(): ReactNode {
  return <PhasePage title="Capital Activity" phase="this build" modules="M16 notices" />;
}

export function CapitalNoticePage(): ReactNode {
  return <PhasePage title="Capital notice" phase="this build" modules="M16 notice detail" />;
}

export function CommitmentsPage(): ReactNode {
  return (
    <PhasePage title="Commitments" phase="this build" modules="M17 commitments and unfunded" />
  );
}
