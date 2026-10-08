import type { ReactNode } from 'react';
import { Outlet, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { InvestmentDetail } from '@pb/contracts';
import { ApiError } from '../../api/client.js';
import { DEAL_TABS } from '../../app/nav.js';
import { investmentQuery } from '../../app/queries.js';
import {
  Badge,
  ErrorState,
  PageHeader,
  PageSkeleton,
  StatTile,
  TabNav,
} from '../../components/ui.js';
import {
  formatDate,
  formatMoic,
  formatMoneyM,
  formatMonthYear,
  formatPct,
  irrDisplay,
  labelOf,
} from '../../lib/format.js';
import { irrFlagHint } from '../../lib/labels.js';
import './deal.css';

/** The one-pager banner (docs/06 section 2): company, vehicle, deal type, investment date and as-of period. */
function DealBanner({ detail: d }: { detail: InvestmentDetail }): ReactNode {
  return (
    <PageHeader
      testId="detail-banner"
      title={d.companyName}
      meta={
        <span className="pb-meta-list">
          <span>{d.vehicleName}</span>
          <span>{labelOf(d.dealType)}</span>
          <span>Investment date {formatMonthYear(d.entryDate)}</span>
          <span>As of {formatDate(d.navDate ?? d.latestPeriodEnd)}</span>
        </span>
      }
      actions={
        d.isActive ? <Badge tone="brand">Active</Badge> : <Badge tone="neutral">Realized</Badge>
      }
    />
  );
}

/**
 * Stat tiles every tab shares. Equity: invested capital, current NAV, gross MOIC and gross IRR.
 * Private credit (docs/06 section 2): funded, par, fair value, current yield and gross IRR.
 */
function DealTiles({ detail: d }: { detail: InvestmentDetail }): ReactNode {
  const latest = d.credit?.latest ?? null;
  const navHint = d.navDate === null ? 'No Locked valuation' : `Locked ${formatDate(d.navDate)}`;
  const irr = (
    <StatTile
      label="Gross IRR"
      value={irrDisplay(d)}
      hint={irrFlagHint(d.irrFlag) ?? 'Position cash flows, XIRR'}
    />
  );
  if (d.credit !== null) {
    const quarter = latest === null ? undefined : `As of ${formatDate(latest.periodEnd)}`;
    return (
      <div className="pb-tiles pb-deal-tiles" data-testid="deal-tiles">
        <StatTile label="Funded" value={formatMoneyM(d.invested)} hint="Contributions to date" />
        <StatTile label="Par" value={formatMoneyM(latest?.parValue ?? null)} hint={quarter} />
        <StatTile label="Fair value" value={formatMoneyM(d.nav)} hint={navHint} />
        <StatTile
          label="Current yield"
          value={formatPct(latest?.currentYield ?? null, 2)}
          hint={quarter}
        />
        {irr}
      </div>
    );
  }
  return (
    <div className="pb-tiles pb-deal-tiles" data-testid="deal-tiles">
      <StatTile label="Invested capital" value={formatMoneyM(d.invested)} />
      <StatTile label="Current NAV" value={formatMoneyM(d.nav)} hint={navHint} />
      <StatTile label="Gross MOIC" value={formatMoic(d.grossMoic)} />
      {irr}
    </div>
  );
}

/**
 * The deal workspace (docs/06 section 2): loads the position once, shows the banner and the stat
 * tiles every tab shares, then the tab bar and the active tab. The tabs read the same cached query.
 */
export function DealWorkspace(): ReactNode {
  const { id } = useParams({ from: '/app/portfolio/$id' });
  // Keyed by the position: a background refetch keeps the data on its own, and holding the
  // previous key's data would show one position's figures under another position's address.
  const q = useQuery(investmentQuery(id));
  if (q.isPending) return <PageSkeleton tiles={4} rows={6} />;
  if (q.isLoadingError) {
    const hidden =
      q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403);
    return hidden ? (
      <ErrorState
        title="Position not found or not visible to you"
        detail="Investment not found in the positions you are entitled to see. The link may be out of date, or the position may sit behind an information wall you are not on."
      />
    ) : (
      <ErrorState title="Could not load this position" detail={q.error.message} />
    );
  }
  const d = q.data;
  return (
    <>
      <DealBanner detail={d} />
      <DealTiles detail={d} />
      <TabNav
        label="Deal workspace"
        items={DEAL_TABS.map((t) => ({
          to: `/portfolio/${id}${t.path}`,
          label: t.label,
          exact: t.path === '',
        }))}
      />
      <Outlet />
    </>
  );
}
