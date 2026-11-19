import type { ReactNode } from 'react';
import { Card, EmptyState } from '../../components/ui.js';
import './deal.css';

/*
 * Tabs whose modules land in later phases (docs/09). Each says it is not built and what it will
 * hold, in the workspace's own frame: the header and the tab bar already name the page.
 */

export function TasksTab(): ReactNode {
  return (
    <Card testId="deal-tasks">
      <EmptyState
        title="Not built yet"
        detail="This tab will list the position's tasks from the task tool, with owners, due dates and reminders, and the approvals waiting on you."
      />
    </Card>
  );
}
