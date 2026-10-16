import type { ReactNode } from 'react';
import { dealStageMachine } from '@pb/workflows';
import { PhasePage } from '../../components/ui.js';
import { WorkflowSpec } from '../../components/WorkflowSpec.js';
import './deal.css';

/* Tabs whose modules land in later phases (docs/09). Each says what arrives and from which module. */

function Arrives({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="pb-prose pb-deal-gap">
      <p>{children}</p>
    </div>
  );
}

export function DiligenceTab(): ReactNode {
  return (
    <>
      <PhasePage title="Diligence" phase="Phase 5" modules="M7 diligence and IC">
        <Arrives>
          M7 brings diligence checklists by deal type, with owners, due dates and the IC gate that
          holds a deal until every required task is done. IC memo sections and prescreen decks
          arrive as drafts marked AI draft until a person approves them, and IC decisions are
          recorded here with their conditions.
        </Arrives>
      </PhasePage>
      <WorkflowSpec
        machine={dealStageMachine}
        title="Deal stages"
        detail="The stages this deal moves through, with the IC gate that diligence feeds."
      />
    </>
  );
}

export function ClosingTab(): ReactNode {
  return (
    <PhasePage title="Closing" phase="Phase 3" modules="M8 closing">
      <Arrives>
        M8 brings the closing checklist (signed documents, funds flow, consents) and the close date
        that operations confirm and every report reads. Wire instructions are verified by callback
        before funding, and the allocation across vehicles is tied out before the deal closes.
      </Arrives>
    </PhasePage>
  );
}

export function TasksTab(): ReactNode {
  return (
    <PhasePage title="Tasks" phase="Phase 6" modules="M15 tasks and approvals">
      <Arrives>
        M15 brings the tasks for this position from the task tool, with owners, due dates and
        reminders. Approvals waiting on you, such as valuation sign-offs and trade tickets, appear
        alongside them.
      </Arrives>
    </PhasePage>
  );
}
