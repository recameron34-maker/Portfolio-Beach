import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Spinner } from '@fluentui/react-components';
import { dataDictionaryQuery, dataHealthQuery } from '../app/queries.js';
import { Card, ErrorState, SectionHeader, StatTile } from '../components/ui.js';
import { formatDate } from '../lib/format.js';

export function DataHealthPage(): ReactNode {
  const q = useQuery(dataHealthQuery);
  if (q.isPending) return <Spinner label="Checking data health" />;
  if (q.isError) return <ErrorState title="Data health unavailable" detail={q.error.message} />;
  const h = q.data;
  return (
    <>
      <div className="pb-banner">
        <h1>Data Health</h1>
        <span className="pb-meta">As of {formatDate(h.asOf)}</span>
      </div>
      <div className="pb-tiles" data-testid="data-health-tiles">
        <StatTile
          label="Orphan investments"
          value={String(h.orphanInvestments)}
          hint="Investment > Vehicle > Fund > Sponsor must resolve"
        />
        <StatTile label="Open exceptions" value={String(h.openExceptions)} />
        <StatTile
          label="Stale positions"
          value={String(h.staleInvestments)}
          hint={`No approved financials in ${h.staleAfterDays} days`}
        />
        <StatTile
          label="Locked valuations, latest quarter"
          value={String(h.lockedValuationsLatestQuarter)}
          hint={`${h.activeInvestments} active positions`}
        />
      </div>
      <Card>
        <SectionHeader>Client ownership</SectionHeader>
        {h.vehiclesWithOwnershipGap.length === 0 ? (
          <p className="pb-status-good">Every closed vehicle's LP ownership sums to 100%.</p>
        ) : (
          <ul>
            {h.vehiclesWithOwnershipGap.map((v) => (
              <li key={v.vehicleName} className="pb-status-bad">
                {v.vehicleName}: ownership sums to {v.ownershipTotal}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function DataDictionaryPage(): ReactNode {
  const q = useQuery(dataDictionaryQuery);
  if (q.isPending) return <Spinner label="Loading the data dictionary" />;
  if (q.isError) return <ErrorState title="Data dictionary unavailable" detail={q.error.message} />;
  const entries = Object.entries(q.data.definitions).filter(([k]) => !k.startsWith('_'));
  return (
    <>
      <div className="pb-banner">
        <h1>Data Dictionary</h1>
        <span className="pb-meta">Single source of truth: {q.data.source} (docs/03 section 4)</span>
      </div>
      <Card>
        <table className="pb-table" aria-label="Definitions">
          <thead>
            <tr>
              <th>Term</th>
              <th>Definition or setting</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{renderValue(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
