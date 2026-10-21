import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { RegisteredRouter } from '@tanstack/react-router';
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

/**
 * An in-app link to a document hub page (a document, an extraction run) by its path. The hub's
 * pages are routed by the Documents group; the deal tabs link to them by href so the router
 * resolves the page whichever build of the hub ships with it (hash history in the preview, the
 * browser history elsewhere), and the tabs never carry a route the hub does not own.
 */
export function HubLink({
  href,
  className,
  testId,
  children,
}: {
  href: string;
  className?: string | undefined;
  testId?: string | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <Link<RegisteredRouter, string, string>
      href={href}
      {...(className === undefined ? {} : { className })}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      {children}
    </Link>
  );
}
