import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Spinner } from '@fluentui/react-components';
import type { AuditEventRow } from '@pb/contracts';
import { auditQuery, capitalNoticesQuery, meQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  PageSkeleton,
  SectionHeader,
  TableWrap,
} from '../../components/ui.js';
import { formatDate, formatDateTime } from '../../lib/format.js';
import { canReadAudit, TIMELINE_LIMIT, timelineEntries, useDealDetail, useDealId } from './data.js';
import './deal.css';

const AUDIT_AUDIENCE =
  'The audit trail is available to operations, approvers, auditors and platform admins.';

function AuditTable({ items }: { items: AuditEventRow[] }): ReactNode {
  return (
    <TableWrap label="Audit trail for this record">
      <table className="pb-table" aria-label="Audit trail for this record">
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              <td className="pb-nowrap">{formatDateTime(e.at)}</td>
              <td>
                {e.actorName ?? (
                  <Badge plain tone="neutral">
                    {e.actorType}
                  </Badge>
                )}
              </td>
              <td>
                <span className="pb-key">{e.action}</span>
              </td>
              <td>{e.reason ?? <span className="pb-meta">none given</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/** The audit events whose subject is this position (SEC-11.1), for the roles the audit route admits. */
function AuditCard({ id }: { id: string }): ReactNode {
  const me = useQuery(meQuery);
  const allowed = me.data !== undefined && canReadAudit(me.data.roles);
  const q = useQuery({ ...auditQuery({ entityId: id }), enabled: allowed });
  let body: ReactNode;
  if (me.isPending) {
    body = <Spinner size="tiny" label="Checking your roles" />;
  } else if (!allowed) {
    body = <p className="pb-meta">{AUDIT_AUDIENCE}</p>;
  } else if (q.isPending) {
    body = <Spinner size="tiny" label="Loading the audit trail" />;
  } else if (q.isLoadingError) {
    body = (
      <UnavailableState
        inline
        error={q.error}
        subject="The audit trail"
        forbidden={{
          title: AUDIT_AUDIENCE,
          detail: 'Row-level security and the API both enforce it (SEC-5.1).',
        }}
        notReady={{ title: 'The audit trail is not available yet' }}
        testId="deal-audit-unavailable"
      />
    );
  } else if (q.data.items.length === 0) {
    body = (
      <EmptyState
        title="No audit events yet"
        detail="Every read of this position's sensitive figures and every change to it is recorded here."
      />
    );
  } else {
    body = (
      <>
        <AuditTable items={q.data.items} />
        <p className="pb-meta pb-deal-note">
          <Link to="/admin/audit">Open the audit trail</Link> for every record.
        </p>
      </>
    );
  }
  const data = allowed ? q.data : undefined;
  return (
    <Card testId="deal-audit">
      <SectionHeader
        aside={
          data === undefined
            ? undefined
            : data.nextCursor === null
              ? `${data.items.length} ${data.items.length === 1 ? 'event' : 'events'}, newest first`
              : `Latest ${data.items.length} events; older events exist`
        }
      >
        Audit trail for this record
      </SectionHeader>
      {body}
    </Card>
  );
}

/**
 * Activity tab: a timeline built only from what the user can already open (cash flows, valuation
 * versions and capital notices), then the audit trail for the roles allowed to read it.
 */
export function ActivityTab(): ReactNode {
  const id = useDealId();
  const detail = useDealDetail();
  const notices = useQuery(capitalNoticesQuery({ investmentId: id }));
  const d = detail.data;
  if (d === undefined) return detail.isPending ? <PageSkeleton rows={8} /> : null;
  const entries = timelineEntries(d, notices.data?.items ?? []);
  const shown = entries.slice(0, TIMELINE_LIMIT);
  return (
    <>
      <Card testId="deal-timeline">
        <SectionHeader aside="Newest first, from records you can open">Timeline</SectionHeader>
        {shown.length === 0 ? (
          <EmptyState
            title="Nothing recorded yet"
            detail="Cash flows, valuation versions and capital notices for this position appear here as they happen."
          />
        ) : (
          <ol className="pb-list pb-deal-timeline" aria-label="Activity timeline">
            {shown.map((e) => (
              <li key={e.key}>
                <time className="pb-deal-timeline-date" dateTime={e.date}>
                  {formatDate(e.date)}
                </time>
                <span>
                  <Badge plain>{e.kind}</Badge>
                </span>
                <span className="pb-deal-timeline-text">{e.text}</span>
              </li>
            ))}
          </ol>
        )}
        {entries.length > TIMELINE_LIMIT ? (
          <p className="pb-meta pb-deal-note">
            Showing the latest {TIMELINE_LIMIT} of {entries.length} entries.
          </p>
        ) : null}
        {notices.isPending ? (
          <div className="pb-deal-gap">
            <Spinner size="tiny" label="Loading capital notices" />
          </div>
        ) : null}
        {notices.isLoadingError ? (
          <div className="pb-deal-gap">
            <UnavailableState
              inline
              error={notices.error}
              subject="Capital notices"
              notReady={{
                title: 'Capital notices are not in this timeline yet',
                detail:
                  'The notices list is not built in this version, so the timeline shows cash flows and valuation versions only.',
              }}
              forbidden={{
                title: 'Capital notices are not visible to your role',
                detail: 'The timeline shows cash flows and valuation versions only.',
              }}
              testId="deal-timeline-notices-unavailable"
            />
          </div>
        ) : null}
      </Card>
      <AuditCard id={id} />
    </>
  );
}
