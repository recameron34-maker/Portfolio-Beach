import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AnalyticsSummary } from '@pb/contracts';
import { analyticsQuery } from '../../app/queries.js';
import { HorizontalBars, LineChart } from '../../components/charts/index.js';
import { UnavailableState } from '../../components/UnavailableState.js';
import {
  Card,
  EmptyState,
  NumCell,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TableWrap,
} from '../../components/ui.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  formatMonthYear,
  formatMonthYearShort,
  formatPct,
  irrDisplay,
  moneyLabel,
} from '../../lib/format.js';
import { irrFlagHint } from '../../lib/labels.js';
import { balanceTiles } from '../../lib/tiles.js';

function NavTrendCard({ summary }: { summary: AnalyticsSummary }): ReactNode {
  const points = summary.navSeries;
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <Card>
      <SectionHeader aside="Active positions, sum of Locked fair values">NAV trend</SectionHeader>
      {first === undefined || last === undefined ? (
        <EmptyState title="No Locked valuations" detail="The NAV series needs Locked marks." />
      ) : (
        <LineChart
          title="NAV by quarter"
          subtitle={`Locked marks only, last ${points.length} quarters`}
          x={points.map((p) => formatMonthYearShort(p.periodEnd))}
          series={[
            { name: 'NAV', values: points.map((p) => (p.value === null ? null : Number(p.value))) },
          ]}
          kind="money"
          format={moneyLabel}
          summary={`NAV by quarter over ${points.length} quarters, from ${formatMoneyM(first.value)} at ${formatMonthYear(first.periodEnd)} to ${formatMoneyM(last.value)} at ${formatMonthYear(last.periodEnd)}.`}
          testId="performance-nav-series"
        />
      )}
    </Card>
  );
}

function CashFlowsCard({ summary }: { summary: AnalyticsSummary }): ReactNode {
  const years = summary.flowsByYear;
  const last = years[years.length - 1];
  if (last === undefined) {
    return (
      <Card>
        <SectionHeader>Cash flows</SectionHeader>
        <EmptyState
          title="No cash flows"
          detail="Approved investment-level cash flows appear here by calendar year."
        />
      </Card>
    );
  }
  return (
    <Card>
      <SectionHeader aside="Approved investment-level cash flows by calendar year">
        Cash flows
      </SectionHeader>
      <div className="pb-two-col">
        <HorizontalBars
          title="Contributions by year"
          data={years.map((y) => ({
            label: y.period,
            value: Number(y.contributions),
            display: formatMoneyM(y.contributions),
          }))}
          kind="money"
          valueColumn="Contributions"
          summary={`Contributions by year over ${years.length} years, ${years[0]?.period ?? ''} to ${last.period}.`}
          testId="performance-contributions"
        />
        <HorizontalBars
          title="Distributions by year"
          data={years.map((y) => ({
            label: y.period,
            value: Number(y.distributions),
            display: formatMoneyM(y.distributions),
          }))}
          kind="money"
          valueColumn="Distributions"
          summary={`Distributions by year over ${years.length} years, ${years[0]?.period ?? ''} to ${last.period}.`}
          testId="performance-distributions"
        />
      </div>
      <LineChart
        title="Cumulative net cash flow"
        subtitle="Distributions less contributions, running total"
        x={years.map((y) => y.period)}
        series={[{ name: 'Cumulative net', values: years.map((y) => Number(y.cumulativeNet)) }]}
        kind="money"
        format={moneyLabel}
        summary={`Cumulative net cash flow ends at ${formatMoneyM(last.cumulativeNet)} in ${last.period}.`}
        testId="performance-cumulative"
      />
      <TableWrap label="Cash flows by year">
        <table className="pb-table" aria-label="Cash flows by year">
          <thead>
            <tr>
              <th>Year</th>
              <th className="num">Contributions</th>
              <th className="num">Distributions</th>
              <th className="num">Net</th>
              <th className="num">Cumulative net</th>
            </tr>
          </thead>
          <tbody>
            {years.map((y) => (
              <tr key={y.period}>
                <td>{y.period}</td>
                <NumCell>{formatMoneyM(y.contributions)}</NumCell>
                <NumCell>{formatMoneyM(y.distributions)}</NumCell>
                <NumCell>{formatMoneyM(y.net)}</NumCell>
                <NumCell>{formatMoneyM(y.cumulativeNet)}</NumCell>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
    </Card>
  );
}

function TopPositionsCard({ summary }: { summary: AnalyticsSummary }): ReactNode {
  const top = summary.topPositions;
  const first = top[0];
  return (
    <Card>
      <SectionHeader aside={`Top ${top.length} by NAV, Locked marks only`}>
        Largest positions
      </SectionHeader>
      {first === undefined ? (
        <EmptyState
          title="No active positions"
          detail="The largest positions by NAV appear here."
        />
      ) : (
        <>
          <HorizontalBars
            title="NAV of the largest positions"
            subtitle="The largest is emphasised"
            data={top.map((p, i) => ({
              label: p.companyName,
              value: Number(p.nav ?? '0'),
              display: formatMoneyM(p.nav),
              emphasis: i === 0,
            }))}
            kind="money"
            valueColumn="NAV"
            summary={`The largest position is ${first.companyName} at ${formatMoneyM(first.nav)}, ${formatPct(first.navShare)} of active NAV.`}
            testId="performance-top-positions"
          />
          <TableWrap label="Largest positions">
            <table className="pb-table" aria-label="Largest positions">
              <thead>
                <tr>
                  <th>Inv #</th>
                  <th>Company</th>
                  <th>Vehicle</th>
                  <th className="num">NAV</th>
                  <th className="num">Share of NAV</th>
                  <th className="num">Gross MOIC</th>
                </tr>
              </thead>
              <tbody>
                {top.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className="pb-key">{p.investmentNumber}</span>
                    </td>
                    <td>
                      <Link to="/portfolio/$id" params={{ id: p.id }}>
                        {p.companyName}
                      </Link>
                    </td>
                    <td>{p.vehicleName}</td>
                    <NumCell>{formatMoneyM(p.nav)}</NumCell>
                    <NumCell>{formatPct(p.navShare)}</NumCell>
                    <NumCell>{formatMoic(p.grossMoic)}</NumCell>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </>
      )}
    </Card>
  );
}

export function PerformanceAnalyticsTab(): ReactNode {
  const analytics = useQuery({ ...analyticsQuery, placeholderData: keepPreviousData });
  if (analytics.isPending) return <PageSkeleton tiles={8} rows={4} />;
  if (analytics.isError) {
    return <UnavailableState error={analytics.error} subject="Portfolio analytics" />;
  }
  const summary = analytics.data;
  const t = summary.totals;
  return (
    <>
      <p className="pb-meta">
        As of {formatDate(summary.asOf)}. Pooled over {t.count} positions, active and realized, that
        you are entitled to see.
      </p>
      <div ref={balanceTiles} className="pb-tiles" data-testid="performance-tiles">
        <StatTile label="Invested" value={formatMoneyM(t.invested)} hint="Contributions to date" />
        <StatTile label="Distributions" value={formatMoneyM(t.distributions)} />
        <StatTile label="NAV" value={formatMoneyM(t.nav)} hint="Latest Locked valuations" />
        <StatTile label="DPI" value={formatMoic(t.dpi)} hint="Distributions / invested" />
        <StatTile label="RVPI" value={formatMoic(t.rvpi)} hint="NAV / invested" />
        <StatTile label="TVPI" value={formatMoic(t.tvpi)} hint="Total value / invested" />
        <StatTile label="Gross MOIC" value={formatMoic(t.grossMoic)} />
        <StatTile
          label="Gross IRR"
          value={irrDisplay(t)}
          hint={irrFlagHint(t.irrFlag) ?? 'Pooled cash flows, XIRR'}
        />
      </div>
      <NavTrendCard summary={summary} />
      <CashFlowsCard summary={summary} />
      <TopPositionsCard summary={summary} />
    </>
  );
}
