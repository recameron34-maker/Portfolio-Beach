import type { ReactNode } from 'react';
import { Badge } from '../../components/ui.js';
import { formatDate, labelOf } from '../../lib/format.js';
import { isApproved } from './data.js';
import './deal.css';

/** A period-end date, optionally marked as the entry snapshot. */
export function PeriodCell({
  periodEnd,
  entry = false,
}: {
  periodEnd: string;
  entry?: boolean;
}): ReactNode {
  return (
    <span className="pb-deal-period">
      <span className="pb-nowrap">{formatDate(periodEnd)}</span>
      {entry ? <Badge tone="brand">Entry</Badge> : null}
    </span>
  );
}

/** Record status of a quarterly row in words: approved reads good, anything still in review reads watch. */
export function RecordStatusBadge({ status }: { status: string }): ReactNode {
  return <Badge tone={isApproved(status) ? 'good' : 'watch'}>{labelOf(status)}</Badge>;
}
