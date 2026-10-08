import { useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input, Label } from '@fluentui/react-components';
import { Search16Regular } from '@fluentui/react-icons';
import { dataDictionaryQuery, dataHealthQuery } from '../app/queries.js';
import {
  Card,
  EmptyState,
  ErrorState,
  Field,
  PageHeader,
  PageSkeleton,
  SectionHeader,
  StatTile,
  TableWrap,
  Toolbar,
} from '../components/ui.js';
import { formatDate } from '../lib/format.js';

export function DataHealthPage(): ReactNode {
  const q = useQuery(dataHealthQuery);
  if (q.isPending) return <PageSkeleton tiles={4} rows={1} />;
  if (q.isError) return <ErrorState title="Data health unavailable" detail={q.error.message} />;
  const h = q.data;
  return (
    <>
      <PageHeader title="Data Health" meta={<>As of {formatDate(h.asOf)}</>} />
      <div className="pb-tiles" data-testid="data-health-tiles">
        <StatTile
          label="Orphan investments"
          value={String(h.orphanInvestments)}
          hint="Investment > Vehicle > Fund > Sponsor must resolve"
          tone={h.orphanInvestments > 0 ? 'bad' : undefined}
        />
        <StatTile
          label="Open exceptions"
          value={String(h.openExceptions)}
          tone={h.openExceptions > 0 ? 'watch' : undefined}
        />
        <StatTile
          label="Stale positions"
          value={String(h.staleInvestments)}
          hint={`No approved financials in ${h.staleAfterDays} days`}
          tone={h.staleInvestments > 0 ? 'watch' : undefined}
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
          <p className="pb-status-good">
            <span className="pb-dot" aria-hidden="true" />
            Every closed vehicle's LP ownership sums to 100%.
          </p>
        ) : (
          <ul className="pb-list">
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
  const [filter, setFilter] = useState('');
  if (q.isPending) return <PageSkeleton rows={8} />;
  if (q.isError) return <ErrorState title="Data dictionary unavailable" detail={q.error.message} />;
  const entries = Object.entries(q.data.definitions).filter(([k]) => !k.startsWith('_'));
  const needle = filter.trim().toLowerCase();
  const shown =
    needle === ''
      ? entries
      : entries.filter(
          ([k, v]) =>
            k.toLowerCase().includes(needle) || renderValue(v).toLowerCase().includes(needle),
        );
  return (
    <>
      <PageHeader
        title="Data Dictionary"
        meta={<>Single source of truth: {q.data.source} (docs/03 section 4)</>}
      />
      <Card>
        <SectionHeader aside={`${shown.length} of ${entries.length} terms`}>
          Definitions
        </SectionHeader>
        <Toolbar>
          <Field>
            <Label htmlFor="dict-filter">Filter terms</Label>
            <Input
              id="dict-filter"
              contentBefore={<Search16Regular />}
              value={filter}
              onChange={(_e, d) => setFilter(d.value)}
            />
          </Field>
        </Toolbar>
        <TableWrap label="Definitions">
          <table className="pb-table" aria-label="Definitions">
            <thead>
              <tr>
                <th>Term</th>
                <th>Definition or setting</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <span className="pb-key">{k}</span>
                  </td>
                  <td>{renderValue(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        {shown.length === 0 ? (
          <EmptyState title="No terms match" detail="Clear the filter to see every definition." />
        ) : null}
      </Card>
    </>
  );
}
