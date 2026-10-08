import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Spinner } from '@fluentui/react-components';
import { dataHealthQuery, investmentsQuery, meQuery } from '../app/queries.js';
import {
  Badge,
  Card,
  ErrorState,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  StatTile,
} from '../components/ui.js';
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
  if (investments.isPending || me.isPending) return <PageSkeleton tiles={4} rows={2} />;
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
      <PageHeader
        title={<>Welcome, {me.data?.displayName}</>}
        meta={
          <>
            As of {formatDate(investments.data.asOf)}. Figures cover the positions you are entitled
            to see.
          </>
        }
      />
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
      <div className="pb-two-col">
        <Card>
          <SectionHeader
            aside={
              health.data !== undefined ? (
                <>Stale after {health.data.staleAfterDays} days</>
              ) : undefined
            }
          >
            Data health
          </SectionHeader>
          {health.isPending ? <Spinner size="tiny" /> : null}
          {health.isError ? <p>Data health is unavailable for your role.</p> : null}
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
        <Card>
          <SectionHeader>Start here</SectionHeader>
          <ul className="pb-linklist">
            <li>
              <Link to="/portfolio">Portfolio grid</Link>
              <span className="pb-meta">
                Every position with invested capital, NAV, MOIC and IRR
              </span>
            </li>
            <li>
              <Link to="/data/health">Data Health</Link>
              <span className="pb-meta">Orphans, open exceptions and stale positions</span>
            </li>
            <li>
              <Link to="/data/dictionary">Data Dictionary</Link>
              <span className="pb-meta">
                Field definitions and display rules (docs/03 section 4)
              </span>
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}
