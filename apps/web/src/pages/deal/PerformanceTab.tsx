import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function PerformanceTab(): ReactNode {
  return <PhasePage title="Performance" phase="this build" modules="M9 quarterly series" />;
}
