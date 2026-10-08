import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Spinner } from '@fluentui/react-components';
import type { CapitalNoticePage, InvestmentDetail } from '@pb/contracts';
import { capitalNoticesQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  NumCell,
  PageSkeleton,
  SectionHeader,
  StatTile,
} from '../../components/ui.js';
import { formatDate, formatMoneyM, labelOf } from '../../lib/format.js';
import { dueLabel, dueTone, humanizeState, noticeTone } from '../../lib/states.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';
import { ALERT_DAYS_BEFORE_DUE, isSettled, useDealDetail, useDealId } from './data.js';
import { WideTable } from './parts.js';
import './deal.css';

function NoticesTable({ page }: { page: CapitalNoticePage }): ReactNode {
  const rows = [...page.items].sort((a, b) => b.dueDate.localeCompare(a.dueDate));
  return (
    <WideTable label="Capital notices">
      <table className="pb-table" aria-label="Capital notices">
        <thead>
          <tr>
            <th>Due</th>
            <th>Type</th>
            <th className="num">Amount</th>
            <th className="num">Settled</th>
            <th>State</th>
            <th>
              <span className="pb-visually-hidden">Notice</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => (
            <tr key={n.id}>
              <td>
                <span className="pb-deal-period">
                  <span className="pb-nowrap">{formatDate(n.dueDate)}</span>
                  {isSettled(n.state) ? null : (
                    <Badge tone={dueTone(n.daysToDue, ALERT_DAYS_BEFORE_DUE)}>
                      {dueLabel(n.daysToDue)}
                    </Badge>
                  )}
                </span>
              </td>
              <td>{labelOf(n.noticeType)}</td>
              <NumCell>{formatMoneyM(n.amount)}</NumCell>
              <NumCell>{formatMoneyM(n.settledAmount)}</NumCell>
              <td>
                <Badge tone={noticeTone(n.state)}>{humanizeState(n.state)}</Badge>
              </td>
              <td>
                <Link to="/capital-activity/$id" params={{ id: n.id }}>
                  {/* The space sits outside the hidden span: a leading space inside it is dropped from the name. */}
                  Open{' '}
                  <span className="pb-visually-hidden">
                    {`${labelOf(n.noticeType)} due ${formatDate(n.dueDate)}`}
                  </span>
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </WideTable>
  );
}

/** The approved cash flows on the position record, newest first: what is true while notices are unavailable. */
function RecordedCashFlows({ detail }: { detail: InvestmentDetail }): ReactNode {
  const flows = [...detail.cashFlows].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <Card testId="deal-cash-flows">
      <SectionHeader aside="Approved, newest first">Cash flows on record</SectionHeader>
      {flows.length === 0 ? (
        <EmptyState
          title="No cash flows on record"
          detail="Contributions and distributions appear here once they are approved."
        />
      ) : (
        <div className="pb-table-wrap">
          <table className="pb-table" aria-label="Cash flows">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {flows.map((f, i) => (
                <tr key={`${f.date}-${i}`}>
                  <td className="pb-nowrap">{formatDate(f.date)}</td>
                  <td>{labelOf(f.flowType)}</td>
                  <NumCell>{formatMoneyM(f.amount)}</NumCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function CapitalLink(): ReactNode {
  return (
    <p className="pb-meta pb-deal-note">
      <Link to="/capital-activity">Open capital activity</Link>. Review, trade tickets and funding
      live there.
    </p>
  );
}

/**
 * Capital activity tab (docs/04 M16): what went in and came out, and this position's capital
 * notices with their due dates and settlement. Read only: the funding workflow lives on the
 * notice pages.
 */
export function CapitalTab(): ReactNode {
  const id = useDealId();
  const detail = useDealDetail();
  const q = useQuery({
    ...capitalNoticesQuery({ investmentId: id }),
    retry: retryUnlessUnavailable,
  });
  const d = detail.data;
  if (d === undefined) return detail.isPending ? <PageSkeleton tiles={2} rows={4} /> : null;
  const n = q.data?.items.length ?? 0;
  return (
    <>
      <div className="pb-tiles pb-deal-tiles" data-testid="deal-capital-tiles">
        <StatTile
          label={d.credit !== null ? 'Funded' : 'Invested'}
          value={formatMoneyM(d.invested)}
          hint="Contributions to date"
        />
        <StatTile
          label="Distributions"
          value={formatMoneyM(d.distributions)}
          hint="Received to date"
        />
      </div>
      {q.isLoadingError ? (
        <>
          <UnavailableState
            card
            error={q.error}
            subject="Capital notices"
            notReady={{
              title: 'Capital notices are not available yet',
              detail:
                'The notices list is not built in this version. The approved cash flows on record for this position are below.',
            }}
            errorTitle="Capital notices could not load"
            testId="deal-notices-unavailable"
          />
          <RecordedCashFlows detail={d} />
        </>
      ) : (
        <Card testId="deal-notices">
          <SectionHeader
            aside={
              q.data === undefined
                ? undefined
                : `${n} ${n === 1 ? 'notice' : 'notices'}, latest due date first`
            }
          >
            Capital notices
          </SectionHeader>
          {q.isPending ? <Spinner size="tiny" label="Loading capital notices" /> : null}
          {q.data !== undefined ? (
            n === 0 ? (
              <EmptyState
                title="No capital notices for this position"
                detail="Calls, distributions and payment notices for this position appear here."
              />
            ) : (
              <>
                <NoticesTable page={q.data} />
                {q.data.nextCursor !== null ? (
                  <p className="pb-meta pb-deal-note">
                    Showing the first {n} notices; capital activity lists every notice.
                  </p>
                ) : null}
              </>
            )
          ) : null}
          <CapitalLink />
        </Card>
      )}
    </>
  );
}
