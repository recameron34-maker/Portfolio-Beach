import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button } from '@fluentui/react-components';
import type { AnalyticsSummary, CapitalNoticePage, Watchlist, WatchlistItem } from '@pb/contracts';
import {
  analyticsQuery,
  capitalNoticesQuery,
  dataHealthQuery,
  meQuery,
  watchlistQuery,
} from '../app/queries.js';
import { HorizontalBars, knownRuns, Sparkline } from '../components/charts/index.js';
import { NavTrendCard } from '../components/NavTrendCard.js';
import { roleWords } from '../components/people.js';
import { PreviewGuide } from '../components/PreviewGuide.js';
import { UnavailableState } from '../components/UnavailableState.js';
import {
  Badge,
  Card,
  CheckList,
  EmptyState,
  NumCell,
  PageHeader,
  PageSkeleton,
  RowsSkeleton,
  SectionHeader,
  StatTile,
  TableWrap,
} from '../components/ui.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  irrDisplay,
  labelOf,
  plural,
} from '../lib/format.js';
import { irrFlagHint, watchFlagLabel } from '../lib/labels.js';
import { usePreviewGuide } from '../lib/preview-guide.js';
import { DEFAULT_HOME, focusOf, homeRows } from '../lib/role-focus.js';
import type { HomeSection, RoleFocus, WorkLink } from '../lib/role-focus.js';
import { dataCheckRows } from './data-display.js';
import { humanizeState, noticeTone } from '../lib/states.js';
import { balanceTiles } from '../lib/tiles.js';

/** Rows the dashboard shows before pointing at the full list. */
const ATTENTION_ROWS = 8;
const NOTICE_ROWS = 6;

/** Numbers feed chart geometry only; every displayed figure is formatted from the API's decimal string. */
const toNumber = (value: string | null): number | null => (value === null ? null : Number(value));

function Tiles({ summary }: { summary: AnalyticsSummary }): ReactNode {
  const a = summary.active;
  // The sparkline shows the latest unbroken run of calculable quarters only, so it never draws
  // across a quarter whose NAV is not calculable and its label counts what it shows.
  const series = summary.navSeries.map((p) => toNumber(p.value));
  const latestRun = knownRuns(series).at(-1) ?? [];
  const navPoints = latestRun.at(-1)?.i === series.length - 1 ? latestRun.map((p) => p.v) : [];
  // Seven cells: one row from about 1100px, four and three below that, two on a phone. Each hint
  // names the figure's basis; how the figure is worked out is under the pointer.
  return (
    <div ref={balanceTiles} className="pb-tiles pb-home-figures" data-testid="home-tiles">
      <StatTile label="Active positions" value={String(summary.activeInvestments)} />
      <StatTile label="Invested capital" value={formatMoneyM(a.invested)} hint="Active positions" />
      <StatTile
        label="Current NAV"
        value={formatMoneyM(a.nav)}
        hint="Locked marks"
        title="Latest Locked valuations"
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
        hint="Pooled"
        title="(distributions + NAV) / invested"
      />
      <StatTile
        label="DPI"
        value={formatMoic(a.dpi)}
        hint="Pooled"
        title="Distributions / invested"
      />
      <StatTile
        label="TVPI"
        value={formatMoic(a.tvpi)}
        hint="Pooled"
        title="Total value / invested"
      />
      <StatTile
        label="Gross IRR"
        value={irrDisplay(a)}
        hint={irrFlagHint(a.irrFlag) ?? 'Pooled, XIRR'}
        title="Pooled cash flows, XIRR"
      />
    </div>
  );
}

function AttentionRow({ item }: { item: WatchlistItem }): ReactNode {
  return (
    <tr>
      <td>
        <Link to="/portfolio/$id" params={{ id: item.investmentId }}>
          {item.companyName}
        </Link>
        <span className="pb-cell-sub">{item.vehicleName}</span>
      </td>
      <td>
        <span className="pb-marker-row">
          {item.flags.map((f) => (
            <span key={f.code} title={f.message}>
              <Badge tone={f.severity}>{watchFlagLabel(f.code)}</Badge>
            </span>
          ))}
        </span>
      </td>
    </tr>
  );
}

/** The watchlist's counts in one line of dots for the section's aside. */
function AttentionCounts({ counts }: { counts: Watchlist['counts'] }): ReactNode {
  return (
    <span className="pb-count-dots">
      <Badge tone={counts.bad > 0 ? 'bad' : 'neutral'}>
        {counts.bad} {counts.bad === 1 ? 'needs' : 'need'} action
      </Badge>
      <Badge tone={counts.watch > 0 ? 'watch' : 'neutral'}>{counts.watch} watch</Badge>
      <Badge tone="good">{counts.clear} clear</Badge>
    </span>
  );
}

function AttentionBody({ data }: { data: Watchlist }): ReactNode {
  const shown = data.items.slice(0, ATTENTION_ROWS);
  return (
    <>
      {shown.length === 0 ? (
        <EmptyState
          title="Nothing flagged"
          detail="No active position breaches a monitoring threshold."
        />
      ) : (
        <TableWrap label="Flagged positions">
          <table className="pb-table" aria-label="Flagged positions">
            <thead>
              <tr>
                <th>Company</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => (
                <AttentionRow key={item.investmentId} item={item} />
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      <p className="pb-meta">
        <Link to="/portfolio/watchlist">Open the watchlist</Link>
        {data.items.length > shown.length
          ? ` for all ${data.items.length} flagged positions.`
          : ' for the thresholds and every flag.'}{' '}
        Flags as of {formatDate(data.asOf)}.
      </p>
    </>
  );
}

function AttentionCard(): ReactNode {
  const q = useQuery({ ...watchlistQuery, placeholderData: keepPreviousData });
  return (
    <Card testId="home-attention">
      <SectionHeader
        aside={q.data !== undefined ? <AttentionCounts counts={q.data.counts} /> : undefined}
      >
        Attention
      </SectionHeader>
      {q.isPending ? <RowsSkeleton rows={4} label="Loading the watchlist" /> : null}
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
        detail={`No notice is open or due within ${plural(page.alertDaysBeforeDue, 'day')} of ${formatDate(page.asOf)}.`}
      />
    );
  }
  return (
    <>
      <TableWrap label="Capital activity needing attention">
        <table className="pb-table" aria-label="Capital activity needing attention">
          <thead>
            <tr>
              <th>Notice</th>
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
                  <span className="pb-cell-sub">
                    {n.companyName ?? n.sponsorFundName ?? n.vehicleName}
                  </span>
                </td>
                <td className="pb-nowrap">
                  {n.daysToDue < 0 ? (
                    <span className="pb-marker-row">
                      <span className="pb-overdue-date">{formatDate(n.dueDate)}</span>
                      <Badge tone="bad">Overdue</Badge>
                    </span>
                  ) : (
                    formatDate(n.dueDate)
                  )}
                </td>
                <NumCell>{formatMoneyM(n.amount)}</NumCell>
                <td>
                  <Badge tone={noticeTone(n.state)}>{humanizeState(n.state)}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>
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
          q.data !== undefined
            ? `Alerts ${plural(q.data.alertDaysBeforeDue, 'day')} before due`
            : undefined
        }
      >
        Capital activity
      </SectionHeader>
      {q.isPending ? <RowsSkeleton rows={4} label="Loading capital notices" /> : null}
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
  // Each chart's title is its section's heading: no second heading over it.
  return (
    <div className="pb-two-col">
      <Card>
        {largest === undefined ? (
          <>
            <SectionHeader>Exposure by vehicle</SectionHeader>
            <EmptyState
              title="No active positions"
              detail="Exposure appears once positions are active."
            />
          </>
        ) : (
          <HorizontalBars
            title="Exposure by vehicle"
            heading
            subtitle="Locked marks only"
            data={vehicles}
            kind="money"
            valueColumn="NAV"
            summary={`NAV by vehicle across ${plural(vehicles.length, 'vehicle')}; the largest is ${largest.label} at ${largest.display}.`}
            testId="home-exposure"
          />
        )}
      </Card>
      <NavTrendCard points={summary.navSeries} testId="home-nav-series" />
    </div>
  );
}

function DataHealthCard(): ReactNode {
  const health = useQuery({ ...dataHealthQuery, placeholderData: keepPreviousData });
  return (
    <Card>
      <SectionHeader>Data health</SectionHeader>
      {health.isPending ? <RowsSkeleton rows={3} label="Loading data health" /> : null}
      {health.isError ? (
        <UnavailableState inline error={health.error} subject="Data health" />
      ) : null}
      {health.data !== undefined ? (
        <>
          <CheckList label="Data checks" rows={dataCheckRows(health.data).slice(0, 3)} />
          <p className="pb-meta">
            <Link to="/data/health">Open data health</Link> for every check.
          </p>
        </>
      ) : null}
    </Card>
  );
}

/**
 * The work of the signed-in role, first on the page: what the role does here in a sentence, and
 * a link to each place it does it (config/role_focus.json). It orders and describes; what a
 * person may open or change is the API's to decide.
 */
/** Places to go, one a row: the link, then what is there on the same line. */
function WorkList({ links, label }: { links: readonly WorkLink[]; label: string }): ReactNode {
  return (
    <ul className="pb-home-work" aria-label={label}>
      {links.map((link) => (
        <li key={link.to}>
          <Link to={link.to}>{link.label}</Link>
          <span className="pb-home-work-what" title={link.what}>
            {link.what}
          </span>
        </li>
      ))}
    </ul>
  );
}

function WorkCard({ focus }: { focus: RoleFocus }): ReactNode {
  return (
    <Card testId="home-work">
      <SectionHeader aside={focus.area}>Your work</SectionHeader>
      <p className="pb-meta pb-home-work-does" data-testid="home-work-does">
        {focus.does}
      </p>
      <WorkList links={focus.work} label="Your work" />
    </Card>
  );
}

/** Where a user with no configured role (the service account) starts. */
const START_HERE: readonly WorkLink[] = [
  {
    to: '/portfolio',
    label: 'Portfolio grid',
    what: 'Every position with invested capital, NAV, MOIC and IRR',
  },
  {
    to: '/analytics',
    label: 'Analytics',
    what: 'Exposure, performance, credit book and realizations',
  },
  { to: '/valuations', label: 'Valuations', what: 'Versions and states across the portfolio' },
  { to: '/capital-activity', label: 'Capital activity', what: 'Calls, distributions and funding' },
  { to: '/sponsors', label: 'Sponsors', what: 'Funds, positions and commitments by sponsor' },
  {
    to: '/data/health',
    label: 'Data health',
    what: 'Orphans, open exceptions and stale positions',
  },
  {
    to: '/data/dictionary',
    label: 'Data dictionary',
    what: 'Field definitions and display rules',
  },
];

function StartHereCard(): ReactNode {
  return (
    <Card>
      <SectionHeader>Start here</SectionHeader>
      <WorkList links={START_HERE} label="Start here" />
    </Card>
  );
}

/**
 * The page a person opens every morning. It leads with the work of their role, then shows the
 * sections that role uses, in its order: pooled figures, what needs attention, capital activity,
 * exposure and trend, data health.
 */
export function HomePage(): ReactNode {
  const me = useQuery(meQuery);
  const analytics = useQuery({ ...analyticsQuery, placeholderData: keepPreviousData });
  const guide = usePreviewGuide();
  if (me.isPending || analytics.isPending) return <PageSkeleton tiles={7} rows={3} />;
  const summary = analytics.data;
  const name = me.data?.displayName;
  const roles = me.data === undefined ? '' : roleWords(me.data.roles);
  const focus = focusOf(me.data?.roles);
  const section = (key: HomeSection): ReactNode => {
    switch (key) {
      case 'work':
        return focus === null ? <StartHereCard key={key} /> : <WorkCard key={key} focus={focus} />;
      case 'tiles':
        return summary !== undefined ? (
          <Tiles key={key} summary={summary} />
        ) : (
          <UnavailableState key={key} error={analytics.error} subject="Portfolio analytics" />
        );
      case 'attention':
        return <AttentionCard key={key} />;
      case 'capital':
        return <CapitalActivityCard key={key} />;
      case 'charts':
        return summary !== undefined ? <ChartsRow key={key} summary={summary} /> : null;
      case 'dataHealth':
        return <DataHealthCard key={key} />;
    }
  };
  return (
    <>
      <PageHeader
        title="Home"
        meta={
          <>
            {summary !== undefined ? `As of ${formatDate(summary.asOf)}. ` : ''}
            {name === undefined ? '' : `${name}${roles === '' ? '' : `, ${roles}`}. `}
            Figures cover the positions visible to you.
          </>
        }
        actions={
          guide.hidden ? (
            <Button
              size="small"
              appearance="secondary"
              autoFocus={guide.focus === 'show'}
              onClick={guide.show}
            >
              Show the preview guide
            </Button>
          ) : undefined
        }
      />
      {homeRows(focus?.home ?? DEFAULT_HOME).map((row) =>
        row.length === 2 ? (
          <div className="pb-two-col" key={row.join('+')}>
            {row.map(section)}
          </div>
        ) : (
          row.map(section)
        ),
      )}
      {/* The preview's walkthroughs come after the dashboard: a reader sees the portfolio first. */}
      {guide.open ? (
        <PreviewGuide variant="home" onHide={guide.hide} focusHide={guide.focus === 'hide'} />
      ) : null}
    </>
  );
}
