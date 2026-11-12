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
    <PhasePage title="Tasks" summary="Tasks and approvals for this position">
      <Arrives>
        This tab will bring the tasks for this position from the task tool, with owners, due dates
        and reminders. Approvals waiting on you, such as valuation sign-offs and trade tickets,
        appear alongside them.
      </Arrives>
    </PhasePage>
  );
}
