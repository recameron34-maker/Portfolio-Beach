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
  PageContext,
  PageSkeleton,
  StatTile,
  TableWrap,
} from '../../components/ui.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  formatYears,
  irrDisplay,
  labelOf,
} from '../../lib/format.js';
import { irrFlagHint } from '../../lib/labels.js';
import { REALIZED_POSITIONS } from './constants.js';
import { balanceTiles } from '../../lib/tiles.js';

function RealizedTiles({ realized, count }: { realized: PooledMetrics; count: number }): ReactNode {
  return (
    <div ref={balanceTiles} className="pb-tiles" data-testid="realizations-tiles">
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
    <TableWrap label="Realized positions">
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
              <td className="pb-col-text">
                <Link to="/portfolio/$id" params={{ id: i.id }}>
                  {i.companyName}
                </Link>
              </td>
              <td className="pb-col-text">{i.vehicleName}</td>
              <td className="pb-col-text">{labelOf(i.dealType)}</td>
              <td className="pb-nowrap">{formatDate(i.entryDate)}</td>
              <td className="pb-nowrap">{formatDate(i.exitDate)}</td>
              <NumCell>{formatYears(i.holdingPeriodYears)}</NumCell>
              <NumCell>{formatMoneyM(i.invested)}</NumCell>
              <NumCell>{formatMoneyM(i.distributions)}</NumCell>
              <NumCell>{formatMoic(i.grossMoic)}</NumCell>
              <NumCell>{irrDisplay(i)}</NumCell>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

export function RealizationsTab(): ReactNode {
  const analytics = useQuery({ ...analyticsQuery, placeholderData: keepPreviousData });
  const realized = useQuery({
    ...investmentsQuery(REALIZED_POSITIONS),
    placeholderData: keepPreviousData,
  });
  if (analytics.isPending || realized.isPending) return <PageSkeleton tiles={6} rows={4} />;
  // The date the figures are as of: the list's, or the summary's when the list cannot be read.
  const asOf = realized.data?.asOf ?? analytics.data?.asOf;
  return (
    <>
      {asOf === undefined ? null : (
        <PageContext
          items={[`As of ${formatDate(asOf)}`, 'Realized positions visible to you']}
          note="Holding period runs from the first contribution to the exit, in 365-day years."
        />
      )}
      {analytics.isError ? (
        <UnavailableState error={analytics.error} subject="Portfolio analytics" />
      ) : (
        <RealizedTiles
          realized={analytics.data.realized}
          count={analytics.data.realizedInvestments}
        />
      )}
      <Card>
        {realized.isError ? (
          <UnavailableState inline error={realized.error} subject="Realized positions" />
        ) : (
          <RealizedTable page={realized.data} />
        )}
      </Card>
    </>
  );
}
