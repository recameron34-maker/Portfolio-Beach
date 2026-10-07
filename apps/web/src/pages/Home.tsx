import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Spinner } from '@fluentui/react-components';
import { dataHealthQuery, investmentsQuery, meQuery } from '../app/queries.js';
import { Card, ErrorState, SectionHeader, StatTile } from '../components/ui.js';
import { formatDate, formatMoic, formatMoneyM } from '../lib/format.js';

function sum(values: (string | null)[]): string | null {
  let total = 0;
  let any = false;
  for (const v of values) {
    if (v === null) continue;
    total += Number(v);
    any = true;
  }
  return any ? total.toFixed(2) : null;
}

export function HomePage(): ReactNode {
  const me = useQuery(meQuery);
  const investments = useQuery(investmentsQuery({ active: 'true', limit: 200 }));
  const health = useQuery(dataHealthQuery);
  if (investments.isPending || me.isPending) return <Spinner label="Loading the portfolio" />;
  if (investments.isError)
    return <ErrorState title="Portfolio unavailable" detail={investments.error.message} />;
  const items = investments.data.items;
  const invested = sum(items.map((i) => i.invested));
  const nav = sum(items.map((i) => i.nav));
  const distributions = sum(items.map((i) => i.distributions));
  const moic =
    invested === null || Number(invested) === 0
      ? null
      : ((Number(nav ?? '0') + Number(distributions ?? '0')) / Number(invested)).toString();
  return (
    <>
      <div className="pb-banner">
        <h1>Welcome, {me.data?.displayName}</h1>
        <span className="pb-meta">
          As of {formatDate(investments.data.asOf)}. Figures cover the positions you are entitled to
          see.
        </span>
      </div>
      <div className="pb-tiles" data-testid="home-tiles">
        <StatTile label="Active positions" value={String(items.length)} />
        <StatTile label="Invested capital" value={formatMoneyM(invested)} />
        <StatTile label="Current NAV" value={formatMoneyM(nav)} hint="Latest Locked valuations" />
        <StatTile
          label="Gross MOIC"
          value={formatMoic(moic)}
          hint="(distributions + NAV) / invested"
        />
      </div>
      <Card>
        <SectionHeader>Data health</SectionHeader>
        {health.isPending ? <Spinner size="tiny" /> : null}
        {health.isError ? <p>Data health is unavailable for your role.</p> : null}
        {health.data !== undefined ? (
          <p>
            {health.data.orphanInvestments === 0 ? (
              <span className="pb-status-good">No orphan investments.</span>
            ) : (
              <span className="pb-status-bad">
                {health.data.orphanInvestments} orphan investments.
              </span>
            )}{' '}
            {health.data.openExceptions} open data exceptions. {health.data.staleInvestments}{' '}
            positions without approved financials in the last {health.data.staleAfterDays} days.{' '}
            <Link to="/data/health">Open Data Health</Link>.
          </p>
        ) : null}
      </Card>
      <Card>
        <SectionHeader>Start here</SectionHeader>
        <p>
          <Link to="/portfolio">Portfolio grid</Link> shows every position with invested capital,
          NAV, MOIC and IRR from the calculation library. Open a row for the one-pager with
          operating ratios, prior-year comparison, credit terms, valuations and cash flows.
        </p>
      </Card>
    </>
  );
}
