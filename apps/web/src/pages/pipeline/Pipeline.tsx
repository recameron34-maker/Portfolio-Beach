import type { ReactNode } from 'react';
import { dealStageMachine } from '@pb/workflows';
import { PhasePage } from '../../components/ui.js';
import { WorkflowSpec } from '../../components/WorkflowSpec.js';

export function PipelinePage(): ReactNode {
  return (
    <>
      <PhasePage title="Pipeline" phase="Phase 5" modules="M5 pipeline, M7 diligence and IC" />
      <WorkflowSpec
        machine={dealStageMachine}
        title="Deal stages"
        detail="Every deal moves from sourcing to close through these stages, with the IC gate and the closing checks in the table."
      />
    </>
  );
}
