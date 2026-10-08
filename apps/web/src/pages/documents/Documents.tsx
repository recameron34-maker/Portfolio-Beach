import type { ReactNode } from 'react';
import { documentClassificationMachine, extractionRunMachine } from '@pb/workflows';
import { PhasePage } from '../../components/ui.js';
import { WorkflowSpec } from '../../components/WorkflowSpec.js';

export function DocumentsPage(): ReactNode {
  return (
    <>
      <PhasePage title="Documents" phase="Phase 2" modules="M3 document hub, M4 extraction" />
      <WorkflowSpec
        machine={documentClassificationMachine}
        title="Document classification"
        detail="Each document is tagged by the classifier; anything below the confidence threshold waits in a review queue for a person."
      />
      <WorkflowSpec
        machine={extractionRunMachine}
        title="Extraction runs"
        detail="Each extraction of quarterly figures runs under a retry budget; a failure surfaces as a data exception, never as a guessed number."
      />
    </>
  );
}
