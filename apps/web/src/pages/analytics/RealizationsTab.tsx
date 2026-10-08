import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { InvestmentPage, PooledMetrics } from '@pb/contracts';
import { analyticsQuery, investmentsQuery } from '../../app/queries.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Card,
  EmptyState,
  NumCell,
  PageSkeleton,
  SectionHeader,
  StatTile,
} from '../../components/ui.js';
import { formatHoldingPeriod } from '../../lib/dates.js';
import { formatDate, formatMoic, formatMoneyM, irrDisplay, labelOf } from '../../lib/format.js';
import { irrFlagHint } from '../../lib/labels.js';
import { REALIZED_POSITIONS } from './constants.js';

function RealizedTiles({ realized, count }: { realized: PooledMetrics; count: number }): ReactNode {
  return (
    <div className="pb-tiles" data-testid="realizations-tiles">
      <StatTile label="Realized positions" value={String(count)} />
      <StatTile label="Invested" value={formatMoneyM(realized.invested)} />
      <StatTile label="Distributions" value={formatMoneyM(realized.distributions)} />
      <StatTile label="DPI" value={formatMoic(realized.dpi)} hint="Distributions / invested" />
      <StatTile label="Gross MOIC" value={formatMoic(realized.grossMoic)} />
      <StatTile
        label="Gross IRR"
        value={irrDisplay(realized)}
        hint={irrFlagHint(realized.irrFlag) ?? 'Pooled cash flows, XIRR'}
      />
    </div>
  );
}

function RealizedTable({ page }: { page: InvestmentPage }): ReactNode {
  if (page.items.length === 0) {
    return (
      <EmptyState
        title="No realized positions"
        detail="Positions appear here once they are marked realized with an exit date."
      />
    );
  }
  return (
    <div className="pb-table-wrap">
      <table className="pb-table" aria-label="Realized positions">
        <thead>
          <tr>
            <th>Inv #</th>
            <th>Company</th>
            <th>Vehicle</th>
            <th>Deal type</th>
            <th>Entry</th>
            <th>Exit</th>
            <th className="num">Holding period</th>
            <th className="num">Invested</th>
            <th className="num">Distributions</th>
            <th className="num">Gross MOIC</th>
            <th className="num">Gross IRR</th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((i) => (
            <tr key={i.id}>
              <td>
                <span className="pb-key">{i.investmentNumber}</span>
              </td>
              <td>
                <Link to="/portfolio/$id" params={{ id: i.id }}>
                  {i.companyName}
                </Link>
              </td>
              <td>{i.vehicleName}</td>
              <td>{labelOf(i.dealType)}</td>
              <td>{formatDate(i.entryDate)}</td>
              <td>{formatDate(i.exitDate)}</td>
              <NumCell>{formatHoldingPeriod(i.entryDate, i.exitDate)}</NumCell>
              <NumCell>{formatMoneyM(i.invested)}</NumCell>
              <NumCell>{formatMoneyM(i.distributions)}</NumCell>
              <NumCell>{formatMoic(i.grossMoic)}</NumCell>
              <NumCell>{irrDisplay(i)}</NumCell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RealizationsTab(): ReactNode {
  const analytics = useQuery({ ...analyticsQuery, placeholderData: keepPreviousData });
  const realized = useQuery({
    ...investmentsQuery(REALIZED_POSITIONS),
    placeholderData: keepPreviousData,
  });
  if (analytics.isPending || realized.isPending) return <PageSkeleton tiles={6} rows={4} />;
  return (
    <>
      {analytics.isError ? (
        <UnavailableState error={analytics.error} subject="Portfolio analytics" />
      ) : (
        <RealizedTiles
          realized={analytics.data.realized}
          count={analytics.data.realizedInvestments}
        />
      )}
      <Card>
        <SectionHeader
          aside={
            realized.data !== undefined
              ? `As of ${formatDate(realized.data.asOf)}. Holding period is entry to exit in 365.25-day years.`
              : undefined
          }
        >
          Realized positions
        </SectionHeader>
        {realized.isError ? (
          <UnavailableState inline error={realized.error} subject="Realized positions" />
        ) : (
          <RealizedTable page={realized.data} />
        )}
      </Card>
    </>
  );
}
