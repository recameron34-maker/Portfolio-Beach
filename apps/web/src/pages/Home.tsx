import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Spinner } from '@fluentui/react-components';
import type { AnalyticsSummary, CapitalNoticePage, Watchlist, WatchlistItem } from '@pb/contracts';
import {
  analyticsQuery,
  capitalNoticesQuery,
  dataHealthQuery,
  meQuery,
  watchlistQuery,
} from '../app/queries.js';
import { HorizontalBars, LineChart, Sparkline } from '../components/charts/index.js';
import { UnavailableState } from '../components/UnavailableState.js';
import {
  Badge,
  Card,
  EmptyState,
  NumCell,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  StatTile,
} from '../components/ui.js';
import { moneyLabel } from '../lib/decimal.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  formatMonthYear,
  irrDisplay,
  labelOf,
} from '../lib/format.js';
import { irrFlagHint, watchFlagLabel } from '../lib/labels.js';
import { humanizeState, noticeTone } from '../lib/states.js';

/** Rows the dashboard shows before pointing at the full list. */
const ATTENTION_ROWS = 8;
const NOTICE_ROWS = 6;

/** Numbers feed chart geometry only; every displayed figure is formatted from the API's decimal string. */
const toNumber = (value: string | null): number | null => (value === null ? null : Number(value));

function Tiles({ summary }: { summary: AnalyticsSummary }): ReactNode {
  const a = summary.active;
  const navPoints = summary.navSeries
    .map((p) => toNumber(p.value))
    .filter((v): v is number => v !== null);
  return (
    <div className="pb-tiles" data-testid="home-tiles">
      <StatTile label="Active positions" value={String(summary.activeInvestments)} />
      <StatTile label="Invested capital" value={formatMoneyM(a.invested)} hint="Active positions" />
      <StatTile
        label="Current NAV"
        value={formatMoneyM(a.nav)}
        hint="Latest Locked valuations"
        figure={
          navPoints.length >= 2 ? (
            <Sparkline
              values={navPoints}
              label={`NAV trend over the last ${navPoints.length} quarters`}
            />
          ) : undefined
        }
      />
      <StatTile
        label="Gross MOIC"
        value={formatMoic(a.grossMoic)}
        hint="(distributions + NAV) / invested"
      />
      <StatTile label="DPI" value={formatMoic(a.dpi)} hint="Distributions / invested" />
      <StatTile label="TVPI" value={formatMoic(a.tvpi)} hint="Total value / invested" />
      <StatTile
        label="Gross IRR"
        value={irrDisplay(a)}
        hint={irrFlagHint(a.irrFlag) ?? 'Pooled cash flows, XIRR'}
      />
    </div>
  );
}

function AttentionRow({ item }: { item: WatchlistItem }): ReactNode {
  return (
    <li>
      <span className="pb-attention-main">
        <Link to="/portfolio/$id" params={{ id: item.investmentId }}>
          {item.companyName}
        </Link>
        <span className="pb-meta">{item.vehicleName}</span>
      </span>
      <span className="pb-chips">
        {item.flags.map((f) => (
          <span key={f.code} title={f.message}>
            <Badge tone={f.severity}>{watchFlagLabel(f.code)}</Badge>
          </span>
        ))}
      </span>
    </li>
  );
}

function AttentionBody({ data }: { data: Watchlist }): ReactNode {
  const shown = data.items.slice(0, ATTENTION_ROWS);
  return (
    <>
      <p className="pb-chips">
        <Badge tone={data.counts.bad > 0 ? 'bad' : 'neutral'}>
          Needs action: {data.counts.bad}
        </Badge>
        <Badge tone={data.counts.watch > 0 ? 'watch' : 'neutral'}>Watch: {data.counts.watch}</Badge>
        <Badge tone="good">Clear: {data.counts.clear}</Badge>
      </p>
      {shown.length === 0 ? (
        <EmptyState
          title="Nothing flagged"
          detail="No active position breaches a monitoring threshold."
        />
      ) : (
        <ul className="pb-attention" aria-label="Flagged positions">
          {shown.map((item) => (
            <AttentionRow key={item.investmentId} item={item} />
          ))}
        </ul>
      )}
      <p className="pb-meta">
        <Link to="/portfolio/watchlist">Open the watchlist</Link>
        {data.items.length > shown.length
          ? ` for all ${data.items.length} flagged positions.`
          : ' for the thresholds and every flag.'}
      </p>
    </>
  );
}

function AttentionCard(): ReactNode {
  const q = useQuery({ ...watchlistQuery, placeholderData: keepPreviousData });
  return (
    <Card testId="home-attention">
      <SectionHeader aside={q.data !== undefined ? `As of ${formatDate(q.data.asOf)}` : undefined}>
        Attention
      </SectionHeader>
      {q.isPending ? <Spinner size="tiny" label="Loading the watchlist" /> : null}
      {q.isError ? <UnavailableState inline error={q.error} subject="The watchlist" /> : null}
      {q.data !== undefined ? <AttentionBody data={q.data} /> : null}
    </Card>
  );
}

function NoticesBody({ page }: { page: CapitalNoticePage }): ReactNode {
  const rows = page.attention.slice(0, NOTICE_ROWS);
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing due"
        detail={`No notice is open or due within ${page.alertDaysBeforeDue} days of ${formatDate(page.asOf)}.`}
      />
    );
  }
  return (
    <>
      <div className="pb-table-wrap">
        <table className="pb-table" aria-label="Capital activity needing attention">
          <thead>
            <tr>
              <th>Notice</th>
              <th>Company or fund</th>
              <th>Due</th>
              <th className="num">Amount</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id}>
                <td>
                  <Link to="/capital-activity/$id" params={{ id: n.id }}>
                    {labelOf(n.noticeType)}
                  </Link>
                </td>
                <td>{n.companyName ?? n.sponsorFundName ?? n.vehicleName}</td>
                <td>
                  {formatDate(n.dueDate)}
                  {n.daysToDue < 0 ? (
                    <>
                      {' '}
                      <Badge tone="bad">Overdue</Badge>
                    </>
                  ) : null}
                </td>
                <NumCell>{formatMoneyM(n.amount)}</NumCell>
                <td>
                  <Badge tone={noticeTone(n.state)}>{humanizeState(n.state)}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pb-meta">
        <Link to="/capital-activity">Open capital activity</Link>
        {page.attention.length > rows.length
          ? ` for all ${page.attention.length} notices needing attention.`
          : ' for every notice.'}
      </p>
    </>
  );
}

function CapitalActivityCard(): ReactNode {
  const q = useQuery({ ...capitalNoticesQuery({}), placeholderData: keepPreviousData });
  return (
    <Card testId="home-capital">
      <SectionHeader
        aside={
          q.data !== undefined ? `Alerts ${q.data.alertDaysBeforeDue} days before due` : undefined
        }
      >
        Capital activity
      </SectionHeader>
      {q.isPending ? <Spinner size="tiny" label="Loading capital notices" /> : null}
      {q.isError ? (
        <UnavailableState
          inline
          error={q.error}
          subject="Capital activity"
          testId="home-capital-unavailable"
        />
      ) : null}
      {q.data !== undefined ? <NoticesBody page={q.data} /> : null}
    </Card>
  );
}

function ChartsRow({ summary }: { summary: AnalyticsSummary }): ReactNode {
  const vehicles = summary.exposures.vehicle.map((b) => ({
    label: b.label,
    value: Number(b.nav ?? '0'),
    display: formatMoneyM(b.nav),
  }));
  const largest = vehicles[0];
  const points = summary.navSeries;
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  return (
    <div className="pb-two-col">
      <Card>
        <SectionHeader aside="Active positions">Exposure</SectionHeader>
        {largest === undefined ? (
          <EmptyState
            title="No active positions"
            detail="Exposure appears once positions are active."
          />
        ) : (
          <HorizontalBars
            title="Exposure by vehicle"
            subtitle="Locked marks only"
            data={vehicles}
            kind="money"
            valueColumn="NAV"
            summary={`NAV by vehicle across ${vehicles.length} vehicles; the largest is ${largest.label} at ${largest.display}.`}
            testId="home-exposure"
          />
        )}
      </Card>
      <Card>
        <SectionHeader aside="Sum of Locked fair values">Trend</SectionHeader>
        {firstPoint === undefined || lastPoint === undefined ? (
          <EmptyState title="No Locked valuations" detail="The NAV series needs Locked marks." />
        ) : (
          <LineChart
            title="NAV by quarter"
            subtitle={`Locked marks only, last ${points.length} quarters`}
            x={points.map((p) => formatMonthYear(p.periodEnd))}
            series={[{ name: 'NAV', values: points.map((p) => toNumber(p.value)) }]}
            kind="money"
            format={moneyLabel}
            summary={`NAV by quarter over ${points.length} quarters, from ${formatMoneyM(firstPoint.value)} at ${formatMonthYear(firstPoint.periodEnd)} to ${formatMoneyM(lastPoint.value)} at ${formatMonthYear(lastPoint.periodEnd)}.`}
            testId="home-nav-series"
          />
        )}
      </Card>
    </div>
  );
}

function DataHealthCard(): ReactNode {
  const health = useQuery({ ...dataHealthQuery, placeholderData: keepPreviousData });
  return (
    <Card>
      <SectionHeader
        aside={
          health.data !== undefined ? <>Stale after {health.data.staleAfterDays} days</> : undefined
        }
      >
        Data health
      </SectionHeader>
      {health.isPending ? <Spinner size="tiny" label="Loading data health" /> : null}
      {health.isError ? (
        <UnavailableState inline error={health.error} subject="Data health" />
      ) : null}
      {health.data !== undefined ? (
        <>
          <p className="pb-chips">
            <Badge tone={health.data.orphanInvestments === 0 ? 'good' : 'bad'}>
              {health.data.orphanInvestments === 0
                ? 'No orphan investments'
                : `${health.data.orphanInvestments} orphan investments`}
            </Badge>
            <Badge tone={health.data.openExceptions === 0 ? 'neutral' : 'watch'}>
              {health.data.openExceptions} open data exceptions
            </Badge>
            <Badge tone={health.data.staleInvestments === 0 ? 'neutral' : 'watch'}>
              {health.data.staleInvestments} stale positions
            </Badge>
          </p>
          <p className="pb-meta">
            Stale means no approved financials in the last {health.data.staleAfterDays} days.{' '}
            <Link to="/data/health">Open Data Health</Link>.
          </p>
        </>
      ) : null}
    </Card>
  );
}

function StartHereCard(): ReactNode {
  return (
    <Card>
      <SectionHeader>Start here</SectionHeader>
      <ul className="pb-linklist">
        <li>
          <Link to="/portfolio">Portfolio grid</Link>
          <span className="pb-meta">Every position with invested capital, NAV, MOIC and IRR</span>
        </li>
        <li>
          <Link to="/analytics">Analytics</Link>
          <span className="pb-meta">Exposure, performance, credit book and realizations</span>
        </li>
        <li>
          <Link to="/valuations">Valuations</Link>
          <span className="pb-meta">Versions and states across the portfolio</span>
        </li>
        <li>
          <Link to="/capital-activity">Capital Activity</Link>
          <span className="pb-meta">Calls, distributions and funding</span>
        </li>
        <li>
          <Link to="/sponsors">Sponsors</Link>
          <span className="pb-meta">Funds, positions and commitments by sponsor</span>
        </li>
        <li>
          <Link to="/data/health">Data Health</Link>
          <span className="pb-meta">Orphans, open exceptions and stale positions</span>
        </li>
        <li>
          <Link to="/data/dictionary">Data Dictionary</Link>
          <span className="pb-meta">Field definitions and display rules (docs/03 section 4)</span>
        </li>
      </ul>
    </Card>
  );
}

/** The dashboard a partner opens every morning: pooled figures, what needs attention, exposure and trend. */
export function HomePage(): ReactNode {
  const me = useQuery(meQuery);
  const analytics = useQuery({ ...analyticsQuery, placeholderData: keepPreviousData });
  if (me.isPending || analytics.isPending) return <PageSkeleton tiles={7} rows={3} />;
  const summary = analytics.data;
  const name = me.data?.displayName;
  return (
    <>
      <PageHeader
        title={name === undefined ? 'Welcome' : `Welcome, ${name}`}
        meta={
          <>
            {summary !== undefined ? `As of ${formatDate(summary.asOf)}. ` : ''}
            Figures cover the positions you are entitled to see.
          </>
        }
      />
      {summary !== undefined ? (
        <Tiles summary={summary} />
      ) : (
        <UnavailableState error={analytics.error} subject="Portfolio analytics" />
      )}
      <div className="pb-two-col">
        <AttentionCard />
        <CapitalActivityCard />
      </div>
      {summary !== undefined ? <ChartsRow summary={summary} /> : null}
      <div className="pb-two-col">
        <DataHealthCard />
        <StartHereCard />
      </div>
    </>
  );
}
