import type { ReactNode } from 'react';
import { PhasePage } from '../../components/ui.js';
import './deal.css';

/* Tabs whose modules land in later phases (docs/09). Each says what arrives and from which module. */

function Arrives({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="pb-prose pb-deal-gap">
      <p>{children}</p>
    </div>
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
