import type { MouseEvent, ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import type { RegisteredRouter } from '@tanstack/react-router';
import { Badge } from '../../components/ui.js';
import { formatDate, labelOf } from '../../lib/format.js';
import { isApproved } from './data.js';
import './deal.css';

/**
 * A period-end date, optionally marked as the entry snapshot: "Entry" follows the date in muted
 * words, set apart by a margin rather than a space, so the cell still reads "Sep 30, 2018Entry".
 */
export function PeriodCell({
  periodEnd,
  entry = false,
}: {
  periodEnd: string;
  entry?: boolean;
}): ReactNode {
  return (
    <span className="pb-nowrap">
      {formatDate(periodEnd)}
      {entry ? <span className="pb-deal-entry-mark">Entry</span> : null}
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

/**
 * A row of links to the sections of a long tab ("On this tab"). The router owns the address's
 * fragment (the preview routes by it), so a link scrolls its section into view and moves focus
 * to it without touching the address, as "Skip to content" does. Never a smooth scroll.
 */
export function JumpLinks({
  items,
}: {
  items: readonly { id: string; label: string }[];
}): ReactNode {
  const jump = (event: MouseEvent<HTMLAnchorElement>, id: string): void => {
    event.preventDefault();
    const target = document.getElementById(id);
    if (target === null) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
  };
  return (
    <nav className="pb-deal-jump" aria-label="On this tab">
      <span className="pb-deal-jump-label" aria-hidden="true">
        On this tab
      </span>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <a href={`#${item.id}`} onClick={(event) => jump(event, item.id)}>
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
