import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { ChangeRequestPage, InvestmentDetail, ValuationPage } from '@pb/contracts';
import { meQuery, valuationsQuery } from '../../app/queries.js';
import { LineChart } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  NumCell,
  PageSkeleton,
  SectionHeader,
  TableWrap,
} from '../../components/ui.js';
import { ActionLogCard, ActionStatus } from '../../components/WorkflowActions.js';
import {
  formatDate,
  formatMoneyM,
  formatMonthYear,
  formatMonthYearShort,
  formatPct,
  labelOf,
  MISSING,
  moneyLabel,
  plural,
} from '../../lib/format.js';
import { changeRequestTone, humanizeState, valuationTone } from '../../lib/states.js';
import { useActionLog } from '../../lib/workflow.js';
import type { ActionLog } from '../../lib/workflow.js';
import { changeRequestsQuery } from '../valuations/api.js';
import { ChangeRequestForm } from '../valuations/ChangeRequestForm.js';
import { canSubmitRequest } from '../valuations/changes.js';
import {
  datePart,
  lockedSeries,
  toNumber,
  useDealDetail,
  useDealId,
  versionsNewestFirst,
} from './data.js';
import type { VersionPoint } from './data.js';
import './deal.css';

/** Single series: the Locked fair value per period. Drafts, versions in review and reopened versions are left out. */
function LockedChart({ rows }: { rows: readonly VersionPoint[] }): ReactNode {
  const locked = lockedSeries(rows);
  const first = locked[0];
  const last = locked[locked.length - 1];
  if (first === undefined || last === undefined) {
    return (
      <EmptyState
        title="No Locked valuations yet"
        detail="The chart plots Locked versions only, the ones reports read (docs/18 section 1)."
      />
    );
  }
  return (
    <LineChart
      title="Locked fair value by period"
      subtitle="Locked versions only"
      x={locked.map((v) => formatMonthYearShort(v.periodEnd))}
      series={[{ name: 'Fair value', values: locked.map((v) => toNumber(v.fairValue)) }]}
      kind="money"
      format={moneyLabel}
      summary={`Locked fair value over ${locked.length} ${locked.length === 1 ? 'period' : 'periods'}, from ${formatMoneyM(first.fairValue)} at ${formatMonthYear(first.periodEnd)} to ${formatMoneyM(last.fairValue)} at ${formatMonthYear(last.periodEnd)}. Only Locked versions are plotted; drafts, versions in review and reopened versions are left out.`}
      testId="deal-valuation-chart"
    />
  );
}

function BoardLink(): ReactNode {
  return (
    <p className="pb-meta pb-deal-note">
      <Link to="/valuations">Open the valuation board</Link>. Prepare, approve, lock and reopen live
      on the valuation board.
    </p>
  );
}

const COLUMNS = 8;

function VersionsTable({ page }: { page: ValuationPage }): ReactNode {
  const rows = versionsNewestFirst(page.items);
  return (
    <TableWrap label="Valuation versions">
      <table className="pb-table" aria-label="Valuation versions">
        <thead>
          <tr>
            <th>Period</th>
            <th className="num">Version</th>
            <th>State</th>
            <th>Method</th>
            <th className="num">Prior fair value</th>
            <th className="num">Fair value</th>
            <th className="num">Change</th>
            <th>Approved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <Fragment key={v.id}>
              <tr className={v.reopenReason !== null ? 'pb-deal-has-note' : undefined}>
                <td className="pb-nowrap">{formatDate(v.periodEnd)}</td>
                <NumCell>{String(v.version)}</NumCell>
                <td>
                  <Badge tone={valuationTone(v.state)}>{humanizeState(v.state)}</Badge>
                </td>
                <td>{labelOf(v.method)}</td>
                <NumCell>{formatMoneyM(v.priorFairValue)}</NumCell>
                <NumCell>{formatMoneyM(v.fairValue)}</NumCell>
                <NumCell>{formatPct(v.changePct)}</NumCell>
                <td className="pb-nowrap">
                  {v.approvedAt === null ? MISSING : formatDate(datePart(v.approvedAt))}
                </td>
              </tr>
              {v.reopenReason !== null ? (
                <tr className="pb-deal-note-row">
                  <td colSpan={COLUMNS}>
                    <span className="pb-meta">Reopen reason: {v.reopenReason}</span>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function VersionsCard({ page }: { page: ValuationPage }): ReactNode {
  const n = page.items.length;
  return (
    <Card testId="deal-valuations">
      <SectionHeader
        aside={n === 0 ? undefined : `${n} ${n === 1 ? 'version' : 'versions'}, newest first`}
      >
        Valuation versions
      </SectionHeader>
      {n === 0 ? (
        <EmptyState
          title="No valuation versions"
          detail="Versions appear here once operations prepare a valuation for this position."
        />
      ) : (
        <>
          <LockedChart rows={page.items} />
          <VersionsTable page={page} />
          {page.nextCursor !== null ? (
            <p className="pb-meta pb-deal-note">
              Showing the first {n} versions; the valuation board lists every version.
            </p>
          ) : null}
        </>
      )}
      <BoardLink />
    </Card>
  );
}

/** What the one-pager already carries: period, version, state, method and fair value per version. */
function RecordedVersionsCard({ detail }: { detail: InvestmentDetail }): ReactNode {
  const rows = versionsNewestFirst(detail.valuations);
  return (
    <Card testId="deal-valuations-recorded">
      <SectionHeader aside="As recorded on the position, newest first">
        Valuation versions
      </SectionHeader>
      {rows.length === 0 ? (
        <EmptyState
          title="No valuation versions"
          detail="Versions appear here once operations prepare a valuation for this position."
        />
      ) : (
        <>
          <LockedChart rows={rows} />
          <TableWrap label="Valuation versions">
            <table className="pb-table" aria-label="Valuation versions">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="num">Version</th>
                  <th>State</th>
                  <th>Method</th>
                  <th className="num">Fair value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={`${v.periodEnd}-${v.version}`}>
                    <td className="pb-nowrap">{formatDate(v.periodEnd)}</td>
                    <NumCell>{String(v.version)}</NumCell>
                    <td>
                      <Badge tone={valuationTone(v.state)}>{humanizeState(v.state)}</Badge>
                    </td>
                    <td>{labelOf(v.method)}</td>
                    <NumCell>{formatMoneyM(v.fairValue)}</NumCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </>
      )}
      <BoardLink />
    </Card>
  );
}

function RequestsTable({ page }: { page: ChangeRequestPage }): ReactNode {
  return (
    <TableWrap label="Change requests">
      <table className="pb-table" aria-label="Change requests">
        <thead>
          <tr>
            <th>Change</th>
            <th>Effective</th>
            <th>Summary</th>
            <th>Owner</th>
            <th>State</th>
            <th>Applied in</th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((r) => (
            <tr key={r.id}>
              <td>{labelOf(r.changeType)}</td>
              <td className="pb-nowrap">{formatDate(r.effectiveDate)}</td>
              <td>{r.summary}</td>
              <td>{r.owner?.name ?? MISSING}</td>
              <td>
                <Badge tone={changeRequestTone(r.state)}>{humanizeState(r.state)}</Badge>
              </td>
              <td className="pb-nowrap">
                {r.appliedPeriod === null ? MISSING : formatDate(r.appliedPeriod)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/**
 * The position's change requests (docs/04 M11) with their state, and the one form to request a
 * change for the roles the route admits. A request is routed, applied or rejected on the queue.
 */
function ChangeRequestsCard({
  investmentId,
  investmentName,
  roles,
  log,
}: {
  investmentId: string;
  investmentName: string;
  roles: readonly string[];
  log: ActionLog;
}): ReactNode {
  const q = useQuery(changeRequestsQuery({ investmentId }));
  const n = q.data?.items.length ?? 0;
  return (
    <Card testId="deal-change-requests">
      <SectionHeader aside={n === 0 ? undefined : `${plural(n, 'request')}, newest first`}>
        Change requests
      </SectionHeader>
      {q.isPending ? (
        <PageSkeleton rows={2} />
      ) : q.isError ? (
        <UnavailableState
          inline
          error={q.error}
          subject="Change requests"
          testId="deal-change-requests-unavailable"
        />
      ) : q.data.items.length === 0 ? (
        <EmptyState
          title="No change requests"
          detail="Requests for an add-on, a new security, a distribution treatment, a recapitalization or a partial exit on this position appear here."
        />
      ) : (
        <RequestsTable page={q.data} />
      )}
      <p className="pb-meta pb-deal-note">
        <Link to="/valuations/changes">Open the change request queue</Link>, where a request is
        routed, applied or rejected.
      </p>
      {canSubmitRequest(roles) ? (
        <div className="pb-deal-gap">
          <SectionHeader>Request a change</SectionHeader>
          <ActionStatus latest={log.latest} testId="deal-change-request-status" />
          <ChangeRequestForm
            investmentId={investmentId}
            investmentName={investmentName}
            log={log}
          />
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Valuations tab (docs/04 M10, M11): every version of this position's valuation with its state,
 * the change against the prior Locked value and any reopen reason (the workflow actions live on
 * the valuation board), then the position's change requests and the form to request one.
 */
export function ValuationsTab(): ReactNode {
  const id = useDealId();
  const detail = useDealDetail();
  const me = useQuery(meQuery);
  const q = useQuery(valuationsQuery({ investmentId: id }));
  const log = useActionLog();
  const roles = me.data?.roles ?? [];
  const requests = (
    <>
      <ChangeRequestsCard
        investmentId={id}
        investmentName={detail.data?.companyName ?? 'this position'}
        roles={roles}
        log={log}
      />
      {canSubmitRequest(roles) ? <ActionLogCard entries={log.entries} /> : null}
    </>
  );
  if (q.isPending) return <PageSkeleton rows={6} />;
  if (q.isLoadingError) {
    return (
      <>
        <UnavailableState
          card
          error={q.error}
          subject="Valuation versions"
          notReady={{
            title: 'Approvals and prior values are not available yet',
            detail:
              'The valuation list is not built in this version, so the versions below come from the position record: period, version, state, method and fair value.',
          }}
          errorTitle="Valuation versions could not load"
          testId="deal-valuations-unavailable"
        />
        {detail.data !== undefined ? <RecordedVersionsCard detail={detail.data} /> : null}
        {requests}
      </>
    );
  }
  return (
    <>
      <VersionsCard page={q.data} />
      {requests}
    </>
  );
}
