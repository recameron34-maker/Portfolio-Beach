import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';

export function PipelinePage(): ReactNode {
  return <PhasePage title="Pipeline" phase="Phase 5" modules="M5 pipeline, M7 diligence and IC" />;
}
