import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { InvestmentDetail, ValuationPage } from '@pb/contracts';
import { valuationsQuery } from '../../app/queries.js';
import { LineChart } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  NumCell,
  PageSkeleton,
  SectionHeader,
} from '../../components/ui.js';
import { moneyLabel } from '../../lib/decimal.js';
import {
  formatDate,
  formatMoneyM,
  formatMonthYear,
  formatPct,
  labelOf,
  MISSING,
} from '../../lib/format.js';
import { humanizeState, valuationTone } from '../../lib/states.js';
import { retryUnlessUnavailable } from '../../lib/unavailable.js';
import {
  axisPeriod,
  datePart,
  lockedSeries,
  toNumber,
  useDealDetail,
  useDealId,
  versionsNewestFirst,
} from './data.js';
import type { VersionPoint } from './data.js';
import { WideTable } from './parts.js';
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
      x={locked.map((v) => axisPeriod(v.periodEnd))}
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
    <WideTable label="Valuation versions">
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
    </WideTable>
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
          <div className="pb-deal-chart">
            <LockedChart rows={page.items} />
          </div>
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
          <div className="pb-deal-chart">
            <LockedChart rows={rows} />
          </div>
          <WideTable label="Valuation versions">
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
          </WideTable>
        </>
      )}
      <BoardLink />
    </Card>
  );
}

/**
 * Valuations tab (docs/04 M10): every version of this position's valuation with its state, the
 * change against the prior Locked value and any reopen reason. Read only: the workflow actions
 * live on the valuation board.
 */
export function ValuationsTab(): ReactNode {
  const id = useDealId();
  const detail = useDealDetail();
  const q = useQuery({ ...valuationsQuery({ investmentId: id }), retry: retryUnlessUnavailable });
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
      </>
    );
  }
  return <VersionsCard page={q.data} />;
}
