import type { ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AuditEventRow, WallList } from '@pb/contracts';
import { ADMIN_TABS } from '../../app/nav.js';
import {
  auditQuery,
  flagsQuery,
  healthReadyQuery,
  meQuery,
  mockUsersQuery,
  wallsQuery,
} from '../../app/queries.js';
import {
  Badge,
  Card,
  EmptyState,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  TableWrap,
  TabNav,
} from '../../components/ui.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import { formatDateTime } from '../../lib/format.js';
import { ROLE_ROWS, ROLE_SOURCE } from './roles.js';

/* ---- Audit trail (SEC-11) ---- */

function AuditTable({ items }: { items: AuditEventRow[] }): ReactNode {
  return (
    <TableWrap label="Audit events">
      <table className="pb-table" aria-label="Audit events">
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Entity</th>
            <th>Entity id</th>
            <th>Reason</th>
            <th>Request</th>
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
              <td>{e.entity}</td>
              <td>
                {e.entityId === null ? (
                  <span className="pb-meta">none</span>
                ) : (
                  <span className="pb-meta pb-truncated-id" title={e.entityId}>
                    {e.entityId.slice(0, 8)}
                  </span>
                )}
              </td>
              <td>{e.reason ?? <span className="pb-meta">none given</span>}</td>
              <td>
                <span className="pb-meta">{e.requestId ?? 'none'}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/** The append-only audit trail: who, what, when and why. Values and hashes never leave the database (SEC-11.4). */
export function AuditPage(): ReactNode {
  const q = useQuery(auditQuery({}));
  return (
    <>
      <PageHeader
        title="Audit trail"
        meta="Who did what and when, newest first (SEC-11.1). Appended on every business change; never edited or deleted."
      />
      <TabNav label="Admin" items={ADMIN_TABS} />
      {q.isPending ? <PageSkeleton rows={8} /> : null}
      {q.isError ? (
        <UnavailableState
          card
          subject="The audit trail"
          error={q.error}
          forbidden={{
            title:
              'The audit trail is available to operations, approvers, auditors and platform admins',
            detail: 'Row-level security and the API both enforce it (SEC-5.1).',
          }}
          notReady={{ title: 'The audit trail is not available yet' }}
          errorTitle="Audit trail unavailable"
          testId="audit-unavailable"
        />
      ) : null}
      {q.data !== undefined ? (
        <Card>
          <SectionHeader
            aside={
              q.data.nextCursor === null
                ? `${q.data.items.length} events`
                : `latest ${q.data.items.length} events; older events exist`
            }
          >
            Events
          </SectionHeader>
          {q.data.items.length === 0 ? (
            <EmptyState
              title="No events yet"
              detail="Events appear here as soon as a business record, approval, export or flag changes."
              testId="audit-empty"
            />
          ) : (
            <AuditTable items={q.data.items} />
          )}
          <p className="pb-meta" data-testid="audit-note">
            The details payload and the before and after hashes are never shown here (SEC-11.4);
            they stay in the database for auditors with direct access.
          </p>
        </Card>
      ) : null}
    </>
  );
}

/* ---- Access and walls (SEC-5) ---- */

function WallCard({ wall }: { wall: WallList['walls'][number] }): ReactNode {
  return (
    <Card testId={`wall-${wall.id}`}>
      <SectionHeader aside={`${wall.members.length} members, ${wall.records.length} records`}>
        {wall.name}
      </SectionHeader>
      {wall.description !== null ? <p className="pb-wall-description">{wall.description}</p> : null}
      <p className="pb-meta">Members</p>
      <p className="pb-chips">
        {wall.members.length === 0 ? (
          <span className="pb-meta">No members yet</span>
        ) : (
          wall.members.map((m) => (
            <Badge key={m.userId} tone="brand">
              {m.displayName}
            </Badge>
          ))
        )}
      </p>
      <p className="pb-meta">Records</p>
      <p className="pb-chips">
        {wall.records.length === 0 ? (
          <span className="pb-meta">No records yet</span>
        ) : (
          wall.records.map((r) => (
            <span key={r.entityId} className="pb-key" title={r.entity}>
              {r.label ?? 'a record you cannot see'}
            </span>
          ))
        )}
      </p>
    </Card>
  );
}

/** Walls the caller can see and the static role table from docs/05 and the RLS matrix. */
export function AccessPage(): ReactNode {
  const walls = useQuery(wallsQuery);
  const me = useQuery(meQuery);
  const users = useQuery({ ...mockUsersQuery, enabled: me.data?.mockIdentity === true });
  const myRoles = new Set<string>(me.data?.roles ?? []);
  const holders = (role: string): string[] =>
    (users.data?.users ?? [])
      .filter((u) => (u.roles as readonly string[]).includes(role))
      .map((u) => u.displayName);
  return (
    <>
      <PageHeader
        title="Access and walls"
        meta="Roles, client entitlements and information walls, enforced in the UI, the API and row-level security (SEC-5.1)"
      />
      <TabNav label="Admin" items={ADMIN_TABS} />
      {walls.isPending ? <PageSkeleton rows={3} /> : null}
      {walls.isError ? (
        <UnavailableState
          card
          subject="Walls"
          error={walls.error}
          forbidden={{ title: 'No walls are visible to you' }}
          notReady={{ title: 'Walls are not available yet' }}
          errorTitle="Walls unavailable"
          testId="walls-unavailable"
        />
      ) : null}
      {walls.data !== undefined ? (
        walls.data.walls.length === 0 ? (
          <Card>
            <EmptyState
              title="No walls are visible to you"
              detail="A wall is listed for its members, approvers and platform admins (SEC-5.3)."
              testId="walls-empty"
            />
          </Card>
        ) : (
          walls.data.walls.map((w) => <WallCard key={w.id} wall={w} />)
        )
      ) : null}
      <Card>
        <SectionHeader aside={`${ROLE_ROWS.length} roles`}>What each role sees</SectionHeader>
        <TableWrap label="What each role sees">
          <table className="pb-table" aria-label="What each role sees">
            <thead>
              <tr>
                <th>Role</th>
                <th>What it can read and change</th>
              </tr>
            </thead>
            <tbody>
              {ROLE_ROWS.map((r) => {
                const names = holders(r.role);
                return (
                  <tr key={r.role}>
                    <td>
                      <div className="pb-role-cell">
                        <span className="pb-key">{r.role}</span>
                        <span>{r.label}</span>
                        {myRoles.has(r.role) ? <Badge tone="accent">Your role</Badge> : null}
                        {names.length > 0 ? (
                          <span className="pb-meta">Prototype users: {names.join(', ')}</span>
                        ) : null}
                      </div>
                    </td>
                    <td>{r.sees}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
        <p className="pb-meta" data-testid="role-source">
          {ROLE_SOURCE}
        </p>
      </Card>
    </>
  );
}

/* ---- Integration health (docs/15, docs/17 section 7) ---- */

/** Readiness checks for the database and every adapter, and the adapter kill switches. */
export function HealthPage(): ReactNode {
  const ready = useQuery({ ...healthReadyQuery, placeholderData: keepPreviousData });
  const flags = useQuery(flagsQuery);
  const switches = (flags.data?.flags ?? []).filter((f) => f.key.startsWith('adapter.'));
  return (
    <>
      <PageHeader
        title="Integration health"
        meta="Readiness of the database and every adapter, with the kill switch for each integration (docs/15, docs/17 section 7)"
        actions={
          ready.data !== undefined ? (
            <Badge tone={ready.data.status === 'ok' ? 'good' : 'bad'}>
              {ready.data.status === 'ok' ? 'Ready' : 'Degraded'}
            </Badge>
          ) : undefined
        }
      />
      <TabNav label="Admin" items={ADMIN_TABS} />
      <Card>
        <SectionHeader
          aside={ready.data !== undefined ? `version ${ready.data.version}` : undefined}
        >
          Readiness checks
        </SectionHeader>
        {ready.isPending ? <PageSkeleton rows={4} /> : null}
        {ready.isError ? (
          <EmptyState
            title="Readiness is unavailable"
            detail="The readiness endpoint did not answer; the API itself may be down or restarting."
            testId="health-unavailable"
          />
        ) : null}
        {ready.data !== undefined ? (
          <TableWrap label="Readiness checks">
            <table className="pb-table" aria-label="Readiness checks">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Status</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(ready.data.checks).map(([name, check]) => (
                  <tr key={name}>
                    <td>
                      <span className="pb-key">{name}</span>
                    </td>
                    <td>
                      <Badge tone={check.ok ? 'good' : 'bad'}>{check.ok ? 'OK' : 'Degraded'}</Badge>
                    </td>
                    <td>{check.detail ?? <span className="pb-meta">no detail</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        ) : null}
      </Card>
      <Card>
        <SectionHeader aside={`${switches.length} adapters`}>Kill switches</SectionHeader>
        {flags.isPending ? <PageSkeleton rows={3} /> : null}
        {flags.isError ? (
          <EmptyState
            title="Flags are unavailable"
            detail="The kill switches could not be read; the Flags tab shows the same list."
          />
        ) : null}
        {flags.data !== undefined ? (
          switches.length === 0 ? (
            <EmptyState title="No adapter flags" detail="No adapter.* flag is configured." />
          ) : (
            <TableWrap label="Kill switches">
              <table className="pb-table" aria-label="Kill switches">
                <thead>
                  <tr>
                    <th>Flag</th>
                    <th>Integration</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {switches.map((f) => (
                    <tr key={f.key}>
                      <td>
                        <span className="pb-key">{f.key}</span>
                      </td>
                      <td>{f.description}</td>
                      <td>
                        <Badge tone={f.enabled ? 'good' : 'neutral'}>
                          {f.enabled ? 'On' : 'Off'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )
        ) : null}
        <p className="pb-meta">
          Off stops the integration at once (docs/17 section 5). Platform admins change these under
          Flags, with a reason; the AI kill switches (ai.*) are there as well.
        </p>
      </Card>
    </>
  );
}
